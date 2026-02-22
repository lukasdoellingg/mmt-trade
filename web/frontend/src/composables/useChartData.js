/** VWAP D/W/M aus OHLCV. Nur getLastVwapAll wird verwendet. */
export function getLastVwapAll(ohlcv) {
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) return null;
  let dTPV = 0, dVol = 0, wTPV = 0, wVol = 0, mTPV = 0, mVol = 0;
  let dK = '', wK = '', mK = '';
  let lastD = 0, lastW = 0, lastM = 0;
  for (let i = 0; i < ohlcv.length; i++) {
    const b = ohlcv[i];
    const t = b.time;
    const d = new Date(t * 1000);
    const dayK = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const monthK = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    d.setUTCHours(0, 0, 0, 0);
    const weekK = String(d.getTime());
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    if (dayK !== dK) { dTPV = 0; dVol = 0; dK = dayK; }
    dTPV += tp * v; dVol += v; lastD = dVol > 0 ? dTPV / dVol : b.close;
    if (weekK !== wK) { wTPV = 0; wVol = 0; wK = weekK; }
    wTPV += tp * v; wVol += v; lastW = wVol > 0 ? wTPV / wVol : b.close;
    if (monthK !== mK) { mTPV = 0; mVol = 0; mK = monthK; }
    mTPV += tp * v; mVol += v; lastM = mVol > 0 ? mTPV / mVol : b.close;
  }
  return { d: lastD, w: lastW, m: lastM };
}
