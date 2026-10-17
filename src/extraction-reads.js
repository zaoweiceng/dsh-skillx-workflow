import { acceptanceDigest } from './acceptance.js';

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
  const remember = (identity, value) => {
    const key=identity+':'+acceptanceDigest(value);
    if (!seen.has(key)) {
      seen.add(key);
      task.readBytesDelivered=(task.readBytesDelivered || 0)+Buffer.byteLength(JSON.stringify(value));
    }
  };
  return {
    remember,
    beginPhase() { seen.clear(); },
    read(identity, value, continuation = false) {
      // Optional metadata fields must be omitted, not exposed as undefined to DSH.
      value = JSON.parse(JSON.stringify(value));
      if (continuation) return value;
      const digest = acceptanceDigest(value); const key = identity+':'+digest;
      if (seen.has(key)) {
        task.duplicateReadsAvoided = (task.duplicateReadsAvoided || 0) + 1;
        return {alreadyRead:true,identity,digest,instruction:'Exact data is already in this phase context. Reuse it; do not request the same unchanged field again.'};
      }
      if (Buffer.byteLength(JSON.stringify(value)) <= 10000) remember(identity,value);
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
