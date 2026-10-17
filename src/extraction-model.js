import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Select authoring models from the host catalog; credentials stay with DSH. */
export function createExtractionModels(ctx, { dataRoot }) {
  const path = join(dataRoot, 'extraction-model.json');
  const llm = () => ctx.get?.('llm') ?? ctx.llm;
  async function models() {
    const host = llm();
    if (!host?.listProviders) throw new Error('DSH model catalog is unavailable');
    const results = await Promise.allSettled(host.listProviders().map(async provider => {
      const advertised = await host.listModels(provider.id);
      return Promise.all(advertised.map(async model => {
        const info = await host.resolveModelInfo(provider.id, model.id);
        return { provider:provider.id, providerName:provider.name || provider.id, model:model.id, name:model.name,
          efforts:info.reasoning?.efforts?.length ? info.reasoning.efforts.map(e => ({ id:e.id, name:e.name || e.id })) : [{id:'default',name:'Default'}] };
      }));
    }));
    const available = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    if (!available.length) throw new Error('DSH has no available extraction models');
    return available;
  }
  async function saved() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function validate(selection, available) {
    const match = available.find(m => m.provider === selection?.provider && m.model === selection?.model);
    if (!match || !match.efforts.some(e => e.id === selection.reasoningEffort)) throw new Error('Choose a DSH model and one of its supported reasoning levels');
    return { provider:match.provider, model:match.model, reasoningEffort:selection.reasoningEffort };
  }
  async function get() {
    const available = await models();
    let selection = await saved();
    if (!selection) {
      const current = (ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel)?.currentSelection?.();
      const flash = available.filter(m => /deepseek/i.test(m.provider+' '+m.model) && /flash/i.test(m.model+' '+m.name) && m.efforts.some(e => e.id === 'low'));
      const preferred = flash.find(m => m.provider === current?.provider && m.model === current?.model) || flash.find(m => m.provider === 'deepseek-official') || flash[0];
      if (!preferred) throw new Error('DSH DeepSeek Flash with Low reasoning is unavailable; choose an extraction model in SkillX');
      selection = {provider:preferred.provider,model:preferred.model,reasoningEffort:'low'};
    }
    return {selection:validate(selection,available),models:available};
  }
  return {
    get,
    async selection() { const {reasoningEffort,...selection} = (await get()).selection; return {...selection,...(reasoningEffort === 'default' ? {} : {reasoningEffort})}; },
    async save(selection) {
      const next = validate(selection, await models());
      await mkdir(dataRoot, {recursive:true});
      const temp = path+'.'+randomUUID()+'.tmp';
      await writeFile(temp, JSON.stringify(next), {mode:0o600});
      await rename(temp,path);
      return {selection:next};
    },
  };
}
