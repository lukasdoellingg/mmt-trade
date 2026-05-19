/**
 * Workspace / widget-grid type definitions.
 *
 * The workspace is a flat list of widgets. Each widget has:
 *   - an immutable `id`
 *   - a `type` that picks the Vue component from the registry
 *   - a `rect` (x, y, w, h) in 8px grid units (CSS pixels = unit * cellPx)
 *   - free-form `props` forwarded to the component
 *
 * Layouts are persisted to localStorage as JSON.
 */

export type WidgetType = 'chart' | 'orderflow-ladder';

export interface WidgetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetState<P = Record<string, unknown>> {
  id: string;
  type: WidgetType;
  rect: WidgetRect;
  /** Stable rendering order (small = behind). */
  z: number;
  /** Widget-specific persistent options (PG, USD/BASE toggle, etc.). */
  props: P;
}

export interface WorkspaceLayout {
  version: number;
  widgets: WidgetState[];
  /** Next free integer id; bumped when widgets are added. */
  nextSerial: number;
}

export interface WidgetRegistryEntry {
  /** Component name as registered via app.component(). */
  componentName: string;
  defaultSize: { w: number; h: number };
  /** Default props clone (shallow). */
  defaultProps: () => Record<string, unknown>;
  /** Title in headers and +Widget menu. */
  label: string;
}
