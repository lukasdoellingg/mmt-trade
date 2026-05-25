/**
 * Decode MMT.gg v2 WebSocket CBOR heatmap frames → flat levels for our Protobuf wire.
 * Column layout from docs/MMT_WS_CAPTURE.md (keys 0–9).
 */
import cbor from 'cbor';

/**
 * @param {Buffer|Uint8Array} raw
 * @returns {{ ts: number, levels: { price: number, volume: number, isBid: boolean }[], lastPrice?: number, meta?: object } | null}
 */
export function decodeMmtHeatmapMessage(raw) {
  const buf = Buffer.from(raw);
  if (buf.length < 4) return null;

  let envelope;
  try {
    envelope = cbor.decode(buf);
  } catch {
    return null;
  }

  if (Array.isArray(envelope)) envelope = envelope[0];
  if (Buffer.isBuffer(envelope) || envelope instanceof Uint8Array) {
    try {
      envelope = cbor.decode(Buffer.from(envelope));
    } catch {
      return null;
    }
  }
  if (!envelope || typeof envelope !== 'object') return null;

  const colBuf = envelope['3'];
  if (!colBuf) return null;

  let col;
  try {
    col = cbor.decode(Buffer.from(colBuf));
  } catch {
    return null;
  }

  return columnToLevels(col);
}

/**
 * @param {Record<string|number, unknown>} col CBOR map with numeric keys 0–9
 */
export function columnToLevels(col) {
  if (!col || typeof col !== 'object') return null;

  const t0 = col[0] ?? col['0'];
  if (t0 && typeof t0 === 'object') return null; // candles / control column, not OB heatmap

  const ts = Number(t0 ?? 0);
  const askP = col[2] ?? col['2'];
  const askS = col[3] ?? col['3'];
  const bidP = col[4] ?? col['4'];
  const bidS = col[5] ?? col['5'];
  const lastPrice = Number(col[6] ?? col['6'] ?? 0);
  if (!Array.isArray(askP) || !Array.isArray(askS) || !Array.isArray(bidP) || !Array.isArray(bidS)) {
    return null;
  }

  const levels = [];
  if (Array.isArray(askP) && Array.isArray(askS)) {
    const n = Math.min(askP.length, askS.length);
    for (let i = 0; i < n; i++) {
      const vol = +askS[i];
      if (vol > 0) levels.push({ price: +askP[i], volume: vol, isBid: false });
    }
  }
  if (Array.isArray(bidP) && Array.isArray(bidS)) {
    const n = Math.min(bidP.length, bidS.length);
    for (let i = 0; i < n; i++) {
      const vol = +bidS[i];
      if (vol > 0) levels.push({ price: +bidP[i], volume: vol, isBid: true });
    }
  }

  if (!levels.length) return null;

  return {
    ts: ts > 1e12 ? Math.floor(ts / 1000) : ts,
    levels,
    lastPrice: lastPrice > 0 ? lastPrice : undefined,
    meta: col[1] ?? col['1'],
  };
}

/**
 * Downsample MMT-scale columns to maxLevels (log-spaced or top-N by volume).
 * @param {{ price: number, volume: number, isBid: boolean }[]} levels
 * @param {number} maxLevels per side cap (0 = no cap)
 */
/**
 * Decode MMT stream 13 bar-stats CBOR → JSON rows for /ws/barstats clients.
 * @param {Buffer|Uint8Array} raw
 * @returns {{ bars: { ts: number, buyVol: number, sellVol: number, delta: number, pct?: number }[] } | null}
 */
export function decodeMmtBarStatsMessage(raw) {
  const buf = Buffer.from(raw);
  if (buf.length < 4) return null;

  let envelope;
  try {
    envelope = cbor.decode(buf);
  } catch {
    return null;
  }

  if (Array.isArray(envelope)) envelope = envelope[0];
  if (Buffer.isBuffer(envelope) || envelope instanceof Uint8Array) {
    try {
      envelope = cbor.decode(Buffer.from(envelope));
    } catch {
      return null;
    }
  }
  if (!envelope || typeof envelope !== 'object') return null;

  const colBuf = envelope['3'];
  if (!colBuf) return null;

  let col;
  try {
    col = cbor.decode(Buffer.from(colBuf));
  } catch {
    return null;
  }
  if (!col || typeof col !== 'object') return null;

  const openTimes = col[0] ?? col['0'];
  const buyVols = col[7] ?? col['7'] ?? col[2] ?? col['2'];
  const sellVols = col[8] ?? col['8'] ?? col[3] ?? col['3'];

  if (!Array.isArray(openTimes) || !Array.isArray(buyVols) || !Array.isArray(sellVols)) {
    return null;
  }

  const bars = [];
  const n = Math.min(openTimes.length, buyVols.length, sellVols.length);
  for (let i = 0; i < n; i++) {
    let ts = Number(openTimes[i]);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    const buyVol = +buyVols[i] || 0;
    const sellVol = +sellVols[i] || 0;
    const total = buyVol + sellVol;
    bars.push({
      ts,
      buyVol,
      sellVol,
      delta: buyVol - sellVol,
      pct: total > 0 ? ((buyVol - sellVol) / total) * 100 : 0,
    });
  }

  return bars.length ? { bars } : null;
}

export function capLevels(levels, maxLevels = 800) {
  if (!maxLevels || levels.length <= maxLevels * 2) return levels;

  const bids = levels.filter((l) => l.isBid).sort((a, b) => b.price - a.price);
  const asks = levels.filter((l) => !l.isBid).sort((a, b) => a.price - b.price);

  const topN = (arr, n) => {
    if (arr.length <= n) return arr;
    return arr
      .map((l, i) => ({ l, i }))
      .sort((a, b) => b.l.volume - a.l.volume)
      .slice(0, n)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.l);
  };

  return [...topN(bids, maxLevels), ...topN(asks, maxLevels)];
}
