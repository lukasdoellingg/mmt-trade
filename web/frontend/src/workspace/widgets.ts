/**
 * Boot-time widget registration. Importing this module from the workspace
 * shell wires component metadata into the registry without pulling in the
 * widget code itself (the components are lazy-loaded by WorkspaceGrid).
 */
import { registerWidget } from './registry';

registerWidget('chart', {
  componentName: 'ChartWidget',
  label: 'Chart',
  defaultSize: { w: 90, h: 90 },
  defaultProps: () => ({}),
});

registerWidget('orderflow-ladder', {
  componentName: 'OrderFlowLadderWidget',
  label: 'Order Flow Ladder',
  defaultSize: { w: 32, h: 45 },
  defaultProps: () => ({
    aggregate: 'binance,bybit',
    pg: 25,
    rowsPerSide: 25,
    quoteUsd: true,
  }),
});
