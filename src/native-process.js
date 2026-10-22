import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolve, delimiter } from 'node:path';
import { parse } from 'acorn';

export const PROCESS_TOOL = 'capability_process';
export const processSdkGuide = 'processes.run accepts {executable:string,args?:string[],cwd?:string,stdin?:string,env?:Record<string,string|null>,inheritEnv?:string[],pathPrefix?:string,timeoutMs?:integer}. inheritEnv is an explicit array of evidenced environment variable NAMES, never true/false; omit it or use [] if none are needed. Do not pass secret values as arguments. executable:"@node" and "@python" resolve configured runtimes. Missing executable resolution may throw before a process result exists; handle only evidenced fallback conditions, not just exitCode 127. The top-level JavaScript body has input, tools, capabilities, resources, processes, but NO context variable. Only a Node script resource main(input,context) receives context. resources.run uses the same inheritEnv array convention. Use read_native_tool name=capability_process for its exact native contract.';

// Reject provably invalid literal SDK calls during authoring, without running
// the candidate. Dynamic argument expressions remain runtime-validated.
export function assertProcessSdkArguments(program) {
  const issues = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && ['processes','resources'].includes(node.callee?.object?.name) && (node.callee.property?.name ?? node.callee.property?.value) === 'run') {
      const argument = node.arguments[0];
      const value = argument?.type === 'ObjectExpression' && argument.properties.find(property => (property.key?.name ?? property.key?.value) === 'inheritEnv')?.value;
      if (value && (['Literal','ObjectExpression','TemplateLiteral'].includes(value.type) || (value.type === 'ArrayExpression' && value.elements.some(item => !item || (item.type === 'Literal' && typeof item.value !== 'string'))))) {
        issues.push({code:'INVALID_PROCESS_ARGUMENT',path:'/program',field:'inheritEnv',message:'processes.run/resources.run inheritEnv must be an array of environment variable names, never a boolean or other literal type'});
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse('(async function(input,tools,capabilities,resources,processes){\n' + program + '\n})',{ecmaVersion:'latest'}));
  if (issues.length) throw Object.assign(new Error('Invalid process SDK arguments'),{code:'INVALID_PROCESS_ARGUMENT',issues});
}
export function registerNativeProcess(ctx, {nodeExecutable=process.execPath, pythonExecutable='python3', executables={}}={}) {
  const get = name => ctx.get?.(name) ?? ctx[name];
  return ctx.tools.register(defineTool({
    name:PROCESS_TOOL,
    description:'Run one executable with a literal argument array under the current native sandbox. No shell interpretation or command string. Used internally by SkillX. Missing executable/configuration must be clarified with the user, never searched broadly.',
    parameters:{
      executable:{type:'string',required:true}, args:{type:'array',items:{type:'string'}}, cwd:{type:'string'},
      stdin:{type:'string'}, env:{type:'json'}, inheritEnv:{type:'array',items:{type:'string'}},
      pathPrefix:{type:'string'}, timeoutMs:{type:'integer'},
    },
    output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    isConcurrencySafe:()=>false,
    execute:async (request,exec)=>{
      const runtime=get('subprocess'); const policyService=get('sandboxPolicy'); const sandbox=get('sandbox');
      if (!runtime?.spawn || !runtime?.resolveExecutable || !policyService?.resolve) throw new Error('Native subprocess runtime is unavailable');
      const policy=policyService.resolve(exec.agent ? {session:exec.agent.session} : {});
      const cwd=resolve(policy.workspaceRoot,request.cwd ?? '.');
      let executable=request.executable; let args=request.args ?? [];
      if (!executable || executable.includes('\0') || !Array.isArray(args) || args.some(arg=>typeof arg!=='string'||arg.includes('\0')) || args.length>10000) throw new Error('Invalid literal executable/argument array');
      const launcher=executables[executable];
      if (launcher) { args=[...(launcher.args ?? []),...args];executable=launcher.runtime==='node'?nodeExecutable:launcher.executable; }
      if (executable==='@node') executable=nodeExecutable;
      if (executable==='@python') executable=pythonExecutable;
      if (!executable) throw Object.assign(new Error('EXECUTABLE_REQUIRED: ask the user to configure the executable'),{code:'EXECUTABLE_REQUIRED'});
      if (/\.(?:cmd|bat)$/i.test(executable)) throw new Error('CLI_LAUNCHER_REQUIRED: configure the CLI JavaScript entry and Node runtime; shell launchers are not executed');
      if (/\.(?:cjs|mjs|js)$/i.test(executable)) {args=[executable,...args];executable=nodeExecutable;}
      const timeoutMs=request.timeoutMs ?? 120000;
      if (!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000) throw new Error('Invalid process timeout');
      const env={};
      for(const name of request.inheritEnv ?? []) {
        if(typeof name!=='string'||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(name)||/^DSH_/i.test(name)) throw new Error('Invalid inherited environment name');
        if(process.env[name]!==undefined) env[name]=process.env[name];
      }
      if(request.env!==undefined && (!request.env || typeof request.env!=='object'||Array.isArray(request.env))) throw new Error('Invalid process environment');
      for(const [name,value] of Object.entries(request.env ?? {})) {
        if(!/^[_A-Za-z][_A-Za-z0-9]*$/.test(name)||/^DSH_/i.test(name)||(value!==null&&typeof value!=='string')||value?.includes('\0')) throw new Error('Invalid process environment entry');
        env[name]=value===null?undefined:value;
      }
      if(request.pathPrefix) {
        if(typeof request.pathPrefix!=='string'||request.pathPrefix.includes('\0')) throw new Error('Invalid PATH prefix');
        const pathKey=Object.keys(process.env).find(key=>key.toUpperCase()==='PATH') ?? 'PATH';
        env[pathKey]=request.pathPrefix+delimiter+(env[pathKey] ?? process.env[pathKey] ?? '');
      }
      const controller=new AbortController(); const signal=AbortSignal.any([exec.signal,controller.signal]);
      let timedOut=false; const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);timer.unref?.();
      let handle;
      try {
        signal.throwIfAborted();
        try { executable=await runtime.resolveExecutable(executable,env,signal); }
        catch(error) { if(error.code==='ENOENT') throw Object.assign(new Error('EXECUTABLE_REQUIRED: configured executable is unavailable'),{code:'EXECUTABLE_REQUIRED',cause:error}); throw error; }
        if(!executable) throw Object.assign(new Error('EXECUTABLE_REQUIRED: ask the user for the installed executable or configured CLI entry'),{code:'EXECUTABLE_REQUIRED'});
        if(/\.(?:cmd|bat)$/i.test(executable)) throw new Error('CLI_LAUNCHER_REQUIRED: ask for the installed CLI JavaScript entry; no shell fallback');
        let confined;
        try {
          if(policy.mode!=='danger-full-access') {
            if(!sandbox?.confine) throw new Error('Native sandbox is unavailable');
            confined=await sandbox.confine([executable,...args],policy,signal);
          }
        } catch(error) {
          return {kind:'foreground',exitCode:null,signal:null,timedOut:false,aborted:exec.signal.aborted,stdout:{text:'',truncated:false},stderr:{text:String(error.message),truncated:false},sandbox:{mode:policy.mode,denied:true,unavailable:true}};
        }
        signal.throwIfAborted();
        handle=runtime.spawn({argv:confined?.argv ?? [executable,...args],cwd,env,stdio:{stdin:request.stdin===undefined?'ignore':{data:request.stdin},stdout:{maxBytes:1048576},stderr:{maxBytes:65536}},graceMs:1000,signal});
        const outcome=await handle.done;
        const collect=reader=>{const value=reader?.readFrom(0);return {text:value?.text ?? '',truncated:value?.lossy===true};};
        const stdout=collect(handle.collected.stdout),stderr=collect(handle.collected.stderr);
        const denied=outcome.exitCode!==0 && !!confined?.denialSignatures?.some(signature=>stderr.text.toLowerCase().includes(signature.toLowerCase()));
        return {kind:'foreground',exitCode:outcome.exitCode ?? null,signal:outcome.signal ?? null,timedOut,aborted:exec.signal.aborted,stdout,stderr,sandbox:{mode:policy.mode,...(confined?.enforcement !== undefined ? {enforcement:confined.enforcement} : {}),denied}};
      } finally {clearTimeout(timer);if(handle){handle.terminate();await handle.waitForExit();}}
    },
  }));
}
