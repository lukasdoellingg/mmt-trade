/**
 * Boot-time widget registration. Importing this module from the workspace
 * shell wires component metadata into the registry without pulling in the
 * widget code itself (the components are lazy-loaded by WorkspaceGrid).
 */
import {
  DEFAULT_SPOT_AGGREGATE_CSV,
  DEFAULT_PERP_AGGREGATE_CSV,
} from '@shared/exchangeIds';
import { registerWidget } from './registry';

registerWidget('chart', {
  componentName: 'ChartWidget',
  label: 'Chart',
  defaultSize: { w: 90, h: 90 },
  defaultProps: () => ({}),
});
registerWidget('bar-stats', {
  componentName: 'BarStatsWidget',
  label: 'Bar Stats',
  defaultSize: { w: 28, h: 40 },
  defaultProps: () => ({ bucketGroup: 6 }),
});

registerWidget('script-indicator-pane', {
  componentName: 'ScriptIndicatorPaneWidget',
  label: 'Script Indicator',
  defaultSize: { w: 34, h: 30 },
  defaultProps: () => ({
    scriptId: 'key-levels',
    localId: 'key-levels-pane',
  }),
});

registerWidget('orderflow-ladder', {
  componentName: 'OrderFlowLadderWidget',
  label: 'Order Flow Ladder',
  defaultSize: { w: 32, h: 45 },
  defaultProps: () => ({
    aggregate: DEFAULT_SPOT_AGGREGATE_CSV,
    pg: 25,
    rowsPerSide: 25,
    quoteUsd: true,
  }),
});
