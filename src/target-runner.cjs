// Runs inside the selected container. No host paths or libraries are required.
(async()=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
  let data=''; for await(const chunk of process.stdin)data+=chunk;
  const {request:r,target,resource,bootstrap,lossless}=JSON.parse(data);
  if(process.platform!=='linux')throw new Error('TARGET_PLATFORM_UNSUPPORTED');
  let directory, child, timer;
  const env={...process.env};
  for(const [name,value] of Object.entries(r.env ?? {})){if(value===null)delete env[name];else env[name]=String(value);}
  if(r.pathPrefix)env.PATH=r.pathPrefix+path.delimiter+(env.PATH ?? '');
  let executable=r.executable==='@node'?(target.nodeExecutable ?? 'node'):r.executable==='@python'?(target.pythonExecutable ?? 'python3'):r.executable;
  let args=r.args ?? [],stdin=r.stdin ?? '';
  try {
    if (r.cwd) {
      try { if (!(await fs.stat(r.cwd)).isDirectory()) throw new Error('not a directory'); }
      catch (error) {
        throw Object.assign(new Error('Process working directory is unavailable: '+r.cwd),{code:'PROCESS_CWD_UNAVAILABLE',cwd:r.cwd,causeCode:error.code});
      }
    }
    if(resource){
      directory=await fs.mkdtemp(path.join(os.tmpdir(),'skillx-resource-'));
      const paths={};
      for(const [name,body] of Object.entries(resource.files)){
        const location=path.resolve(directory,name);
        if(!location.startsWith(directory+path.sep))throw new Error('RESOURCE_PATH_INVALID');
        await fs.mkdir(path.dirname(location),{recursive:true});await fs.writeFile(location,body);paths[name]=location;
      }
      await fs.writeFile(path.join(directory,'.bootstrap.cjs'),bootstrap);
      await fs.writeFile(path.join(directory,'lossless-json.cjs'),lossless);
      const entry=paths[resource.path];if(!entry)throw new Error('RESOURCE_PATH_MISSING');
      const python=resource.path.endsWith('.py');
      executable=r.executable?executable:python?(target.pythonExecutable ?? 'python3'):(target.nodeExecutable ?? 'node');
      args=r.args!==undefined?[entry,...r.args]:python?[entry]:[path.join(directory,'.bootstrap.cjs'),entry];
      if(r.args===undefined)stdin=JSON.stringify({input:resource.input,context:{resources:paths,nodeExecutable:target.nodeExecutable ?? 'node',pythonExecutable:target.pythonExecutable ?? 'python3',executables:{}}});
    }
    const status=await new Promise((resolve,reject)=>{
      child=spawn(executable,args,{cwd:r.cwd,env,detached:true,stdio:['pipe','inherit','inherit']});
      child.on('error',reject);child.on('exit',(code,signal)=>resolve(code ?? (signal?128:1)));
      child.stdin.on('error',()=>{});child.stdin.end(stdin);
      timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},r.timeoutMs ?? 120000);
    });
    process.exitCode=status;
  } finally {clearTimeout(timer);if(directory)await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{process.stderr.write(JSON.stringify({code:error.code ?? 'TARGET_EXECUTION_FAILED',message:error.message,...(error.cwd?{cwd:error.cwd}:{}),...(error.causeCode?{causeCode:error.causeCode}:{})})+'\n');process.exitCode=1;});
