import { parse } from 'acorn';
import { outcomeRecordIds } from './evidence-file.js';

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
  if(candidate.execution.language==='python'){if(candidate.dependencies?.length)throw new Error('Compose declared dependencies with a JavaScript workflow and reusable Python capabilities');return;}
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

export function assertOutcomeEvidenceRead(files, readRecords) {
  const missing = [...files].flatMap(([sessionId, file]) => outcomeRecordIds(file)
    .filter(record => !readRecords.get(sessionId)?.has(record)).map(record => ({ sessionId, record })));
  if (missing.length) throw Object.assign(new Error(JSON.stringify({ code: 'OUTCOME_EVIDENCE_REQUIRED', missing,
    instruction: 'Read these terminal observations completely with read_native_execution before submission. Follow every nextPartCursor; summaries, indexes and excerpts are insufficient. Distinguish command failure from tool transport success.' })), { code: 'OUTCOME_EVIDENCE_REQUIRED' });
}

export async function validateExtractionPlan(plan, { files, readRecords, readVersions, readRevisionIds, store, requireCompletionTrace = false }) {
  if (!plan || !Array.isArray(plan.candidates) || !Array.isArray(plan.reuseNames)
    || plan.candidates.length > 20 || plan.reuseNames.length > 20
    || !['extract', 'skip'].includes(plan.decision) || typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 1000 || Buffer.byteLength(JSON.stringify(plan)) > 16000) throw new Error('Supply a concise plan of at most 20 candidates/reuses, 16 KB total');
  plan = structuredClone(plan);
  assertOutcomeEvidenceRead(files, readRecords);
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
    const trace = candidate.completionTrace;
    if (requireCompletionTrace || trace !== undefined) {
      if (!trace || typeof trace.goal !== 'string' || !trace.goal.trim() || typeof trace.doneWhen !== 'string' || !trace.doneWhen.trim() || trace.goal.length > 400 || trace.doneWhen.length > 600 || !Array.isArray(trace.continuations) || trace.continuations.length > 12) add('completionTrace','Declare goal, business doneWhen and continuations:[{condition,action,sourceRecords}]; [] explicitly means no evidenced continuation');
      else for (const [j, branch] of trace.continuations.entries()) {
        if (!branch || typeof branch.condition !== 'string' || !branch.condition.trim() || typeof branch.action !== 'string' || !branch.action.trim() || branch.condition.length > 400 || branch.action.length > 600 || !Array.isArray(branch.sourceRecords) || !branch.sourceRecords.length) { add(`completionTrace/continuations/${j}`,'Require the observed intermediate condition, subsequent action and full-read supporting records'); continue; }
        for (const reference of branch.sourceRecords) {
          if (!reference || !files.get(reference.sessionId)?.index[reference.record] || !readRecords.get(reference.sessionId)?.has(reference.record)) add(`completionTrace/continuations/${j}/sourceRecords`,'Read the actual continuation calls/results, not only an assistant summary or helper manual');
          else if (Array.isArray(candidate.sourceRecords) && !candidate.sourceRecords.some(item=>item?.sessionId===reference.sessionId && item.record===reference.record)) candidate.sourceRecords.push(reference);
        }
      }
      if (!Array.isArray(trace?.lessons) || trace.lessons.length > 12) add('completionTrace/lessons','Assess observed problems, diagnosis and verified resolutions as lessons; [] when none exist');
      else if (requireCompletionTrace && !trace.lessons.length && [...files.values()].some(file=>file.index.some(record=>record.continuationReview))) add('completionTrace/lessons','Failure/blocked signals exist in the selected evidence: assess their resolution or explicitly omit irrelevant/unsupported cases with evidence and a reason');
      else for (const [j, lesson] of trace.lessons.entries()) {
        if (!lesson || ['problem','cause','resolution','reason'].some(field=>typeof lesson[field]!=='string' || !lesson[field].trim() || lesson[field].length>600) || !['program','prerequisite','recovery-doc','omit'].includes(lesson.disposition) || !Array.isArray(lesson.sourceRecords) || !lesson.sourceRecords.length) {add(`completionTrace/lessons/${j}`,'Record problem, evidence-based cause (or unknown), resolution, disposition, reason and supporting sourceRecords');continue;}
        for (const reference of lesson.sourceRecords) {
          if (!reference || !files.get(reference.sessionId)?.index[reference.record] || !readRecords.get(reference.sessionId)?.has(reference.record)) add(`completionTrace/lessons/${j}/sourceRecords`,'Read original problem and resolution observations completely');
          else if (Array.isArray(candidate.sourceRecords) && !candidate.sourceRecords.some(item=>item?.sessionId===reference.sessionId && item.record===reference.record)) candidate.sourceRecords.push(reference);
        }
      }
    }
    const responsibilities = candidate.responsibilities;
    if (!Array.isArray(responsibilities) || !responsibilities.length || responsibilities.length > 12) add('responsibilities', 'Every candidate requires 1..12 responsibility decisions; assess independent operations before choosing skill/workflow, with no count quota');
    else for (const [j, responsibility] of responsibilities.entries()) {
      const path = `responsibilities/${j}`;
      if (!responsibility || typeof responsibility !== 'object') { add(path, 'Require a responsibility decision'); continue; }
      for (const field of ['purpose', 'reason', 'independentUse']) if (typeof responsibility[field] !== 'string' || !responsibility[field].trim() || responsibility[field].length > 400) add(`${path}/${field}`, 'Require a concise nonempty responsibility and independent-reuse rationale, at most 400 characters');
      // The candidate already publishes its own primary responsibility: no self-edge.
      if (responsibility.disposition === 'capability' && responsibility.capability === candidate.name) responsibility.disposition = 'self';
      if (responsibility.disposition === 'self' && responsibility.capability !== undefined && responsibility.capability !== candidate.name) add(`${path}/capability`, 'Self responsibility must name this candidate or omit capability');
      if (!['self', 'capability', 'inline'].includes(responsibility.disposition)) add(`${path}/disposition`, 'Choose self for this candidate’s own published responsibility, capability for a separate dependency, inline for internal glue');
      if (responsibility.disposition === 'capability' && (!responsibility.capability || !candidate.dependsOn?.includes(responsibility.capability))) add(`${path}/capability`, 'Extract or reuse this capability and include it in dependsOn');
      if (responsibility.disposition === 'inline' && responsibility.capability !== undefined) add(`${path}/capability`, 'Inline responsibilities cannot declare a capability');
    }
    // Older drafts may have added a self-edge while repairing ownership metadata.
    if (Array.isArray(candidate.dependsOn) && Array.isArray(responsibilities) && responsibilities.some(item => item?.disposition === 'self' && item.capability === candidate.name)) candidate.dependsOn = candidate.dependsOn.filter(name => name !== candidate.name);
    if (Array.isArray(candidate.dependsOn)) for (const name of candidate.dependsOn) if (!(Array.isArray(responsibilities) && responsibilities.some(item => item?.disposition === 'capability' && item.capability === name))) add('responsibilities', 'Explain each dependency responsibility: ' + name);
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
  const issues = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const planned = plan.candidates.find(item => item.name === candidate.name);
    if (!planned || planned.kind !== candidate.kind || [...planned.dependsOn].sort().join('\0') !== (candidate.dependencies || []).map(item => item.name).sort().join('\0')) throw new Error('Candidate identity/dependencies differ from the saved plan');
    assertDependencyCalls(candidate);
    for (const branch of planned.completionTrace?.continuations ?? []) {
      const coverage = candidate.completionCoverage?.find(item=>item.condition===branch.condition);
      const bodies = [candidate.execution.program,...Object.values(candidate.resources ?? {})];
      if (!coverage || typeof coverage.implementation !== 'string' || coverage.implementation.trim().length < 8 || !bodies.some(body=>body.includes(coverage.implementation))) issues.push({code:'COMPLETION_COVERAGE_INVALID',candidate:candidate.name,path:'/candidates/'+candidateIndex+'/completionCoverage',condition:branch.condition,message:'completionCoverage.implementation must be an exact existing nontrivial code fragment, with no ellipses or pseudocode. If behavior already exists, repair this coverage field rather than rewriting the program. If behavior is missing, implement it and cite the actual code.'});
    }
    for (const lesson of planned.completionTrace?.lessons ?? []) {
      if (lesson.disposition === 'omit') continue;
      const coverage = candidate.lessonCoverage?.find(item=>item.problem===lesson.problem);
      const bodies = lesson.disposition==='program' ? [candidate.execution.program,...Object.values(candidate.resources ?? {})] : lesson.disposition==='prerequisite' ? [...(candidate.compatibility?.requirements ?? []),candidate.compatibility?.limitations ?? ''] : Object.values(candidate.docs ?? {});
      if (!coverage || typeof coverage.implementation !== 'string' || coverage.implementation.trim().length<8 || !bodies.some(body=>body.includes(coverage.implementation))) issues.push({code:'LESSON_COVERAGE_INVALID',candidate:candidate.name,path:'/candidates/'+candidateIndex+'/lessonCoverage',problem:lesson.problem,destination:lesson.disposition,message:'lessonCoverage.implementation must quote an exact existing nontrivial fragment in its declared destination, without ellipses. Repair the coverage field if the solution is already implemented.'});
    }
  }
  if (issues.length) throw Object.assign(new Error('Repair all listed completion/lesson coverage fields'),{code:'COVERAGE_INVALID',issues});
}
