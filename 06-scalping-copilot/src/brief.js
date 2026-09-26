/**
 * brief.js — the pre-session brief.
 *
 * What it is for, and what it is not. There is no credible evidence that a
 * pre-market routine, as such, improves trading outcomes. The finding that
 * does carry over from the checklist literature is narrower: a checklist helps
 * when it DEMANDS an input and does nothing when it can be ticked through
 * (Haynes et al. 2009, against Urbach et al. 2014). So the brief shows the few
 * facts worth having before 08:00, then asks for two decisions — which setups,
 * and how many trades at most — instead of presenting boxes to tick.
 *
 * It shows no P&L and no time to the close. During the session it keeps one
 * process count, trades taken against the plan, which the user taps.
 *
 * Everything here is pure, so it is tested under node without a page.
 */
import { zonedTimeToUtc } from './timezone.js';
import { localDate, windowState, remainingBands } from './sessions.js';
import { getUpcomingEvents } from './news-calendar.js';

/** Generic scalping setups offered as one-tap choices. The user can add their own. */
export const SETUPS = ['Trend pullback', 'Breakout', 'Range fade', 'Sweep and reclaim'];

/** An overnight range needs at least an hour of five-minute bars to mean anything. */
const MIN_OVERNIGHT_BARS = 12;
const M5_MS = 300000;
const ONE_DAY_MS = 864e5;

/** The calendar day in the user's window zone, as 'YYYY-MM-DD' — the key a plan is stored under. */
export function dayKey(atMs, win) {
  const { y, m, d } = localDate(atMs, win.tz);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The overnight stretch, ending now or at the open, whichever comes first.
 *  - Gold: since its daily reopen at 18:00 New York, after the 17:00-18:00
 *    break — the Asian session and early Europe. On a Monday that is Sunday's
 *    reopen, which is correct: gold is shut on Saturday.
 *  - Bitcoin: the last 24 hours. It never closes, so "overnight" has no
 *    natural start, and a full day is the honest comparison.
 */
export function overnightWindow(nowMs, pair, win) {
  const endMs = Math.min(nowMs, windowState(nowMs, win).opensAtMs);
  if (pair === 'BTCUSD') return { startMs: endMs - ONE_DAY_MS, endMs, basis: 'last 24 hours' };
  const { y, m, d } = localDate(endMs, 'America/New_York');
  let startMs = zonedTimeToUtc(y, m, d, 18, 0, 'America/New_York');
  if (startMs > endMs) startMs = zonedTimeToUtc(y, m, d - 1, 18, 0, 'America/New_York');
  return { startMs, endMs, basis: 'since the reopen' };
}

/** High, low and last close of the bars inside [startMs, endMs). Null if too few. */
export function rangeOf(bars, startMs, endMs) {
  const inside = (bars || []).filter((b) => b.t >= startMs && b.t < endMs);
  if (inside.length < MIN_OVERNIGHT_BARS) return null;
  let high = -Infinity, low = Infinity;
  for (const b of inside) {
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
  }
  return { high, low, size: high - low, bars: inside.length, last: inside[inside.length - 1].c };
}

/** Where a price sits in a range, in words. Works for a typed price outside it too. */
export function whereInRange(price, high, low) {
  if (!(high > low) || !(price > 0)) return null;
  const pos = (price - low) / (high - low);
  const where = price > high ? 'above the overnight high'
    : price < low ? 'below the overnight low'
      : pos >= 0.8 ? 'near the overnight high'
        : pos <= 0.2 ? 'near the overnight low'
          : 'in the middle of the overnight range';
  return { pos: +pos.toFixed(2), where };
}

/**
 * Tonight's range against the same stretch on earlier nights, like for like:
 * each earlier window has the same length and ends at the same clock time.
 * Windows the market was shut for (gold at the weekend) are skipped rather
 * than counted as quiet. Fewer than two usable nights gives no verdict.
 */
export function overnightVsNorm(bars, startMs, endMs, nights = 3) {
  const tonight = rangeOf(bars, startMs, endMs);
  if (!tonight) return null;
  const expected = (endMs - startMs) / M5_MS;
  const prior = [];
  for (let k = 1; k <= nights + 3 && prior.length < nights; k++) {
    const r = rangeOf(bars, startMs - k * ONE_DAY_MS, endMs - k * ONE_DAY_MS);
    if (r && r.bars >= expected * 0.6) prior.push(r.size);
  }
  if (prior.length < 2) return { nights: prior.length, ratio: null, word: null };
  const s = [...prior].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (!(mid > 0)) return { nights: prior.length, ratio: null, word: null };
  const ratio = tonight.size / mid;
  const word = ratio >= 1.4 ? 'busier than usual' : ratio <= 0.7 ? 'quieter than usual' : 'about normal';
  return { nights: prior.length, ratio: +ratio.toFixed(2), word };
}

/** Today's scheduled releases inside the window, with the flat-from and flat-until times. */
export function todaysPrints(nowMs, pair, win) {
  const ws = windowState(nowMs, win);
  return getUpcomingEvents(nowMs, 24, pair, { includeContext: false })
    .filter((e) => typeof e.tier === 'number' && e.ts >= ws.opensAtMs && e.ts < ws.closesAtMs)
    .map((e) => ({
      ...e,
      flatFromMs: (e.windowStartTs || e.ts) - e.blackoutBefore * 60000,
      flatToMs: e.ts + e.blackoutAfter * 60000,
    }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * The shape of the day for one instrument: the stretches worth trading and
 * the ones to sit out, with neighbouring bands of the same kind merged.
 */
export function dayShape(nowMs, pair, win) {
  const bands = remainingBands(nowMs, pair, win);
  const merge = (list) => list.reduce((out, b) => {
    const last = out[out.length - 1];
    if (last && last.toMs === b.startsAtMs) { last.toMs = b.endsAtMs; last.names.push(b.name); }
    else out.push({ fromMs: b.startsAtMs, toMs: b.endsAtMs, names: [b.name] });
    return out;
  }, []);
  return {
    best: merge(bands.filter((b) => b.band === 'green')),
    sitOut: merge(bands.filter((b) => b.band === 'dead')),
  };
}

/** Is a stored plan today's, and how far through it is the user? */
export function planStatus(plan, todayKey) {
  if (!plan || plan.date !== todayKey || !(plan.maxTrades > 0)) return null;
  const taken = Math.max(0, plan.taken || 0);
  const over = taken > plan.maxTrades;
  return {
    taken, max: plan.maxTrades, over, atLimit: taken === plan.maxTrades,
    setups: [...(plan.setups || []), ...(plan.other ? [plan.other] : [])],
    text: over ? `${taken} trades — over your plan of ${plan.maxTrades}` : `${taken} of ${plan.maxTrades} trades`,
  };
}

/** What a plan needs before it can be set. Returns the problem in words, or null. */
export function planProblem({ setups = [], other = '', maxTrades }) {
  if (!setups.length && !String(other).trim()) return 'Pick at least one setup, or write your own.';
  if (!(Number.isInteger(maxTrades) && maxTrades >= 1 && maxTrades <= 50)) return 'Set the most trades you will take today (1 to 50).';
  return null;
}
