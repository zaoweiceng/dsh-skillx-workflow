import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const recordsOf = evidence => {
  const records = [
  ...evidence.messages.map((value, index) => ({ type: 'message', value: { ...value, messageIndex: index } })),
  ...evidence.toolEvidence.map(value => ({ type: 'toolEvidence', value })),
  ...evidence.incompleteCalls.map(value => ({ type: 'incompleteCall', value })),
  ...evidence.executionRecords.map(value => ({ type: 'control', value })),
  ];
  const seq = record => record.type === 'message' ? record.value.sourceSeq : record.type === 'toolEvidence' ? record.value.resultSeq : record.value.seq;
  // Imported/legacy fixtures without complete sequence metadata retain their original order.
  return records.every(record => Number.isSafeInteger(seq(record))) ? records.sort((a, b) => seq(a) - seq(b)) : records;
};

/** Frozen JSONL plus byte offsets for bounded complete-record delivery and selective reads. */
export async function writeEvidenceFile(path, evidence) {
  const file = await open(path, 'wx', 0o600);
  const index = [];
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const record of recordsOf(evidence)) {
      const line = Buffer.from(JSON.stringify(record) + '\n');
      // This is a host storage guard, not a model-context budget.
      if (bytes + line.length > 64 * 1024 * 1024) throw new Error('Evidence file exceeds 64 MiB storage limit; nothing was truncated');
      await file.writeFile(line);
      hash.update(line);
      const value = record.value;
      index.push({ record: index.length, offset: bytes, bytes: line.length, type: record.type,
        // A transport-successful tool can report a business failure. Preserve
        // its subsequent resolution chain even when later payloads are large.
        ...(record.type === 'toolEvidence' ? { continuationReview: value.status === 'failed' || /\[exit code:\s*(?:-[1-9]\d*|[1-9]\d*)\]|"ok"\s*:\s*false|"status"\s*:\s*"(?:blocked|failed|partial)"/.test(typeof value.output === 'string' ? value.output : (value.output ?? []).filter?.(block=>block.type==='text').map(block=>block.text).join('\n') ?? '') } : {}),
        ...(value.sourceSeq !== undefined ? { sourceSeq: value.sourceSeq, sourceTime: value.sourceTime } : {}),
        ...(value.role ? { role: value.role } : {}), ...(record.type === 'control' ? { controlType: value.type } : {}), ...(value.name ? { name: value.name } : {}),
        ...(value.id ? { callId: value.id } : {}), ...(value.status ? { status: value.status } : {}),
        ...(value.turn !== undefined ? { turn: value.turn, step: value.step } : {}) });
      bytes += line.length;
    }
    await file.sync();
  } finally { await file.close(); }
  return { path, format: 'jsonl', digest: hash.digest('hex'), bytes, recordCount: index.length, index };
}

export async function readEvidenceRecord(file, record) {
  if (!Number.isInteger(record) || record < 0) throw new Error('Invalid evidence record number');
  const entry = file.index[record];
  if (!entry) throw new Error('Unknown evidence record');
  const handle = await open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(entry.bytes);
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, entry.offset + read);
      if (!result.bytesRead) throw new Error('Incomplete evidence file');
      read += result.bytesRead;
    }
    return JSON.parse(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

/** Index/search pages contain bounded previews; detail reads remain explicit. */
export async function evidenceIndexPage(file, { cursor = 0, limit = 10, query, type } = {}) {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > file.recordCount || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid evidence index page: cursor must be 0..recordCount; limit must be 1..20. Follow nextCursor using limit 20');
  if (query !== undefined && (typeof query !== 'string' || query.length > 200)) throw new Error('Invalid literal evidence query');
  if (type !== undefined && !['message', 'toolEvidence', 'incompleteCall', 'control'].includes(type)) throw new Error('Invalid evidence record type');
  const matches = [];
  let next = cursor;
  for (; next < file.recordCount && matches.length < limit; next++) {
    const entry = file.index[next];
    if (type && entry.type !== type) continue;
    const record = await readEvidenceRecord(file, next);
    const text = JSON.stringify(record.value);
    const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : 0;
    if (at < 0) continue;
    const start = Math.max(0, at - 80);
    matches.push({ ...entry, preview: text.slice(start, start + 240), previewStart: start, previewTruncated: start > 0 || text.length > start + 240 });
  }
  return { matches, nextCursor: next < file.recordCount ? next : null, totalRecords: file.recordCount,
    nextRead: next < file.recordCount ? { view: 'index', cursor: next, limit: 20, ...(query !== undefined ? { query } : {}), ...(type ? { type } : {}) } : null };
}

/** Terminal observations are mandatory evidence, irrespective of reported success.
 * Tool transport status cannot establish whether a business command succeeded.
 */
export function outcomeRecordIds(file) {
  const required = new Set();
  let tool, assistant, incomplete, continuation = false;
  const finish = () => {
    for (const record of [tool, assistant, incomplete]) if (record !== undefined) required.add(record);
    tool = assistant = incomplete = undefined;
    continuation = false;
  };
  for (const entry of file.index) {
    if (entry.type === 'toolEvidence') {
      tool = entry.record;
      continuation ||= entry.continuationReview === true;
      if (continuation) required.add(entry.record);
    }
    if (entry.type === 'incompleteCall') incomplete = entry.record;
    if (entry.type === 'message' && entry.role === 'assistant') assistant = entry.record;
    if (entry.type === 'control' && entry.controlType === 'turn/end') {
      finish(); required.add(entry.record);
    }
  }
  finish();
  return [...required].sort((a, b) => a - b);
}

/** Reserve context for outcomes across ALL sources before filling with earlier work.
 * Oversized records remain indexed and must be read through lossless fragments.
 */
export async function prefillEvidence(files, references = [], { maxBytes = 32768, maxRecordBytes = 10000 } = {}) {
  const queue = [];
  for (const [sessionId, file] of files) {
    const outcomes = new Set(outcomeRecordIds(file));
    const cited = new Set(references.filter(ref => ref.sessionId === sessionId).map(ref => ref.record));
    for (const entry of file.index) queue.push({ sessionId, file, entry,
      priority: outcomes.has(entry.record) ? 0 : cited.has(entry.record) ? 1 : entry.type === 'message' && entry.role === 'user' ? 2 : 3 });
  }
  queue.sort((a, b) => a.priority - b.priority || a.entry.record - b.entry.record);
  const records = new Map([...files.keys()].map(id => [id, []]));
  let bytes = 0;
  for (const { sessionId, file, entry } of queue) {
    if (entry.bytes > maxRecordBytes || bytes + entry.bytes > maxBytes) continue;
    const record = { record: entry.record, ...await readEvidenceRecord(file, entry.record) };
    const size = Buffer.byteLength(JSON.stringify(record));
    if (bytes + size > maxBytes) continue;
    records.get(sessionId).push(record); bytes += size;
  }
  return { bytes, evidence: [...records].filter(([, records]) => records.length).map(([sessionId, records]) => ({
    sessionId, sourceDigest: files.get(sessionId).digest, records: records.sort((a, b) => a.record - b.record),
  })) };
}
