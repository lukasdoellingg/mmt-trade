/**
 * Central widget registry. Widget Vue components register themselves here so
 * that the workspace grid and the "+ Widget" menu can stay decoupled.
 */
import type { WidgetRegistryEntry, WidgetType } from './types';

const entries = new Map<WidgetType, WidgetRegistryEntry>();

export function registerWidget(type: WidgetType, entry: WidgetRegistryEntry): void {
  entries.set(type, entry);
}

export function getWidget(type: WidgetType): WidgetRegistryEntry | undefined {
  return entries.get(type);
}

export function listWidgets(): { type: WidgetType; entry: WidgetRegistryEntry }[] {
  const out: { type: WidgetType; entry: WidgetRegistryEntry }[] = [];
  for (const [type, entry] of entries) out.push({ type, entry });
  return out;
}
