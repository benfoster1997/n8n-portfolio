/**
 * data-feeds.js — getting candles into the browser, or failing honestly.
 *
 * ===========================================================================
 * THESE ENDPOINTS WERE NOT VERIFIED FROM A BROWSER.
 *
 * The environment this was built in blocked outbound requests to every market
 * data host (the egress proxy returned 403 for api.binance.com,
 * api.kraken.com, api.exchange.coinbase.com and the rest), so the CORS
 * behaviour below is documented intent, not something observed working.
 *
 * Your iPhone is not behind that proxy, so they may well work fine for you.
 * But because that could not be confirmed, the design assumes failure:
 *   - every source is tried in turn and the first success wins;
 *   - the UI always shows WHICH source answered, so a silent fallback to
 *     stale or wrong data is impossible;
 *   - MANUAL mode needs no network at all and is always available.
 *
 * The news calendar, the risk maths and the session clock are all pure
 * client-side computation and work whether or not any of this succeeds.
 * ===========================================================================
 */

const TIMEOUT_MS = 9000;

/**
 * Deliberately header-free.
 *
 * Every CORS failure traced while researching these endpoints originated in a
 * custom request header. Any of Authorization, X-MBX-APIKEY, a custom Accept
 * or a custom User-Agent turns a simple request into a PREFLIGHTED one, and
 * these hosts do not answer the OPTIONS. A bare fetch(url) succeeds where the
 * same request with one extra header fails. That is why API keys go in the
 * query string here rather than in a header.
 *
 * So: do not add a `headers` option to this function. It is absent on purpose.
 */
async function fetchJson(url, { timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every adapter normalises to this shape. Timestamps are epoch MILLISECONDS. */
const bar = (t, o, h, l, c, v) => ({
  t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0,
});

const sane = (bars) =>
  bars.filter((b) =>
    Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.h) &&
    Number.isFinite(b.l) && Number.isFinite(b.c) && b.h >= b.l && b.t > 0)
    .sort((a, b) => a.t - b.t);

/* ------------------------------------------------------------- bitcoin */

export const BTC_SOURCES = [
  {
    id: 'binance-vision',
    label: 'Binance (BTCUSDT)',
    instrument: 'BTCUSDT — tether-quoted, not BTCUSD',
    needsKey: false,
    note: 'The public market-data host, intended for exactly this kind of unauthenticated use.',
    async fetch(limit = 300) {
      const d = await fetchJson(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`);
      return sane(d.map((k) => bar(k[0], k[1], k[2], k[3], k[4], k[5])));
    },
  },
  {
    id: 'binance',
    label: 'Binance main (BTCUSDT)',
    instrument: 'BTCUSDT — tether-quoted, not BTCUSD',
    needsKey: false,
    note: 'Same data, the main API host.',
    async fetch(limit = 300) {
      const d = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`);
      return sane(d.map((k) => bar(k[0], k[1], k[2], k[3], k[4], k[5])));
    },
  },
  {
    id: 'coinbase',
    label: 'Coinbase (BTC-USD)',
    instrument: 'true BTC/USD',
    needsKey: false,
    note: 'Genuine dollar pricing rather than tether. Returns newest first, capped at 300 candles.',
    async fetch() {
      const d = await fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300');
      // [ time(s), low, high, open, close, volume ]
      return sane(d.map((k) => bar(k[0] * 1000, k[3], k[2], k[1], k[4], k[5])));
    },
  },
  {
    id: 'kraken',
    label: 'Kraken (XBT/USD)',
    instrument: 'true BTC/USD',
    needsKey: false,
    note: 'Genuine dollar pricing.',
    async fetch() {
      const d = await fetchJson('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5');
      if (d.error && d.error.length) throw new Error(d.error.join(', '));
      const key = Object.keys(d.result).find((k) => k !== 'last');
      return sane(d.result[key].map((k) => bar(k[0] * 1000, k[1], k[2], k[3], k[4], k[6])));
    },
  },
  {
    id: 'okx',
    label: 'OKX (BTC-USDT)',
    instrument: 'BTCUSDT — tether-quoted',
    needsKey: false,
    note: 'Newest first.',
    async fetch(limit = 300) {
      const d = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=5m&limit=${Math.min(300, limit)}`);
      if (d.code !== '0') throw new Error(d.msg || 'OKX error');
      return sane(d.data.map((k) => bar(k[0], k[1], k[2], k[3], k[4], k[5])));
    },
  },
  {
    id: 'bitstamp',
    label: 'Bitstamp (BTC/USD)',
    instrument: 'true BTC/USD',
    needsKey: false,
    note: 'Genuine dollar pricing.',
    async fetch(limit = 300) {
      const d = await fetchJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=300&limit=${Math.min(1000, limit)}`);
      return sane(d.data.ohlc.map((k) => bar(k.timestamp * 1000, k.open, k.high, k.low, k.close, k.volume)));
    },
  },
];

/* ---------------------------------------------------------------- gold */

/**
 * Gold is the hard one. There is no free, key-free, CORS-enabled source of
 * 5-minute XAU/USD history that could be confirmed. The realistic options all
 * want a free API key, so the tool asks for one rather than pretending.
 */
