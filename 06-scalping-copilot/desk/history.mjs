/**
 * desk/history.mjs — years of closed bars for the replay and the learner, cached and extended.
 *
 * Why this exists. The replay used to fetch its own bitcoin history and, when
 * the cache did not cover the stretch asked for, threw the cache away and
 * started again. A cache of nine years (320,623 bitcoin bars from 2017-08-17)
 * is two minutes from Binance, but gold's is hours from Twelve Data's free
 * tier, and a one-day fetch must never cost the years already held. So:
 *
 *  - NEW BARS ARE MERGED IN, NEVER SWAPPED IN. The cache only grows. Bars are
 *    deduplicated by their open time and sorted; a fetched bar replaces a
 *    cached one with the same time (it is the fresher copy), and nothing else
 *    in the file is touched. The file is written to a temporary name and
 *    renamed, so a run killed mid-write leaves the old file whole.
 *  - ONLY THE MISSING ENDS ARE FETCHED. Earlier than the first cached bar, or
 *    later than the last. A hole in the middle is the feed's own outage (the
 *    largest in bitcoin's is 134 bars from 2018-02-08); refetching it would
 *    give the same hole, so it is reported instead.
 *  - THE LAST CACHED BAR IS FETCHED AGAIN. An older writer kept the bar that
 *    was still forming when it saved, and its high, low and close were not
 *    final. This module never caches a bar that has not closed
 *    (t + bar length > now), and records in a small file beside the cache
 *    (`<PAIR>-<TF>.meta.json`) how far it knows the bars are final, so the
 *    refetch happens only when that is in doubt.
 *  - CLOSED BARS ONLY ARE RETURNED. The replay hands the engine "bars up to k";
 *    a forming bar at the end would be a look at a price the live desk could
 *    not yet have seen as a candle.
 *
 * Feeds. Bitcoin: Binance's public data host (BTCUSDT, 1,000 bars a call,
 * paging forward), the same host the live watcher reads. Gold: Twelve Data
 * (XAU/USD, 5,000 bars a call, newest first, so paging goes backwards), which
 * needs `TWELVEDATA_API_KEY`; its free tier allows 8 calls a minute and 800 a
 * day, so calls are at least 8 seconds apart, a "per-minute" refusal waits a
 * minute and tries again, and a "for the day" refusal stops with the reason.
 * Without a key, gold returns `needKey` rather than a stand-in instrument.
 *
 * What it is not. A reference feed's bars, not IC Markets' quote (decision 26:
 * the feeds sit tens of dollars from the broker). Binance's volume is that
 * exchange's; Twelve Data's gold has none, so `v` is 0 there. The network
 * goes through Node's fetch: in the cloud container the caller must run with
 * NODE_USE_ENV_PROXY=1 (desk/net.mjs `ensureProxy()`), as desk.mjs does.
 *
 * Gaps. `gapsIn()` lists runs of missing bars, so a check whose engine window
 * holds one can be skipped and a trade that spans one flagged (LEARNING-PLAN.md
 * Part 1). Gold's market shuts every weekend and for about an hour every day;
 * those are the market closed, not data missing, and are not listed.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { TIMEFRAMES, timeframeOf } from '../src/timeframes.js';

/** Bars a Binance klines call returns at most. A shorter page means the present was reached. */
export const BINANCE_PAGE = 1000;
/** Bars a Twelve Data time_series call returns at most. */
export const TWELVE_PAGE = 5000;
/** Twelve Data's free tier: 8 calls a minute, so no closer than this. */
export const TWELVE_SPACING_MS = 8000;
/** How long to wait after Twelve Data says the minute's allowance is used up. */
export const TWELVE_LIMIT_WAIT_MS = 60000;
/** Retries after the first try, on a network failure, a server error or a rate limit. */
export const MAX_RETRIES = 5;
/** A gap is listed from this many missing bars: "a gap of more than 4 bars" (LEARNING-PLAN.md). */
export const GAP_MIN_MISSING = 5;
/** Bars an engine read looks back over (the live watcher fetches 1,000 for the higher-timeframe bias). */
export const GAP_LOOKBACK = 1000;
/** Gold closes for about an hour each day; a shorter closure is the market, not missing data. */
export const GOLD_DAILY_BREAK_MS = 2 * 3600e3;
/**
 * Gold's weekend closure: Friday ~21:00 UTC to Sunday ~22:00 UTC, about 49
 * hours. A holiday on the Friday or the Monday (Good Friday, Christmas or New
 * Year falling beside a weekend) stretches it to about 73. A closure over a
 * Saturday up to this long is the weekend; a longer one is listed, because a
 * feed outage can hide next to a weekend too.
 */
