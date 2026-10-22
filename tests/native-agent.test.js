import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAgentService } from '../src/native-agent.js';
import { createStore } from '../src/native-store.js';

const execution = { language: 'typescript', inputSchema: { type: 'object', additionalProperties: false, properties: {forceFailure:{type:'boolean'}} },
  outputSchema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean' } }, required: ['accepted'] }, outcome:{path:'/accepted',values:{true:'completed',false:'failed'}}, program: 'return { accepted: !input.forceFailure };' };
const candidate = { docs: {'docs/troubleshooting.md':'# Failure guidance\nInspect the failed operation before continuing; preserve the declared accepted output.'}, compatibility: {platforms:['darwin','linux','win32'],requirements:[],limitations:'Pure deterministic JavaScript fixture; no external OS integration verified.'}, execution, name: 'observed-procedure', kind: 'workflow', description: 'A reusable observed procedure', content: '# Procedure\nUse the provided inputs and verify current results.', validationNotes: 'Source evidence is historical; no future verification claimed.' };
const responsibilities = [{ purpose: 'Fixture deterministic result', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: 'A single local expression with no independently useful sub-operation.' }];
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
    agentPresets: { acquireScope: async () => ({ key: 'standard', async [Symbol.asyncDispose]() {} }) },
    tools: { get: name => ({ name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' } } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'wrong-global-provider', model: 'wrong-global-model', reasoningEffort: 'high' }) },
    sessionQuery: { readSession: async () => structuredClone(source) },
    sessions: { flush: async session => { await flushHook?.(session); return true; } },
    agents: { async create(settings) {
      const tools = new Map(); const events = []; const listeners = new Map(); const guards = [];
      const agentCtx = { tools: { restrict: rule => { restrictions.push(rule); throw new Error('No global ask_user_question: question tools belong to the agent scope'); }, presentAs() {}, guard: fn => guards.push(fn), register: tool => { tools.set(tool.name, tool); } }, systemPrompt: { section() {} }, on: (name, handler) => listeners.set(name, handler) };
      await settings.setup(agentCtx);
      let completion; let cancelled = false;
      const agent = { session: { id: settings.sessionId, snapshotEvents: () => events, surface: { nodes: [] }, deriveMessages: () => [], append() {} },
        followup(message) {
          const prompt = JSON.parse(message.content[0].text);
          if (prompt.phase === 'plan') {
            completion = (async () => {
              for (const item of prompt.sourceSessions) await readOutcomes(tools, item);
              const existing = await store.get(candidate.name);
              if (existing) await tools.get('read_native_capability').execute({ name: candidate.name }, {});
              let value = options.skipPlanReason ? { decision: 'skip', reason: options.skipPlanReason, candidates: [], reuseNames: [] } : { decision: 'extract', reason: '存在具体独立复用目标。', candidates: existing ? [] : [{ name: candidate.name, kind: candidate.kind, description: candidate.description, reuseValue: 'Reusable operation with variable inputs in future supported tasks.', scope: 'One observed operation with variable inputs and explicit limits.', dependsOn: [], responsibilities, completionTrace:{goal:'生成可验证结果',doneWhen:'返回 accepted 结果',continuations:[],lessons:[{problem:'已观察工具失败',cause:'未知',resolution:'来源没有证明该失败已被修复，不编造修复步骤',disposition:'omit',reason:'仅保留 fixture 已证明的输出边界',sourceRecords:[{sessionId:prompt.sourceSessions[0].sessionId,record:1}]}]}, sourceRecords: [{ sessionId: prompt.sourceSessions[0].sessionId, record: 0 }] }], reuseNames: existing ? [candidate.name] : [] };
              events.push({ type: 'tool/call', data: { callId: 'plan', name: 'submit_native_plan' } });
              await tools.get('submit_native_plan').execute(value, { signal: new AbortController().signal, concludeTurn() {} });
              events.push({ type: 'tool/result', data: { message: { toolCallId: 'plan', isError: false } } });
              end(events);
            })();
          } else { prompts.push(prompt); completion = behavior({ tools, events, settings, listeners, session: agent.session, get cancelled() { return cancelled; } }); }
        },
        whenIdle: () => completion,
        cancel() { cancelled = true; },
      };
      const handle = { agent, async dispose() {} }; creations.push({ settings, handle, guards, listeners }); return handle;
    } },
  };
  const service = createNativeAgentService(ctx, store, { dataRoot, ...options }); t.after(async () => { await service.dispose(); await rm(dataRoot, { recursive: true, force: true }); });
  return { service, store, creations, prompts, restrictions, dataRoot, ctx, setFlushHook: fn => { flushHook = fn; } };
}
async function readOutcomes(tools, item) {
  const read = tools.get('read_native_execution');
  const ids = [...new Set([0, ...(item.outcomeRecordIds || [])])];
  for (const id of ids) {
    let partCursor = 0;
    do {
      const result = await read.execute({ sessionId: item.sessionId, view: 'records', recordIds: [id], partCursor }, {});
      partCursor = result.nextPartCursor;
    } while (partCursor != null);
  }
}
async function submit({ tools, events }, candidates = [candidate], reuseNames = []) {
  await tools.get('read_native_execution').execute({ sessionId: 'source', view: 'records', cursor: 0, limit: 1 }, {});
  const callId = 'native-submit';
  events.push({ type: 'tool/call', data: { callId, name: 'submit_native_capabilities' } });
  await tools.get('submit_native_capabilities').execute({ candidates, reuseNames }, { signal: new AbortController().signal, concludeTurn() {} });
  events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false } } });
}
const end = (events, kind = 'completed') => events.push({ type: 'turn/end', data: { reason: { kind } } });
async function settled(service, taskId) { for (let i = 0; i < 2000; i++) { const task = await service.get(taskId); if (!['queued', 'running'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('Task did not settle'); }

test('publishes only after native submission, completed turn and durability barrier', async t => {
  let staged;
  const f = await fixture(t, async env => { await submit(env); staged = await f.store.list(); end(env.events); });
  const task = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'completed', result.status === 'failed' ? await readFile(join(f.dataRoot, 'jobs', task.taskId + '.diagnostics.json'), 'utf8').catch(() => result.error) : result.error); assert.deepEqual(staged, []);
  assert.notEqual(result.plannerSessionId, result.generatorSessionId);
  assert.deepEqual(result.phaseSessions.map(item => [item.phase, item.status]), [['plan', 'completed'], ['build', 'completed']]);
  const checkpoint = JSON.parse(await readFile(join(f.dataRoot, 'jobs', task.taskId + '.plan.json'), 'utf8'));
  assert.deepEqual(f.prompts[0].savedPlan, checkpoint.plan);
  assert.ok(f.prompts[0].sourceEvidence[0].records.some(record => record.type === 'toolEvidence'));
  assert.equal((await f.store.get(candidate.name)).generatorSessionId, result.generatorSessionId);
  assert.deepEqual(f.restrictions, []);
  assert.equal(f.creations[0].settings.parentAgent, undefined);
  assert.equal(f.creations[0].settings.agentOptions.model, 'native-model');
  assert.equal(f.creations[0].settings.agentOptions.reasoningEffort, 'low');
  assert.equal(f.creations[0].settings.agentOptions.maxTokens, 4096);
  assert.equal(result.modelSourceSessionId, 'source');
  assert.equal(f.creations[0].settings.meta.agentPreset, 'standard');
  assert.deepEqual((await f.store.get(candidate.name)).execution, execution);
  assert.ok(f.prompts[0].sourceEvidence[0].records.some(record => record.type === 'toolEvidence'));
  const records = (await readFile(f.prompts[0].sourceSessions[0].path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.find(record => record.type === 'toolEvidence').value.status, 'failed');
});

test('failed native turn never publishes staged candidates', async t => {
  const f = await fixture(t, async env => { await submit(env); end(env.events, 'error'); });
  const task = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'failed'); assert.deepEqual(await f.store.list(), []);
});

test('scoped question tools stay allowed while author dispatch and presentation exclude business tools', async t => {
  const f = await fixture(t, async env => { await submit(env); end(env.events); });
  const task = await f.service.start({ sessionId: 'source' });
  assert.equal((await settled(f.service, task.taskId)).status, 'completed');
  for (const { guards, listeners } of f.creations) {
    const [guard] = guards;
    assert.equal(guard({ name: 'ask_user_question' }), undefined);
    assert.equal(guard({ name: 'read_native_execution' }), undefined);
    assert.match(guard({ name: 'bash' }), /only read/);
    assert.match(guard({ name: 'late_registered_team_tool' }), /only read/);
    const assembled = await listeners.get('system-prompt/assemble')({}, {}, async () => ({
      tools: ['ask_user_question', 'read_native_execution', 'bash', 'late_registered_team_tool'].map(name => ({ name })),
    }));
    assert.deepEqual(assembled.tools.map(tool => tool.name), ['ask_user_question', 'read_native_execution']);
  }
});

test('initialization failures retain a private diagnostic before a native session exists', async t => {
  const f = await fixture(t, async () => {});
  f.ctx.agents.create = async () => { throw new Error('Scoped initialization failed: private detail'); };
  const task = await f.service.start({ sessionId: 'source' });
  const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.error, /private detail/);
  const path = join(f.dataRoot, 'jobs', task.taskId + '.failure.json');
  const diagnostic = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(diagnostic.phase, 'plan');
  assert.equal(diagnostic.sessionId, result.plannerSessionId);
  assert.match(diagnostic.message, /private detail/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('cancellation during flush does not publish', async t => {
  const f = await fixture(t, async env => { await submit(env); end(env.events); });
  f.setFlushHook(async session => { const current = await f.service.get(task.taskId); if ([current.plannerSessionId].includes(session.id)) return; assert.equal(session.id, current.generatorSessionId); await f.service.cancel(task.taskId); });
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
  assert.equal(result.status, 'completed', result.error); assert.notEqual(first.generatorSessionId, second.generatorSessionId);
  assert.equal(f.creations.length, 3); assert.equal(f.prompts[1].selectedCapability.version, 1);
  assert.ok(f.prompts[1].sourceEvidence[0].records.some(record => record.type === 'toolEvidence'));
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
      const draft = await env.tools.get('read_native_draft').execute({name:'__draft__'}, {});
      env.events.push({type:'tool/call',data:{callId:'reuse',name:'submit_native_capabilities'}});
      await env.tools.get('submit_native_capabilities').execute({draftDigest:draft.draftDigest,draftEdits:[{op:'replace',path:'/reuseNames',value:[candidate.name]}]}, {signal:new AbortController().signal,concludeTurn(){}});
      env.events.push({type:'tool/result',data:{message:{toolCallId:'reuse',isError:false}}});
    } else await submit(env);
    end(env.events);
  });
  const first = await f.service.start({ sessionId: 'source' }); await settled(f.service, first.taskId); reuse = true;
  const second = await f.service.start({ sessionId: 'source' }); const result = await settled(f.service, second.taskId);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.entries.length, 0); assert.equal(result.reused[0].version, 1);
  assert.equal((await f.store.get(candidate.name)).version, 1);
});


