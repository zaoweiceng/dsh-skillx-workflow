import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as Plugin from '../src/index.js';

class WebServer extends Service {
  routes = [];
  constructor(ctx) { super(ctx, 'webServer'); }
  register(route) { this.routes.push(route); return () => { this.routes.splice(this.routes.indexOf(route), 1); }; }
}
const stub = name => class extends Service { constructor(ctx) { super(ctx, name); } };
async function host(t, enableCapabilities) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'native-host-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SkillRegistry); await ctx.plugin(WebServer);
  for (const name of ['sessionQuery', 'agents', 'sessions', 'agentDefaultModel']) await ctx.plugin(stub(name));
  const fork = ctx.plugin(Plugin, { dataRoot, enableCapabilities }); await fork;
  const request = async (method, path, body) => {
    const result = {};
    const req = { method, url: '/skillx-workflow/api/' + path, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
    const res = { writeHead(status) { result.status = status; }, end(raw) { result.body = JSON.parse(raw); } };
    await ctx.webServer.routes[0].handler(req, res); return result;
  };
  return { ctx, fork, dataRoot, request };
}

test('native plugin exposes direct catalog/runtime API and disposes its route', async t => {
  const f = await host(t, true);
  assert.equal(f.ctx.webServer.routes.length, 1);
  assert.deepEqual((await f.request('GET', 'catalog')).body, { capabilities: [], workflows: [] });
  const runtime=(await f.request('GET', 'runtime')).body;
  assert.deepEqual({mode:runtime.mode,dataRoot:runtime.dataRoot,enableCapabilities:runtime.enableCapabilities}, { mode: 'native-agent', dataRoot: f.dataRoot, enableCapabilities: true });
  assert.equal(runtime.generationPolicy.revision,'contract-invocation-v13');
  assert.equal(runtime.generationPolicy.totalTimeoutMs,600000);
  assert.deepEqual(await f.ctx.skills.list(), []);
  await f.fork.dispose(); assert.equal(f.ctx.webServer.routes.length, 0);
});

test('baseline disables native provider while UI routes stay available', async t => {
  const f = await host(t, false);
  assert.equal((await f.request('GET', 'runtime')).body.enableCapabilities, false);
  assert.equal((await f.request('GET', 'catalog')).status, 200);
  assert.equal((await f.request('GET', 'entries/unknown')).status, 404);
  assert.equal((await f.request('POST', 'entries/unknown/availability', { enabled: true })).status, 400);
  assert.equal((await f.request('POST', 'entries/unknown/homepage', { showOnHome: true })).status, 400);
  assert.deepEqual(await f.ctx.skills.list(), []);
});

test('native config bounds and absolute data storage are validated', () => {
  assert.equal(Plugin.resolveConfig().enableCapabilities, true);
  for (const config of [{ enableCapabilities: 'yes' }, { dataRoot: './relative' }, { timeoutMs: 0 }, { maxSteps: 0 }]) assert.throws(() => Plugin.resolveConfig(config));
});
