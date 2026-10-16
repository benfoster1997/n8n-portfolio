/**
 * The history cache (desk/history.mjs): years of closed bars, merged and never
 * truncated, fetched from Binance (bitcoin) and Twelve Data (gold). Every feed
 * here is a stand-in fetch that serves a made-up market and records the calls,
 * and every wait is a stand-in sleep that records how long it was asked for,
 * so nothing touches the network and nothing really waits.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadHistory, mergeBars, gapsIn, gapInWindow, gapsDuring, historyPath, historyPair,
  BINANCE_PAGE, TWELVE_PAGE, TWELVE_SPACING_MS, TWELVE_LIMIT_WAIT_MS, MAX_RETRIES,
} from '../desk/history.mjs';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  };
  pending.push(run);
};

const M15 = 15 * 60000, M5 = 5 * 60000;
const home = () => mkdtempSync(join(tmpdir(), 'scalp-history-'));
const readCacheFile = (h, pair = 'BTCUSD', tf = 'M15') => JSON.parse(readFileSync(historyPath(pair, tf, h), 'utf8'));
const readMetaFile = (h, pair = 'BTCUSD', tf = 'M15') => JSON.parse(readFileSync(historyPath(pair, tf, h).replace(/\.json$/, '.meta.json'), 'utf8'));
const writeCacheFile = (h, bars, pair = 'BTCUSD', tf = 'M15') => {
  mkdirSync(join(h, 'history'), { recursive: true });
  writeFileSync(historyPath(pair, tf, h), JSON.stringify(bars));
};

/** A made-up market: one bar every `ms` from `t0`, `n` of them, prices from the index. */
function market(t0, n, ms = M15, price = 60000) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const o = price + i;
    bars.push({ t: t0 + i * ms, o, h: o + 5, l: o - 5, c: o + 1, v: 10 + (i % 7) });
  }
  return bars;
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * Binance's klines as the stand-in: bars from startTime, `limit` at most, and
 * like the real one it includes the bar still forming at `nowMs`.
 */
function binanceStub(bars, nowMs, { fail = () => null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const f = fail(calls.length, u);
    if (f) return f();
    const start = Number(u.searchParams.get('startTime')), limit = Number(u.searchParams.get('limit'));
    const page = bars.filter((b) => b.t >= start && b.t <= nowMs).slice(0, limit);
    return json(page.map((b) => [b.t, String(b.o), String(b.h), String(b.l), String(b.c), String(b.v), b.t + M15 - 1]));
  };
  return { fetchImpl, calls };
}

const tdTime = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
const tdStamp = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
/**
 * Twelve Data's time_series as the stand-in: newest first, `outputsize` at
 * most, end_date inclusive (so paging back overlaps one bar), no volume for
 * gold, prices as strings. `script` may answer a call instead.
 */
function twelveStub(bars, nowMs, { script = () => null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const s = script(calls.length, u);
    if (s) return s();
    const start = u.searchParams.get('start_date') ? tdTime(u.searchParams.get('start_date')) : -Infinity;
    const end = tdTime(u.searchParams.get('end_date'));
    const size = Number(u.searchParams.get('outputsize'));
    const page = bars.filter((b) => b.t >= start && b.t <= end && b.t <= nowMs).sort((a, b) => b.t - a.t).slice(0, size);
    if (!page.length) return json({ code: 400, message: 'No data is available on the specified dates. Try setting different start/end dates.', status: 'error' });
    return json({
      meta: { symbol: 'XAU/USD', interval: u.searchParams.get('interval') },
      values: page.map((b) => ({ datetime: tdStamp(b.t), open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c) })),
      status: 'ok',
    });
  };
  return { fetchImpl, calls };
}
const sleeper = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };

