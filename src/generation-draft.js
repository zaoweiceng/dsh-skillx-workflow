import { draftDigest as hashDraft } from './generation-digest.js';

/** Apply a small atomic JSON patch to an exact draft, never to a published artifact. */
export function editDraft(draft, expectedDigest, edits) {
  if (!draft || expectedDigest !== hashDraft(draft)) throw Object.assign(new Error('Draft changed or is missing; read __draft__ and use its current draftDigest'), { code: 'DRAFT_CONFLICT' });
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('Supply 1..100 draftEdits');
  const copy = structuredClone(draft);
  for (const edit of edits) {
    if (!edit || !['add', 'replace', 'remove'].includes(edit.op) || typeof edit.path !== 'string' || (!edit.path.startsWith('/') || edit.path === '/') || (edit.op !== 'remove' && !Object.hasOwn(edit, 'value'))) throw new Error('Draft edit needs add/replace/remove, a non-root JSON pointer and value except for remove');
    const keys = edit.path.slice(1).split('/').map(key => {
      if (/~(?![01])/u.test(key)) throw new Error('Invalid JSON pointer escape');
      const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
      if (['__proto__','prototype','constructor'].includes(decoded)) throw new Error('Unsafe draft path');
      return decoded;
    });
    let parent = copy;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Draft parent path does not exist: ' + edit.path);
      parent = parent[key];
    }
    const key = keys.at(-1);
    if (!parent || typeof parent !== 'object') throw new Error('Draft parent is not an object: ' + edit.path);
    if (Array.isArray(parent)) {
      const index = key === '-' && edit.op === 'add' ? parent.length : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : NaN;
      if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (edit.op !== 'add' && index === parent.length)) throw new Error('Draft array index out of range: ' + edit.path);
      if (edit.op === 'add') parent.splice(index, 0, structuredClone(edit.value));
      else if (edit.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(edit.value);
    } else {
      if (edit.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('Draft path does not exist: ' + edit.path);
      if (edit.op === 'remove') delete parent[key]; else parent[key] = structuredClone(edit.value);
    }
  }
  return copy;
}

export const draftEditParameters = {
  draftDigest: { type: 'string', description: 'Exact draftDigest from the last receipt or read __draft__; required for edits' },
  draftEdits: { type: 'array', items: { type: 'json' }, description: 'Atomic JSON patch array {op:add|replace|remove,path:JSON-pointer,value}. Patch saved unpublished draft only. Example: replace /candidates/0/validationNotes with "Observed evidence and limits". No full rewrite needed.' },
};
