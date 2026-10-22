import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionEvidence } from '../src/snapshot.js';
import { writeEvidenceFile, readEvidenceRecord, outcomeRecordIds, prefillEvidence } from '../src/evidence-file.js';

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

test('terminal tool result survives a full context of early failures and a large manual', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-outcome-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { messages: [
    { role: 'user', sourceSeq: 0, content: 'Fetch and switch target branch' },
    { role: 'user', sourceSeq: 1, content: 'CLI MANUAL '.repeat(3000) },
    { role: 'assistant', sourceSeq: 100, content: 'Fetch completed using credential helper' },
  ], toolEvidence: Array.from({ length: 14 }, (_, i) => ({ id: String(i), name: 'bash', resultSeq: i + 2,
    // All transport calls succeeded, but only the final business operation did.
    status: 'succeeded', input: { command: i === 13 ? 'git -c credential.helper=temporary fetch' : 'git -c http.extraHeader=Bearer fetch' },
    output: i === 13 ? 'Fetched and switched target branch' : 'failure '.repeat(600),
  })), incompleteCalls: [], executionRecords: [{ type: 'turn/end', seq: 101, data: { reason: { kind: 'completed' } } }] };
  const file = await writeEvidenceFile(join(root, 'source.jsonl'), source);
  const ids = outcomeRecordIds(file);
  const final = file.index.find(entry => entry.callId === '13').record;
  assert.ok(ids.includes(final));
  const { evidence, bytes } = await prefillEvidence(new Map([['source', file]]));
  assert.ok(bytes <= 32768);
  assert.ok(evidence[0].records.some(record => record.record === final && record.value.input.command.includes('credential.helper')));
  assert.ok(evidence[0].records.some(record => record.value.content === 'Fetch completed using credential helper'));
  assert.ok(!evidence[0].records.some(record => record.record === 1));
  assert.ok(evidence[0].records.length < file.recordCount);
});

test('reserve outcomes from every turn and source, including interruptions and oversized records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-turns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = { messages: [{ role: 'user', sourceSeq: 0, content: 'goal' }], toolEvidence: [
    { id: 'failed', resultSeq: 1, name: 'bash', status: 'succeeded', output: 'exit code 128' },
    { id: 'large', resultSeq: 3, name: 'bash', status: 'succeeded', output: 'x'.repeat(12000) },
  ], incompleteCalls: [{ callId: 'pending', seq: 4 }], executionRecords: [
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
    { type: 'turn/end', seq: 5, data: { reason: { kind: 'interrupted' } } },
  ] };
  const file = await writeEvidenceFile(join(root, 'source.jsonl'), evidence);
  assert.deepEqual(outcomeRecordIds(file), [1, 2, 3, 4, 5]);
  const result = await prefillEvidence(new Map([['first', file], ['second', file]]), [], { maxBytes: 1500 });
  for (const item of result.evidence) {
    assert.ok(item.records.some(record => record.record === 1));
    assert.ok(item.records.some(record => record.record === 5));
    assert.ok(!item.records.some(record => record.record === 3));
  }
  assert.equal(result.evidence.length, 2);
  assert.ok(result.bytes <= 1500);
});
