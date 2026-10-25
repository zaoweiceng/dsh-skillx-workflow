import { parse } from 'acorn';
export function extractionRequirements(value={}) {
  if(!value || typeof value!=='object' || Object.keys(value).some(k=>!['target','workflowDepth','parallelBranches'].includes(k)))throw new Error('Invalid extraction requirements');
  const result={target:value.target ?? 'local',workflowDepth:value.workflowDepth ?? 0,parallelBranches:value.parallelBranches ?? 0};
  if(!['local','docker'].includes(result.target)||![result.workflowDepth,result.parallelBranches].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=8))throw new Error('Invalid extraction requirements');
  return result;
}
export function assertRequiredStructure(candidates, requirements, built=false) {
  const definitions=new Map(candidates.map(c=>[c.name,c]));
  const dependencies=c=>built?(c.dependencies ?? []).map(d=>d.name):c.dependsOn ?? [];
  const depth=(c,path=[])=>{
    if(path.includes(c.name))throw new Error('Dependency cycle');
    return (c.kind==='workflow'?1:0)+Math.max(0,...dependencies(c).map(name=>definitions.has(name)?depth(definitions.get(name),[...path,c.name]):0));
  };
  const observedDepth=Math.max(0,...candidates.map(c=>depth(c)));
  const observedBranches=Math.max(0,...candidates.map(c=>dependencies(c).length));
  if(observedDepth<requirements.workflowDepth || (!built && observedBranches<requirements.parallelBranches))throw new Error('Plan must preserve requested reusable boundaries before freezing: workflow depth '+observedDepth+'/'+requirements.workflowDepth+', distinct dependency branches '+observedBranches+'/'+requirements.parallelBranches+'. Decompose independently useful source results; a delivery wrapper does not replace missing branch capabilities.');
  if(built && requirements.parallelBranches>0){
    let maximum=0;
    const visit=node=>{
      if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&node.callee?.object?.name==='Promise'&&['all','allSettled'].includes(node.callee.property?.name)&&node.arguments[0]?.type==='ArrayExpression'){
        const calls=node.arguments[0].elements.filter(n=>n?.type==='CallExpression'&&n.callee?.object?.name==='capabilities'&&n.callee.property?.name==='run');
        maximum=Math.max(maximum,calls.length);
      }
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    };
    for(const c of candidates)if(c.execution.language==='typescript')visit(parse('(async()=>{'+c.execution.program+'})',{ecmaVersion:'latest'}));
    if(maximum<requirements.parallelBranches)throw new Error('Requested parallel capability branches must be executable Promise.all/allSettled literal calls; runtime overlap still needs real acceptance');
  }
}
