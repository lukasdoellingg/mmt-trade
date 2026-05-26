import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const libDir = path.join(root, 'web/backend/lib');

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('backend lib hot paths: no console.log', () => {
  const offenders = [];
  for (const file of walkJs(libDir)) {
    const rel = path.relative(root, file);
    if (rel.includes('src/platform/logger.js')) continue;
    const text = readFileSync(file, 'utf8');
    if (/console\.log\s*\(/.test(text)) offenders.push(rel);
  }
  assert.equal(offenders.length, 0, `console.log in: ${offenders.join(', ')}`);
});
