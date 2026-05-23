/**
 * Bootstrap REST routes — exchange list and symbol discovery.
 */

export function registerBootstrapRoutes(app, deps) {
  const {
    EXCHANGES,
    validateExchangeId,
    clampInteger,
    cached,
    setCache,
    safeSend,
    safeError,
    throttle,
    getExchange,
    ensureMarkets,
  } = deps;

  app.get('/', (_req, res) => res.json({ ok: true, name: 'MMT-Trade API' }));
  app.get('/api/exchanges', (_req, res) => res.json({ exchanges: EXCHANGES }));

  app.get('/api/symbols', async (req, res) => {
    const id = validateExchangeId(req.query.exchange);
    if (!id) return res.status(400).json({ error: 'Unsupported exchange' });
    const limit = clampInteger(req.query.limit, 10, 1, 20);
    const ck = `symbols:${id}:${limit}`;
    const c = cached(ck, 120_000);
    if (c) return res.json(c);
    try {
      await throttle(id);
      const ex = getExchange(id);
      await ensureMarkets(ex);
      const tickers = await ex.fetchTickers();
      const list = [];
      for (const data of Object.values(tickers)) {
        if (!String(data?.symbol || '').toUpperCase().endsWith('/USDT')) continue;
        list.push({ symbol: data.symbol, volume: Number(data?.quoteVolume ?? 0) });
      }
      list.sort((a, b) => b.volume - a.volume);
      const out = { symbols: list.slice(0, limit) };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });
}
