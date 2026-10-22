import { randomUUID } from 'node:crypto';
import { draftDigest as hashDraft } from './generation-digest.js';

export function selectDraftField(value, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') throw new Error('Read one explicit JSON pointer field, not the entire draft');
  for (const raw of path.slice(1).split('/')) {
    if (/~(?![01])/u.test(raw)) throw new Error('Invalid JSON pointer escape');
    const key = raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) throw new Error('Draft field not found: '+path);
    value = value[key];
  }
  return value;
}

/** Phase-local delivery tracking and advisory request accounting. */
export function createExtractionReads(task, persist) {
  const seen = new Set();
  const fields = new Map();
  const remember = (identity, value, retain = false) => {
    if (retain) { fields.set(identity, JSON.parse(JSON.stringify(value))); fields.delete(identity+':fragments'); }
    const key=identity+':'+hashDraft(value);
    if (!seen.has(key)) {
      seen.add(key);
      task.readBytesDelivered=(task.readBytesDelivered || 0)+Buffer.byteLength(JSON.stringify(value));
    }
  };
  return {
    remember,
    beginPhase() { seen.clear(); fields.clear(); },
    fields() { return [...fields].map(([identity,value])=>({identity,value})); },
    releaseUnretained(prefix) {
      for(const key of seen) if(key.startsWith(prefix) && !fields.has(key.slice(0,-65))) seen.delete(key);
    },
    fragment(identity, value) {
      const key=identity+':fragments';
      const parts=fields.get(key) || [];
      fields.set(key,[...parts.filter(part=>part.partCursor!==value.partCursor),value]);
    },
    invalidateDraft(draft) {
      const stale=new Set();
      for(const identity of fields.keys()) {
        if(!identity.startsWith('draft:') || identity.startsWith('draft:__protocol__:')) continue;
        const match=identity.match(/^draft:([^:]+):(\/.*)$/);
        const collection=draft.candidates;
        const item=match && Array.isArray(collection) && collection.find(item=>item?.name===match[1]);
        try {
          const current=selectDraftField(item,match?.[2]);
          if(hashDraft(current)!==hashDraft(fields.get(identity))) stale.add(identity);
        } catch { stale.add(identity); }
      }
      for(const identity of stale) {
        fields.delete(identity);
        for(const key of seen) if(key.startsWith(identity+':')) seen.delete(key);
      }
      for(const key of seen) if(/^draft:__(?!protocol__)/.test(key)) seen.delete(key);
    },
    read(identity, value, continuation = false) {
      // Optional metadata fields must be omitted, not exposed as undefined to DSH.
      value = JSON.parse(JSON.stringify(value));
      if (continuation) return value;
      const digest = hashDraft(value); const key = identity+':'+digest;
      if (seen.has(key)) {
        task.duplicateReadsAvoided = (task.duplicateReadsAvoided || 0) + 1;
        return {alreadyRead:true,identity,digest,instruction:'Exact data is already in this phase context. Reuse it; do not request the same unchanged field again.'};
      }
      if (Buffer.byteLength(JSON.stringify(value)) <= 10000) remember(identity,value,true);
      return value;
    },
    async preflight(session, config) {
      const inputBytes=session?.deriveMessages ? Buffer.byteLength(JSON.stringify(session.deriveMessages())) : 0;
      const estimatedInputTokens=Math.ceil(inputBytes / 2)+4096;
      const remaining=task.budget.maxTotalTokens-(task.totalTokens || 0);
      const projected=(task.totalTokens || 0)+estimatedInputTokens+config.maxTokens;
      if (projected > task.budget.maxTotalTokens) {
        const previous=task.budget.maxTotalTokens;
        task.budget.maxTotalTokens=Math.ceil(projected/100000)*100000;
        (task.budgetAdjustments ??= []).push({kind:'tokens',previous,estimate:task.budget.maxTotalTokens,reason:'Pre-request estimate updated; continue requested work'});
      }
      task.requestPreflight={checkedAt:new Date().toISOString(),inputBytes,estimatedInputTokens,remainingBeforeCheck:remaining,projectedTokens:projected,requestOutputLimit:config.maxTokens};
      await persist(task); return config;
    },
  };
}

/** Replace model-visible authoring history with exact host-owned current data. */
export function replaceExtractionContext(session, value) {
  const events=session.snapshotEvents();
  const nodes=[...session.surface.nodes];
  const start=nodes.findIndex(seq=>!['system/message','developer/message'].includes(events[seq].type));
  if(start<0) return 0;
  const replaced=nodes.slice(start);
  const calls=new Map(events.filter(event=>event.type==='tool/call').map(event=>[event.data.callId,event.data.name]));
  value.toolFeedback=replaced.flatMap(seq=>{
    const event=events[seq];if(event.type!=='tool/result') return [];
    const message=event.data.message;
    const tool=calls.get(message.toolCallId);
    const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
    let result;try {result=JSON.parse(text);} catch {if(message.isError) return [{tool,error:text}];return [];}
    if(message.isError || result?.fieldNotFound || result?.fieldTooLarge || result?.alreadyRead || result?.unrelated || result?.completeRecord===false) return [{tool,result}];
    if(['submit_native_capabilities','submit_native_plan'].includes(tool)) {
      const {saved,frozen,accepted,unchanged,draftDigest,validatedNames,instruction}=result;
      return [{tool,result:{saved,frozen,accepted,unchanged,draftDigest,validatedNames,instruction}}];
    }
    return [];
  });
  const text=JSON.stringify(value);
  session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'dsh-skillx-workflow-request'},content:[{type:'text',text}]},{surfaceOp:{op:'replace',startSeq:replaced[0],endSeq:replaced.at(-1)},sourceEventSeqs:replaced});
  return Buffer.byteLength(text);
}
