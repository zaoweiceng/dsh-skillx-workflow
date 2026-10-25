// Shared protocol only. Business logic stays in the versioned resource module.
(async()=>{
  let text='';for await(const chunk of process.stdin) text+=chunk;
  const {input,context}=JSON.parse(text);
  const module=await import(require('node:url').pathToFileURL(process.argv[2]).href);
  const main=typeof module.default==='function'?module.default:module.main ?? module.default?.main;
  if(typeof main!=='function') throw new Error('Bundled JavaScript resource must export an async main(input, context) function');
  const output=await main(input,context);
  require('./lossless-json.cjs').assertLosslessJson(output);
  process.stdout.write(JSON.stringify(output));
})().catch(error=>{
  process.stderr.write(String(error?.message ?? error)+'\n');
  process.stderr.write('[skillx-script-error]'+JSON.stringify({code:error?.code==='SCRIPT_OUTPUT_NOT_JSON'?'SCRIPT_OUTPUT_NOT_JSON':'SCRIPT_PROGRAM_FAILED',errorCode:typeof error?.code==='string'?error.code.slice(0,80):undefined,message:String(error?.message ?? error).split('\n')[0].slice(0,500)})+'\n');
  process.exitCode=1;
});
