import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowGraph} from '../src/workflow-graph.js';
const entry=(name,program,deps=[],kind='workflow',version=1)=>({name,version,kind,execution:{language:'typescript',program},dependencies:deps.map(name=>({name,version:1}))});
const reachable=(g,a,b)=>{const seen=new Set();const walk=id=>{if(id===b)return true;if(seen.has(id))return false;seen.add(id);return g.edges.filter(e=>e.from===id).some(e=>walk(e.to));};return walk(a);};
test('source-derived graph expands three workflow layers and preserves fork/join, without graph metadata',()=>{
  const entries=[entry('root',"return await capabilities.run({name:'batch',input});",['batch']),entry('batch',"return await capabilities.run({name:'dataset',input});",['dataset']),entry('dataset',"const x=await Promise.all([capabilities.run({name:'csv',input}),capabilities.run({name:'image',input})]); return await capabilities.run({name:'aggregate',input:{x}});",['csv','image','aggregate']),...['csv','image','aggregate'].map(name=>entry(name,'return input;',[],'skill'))];
  const original=JSON.stringify(entries),g=workflowGraph(entries,'root');
  assert.equal(JSON.stringify(entries),original);assert.equal(g.basis,'executable-syntax-v1');
  assert.equal(g.nodes.filter(n=>n.type==='workflow-start').length,3);
  const node=name=>g.nodes.find(n=>n.type==='skill'&&n.label===name).id;
  assert.equal(reachable(g,node('csv'),node('image')),false);assert.equal(reachable(g,node('image'),node('csv')),false);
  for(const name of ['csv','image'])assert.equal(reachable(g,node(name),node('aggregate')),true);
  assert.deepEqual(g.limitations,[]);
});
test('comments never generate stages and mutually exclusive branches do not become serial',()=>{
  const entries=[entry('root',"// ---- 1. fake ----\nif(input.test){await capabilities.run({name:'yes',input});}else{await capabilities.run({name:'no',input});} return input;",['yes','no']),entry('yes','return input;',[],'skill'),entry('no','return input;',[],'skill')];
  const g=workflowGraph(entries,'root'),yes=g.nodes.find(n=>n.label==='yes').id,no=g.nodes.find(n=>n.label==='no').id;
  assert.equal(reachable(g,yes,no),false);assert.equal(reachable(g,no,yes),false);assert.ok(g.nodes.some(n=>n.type==='join'));assert.ok(!JSON.stringify(g).includes('fake'));
});
test('unawaited promises, dynamic calls and external scripts are explicit unknowns, never invented serial DAGs',()=>{
  for(const program of ["const pending=capabilities.run({name:'leaf',input});await pending;",'for(const item of input.items){await work(item)}','return await Promise.all(input.items.map(work));']){
    const g=workflowGraph([entry('root',program)],'root');assert.ok(g.limitations.length);assert.ok(g.nodes.some(n=>n.type==='opaque'));
  }
  const g=workflowGraph([{...entry('py','print(1)'),execution:{language:'python',program:'print(1)'}}],'py');assert.match(g.limitations[0],/外部脚本/);
});
test('wrong version locks cannot be expanded as a current child implementation',()=>{
  const g=workflowGraph([entry('root',"return await capabilities.run({name:'child',input});",['child']),entry('child','return input;',[],'workflow',2)],'root');
  assert.equal(g.nodes.filter(n=>n.type==='workflow-start').length,1);assert.ok(g.limitations.length);
});

test('awaits inside Promise.all array are not misrepresented as parallel branches',()=>{
  const g=workflowGraph([entry('root',"return await Promise.all([await capabilities.run({name:'leaf',input}),await capabilities.run({name:'leaf',input})]);",['leaf']),entry('leaf','return input;',[],'skill')],'root');
  assert.ok(g.nodes.some(n=>n.type==='opaque'));assert.ok(!g.nodes.some(n=>n.type==='parallel-start'));
});

test('opaque try and loop regions expose nested call sites as containment, never scheduling edges',()=>{
  const g=workflowGraph([
    entry('root',"try { for(const x of input.items) await capabilities.run({name:'middle',input:x}); } catch(e) { return null; }",['middle']),
    entry('middle',"try { return await capabilities.run({name:'child',input}); } catch(e) { return null; }",['child']),
    entry('child','return input;')
  ],'root');
  assert.equal(g.nodes.filter(n=>n.type==='workflow-start').length,3);
  assert.equal(g.edges.filter(e=>e.relation==='contains').length,2);
  assert.ok(g.nodes.some(n=>n.type==='opaque'));
  assert.ok(!g.nodes.some(n=>n.type==='parallel-start'));
  const rootEnd=g.nodes.find(n=>n.type==='workflow-end'&&n.capability==='root').id;
  const childStart=g.nodes.find(n=>n.type==='workflow-start'&&n.capability==='child').id;
  assert.equal(reachable(g,childStart,rootEnd),false,'unknown call sites must not invent a successful join');
});

test('a directly awaited always-throwing workflow does not invent a success continuation',()=>{
  const g=workflowGraph([entry('root',"await capabilities.run({name:'child',input});return await capabilities.run({name:'after',input});",['child','after']),entry('child','throw new Error("failed");'),entry('after','return input;',[],'skill')],'root');
  assert.ok(g.nodes.some(n=>n.type==='throw'));
  assert.ok(!g.nodes.some(n=>n.type==='workflow-end'));
  assert.ok(!g.nodes.some(n=>n.capability==='after'));
});

test('Promise.all rejection and allSettled completion retain different continuation semantics',()=>{
  for(const method of ['all','allSettled']) {
    const g=workflowGraph([entry('root',`await Promise.${method}([capabilities.run({name:'child',input})]);return await capabilities.run({name:'after',input});`,['child','after']),entry('child','throw new Error("failed");'),entry('after','return input;',[],'skill')],'root');
    assert.equal(g.nodes.some(n=>n.capability==='after'),method==='allSettled');
    assert.equal(g.nodes.some(n=>n.type==='parallel-reject'),method==='all');
  }
});

test('spread arguments cannot fabricate a fixed dependency target or crash rendering',()=>{
  const g=workflowGraph([entry('root',"return await capabilities.run({name:'child',...input});",['child']),entry('child','return input;')],'root');
  assert.equal(g.nodes.filter(n=>n.type==='workflow-start').length,1);
  assert.ok(g.nodes.some(n=>n.type==='opaque'));
});
