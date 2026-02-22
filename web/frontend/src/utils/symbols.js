/** Symbol → WS-Format (btcusdt | BTC-USDT) */
export function symbolToWs(symbol, exId) {
  const s = (symbol || 'BTC/USDT').toUpperCase().replace(/\s/g, '');
  const [base, quote = 'USDT'] = s.split('/');
  if (exId === 'binance' || exId === 'bybit') return (base + quote).toLowerCase();
  if (exId === 'okx' || exId === 'coinbase') return `${base}-${quote}`;
  return (base + quote).toLowerCase();
}
