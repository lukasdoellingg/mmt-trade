/**
 * Tab-group drag coordination — hover 300ms over another header creates a tab stack.
 */
import type { Ref } from 'vue';

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hoverTargetId: string | null = null;
let dragSourceId: string | null = null;

export function beginTabDrag(widgetId: string): void {
  dragSourceId = widgetId;
  clearTabHover();
}

export function endTabDrag(): void {
  dragSourceId = null;
  clearTabHover();
}

export function clearTabHover(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverTargetId = null;
}

export function onHeaderHover(targetWidgetId: string, createTabGroup: (ids: string[]) => void): void {
  if (!dragSourceId || dragSourceId === targetWidgetId) return;
  if (hoverTargetId === targetWidgetId) return;
  clearTabHover();
  hoverTargetId = targetWidgetId;
  hoverTimer = setTimeout(() => {
    if (dragSourceId && hoverTargetId) {
      createTabGroup([dragSourceId, hoverTargetId]);
    }
    endTabDrag();
  }, 300);
}

export function isTabDragging(): boolean {
  return dragSourceId != null;
}

export function injectLayoutLocked(locked: Ref<boolean>): Ref<boolean> {
  return locked;
}
