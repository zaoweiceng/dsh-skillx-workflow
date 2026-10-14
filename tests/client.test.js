import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('notice uses host primitives, themed surface, progress, result and dismissal', () => {
  let snapshot = { kind: 'running', resultUrl: 'http://127.0.0.1:5173/chat/result' };
  let loaded; const slots = new Map(); const opened = [];
  const primitives = Object.fromEntries(['MenuItemButton', 'Button', 'StateDot', 'IconCloseOutlineRegular', 'IconRightUpOutlineRegular'].map(name => [name, name]));
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useSyncExternalStore: () => snapshot };
  const window = { open: (...args) => opened.push(args), __ModuleLoader__: { load: value => { loaded = value; } } };
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), { window });
  const plugin = loaded.factory(name => name === 'react' ? React : primitives);
  const ctx = { effect: fn => fn(), locale: { register() {}, bind: () => key => key }, slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slots.set(spec.id || spec.key, component); } } };
  plugin.apply(ctx);
  const Notice = slots.get('skillx-workflow.notice');
  const tree = Notice(); assert.equal(tree.props.role, 'status');
  assert.equal(tree.props.style.border, '0.5px solid var(--dsw-alias-border-l2)');
  assert.equal(tree.props.style.boxShadow, 'var(--dsw-shadow-lv2)');
  const flatten = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(flatten)] : [];
  const nodes = flatten(tree);
  assert.equal(nodes.find(node => node.type === 'StateDot').props.state, 'ongoing');
  assert.equal(nodes.some(node => node.type === 'a' || node.type === 'button'), false);
  nodes.find(node => node.type === 'Button' && node.children.includes('result')).props.onClick();
  assert.deepEqual(opened[0], [snapshot.resultUrl, '_blank', 'noopener,noreferrer']);
  snapshot = { kind: 'failed', detail: 'Validation failed' };
  assert.equal(Notice().props.role, 'alert');
  snapshot = { kind: 'completed' };
  assert.equal(flatten(Notice()).find(node => node.type === 'StateDot').props.state, 'done');
  nodes.find(node => node.type === 'Button' && node.props['aria-label'] === 'dismiss').props.onClick();
});

test('native list filters in header, shows row switches, fetches details and changes availability', async () => {
  let loaded; const slots = new Map(); const requests = []; const state = []; let cursor = 0;
  const catalog = { capabilities: [{ name: 'alpha', description: 'First skill', enabled: true }, { name: 'beta', description: 'Second', enabled: false }], workflows: [{ name: 'flow', enabled: true }] };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value; }]; },
    useEffect() {}, useSyncExternalStore: () => null,
  };
  const primitives = Object.fromEntries(['MenuItemButton', 'Button', 'StateDot', 'IconCloseOutlineRegular', 'IconRightUpOutlineRegular'].map(name => [name, name]));
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } },
    fetch: async (url, options) => { requests.push({ url, options }); const value = url.endsWith('/catalog') ? catalog : url.endsWith('/entries/alpha') ? { name: 'alpha', content: '# Actual content' } : {}; return { ok: true, text: async () => JSON.stringify(value) }; },
  });
  loaded.factory(name => name === 'react' ? React : primitives).apply({ effect: fn => fn(), locale: { register() {}, bind: () => key => key }, slots: { inject: (_name, fn) => fn(), register: (spec, component) => slots.set(spec.name + ':' + (spec.id || spec.key), component) } });
  assert.equal(requests.length, 0, 'registration does not automatically extract');
  state[0] = catalog;
  const Page = slots.get('main:skillx-workflow.skillx');
  const render = () => { cursor = 0; return Page().type({ kind: 'skillx' }); };
  const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : [];
  let tree = render(); let nodes = flatten(tree);
  assert.equal(nodes.some(node => node.type === 'iframe'), false);
  const header = nodes.find(node => node.type === 'header');
  assert.equal(flatten(header).some(node => node.type === 'input' && node.props.type === 'search'), true);
  assert.equal(nodes.filter(node => node.props.role === 'switch').length, 2);
  await nodes.find(node => node.props.role === 'switch').props.onChange();
  assert.equal(requests[0].url, '/skillx-workflow/api/entries/alpha/availability');
  assert.deepEqual(JSON.parse(requests[0].options.body), { enabled: false });
  nodes.find(node => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: 'Second' } });
  nodes = flatten(render()); assert.equal(nodes.filter(node => node.props.role === 'switch').length, 1);
  state[2] = ''; nodes = flatten(render());
  await nodes.find(node => node.type === 'Button' && node.children.includes('alpha')).props.onClick();
  nodes = flatten(render()); assert.equal(nodes.find(node => node.type === 'pre').children[0], '# Actual content');
  assert.equal(nodes.find(node => node.type === 'Button' && node.children.includes('optimize')).props.disabled, true);
  nodes.find(node => node.type === 'input' && node.props.required).props.onChange({ target: { value: 'execution-session' } });
  assert.equal(flatten(render()).find(node => node.type === 'Button' && node.children.includes('optimize')).props.disabled, false);
  assert.equal(requests.some(request => request.url.endsWith('/extract') || request.url.endsWith('/optimize')), false);
});
