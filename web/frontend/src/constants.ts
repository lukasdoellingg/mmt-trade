export const EXCHANGE_IDS: Record<string, string> = {
  Binance: 'binance', Coinbase: 'coinbase', Bybit: 'bybit',
  OKX: 'okx', Deribit: 'deribit', Hyperliquid: 'hyperliquid',
};

export const FUTURES_EXCHANGES = ['binance', 'bybit', 'okx', 'deribit', 'hyperliquid'] as const;
export const ALL_EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx'] as const;
export const TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
export const INVERSE_EXCHANGES = new Set(['deribit']);

export const EX_COLORS: Record<string, string> = {
  binance: '#3861fb',
  coinbase: '#5b9cf6',
  bybit: '#00c9c9',
  okx: '#c850c0',
  deribit: '#f5a623',
  hyperliquid: '#e8d44d',
};

export const EX_LABELS: Record<string, string> = {
  binance: 'Binance',
  coinbase: 'Coinbase',
  bybit: 'Bybit',
  okx: 'OKX',
  deribit: 'Deribit',
  hyperliquid: 'Hyperliquid',
};
