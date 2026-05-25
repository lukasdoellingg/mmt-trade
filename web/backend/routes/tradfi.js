/**
 * TradFi REST routes — Yahoo Finance proxies (IPO B2 route split).
 */

const VALID_YAHOO_TICKERS = new Set([
  'DX-Y.NYB',
  '^GSPC',
  'GC=F',
  '^TNX',
  'BTC=F',
  'ETH=F',
  'GBTC',
  'ETHE',
  'IBIT',
  'FBTC',
  'ARKB',
  'BITB',
]);

const ETF_TICKERS_LIST = ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'];

async function yahooChart(ticker, range, interval, deps) {
  const { VALID_YAHOO_RANGES, VALID_YAHOO_INTERVALS } = deps;
  if (!VALID_YAHOO_TICKERS.has(ticker)) throw new Error(`Blocked ticker: ${ticker}`);
  if (!VALID_YAHOO_RANGES.has(range)) range = '1y';
  if (!VALID_YAHOO_INTERVALS.has(interval)) interval = '1d';
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo ${ticker} HTTP ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no data`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const data = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c != null && isFinite(c))
      data.push({
        ts: ts[i] * 1000,
        close: +c,
        open: +(q.open?.[i] || c),
        high: +(q.high?.[i] || c),
        low: +(q.low?.[i] || c),
        volume: +(q.volume?.[i] || 0),
      });
  }
  return data;
}

async function yahooQuote(ticker) {
  if (!VALID_YAHOO_TICKERS.has(ticker)) throw new Error(`Blocked ticker: ${ticker}`);
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo ${ticker} HTTP ${r.status}`);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  return {
    price: meta?.regularMarketPrice ?? null,
    prevClose: meta?.chartPreviousClose ?? null,
    currency: meta?.currency ?? 'USD',
  };
}

async function fetchEtfFlowsFromYahoo(deps) {
  const allData = {};
  await Promise.allSettled(
    ETF_TICKERS_LIST.map(async (ticker) => {
      try {
        const data = await yahooChart(ticker, '1mo', '1d', deps);
        allData[ticker] = data;
      } catch {
        allData[ticker] = [];
      }
    }),
  );

  let holdings = {};
  try {
    const r = await fetch('https://www.btcetfdata.com/v1/current.json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (r.ok) {
      const j = await r.json();
      holdings = j?.data || {};
    }
  } catch {
    /* silent */
  }

  const dateMap = new Map();
  for (const ticker of ETF_TICKERS_LIST) {
    const data = allData[ticker] || [];
    for (let i = 1; i < data.length; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const dateStr = new Date(d.ts).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: '2-digit',
      });
      if (!dateMap.has(dateStr)) dateMap.set(dateStr, { date: dateStr, ts: d.ts });
      const row = dateMap.get(dateStr);
      const priceChange = d.close - prev.close;
      row[ticker] = +((d.volume * priceChange) / 1e6).toFixed(1);
    }
  }

  const rows = [...dateMap.values()].sort((a, b) => a.ts - b.ts);
  for (const row of rows) {
    let total = 0;
    for (const t of ETF_TICKERS_LIST) total += row[t] || 0;
    row.Total = +total.toFixed(1);
  }

  return { rows, holdings };
}

export function registerTradFiRoutes(app, deps) {
  const { cached, setCache, safeSend, safeError, getExchange, ensureMarkets, VALID_YAHOO_RANGES, VALID_YAHOO_INTERVALS } =
    deps;

  app.get('/api/tradfi/overview', async (req, res) => {
    const symbol = req.query.symbol || 'BTC/USDT';
    const base = symbol.split('/')[0];
    const ck = `tradfi:overview:${base}`;
    const c = cached(ck, 120_000);
    if (c) return res.json(c);

    const result = { indices: {}, crypto: {}, grayscale: {} };
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

    for (const key of ['DXY', 'SPX', 'Gold', 'US10Y']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.indices[key] = { price: q.price, change };
      }
    }

    for (const key of ['BTC-CME', 'ETH-CME']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.crypto[key] = { price: q.price, change };
      }
    }

    for (const key of ['GBTC', 'ETHE', 'IBIT', 'FBTC']) {
      const q = quotes[key];
      if (q?.price != null) {
        const change = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
        result.grayscale[key] = { price: q.price, change };
      }
    }

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
      const data = await yahooChart(ticker, range, interval, deps);
      const out = { ticker, range, interval, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });

  app.get('/api/tradfi/cme-history', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const interval = VALID_YAHOO_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const ck = `tradfi:cme:${base}:${range}:${interval}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);

    try {
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, interval, deps);
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
      const result = await fetchEtfFlowsFromYahoo(deps);
      setCache(ck, result);
      safeSend(res, result);
    } catch (e) {
      safeError(res, e);
    }
  });

  app.get('/api/tradfi/cme-options', async (req, res) => {
    const base = (req.query.symbol || 'BTC').toUpperCase();
    const range = VALID_YAHOO_RANGES.has(req.query.range) ? req.query.range : '1y';
    const ck = `tradfi:cme-opt:${base}:${range}`;
    const c = cached(ck, 300_000);
    if (c) return res.json(c);
    try {
      const ticker = base === 'ETH' ? 'ETH=F' : 'BTC=F';
      const data = await yahooChart(ticker, range, '1d', deps);
      const out = { symbol: base, range, data };
      setCache(ck, out);
      safeSend(res, out);
    } catch (e) {
      safeError(res, e);
    }
  });
}
