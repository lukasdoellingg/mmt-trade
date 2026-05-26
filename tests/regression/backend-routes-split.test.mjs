import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('backend route modules are registered from index.js', () => {
  const index = readFileSync(path.join(root, 'web/backend/index.js'), 'utf8');
  assert.match(index, /registerMarketRoutes/);
  assert.match(index, /registerDerivativesRoutes/);
  assert.match(index, /registerTradFiRoutes/);
  assert.doesNotMatch(index, /app\.get\('\/api\/liquidations'/);
  assert.doesNotMatch(index, /app\.get\('\/api\/orderbook'/);
});
