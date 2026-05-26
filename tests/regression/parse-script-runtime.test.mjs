import assert from 'node:assert/strict';

function isFinitePrice(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function parseScriptRuntimePayload(text, streamRuntimeId) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  const data = msg.data && typeof msg.data === 'object' ? msg.data : msg;
  const runtimeId =
    (typeof data.runtime_id === 'string' ? data.runtime_id : null) ??
    (typeof streamRuntimeId === 'string' && streamRuntimeId.startsWith('runtime:')
      ? streamRuntimeId.slice('runtime:'.length)
      : null);
  const lines = [];
  const walk = (obj, depth) => {
    if (depth > 6 || !obj || typeof obj !== 'object') return;
    for (const key of ['levels', 'lines', 'plots', 'hlines']) {
      const v = obj[key];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'number' && isFinitePrice(item)) lines.push({ price: item });
          else if (item && typeof item === 'object') {
            const p = item.price ?? item.y ?? item.value ?? item.level;
            if (isFinitePrice(p)) lines.push({ price: p });
          }
        }
      }
    }
  };
  walk(data, 0);
  if (!lines.length && !runtimeId) return null;
  return { runtimeId, lines };
}

const sample = JSON.stringify({
  data: { runtime_id: 'rt-abc', levels: [{ price: 95000.5 }, { price: 96000 }] },
});
const parsed = parseScriptRuntimePayload(sample, 'runtime:rt-abc');
assert.ok(parsed);
assert.equal(parsed.runtimeId, 'rt-abc');
assert.equal(parsed.lines.length, 2);
console.log('parse-script-runtime.test.mjs OK');
