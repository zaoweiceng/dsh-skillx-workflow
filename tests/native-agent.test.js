import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAgentService } from '../src/native-agent.js';
import { createStore } from '../src/native-store.js';

const execution = { language: 'typescript', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean' } }, required: ['accepted'] }, program: 'return { accepted: true };' };
const candidate = { execution, name: 'observed-procedure', kind: 'workflow', description: 'A reusable observed procedure', content: '# Procedure\nUse the provided inputs and verify current results.', validationNotes: 'Source evidence is historical; no future verification claimed.' };
const source = { session: { id: 'source', cwd: '/tmp' }, events: [
  { type: 'request/header', data: { header: { config: { provider: 'native-provider', model: 'native-model', reasoningEffort: 'low', maxTokens: 4096 } } } },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'Perform the requested task.' }], source: { kind: 'user' } } },
  { type: 'tool/call', data: { callId: 'source-call', name: 'read', arguments: '{}' } },
  { type: 'tool/result', data: { message: { toolCallId: 'source-call', isError: true, content: [{ type: 'text', text: 'Observed failure' }] } } },
] };
async function fixture(t, behavior, options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'native-agent-'));
  const store = createStore({ dataRoot }); const creations = []; const prompts = []; const restrictions = [];
  let flushHook;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'wrong-global-provider', model: 'wrong-global-model', reasoningEffort: 'high' }) },
    sessionQuery: { readSession: async () => structuredClone(source) },
    sessions: { flush: async () => { await flushHook?.(); return true; } },
    agents: { async create(settings) {
      const tools = new Map(); const events = []; const listeners = new Map();
      const agentCtx = { tools: { restrict: rule => restrictions.push(rule), presentAs() {}, guard() {}, register: tool => { tools.set(tool.name, tool); } }, systemPrompt: { section() {} }, on: (name, handler) => listeners.set(name, handler) };
      await settings.setup(agentCtx);
      let completion; let cancelled = false;
      const agent = { session: { snapshotEvents: () => events },
        followup(message) { prompts.push(JSON.parse(message.content[0].text)); completion = behavior({ tools, events, settings, listeners, get cancelled() { return cancelled; } }); },
        whenIdle: () => completion,
        cancel() { cancelled = true; },
      };
      const handle = { agent, async dispose() {} }; creations.push({ settings, handle }); return handle;
    } },
  };
  const service = createNativeAgentService(ctx, store, { dataRoot, ...options }); t.after(async () => { await service.dispose(); await rm(dataRoot, { recursive: true, force: true }); });
  return { service, store, creations, prompts, restrictions, setFlushHook: fn => { flushHook = fn; } };
}
async function submit({ tools, events }, candidates = [candidate], reuseNames = []) {
  const callId = 'native-submit';
  events.push({ type: 'tool/call', data: { callId, name: 'submit_native_capabilities' } });
  await tools.get('submit_native_capabilities').execute({ candidates, reuseNames }, { signal: new AbortController().signal });
  events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false } } });
}
const end = (events, kind = 'completed') => events.push({ type: 'turn/end', data: { reason: { kind } } });
async function settled(service, taskId) { for (let i = 0; i < 200; i++) { const task = await service.get(taskId); if (!['queued', 'running'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('Task did not settle'); }

test('publishes only after native submission, completed turn and durability barrier', async t => {
  let staged;
  const f = await fixture(t, async env => { await submit(env); staged = await f.store.list(); end(env.events); });
  const task = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, task.taskId);
  assert.deepEqual(staged, []); assert.equal(result.status, 'completed');
  assert.equal((await f.store.get(candidate.name)).generatorSessionId, result.generatorSessionId);
  assert.deepEqual(f.restrictions, [{ allow: [] }]);
  assert.equal(f.creations[0].settings.parentAgent, undefined);
  assert.equal(f.creations[0].settings.agentOptions.model, 'native-model');
  assert.equal(f.creations[0].settings.agentOptions.reasoningEffort, 'low');
  assert.equal(f.creations[0].settings.agentOptions.maxTokens, 4096);
  assert.equal(result.modelSourceSessionId, 'source');
  assert.equal(f.creations[0].settings.meta.agentPreset, 'standard');
  assert.deepEqual((await f.store.get(candidate.name)).execution, execution);
  assert.equal((f.prompts[0].sourceEvidence.toolEvidence[0].status === 'failed'), true);
});

test('failed native turn never publishes staged candidates', async t => {
  const f = await fixture(t, async env => { await submit(env); end(env.events, 'error'); });
  const task = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'failed'); assert.deepEqual(await f.store.list(), []);
});

test('cancellation during flush does not publish', async t => {
  const f = await fixture(t, async env => { await submit(env); end(env.events); });
  f.setFlushHook(async () => { const active = f.creations[0].settings.sessionId; const current = await f.service.get(task.taskId); assert.equal(active, current.generatorSessionId); await f.service.cancel(task.taskId); });
  const task = await f.service.start({ sessionId: 'source' });
  const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'cancelled'); assert.deepEqual(await f.store.list(), []);
});

test('optimization creates a fresh native Agent and preserves source failures', async t => {
  let reuse = false;
  const f = await fixture(t, async env => {
    if (reuse) {
      const reference = await env.tools.get('read_native_capability').execute({ name: candidate.name }, {});
      assert.equal(reference.reference, 'initial-prompt.selectedCapability');
      assert.equal(reference.execution, undefined);
      await submit(env, [], [candidate.name]);
    } else await submit(env);
    end(env.events);
  });
  const first = await f.service.start({ sessionId: 'source' }); await settled(f.service, first.taskId);
  const second = await f.service.start({ sessionId: 'source', operation: 'optimize', name: candidate.name }); const result = await settled(f.service, second.taskId);
  assert.equal(result.status, 'completed'); assert.notEqual(first.generatorSessionId, second.generatorSessionId);
  assert.equal(f.creations.length, 2); assert.equal(f.prompts[1].selectedCapability.version, 1);
  assert.equal(f.prompts[1].sourceEvidence.toolEvidence[0].status, 'failed');
  assert.equal((await f.store.get(candidate.name)).version, 2);
  reuse = true;
  const third = await f.service.start({ sessionId: 'source', operation: 'optimize', name: candidate.name });
  const reused = await settled(f.service, third.taskId);
  assert.equal(reused.status, 'completed');
  assert.equal(reused.reused[0].version, 2);
  assert.equal((await f.store.get(candidate.name)).version, 2);
});

test('explicit reuse succeeds without a new revision and requires actual on-demand read', async t => {
  let reuse = false;
  const f = await fixture(t, async env => {
    if (reuse) {
      await assert.rejects(submit(env, [], [candidate.name]), /Read the current/);
      await env.tools.get('read_native_capability').execute({ name: candidate.name }, {});
      await submit(env, [], [candidate.name]);
    } else await submit(env);
    end(env.events);
  });
  const first = await f.service.start({ sessionId: 'source' }); await settled(f.service, first.taskId); reuse = true;
  const second = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, second.taskId);
  assert.equal(result.status, 'completed'); assert.equal(result.entries.length, 0); assert.equal(result.reused[0].version, 1);
  assert.equal((await f.store.get(candidate.name)).version, 1);
});
