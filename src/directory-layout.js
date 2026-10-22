import { mkdir, open, readFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resourceManifest } from './native-resources.js';
export const entryName=entry=>entry.execution?.language==='python'?'entry.py':'entry.js';
export async function writeDirectory(directory,entry,{record=true}={}) {
 const files={'SKILL.md':entry.content,...entry.resources,...entry.docs};
 if(entry.execution)files[entryName(entry)]=entry.execution.program;
 const manifest={format:'skillx-directory-v1',name:entry.name,kind:entry.kind,description:entry.description,version:entry.version,revisionId:entry.revisionId,enabled:entry.enabled,
  ...(entry.execution?{entry:{file:entryName(entry),runtime:entry.execution.language==='python'?'python':'javascript',convention:entry.execution.language==='python'?'json-stdin':'async-function-body'},inputSchema:entry.execution.inputSchema,outputSchema:entry.execution.outputSchema}:{}),
  dependencies:entry.dependencies??[],...(entry.dependencyRevisions?{dependencyRevisions:entry.dependencyRevisions}:{}),compatibility:entry.compatibility,files:resourceManifest(files)};
 files['manifest.json']=JSON.stringify(manifest,null,2)+'\n';
 if(record)files['.record.json']=JSON.stringify(entry,null,2);
 await mkdir(directory,{recursive:true});
 if((await lstat(directory)).isSymbolicLink())throw new Error('Symlink revision directory is forbidden');
 for(const [path,content]of Object.entries(files)){
  const parts=path.split('/');let parent=directory;
  for(const part of parts.slice(0,-1)){parent=join(parent,part);await mkdir(parent,{recursive:true});if((await lstat(parent)).isSymbolicLink())throw new Error('Symlink artifact directory is forbidden');}
  const target=join(directory,...parts);let file;
  try{file=await open(target,'wx',0o400);}catch(error){if(error.code!=='EEXIST')throw error;if((await lstat(target)).isSymbolicLink()||await readFile(target,'utf8')!==content)throw new Error('Immutable artifact file conflict: '+path);continue;}
  try{await file.writeFile(content);await file.sync();}finally{await file.close();}
 }
 return manifest;
}
export async function refreshCurrentDirectories(root,entries) {
 for(const kind of ['skill','workflow']){
  const directory=join(root,kind==='skill'?'skillx':'workflow');await mkdir(directory,{recursive:true});
  if((await lstat(directory)).isSymbolicLink())throw new Error('Symlink current directory is forbidden');
  const current=entries.filter(entry=>entry.kind===kind);const names=new Set(current.map(entry=>entry.name));
  for(const entry of current){
   const target=join(directory,entry.name);let old;
   try{old=JSON.parse(await readFile(join(target,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(old?.revisionId===entry.revisionId&&old.enabled===entry.enabled)continue;
   const staging=join(root,'.current-'+randomUUID()),backup=join(root,'.previous-'+randomUUID());let backed=false;
   try{await writeDirectory(staging,entry,{record:false});
    try{await rename(target,backup);backed=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    try{await rename(staging,target);}catch(error){if(backed)await rename(backup,target);throw error;}
   }finally{await rm(staging,{recursive:true,force:true});await rm(backup,{recursive:true,force:true});}
  }
  for(const item of await readdir(directory,{withFileTypes:true})){if(!item.isDirectory()||names.has(item.name))continue;
   try{const m=JSON.parse(await readFile(join(directory,item.name,'manifest.json'),'utf8'));if(m.format==='skillx-directory-v1'&&m.name===item.name)await rm(join(directory,item.name),{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
}
