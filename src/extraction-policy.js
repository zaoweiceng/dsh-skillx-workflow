import { parse } from 'acorn';
import { outcomeRecordIds } from './evidence-file.js';
import { sourceEntrypoint } from './source-adapter.js';

export function assertBuildContracts(candidates, invocations) {
  const issues = [];
  for (const candidate of candidates) {
    if (candidate.execution.language !== 'typescript') continue;
    const body=parse('async function capability(){'+candidate.execution.program+'}',{ecmaVersion:'latest'}).body[0].body;
    const bindings=new Map();
    const keys=(node,seen=new Set())=>{
      if (node?.type==='Identifier' && !seen.has(node.name)) return keys(bindings.get(node.name),new Set([...seen,node.name]));
      if (node?.type!=='ObjectExpression') return undefined;
      const result=new Set();
      for (const p of node.properties) {
        if (p.type==='SpreadElement') {const nested=keys(p.argument,seen);if(!nested)return undefined;for(const k of nested)result.add(k);}
        else if (!p.computed) result.add(p.key.name ?? p.key.value); else return undefined;
      }
      return result;
    };
    const visit=node=>{
      if (!node || typeof node!=='object' || ['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)) return;
      if (node.type==='VariableDeclarator' && node.id.type==='Identifier') bindings.set(node.id.name,node.init);
      if (node.type==='ReturnStatement') {
        const supplied=keys(node.argument);
        const missing=supplied && (candidate.execution.outputSchema.required ?? []).filter(key=>!supplied.has(key));
        if (missing?.length) issues.push({code:'OUTPUT_CONTRACT',candidate:candidate.name,path:'/execution/program',fields:missing,message:'A known return object omits required output fields. Preserve the business result on every return path or declare the correct outcome-specific schema.'});
      }
      if (node.type==='CallExpression' && node.callee.object?.name==='resources' && node.callee.property?.name==='run') {
        const request=node.arguments[0];
        const field=name=>request?.type==='ObjectExpression' && request.properties.find(p=>(p.key?.name ?? p.key?.value)===name)?.value;
        const path=field('path')?.value;
        const required=typeof path==='string' && invocations.find(item=>item.script===path.split('/').pop())?.env;
        if (required && field('args')) {
          const supplied=keys(field('env'));
          const missing=required.filter(key=>!supplied?.has(key));
          if (missing.length) issues.push({code:'SOURCE_INVOCATION_ENV',candidate:candidate.name,path:'/execution/program',resourcePath:path,fields:missing,message:'Preserve the source invocation environment when extracting this CLI. Its original caller supplies these overrides; copying the script alone changes its execution/side-effect contract. Use that source operation or supply the explicit environment.'});
        }
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value==='object') visit(value);
    };
    visit(body);
  }
  if (issues.length) throw Object.assign(new Error('Executable returns or CLI invocation disagree with their contracts'),{code:'BUILD_CONTRACT',issues});
}

// Calling children and then replaying the original task entry is not composition.
// Match executable source/argv, rather than names, comments or a file checksum.
export function assertNoSourceReplay(candidates, entries) {
  const issues = [];
  for (const candidate of candidates) {
    if (!candidate.dependencies?.length || candidate.execution.language !== 'typescript') continue;
    const resources = new Map(Object.entries(candidate.resources ?? {}).flatMap(([path,body])=>{
      const entry=sourceEntrypoint(body);
      const original=entry && entries.find(item=>item.body===entry.body);
      return original ? [[path,original]] : [];
    }));
    if (!resources.size) continue;
    const bindings = new Map();
    const tree = parse('(async()=>{'+candidate.execution.program+'})',{ecmaVersion:'latest'});
    const resolve = node => node?.type==='Identifier' ? bindings.get(node.name) : node;
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type==='VariableDeclarator' && node.id.type==='Identifier') bindings.set(node.id.name,resolve(node.init));
      if (node.type==='CallExpression' && node.callee.object?.name==='resources' && node.callee.property?.name==='run') {
        const request=resolve(node.arguments[0]);
        const field=name=>request?.type==='ObjectExpression' && resolve(request.properties.find(p=>p.type==='Property' && (p.key.name ?? p.key.value)===name)?.value);
        const entry=resources.get(field('path')?.value), args=field('args');
        if (entry && args?.type==='ArrayExpression' && entry.commands.includes(args.elements[0]?.value ?? '')) issues.push({code:'SOURCE_ENTRY_REPLAY',candidate:candidate.name,path:'/execution/program',message:'This workflow invokes the original task entry after child capability calls. Aggregate child results and preserve finalization as a separate source sub-operation; do not replay the original task.'});
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value==='object') visit(value);
    };
    visit(tree);
  }
  if (issues.length) throw Object.assign(new Error('Workflow replays the source task entry'),{code:'SOURCE_ENTRY_REPLAY',issues});
}

