import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionBudget, assertDependencyCalls, validateExtractionPlan, assertPlanSubmission } from '../src/extraction-policy.js';

const call = (program, dependencies = []) => ({ execution: { program }, dependencies: dependencies.map(name => ({ name, version: 1 })) });
test('adaptive budget uses both line count and bytes, with a configurable multi-hour ceiling', () => {
  assert.equal(extractionBudget([{ recordCount: 38, bytes: 63784 }]).timeoutMs, 1800000);
  assert.equal(extractionBudget([{ recordCount: 201, bytes: 1000 }]).timeoutMs, 5400000);
  assert.equal(extractionBudget([{ recordCount: 1, bytes: 600000 }]).timeoutMs, 5400000);
  assert.equal(extractionBudget([{ recordCount: 100000, bytes: 100000000 }]).timeoutMs, 14400000);
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
  const leaf = { name: 'leaf', kind: 'skill', description: '独立操作', reuseValue: '供不同输入的重复任务独立调用。', scope: '输入数据，输出结果。', dependsOn: [], sourceRecords: [{ sessionId: 's', record: 0 }] };
  assert.deepEqual(await validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] }, context), { decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] });
  await assert.rejects(validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [{ ...leaf, sourceRecords: [{ sessionId: 's', record: 1 }] }], reuseNames: [] }, context), /fully read/);
  await assert.rejects(validateExtractionPlan({ decision: 'extract', reason: '独立复用', candidates: [{ ...leaf, dependsOn: ['parent'] }, { ...leaf, name: 'parent', kind: 'workflow', dependsOn: ['leaf'] }], reuseNames: [] }, context), /cycle/);
  assert.throws(() => assertPlanSubmission({ decision: 'extract', reason: '独立复用', candidates: [leaf], reuseNames: [] }, [{ name: 'other', kind: 'skill' }], []), /differ/);
});

test('known independent phases expand the frozen size-based budget before dispatch',()=>{
 const budget=extractionBudget([{recordCount:38,bytes:64000}],{stageCount:3});
 assert.equal(budget.stageCount,3); assert.equal(budget.timeoutMs,90*60*1000);
});
