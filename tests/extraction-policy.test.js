import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionBudget, assertDependencyCalls, validateExtractionPlan, assertPlanSubmission } from '../src/extraction-policy.js';

const call = (program, dependencies = []) => ({ execution: { program }, dependencies: dependencies.map(name => ({ name, version: 1 })) });
test('evidence size never expands dispatch beyond the total time budget', () => {
  assert.equal(extractionBudget([{ recordCount: 38, bytes: 63784 }]).timeoutMs, 600000);
  assert.equal(extractionBudget([{ recordCount: 201, bytes: 1000 }]).timeoutMs, 600000);
  assert.equal(extractionBudget([{ recordCount: 1, bytes: 600000 }]).timeoutMs, 600000);
  assert.equal(extractionBudget([{ recordCount: 100000, bytes: 100000000 }]).timeoutMs, 600000);
});
test('dependency checks use syntax, ignore prose/comments, and require actual literal calls', () => {
  assert.doesNotThrow(() => assertDependencyCalls(call("// capabilities.run({name:'fake'})\nreturn 'capabilities.run';")));
  assert.doesNotThrow(() => assertDependencyCalls(call("return await capabilities.run({name:'leaf',input});", ['leaf'])));
  assert.throws(() => assertDependencyCalls(call('return input;', ['leaf'])), /match actual/);
  assert.throws(() => assertDependencyCalls(call("return capabilities.run({name:'leaf',input});")), /match actual/);
  assert.throws(() => assertDependencyCalls(call('return capabilities.run({name: input.name,input});', ['leaf'])), /literal names/);
});
test('plans require read evidence and reject cyclic decompositions before building code', async () => {
  const context = { files: new Map([['s', { index: [{}] }]]), readRecords: new Map([['s', new Set([0])]]), readVersions: new Map(), store: { get: async () => undefined } };
  const leaf = { name: 'leaf', kind: 'skill', description: '独立操作', reuseValue: '供不同输入的重复任务独立调用。', scope: '输入数据，输出结果。', dependsOn: [], responsibilities: [{ purpose: '独立操作', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: '内部步骤没有独立输入输出，保留单一操作边界' }], sourceRecords: [{ sessionId: 's', record: 0 }] };
  assert.deepEqual(await validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] }, context), { decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] });
  await assert.rejects(validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [{ ...leaf, sourceRecords: [{ sessionId: 's', record: 1 }] }], reuseNames: [] }, context), /fully read/);
  await assert.rejects(validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [{ ...leaf, dependsOn: ['parent'], responsibilities: [{ purpose: 'cyclic', disposition: 'capability', independentUse: '该结果可供其他后续任务独立消费', capability: 'parent', reason: 'cycle fixture' }] }, { ...leaf, name: 'parent', kind: 'workflow', responsibilities: [{ purpose: 'compose leaf', disposition: 'capability', independentUse: '该结果可供其他后续任务独立消费', capability: 'leaf', reason: '独立输入输出，可由其他流程复用' }], dependsOn: ['leaf'] }], reuseNames: [] }, context), /cycle/);
  assert.throws(() => assertPlanSubmission({ decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] }, [{ name: 'other', kind: 'skill' }], []), /differ/);
});

test('independent phases share the same frozen total budget',()=>{
 const budget=extractionBudget([{recordCount:38,bytes:64000}],{stageCount:3});
 assert.equal(budget.stageCount,3); assert.equal(budget.timeoutMs,10*60*1000);
});

test('workflow responsibility decisions allow inline glue but require real dependencies for independent operations', async () => {
  const context = { files: new Map([['s', { index: [{}] }]]), readRecords: new Map([['s', new Set([0])]]), readVersions: new Map(), store: { get: async () => undefined } };
  const leaf = { name: 'fetch-resource', kind: 'skill', description: '获取资源', reuseValue: '供多个流程取得可验证资源', scope: '输入仓库与分支，输出本地引用', dependsOn: [], responsibilities: [{ purpose: '独立操作', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: '内部步骤没有独立输入输出，保留单一操作边界' }], sourceRecords: [{ sessionId: 's', record: 0 }] };
  const workflow = { ...leaf, name: 'switch-branch', kind: 'workflow', responsibilities: undefined };
  const plan = candidates => ({ decision: 'extract', reason: '按独立职责提取', candidates, reuseNames: [] });
  await assert.rejects(validateExtractionPlan(plan([workflow]), context), /responsibilities/);
  const independent = { purpose: '取得远端分支', disposition: 'capability', independentUse: '该结果可供其他后续任务独立消费', capability: leaf.name, reason: '独立于切换，可供比较、构建和检出复用' };
  await assert.rejects(validateExtractionPlan(plan([{ ...workflow, responsibilities: [independent] }]), context), /include it in dependsOn/);
  await assert.rejects(validateExtractionPlan(plan([{ ...workflow, dependsOn: [leaf.name], responsibilities: [{ purpose: 'switch', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: '流程胶水' }] }, leaf]), context), /Explain each dependency/);
  const composed = { ...workflow, dependsOn: [leaf.name], responsibilities: [independent, { purpose: '切换与核验', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: '消费已拉取引用，保留工作流控制流' }] };
  assert.deepEqual((await validateExtractionPlan(plan([leaf, composed]), context)).candidates, [leaf, composed]);
  const inline = { ...workflow, responsibilities: [{ purpose: '单一职责的固定工具链', disposition: 'inline', independentUse: '仅为内部表达式或流程胶水，没有独立消费结果', reason: '内部步骤没有独立输入输出或独立使用价值' }] };
  assert.equal((await validateExtractionPlan(plan([inline]), context)).candidates.length, 1);
  assert.equal((await validateExtractionPlan(plan([leaf]), context)).candidates[0].kind, 'skill');
});

test('unread terminal observations block both extraction and skip even after a goal or summary was read', async () => {
  const context = { files: new Map([['s', { index: [
    { record: 0, type: 'message', role: 'user' },
    { record: 1, type: 'toolEvidence' },
    { record: 2, type: 'message', role: 'assistant' },
    { record: 3, type: 'control', controlType: 'turn/end' },
  ] }]]), readRecords: new Map([['s', new Set([0, 2, 3])]]), readVersions: new Map(), store: { get: async () => undefined } };
  const skip = { decision: 'skip', reason: '暂未发现复用价值', candidates: [], reuseNames: [] };
  await assert.rejects(validateExtractionPlan(skip, context), error => error.code === 'OUTCOME_EVIDENCE_REQUIRED' && error.message.includes('"record":1'));
  context.readRecords.get('s').add(1);
  assert.deepEqual(await validateExtractionPlan(skip, context), skip);
});