/** Evidence size is known before dispatch; record the initial estimate for auditing, never a cancellation deadline. */
export function extractionBudget(files, { timeoutMs = 600000, maxTimeoutMs = 900000, totalTimeoutMs = 600000,
  recordsPerBudgetUnit = 100, bytesPerBudgetUnit = 262144, stageCount = 1 } = {}) {
  const records = files.reduce((sum, file) => sum + file.recordCount, 0);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const units = Math.max(1, Math.ceil(records / recordsPerBudgetUnit), Math.ceil(bytes / bytesPerBudgetUnit));
  return { mode: 'advisory', enforced: false, stageCount, records, bytes, units, baseTimeoutMs: timeoutMs,
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

// A forwarded object is a contract projection, not an arbitrary JSON bag.
// Resolve it at build time so callers need not load private child contracts.
export function bindForwardedInputs(candidates, definitions) {
  const merge = (schema, projection) => {
    if (schema.type && projection.type && schema.type !== projection.type) throw new Error('Forwarded input type conflicts with dependency contract');
    schema.type ??= projection.type;
    schema.properties ??= {};
    for (const [key, value] of Object.entries(projection.properties ?? {})) {
      if (!schema.properties[key]) schema.properties[key] = structuredClone(value);
      else if (value.type === 'object' && schema.properties[key].type === 'object') merge(schema.properties[key], value);
    }
    schema.required = [...new Set([...(schema.required ?? []),...(projection.required ?? [])])];
    if (projection.additionalProperties === false) schema.additionalProperties = false;
  };
  for (let pass = 0; pass < candidates.length; pass++) {
    let changed = false;
    for (const candidate of candidates) {
      if (candidate.execution.language !== 'typescript') continue;
      const tree = parse(`async function capability(input) {\n${candidate.execution.program}\n}`, {ecmaVersion:'latest'});
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.object?.name === 'capabilities' && node.callee.property?.name === 'run') {
          const object = node.arguments[0];
          const field = name => object?.type === 'ObjectExpression' && object.properties.find(p=>p.type==='Property' && (p.key.name ?? p.key.value)===name)?.value;
          const child = definitions.get(field('name')?.value);
          const path = []; let forwarded = field('input');
          while (forwarded?.type === 'MemberExpression' && !forwarded.computed) {path.unshift(forwarded.property.name);forwarded=forwarded.object;}
          if (forwarded?.name === 'input' && path.length && child?.execution?.inputSchema) {
            let schema = candidate.execution.inputSchema;
            for (const key of path) schema = schema?.properties?.[key];
            if (schema?.type === 'object') {
              const projection = structuredClone(child.execution.inputSchema);
              // Each child receives the invocation target from the host.
              delete projection.properties?.executionTarget;
              projection.required = (projection.required ?? []).filter(key=>key!=='executionTarget');
              const before = JSON.stringify(schema);
              merge(schema, projection);
              if (JSON.stringify(schema) !== before) changed = true;
            }
          }
        }
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      };
      visit(tree);
    }
    if (!changed) break;
  }
}

