/**
 * Derivatives REST routes — funding, OI, basis, liquidations, futures scanner (IPO B2).
 */

export function registerDerivativesRoutes(app, deps) {
  const {
    readRequestedSymbol,
    readRequestedTimeframe,
    TIMEFRAMES,
    clampInteger,
    cached,
    setCache,
    safeSend,
    safeError,
    FUTURES_EXCHANGES,
    futSym,
    withRetry,
    throttle,
    getExchange,
    ensureMarkets,
    paginatedFetch,
    fetchDeribitFundingHistory,
    fetchHyperFundingHistory,
    normalizeFundingTo8h,
    appendRuntimeOi,
    getRuntimeOiSlice,
    OI_HISTORY_EXCHANGES,
    SPOT_BASIS_EXCHANGES,
  } = deps;

  app.get('/api/futures-ohlcv-multi', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const tf = readRequestedTimeframe(req, res, TIMEFRAMES);
    if (tf === null) return;
    const limit = clampInteger(req.query.limit, 168, 1, 720);
    const ck = `fohlcv:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, id);
            await throttle(id);
            const ex = getExchange(id, 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            result[id] = await ex.fetchOHLCV(fs, tf, undefined, limit);
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );
    const out = { symbol, timeframe: tf, ohlcv: result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/futures-tickers', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const ck = `ftick:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, id);
            await throttle(id);
            const ex = getExchange(id, 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            const t = await ex.fetchTicker(fs);
            let qv = t.quoteVolume;
            const market = ex.market(fs);
            if (id === 'deribit') {
              qv = +t.info?.stats?.volume_usd || qv;
            }
            if (!qv && t.baseVolume && t.last) {
              const cs = market?.contractSize || 1;
              qv = market?.contract ? t.baseVolume * cs * t.last : t.baseVolume * t.last;
            }
            result[id] = { last: t.last, quoteVolume: qv, baseVolume: t.baseVolume };
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

  app.get('/api/futures-scanner', async (req, res) => {
    const defaultSymbols =
      'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,MATIC,LTC,UNI,ATOM,NEAR,APT,ARB,OP,SUI,FIL';
    const raw = req.query.symbols ? String(req.query.symbols) : defaultSymbols;
    const bases = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!bases.length) {
      res.status(400).json({ error: 'symbols required' });
      return;
    }
    const ck = `fscan:${bases.join(',')}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);

    const rows = [];
    await Promise.allSettled(
      bases.map(async (base) => {
        const symbol = base.includes('/') ? base : `${base}/USDT`;
        const row = { symbol, base: symbol.split('/')[0], vol24h: 0, fundingApr: 0, oi: 0, change24h: 0 };
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, 'binance');
            await throttle('binance');
            const ex = getExchange('binance', 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            const [ticker, funding, oiSnap] = await Promise.all([
              ex.fetchTicker(fs),
              ex.fetchFundingRate(fs).catch(() => null),
              ex.fetchOpenInterest(fs).catch(() => null),
            ]);
            row.vol24h = ticker.quoteVolume || 0;
            if (ticker.percentage != null) row.change24h = ticker.percentage;
            else if (ticker.open && ticker.last) row.change24h = ((ticker.last - ticker.open) / ticker.open) * 100;
            if (funding?.fundingRate != null) {
              const rate8h = normalizeFundingTo8h([{ ts: funding.timestamp || Date.now(), rate: funding.fundingRate }])[0]
                ?.rate ?? funding.fundingRate;
              row.fundingApr = rate8h * 3 * 365 * 100;
            }
            if (oiSnap) {
              row.oi = oiSnap.openInterestValue || 0;
              if (!row.oi && oiSnap.openInterestAmount && ticker.last) {
                row.oi = oiSnap.openInterestAmount * ticker.last;
              }
            }
          });
        } catch (e) {
          row.error = e.message;
        }
        rows.push(row);
      }),
    );
    rows.sort((a, b) => (b.vol24h || 0) - (a.vol24h || 0));
    const out = { rows };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/funding-rates', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const limit = clampInteger(req.query.limit, 100, 1, 720);
    const ck = `fr:${symbol}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const base = symbol.split('/')[0];
    const result = {};
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            if (id === 'deribit') {
              result[id] = await fetchDeribitFundingHistory(base, limit);
              return;
            }
            if (id === 'hyperliquid') {
              result[id] = await fetchHyperFundingHistory(base, limit);
              return;
            }
            const fs = futSym(symbol, id);
            const ex = getExchange(id, 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            const all = await paginatedFetch(
              (since, lim) => ex.fetchFundingRateHistory(fs, since, lim),
              id,
              limit,
              limit * 8 * 3600_000,
            );
            result[id] = normalizeFundingTo8h(all.map((r) => ({ ts: r.timestamp, rate: r.fundingRate })));
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );
    const out = { symbol, rates: result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/open-interest', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const ck = `oi:${symbol}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, id);
            await throttle(id);
            const ex = getExchange(id, 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            const oi = await ex.fetchOpenInterest(fs);
            let val = oi.openInterestValue;
            if (!val && oi.openInterestAmount) {
              const t = await ex.fetchTicker(fs);
              val = oi.openInterestAmount * (t.last || 0);
            }
            appendRuntimeOi(id, oi.timestamp, val || 0);
            result[id] = { oi: val || 0, ts: oi.timestamp };
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );
    const out = { symbol, openInterest: result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/open-interest-history', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const tf = readRequestedTimeframe(req, res, TIMEFRAMES);
    if (tf === null) return;
    const limit = clampInteger(req.query.limit, 168, 1, 720);
    const ck = `oih:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);
    const result = {};
    await Promise.allSettled(
      OI_HISTORY_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, id);
            const ex = getExchange(id, 'swap');
            if (!ex) return;
            await ensureMarkets(ex);
            const all = await paginatedFetch(
              (since, lim) => ex.fetchOpenInterestHistory(fs, tf, since, lim),
              id,
              limit,
              limit * 3600_000,
            );
            let price = 0;
            if (all.length > 0 && !all[0].openInterestValue && all[0].openInterestAmount) {
              try {
                price = (await ex.fetchTicker(fs)).last || 0;
              } catch {
                /* 0 */
              }
            }
            result[id] = all.map((r) => ({
              ts: r.timestamp,
              oi: r.openInterestValue || r.openInterestAmount * price || 0,
            }));
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );

    const syntheticExchanges = [];
    for (const id of ['deribit', 'hyperliquid']) {
      if (result[id]) continue;
      const arr = getRuntimeOiSlice(id, limit);
      if (arr.length >= 2) {
        result[id] = arr;
      } else {
        try {
          const fs = futSym(symbol, id);
          const ex = getExchange(id, 'swap');
          await ensureMarkets(ex);
          const oi = await ex.fetchOpenInterest(fs);
          let val = oi.openInterestValue || 0;
          if (!val && oi.openInterestAmount) {
            const t = await ex.fetchTicker(fs);
            val = oi.openInterestAmount * (t.last || 0);
          }
          const now = Date.now();
          const pts = Math.min(limit, 24);
          result[id] = Array.from({ length: pts }, (_, i) => ({
            ts: now - (pts - 1 - i) * 3600_000,
            oi: val,
          }));
          syntheticExchanges.push(id);
        } catch {
          /* skip */
        }
      }
    }

    const out = {
      symbol,
      history: result,
      synthetic: syntheticExchanges.length > 0,
      syntheticExchanges,
    };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/basis', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const ck = `basis:${symbol}`;
    const c = cached(ck, 30000);
    if (c) return res.json(c);

    let binanceSpotPrice = null;
    try {
      await throttle('binance');
      const binSpot = getExchange('binance', 'spot');
      await ensureMarkets(binSpot);
      binanceSpotPrice = (await binSpot.fetchTicker(symbol)).last;
    } catch {
      /* fallback */
    }

    const result = {};
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          await withRetry(async () => {
            const fs = futSym(symbol, id);
            await throttle(id);
            const futEx = getExchange(id, 'swap');
            if (!futEx) return;
            await ensureMarkets(futEx);
            const futTicker = await futEx.fetchTicker(fs);
            const futPrice = futTicker.last;
            let spotPrice = null;

            if (SPOT_BASIS_EXCHANGES.includes(id)) {
              try {
                const spotEx = getExchange(id, 'spot');
                await ensureMarkets(spotEx);
                spotPrice = (await spotEx.fetchTicker(symbol)).last;
              } catch {
                /* fallback */
              }
            }
            if (id === 'deribit') {
              const idx = futTicker.info?.index_price || futTicker.info?.underlying_price;
              if (idx) spotPrice = +idx;
            }
            if (!spotPrice && binanceSpotPrice) spotPrice = binanceSpotPrice;

            if (spotPrice && futPrice) {
              const premium = (futPrice - spotPrice) / spotPrice;
              result[id] = { spot: spotPrice, futures: futPrice, premium, annualized: (premium * 365) / 90 };
            } else {
              result[id] = { futures: futPrice, premium: null };
            }
          });
        } catch (e) {
          result[id] = { error: e.message };
        }
      }),
    );
    const out = { symbol, basis: result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/liquidations', async (req, res) => {
    const symbol = readRequestedSymbol(req, res);
    if (symbol === null) return;
    const tf = readRequestedTimeframe(req, res, TIMEFRAMES);
    if (tf === null) return;
    const limit = clampInteger(req.query.limit, 168, 1, 720);
    const ck = `liq:${symbol}:${tf}:${limit}`;
    const c = cached(ck);
    if (c) return res.json(c);

    const allCandles = {};
    const isInverse = new Set(['deribit']);
    await Promise.allSettled(
      FUTURES_EXCHANGES.map(async (id) => {
        try {
          const fs = futSym(symbol, id);
          await throttle(id);
          const ex = getExchange(id, 'swap');
          if (!ex) return;
          await ensureMarkets(ex);
          allCandles[id] = await ex.fetchOHLCV(fs, tf, undefined, limit);
        } catch {
          /* skip */
        }
      }),
    );

    const tsMap = new Map();
    for (const [id, candles] of Object.entries(allCandles)) {
      if (!Array.isArray(candles)) continue;
      for (const c of candles) {
        const ts = c[0],
          open = +c[1],
          close = +c[4],
          vol = +c[5] || 0;
        const volUsd = isInverse.has(id) ? vol : vol * close;
        const prev = tsMap.get(ts) || { ts, totalVol: 0, weightedReturn: 0 };
        prev.totalVol += volUsd;
        prev.weightedReturn += (open > 0 ? (close - open) / open : 0) * volUsd;
        tsMap.set(ts, prev);
      }
    }

    const entries = [...tsMap.values()].sort((a, b) => a.ts - b.ts);
    const avgVol = entries.length > 0 ? entries.reduce((s, e) => s + e.totalVol, 0) / entries.length : 1;

    const data = entries.map((e) => {
      const volRatio = e.totalVol / (avgVol || 1);
      const weightedMove = e.totalVol > 0 ? e.weightedReturn / e.totalVol : 0;
      const direction = weightedMove >= 0 ? 1 : -1;
      const spike = Math.max(0.2, volRatio - 0.9);
      return { ts: e.ts, liq: direction * spike * Math.abs(weightedMove) * e.totalVol * 2 };
    });

    const out = { symbol, timeframe: tf, synthetic: true, liquidations: data };
    setCache(ck, out);
    safeSend(res, out);
  });
}
