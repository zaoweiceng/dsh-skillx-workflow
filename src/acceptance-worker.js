// Trusted child harness: no business dispatch ever reaches the native runtime.
import { Script, createContext } from 'node:vm';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
// All values and SDK functions are created INSIDE the context; no host callbacks.
const candidate = new Script('(async function(input, tools, capabilities) {\n\"use strict\";\n' + payload.program + '\n})').runInContext(context, { timeout: 1000 });
context.__candidate = candidate;

// Compare literal argv inside shell command boundaries, without running a shell.
function parseShellCommands(source) {
  if(typeof source!=='string') return;
  const commands=[];let words=[],word='',fragment='',fragments=[],literal=true,started=false,quote='',redirect=false,plain=true,assignment=false,bracket=false;
  const flushWord=()=>{if(started) {if(redirect) redirect=false;else words.push({value:word,literal,assignment,fragments:[...fragments,fragment]});}word='';fragment='';fragments=[];literal=true;started=false;plain=true;assignment=false;bracket=false;};
  const flushCommand=()=>{flushWord();if(words.length) commands.push(words);words=[];};
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quote==="'") {if(c==="'") quote='';else {word+=c;fragment+=c;}continue;}
    if(c==='\\' && quote!=="'") {
      const next=source[++i];if(next===undefined) return false;
      if(next==='\n') continue;
      plain=false;
      if(quote==='"' && !['$','`','"','\\'].includes(next)) {word+='\\';fragment+='\\';}
      word+=next;fragment+=next;started=true;continue;
    }
    if(quote && c===quote) {quote='';continue;}
    if(!quote && (c==="'" || c==='"')) {quote=c;plain=false;started=true;continue;}
    if(c==='$' || c==='`') {
      let end=i;
      if(c==='`') {
        for(end=i+1;end<source.length;end++) {if(source[end]==='\\') end++;else if(source[end]==='`') break;}
        if(end>=source.length) return false;
      } else if(source[i+1]==='(' || source[i+1]==='{') {
        const open=source[i+1],close=open==='(' ? ')' : '}';let depth=1,innerQuote='';
        for(end=i+2;end<source.length;end++) {
          const t=source[end];
          if(t==='\\' && innerQuote!=="'") {end++;continue;}
          if(innerQuote) {if(t===innerQuote) innerQuote='';continue;}
          if(t==="'" || t==='"' || t==='`') {innerQuote=t;continue;}
          if(t===open) depth++;else if(t===close && --depth===0) break;
        }
        if(end>=source.length) return false;
      } else {
        const name=source.slice(i+1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/);
        if(!name) {word+=c;fragment+=c;started=true;continue;}
        end=i+name[0].length;
      }
      fragments.push(fragment);fragment='';word+=source.slice(i,end+1);literal=false;plain=false;started=true;i=end;continue;
    }
    if(!quote) {
      if(c==='#' && !started) {while(i<source.length && source[i]!=='\n') i++;flushCommand();continue;}
      if(c===' ' || c==='\t') {flushWord();continue;}
      if(c==='\n' || ';|&(){}'.includes(c)) {flushCommand();continue;}
      if(c==='<' || c==='>') {
        if(source[i+1]==='<' || (c==='<' && source[i+1]==='>')) return false;
        if(started && plain && /^\d+$/.test(word)) {word='';started=false;} else flushWord();
        if(source[i+1]===c) i++;
        if(source[i+1]==='&') i++;
        redirect=true;continue;
      }
      if(c==='=' && plain && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) assignment=true;
      if(c==='[') bracket=true;
      if(c==='*' || c==='?' || (c===']' && bracket)) literal=false;
    }
    word+=c;fragment+=c;started=true;
  }
  if(quote) return false;
  flushCommand();
  if(redirect) return false;
  return commands;
}

function shellEnvironmentIssues(source, depth = 0) {
  if(depth>4) return ['SHELL_NESTING_LIMIT'];
  const commands=parseShellCommands(source);
  if(!commands) return ['UNSUPPORTED_SHELL_SYNTAX'];
  return commands.flatMap(tokens=>tokens.flatMap((token,index)=>{
    const name=token.assignment && token.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if(name && token.fragments.some(part=>new RegExp('\\$'+name+'(?![A-Za-z0-9_])|\\$\\{'+name+'\\}').test(part))) return ['LITERAL_ENV_SELF_REFERENCE:'+name];
    if(token.literal && /^(?:.*\/)?(?:sh|bash|dash|zsh|ksh)$/.test(token.value)) {
      const flag=tokens.findIndex((word,i)=>i>index && word.literal && /^-[a-z]*c[a-z]*$/.test(word.value));
      if(flag>=0 && tokens[flag+1]?.literal) return shellEnvironmentIssues(tokens[flag+1].value,depth+1);
    }
    return [];
  }));
}