// Check only statically known top-level fields; dynamic expressions stay runtime-validated.
export function assertDependencyInputs(candidates, definitions) {
  const issues = [];
  for (const candidate of candidates) {
    if (candidate.execution.language !== 'typescript') continue;
    const tree = parse(`async function capability(input) {\n${candidate.execution.program}\n}`, {ecmaVersion:'latest'});
    const bindings = new Map(), calls = [];
    const visit = (node, discarded = false) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ExpressionStatement' && node.expression?.type === 'AwaitExpression') {
        const awaited = node.expression.argument;
        discarded = awaited?.callee?.object?.name === 'capabilities' || (awaited?.callee?.object?.name === 'Promise' && awaited?.callee?.property?.name === 'all');
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') bindings.set(node.id.name, bindings.has(node.id.name) ? null : node.init);
      if (node.type === 'CallExpression' && node.callee.object?.name === 'capabilities' && (node.callee.property?.name ?? node.callee.property?.value) === 'run') calls.push({argument:node.arguments[0],discarded});
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item=>visit(item,discarded)); else if (value && typeof value === 'object') visit(value,discarded);
    };
    visit(tree);
    const keys = (node, seen = new Set()) => {
      if (!node) return null;
      if (node.type === 'Identifier') {
        if (node.name === 'input') return new Set(Object.keys(candidate.execution.inputSchema.properties || {}));
        if (seen.has(node.name)) return null;
        return keys(bindings.get(node.name), new Set([...seen,node.name]));
      }
      if (node.type === 'MemberExpression' && !node.computed) {
        const path = []; let root = node;
        while (root?.type === 'MemberExpression' && !root.computed) {path.unshift(root.property.name);root=root.object;}
        if (root?.name === 'input') {
          let schema = candidate.execution.inputSchema;
          for (const key of path) schema = schema?.properties?.[key];
          return schema?.properties ? new Set(Object.keys(schema.properties)) : null;
        }
      }
      if (node.type !== 'ObjectExpression') return null;
      const result = new Set();
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const spread = keys(property.argument, seen); if (!spread) return null;
          for (const key of spread) result.add(key);
        } else if (!property.computed) result.add(property.key.name ?? property.key.value);
        else return null;
      }
      return result;
    };
    for (const {argument,discarded} of calls) {
      if (argument?.type !== 'ObjectExpression') continue;
      const field = name => argument.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === name)?.value;
      const callee = definitions.get(field('name')?.value);
      if (discarded && Object.values(callee?.execution?.outcome?.values || {}).some(status=>status !== 'completed')) issues.push({candidate:candidate.name,dependency:callee.name,code:'DEPENDENCY_OUTCOME_UNCHECKED',message:'Consume the child business result and propagate failure; aggregate child outputs instead of replaying the source orchestration after prechecks.'});
      const schema = callee?.execution?.inputSchema, supplied = keys(field('input'));
      if (!supplied || !schema) continue;
      // The host binds the Docker target before validating each child input.
      const missing = (schema.required || []).filter(key => !supplied.has(key) && !(key === 'executionTarget' && callee.execution.target === 'docker'));
      if (missing.length) issues.push({candidate:candidate.name,dependency:callee.name,fields:missing,message:'Supply the required dependency input fields in the caller.'});
      const unexpected = schema.additionalProperties === false ? [...supplied].filter(key => !Object.hasOwn(schema.properties || {},key)) : [];
      if (unexpected.length) issues.push({candidate:candidate.name,dependency:callee.name,fields:unexpected,message:'Pass only the dependency input fields; consume parent-only fields in the caller.'});
    }
  }
  if (issues.length) throw Object.assign(new Error('Dependency inputs or outcomes disagree with declared contracts'),{code:'DEPENDENCY_CONTRACT',issues});
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
    || !['extract', 'skip'].includes(plan.decision) || typeof plan.reason !== 'string' || !plan.reason.trim()) throw new Error('Supply a plan with decision, nonempty reason, and at most 20 candidates/reuses');
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
    for (const field of ['description','scope','reuseValue']) if (typeof candidate[field] !== 'string' || !candidate[field].trim()) add(field,'Require a nonempty string');
    // Responsibilities are the authoritative authoring form; explicit legacy edges must still agree.
    if (candidate.dependsOn === undefined && Array.isArray(candidate.responsibilities)) candidate.dependsOn = [...new Set(candidate.responsibilities.filter(r => r?.disposition === 'capability' && r.capability !== candidate.name).map(r => r.capability))];
    if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(name=>typeof name !== 'string')) add('dependsOn','Require an array of capability names');
    candidate.kind = candidate.dependsOn?.length ? 'workflow' : 'skill';
    if (!Array.isArray(candidate.sourceRecords) || !candidate.sourceRecords.length || candidate.sourceRecords.length > 32) add('sourceRecords','Require 1..32 fully read source record references');
    else for (const [j, reference] of candidate.sourceRecords.entries()) if (!reference || !files.get(reference.sessionId)?.index[reference.record] || !readRecords.get(reference.sessionId)?.has(reference.record)) add(`sourceRecords/${j}`,'Plan must cite fully read source record numbers');
    const trace = candidate.completionTrace;
    if (requireCompletionTrace || trace !== undefined) {
      if (!trace || typeof trace.goal !== 'string' || !trace.goal.trim() || typeof trace.doneWhen !== 'string' || !trace.doneWhen.trim() || !Array.isArray(trace.continuations) || trace.continuations.length > 12) add('completionTrace','Declare goal, business doneWhen and continuations:[{condition,action,sourceRecords}]; [] explicitly means no evidenced continuation');
      else for (const [j, branch] of trace.continuations.entries()) {
        if (!branch || typeof branch.condition !== 'string' || !branch.condition.trim() || typeof branch.action !== 'string' || !branch.action.trim() || !Array.isArray(branch.sourceRecords) || !branch.sourceRecords.length) { add(`completionTrace/continuations/${j}`,'Require the observed intermediate condition, subsequent action and full-read supporting records'); continue; }
        for (const reference of branch.sourceRecords) {
          if (!reference || !files.get(reference.sessionId)?.index[reference.record] || !readRecords.get(reference.sessionId)?.has(reference.record)) add(`completionTrace/continuations/${j}/sourceRecords`,'Read the actual continuation calls/results, not only an assistant summary or helper manual');
          else if (Array.isArray(candidate.sourceRecords) && !candidate.sourceRecords.some(item=>item?.sessionId===reference.sessionId && item.record===reference.record)) candidate.sourceRecords.push(reference);
        }
      }
      if (!Array.isArray(trace?.lessons) || trace.lessons.length > 12) add('completionTrace/lessons','Assess observed problems, diagnosis and verified resolutions as lessons; [] when none exist');
      else if (requireCompletionTrace && !trace.lessons.length && [...files.values()].some(file=>file.index.some(record=>record.continuationReview))) add('completionTrace/lessons','Failure/blocked signals exist in the selected evidence: assess their resolution or explicitly omit irrelevant/unsupported cases with evidence and a reason');
      else for (const [j, lesson] of trace.lessons.entries()) {
        if (!lesson || ['problem','cause','resolution','reason'].some(field=>typeof lesson[field]!=='string' || !lesson[field].trim()) || !['program','prerequisite','recovery-doc','omit'].includes(lesson.disposition) || !Array.isArray(lesson.sourceRecords) || !lesson.sourceRecords.length) {add(`completionTrace/lessons/${j}`,'Record problem, evidence-based cause (or unknown), resolution, disposition, reason and supporting sourceRecords');continue;}
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
      for (const field of ['purpose', 'reason', 'independentUse']) if (typeof responsibility[field] !== 'string' || !responsibility[field].trim()) add(`${path}/${field}`, 'Require a nonempty responsibility and independent-reuse rationale');
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
  for (const candidate of candidates) {
    const planned = plan.candidates.find(item => item.name === candidate.name);
    if (!planned) throw new Error('Preserve planned capability identities and responsibilities');
    // Plans describe responsibilities; executable calls determine edge placement.
    // Shared setup may move to a parent and pass prepared results to children.
    assertDependencyCalls(candidate);
  }
  const planned = new Map(plan.candidates.map(candidate => [candidate.name,candidate]));
  const built = new Map(candidates.map(candidate => [candidate.name,candidate]));
  const descendants = (definitions, name, dependencies) => {
    const seen = new Set([name]), pending = [...dependencies(definitions.get(name))];
    while (pending.length) {
      const next = pending.pop();
      if (seen.has(next) || !definitions.has(next)) continue;
      seen.add(next); pending.push(...dependencies(definitions.get(next)));
    }
    seen.delete(name); return seen;
  };
  const referenced = new Set(plan.candidates.flatMap(candidate => candidate.dependsOn || []));
  const issues = [];
  for (const root of plan.candidates.filter(candidate => !referenced.has(candidate.name))) {
    const expected = descendants(planned,root.name,candidate=>candidate.dependsOn || []);
    const actual = descendants(built,root.name,candidate=>(candidate.dependencies || []).map(dependency=>dependency.name));
    const missing = [...expected].filter(name=>!actual.has(name));
    if (missing.length) issues.push({candidate:root.name,code:'PLAN_RESPONSIBILITY_UNREACHABLE',missing,message:'Preserve the planned reusable operations in the root call graph; edge placement may change, but publishing unused operations does not implement them.'});
  }
  if (issues.length) throw Object.assign(new Error('Planned responsibilities became unreachable from their root'),{code:'PLAN_RESPONSIBILITY_UNREACHABLE',issues});
}