export const GOLD_WEEKEND_MAX_MS = 76 * 3600e3;

/** Which feed holds each instrument's history. */
export const HISTORY_FEEDS = { BTCUSD: 'binance-vision', XAUUSD: 'twelvedata' };

const MAX_PAGES = 20000;
const DAY_MS = 86400e3;

/** Where the desk keeps container state: $SCALP_DESK_HOME, or ~/.scalp-desk. */
export const deskHome = () => process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');

/** 'BTCUSD' / 'XAUUSD' from the ways it is written ("bitcoin", "gold", "XAU/USD"), else null. */
export function historyPair(p) {
  const t = String(p || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (/XAU|GOLD/.test(t)) return 'XAUUSD';
  if (/BTC|XBT|BITCOIN/.test(t)) return 'BTCUSD';
  return null;
}

/**
 * The cache file for one instrument and timeframe: <home>/history/<PAIR>-<TF>.json,
 * e.g. ~/.scalp-desk/history/BTCUSD-M15.json. A JSON array of {t, o, h, l, c, v},
 * oldest first, t the bar's open time in UTC milliseconds. Throws on an
 * instrument or timeframe it does not know (a programming error, not a user's).
 */
export function historyPath(pair, tf, home = deskHome()) {
  const p = historyPair(pair), id = timeframeOf(tf);
  if (!p || !id) throw new TypeError(`historyPath: unknown instrument or timeframe (${pair}, ${tf})`);
  return join(home, 'history', `${p}-${id}.json`);
}

const metaPathOf = (file) => file.replace(/\.json$/, '.meta.json');

/** A bar in the cache's shape, or null if any price is missing or not positive. */
function cleanBar(b) {
  const bar = { t: Number(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) || 0 };
  if (!Number.isFinite(bar.t)) return null;
  for (const k of ['o', 'h', 'l', 'c']) if (!(Number.isFinite(bar[k]) && bar[k] > 0)) return null;
  return bar;
}

/**
 * Two lists of bars as one: deduplicated by t, sorted oldest first. Where both
 * hold a bar for the same t, `b`'s wins — pass the cache as `a` and a fresh
 * fetch as `b`, so a bar that was still forming when cached is replaced by its
 * final copy. Neither input is changed; every bar of either survives unless
 * replaced by one with the same t.
 */
export function mergeBars(a = [], b = []) {
  const byT = new Map();
  for (const x of a) { const bar = cleanBar(x); if (bar) byT.set(bar.t, bar); }
  for (const x of b) { const bar = cleanBar(x); if (bar) byT.set(bar.t, bar); }
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

/** Whether a gold closure from `fromT` to `toT` lies over a Saturday (UTC). */
function overSaturday(fromT, toT) {
  const dayStart = Math.floor(fromT / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay();
  if (dow === 6) return true;
  const saturday = dayStart + ((6 - dow + 7) % 7) * DAY_MS;
  return saturday < toT;
}

/**
 * Runs of missing bars in a sorted list: [{ afterT, nextT, missingBars }],
 * where afterT is the last bar before the hole, nextT the first after it, and
 * missingBars how many bars of `tfMinutes` would fit between. Only holes of at
 * least `minMissing` bars are listed. For gold (`pair` 'XAUUSD' or 'gold'),
 * the weekend closure and daily breaks shorter than two hours are the market
 * shut, not data missing, and are left out. Bitcoin trades every hour of
 * every day, so every hole in it counts.
 */
export function gapsIn(bars, tfMinutes, { minMissing = GAP_MIN_MISSING, pair = null } = {}) {
  const ms = tfMinutes * 60000;
  const gold = historyPair(pair) === 'XAUUSD';
  const gaps = [];
  for (let i = 1; i < (bars?.length || 0); i++) {
    const a = bars[i - 1].t, b = bars[i].t;
    const missingBars = Math.round((b - a) / ms) - 1;
    if (missingBars < minMissing) continue;
    if (gold) {
      const closed = b - (a + ms);
      if (closed < GOLD_DAILY_BREAK_MS) continue;
      if (closed <= GOLD_WEEKEND_MAX_MS && overSaturday(a + ms, b)) continue;
    }
    gaps.push({ afterT: a, nextT: b, missingBars });
  }
  return gaps;
}

/**
 * For the replay and the dataset: a function of k that says whether the
 * `lookback` bars ending at bars[k] (the engine's slice, bars[k − lookback + 1 .. k])
 * hold one of `gaps` (from gapsIn on the same bars). Such a check is skipped:
 * the engine would read a hole as one long candle-to-candle jump.
 */
export function gapInWindow(bars, gaps, lookback = GAP_LOOKBACK) {
  // lastGapAt[k]: the index of the newest bar at or before k that comes straight after a gap.
  const after = new Set((gaps || []).map((g) => g.nextT));
  const lastGapAt = new Int32Array(bars.length);
  let last = -1;
  for (let k = 0; k < bars.length; k++) { if (after.has(bars[k].t)) last = k; lastGapAt[k] = last; }
  return (k) => {
    if (k < 0 || k >= bars.length) return false;
    const start = Math.max(0, k - lookback + 1);
    return lastGapAt[k] > start;
  };
}

/** The gaps a trade from the close of the bar at `entryT` to the bar at `exitT` runs through (to flag it). */
export function gapsDuring(gaps, entryT, exitT) {
  return (gaps || []).filter((g) => g.afterT >= entryT && g.afterT < exitT);
}

/* ------------------------------------------------------------ the cache */

function readCache(file) {
  if (!existsSync(file)) return { bars: [] };
  try {
    const bars = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(bars)) throw new Error('not a list of bars');
    return { bars: mergeBars(bars) };
  } catch (e) {
    return { error: `The saved price history at ${file} could not be read (${e.message}). It has been left as it is; move it aside to fetch afresh.` };
  }
}

function readMeta(file) {
  try { return JSON.parse(readFileSync(metaPathOf(file), 'utf8')) || {}; } catch { return {}; }
}

/** Write to a temporary file beside the target, then rename: a reader sees the old file or the new one, never half. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, text); renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}

/* ------------------------------------------------------------ the network */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (retry) => 1000 * 2 ** (retry - 1);          // 1, 2, 4, 8, 16 s

/**
 * One GET with retries: a network failure, an HTTP 5xx, 429 or 418 (Binance's
 * "slow down") waits and tries again, up to MAX_RETRIES times. Any other HTTP
 * error is final. Never puts the URL in a message: Twelve Data's carries the key.
 */
async function getJson(url, ctx, { beforeCall, limitWaitMs } = {}) {
  let last = '';
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    if (retry) await ctx.sleep(last === 'HTTP 429' && limitWaitMs ? limitWaitMs : backoffMs(retry));
    if (beforeCall) await beforeCall();
    ctx.calls++;
    let r;
    try { r = await ctx.fetchImpl(url); }
    catch (e) { last = e?.message || String(e); ctx.log?.(`  network error (${last}); trying again`); continue; }
    if (r.status === 429 || r.status === 418 || r.status >= 500) { last = `HTTP ${r.status}`; ctx.log?.(`  ${last}; trying again`); continue; }
    if (!r.ok) return { error: `HTTP ${r.status}` };
    try { return { json: await r.json() }; }
    catch { last = 'a reply that was not JSON'; continue; }
  }
  return { error: `no usable answer after ${MAX_RETRIES + 1} tries (last: ${last})` };
}

const isoUtc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Binance BTCUSDT bars from `fromT` forward until `endT`, 1,000 a call.
 * Stops at an empty or short page (the present) or once a page reaches endT.
 * Returns { bars, done } or { bars, error } with whatever arrived before it.
 */
async function binanceSpan(fromT, endT, ctx) {
  const bars = [];
  let t = Math.max(0, Math.floor(fromT));
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${ctx.minutes}m&startTime=${t}&limit=${BINANCE_PAGE}`, ctx);
    if (r.error) return { bars, error: `Binance's price history did not answer: ${r.error}.` };
    if (!Array.isArray(r.json)) return { bars, error: `Binance's price history sent something other than bars${r.json?.msg ? ` ("${r.json.msg}")` : ''}.` };
    for (const k of r.json) bars.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    if (r.json.length < BINANCE_PAGE) return { bars, done: true };
    const lastT = +r.json[r.json.length - 1][0];
    if (!(lastT >= t)) return { bars, error: 'Binance\'s price history went backwards between pages.' };
    if (lastT + ctx.ms >= endT) return { bars, done: true };
    t = lastT + ctx.ms;
    if (page % 50 === 49) ctx.log?.(`  bitcoin: ${bars.length.toLocaleString('en-GB')} bars, to ${isoUtc(lastT)} UTC`);
  }
  return { bars, error: 'Binance\'s price history did not end after 20,000 pages.' };
}

