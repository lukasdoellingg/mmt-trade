/**
 * Runtime Lock Registry — tracks pane leases and focus (LCM Phase 1–2).
 */
import { ref } from 'vue';
import type { LeaseState, RuntimeLeaseRecord, WidgetType, WorkspaceProfile } from './types';

export const focusAnchorId = ref<string | null>(null);

const leases = new Map<string, RuntimeLeaseRecord>();
const slotSuspended = new Set<string>();

export function slotKeyFor(profile: WorkspaceProfile, slot: number): string {
  return profile === 'heatmap' ? 'heatmap' : `futures:${slot}`;
}

export function getLease(anchorId: string): RuntimeLeaseRecord | undefined {
  return leases.get(anchorId);
}

export function registerLease(
  anchorId: string,
  widgetId: string,
  widgetType: WidgetType,
  slotKey: string | null,
): RuntimeLeaseRecord {
  let rec = leases.get(anchorId);
  if (!rec) {
    rec = {
      anchorId,
      widgetId,
      widgetType,
      state: 'cold',
      slotKey,
    };
    leases.set(anchorId, rec);
  } else {
    rec.widgetId = widgetId;
    rec.widgetType = widgetType;
    rec.slotKey = slotKey;
  }
  return rec;
}

export function setLeaseState(anchorId: string, state: LeaseState): void {
  const rec = leases.get(anchorId);
  if (rec) rec.state = state;
}

export function releaseLease(anchorId: string): void {
  const rec = leases.get(anchorId);
  if (rec) {
    rec.state = 'released';
    rec.widgetId = null;
  }
}

export function deleteLease(anchorId: string): void {
  leases.delete(anchorId);
}

export function setFocusAnchor(anchorId: string | null): void {
  focusAnchorId.value = anchorId;
  if (!anchorId) return;
  const rec = leases.get(anchorId);
  if (rec && rec.state !== 'released') {
    rec.state = 'active';
  }
  for (const [aid, lease] of leases) {
    if (aid === anchorId) continue;
    if (lease.widgetType !== 'chart') continue;
    if (lease.state === 'active') lease.state = 'suspended';
  }
}

export function suspendLease(anchorId: string): void {
  const rec = leases.get(anchorId);
  if (rec && rec.state === 'active') rec.state = 'suspended';
}

export function resumeLease(anchorId: string): void {
  const rec = leases.get(anchorId);
  if (rec && (rec.state === 'suspended' || rec.state === 'cold')) {
    rec.state = 'active';
  }
}

/** Phase 2: mark all leases in current slot suspended before layout swap. */
export function suspendSlot(profile: WorkspaceProfile, slot: number): void {
  const key = slotKeyFor(profile, slot);
  slotSuspended.add(key);
  for (const rec of leases.values()) {
    if (rec.slotKey === key && rec.state === 'active') {
      rec.state = 'suspended';
    }
  }
}

export function resumeSlot(profile: WorkspaceProfile, slot: number): void {
  const key = slotKeyFor(profile, slot);
  slotSuspended.delete(key);
  const focus = focusAnchorId.value;
  for (const rec of leases.values()) {
    if (rec.slotKey !== key || rec.state === 'released') continue;
    if (rec.anchorId === focus) rec.state = 'active';
    else if (rec.widgetType === 'chart') rec.state = 'suspended';
    else rec.state = 'active';
  }
}

export function isSlotSuspended(profile: WorkspaceProfile, slot: number): boolean {
  return slotSuspended.has(slotKeyFor(profile, slot));
}

export function resolveWidgetIdForAnchor(
  anchorId: string | null,
  widgets: { id: string; anchorId: string }[],
): string | null {
  if (!anchorId) return null;
  return widgets.find((w) => w.anchorId === anchorId)?.id ?? null;
}

export function resolveAnchorForWidgetId(
  widgetId: string | null,
  widgets: { id: string; anchorId: string }[],
): string | null {
  if (!widgetId) return null;
  return widgets.find((w) => w.id === widgetId)?.anchorId ?? null;
}

/** Widget id for focused chart pane (TopBar). */
export function resolveFocusedChartWidgetId(
  widgets: { id: string; type: string; anchorId: string }[],
): string | null {
  const byAnchor = resolveWidgetIdForAnchor(focusAnchorId.value, widgets);
  if (byAnchor) {
    const w = widgets.find((x) => x.id === byAnchor);
    if (w?.type === 'chart') return byAnchor;
  }
  return [...widgets].reverse().find((w) => w.type === 'chart')?.id ?? null;
}

export function listLeases(): RuntimeLeaseRecord[] {
  return [...leases.values()];
}

export function clearAllLeases(): void {
  leases.clear();
  slotSuspended.clear();
  focusAnchorId.value = null;
}
