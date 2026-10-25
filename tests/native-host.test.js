import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as Plugin from '../src/index.js';
import { createNativeExecutionService } from '../src/native-execution.js';

test('platform mismatch in a dependency stops before any process or tool is dispatched', async () => {
  const unsupported = process.platform === 'win32' ? 'linux' : 'win32';
  const root = { name: 'root', revisionId:'snapshot', execution: {} };
  const dependency = { name: 'dependency', compatibility: { platforms: [unsupported], requirements: [], limitations: '平台限制，请使用已支持环境。' } };
  const execution = createNativeExecutionService({}, { loadBundle: async () => ({ root, entries: [root, dependency] }), loadSnapshotBundle:async(name,id)=>{assert.equal(name,'root');assert.equal(id,'snapshot');return {root,entries:[root,dependency]};} }, { dataRoot: '/unused-no-io' });
  try {
    const result = await execution.run({ name: 'root', input: {} }, { signal: new AbortController().signal });
    assert.equal(result.failure.code, 'PLATFORM_UNSUPPORTED');
    assert.equal(result.failure.capability, 'dependency');
    assert.equal(result.failure.retryable, false);
    assert.deepEqual(result.receipt.steps, []);
    const historical=await execution.run({name:'root',input:{},snapshotRevisionId:'snapshot',expectedRevisionId:'snapshot'},{signal:new AbortController().signal});
    assert.equal(historical.failure.code,'PLATFORM_UNSUPPORTED');
  } finally { await execution.dispose(); }
});

class WebServer extends Service {
  routes = [];
  constructor(ctx) { super(ctx, 'webServer'); }
  register(route) { this.routes.push(route); return () => { this.routes.splice(this.routes.indexOf(route), 1); }; }
}
const stub = name => class extends Service { constructor(ctx) { super(ctx, name); } };
async function host(t, enableCapabilities) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'native-host-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SkillRegistry); await ctx.plugin(WebServer);
  for (const name of ['sessionQuery', 'agents', 'sessions', 'agentDefaultModel']) await ctx.plugin(stub(name));
  const fork = ctx.plugin(Plugin, { dataRoot, enableCapabilities }); await fork;
  const request = async (method, path, body) => {
    const result = {};
    const req = { method, url: '/skillx-workflow/api/' + path, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
    const res = { writeHead(status) { result.status = status; }, end(raw) { result.body = JSON.parse(raw); } };
    await ctx.webServer.routes[0].handler(req, res); return result;
  };
  return { ctx, fork, dataRoot, request };
}

test('native plugin exposes direct catalog/runtime API and disposes its route', async t => {
  const f = await host(t, true);
  assert.equal(f.ctx.webServer.routes.length, 1);
  assert.deepEqual((await f.request('GET', 'catalog')).body, { capabilities: [], workflows: [] });
  const runtime=(await f.request('GET', 'runtime')).body;
  assert.deepEqual({mode:runtime.mode,dataRoot:runtime.dataRoot,enableCapabilities:runtime.enableCapabilities}, { mode: 'native-agent', dataRoot: f.dataRoot, enableCapabilities: true });
  assert.equal(runtime.generationPolicy.revision,'completion-evidence-v2');
  assert.equal(runtime.generationPolicy.totalTimeoutMs,600000);
  assert.deepEqual(await f.ctx.skills.list(), []);
  await f.fork.dispose(); assert.equal(f.ctx.webServer.routes.length, 0);
});

test('baseline disables native provider while UI routes stay available', async t => {
  const f = await host(t, false);
  assert.equal((await f.request('GET', 'runtime')).body.enableCapabilities, false);
  assert.equal((await f.request('GET', 'catalog')).status, 200);
  assert.equal((await f.request('GET', 'entries/unknown')).status, 404);
  assert.equal((await f.request('POST', 'entries/unknown/availability', { enabled: true })).status, 400);
  assert.equal((await f.request('POST', 'entries/unknown/homepage', { showOnHome: true })).status, 400);
  assert.deepEqual(await f.ctx.skills.list(), []);
});

test('native config bounds and absolute data storage are validated', () => {
  assert.equal(Plugin.resolveConfig().enableCapabilities, true);
  for (const config of [{ enableCapabilities: 'yes' }, { dataRoot: './relative' }, { timeoutMs: 0 }, { maxSteps: 0 }]) assert.throws(() => Plugin.resolveConfig(config));
});

