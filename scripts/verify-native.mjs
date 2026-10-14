import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const visited = new Set();
async function inspect(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const text = await readFile(file, 'utf8');
  if (/runtime-engine|standalone-runtime|dsh-model-bridge|127\.0\.0\.1:(8000|5173)/.test(text)) throw new Error(`Legacy runtime dependency in ${file}`);
  for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)) await inspect(resolve(dirname(file), match[1]));
}
await inspect(resolve(root, 'src/index.js'));
const host = new URL(process.argv[2] || 'http://127.0.0.1:3080');
const get = async path => {
  const response = await fetch(new URL('/skillx-workflow/api/' + path, host));
  if (!response.ok) throw new Error(`Native API ${path}: ${response.status}`);
  return response.json();
};
const runtime = await get('runtime');
if (!['native-agent'].includes(runtime.mode)) throw new Error('Host is not using the DSH native Agent implementation');
const catalog = await get('catalog');
console.log(JSON.stringify({ runtime, catalog, verified: ['native-import-graph', 'native-host-api', 'catalog'] }, null, 2));
