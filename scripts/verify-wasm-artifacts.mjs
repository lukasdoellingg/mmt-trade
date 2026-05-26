#!/usr/bin/env node
/**
 * CI guard: required WASM artifacts exist in frontend/shell public dirs.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'web/frontend/public/engine.wasm',
];
const optional = [
  'web/frontend/public/chart_runtime.wasm',
  'packages/shell/public/engine.wasm',
];

let failed = 0;
for (const rel of required) {
  const path = join(root, rel);
  try {
    await access(path, constants.R_OK);
    console.log(`ok ${rel}`);
  } catch {
    console.error(`missing required ${rel}`);
    failed++;
  }
}
for (const rel of optional) {
  const path = join(root, rel);
  try {
    await access(path, constants.R_OK);
    console.log(`ok (optional) ${rel}`);
  } catch {
    console.warn(`warn optional missing ${rel}`);
  }
}

if (failed > 0) {
  console.error(`verify-wasm-artifacts: ${failed} missing file(s)`);
  process.exit(1);
}
