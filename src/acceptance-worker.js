// Trusted child harness: no business dispatch ever reaches the native runtime.
import { Script, createContext } from 'node:vm';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
// All values and SDK functions are created INSIDE the context; no host callbacks.
const candidate = new Script('(async function(input, tools, capabilities) {\n\"use strict\";\n' + payload.program + '\n})').runInContext(context, { timeout: 1000 });
context.__candidate = candidate;
const setup = `(async()=>{const candidate = globalThis.__candidate; delete globalThis.__candidate;
const payload = ${JSON.stringify(payload)};
const trace = []; const violations = []; const requestFailures = []; let cursor = 0;
const dispatch = async (channel, request) => {
  trace.push({channel, request});
  if (channel === 'capability' && (!request || !Object.hasOwn(request,'input') || Object.keys(request).some(key=>!['name','input'].includes(key)))) { violations.push('INVALID_REQUEST_ENVELOPE'); throw new Error('INVALID_REQUEST_ENVELOPE: capabilities.run accepts {name,input}'); }
  const mock = payload.test.calls[cursor++];
  if (!mock || mock.channel !== channel || mock.name !== request.name) { violations.push('UNEXPECTED_DISPATCH'); throw new Error('UNEXPECTED_DISPATCH:' + channel + ':' + request.name); }
  for (const check of mock.assertions || []) {
    const value = check.path.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')], request);
    if (check.op === 'eq' ? JSON.stringify(value)!==JSON.stringify(check.value) : check.op === 'contains' ? !String(value).includes(check.value) : true) { violations.push('REQUEST_ASSERTION_FAILED'); requestFailures.push({index:cursor-1,channel,name:request.name,path:check.path,op:check.op,expected:check.value,...(value === undefined ? {missing:true} : {actual:value})}); throw new Error('REQUEST_ASSERTION_FAILED:'+check.path); }
  }
  if (mock.error) throw new Error(mock.error);
  return JSON.parse(JSON.stringify(mock.result));
};
const input = payload.test.input;
const tools = {call: request => dispatch('tool', request)};
const capabilities = {run: request => dispatch('capability',request), reason: request => dispatch('reason', {...request,name:'reason'})};
try { const output = await candidate(input, tools, capabilities); return JSON.stringify({output,trace,violations,requestFailures,remaining:payload.test.calls.length-cursor}); }
catch(error){ return JSON.stringify({error:String(error.message),trace,violations,requestFailures,remaining:payload.test.calls.length-cursor}); }})()`;
try {
  const result = await new Script(setup).runInContext(context, { timeout: 1000 });
  process.stdout.write(result);
} catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message), harnessFailure: true })); }
