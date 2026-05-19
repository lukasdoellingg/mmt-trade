export type AppView = 'futures' | 'chart' | 'cme' | 'tradfi' | 'heatmap';

export interface SymbolSelection {
  exchange: string;
  symbol: string;
  timeframe: string;
}
