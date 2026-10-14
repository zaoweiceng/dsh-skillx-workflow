import { randomUUID, createHash } from 'node:crypto';
import { mkdir, appendFile, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeExecution, validateExecutionInput, validateExecutionOutput } from './native-contract.js';

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
  authority: 'Native tool dispatches retain the original calling Agent, root call and execution token. No policy widening is requested.',
};

/** Programs are DSH-authored data executed only by the host's public PTC service. */
export function createNativeExecutionService(ctx, store, {
  dataRoot, timeoutMs = 120000, maxCalls = 100, maxDepth = 8, maxOutputBytes = 65536, reason,
} = {}) {
  if (!dataRoot) throw new Error('Execution dataRoot is required');
  for (const [key, value] of Object.entries({ timeoutMs, maxCalls, maxDepth, maxOutputBytes })) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid execution bound: ' + key);
  const tracesRoot = join(dataRoot, 'executions');
  const active = new Set();
  let disposed = false;
  const services = () => ({ ptc: ctx.get?.('ptcRuntime') ?? ctx.ptcRuntime, policy: ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy });
  const authority = exec => {
    if (!exec?.agent?.session || !exec.token || !exec.rootCallId || !exec.signal) throw new ExecutionFault('CALLER_AUTHORITY_REQUIRED', 'admission');
  };
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
    const header = { runId, sessionId: exec.agent.session.header.id, rootCallId: exec.rootCallId,
      startedAt: new Date().toISOString(), deadline, constraints };
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
        if (priorHeader.sessionId !== header.sessionId || priorHeader.rootCallId !== header.rootCallId) throw new ExecutionFault('RESUME_AUTHORITY_MISMATCH', 'admission');
        const events = (await readFile(join(prior, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        for (const item of events) if (item.type === 'dispatch/end' && item.status === 'succeeded' && item.reusable === true) ledger.reuse.set(item.stepId, item);
        ledger.relatedSessions.push(...(JSON.parse(await readFile(join(prior, 'receipt.json'), 'utf8'))).relatedSessions ?? []);
      }
    }
    await event({ type: 'execution/start', ...header });
    return ledger;
  }
  const check = ledger => {
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
    const execute = async () => {
      ledger.signal.throwIfAborted();
      return ctx.tools.execute({ name: request.name, arguments: args, agent: exec.agent, parent: exec.token,
        rootCallId: exec.rootCallId, callId, signal: ledger.signal });
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
    if (!ptc?.resolve || !ptc?.run || ptc.language !== 'typescript' || ptc.isolation !== 'process' || !policy?.resolve) throw new ExecutionFault('NATIVE_PTC_UNAVAILABLE', 'admission', 'external');
    const implementationId = `${ledger.runId}:implementation:${ledger.implementations.length + 1}`;
    const implementation = { implementationId, name: owner.name, version: owner.version, revisionId: owner.revisionId, input: json(input), execution: contract, dependencies: owner.dependencies ?? [] };
    ledger.implementations.push({ implementationId, name: owner.name, version: owner.version, revisionId: owner.revisionId, digest: hash(contract) });
    await ledger.event({ type: 'implementation/start', ...implementation });
    const bindings = {
      input: async () => json(input),
      tool: async request => callTool(request, exec, ledger, owner),
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
        const bundle = await store.loadBundle(lock.name, { signal: ledger.signal });
        if (!bundle || bundle.root.version !== lock.version) throw new ExecutionFault('CAPABILITY_DEPENDENCY_CHANGED', 'dependency');
        return executeProgram(bundle.root.execution, request.input, exec, ledger, bundle.root, [...path, identity]);
      },
      reason: async request => {
        check(ledger);
        if (typeof reason !== 'function') throw new ExecutionFault('NATIVE_REASONING_UNAVAILABLE', 'reasoning');
        await ledger.event({ type: 'reasoning/start', owner: owner.name, request });
        let result;
        try { result = await track(ledger, reason(request, exec, { signal: ledger.signal, runId: ledger.runId, deadline: ledger.deadline })); }
        catch (error) {
          if (Array.isArray(error.relatedSessions)) ledger.relatedSessions.push(...error.relatedSessions);
          if (Array.isArray(error.usage)) ledger.usage.push(...error.usage);
          await ledger.event({ type: 'reasoning/end', owner: owner.name, status: 'failed', code: code(error.code), relatedSessions: error.relatedSessions ?? [], usage: error.usage ?? [] });
          throw error;
        }
        if (!result || !Object.hasOwn(result, 'output')) throw new ExecutionFault('INVALID_NATIVE_REASONING_RESULT', 'reasoning');
        if (Array.isArray(result.relatedSessions)) ledger.relatedSessions.push(...result.relatedSessions);
        if (Array.isArray(result.usage)) ledger.usage.push(...result.usage);
        await ledger.event({ type: 'reasoning/end', owner: owner.name, status: 'completed', output: result.output, relatedSessions: result.relatedSessions ?? [], usage: result.usage ?? [] });
        return json(result.output);
      },
    };
    const functions = Object.fromEntries(Object.entries(bindings).map(([name, fn]) => [name, request => track(ledger, Promise.resolve().then(() => fn(request)))]));
    const program = `const input = await __native_capability.input({});\nconst tools = Object.freeze({call: request => __native_capability.tool(request), reuse: request => __native_capability.reuse(request)});\nconst capabilities = Object.freeze({run: request => __native_capability.capability(request), reason: request => __native_capability.reason(request)});\n${contract.program}`;
    const sandboxPolicy = policy.resolve({ session: exec.agent.session });
    const spec = ptc.resolve({ program, bindings: [{ global: '__native_capability', functions }],
      cwd: exec.agent.session.header.cwd, signal: ledger.signal, sandboxPolicy, timeoutMs: Math.max(1, ledger.deadline - Date.now()) });
    const result = await track(ledger, ptc.run(spec));
    await ledger.event({ type: 'implementation/end', implementationId, sandbox: result.sandbox, logs: result.logs, error: result.error, ...(result.error ? {} : { value: result.value }) });
    if (result.error) throw new ExecutionFault('PROGRAM_' + result.error.kind.replaceAll('-', '_').toUpperCase(), 'program', ledger.nativeFailures.length ? 'unknown' : 'internal', result.error);
    const outputErrors = validateExecutionOutput(contract, result.value);
    if (outputErrors.length) throw new ExecutionFault('OUTPUT_SCHEMA_INVALID', 'output', 'internal', outputErrors);
    if (Buffer.byteLength(JSON.stringify(result.value)) > maxOutputBytes) throw new ExecutionFault('OUTPUT_SIZE_LIMIT', 'output');
    return result.value;
  }
  async function perform(execution, input, exec, owner, options = {}) {
    let ledger;
    try {
      if (disposed) throw new ExecutionFault('EXECUTION_SERVICE_DISPOSED', 'admission');
      ledger = await newLedger(exec, options.resumeEvidence, options);
      active.add(ledger);
      const output = await executeProgram(execution, json(input ?? {}), exec, ledger, owner, []);
      // A program must await every host call. Returning while bindings remain
      // active is an implementation failure, not permission to finish effects
      // invisibly after the reported result. Drain before allowing recovery.
      if (ledger.pending.size) { ledger.controller.abort(); await Promise.allSettled([...ledger.pending]); throw new ExecutionFault('UNAWAITED_BINDINGS', 'program'); }
      // PTC owns process cleanup; full binding lifetimes are tracked above.
      await Promise.allSettled([...ledger.pending]);
      const receipt = { runId: ledger.runId, status: 'completed', capability: { name: owner.name, version: owner.version, revisionId: owner.revisionId },
        implementations: ledger.implementations, steps: ledger.steps, relatedSessions: [...new Set(ledger.relatedSessions)], usage: ledger.usage,
        startedAt: ledger.startedAt, deadline: ledger.deadline, finishedAt: new Date().toISOString(), constraints, outputDigest: hash(output) };
      await ledger.event({ type: 'execution/end', status: 'completed', output, receipt });
      await writeFile(join(ledger.directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      await ledger.logTail;
      return { ok: true, output: json(output), receipt };
    } catch (error) {
      ledger?.controller.abort();
      if (ledger) await Promise.allSettled([...ledger.pending]);
      const failure = { code: ledger?.timedOut ? 'EXECUTION_TIMEOUT' : code(error.code), category: ledger?.timedOut ? 'unknown' : error.category ?? 'unknown', stage: error.stage ?? 'infrastructure', retryable: false,
        ...(ledger?.nativeFailures.length ? { observedNativeFailures: ledger.nativeFailures.slice(-8) } : {}) };
      const receipt = { ...(ledger ? { runId: ledger.runId, startedAt: ledger.startedAt, deadline: ledger.deadline } : {}), status: 'failed',
        capability: { name: owner.name, version: owner.version, revisionId: owner.revisionId }, steps: ledger?.steps ?? [],
        relatedSessions: [...new Set(ledger?.relatedSessions ?? [])], usage: ledger?.usage ?? [], finishedAt: new Date().toISOString(), constraints };
      if (ledger) {
        try {
          await ledger.event({ type: 'execution/end', status: 'failed', failure, diagnostic: { name: error.name, message: error.message, detail: error.detail }, receipt });
          await writeFile(join(ledger.directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
          await ledger.logTail;
        } catch { failure.traceUnavailable = true; }
      }
      return { ok: false, failure, receipt, ...(ledger ? { traceRef: ledger.runId } : {}) };
    } finally { if (ledger) { clearTimeout(ledger.timer); ledger.controller.abort(); active.delete(ledger); } }
  }
  return {
    async readTrace(runId, exec) {
      authority(exec);
      if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw new ExecutionFault('INVALID_TRACE_REFERENCE', 'trace');
      const directory = join(tracesRoot, runId);
      const header = JSON.parse(await readFile(join(directory, 'header.json'), 'utf8'));
      if (header.sessionId !== exec.agent.session.header.id || header.rootCallId !== exec.rootCallId) throw new ExecutionFault('TRACE_AUTHORITY_MISMATCH', 'trace');
      const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
      return { header, events, receipt };
    },
    async run({ name, input, timeoutMs: remainingTimeout, deadline }, exec) {
      let bundle;
      try { bundle = await store.loadBundle(name, { signal: exec.signal }); }
      catch (error) { return { ok: false, failure: { code: 'CAPABILITY_LOAD_FAILED', category: 'internal', stage: 'dependency', retryable: false }, receipt: { status: 'failed', capability: { name }, steps: [], constraints } }; }
      if (!bundle) return { ok: false, failure: { code: 'CAPABILITY_UNAVAILABLE', category: 'external', stage: 'admission', retryable: false }, receipt: { status: 'failed', capability: { name }, steps: [], constraints } };
      const result = await perform(bundle.root.execution, input, exec, bundle.root, { ...(remainingTimeout === undefined ? {} : { timeoutMs: remainingTimeout }), ...(deadline === undefined ? {} : { deadline }) });
      return { ...result, entry: bundle.root };
    },
    runImplementation(execution, input, exec, options = {}) {
      return perform(execution, input, exec, { name: options.name ?? 'recovery-implementation', version: options.version,
        revisionId: options.revisionId, dependencies: options.dependencies ?? [] }, options);
    },
    async dispose() { disposed = true; for (const ledger of active) ledger.controller.abort(); await Promise.allSettled([...active].flatMap(ledger => [...ledger.pending])); },
  };
}