function matchShellCommand(source, expected, depth = 0) {
  if(depth>4 || !expected || typeof expected.command!=='string' || !Array.isArray(expected.args)) return false;
  const commands=parseShellCommands(source);
  if(!commands) return false;
  return commands.some(tokens=>{
    let start=0;
    while(start<tokens.length && (tokens[start].assignment || ['if','then','do','else','!'].includes(tokens[start].value))) start++;
    const head=tokens[start];
    if(head?.literal && /^(?:.*\/)?(?:sh|bash|dash|zsh|ksh)$/.test(head.value)) {
      const index=tokens.findIndex((token,index)=>index>start && token.literal && /^-[a-z]*c[a-z]*$/.test(token.value));
      if(index>=0 && tokens[index+1]?.literal && matchShellCommand(tokens[index+1].value,expected,depth+1)) return true;
    }
    if(!head?.literal || head.value!==expected.command) return false;
    let cursor=start+1;
    // The operation stays ahead of positional arguments; leading options may
    // carry a value, e.g. git -C <repo> status.
    if(expected.args.length) {
      while(cursor<tokens.length && tokens[cursor].value!==expected.args[0] && tokens[cursor].value.startsWith('-')) {
        const option=tokens[cursor++].value;
        if(option==='--') break;
        if(!option.includes('=') && cursor<tokens.length && tokens[cursor].value!==expected.args[0] && !tokens[cursor].value.startsWith('-')) cursor++;
      }
      if(!tokens[cursor]?.literal || tokens[cursor].value!==expected.args[0]) return false;
    }
    return expected.args.every(arg=>{
      if(typeof arg!=='string') return false;
      while(cursor<tokens.length && (!tokens[cursor].literal || tokens[cursor].value!==arg)) cursor++;
      return cursor++<tokens.length;
    });
  });
}

function containsShellLiteral(source, value) {
  if(typeof value!=='string' || !value) return false;
  const commands=parseShellCommands(source);
  return !!commands && commands.some(tokens=>tokens.some(token=>token.fragments.some(fragment=>fragment.includes(value))));
}

const setup = `(async()=>{const candidate = globalThis.__candidate; delete globalThis.__candidate;
const payload = ${JSON.stringify(payload)};
const parseShellCommands = ${parseShellCommands.toString()};
const matchShellCommand = ${matchShellCommand.toString()};
const shellEnvironmentIssues = ${shellEnvironmentIssues.toString()};
const containsShellLiteral = ${containsShellLiteral.toString()};
const trace = []; const violations = []; const requestFailures = []; let cursor = 0;
const dispatch = async (channel, request) => {
  trace.push({channel, request});
  if (channel === 'capability' && (!request || !Object.hasOwn(request,'input') || Object.keys(request).some(key=>!['name','input'].includes(key)))) { violations.push('INVALID_REQUEST_ENVELOPE'); throw new Error('INVALID_REQUEST_ENVELOPE: capabilities.run accepts {name,input}'); }
  const mock = payload.test.calls[cursor++];
  if (!mock || mock.channel !== channel || mock.name !== request.name) { violations.push('UNEXPECTED_DISPATCH'); throw new Error('UNEXPECTED_DISPATCH:' + channel + ':' + request.name); }
  if(channel==='tool' && mock.result?.kind==='foreground' && typeof request.arguments?.command==='string') {
    const issues=shellEnvironmentIssues(request.arguments.command);
    if(issues.length) {violations.push(...issues);requestFailures.push({index:cursor-1,channel,name:request.name,path:'/arguments/command',actual:request.arguments.command,issues});throw new Error(issues.join(';'));}
  }
  for (const check of mock.assertions || []) {
    const value = check.path.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')], request);
    if (check.op === 'eq' ? JSON.stringify(value)!==JSON.stringify(check.value) : check.op === 'contains' ? (check.path==='/arguments/command' ? !containsShellLiteral(value,check.value) : !String(value).includes(check.value)) : check.op === 'shell' ? !matchShellCommand(value,check.value) : true) { violations.push('REQUEST_ASSERTION_FAILED'); requestFailures.push({index:cursor-1,channel,name:request.name,path:check.path,op:check.op,expected:check.value,...(value === undefined ? {missing:true} : {actual:value})}); throw new Error('REQUEST_ASSERTION_FAILED:'+check.path); }
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
