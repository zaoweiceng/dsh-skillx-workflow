import { Script } from 'node:vm';
import { parse } from 'acorn';
import { assertSupportedJsonSchema, assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const MAX_SCHEMA_DEPTH = 32;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function normalizeOutcome(outcome) {
  if (outcome === undefined) return undefined;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || Object.keys(outcome).some(key=>!['path','values','reasonPath'].includes(key))) throw new Error('Invalid execution.outcome declaration');
  const pointer = value => typeof value==='string' && (value==='' || (value.startsWith('/') && !/~(?![01])/.test(value)));
  if (!pointer(outcome.path) || (outcome.reasonPath!==undefined && !pointer(outcome.reasonPath)) || !outcome.values || typeof outcome.values!=='object' || Array.isArray(outcome.values) || !Object.keys(outcome.values).length || Object.entries(outcome.values).some(([key,value])=>!key || !['completed','blocked','failed','partial'].includes(value))) throw new Error('execution.outcome requires a JSON pointer path and values mapping reported scalar strings to completed/blocked/failed/partial');
  return structuredClone(outcome);
}

export function businessOutcome(execution, output) {
  const mapping = normalizeOutcome(execution?.outcome);
  if (!mapping) return {status:'unknown'};
  const read = path => {
    let value=output;
    for (const key of path === '' ? [] : path.slice(1).split('/').map(key=>key.replace(/~1/g,'/').replace(/~0/g,'~'))) {
      if (value===null || typeof value!=='object' || !Object.hasOwn(value,key)) return undefined;
      value=value[key];
    }
    return value;
  };
  const value=read(mapping.path);
  const key = value===null ? 'null' : ['string','number','boolean'].includes(typeof value) ? String(value) : undefined;
  const status = key!==undefined && Object.hasOwn(mapping.values,key) ? mapping.values[key] : 'unknown';
  const reason = mapping.reasonPath!==undefined ? read(mapping.reasonPath) : undefined;
  return {status,...(typeof reason==='string' ? {reason:reason.slice(0,2000)} : {})};
}

// DSH's enforced subset, not full JSON Schema. Keep authoring guidance beside
// the validator boundary so every generation entry point uses the same rules.
export const executionSchemaGuide = `Execution inputSchema and outputSchema use the DSH JSON Schema subset, NOT full JSON Schema. Allowed constraint keywords ONLY: type, oneOf, properties, required, additionalProperties, items, enum, const. Allowed annotations ONLY: title, description, default, examples. Each schema is an object; {} allows any JSON. type is ONE string: object|array|string|number|integer|boolean|null (never "json" or a type array). inputSchema root MUST have type:"object". properties maps field names to schemas; required is a unique array of declared property names; additionalProperties is boolean, never a schema. items is one schema, never a tuple array. enum/const are for type-matching scalar values only, not objects/arrays; enum is nonempty. oneOf requires at least two alternatives and exactly one must match; its siblings may only be annotations, never type or other constraints. Nullable example: {"oneOf":[{"type":"integer"},{"type":"null"}]}. Unsupported keywords include $schema, $ref, $defs, definitions, anyOf, allOf, not, nullable, format, pattern, minLength, maxLength, minimum, maximum, minItems, maxItems and uniqueItems. Enforce business bounds/patterns in the program instead of adding unsupported keywords. Every enforced bound, allowed combination, unit, default and fallback priority MUST be stated precisely in its public property description before invocation. A hard range is mandatory, never merely recommended; distinguish omitted, null, zero and explicit values. Do not infer a lookback window when the source can derive it from an identifier. default/examples are annotations only: defaults are NOT inserted into inputs. Give input properties Chinese title labels. Each input/output schema must be finite acyclic JSON, with maximum depth 32. Program return values must also be lossless JSON: omit optional object properties instead of assigning undefined (including nested objects); arrays cannot contain undefined, and numbers cannot be NaN or Infinity. Multi-target output must omit single-target-only fields instead of setting them to undefined.`;

// Inspect only literal native tool calls. This never evaluates the program.
export function programToolNames(program) {
  const names = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.object?.name === 'tools' && node.callee.property?.name === 'call') {
      const field = node.arguments[0]?.properties?.find(property => (property.key?.name ?? property.key?.value) === 'name');
      if (field?.value?.type === 'Literal' && typeof field.value.value === 'string') names.add(field.value.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse('(async function(input, tools, capabilities, resources, processes) {\n' + program + '\n})', {ecmaVersion:'latest'}));
  return [...names];
}

export function assertProgramResources(program, resources = {}) {
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.object?.name === 'resources' && ['path','run'].includes(node.callee.property?.name ?? node.callee.property?.value)) {
      const method=node.callee.property?.name ?? node.callee.property?.value;
      const value = method==='path'?node.arguments[0]:node.arguments[0]?.properties?.find(property=>(property.key?.name ?? property.key?.value)==='path')?.value;
      if (value?.type === 'Literal' && typeof value.value === 'string' && !Object.hasOwn(resources, value.value)) throw new Error('Program references an unbundled resource: ' + value.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse('(async function(input, tools, capabilities, resources, processes) {\n' + program + '\n})', {ecmaVersion:'latest'}));
}

