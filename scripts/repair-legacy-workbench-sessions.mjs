import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

// Offline, explicit migration of sessions owned by the old workbench. Never relax
// the DSH reader or discard a damaged tail; unsupported histories fail closed.
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Required: ${flag}`); return resolve(args[i + 1]); };
const dataRoot = value('--data-root'), sessionsRoot = value('--sessions-root');
const requireDsh = createRequire(await realpath(value('--dsh-bin')));
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href);
const { releasedV4SessionFormatCodec: codec, restoreReleasedV4Artifact: validate } = await load('@deepseek-ai/dsh-session-format-v3-to-v4');
const { KNOWN_SESSION_EVENT_TYPES: known, adoptSessionEvent } = await load('@deepseek-ai/dsh-session');
const { tryLockExclusive } = await load('@deepseek-ai/node-addon-system/flock');
const apply = args.includes('--apply');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const surfaceTypes = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
const jobs = new Map(), legacyNames = new Map();
for (const name of await readdir(join(dataRoot, 'ui-runs'))) {
  if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
  const job = JSON.parse(await readFile(join(dataRoot, 'ui-runs', name), 'utf8'));
  if (/^session-[a-f0-9-]{36}$/.test(job.sessionId)) {
    const refs = jobs.get(job.sessionId) ?? []; refs.push(job.id); jobs.set(job.sessionId, refs);
    legacyNames.set(job.sessionId, [...(legacyNames.get(job.sessionId) ?? []), job.name]);
  }
}
function decode(bytes) {
  // zstd's CLI reads every concatenated frame; sync Node decompression reads only
  // the first frame on supported DSH installations (the header, without events).
  const text = execFileSync('zstd', ['-dc'], { input: bytes, maxBuffer: 128 * 1024 * 1024 }).toString('utf8');
  const lines = text.split('\n'); if (lines.pop() !== '') throw new Error('Incomplete JSONL tail');
  const physicalHeader = JSON.parse(lines.shift());
  if (physicalHeader.version !== 4) throw new Error('Only released V4 histories are supported');
  const decoder = codec.createDecoder(physicalHeader, 'strict'), events = [];
  const sink = { emitEvent: event => events.push(adoptSessionEvent(event)), emitRun() { throw new Error('Unsupported grouped log row'); } };
  for (const line of lines) decoder.decodeRow(JSON.parse(line), sink);
  return { physicalHeader, header: decoder.header, events, inheritedEventCount: decoder.finish(sink) };
}
function canonicalize(artifact) {
  const { events, header } = artifact;
  if (header.isSeeded || artifact.inheritedEventCount !== 0) throw new Error('Inherited history requires separate migration');
  const head = events.findIndex(e => e.type === 'system/message');
  const prefix = events.slice(0, head).filter(e => surfaceTypes.has(e.type));
  if (head < 0 || prefix.length !== 2 || prefix.some(e => e.type !== 'user/message' || e.surfaceOp !== 'append')) throw new Error('Not the legacy workbench prefix');
  const [request, result] = prefix;
  const jobNames = legacyNames.get(header.id);
  if (request.data.source?.kind !== 'user' || !jobNames.some(name => request.data.content?.[0]?.text?.startsWith(`Execute ${name} with the submitted parameters:\n`)) || result.data.source?.kind !== 'skillx-workflow-execution') throw new Error('Unrecognized workbench provenance');
  if (events[head].surfaceOp !== 'append' || events.some(e => (e.surfaceOp && e.surfaceOp !== 'append') || /^(compaction\/|image\/|session-log-|session\/fork)/.test(e.type))) throw new Error('Complex history requires separate migration');
  const moved = new Set(prefix.map(e => e.seq));
  const order = events.slice(0, head + 1).filter(e => !moved.has(e.seq)).concat(prefix, events.slice(head + 1));
  const mapping = new Map(order.map((e, i) => [e.seq, i]));
  const ref = n => { if (!Number.isSafeInteger(n) || !mapping.has(n)) throw new Error('Invalid local event reference'); return mapping.get(n); };
  const repaired = order.map(event => {
    const e = structuredClone(event); e.seq = mapping.get(event.seq);
    if (e.sourceEventSeqs) e.sourceEventSeqs = e.sourceEventSeqs.map(ref);
    if (['session/title', 'session/title-llm-request'].includes(e.type)) e.data.messageSeqs = e.data.messageSeqs.map(ref);
    if (e.type === 'command/done' && e.data.sourceEventSeq !== undefined) e.data.sourceEventSeq = ref(e.data.sourceEventSeq);
    if (e.type === 'developer/message' && e.data.headerSeq !== undefined) e.data.headerSeq = ref(e.data.headerSeq);
    return adoptSessionEvent(e);
  });
  const candidate = { header, events: repaired, inheritedEventCount: 0 };
  validate(candidate, known);
  // Original IDs, timestamps, messages, tool arguments/results and policies are
  // retained. Only event order and explicitly declared local references change.
  return { candidate, mapping: Object.fromEntries(mapping), movedMessageIds: prefix.map(e => e.data.id) };
}
async function durableFile(path, bytes, mode = 0o600) {
  const handle = await open(path, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDir(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
const located = new Set(); let failures = 0;
for (const bucket of await readdir(sessionsRoot, { withFileTypes: true })) {
  if (!bucket.isDirectory()) continue;
  for (const [id, jobIds] of jobs) {
    const dir = join(sessionsRoot, bucket.name, id), path = join(dir, 'session.v4.jsonl.zstd');
    try { await stat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let lock, temp;
    try {
      if (located.has(id)) throw new Error('Ambiguous session location'); located.add(id);
      lock = await open(join(dir, 'session.lock'), 'a'); await tryLockExclusive(lock.fd);
      const held = await lock.stat(), current = await stat(join(dir, 'session.lock'));
      if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('Session lock changed');
      const original = await readFile(path), artifact = decode(original);
      if (artifact.header.id !== id) throw new Error('Session identity mismatch');
      try { validate(artifact, known); console.log(JSON.stringify({ id, status: 'already-valid', eventCount: artifact.events.length })); continue; }
      catch (error) { if (!String(error.message).includes('system/message requires a protected first surface head')) throw error; }
      const repair = canonicalize(artifact);
      const headerBytes = Buffer.from(JSON.stringify(codec.encodeHeader(repair.candidate.header, 0)) + '\n');
      const bodyBytes = Buffer.from(repair.candidate.events.map(e => JSON.stringify(codec.encodeEvent(e)) + '\n').join(''));
      const replacement = Buffer.concat([zstdCompressSync(headerBytes), zstdCompressSync(bodyBytes)]);
      validate(decode(replacement), known);
      if (!apply) { console.log(JSON.stringify({ id, status: 'repairable', eventCount: artifact.events.length })); continue; }
      const backupDir = join(dataRoot, 'legacy-session-repairs', id, digest(original));
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const backup = join(backupDir, 'original.session.v4.jsonl.zstd');
      try { await durableFile(backup, original, 0o400); } catch (error) { if (error.code !== 'EEXIST' || digest(await readFile(backup)) !== digest(original)) throw error; }
      const manifest = { version: 1, sessionId: id, jobIds, path, backup, originalSha256: digest(original), repairedSha256: digest(replacement), eventCount: artifact.events.length, addedEvents: 0, removedEvents: 0, mapping: repair.mapping, movedMessageIds: repair.movedMessageIds, preparedAt: new Date().toISOString() };
      const transaction = randomUUID();
      await durableFile(join(backupDir, `${transaction}.json`), JSON.stringify(manifest, null, 2) + '\n');
      await syncDir(backupDir);
      await syncDir(dirname(backupDir)); await syncDir(dirname(dirname(backupDir))); await syncDir(dataRoot);
      temp = join(dir, `.legacy-repair-${transaction}.tmp`); await durableFile(temp, replacement);
      if (digest(await readFile(path)) !== manifest.originalSha256) throw new Error('Session changed during repair');
      await rename(temp, path); temp = undefined; await syncDir(dir);
      console.log(JSON.stringify({ id, status: 'repaired', eventCount: artifact.events.length, backup, originalSha256: manifest.originalSha256, repairedSha256: manifest.repairedSha256 }));
    } catch (error) { failures++; console.error(JSON.stringify({ id, status: 'not-modified-or-incomplete', error: error.message })); }
    finally { if (temp) await unlink(temp).catch(() => {}); if (lock) await lock.close(); }
  }
}
for (const id of jobs.keys()) if (!located.has(id)) { failures++; console.error(JSON.stringify({ id, status: 'not-found' })); }
if (failures) process.exitCode = 1;
