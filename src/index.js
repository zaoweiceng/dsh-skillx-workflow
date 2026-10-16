import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNativeUiRuns } from './native-ui-runs.js';
import { createNativeMonitoring } from './native-monitoring.js';
import { createStore } from './native-store.js';
import { registerNativeSkills } from './native-skills.js';
import { createNativeAgentService } from './native-agent.js';
import { createNativeExecutionService } from './native-execution.js';
import { createNativeRecoveryService } from './native-recovery.js';
import { writeFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-skillx-workflow';
export const inject = ['webServer', 'sessionQuery', 'agents', 'sessions', 'agentDefaultModel', 'tools', 'systemPrompt', 'skills'];
export function resolveConfig(config = {}) {
  const result = { dataRoot: config.dataRoot, enableCapabilities: config.enableCapabilities ?? true,
    timeoutMs: config.timeoutMs ?? 1800000, maxTimeoutMs: config.maxTimeoutMs ?? 14400000,
    recordsPerBudgetUnit: config.recordsPerBudgetUnit ?? 100, bytesPerBudgetUnit: config.bytesPerBudgetUnit ?? 262144,
    maxSteps: config.maxSteps, contractReview: config.contractReview ?? false };
  if (typeof result.contractReview !== 'boolean') throw new Error('contractReview must be boolean');
  if (typeof result.enableCapabilities !== 'boolean') throw new Error('enableCapabilities must be boolean');
  if (result.dataRoot !== undefined && (typeof result.dataRoot !== 'string' || !isAbsolute(result.dataRoot) || result.dataRoot.includes('\0'))) throw new Error('dataRoot must be an absolute local path');
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 100 || result.timeoutMs > 14400000) throw new Error('Invalid timeoutMs');
  if (result.maxSteps !== undefined && (!Number.isSafeInteger(result.maxSteps) || result.maxSteps < 1)) throw new Error('Invalid maxSteps');
  if (!Number.isSafeInteger(result.maxTimeoutMs) || result.maxTimeoutMs < result.timeoutMs || result.maxTimeoutMs > 86400000) throw new Error('Invalid maxTimeoutMs');
  for (const key of ['recordsPerBudgetUnit', 'bytesPerBudgetUnit']) if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error('Invalid adaptive budget scale');
  return result;
}
const publicReceipt = receipt => JSON.parse(JSON.stringify({ runId: receipt?.runId, status: receipt?.status, capability: receipt?.capability, outputDigest: receipt?.outputDigest }));
const digest = entry => 'sha256:' + createHash('sha256').update(JSON.stringify({ name: entry.name, kind: entry.kind, description: entry.description, content: entry.content, version: entry.version })).digest('hex');