console.log('\nthe cache file');
test('the path is <home>/history/<PAIR>-<TF>.json, whatever the instrument and timeframe are called', () => {
  assert.equal(historyPath('bitcoin', '15', '/h'), '/h/history/BTCUSD-M15.json');
  assert.equal(historyPath('XAU/USD', 'm5', '/h'), '/h/history/XAUUSD-M5.json');
  assert.equal(historyPair('gold'), 'XAUUSD');
  assert.equal(historyPair('EURUSD'), null);
  assert.throws(() => historyPath('EURUSD', 'M15', '/h'));
});
test('mergeBars dedupes by t, sorts, lets the second list win a tie, and changes neither input', () => {
  const a = [{ t: 3, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 2, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const b = [{ t: 2, o: 9, h: 9, l: 9, c: 9 }, { t: 4, o: 2, h: 2, l: 2, c: 2, v: 3 }];
  const aCopy = JSON.stringify(a), bCopy = JSON.stringify(b);
  const m = mergeBars(a, b);
  assert.deepEqual(m.map((x) => x.t), [1, 2, 3, 4]);
  assert.deepEqual(m[1], { t: 2, o: 9, h: 9, l: 9, c: 9, v: 0 });      // fresher copy; no volume → 0
  assert.equal(JSON.stringify(a), aCopy);
  assert.equal(JSON.stringify(b), bCopy);
  assert.deepEqual(mergeBars([{ t: 5, o: 'x', h: 1, l: 1, c: 1 }], []), []);   // a bar with a bad price is dropped
});

console.log('\nbitcoin from Binance');
test('pages forward 1,000 at a time and stops at the short page; the bar still forming is not kept', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 0, 1);
  const bars = market(t0, 2037);
  const nowMs = t0 + 2036 * M15 + 5 * 60000;          // five minutes into the 2,037th bar
  const { fetchImpl, calls } = binanceStub(bars, nowMs);
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl, nowMs });
  assert.equal(r.ok, true, r.reason);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((u) => Number(u.searchParams.get('startTime'))), [t0, t0 + 1000 * M15, t0 + 2000 * M15]);
  for (const u of calls) {
    assert.equal(u.origin + u.pathname, 'https://data-api.binance.vision/api/v3/klines');
    assert.equal(u.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(u.searchParams.get('interval'), '15m');
    assert.equal(u.searchParams.get('limit'), String(BINANCE_PAGE));
  }
  assert.equal(r.bars.length, 2036);
  assert.equal(r.source, 'binance-vision');
  assert.equal(r.fetched, 2036);
  assert.deepEqual(r.coverage, { first: t0, last: t0 + 2035 * M15, count: 2036, gaps: [] });
  const file = readCacheFile(h);
  assert.equal(file.length, 2036);
  assert.deepEqual(Object.keys(file[0]), ['t', 'o', 'h', 'l', 'c', 'v']);
  assert.deepEqual(file[5], bars[5]);
  assert.ok(file.every((b) => b.t + M15 <= nowMs));
  assert.deepEqual(readdirSync(join(h, 'history')).sort(), ['BTCUSD-M15.json', 'BTCUSD-M15.meta.json']);   // no temp file left
});
test('the M5 timeframe asks Binance for 5m bars and caches them apart', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 0, 1);
  const { fetchImpl, calls } = binanceStub(market(t0, 50, M5), t0 + 50 * M5);
  const r = await loadHistory('bitcoin', 'M5', { fromMs: t0, home: h, fetchImpl, nowMs: t0 + 50 * M5 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(calls[0].searchParams.get('interval'), '5m');
  assert.equal(readCacheFile(h, 'BTCUSD', 'M5').length, 50);
});
test('a one-day fetch onto a cache running from 2017 keeps every cached bar and refreshes the last one', async () => {
  const h = home();
  const first = Date.UTC(2017, 7, 17, 4, 0);
  const lastCached = Date.UTC(2026, 9, 15, 0, 0);
  const cache = [
    ...market(first, 100, M15, 4000),
    ...market(Date.UTC(2021, 5, 1), 100, M15, 36000),
    ...market(lastCached - 499 * M15, 500, M15, 66000),
  ];
  cache[cache.length - 1] = { ...cache[cache.length - 1], h: 1, c: 1 };    // cached while still forming (an older writer)
  writeCacheFile(h, cache);
  const day = market(lastCached - 96 * M15, 200, M15, 67000);             // the feed's last two days
  const nowMs = Date.UTC(2026, 9, 16, 0, 5);
  const { fetchImpl, calls } = binanceStub(day, nowMs);
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: first, home: h, fetchImpl, nowMs });
  assert.equal(r.ok, true, r.reason);
  assert.equal(calls.length, 1);
  assert.equal(Number(calls[0].searchParams.get('startTime')), lastCached);   // from the last cached bar, not after it
  const file = readCacheFile(h);
  assert.equal(file.length, 700 + 95);                     // 00:15 … 23:45 added; 16 Oct 00:00 still forming
  assert.equal(file[0].t, first);
  for (const b of cache.slice(0, -1)) assert.ok(file.some((x) => x.t === b.t && x.c === b.c), `lost ${new Date(b.t).toISOString()}`);
  const refreshed = file.find((b) => b.t === lastCached);
  assert.deepEqual(refreshed, day.find((b) => b.t === lastCached));
  assert.equal(r.bars.length, file.length);
  assert.equal(r.coverage.first, first);
  assert.equal(r.coverage.last, Date.UTC(2026, 9, 15, 23, 45));
  assert.equal(r.coverage.gaps.length, 2);                 // the holes between the sparse chunks, reported
  assert.equal(readMetaFile(h).closedThrough, Date.UTC(2026, 9, 15, 23, 45));
  // Asked again a minute later: the last bar is known to be final and no new one has closed.
  const again = binanceStub(day, nowMs + 60000);
  const r2 = await loadHistory('BTCUSD', 'M15', { fromMs: first, home: h, fetchImpl: again.fetchImpl, nowMs: nowMs + 60000 });
  assert.equal(r2.ok, true);
  assert.equal(again.calls.length, 0);
  assert.equal(r2.fetched, 0);
  assert.equal(r2.bars.length, 795);
});
test('a bar still forming is neither cached nor returned, and is picked up once it closes', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 9, 14, 8, 0);
  const bars = market(t0, 10);
  const mid = t0 + 9 * M15 + 7 * 60000;                   // 7 minutes into the tenth bar
  const s1 = binanceStub(bars, mid);
  const r1 = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl: s1.fetchImpl, nowMs: mid });
  assert.equal(r1.ok, true);
  assert.equal(r1.bars.length, 9);
  assert.equal(readCacheFile(h).length, 9);
  assert.ok(!readCacheFile(h).some((b) => b.t === t0 + 9 * M15));
  const after = t0 + 10 * M15 + 20000;
  const s2 = binanceStub(bars, after);
  const r2 = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl: s2.fetchImpl, nowMs: after });
  assert.equal(r2.bars.length, 10);
  assert.equal(Number(s2.calls[0].searchParams.get('startTime')), t0 + 8 * M15);   // again from the last cached bar
});
test('an earlier start fetches only the missing head, from the start up to the first cached bar', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 0, 1);
  const bars = market(t0, 1500);
  writeCacheFile(h, bars.slice(1200));
  const nowMs = t0 + 1500 * M15;
  writeFileSync(historyPath('BTCUSD', 'M15', h).replace(/\.json$/, '.meta.json'), JSON.stringify({ closedThrough: bars[1499].t }));
  const { fetchImpl, calls } = binanceStub(bars, nowMs);
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl, nowMs });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(calls.map((u) => Number(u.searchParams.get('startTime'))), [t0, t0 + 1000 * M15]);
  assert.equal(r.bars.length, 1500);
  assert.equal(r.coverage.gaps.length, 0);
  assert.equal(readMetaFile(h).headCheckedFrom, t0);
});
test('a server error is retried with growing waits; a refusal is not', async () => {
  const t0 = Date.UTC(2026, 0, 1), nowMs = t0 + 20 * M15;
  const z = sleeper();
  const flaky = binanceStub(market(t0, 20), nowMs, { fail: (n) => (n <= 2 ? () => json({}, 503) : null) });
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: flaky.fetchImpl, nowMs, sleep: z.sleep });
  assert.equal(r.ok, true, r.reason);
  assert.equal(flaky.calls.length, 3);
  assert.deepEqual(z.waits, [1000, 2000]);

  const z2 = sleeper();
  const down = binanceStub([], nowMs, { fail: (n) => (n % 2 ? () => json({}, 429) : () => { throw new Error('ECONNRESET'); }) });
  const r2 = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: down.fetchImpl, nowMs, sleep: z2.sleep });
  assert.equal(r2.ok, false);
  assert.equal(down.calls.length, MAX_RETRIES + 1);
  assert.deepEqual(z2.waits, [1000, 2000, 4000, 8000, 16000]);
  assert.match(r2.reason, /Binance's price history did not answer: no usable answer after 6 tries/);

  const bad = binanceStub([], nowMs, { fail: () => () => json({ code: -1121, msg: 'Invalid symbol.' }, 400) });
  const r3 = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: bad.fetchImpl, nowMs, sleep: sleeper().sleep });
  assert.equal(r3.ok, false);
  assert.equal(bad.calls.length, 1);
  assert.match(r3.reason, /HTTP 400/);
});
test('a failure part-way keeps the pages that join onto the cache, and drops a head that would leave a hole', async () => {
  const t0 = Date.UTC(2026, 0, 1);
  const bars = market(t0, 3000);
  const nowMs = t0 + 3000 * M15;
  // Tail: the first page arrives, the second never does. The first page joins the cache's end: kept.
  const h = home();
  writeCacheFile(h, bars.slice(0, 500));
  const tail = binanceStub(bars, nowMs, { fail: (n) => (n >= 2 ? () => { throw new Error('socket hang up'); } : null) });
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl: tail.fetchImpl, nowMs, sleep: sleeper().sleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /socket hang up/);
  assert.equal(readCacheFile(h).length, 500 + 999);          // bars 0..1498, one overlapping
  assert.equal(gapsIn(readCacheFile(h), 15).length, 0);
  // Head: the first page of the earlier bars arrives, the rest fails. It would not reach the cache: dropped.
  const h2 = home();
  writeCacheFile(h2, bars.slice(2500));
  writeFileSync(historyPath('BTCUSD', 'M15', h2).replace(/\.json$/, '.meta.json'), JSON.stringify({ closedThrough: bars[2999].t }));
  const head = binanceStub(bars, nowMs, { fail: (n) => (n >= 2 ? () => json({}, 500) : null) });
  const r2 = await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h2, fetchImpl: head.fetchImpl, nowMs, sleep: sleeper().sleep });
  assert.equal(r2.ok, false);
  assert.equal(readCacheFile(h2).length, 500);
  assert.equal(readCacheFile(h2)[0].t, bars[2500].t);
});
test('a cache that cannot be read is left exactly as it is', async () => {
  const h = home();
  mkdirSync(join(h, 'history'), { recursive: true });
  writeFileSync(historyPath('BTCUSD', 'M15', h), '[{"t":1,"o":');
  const { fetchImpl, calls } = binanceStub([], Date.now());
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: 0, home: h, fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be read/);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(historyPath('BTCUSD', 'M15', h), 'utf8'), '[{"t":1,"o":');
});
test('only closed bars in [fromMs, toMs) are returned, while the cache keeps the rest', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 0, 1);
  const nowMs = t0 + 100 * M15;
  const { fetchImpl } = binanceStub(market(t0, 100), nowMs);
  await loadHistory('BTCUSD', 'M15', { fromMs: t0, home: h, fetchImpl, nowMs });
  const r = await loadHistory('BTCUSD', 'M15', { fromMs: t0 + 10 * M15, toMs: t0 + 20 * M15, home: h, fetchImpl: binanceStub([], nowMs).fetchImpl, nowMs });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bars.map((b) => b.t), market(t0 + 10 * M15, 10).map((b) => b.t));
  assert.equal(readCacheFile(h).length, 100);
});

