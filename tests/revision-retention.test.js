import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, REVISION_RETENTION_MS } from '../src/native-store.js';

const DAY = 86400000;
const candidate = (overrides = {}) => ({ name: 'example', description: 'Example', content: 'Instructions', kind: 'skill',
  sourceSessionId: 'source', generatorSessionId: 'generator', operation: 'extract',
  evidence: { provider: 'dsh', status: 'completed', sessionId: 'generator' }, ...overrides });
async function fixture(t) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'revision-retention-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let time = 100 * DAY;
  const reopen = () => createStore({ dataRoot, now: () => time });
  return { dataRoot, store: reopen(), reopen, advance: ms => { time += ms; },
    files: () => readdir(join(dataRoot, 'revisions')),
    metadata: async () => JSON.parse(await readFile(join(dataRoot, 'revision-retention.json'), 'utf8')) };
}

for (const kind of ['skill', 'workflow']) test(`${kind} history survives replacement; recycled versions expire together and survive restart`, async t => {
  const f = await fixture(t), first = await f.store.commit(candidate({ kind }));
  f.advance(100 * DAY); // Creation age must not count toward retirement.
  const second = await f.store.commit(candidate({ kind, operation: 'optimize', baseVersion: 1 }));
  await f.store.cleanupRevisions();
  assert.equal((await f.files()).length, 2);
  f.advance(5 * DAY);
  await f.store.remove('example', { version: 2, revisionId: second.revisionId });
  assert.equal(await f.store.get('example'), undefined);
  assert.equal((await f.files()).length, 2);
  // Records in these directories are outside revision cleanup's scope.
  for (const dir of ['executions', 'jobs', 'ui-runs', 'recovery']) {
    await mkdir(join(f.dataRoot, dir));
    await writeFile(join(f.dataRoot, dir, 'evidence.json'), '{}');
  }
  const reopened = f.reopen();
  f.advance(REVISION_RETENTION_MS - 1);
  assert.deepEqual((await reopened.cleanupRevisions()).removed, []);
  f.advance(1);
  assert.deepEqual((await reopened.cleanupRevisions()).removed.sort(), [first.revisionId,second.revisionId].sort());
  assert.equal((await reopened.snapshots()).purged.length,2);
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(await f.metadata(), {});
  for (const dir of ['executions', 'jobs', 'ui-runs', 'recovery']) {
    assert.equal(await readFile(join(f.dataRoot, dir, 'evidence.json'), 'utf8'), '{}');
  }
});

test('legacy files receive a full grace period; current disabled versions and unrelated files survive', async t => {
  const f = await fixture(t), old = await f.store.commit(candidate());
  const current = await f.store.commit(candidate({ operation: 'optimize', baseVersion: 1 }));
  await f.store.setEnabled('example', false);
  await rm(join(f.dataRoot, 'revision-retention.json'));
  // Include an orphan Markdown file from an interrupted publication.
  await writeFile(join(f.dataRoot, 'revisions', 'abc-123.md'), 'orphan');
  await writeFile(join(f.dataRoot, 'revisions', 'notes.txt'), 'keep');
  await writeFile(join(f.dataRoot, 'outside.json'), 'keep');
  await symlink(join(f.dataRoot, 'outside.json'), join(f.dataRoot, 'revisions', 'abc-456.json'));
  f.advance(100 * DAY);
  await f.store.cleanupRevisions();
  assert.deepEqual(Object.keys(await f.metadata()).sort(), ['abc-123']);
  f.advance(REVISION_RETENTION_MS);
  await f.reopen().cleanupRevisions();
  assert.deepEqual((await f.files()).sort(), [old.revisionId,current.revisionId, 'abc-456.json', 'notes.txt'].sort());
  assert.equal((await f.store.get('example', { includeDisabled: true })).revisionId, current.revisionId);
  assert.equal(await readFile(join(f.dataRoot, 'outside.json'), 'utf8'), 'keep');
});

test('blocked deletes preserve catalog and retention; a loaded bundle stays usable after retirement', async t => {
  const f = await fixture(t), base = await f.store.commit(candidate());
  const child = await f.store.commit(candidate({ name: 'child', kind: 'workflow', dependencies: [{ name: base.name, version: 1 }] }));
  await f.store.setEnabled('child', false);
  await assert.rejects(f.store.remove('example'), { code: 'CAPABILITY_IN_USE' });
  await assert.rejects(f.store.remove('child', { revisionId: 'stale' }), { code: 'CAPABILITY_CHANGED' });
  assert.deepEqual(await f.metadata(), {});
  assert.equal((await f.store.get('example')).revisionId, base.revisionId);
  await f.store.remove('child', { revisionId: child.revisionId });
  const bundle = await f.store.loadBundle('example');
  await f.store.remove('example');
  f.advance(REVISION_RETENTION_MS);
  await f.store.cleanupRevisions();
  assert.equal(bundle.root.content, base.content);
  assert.deepEqual(await f.files(), []);
});

test('partial physical deletion retries without resetting retirement time', async t => {
  const f = await fixture(t), entry = await f.store.commit(candidate());
  await f.store.remove('example');
  const retired = await f.metadata();
  const path = join(f.dataRoot, 'revisions', `${entry.revisionId}.json`);
  await rm(path,{force:true});
  await mkdir(path); // Simulate a filesystem error after the Markdown removal.
  f.advance(REVISION_RETENTION_MS);
  await assert.rejects(f.store.cleanupRevisions());
  assert.deepEqual(await f.metadata(), retired);
  await rm(path, { recursive: true });
  assert.deepEqual((await f.reopen().cleanupRevisions()).removed, [entry.revisionId]);
  assert.deepEqual(await f.files(), []);
});

