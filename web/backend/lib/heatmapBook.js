/**
 * Order-book maps → HeatmapFrame levels (shared Binance + aggregate paths).
 *
 * Zero-allocation hot path: a single pre-allocated Float64Array per side is
 * reused on every tick instead of building intermediate [price, qty] tuples.
 * Only the final per-level objects required by the protobuf encoder are
 * allocated, and they are recycled across calls via a pooled level array.
 */

export const HEATMAP_MAX_LEVELS = Number(process.env.HEATMAP_MAX_LEVELS || 800);
export const HEATMAP_MAX_BOOK_SIZE = Number(process.env.HEATMAP_MAX_BOOK_SIZE || 5000);

const bidPriceScratch = new Float64Array(HEATMAP_MAX_BOOK_SIZE);
const bidVolumeScratch = new Float64Array(HEATMAP_MAX_BOOK_SIZE);
const askPriceScratch = new Float64Array(HEATMAP_MAX_BOOK_SIZE);
const askVolumeScratch = new Float64Array(HEATMAP_MAX_BOOK_SIZE);
const sortIndexScratch = new Uint32Array(HEATMAP_MAX_BOOK_SIZE);

/** Pool of per-level objects reused across encode calls. */
const pooledLevels = [];
function acquireLevel(price, volume, isBid) {
  const reused = pooledLevels.pop();
  if (reused) {
    reused.price = price;
    reused.volume = volume;
    reused.isBid = isBid;
    return reused;
  }
  return { price, volume, isBid };
}

/** Reusable output array — caller must consume synchronously. */
const outputLevels = [];

/**
 * Drop ascending-price entries beyond HEATMAP_MAX_BOOK_SIZE to bound memory.
 * Bids keep the highest prices, asks keep the lowest.
 */
export function pruneBookSide(map, isBid) {
  if (map.size <= HEATMAP_MAX_BOOK_SIZE) return;
  const sortedDescending = isBid
    ? [...map].sort((a, b) => +b[0] - +a[0])
    : [...map].sort((a, b) => +a[0] - +b[0]);
  map.clear();
  for (let i = 0; i < HEATMAP_MAX_BOOK_SIZE; i++) {
    const [price, volume] = sortedDescending[i];
    map.set(String(price), volume);
  }
}

/**
 * Copy book side into scratch arrays, returning the number of entries written.
 * Caller must not retain the returned scratch slice across ticks.
 */
function loadSideIntoScratch(map, priceOut, volumeOut) {
  let writeIndex = 0;
  const cap = priceOut.length;
  for (const [priceString, volume] of map) {
    if (writeIndex >= cap) break;
    priceOut[writeIndex] = +priceString;
    volumeOut[writeIndex] = volume;
    writeIndex += 1;
  }
  return writeIndex;
}

/** Sort an index array so prices[indexOut[i]] is monotonic in the requested direction. */
function sortIndices(prices, length, indexOut, descending) {
  for (let i = 0; i < length; i++) indexOut[i] = i;
  // Sort a subarray view of the typed index buffer to avoid allocations.
  const view = indexOut.subarray(0, length);
  if (descending) {
    view.sort((a, b) => prices[b] - prices[a]);
  } else {
    view.sort((a, b) => prices[a] - prices[b]);
  }
}

export function bookToLevels(bids, asks, maxLevels = HEATMAP_MAX_LEVELS) {
  pruneBookSide(bids, true);
  pruneBookSide(asks, false);

  // Return previously emitted level objects to the pool.
  for (let i = 0; i < outputLevels.length; i++) pooledLevels.push(outputLevels[i]);
  outputLevels.length = 0;

  const bidCount = loadSideIntoScratch(bids, bidPriceScratch, bidVolumeScratch);
  sortIndices(bidPriceScratch, bidCount, sortIndexScratch, /* descending */ true);
  const bidLimit = Math.min(bidCount, maxLevels);
  for (let i = 0; i < bidLimit; i++) {
    const idx = sortIndexScratch[i];
    outputLevels.push(acquireLevel(bidPriceScratch[idx], bidVolumeScratch[idx], true));
  }

  const askCount = loadSideIntoScratch(asks, askPriceScratch, askVolumeScratch);
  sortIndices(askPriceScratch, askCount, sortIndexScratch, /* descending */ false);
  const askLimit = Math.min(askCount, maxLevels);
  for (let i = 0; i < askLimit; i++) {
    const idx = sortIndexScratch[i];
    outputLevels.push(acquireLevel(askPriceScratch[idx], askVolumeScratch[idx], false));
  }

  return outputLevels;
}

export function encodeHeatmapFrame(HeatmapFrame, ts, levels) {
  if (!levels.length) return null;
  return HeatmapFrame.encode(HeatmapFrame.create({ ts, levels })).finish();
}

export function broadcastToClients(clients, payload) {
  if (!payload) return;
  for (const client of clients) {
    if (client.readyState === 1) {
      try { client.send(payload); } catch { /* ignore */ }
    }
  }
}