console.log('\ngold from Twelve Data');
test('no key: need-key, and the feed is never called', async () => {
  const { fetchImpl, calls } = twelveStub([], Date.now());
  const r = await loadHistory('gold', 'M15', { fromMs: Date.UTC(2026, 0, 1), home: home(), fetchImpl, keys: {} });
  assert.equal(r.ok, false);
  assert.equal(r.needKey, true);
  assert.match(r.reason, /TWELVEDATA_API_KEY/);
  assert.equal(calls.length, 0);
});
test('pages backwards 5,000 at a time, each page ending on the oldest bar of the last, 8 s apart', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 3, 1);
  const bars = market(t0, 12000, M15, 4000).map(({ v, ...b }) => b);
  const nowMs = t0 + 12000 * M15;
  const { fetchImpl, calls } = twelveStub(bars, nowMs);
  const z = sleeper();
  const r = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: h, fetchImpl, keys: { twelvedata: 'KEY' }, nowMs, sleep: z.sleep, clock: () => 0 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.source, 'twelvedata');
  assert.equal(calls.length, 3);
  for (const u of calls) {
    assert.equal(u.origin + u.pathname, 'https://api.twelvedata.com/time_series');
    assert.equal(u.searchParams.get('symbol'), 'XAU/USD');
    assert.equal(u.searchParams.get('interval'), '15min');
    assert.equal(u.searchParams.get('timezone'), 'UTC');
    assert.equal(u.searchParams.get('outputsize'), String(TWELVE_PAGE));
    assert.equal(u.searchParams.get('apikey'), 'KEY');
    assert.equal(tdTime(u.searchParams.get('start_date')), t0);
  }
  assert.equal(tdTime(calls[0].searchParams.get('end_date')), nowMs);
  assert.equal(tdTime(calls[1].searchParams.get('end_date')), bars[7000].t);     // the oldest bar of page one
  assert.equal(tdTime(calls[2].searchParams.get('end_date')), bars[2001].t);
  assert.deepEqual(z.waits, [TWELVE_SPACING_MS, TWELVE_SPACING_MS]);
  assert.equal(r.bars.length, 12000);
  assert.equal(new Set(r.bars.map((b) => b.t)).size, 12000);
  assert.equal(r.bars[0].t, t0);                                                // datetimes read as UTC
  assert.ok(r.bars.every((b, i) => !i || b.t > r.bars[i - 1].t));
  assert.deepEqual(r.bars[123], { ...bars[123], v: 0 });                        // no volume for gold → 0, prices as numbers
  assert.equal(readCacheFile(h, 'XAUUSD').length, 12000);
});
test('a per-minute 429 waits a minute and tries again; a daily one stops with the reason', async () => {
  const t0 = Date.UTC(2026, 3, 1), nowMs = t0 + 40 * M15;
  const bars = market(t0, 40, M15, 4000);
  const limited = () => json({ code: 429, message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.', status: 'error' });
  const z = sleeper();
  const s = twelveStub(bars, nowMs, { script: (n) => (n === 1 ? limited : null) });
  const r = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: s.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: z.sleep, clock: () => 0 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.calls.length, 2);
  assert.ok(z.waits.includes(TWELVE_LIMIT_WAIT_MS));
  assert.equal(r.bars.length, 40);

  const daily = () => json({ code: 429, message: 'You have run out of API credits for the day. 800 API credits were used, with the current limit being 800.', status: 'error' });
  const s2 = twelveStub(bars, nowMs, { script: () => daily });
  const r2 = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: s2.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: sleeper().sleep, clock: () => 0 });
  assert.equal(r2.ok, false);
  assert.equal(s2.calls.length, 1);
  assert.match(r2.reason, /today's allowance/);
  assert.ok(!/apikey|K&/.test(r2.reason));
});
test('"No data is available" ends the walk back: the earliest bar is reached, and it is not asked again', async () => {
  const h = home();
  const t0 = Date.UTC(2026, 3, 1);
  const bars = market(t0, 300, M15, 4000);
  const nowMs = t0 + 300 * M15;
  const s1 = twelveStub(bars, nowMs);
  const r1 = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: h, fetchImpl: s1.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: sleeper().sleep });
  assert.equal(r1.ok, true, r1.reason);
  const early = Date.UTC(2020, 0, 1);
  const s2 = twelveStub(bars, nowMs);
  const r2 = await loadHistory('XAUUSD', 'M15', { fromMs: early, home: h, fetchImpl: s2.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: sleeper().sleep });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(s2.calls.length, 1);                                  // one call, answered "No data"
  assert.equal(tdTime(s2.calls[0].searchParams.get('end_date')), t0);
  assert.equal(r2.bars.length, 300);
  assert.equal(readMetaFile(h, 'XAUUSD').headCheckedFrom, early);
  const s3 = twelveStub(bars, nowMs);
  const r3 = await loadHistory('XAUUSD', 'M15', { fromMs: early, home: h, fetchImpl: s3.fetchImpl, keys: {}, nowMs });
  assert.equal(r3.ok, true, r3.reason);                              // saved history is served without a key
  assert.equal(s3.calls.length, 0);
});
test('any other Twelve Data error ends the fetch with what it said', async () => {
  const t0 = Date.UTC(2026, 3, 1), nowMs = t0 + 40 * M15;
  const s = twelveStub([], nowMs, { script: () => () => json({ code: 401, message: 'Invalid API key.', status: 'error' }) });
  const r = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: s.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: sleeper().sleep });
  assert.equal(r.ok, false);
  assert.equal(r.needKey, undefined);
  assert.match(r.reason, /refused the key/);
  const s2 = twelveStub([], nowMs, { script: () => () => json({ code: 404, message: 'Symbol not found.', status: 'error' }) });
  const r2 = await loadHistory('XAUUSD', 'M15', { fromMs: t0, home: home(), fetchImpl: s2.fetchImpl, keys: { twelvedata: 'K' }, nowMs, sleep: sleeper().sleep });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /Twelve Data said: Symbol not found\./);
});

