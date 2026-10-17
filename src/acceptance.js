import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeExecution, validateExecutionInput, validateExecutionOutput } from './native-contract.js';
const worker = readFileSync(new URL('./acceptance-worker.js', import.meta.url), 'utf8');
export const acceptanceProtocol = {
  purpose: 'Freeze independent behavioral contracts BEFORE implementation. No candidate code is visible to this phase. Historical commands are data, never executed.',
  draftRepair: 'Use upsertContracts:[one contract], finalize:false to save incrementally; include current draftDigest after the first save. Finally submit finalize:true without arrays. On validation failure all issues have candidate/caseId/path. Read __draft__ for current digest/indexes and named contracts for details. Submit draftEdits:[{op:"replace",path:"/contracts/0/cases/7/covers",value:["empty","failure"]}] with draftDigest to repair only that field. add/remove are also supported. Failed drafts are persisted; frozen contracts cannot be changed by the builder.',
  format: { withdrawn: [{name:'planned-name',reason:'Concrete unsupported behavior or absent reuse value; withdraw dependents too'}], contracts: [{ name: 'planned-name', inputSchema: 'DSH object schema; only type, oneOf, properties, required, additionalProperties, items, enum, const, title, description; no minimum/maximum/pattern/$ref', outputSchema: 'DSH schema', outcomePath: '/status', successValues: ['ok'], limitations: 'What simulation cannot establish', cases: [{ id: 'unique', covers: ['success'], input: {}, calls: [{ channel: 'tool|capability|reason', name: 'native name', assertions: [{ path: '/arguments/command', op: 'contains', value: 'expected operation' }], optionalReason: 'Only for observations whose loss does not invalidate the advertised success; concrete independent fallback required', result: 'canonical native JSON OR error string', error: 'optional thrown dispatch failure' }], expect: { throws: false, assertions: [{ path: '/status', op: 'eq', value: 'ok' }] } }] }] },
  rules: 'Prefer 4..8 concise cases per candidate: combine coverage tags and string boundary inputs within one meaningful case; do not create a case per optional field or repeat the same successful command transcript. The host injects representative thrown errors, command failure, timeout and truncation automatically once per dispatch channel/name and fault type, not per call in every case. Every contract needs success, defaults (all optional root inputs omitted), failure and boundary cases; tool/dependency operations also need empty and failure response cases per candidate. Empty unavailable responses may fail or throw and MUST carry both empty and failure tags; never manufacture a completed empty outcome to satisfy coverage. Each declared dependency needs a thrown-error case. Calls are ordered closed-world mocks; all must be consumed. Allowed coverage tags are success/defaults/empty/failure/boundary. failure means an unavailable/failed observation or dependency, not a valid negative/empty business result. Never require a declared successful outcome in a failure case. Request assertions target SDK envelopes: tool arguments are under /arguments, capability arguments under /input (for example /input/repo); never flatten business inputs onto the request root. Mock results must be actual JSON values, not JSON-encoded strings when the native schema requires an object or array. Expected-output assertions use JSON pointers and eq/ne/in/exists/contains, always with a value. Request assertions inside calls support only eq/contains. successValues MUST include ALL trustworthy completed outcomes, including valid empty/negative/not-found outcomes, not only a status spelled success/ok. Never include unknown, failed or pending outcomes. Every non-failure returning case must assert one of these completed outcomes; tag a deliberately unsuccessful boundary case failure too. For every unconstrained root string input, include a boundary case containing whitespace, quotes, shell metacharacters and command substitution syntax (for example a value containing a space, apostrophe, semicolon and $(...)). Treat caller strings as data: POSIX double quotes still expand dollar expressions and backticks; request assertions must preserve argument literals using safe escaping. Safely quote/encode or reject before dispatch; never interpolate unchecked input into shell syntax. Requests in that case must be asserted, or no calls allowed when rejecting the input. Reject incomplete/truncated observations instead of drawing definitive conclusions. Preserve resource/session/transaction lifetimes across tool calls. Unless a native contract explicitly promises persistence, separate shell calls are independent: a PID or other call-scoped handle obtained from a completed call is not a valid persistent caller identity. A capability invocation is not a shared native tool session: each tools.call is independent even within the same capability invocation. Mock internal consistency cannot establish persistence, and a request is not evidence of successful behavior. Defaults must be derived from stable supplied inputs or context whose lifetime is guaranteed; otherwise require explicit input, collect all needed observations atomically while the resource exists, or withdraw unsupported behavior. Do not create mocks that resurrect expired resources or assume shared execution context. No external permission change or privilege escalation is an implementation repair. Failure cases may throw or return non-success. Simulated native command results do NOT verify embedded scripts: omit candidates whose essential executable behavior cannot be tested by this runner (e.g. generated Python/shell daemons), and omit their dependent candidates. Do not invent passing fixtures to force extraction. Tests must assert business evidence, not only a success flag. Include realistic canonical results and command nonzero/permission errors, domain empty and negative states when relevant; derive from the contract, not a fixed incident checklist.',
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
/** Collect independent issues in one pass; invalid branches do not hide other candidates. */
export function acceptanceIssues(value, planned, { toolContracts, capabilitySchemas = new Map() } = {}) {
  const issues = [];
  const issue = (code, path, message, context = {}) => issues.push({ code, path, message, ...context });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue('INVALID_SUITE', '/', 'Supply an object with contracts and withdrawn arrays'); return issues;
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    issue('INVALID_SUITE', '/', 'Acceptance suite exceeds 256 KiB'); return issues;
  }
  const contracts=Array.isArray(value.contracts) ? value.contracts : [];
  const withdrawn=Array.isArray(value.withdrawn) ? value.withdrawn : [];
  if (!Array.isArray(value.contracts)) issue('INVALID_SUITE','/contracts','Supply contracts as an array');
  if (!Array.isArray(value.withdrawn)) issue('INVALID_SUITE','/withdrawn','Supply withdrawn as an array');
  const names = [...contracts.map(c => c?.name), ...withdrawn.map(c => c?.name)];
  if (Array.isArray(value.contracts) && Array.isArray(value.withdrawn) && (new Set(names).size !== names.length || canonical([...names].sort()) !== canonical(planned.map(c => c.name).sort()))) {
    issue('CONTRACT_COVERAGE_MISMATCH', '/', 'Supply exactly one contract or withdrawal per planned candidate', { expectedNames: planned.map(c => c.name), providedNames: names });
  }
  withdrawn.forEach((item, i) => { if (typeof item?.reason !== 'string' || !item.reason.trim()) issue('WITHDRAWAL_REASON_REQUIRED', `/withdrawn/${i}/reason`, 'Withdrawal requires a reason', { candidate: item?.name }); });
  contracts.forEach((contract, i) => {
    const root = `/contracts/${i}`;
    const add = (code, path, message, extra = {}) => issue(code, root + path, message, { candidate: contract?.name, ...extra });
    if (!contract || typeof contract !== 'object') { add('INVALID_CONTRACT', '', 'Expected a contract object'); return; }
    let schemasValid = true;
    for (const field of ['inputSchema','outputSchema']) {
      try { normalizeExecution({ language:'typescript', inputSchema:field === 'inputSchema' ? contract.inputSchema : {type:'object'}, outputSchema:field === 'outputSchema' ? contract.outputSchema : {type:'object'}, program:'return null;' }); }
      catch (error) { if (field === 'inputSchema') schemasValid = false; add('INVALID_SCHEMA', '/' + field, error.message); }
    }
    const outcomeValid = typeof contract.outcomePath === 'string' && contract.outcomePath.startsWith('/') && Array.isArray(contract.successValues) && contract.successValues.length > 0;
    if (!outcomeValid) add('INVALID_OUTCOME', '/outcomePath', 'Require a JSON pointer and nonempty successValues containing only trustworthy completed outcomes');
    if (typeof contract.limitations !== 'string' || !contract.limitations.trim()) add('LIMITATIONS_REQUIRED', '/limitations', 'Explain what simulation cannot establish');
    if (!Array.isArray(contract.cases)) { add('INVALID_CASES', '/cases', 'Supply 4..40 cases'); return; }
    if (contract.cases.length < 4 || contract.cases.length > 40) add('INVALID_CASE_COUNT', '/cases', 'Supply 4..40 cases');
    const cases = contract.cases.filter(test => test && typeof test === 'object');
    const coverage = new Set(cases.flatMap(test => Array.isArray(test.covers) ? test.covers : []));
    for (const tag of ['success', 'defaults', 'failure', 'boundary']) if (!coverage.has(tag)) add('MISSING_COVERAGE', '/cases', 'Missing coverage: ' + tag, { missingTag: tag });
    const optional = Object.keys(contract.inputSchema?.properties || {}).filter(k => !(Array.isArray(contract.inputSchema.required) ? contract.inputSchema.required : []).includes(k));
    if (!cases.some(test => Array.isArray(test.covers) && test.covers.includes('defaults') && test.input && optional.every(k => !Object.hasOwn(test.input, k)))) add('DEFAULTS_REQUIRED', '/cases', 'Defaults case must omit all optional root inputs', { optionalFields: optional });
    if (new Set(cases.map(test => test.id)).size !== cases.length) add('DUPLICATE_CASE_ID', '/cases', 'Case IDs must be unique');
    contract.cases.forEach((test, j) => {
      const path = `/cases/${j}`;
      const err = (code, suffix, message, extra = {}) => add(code, path + suffix, message, { caseId: test?.id, ...extra });
      if (!test || typeof test !== 'object') { err('INVALID_CASE', '', 'Expected a case object'); return; }
      const tags = Array.isArray(test.covers) ? test.covers : [];
      if (!tags.length || tags.some(tag => !['success','defaults','empty','failure','boundary'].includes(tag))) err('INVALID_COVERAGE', '/covers', 'Use success/defaults/empty/failure/boundary tags');
      if (!test.id || !Array.isArray(test.calls) || !test.expect || typeof test.expect !== 'object') { err('INVALID_CASE', '', 'Require id, calls array and expect object'); return; }
      if (schemasValid) {
        try { const errors = validateExecutionInput(contract, test.input); if (errors.length) err('CASE_INPUT_MISMATCH', '/input', 'Case input does not match frozen inputSchema', { errors }); }
        catch (error) { err('CASE_INPUT_MISMATCH', '/input', error.message); }
      }
      const assertions = Array.isArray(test.expect.assertions) ? test.expect.assertions : [];
      if (!test.expect.throws && !assertions.length) err('ASSERTIONS_REQUIRED', '/expect/assertions', 'Returning cases require meaningful assertions');
      assertions.forEach((assertion, k) => {
        if (!assertion || typeof assertion.path !== 'string' || !assertion.path.startsWith('/') || !['eq','ne','in','exists','contains'].includes(assertion.op) || !Object.hasOwn(assertion, 'value')) err('INVALID_ASSERTION', `/expect/assertions/${k}`, 'Use JSON pointer, eq/ne/in/exists/contains and an explicit value');
      });
      const outcomes = assertions.filter(a => a?.path === contract.outcomePath);
      if (!test.expect.throws && !outcomes.length) err('OUTCOME_ASSERTION_REQUIRED', '/expect/assertions', 'Assert the business outcome discriminator');
      if (outcomeValid && (test.expect.throws || outcomes.length)) {
        const permitsSuccess = contract.successValues.some(value => outcomes.every(assertion => check({ value }, { ...assertion, path: '/value' })));
        if ((tags.includes('failure') && !test.expect.throws && permitsSuccess) || (!tags.includes('failure') && (test.expect.throws || !permitsSuccess))) err('CONTRACT_CONTRADICTION', '/expect', 'Failure cases must throw or return a non-success outcome; unsuccessful empty/boundary cases also need failure. Do not change business meaning merely to pass coverage.', { outcomePath: contract.outcomePath, successValues: contract.successValues, coverage: tags, expect: test.expect });
      }
      test.calls.forEach((call, k) => {
        const cp = `/calls/${k}`;
        if (!call || !['tool','capability','reason'].includes(call.channel) || !call.name || (!call.error && !Object.hasOwn(call, 'result'))) { err('INVALID_MOCK', cp, 'Require channel, name and canonical result or thrown error'); return; }
        if (call.assertions !== undefined && !Array.isArray(call.assertions)) err('INVALID_REQUEST_ASSERTION', cp + '/assertions', 'Request assertions must be an array');
        else (call.assertions || []).forEach((a, n) => {
          if (!a || typeof a.path !== 'string' || !a.path.startsWith('/') || !['eq','contains'].includes(a.op) || !Object.hasOwn(a,'value')) { err('INVALID_REQUEST_ASSERTION', `${cp}/assertions/${n}`, 'Request assertions support JSON pointers and eq/contains with a value'); return; }
          const roots = call.channel === 'capability' ? ['name','input'] : call.channel === 'tool' ? ['name','arguments'] : ['name','prompt','outputSchema'];
          const root = a.path.split('/')[1];
          if (!roots.includes(root)) err('REQUEST_ASSERTION_PATH', `${cp}/assertions/${n}/path`, 'Assertion targets the SDK request envelope, not its flattened business input', {channel:call.channel,actualPath:a.path,allowedRoots:roots,suggestedPath:call.channel === 'capability' ? '/input'+a.path : call.channel === 'tool' ? '/arguments'+a.path : undefined});
        });
        if (call.channel === 'tool' && toolContracts && !toolContracts.has(call.name)) err('TOOL_CONTRACT_REQUIRED', cp, 'Read exact native tool contract before mocking: ' + call.name, { tool: call.name });
        if (call.error) return;
        const schema = call.channel === 'tool' ? toolContracts?.get(call.name) : call.channel === 'capability' ? (contracts.find(c => c?.name === call.name)?.outputSchema || capabilitySchemas.get(call.name)) : undefined;
        if (schema) {
          try { const errors = validateExecutionOutput({ outputSchema: schema }, call.result); if (errors.length) err('MOCK_SCHEMA_MISMATCH', cp + '/result', 'Mock result must match the exact native tool/dependency output schema', { tool: call.name, errors }); }
          catch (error) { err('MOCK_SCHEMA_MISMATCH', cp + '/result', error.message, { tool: call.name }); }
        }
      });
    });
    for (const [name, schema] of Object.entries(contract.inputSchema?.properties || {})) {
      if (schema?.type !== 'string' || schema.enum || Object.hasOwn(schema, 'const')) continue;
      const safetyCase = cases.find(test => Array.isArray(test.covers) && test.covers.includes('boundary') && typeof test.input?.[name] === 'string' && /\s/.test(test.input[name]) && /['"]/.test(test.input[name]) && /[;|&]/.test(test.input[name]) && test.input[name].includes('$(') && Array.isArray(test.calls) && test.calls.every(call => Array.isArray(call?.assertions) && call.assertions.length));
      if (!safetyCase) add('INPUT_BOUNDARY_REQUIRED', '/cases', 'Cover this field with whitespace, quotes, shell metacharacters AND $(...) as data. Assert every dispatched request, or reject before dispatch.', { field: name });
    }
    const target = planned.find(c => c.name === contract.name);
    for (const dependency of target?.dependsOn || []) if (!cases.some(test => Array.isArray(test.covers) && test.covers.includes('failure') && (Array.isArray(test.calls) ? test.calls : []).some(call => call?.channel === 'capability' && call.name === dependency && call.error))) add('DEPENDENCY_FAILURE_REQUIRED', '/cases', 'Include a thrown-error case for dependency: ' + dependency, { dependency });
    if (cases.some(test => Array.isArray(test.calls) && test.calls.length) && !coverage.has('empty')) add('EMPTY_COVERAGE_REQUIRED', '/cases', 'This candidate needs an empty-response case tagged empty. An unavailable empty response may throw or fail: tag it ["empty","failure"]. Do not invent a successful empty outcome or weaken schemas.', { missingTag: 'empty' });
    if ((target?.dependsOn || []).some(name => withdrawn.some(c => c?.name === name))) add('WITHDRAW_DEPENDENT', '', 'Withdraw dependents of withdrawn candidates too');
  });
  return issues;
}

export function validateAcceptance(value, planned, options) {
  const issues = acceptanceIssues(value, planned, options);
  if (issues.length) {
    const error = new Error(JSON.stringify({ code: 'ACCEPTANCE_VALIDATION_FAILED', issues, instruction: 'Repair all listed locations using draftEdits with the current draftDigest. Untouched contracts and cases are retained. Read __diagnostics__ for the complete saved report.' }));
    error.code = 'ACCEPTANCE_VALIDATION_FAILED'; error.issues = issues; throw error;
  }
  return structuredClone(value);
}

function isolated(payload, signal) {
  signal?.throwIfAborted();
  if (process.platform !== 'darwin') return Promise.reject(new Error('ACCEPTANCE_ISOLATION_UNAVAILABLE'));
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)(deny signal)(deny file-read* (subpath "/Users") (subpath "/var/folders") (subpath "/private/var/folders") (subpath "/tmp") (subpath "/private/tmp"))`;
  return new Promise((resolve,reject)=>{
    const child = spawn('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--max-old-space-size=128','--input-type=module','-e',worker],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','pipe']});
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once:true });
    if (signal?.aborted) abort();
    let output='',error=''; const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
    child.stdout.on('data',chunk=>{output+=chunk; if(output.length>128*1024) child.kill('SIGKILL');});
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});
    child.on('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);}); child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort); try { if(code!==0) throw new Error('Isolated worker failed: '+error); resolve(JSON.parse(output)); }catch(e){reject(e);} });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(payload));
  });
}
function callEvidence(test, index, injection) {
  const call = test.calls[index];
  return call && {origin:'acceptance-mock',index,...(injection ? {injection} : {}),channel:call.channel,name:call.name,result:call.result,error:call.error};
}
export async function runAcceptance(candidates, suite, { signal } = {}) {
  signal?.throwIfAborted();
  const results=[];
  for (const contract of suite.contracts) if (!candidates.some(candidate => candidate.name === contract.name)) results.push({name:contract.name,passed:false,error:'Frozen contract has no implementation; unchanged reuse must also pass acceptance'});
  for (const candidate of candidates) {
    const contract = suite.contracts.find(c=>c.name===candidate.name);
    if (!contract || canonical(behavioralSchema(candidate.execution.inputSchema))!==canonical(behavioralSchema(contract.inputSchema)) || canonical(behavioralSchema(candidate.execution.outputSchema))!==canonical(behavioralSchema(contract.outputSchema))) {
      results.push({name:candidate.name,passed:false,error:'Implementation schemas differ from frozen contract'}); continue;
    }
    const injected = new Set();
    const faultExpectation = { outcomePath:contract.outcomePath, excludedValues:contract.successValues,
      allowThrow:true, returnedOutputMustMatchSchema:true,
      instruction:'This injected response is unavailable evidence. Throw or return a schema-valid unsuccessful outcome; never report a completed outcome from excludedValues.' };
    for (const test of contract.cases) {
      signal?.throwIfAborted();
      let actual;
      try { actual=await isolated({program:candidate.execution.program,test}, signal); }
      catch(error) { actual={harnessFailure:true,error:error.message}; }
      signal?.throwIfAborted();
      const assertions = (test.expect.assertions || []).map(assertion=>({...assertion,passed:check(actual.output,assertion)}));
      const outputErrors = actual.error ? [] : validateExecutionOutput(candidate.execution,actual.output);
      const falseSuccess = test.covers.includes('failure') && contract.successValues.some(v=>canonical(v)===canonical(pointer(actual.output,contract.outcomePath)));
      const passed = !actual.harnessFailure && !actual.violations?.length && !falseSuccess && actual.remaining===0 && !outputErrors.length && (test.expect.throws ? !!actual.error && !actual.error.startsWith('UNEXPECTED_DISPATCH') && !actual.error.startsWith('REQUEST_ASSERTION') : !actual.error && assertions.every(a=>a.passed));
      results.push({name:candidate.name,caseId:test.id,passed,actual,assertions,outputErrors,falseSuccess,...(!passed ? {callEvidence:callEvidence(test,(actual.trace?.length || 0)-1)} : {})});
      if (passed && !test.covers.includes('failure')) for(let index=0;index<test.calls.length;index++) {
        signal?.throwIfAborted();
        if(test.calls[index].optionalReason?.trim()) continue;
        const key=test.calls[index].channel+':'+test.calls[index].name;
        if (!injected.has(key+':throw')) {
        injected.add(key+':throw');
        const faultTest=structuredClone(test); faultTest.calls[index]={...faultTest.calls[index],result:undefined,error:'ACCEPTANCE_INJECTED_DISPATCH_FAILURE'};
        let fault; try {fault=await isolated({program:candidate.execution.program,test:faultTest}, signal);} catch(error) {fault={harnessFailure:true,error:error.message};}
        const success=contract.successValues.some(v=>canonical(v)===canonical(pointer(fault.output,contract.outcomePath)));
        results.push({name:candidate.name,caseId:test.id+':injected-failure-'+index,passed:!fault.harnessFailure && !fault.violations?.length && !success && (!!fault.error || !validateExecutionOutput(candidate.execution,fault.output).length),actual:fault,falseSuccess:success,expected:faultExpectation,callEvidence:callEvidence(faultTest,index,'failure')});
        }
        // Canonical foreground tool responses can report failure without throwing.
        // This tests the native transport convention, never an incident/command name.
        const response=test.calls[index].result;
        if (response?.kind==='foreground' && Object.hasOwn(response,'exitCode')) {
          const variants = [
            ['tool-response-failure', {exitCode:73, stderr:{...response.stderr,text:'ACCEPTANCE_INJECTED_COMMAND_FAILURE'}}],
            ['truncated-output', {stdout:{...response.stdout,truncated:true}}],
            ['timed-out', {timedOut:true,exitCode:null}],
          ];
          for (const [variant, changes] of variants) {
            if (injected.has(key+':'+variant)) continue;
            injected.add(key+':'+variant);
            signal?.throwIfAborted();
            const failedResponse=structuredClone(test);
            failedResponse.calls[index].result={...response,...changes};
            delete failedResponse.calls[index].error;
            let actual;try {actual=await isolated({program:candidate.execution.program,test:failedResponse}, signal);}catch(error){actual={harnessFailure:true,error:error.message};}
            const falseSuccess=contract.successValues.some(v=>canonical(v)===canonical(pointer(actual.output,contract.outcomePath)));
            results.push({name:candidate.name,caseId:test.id+':injected-'+variant+'-'+index,passed:!actual.harnessFailure&&!actual.violations?.length&&!falseSuccess&&(!!actual.error||!validateExecutionOutput(candidate.execution,actual.output).length),actual,falseSuccess,expected:faultExpectation,callEvidence:callEvidence(failedResponse,index,variant)});
          }
        }

      }

    }
  }
  signal?.throwIfAborted();
  return {policy:'representative-faults-v1',passed:results.every(r=>r.passed),suiteDigest:acceptanceDigest(suite),candidateDigest:acceptanceDigest(candidates),results};
}
