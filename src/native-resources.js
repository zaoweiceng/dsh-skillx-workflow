import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_BYTES = 512 * 1024;
export function assertResourcePath(path) {
  if (typeof path !== 'string' || !/^(?:scripts|assets)\/[a-zA-Z0-9_.\/-]+$/.test(path) || path.length > 240
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Resource path must be a portable relative scripts/ or assets/ path');
  return path;
}
export function normalizeResources(resources) {
  if (resources === undefined) return undefined;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources) || Object.keys(resources).length > 32) throw new Error('resources must map at most 32 relative paths to UTF-8 text');
  const names = new Set(); let bytes = 0;
  for (const [path, content] of Object.entries(resources)) {
    assertResourcePath(path);
    if (names.has(path.toLowerCase())) throw new Error('Resource paths must not differ only by case');
    names.add(path.toLowerCase());
    if (typeof content !== 'string' || content.includes('\0') || Buffer.from(content).toString('utf8') !== content) throw new Error('Resources must be lossless UTF-8 text');
    bytes += Buffer.byteLength(content);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) if (names.has(parts.slice(0, index).join('/'))) throw new Error('Resource file conflicts with a resource directory');
  }
  if (bytes > MAX_BYTES) throw new Error('Resource text exceeds 512 KiB');
  return { ...resources };
}
export const resourceDigest = content => createHash('sha256').update(content).digest('hex');
export const resourceManifest = resources => Object.fromEntries(Object.entries(resources ?? {}).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: resourceDigest(content) }]));

// Copy only specifically evidenced source files; no filesystem discovery or execution.
export async function captureResources(candidate, allowedSources, cache) {
  const resources = { ...normalizeResources(candidate.resources) };
  const sources = candidate.resourceSources ?? {};
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length > 32) throw new Error('Invalid resourceSources');
  for (const [path, sourcePath] of Object.entries(sources)) {
    assertResourcePath(path);
    if (Object.hasOwn(resources, path)) throw new Error('Specify resource content or sourcePath, not both: ' + path);
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || !allowedSources.has(sourcePath)) throw new Error('Resource source must be an exact file path recorded by a source read/write operation; ask the user when unknown');
    if (!cache.has(sourcePath)) {
      const stat = await lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Resource source must be a regular text file of at most 512 KiB');
      const bytes = await readFile(sourcePath);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes)) throw new Error('Resource source is not UTF-8 text');
      cache.set(sourcePath, content);
    }
    resources[path] = cache.get(sourcePath);
  }
  return normalizeResources(resources);
}
