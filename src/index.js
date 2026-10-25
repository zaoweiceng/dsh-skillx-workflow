import { assertResultSelection } from './result-delivery.js';
import { workflowGraph } from './workflow-graph.js';
import { registerNativeProcess } from './native-process.js';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNativeUiRuns } from './native-ui-runs.js';
import { createNativeMonitoring } from './native-monitoring.js';
import { createStore } from './native-store.js';
import { registerNativeSkills } from './native-skills.js';
import { createExtractionModels } from './extraction-model.js';
import { createNativeAgentService } from './native-agent.js';
import { createNativeExecutionService } from './native-execution.js';
import { createNativeRecoveryService } from './native-recovery.js';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-skillx-workflow';
export const inject = ['webServer', 'sessionQuery', 'agents', 'sessions', 'agentDefaultModel', 'tools', 'systemPrompt', 'skills'];
export function resolveConfig(config = {}) {
  const result = { dataRoot: config.dataRoot, enableCapabilities: config.enableCapabilities ?? true,
    timeoutMs: config.timeoutMs ?? 600000, maxTimeoutMs: config.maxTimeoutMs ?? 900000,
    totalTimeoutMs: config.totalTimeoutMs ?? 600000, maxOutputTokens: config.maxOutputTokens ?? 64000, maxTotalTokens: config.maxTotalTokens ?? 400000,
    maxRequestOutputTokens: config.maxRequestOutputTokens ?? 12000, maxTotalSteps: config.maxTotalSteps ?? 40,
    maxRepairAttempts: config.maxRepairAttempts ?? 3, maxRepeatedFailures: config.maxRepeatedFailures ?? 2,
    recordsPerBudgetUnit: config.recordsPerBudgetUnit ?? 100, bytesPerBudgetUnit: config.bytesPerBudgetUnit ?? 262144,
    maxSteps: config.maxSteps ?? 16, nodeExecutable:config.nodeExecutable ?? process.execPath, pythonExecutable:config.pythonExecutable ?? "python3", executables:config.executables ?? {} };
  for(const key of ['nodeExecutable','pythonExecutable']) if(typeof result[key]!=='string'||!result[key]||result[key].includes('\0'))throw new Error('Invalid runtime executable: '+key);
  if(!result.executables||typeof result.executables!=='object'||Array.isArray(result.executables))throw new Error('Invalid CLI launchers');
  for(const [command,launcher] of Object.entries(result.executables)){
    if(!command||!launcher||typeof launcher!=='object'||(launcher.runtime!=='node'&&(typeof launcher.executable!=='string'||!launcher.executable))||!Array.isArray(launcher.args ?? [])||(launcher.args??[]).some(value=>typeof value!=='string'||value.includes('\0')))throw new Error('Invalid configured executable: '+command);
  }
  if (typeof result.enableCapabilities !== 'boolean') throw new Error('enableCapabilities must be boolean');
  if (result.dataRoot !== undefined && (typeof result.dataRoot !== 'string' || !isAbsolute(result.dataRoot) || result.dataRoot.includes('\0'))) throw new Error('dataRoot must be an absolute local path');
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 100) throw new Error('Invalid timeoutMs');
  if (result.maxSteps !== undefined && (!Number.isSafeInteger(result.maxSteps) || result.maxSteps < 1)) throw new Error('Invalid maxSteps');
  if (!Number.isSafeInteger(result.maxTimeoutMs) || result.maxTimeoutMs < 100) throw new Error('Invalid maxTimeoutMs');
  for (const key of ['totalTimeoutMs','maxTotalTokens','maxOutputTokens','maxRequestOutputTokens','maxTotalSteps','maxRepairAttempts','maxRepeatedFailures']) if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error('Invalid generation limit: ' + key);
  for (const key of ['recordsPerBudgetUnit', 'bytesPerBudgetUnit']) if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error('Invalid adaptive budget scale');
  return result;
}
const publicReceipt = receipt => JSON.parse(JSON.stringify({ runId: receipt?.runId, status: receipt?.status, businessOutcome:receipt?.businessOutcome, capability: receipt?.capability, outputDigest: receipt?.outputDigest }));
const digest = entry => 'sha256:' + createHash('sha256').update(JSON.stringify({ name: entry.name, kind: entry.kind, description: entry.description, content: entry.content, version: entry.version })).digest('hex');