test('large single-source evidence stays in JSONL and supports selective bounded reads', async t => {
  const marker = 'UNIQUE-END-OF-LARGE-RESULT';
  const f = await fixture(t, async env => {
    const read = env.tools.get('read_native_execution');
    const index = await read.execute({ sessionId: 'source', query: marker }, {});
    assert.equal(index.matches.length, 1);
    assert.equal(index.matches[0].status, 'failed');
    assert.ok(Buffer.byteLength(JSON.stringify(index)) < 1000);
    assert.ok(index.matches[0].preview.includes(marker));
    const excerpt = await read.execute({ sessionId: 'source', view: 'excerpt', cursor: index.matches[0].record, textOffset: index.matches[0].previewStart }, {});
    assert.ok(excerpt.fragment.includes(marker));
    assert.equal(excerpt.completeRecord, false);
    assert.ok(JSON.stringify(excerpt).length < 2000);
    const partial = await read.execute({ sessionId: 'source', view: 'records', cursor: index.matches[0].record, limit: 1 }, {});
    assert.equal(partial.encoding, 'json-text-fragments');
    assert.ok(Buffer.byteLength(JSON.stringify(partial)) < 11000);
    assert.ok(partial.nextPartCursor > 0);
    let cursor = partial.nextPartCursor;
    while (cursor != null) { const part = await read.execute({ sessionId: 'source', view: 'records', recordIds: [index.matches[0].record], partCursor: cursor }, {}); cursor = part.nextPartCursor; }
    await submit(env); end(env.events);
  });
  const large = structuredClone(source);
  large.events[3].data.message.content[0].text = 'x'.repeat(2 * 1024 * 1024) + marker;
  f.ctx.sessionQuery.readSession = async () => large;
  const task = await f.service.start({ sessionId: 'source' });
  const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'completed', result.error);
  assert.ok(Buffer.byteLength(JSON.stringify(f.prompts[0])) < 16000);
  assert.ok(!JSON.stringify(f.prompts[0]).includes(marker));
  assert.equal(f.prompts[0].sourceSessions[0].format, 'jsonl');
  assert.ok(f.prompts[0].sourceSessions[0].bytes > 2 * 1024 * 1024);
  const revision = await f.store.get(candidate.name);
  assert.equal(revision.evidence.reviewMode, 'selective-jsonl');
  assert.deepEqual(revision.evidence.reviewedRecordIds.source, [0, 1]);
});

