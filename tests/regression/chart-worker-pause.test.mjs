import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const chartWidget = readFileSync(
  join(root, 'web/frontend/src/widgets/ChartWidget.vue'),
  'utf8',
);
const chartWorker = readFileSync(
  join(root, 'web/frontend/src/workers/chartEngineWorker.ts'),
  'utf8',
);

test('ChartWidget pause keeps chart worker alive (KeepAlive)', () => {
  const pauseFn = chartWidget.match(/function pause\(\) \{[\s\S]*?\n\}/);
  assert.ok(pauseFn, 'pause() missing');
  assert.doesNotMatch(pauseFn[0], /stopWorker\(\)/, 'pause must not terminate chart worker');
  assert.match(pauseFn[0], /type: 'pause'/, 'pause must post pause to chart worker');
});

test('ChartWidget unmount terminates chart worker', () => {
  const unmountIdx = chartWidget.indexOf('onUnmounted(() => {');
  assert.ok(unmountIdx >= 0);
  const block = chartWidget.slice(unmountIdx, unmountIdx + 200);
  assert.match(block, /stopWorker\(\)/);
  assert.match(block, /terminateAllLayerWorkers\(\)/);
});

test('chartEngineWorker implements pause and resume', () => {
  assert.match(chartWorker, /case 'pause':/);
  assert.match(chartWorker, /case 'resume':/);
});
