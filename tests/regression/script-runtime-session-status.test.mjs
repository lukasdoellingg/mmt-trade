import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptRuntime = readFileSync(join(root, 'web/frontend/src/chart/scriptRuntime.ts'), 'utf8');
const feedHubClient = readFileSync(join(root, 'web/frontend/src/engine/feedHubClient.ts'), 'utf8');
const scriptPane = readFileSync(join(root, 'web/frontend/src/widgets/ScriptIndicatorPaneWidget.vue'), 'utf8');
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
  assert.match(scriptRuntime, /schedulePendingMountTimeouts/);
  assert.match(scriptRuntime, /sessionConnectionStatus\.value !== 'live'/);
  assert.match(scriptRuntime, /parseCreateTokenFromRuntimeId/);
  assert.match(scriptRuntime, /promoteMountLive/);
});

test('script pane shows distinct messages for off vs disconnected', () => {
  assert.match(scriptPane, /Script session disabled in build/);
  assert.match(scriptPane, /Backend \/ws\/session unreachable/);
  assert.match(scriptPane, /Restart Vite/);
  assert.match(scriptPane, /displayBadge/);
  assert.match(scriptPane, /sessionConnLabel/);
  assert.doesNotMatch(scriptPane, /linkedPane\(\)/);
});

test('scriptRuntime mount errors immediately when session mux off', () => {
  assert.match(scriptRuntime, /if \(!USE_SESSION_MUX\) \{[\s\S]*status: 'error'/);
  assert.match(scriptRuntime, /Script session disabled in build/);
});

test('main exposes dev flags for mux diagnosis', () => {
  const main = readFileSync(join(root, 'web/frontend/src/main.ts'), 'utf8');
  assert.match(main, /__MMT_FLAGS__/);
  assert.match(main, /USE_SESSION_MUX/);
});

test('vite config loadEnv and defines session mux from env', () => {
  const vite = readFileSync(join(root, 'web/frontend/vite.config.js'), 'utf8');
  assert.match(vite, /loadEnv/);
  assert.match(vite, /import\.meta\.env\.VITE_USE_SESSION_MUX/);
  assert.match(vite, /envDir: frontendRoot/);
});

test('mountScriptWindowRuntime guarded when mux off', () => {
  const paneRuntime = readFileSync(join(root, 'web/frontend/src/chart/useChartPaneRuntime.ts'), 'utf8');
  assert.match(paneRuntime, /if \(!USE_SESSION_MUX\) return ''/);
  assert.match(paneRuntime, /type === 'script-indicator-pane' && USE_SESSION_MUX/);
});

test('ChartWidget resets chartBooted on KeepAlive deactivate', () => {
  const chart = readFileSync(join(root, 'web/frontend/src/widgets/ChartWidget.vue'), 'utf8');
  assert.match(chart, /onDeactivated/);
  assert.match(chart, /chartBooted = false/);
});

test('dev env enables session mux', () => {
  assert.match(envDev, /VITE_USE_SESSION_MUX=1/);
});
