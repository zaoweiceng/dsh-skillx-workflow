import { parse } from 'acorn';

/** Evidence size is known before dispatch; freeze the calculated budget for auditing. */
export function extractionBudget(files, { timeoutMs = 600000, maxTimeoutMs = 900000, totalTimeoutMs = 600000,
  recordsPerBudgetUnit = 100, bytesPerBudgetUnit = 262144, stageCount = 1 } = {}) {
  const records = files.reduce((sum, file) => sum + file.recordCount, 0);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const units = Math.max(1, Math.ceil(records / recordsPerBudgetUnit), Math.ceil(bytes / bytesPerBudgetUnit));
  return { mode: 'evidence-size', stageCount, records, bytes, units, baseTimeoutMs: timeoutMs,
    maxTimeoutMs, totalTimeoutMs, recordsPerBudgetUnit, bytesPerBudgetUnit, timeoutMs: Math.min(totalTimeoutMs, maxTimeoutMs, timeoutMs * units) };
}

export function assertDependencyCalls(candidate) {
  const tree = parse(`async function capability(input, tools, capabilities) {\n${candidate.execution.program}\n}`, { ecmaVersion: 'latest' });
  const calls = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'capabilities'
      && (node.callee.computed ? node.callee.property.value : node.callee.property.name) === 'run') {
      const argument = node.arguments[0];
      const name = argument?.type === 'ObjectExpression' && argument.properties.find(property =>
        property.type === 'Property' && !property.computed && (property.key.name ?? property.key.value) === 'name');
      if (name?.value.type !== 'Literal' || typeof name.value.value !== 'string') throw new Error('Dependency calls must use literal names from the extraction plan');
      calls.add(name.value.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(tree);
  const declared = new Set((candidate.dependencies || []).map(dependency => dependency.name));
  if ([...calls].some(name => !declared.has(name)) || [...declared].some(name => !calls.has(name))) {
    throw new Error('Declared dependencies must match actual literal capabilities.run calls');
  }
}

export async function validateExtractionPlan(plan, { files, readRecords, readVersions, readRevisionIds, store }) {
  if (!plan || !Array.isArray(plan.candidates) || !Array.isArray(plan.reuseNames)
    || plan.candidates.length > 20 || plan.reuseNames.length > 20
    || !['extract', 'skip'].includes(plan.decision) || typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 1000 || Buffer.byteLength(JSON.stringify(plan)) > 16000) throw new Error('Supply a concise plan of at most 20 candidates/reuses, 16 KB total');
  if (plan.decision === 'skip') {
    if (plan.candidates.length || plan.reuseNames.length) throw new Error('Skip cannot include candidates or reuse targets');
    if ([...files.keys()].some(id => !readRecords.get(id)?.size)) throw new Error('Read source evidence before deciding to skip');
    return structuredClone(plan);
  }
  if (!plan.candidates.length && !plan.reuseNames.length) throw new Error('Use decision=skip with a reason when nothing is worth extracting');
  const names = new Set();
  const issues = [];
  for (const [index, candidate] of plan.candidates.entries()) {
    const add = (field, message) => issues.push({ code:'INVALID_PLAN_FIELD', candidate:candidate?.name, path:`/candidates/${index}/${field}`, field, message });
    if (!candidate || typeof candidate !== 'object') { add('', 'Expected a candidate object'); continue; }
    if (typeof candidate.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name) || names.has(candidate.name)) add('name','Require a unique kebab-case name');
    if (!['skill','workflow'].includes(candidate.kind)) add('kind','Require skill or workflow');
    for (const [field, limit] of [['description',300],['scope',800],['reuseValue',400]]) if (typeof candidate[field] !== 'string' || !candidate[field].trim() || candidate[field].length > limit) add(field,`Require a nonempty string of at most ${limit} characters; received ${typeof candidate[field] === 'string' ? candidate[field].length : typeof candidate[field]}`);
    if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(name=>typeof name !== 'string')) add('dependsOn','Require an array of capability names');
    if (!Array.isArray(candidate.sourceRecords) || !candidate.sourceRecords.length || candidate.sourceRecords.length > 32) add('sourceRecords','Require 1..32 fully read source record references');
    else for (const [j, reference] of candidate.sourceRecords.entries()) if (!reference || !files.get(reference.sessionId)?.index[reference.record] || !readRecords.get(reference.sessionId)?.has(reference.record)) add(`sourceRecords/${j}`,'Plan must cite fully read source record numbers');
    if (typeof candidate.name === 'string' && await store.get(candidate.name, { includeDisabled:true })) add('name','Plan duplicates an existing capability; read and explicitly reuse it');
    names.add(candidate.name);
  }
  if (issues.length) throw Object.assign(new Error(JSON.stringify({code:'PLAN_VALIDATION_FAILED',issues})),{code:'PLAN_VALIDATION_FAILED',issues});
  const newReuses = plan.reuseNames.filter(name => names.has(name));
  if (newReuses.length) throw new Error('reuseNames is only for unchanged entries in the existing catalog, not new candidates: ' + newReuses.join(', ') + '. Remove these from reuseNames; use dependsOn for references between new candidates. An empty catalog requires reuseNames: [].');
  for (const name of plan.reuseNames) {
    const existing = await store.get(name);
    if (!existing) throw new Error('reuseNames entry is absent or disabled: ' + name + '. Only existing enabled catalog entries can be reused; do not query invented names.');
    if (readVersions.get(name) !== existing.version || (readRevisionIds && readRevisionIds.get(name) !== existing.revisionId)) throw new Error('Read exact current capability before planning reuse: ' + name);
  }
  const visiting = new Set(), visited = new Set();
  const walk = async candidate => {
    if (visiting.has(candidate.name)) throw new Error('Extraction plan dependency cycle');
    if (visited.has(candidate.name)) return;
    visiting.add(candidate.name);
    for (const name of candidate.dependsOn) {
      const local = plan.candidates.find(item => item.name === name);
      if (local) await walk(local);
      else {
        const existing = await store.get(name);
        if (!existing || readVersions.get(name) !== existing.version || (readRevisionIds && readRevisionIds.get(name) !== existing.revisionId)) throw new Error('Read exact existing dependency before planning it: ' + name);
      }
    }
    visiting.delete(candidate.name); visited.add(candidate.name);
  };
  for (const candidate of plan.candidates) await walk(candidate);
  return structuredClone(plan);
}

export function assertPlanSubmission(plan, candidates, reuseNames) {
  if (candidates.length !== plan.candidates.length || [...reuseNames].sort().join('\0') !== [...plan.reuseNames].sort().join('\0')) throw new Error('Build only the saved extraction plan');
  for (const candidate of candidates) {
    const planned = plan.candidates.find(item => item.name === candidate.name);
    if (!planned || planned.kind !== candidate.kind || [...planned.dependsOn].sort().join('\0') !== (candidate.dependencies || []).map(item => item.name).sort().join('\0')) throw new Error('Candidate identity/dependencies differ from the saved plan');
    assertDependencyCalls(candidate);
  }
}
