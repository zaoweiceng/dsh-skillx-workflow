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

/** Frozen JSONL plus byte offsets: no transcript is placed in the author prompt. */
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
        ...(value.sourceSeq !== undefined ? { sourceSeq: value.sourceSeq, sourceTime: value.sourceTime } : {}),
        ...(value.role ? { role: value.role } : {}), ...(value.name ? { name: value.name } : {}),
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
