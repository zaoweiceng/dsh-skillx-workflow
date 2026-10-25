/** Versioned Markdown, loaded into recovery context only after execution fails. */
export function normalizeRecoveryDocs(docs, { required = false } = {}) {
  if (docs === undefined && !required) return undefined;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) throw new Error('docs must map docs/<filename>.md to dedicated error guidance');
  const entries = Object.entries(docs);
  if (!entries.length || entries.length > 8) throw new Error('Provide 1 to 8 dedicated recovery docs');
  for (const [path, content] of entries) {
    if (!/^docs\/[a-z0-9][a-z0-9-]{0,79}\.md$/.test(path)) throw new Error('Recovery guide path must be docs/<kebab-case>.md');
    if (typeof content !== 'string' || !content.trim()) throw new Error('Recovery guide must contain Markdown');
  }
  return Object.fromEntries(entries);
}
export function recoveryGuides(entries, receipt, failure) {
  const failedOwners = new Set((receipt?.steps ?? []).filter(step => !['completed','succeeded','reused'].includes(step.status)).map(step => step.capability));
  if (failure?.capability) failedOwners.add(failure.capability);
  return entries.filter((entry, index) => index === 0 || failedOwners.has(entry.name)).filter(entry => entry.docs)
    .map(entry => ({ name: entry.name, version: entry.version, revisionId: entry.revisionId, docs: entry.docs }));
}
