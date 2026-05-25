/**
 * Market REST routes — klines, OHLCV, tickers, order books (IPO B2 route split).
 */

export function registerMarketRoutes(app, deps) {
  const {
    validateHeatmapSymbol,
    validateTimeframe,
    chartIntervalToBinance,
    clampInteger,
    KLINES_MAX_LIMIT,
    throttle,
    fetchBinanceKlines,
    safeSend,
    validateExchangeId,
    readRequestedSymbol,
    readRequestedTimeframe,
    TIMEFRAMES,
    getExchange,
    ensureMarkets,
    safeError,
    SPOT_EXCHANGES,
    cached,
    setCache,
    withRetry,
    OB_EXCHANGES,
    OB_MAX_LIMITS,
  } = deps;

  app.get('/api/chart/klines', async (req, res) => {
    const sym = validateHeatmapSymbol(req.query.symbol);
    if (!sym) return res.status(400).json({ error: 'Invalid symbol' });
    const tf = validateTimeframe(req.query.tf || req.query.timeframe || '1h') ?? '1h';
    const interval = chartIntervalToBinance(tf);
    const limit = clampInteger(req.query.limit, 500, 1, KLINES_MAX_LIMIT);
    const startTime =
      req.query.startTime != null
        ? clampInteger(req.query.startTime, 0, 0, Number.MAX_SAFE_INTEGER)
        : undefined;
    const endTime =
      req.query.endTime != null ? clampInteger(req.query.endTime, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    try {
      await throttle('binance');
      const klines = await fetchBinanceKlines(sym, interval, {
        limit,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
      });
      safeSend(res, klines);
    } catch (e) {
      const status = e?.status === 429 ? 429 : 502;
      res.status(status).json({ error: 'Klines fetch failed' });
    }
  });

  app.get('/api/ohlcv', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const tf = readRequestedTimeframe(req, res, TIMEFRAMES);
    if (tf === null) return;
    const limit = clampInteger(req.query.limit, 50, 1, 2000);
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      safeSend(res, { ohlcv: await ex.fetchOHLCV(symbol, tf, undefined, limit) });
    } catch (e) {
      safeError(res, e);
    }
  });

  app.get('/api/tickers', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const ck = `tick:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(
      SPOT_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            await throttle(id);
            const ex = getExchange(id);
            await ensureMarkets(ex);
            const t = await ex.fetchTicker(symbol);
            result[id] = {
              last: t.last,
              high: t.high,
              low: t.low,
              change: t.percentage,
              volume: t.baseVolume,
              quoteVolume: t.quoteVolume,
            };
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );
    const out = { symbol, tickers: result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/orderbook', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const limit = clampInteger(req.query.limit, 100, 1, OB_MAX_LIMITS[id] || 500);
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      const book = await ex.fetchOrderBook(symbol, limit);
      safeSend(res, {
        exchange: id,
        symbol,
        bids: book.bids || [],
        asks: book.asks || [],
        timestamp: book.timestamp,
      });
    } catch (e) {
      safeError(res, e);
    }
  });

  app.get('/api/orderbooks', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const result = {};
    await Promise.allSettled(
      OB_EXCHANGES.map(async (id) => {
        try {
          await throttle(id);
          const ex = getExchange(id);
          await ensureMarkets(ex);
          const book = await ex.fetchOrderBook(symbol, OB_MAX_LIMITS[id] || 200);
          result[id] = { bids: book.bids || [], asks: book.asks || [], timestamp: book.timestamp };
        } catch {
          result[id] = { bids: [], asks: [] };
        }
      }),
    );
    safeSend(res, { symbol, orderbooks: result });
  });
}