export function normalizeCompatibility(value) {
  if (value === undefined) return undefined; // Existing revisions have no declaration.
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['platforms', 'requirements', 'limitations', 'probes'].includes(key))) throw new Error('Invalid compatibility declaration');
  if (!Array.isArray(value.platforms) || !value.platforms.length || new Set(value.platforms).size !== value.platforms.length || value.platforms.some(platform => !['darwin', 'linux', 'win32'].includes(platform))) throw new Error('compatibility.platforms must list supported darwin/linux/win32 platforms');
  if (!Array.isArray(value.requirements) || value.requirements.length > 16 || value.requirements.some(item => typeof item !== 'string' || !item.trim())) throw new Error('compatibility.requirements must list concrete runtime prerequisites');
  if (typeof value.limitations !== 'string' || !value.limitations.trim()) throw new Error('compatibility.limitations must explain unsupported systems and verification limits');
  if (value.probes !== undefined) {
    if (!Array.isArray(value.probes) || value.probes.length > 16) throw new Error('compatibility.probes must contain at most 16 read-only executable probes');
    for (const probe of value.probes) {
      if (!probe || typeof probe !== 'object' || Array.isArray(probe) || Object.keys(probe).some(key=>!['executable','args','stdoutIncludes','timeoutMs'].includes(key))
        || typeof probe.executable !== 'string' || !probe.executable.trim() || probe.executable.length > 1024 || probe.executable.includes('\0')
        || !Array.isArray(probe.args) || probe.args.length > 32 || probe.args.some(arg=>typeof arg!=='string'||arg.length>4096||arg.includes('\0'))
        || (probe.stdoutIncludes !== undefined && (typeof probe.stdoutIncludes !== 'string' || !probe.stdoutIncludes || probe.stdoutIncludes.length>1024))
        || (probe.timeoutMs !== undefined && (!Number.isSafeInteger(probe.timeoutMs) || probe.timeoutMs<1 || probe.timeoutMs>30000))) throw new Error('Invalid compatibility probe: explicit executable/args, optional stdoutIncludes and timeoutMs 1..30000');
    }
  }
  return structuredClone(value);
}

function schemaSnapshot(schema, objectRoot) {
  const seen = new Set();
  const visit = (value, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error('Execution schema exceeds depth 32');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Execution schema must be finite acyclic JSON');
    seen.add(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
    seen.delete(value);
  };
  visit(schema, 0);
  const serialized = JSON.stringify(schema);
  const copy = JSON.parse(serialized);
  if (objectRoot) assertObjectJsonSchema(copy); else assertSupportedJsonSchema(copy);
  return copy;
}

/** Version 1 accepts async function bodies in the JavaScript subset of TypeScript.
 * Parsing never executes the program and is not a security sandbox. Runtime
 * tool authorization and isolation belong to the native execution host.
 */
export function normalizeExecution(execution) {
  if (execution === undefined) return undefined;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).some(key => !['language', 'inputSchema', 'outputSchema', 'program','outcome','target'].includes(key))) throw new Error('Invalid execution contract');
  if (!['typescript','python'].includes(execution.language)) throw new Error('Execution language must be typescript (JavaScript subset) or python');
  if (typeof execution.program !== 'string' || !execution.program.trim()) throw new Error('Execution program must be nonempty');
  const schemas = {};
  const issues = [];
  for (const [field, objectRoot] of [['inputSchema', true], ['outputSchema', false]]) {
    try { schemas[field] = schemaSnapshot(execution[field], objectRoot); }
    catch (error) {
      for (const message of error.violations ?? [error.message]) {
        issues.push({ code: error.code || 'INVALID_SCHEMA', path: '/' + field, field, message });
      }
    }
  }
  if (issues.length) throw Object.assign(new Error('Execution schemas are invalid; repair all reported input/output issues'), { code: 'EXECUTION_SCHEMA_INVALID', issues });
  const { inputSchema, outputSchema } = schemas;
  const outcome = normalizeOutcome(execution.outcome);
  if (execution.target !== undefined && execution.target !== 'docker') throw new Error('Unsupported execution target');
  const target = execution.target ? {target:execution.target} : {};
  if(execution.language==='python'){if(execution.program.includes('\0'))throw new Error('Python entry must be UTF-8 text without NUL');return {...target,language:'python',inputSchema,outputSchema,program:execution.program,...(outcome ? {outcome} : {})};}
  try {
    new Script(`(async function(input, tools, capabilities, resources, processes) {\n"use strict";\n${execution.program}\n})`, { filename: 'native-capability-program.js' });
    // Compile the body separately too: it cannot close the wrapper and add
    // unrelated statements. This constructs a function without invoking it.
    new AsyncFunction('input', 'tools', 'capabilities', 'resources', 'processes', `"use strict";\n${execution.program}`);
  }
  catch { throw new Error('Execution program must parse as an async JavaScript function body; TypeScript-only syntax is unsupported'); }
  if(execution.target==='docker'){
    const tree=parse('(async()=>{'+execution.program+'})',{ecmaVersion:'latest'});
    const visit=node=>{if(!node||typeof node!=='object')return;
      if(node.type==='ImportExpression'||(node.type==='CallExpression'&&['require','eval','Function'].includes(node.callee?.name)))throw new Error('Target programs are JSON orchestration only; put I/O and imports in resources.run scripts');
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    };visit(tree);
  }
  return { ...target, language: 'typescript', inputSchema, outputSchema, program: execution.program,...(outcome ? {outcome} : {}) };
}

export function validateExecutionInput(execution, input) {
  assertObjectJsonSchema(execution.inputSchema);
  return validateJsonSchemaValue(execution.inputSchema, input);
}
export function validateExecutionOutput(execution, output) {
  assertSupportedJsonSchema(execution.outputSchema);
  return validateJsonSchemaValue(execution.outputSchema, output);
}
