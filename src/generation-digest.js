import { createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
export const draftDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
