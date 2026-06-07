import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const useWorkspace = readFileSync(join(root, 'web/frontend/src/workspace/useWorkspace.ts'), 'utf8');
const layoutTree = readFileSync(join(root, 'web/frontend/src/workspace/layoutTree.ts'), 'utf8');

test('useWorkspace persists split regions when layoutRoot is set', () => {
  assert.match(useWorkspace, /layoutRoot/);
  assert.match(useWorkspace, /store\.layoutRoot\s*\?\s*\[store\.layoutRoot\]/);
});

test('layoutTree provides heatmap default split tree', () => {
  assert.match(layoutTree, /buildHeatmapDefaultTree/);
  assert.match(layoutTree, /mutateSplitRatio/);
  assert.match(layoutTree, /dockToEdge/);
});
