import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Context,Service} from '@deepseek-ai/cordis';
import {registerNativeProcess} from '../src/native-process.js';
import {createNativeExecutionService} from '../src/native-execution.js';
import {createNativeRecoveryService} from '../src/native-recovery.js';
import {normalizeCompatibility} from '../src/native-contract.js';
import {createStore} from '../src/native-store.js';

// Real subprocesses behind the host seam. Only PTC evaluation is a fixture.
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'skillx process 中文 '));
  const calls=[];let definition;
  let subprocess={
    resolveExecutable:async executable=>{if(isAbsolute(executable))await access(executable);return executable;},
    spawn(spec){
      const child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:{...process.env,...spec.env},stdio:['pipe','pipe','pipe']});
      let timer;let ended=false;
      const terminate=()=>{if(!ended){child.kill('SIGTERM');timer??=setTimeout(()=>child.kill('SIGKILL'),100);timer.unref();}};
      spec.signal.addEventListener('abort',terminate,{once:true});
      const collected={};
      for(const name of ['stdout','stderr']){
        let chunks=[];let size=0;const cap=spec.stdio[name].maxBytes;
        child[name].on('data',chunk=>{size+=chunk.length;chunks.push(chunk);if(size>cap)chunks=[Buffer.concat(chunks).subarray(-cap)];});
        collected[name]={readFrom:()=>({text:Buffer.concat(chunks).toString('utf8'),lossy:size>cap})};
      }
      child.stdin.on('error',()=>{});child.stdin.end(spec.stdio.stdin?.data);
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>{ended=true;clearTimeout(timer);spec.signal.removeEventListener('abort',terminate);resolve({exitCode,signal});});});
      return {done,collected,terminate,waitForExit:()=>done};
    }
  };
  const policy={resolve:()=>({mode:'danger-full-access',workspaceRoot:root})};
  let nativePtc;
  if (process.env.DSH_RUNTIME_MODULES) {
    const module = async name => (await import(pathToFileURL(join(process.env.DSH_RUNTIME_MODULES,'@deepseek-ai',name,'lib/index.js')).href)).default;
    const native = new Context();
    for (const [name,value] of Object.entries({fs:{processPathFromHostPath:path=>path},sandbox:{},sandboxPolicy:policy})) {
      await native.plugin(class extends Service {constructor(ctx){super(ctx,name);Object.assign(this,value);}});
    }
    await native.plugin(await module('dsh-subprocess-local'));
    await native.plugin(await module('dsh-ptc-runtime-node'),{timeoutMs:120000,maxTimeoutMs:600000,maxOutputBytes:67108864,maxOldGenerationSizeMb:512,maxMessageBytes:134217728,maxPendingCalls:128,graceMs:1000});
    subprocess=native.subprocess;nativePtc=native.ptcRuntime;
    t.after(()=>native.fiber.dispose());
  }
  const ctx={get:name=>({subprocess,sandboxPolicy:policy})[name],tools:{register:tool=>{definition=tool;return()=>{};}}};
  registerNativeProcess(ctx,{pythonExecutable:process.env.SKILLX_TEST_PYTHON ?? 'python3'});
  const exec={agent:{session:{header:{id:'process-test',cwd:root}}},token:{},rootCallId:'root',callId:'call',signal:new AbortController().signal};
  ctx.tools.execute=async request=>{calls.push(request);return {isError:false,value:await definition.execute(request.arguments,exec)};};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  ctx.ptcRuntime=nativePtc ?? {language:'typescript',isolation:'process',resolve:s=>s,run:async s=>({value:await new AsyncFunction('__native_capability',s.program)(s.bindings[0].functions)})};
  ctx.sandboxPolicy=policy;
  const store=createStore({dataRoot:join(root,'store')});
  const runtime=createNativeExecutionService(ctx,store,{dataRoot:join(root,'runs')});
  t.after(async()=>{await runtime.dispose();await rm(root,{recursive:true,force:true});});
  const contract=program=>({language:'typescript',inputSchema:{type:'object'},outputSchema:{type:'object'},program});
  const run=program=>runtime.runImplementation(contract(program),{},exec);
  const save=(name,program,extra={})=>store.commit({name,kind:'skill',description:name,content:name,sourceSessionId:'source',generatorSessionId:'generator',operation:'extract',evidence:{provider:'dsh',status:'completed',sessionId:'generator'},execution:contract(program),...extra});
  return {root,run,runtime,store,save,contract,exec,calls,process:(request,signal=exec.signal)=>definition.execute(request,{...exec,signal})};
}
const nodeRequest=code=>({executable:'@node',args:['-e',code]});
const compatibility=probes=>({platforms:[process.platform],requirements:[],limitations:'Verified on test host only.',probes});