console.log('\ngaps');
const run = (t0, n, ms = M15) => market(t0, n, ms).map((b) => ({ t: b.t }));
test('bitcoin: a hole of five bars or more is listed, a shorter one is not, weekends included', () => {
  const t0 = Date.UTC(2026, 9, 5);
  const bars = [...run(t0, 10), ...run(t0 + 13 * M15, 10), ...run(t0 + 29 * M15, 10)];   // 3 missing, then 6
  assert.deepEqual(gapsIn(bars, 15), [{ afterT: t0 + 22 * M15, nextT: t0 + 29 * M15, missingBars: 6 }]);
  assert.equal(gapsIn(bars, 15, { minMissing: 3 }).length, 2);
  const fri = Date.UTC(2026, 9, 9, 20, 45), sun = Date.UTC(2026, 9, 11, 22, 0);
  assert.equal(gapsIn([{ t: fri }, { t: sun }], 15, { pair: 'BTCUSD' }).length, 1);
  assert.deepEqual(gapsIn([], 15), []);
});
test('gold: the weekend close and the daily break are the market shut, not missing data', () => {
  const fri = Date.UTC(2026, 9, 9, 20, 45), sun = Date.UTC(2026, 9, 11, 22, 0);
  assert.deepEqual(gapsIn([{ t: fri }, { t: sun }], 15, { pair: 'XAUUSD' }), []);
  // The daily hour off, on M5: 12 bars missing, but under two hours shut.
  const brk = Date.UTC(2026, 9, 13, 20, 55);
  assert.deepEqual(gapsIn([{ t: brk }, { t: brk + 65 * 60000 }], 5, { pair: 'gold' }), []);
  // Three hours missing mid-week is a feed hole.
  const tue = Date.UTC(2026, 9, 13, 10, 0);
  assert.deepEqual(gapsIn([{ t: tue }, { t: tue + 13 * M15 }], 15, { pair: 'XAUUSD' }), [{ afterT: tue, nextT: tue + 13 * M15, missingBars: 12 }]);
  // A weekend stretched by Good Friday is still the weekend; four days over it is not.
  const thu = Date.UTC(2026, 3, 2, 20, 45), easter = Date.UTC(2026, 3, 5, 22, 0);
  assert.deepEqual(gapsIn([{ t: thu }, { t: easter }], 15, { pair: 'XAUUSD' }), []);
  const wed = Date.UTC(2026, 3, 1, 20, 45);
  assert.equal(gapsIn([{ t: wed }, { t: easter }], 15, { pair: 'XAUUSD' }).length, 1);
});
test('a check whose 1,000-bar slice holds a gap is flagged, and so is a trade running through one', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const bars = [...run(t0, 1500), ...run(t0 + 1510 * M15, 1500)];      // 10 missing after index 1499
  const gaps = gapsIn(bars, 15);
  assert.equal(gaps.length, 1);
  const hasGap = gapInWindow(bars, gaps);
  assert.equal(hasGap(1499), false);                 // the hole comes after
  assert.equal(hasGap(1500), true);                  // the first bar after it
  assert.equal(hasGap(1500 + 998), true);            // slice 1499..2498 still spans it
  assert.equal(hasGap(1500 + 999), false);           // slice starts at 1500: clean
  assert.equal(gapInWindow(bars, gaps, 300)(1500 + 299), false);
  assert.equal(gapsDuring(gaps, bars[1495].t, bars[1505].t).length, 1);
  assert.equal(gapsDuring(gaps, bars[1500].t, bars[1505].t).length, 0);
});

for (const r of pending) await r();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
