import { createHash } from 'node:crypto';

/** Convert logged messages and paired tool results, preserving reported evidence. */
export function extractionSnapshot(sessionId, snapshot) {
  const messages = [];
  const calls = new Map();
  const toolEvidence = [];
  const observedOutputs = new Map();
  let title = 'DSH 对话';
  let cwd = snapshot.session.cwd;
  for (const event of snapshot.events) {
    const data = event.data;
    if (event.type === 'working-directory/change' && typeof data.cwd === 'string') cwd = data.cwd;
    if (event.type === 'session/title' && typeof data.title === 'string') title = data.title;
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      const message = data.message || data;
      // DSH logs skill catalogs, loaded instructions and agent notices as user
      // messages too. They are context, not human requests or execution evidence.
      if (event.type === 'user/message' && message.source?.kind && message.source.kind !== 'user') continue;
      const blocks = Array.isArray(message.content) ? message.content.filter(block => block.type !== 'reasoning') : message.content;
      const content = typeof blocks === 'string' ? blocks : blocks?.length ? JSON.stringify(blocks) : '';
      if (content) messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', content });
    }
    if (event.type === 'tool/call') calls.set(data.callId, data);
    if (event.type === 'tool/result') {
      const result = data.message;
      const call = calls.get(result.toolCallId);
      if (!call) continue;
      let input;
      try { input = JSON.parse(call.arguments); } catch { input = call.arguments; }
      const status = result.isError ? 'failed' : 'succeeded';
      const outputDigest = createHash('sha256').update(JSON.stringify(result.content)).digest('hex');
      const identity = JSON.stringify([call.name, input, status, outputDigest]);
      const original = observedOutputs.get(identity);
      const evidence = { id: String(call.callId), name: call.name, status, input,
        ...(original ? { outputReference: { sessionId, toolCallId: original.id, resultSeq: original.resultSeq, sha256: outputDigest } } : { output: result.content }),
        turn: call.turn, step: call.step, resultSeq: event.seq, resultTime: event.time };
      toolEvidence.push(evidence);
      if (!original) observedOutputs.set(identity, evidence);
    }
  }
  if (!messages.length) throw new Error('对话暂无可提取内容');
  const body = { sessionId, title: title.slice(0, 200), cwd, messages, toolEvidence };
  if (messages.length > 500 || toolEvidence.length > 500 || messages.some(m => m.content.length > 65536) || Buffer.byteLength(JSON.stringify(body)) > 1048576) {
    throw new Error('对话超过提取上限，请选择较短的对话；未截断或发送部分证据。');
  }
  return body;
}

/** Canonical evidence once, plus small measured indexes for comparison/discovery. */
export function executionEvidence(sessionId, snapshot) {
  const source = extractionSnapshot(sessionId, snapshot);
  const steps = new Map();
  const controls = [];
  const calls = new Map();
  const completed = new Set(source.toolEvidence.map(call => call.id));
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  for (const event of snapshot.events) {
    const d = event.data || {};
    const key = `${d.turn}:${d.step}`;
    if (event.type === 'step/start') steps.set(key, { turn: d.turn, step: d.step, startedAt: event.time, usage: [], tools: [] });
    const step = steps.get(key);
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      // An attempt stores usage/finish inside its compact stream. A successful
      // message may also expose the same usage at top level; count it once.
      const streamUsage = Array.isArray(d.stream) ? d.stream.findLast(record => record.chunk?.type === 'usage')?.chunk.usage : undefined;
      const usage = d.usage && typeof d.usage === 'object' ? d.usage : streamUsage;
      if (step && usage) step.usage.push(usage);
      if (step && number(event.time) !== undefined && number(step.startedAt) !== undefined) step.modelElapsedMs = event.time - step.startedAt;
    }
    if (event.type === 'tool/call') {
      calls.set(d.callId, { ...d, time: event.time, seq: event.seq });
      step?.tools.push({ id: d.callId, name: d.name, argumentBytes: Buffer.byteLength(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments || {})) });
    }
    if (event.type === 'tool/result') {
      const call = calls.get(d.message?.toolCallId);
      const evidence = source.toolEvidence.find(item => item.id === String(d.message?.toolCallId));
      if (call && evidence) Object.assign(evidence, { callSeq: call.seq, calledAt: call.time,
        elapsedMs: number(event.time) !== undefined && number(call.time) !== undefined ? event.time - call.time : undefined });
    }
    if (event.type === 'step/end' && step) step.endedAt = event.time;
    // Keep failure/termination evidence, without duplicating all call/result bodies.
    if (event.type === 'assistant/attempt') {
      // Failed-attempt accounting and errors matter; replaying private reasoning
      // into another author adds no execution evidence. Original logs stay intact.
      controls.push({ ...event, data: { ...d, ...(Array.isArray(d.stream) ? { stream: d.stream.filter(record => !String(record.chunk?.type || '').startsWith('reasoning')) } : {}) } });
    } else if (['turn/end', 'tool/ptc-dispatch'].includes(event.type)) controls.push(event);
  }
  source.incompleteCalls = [...calls.values()].filter(call => !completed.has(String(call.callId)));
  source.executionRecords = controls;
  source.performance = { firstEventAt: snapshot.events[0]?.time, lastEventAt: snapshot.events.at(-1)?.time,
    steps: [...steps.values()], outcomes: controls.filter(e => e.type === 'turn/end').map(e => e.data.reason) };
  return source;
}

/** Resolve a lossless duplicate-result reference against the same frozen snapshot. */
export function resolveToolEvidenceOutput(source, callId) {
  const entry = source.toolEvidence.find(item => item.id === String(callId));
  if (!entry) throw new Error('Unknown evidence call');
  if (!entry.outputReference) return entry.output;
  const reference = entry.outputReference;
  if (reference.sessionId !== source.sessionId) throw new Error('Cross-session evidence reference');
  const original = source.toolEvidence.find(item => item.id === reference.toolCallId && item.resultSeq === reference.resultSeq);
  if (!original || original.outputReference || createHash('sha256').update(JSON.stringify(original.output)).digest('hex') !== reference.sha256) throw new Error('Evidence reference identity mismatch');
  return original.output;
}
