/**
 * desk/features.mjs — one moment on the chart, described as numbers the
 * learner can compare across years.
 *
 * Why this exists. The learning layer (LEARNING-PLAN.md, Part 4) asks which
 * measurable conditions came before better or worse trades, and whether that
 * held on years it never saw. It needs every window check described the same
 * way, whatever the engine then did with it. Three rules shape everything here:
 *
 *  - PRICE-FREE. Bitcoin went from $4,000 to $120,000 inside the history and
 *    gold moved 40% in 2026 alone (decision 6). A feature measured in dollars
 *    would teach the learner the year, not the chart. So every distance is in
 *    ATRs, every level of volatility a ratio or a percentile.
 *  - MARKET-DIRECTION SIGNED. Positive means bullish, in every directional
 *    feature. `sideSigned()` turns that into "for the trade" (positive = in the
 *    trade's favour), so "momentum with the trade" is one feature for buys and
 *    sells alike, and long and short rows can be pooled with mirrored features.
 *  - NEVER LOOKS AHEAD. Only the bars handed in, and those must all have closed
 *    by `nowMs`; a bar still forming, or a history running past the engine's
 *    window, is refused with an error rather than quietly read.
 *
 * Features exist for EVERY check, not only the ones the engine traded. A news
 * blackout or gold's dead zone makes analyse() return `stand-aside` or
 * `stand-down`, and a lean without a usable stop returns `no-read` — none of
 * which carry a net score. `analysisForFeatures()` re-reads such a moment with
 * the blackout and the dead zone switched off, and `featuresAt()` recomputes
 * the net and raw confidence from the bucket scores and the exported WEIGHTS
 * exactly as analyse() does. That re-read is for description only: it never
 * reaches a trade, an alert or the user. The watcher's own path (desk/live.mjs)
 * still decides what was sendable; the dataset takes the kind from there.
 *
 * What it is not. A forecast, or a list of reasons to trade. Nothing about the
 * learner reaches a live alert (the plan's rule 3), and a feature that looks
 * predictive on one stretch is the commonest way to fool yourself.
 *
 * Pure: bars, the engine's analysis, the clock and the config are handed in.
 */
import { analyse, WEIGHTS } from '../src/signal-engine.js';
import { atr, valueAt } from '../src/indicators.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { tfInfo } from '../src/timeframes.js';
import { sessionQuality, windowState, localHour, localWeekday } from '../src/sessions.js';

/** Bars the engine reads, and bars of history behind it (desk/live.mjs ENGINE_BARS and FETCH_BARS). */
export const WINDOW_BARS = 300;
export const HISTORY_BARS = 1000;

/** Every regime detectRegime() can return, in the order of the one-hot features. */
export const REGIMES = Object.freeze(['trending', 'ranging', 'compressed', 'mixed']);

/** The four two-hour stretches of the London session, as [from, to) local hours. */
export const HOUR_BANDS = Object.freeze([
  { key: 'hour_08_10', label: '08-10', from: 8, to: 10 },
  { key: 'hour_10_12', label: '10-12', from: 10, to: 12 },
  { key: 'hour_12_14', label: '12-14', from: 12, to: 14 },
  { key: 'hour_14_16', label: '14-16', from: 14, to: 16 },
]);

/** Weekdays by localWeekday() number (1 = Monday). The weekend has no feature: nothing is traded then. */
export const WEEKDAYS = Object.freeze([
  { key: 'wd_mon', label: 'Mon', day: 1 },
  { key: 'wd_tue', label: 'Tue', day: 2 },
  { key: 'wd_wed', label: 'Wed', day: 3 },
  { key: 'wd_thu', label: 'Thu', day: 4 },
  { key: 'wd_fri', label: 'Fri', day: 5 },
]);

const DIRECTIONAL_BUCKETS = ['trend', 'momentum', 'structure', 'location', 'volume'];

/**
 * The feature names, in a fixed order. A dataset row is these values in this
 * order, so the order is part of the file format: append, never reorder or
 * rename, or every stored row and fitted model silently means something else.
 * test/features.test.mjs pins it.
 */