/** Only native DSH session/Agent/skill services; no model bridge or external engine. */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  const profile = ctx.get('profileContext');
  const dataRoot = settings.dataRoot ?? join(profile?.dir || process.env.DSH_HOME || join(homedir(), '.dsh'), 'native-workflows');
  const store = createStore({ dataRoot });
  ctx.effect(()=>{const pending=store.migrateLayout().catch(error=>console.error('SkillX directory migration failed:',error.message));return async()=>{await pending;};});
  ctx.effect(() => store.startCleanup({ onError: error => {
    if (ctx.logger?.error) ctx.logger.error(error);
    else console.error(error);
  } }));
  const extractionModels = createExtractionModels(ctx, {dataRoot});
  const service = createNativeAgentService(ctx, store, { ...settings, dataRoot, getExtractionModel:() => extractionModels.selection() });
  const monitoring = createNativeMonitoring({ dataRoot, store, learningService: service, sessionQuery: ctx.sessionQuery });
  const recovery = createNativeRecoveryService(ctx, { store, learningService: service, dataRoot, getRecoveryModel:() => extractionModels.selection() });
  const execution = createNativeExecutionService(ctx, store, { dataRoot, nodeExecutable:settings.nodeExecutable, pythonExecutable:settings.pythonExecutable, executables:settings.executables, recover: request => recovery.recover(request) });
  const uiRuns = createNativeUiRuns(ctx, store, { dataRoot, execution });
  ctx.effect(() => () => service.dispose());
  ctx.effect(() => () => execution.dispose());
  ctx.effect(() => () => recovery.dispose());
  ctx.effect(() => () => uiRuns.dispose());
  if (settings.enableCapabilities) {
    ctx.effect(()=>registerNativeProcess(ctx,settings));
    ctx.effect(() => ctx.systemPrompt.section({name:'native-capability-invocation',order:850,text:'When capability_run is available and an advertised executable SkillX or workflow covers the user goal, use its public contract to call capability_run and consume the validated output and execution receipt. When the tool schema already declares the selected capability’s input contract, invoke directly with its expectedRevisionId. Otherwise discover and load the root contract with skill first. The executor resolves declared dependencies and checks prerequisites. Workflow recovery runs in the published program; implementation defects can be explicitly revised with capability_revise. Load implementation or CLI documentation only to resolve a concrete external blocker reported by that call; root invocation needs only its public contract. For final fields missing from the returned output, combine necessary read-only checks into one tool call. Results use bounded previews with delivery.complete and delivery.read. Do not request full raw logs unless needed for the goal. Read missing evidence with capability_result_read using the existing runId and precise JSON pointers; never rerun completed queries to obtain detail. Report the verified result concisely. A blocked call preserves completed steps; resume only the unfinished operation identified by its receipt.'}));
    ctx.effect(() => registerNativeSkills(ctx, store));
    ctx.effect(() => ctx.tools.register(defineTool({
      name:'capability_revise',
      description:'Submit an observed implementation or contract defect to the read-only native author and wait for publication. Uses this conversation as evidence; does not execute business operations. Do not revise code merely to install a missing external prerequisite. After publication invoke the capability again to verify the result.',
      parameters:{name:{type:'string',required:true,description:'Capability from the failed run; input-contract failures are routed to the actual argument-assembling caller'},runId:{type:'string',required:true,description:'Retained failed/partial execution runId; supplies original producer and consumer inputs, schemas and outputs'},findings:{type:'string',required:true,description:'Concrete failed result, missing output or incorrect parameter behavior observed in this conversation'},preserveContract:{type:'boolean',description:'Defaults true; false only when input/output schema itself needs repair'}},
      output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      isConcurrencySafe:()=>false,
      execute:async(args,exec)=>{
        await ctx.sessions.flush(exec.agent.session);
        const reviewExecution=await execution.review(args.runId,exec);
        const target = [reviewExecution.summary.root?.name,reviewExecution.summary.failure?.capability].includes(args.name) ? (reviewExecution.summary.failure?.repairTarget?.name ?? args.name) : args.name;
        const task=await service.start({sessionId:exec.agent.session.header.id,name:target,operation:'optimize',preserveContract:args.preserveContract ?? true,reviewFindings:[args.findings],reviewExecution});
        const cancel=()=>void service.cancel(task.taskId);
        exec.signal.addEventListener('abort',cancel,{once:true});
        try {
          if(exec.signal.aborted)cancel();
          const result=await service.wait(task.taskId);
          const updated=await Promise.all((result.entries||[]).map(async entry=>{const current=await store.get(entry.name);return {...entry,revisionId:current?.revisionId};}));
          return {taskId:task.taskId,name:target,requestedName:args.name,status:result.status,updated,reused:result.reused ?? [],businessExecuted:false,...(result.error?{error:result.error}:{})};
        } finally {exec.signal.removeEventListener('abort',cancel);}
      },
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'capability_result_read',
      description: 'Read retained validated capability output from this conversation without re-executing operations. Use delivery.read.runId and only needed JSON pointers; returns bounded JSON text fragments with nextOffset. A preview is not the complete output. Never rerun capability_run to obtain omitted detail.',
      parameters: { runId: {type:'string',required:true,description:'Execution runId from delivery.read'}, select:{type:'array',items:{type:'string'},description:'Read multiple required JSON Pointers from retained output in one call, as a pointer-to-value map. Use instead of pointer/offset/limit/stepId/jsonTextPointer; does not execute the capability.'}, implementationId:{type:'string',description:'Read an original capability boundary: index for outcomes, or the ID in an executionReview examples pointer; pointer then selects /input, /output or /execution. No execution.'},stepId:{type:'string',description:'Optional retained native observation stepId, or index to list observations; no re-execution'}, jsonTextPointer:{type:'string',description:'Optional JSON Pointer to a JSON-encoded string inside the selected observation, e.g. /stdout/text. Explicitly decode it before applying pointer; only with stepId.'}, pointer:{type:'string',description:'JSON pointer, e.g. /key_logs or /hits/0; default root'}, offset:{type:'integer',description:'UTF-16 character cursor in the JSON text, default 0; follow nextOffset'}, limit:{type:'integer',description:'1 to 4000 UTF-16 characters, default 4000'} },
      output: {schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      isConcurrencySafe:()=>true,
      execute:async(args,exec)=>execution.readResult(args,exec),
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'capability_run',
      description: 'Execute a native SkillX/workflow as a black box. Select a capability by purpose and use its typed input contract here directly. If its input is only generic JSON, load its public contract with skill first. Consume the verified output. Runs the published implementation and returns its original failure evidence. It does not start a reasoning Agent to replace failed business operations. Use capability_revise explicitly for implementation defects. timeoutMs limits foreground execution (default 600000). External blockers are returned for caller action.',
      parameters: { name: { type: 'string', required: true, description: 'Exact enabled capability name' }, input: { type: 'json', required: true, description: 'JSON object matching the capability input schema' }, select: { type:'array', items:{type:'string'}, description:'Optional exact JSON Pointers to the business fields needed for this task, e.g. /status and /summary. Select only needed fields to avoid bulk results and follow-up reads. Returns a pointer-to-value map; missing pointers are explicit. Full output remains retained and business status is always in receipt.businessOutcome.' }, expectedRevisionId: { type: 'string', description: 'Optional exact revision selected in the execution UI' }, snapshotRevisionId: { type:'string', description:'Run an available immutable historical snapshot and its locked dependencies' }, timeoutMs: { type: 'integer', description: 'Total foreground time budget in milliseconds; 1000 to 600000' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => false,
      execute: async ({ name, input, select, expectedRevisionId, snapshotRevisionId, timeoutMs = 600000 }, exec) => {
        assertResultSelection(select);
        if (execution.isHostCall(exec)) return execution.runHostCall({ name, input, select, expectedRevisionId, snapshotRevisionId }, exec);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeoutMs must be between 1000 and 600000');
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        const signal = AbortSignal.any([exec.signal, controller.signal]);
        const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
        const scopedExec = { ...exec, signal };
        try {
          const result = await execution.run({ name, input, expectedRevisionId, snapshotRevisionId, timeoutMs, deadline }, scopedExec);
          if (result.ok && !signal.aborted && Date.now() < deadline) {
            const delivery=execution.delivery(result.output,result.receipt,select);
            if (['partial','failed','blocked'].includes(result.receipt.businessOutcome?.status)) delivery.executionReview={...(await execution.review(result.receipt.runId,exec)).summary,
              read:{tool:'capability_result_read',runId:result.receipt.runId,implementationId:'index'}};
            return {status:'completed',...delivery,receipt:publicReceipt(result.receipt)};
          }
          if (result.failure?.code === 'PLATFORM_UNSUPPORTED') return { status: 'blocked',
            error: { category: 'compatibility', code: 'PLATFORM_UNSUPPORTED',
              message: `${result.failure.capability} does not support ${result.failure.platform}. ${result.failure.compatibility.limitations}` },
            receipt: publicReceipt(result.receipt) };
          if (result.failure?.stage === 'authorization') return { status: 'blocked',
            error: { category: 'permission', code: result.failure.code, originalFailure:result.failure, message: 'Native authorization did not allow safe continuation. Completed steps were retained; do not replay the capability.' },
            receipt: publicReceipt(result.receipt) };
          const entry = result.entry ?? await store.get(name);
          if (!entry?.execution) return { status: 'blocked', error: { category: 'configuration', code: 'CAPABILITY_NOT_EXECUTABLE', message: 'The capability needs a native Agent-generated executable contract.' }, receipt: publicReceipt(result.receipt) };
          return { status:'blocked', error:{category:result.failure?.category ?? 'internal',code:result.failure?.code ?? 'EXECUTION_FAILED',originalFailure:result.failure,message:'The published implementation failed. Inspect the original failure; correct external inputs/prerequisites or use capability_revise for implementation defects.'},receipt:publicReceipt(result.receipt) };
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
      if (req.method === 'GET' && route === 'extraction-model') return send(200, await extractionModels.get());
      if (req.method === 'POST' && route === 'extraction-model') return send(200, await extractionModels.save(await readBody()));
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
      if (req.method === 'GET' && route === 'runtime') return send(200, { mode: 'native-agent', dataRoot, enableCapabilities: settings.enableCapabilities, generationPolicy: { revision:'executable-extraction-v4', submissionProtocol:'draft-plan-v2', workflowGraph:'executable-syntax-v1', executionTarget:'local-or-linux-docker-v1', managedConcurrency:'program-await-promise-all', validation:'static-only', behaviorTests:false, recovery:'explicit-author-revision', resources:'versioned-utf8-bundle-v1',sourceAdapters:'esm-functions-v2', processExecution:'native-argv-no-shell-v2', environmentPreflight:'optional-readonly-probes-v1', storage:'current-directories-with-revision-snapshots-v1', layoutWarning:store.layoutWarning, missingConfiguration:'ask-user', budgetMode:'advisory', generationCostLimitsEnforced:false, totalTimeoutMs:settings.totalTimeoutMs, maxTotalTokens:settings.maxTotalTokens, maxOutputTokens:settings.maxOutputTokens, maxRequestOutputTokens:settings.maxRequestOutputTokens, maxSteps:settings.maxSteps, maxTotalSteps:settings.maxTotalSteps, maxRepairAttempts:settings.maxRepairAttempts, maxRepeatedFailures:settings.maxRepeatedFailures } });
      if (req.method === 'POST' && route === 'homepage/order') {
        const body = await readBody(); return send(200, await store.setHomeOrder(body.names));
      }
      if(req.method==='GET'&&route==='snapshots')return send(200,await store.snapshots());
      if(req.method==='GET'&&/^snapshots\/[^/]+$/.test(route)) {
        const entry=await store.snapshot(decodeURIComponent(route.split('/')[1]));
        return entry?send(200,entry):send(404,{error:'Snapshot not found'});
      }
      if(req.method==='POST'&&/^snapshots\/[^/]+\/(rollback|restore)$/.test(route)) {
        const [,revisionId,action]=route.split('/'),body=await readBody();
        return send(200,action==='rollback'?await store.rollback(decodeURIComponent(revisionId),body):await store.restore(decodeURIComponent(revisionId)));
      }
      if (req.method === 'GET' && route === 'graph') {
        const name=url.searchParams.get('name'),revisionId=url.searchParams.get('revisionId');
        const bundle=revisionId ? await store.loadSnapshotBundle(name,revisionId) : await store.loadBundle(name);
        return bundle ? send(200,workflowGraph(bundle.entries,name)) : send(404,{error:'Workflow unavailable'});
      }
      if (req.method === 'GET' && route === 'catalog') {
        const [capabilities, workflows] = await Promise.all([store.list('skill', { includeDisabled: true }), store.list('workflow', { includeDisabled: true })]);
        return send(200, { capabilities, workflows });
      }
      if (req.method === 'GET' && route.startsWith('entries/')) {
        const entry = await store.get(decodeURIComponent(route.slice('entries/'.length)), { includeDisabled: true });
        return entry ? send(200, { ...entry, digest: digest(entry) }) : send(404, { error: 'Capability not found' });
      }
      if (req.method === 'POST' && /^entries\/[^/]+\/homepage$/.test(route)) {
        const entryName = decodeURIComponent(route.split('/')[1]);
        const body = await readBody(); return send(200, await store.setShowOnHome(entryName, body.showOnHome));
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
        const task = await service.start({ sessionId: body.sessionId, sessionIds: body.sessionIds, name: body.name, intent:body.intent, operation: route, reviewFindings: body.reviewFindings, resumeTaskId:body.resumeTaskId, validateOnly:body.validateOnly, preserveContract:body.preserveContract, requirements:body.requirements });
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
