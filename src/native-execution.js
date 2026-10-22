import { deliverResult, resultPage } from './result-delivery.js';
import { fileURLToPath } from 'node:url';
import { PROCESS_TOOL } from './native-process.js';
import { recoveryGuides } from './recovery-guides.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, appendFile, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeExecution, validateExecutionInput, validateExecutionOutput, businessOutcome } from './native-contract.js';
import { createHostExecutionContext } from './host-execution-context.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sandboxDenied, nativeRetryMode, nativeApprovalOutcome } from './native-tool-approval.js';

const json = value => JSON.parse(JSON.stringify(value));
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'UNKNOWN';
const categories = { AUTH: 'external', PERMISSION_DENIED: 'external', APPROVAL_DENIED: 'external', USER_DENIED: 'external', POLICY_DENIED: 'external', CREDENTIALS_MISSING: 'external' };
class ExecutionFault extends Error {
  constructor(identity, stage, category = 'internal', detail) { super(identity); this.code = identity; this.stage = stage; this.category = category; this.detail = detail; }
}
const constraints = {
  isolation: 'DSH native PTC process',
  directIO: 'Official Node PTC permits Node APIs. Direct I/O follows the resolved session sandbox; this receipt covers native tool dispatches, not every possible program effect.',
  authority: 'Native tool dispatches retain the calling Agent, root call and execution token. A safely retryable sandbox refusal may request native approval for one exact operation; standing session permissions are unchanged.',
};

