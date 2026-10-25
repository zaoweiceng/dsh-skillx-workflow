import { adaptSource } from './source-adapter.js';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

export function assertResourcePath(path) {
  if (typeof path !== 'string' || !/^(?:scripts|assets)\/[a-zA-Z0-9_.\/-]+$/.test(path) || path.length > 240
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Resource path must be a portable relative scripts/ or assets/ path');
  return path;
}
export function normalizeResources(resources) {
  if (resources === undefined) return undefined;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources) || Object.keys(resources).length > 32) throw new Error('resources must map at most 32 relative paths to UTF-8 text');
  const names = new Set();
  for (const [path, content] of Object.entries(resources)) {
    assertResourcePath(path);
    if (names.has(path.toLowerCase())) throw new Error('Resource paths must not differ only by case');
    names.add(path.toLowerCase());
    if (typeof content !== 'string' || content.includes('\0') || Buffer.from(content).toString('utf8') !== content) throw new Error('Resources must be lossless UTF-8 text');
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) if (names.has(parts.slice(0, index).join('/'))) throw new Error('Resource file conflicts with a resource directory');
  }
  return { ...resources };
}
export const resourceDigest = content => createHash('sha256').update(content).digest('hex');
export const resourceManifest = resources => Object.fromEntries(Object.entries(resources ?? {}).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: resourceDigest(content) }]));

// Build diagnostics only: do not make an invalid published module unreadable for repair.
export function assertResourceModules(candidates) {
  const issues = [];
  for (const candidate of candidates) for (const [resourcePath, source] of Object.entries(candidate.resources ?? {})) {
    if (!resourcePath.endsWith('.mjs')) continue;
    const add = (code, message) => issues.push({candidate:candidate.name,resourcePath,path:'/resources/'+resourcePath,code,message});
    let tree;
    try { tree = parse(source,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true}); }
    catch (error) { add('RESOURCE_SYNTAX_INVALID',error.message); continue; }
    let usesRequire = false, bindsRequire = false;
    const binding = node => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'Identifier' && node.name === 'require') bindsRequire = true;
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(binding); else if (value && typeof value === 'object') binding(value);
    };
    const visit = node => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') usesRequire = true;
      if (node.type === 'VariableDeclarator') binding(node.id);
      if (['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)) { binding(node.id); node.params.forEach(binding); }
      if (node.type.startsWith('Import')) binding(node.local);
      if (node.type === 'CatchClause') binding(node.param);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    };
    visit(tree);
    if (usesRequire && !bindsRequire) add('RESOURCE_ESM_REQUIRE','An .mjs resource has no implicit require. Use ESM imports or a locally defined createRequire binding.');
  }
  if (issues.length) throw Object.assign(new Error('Resource modules disagree with their Node module format'),{code:'RESOURCE_MODULE_INVALID',issues});
}

// Reading and copying a source must use the same frozen bytes, including after
// the author revises a draft. Reads address exact files, never directories.
export async function readResourceSource(sourcePath, allowedSources, cache, sourceRoots = []) {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) throw new Error('Resource source must be an absolute file path');
  if (!allowedSources.has(sourcePath)) {
    const actual = await realpath(sourcePath);
    let inside = false;
    for (const root of sourceRoots) {
      const part = relative(await realpath(root), actual);
      if (part && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part)) { inside = true; break; }
    }
    if (!inside) throw new Error('Resource source must be recorded evidence or inside a selected source workspace');
  }
  if (!cache.has(sourcePath)) {
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Resource source must be a regular text file');
    const bytes = await readFile(sourcePath);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('Resource source is not UTF-8 text');
    cache.set(sourcePath, content);
  }
  return cache.get(sourcePath);
}

// Copy selected source files without discovery or execution.
export async function captureResources(candidate, allowedSources, cache, sourceRoots = []) {
  const resources = { ...normalizeResources(candidate.resources) };
  const sources = candidate.resourceSources ?? {};
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length > 32) throw new Error('Invalid resourceSources');
  for (const [path, origin] of Object.entries(sources)) {
    const adapter = typeof origin === 'string' ? undefined : origin;
    const sourcePath = adapter?.path ?? origin;
    assertResourcePath(path);
    if (Object.hasOwn(resources, path)) throw new Error('Specify resource content or sourcePath, not both: ' + path);
    const source = await readResourceSource(sourcePath, allowedSources, cache, sourceRoots);
    if (adapter && (!path.endsWith('.mjs') || !sourcePath.endsWith('.mjs'))) throw new Error('Source function adapters require an ESM .mjs source and destination');
    resources[path] = adapter ? adaptSource(source,adapter) : source;
  }
  return normalizeResources(resources);
}
