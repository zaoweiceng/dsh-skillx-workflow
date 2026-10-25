import { readFileSync } from 'node:fs';

export const targetSchema = {type:'object',title:'执行目标',description:'所有子能力继承此 Linux 容器目标；业务进程、文件及依赖操作均在指定运行中容器内。宿主只运行编排与 Docker 客户端。',properties:{container:{type:'string',title:'容器名或 ID'},dockerExecutable:{type:'string',title:'宿主 Docker 客户端',description:'可选，默认 docker；明确路径仅用于宿主客户端。'},nodeExecutable:{type:'string',title:'容器 Node',description:'可选，默认 node；资源运输需要容器内 Node。'},pythonExecutable:{type:'string',title:'容器 Python',description:'可选，默认 python3。'}},required:['container'],additionalProperties:false};
export function bindExecutionTarget(execution, target) {
  if (target !== 'docker') return execution;
  return {...execution,target:'docker',inputSchema:{...execution.inputSchema,properties:{...execution.inputSchema.properties,executionTarget:targetSchema},required:[...new Set([...(execution.inputSchema.required ?? []),'executionTarget'])]}};
}
export function resolveExecutionTarget(execution, input) {
  if (execution.target !== 'docker') return undefined;
  const target=input?.executionTarget;
  if(!target || typeof target.container!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.container)) throw Object.assign(new Error('A running container identifier is required'),{code:'EXECUTION_TARGET_REQUIRED'});
  for(const key of ['dockerExecutable','nodeExecutable','pythonExecutable']) if(target[key]!==undefined && (typeof target[key]!=='string'||!target[key]||target[key].includes('\0'))) throw Object.assign(new Error('Invalid target executable'),{code:'EXECUTION_TARGET_INVALID'});
  return {...target};
}
const runner=readFileSync(new URL('./target-runner.cjs',import.meta.url),'utf8');
const bootstrap=readFileSync(new URL('./script-bootstrap.cjs',import.meta.url),'utf8');
const lossless=readFileSync(new URL('./lossless-json.cjs',import.meta.url),'utf8');
export function targetProcess(target, request, resource) {
  if (!target) return request;
  const payload={request,target,...(resource?{resource,bootstrap,lossless}:{})};
  return {executable:target.dockerExecutable ?? 'docker',args:['exec','-i',target.container,target.nodeExecutable ?? 'node','-e',runner],stdin:JSON.stringify(payload),timeoutMs:request.timeoutMs ?? 120000};
}
