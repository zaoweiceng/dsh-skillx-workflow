// Validate before serialization: JSON.stringify silently changes NaN, holes,
// undefined and custom objects, which a later JSON Schema check cannot detect.
function assertLosslessJson(value, seen = new Set()) {
  const fail = () => { throw Object.assign(new Error('Script output must be lossless JSON'), { code: 'SCRIPT_OUTPUT_NOT_JSON' }); };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value !== 'object' || seen.has(value)) fail();
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (Object.getOwnPropertySymbols(value).length) fail();
  if (array && (Object.keys(value).length !== value.length || Object.keys(value).some((key,i)=>key!==String(i)))) fail();
  seen.add(value);
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(property, 'value')) fail();
    assertLosslessJson(property.value, seen);
  }
  seen.delete(value);
}
module.exports = { assertLosslessJson };