export const FEATURE_NAMES = Object.freeze([
  // The engine's own read, recomputed so it exists for every state.
  'net', 'confidence',
  'b_trend', 'b_momentum', 'b_structure', 'b_location', 'b_volume', 'volume_abstain',
  // Volatility: whether the conditions suit a scalp at all. Directionless.
  'b_volatility', 'atr_change_1h', 'bb_width_pctile', 'adx',
  'atr_over_price', 'atr_pctile',
  // Regime, as the engine named it.
  'regime_trending', 'regime_ranging', 'regime_compressed', 'regime_mixed',
  'efficiency',
  // The two higher timeframes (H1 and H4 on M15).
  'h1_bias', 'h4_bias', 'htf_agree',
  // Where price has been and where it sits, in ATRs.
  'ret_1', 'ret_4', 'ret_16', 'ret_96',
  'close_vs_ema21', 'close_vs_ema50', 'close_vs_vwap',
  'rsi_m50', 'bb_pctb_m05',
  'bar_range', 'bar_body',
  // Room to the nearest clustered level, from a buyer's point of view.
  'level_ahead', 'level_behind', 'level_ahead_none', 'level_behind_none',
  'rel_volume',
  // When.
  ...HOUR_BANDS.map((b) => b.key),
  ...WEEKDAYS.map((d) => d.key),
]);

/**
 * Features whose sign is the market's direction: positive = bullish. For a
 * sell they are multiplied by −1, so positive always means "in the trade's
 * favour". (The location bucket is mean-reverting — far above VWAP scores
 * negative — but its sign is still "which way it leans", so it flips too.)
 */
export const DIRECTIONAL = Object.freeze([
  'net', 'b_trend', 'b_momentum', 'b_structure', 'b_location', 'b_volume',
  'h1_bias', 'h4_bias',
  'ret_1', 'ret_4', 'ret_16', 'ret_96',
  'close_vs_ema21', 'close_vs_ema50', 'close_vs_vwap',
  'rsi_m50', 'bb_pctb_m05', 'bar_body',
]);

/**
 * Pairs that trade places for a sell. The raw features are written from a
 * buyer's point of view: "ahead" is the nearest level above price, "behind"
 * the nearest below. For a sell the level ahead is the one below, so the
 * values swap. Distances stay positive — a distance has no direction.
 */
export const SWAPPED = Object.freeze([
  ['level_ahead', 'level_behind'],
  ['level_ahead_none', 'level_behind_none'],
]);

/**
 * Why a feature can be null. The learner imputes nulls inside each training
 * fold; it must never read a null as zero, because zero is a real value for
 * most of these ("no momentum") and null is "not measurable here". When the
 * engine itself could not read the chart (fewer than its minimum bars), every
 * feature is null: such checks are skipped by the watcher anyway.
 */
export const WHY_NULL = Object.freeze({
  atr_change_1h: 'needs ATR from an hour earlier, which the first bars of the window do not have',
  bb_width_pctile: 'needs more than 20 Bollinger widths in the engine\'s lookback',
  adx: 'needs about 28 bars before ADX exists',
  atr_pctile: 'needs at least 100 bars of ATR in the history to rank against',
  efficiency: 'needs 21 closes',
  h1_bias: 'needs 30 closed H1 bars behind the check',
  h4_bias: 'needs 30 closed H4 bars (480 M15 bars) behind the check',
  htf_agree: 'needs both higher-timeframe biases',
  ret_1: 'needs 2 bars', ret_4: 'needs 5 bars', ret_16: 'needs 17 bars', ret_96: 'needs 97 bars',
  close_vs_ema21: 'needs 21 bars', close_vs_ema50: 'needs 50 bars',
  rsi_m50: 'needs 15 bars', bb_pctb_m05: 'needs 20 bars',
  level_ahead: 'no clustered level above price in the window (level_ahead_none is then 1)',
  level_behind: 'no clustered level below price in the window (level_behind_none is then 1)',
  rel_volume: 'the newest bar has fewer than two earlier same-slot bars to compare with, or the feed has no volume',
  // Any ATR-scaled feature is also null when ATR is zero or missing (a frozen feed).
});

const NUM = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/* -------------------------------------------------------- the re-read */

/**
 * analyse() on the watcher's inputs, with the two overrides that withhold a
 * read switched off: no news blackout, and a session whose band is never
 * 'dead' (bitcoin's live path already maps its dead band to 'red'; this does
 * the same for gold). Everything else is the watcher's: the same 300-bar
 * window, the same 1,000-bar history for the higher timeframes and relative
 * volume, the same final-stretch flag, the same spread.
 *
 * FEATURES ONLY. The result must never be traded, alerted or shown: it is
 * what the engine saw at a moment the live desk would have sat out.
 */
