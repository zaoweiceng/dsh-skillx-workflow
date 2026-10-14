import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionSnapshot } from '../src/snapshot.js';

test('exports user messages and paired tool evidence without treating logs as instructions', () => {
  const body = extractionSnapshot('s', { session: { cwd: '/tmp' }, events: [
    { type: 'system/message', data: { message: { content: 'private system instructions' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'count words' }] } },
    { type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"wc"}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'orphan', content: 'ignored' } } },
    { type: 'tool/result', data: { message: { toolCallId: 'c', content: [{ type: 'text', text: '2' }] } } },
    { type: 'assistant/message', data: { message: { content: 'two words' } } },
  ] });
  assert.equal(body.messages.length, 2);
  assert.equal(body.toolEvidence.length, 1);
  assert.deepEqual(body.toolEvidence[0].input, { command: 'wc' });
  assert.equal(body.toolEvidence[0].status, 'succeeded');
  assert.ok(!JSON.stringify(body).includes('private system'));
});

test('does not fabricate evidence for incomplete tools or silently truncate oversized logs', () => {
  assert.throws(() => extractionSnapshot('s', { session: {}, events: [] }), /暂无/);
  assert.throws(() => extractionSnapshot('s', { session: {}, events: [{ type: 'user/message', data: { content: 'x'.repeat(65537) } }] }), /上限/);
  const body = extractionSnapshot('s', { session: {}, events: [
    { type: 'user/message', data: { content: 'hello' } },
    { type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{}' } },
  ] });
  assert.deepEqual(body.toolEvidence, []);
});

test('excludes injected skill instructions and reasoning, and uses latest effective cwd', () => {
  const body = extractionSnapshot('s', { session: { cwd: '/old' }, events: [
    { type: 'user/message', data: { source: { kind: 'user' }, content: 'human task' } },
    { type: 'user/message', data: { source: { kind: 'skill-invocation' }, content: 'private injected instructions' } },
    { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: 'private catalog' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'result' }] } } },
    { type: 'working-directory/change', data: { cwd: '/new' } },
  ] });
  assert.equal(body.messages.length, 2);
  assert.equal(body.cwd, '/new');
  assert.ok(!JSON.stringify(body).includes('private'));
});
