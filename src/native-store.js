import { writeDirectory, refreshCurrentDirectories, entryName } from './directory-layout.js';
import { assertResourcePath, normalizeResources, resourceDigest, resourceManifest } from './native-resources.js';
import { mkdir, readFile, open, rename, lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeRecoveryDocs } from './recovery-guides.js';
import { draftDigest } from './generation-digest.js';
import { normalizeExecution, normalizeCompatibility, assertProgramResources } from './native-contract.js';

const validName = name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
const required = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`); return value; };
const DEFAULT_BUNDLE_LIMITS = { maxDepth: 8, maxEntries: 32, maxBytes: 131072, maxResourceBytes: 1048576 };
export const REVISION_RETENTION_MS = 30 * 86400000;
const executionText = entry => entry.execution?.program ?? entry.executionContent ?? entry.content;
const reference = entry => ({ name: entry.name, kind: entry.kind, version: entry.version, revisionId: entry.revisionId,
  digest: 'sha256:' + createHash('sha256').update(JSON.stringify({ name: entry.name, version: entry.version, dependencies: entry.dependencies ?? [], ...(entry.resources ? { resources: entry.resources } : {}), content: executionText(entry), ...(entry.execution ? { execution: entry.execution } : {}) })).digest('hex') });
function normalizeDependencies(input, name) {
  const dependencies = input ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 32) throw new Error('dependencies must contain at most 32 named version locks');
  const seen = new Set();
  return dependencies.map(dependency => {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || !validName(dependency.name) || !Number.isSafeInteger(dependency.version) || dependency.version < 1 || Object.keys(dependency).some(key => !['name', 'version'].includes(key))) throw new Error('Invalid dependency version lock');
    if (dependency.name === name || seen.has(dependency.name)) throw new Error('Self or duplicate dependency');
    seen.add(dependency.name);
    return { name: dependency.name, version: dependency.version };
  });
}
function normalizeCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validName(input.name)) throw new Error('Invalid capability candidate');
  required(input.description, 'description'); required(input.content, 'content');
  const kind = input.kind ?? 'skill';
  if (!['skill', 'workflow'].includes(kind)) throw new Error('Invalid kind');
  const dependencies = normalizeDependencies(input.dependencies, input.name);
  const execution = normalizeExecution(input.execution);
  const compatibility = normalizeCompatibility(input.compatibility);
  const docs = normalizeRecoveryDocs(input.docs);
  const resources = normalizeResources(input.resources);
  if (execution?.language==='typescript') assertProgramResources(execution.program, resources);
  const executionContent = input.executionContent;
  if (executionContent !== undefined && (typeof executionContent !== 'string' || !executionContent.trim() || Buffer.byteLength(executionContent) > 65536)) throw new Error('executionContent must be nonempty Markdown at most 64 KiB');
  return { ...input, kind, dependencies, ...(resources ? { resources } : {}), ...(docs ? { docs } : {}), ...(compatibility === undefined ? {} : { compatibility }), ...(execution === undefined ? {} : { execution }), ...(executionContent === undefined ? {} : { executionContent }) };
}
async function collectBundle(name, read, { signal, ...limits } = {}) {
  const bounds = { ...DEFAULT_BUNDLE_LIMITS, ...limits };
  for (const [key, value] of Object.entries(bounds)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_BUNDLE_LIMITS[key]) throw new Error('Invalid dependency bundle limit');
  const collected = new Map();
  const visiting = new Set();
  let bytes = 0; let resourceBytes = 0;
  async function visit(currentName, expectedVersion, depth, parent) {
    signal?.throwIfAborted();
    if (depth > bounds.maxDepth) throw new Error('Dependency depth limit exceeded');
    if (visiting.has(currentName)) throw new Error('Capability dependency cycle');
    const entry = await read(currentName, expectedVersion, parent);
    if (!entry || !entry.enabled) throw new Error('Required dependency is missing or disabled: ' + currentName);
    if (expectedVersion !== undefined && entry.version !== expectedVersion) throw new Error('Required dependency version changed: ' + currentName);
    if (collected.has(currentName)) {
      if(collected.get(currentName).revisionId!==entry.revisionId)throw new Error("Conflicting dependency snapshots: "+currentName);
      return;
    }
    if (collected.size >= bounds.maxEntries) throw new Error('Dependency entry limit exceeded');
    const body = required(executionText(entry), 'execution body');
    bytes += Buffer.byteLength(body);
    if (bytes > bounds.maxBytes) throw new Error('Dependency execution content exceeds bundle size limit');
    resourceBytes += Object.values(normalizeResources(entry.resources) ?? {}).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    if (resourceBytes > bounds.maxResourceBytes) throw new Error('Dependency resource content exceeds bundle size limit');
    collected.set(currentName, entry); visiting.add(currentName);
    for (const dependency of normalizeDependencies(entry.dependencies, currentName)) await visit(dependency.name, dependency.version, depth + 1, entry);
    visiting.delete(currentName);
  }
  await visit(name, undefined, 1);
  const entries = [...collected.values()];
  return { root: entries[0], entries, loadReceipt: entries.map(reference), executionBytes: bytes, resourceBytes };
}


// Legacy snapshots only stored name/version. Resolve within the owner's creation
// horizon; new snapshots pin revision IDs so deleted/re-extracted names stay exact.
function historicalDependency(entries,owner,lock) {
  const pinned=owner.dependencyRevisions?.find(item=>item.name===lock.name&&item.version===lock.version);
  if(pinned)return entries.find(item=>item.revisionId===pinned.revisionId&&item.name===lock.name&&item.version===lock.version);
  const candidates=entries.filter(item=>item.name===lock.name&&item.version===lock.version&&Date.parse(item.createdAt)<=Date.parse(owner.createdAt));
  candidates.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  if(candidates.length>1&&candidates[0].createdAt===candidates[1].createdAt)throw new Error('Ambiguous legacy dependency snapshot: '+lock.name+' v'+lock.version);
  return candidates[0];
}

// Catalog publication is the transaction boundary; revisions are write-once evidence.
export function createStore({ dataRoot, now = Date.now }) {
  const root = resolve(required(dataRoot, 'dataRoot'));
  const resourceMigrationAuthority = Symbol('resource-migration');
  const listeners = new Set();
  let queue = Promise.resolve();
  let layoutWarning;
  const exclusive = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const checkedDir = async path => {
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlink storage directories are forbidden');
  };
  const initialize = async () => { await checkedDir(root); await checkedDir(join(root, 'revisions')); };
  const state = async () => {
    await initialize();
    let value;
    try { value = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; value = {}; }
    return value.format === 'snapshot-catalog-v1' ? value : { format:'snapshot-catalog-v1', rows:value, trash:{}, purged:{}, versions:{}, orphans:{}, legacy:true };
  };
  const catalog = async () => (await state()).rows;
  const writeJson = async (name, value, signal) => {
    const temp = join(root, `.${name}-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
      signal?.throwIfAborted();
      await rename(temp, join(root, name));
    } finally { await rm(temp, { force: true }); }
  };
  const readRetired = async () => {
    let retired;
    try { retired = JSON.parse(await readFile(join(root, 'revision-retention.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    if (!retired || typeof retired !== 'object' || Array.isArray(retired)
      || Object.entries(retired).some(([id, time]) => !/^[a-f0-9-]+$/.test(id) || !Number.isFinite(time) || time < 0)) throw new Error('Invalid revision retention metadata');
    return retired;
  };
  const revisionFiles = async () => {
    await initialize();
    const ids = new Set();
    for (const file of await readdir(join(root,'revisions'),{withFileTypes:true})) {
      if (file.isDirectory() && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(file.name)) ids.add(file.name);
      if (file.isFile() && /^([a-f0-9-]+)\.json$/.test(file.name)) ids.add(file.name.slice(0,-5));
    }
    const entries=[],recycled=(await state()).trash;
    for(const id of ids) {
      let entry;
      try {entry=JSON.parse(await readFile(join(root,'revisions',id,'.record.json'),'utf8'));}
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        try{entry=JSON.parse(await readFile(join(root,'revisions',id+'.json'),'utf8'));}
        catch(fallback){if(fallback.code==='ENOENT'&&recycled[id])continue;throw fallback;}
      }
      if(entry.revisionId!==id || !validName(entry.name) || !Number.isSafeInteger(entry.version))throw new Error('Invalid snapshot identity');
      entries.push(entry);
    }
    return entries;
  };
  const conflict = message => Object.assign(new Error(message),{statusCode:409,code:'SNAPSHOT_CONFLICT'});
  const publish = async (rows, signal, lifecycle) => {
    const next=lifecycle ?? await state();
    next.rows=rows;
    for(const row of Object.values(rows)) {
      delete next.trash[row.revisionId];
      next.versions[row.name]=Math.max(next.versions[row.name]??0,row.version);
    }
    signal?.throwIfAborted();
    // Catalog and recycle metadata share one atomic replacement.
    await writeJson('catalog.json',next,signal);
    const retired={...next.orphans,...Object.fromEntries(Object.entries(next.trash).map(([id,item])=>[id,item.deletedAt]))};
    try {await writeJson('revision-retention.json',retired);await refreshCurrentDirectories(root,await Promise.all(Object.values(rows).map(readRevision)));layoutWarning=undefined;} catch(error){layoutWarning=String(error.message);}
    for (const listener of listeners) { try { listener(); } catch {} }
  };
  const cleanupRevisions = () => exclusive(async () => {
    const next=await state(), entries=await revisionFiles(), time=now(), removed=[], errors=[];
    const active=new Set(Object.values(next.rows).map(row=>row.revisionId));
    // Migrate deleted legacy entries. Superseded versions of live entries remain history.
    const retired=await readRetired();
    next.orphans??={};
    const known=new Set(entries.map(entry=>entry.revisionId));
    for(const file of await readdir(join(root,'revisions'),{withFileTypes:true})) {
      const match=file.isFile()&&/^([a-f0-9-]+)\.md$/.exec(file.name);
      if(match&&!known.has(match[1]))next.orphans[match[1]]??=retired[match[1]]??time;
    }
    for(const [id,retiredAt] of Object.entries(next.orphans))if(time-retiredAt>=REVISION_RETENTION_MS){
      try{await rm(join(root,'revisions',id+'.md'),{force:true});delete next.orphans[id];removed.push(id);}catch(error){errors.push(error);}
    }
    for(const entry of entries) {
      next.versions[entry.name]=Math.max(next.versions[entry.name]??0,entry.version);
      if(next.legacy && !next.rows[entry.name] && !next.trash[entry.revisionId]) next.trash[entry.revisionId]={name:entry.name,version:entry.version,kind:entry.kind,deletedAt:retired[entry.revisionId]??time,reason:'deleted'};
    }
    delete next.legacy;
    for(const id of active)delete next.trash[id];
    const available=entries.filter(entry=>!next.trash[entry.revisionId] || time-next.trash[entry.revisionId].deletedAt<REVISION_RETENTION_MS);
    // Keep locked dependencies until their surviving users are removed too.
    const protectedIds=new Set();
    const protect=entry=>{for(const lock of entry.dependencies??[]) {const dependency=historicalDependency(entries,entry,lock);if(dependency&&!protectedIds.has(dependency.revisionId)){protectedIds.add(dependency.revisionId);protect(dependency);}}};
    available.forEach(protect);
    for(const [id,item] of Object.entries(next.trash)) {
      if(time-item.deletedAt<REVISION_RETENTION_MS||protectedIds.has(id))continue;
      try {
        await rm(join(root,'revisions',id+'.md'),{force:true});
        await rm(join(root,'revisions',id+'.json'),{force:true});
        await rm(join(root,'revisions',id),{recursive:true,force:true});
        next.purged[id]={...item,purgedAt:time}; delete next.trash[id];removed.push(id);
      }catch(error){errors.push(error);}
    }
    await publish(next.rows,undefined,next);
    if(errors.length)throw new AggregateError(errors,'Some expired revisions could not be removed; cleanup will retry');
    return {removed};
  });
  const assertName = name => { if (!validName(name)) throw new Error('Invalid capability name'); };
  const readRevision = async row => {
    if (!/^[a-f0-9-]+$/.test(row.revisionId)) throw new Error('Invalid revision reference');
    let full;
    try {full=JSON.parse(await readFile(join(root,'revisions',row.revisionId,'.record.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;full=JSON.parse(await readFile(join(root,'revisions',row.revisionId+'.json'),'utf8'));}
    if (full.name !== row.name || full.version !== row.version || full.revisionId !== row.revisionId) throw new Error('Revision identity mismatch');
    return { ...full, enabled: row.enabled, showOnHome: row.showOnHome === true };
  };

  const validateProjected = async (revisions, rows, signal) => {
    const pending = new Map(revisions.map(revision => [revision.name, revision]));
    if (pending.size !== revisions.length) throw new Error('Duplicate candidate name');
    const readProjected = async name => pending.get(name) ?? (Object.hasOwn(rows, name) ? readRevision(rows[name]) : undefined);
    const bundles = [];
    for (const revision of revisions) bundles.push(await collectBundle(revision.name, async name => {
      const entry = await readProjected(name);
      // Revising a disabled root does not enable it. Referenced definitions must
      // still be enabled to support an eventual execution load.
      return name === revision.name && entry ? { ...entry, enabled: true } : entry;
    }, { signal }));
    return bundles;
  };
  const commitBatch = (inputs, { signal, expectedRevisions = {}, relockDependents = false, migrationAuthority } = {}) => exclusive(async () => {
    signal?.throwIfAborted();
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('A nonempty candidate batch is required');
    const rows = await catalog();
    const allRevisions=await revisionFiles(), lifecycle=await state();
    const nextVersion=name=>Math.max(rows[name]?.version??0,lifecycle.versions[name]??0,...allRevisions.filter(entry=>entry.name===name).map(entry=>entry.version))+1;
    for (const [name, revisionId] of Object.entries(expectedRevisions)) {
      assertName(name);
      if (!revisionId || !Object.hasOwn(rows, name) || !rows[name].enabled || rows[name].revisionId !== revisionId) throw new Error('Referenced capability revision changed: ' + name);
    }
    // A contract-preserving dependency repair and its mechanical version-lock
    // updates publish in one catalog transaction, without running business code.
    if (relockDependents) {
      inputs = [...inputs];
      const changed = new Map(inputs.map(input => [input.name, { previous: rows[input.name]?.version, next: nextVersion(input.name) }]));
      const included = new Set(changed.keys());
      const evidence = inputs[0].evidence;
      for (let pass = 0; pass < DEFAULT_BUNDLE_LIMITS.maxDepth; pass++) {
        let added = false;
        for (const row of Object.values(rows)) {
          if (included.has(row.name)) continue;
          const previous = await readRevision(row);
          if (!(previous.dependencies ?? []).some(lock => changed.has(lock.name) && lock.version === changed.get(lock.name).previous)) continue;
          inputs.push({ ...previous, operation:'optimize', baseVersion:previous.version, baseRevisionId:previous.revisionId,
            generatorSessionId:inputs[0].generatorSessionId, evidence:{...evidence, dependencyRelock:true},
            validationNotes:previous.validationNotes + '\nDependency locks updated atomically after a contract-preserving repair.' });
          changed.set(row.name,{previous:row.version,next:nextVersion(row.name)}); included.add(row.name); added = true;
        }
        if (!added) break;
      }
      inputs = inputs.map(input => ({...input,dependencies:(input.dependencies ?? []).map(lock => changed.has(lock.name) && lock.version === changed.get(lock.name).previous ? {...lock,version:changed.get(lock.name).next} : lock)}));
    }
    const names = new Set();
    const revisions = [];
    for (const input of inputs) {
        const { name, description, content, sourceSessionId, generatorSessionId, operation, evidence, baseVersion, baseRevisionId } = input;
        assertName(name);
        for (const [field, value] of Object.entries({ description, content, sourceSessionId, generatorSessionId })) required(value, field);
        const { dependencies, executionContent, execution, kind, compatibility, docs, resources } = normalizeCandidate(input);
        if (!['extract', 'optimize'].includes(operation)) throw new Error('Invalid operation');
        const resourceMigration = migrationAuthority === resourceMigrationAuthority && evidence?.provider === 'local-resource-migration' && operation === 'optimize';
        if ((!resourceMigration && evidence?.provider !== 'dsh') || evidence?.status !== 'completed' || evidence?.sessionId !== generatorSessionId) throw new Error('Current successful DSH generator evidence is required');
        const previous = Object.hasOwn(rows, name) ? rows[name] : undefined;
        if (relockDependents && previous) {
          const original = await readRevision(previous);
          if (draftDigest(execution?.inputSchema ?? null) !== draftDigest(original.execution?.inputSchema ?? null) || draftDigest(execution?.outputSchema ?? null) !== draftDigest(original.execution?.outputSchema ?? null)) throw new Error('Contract-preserving repair cannot change schemas');
        }
        if (baseRevisionId !== undefined && baseRevisionId !== previous?.revisionId) throw new Error('Optimization base revision conflict');
        if (operation === 'extract' && previous) throw new Error('Capability already exists; use optimize with baseVersion');
        if (operation === 'optimize' && (!previous || baseVersion !== previous.version)) throw new Error('Optimization base version conflict');
        if (baseVersion !== undefined && baseVersion !== (previous?.version ?? 0)) throw new Error('Base version conflict');
        const revision = { name, description, content, kind, dependencies, ...(resources ? { resources } : {}), ...(docs ? { docs } : {}), ...(compatibility === undefined ? {} : { compatibility }), ...(execution === undefined ? {} : { execution }), ...(executionContent === undefined ? {} : { executionContent }), sourceSessionId, generatorSessionId, operation,
          evidence: structuredClone(evidence), validationNotes: input.validationNotes ?? '', version: nextVersion(name),
          revisionId: randomUUID(), previousRevisionId: previous?.revisionId ?? null, createdAt: new Date().toISOString() };
        if (names.has(name)) throw new Error('Duplicate candidate name');
        names.add(name);
        revisions.push({ ...revision, enabled: previous?.enabled ?? true });
        rows[name] = { name, description, kind, showOnHome: previous?.showOnHome === true, homeOrder: previous?.homeOrder ?? null, enabled: previous?.enabled ?? true, version: revision.version, revisionId: revision.revisionId };
    }
    // Validate the projected publication before creating any visible revision.
    await validateProjected(revisions, rows, signal);
    for(const revision of revisions)revision.dependencyRevisions=(revision.dependencies??[]).map(lock=>({name:lock.name,version:lock.version,revisionId:rows[lock.name].revisionId}));
    for (const revision of revisions) {
      signal?.throwIfAborted();
      await writeDirectory(join(root,'revisions',revision.revisionId),revision);
    }
    await publish(rows, signal);
    return revisions;
  });
  return {
    dataRoot: root,
    get layoutWarning(){return layoutWarning;},
    migrateLayout:()=>exclusive(async()=>{
      const rows=await catalog();let migrated=0;
      for(const item of await readdir(join(root,'revisions'),{withFileTypes:true})){
        if(!item.isFile()||!/^([a-f0-9-]+)\.json$/.test(item.name))continue;
        const entry=JSON.parse(await readFile(join(root,'revisions',item.name),'utf8'));
        if(!entry.revisionId||item.name!==entry.revisionId+'.json')throw new Error('Invalid legacy revision identity');
        await writeDirectory(join(root,'revisions',entry.revisionId),entry);
        await rm(join(root,'revisions',item.name));await rm(join(root,'revisions',entry.revisionId+'.md'),{force:true});migrated++;
      }
      await refreshCurrentDirectories(root,await Promise.all(Object.values(rows).map(readRevision)));layoutWarning=undefined;return {migrated};
    }),
    async nextVersions(names) {
      const next=await state(),entries=await revisionFiles();
      return Object.fromEntries(names.map(name=>[name,Math.max(next.versions[name]??0,next.rows[name]?.version??0,...entries.filter(entry=>entry.name===name).map(entry=>entry.version))+1]));
    },
    snapshots: () => exclusive(async () => {
      const next=await state(), entries=await revisionFiles();
      const protectedBy=new Map();
      const protect=(entry,owner,seen=new Set())=>{if(seen.has(entry.revisionId))return;seen.add(entry.revisionId);for(const lock of entry.dependencies??[]){const dep=historicalDependency(entries,entry,lock);if(dep){if(!protectedBy.has(dep.revisionId))protectedBy.set(dep.revisionId,new Set());protectedBy.get(dep.revisionId).add(owner);protect(dep,owner,seen);}}};
      entries.filter(entry=>!next.trash[entry.revisionId] || now()-next.trash[entry.revisionId].deletedAt<REVISION_RETENTION_MS).forEach(entry=>protect(entry,entry.name+' v'+entry.version));
      const decorate=entry=>({name:entry.name,description:entry.description,kind:entry.kind,version:entry.version,revisionId:entry.revisionId,createdAt:entry.createdAt, enabled:true, historical:true, current:next.rows[entry.name]?.revisionId===entry.revisionId,currentRevisionId:next.rows[entry.name]?.revisionId,currentVersion:next.rows[entry.name]?.version,
        ...(next.trash[entry.revisionId]?{...next.trash[entry.revisionId],purgeAfter:next.trash[entry.revisionId].deletedAt+REVISION_RETENTION_MS,retainedBy:[...(protectedBy.get(entry.revisionId)??[])]}:{} )});
      return {snapshots:entries.filter(entry=>!next.trash[entry.revisionId]).map(decorate).sort((a,b)=>a.name.localeCompare(b.name)||b.version-a.version),
        trash:entries.filter(entry=>next.trash[entry.revisionId]).map(decorate).sort((a,b)=>b.deletedAt-a.deletedAt),
        purged:Object.entries(next.purged).map(([revisionId,item])=>({revisionId,...item})).sort((a,b)=>b.purgedAt-a.purgedAt)};
    }),
    snapshot: revisionId => exclusive(async () => {
      const next=await state();
      if(next.trash[revisionId])throw conflict('Snapshot is in the recycle bin; restore it first');
      const entry=(await revisionFiles()).find(item=>item.revisionId===revisionId);
      return entry?{...entry,enabled:true,historical:true,current:next.rows[entry.name]?.revisionId===revisionId}:undefined;
    }),
    loadSnapshotBundle: (name,revisionId,options={}) => exclusive(async()=>{
      const next=await state(),entries=await revisionFiles();
      const selected=entries.find(entry=>entry.name===name&&entry.revisionId===revisionId);
      if(!selected||next.trash[revisionId])return undefined;
      return collectBundle(name,async(currentName,version,parent)=>{
        const entry=currentName===name&&version===undefined?selected:historicalDependency(entries,parent,{name:currentName,version});
        return entry?{...entry,enabled:true}:undefined;
      },options);
    }),
    restore: revisionId => exclusive(async()=>{
      const next=await state(),entry=(await revisionFiles()).find(item=>item.revisionId===revisionId);
      if(!entry||!next.trash[revisionId])throw conflict('Recycled snapshot no longer exists');
      const entries=await revisionFiles(),restored=new Map();
      const restoreEntry=item=>{if(restored.has(item.revisionId))return;restored.set(item.revisionId,item);delete next.trash[item.revisionId];
        for(const lock of item.dependencies??[]){const dep=historicalDependency(entries,item,lock);if(!dep)throw conflict('Dependency was permanently deleted: '+lock.name+' v'+lock.version);restoreEntry(dep);}};
      restoreEntry(entry);
      const projected={...next.rows};
      for(const item of restored.values())if(!projected[item.name])projected[item.name]={...reference(item),description:item.description,enabled:true,showOnHome:false};
      try {await validateProjected(await Promise.all(Object.values(projected).map(readRevision)),projected);next.rows=projected;}
      catch { /* Restored definitions remain usable as immutable historical snapshots. */ }
      await publish(next.rows,undefined,next);
      return {restored:true,name:entry.name,version:entry.version,current:next.rows[entry.name]?.revisionId===revisionId};
    }),
    rollback: (revisionId,{expectedRevisionId}={}) => exclusive(async()=>{
      const next=await state(),entries=await revisionFiles(),target=entries.find(entry=>entry.revisionId===revisionId);
      if(!target||next.trash[revisionId])throw conflict('Snapshot unavailable; restore it first');
      const previous=next.rows[target.name];
      if(!expectedRevisionId||previous?.revisionId!==expectedRevisionId)throw conflict('Current version changed; refresh before rolling back');
      if(target.version>=previous.version)throw conflict('Select an older snapshot to roll back');
      const selected=new Map();
      const select=entry=>{
        const bound=selected.get(entry.name);if(bound&&bound.revisionId!==entry.revisionId)throw conflict('Conflicting dependency versions: '+entry.name);
        if(bound)return;selected.set(entry.name,entry);
        for(const lock of entry.dependencies??[]) {
          const dep=historicalDependency(entries,entry,lock);
          if(!dep||next.trash[dep.revisionId])throw conflict('Restore required dependency first: '+lock.name+' v'+lock.version);
          select(dep);
        }
      };select(target);
      const affected=[];
      for(const entry of selected.values()) {
        const row=next.rows[entry.name];
        next.rows[entry.name]={...row,name:entry.name,kind:entry.kind,description:entry.description,version:entry.version,revisionId:entry.revisionId,enabled:row?.enabled??true};
        if(row?.revisionId!==entry.revisionId)affected.push(entry.name);
      }
      // Check incoming users before retiring any revision. Never rewrite their contracts.
      try {await validateProjected(await Promise.all(Object.values(next.rows).map(readRevision)),next.rows);}
      catch(error){throw conflict('Rollback conflicts with current dependencies: '+error.message);}
      const moved=[];
      for(const entry of entries) if(selected.has(entry.name)&&entry.version>selected.get(entry.name).version&&!next.trash[entry.revisionId]) {
        next.trash[entry.revisionId]={name:entry.name,kind:entry.kind,version:entry.version,deletedAt:now(),reason:'rollback'};moved.push(entry.revisionId);
      }
      await publish(next.rows,undefined,next);
      return {rolledBack:true,name:target.name,version:target.version,affected,movedToTrash:moved};
    }),
    async resolveEntry(entry,{signal}={}){
      signal?.throwIfAborted();
      if(!/^[a-f0-9-]+$/.test(entry?.revisionId)||!entry.execution)throw new Error('Invalid entry reference');
      const path=join(root,'revisions',entry.revisionId,entryName(entry));
      if((await lstat(path)).isSymbolicLink()||await readFile(path,'utf8')!==entry.execution.program)throw new Error('Entry file integrity mismatch');
      return path;
    },
    async migrateDefinitions(inputs,{reason}) {
      required(reason,'migration reason');const rows=await catalog();const pending=[];
      for(const input of inputs){assertName(input.name);const previous=rows[input.name] && await readRevision(rows[input.name]);
        if(!previous||previous.revisionId!==input.baseRevisionId)throw new Error('Migration base revision changed');
        const execution=normalizeExecution(input.execution);
        if(!execution||draftDigest(execution.inputSchema)!==draftDigest(previous.execution.inputSchema)||draftDigest(execution.outputSchema)!==draftDigest(previous.execution.outputSchema))throw new Error('Runner migration must preserve public input/output schemas');
        pending.push({...previous,...input,operation:'optimize',baseVersion:previous.version,baseRevisionId:previous.revisionId,
          evidence:{provider:'local-resource-migration',status:'completed',sessionId:previous.generatorSessionId,sourceGeneratorSessionId:previous.generatorSessionId,baseRevisionId:previous.revisionId,migration:{kind:'shell-free-runtime-v1',reason,createdAt:new Date().toISOString()},validation:{behaviorTested:false,scope:'static-only'}},validationNotes:reason});
      }
      return commitBatch(pending,{migrationAuthority:resourceMigrationAuthority});
    },
    async migrateResources({name, baseRevisionId, resources, execution, docs, compatibility, reason}) {
      assertName(name); required(reason, 'migration reason');
      const rows = await catalog();
      const previous = Object.hasOwn(rows, name) ? await readRevision(rows[name]) : undefined;
      if (!previous || previous.revisionId !== baseRevisionId) throw new Error('Resource migration base revision changed');
      const normalized = normalizeResources(resources);
      if (!normalized || !Object.keys(normalized).length) throw new Error('Resource migration must bundle actual files');
      const contract = normalizeExecution(execution);
      if (!contract || draftDigest(contract.outputSchema) !== draftDigest(previous.execution?.outputSchema)) throw new Error('Resource migration must preserve the output schema');
      // This is a traceable host migration, not a claim of a newly generated DSH turn.
      return commitBatch([{...previous, resources:normalized, execution:contract,
        docs:docs ?? previous.docs, compatibility:compatibility ?? previous.compatibility,
        operation:'optimize', baseVersion:previous.version, baseRevisionId,
        validationNotes:previous.validationNotes + '\n' + reason,
        evidence:{...previous.evidence, provider:'local-resource-migration', status:'completed', sessionId:previous.generatorSessionId,
          sourceGeneratorSessionId:previous.generatorSessionId, baseRevisionId,
          migration:{kind:'bundle-resources-v1',reason,resources:resourceManifest(normalized),createdAt:new Date().toISOString()},
          validation:{policy:'static-resource-migration-v1',behaviorTested:false,scope:'structure-and-resource-integrity-only'}},
      }],{migrationAuthority:resourceMigrationAuthority}).then(entries=>entries[0]);
    },
    cleanupRevisions,
    async resolveResource(entry, path, { signal } = {}) {
      signal?.throwIfAborted();
      assertResourcePath(path);
      if (!/^[a-f0-9-]+$/.test(entry?.revisionId) || !Object.hasOwn(entry.resources ?? {}, path)) throw new Error('Undeclared bundled resource: ' + path);
      let current = root;
      // Check every component, including dataRoot and the revision directory.
      for (const part of ['revisions', entry.revisionId, ...path.split('/')]) {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink resource paths are forbidden');
        current = join(current, part);
      }
      const stat = await lstat(current);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Bundled resource is not a regular file');
      const bytes = await readFile(current);
      if (resourceDigest(bytes) !== resourceDigest(entry.resources[path])) throw new Error('Bundled resource content changed: ' + path);
      signal?.throwIfAborted();
      return current;
    },
    startCleanup({ onError = console.error, intervalMs = 3600000 } = {}) {
      let pending;
      const run = () => {
        if (!pending) pending = cleanupRevisions().catch(onError).finally(() => { pending = undefined; });
      };
      run();
      const timer = setInterval(run, intervalMs);
      timer.unref?.();
      return async () => { clearInterval(timer); await pending; };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list(kind, { includeDisabled = false } = {}) {
      const rows = await catalog();
      return Object.values(rows).filter(row => (!kind || row.kind === kind) && (includeDisabled || row.enabled))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(row => includeDisabled ? { name: row.name, description: row.description, kind: row.kind, enabled: row.enabled, showOnHome: row.showOnHome === true, homeOrder: row.homeOrder ?? null, version: row.version, revisionId: row.revisionId } : { name: row.name, description: row.description });
    },
    async get(name, { includeDisabled = false } = {}) {
      assertName(name);
      const rows = await catalog();
      const row = Object.hasOwn(rows, name) ? rows[name] : undefined;
      if (!row || (!includeDisabled && !row.enabled)) return undefined;
      return readRevision(row);
    },
    async validateCandidates(candidates, { signal, replay = false } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(candidates) || candidates.length > 20) throw new Error('Submit at most 20 capability candidates');
      if (!candidates.length) return { valid: true, candidates: [] };
      const rows = await catalog(), lifecycle=await state(), allRevisions=await revisionFiles();
      const revisions = candidates.map(input => {
        const normalized = normalizeCandidate(input);
        const previous = Object.hasOwn(rows, normalized.name) ? rows[normalized.name] : undefined;
        return { ...normalized, version: replay ? (previous?.version ?? 1) : Math.max(previous?.version??0,lifecycle.versions[input.name]??0,...allRevisions.filter(entry=>entry.name===input.name).map(entry=>entry.version))+1, revisionId: 'candidate', enabled: previous?.enabled ?? true };
      });
      const bundles = await validateProjected(revisions, rows, signal);
      signal?.throwIfAborted();
      return { valid: true, candidates: bundles.map(bundle => ({ name: bundle.root.name, executionBytes: bundle.executionBytes, dependencyCount: bundle.entries.length - 1 })) };
    },
    async loadBundle(name, options = {}) {
      assertName(name);
      const rows = await catalog();
      if (!Object.hasOwn(rows, name) || !rows[name].enabled) return undefined;
      const bundle = await collectBundle(name, async entryName => Object.hasOwn(rows, entryName) ? readRevision(rows[entryName]) : undefined, options);
      // A single catalog snapshot binds the closure. If anything was changed while
      // immutable bodies were read, refuse this load rather than mix versions.
      const latest = await catalog();
      for (const entry of bundle.entries) {
        const current = Object.hasOwn(latest, entry.name) ? latest[entry.name] : undefined;
        if (!current?.enabled || current.version !== entry.version || current.revisionId !== entry.revisionId) throw new Error('Dependency catalog changed during load; retry the native skill request');
      }
      options.signal?.throwIfAborted();
      return bundle;
    },
    commit(input, options) { return commitBatch([input], options).then(rows => rows[0]); },
    commitBatch,
    remove(name, { version, revisionId } = {}) {
      return exclusive(async () => {
        assertName(name);
        const rows = await catalog();
        if (!Object.hasOwn(rows, name)) return undefined;
        if ((version !== undefined && version !== rows[name].version) || (revisionId !== undefined && revisionId !== rows[name].revisionId)) throw Object.assign(new Error('Capability changed; refresh before deleting'), { statusCode: 409, code: 'CAPABILITY_CHANGED' });
        const dependents = [];
        for (const row of Object.values(rows)) {
          const entry = await readRevision(row);
          if (entry.dependencies?.some(dependency => dependency.name === name)) dependents.push({ name: entry.name, kind: entry.kind, enabled: entry.enabled });
        }
        dependents.sort((a, b) => a.name.localeCompare(b.name));
        if (dependents.length) throw Object.assign(new Error('Cannot delete: referenced by ' + dependents.map(entry => entry.name).join(', ')), { statusCode: 409, code: 'CAPABILITY_IN_USE', dependents });
        const removed = rows[name];
        delete rows[name];
        // Retire the current revision now; its files expire after the grace period.
        const next=await state();
        for(const entry of await revisionFiles())if(entry.name===name&&!next.trash[entry.revisionId])next.trash[entry.revisionId]={name:entry.name,kind:entry.kind,version:entry.version,deletedAt:now(),reason:"deleted"};
        await publish(rows,undefined,next);
        return { deleted: true, name: removed.name, version: removed.version };
      });
    },
    setHomeOrder(names) {
      return exclusive(async () => {
        if (!Array.isArray(names) || names.some(name => !validName(name)) || new Set(names).size !== names.length) throw new Error('Invalid home card order');
        const rows = await catalog();
        if (names.some(name => !Object.hasOwn(rows, name) || rows[name].showOnHome !== true)) throw new Error('Home cards changed; refresh before sorting');
        const remaining = Object.values(rows).filter(row => row.showOnHome === true && !names.includes(row.name))
          .sort((a, b) => (a.homeOrder ?? Infinity) - (b.homeOrder ?? Infinity) || a.name.localeCompare(b.name));
        [...names, ...remaining.map(row => row.name)].forEach((name, index) => { rows[name].homeOrder = index; });
        await publish(rows);
        return { saved: true };
      });
    },
    setShowOnHome(name, showOnHome) {
      return exclusive(async () => {
        assertName(name);
        if (typeof showOnHome !== 'boolean') throw new Error('showOnHome must be boolean');
        const rows = await catalog();
        if (!Object.hasOwn(rows, name)) throw new Error('Capability not found');
        rows[name].showOnHome = showOnHome;
        await publish(rows);
        return { ...rows[name] };
      });
    },
    setEnabled(name, enabled) {
      return exclusive(async () => {
        assertName(name);
        if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
        const rows = await catalog();
        if (!Object.hasOwn(rows, name)) throw new Error('Capability not found');
        rows[name].enabled = enabled;
        await publish(rows);
        return { ...rows[name] };
      });
    },
  };
}
export const createNativeStore = createStore;
