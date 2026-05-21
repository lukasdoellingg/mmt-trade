/**
 * Cross-cutting domain types shared by the workspace shell, widgets and
 * chart settings.
 *
 * `AppView` used to enumerate Dashboard/Trade/TradFi/CME — those views were
 * retired with the move to a single mmt.gg-style workspace surface. The type
 * is kept as a single-member union so future workspace presets (e.g. options
 * desk, perp desk) plug in cleanly without churning import sites.
 */
export type AppView = 'heatmap';

export interface SymbolSelection {
  exchange: string;
  symbol: string;
  timeframe: string;
}