/** Only native DSH session/Agent/skill services; no model bridge or external engine. */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  const profile = ctx.get('profileContext');
  const dataRoot = settings.dataRoot ?? join(profile?.dir || process.env.DSH_HOME || join(homedir(), '.dsh'), 'native-workflows');
  const store = createStore({ dataRoot });
  const service = createNativeAgentService(ctx, store, { ...settings, dataRoot });
  const monitoring = createNativeMonitoring({ dataRoot, store, learningService: service, sessionQuery: ctx.sessionQuery });
  const recovery = createNativeRecoveryService(ctx, { store, learningService: service, dataRoot });
  const execution = createNativeExecutionService(ctx, store, { dataRoot, reason: (...args) => recovery.reason(...args) });
  const uiRuns = createNativeUiRuns(ctx, store, { dataRoot, execution });
  ctx.effect(() => () => service.dispose());
  ctx.effect(() => () => execution.dispose());
  ctx.effect(() => () => recovery.dispose());
  ctx.effect(() => () => uiRuns.dispose());
  if (settings.enableCapabilities) {
    ctx.effect(() => registerNativeSkills(ctx, store));
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'capability_run',
      description: 'Execute a native SkillX/workflow as a black box. Discover purpose and input/output schema with skill; supply input and consume the verified output. Internal execution and bounded repair happen within this same call. Do not repeat its internal operations. timeoutMs limits foreground execution and recovery (default 600000). Evidence-based background capability maintenance has an independent budget and may continue after timeout, without replaying business operations. External blockers are returned for caller action.',
      parameters: { name: { type: 'string', required: true, description: 'Exact enabled capability name' }, input: { type: 'json', required: true, description: 'JSON object matching the capability input schema' }, expectedRevisionId: { type: 'string', description: 'Optional exact revision selected in the execution UI' }, timeoutMs: { type: 'integer', description: 'Total hard time budget in milliseconds, including recovery; 1000 to 600000' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => false,
      execute: async ({ name, input, expectedRevisionId, timeoutMs = 600000 }, exec) => {
        if (execution.isHostCall(exec)) return execution.runHostCall({ name, input, expectedRevisionId }, exec);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be between 1000 and 600000');
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        const signal = AbortSignal.any([exec.signal, controller.signal]);
        const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
        const scopedExec = { ...exec, signal };
        try {
          const result = await execution.run({ name, input, expectedRevisionId, timeoutMs: Math.min(120000, timeoutMs), deadline }, scopedExec);
          if (result.ok && !signal.aborted && Date.now() < deadline) return { status: 'completed', output: result.output, receipt: publicReceipt(result.receipt) };
          if (result.failure?.stage === 'authorization') return { status: 'blocked',
            error: { category: 'permission', code: result.failure.code, message: 'Native authorization did not allow safe continuation. Completed steps were retained; do not replay the capability.' },
            receipt: publicReceipt(result.receipt) };
          const entry = result.entry ?? await store.get(name);
          if (!entry?.execution) return { status: 'blocked', error: { category: 'configuration', code: 'CAPABILITY_NOT_EXECUTABLE', message: 'The capability needs a native Agent-generated executable contract.' }, receipt: publicReceipt(result.receipt) };
          let trace;
          if (result.traceRef || result.receipt?.runId) {
            try { trace = await execution.readTrace(result.traceRef ?? result.receipt.runId, exec); }
            catch { trace = { unavailable: true, receipt: result.receipt }; }
          }
          const maintain = async () => {
            try { const job = await recovery.scheduleMaintenance({ entry, input, failure: result.failure, receipt: result.receipt, trace, exec }); return { jobId: job.jobId, status: job.status }; }
            catch { return { status: 'failed', code: 'MAINTENANCE_SCHEDULE_FAILED' }; }
          };
          if (signal.aborted || Date.now() >= deadline) {
            const maintenance = await maintain();
            return { status: 'blocked', maintenance, error: { category: 'deadline', code: 'CAPABILITY_DEADLINE', message: 'The foreground deadline was reached. Execution evidence was retained and independent capability maintenance is tracked separately; do not blindly repeat mutations.' }, receipt: publicReceipt(result.receipt) };
          }
          const restored = await recovery.recover({ entry, input, failure: result.failure, receipt: result.receipt, trace, exec: scopedExec, deadline });
          if (signal.aborted || Date.now() >= deadline) {
            const maintenance = await maintain();
            return { status: 'blocked', maintenance, error: { category: 'deadline', code: 'CAPABILITY_DEADLINE', message: 'The foreground deadline was reached during recovery. Independent capability maintenance continues; partial execution is retained.' }, receipt: publicReceipt(result.receipt) };
          }
          if (restored.outcome === 'completed' && !signal.aborted && Date.now() < deadline) {
            const completed = { ...result.receipt, status: 'completed', recovered: true, finishedAt: new Date().toISOString(), outputDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(restored.output)).digest('hex') };
            if (completed.runId && /^[a-f0-9-]{36}$/.test(completed.runId)) await writeFile(join(dataRoot, 'executions', completed.runId, 'resolved.json'), JSON.stringify({ receipt: completed, output: restored.output }), { mode: 0o600 });
            return { status: 'completed', output: restored.output, receipt: publicReceipt(completed) };
          }
          const maintenance = restored.outcome !== 'external_blocked' ? await maintain() : undefined;
          return { status: 'blocked', ...(maintenance ? { maintenance } : {}), error: { category: restored.category, code: restored.reason, message: restored.outcome === 'external_blocked' ? 'An external prerequisite requires caller attention; partial execution is retained.' : 'Internal recovery could not produce a verified output within the current budget; partial execution is retained.' }, receipt: publicReceipt(result.receipt) };
        } finally { clearTimeout(timer); }
      },
    })));
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/skillx-workflow/api', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.slice('/skillx-workflow/api/'.length);
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'Cross-origin request rejected' });
      const readBody = async () => {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw new Error('Request too large'); }
        return raw ? JSON.parse(raw) : {};
      };
      if (req.method === 'POST' && route === 'runs') return send(202, await uiRuns.start(await readBody()));
      if (req.method === 'GET' && route === 'runs') return send(200, await uiRuns.list(url.searchParams.get('name')));
      if (req.method === 'GET' && /^runs\/[^/]+$/.test(route)) { const job = await uiRuns.get(route.split('/')[1]); return job ? send(200, job) : send(404, { error: 'Execution not found' }); }
      if (req.method === 'POST' && /^runs\/[^/]+\/cancel$/.test(route)) { const job = await uiRuns.cancel(route.split('/')[1]); return job ? send(200, job) : send(404, { error: 'Execution not found' }); }
      if (req.method === 'POST' && route === 'prepare') {
        const body = await readBody(), entry = await store.get(body.name, { includeDisabled: true });
        if (!entry || !entry.sourceSessionId) return send(400, { error: 'Original extraction evidence is unavailable' });
        return send(202, await service.start({ operation: 'optimize', name: entry.name, sessionId: entry.sourceSessionId, prepareExecution: true }));
      }
      if (req.method === 'GET' && route.startsWith('monitoring/metrics/')) return send(200, await monitoring.metric(route.slice('monitoring/metrics/'.length), url.searchParams));
      if (req.method === 'GET' && route === 'monitoring/sessions') return send(200, await monitoring.sessions(url.searchParams));
      if (req.method === 'GET' && route.startsWith('monitoring/records/')) return send(200, await monitoring.records(route.slice('monitoring/records/'.length), url.searchParams));
      if (req.method === 'GET' && route === 'runtime') return send(200, { mode: 'native-agent', dataRoot, enableCapabilities: settings.enableCapabilities });
      if (req.method === 'GET' && route === 'catalog') {
        const [capabilities, workflows] = await Promise.all([store.list('skill', { includeDisabled: true }), store.list('workflow', { includeDisabled: true })]);
        return send(200, { capabilities, workflows });
      }
      if (req.method === 'GET' && route.startsWith('entries/')) {
        const entry = await store.get(decodeURIComponent(route.slice('entries/'.length)), { includeDisabled: true });
        return entry ? send(200, { ...entry, digest: digest(entry) }) : send(404, { error: 'Capability not found' });
      }
      if (req.method === 'POST' && /^entries\/[^/]+\/availability$/.test(route)) {
        const entryName = decodeURIComponent(route.split('/')[1]);
        const body = await readBody(); return send(200, await store.setEnabled(entryName, body.enabled));
      }
      if (req.method === 'DELETE' && /^entries\/[^/]+$/.test(route)) {
        const body = await readBody();
        const result = await store.remove(decodeURIComponent(route.split('/')[1]), { version: body.version, revisionId: body.revisionId });
        return result ? send(200, result) : send(404, { error: 'Capability not found' });
      }
      if (req.method === 'POST' && ['extract', 'optimize'].includes(route)) {
        const body = await readBody();
        const task = await service.start({ sessionId: body.sessionId, sessionIds: body.sessionIds, name: body.name, operation: route, reviewFindings: body.reviewFindings });
        return send(202, task);
      }
      if (req.method === 'GET' && route === 'status') {
        const task = await service.get(url.searchParams.get('taskId'));
        return task ? send(200, task) : send(404, { error: 'Task not found' });
      }
      if (req.method === 'POST' && route === 'cancel') { const body = await readBody(); const task = await service.cancel(body.taskId); return task ? send(200, task) : send(404, { error: 'Task not found' }); }
      return send(404, { error: 'Unknown native workflow route' });
    } catch (error) { send(error.statusCode ?? 400, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.dependents ? { dependents: error.dependents } : {}) }); }
  } }));
}