export function analysisForFeatures({ window = null, closed, pair, cfg, nowMs, tf = null, spreadNum = null }) {
  const t = tfInfo(tf ?? cfg.timeframe);
  const inst = INSTRUMENTS[pair];
  if (!inst) throw new Error(`unknown instrument ${pair}`);
  const hist = closed || window || [];
  const win = window || hist.slice(-WINDOW_BARS);
  checkInputs(win, hist, nowMs, t);
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  let session = { ...sessionQuality(nowMs, pair, cfg.window), lastStretch };
  if (session.band === 'dead') session = { ...session, band: 'red' };
  return analyse({
    bars: win, htfBars: hist, instrument: inst,
    spread: spreadNum ?? inst.typicalSpread.observed,
    blackout: null, session, nowMs, timeframe: t.id,
  });
}

/**
 * The look-ahead guard. The window's last bar must have closed by `nowMs`, and
 * the history must end on that same bar — a history running further would put
 * later bars into the H4 bias, relative volume and the ATR percentile.
 */
function checkInputs(window, closed, nowMs, t) {
  if (!window.length) return;
  const last = window[window.length - 1];
  if (!Number.isFinite(nowMs)) throw new Error('features need the moment of the check (nowMs)');
  if (last.t + t.minutes * 60000 > nowMs) {
    throw new Error(`the bar opened at ${new Date(last.t).toISOString()} had not closed by the check; pass closed bars only`);
  }
  if (closed && closed.length && closed[closed.length - 1].t !== last.t) {
    throw new Error('the history must end on the same bar as the engine\'s window');
  }
}

/* --------------------------------------------- the engine's net, again */

/**
 * Net score and raw confidence from the bucket scores, exactly as analyse()
 * computes them (same order of summation, same multipliers), before a
 * blackout or the dead zone sets confidence to 0. analyse() rounds its own
 * net to 3 places and confidence to 2; these are unrounded.
 *
 * `windowLength` is the number of bars the engine read (it marks confidence
 * down under 150); `lastStretch` is whether the check fell in the final 30
 * minutes of the window (×0.6, decision 1).
 */
export function engineScore(analysis, { windowLength, lastStretch = false }) {
  const buckets = analysis && analysis.buckets;
  const regime = analysis && analysis.regime && analysis.regime.regime;
  if (!buckets || !WEIGHTS[regime]) return { net: null, confidence: null };
  const w = WEIGHTS[regime];
  const entries = Object.entries(buckets);
  const contributing = entries.filter(([, b]) => !b.directionless && !b.noData);
  const abstaining = entries.filter(([, b]) => !b.directionless && b.noData);

  let net = 0;
  for (const [name, b] of contributing) net += b.score * w[name];
  const liveWeight = contributing.reduce((s, [n]) => s + w[n], 0);
  const abstainedWeight = abstaining.reduce((s, [n]) => s + w[n], 0);
  net = liveWeight > 0 ? net / liveWeight : 0;

  const agreeing = contributing.filter(([, b]) => Math.sign(b.score) === Math.sign(net) && Math.abs(b.score) > 0.2).length;
  let confidence = contributing.length
    ? Math.min(0.95, Math.abs(net) * 0.55 + (agreeing / contributing.length) * 0.35)
    : 0;
  if (abstainedWeight > 0) confidence *= (1 - abstainedWeight);
  if (lastStretch) confidence *= 0.6;
  if (regime === 'mixed') confidence *= 0.55;
  if (regime === 'compressed') confidence *= 0.6;
  if (buckets.volatility && buckets.volatility.score < 0) confidence *= 0.7;
  if (!(analysis.htf && analysis.htf.agree)) confidence *= 0.8;
  if (windowLength < 150) confidence *= 0.85;
  confidence = Math.max(0, Math.min(0.95, confidence));
  return { net, confidence };
}

/* ------------------------------------------------------------ features */

const allNull = () => Object.fromEntries(FEATURE_NAMES.map((n) => [n, null]));

/**
 * The features of one check: { [name]: number | null }, keys in FEATURE_NAMES
 * order. `window` is the engine's window (the last 300 closed bars), `closed`
 * the history behind it (up to 1,000 closed bars, ending on the same bar),
 * `analysis` analyse()'s result on that window — from the live path or from
 * analysisForFeatures(), the two give the same features — and `nowMs` the
 * moment of the check (bar close + 20 s on the watcher). `pair` is accepted
 * so a caller can hand both functions the same arguments; no feature depends
 * on it, which is the point of being price-free: one learner can read both.
 */
