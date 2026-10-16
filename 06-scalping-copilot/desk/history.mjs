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
 *    renamed, so a run killed mid-write leaves the old file whole. A fetch
 *    that changes nothing writes nothing.
 *  - ONLY THE MISSING ENDS ARE FETCHED. Earlier than the first cached bar, or
 *    later than the last. A hole in the middle is the feed's own outage (the
 *    largest in bitcoin's is 134 bars from 2018-02-08); refetching it would
 *    give the same hole, so it is reported instead.
 *  - THE LAST CACHED BAR IS FETCHED AGAIN unless this module saved it itself,
 *    knowing it had closed. An older writer kept the bar that was still
 *    forming when it saved, and its high, low and close were not final. A
 *    small file beside the cache (`<PAIR>-<TF>.meta.json`) records the bar
 *    this module last saved as final and the first bar it had checked back
 *    from. Both are tied to the bar they describe, not just to a time: when
 *    another writer replaces the cache (the legacy replay rewrote it from
 *    twelve days before its start), the record no longer matches the file and
 *    is ignored, so years of history cannot go missing behind a stale note.
 *  - CLOSED BARS ONLY ARE RETURNED. The replay hands the engine "bars up to k";
 *    a forming bar at the end would be a look at a price the live desk could
 *    not yet have seen as a candle.
 *
 * Feeds. Bitcoin: Binance's public data host (BTCUSDT, 1,000 bars a call,
 * paging forward), the same host the live watcher reads. Gold: Twelve Data
 * (XAU/USD, 5,000 bars a call, newest first, so paging goes backwards by
 * end_date alone), which needs `TWELVEDATA_API_KEY`, sent in a header rather
 * than the address so a proxy's log never holds it. Its free tier allows 8
 * calls a minute and 800 a day, so calls are at least 8 seconds apart, a
 * "per-minute" refusal waits a minute and tries again, and a "for the day"
 * refusal stops with the reason. Without a key, gold returns `needKey` rather
 * than a stand-in instrument (the caller shows desk.mjs's KEY_HOW).
 *
 * Time limits. `opts.signal` (an AbortSignal) and `opts.deadlineMs` reach every
 * fetch and every wait: the journal resolves alerts inside a ~5 s budget and a
 * five-retry backoff (31 s) or a Twelve Data minute must not hold a command up.
 *
 * What it is not. A reference feed's bars, not IC Markets' quote (decision 26:
 * the feeds sit tens of dollars from the broker). Binance's volume is that
 * exchange's; Twelve Data's gold has none, so `v` is 0 there. The network
 * goes through Node's fetch: in the cloud container the caller must run with
 * NODE_USE_ENV_PROXY=1 (desk/net.mjs `ensureProxy()`), as desk.mjs does.
 *
 * Gaps. `gapsIn()` lists runs of missing bars, so a check whose engine window
 * holds one can be skipped and a trade that spans one flagged (LEARNING-PLAN.md
 * Part 1). Gold's market shuts every weekend, for an hour every day and early
 * on US holidays; those are the market closed, not data missing, and are told
 * apart by the New York clock they keep, not by how long they last.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { TIMEFRAMES, timeframeOf } from '../src/timeframes.js';
import { pairOf } from './lib.mjs';

/** Bars a Binance klines call returns at most. A shorter page means the present was reached. */
export const BINANCE_PAGE = 1000;
/** Bars a Twelve Data time_series call returns at most. */
export const TWELVE_PAGE = 5000;
/** Twelve Data's free tier: 8 calls a minute, so no closer than this. */
export const TWELVE_SPACING_MS = 8000;
/** How long to wait after Twelve Data says the minute's allowance is used up. */
export const TWELVE_LIMIT_WAIT_MS = 60000;
/**
 * A full Twelve Data page whose newest bar is further than this before the
 * end asked for is not the page asked for (the oldest 5,000 of a range, say)
 * and is refused rather than merged into a cache that cannot shed it. The
 * longest real closure is under four days; a week leaves room.
 */
export const TWELVE_PAGE_STALE_MS = 7 * 86400e3;
/** Retries after the first try, on a network failure, a server error or a rate limit. */
export const MAX_RETRIES = 5;
/** A gap is listed from this many missing bars: "a gap of more than 4 bars" (LEARNING-PLAN.md). */
export const GAP_MIN_MISSING = 5;
/** Bars an engine read looks back over (the live watcher fetches 1,000 for the higher-timeframe bias). */
export const GAP_LOOKBACK = 1000;

/*
 * Gold's hours, on the New York clock it keeps (DST and all): the day's trading
 * stops at 17:00 and restarts at 18:00; the week stops Friday 17:00 and
 * restarts Sunday 18:00. On US holidays (MLK, Presidents, Memorial, Juneteenth,
 * July 4, Labor, Thanksgiving, the days around Christmas and New Year) it
 * stops early, about 13:00-13:45, and restarts at 18:00 that day or the next.
 * Twelve Data's spot feed has not been checked live against this; if its day
 * runs on another clock, every daily break on M5 shows up as a gap, which is
 * loud, rather than a real hole being hidden, which would be silent.
 */
/** 17:00 New York, in minutes of the day: the daily and weekly close. */
export const GOLD_CLOSE_ET_MIN = 17 * 60;
/** 18:00 New York: the restart after every closure. */
export const GOLD_REOPEN_ET_MIN = 18 * 60;
/** A closure starting after noon New York and before the usual close is a holiday's early close. */
export const GOLD_EARLY_CLOSE_FROM_ET_MIN = 12 * 60;
/** How far a closure's edge may sit from the scheduled time: one bar, and at least a quarter hour. */
export const GOLD_CLOSURE_SLACK_MS = 15 * 60000;
/** An early close and the whole next day shut (Christmas or New Year midweek): about 28 hours. */
export const GOLD_HOLIDAY_MAX_MS = 30 * 3600e3;
/**
 * Gold's weekend: about 49 hours, stretched to about 76 when a holiday falls on
 * the Friday or the Monday (Christmas 2020: Thursday 13:45 to Sunday 18:00 New
 * York is 76¼ hours). A closure over a Saturday up to this long, starting after
 * noon New York and ending on the Sunday or at an 18:00 restart, is the
 * weekend; a hole running into the London session either side is not.
 */
export const GOLD_WEEKEND_MAX_MS = 78 * 3600e3;

/** Which feed holds each instrument's history. */
export const HISTORY_FEEDS = { BTCUSD: 'binance-vision', XAUUSD: 'twelvedata' };

const MAX_PAGES = 20000;
const DAY_MS = 86400e3;

/** Where the desk keeps container state: $SCALP_DESK_HOME, or ~/.scalp-desk. */
export const deskHome = () => process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');

/** 'BTCUSD' / 'XAUUSD' from the ways it is written ("bitcoin", "gold", "XAU/USD"), else null. lib.mjs's, so the two cannot drift. */
export const historyPair = pairOf;

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

const sameBar = (a, b) => !!a && !!b && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

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

/** Minutes of a timeframe: a number of minutes, or anything timeframeOf reads ('M15', '5m'). */
function minutesOf(tf) {
  if (typeof tf === 'number') return tf > 0 && Number.isFinite(tf) ? tf : null;
  const id = timeframeOf(tf);
  return id ? TIMEFRAMES[id].minutes : null;
}

/* ------------------------------------------------------------ gold's clock */

// One formatter for the module: building an Intl.DateTimeFormat per call is
// what made the replay slow (LEARNING-PLAN.md, Engineering).
const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
/** The New York wall clock at `ms`: { day: 'YYYY-MM-DD', dow: 'Mon'..'Sun', min: minutes since midnight }. */
function newYork(ms) {
  const p = {};
  for (const { type, value } of NEW_YORK.formatToParts(new Date(ms))) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** Whether a closure from `fromT` to `toT` lies over a Saturday (UTC; the whole of it is inside any weekend closure). */
function overSaturday(fromT, toT) {
  const dayStart = Math.floor(fromT / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay();
  if (dow === 6) return true;
  const saturday = dayStart + ((6 - dow + 7) % 7) * DAY_MS;
  return saturday < toT;
}

/**
 * Whether gold's market was shut from `closeAt` (the end of the last bar
 * before a hole) to `reopenAt` (the open of the first bar after it):
 *  - the daily break: from 17:00 to 18:00 New York the same day;
 *  - a holiday: from an early close (after noon, before 17:00) to an 18:00
 *    restart, that day or the next, within GOLD_HOLIDAY_MAX_MS;
 *  - the weekend: over a Saturday, within GOLD_WEEKEND_MAX_MS, from after
 *    noon New York (so a hole in Friday's London session still counts) to a
 *    Sunday or an 18:00 restart (so a hole in Monday's still counts).
 * Each edge may sit up to a bar (at least 15 minutes) off the hour.
 */
function goldShut(closeAt, reopenAt, ms) {
  const slack = Math.max(ms, GOLD_CLOSURE_SLACK_MS) / 60000;
  const c = newYork(closeAt), o = newYork(reopenAt);
  const len = reopenAt - closeAt;
  const atReopen = Math.abs(o.min - GOLD_REOPEN_ET_MIN) <= slack;
  if (len <= GOLD_WEEKEND_MAX_MS && overSaturday(closeAt, reopenAt)) {
    return c.min >= GOLD_EARLY_CLOSE_FROM_ET_MIN - slack && (o.dow === 'Sun' || atReopen);
  }
  if (!atReopen) return false;
  if (c.day === o.day && Math.abs(c.min - GOLD_CLOSE_ET_MIN) <= slack) return true;
  return c.min >= GOLD_EARLY_CLOSE_FROM_ET_MIN && c.min < GOLD_CLOSE_ET_MIN - slack && len <= GOLD_HOLIDAY_MAX_MS;
}

/** Whether gold's market is on its scheduled break at `t` (daily 17:00-18:00, or Friday 17:00 to Sunday 18:00, New York). */
function goldOnBreak(t) {
  const { dow, min } = newYork(t);
  if (dow === 'Sat') return true;
  if (dow === 'Fri' && min >= GOLD_CLOSE_ET_MIN) return true;
  if (dow === 'Sun' && min < GOLD_REOPEN_ET_MIN) return true;
  return min >= GOLD_CLOSE_ET_MIN && min < GOLD_REOPEN_ET_MIN;
}

/* ------------------------------------------------------------ gaps */

/**
 * Runs of missing bars in a sorted list: [{ afterT, nextT, missingBars }],
 * where afterT is the last bar before the hole, nextT the first after it, and
 * missingBars how many bars of the timeframe would fit between. `tf` is the
 * bar length in minutes or a timeframe id ('M15'); anything else throws,
 * because without it every pair of bars would read as a gap. Only holes of at
 * least `minMissing` bars are listed. For gold (`pair` 'XAUUSD' or 'gold'),
 * closures that keep the market's New York schedule (goldShut) are left out;
 * a hole at any other time is listed, however short its closure-like length.
 * Bitcoin trades every hour of every day, so every hole in it counts.
 */
export function gapsIn(bars, tf, { minMissing = GAP_MIN_MISSING, pair = null } = {}) {
  const minutes = minutesOf(tf);
  if (!minutes) throw new TypeError(`gapsIn: the timeframe is needed (minutes or an id such as 'M15'), got ${tf}`);
  const ms = minutes * 60000;
  const gold = historyPair(pair) === 'XAUUSD';
  const gaps = [];
  for (let i = 1; i < (bars?.length || 0); i++) {
    const a = bars[i - 1].t, b = bars[i].t;
    const missingBars = Math.round((b - a) / ms) - 1;
    if (missingBars < minMissing) continue;
    if (gold && goldShut(a + ms, b, ms)) continue;
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
  try { const m = JSON.parse(readFileSync(metaPathOf(file), 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/** Write to a temporary file beside the target, then rename: a reader sees the old file or the new one, never half. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, text); renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}

/** Index of the bar with open time t in a sorted list, or -1. */
function indexOfT(bars, t) {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, x = bars[mid].t;
    if (x === t) return mid;
    if (x < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/* ------------------------------------------------------------ the network */

/** The default wait: a timer that an abort cuts short and clears, so it never holds the process open. */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
const backoffMs = (retry) => 1000 * 2 ** (retry - 1);          // 1, 2, 4, 8, 16 s

/** Why the run must stop now (cancelled, or out of time), or null. */
function stopReason(ctx) {
  if (ctx.userSignal?.aborted) return 'it was cancelled';
  if (ctx.signal?.aborted || (ctx.deadlineAt != null && ctx.clock() >= ctx.deadlineAt)) return 'the time allowed ran out';
  return null;
}

/** `promise`, or an early 'aborted' once the signal fires, so a fetch that ignores its signal still cannot outlast it. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    // Abandoned: its later failure is expected, not an unhandled rejection.
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); resolve(ABORTED); return; }
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
const ABORTED = Symbol('aborted');

/**
 * Wait `ms`, unless that would run past the deadline or the signal fires.
 * Returns null, or why the run must stop instead.
 */
async function pause(ctx, ms) {
  if (stopReason(ctx)) return stopReason(ctx);
  if (ctx.deadlineAt != null && ctx.clock() + ms > ctx.deadlineAt) return 'the next wait would pass the time allowed';
  await untilAborted(ctx.sleep(ms, ctx.signal), ctx.signal);
  return stopReason(ctx);
}

const isAbortError = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError';

/**
 * One GET with retries: a network failure, an HTTP 5xx, 429 or 418 (Binance's
 * "slow down") waits and tries again, up to MAX_RETRIES times. Any other HTTP
 * error is final. A cancel or the deadline ends it at once with { aborted }.
 * Never puts the URL or the key in a message.
 */
async function getJson(url, ctx, { beforeCall, limitWaitMs, headers } = {}) {
  let last = '';
  const init = { ...(ctx.signal ? { signal: ctx.signal } : {}), ...(headers ? { headers } : {}) };
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const stop = (retry ? await pause(ctx, last === 'HTTP 429' && limitWaitMs ? limitWaitMs : backoffMs(retry)) : null)
      || (beforeCall ? await beforeCall() : null) || stopReason(ctx);
    if (stop) return { aborted: stop };
    ctx.calls++;
    let r;
    try {
      r = await untilAborted(ctx.fetchImpl(url, init), ctx.signal);
      if (r === ABORTED) return { aborted: stopReason(ctx) };
    } catch (e) {
      if (isAbortError(e) || stopReason(ctx)) return { aborted: stopReason(ctx) || 'the time allowed ran out' };
      last = ctx.scrub(e?.message || String(e));
      ctx.log?.(`  network error (${last}); trying again`);
      continue;
    }
    if (r.status === 429 || r.status === 418 || r.status >= 500) { last = `HTTP ${r.status}`; ctx.log?.(`  ${last}; trying again`); continue; }
    if (!r.ok) return { error: `HTTP ${r.status}` };
    try {
      const body = await untilAborted(r.json(), ctx.signal);
      if (body === ABORTED) return { aborted: stopReason(ctx) };
      return { json: body };
    } catch (e) {
      if (isAbortError(e) || stopReason(ctx)) return { aborted: stopReason(ctx) || 'the time allowed ran out' };
      last = 'a reply that was not JSON';
      continue;
    }
  }
  return { error: `no usable answer after ${MAX_RETRIES + 1} tries (last: ${last})` };
}

const isoUtc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const offGrid = (feed, t, ctx) => `${feed} sent a bar at ${Number.isFinite(t) ? `${new Date(t).toISOString()} UTC` : 'an unreadable time'}, off the ${ctx.minutes}-minute grid; that page was not saved.`;

/**
 * Binance BTCUSDT bars from `fromT` forward until `endT`, 1,000 a call.
 * Stops at an empty or short page (the present) or once a page reaches endT.
 * Returns { bars, done } or { bars, error, aborted? } with whatever arrived before it.
 */
async function binanceSpan(fromT, endT, ctx) {
  const bars = [];
  let t = Math.max(0, Math.floor(fromT));
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${ctx.minutes}m&startTime=${t}&limit=${BINANCE_PAGE}`, ctx);
    if (r.aborted) return { bars, error: `Fetching bitcoin's history was stopped before it finished (${r.aborted}).`, aborted: true };
    if (r.error) return { bars, error: `Binance's price history did not answer: ${r.error}.` };
    if (!Array.isArray(r.json)) return { bars, error: `Binance's price history sent something other than bars${r.json?.msg ? ` ("${r.json.msg}")` : ''}.` };
    const pageBars = r.json.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const bad = pageBars.find((b) => !Number.isFinite(b.t) || b.t % ctx.ms !== 0);
    if (bad) return { bars, error: offGrid('Binance', bad.t, ctx) };
    bars.push(...pageBars);
    if (r.json.length < BINANCE_PAGE) return { bars, done: true };
    const lastT = pageBars[pageBars.length - 1].t;
    if (!(lastT >= t)) return { bars, error: 'Binance\'s price history went backwards between pages.' };
    if (lastT + ctx.ms >= endT) return { bars, done: true };
    t = lastT + ctx.ms;
    if (page % 50 === 49) ctx.log?.(`  bitcoin: ${bars.length.toLocaleString('en-GB')} bars, to ${isoUtc(lastT)} UTC`);
  }
  return { bars, error: 'Binance\'s price history did not end after 20,000 pages.' };
}

/** One Twelve Data call: its own error replies (HTTP 200, status "error") turned into what to do next. */
async function twelveCall(url, ctx) {
  // Calls start at least 8 s apart, retries included. Returns why to stop, or null.
  const beforeCall = async () => {
    if (ctx.lastTwelveAt != null) {
      const wait = TWELVE_SPACING_MS - (ctx.clock() - ctx.lastTwelveAt);
      const stop = wait > 0 ? await pause(ctx, wait) : null;
      if (stop) return stop;
    }
    ctx.lastTwelveAt = ctx.clock();
    return null;
  };
  // The key travels as Twelve Data's documented header, not in the address.
  const headers = { Authorization: `apikey ${ctx.key}` };
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const r = await getJson(url, ctx, { beforeCall, limitWaitMs: TWELVE_LIMIT_WAIT_MS, headers });
    if (r.aborted) return { error: `Fetching gold's history was stopped before it finished (${r.aborted}).`, aborted: true };
    if (r.error) return { error: `Twelve Data did not answer: ${r.error}.` };
    const d = r.json;
    if (d?.status !== 'error') return { json: d };
    const msg = ctx.scrub(String(d.message || '').trim());
    const code = Number(d.code);
    if (code === 429) {
      if (/\bday\b|daily/i.test(msg)) return { error: 'Twelve Data says today\'s allowance of calls is used up.', dayLimit: true };
      ctx.log?.('  Twelve Data: this minute\'s calls are used up; waiting a minute');
      const stop = await pause(ctx, TWELVE_LIMIT_WAIT_MS);
      if (stop) return { error: `Fetching gold's history was stopped before it finished (${stop}).`, aborted: true };
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
 * first. Paged by end_date alone: with a start_date as well, nothing promises
 * the newest 5,000 of a longer range rather than the oldest, and a wrong page
 * merged into a cache that only grows could never be taken out. Each page
 * ends where the last began, so it works whether end_date includes its own
 * bar or not. Stops at a short page or "No data is available" (the start of
 * what it holds), or once a page reaches fromT; the bars before fromT on that
 * page are kept, at a cost of at most one page.
 * Returns { bars, done } or { bars, error, aborted?, dayLimit? }.
 */
async function twelveSpan(fromT, endT, ctx) {
  const bars = [];
  let end = endT;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = [
      'symbol=XAU/USD', `interval=${ctx.minutes}min`, 'timezone=UTC', `outputsize=${TWELVE_PAGE}`,
      `end_date=${encodeURIComponent(isoUtc(end) + ':00')}`,
    ].join('&');
    const r = await twelveCall(`https://api.twelvedata.com/time_series?${q}`, ctx);
    if (r.noData) return { bars, done: true };
    if (r.error) return { bars, error: r.error, aborted: r.aborted, dayLimit: r.dayLimit };
    const values = Array.isArray(r.json?.values) ? r.json.values : [];
    const pageBars = [];
    let oldest = Infinity, newest = -Infinity;
    for (const v of values) {
      const s = String(v.datetime || '');
      const t = Date.parse((s.length === 10 ? `${s}T00:00:00` : s.replace(' ', 'T')) + 'Z');
      // A datetime in another zone or offset would land off the grid (and, with DST, collide in the autumn).
      if (!Number.isFinite(t) || t % ctx.ms !== 0) return { bars, error: offGrid('Twelve Data', t, ctx) };
      pageBars.push({ t, o: v.open, h: v.high, l: v.low, c: v.close, v: v.volume ?? 0 });
      if (t < oldest) oldest = t;
      if (t > newest) newest = t;
    }
    if (values.length >= TWELVE_PAGE && newest < end - TWELVE_PAGE_STALE_MS) {
      return { bars, error: `Twelve Data answered a request for bars up to ${isoUtc(end)} UTC with bars ending ${isoUtc(newest)} UTC; that page was not saved.` };
    }
    bars.push(...pageBars);
    if (values.length < TWELVE_PAGE) return { bars, done: true };
    if (oldest <= fromT) return { bars, done: true };
    if (!(oldest < end)) return { bars, error: 'Twelve Data returned the same page twice.' };
    end = oldest;
    ctx.log?.(`  gold: ${bars.length.toLocaleString('en-GB')} bars, back to ${isoUtc(oldest)} UTC`);
  }
  return { bars, error: 'Twelve Data\'s history did not end after 20,000 pages.' };
}

/* ------------------------------------------------------------ loadHistory */

/** A time option: left out → the default; anything else must be a finite number of ms. */
function timeOpt(opts, name, fallback) {
  if (opts[name] === undefined) return { value: fallback };
  if (typeof opts[name] === 'number' && Number.isFinite(opts[name])) return { value: opts[name] };
  return { error: `${name} must be a time in milliseconds; it was ${String(opts[name])}, so nothing was fetched.` };
}

/** Whether a bar opening between `fromT` and `toT` (and closed by `nowMs`) could exist: for gold, not if all of it falls on a scheduled break. */
function goldBarPossible(fromT, toT, nowMs, ms) {
  const cap = Math.ceil(GOLD_WEEKEND_MAX_MS / ms) + 2;
  let n = 0;
  for (let x = fromT; x < toT && x + ms <= nowMs; x += ms) {
    if (!goldOnBreak(x)) return true;
    if (++n > cap) return true;
  }
  return false;
}

/**
 * Closed bars for one instrument and timeframe between fromMs (inclusive) and
 * toMs (exclusive), from the cache, extended from the feed at either end.
 *
 *   pair  'BTCUSD' | 'XAUUSD' (or "bitcoin", "gold")
 *   tf    'M15' | 'M5' (or as typed: "15", "5m")
 *   opts  a plain object (the range is never positional; a call written
 *         loadHistory(pair, tf, fromMs, toMs, …) throws a TypeError):
 *     fromMs  earliest bar wanted (open time, UTC ms). Left out: as far back as
 *             the feed goes (Binance from 2017-08-17; Twelve Data until "No data").
 *     toMs    default nowMs. nowMs default Date.now(): bars that have not closed
 *             by then are neither cached nor returned. Any of the three given
 *             but not a finite number → { ok: false, reason }, never "everything".
 *     signal      an AbortSignal; cancels every fetch and wait at once.
 *     deadlineMs  a time budget from the call; no wait is started that would
 *                 pass it, and fetches are cut off when it runs out.
 *     home    default $SCALP_DESK_HOME or ~/.scalp-desk. fetchImpl default fetch,
 *             called as fetchImpl(url, { signal, headers? }).
 *     keys    { twelvedata } default $TWELVEDATA_API_KEY.
 *     sleep, clock  injected for tests: sleep(ms, signal) for waits, and the
 *             clock the 8 s spacing and the deadline read.
 *     log     optional (line) => void for progress on long fetches.
 *
 * Returns
 *   { ok: true, bars, source, fetched, calls, coverage: { first, last, count, gaps } }
 *     bars      [{t,o,h,l,c,v}] oldest first, closed only, in [fromMs, toMs)
 *     source    'binance-vision' | 'twelvedata' (the cache holds that feed's bars only)
 *     fetched   bars new to the cache or changed by this call (0: nothing changed)
 *     calls     network calls made (retries included)
 *     coverage  first/last: open times of the first and last bar returned (null if none);
 *               count: bars.length; gaps: gapsIn(bars) — [{afterT, nextT, missingBars}]
 *     stale, needKey, note   only for gold without a key when the saved bars
 *               cover the start asked for and only newer bars are missing: the
 *               saved bars are served, flagged, rather than nothing.
 *   { ok: false, needKey: true, reason }   gold, earlier bars needed, no Twelve Data key
 *   { ok: false, aborted: true, reason }   cancelled, or out of time
 *   { ok: false, reason }                  any other plain-English reason. Bars that did
 *               arrive are still saved when they join onto the cache, so a rerun carries on.
 */
export async function loadHistory(pair, tf, opts = {}) {
  if (arguments.length > 3 || opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('loadHistory(pair, tf, opts): the range and settings go in one options object ({ fromMs, toMs, home, fetchImpl, … }), not as separate arguments');
  }
  const P = historyPair(pair);
  if (!P) return { ok: false, reason: `There is no price history for "${pair}" here: bitcoin (BTCUSD) and gold (XAUUSD) only.` };
  const tfId = timeframeOf(tf);
  if (!tfId) return { ok: false, reason: `"${tf}" is not a chart timeframe the desk knows (M15 or M5).` };
  const minutes = TIMEFRAMES[tfId].minutes, ms = minutes * 60000;
  const nowO = timeOpt(opts, 'nowMs', Date.now());
  if (nowO.error) return { ok: false, reason: nowO.error };
  const toO = timeOpt(opts, 'toMs', nowO.value), fromO = timeOpt(opts, 'fromMs', 0);
  if (toO.error || fromO.error) return { ok: false, reason: toO.error || fromO.error };
  const nowMs = nowO.value, toMs = toO.value, fromMs = fromO.value;
  if (opts.deadlineMs !== undefined && !(typeof opts.deadlineMs === 'number' && opts.deadlineMs > 0)) {
    return { ok: false, reason: `deadlineMs must be a positive number of milliseconds; it was ${String(opts.deadlineMs)}.` };
  }
  const home = opts.home ?? deskHome();
  const key = String((opts.keys ? opts.keys.twelvedata : process.env.TWELVEDATA_API_KEY) || '');
  const clock = opts.clock ?? Date.now;
  // The deadline's own timer, held (unlike AbortSignal.timeout's) so a fetch
  // that never settles cannot let the process drift out before it fires; it is
  // cleared on every way out below.
  const deadline = opts.deadlineMs ? new AbortController() : null;
  const timer = deadline ? setTimeout(() => deadline.abort(new DOMException('The time allowed ran out', 'TimeoutError')), opts.deadlineMs) : null;
  const signals = [opts.signal, deadline?.signal].filter(Boolean);
  const scrub = (s) => {
    let out = String(s);
    if (key) for (const k of new Set([key, encodeURIComponent(key)])) out = out.split(k).join('***');
    return out;
  };
  const ctx = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch, sleep: opts.sleep ?? defaultSleep, clock,
    log: opts.log ? (line) => opts.log(scrub(line)) : null, scrub,
    minutes, ms, key, calls: 0, lastTwelveAt: null,
    userSignal: opts.signal ?? null,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] ?? null,
    deadlineAt: opts.deadlineMs ? clock() + opts.deadlineMs : null,
  };
  try {
    return await fill(P, tfId, { fromMs, toMs, nowMs, home, ctx });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** loadHistory's work once its options are checked: read, fetch the missing ends, save, answer. */
async function fill(P, tfId, { fromMs, toMs, nowMs, home, ctx }) {
  const { minutes, ms, key, scrub } = ctx;
  const source = HISTORY_FEEDS[P];
  const file = historyPath(P, tfId, home);

  const cached = readCache(file);
  if (cached.error) return { ok: false, reason: cached.error };
  const meta = readMeta(file);
  const end = Math.min(toMs, nowMs);       // nothing at or after this can be a closed bar we want
  const firstBar = cached.bars[0], lastBar = cached.bars[cached.bars.length - 1];

  // The sidecar is believed only about the bars it names: headCheckedFrom while
  // the cache still starts at headFirstT, closedThrough while the cache still
  // ends on the very bar (prices and all) this module saved as final.
  const headTrusted = !!firstBar && meta.headFirstT === firstBar.t && Number.isFinite(meta.headCheckedFrom);
  const tailSure = !!lastBar && meta.closedThrough === lastBar.t && sameBar(meta.closedBar, lastBar);

  // What to fetch: the whole range into an empty cache, or the missing ends.
  const spans = [];
  if (!cached.bars.length) {
    if (fromMs < end) spans.push({ kind: 'all', from: fromMs, to: end });
  } else {
    const first = firstBar.t, last = lastBar.t;
    // headCheckedFrom: an earlier run asked from there and found nothing before the first bar.
    const checked = headTrusted ? Math.min(first, meta.headCheckedFrom) : first;
    if (fromMs <= checked - ms && fromMs < end) spans.push({ kind: 'head', from: fromMs, to: first });
    // Sure of the last bar: fetch only once the next one (opening before toMs) has closed.
    // Not sure: fetch the last bar again whenever it is wanted and has closed.
    let wantTail = tailSure ? last + ms < toMs && last + 2 * ms <= nowMs : last < toMs && last + ms <= nowMs;
    // Gold over its weekend or daily break: no bar can have closed, so no call is spent.
    if (wantTail && tailSure && P === 'XAUUSD' && !goldBarPossible(last + ms, toMs, nowMs, ms)) wantTail = false;
    if (wantTail) spans.push({ kind: 'tail', from: last, to: Math.max(end, last + ms) });
  }

  let stale = null;
  if (spans.length && P === 'XAUUSD' && !key) {
    const how = 'Gold\'s price history comes from Twelve Data, which needs a free key (TWELVEDATA_API_KEY).';
    if (spans.some((s) => s.kind !== 'tail')) return { ok: false, needKey: true, reason: how };
    // Only newer bars are missing: serve what is saved, flagged, rather than nothing.
    stale = { stale: true, needKey: true, note: `${how} The saved bars end at ${isoUtc(lastBar.t)} UTC; newer ones were not fetched.` };
    spans.length = 0;
  }
  if (spans.length && typeof ctx.fetchImpl !== 'function') return { ok: false, reason: 'This Node has no fetch; it needs version 18 or later.' };

  const kept = [];
  let error = null, aborted = false, headCheckedFrom = null;
  for (const s of spans) {
    ctx.log?.(`${P} ${tfId}: fetching ${s.kind === 'all' ? 'history' : s.kind === 'head' ? 'earlier bars' : 'newer bars'} ${isoUtc(s.from)} → ${isoUtc(s.to)} UTC`);
    const r = P === 'BTCUSD' ? await binanceSpan(s.from, s.to, ctx) : await twelveSpan(s.from, s.to, ctx);
    // Keep what arrived before a failure only if it joins onto the cache: Binance
    // pages forward, so a partial head (or a partial tail from Twelve Data,
    // paging back) would leave a hole the "ends only" rule never fills.
    let joins = r.done || s.kind === 'all' || (P === 'BTCUSD' ? s.kind === 'tail' : s.kind === 'head');
    let reason = r.error ? scrub(r.error) : null;
    // A tail must meet the cache on its last bar; one that does not is another
    // series (or a feed that moved), and merging it would hide the seam.
    if (s.kind === 'tail' && r.bars.length && !r.bars.some((b) => b.t === s.from)) {
      joins = false;
      reason = reason || `The feed's newer bars did not include the last saved one (${isoUtc(s.from)} UTC), so they were not saved.`;
    }
    const keeping = joins && r.bars.some((b) => b.t + ms <= nowMs);
    if (joins) kept.push(...r.bars);
    if (r.done && joins && (s.kind === 'head' || s.kind === 'all')) headCheckedFrom = s.from;
    if (r.dayLimit) reason += keeping ? ' The bars fetched before that are saved; run it again tomorrow to carry on.' : ' Nothing from this fetch could be saved without leaving a hole; run it again tomorrow.';
    if (reason) { error = reason; aborted = !!r.aborted; break; }
  }
  const fresh = mergeBars([], kept.filter((b) => Number.isFinite(b.t) && b.t + ms <= nowMs));

  // Save: re-read first (another run may have written since), merge, write only what changed.
  let bars = cached.bars, fetched = 0;
  if (fresh.length || cached.bars.length) {
    const now = fresh.length ? readCache(file) : cached;
    if (now.error) return { ok: false, reason: now.error };
    for (const b of fresh) { const i = indexOfT(now.bars, b.t); if (i < 0 || !sameBar(now.bars[i], b)) fetched++; }
    bars = fetched ? mergeBars(now.bars, fresh) : now.bars;
    if (now.bars.length && (bars[0].t > now.bars[0].t || bars[bars.length - 1].t < now.bars[now.bars.length - 1].t)) {
      return { ok: false, reason: 'The merged history came out shorter than the saved one, so nothing was written.' };
    }
    const metaNext = {};
    const head = bars[0], tail = bars[bars.length - 1];
    if (head && headCheckedFrom != null) Object.assign(metaNext, { headCheckedFrom: Math.min(headCheckedFrom, head.t), headFirstT: head.t });
    else if (head && headTrusted && head.t === meta.headFirstT) Object.assign(metaNext, { headCheckedFrom: meta.headCheckedFrom, headFirstT: meta.headFirstT });
    const freshTail = fresh[fresh.length - 1];
    if (tail && freshTail && freshTail.t === tail.t) Object.assign(metaNext, { closedThrough: tail.t, closedBar: tail });
    else if (tail && tailSure && sameBar(meta.closedBar, tail)) Object.assign(metaNext, { closedThrough: meta.closedThrough, closedBar: meta.closedBar });
    const metaChanged = JSON.stringify(metaNext) !== JSON.stringify(meta);
    try {
      if (fetched) writeAtomic(file, JSON.stringify(bars));
      if (metaChanged) writeAtomic(metaPathOf(file), JSON.stringify(metaNext));
    } catch (e) {
      return { ok: false, reason: `The price history could not be saved (${e.message}).` };
    }
  }
  if (error) return aborted ? { ok: false, aborted: true, reason: error } : { ok: false, reason: error };

  const out = bars.filter((b) => b.t >= fromMs && b.t < toMs && b.t + ms <= nowMs);
  return {
    ok: true, bars: out, source, fetched, calls: ctx.calls,
    coverage: {
      first: out.length ? out[0].t : null,
      last: out.length ? out[out.length - 1].t : null,
      count: out.length,
      gaps: gapsIn(out, minutes, { pair: P }),
    },
    ...(stale || {}),
  };
}
