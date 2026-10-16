import { readdir, readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ended = new Set(['completed', 'failed', 'blocked']);
async function entries(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe monitoring directory'); return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function json(path) {
  try { if (!(await lstat(path)).isFile()) throw new Error('Unsafe monitoring file'); return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function monitoringRange(params) {
  const start = Date.parse(params.get('start')), end = Date.parse(params.get('end'));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400000) throw new Error('Invalid monitoring range (maximum 366 days)');
  return { start, end };
}
function offsetOf(params) {
  const value = Number(params.get('offset') ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid offset');
  return value;
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|api.?key|cookie|credential/i.test(key) && !/tokens$|tokenCount/i.test(key) ? '[REDACTED]' : redact(item)]));
  if (typeof value === 'string') return value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[\w-]{12,}\b/g, '[REDACTED]');
  return value;
}
function tokensOf(usage) {
  if (!Array.isArray(usage)) return null;
  let known = false, total = 0;
  for (const item of usage) {
    const value = Number.isFinite(item?.totalTokens) ? item.totalTokens : Number.isFinite(item?.inputTokens) && Number.isFinite(item?.outputTokens) ? item.inputTokens + item.outputTokens : null;
    if (value !== null && value >= 0) { total += value; known = true; }
  }
  return known ? total : null;
}
export function createNativeMonitoring({ dataRoot, store, learningService, sessionQuery }) {
  async function scan(range) {
    const rows = [], warnings = [];
    const catalog = new Map((await store.list(undefined, { includeDisabled: true })).map(row => [row.name, row.kind]));
    for (const entry of await entries(join(dataRoot, 'executions'))) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      try {
        const directory = join(dataRoot, 'executions', entry.name);
        const header = await json(join(directory, 'header.json'));
        const createdAt = header?.startedAt, time = Date.parse(createdAt);
        if (!(time >= range.start && time < range.end)) continue;
        const receipt = (await json(join(directory, 'resolved.json')))?.receipt ?? await json(join(directory, 'receipt.json'));
        const capability = { ...header.capability, ...receipt?.capability };
        let kind = capability.kind;
        if (!kind && uuid.test(capability.revisionId)) kind = (await json(join(dataRoot, 'revisions', capability.revisionId + '.json')))?.kind;
        kind ??= catalog.get(capability.name);
        rows.push({ id: entry.name, type: 'execution', name: capability?.name ?? '—', kind, createdAt,
          revisionId: capability.revisionId, sessionId: header.sessionId ?? receipt?.relatedSessions?.[0], executionContext: header.executionContext, status: receipt?.status ?? 'unfinished', tokens: tokensOf(receipt?.usage), usageComplete: receipt?.usageComplete === true, durationMs: receipt?.finishedAt ? Math.max(0, Date.parse(receipt.finishedAt) - time) : null });
      } catch { warnings.push(entry.name); }
    }
    for (const entry of await entries(join(dataRoot, 'jobs'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid.test(entry.name.slice(0, -5))) continue;
      try {
        const task = await learningService.get(entry.name.slice(0, -5));
        const time = Date.parse(task?.createdAt);
        if (!(time >= range.start && time < range.end)) continue;
        rows.push({ id: task.taskId, type: 'learning', name: task.name ?? task.operation, kind: 'learning', createdAt: task.createdAt, sessionId: task.generatorSessionId,
          status: task.status, outcome: task.outcome, tokens: tokensOf(task.usage), usageComplete: task.usageComplete === true, reason: typeof task.error === 'string' ? task.error : task.error?.code,
          durationMs: task.finishedAt ? Math.max(0, Date.parse(task.finishedAt) - time) : null });
      } catch { warnings.push(entry.name); }
    }
    return { rows: rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), warnings };
  }
  async function records(id, params) {
    if (!uuid.test(id)) throw new Error('Invalid execution ID');
    const directory = join(dataRoot, 'executions', id);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe execution directory');
    const path = join(directory, 'events.jsonl');
    if (!(await lstat(path)).isFile()) throw new Error('Unsafe execution records');
    const offset = offsetOf(params), items = [];
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0, more = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (index++ < offset) continue;
        if (items.length === 50) { more = true; break; }
        try { items.push(redact(JSON.parse(line))); } catch { items.push({ type: 'incomplete_record' }); }
      }
    } finally { lines.close(); stream.destroy(); }
    return { items, nextOffset: more ? offset + 50 : null };
  }
  // Follow the executed immutable revision back to its original extraction;
  // optimization evidence is not the unoptimized workflow baseline.
  async function estimateSavings(rows) {
    const jobs = new Map(), baselines = new Map(), sourceUsage = new Map();
    for (const entry of await entries(join(dataRoot, 'jobs'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid.test(entry.name.slice(0, -5))) continue;
      try { const job = await json(join(dataRoot, 'jobs', entry.name)); if (job?.generatorSessionId) jobs.set(job.generatorSessionId, job); } catch {}
    }
    const completeUsage = usage => Array.isArray(usage) && usage.length > 0 && usage.every(item => tokensOf([item]) !== null) ? tokensOf(usage) : null;
    async function baseline(revisionId) {
      if (!uuid.test(revisionId)) return null;
      if (baselines.has(revisionId)) return baselines.get(revisionId);
      const pending = (async () => {
        let revision = await json(join(dataRoot, 'revisions', revisionId + '.json'));
        const visited = new Set([revisionId]);
        while (revision?.previousRevisionId) {
          if (!uuid.test(revision.previousRevisionId) || visited.has(revision.previousRevisionId)) return null;
          visited.add(revision.previousRevisionId);
          revision = await json(join(dataRoot, 'revisions', revision.previousRevisionId + '.json'));
        }
        if (revision?.operation !== 'extract') return null;
        const job = jobs.get(revision.generatorSessionId);
        if (!job || !uuid.test(job.taskId)) return null;
        const sources = await json(join(dataRoot, 'jobs', job.taskId + '.sources.json'));
        const ids = [...new Set(job.sourceSessionIds ?? [job.sourceSessionId])].filter(id => typeof id === 'string');
        const measured = [];
        for (const id of ids) {
          const cacheKey = job.taskId + ':' + id;
          if (!sourceUsage.has(cacheKey)) {
            const source = sources?.find(item => item.sessionId === id);
            const steps = source?.performance?.steps;
            let tokens = null;
            if (steps?.length) {
              const totals = steps.map(step => completeUsage(step.usage));
              if (totals.every(total => total !== null)) tokens = totals.reduce((sum, total) => sum + total, 0);
            } else if (sessionQuery?.readSession) {
              // Legacy extractions did not save performance snapshots. Freeze
              // the logical source at extraction time, excluding later turns.
              const snapshot = await sessionQuery.readSession(id);
              const cutoff = Date.parse(job.createdAt);
              const settlements = snapshot.events.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type) && (typeof event.time === 'number' ? event.time : Date.parse(event.time)) <= cutoff);
              tokens = completeUsage(settlements.map(event => event.data.usage ?? event.data.stream?.findLast(record => record.chunk?.type === 'usage')?.chunk.usage));
            }
            sourceUsage.set(cacheKey, tokens);
          }
          const tokens = sourceUsage.get(cacheKey);
          if (tokens !== null) measured.push(tokens);
        }
        // Partial original samples would bias savings upward or downward.
        if (!measured.length || measured.length !== ids.length) return null;
        return { tokens: measured.reduce((sum, value) => sum + value, 0) / measured.length, samples: measured.length };
      })().catch(() => null);
      baselines.set(revisionId, pending);
      return pending;
    }
    async function executionUsage(row) {
      const directory = join(dataRoot, 'executions', row.id);
      const receipt = (await json(join(directory, 'resolved.json')))?.receipt ?? await json(join(directory, 'receipt.json'));
      const related = [...new Set([...(receipt.relatedSessions ?? []), ...(receipt.recoveryRuns ?? []).map(run => run.sessionId)])];
      if (related.length) {
        let total = 0;
        for (const id of related) {
          if (!uuid.test(id)) return null;
          const run = await json(join(dataRoot, 'recovery', id + '.json')) ?? receipt.recoveryRuns?.find(run => run.sessionId === id);
          const tokens = completeUsage(run?.usage);
          if (run?.usageComplete !== true || tokens === null) return null;
          total += tokens;
        }
        // Receipt usage already contains reasoning sessions; do not add twice.
        return total;
      }
      if (receipt.usage?.length) return receipt.usageComplete === true ? completeUsage(receipt.usage) : null;
      let next = 0, executionEnded = false;
      do {
        const page = await records(row.id, new URLSearchParams({ offset: String(next) }));
        if (page.items.some(item => item.type.startsWith('reasoning/') || item.type === 'incomplete_record')) return null;
        executionEnded ||= page.items.some(item => item.type === 'execution/end' && item.status === 'completed');
        next = page.nextOffset;
      } while (next !== null);
      // A completed deterministic program with no model sessions uses zero
      // internal LLM tokens. This does not assume its calling chat is free.
      return executionEnded && receipt.status === 'completed' && !receipt.recovered ? 0 : null;
    }
    for (const row of rows.filter(row => row.type === 'execution' && row.status === 'completed')) {
      try {
        const original = await baseline(row.revisionId), actual = await executionUsage(row);
        if (original && actual !== null) Object.assign(row, { baselineTokens: original.tokens, executionTokens: actual, savedTokens: original.tokens - actual, baselineSamples: original.samples });
      } catch { /* Unavailable comparisons remain excluded, never estimated as zero. */ }
    }
  }
  async function metric(key, params) {
    if (!['tokens', 'savings', 'success', 'failure', 'skillx', 'workflow', 'duration', 'reasons'].includes(key)) throw new Error('Unknown monitoring metric');
    const range = monitoringRange(params), { rows, warnings } = await scan(range);
    if (key === 'savings') await estimateSavings(rows);
    const completed = rows.filter(row => ended.has(row.status));
    const valueOf = group => {
      if (key === 'savings') { const known = group.filter(row => Number.isFinite(row.savedTokens)); return known.length ? known.reduce((sum, row) => sum + row.savedTokens, 0) : null; }
      if (key === 'tokens') { const known = group.filter(row => row.tokens !== null); return known.length ? known.reduce((sum, row) => sum + row.tokens, 0) : group.length ? null : 0; }
      if (key === 'skillx' || key === 'workflow') return group.filter(row => row.type === 'execution' && row.kind === (key === 'skillx' ? 'skill' : 'workflow')).length;
      const done = group.filter(row => ended.has(row.status));
      return done.length ? 100 * done.filter(row => key === 'success' ? row.status === 'completed' : row.status !== 'completed').length / done.length : null;
    };
    const span = range.end - range.start;
    const intervalMs = span <= 3600000 ? 300000 : span <= 10800000 ? 900000 : span <= 43200000 ? 1800000 : span <= 3 * 86400000 ? 3600000 : Math.ceil(span / (90 * 86400000)) * 86400000;
    const series = [];
    for (let start = range.start; start < range.end; start += intervalMs) {
      const end = Math.min(range.end, start + intervalMs), group = rows.filter(row => Date.parse(row.createdAt) >= start && Date.parse(row.createdAt) < end);
      series.push({ start: new Date(start).toISOString(), value: valueOf(group), samples: group.length });
    }
    const result = { value: ['duration', 'reasons'].includes(key) ? null : valueOf(rows), series, tasks: rows.length, completed: completed.length, cancelled: rows.filter(row => row.status === 'cancelled').length,
      incompleteTasks: key === 'tokens' ? rows.filter(row => row.tokens === null || !row.usageComplete).length : 0, skippedRecords: warnings.length };
    if (key === 'savings') {
      const known = rows.filter(row => Number.isFinite(row.savedTokens));
      result.estimatedExecutions = known.length;
      result.excludedExecutions = rows.filter(row => row.type === 'execution' && row.status === 'completed').length - known.length;
      result.baselineTokens = known.reduce((sum, row) => sum + row.baselineTokens, 0);
      result.executionTokens = known.reduce((sum, row) => sum + row.executionTokens, 0);
      result.savingsRate = result.baselineTokens > 0 ? 100 * result.value / result.baselineTokens : null;
    }
    if (key === 'duration') result.ranking = completed.filter(row => Number.isFinite(row.durationMs)).sort((a, b) => b.durationMs - a.durationMs);
    if (key === 'reasons') {
      const reasons = new Map();
      for (const row of completed.filter(row => row.status !== 'completed')) {
        let reason = row.reason;
        if (row.type === 'execution') {
          try {
            let next = 0;
            do { const page = await records(row.id, new URLSearchParams({ offset: String(next) })); reason = page.items.findLast(item => item.type === 'execution/end')?.failure?.code ?? reason; next = page.nextOffset; } while (next !== null);
          } catch { result.skippedRecords++; }
        }
        reason ||= 'UNKNOWN'; reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      result.items = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    }
    return redact(result);
  }
  return { metric, records, async sessions(params) { const { rows, warnings } = await scan(monitoringRange(params)); const offset = offsetOf(params); return { items: redact(rows.slice(offset, offset + 30)), total: rows.length, skippedRecords: warnings.length }; } };
}
