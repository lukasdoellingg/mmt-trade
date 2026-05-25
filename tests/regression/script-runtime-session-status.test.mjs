import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptRuntime = readFileSync(
  join(root, 'web/frontend/src/chart/scriptRuntime.ts'),
  'utf8',
);
const feedHubClient = readFileSync(
  join(root, 'web/frontend/src/engine/feedHubClient.ts'),
  'utf8',
);
const scriptPane = readFileSync(
  join(root, 'web/frontend/src/widgets/ScriptIndicatorPaneWidget.vue'),
  'utf8',
);
const envDev = readFileSync(join(root, 'web/frontend/.env.development'), 'utf8');

test('feedHubClient forwards session_status from worker', () => {
  assert.match(feedHubClient, /session_status/);
  assert.match(feedHubClient, /onSessionStatus/);
});

test('scriptRuntime tracks connection status and mount timeout', () => {
  assert.match(scriptRuntime, /sessionConnectionStatus/);
  assert.match(scriptRuntime, /onSessionStatus/);
  assert.match(scriptRuntime, /MOUNT_TIMEOUT_MS/);
  assert.match(scriptRuntime, /nextCreateToken/);
  assert.match(scriptRuntime, /Runtime timeout/);
});

test('script pane shows distinct messages for off vs disconnected', () => {
  assert.match(scriptPane, /Script session disabled in build/);
  assert.match(scriptPane, /Backend \/ws\/session unreachable/);
  assert.doesNotMatch(scriptPane, /linkedPane\(\)/);
});

test('dev env enables session mux', () => {
  assert.match(envDev, /VITE_USE_SESSION_MUX=1/);
});
