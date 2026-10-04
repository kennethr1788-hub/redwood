// Small, strict JSON boundary shared only by the two disjoint leaf modules.
export const MAX_JSON_BYTES = 65_536;
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|oauth[_ -]?token|session[_ -]?token|password|cookie|authorization)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|https?:\/\/[^\s/]+:[^\s/]+@/i;

export function fail(message = 'Invalid bounded data') { throw new TypeError(message); }

export function boundedJSON(input, limit = MAX_JSON_BYTES) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > limit) fail('JSON exceeds byte limit');
    try { value = JSON.parse(input); } catch { fail('Malformed JSON'); }
  }
  let nodes = 0;
  const seen = new Set();
  function visit(v, depth) {
    if (++nodes > 4096 || depth > 16) fail('Data exceeds structural limit');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') {
      if (Buffer.byteLength(v) > limit || secret.test(v)) fail('Unsafe or oversized text');
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) fail('Expected acyclic plain JSON');
    if (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('Expected plain JSON object');
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.length > 256) fail('Too many entries');
    for (const key of keys) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe JSON property');
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) fail('Invalid array property');
      visit(d.value, depth + 1);
    }
    if (Array.isArray(v) && (v.length > 256 || Object.keys(v).length !== v.length)) fail('Invalid array');
    seen.delete(v);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > limit) fail('JSON exceeds byte limit');
  return JSON.parse(json);
}

export const enumeration = (...values) => v => values.includes(v) ? v : fail('Invalid enum value');
export const nullable = check => v => v === null ? null : check(v);
export const optional = check => ({ optional: true, check });
export const bool = v => typeof v === 'boolean' ? v : fail('Expected boolean');
export const text = (max = 500) => v => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(v) || secret.test(v)) fail('Invalid safe single-line text');
  return v;
};
export const id = v => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(text(100)(v)) ? v : fail('Invalid identifier');
export const revision = nullable(v => {
  id(v);
  if (/^(unknown|missing|undefined|null|not[-_.]?supplied|n[-_.]?a)$/i.test(v)) fail('Unknown revisions must be null');
  return v;
});
export const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail('Expected SHA-256');
export const identity = nullable(digest);
export const product = enumeration('build', 'studio', 'grow');
export const timestamp = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('Expected canonical UTC timestamp');
  return v;
};
export const relativePath = v => {
  text(240)(v);
  const parts = v.split('/');
  if (parts.length > 16 || parts.some(p => !p || p === '.' || p === '..' || !/^[\p{L}\p{N}_. -]+$/u.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail('Expected contained relative path');
  return v;
};
export const array = (check, max = 32) => v => {
  if (!Array.isArray(v) || v.length > max) fail('Invalid bounded array');
  return v.map(check);
};
export const object = shape => v => {
  if (!v || Array.isArray(v) || typeof v !== 'object') fail('Expected object');
  if (Object.keys(v).some(k => !Object.hasOwn(shape, k))) fail('Unexpected field');
  const result = {};
  for (const [k, field] of Object.entries(shape)) {
    if (!Object.hasOwn(v, k)) {
      if (field.optional) continue;
      fail('Missing required field');
    }
    result[k] = (field.check ?? field)(v[k]);
  }
  return result;
};
export const schema = check => Object.freeze({ parse: input => check(boundedJSON(input)) });
export function unique(values, key = v => v) {
  if (new Set(values.map(key)).size !== values.length) fail('Duplicate identity');
  return values;
}

export function canonicalJSON(value) {
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  // Also safe inside the Markdown code fence: content cannot close it or add HTML.
  return JSON.stringify(sort(value), null, 2).replace(/[<>&`]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}
