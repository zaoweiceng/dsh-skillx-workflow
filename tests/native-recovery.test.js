import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeRecoveryService } from '../src/native-recovery.js';

// Host plumbing only: no generated business program or external service is executed.
test('internal recovery preserves output contract; independent diagnosis gates persistent repair', async t => {
  for (const classification of ['transient', 'unknown', 'defect']) {
    const dataRoot = await mkdtemp(join(tmpdir(), 'native-recovery-'));
    const sessions = new Map(); const prompts = []; const optimizations = [];
    const ctx = {
      sessions: { flush: async () => {} },
      sessionQuery: { readSession: async id => ({ session:{id,cwd:tmpdir()}, events:sessions.get(id) }) },
      agents: { create: async settings => {
        const tools = new Map(); const events = []; let completion;
        const child = { session: { append() {} } };
        await settings.setup({
          tools: { presentAs() {}, restrict() {}, guard() {}, register: tool => tools.set(tool.name, tool) },
          systemPrompt: { section() {} }, on() {},
        }, child);
        sessions.set(settings.sessionId, events);
        return { agent: {
          session: { id:settings.sessionId, snapshotEvents:() => events }, cancel() {},
          followup: message => { completion = (async () => {
            const prompt = JSON.parse(message.content[0].text); prompts.push(prompt);
            const diagnosis = !prompt.outputSchema.properties.done;
            if (tools.has('read_recovery_evidence')) {
              const first = await tools.get('read_recovery_evidence').execute({page:0},{callId:'page0'});
              for (let page=1; page<first.totalPages; page++) await tools.get('read_recovery_evidence').execute({page},{callId:'page'+page});
              if (!diagnosis) assert.equal(JSON.parse(first.data).failureGuides[0].docs['docs/troubleshooting.md'], 'Inspect failed operation, then resume safely.');
            }
            if (!diagnosis) {
              await assert.rejects(tools.get('submit_recovery').execute({outcome:'completed', output:'invalid',reason:'recovered',category:'completed'}), /output schema mismatch/);
            }
            const output = diagnosis ? {diagnosis:'Observed cause',classification,shouldOptimize:classification==='defect',repairTarget:'operation',repairPlan:classification==='defect'?'Repair observed implementation defect.':'',recommendations:classification==='defect'?['Preserve original output.']:[]} : {done:true};
            events.push({type:'tool/call',data:{callId:'submit',name:'submit_recovery',arguments:{output}}});
            await tools.get('submit_recovery').execute({outcome:'completed',output,reason:'Complete',category:'completed'});
            events.push({type:'tool/result',data:{message:{toolCallId:'submit',isError:false,content:[{type:'text',text:JSON.stringify({output})}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}});
          })(); }, whenIdle: () => completion,
        }, dispose: async () => {} };
      } },
    };
    const service = createNativeRecoveryService(ctx, {dataRoot,store:{get:async () => ({revisionId:'original-revision'})},learningService:{
      start:async request => {optimizations.push(request);return {taskId:'learning'};}, get:async () => ({status:'completed'}),
    }});
    try {
      const entry={name:'operation',version:1,revisionId:'original-revision',docs:{'docs/troubleshooting.md':'Inspect failed operation, then resume safely.'},execution:{language:'typescript',inputSchema:{type:'object'},outputSchema:{type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false},program:'return {done:true};'}};
      const result=await service.recover({entry,input:{},failure:{code:'PROGRAM_ERROR'},trace:{events:[]},receipt:{runId:classification},exec:{signal:new AbortController().signal},hostContext:{id:'host',cwd:tmpdir()}});
      assert.equal(result.outcome,'completed',JSON.stringify(result)); assert.deepEqual(result.output,{done:true});
      let job;
      for (let attempt=0;attempt<100;attempt++) {
        const files=await readdir(join(dataRoot,'recovery'));
        const file=files.find(name=>/^maintenance-.*\.json$/.test(name) && !name.endsWith('-error.json'));
        if(file) job=JSON.parse(await readFile(join(dataRoot,'recovery',file),'utf8'));
        if(job?.finishedAt) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(job?.status,'completed',job?.diagnosticRecord ? await readFile(join(dataRoot,'recovery',job.diagnosticRecord),'utf8') : JSON.stringify(job));
      assert.equal(job.action,classification==='defect'?'repair':'no_change');
      assert.equal(optimizations.length,classification==='defect'?1:0);
      if(optimizations.length) assert.equal(optimizations[0].preserveContract,true);
      assert.equal(prompts.length,2);
      assert.equal(new Set(sessions.keys()).size,2);
    } finally {await service.dispose();await rm(dataRoot,{recursive:true,force:true});}
  }
});
