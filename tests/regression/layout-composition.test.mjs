import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('LCM v5 types and registry modules exist', () => {
  const types = readFileSync(path.join(root, 'web/frontend/src/workspace/types.ts'), 'utf8');
  assert.match(types, /interface LayoutDocument/);
  assert.match(types, /anchorId: string/);
  assert.match(types, /interface TabGroupState/);

  const registry = readFileSync(
    path.join(root, 'web/frontend/src/workspace/runtimeLockRegistry.ts'),
    'utf8',
  );
  assert.match(registry, /focusAnchorId/);
  assert.match(registry, /suspendSlot/);
  assert.match(registry, /resumeSlot/);

  const migrate = readFileSync(path.join(root, 'web/frontend/src/workspace/layoutDocument.ts'), 'utf8');
  assert.match(migrate, /migrateWorkspaceLayoutToDocument/);
  assert.match(migrate, /LAYOUT_DOC_VERSION = 5/);
});

test('useWorkspace persists v5 layout keys', () => {
  const ws = readFileSync(path.join(root, 'web/frontend/src/workspace/useWorkspace.ts'), 'utf8');
  assert.match(ws, /mmt-layout-heatmap-v5/);
  assert.match(ws, /mmt-layout-futures-v5-slot-/);
  assert.match(ws, /migrateWorkspaceLayoutToDocument/);
  assert.match(ws, /createTabGroup/);
});

test('layout composition spec doc exists', () => {
  const doc = readFileSync(path.join(root, 'docs/architecture/layout-composition.md'), 'utf8');
  assert.match(doc, /Layout Composition Model/);
  assert.match(doc, /Runtime Lock Registry/);
});

test('ChartTopBar exposes layout export/import', () => {
  const bar = readFileSync(path.join(root, 'web/frontend/src/components/chart/ChartTopBar.vue'), 'utf8');
  assert.match(bar, /onExportLayout/);
  assert.match(bar, /onImportLayout/);
  assert.match(bar, /saveCurrentToCatalog/);
});
