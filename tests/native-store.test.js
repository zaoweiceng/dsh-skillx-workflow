import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/native-store.js';
import { registerNativeSkills } from '../src/native-skills.js';

const execution = { language: 'typescript', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean' } }, required: ['accepted'] }, program: 'return { accepted: true };' };
const input = overrides => ({ execution, name: 'native-example', description: 'An extracted capability', content: 'Use the native skill tool to load another capability when needed.', kind: 'workflow', sourceSessionId: 'source-1', generatorSessionId: 'generator-1', operation: 'extract', evidence: { provider: 'dsh', status: 'completed', sessionId: 'generator-1' }, ...overrides });
async function fixture(t) { const dataRoot = await mkdtemp(join(tmpdir(), 'native-store-')); t.after(() => rm(dataRoot, { recursive: true, force: true })); return createStore({ dataRoot }); }

test('publishes summaries and loads immutable full revisions on demand', async t => {
  const store = await fixture(t);
  const one = await store.commit(input());
  assert.deepEqual(await store.list(), [{ name: one.name, description: one.description }]);
  assert.equal((await store.get(one.name)).content, one.content);
  const two = await store.commit(input({ operation: 'optimize', baseVersion: 1, content: 'Improved native instructions' }));
  assert.equal(two.version, 2);
  assert.equal(two.previousRevisionId, one.revisionId);
  const original = JSON.parse(await readFile(join(store.dataRoot, 'revisions', `${one.revisionId}.json`)));
  assert.equal(original.content, one.content);
  assert.equal(await readFile(join(store.dataRoot, 'revisions', `${one.revisionId}.md`), 'utf8'), one.content);
  assert.equal(original.sourceSessionId, 'source-1');
  await assert.rejects(store.commit(input({ operation: 'optimize', baseVersion: 1 })), /conflict/);
});

test('rejects traversal and unproven generators without publication', async t => {
  const store = await fixture(t);
  await assert.rejects(store.commit(input({ name: '../escape' })), /Invalid/);
  await assert.rejects(store.commit(input({ evidence: { provider: 'dsh', status: 'completed', sessionId: 'historical-generator' } })), /evidence/);
  await assert.rejects(store.commit(input({ evidence: undefined })), /evidence/);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(join(store.dataRoot, 'revisions')), []);
});

test('serializes concurrent versions and keeps disabled entries out of native loading', async t => {
  const store = await fixture(t);
  const versions = await Promise.allSettled([store.commit(input()), store.commit(input())]);
  assert.equal(versions[0].value.version, 1);
  assert.match(versions[1].reason.message, /already exists/);
  await store.commit(input({ operation: 'optimize', baseVersion: 1 }));
  await store.setEnabled('native-example', false);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('native-example'), undefined);
  assert.equal((await store.get('native-example', { includeDisabled: true })).version, 2);
  assert.equal((await store.list('workflow', { includeDisabled: true }))[0].enabled, false);
  await store.setEnabled('native-example', true);
  assert.equal((await store.list()).length, 1);
});

test('provider uses DSH lazy body loading, priority, invalidation and disposal', async t => {
  const store = await fixture(t);
  let provider, invalidated = 0, disposed = 0;
  const controller = new AbortController();
  const dispose = registerNativeSkills({ skills: { registerProvider(factory) { provider = factory({ signal: controller.signal, invalidate() { invalidated++; } }); return () => { disposed++; controller.abort(); }; } } }, store);
  await store.commit(input());
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].content, undefined);
  assert.ok(candidates[0].rank < 0);
  const definition = await provider.get(candidates[0]);
  const manifest = JSON.parse(definition.content);
  assert.deepEqual(manifest.inputSchema, execution.inputSchema);
  assert.deepEqual(manifest.outputSchema, execution.outputSchema);
  assert.equal(manifest.invocation.tool, 'capability_run');
  assert.equal(manifest.content, undefined);
  assert.equal(manifest.program, undefined);
  assert.equal(manifest.execution, undefined);
  assert.equal(definition.content.includes(execution.program), false);
  assert.equal(definition.content.includes(input().content), false);
  await store.setEnabled('native-example', false);
  assert.equal(await provider.get(candidates[0]), undefined);
  assert.equal(invalidated, 2);
  dispose();
  await store.setEnabled('native-example', true);
  assert.equal(invalidated, 2);
  assert.equal(disposed, 1);
});


