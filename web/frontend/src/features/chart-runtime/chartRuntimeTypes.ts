/**
 * Chart widget runtime props — mirrors docs/architecture/object-tree.md ScriptRuntimeMount.
 */
export interface ChartRuntimeAttachment {
  /** Local mount id (widget-scoped). */
  localId: string;
  /** MMT runtime id returned by create_runtime. */
  runtimeId?: string;
  /** Backend script template id. */
  scriptId: string;
  /** Mount status for UI. */
  status: 'mounting' | 'live' | 'error' | 'idle';
  createToken?: number;
  /** overlay on chart pane vs detached workspace window. */
  pane?: 'overlay' | 'window';
  /** When pane=window — workspace widget id hosting this runtime. */
  windowWidgetId?: string;
}

/** Props for script-indicator-pane workspace widget. */
export interface ScriptIndicatorPaneProps {
  scriptId: string;
  localId: string;
  parentChartWidgetId?: string;
  runtimeId?: string;
}

export interface ChartWidgetRuntimeProps {
  runtimes?: ChartRuntimeAttachment[];
}
