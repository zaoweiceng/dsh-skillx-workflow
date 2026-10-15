import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeExecution, validateExecutionInput, validateExecutionOutput } from './native-contract.js';
const worker = readFileSync(new URL('./acceptance-worker.js', import.meta.url), 'utf8');
export const acceptanceProtocol = {
  purpose: 'Freeze independent behavioral contracts BEFORE implementation. No candidate code is visible to this phase. Historical commands are data, never executed.',
  format: { withdrawn: [{name:'planned-name',reason:'Concrete unsupported behavior or absent reuse value; withdraw dependents too'}], contracts: [{ name: 'planned-name', inputSchema: 'DSH object schema; only type, oneOf, properties, required, additionalProperties, items, enum, const, title, description; no minimum/maximum/pattern/$ref', outputSchema: 'DSH schema', outcomePath: '/status', successValues: ['ok'], limitations: 'What simulation cannot establish', cases: [{ id: 'unique', covers: ['success'], input: {}, calls: [{ channel: 'tool|capability|reason', name: 'native name', assertions: [{ path: '/arguments/command', op: 'contains', value: 'expected operation' }], optionalReason: 'Only for observations whose loss does not invalidate the advertised success; concrete independent fallback required', result: 'canonical native JSON OR error string', error: 'optional thrown dispatch failure' }], expect: { throws: false, assertions: [{ path: '/status', op: 'eq', value: 'ok' }] } }] }] },
  rules: 'Every contract needs success, defaults (all optional root inputs omitted), failure and boundary cases; tool/dependency operations also need empty and failure response cases. Each declared dependency needs a thrown-error case. Calls are ordered closed-world mocks; all must be consumed. Allowed coverage tags are success/defaults/empty/failure/boundary. failure means an unavailable/failed observation or dependency, not a valid negative/empty business result. Never require a declared successful outcome in a failure case. Expected-output assertions use JSON pointers and eq/ne/in/exists/contains, always with a value. Request assertions inside calls support only eq/contains. successValues MUST include ALL trustworthy completed outcomes, including valid empty/negative/not-found outcomes, not only a status spelled success/ok. Never include unknown, failed or pending outcomes. Every non-failure returning case must assert one of these completed outcomes; tag a deliberately unsuccessful boundary case failure too. For every unconstrained root string input, include a boundary case containing whitespace, quotes, shell metacharacters and command substitution syntax (for example a value containing a space, apostrophe, semicolon and $(...)). Treat caller strings as data: safely quote/encode or reject before dispatch; never interpolate unchecked input into shell syntax. Requests in that case must be asserted, or no calls allowed when rejecting the input. Do not claim PPID 1 alone proves orphaning, supervision or restart safety; report observed facts and uncertainty. Reject incomplete/truncated observations instead of drawing definitive conclusions. Preserve resource/session/transaction lifetimes across tool calls. Unless a native contract explicitly promises persistence, separate shell calls are independent: a PID or other call-scoped handle obtained from a completed call is not a valid persistent caller identity. A capability invocation is not a shared native tool session: each tools.call is independent even within the same capability invocation. Mock internal consistency cannot establish persistence, and a request is not evidence of successful behavior. Defaults must be derived from stable supplied inputs or context whose lifetime is guaranteed; otherwise require explicit input, collect all needed observations atomically while the resource exists, or withdraw unsupported behavior. Do not create mocks that resurrect expired resources or assume shared execution context. No external permission change or privilege escalation is an implementation repair. Failure cases may throw or return non-success. Simulated native command results do NOT verify embedded scripts: omit candidates whose essential executable behavior cannot be tested by this runner (e.g. generated Python/shell daemons), and omit their dependent candidates. Do not invent passing fixtures to force extraction. Tests must assert business evidence, not only a success flag. Include realistic canonical results and command nonzero/permission errors, domain empty and negative states when relevant; derive from the contract, not a fixed incident checklist.',
};
const canonical = value => JSON.stringify(value, (_k,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
export const acceptanceDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

// Documentation annotations may improve labels without weakening behavior.
function behavioralSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k])=>!['title','description'].includes(k)).map(([k,v])=>[k,k==='properties'?Object.fromEntries(Object.entries(v).map(([name,item])=>[name,behavioralSchema(item)])):k==='items'?behavioralSchema(v):k==='oneOf'?v.map(behavioralSchema):v]));
}
const pointer = (value,path) => path.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],value);
function check(value, assertion) {
  const actual = pointer(value, assertion.path);
  switch(assertion.op) {
    case 'eq': return canonical(actual) === canonical(assertion.value);
    case 'ne': return canonical(actual) !== canonical(assertion.value);
    case 'in': return Array.isArray(assertion.value) && assertion.value.some(v=>canonical(v)===canonical(actual));
    case 'exists': return (actual !== undefined) === assertion.value;
    case 'contains': return typeof actual === 'string' && typeof assertion.value === 'string' ? actual.includes(assertion.value) : Array.isArray(actual) && actual.some(value=>canonical(value)===canonical(assertion.value));
    default: return false;
  }
}
export function validateAcceptance(value, planned) {
  if (!value || !Array.isArray(value.contracts) || !Array.isArray(value.withdrawn) || Buffer.byteLength(JSON.stringify(value)) > 256*1024) throw new Error('Supply contracts and withdrawn arrays, at most 256 KiB');
  const names = [...value.contracts.map(c=>c.name), ...value.withdrawn.map(c=>c.name)];
  if (new Set(names).size !== names.length || canonical([...names].sort()) !== canonical(planned.map(c=>c.name).sort())) throw new Error(JSON.stringify({code:'CONTRACT_COVERAGE_MISMATCH',expectedNames:planned.map(c=>c.name),providedNames:names,instruction:'Supply exactly one contract or withdrawal for each expected name, with no duplicates or other names. Read __protocol__ for the array shape.'}));
  for (const item of value.withdrawn) if (!item.reason?.trim()) throw new Error('Withdrawal requires reason');
  for (const contract of value.contracts) {
    normalizeExecution({language:'typescript',inputSchema:contract.inputSchema,outputSchema:contract.outputSchema,program:'return null;'});
    if (!contract.outcomePath?.startsWith('/') || !contract.successValues?.length || !contract.limitations?.trim() || !Array.isArray(contract.cases) || contract.cases.length < 4 || contract.cases.length > 40) throw new Error('Contract requires outcome discriminator, limitations and 4..40 cases');
    const coverage = new Set(contract.cases.flatMap(c=>c.covers || []));
    for (const required of ['success','defaults','failure','boundary']) if (!coverage.has(required)) throw new Error('Missing coverage: '+required);
    const optional = Object.keys(contract.inputSchema.properties || {}).filter(k=>!(contract.inputSchema.required || []).includes(k));
    if (!contract.cases.some(c=>c.covers.includes('defaults') && optional.every(k=>!(k in c.input)))) throw new Error('Defaults case must omit all optional inputs');
    if(new Set(contract.cases.map(c=>c.id)).size !== contract.cases.length) throw new Error('Case IDs must be unique');
    for (const test of contract.cases) {
      if (!Array.isArray(test.covers) || !test.covers.length) throw new Error('Case coverage must be explicit');
      if (!test.id || !Array.isArray(test.calls) || !test.expect || (!test.expect.throws && !test.expect.assertions?.length)) throw new Error('Each case requires calls and meaningful expected assertions');
      if (validateExecutionInput(contract,test.input).length) throw new Error('Case input does not match frozen inputSchema');
      for (const assertion of test.expect.assertions || []) if (!assertion.path?.startsWith('/') || !['eq','ne','in','exists','contains'].includes(assertion.op) || !Object.hasOwn(assertion,'value')) throw new Error(JSON.stringify({code:'INVALID_ASSERTION',candidate:contract.name,caseId:test.id,assertion,allowed:['eq','ne','in','exists','contains'],valueRequired:true}));
      if (!test.expect.throws && !(test.expect.assertions || []).some(a=>a.path===contract.outcomePath)) throw new Error('Every returning case must assert its business outcome discriminator');
      const outcomes = (test.expect.assertions || []).filter(assertion=>assertion.path===contract.outcomePath);
      const permitsSuccess = contract.successValues.some(value=>outcomes.every(assertion=>check({value}, {...assertion,path:'/value'})));
      if ((test.covers.includes('failure') && !test.expect.throws && permitsSuccess)
        || (!test.covers.includes('failure') && (test.expect.throws || !permitsSuccess))) {
        throw new Error(JSON.stringify({code:'CONTRACT_CONTRADICTION',candidate:contract.name,caseId:test.id,
          outcomePath:contract.outcomePath,successValues:contract.successValues,coverage:test.covers,expect:test.expect,
          instruction:'Resolve coverage/expected-outcome contradictions before freezing the contract. All trustworthy completed outcomes, including empty/negative outcomes, belong in successValues. A valid empty/negative observation is not an observation failure; an unsuccessful boundary case must explicitly cover failure.'}));
      }
      for (const call of test.calls) if (!['tool','capability','reason'].includes(call.channel) || !call.name || (!call.error && !Object.hasOwn(call,'result'))) throw new Error('Invalid closed-world call fixture');
    }
    for (const [name, schema] of Object.entries(contract.inputSchema.properties || {})) {
      if (schema.type !== 'string' || schema.enum || Object.hasOwn(schema, 'const')) continue;
      const safetyCase = contract.cases.find(test => test.covers.includes('boundary') && typeof test.input[name] === 'string'
        && /\s/.test(test.input[name]) && /['"]/.test(test.input[name]) && /[;|&]/.test(test.input[name]) && test.input[name].includes('$(')
        && test.calls.every(call => call.assertions?.length));
      if (!safetyCase) throw new Error(JSON.stringify({code:'INPUT_BOUNDARY_REQUIRED',candidate:contract.name,field:name,instruction:'Include a boundary case with hostile-looking text as data. Assert requests or reject the input before any dispatch. Read the protocol; no real commands will execute.'}));
    }
    const target = planned.find(c=>c.name===contract.name);
    for (const dependency of target.dependsOn || []) if (!contract.cases.some(c=>c.covers.includes('failure') && c.calls.some(call=>call.channel==='capability' && call.name===dependency && call.error))) throw new Error('Dependency failure case required: '+dependency);
    if (contract.cases.some(c=>c.calls.length) && !coverage.has('empty')) throw new Error('External operation requires empty-result coverage');
    if ((target.dependsOn || []).some(name=>value.withdrawn.some(c=>c.name===name))) throw new Error('Withdraw dependents of withdrawn candidates too');
  }
  return structuredClone(value);
}
function isolated(payload) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('ACCEPTANCE_ISOLATION_UNAVAILABLE'));
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)(deny signal)(deny file-read* (subpath "/Users") (subpath "/var/folders") (subpath "/private/var/folders") (subpath "/tmp") (subpath "/private/tmp"))`;
  return new Promise((resolve,reject)=>{
    const child = spawn('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--max-old-space-size=128','--input-type=module','-e',worker],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','pipe']});
    let output='',error=''; const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
    child.stdout.on('data',chunk=>{output+=chunk; if(output.length>128*1024) child.kill('SIGKILL');});
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});
    child.on('error',reject); child.on('close',code=>{clearTimeout(timer); try { if(code!==0) throw new Error('Isolated worker failed: '+error); resolve(JSON.parse(output)); }catch(e){reject(e);} });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(payload));
  });
}
export async function runAcceptance(candidates, suite) {
  const results=[];
  for (const contract of suite.contracts) if (!candidates.some(candidate => candidate.name === contract.name)) results.push({name:contract.name,passed:false,error:'Frozen contract has no implementation; unchanged reuse must also pass acceptance'});
  for (const candidate of candidates) {
    const contract = suite.contracts.find(c=>c.name===candidate.name);
    if (!contract || canonical(behavioralSchema(candidate.execution.inputSchema))!==canonical(behavioralSchema(contract.inputSchema)) || canonical(behavioralSchema(candidate.execution.outputSchema))!==canonical(behavioralSchema(contract.outputSchema))) {
      results.push({name:candidate.name,passed:false,error:'Implementation schemas differ from frozen contract'}); continue;
    }
    for (const test of contract.cases) {
      let actual;
      try { actual=await isolated({program:candidate.execution.program,test}); }
      catch(error) { actual={harnessFailure:true,error:error.message}; }
      const assertions = (test.expect.assertions || []).map(assertion=>({...assertion,passed:check(actual.output,assertion)}));
      const outputErrors = actual.error ? [] : validateExecutionOutput(candidate.execution,actual.output);
      const falseSuccess = test.covers.includes('failure') && contract.successValues.some(v=>canonical(v)===canonical(pointer(actual.output,contract.outcomePath)));
      const passed = !actual.harnessFailure && !actual.violations?.length && !falseSuccess && actual.remaining===0 && !outputErrors.length && (test.expect.throws ? !!actual.error && !actual.error.startsWith('UNEXPECTED_DISPATCH') && !actual.error.startsWith('REQUEST_ASSERTION') : !actual.error && assertions.every(a=>a.passed));
      results.push({name:candidate.name,caseId:test.id,passed,actual,assertions,outputErrors,falseSuccess});
      if (passed && !test.covers.includes('failure')) for(let index=0;index<test.calls.length;index++) {
        if(test.calls[index].optionalReason?.trim()) continue;
        const faultTest=structuredClone(test); faultTest.calls[index]={...faultTest.calls[index],result:undefined,error:'ACCEPTANCE_INJECTED_DISPATCH_FAILURE'};
        let fault; try {fault=await isolated({program:candidate.execution.program,test:faultTest});} catch(error) {fault={harnessFailure:true,error:error.message};}
        const success=contract.successValues.some(v=>canonical(v)===canonical(pointer(fault.output,contract.outcomePath)));
        results.push({name:candidate.name,caseId:test.id+':injected-failure-'+index,passed:!fault.harnessFailure && !fault.violations?.length && !success && (!!fault.error || !validateExecutionOutput(candidate.execution,fault.output).length),actual:fault});
        // Canonical foreground tool responses can report failure without throwing.
        // This tests the native transport convention, never an incident/command name.
        const response=test.calls[index].result;
        if (response?.kind==='foreground' && Object.hasOwn(response,'exitCode')) {
          const variants = [
            ['tool-response-failure', {exitCode:73, stdout:{...response.stdout,text:''}, stderr:{...response.stderr,text:'ACCEPTANCE_INJECTED_COMMAND_FAILURE'}}],
            ['partial-command-failure', {exitCode:73, stderr:{...response.stderr,text:'ACCEPTANCE_INJECTED_COMMAND_FAILURE'}}],
            ['truncated-output', {stdout:{...response.stdout,truncated:true}}],
            ['timed-out', {timedOut:true,exitCode:null}],
          ];
          for (const [variant, changes] of variants) {
            const failedResponse=structuredClone(test);
            failedResponse.calls[index].result={...response,...changes};
            delete failedResponse.calls[index].error;
            let actual;try {actual=await isolated({program:candidate.execution.program,test:failedResponse});}catch(error){actual={harnessFailure:true,error:error.message};}
            const falseSuccess=contract.successValues.some(v=>canonical(v)===canonical(pointer(actual.output,contract.outcomePath)));
            results.push({name:candidate.name,caseId:test.id+':injected-'+variant+'-'+index,passed:!actual.harnessFailure&&!actual.violations?.length&&!falseSuccess&&(!!actual.error||!validateExecutionOutput(candidate.execution,actual.output).length),actual});
          }
        }

      }

    }
  }
  return {passed:results.every(r=>r.passed),suiteDigest:acceptanceDigest(suite),candidateDigest:acceptanceDigest(candidates),results};
}
