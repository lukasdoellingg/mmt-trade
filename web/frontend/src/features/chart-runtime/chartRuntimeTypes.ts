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
}

export interface ChartWidgetRuntimeProps {
  runtimes?: ChartRuntimeAttachment[];
}