test('a failed catalog switch cannot expire the still-current revision', async t => {
  const f = await fixture(t), entry = await f.store.commit(candidate());
  // Simulate a crash after the retirement marker was written but before publication.
  await writeFile(join(f.dataRoot, 'revision-retention.json'), JSON.stringify({ [entry.revisionId]: 0 }));
  await f.store.cleanupRevisions();
  assert.deepEqual(await f.metadata(), {});
  assert.equal((await f.store.get('example')).revisionId, entry.revisionId);
  await f.store.remove('example');
  f.advance(REVISION_RETENTION_MS - 1);
  assert.deepEqual((await f.store.cleanupRevisions()).removed, []);
});

test('cleanup runs automatically on startup and periodically, and stops on disposal', async t => {
  const f = await fixture(t), entry = await f.store.commit(candidate());
  await f.store.remove('example');
  f.advance(REVISION_RETENTION_MS);
  const errors = [];
  const stop = f.store.startCleanup({ intervalMs: 10, onError: error => errors.push(error) });
  t.after(stop);
  await stop(); // Disposal waits for the startup sweep.
  assert.deepEqual(await f.files(), []);
  const second = await f.store.commit(candidate());
  await f.store.remove('example');
  const running = f.store.startCleanup({ intervalMs: 10, onError: error => errors.push(error) });
  t.after(running);
  await f.store.cleanupRevisions();
  f.advance(REVISION_RETENTION_MS);
  // Poll with a bounded deadline rather than assuming a timer ran after one sleep.
  const deadline = Date.now() + 2000;
  while ((await f.files()).includes(second.revisionId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await running();
  assert.deepEqual(await f.files(), []);
  const third = await f.store.commit(candidate());
  await f.store.remove('example');
  f.advance(REVISION_RETENTION_MS);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok((await f.files()).includes(third.revisionId));
  assert.deepEqual(errors, []);
});

test('rollback recycles newer snapshots atomically, restores history and never reuses version numbers', async t => {
  const f=await fixture(t),first=await f.store.commit(candidate());
  const second=await f.store.commit(candidate({operation:'optimize',baseVersion:1,content:'v2'}));
  const third=await f.store.commit(candidate({operation:'optimize',baseVersion:2,content:'v3'}));
  await assert.rejects(f.store.rollback(first.revisionId,{expectedRevisionId:'stale'}),{code:'SNAPSHOT_CONFLICT'});
  const result=await f.store.rollback(first.revisionId,{expectedRevisionId:third.revisionId});
  assert.deepEqual(result.movedToTrash.sort(),[second.revisionId,third.revisionId].sort());
  assert.equal((await f.store.get(first.name)).revisionId,first.revisionId);
  assert.equal((await f.store.snapshots()).trash.length,2);
  await assert.rejects(f.store.snapshot(second.revisionId),{code:'SNAPSHOT_CONFLICT'});
  await f.reopen().restore(second.revisionId);
  assert.equal((await f.store.get(first.name)).version,1);
  assert.equal((await f.store.snapshot(second.revisionId)).version,2);
  f.advance(REVISION_RETENTION_MS);await f.store.cleanupRevisions();
  assert.equal((await f.store.snapshots()).purged[0].revisionId,third.revisionId);
  const fourth=await f.store.commit(candidate({operation:'optimize',baseVersion:1}));
  assert.equal(fourth.version,4);
});

test('historical bundles bind original dependencies; conflicting rollbacks leave all state unchanged',async t=>{
  const f=await fixture(t),base=await f.store.commit(candidate());
  const flow=await f.store.commit(candidate({name:'flow',kind:'workflow',dependencies:[{name:base.name,version:1}]}));
  await f.store.commitBatch([candidate({operation:'optimize',baseVersion:1}),candidate({name:'flow',kind:'workflow',operation:'optimize',baseVersion:1,dependencies:[{name:base.name,version:2}]})]);
  const bundle=await f.store.loadSnapshotBundle('flow',flow.revisionId);
  assert.deepEqual(bundle.entries.map(entry=>entry.version),[1,1]);
  const before=await f.store.snapshots();
  await assert.rejects(f.store.rollback(base.revisionId,{expectedRevisionId:(await f.store.get(base.name)).revisionId}),{code:'SNAPSHOT_CONFLICT'});
  assert.deepEqual(await f.store.snapshots(),before);
  await f.store.rollback(flow.revisionId,{expectedRevisionId:(await f.store.get('flow')).revisionId});
  assert.equal((await f.store.get(base.name)).version,1);
  assert.equal((await f.store.get('flow')).version,1);
  assert.equal((await f.store.loadBundle('flow')).entries.length,2);
  await f.store.restore((await f.store.snapshots()).trash.find(entry=>entry.name==='flow').revisionId);
  const restored=(await f.store.snapshots()).snapshots.find(entry=>entry.name==='flow'&&entry.version===2);
  assert.deepEqual((await f.store.loadSnapshotBundle('flow',restored.revisionId)).entries.map(entry=>entry.version),[2,2]);
  await f.store.remove('flow');
  await f.store.remove(base.name);
  const reopen=f.reopen();await reopen.restore(restored.revisionId);
  assert.equal((await reopen.loadBundle('flow')).root.version,2);
});
