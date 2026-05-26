import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptRuntime = readFileSync(join(root, 'web/frontend/src/chart/scriptRuntime.ts'), 'utf8');
const wsSession = readFileSync(join(root, 'web/backend/lib/wsSession.js'), 'utf8');

test('scriptRuntime scopes session errors by createToken', () => {
  assert.match(scriptRuntime, /const token = msg\.createToken/);
  assert.match(scriptRuntime, /mount\.createToken === token/);
  assert.match(scriptRuntime, /if \(matched\) mounts\.value = next/);
});

test('wsSession echoes createToken on create_runtime errors', () => {
  assert.match(wsSession, /createToken.*runtime limit|runtime limit.*createToken/s);
  assert.match(wsSession, /create_runtime failed', createToken/);
});