export function featuresAt({ window = null, closed = null, analysis, nowMs, cfg, pair = null, tf = null }) {
  const t = tfInfo(tf ?? cfg.timeframe);
  const hist = (closed || window || []).slice(-HISTORY_BARS);
  const win = window || hist.slice(-WINDOW_BARS);
  checkInputs(win, hist, nowMs, t);
  const out = allNull();
  const ind = analysis && analysis.indicators;
  if (!win.length || !ind || !analysis.buckets || !analysis.regime) return out;

  const last = win[win.length - 1];
  const price = last.c;
  // The analysis must be of this window, or every feature below is of a different moment.
  if (analysis.price !== undefined && analysis.price !== price) {
    throw new Error('the analysis was not made on this window (its price differs from the last close)');
  }
  const a = NUM(analysis.atr);
  const perAtr = (x) => (a && a > 0 && NUM(x) !== null ? x / a : null);

  // --- the engine's read
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  const { net, confidence } = engineScore(analysis, { windowLength: win.length, lastStretch });
  out.net = net;
  out.confidence = confidence;
  for (const name of DIRECTIONAL_BUCKETS) out[`b_${name}`] = NUM(analysis.buckets[name] && analysis.buckets[name].score);
  out.volume_abstain = analysis.buckets.volume && analysis.buckets.volume.noData ? 1 : 0;

  // --- volatility
  out.b_volatility = NUM(analysis.buckets.volatility && analysis.buckets.volatility.score);
  const aPrev = valueAt(ind.atr, t.barsPerHour);
  out.atr_change_1h = a && aPrev ? a / aPrev - 1 : null;
  out.bb_width_pctile = NUM(analysis.regime.widthPercentile);
  out.adx = NUM(analysis.regime.adx);
  out.atr_over_price = a && price > 0 ? a / price : null;
  // Where today's volatility sits in the last ~10 days' (1,000 M15 bars). The
  // history's own ATR series is used, so the ranking is like with like; it
  // counts the share of the history's values strictly below the newest, as the
  // engine's Bollinger-width percentile does.
  const histAtr = atr(hist, 14);
  const ratios = [];
  for (let i = 0; i < hist.length; i++) if (histAtr[i] !== null && hist[i].c > 0) ratios.push(histAtr[i] / hist[i].c);
  if (ratios.length >= 100) {
    const now = ratios[ratios.length - 1];
    out.atr_pctile = ratios.filter((r) => r < now).length / ratios.length;
  }

  // --- regime
  for (const r of REGIMES) out[`regime_${r}`] = analysis.regime.regime === r ? 1 : 0;
  out.efficiency = NUM(analysis.regime.efficiency);

  // --- higher timeframes (keyed by the engine's own ids: H1 and H4 on M15, M15 and H1 on M5)
  const htf = analysis.htf || {};
  const [k1, k2] = (htf.ids || t.htf.map((x) => x.id)).map((id) => id.toLowerCase());
  out.h1_bias = htf[k1] ? NUM(htf[k1].score) : null;
  out.h4_bias = htf[k2] ? NUM(htf[k2].score) : null;
  out.htf_agree = htf[k1] && htf[k2] ? (htf.agree ? 1 : 0) : null;

  // --- where price has been, and where it sits
  const back = (n) => (win.length > n ? perAtr(price - win[win.length - 1 - n].c) : null);
  out.ret_1 = back(1); out.ret_4 = back(4); out.ret_16 = back(16); out.ret_96 = back(96);
  const newest = (series) => (Array.isArray(series) ? NUM(valueAt(series, 0)) : null);
  const e21 = newest(ind.ema21), e50 = newest(ind.ema50), vw = newest(ind.vwap && ind.vwap.vwap);
  out.close_vs_ema21 = e21 === null ? null : perAtr(price - e21);
  out.close_vs_ema50 = e50 === null ? null : perAtr(price - e50);
  out.close_vs_vwap = vw === null ? null : perAtr(price - vw);
  const r = newest(ind.rsi);
  out.rsi_m50 = r === null ? null : r - 50;
  const pb = newest(ind.bb && ind.bb.percentB);
  out.bb_pctb_m05 = pb === null ? null : pb - 0.5;
  out.bar_range = perAtr(last.h - last.l);
  out.bar_body = perAtr(last.c - last.o);

  // --- room to the nearest level (the engine's clustered levels over its window)
  let above = null, below = null;
  for (const L of ind.levels || []) {
    if (L.price > price && (above === null || L.price < above)) above = L.price;
    if (L.price < price && (below === null || L.price > below)) below = L.price;
  }
  out.level_ahead = above === null ? null : perAtr(above - price);
  out.level_behind = below === null ? null : perAtr(price - below);
  out.level_ahead_none = above === null ? 1 : 0;
  out.level_behind_none = below === null ? 1 : 0;

  // The NEWEST bar's relative volume. The engine's volume bucket reads the last
  // bar that had a baseline (a known quirk, LEARNING-PLAN.md), which can be an
  // older bar; the feature does not inherit that.
  out.rel_volume = newest(ind.relVol);

  // --- when (the check's moment on the user's clock)
  const tz = cfg.window.tz;
  const h = localHour(nowMs, tz);
  for (const b of HOUR_BANDS) out[b.key] = h >= b.from && h < b.to ? 1 : 0;
  const dow = localWeekday(nowMs, tz);
  for (const d of WEEKDAYS) out[d.key] = dow === d.day ? 1 : 0;

  return out;
}