test('real process: raw nonzero stays compatible but is failed, readable and not reusable',async t=>{
  const f=await fixture(t);
  const r=await f.run(`return await processes.run(${JSON.stringify(nodeRequest('process.exitCode=7;console.log("failure evidence")'))});`);
  assert.equal(r.ok,true);assert.equal(r.output.exitCode,7);assert.equal(r.receipt.steps[0].status,'failed');
  const trace=await f.runtime.readTrace(r.receipt.runId,f.exec);
  assert.equal(trace.events.find(e=>e.type==='dispatch/end').reusable,false);
  const page=await f.runtime.readResult({runId:r.receipt.runId,stepId:r.receipt.steps[0].stepId},f.exec);
  assert.match(JSON.stringify(page),/failure evidence/);
  const reused=await f.runtime.runImplementation(f.contract(`return await tools.reuse({stepId:${JSON.stringify(r.receipt.steps[0].stepId)}});`),{},f.exec,{resumeEvidence:r.receipt.runId});
  assert.equal(reused.failure.code,'RESUME_STEP_UNAVAILABLE');
});
test('real checkedRun rejects exit failure and accepts explicit expected nonzero',async t=>{
  const f=await fixture(t);const request=nodeRequest('process.exitCode=7');
  assert.equal((await f.run(`return await processes.checkedRun(${JSON.stringify(request)});`)).failure.code,'PROCESS_EXIT_FAILED');
  const ok=await f.run(`return await processes.checkedRun(${JSON.stringify({...request,acceptedExitCodes:[7]})});`);
  assert.equal(ok.ok,true);assert.equal(ok.output.exitCode,7);assert.equal(ok.receipt.steps[0].status,'succeeded');
  assert.equal((await f.run(`return await processes.checkedRun(${JSON.stringify({...request,acceptedExitCodes:[]})});`)).failure.code,'INVALID_PROCESS_ARGUMENT');
});
test('real process timeout, cancellation and oversized stdout are distinct',async t=>{
  const f=await fixture(t);
  const timeout=await f.run(`return await processes.checkedRun(${JSON.stringify({...nodeRequest('setInterval(()=>{},1000)'),timeoutMs:150})});`);
  assert.equal(timeout.failure.code,'PROCESS_TIMEOUT');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),150);
  const cancelled=await f.process(nodeRequest('setInterval(()=>{},1000)'),controller.signal);clearTimeout(timer);assert.equal(cancelled.aborted,true);
  const oversized=await f.run(`return await processes.checkedRun(${JSON.stringify(nodeRequest('process.stdout.write("x".repeat(1100000))'))});`);
  assert.equal(oversized.failure.code,'PROCESS_OUTPUT_TRUNCATED');
});
test('real bundled JS valid result survives stderr truncation',async t=>{
  const f=await fixture(t);
  await f.save('verbose','return await resources.run({path:"scripts/main.cjs"});',{resources:{'scripts/main.cjs':'exports.main=()=>{console.error("x".repeat(100000));return {ok:true};};'}});
  const result=await f.runtime.run({name:'verbose',input:{}},f.exec);
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.output,{ok:true});
});
test('real bundled JS rejects lossy output before serialization',async t=>{
  const f=await fixture(t);
  for(const [i,expression] of ['{n:NaN}','{a:[undefined]}','{n:Infinity}','{optional:undefined}','{date:new Date()}','{a:new Array(2)}'].entries()){
    const name='lossy-'+i;
    await f.save(name,'return await resources.run({path:"scripts/main.cjs"});',{resources:{'scripts/main.cjs':`exports.main=()=>(${expression});`}});
    assert.equal((await f.runtime.run({name,input:{}},f.exec)).failure.code,'SCRIPT_OUTPUT_NOT_JSON',expression);
  }
});
test('real bundled JS malformed stdout and thrown errors retain distinct codes',async t=>{
  const f=await fixture(t);
  for(const [name,body,code] of [['bad-json','console.log("noise");return {ok:true};','SCRIPT_OUTPUT_INVALID'],['throwing','throw new Error("fixture failure");','SCRIPT_PROGRAM_FAILED']]){
    await f.save(name,'return await resources.run({path:"scripts/main.cjs"});',{resources:{'scripts/main.cjs':`exports.main=()=>{${body}}`}});
    assert.equal((await f.runtime.run({name,input:{}},f.exec)).failure.code,code);
  }
});
test('real launcher preserves Unicode, spaces and shell metacharacters',async t=>{
  const f=await fixture(t);const file=join(f.root,'cli 中文.cjs');await writeFile(file,'console.log(JSON.stringify(process.argv.slice(2)));');
  const arg='中文 path ;$(echo wrong)';const r=await f.process({executable:file,args:[arg]});
  assert.equal(r.exitCode,0);assert.deepEqual(JSON.parse(r.stdout.text),[arg]);
  await assert.rejects(f.process({executable:'missing.cmd'}),{code:'CLI_LAUNCHER_REQUIRED'});
  await assert.rejects(f.process({executable:join(f.root,'not-installed')}),{code:'EXECUTABLE_REQUIRED'});
});
test('real dependency preflight blocks root business code and recovery model',async t=>{
  const f=await fixture(t);
  await f.save('leaf','return {ok:true};',{compatibility:compatibility([{executable:join(f.root,'missing-cli'),args:['--version']}])});
  await f.save('parent','throw new Error("business must not start");',{kind:'workflow',dependencies:[{name:'leaf',version:1}]});
  const result=await f.runtime.run({name:'parent',input:{}},f.exec);
  assert.equal(result.failure.stage,'preflight');assert.equal(result.failure.code,'EXECUTABLE_REQUIRED');assert.equal(result.failure.capability,'leaf');
  assert.equal(result.failure.environmentCheck.executable,join(f.root,'missing-cli'));
  assert(!(await f.runtime.readTrace(result.receipt.runId,f.exec)).events.some(e=>e.type==='implementation/start'));
  const recovery=createNativeRecoveryService({},{});
  assert.equal((await recovery.recover({failure:result.failure})).category,'environment');await recovery.dispose();
});
test('real preflight deduplicates probes, detects mismatch and leaves legacy unchanged',async t=>{
  const f=await fixture(t);const probe={executable:'@node',args:['--version'],stdoutIncludes:process.version};
  await f.save('leaf','return {ok:true};',{compatibility:compatibility([probe])});
  await f.save('parent','return await capabilities.run({name:"leaf",input:{}});',{kind:'workflow',dependencies:[{name:'leaf',version:1}],compatibility:compatibility([probe])});
  assert.equal((await f.runtime.run({name:'parent',input:{}},f.exec)).ok,true);assert.equal(f.calls.length,1);
  assert.deepEqual((await f.store.get('parent')).compatibility.probes,[probe]);
  await f.save('mismatch','return {};',{compatibility:compatibility([{...probe,stdoutIncludes:'impossible-version'}])});
  assert.equal((await f.runtime.run({name:'mismatch',input:{}},f.exec)).failure.code,'ENVIRONMENT_OUTPUT_MISMATCH');
  f.calls.length=0;await f.save('legacy','return {ok:true};');
  assert.equal((await f.runtime.run({name:'legacy',input:{}},f.exec)).ok,true);assert.equal(f.calls.length,0);
});
test('preflight rejects malformed declarations before execution',()=>{
  for(const probe of [{executable:'x'},{executable:'x',args:[],timeoutMs:0},{executable:'x',args:[],env:{TOKEN:'secret'}},{executable:'x',args:[],stdoutIncludes:''}])assert.throws(()=>normalizeCompatibility(compatibility([probe])),/Invalid compatibility probe/);
});