test('index-only review cannot publish candidates', async t => {
  const f = await fixture(t, async env => {
    await env.tools.get('read_native_execution').execute({ sessionId: 'source' }, {});
    await assert.rejects(env.tools.get('submit_native_capabilities').execute({ candidates: [candidate] }, { signal: new AbortController().signal, concludeTurn() {} }), /OUTCOME_EVIDENCE_REQUIRED/);
    end(env.events);
  });
  const oversized = structuredClone(source);
  oversized.events[3].data.message.content[0].text = 'x'.repeat(12000);
  f.ctx.sessionQuery.readSession = async () => oversized;
  const task = await f.service.start({ sessionId: 'source' });
  assert.equal((await settled(f.service, task.taskId)).status, 'failed');
  assert.deepEqual(await f.store.list(), []);
});


test('multiple sources require relevant details from each, without requiring exhaustive reads', async t => {
  const f = await fixture(t, async env => {
    const signal = new AbortController().signal;
    await env.tools.get('read_native_execution').execute({ sessionId: 'source', view: 'records', limit: 1 }, {});
    assert.ok(f.prompts[0].sourceEvidence.find(item => item.sessionId === 'other').records.some(record => record.type === 'toolEvidence'));
    await env.tools.get('read_native_execution').execute({ sessionId: 'other', view: 'records' }, {});
    await submit(env); end(env.events);
  });
  const task = await f.service.start({ sessionIds: ['source', 'other'] });
  const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(f.prompts[0].sourceSessions.length, 2);
  assert.ok(f.prompts[0].sourceSessions.every(item => item.recordCount > 1));
  const saved = await f.store.get(candidate.name);
  assert.deepEqual(saved.evidence.reviewedRecordIds, { source: [0, 1], other: [0, 1] });
});