export const XAU_SOURCES = [
  {
    id: 'twelvedata',
    label: 'Twelve Data',
    needsKey: true,
    keyUrl: 'https://twelvedata.com/pricing',
    note: 'Free tier is rate-limited per minute and per day. At one poll a minute a single session can exhaust a day\'s allowance, so the tool polls conservatively and backs off on a 429.',
    async fetch(limit = 300, key) {
      if (!key) throw new Error('needs an API key');
      const d = await fetchJson(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=${limit}&apikey=${encodeURIComponent(key)}`);
      if (d.status === 'error') throw new Error(d.message || 'Twelve Data error');
      if (!d.values) throw new Error('no values returned');
      return sane(d.values.map((v) => bar(
        new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
        v.open, v.high, v.low, v.close, v.volume,
      )));
    },
  },
  {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    needsKey: true,
    keyUrl: 'https://www.alphavantage.co/support/#api-key',
    note: 'Free tier is very tightly rate-limited. Intraday FX coverage of XAU/USD is inconsistent — verify before relying on it.',
    async fetch(limit = 300, key) {
      if (!key) throw new Error('needs an API key');
      const d = await fetchJson(`https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=XAU&to_symbol=USD&interval=5min&outputsize=full&apikey=${encodeURIComponent(key)}`);
      const series = d['Time Series FX (5min)'];
      if (!series) throw new Error(d.Note || d['Error Message'] || 'no series returned');
      return sane(Object.entries(series).slice(0, limit).map(([ts, v]) => bar(
        new Date(ts.replace(' ', 'T') + 'Z').getTime(),
        v['1. open'], v['2. high'], v['3. low'], v['4. close'], 0,
      )));
    },
  },
  {
    id: 'paxg-kraken',
    label: 'PAXG proxy (Kraken)',
    needsKey: false,
    proxy: true,
    note: 'NOT GOLD. PAXG is a token redeemable for gold; it tracks spot loosely but carries its own premium, its own liquidity and its own spread. Usable to see shape and rough structure when nothing else is available. Never size a position from it.',
    async fetch() {
      const d = await fetchJson('https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=5');
      if (d.error && d.error.length) throw new Error(d.error.join(', '));
      const key = Object.keys(d.result).find((k) => k !== 'last');
      return sane(d.result[key].map((k) => bar(k[0] * 1000, k[1], k[2], k[3], k[4], k[6])));
    },
  },
];

/**
 * Try each source in order. Returns the bars plus a full account of what was
 * attempted, so the UI can name the source and show what failed.
 */
export async function loadBars(pair, { keys = {}, limit = 300, preferred = null, allowProxy = false } = {}) {
  const all = pair === 'BTCUSD' ? BTC_SOURCES : XAU_SOURCES;
  let sources = allowProxy ? all : all.filter((s) => !s.proxy);
  if (preferred) {
    const i = sources.findIndex((s) => s.id === preferred);
    if (i > 0) sources = [sources[i], ...sources.slice(0, i), ...sources.slice(i + 1)];
  }

  const attempts = [];
  for (const src of sources) {
    if (src.needsKey && !keys[src.id]) {
      attempts.push({ id: src.id, label: src.label, ok: false, reason: 'no API key saved' });
      continue;
    }
    try {
      const bars = await src.fetch(limit, keys[src.id]);
      if (!bars.length) throw new Error('returned no usable bars');
      attempts.push({ id: src.id, label: src.label, ok: true, bars: bars.length });
      return {
        ok: true, bars, source: src, attempts,
        proxyWarning: src.proxy ? src.note : null,
        staleness: Date.now() - bars[bars.length - 1].t,
      };
    } catch (e) {
      attempts.push({ id: src.id, label: src.label, ok: false, reason: String(e.message || e) });
    }
  }
  return {
    ok: false, bars: [], source: null, attempts,
    reason: 'No data source answered. This is expected if the endpoints are blocked on your network, or if gold needs an API key you have not entered yet. Manual mode below works without any of them.',
  };
}

/**
 * Turn typed-in values into a usable bar series.
 *
 * Manual mode is not a toy fallback — it is the mode that always works, and on
 * a phone next to an open MT5 chart it is often faster than waiting for an API.
 * You read the numbers off your own broker's chart, which means the analysis
 * is running on YOUR prices rather than a reference feed that differs from them.
 */
export function manualBars(rows) {
  return sane(rows.map((r) => bar(r.t, r.o, r.h, r.l, r.c, r.v || 0)));
}

/**
 * Live spread as a fraction of current ATR — the single ratio that decides
 * whether a five-minute scalp is viable at all.
 *
 * Above roughly 40% the cost structure is broken: the spread consumes so much
 * of the available range that even a correct read loses money over a series.
 */
export function spreadViability(spread, atrValue) {
  if (!(spread > 0) || !(atrValue > 0)) return { ok: null, reason: 'need both a live spread and an ATR reading' };
  const ratio = spread / atrValue;
  return {
    ok: ratio <= 0.4,
    ratio,
    pct: +(ratio * 100).toFixed(0),
    verdict:
      ratio <= 0.15 ? 'healthy — the spread is a small fraction of the available range'
        : ratio <= 0.25 ? 'workable, but the spread is a real drag'
          : ratio <= 0.4 ? 'expensive — the spread is eating a quarter to a third of a typical bar'
            : 'not viable — the spread is too large a share of the range to scalp against',
  };
}

/**
 * A keyless spot-gold price, for sanity-checking whatever the candle feed says.
 *
 * It returns a single number with no history, so it cannot drive the analysis.
 * Its job is narrower and useful: if the PAXG proxy is standing in for gold,
 * this says how far the proxy has drifted from the real thing.
 */
export async function goldSpotCheck() {
  try {
    const d = await fetchJson('https://api.gold-api.com/price/XAU');
    const price = Number(d.price ?? d.Price ?? d.value);
    return Number.isFinite(price) ? { ok: true, price } : { ok: false };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}
