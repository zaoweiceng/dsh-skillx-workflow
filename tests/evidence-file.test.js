import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionEvidence } from '../src/snapshot.js';
import { writeEvidenceFile, readEvidenceRecord } from '../src/evidence-file.js';

test('native JSONL preserves event order and stores tool calls once, including incomplete calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = executionEvidence('s', { session: {}, events: [
    { seq: 1, time: 10, type: 'user/message', data: { content: 'goal' } },
    { seq: 2, time: 20, type: 'assistant/message', data: { content: [
      { type: 'text', text: 'checking' }, { type: 'tool-call', id: 'c', name: 'bash', arguments: '{"command":"unique-command"}' },
    ] } },
    { seq: 3, time: 30, type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"unique-command"}' } },
    { seq: 4, time: 40, type: 'tool/result', data: { message: { toolCallId: 'c', content: 'result' } } },
    { seq: 5, time: 50, type: 'assistant/message', data: { content: 'done' } },
    { seq: 6, time: 60, type: 'tool/call', data: { callId: 'unfinished', name: 'bash', arguments: '{}' } },
    { seq: 7, time: 70, type: 'turn/end', data: { reason: { kind: 'interrupted' } } },
  ] });
  const file = await writeEvidenceFile(join(root, 'source.jsonl'), source);
  const records = [];
  for (let i = 0; i < file.recordCount; i++) records.push(await readEvidenceRecord(file, i));
  assert.deepEqual(records.map(record => record.type), ['message', 'message', 'toolEvidence', 'message', 'incompleteCall', 'control']);
  assert.equal(records[1].value.sourceSeq, 2);
  assert.equal(records[2].value.callSeq, 3);
  assert.equal(records[2].value.resultSeq, 4);
  assert.equal(records[4].value.callId, 'unfinished');
  assert.equal((await readFile(file.path, 'utf8')).split('unique-command').length - 1, 1);
  assert.ok(records[1].value.content.includes('checking'));
  await assert.rejects(readEvidenceRecord(file, -1), /Invalid evidence record/);
});
