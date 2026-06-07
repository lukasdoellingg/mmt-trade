/**
 * Layout split tree — build, mutate, and dock helpers (LCM Phase B).
 */
import type { RegionNode, WidgetState, WorkspaceProfile } from './types';
import { newAnchorId } from './layoutDocument';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';

export interface ViewportCells {
  w: number;
  h: number;
}

/** Heatmap default: chart | (ladder spot / ladder perp). */
export function buildHeatmapDefaultTree(
  widgets: WidgetState[],
  viewport: ViewportCells,
): RegionNode | null {
  const chart = widgets.find((w) => w.type === 'chart');
  const ladders = widgets.filter((w) => w.type === 'orderflow-ladder');
  if (!chart || ladders.length < 2) return null;

  const w = viewport.w;
  const h = viewport.h;
  const chartW = Math.max(60, Math.round(w * 0.78));
  const ladW = Math.max(20, w - chartW);
  const halfH = Math.max(10, Math.floor(h / 2));

  return {
    kind: 'split',
    axis: 'h',
    ratio: chartW / w,
    a: { kind: 'leaf', anchorId: chart.anchorId, rect: { x: 0, y: 0, w: chartW, h }, z: chart.z },
    b: {
      kind: 'split',
      axis: 'v',
      ratio: 0.5,
      a: {
        kind: 'leaf',
        anchorId: ladders[0].anchorId,
        rect: { x: chartW, y: 0, w: ladW, h: halfH },
        z: ladders[0].z,
      },
      b: {
        kind: 'leaf',
        anchorId: ladders[1].anchorId,
        rect: { x: chartW, y: halfH, w: ladW, h: h - halfH },
        z: ladders[1].z,
      },
    },
  };
}

export function findLeafByAnchor(root: RegionNode | null, anchorId: string): RegionNode | null {
  if (!root) return null;
  if (root.kind === 'leaf') return root.anchorId === anchorId ? root : null;
  if (root.kind === 'tabs') return root.anchorIds.includes(anchorId) ? root : null;
  return findLeafByAnchor(root.a, anchorId) ?? findLeafByAnchor(root.b, anchorId);
}

export function mutateSplitRatio(root: RegionNode, path: number[], ratio: number): RegionNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (path.length === 0) {
    if (root.kind !== 'split') return root;
    return { ...root, ratio: clamped };
  }
  if (root.kind !== 'split') return root;
  const [head, ...rest] = path;
  if (head === 0) return { ...root, a: mutateSplitRatio(root.a, rest, ratio) };
  return { ...root, b: mutateSplitRatio(root.b, rest, ratio) };
}

export function splitLeaf(
  root: RegionNode | null,
  anchorId: string,
  axis: 'h' | 'v',
  _profile: WorkspaceProfile,
): { root: RegionNode; newAnchorId: string } | null {
  if (!root) return null;
  const leaf = findLeafByAnchor(root, anchorId);
  if (!leaf || leaf.kind !== 'leaf') return null;

  const newId = newAnchorId();
  const newLeaf: RegionNode = {
    kind: 'leaf',
    anchorId: newId,
    rect: { ...leaf.rect },
    z: leaf.z + 1,
  };

  const splitNode: RegionNode = {
    kind: 'split',
    axis,
    ratio: 0.5,
    a: { ...leaf },
    b: newLeaf,
  };

  function replace(node: RegionNode): RegionNode {
    if (node.kind === 'leaf' && node.anchorId === anchorId) return splitNode;
    if (node.kind === 'tabs') return node;
    if (node.kind === 'split') {
      return { ...node, a: replace(node.a), b: replace(node.b) };
    }
    return node;
  }

  return { root: replace(root), newAnchorId: newId };
}

export function dockToEdge(
  root: RegionNode | null,
  anchorId: string,
  edge: DockEdge,
  viewport: ViewportCells,
): RegionNode | null {
  if (!root) return null;
  const leaf = findLeafByAnchor(root, anchorId);
  if (!leaf || leaf.kind !== 'leaf') return root;

  const axis: 'h' | 'v' = edge === 'left' || edge === 'right' ? 'h' : 'v';
  const ratio =
    edge === 'left' || edge === 'top'
      ? Math.max(0.15, (edge === 'left' ? leaf.rect.w : leaf.rect.h) / (axis === 'h' ? viewport.w : viewport.h))
      : Math.max(0.15, 1 - (edge === 'right' ? leaf.rect.w : leaf.rect.h) / (axis === 'h' ? viewport.w : viewport.h));

  const split = splitLeaf(root, anchorId, axis, 'heatmap');
  if (!split) return root;
  return mutateSplitRatio(split.root, [], ratio);
}

/** Infer a horizontal split tree from current widget rects (float → split migration). */
export function inferSplitFromWidgets(
  widgets: WidgetState[],
  viewport: ViewportCells,
): RegionNode | null {
  if (widgets.length < 2) return null;
  const sorted = [...widgets].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  let root: RegionNode = {
    kind: 'leaf',
    anchorId: sorted[0].anchorId,
    rect: { ...sorted[0].rect },
    z: sorted[0].z,
  };
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const leaf: RegionNode = {
      kind: 'leaf',
      anchorId: w.anchorId,
      rect: { ...w.rect },
      z: w.z,
    };
    const totalW = viewport.w || 1;
    const ratio = Math.max(0.15, Math.min(0.85, w.rect.x / totalW));
    root = {
      kind: 'split',
      axis: 'h',
      ratio,
      a: root,
      b: leaf,
    };
  }
  return root.kind === 'leaf' ? null : root;
}

export function flattenLeaves(root: RegionNode | null): RegionNode[] {
  if (!root) return [];
  if (root.kind === 'leaf') return [root];
  if (root.kind === 'tabs') return [];
  return [...flattenLeaves(root.a), ...flattenLeaves(root.b)];
}

export function syncWidgetsFromTree(root: RegionNode | null, widgets: WidgetState[]): WidgetState[] {
  if (!root) return widgets;
  const leaves = flattenLeaves(root);
  const byAnchor = new Map(widgets.map((w) => [w.anchorId, w]));
  return leaves
    .map((leaf) => {
      if (leaf.kind !== 'leaf') return null;
      const w = byAnchor.get(leaf.anchorId);
      if (!w) return null;
      return { ...w, rect: { ...leaf.rect }, z: leaf.z };
    })
    .filter(Boolean) as WidgetState[];
}
