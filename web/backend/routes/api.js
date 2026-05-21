import { clampInteger } from '../lib/security.js';

export function mountApiRoutes(app, ctx, metrics) {
  const {
    heatmapUpstreams,
    cached,
    setCache,
    throttle,
    getExchange,
    ensureMarkets,
    withRetry,
    readRequestedSymbol,
    readRequestedTimeframe,
    validateExchangeId,
    safeSend,
    safeError,
    futSym,
    paginatedFetch,
    normalizeFundingTo8h,
    fetchDeribitFundingHistory,
    fetchHyperFundingHistory,
    appendRuntimeOi,
    getRuntimeOiSlice,
    EXCHANGES,
    TIMEFRAMES,
    FUTURES_EXCHANGES,
    SPOT_EXCHANGES,
    OI_HISTORY_EXCHANGES,
    SPOT_BASIS_EXCHANGES,
    OB_EXCHANGES,
    OB_MAX_LIMITS,
    VALID_YAHOO_TICKERS,
    VALID_YAHOO_RANGES,
    VALID_YAHOO_INTERVALS,
    yahooChart,
    yahooQuote,
    fetchEtfFlowsFromYahoo,
  } = ctx;

  app.get('/', (_, res) => res.json({ ok: true, name: 'MMT-Trade API' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'mmt-trade-backend',
      uptimeSec: Math.floor(process.uptime()),
      heatmapUpstreamCount: heatmapUpstreams.size,
      mmtUpstreamEnabled: Boolean(process.env.MMT_WS_TOKEN),
    });
  });

  app.get('/api/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.renderPrometheus(ctx));
  });

  app.get('/api/exchanges', (_, res) => res.json({ exchanges: EXCHANGES }));

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
        if (
          !String(data?.symbol || '')
            .toUpperCase()
            .endsWith('/USDT')
        )
          continue;
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
        } catch {
          /* skip */
        }
      }
    }

    const out = { symbol, history: result };
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

    const out = { symbol, timeframe: tf, liquidations: data };
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

  // --------------- TradFi Routes ---------------

  // CME BTC Futures OI + Volume via CCXT (CME-listed on some exchanges as reference)
  // We use the existing Coinbase spot + Binance futures for basis calculation
  // For actual CME data, we scrape Yahoo Finance CME BTC futures ticker

  app.get('/api/tradfi/overview', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const base = symbol.split('/')[0];
    const ck = `tradfi:overview:${base}`;
    const c = cached(ck, 120_000);
    if (c) return res.json(c);

    const result = { indices: {}, crypto: {}, grayscale: {} };

    // Parallel fetch: DXY, SPX, Gold, 10Y Treasury, BTC spot
    const tickers = {
      DXY: 'DX-Y.NYB',
      SPX: '^GSPC',
      Gold: 'GC=F',
      US10Y: '^TNX',
      'BTC-CME': 'BTC=F',
      'ETH-CME': 'ETH=F',
      GBTC: 'GBTC',
      ETHE: 'ETHE',
      IBIT: 'IBIT',
      FBTC: 'FBTC',
    };

    const quotes = {};
    await Promise.allSettled(
      Object.entries(tickers).map(async ([key, ticker]) => {
        try {
          quotes[key] = await yahooQuote(ticker);
        } catch {
          quotes[key] = null;
        }
      }),
    );

    // Indices
    for (const key of ['DXY', 'SPX', 'Gold', 'US10Y']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.indices[key] = { price: q.price, change };
      }
    }

    // CME BTC/ETH Futures
    for (const key of ['BTC-CME', 'ETH-CME']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.crypto[key] = { price: q.price, change };
      }
    }

    // Grayscale / ETF products
    for (const key of ['GBTC', 'ETHE', 'IBIT', 'FBTC']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.grayscale[key] = { price: q.price, change };
      }
    }

    // CME Basis: CME futures price vs Coinbase spot
    try {
      const cmeBtc = quotes['BTC-CME']?.price;
      if (cmeBtc) {
        const spotEx = getExchange('coinbase', 'spot');
        await ensureMarkets(spotEx);
        const spot = (await spotEx.fetchTicker('BTC/USD')).last;
        if (spot) {
          const premium = (cmeBtc - spot) / spot;
          result.cmeBasis = { spot, futures: cmeBtc, premium, annualized: (premium * 365) / 30 };
        }
      }
    } catch {
      /* skip */
    }

    const out = { symbol: base, ...result };
    setCache(ck, out);
    safeSend(res, out);
  });

  app.get('/api/tradfi/chart', async (req, res) => {
    const ticker = req.query.ticker || 'DX-Y.NYB';
    if (!VALID_YAHOO_TICKERS.has(ticker)) return res.status(400).json({ error: 'Unsupported ticker' });
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const interval = VALID_YAHOO_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const ck = `tradfi:chart:${ticker}:${range}:${interval}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);

    try {
      const data = await yahooChart(ticker, range, interval);
      const out = { ticker, range, interval, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });

  // CME OI + Volume history (via Yahoo Finance volume data for BTC=F)
  app.get('/api/tradfi/cme-history', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const interval = VALID_YAHOO_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const ck = `tradfi:cme:${base}:${range}:${interval}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);

    try {
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, interval);
      const out = { symbol: base, range, interval, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });

  app.get('/api/tradfi/etf-flows', async (req, res) => {
    const ck = 'tradfi:etf-flows';
    const c = cached(ck, 600_000);
    if (c) return res.json(c);
    try {
      const result = await fetchEtfFlowsFromYahoo();
      setCache(ck, result);
      safeSend(res, result);
    } catch (e) {
      safeError(res, e);
    }
  });

  // CME Options data via Yahoo Finance
  app.get('/api/tradfi/cme-options', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const ck = `tradfi:cme-opt:${base}:${range}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);
    try {
      // CME BTC Options use ticker symbol for mini options
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, '1d');
      const out = { symbol: base, range, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });
}