/** One Twelve Data call: its own error replies (HTTP 200, status "error") turned into what to do next. */
async function twelveCall(url, ctx) {
  // Calls start at least 8 s apart, retries included.
  const beforeCall = async () => {
    if (ctx.lastTwelveAt != null) {
      const wait = TWELVE_SPACING_MS - (ctx.clock() - ctx.lastTwelveAt);
      if (wait > 0) await ctx.sleep(wait);
    }
    ctx.lastTwelveAt = ctx.clock();
  };
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const r = await getJson(url, ctx, { beforeCall, limitWaitMs: TWELVE_LIMIT_WAIT_MS });
    if (r.error) return { error: `Twelve Data did not answer: ${r.error}.` };
    const d = r.json;
    if (d?.status !== 'error') return { json: d };
    const msg = String(d.message || '').trim();
    const code = Number(d.code);
    if (code === 429) {
      if (/\bday\b|daily/i.test(msg)) return { error: 'Twelve Data says today\'s allowance of calls is used up. The history fetched so far is kept; run it again tomorrow to carry on.' };
      ctx.log?.('  Twelve Data: this minute\'s calls are used up; waiting a minute');
      await ctx.sleep(TWELVE_LIMIT_WAIT_MS);
      continue;
    }
    if (code === 400 && /no data is available/i.test(msg)) return { noData: true };
    if (code === 401 || code === 403) return { error: `Twelve Data refused the key${msg ? ` ("${msg}")` : ''}. Check TWELVEDATA_API_KEY in the environment settings.` };
    return { error: `Twelve Data said: ${msg || `error ${d.code}`}` };
  }
  return { error: 'Twelve Data kept saying its per-minute allowance was used up.' };
}

