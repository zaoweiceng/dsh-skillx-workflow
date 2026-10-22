import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtractionModels } from '../src/extraction-model.js';

async function fixture(t, initial) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'extraction-model-'));
  t.after(() => rm(dataRoot, { recursive:true, force:true }));
  const path = join(dataRoot, 'extraction-model.json');
  if (initial) await writeFile(path, JSON.stringify(initial));
  const models = [{ id:'gpt-5.5', name:'GPT' }, { id:'deepseek-flash', name:'DeepSeek Flash' }, {id:'plain',name:'Plain'}];
  const ctx = {llm:{listProviders:() => [{id:'traex'}],listModels:async () => models,
    resolveModelInfo:async (_provider,model) => model === 'plain' ? {} : {reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}}};
  return {service:createExtractionModels(ctx,{dataRoot}),path,models};
}

test('stale saved effort returns the catalog for repair without changing saved settings', async t => {
  const stale = {provider:'traex',model:'gpt-5.5',reasoningEffort:'default'};
  const {service,path} = await fixture(t,stale);
  const result = await service.get();
  assert.equal(result.selection,null);
  assert.equal(result.selectionIssue,'unavailableSelection');
  assert.equal(result.models.length,3);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),stale);
  await assert.rejects(service.selection(), {code:'INVALID_EXTRACTION_MODEL'});
  await assert.rejects(service.save(stale), {code:'INVALID_EXTRACTION_MODEL'});
  const repaired = {...stale,reasoningEffort:'high'};
  await service.save(repaired);
  assert.deepEqual(await service.selection(),repaired);
  assert.equal((await service.get()).selectionIssue,undefined);
});

test('removed model remains recoverable and no default model still allows manual setup', async t => {
  const {service,models} = await fixture(t,{provider:'removed',model:'missing',reasoningEffort:'low'});
  assert.equal((await service.get()).selectionIssue,'unavailableSelection');
  const other = await fixture(t);
  other.models.splice(1,1);
  const result = await other.service.get();
  assert.equal(result.selectionIssue,'missingDefaultModel');
  assert.equal(result.models.length,2);
  await assert.rejects(other.service.selection(), {code:'INVALID_EXTRACTION_MODEL'});
});

test('initial Flash Low and models without reasoning metadata retain their behavior', async t => {
  const {service} = await fixture(t);
  assert.deepEqual(await service.selection(),{provider:'traex',model:'deepseek-flash',reasoningEffort:'low'});
  await service.save({provider:'traex',model:'plain',reasoningEffort:'default'});
  assert.deepEqual(await service.selection(),{provider:'traex',model:'plain'});
});