test('installed DSH registry and native skill tool resolve precedence and disabled fallback', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill');
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
  const { apply: applySkillTool } = await import('@deepseek-ai/dsh-tool-skill');
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new SkillRegistry(ctx);
  new ToolRuntime(ctx);
  applySkillTool(ctx);
  const ordinary = ctx.skills.register({ name: 'native-example', description: 'Ordinary skill', source: 'runtime', content: 'Ordinary body' });
  t.after(ordinary);
  const store = await fixture(t);
  const dispose = registerNativeSkills(ctx, store);
  t.after(dispose);
  await store.commit(input());
  const tool = ctx.tools.get('skill');
  assert.ok(tool);
  assert.equal((await ctx.skills.list())[0].description, input().description);
  const loaded = await tool.execute({ name: 'native-example' }, {});
  const manifest = JSON.parse(loaded.content);
  assert.equal(manifest.name, 'native-example');
  assert.equal(manifest.invocation.tool, 'capability_run');
  assert.deepEqual(manifest.inputSchema, execution.inputSchema);
  assert.deepEqual(manifest.outputSchema, execution.outputSchema);
  assert.equal(manifest.content, undefined);
  assert.equal(manifest.program, undefined);
  assert.equal(loaded.content.includes(execution.program), false);
  assert.equal(loaded.content.includes(input().content), false);
  await store.setEnabled('native-example', false);
  assert.equal((await ctx.skills.list())[0].description, 'Ordinary skill');
  assert.equal((await tool.execute({ name: 'native-example' }, {})).content, 'Ordinary body');
  await store.setEnabled('native-example', true);
  assert.equal((await tool.execute({ name: 'native-example' }, {})).provider, 'native-workflows');
});

test('batch publication is atomic across conflicts and cancellation', async t => {
  const store = await fixture(t);
  await store.commit(input());
  let changes = 0;
  store.subscribe(() => changes++);
  await assert.rejects(store.commitBatch([input({ name: 'new-entry' }), input()]), /already exists/);
  assert.equal(await store.get('new-entry'), undefined);
  assert.equal(changes, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.commitBatch([input({ name: 'new-entry' })], { signal: controller.signal }), /abort/i);
  assert.equal(await store.get('new-entry'), undefined);
  const committed = await store.commitBatch([input({ name: 'new-entry' }), input({ name: 'another-entry' })]);
  assert.equal(committed.length, 2);
  assert.equal(changes, 1);
  assert.equal((await store.list()).length, 3);
});


test('home selection persists independently of availability and survives optimization', async t => {
  const store = await fixture(t);
  await store.commit(input());
  assert.equal((await store.list('workflow', { includeDisabled: true }))[0].showOnHome, false);
  await store.setShowOnHome('native-example', true);
  await store.setEnabled('native-example', false);
  const reopened = createStore({ dataRoot: store.dataRoot });
  assert.equal((await reopened.get('native-example', { includeDisabled: true })).showOnHome, true);
  await reopened.commit(input({ operation: 'optimize', baseVersion: 1 }));
  const entry = (await reopened.list('workflow', { includeDisabled: true }))[0];
  assert.equal(entry.showOnHome, true);
  assert.equal(entry.enabled, false);
  await assert.rejects(reopened.setShowOnHome('native-example', 'yes'), /boolean/);
  await assert.rejects(reopened.setShowOnHome('missing', true), /not found/);
  await reopened.setShowOnHome('native-example', false);
  assert.equal((await reopened.get('native-example', { includeDisabled: true })).showOnHome, false);
});


test('home card order spans kinds, persists and survives optimization', async t => {
  const store = await fixture(t);
  await store.commit(input());
  await store.commit(input({ name: 'another', kind: 'skill' }));
  await store.setShowOnHome('native-example', true);
  await store.setShowOnHome('another', true);
  await store.setHomeOrder(['native-example', 'another']);
  const reopened = createStore({ dataRoot: store.dataRoot });
  await reopened.commit(input({ operation: 'optimize', baseVersion: 1 }));
  const rows = await reopened.list(undefined, { includeDisabled: true });
  assert.deepEqual(rows.sort((a,b) => a.homeOrder - b.homeOrder).map(row => row.name), ['native-example', 'another']);
  await assert.rejects(store.setHomeOrder(['another', 'another']), /Invalid/);
  await assert.rejects(store.setHomeOrder(['missing']), /changed/);
  await store.setHomeOrder(['another']);
  assert.equal((await store.list('skill', { includeDisabled: true }))[0].homeOrder, 0);
});