/**
 * Twelve Data XAU/USD bars from `endT` back to `fromT`, 5,000 a call, newest
 * first. Each page ends where the last began (end_date takes the oldest bar
 * seen), so one bar overlaps and is deduplicated. Stops at a short page, at
 * fromT, or at "No data is available" (the start of what it holds).
 * Returns { bars, done, reachedStart? } or { bars, error }.
 */
async function twelveSpan(fromT, endT, ctx) {
  const bars = [];
  let end = endT;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = [
      'symbol=XAU/USD', `interval=${ctx.minutes}min`, 'timezone=UTC', `outputsize=${TWELVE_PAGE}`,
      ...(fromT > 0 ? [`start_date=${encodeURIComponent(isoUtc(fromT) + ':00')}`] : []),
      `end_date=${encodeURIComponent(isoUtc(end) + ':00')}`, `apikey=${encodeURIComponent(ctx.key)}`,
    ].join('&');
    const r = await twelveCall(`https://api.twelvedata.com/time_series?${q}`, ctx);
    if (r.noData) return { bars, done: true, reachedStart: true };
    if (r.error) return { bars, error: r.error };
    const values = Array.isArray(r.json?.values) ? r.json.values : [];
    let oldest = Infinity;
    for (const v of values) {
      const s = String(v.datetime || '');
      const t = Date.parse((s.length === 10 ? `${s}T00:00:00` : s.replace(' ', 'T')) + 'Z');
      bars.push({ t, o: v.open, h: v.high, l: v.low, c: v.close, v: v.volume ?? 0 });
      if (t < oldest) oldest = t;
    }
    if (values.length < TWELVE_PAGE) return { bars, done: true, reachedStart: !values.length || fromT <= 0 };
    if (oldest <= fromT) return { bars, done: true };
    if (!(oldest < end)) return { bars, error: 'Twelve Data returned the same page twice.' };
    end = oldest;
    ctx.log?.(`  gold: ${bars.length.toLocaleString('en-GB')} bars, back to ${isoUtc(oldest)} UTC`);
  }
  return { bars, error: 'Twelve Data\'s history did not end after 20,000 pages.' };
}

