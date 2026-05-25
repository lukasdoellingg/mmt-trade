import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const paneSettings = readFileSync(
  join(root, 'web/frontend/src/chart/chartPaneSettings.ts'),
  'utf8',
);
const workspace = readFileSync(
  join(root, 'web/frontend/src/workspace/useWorkspace.ts'),
  'utf8',
);
const chartSettings = readFileSync(
  join(root, 'web/frontend/src/chart/chartSettings.ts'),
  'utf8',
);

test('per-chart pane settings module exists', () => {
  assert.match(paneSettings, /usePaneSettings/);
  assert.match(paneSettings, /useActivePaneSettings/);
  assert.match(paneSettings, /initialChartWidgetProps/);
  assert.match(paneSettings, /snapshotPaneSettings/);
  assert.doesNotMatch(paneSettings, /reactive\(\s*\n?\s*new Proxy/);
});

test('workspace tracks active chart and layout v4', () => {
  assert.match(workspace, /activeChartId/);
  assert.match(workspace, /LAYOUT_VERSION = 4/);
});

test('chartSettings is shell-only', () => {
  assert.match(chartSettings, /ChartShellSettings/);
  assert.doesNotMatch(chartSettings, /symbol: DEFAULT_SYMBOL/);
});
