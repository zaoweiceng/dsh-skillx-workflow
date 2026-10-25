import { createHash } from 'node:crypto';

export function assertResultSelection(select) {
  if (select === undefined) return;
  if (!Array.isArray(select) || !select.length || new Set(select).size !== select.length || select.some(pointer =>
    typeof pointer !== 'string' || (pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/.test(pointer))))) throw new Error('INVALID_RESULT_SELECTION');
}

// Selection is a transport projection of an already validated, retained value.
// Missing optional fields are reported, never turned into an execution failure.
export function deliverSelectedResult(output, runId, maxBytes, select) {
  if (select === undefined) return deliverResult(output, runId, maxBytes);
  const values = [], missingPointers = [];
  for (const pointer of select) {
    let value = output, found = true;
    for (const key of pointer === '' ? [] : pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) { found = false; break; }
      value = value[key];
    }
    if (found) values.push([pointer, value]); else missingPointers.push(pointer);
  }
  const retainedPointer = pointer => {
    const [, first, ...rest] = pointer.split('/');
    return first === undefined ? '' : first.replace(/~1/g, '/').replace(/~0/g, '~') + (rest.length ? '/' + rest.join('/') : '');
  };
  const result = deliverResult(Object.fromEntries(values), runId, maxBytes, retainedPointer);
  // Preview pointers refer to the selection map; reads address retained output.
  if (result.delivery.omitted) result.delivery.omitted = result.delivery.omitted.map(item => ({ ...item, pointer: retainedPointer(item.pointer) }));
  const full = JSON.stringify(output);
  Object.assign(result.delivery, { scope: 'selection', selection: select, missingPointers,
    fullBytes: Buffer.byteLength(full) });
  return result;
}

// Delivery is distinct from execution: validate and retain the full value first.
// Previews never claim to be complete or to satisfy the capability output schema.
export function deliverResult(output, runId, maxBytes = 16384, retainedPointer = pointer => pointer) {
  const encoded = JSON.stringify(output);
  const bytes = Buffer.byteLength(encoded);
  const reference = { tool: 'capability_result_read', runId, pointer: '', offset: 0, limit: 4000 };
  const base = { runId, bytes, digest: 'sha256:' + createHash('sha256').update(encoded).digest('hex'), read: reference };
  if (bytes <= maxBytes) return { output, delivery: { ...base, complete: true } };
  const omitted = [];
  const mark = (pointer, value) => { if (omitted.length < 12 && pointer.length <= 128) omitted.push({ pointer, kind: Array.isArray(value) ? 'array' : typeof value, ...(Array.isArray(value) ? { count: value.length } : {}) }); };
  const project = (value, pointer, depth, budget) => {
    if (Buffer.byteLength(JSON.stringify(value)) <= budget) return value;
    mark(pointer, value);
    // A preview must not turn retained data into a business null or a false path.
    // The pointer addresses the full retained result, never a truncated value.
    const omittedValue = { $omitted: retainedPointer(pointer) };
    if (typeof value === 'string') return omittedValue;
    if (!value || typeof value !== 'object' || depth >= 6 || budget < 32) return omittedValue;
    if (Array.isArray(value)) return value.slice(0, 3).map((item, index) => project(item, pointer + '/' + index, depth + 1, Math.max(16, Math.floor((budget - 16) / 3))));
    const pairs = Object.entries(value).slice(0, 40);
    const share = Math.max(16, Math.floor((budget - 32) / Math.max(1, pairs.length)));
    return Object.fromEntries(pairs.map(([key, item]) => [key, project(item, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1, Math.max(16, share - Buffer.byteLength(key) - 8))]));
  };
  let preview = project(output, '', 0, Math.max(32, maxBytes - 4096));
  if (Buffer.byteLength(JSON.stringify(preview)) > maxBytes - 4096) preview = { $omitted: '' };
  return { output: preview, delivery: { ...base, complete: false, format: 'bounded-preview', omitted, instruction: 'Output is a preview of a validated, retained result. Do not infer missing evidence or repeat the query. Read only required JSON pointers through capability_result_read; offsets count UTF-16 code units in the JSON text.' } };
}

export function resultPage(output, { pointer = '', offset = 0, limit = 4000 } = {}) {
  if (typeof pointer !== 'string' || (pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/.test(pointer)))) throw new Error('INVALID_RESULT_POINTER');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error('INVALID_RESULT_PAGE');
  let value = output;
  for (const key of pointer === '' ? [] : pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('RESULT_POINTER_NOT_FOUND');
    value = value[key];
  }
  const encoded = JSON.stringify(value);
  if (offset > encoded.length) throw new Error('INVALID_RESULT_OFFSET');
  let end = Math.min(offset + limit, encoded.length);
  // Keep surrogate pairs intact without changing the documented cursor unit.
  if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1])) end--;
  if (end === offset && end < encoded.length) end = Math.min(offset + 2, encoded.length);
  return { pointer, format: 'json-text-fragment', offset, text: encoded.slice(offset, end), totalChars: encoded.length, complete: end === encoded.length, ...(end < encoded.length ? { nextOffset: end } : {}) };
}
