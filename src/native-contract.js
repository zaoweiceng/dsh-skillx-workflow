import { Script } from 'node:vm';
import { assertSupportedJsonSchema, assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const MAX_SCHEMA_BYTES = 65536;
const MAX_SCHEMA_DEPTH = 32;
const MAX_PROGRAM_BYTES = 65536;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

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
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) throw new Error('Execution schema exceeds 64 KiB');
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
    || Object.keys(execution).some(key => !['language', 'inputSchema', 'outputSchema', 'program'].includes(key))) throw new Error('Invalid execution contract');
  if (execution.language !== 'typescript') throw new Error('Execution language must be typescript (JavaScript subset)');
  if (typeof execution.program !== 'string' || !execution.program.trim() || Buffer.byteLength(execution.program) > MAX_PROGRAM_BYTES) throw new Error('Execution program must be nonempty and at most 64 KiB');
  const inputSchema = schemaSnapshot(execution.inputSchema, true);
  const outputSchema = schemaSnapshot(execution.outputSchema, false);
  try {
    new Script(`(async function(input, tools, capabilities) {\n"use strict";\n${execution.program}\n})`, { filename: 'native-capability-program.js' });
    // Compile the body separately too: it cannot close the wrapper and add
    // unrelated statements. This constructs a function without invoking it.
    new AsyncFunction('input', 'tools', 'capabilities', `"use strict";\n${execution.program}`);
  }
  catch { throw new Error('Execution program must parse as an async JavaScript function body; TypeScript-only syntax is unsupported'); }
  return { language: 'typescript', inputSchema, outputSchema, program: execution.program };
}

export function validateExecutionInput(execution, input) {
  assertObjectJsonSchema(execution.inputSchema);
  return validateJsonSchemaValue(execution.inputSchema, input);
}
export function validateExecutionOutput(execution, output) {
  assertSupportedJsonSchema(execution.outputSchema);
  return validateJsonSchemaValue(execution.outputSchema, output);
}
