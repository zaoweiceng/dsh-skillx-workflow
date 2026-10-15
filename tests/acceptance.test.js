import test from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, validateAcceptance } from '../src/acceptance.js';
const schema={type:'object',properties:{mode:{type:'string'}},additionalProperties:false};
const outputSchema={type:'object',properties:{status:{type:'string'},value:{type:'integer'}},required:['status'],additionalProperties:false};
const makeCase=(id,input,calls,status)=>({id,covers:[id],input,calls,expect:{assertions:[{path:'/status',op:'eq',value:status}]}});
const suite={contracts:[{name:'lookup',inputSchema:schema,outputSchema,outcomePath:'/status',successValues:['ok'],limitations:'Simulation proves response handling, not external service reality.',cases:[
 makeCase('success',{},[{channel:'tool',name:'query',result:{count:1}}],'ok'),
 makeCase('defaults',{},[{channel:'tool',name:'query',result:{count:1}}],'ok'),
 makeCase('failure',{mode:'failure'},[{channel:'tool',name:'query',error:'unavailable'}],'unknown'),
 makeCase('empty',{mode:'empty'},[{channel:'tool',name:'query',result:{count:0}}],'empty'),
 makeCase('boundary',{mode:'boundary'},[{channel:'tool',name:'query',result:{count:-1}}],'unknown'),
]}],withdrawn:[]};
const good=`try {const result=await tools.call({name:'query',arguments:{}}); return {status:result.count>0?'ok':result.count===0?'empty':'unknown'};} catch {return {status:'unknown'};}`;
const candidate=program=>({name:'lookup',execution:{language:'typescript',inputSchema:schema,outputSchema,program}});
test('frozen general contract covers defaults, empty observations, errors and boundaries',async()=>{
 const frozen=validateAcceptance(suite,[{name:'lookup',dependsOn:[]}]);
 assert.equal((await runAcceptance([candidate(good)],frozen)).passed,true);
 assert.equal((await runAcceptance([candidate("await tools.call({name:'query',arguments:{}}); return {status:'ok'};")],frozen)).passed,false);
});
test('automatic dispatch fault injection rejects fabricated success despite passing nominal fixture',async()=>{
 const onlySuccess=structuredClone(suite); onlySuccess.contracts[0].cases=onlySuccess.contracts[0].cases.slice(0,1);
 const result=await runAcceptance([candidate("try {await tools.call({name:'query',arguments:{}});} catch {} return {status:'ok'};")],onlySuccess);
 assert.equal(result.results[0].passed,true); assert.equal(result.results[1].passed,false);
});
test('unexpected dispatch cannot be hidden by catching errors',async()=>{
 const result=await runAcceptance([candidate("try {await tools.call({name:'other'});} catch {} return {status:'unknown'};")],suite);
 assert.equal(result.passed,false); assert.ok(result.results.some(c=>c.actual.violations?.length));
});
test('schemas are frozen independently and cannot be weakened by implementation',async()=>{
 const changed=candidate(good); changed.execution.outputSchema={type:'json'};
 const result=await runAcceptance([changed],suite); assert.equal(result.passed,false); assert.match(result.results[0].error,/frozen/);
});
test('closed-world execution offers no process, imports or callback constructor escape',async()=>{
 for(const program of ['return process.env;', 'return await import("node:fs");', 'return tools.call.constructor("return process")();']) {
  const result=await runAcceptance([candidate(program)],suite); assert.equal(result.passed,false);
 }
});
test('unsupported candidates may be withdrawn; dependents cannot survive missing dependencies',()=>{
 const value={contracts:[],withdrawn:[{name:'lookup',reason:'Core executable behavior unsupported by isolated tests'}]};
 assert.equal(validateAcceptance(value,[{name:'lookup',dependsOn:[]}]).contracts.length,0);
 const incomplete=structuredClone(suite); incomplete.withdrawn=[{name:'base',reason:'unsupported'}];
 assert.throws(()=>validateAcceptance(incomplete,[{name:'lookup',dependsOn:['base']},{name:'base',dependsOn:[]}]),/Dependency failure|Withdraw/);
});

test('native foreground error responses cannot be treated as command success',async()=>{
 const c=candidate(`const result=await tools.call({name:'query'}); return {status:'ok'};`);
 const spec=structuredClone(suite);spec.contracts[0].cases=[makeCase('success',{},[{channel:'tool',name:'query',result:{kind:'foreground',exitCode:0,stdout:{text:'found',truncated:false},stderr:{text:'',truncated:false}}}],'ok')];
 const result=await runAcceptance([c],spec);
 assert.equal(result.results[0].passed,true);assert.equal(result.results.find(r=>r.caseId.includes('response-failure')).passed,false);
});

test('documentation annotations can improve Chinese labels without changing frozen behavior',async()=>{
 const c=candidate(good);c.execution.inputSchema=structuredClone(schema);c.execution.inputSchema.properties.mode.title='模式';c.execution.outputSchema=structuredClone(outputSchema);c.execution.outputSchema.description='观察结果';
 assert.equal((await runAcceptance([c],suite)).passed,true);
});
