# Layout Composition Model (LCM)

Normative JS-side layout spec. Complements [object-tree.md](./object-tree.md) (runtime hierarchy) without changing worker or FeedHub architecture.

## Layers

| Layer | Owns | Persisted |
|-------|------|-----------|
| **LayoutDocument** | Regions, tab groups, focus, metadata | `localStorage` v5 keys |
| **PaneAnchor** | Stable `anchorId`, widget type, props, lease policy | Inside LayoutDocument |
| **RuntimeLease** | Worker handles, script mounts, stream ref keys | In-memory (Registry) |

## Stable identity

Every pane has an immutable **`anchorId`** (UUID). Widget serial ids (`chart-3`) may change on add/remove; anchors survive reload, slot switch, and export/import.

`WidgetState.anchorId` links Vue instances to persisted anchors. `WidgetBinding` maps legacy `widgetId ↔ anchorId` during migration.

## LayoutDocument v5

```typescript
interface LayoutDocument {
  version: 5;
  meta: { name: string; profile: 'heatmap' | 'futures'; slot?: 1|2|3|4 };
  focusAnchorId: string | null;
  regions: RegionNode[];
  anchors: Record<string, PaneAnchor>;
  bindings: WidgetBinding[];
  tabGroups?: TabGroupState[];
  widgets: WidgetState[];  // flattened render list
  nextSerial: number;
}
```

### RegionNode

- `leaf` — single anchor at rect + z
- `tabs` — tab stack sharing one rect
- `split` — nested CSS grid split (`axis`, `ratio`, `a`, `b`)

Split renderer: `WorkspaceSplitPane.vue` + `layoutTree.ts`. When `layoutRoot` is set, `WorkspaceGrid` fills the viewport without float overlap. Heatmap default:

```
split(h, 0.78)
├── chart
└── split(v, 0.5)
    ├── ladder (spot)
    └── ladder (perp)
```

Legacy float layout remains when `layoutRoot` is null (backward compatible).

## Runtime Lock Registry

Module: [`web/frontend/src/workspace/runtimeLockRegistry.ts`](../../web/frontend/src/workspace/runtimeLockRegistry.ts)

Single source of truth for lease lifecycle:

| State | Meaning |
|-------|---------|
| `cold` | Anchor known, no worker |
| `booting` | Worker spawn in progress |
| `active` | rAF + streams running |
| `suspended` | Paused; OffscreenCanvas retained where possible |
| `released` | Teardown complete |

### Lifecycle rules (align object-tree Regel 4)

| Event | Registry action |
|-------|-----------------|
| Chart focused | `setFocusAnchor(anchorId)` → resume lease |
| Chart blurred / tab hidden | `suspendLease(anchorId)` |
| Layout slot switch | `suspendSlot(slot)` before swap; `resumeSlot(slot)` after hydrate |
| Widget closed | `releaseLease(anchorId)` |
| Symbol/TF change | refresh streams on active lease |

## Focus model

- **`focusAnchorId`** — global ref; ChartTopBar reads settings via anchor → widgetId resolution
- Satellite widgets (`followFocus: true`) bind to focused chart anchor props
- Replaces semantic use of `activeChartId` (kept as alias during migration)

## Persistence keys

| Key | Content |
|-----|---------|
| `mmt-layout-heatmap-v5` | Heatmap LayoutDocument |
| `mmt-layout-futures-v5-slot-{n}` | Futures slot layout |
| `mmt-layout-catalog-v1` | Named layout index (export/import) |

v4 keys (`mmt-workspace-*-v1`) migrate automatically on first load.

## Tab groups

`TabGroupState` groups multiple anchors in one chrome rect. Inactive tabs: `suspendLease`; active tab: `resumeLease`. Header tabs in `WorkspaceTabStack.vue`. Drag widget header → hover another header 300ms → `createTabGroup()`.

## Split / dock UX

| Action | Module |
|--------|--------|
| Splitter drag | `WorkspaceSplitter.vue` — rAF-throttled ratio, 250ms debounced save |
| Edge snap on drag | `layoutTree.dockToEdge()` — mutates tree on pointer up |
| Lock layout | `layoutLocked` — disables splitters + widget drag/resize |
| Split H/V focused pane | ChartTopBar layout menu → `splitLeaf()` |

## Export / import

`layoutCatalog.ts` — clipboard JSON for LayoutDocument; named entries in catalog localStorage (MMT Layout Hub pattern, client-only).

## Non-goals

- No Golden Layout / Dockview / ImGui dock space
- No FeedHub or worker message contract changes
- No cross-tab SharedWorker (Phase 4 optional)