test('literal process dispatch uses native confinement and Python entries keep the same JSON contract', async t => {
  const {registerNativeProcess}=await import('../src/native-process.js');
  let definition,spawned,confined;let terminated=false,drained=false;
  const dataRoot=await mkdtemp(join(tmpdir(),'native-process-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const ctx={tools:{register:tool=>{definition=tool;return ()=>{};}},get:name=>({
    sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:dataRoot})},
    sandbox:{confine:async(argv,policy)=>{confined={argv,policy};return {argv:['sandbox-runner',...argv],denialSignatures:[],enforcement:'full'};}},
    subprocess:{resolveExecutable:async command=>command,spawn:spec=>{spawned=spec;return {done:Promise.resolve({exitCode:0,signal:null}),collected:{stdout:{readFrom:()=>({text:'{}',lossy:false})},stderr:{readFrom:()=>({text:'',lossy:false})}},terminate:()=>{terminated=true;},waitForExit:async()=>{drained=true;return true;}};}},
  })[name]};
  registerNativeProcess(ctx);
  const literal='path with spaces;$(not-a-command)';
  await definition.execute({executable:'git',args:['--',literal]}, {agent:{session:{}},signal:new AbortController().signal});
  assert.deepEqual(confined.argv,['git','--',literal]);assert.deepEqual(spawned.argv,['sandbox-runner','git','--',literal]);
  assert.equal(spawned.shell,undefined);assert.ok(terminated&&drained);
  const {createStore}=await import('../src/native-store.js');const store=createStore({dataRoot});
  const entry=await store.commit({name:'python-entry',description:'Python entry',content:'Read JSON, return JSON',kind:'skill',operation:'extract',sourceSessionId:'source',generatorSessionId:'generator',evidence:{provider:'dsh',status:'completed',sessionId:'generator'},execution:{language:'python',inputSchema:{type:'object'},outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},program:'import json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({"ok": True}))\n'}});
  let call;
  const runtime=createNativeExecutionService({tools:{execute:async request=>{call=request;return {isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'{"ok":true}',truncated:false},stderr:{text:'',truncated:false}}};}}},store,{dataRoot});
  try{const result=await runtime.run({name:entry.name,input:{}},{agent:{session:{header:{id:'session',cwd:dataRoot}}},token:{},rootCallId:'root',callId:'call',signal:new AbortController().signal});
    assert.equal(result.ok,true,JSON.stringify(result.failure));assert.equal(call.name,'capability_process');assert.equal(call.arguments.executable,'@python');assert.ok(call.arguments.args[0].endsWith('entry.py'));
    const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dataRoot,'skillx','python-entry','entry.py'),'utf8'),entry.execution.program);
    const manifest=JSON.parse(await readFile(join(dataRoot,'skillx','python-entry','manifest.json'),'utf8'));assert.equal(manifest.entry.runtime,'python');
  }finally{await runtime.dispose();}
});


test('native process failures retain stable codes through the real tool dispatcher',async t=>{
  const f=await host(t,true);
  const result=await f.ctx.tools.execute({name:'capability_process',arguments:{executable:'@node',args:[]},callId:'process-code',signal:new AbortController().signal});
  assert.equal(result.isError,true);
  assert.equal(result.error.info?.code,'PROCESS_RUNTIME_UNAVAILABLE',JSON.stringify(result));
  await f.ctx.plugin(class extends Service {
    constructor(ctx){super(ctx,'subprocess');}
    spawn(){throw new Error('must not launch');}
    resolveExecutable(){throw Object.assign(new Error('unavailable'),{name:'SubprocessExecutableNotFoundError'});}
  });
  await f.ctx.plugin(class extends Service {
    constructor(ctx){super(ctx,'sandboxPolicy');}
    resolve(){return {mode:'danger-full-access',workspaceRoot:f.dataRoot};}
  });
  for (const [executable,code] of [['missing-cli','EXECUTABLE_REQUIRED'],['missing.cmd','CLI_LAUNCHER_REQUIRED']]) {
    const failed=await f.ctx.tools.execute({name:'capability_process',arguments:{executable},callId:'process-'+code,signal:new AbortController().signal});
    assert.equal(failed.error.info?.code,code,JSON.stringify(failed));
  }
  await f.request('GET','catalog');
  await f.fork.dispose();
});