/* ------------------------------------------------------------ loadHistory */

/**
 * Closed bars for one instrument and timeframe between fromMs (inclusive) and
 * toMs (exclusive), from the cache, extended from the feed at either end.
 *
 *   pair  'BTCUSD' | 'XAUUSD' (or "bitcoin", "gold")
 *   tf    'M15' | 'M5' (or as typed: "15", "5m")
 *   fromMs  earliest bar wanted (open time, UTC ms). Left out: as far back as
 *           the feed goes (Binance from 2017-08-17; Twelve Data until "No data").
 *   toMs    default nowMs. nowMs default Date.now(): bars that have not closed
 *           by then are neither cached nor returned.
 *   home    default $SCALP_DESK_HOME or ~/.scalp-desk. fetchImpl default fetch.
 *   keys    { twelvedata } default $TWELVEDATA_API_KEY.
 *   sleep, clock  injected for tests (waits, and the clock the 8 s spacing reads).
 *   log     optional (line) => void for progress on long fetches.
 *
 * Returns
 *   { ok: true, bars, source, fetched, calls, coverage: { first, last, count, gaps } }
 *     bars      [{t,o,h,l,c,v}] oldest first, closed only, in [fromMs, toMs)
 *     source    'binance-vision' | 'twelvedata' (the cache holds that feed's bars only)
 *     fetched   bars that came from the network this time (0: served from the cache)
 *     calls     network calls made (retries included)
 *     coverage  first/last: open times of the first and last bar returned (null if none);
 *               count: bars.length; gaps: gapsIn(bars) — [{afterT, nextT, missingBars}]
 *   { ok: false, needKey: true, reason }   gold, a fetch needed, no Twelve Data key
 *   { ok: false, reason }                  a plain-English reason. Bars that did arrive
 *               are still saved when they join onto the cache, so a rerun carries on.
 *
 * A key is asked for only when a fetch is needed: gold history already saved
 * is served without one.
 */