/** Programs are DSH-authored data executed only by the host's public PTC service. */
export function createNativeExecutionService(ctx, store, {
  dataRoot, timeoutMs = 120000, maxCalls = 100, maxDepth = 8, maxOutputBytes = 65536, recover, nodeExecutable=process.execPath, pythonExecutable="python3", executables={},
} = {}) {
  if (!dataRoot) throw new Error('Execution dataRoot is required');
  for (const [key, value] of Object.entries({ timeoutMs, maxCalls, maxDepth, maxOutputBytes })) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid execution bound: ' + key);
  const tracesRoot = join(dataRoot, 'executions');
  const active = new Set();
  const hostExecutions = new WeakMap();
  const hostScope = createHostExecutionContext(ctx);
  const hostEntry = new AsyncLocalStorage();
  let disposed = false;
  const services = () => ({ ptc: ctx.get?.('ptcRuntime') ?? ctx.ptcRuntime, policy: ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy });
  const authority = exec => {
    if ((!exec?.agent?.session && !hostExecutions.has(exec)) || !exec.token || !exec.rootCallId || !exec.signal) throw new ExecutionFault('CALLER_AUTHORITY_REQUIRED', 'admission');
  };
  const contextOf = exec => hostExecutions.get(exec);
  const constraintsOf = exec => contextOf(exec) ? { ...constraints,
    authority: 'Human workbench execution uses host process permissions, without a DSH conversation or session sandbox.' } : constraints;
  async function newLedger(exec, resumeEvidence, options = {}) {
    authority(exec);
    await mkdir(tracesRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(tracesRoot)).isSymbolicLink()) throw new ExecutionFault('UNSAFE_TRACE_DIRECTORY', 'admission');
    const budget = options.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 3600000) throw new ExecutionFault('INVALID_EXECUTION_TIMEOUT', 'admission');
    const deadline = Math.min(Date.now() + budget, options.deadline ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new ExecutionFault('EXECUTION_TIMEOUT', 'admission', 'unknown');
    const runId = randomUUID(); const directory = join(tracesRoot, runId);
    await mkdir(directory, { mode: 0o700 });
    const host = contextOf(exec);
    const header = { runId, ...(host ? { executionContext: { kind: 'workbench', id: host.id, cwd: host.cwd, permissions: 'host' } }
      : { sessionId: exec.agent.session.header.id }), rootCallId: exec.rootCallId,
      startedAt: new Date().toISOString(), deadline, capability: options.capability, constraints: constraintsOf(exec) };
    const ledger = { ...header, directory, steps: [], implementations: [], relatedSessions: [], usage: [], reuse: new Map(), count: 0,
      controller: new AbortController(), pending: new Set(), toolTail: Promise.resolve(), logTail: Promise.resolve(), nativeFailures: [] };
    ledger.signal = AbortSignal.any([exec.signal, ledger.controller.signal]);
    ledger.timer = setTimeout(() => { ledger.timedOut = true; ledger.controller.abort(); }, Math.max(1, deadline - Date.now()));
    ledger.timer.unref?.();
    const event = value => { const result = ledger.logTail.then(() => appendFile(join(directory, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 })); ledger.logTail = result; return result; };
    ledger.event = event;
    await writeFile(join(directory, 'header.json'), JSON.stringify(header, null, 2), { mode: 0o600 });
    if (resumeEvidence !== undefined) {
      const priorRunIds = Array.isArray(resumeEvidence) ? resumeEvidence : [typeof resumeEvidence === 'string' ? resumeEvidence : resumeEvidence.runId];
      if (priorRunIds.length > 8) throw new ExecutionFault('RESUME_EVIDENCE_LIMIT', 'admission');
      for (const priorRunId of priorRunIds) {
        if (typeof priorRunId !== 'string' || !/^[a-f0-9-]{36}$/.test(priorRunId)) throw new ExecutionFault('INVALID_RESUME_REFERENCE', 'admission');
        const prior = join(tracesRoot, priorRunId);
        const priorHeader = JSON.parse(await readFile(join(prior, 'header.json'), 'utf8'));
        if (priorHeader.sessionId !== header.sessionId || priorHeader.executionContext?.id !== header.executionContext?.id || priorHeader.rootCallId !== header.rootCallId) throw new ExecutionFault('RESUME_AUTHORITY_MISMATCH', 'admission');
        const events = (await readFile(join(prior, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        for (const item of events) if (item.type === 'dispatch/end' && item.status === 'succeeded' && item.reusable === true) ledger.reuse.set(item.stepId, item);
        ledger.relatedSessions.push(...(JSON.parse(await readFile(join(prior, 'receipt.json'), 'utf8'))).relatedSessions ?? []);
      }
    }
    await event({ type: 'execution/start', ...header });
    return ledger;
  }
  const check = ledger => {
    if (ledger.authorizationFailure) throw ledger.authorizationFailure;
    ledger.signal.throwIfAborted();
    if (++ledger.count > maxCalls) throw new ExecutionFault('EXECUTION_CALL_LIMIT', 'dispatch');
  };
  const track = (ledger, promise) => { ledger.pending.add(promise); promise.then(() => ledger.pending.delete(promise), () => ledger.pending.delete(promise)); return promise; };
  async function callTool(request, exec, ledger, owner) {
    check(ledger);
    if (!request || typeof request.name !== 'string' || !request.name || request.name === 'capability_run' || request.name === 'run_code') throw new ExecutionFault('INVALID_NATIVE_TOOL', 'dispatch');
    const stepId = `${ledger.runId}:${ledger.steps.length + 1}`;
    const callId = `${exec.callId}:capability:${ledger.count}`;
    const step = { stepId, kind: 'tool', name: request.name, capability: owner.name, status: 'running', startedAt: new Date().toISOString() };
    ledger.steps.push(step);
    const args = json(request.arguments ?? {});
    await ledger.event({ type: 'dispatch/start', ...step, arguments: args });
    const dispatch = async (arguments_, identity) => {
      ledger.signal.throwIfAborted();
      const invoke = () => ctx.tools.execute({ name: request.name, arguments: arguments_, ...(exec.agent ? { agent: exec.agent } : {}), parent: exec.token,
        rootCallId: exec.rootCallId, callId: identity, signal: ledger.signal });
      const host = contextOf(exec);
      return host ? hostScope.run(host, invoke) : invoke();
    };
    const authorizationFailure = async (identity, detail) => {
      const fault = new ExecutionFault(identity, 'authorization', 'external', detail);
      ledger.authorizationFailure = fault;
      await ledger.event({ type: 'authorization/blocked', stepId, code: identity, detail });
      throw fault;
    };
    const outcomeCode = outcome => ({ rejected: 'APPROVAL_DENIED', cancelled: 'APPROVAL_CANCELLED', unavailable: 'APPROVAL_UNAVAILABLE' })[outcome] ?? 'APPROVAL_UNAVAILABLE';
    const execute = async () => {
      if (ledger.authorizationFailure) throw ledger.authorizationFailure;
      const session = exec.agent?.session;
      const since = session?.seq;
      const initial = await dispatch(args, callId);
      if (!session || contextOf(exec)) return initial;
      if (!initial.isError && !sandboxDenied(initial)) return initial;
      const initialApproval = nativeApprovalOutcome(session, callId, since);
      if (initialApproval && initialApproval !== 'allowed-once') return authorizationFailure(outcomeCode(initialApproval), 'The native authorization was not granted; the operation was not retried.');
      if (!sandboxDenied(initial)) return initial;
      await ledger.event({ type: 'dispatch/attempt', stepId, attempt: 1, callId, status: 'sandbox-denied',
        value: initial.value, error: initial.error, content: initial.content, reusable: false });
      let mode;
      try { mode = await nativeRetryMode(ctx, request.name, args, initial, exec.agent, ledger.signal); }
      catch { return authorizationFailure('SANDBOX_RETRY_UNSAFE', 'Cannot determine a safe one-operation permission retry.'); }
      if (!mode) return authorizationFailure('SANDBOX_RETRY_UNSAFE', 'The denied operation may have partially executed or does not support a native one-operation grant; do not replay it.');
      check(ledger);
      const retryCallId = callId + ':approval-retry';
      const retryArgs = { ...args, sandbox_permissions: mode,
        justification: 'SkillX「' + owner.name + '」的操作被沙箱拒绝，是否仅授权本次原样重试？操作：' + (args.command ?? args.file_path ?? request.name) };
      await ledger.event({ type: 'authorization/retry', stepId, callId: retryCallId, mode, arguments: retryArgs });
      const retrySince = session.seq;
      // The native tool requests approval before performing this retry. Keep
      // the entire wait and retry in the original serialized tool slot: the
      // capability program is suspended, never restarted.
      let retried;
      try { retried = await dispatch(retryArgs, retryCallId); }
      catch { return authorizationFailure(ledger.signal.aborted ? 'APPROVAL_CANCELLED' : 'APPROVAL_UNAVAILABLE',
        'The permission retry could not settle; retain its evidence and do not replay completed operations.'); }
      const outcome = nativeApprovalOutcome(session, retryCallId, retrySince);
      await ledger.event({ type: 'dispatch/attempt', stepId, attempt: 2, callId: retryCallId,
        approvalOutcome: outcome ?? 'unavailable', value: retried.value, error: retried.error, content: retried.content, reusable: false });
      if (outcome !== 'allowed-once') return authorizationFailure(outcomeCode(outcome), 'Native approval did not grant the retry; stop without replaying completed steps.');
      if (sandboxDenied(retried)) return authorizationFailure('SANDBOX_DENIED_AFTER_APPROVAL', 'The one-operation grant did not resolve the denial; no further retry was attempted.');
      step.approvalRetry = { callId: retryCallId, mode, outcome };
      return retried;
    };
    // Serialize native dispatches conservatively: generated Promise.all must not
    // overlap effects whose tool contract classifies them as exclusive.
    const running = ledger.toolTail.then(execute);
    ledger.toolTail = running.catch(() => {});
    let result;
    try { result = await track(ledger, running); }
    catch (error) {
      step.status = 'failed'; step.finishedAt = new Date().toISOString(); step.code = code(error.code);
      await ledger.event({ type: 'dispatch/end', ...step, error: { name: error.name, message: error.message } });
      if (error instanceof ExecutionFault) throw error;
      throw new ExecutionFault(step.code, 'native-tool', categories[step.code] ?? 'unknown');
    }
    step.finishedAt = new Date().toISOString();
    if (result.isError) {
      step.status = 'failed'; step.code = code(result.error?.info?.code);
      ledger.nativeFailures.push({ stepId, code: step.code });
      await ledger.event({ type: 'dispatch/end', ...step, error: result.error, content: result.content, reusable: false });
      throw new ExecutionFault(step.code, 'native-tool', categories[step.code] ?? 'unknown');
    }
    step.status = 'succeeded'; step.outputDigest = hash(result.value);
    await ledger.event({ type: 'dispatch/end', ...step, value: result.value, content: result.content, reusable: true });
    // Nested images/context are not silently injected into the calling model.
    // All program-visible data stays behind the black-box contract.
    return json(result.value);
  }
  async function executeProgram(execution, input, exec, ledger, owner, path) {
    check(ledger);
    if (path.length > maxDepth) throw new ExecutionFault('CAPABILITY_DEPTH_LIMIT', 'admission');
    const identity = `${owner.name}@${owner.version ?? 0}`;
    if (path.includes(identity)) throw new ExecutionFault('CAPABILITY_CYCLE', 'admission');
    const contract = normalizeExecution(execution);
    if (!contract) throw new ExecutionFault('EXECUTION_IMPLEMENTATION_MISSING', 'admission');
    const inputErrors = validateExecutionInput(contract, input);
    if (inputErrors.length) throw new ExecutionFault('INPUT_SCHEMA_INVALID', 'input', 'internal', inputErrors);
    const { ptc, policy } = services();
    if (contract.language!=='python' && (!ptc?.resolve || !ptc?.run || ptc.language !== 'typescript' || ptc.isolation !== 'process' || !policy?.resolve)) throw new ExecutionFault('NATIVE_PTC_UNAVAILABLE', 'admission', 'external');
    const implementationId = `${ledger.runId}:implementation:${ledger.implementations.length + 1}`;
    const implementation = { implementationId, name: owner.name, version: owner.version, revisionId: owner.revisionId, input: json(input), execution: contract, dependencies: owner.dependencies ?? [] };
    ledger.implementations.push({ implementationId, name: owner.name, version: owner.version, revisionId: owner.revisionId, digest: hash(contract) });
    await ledger.event({ type: 'implementation/start', ...implementation });
    const bindings = {
      input: async () => json(input),
      tool: async request => callTool(request, exec, ledger, owner),
      process: async request => {
        if (!request || typeof request!=='object') throw new ExecutionFault('INVALID_PROCESS_REQUEST','dispatch');
        return callTool({name:PROCESS_TOOL,arguments:{...request,timeoutMs:Math.max(1,Math.min(request.timeoutMs ?? 120000,ledger.deadline-Date.now()))}},exec,ledger,owner);
      },
      script: async request => {
        if (!request || typeof request.path!=='string') throw new ExecutionFault('INVALID_RESOURCE_PATH','resource');
        const entryPath=request.path==='@entry'?await store.resolveEntry(owner,{signal:ledger.signal}):await store.resolveResource(owner,request.path,{signal:ledger.signal});
        const paths={};
        for(const path of Object.keys(owner.resources ?? {})) paths[path]=await store.resolveResource(owner,path,{signal:ledger.signal});
        const runtime=request.path==='@entry'?'python':request.path.endsWith('.py')?'python':'node';
        const context={resources:paths,nodeExecutable,pythonExecutable,executables};
        const args=runtime==='node'?[fileURLToPath(new URL('./script-bootstrap.cjs',import.meta.url)),entryPath]:[entryPath];
        const result=await callTool({name:PROCESS_TOOL,arguments:{executable:runtime==='node'?'@node':'@python',args,
          ...(request.cwd ? {cwd:request.cwd}:{}),...(request.pathPrefix ? {pathPrefix:request.pathPrefix}:{}),
          inheritEnv:request.inheritEnv ?? [],stdin:JSON.stringify({input:request.input ?? input,context}),
          timeoutMs:Math.max(1,Math.min(request.timeoutMs ?? 120000,ledger.deadline-Date.now()))}},exec,ledger,owner);
        if(result.exitCode!==0 || result.timedOut || result.aborted || result.stdout?.truncated || result.stderr?.truncated) throw new ExecutionFault('SCRIPT_EXECUTION_FAILED','program','unknown',result.stderr?.text);
        try {return JSON.parse(result.stdout.text);} catch {throw new ExecutionFault('SCRIPT_OUTPUT_INVALID','output');}
      },
      resource: async request => {
        check(ledger);
        if (typeof request?.path !== 'string') throw new ExecutionFault('INVALID_RESOURCE_PATH', 'resource');
        return store.resolveResource(owner, request.path, {signal:ledger.signal});
      },
      reuse: async request => {
        check(ledger);
        const previous = ledger.reuse.get(request?.stepId);
        if (!previous) throw new ExecutionFault('RESUME_STEP_UNAVAILABLE', 'resume');
        await ledger.event({ type: 'dispatch/reuse', stepId: request.stepId, owner: owner.name, note: 'Explicit reuse by the DSH-authored program; no operation replayed.' });
        return json(previous.value);
      },
      capability: async request => {
        check(ledger);
        const lock = (owner.dependencies ?? []).find(dependency => dependency.name === request?.name);
        if (!lock) throw new ExecutionFault('UNDECLARED_CAPABILITY_DEPENDENCY', 'dependency');
        let definition = ledger.boundDefinitions.get(lock.name);
        if (!definition) {
          const bundle = await store.loadBundle(lock.name, { signal: ledger.signal });
          if (!bundle || bundle.root.version !== lock.version) throw new ExecutionFault('CAPABILITY_DEPENDENCY_CHANGED', 'dependency');
          for (const entry of bundle.entries) {
            const bound = ledger.boundDefinitions.get(entry.name);
            if (bound && bound.revisionId !== entry.revisionId) throw new ExecutionFault('CAPABILITY_DEPENDENCY_CHANGED', 'dependency');
            ledger.boundDefinitions.set(entry.name, entry);
          }
          definition = bundle.root;
        }
        if (definition.version !== lock.version) throw new ExecutionFault('CAPABILITY_DEPENDENCY_CHANGED', 'dependency');
        try { return await executeProgram(definition.execution, request.input, exec, ledger, definition, [...path, identity]); }
        catch (error) { ledger.failedCapability ??= {name:definition.name,version:definition.version,revisionId:definition.revisionId}; throw error; }
      },
      // Legacy programs fail into internal recovery rather than starting a model on the normal path.
      reason: async () => { throw new ExecutionFault('AGENT_INTERVENTION_REQUIRES_FAILURE', 'program'); },
    };
    if(contract.language==='python'){
      const value=await track(ledger,bindings.script({path:'@entry',input}));
      await ledger.event({type:'implementation/end',implementationId,value});
      const errors=validateExecutionOutput(contract,value);
      if(errors.length)throw new ExecutionFault('OUTPUT_SCHEMA_INVALID','output','internal',errors);
      return value;
    }
    const functions = Object.fromEntries(Object.entries(bindings).map(([name, fn]) => [name, request => track(ledger, Promise.resolve().then(() => fn(request)))]));
    const program = `const input = await __native_capability.input({});\nconst tools = Object.freeze({call: request => __native_capability.tool(request), reuse: request => __native_capability.reuse(request)});\nconst capabilities = Object.freeze({run: request => __native_capability.capability(request), reason: request => __native_capability.reason(request)});\nconst resources = Object.freeze({path: path => __native_capability.resource({path}), run: request => __native_capability.script(JSON.parse(JSON.stringify(request)))});\nconst processes = Object.freeze({run: request => __native_capability.process(JSON.parse(JSON.stringify(request)))});\n${contract.program}`;
    const host = contextOf(exec);
    const sandboxPolicy = host ? { mode: 'danger-full-access', workspaceRoot: host.cwd } : policy.resolve({ session: exec.agent.session });
    const spec = ptc.resolve({ program, bindings: [{ global: '__native_capability', functions }],
      cwd: host?.cwd ?? exec.agent.session.header.cwd, signal: ledger.signal, sandboxPolicy, timeoutMs: Math.max(1, ledger.deadline - Date.now()) });
    const result = await track(ledger, ptc.run(spec));
    await ledger.event({ type: 'implementation/end', implementationId, sandbox: result.sandbox, logs: result.logs, error: result.error, ...(result.error ? {} : { value: result.value }) });
    if (ledger.authorizationFailure) throw ledger.authorizationFailure;
    if (result.error) throw new ExecutionFault('PROGRAM_' + result.error.kind.replaceAll('-', '_').toUpperCase(), 'program', ledger.nativeFailures.length ? 'unknown' : 'internal', result.error);
    const outputErrors = validateExecutionOutput(contract, result.value);
    if (outputErrors.length) throw new ExecutionFault('OUTPUT_SCHEMA_INVALID', 'output', 'internal', outputErrors);
    return result.value;
  }
  async function perform(execution, input, exec, owner, options = {}) {
    let ledger;
    try {
      if (disposed) throw new ExecutionFault('EXECUTION_SERVICE_DISPOSED', 'admission');
      ledger = await newLedger(exec, options.resumeEvidence, { ...options, capability: { name: owner.name, kind: owner.kind, version: owner.version, revisionId: owner.revisionId } });
      ledger.boundDefinitions = new Map((options.bundleEntries || [owner]).map(entry => [entry.name, entry]));
      active.add(ledger);
      const output = await executeProgram(execution, json(input ?? {}), exec, ledger, owner, []);
      // A program must await every host call. Returning while bindings remain
      // active is an implementation failure, not permission to finish effects
      // invisibly after the reported result. Drain before allowing recovery.
      if (ledger.pending.size) { ledger.controller.abort(); await Promise.allSettled([...ledger.pending]); throw new ExecutionFault('UNAWAITED_BINDINGS', 'program'); }
      // PTC owns process cleanup; full binding lifetimes are tracked above.
      await Promise.allSettled([...ledger.pending]);
      const receipt = { runId: ledger.runId, status: 'completed', businessOutcome:businessOutcome(execution,output), capability: { name: owner.name, kind: owner.kind, version: owner.version, revisionId: owner.revisionId },
        implementations: ledger.implementations, steps: ledger.steps, relatedSessions: [...new Set(ledger.relatedSessions)], usage: ledger.usage,
        startedAt: ledger.startedAt, deadline: ledger.deadline, finishedAt: new Date().toISOString(), constraints: constraintsOf(exec), outputDigest: hash(output) };
      await writeFile(join(ledger.directory, 'output.json'), JSON.stringify(output), { mode: 0o600 });
      await ledger.event({ type: 'execution/end', status: 'completed', output, receipt });
      await writeFile(join(ledger.directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      await ledger.logTail;
      return { ok: true, output: json(output), receipt };
    } catch (error) {
      ledger?.controller.abort();
      if (ledger) await Promise.allSettled([...ledger.pending]);
      // Cancellation may settle the PTC process before the native approval
      // decision is logged. Drain the binding first and retain that decision,
      // rather than sending a declined/cancelled operation into model repair.
      const failed = ledger?.authorizationFailure ?? error;
      const timedOut = ledger?.timedOut && !ledger.authorizationFailure;
      const failure = { capability: ledger?.failedCapability?.name ?? owner.name, capabilityVersion: ledger?.failedCapability?.version ?? owner.version, capabilityRevisionId: ledger?.failedCapability?.revisionId ?? owner.revisionId, code: timedOut ? 'EXECUTION_TIMEOUT' : code(failed.code), category: timedOut ? 'unknown' : failed.category ?? 'unknown', stage: failed.stage ?? 'infrastructure', retryable: false,
        ...(ledger?.nativeFailures.length ? { observedNativeFailures: ledger.nativeFailures.slice(-8) } : {}) };
      const receipt = { ...(ledger ? { runId: ledger.runId, startedAt: ledger.startedAt, deadline: ledger.deadline } : {}), status: 'failed',
        capability: { name: owner.name, version: owner.version, revisionId: owner.revisionId }, steps: ledger?.steps ?? [],
        relatedSessions: [...new Set(ledger?.relatedSessions ?? [])], usage: ledger?.usage ?? [], finishedAt: new Date().toISOString(), constraints: constraintsOf(exec) };
      if (ledger) {
        try {
          await ledger.event({ type: 'execution/end', status: 'failed', failure, diagnostic: { name: failed.name, message: failed.message, detail: failed.detail }, receipt });
          await writeFile(join(ledger.directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
          await ledger.logTail;
        } catch { failure.traceUnavailable = true; }
      }
      return { ok: false, failure, receipt, ...(ledger ? { traceRef: ledger.runId } : {}) };
    } finally { if (ledger) { clearTimeout(ledger.timer); ledger.controller.abort(); active.delete(ledger); } }
  }
  const service = {
    delivery(output, receipt) {
      const result = deliverResult(output, receipt.runId, Math.min(maxOutputBytes, 16384));
      if (receipt.steps?.length) result.delivery.observations = {tool:'capability_result_read',runId:receipt.runId,stepId:'index',instruction:'Retained native observations, including query details omitted from the final summary. Read only needed entries; never requery solely for detail.'};
      return result;
    },
    async readResult({runId, pointer, offset, limit, stepId, jsonTextPointer}, exec) {
      authority(exec);
      if (jsonTextPointer !== undefined && (stepId === undefined || stepId === 'index')) throw new ExecutionFault('INVALID_RESULT_JSON_TEXT_SOURCE','result');
      if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw new ExecutionFault('INVALID_RESULT_REFERENCE', 'result');
      const directory = join(tracesRoot, runId);
      const header = JSON.parse(await readFile(join(directory, 'header.json'), 'utf8'));
      // Subsequent tool calls have different rootCallIds; the owning session is
      // the stable authority. Workbench outputs cannot be read by a chat.
      if (!exec.agent?.session.header.id || header.sessionId !== exec.agent.session.header.id || header.executionContext) throw new ExecutionFault('RESULT_AUTHORITY_MISMATCH', 'result', 'external');
      if (stepId !== undefined) {
        if (stepId !== 'index' && (typeof stepId !== 'string' || !stepId.startsWith(runId + ':') || !/^[1-9][0-9]*$/.test(stepId.slice(runId.length + 1)))) throw new ExecutionFault('INVALID_RESULT_STEP', 'result');
        const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        const observations = events.filter(event => event.type === 'dispatch/end' && event.status === 'succeeded' && Object.hasOwn(event,'value'));
        let value;
        if (stepId === 'index') value = observations.map(event => ({stepId:event.stepId,name:event.name,read:{runId,stepId:event.stepId,pointer:'',offset:0,limit:4000}}));
        else {
          const observation = observations.find(event => event.stepId === stepId);
          if (!observation) throw new ExecutionFault('RESULT_STEP_NOT_FOUND','result','external');
          value = observation.value;
          // Optional decoding is explicit, never inferred from business fields.
          if (jsonTextPointer !== undefined) {
            resultPage(value,{pointer:jsonTextPointer,limit:4000});
            let text = value;
            for (const key of jsonTextPointer === '' ? [] : jsonTextPointer.slice(1).split('/').map(key=>key.replace(/~1/g,'/').replace(/~0/g,'~'))) text = text[key];
            if (typeof text !== 'string') throw new ExecutionFault('RESULT_NOT_JSON_TEXT','result','external');
            try { value = JSON.parse(text); } catch { throw new ExecutionFault('RESULT_NOT_JSON_TEXT','result','external'); }
          }
        }
        return {runId,stepId,...resultPage(value,{pointer,offset,limit})};
      }
      let output;
      try { output = JSON.parse(await readFile(join(directory, 'output.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {
          const resolved = JSON.parse(await readFile(join(directory, 'resolved.json'), 'utf8'));
          output = resolved.output;
        } catch (resolvedError) {
          if (resolvedError.code !== 'ENOENT') throw resolvedError;
          // Old OUTPUT_SIZE_LIMIT runs already validated their result before
          // failing delivery. Recover that exact saved value, never requery.
          const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
          const end = events.findLast(event => event.type === 'execution/end');
          const implementation = events.findLast(event => event.type === 'implementation/end' && Object.hasOwn(event, 'value'));
          if (end?.failure?.code !== 'OUTPUT_SIZE_LIMIT' || !implementation) throw new ExecutionFault('RESULT_UNAVAILABLE', 'result', 'external');
          output = implementation.value;
          await writeFile(join(directory, 'output.json'), JSON.stringify(output), {mode:0o600});
        }
      }
      return {runId, ...resultPage(output, {pointer, offset, limit})};
    },
    isHostCall(exec) {
      const host = hostEntry.getStore();
      return !!host && !exec.agent && exec.rootCallId === host.id && exec.name === 'capability_run';
    },
    async runHostCall(request, exec) {
      if (!service.isHostCall(exec)) throw new ExecutionFault('HOST_AUTHORITY_REQUIRED', 'admission');
      const host = hostEntry.getStore();
      hostExecutions.set(exec, host);
      try {
        const deadline = Date.now() + 600000;
        const result = await service.run({ ...request, timeoutMs: 120000, deadline }, exec);
        if (!result.ok && result.entry?.execution && result.failure?.stage !== 'authorization' && result.failure?.code !== 'PLATFORM_UNSUPPORTED' && typeof recover === 'function' && !exec.signal.aborted && Date.now() < deadline) {
          const trace = result.traceRef ? await service.readTrace(result.traceRef, exec) : { receipt:result.receipt };
          const restored = await recover({ entry:result.entry, input:request.input, failure:result.failure, receipt:result.receipt, trace, failureGuides:result.failureGuides, resourceEntries:result.resourceEntries, exec, deadline, hostContext:host });
          result.receipt.relatedSessions = [...new Set([...(result.receipt.relatedSessions ?? []), ...(restored.relatedSessions ?? [])])];
          if (result.receipt.runId) {
            const directory = join(tracesRoot, result.receipt.runId);
            await appendFile(join(directory, 'events.jsonl'), JSON.stringify({type:'recovery/end',outcome:restored.outcome,category:restored.category,reason:restored.reason,relatedSessions:result.receipt.relatedSessions,recoveryRuns:result.receipt.recoveryRuns ?? [],finishedAt:new Date().toISOString()}) + '\n', {mode:0o600});
            await writeFile(join(directory,'receipt.json'),JSON.stringify(result.receipt,null,2),{mode:0o600});
          }
          if (restored.outcome === 'completed' && !exec.signal.aborted && Date.now() < deadline) {
            const receipt = { ...result.receipt, status:'completed', businessOutcome:businessOutcome(result.entry.execution,restored.output), recovered:true, finishedAt:new Date().toISOString(), outputDigest:'sha256:' + createHash('sha256').update(JSON.stringify(restored.output)).digest('hex') };
            if (receipt.runId) await writeFile(join(tracesRoot, receipt.runId, 'resolved.json'), JSON.stringify({receipt,output:restored.output}), {mode:0o600});
            return {status:'completed',...service.delivery(restored.output,receipt),receipt};
          }
          const failureCode = result.failure.observedNativeFailures?.at(-1)?.code ?? result.failure.code;
          return {status:'blocked',error:{category:result.failure.category,code:result.failure.code,recovery:{category:restored.category,code:restored.reason},originalFailure:result.failure,message:`Execution failed (${failureCode}); internal recovery could not complete the task (${restored.reason}). Inspect the retained execution records.`},receipt:result.receipt};
        }
        const receipt = json(result.receipt);
        return result.ok ? { status: 'completed', ...service.delivery(result.output,receipt), receipt }
          : { status: 'blocked', error: { ...result.failure, message: result.failure.code === 'PLATFORM_UNSUPPORTED'
            ? `${result.failure.capability} does not support ${result.failure.platform}. ${result.failure.compatibility.limitations}`
            : 'Execution failed; inspect the retained execution record before retrying.' }, receipt };
      } finally { hostExecutions.delete(exec); }
    },
    async readTrace(runId, exec) {
      authority(exec);
      if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw new ExecutionFault('INVALID_TRACE_REFERENCE', 'trace');
      const directory = join(tracesRoot, runId);
      const header = JSON.parse(await readFile(join(directory, 'header.json'), 'utf8'));
      if (header.sessionId !== exec.agent?.session.header.id || header.executionContext?.id !== contextOf(exec)?.id || header.rootCallId !== exec.rootCallId) throw new ExecutionFault('TRACE_AUTHORITY_MISMATCH', 'trace');
      const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
      return { header, events, receipt };
    },
    async run({ name, input, expectedRevisionId, snapshotRevisionId, timeoutMs: remainingTimeout, deadline }, exec) {
      let bundle;
      try { bundle = snapshotRevisionId ? await store.loadSnapshotBundle(name,snapshotRevisionId,{signal:exec.signal}) : await store.loadBundle(name, { signal: exec.signal }); }
      catch (error) { return { ok: false, failure: { code: 'CAPABILITY_LOAD_FAILED', category: 'internal', stage: 'dependency', retryable: false }, receipt: { status: 'failed', capability: { name }, steps: [], constraints } }; }
      if (!bundle) return { ok: false, failure: { code: 'CAPABILITY_UNAVAILABLE', category: 'external', stage: 'admission', retryable: false }, receipt: { status: 'failed', capability: { name }, steps: [], constraints } };
      if (expectedRevisionId !== undefined && bundle.root.revisionId !== expectedRevisionId) throw new Error('Capability version changed before execution; reopen it before executing');
      const incompatible = bundle.entries.find(entry => entry.compatibility && !entry.compatibility.platforms.includes(process.platform));
      if (incompatible) return { ok: false, entry: bundle.root,
        failure: { code: 'PLATFORM_UNSUPPORTED', category: 'external', stage: 'admission', retryable: false,
          platform: process.platform, capability: incompatible.name, compatibility: incompatible.compatibility },
        receipt: { status: 'blocked', capability: { name }, steps: [], constraints } };
      const result = await perform(bundle.root.execution, input, exec, bundle.root, { bundleEntries: bundle.entries, ...(remainingTimeout === undefined ? {} : { timeoutMs: remainingTimeout }), ...(deadline === undefined ? {} : { deadline }) });
      return { ...result, entry: bundle.root, ...(!result.ok ? { failureGuides: recoveryGuides(bundle.entries, result.receipt, result.failure), resourceEntries:bundle.entries.filter(entry => entry.resources) } : {}) };
    },
    runImplementation(execution, input, exec, options = {}) {
      return perform(execution, input, exec, { name: options.name ?? 'recovery-implementation', version: options.version,
        revisionId: options.revisionId, dependencies: options.dependencies ?? [] }, options);
    },
    async runHost(request, { id, cwd = process.cwd(), signal, onSession }) {
      if (disposed) throw new Error('Execution service disposed');
      // Use the public native dispatcher to mint tokens and retain hooks. PTC
      // presentation needs its programmatic transport, never a model or session.
      const presets = ctx.get('agentPresets');
      if (!presets?.acquireScope) throw new Error('Host execution requires the native tool composition registry');
      const lease = await presets.acquireScope('standard');
      try {
        const host = { id, cwd, onSession, observations: new Map(), toolScope: lease.key };
        return await hostEntry.run(host, () => hostScope.run(host, async () => {
          const direct = !ctx.tools.get('run_code');
          if (!direct && ctx.get('ptcRuntime')?.language !== 'typescript') throw new Error('Host execution requires the TypeScript PTC transport');
          const outcome = await ctx.tools.execute({ callId: id, signal,
            name: direct ? 'capability_run' : 'run_code', arguments: direct ? request
              : { code: 'return await tools.capability_run(' + JSON.stringify(request) + ')', description: 'Execute ' + request.name, timeoutMs: 600000 } });
          if (outcome.isError) throw new Error(outcome.error?.message || 'Host execution dispatch failed');
          return direct ? outcome.value : outcome.value?.result;
        }));
      } finally { await lease[Symbol.asyncDispose](); }
    },
    async dispose() { disposed = true; for (const ledger of active) ledger.controller.abort(); await Promise.allSettled([...active].flatMap(ledger => [...ledger.pending])); hostScope.dispose(); hostEntry.disable(); },
  };
  return service;
}
