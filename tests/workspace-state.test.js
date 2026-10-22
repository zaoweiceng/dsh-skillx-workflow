import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let loaded, current, cursor;
  const slots = new Map(), states = new Map();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) {
      const state = states.get(current), index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useEffect() {}, useSyncExternalStore: () => null,
  };
  const primitives = Object.fromEntries(['MenuItemButton', 'Button', 'StateDot', 'IconCloseOutlineRegular', 'IconRightUpOutlineRegular'].map(name => [name, name]));
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } },
  });
  loaded.factory(name => name === 'react' ? React : primitives).apply({
    effect: fn => fn(), locale: { register() {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => slots.set(spec.name + ':' + (spec.id || spec.key), component) },
  });
  const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : [];
  const render = (component, props = {}, key = component.name) => {
    current = key; cursor = 0;
    if (!states.has(key)) states.set(key, []);
    return flatten(component(props));
  };
  const Workspace = slots.get('main:skillx-workflow.skillx')().type;
  const workspace = () => render(Workspace);
  const selectTab = tab => workspace().find(node => node.props.id === 'sxw-tab-' + tab).props.onClick();
  return { render, workspace, selectTab, states };
}

test('home edit control is absent from every other tab', () => {
  const { workspace, selectTab } = fixture();
  const edit = () => workspace().find(node => node.type === 'Button' && node.props['aria-pressed'] !== undefined);
  assert.ok(edit());
  edit().props.onClick();
  assert.ok(edit().children.includes('finishEditing'));
  for (const tab of ['skillx', 'workflow', 'monitoring', 'runHistory', 'extractionModel']) {
    selectTab(tab);
    assert.equal(edit(), undefined, tab);
  }
  selectTab('home');
  assert.ok(edit());
});

test('independent monitoring dates survive refresh and tab remounts until workspace closes', () => {
  const { render, workspace, selectTab, states } = fixture();
  selectTab('monitoring');
  const monitoring = () => {
    const node = workspace().find(node => node.type?.name === 'Monitoring');
    return render(node.type, node.props);
  };
  const control = metric => {
    const panel = monitoring().find(node => node.props.metric === metric);
    const range = render(panel.type, panel.props, metric).find(node => node.type?.name === 'RangeControl');
    return render(range.type, range.props);
  };
  const choose = (metric, choice) => control(metric).find(node => node.type === 'select').props.onChange({ target: { value: choice } });
  choose('savings', 'custom');
  for (const [key, date] of [['start', '2026-10-01'], ['end', '2026-10-15']]) {
    control('savings').find(node => node.props['aria-label'] === key).props.onInput({ currentTarget: { value: date } });
  }
  choose('success', '72');
  workspace().find(node => node.type === 'Button' && node.children.includes('refresh')).props.onClick();
  assert.equal(control('savings').find(node => node.props['aria-label'] === 'start').props.value, '2026-10-01');
  selectTab('home');
  // Tab children unmount; only Workspace state survives.
  for (const key of [...states.keys()]) if (key !== 'Workspace') states.delete(key);
  selectTab('monitoring');
  assert.equal(control('savings').find(node => node.type === 'select').props.value, 'custom');
  assert.equal(control('savings').find(node => node.props['aria-label'] === 'start').props.value, '2026-10-01');
  assert.equal(control('savings').find(node => node.props['aria-label'] === 'end').props.value, '2026-10-15');
  assert.equal(control('success').find(node => node.type === 'select').props.value, 72);
  assert.equal(control('workflowCalls').find(node => node.type === 'select').props.value, 24);
  states.clear();
  selectTab('monitoring');
  assert.equal(control('savings').find(node => node.type === 'select').props.value, 24);
});
