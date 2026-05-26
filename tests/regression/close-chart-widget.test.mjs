import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = readFileSync(join(root, 'web/frontend/src/workspace/useWorkspace.ts'), 'utf8');
const chartWidget = readFileSync(join(root, 'web/frontend/src/widgets/ChartWidget.vue'), 'utf8');
const workspaceWidget = readFileSync(join(root, 'web/frontend/src/workspace/WorkspaceWidget.vue'), 'utf8');

test('closeChartWidget cascades script panes and unregisters tree', () => {
  assert.match(workspace, /function closeChartWidget/);
  assert.match(workspace, /script-indicator-pane/);
  assert.match(workspace, /parentChartWidgetId/);
  assert.match(workspace, /chartPaneUnregister/);
  assert.match(workspace, /activeChartId\.value = remaining/);
});

test('chart widget exposes close button via WorkspaceWidget', () => {
  assert.doesNotMatch(chartWidget, /no-close/);
  assert.match(chartWidget, /handle-close/);
  assert.match(chartWidget, /@close="onChartClose"/);
  assert.match(chartWidget, /closeChartWidget/);
  assert.match(chartWidget, /releasePaneSettingsSnapshot/);
});

test('closeChartWidget snapshots pane props before removal', () => {
  assert.match(workspace, /snapshotPaneSettings/);
  assert.match(workspace, /removeIds/);
  assert.match(workspace, /store\.widgets = store\.widgets\.filter/);
});

test('WorkspaceWidget emits close before remove', () => {
  assert.match(workspaceWidget, /emit\('close'\)/);
});
