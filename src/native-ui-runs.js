import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { validateExecutionInput } from './native-contract.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ongoing = status => ['queued', 'running', 'cancelling'].includes(status);

// UI submissions execute through a normally composed DSH session and its public
// tool dispatcher. No fabricated execution token, policy override or LLM hop.
export function createNativeUiRuns(ctx, store, { dataRoot }) {
  const root = join(dataRoot, 'ui-runs');
  const active = new Map();
  let queue = Promise.resolve(), disposed = false;
  const exclusive = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const persist = async job => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, '.' + job.id + '-' + randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify(job), { mode: 0o600 });
    await rename(temp, join(root, job.id + '.json'));
  };
  async function get(id) {
    if (!uuid.test(id)) throw new Error('Invalid execution reference');
    let job;
    try { job = JSON.parse(await readFile(join(root, id + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (ongoing(job.status) && !active.has(id)) return { ...job, status: 'interrupted', error: { message: 'DSH restarted before the UI execution settled. Inspect execution records before running again.' } };
    return job;
  }
  async function perform(job, controller, lifecycle) {
    try {
      const sessions = ctx.get('sessionController');
      if (!sessions) throw new Error('DSH session controller is required for UI execution');
      const created = await sessions.create(job.cwd ? { cwd: job.cwd } : {});
      job.sessionId = created.sessionId;
      const resolved = await sessions.resolveAgent(job.sessionId);
      if (!resolved.agent) throw new Error(resolved.error?.message || 'Cannot resolve execution session');
      const agent = resolved.agent;
      lifecycle.agent = agent;
      controller.signal.throwIfAborted();
      job.status = 'running'; job.startedAt = new Date().toISOString();
      await sessions.rename({ sessionId: job.sessionId, title: job.name });
      agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Execute ' + job.name + ' with the submitted parameters:\n' + JSON.stringify(job.input) }] }, { surfaceOp: 'append' });
      await ctx.sessions.flush(agent.session);
      await persist(job);
      const result = await agent.runMaintenance(async signal => {
        const tools = agent.ctx.tools;
        const args = { name: job.name, input: job.input, expectedRevisionId: job.revisionId };
        if (!tools.get('capability_run', agent)) throw new Error('Capability execution is unavailable in the selected DSH session');
        const direct = !tools.get('run_code', agent);
        if (!direct && agent.ctx.get('codeRuntime')?.language !== 'typescript') throw new Error('This tool transport does not support direct capability execution');
        const outcome = await tools.execute({ agent, callId: randomUUID(), signal: AbortSignal.any([signal, controller.signal]),
          name: direct ? 'capability_run' : 'run_code', arguments: direct ? args : { code: 'return await tools.capability_run(' + JSON.stringify(args) + ')', description: 'Execute ' + job.name } });
        if (outcome.isError) throw new Error(outcome.error?.error?.message || outcome.error?.message || JSON.stringify(outcome.error));
        return direct ? outcome.value : outcome.value?.result;
      });
      if (!result || !['completed', 'blocked'].includes(result.status)) throw new Error('Execution returned no canonical capability result');
      job.status = result.status;
      job.output = result.output;
      job.error = result.error;
      job.receipt = result.receipt;
      job.maintenance = result.maintenance;
      try {
        agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'skillx-workflow-execution' }, content: [{ type: 'text', text: 'Capability execution result (historical data, not a new request; do not repeat completed operations):\n' + JSON.stringify(result) }] }, { surfaceOp: 'append' });
        await ctx.sessions.flush(agent.session);
      } catch (error) { job.recordingError = error.message; }
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = { message: error.message };
    } finally {
      job.finishedAt = new Date().toISOString();
      try { await persist(job); } finally { active.delete(job.id); }
    }
  }
  async function start(request) {
    return exclusive(async () => {
      if (disposed) throw new Error('Plugin disposed');
      if (!uuid.test(request.idempotencyKey)) throw new Error('Execution idempotency key is required');
      if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || request.cwd.includes('\0'))) throw new Error('Working directory must be an absolute path');
      const fingerprint = createHash('sha256').update(JSON.stringify([request.name, request.revisionId, request.input, request.cwd])).digest('hex');
      const previous = await get(request.idempotencyKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Execution key was already used with different parameters'); return previous; }
      const entry = await store.get(request.name);
      if (!entry?.execution) throw new Error('This capability does not have an executable contract');
      if (entry.revisionId !== request.revisionId) throw new Error('Capability version changed; reopen it before executing');
      const errors = validateExecutionInput(entry.execution, request.input);
      if (errors.length) throw new Error('Invalid execution input: ' + errors.join('; '));
      if (active.size >= 4) throw new Error('Four UI executions are already active');
      const job = { id: request.idempotencyKey, name: entry.name, revisionId: entry.revisionId, version: entry.version, input: request.input,
        ...(request.cwd ? { cwd: request.cwd } : {}), fingerprint, status: 'queued', createdAt: new Date().toISOString() };
      const controller = new AbortController(), lifecycle = { controller, agent: null, done: null };
      active.set(job.id, lifecycle);
      try { await persist(job); } catch (error) { active.delete(job.id); throw error; }
      lifecycle.done = perform(job, controller, lifecycle).catch(error => ctx.logger?.error?.(error));
      return structuredClone(job);
    });
  }
  return {
    start, get,
    async list(name) {
      let files;
      try { files = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const jobs = [];
      for (const file of files) if (file.endsWith('.json') && uuid.test(file.slice(0, -5))) { const job = await get(file.slice(0, -5)); if (job?.name === name) jobs.push(job); }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    },
    async cancel(id) { const job = await get(id); if (!job) return null; const running = active.get(id); if (running) { running.controller.abort(); running.agent?.cancel({ kind: 'user' }); return { ...job, status: 'cancelling' }; } return job; },
    async dispose() { disposed = true; for (const item of active.values()) { item.controller.abort(); item.agent?.cancel({ kind: 'user' }); } await Promise.allSettled([...active.values()].map(item => item.done)); },
  };
}