// A caught failure must not poison a later success or unrelated exception.
test('host rejection identity survives PTC without poisoning handled failures',async t=>{
  const f=await fixture(t);const request=JSON.stringify(nodeRequest('process.exitCode=7'));
  const handled=await f.run(`try {await processes.checkedRun(${request});} catch(error) {return {code:error.message};}`);
  assert.equal(handled.ok,true);assert.equal(handled.output.code,'PROCESS_EXIT_FAILED');
  const later=await f.run(`try {await processes.checkedRun(${request});} catch {} throw new Error("different failure");`);
  assert.equal(later.failure.code,process.env.DSH_RUNTIME_MODULES?'PROGRAM_EXCEPTION':'UNKNOWN');
});
test('real Python resource uses the same result validation and preflight',async t=>{
  const f=await fixture(t);
  await f.save('python-resource','return await resources.run({path:"scripts/main.py",input:{text:"中文 path"}});',{
    compatibility:compatibility([{executable:'@python',args:['-c','import json, hashlib; print("stdlib-ready")'],stdoutIncludes:'stdlib-ready'}]),
    resources:{'scripts/main.py':'import sys, json, hashlib\nr=json.load(sys.stdin)\nprint(json.dumps({"text":r["input"]["text"],"digest":hashlib.sha256(b"abc").hexdigest()}))\n'}
  });
  const result=await f.runtime.run({name:'python-resource',input:{}},f.exec);
  assert.equal(result.ok,true,JSON.stringify(result.failure));assert.equal(result.output.text,'中文 path');
  assert.equal(result.output.digest,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('known missing runtime conditions do not invoke model repair without a preflight',async()=>{
  const recovery=createNativeRecoveryService({},{});
  for (const code of ['EXECUTABLE_REQUIRED','CLI_LAUNCHER_REQUIRED','PROCESS_RUNTIME_UNAVAILABLE']) {
    const result=await recovery.recover({entry:{},failure:{code,stage:'native-tool'}});
    assert.equal(result.outcome,'external_blocked');assert.equal(result.category,'environment');
  }
  await recovery.dispose();
});


test('real PTC supports Node modules and local require shadowing across deep repeated workflow calls',async t=>{
  const f=await fixture(t);
  const leaf=await f.save('module-leaf',"const path=require('node:path'); const fs=await import('node:fs'); return {ok:typeof fs.readFile==='function' && path.basename('/a/b')==='b'};");
  await f.save('module-package',"return await capabilities.run({name:'module-leaf',input});",{kind:'workflow',dependencies:[{name:leaf.name,version:1}]});
  await f.save('module-project',"return await capabilities.run({name:'module-package',input});",{kind:'workflow',dependencies:[{name:'module-package',version:1}]});
  await f.save('module-region',"return await capabilities.run({name:'module-project',input});",{kind:'workflow',dependencies:[{name:'module-project',version:1}]});
  await f.save('module-batch',"const results=[];for(let i=0;i<26;i++)results.push(await capabilities.run({name:'module-region',input})); return {count:results.length,ok:results.every(r=>r.ok)};",{kind:'workflow',dependencies:[{name:'module-region',version:1}]});
  const result=await f.runtime.run({name:'module-batch',input:{}},f.exec);
  assert.equal(result.ok,true,JSON.stringify(result.failure));assert.deepEqual(result.output,{count:26,ok:true});
  assert.ok(result.receipt.implementations.length>100);
  const shadowed=await f.run("const require=()=>({value:42}); return require('local');");
  assert.equal(shadowed.ok,true);assert.deepEqual(shadowed.output,{value:42});
});
