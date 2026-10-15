import { mkdir, readFile, open, rename, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeExecution } from './native-contract.js';

const validName = name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
const required = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`); return value; };
const DEFAULT_BUNDLE_LIMITS = { maxDepth: 8, maxEntries: 32, maxBytes: 131072 };
const executionText = entry => entry.execution?.program ?? entry.executionContent ?? entry.content;
const reference = entry => ({ name: entry.name, kind: entry.kind, version: entry.version, revisionId: entry.revisionId,
  digest: 'sha256:' + createHash('sha256').update(JSON.stringify({ name: entry.name, version: entry.version, dependencies: entry.dependencies ?? [], content: executionText(entry), ...(entry.execution ? { execution: entry.execution } : {}) })).digest('hex') });
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
  const executionContent = input.executionContent;
  if (executionContent !== undefined && (typeof executionContent !== 'string' || !executionContent.trim() || Buffer.byteLength(executionContent) > 65536)) throw new Error('executionContent must be nonempty Markdown at most 64 KiB');
  return { ...input, kind, dependencies, ...(execution === undefined ? {} : { execution }), ...(executionContent === undefined ? {} : { executionContent }) };
}
async function collectBundle(name, read, { signal, ...limits } = {}) {
  const bounds = { ...DEFAULT_BUNDLE_LIMITS, ...limits };
  for (const [key, value] of Object.entries(bounds)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_BUNDLE_LIMITS[key]) throw new Error('Invalid dependency bundle limit');
  const collected = new Map();
  const visiting = new Set();
  let bytes = 0;
  async function visit(currentName, expectedVersion, depth) {
    signal?.throwIfAborted();
    if (depth > bounds.maxDepth) throw new Error('Dependency depth limit exceeded');
    if (visiting.has(currentName)) throw new Error('Capability dependency cycle');
    const entry = collected.get(currentName) ?? await read(currentName);
    if (!entry || !entry.enabled) throw new Error('Required dependency is missing or disabled: ' + currentName);
    if (expectedVersion !== undefined && entry.version !== expectedVersion) throw new Error('Required dependency version changed: ' + currentName);
    if (collected.has(currentName)) return;
    if (collected.size >= bounds.maxEntries) throw new Error('Dependency entry limit exceeded');
    const body = required(executionText(entry), 'execution body');
    bytes += Buffer.byteLength(body);
    if (bytes > bounds.maxBytes) throw new Error('Dependency execution content exceeds bundle size limit');
    collected.set(currentName, entry); visiting.add(currentName);
    for (const dependency of normalizeDependencies(entry.dependencies, currentName)) await visit(dependency.name, dependency.version, depth + 1);
    visiting.delete(currentName);
  }
  await visit(name, undefined, 1);
  const entries = [...collected.values()];
  return { root: entries[0], entries, loadReceipt: entries.map(reference), executionBytes: bytes };
}


// Catalog publication is the transaction boundary; revisions are write-once evidence.
export function createStore({ dataRoot }) {
  const root = resolve(required(dataRoot, 'dataRoot'));
  const listeners = new Set();
  let queue = Promise.resolve();
  const exclusive = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const checkedDir = async path => {
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlink storage directories are forbidden');
  };
  const initialize = async () => { await checkedDir(root); await checkedDir(join(root, 'revisions')); };
  const catalog = async () => {
    await initialize();
    try { return JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const publish = async (rows, signal) => {
    const temp = join(root, `.catalog-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(rows, null, 2)); await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    await rename(temp, join(root, 'catalog.json'));
    for (const listener of listeners) { try { listener(); } catch {} }
  };
  const assertName = name => { if (!validName(name)) throw new Error('Invalid capability name'); };
  const readRevision = async row => {
    if (!/^[a-f0-9-]+$/.test(row.revisionId)) throw new Error('Invalid revision reference');
    const full = JSON.parse(await readFile(join(root, 'revisions', `${row.revisionId}.json`), 'utf8'));
    if (full.name !== row.name || full.version !== row.version || full.revisionId !== row.revisionId) throw new Error('Revision identity mismatch');
    return { ...full, enabled: row.enabled };
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
  const commitBatch = (inputs, { signal, expectedRevisions = {} } = {}) => exclusive(async () => {
    signal?.throwIfAborted();
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('A nonempty candidate batch is required');
    const rows = await catalog();
    for (const [name, revisionId] of Object.entries(expectedRevisions)) {
      assertName(name);
      if (!revisionId || !Object.hasOwn(rows, name) || !rows[name].enabled || rows[name].revisionId !== revisionId) throw new Error('Referenced capability revision changed: ' + name);
    }
    const names = new Set();
    const revisions = [];
    for (const input of inputs) {
        const { name, description, content, sourceSessionId, generatorSessionId, operation, evidence, baseVersion, baseRevisionId } = input;
        assertName(name);
        for (const [field, value] of Object.entries({ description, content, sourceSessionId, generatorSessionId })) required(value, field);
        const { dependencies, executionContent, execution, kind } = normalizeCandidate(input);
        if (!['extract', 'optimize'].includes(operation)) throw new Error('Invalid operation');
        if (evidence?.provider !== 'dsh' || evidence?.status !== 'completed' || evidence?.sessionId !== generatorSessionId) throw new Error('Current successful DSH generator evidence is required');
        const previous = Object.hasOwn(rows, name) ? rows[name] : undefined;
        if (baseRevisionId !== undefined && baseRevisionId !== previous?.revisionId) throw new Error('Optimization base revision conflict');
        if (operation === 'extract' && previous) throw new Error('Capability already exists; use optimize with baseVersion');
        if (operation === 'optimize' && (!previous || baseVersion !== previous.version)) throw new Error('Optimization base version conflict');
        if (baseVersion !== undefined && baseVersion !== (previous?.version ?? 0)) throw new Error('Base version conflict');
        const revision = { name, description, content, kind, dependencies, ...(execution === undefined ? {} : { execution }), ...(executionContent === undefined ? {} : { executionContent }), sourceSessionId, generatorSessionId, operation,
          evidence: structuredClone(evidence), validationNotes: input.validationNotes ?? '', version: (previous?.version ?? 0) + 1,
          revisionId: randomUUID(), previousRevisionId: previous?.revisionId ?? null, createdAt: new Date().toISOString() };
        if (names.has(name)) throw new Error('Duplicate candidate name');
        names.add(name);
        revisions.push({ ...revision, enabled: previous?.enabled ?? true });
        rows[name] = { name, description, kind, enabled: previous?.enabled ?? true, version: revision.version, revisionId: revision.revisionId };
    }
    // Validate the projected publication before creating any visible revision.
    await validateProjected(revisions, rows, signal);
    for (const revision of revisions) {
      signal?.throwIfAborted();
      for (const [extension, content] of [['md', revision.content], ['json', JSON.stringify(revision, null, 2)]]) {
        const file = await open(join(root, 'revisions', `${revision.revisionId}.${extension}`), 'wx', 0o600);
        try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      }
    }
    await publish(rows, signal);
    return revisions;
  });
  return {
    dataRoot: root,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list(kind, { includeDisabled = false } = {}) {
      const rows = await catalog();
      return Object.values(rows).filter(row => (!kind || row.kind === kind) && (includeDisabled || row.enabled))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(row => includeDisabled ? { name: row.name, description: row.description, kind: row.kind, enabled: row.enabled, version: row.version, revisionId: row.revisionId } : { name: row.name, description: row.description });
    },
    async get(name, { includeDisabled = false } = {}) {
      assertName(name);
      const rows = await catalog();
      const row = Object.hasOwn(rows, name) ? rows[name] : undefined;
      if (!row || (!includeDisabled && !row.enabled)) return undefined;
      return readRevision(row);
    },
    async validateCandidates(candidates, { signal } = {}) {
      signal?.throwIfAborted();
      if (!Array.isArray(candidates) || candidates.length > 20) throw new Error('Submit at most 20 capability candidates');
      if (!candidates.length) return { valid: true, candidates: [] };
      const rows = await catalog();
      const revisions = candidates.map(input => {
        const normalized = normalizeCandidate(input);
        const previous = Object.hasOwn(rows, normalized.name) ? rows[normalized.name] : undefined;
        return { ...normalized, version: (previous?.version ?? 0) + 1, revisionId: 'candidate', enabled: previous?.enabled ?? true };
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
        // Keep immutable revisions for already loaded executions and audit history.
        await publish(rows);
        return { deleted: true, name: removed.name, version: removed.version };
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
