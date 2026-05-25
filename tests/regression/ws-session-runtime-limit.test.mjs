import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const wsSession = readFileSync(join(root, 'web/backend/lib/wsSession.js'), 'utf8');

test('create_runtime reserves _runtimeCount before async mount', () => {
  const start = wsSession.indexOf("if (msg.op === 'create_runtime')");
  assert.ok(start >= 0, 'create_runtime handler missing');
  const body = wsSession.slice(start, start + 1200);
  const reserveIdx = body.indexOf('socket._runtimeCount = count + 1');
  const mountIdx = body.indexOf('mountLocalRuntime(');
  assert.ok(reserveIdx >= 0, 'must reserve count synchronously');
  assert.ok(mountIdx >= 0, 'must call mountLocalRuntime');
  assert.ok(reserveIdx < mountIdx, 'reserve must precede mountLocalRuntime');
  assert.doesNotMatch(body.slice(mountIdx), /socket\._runtimeCount = count \+ 1/);
  assert.match(body, /Math\.max\(0, \(socket\._runtimeCount/);
});
