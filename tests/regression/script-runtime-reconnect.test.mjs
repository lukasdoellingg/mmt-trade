import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const feedHubWorker = readFileSync(join(root, 'web/frontend/src/workers/feedHubWorker.ts'), 'utf8');
const scriptRuntime = readFileSync(join(root, 'web/frontend/src/chart/scriptRuntime.ts'), 'utf8');
const localEngine = readFileSync(join(root, 'web/backend/lib/indicators/localEngine.js'), 'utf8');

test('feedHubWorker replays pending runtimes on reconnect', () => {
  assert.match(feedHubWorker, /pendingRuntimes/);
  assert.match(feedHubWorker, /replayPendingRuntimes/);
  assert.match(feedHubWorker, /resubscribeAll/);
});

test('scriptRuntime unmount uses single release path', () => {
  assert.doesNotMatch(scriptRuntime, /destroyScriptRuntime/);
  assert.match(scriptRuntime, /cancelPendingRuntime/);
  assert.match(scriptRuntime, /replayPendingMounts/);
});

test('localEngine deduplicates compute by scriptId:symbol:tf', () => {
  assert.match(localEngine, /function computeKey/);
  assert.match(localEngine, /computeSlots/);
  assert.match(localEngine, /fanoutPlot/);
  assert.doesNotMatch(localEngine, /function slotKey/);
});
