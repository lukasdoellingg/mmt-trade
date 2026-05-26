#!/usr/bin/env node
/**
 * Dev preflight — fail fast with clear errors before concurrently starts services.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const minNodeMajor = 20;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < minNodeMajor) {
  console.error(
    `[dev-preflight] Node.js ${minNodeMajor}+ required (found ${process.versions.node}).`,
  );
  process.exit(1);
}

const wasmPath = join(root, 'web/frontend/public/engine.wasm');
try {
  await access(wasmPath, constants.R_OK);
} catch {
  console.error(
    '[dev-preflight] Missing web/frontend/public/engine.wasm — chart WASM will not load.',
  );
  console.error('  Copy from another machine or run: npm run build:wasm (requires Odin).');
  process.exit(1);
}

console.log('[dev-preflight] ok — Node', process.versions.node, '+ engine.wasm present');