export async function loadHistory(pair, tf, opts = {}) {
  const P = historyPair(pair);
  if (!P) return { ok: false, reason: `There is no price history for "${pair}" here: bitcoin (BTCUSD) and gold (XAUUSD) only.` };
  const tfId = timeframeOf(tf);
  if (!tfId) return { ok: false, reason: `"${tf}" is not a chart timeframe the desk knows (M15 or M5).` };
  const minutes = TIMEFRAMES[tfId].minutes, ms = minutes * 60000;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const toMs = Number.isFinite(opts.toMs) ? opts.toMs : nowMs;
  const fromMs = Number.isFinite(opts.fromMs) ? opts.fromMs : 0;
  const home = opts.home ?? deskHome();
  const key = (opts.keys ? opts.keys.twelvedata : process.env.TWELVEDATA_API_KEY) || '';
  const ctx = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch, sleep: opts.sleep ?? defaultSleep, clock: opts.clock ?? Date.now,
    log: opts.log, minutes, ms, key, calls: 0, lastTwelveAt: null,
  };
  const source = HISTORY_FEEDS[P];
  const file = historyPath(P, tfId, home);

  const cached = readCache(file);
  if (cached.error) return { ok: false, reason: cached.error };
  const meta = readMeta(file);
  const end = Math.min(toMs, nowMs);       // nothing at or after this can be a closed bar we want

  // What to fetch: the whole range into an empty cache, or the missing ends.
  const spans = [];
  if (!cached.bars.length) {
    if (fromMs < end) spans.push({ kind: 'all', from: fromMs, to: end });
  } else {
    const first = cached.bars[0].t, last = cached.bars[cached.bars.length - 1].t;
    // headCheckedFrom: an earlier run asked from there and found nothing before the first bar.
    const checked = Math.min(first, Number.isFinite(meta.headCheckedFrom) ? meta.headCheckedFrom : first);
    if (fromMs <= checked - ms && fromMs < end) spans.push({ kind: 'head', from: fromMs, to: first });
    // closedThrough: the newest bar this module saved knowing it had closed.
    const sure = Number.isFinite(meta.closedThrough) && meta.closedThrough >= last;
    const wantTail = sure ? last + 2 * ms <= end : last + ms <= end && last < toMs;
    if (wantTail) spans.push({ kind: 'tail', from: last, to: end });
  }

  if (spans.length && P === 'XAUUSD' && !key) {
    return { ok: false, needKey: true, reason: 'Gold\'s price history comes from Twelve Data, which needs a free key (TWELVEDATA_API_KEY).' };
  }
  if (spans.length && typeof ctx.fetchImpl !== 'function') return { ok: false, reason: 'This Node has no fetch; it needs version 18 or later.' };

  const kept = [];
  let error = null, headCheckedFrom = null;
  for (const s of spans) {
    opts.log?.(`${P} ${tfId}: fetching ${s.kind === 'all' ? 'history' : s.kind === 'head' ? 'earlier bars' : 'newer bars'} ${isoUtc(s.from)} → ${isoUtc(s.to)} UTC`);
    const r = P === 'BTCUSD' ? await binanceSpan(s.from, s.to, ctx) : await twelveSpan(s.from, s.to, ctx);
    // Keep what arrived before a failure only if it joins onto the cache: Binance
    // pages forward, so a partial head (or a partial tail from Twelve Data,
    // paging back) would leave a hole the "ends only" rule never fills.
    const joins = r.done || s.kind === 'all' || (P === 'BTCUSD' ? s.kind === 'tail' : s.kind === 'head');
    if (joins) kept.push(...r.bars);
    if (r.done && (s.kind === 'head' || s.kind === 'all')) headCheckedFrom = s.from;
    if (r.error) { error = r.error; break; }
  }
  const fresh = kept.filter((b) => Number.isFinite(b.t) && b.t + ms <= nowMs);

  // Save: re-read first (another run may have written since), merge, write whole.
  let bars = cached.bars;
  const metaNext = { ...meta };
  if (headCheckedFrom != null) metaNext.headCheckedFrom = Math.min(headCheckedFrom, Number.isFinite(meta.headCheckedFrom) ? meta.headCheckedFrom : Infinity);
  const freshMerged = mergeBars([], fresh);
  if (freshMerged.length) metaNext.closedThrough = Math.max(freshMerged[freshMerged.length - 1].t, Number.isFinite(meta.closedThrough) ? meta.closedThrough : -Infinity);
  const metaChanged = JSON.stringify(metaNext) !== JSON.stringify(meta);
  if (freshMerged.length || metaChanged) {
    const now = readCache(file);
    if (now.error) return { ok: false, reason: now.error };
    bars = mergeBars(now.bars, freshMerged);
    if (now.bars.length && (bars[0].t > now.bars[0].t || bars[bars.length - 1].t < now.bars[now.bars.length - 1].t)) {
      return { ok: false, reason: 'The merged history came out shorter than the saved one, so nothing was written.' };
    }
    try {
      if (freshMerged.length) writeAtomic(file, JSON.stringify(bars));
      if (metaChanged) writeAtomic(metaPathOf(file), JSON.stringify(metaNext));
    } catch (e) {
      return { ok: false, reason: `The price history could not be saved (${e.message}).` };
    }
  }
  if (error) return { ok: false, reason: error };

  const out = bars.filter((b) => b.t >= fromMs && b.t < toMs && b.t + ms <= nowMs);
  return {
    ok: true, bars: out, source, fetched: freshMerged.length, calls: ctx.calls,
    coverage: {
      first: out.length ? out[0].t : null,
      last: out.length ? out[out.length - 1].t : null,
      count: out.length,
      gaps: gapsIn(out, minutes, { pair: P }),
    },
  };
}