test('step estimates do not cancel an author that can complete', async t => {
  const f = await fixture(t, async env => {
    for (let i = 0; i < 25; i++) {
      const result = await env.listeners.get('agent/pre-step')({agent:{session:env.session}}, async () => ({ kind: 'continue' }));
      assert.equal(result.kind, 'continue');
    }
    await submit(env); end(env.events);
  });
  const task = await f.service.start({ sessionId: 'source' });
  const stopped = await settled(f.service, task.taskId);
  assert.equal(stopped.status, 'completed', stopped.error);
  assert.equal(stopped.stopReason, undefined);
  assert.equal((await f.store.list()).length,1);
});


test('a deliberate no-extraction decision completes normally without a builder or publication', async t => {
  const f = await fixture(t, async () => { throw new Error('Skip must not create a builder'); }, { skipPlanReason: '仅有一次性结论，没有稳定且值得复用的操作。' });
  const task = await f.service.start({ sessionId: 'source' });
  const result = await settled(f.service, task.taskId);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.outcome, 'skipped');
  assert.match(result.skipReason, /一次性/);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(await f.store.list(), []);
  assert.equal(f.creations.length, 1);
  assert.equal(result.phaseSessions.length, 1);
});

test('author repairs static syntax without executing business code', async t => {
  const f = await fixture(t, async env => {
    await env.tools.get('read_native_execution').execute({sessionId:'source',view:'records',cursor:0},{});
    await assert.rejects(env.tools.get('submit_native_capabilities').execute({candidates:[{...candidate, execution:{...execution,program:'return {'}}]}, {signal:new AbortController().signal,concludeTurn(){}}));
    assert.deepEqual(await f.store.list(),[]);
    const draft=await env.tools.get('read_native_draft').execute({name:'__draft__'},{});
    env.events.push({type:'tool/call',data:{callId:'repair',name:'submit_native_capabilities'}});
    await env.tools.get('submit_native_capabilities').execute({draftDigest:draft.draftDigest,programEdits:[{before:'return {',after:'throw new Error("MUST_NOT_RUN_DURING_EXTRACTION");'}]}, {signal:new AbortController().signal,concludeTurn(){}});
    env.events.push({type:'tool/result',data:{message:{toolCallId:'repair',isError:false}}});end(env.events);
  });
  const task=await f.service.start({sessionId:'source'}); const result=await settled(f.service,task.taskId);
  assert.equal(result.status,'completed',result.error);
  const stored=await f.store.get(candidate.name);
  assert.equal(stored.evidence.validation.behaviorTested,false);
  assert.match(await readFile(join(f.dataRoot,'revisions',stored.revisionId,'docs/troubleshooting.md'),'utf8'),/Failure guidance/);
});

test('builder may withdraw the entire batch without forced publication',async t=>{
 const f=await fixture(t,async env=>{
   env.events.push({type:'tool/call',data:{callId:'withdraw',name:'submit_native_capabilities'}});
   await env.tools.get('submit_native_capabilities').execute({skipReason:'No supported reusable increment survives verification.'},{signal:new AbortController().signal, concludeTurn() {}});
   env.events.push({type:'tool/result',data:{message:{toolCallId:'withdraw',isError:false}}}); end(env.events);
 });
 const task=await f.service.start({sessionId:'source'}); const result=await settled(f.service,task.taskId);
 assert.equal(result.status,'completed'); assert.equal(result.outcome,'skipped'); assert.deepEqual(await f.store.list(),[]);
});