/* ---------------------------------------------------- for a given side */

const SIDE_WORDS = { buy: 1, long: 1, sell: -1, short: -1 };
const sideNum = (side) => (side === 1 || side === -1 ? side : SIDE_WORDS[side] ?? null);
const flip = (v, s) => (v === null || v === undefined ? null : v * s + 0);   // + 0 turns −0 into 0

/**
 * The features as seen by a trade on `side` (+1 long / −1 short, or the
 * words): directional ones multiplied by the side, the level pairs swapped
 * for a short, everything else unchanged. For a long it is a copy of `raw`.
 */
export function sideSigned(raw, side) {
  const s = sideNum(side);
  if (s === null) throw new Error(`side must be +1 or -1 (or buy/sell), not ${side}`);
  const out = { ...raw };
  if (s === 1) return out;
  for (const n of DIRECTIONAL) out[n] = flip(raw[n], s);
  for (const [x, y] of SWAPPED) { out[x] = raw[y]; out[y] = raw[x]; }
  return out;
}

/* -------------------------------------------------- the condition cell */

const confidenceLabel = (c) => (c === null ? null : c < 0.3 ? 'low' : c < 0.55 ? 'moderate' : 'firm');
const sgn = (v) => (v === null || v === undefined ? null : Math.sign(v) + 0);

/**
 * The coarse condition a check falls in, for the by-condition table: regime;
 * confidence in the engine's words (low < 0.3 ≤ moderate < 0.55 ≤ firm);
 * H1 and H4 bias and every directional bucket as a sign RELATIVE TO THE SIDE
 * (+1 points the trade's way, −1 against, 0 flat; market direction when no
 * side is given); whether H1 and H4 agree with each other; the hour band and
 * weekday on the user's clock (null outside them); and the side as 'buy' or
 * 'sell'. A bucket that abstained is null, not 0: "no data" is not "no lean".
 */
export function conditionOf(raw, { side = null } = {}) {
  const s = side === null ? null : sideNum(side);
  if (side !== null && s === null) throw new Error(`side must be +1 or -1 (or buy/sell), not ${side}`);
  const f = s === null ? raw : sideSigned(raw, s);
  const buckets = {};
  for (const name of DIRECTIONAL_BUCKETS) buckets[name] = sgn(f[`b_${name}`]);
  if (raw.volume_abstain === 1) buckets.volume = null;
  return {
    regime: REGIMES.find((r) => raw[`regime_${r}`] === 1) || null,
    confidenceLabel: confidenceLabel(raw.confidence),
    h1: sgn(f.h1_bias),
    h4: sgn(f.h4_bias),
    agree: raw.htf_agree === null || raw.htf_agree === undefined ? null : raw.htf_agree === 1,
    buckets,
    hourBand: (HOUR_BANDS.find((b) => raw[b.key] === 1) || {}).label || null,
    weekday: (WEEKDAYS.find((d) => raw[d.key] === 1) || {}).label || null,
    side: s === 1 ? 'buy' : s === -1 ? 'sell' : null,
  };
}
