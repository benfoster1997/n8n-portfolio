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
 *    by `nowMs`; a bar still forming is refused with an error rather than
 *    quietly read. The engine's window is always the tail of that history, so
 *    the two cannot end on different bars.
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
 * For the modules that store or learn from these numbers: a stored row is
 * only comparable with rows made by the same definitions. FEATURES_VERSION is
 * bumped whenever any definition here changes (a test hashes this file). But
 * the values also come from the engine (src/signal-engine.js: the buckets,
 * WEIGHTS and the regime; src/indicators.js; src/sessions.js;
 * src/timeframes.js), which can change a feature with no change here — the
 * volumeBucket fix moved b_volume, net and confidence without touching this
 * file. So whatever stores or fits these numbers must key them by BOTH
 * FEATURES_VERSION and the engine's source: reads.mjs's read store hashes the
 * source of every file a read imports (engineFiles) and of this module, and
 * learn.mjs's recipe carries FEATURES_VERSION and the engine hash
 * (methodFiles, engineHash). The heavy-tailed features (the ret_*, close_vs_*
 * and level_* distances in ATRs) are stored as measured: learn.mjs clips them
 * at each training fold's own 1st and 99th percentiles before standardising,
 * so a few release bars cannot own the ridge coefficients. The two ratios with
 * the longest tails are stored as logarithms here, which needs no fold to
 * decide.
 *
 * Pure: bars, the engine's analysis, the clock and the config are handed in.
 */
import { analyse, WEIGHTS, MIN_BARS } from '../src/signal-engine.js';
import { valueAt, resample } from '../src/indicators.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { tfInfo } from '../src/timeframes.js';
import { closedBars } from '../src/data-feeds.js';
import { sessionQuality, windowState, localHour, localWeekday } from '../src/sessions.js';

/**
 * The version of every definition in this file. Bump it (and re-pin the hash
 * in test/features.test.mjs) whenever a feature's meaning changes — a new
 * window, a new null rule, a new transform — so rows made before and after
 * are never pooled, and a model fitted on one is never fed the other.
 */
export const FEATURES_VERSION = 1;

/** Bars the engine reads, and bars of history behind it (desk/live.mjs ENGINE_BARS and FETCH_BARS). */
export const WINDOW_BARS = 300;
export const HISTORY_BARS = 1000;

/**
 * How many of the newest volatility values the ATR percentile ranks against:
 * ten days of M15, the most a 999-bar history fills. A fixed count, not "the
 * whole history", because the live feed's 1,000 bars usually include the bar
 * still forming, leaving 999 closed, while the replay and the dataset hold
 * 1,000; ranking over all of them made the same moment read differently live
 * and in the dataset. The values ranked are a plain 14-bar mean of the true
 * range over price, each from its own 14 bars: Wilder's ATR depends on where
 * its series starts, and one bar's difference in the start was still moving
 * the early values by 1% two hundred bars later.
 */
export const ATR_RANK_BARS = 960;

/**
 * The hour bands and weekdays are London's, whatever the user's window is set
 * to: the plan defines the conditions as London 08–10 … 14–16, and a model
 * trained on London bands must be fed London bands live.
 */
export const BANDS_TZ = 'Europe/London';

/** A zero-volume bar has relative volume 0, whose logarithm is −∞; it is floored here. */
const REL_VOLUME_FLOOR = 0.01;

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
 * test/features.test.mjs pins it. (Two names were changed once, to log_*, as
 * FEATURES_VERSION 1 was set and before any row was stored.)
 */
export const FEATURE_NAMES = Object.freeze([
  // The engine's own read, recomputed so it exists for every state.
  'net', 'confidence',
  'b_trend', 'b_momentum', 'b_structure', 'b_location', 'b_volume', 'volume_abstain',
  // Volatility: whether the conditions suit a scalp at all. Directionless.
  'b_volatility', 'log_atr_change_1h', 'bb_width_pctile', 'adx',
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
  'log_rel_volume',
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
const ATR_ZERO = 'or ATR is zero (a frozen feed), when no distance can be put in ATRs';
export const WHY_NULL = Object.freeze({
  log_atr_change_1h: 'needs a non-zero ATR now and an hour earlier, which the first bars of the window (or a frozen feed) do not have',
  bb_width_pctile: 'needs more than 20 Bollinger widths in the engine\'s lookback',
  adx: 'needs about 28 bars before ADX exists, and some movement: a frozen feed has none to measure',
  atr_pctile: 'needs at least 114 bars of history, for 100 fourteen-bar ranges to rank against',
  efficiency: 'needs 21 closes',
  h1_bias: 'needs 30 closed H1 bars behind the check',
  h4_bias: 'needs 30 closed H4 bars (480 M15 bars) behind the check',
  htf_agree: 'needs both higher-timeframe biases',
  ret_1: `needs 2 bars, ${ATR_ZERO}`, ret_4: `needs 5 bars, ${ATR_ZERO}`,
  ret_16: `needs 17 bars, ${ATR_ZERO}`, ret_96: `needs 97 bars, ${ATR_ZERO}`,
  close_vs_ema21: `needs 21 bars, ${ATR_ZERO}`, close_vs_ema50: `needs 50 bars, ${ATR_ZERO}`,
  close_vs_vwap: `needs a session VWAP, ${ATR_ZERO}`,
  rsi_m50: 'needs 15 bars', bb_pctb_m05: 'needs 20 bars, or a window so flat the bands have no width',
  bar_range: ATR_ZERO.replace(/^or /, ''), bar_body: ATR_ZERO.replace(/^or /, ''),
  level_ahead: `no clustered level above price in the window (level_ahead_none is then 1), ${ATR_ZERO}`,
  level_behind: `no clustered level below price in the window (level_behind_none is then 1), ${ATR_ZERO}`,
  log_rel_volume: 'the newest bar has fewer than two earlier same-slot bars to compare with, or the feed has no volume',
});

const NUM = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/* -------------------------------------------------------- the re-read */

/**
 * The history and window every function here reads: the last HISTORY_BARS of
 * `closed`, and the last WINDOW_BARS of those. Both functions cut the same way,
 * so a dataset may hand in all bars up to the check and get exactly what the
 * watcher's 1,000-bar fetch gives (and stay linear: nothing reads the rest).
 * `closed` is required. A missing history used to fall back to the window,
 * which ranked the ATR percentile over 300 bars instead of 1,000 without a word.
 */
function historyOf(args, who) {
  if (args.window !== undefined) {
    throw new Error(`${who} takes no window: it is always the last ${WINDOW_BARS} bars of \`closed\``);
  }
  const { closed } = args;
  if (!Array.isArray(closed) || !closed.length) {
    throw new Error(`${who} needs \`closed\`: the closed bars up to the check (it reads the last ${HISTORY_BARS})`);
  }
  const hist = closed.slice(-HISTORY_BARS);
  return { hist, win: hist.slice(-WINDOW_BARS) };
}

/**
 * analyse() on the watcher's inputs, with the two overrides that withhold a
 * read switched off: no news blackout, and a session whose band is never
 * 'dead' (bitcoin's live path already maps its dead band to 'red'; this does
 * the same for gold). Everything else is the watcher's: the same 300-bar
 * window, the same 1,000-bar history for the higher timeframes and relative
 * volume, the same final-stretch flag, the same spread.
 *
 * FEATURES ONLY, and the result says so: { state: 'features-only',
 * featuresOnly: true, price, atr, regime, htf, buckets, indicators }. The
 * bias, stop, targets, spread verdict and wording are dropped, because this is
 * what the engine saw at a moment the live desk may have sat out. Handing it to
 * toPlan(), outcome() or a formatter would name or score a lean the desk
 * withheld (rule 7; decisions 2 and 22), or give a blocked row a label (a).
 * With too few bars it is { state: 'insufficient-data', featuresOnly: true }.
 */
export function analysisForFeatures(args) {
  const { pair, cfg, nowMs, tf = null, spreadNum = null } = args;
  const t = tfInfo(tf ?? cfg.timeframe);
  const inst = INSTRUMENTS[pair];
  if (!inst) throw new Error(`unknown instrument ${pair}`);
  const { hist, win } = historyOf(args, 'analysisForFeatures');
  checkInputs(hist, nowMs, t);
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  let session = { ...sessionQuality(nowMs, pair, cfg.window), lastStretch };
  if (session.band === 'dead') session = { ...session, band: 'red' };
  const a = analyse({
    bars: win, htfBars: hist, instrument: inst,
    spread: spreadNum ?? inst.typicalSpread.observed,
    blackout: null, session, nowMs, timeframe: t.id,
  });
  if (a.state === 'insufficient-data') return { state: 'insufficient-data', featuresOnly: true, pair };
  const { price, atr: atrNow, regime, htf, buckets, indicators } = a;
  // `pair` rides along so featuresAt can refuse it for the other instrument.
  return { state: 'features-only', featuresOnly: true, pair, price, atr: atrNow, regime, htf, buckets, indicators };
}

/**
 * The look-ahead and sanity guard, over the history actually read. Bars must
 * rise strictly in time (a duplicated bar, the commonest merge bug in an
 * incremental cache, would set ret_1 to 0 and drag the ATR); the last one must
 * have closed by `nowMs`; and `nowMs` must be no more than two bars after that
 * close — liveRead's own 'stale' rule — or the hour band and weekday would
 * describe a moment the bars do not.
 */
function checkInputs(hist, nowMs, t) {
  if (!Number.isFinite(nowMs)) throw new Error('features need the moment of the check (nowMs)');
  for (let i = 1; i < hist.length; i++) {
    if (!(hist[i].t > hist[i - 1].t)) {
      throw new Error(`bars must rise strictly in time; the bar at ${new Date(hist[i].t).toISOString()} repeats or goes back`);
    }
  }
  const last = hist[hist.length - 1];
  const closeMs = last.t + t.minutes * 60000;
  if (closeMs > nowMs) {
    throw new Error(`the bar opened at ${new Date(last.t).toISOString()} had not closed by the check; pass closed bars only`);
  }
  if (nowMs - closeMs > 2 * t.minutes * 60000) {
    throw new Error(`the newest bar closed at ${new Date(closeMs).toISOString()}, more than two bars before the check: the history is stale for this moment`);
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

/* ------------------------------------------------------- provenance */

/** Closed bars higherTimeframeBias (src/signal-engine.js) needs before it scores a higher timeframe. */
const HTF_MIN_BARS = 30;

/**
 * Whether `analysis` was made on exactly this window and history, or a throw.
 * The last close alone matched a short `closed` (the last 300 bars, say)
 * paired with an analysis of the full history, which moved atr_pctile (0.930
 * against 0.844) and, under 150 bars, confidence; and an analysis of the
 * other instrument passed as well (review, 17 Oct 2026). So:
 *  - the price is the window's last close;
 *  - the engine's ATR series is as long as the window (it is computed over
 *    the bars analyse() was handed);
 *  - each higher timeframe has as many closed bars as resample() makes of
 *    this history (or, where the engine had too few to score it, this history
 *    makes fewer than it needs too);
 *  - a features-only analysis names its instrument, and it must be `pair`.
 */
function checkProvenance(analysis, { hist, win, price, t, pair }) {
  const not = (why) => new Error(`the analysis was not made on this window (${why})`);
  if (analysis.price !== price) throw not('its price differs from the last close');
  const atr = analysis.indicators && analysis.indicators.atr;
  if (!Array.isArray(atr) || atr.length !== win.length) throw not(`its ATR covers ${Array.isArray(atr) ? atr.length : 'no'} bars, the window ${win.length}`);
  for (const { id, minutes } of t.htf) {
    const got = analysis.htf ? analysis.htf[id.toLowerCase()] : null;
    const n = resample(hist, minutes, true, t.minutes).length;
    if (got ? got.closedBars !== n : n >= HTF_MIN_BARS) throw not(`its ${id} history has ${got ? got.closedBars : 'too few'} closed bars, this one ${n}`);
  }
  if (pair && analysis.pair && analysis.pair !== pair) throw not(`it is of ${analysis.pair}, not ${pair}`);
}

/* ------------------------------------------------------------ features */

const allNull = () => Object.fromEntries(FEATURE_NAMES.map((n) => [n, null]));

/**
 * The mean true range of each `period` bars over that bar's close, for every
 * bar with `period` true ranges behind it. Each mean is summed afresh from its
 * own bars, never as a running total, so a value depends on those bars alone
 * and is bit-for-bit the same whatever the history started on.
 */
function rangeOverPrice(bars, period) {
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  const out = [];
  for (let i = period - 1; i < tr.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tr[j];
    const c = bars[i + 1].c;
    if (c > 0) out.push(sum / period / c);
  }
  return out;
}

/**
 * The features of one check: { [name]: number | null }, keys in FEATURE_NAMES
 * order. `closed` is the closed bars up to and including the check's bar (the
 * last 1,000 are read; the engine's window is the last 300 of those),
 * `analysis` analyse()'s result on that window — from the live path or from
 * analysisForFeatures(), the two give the same features — and `nowMs` the
 * moment of the check (bar close + 20 s on the watcher). `pair` is accepted
 * so a caller can hand both functions the same arguments; no feature depends
 * on it, which is the point of being price-free: one learner can read both.
 * It is checked against a features-only analysis, which names its instrument.
 *
 * It refuses rather than guesses. No `closed`, no analysis (liveRead's
 * 'blocked' and 'no-data' results carry none: use analysisForFeatures), an
 * analysis without buckets, or one made on a different window or history
 * (checkProvenance: its price, its ATR's length, its higher timeframes' bar
 * counts, its instrument), all throw. The
 * all-null row is kept for one case only, an analysis whose state is
 * 'insufficient-data' on a window that really is too short: a missing input
 * must never look like a genuine "the engine could not read" row, or the
 * dataset would quietly impute every feature on it.
 */
export function featuresAt(args) {
  const { analysis, nowMs, cfg, tf = null } = args;
  const t = tfInfo(tf ?? cfg.timeframe);
  const { hist, win } = historyOf(args, 'featuresAt');
  checkInputs(hist, nowMs, t);
  if (!analysis || typeof analysis.state !== 'string') {
    throw new Error('featuresAt needs the engine\'s analysis of this window (a blocked or no-data live read has none: use analysisForFeatures)');
  }
  if (analysis.state === 'insufficient-data') {
    if (win.length >= MIN_BARS) throw new Error(`the analysis says too few bars, but the window holds ${win.length}: it was not made on this window`);
    return allNull();
  }
  const ind = analysis.indicators;
  if (!ind || !analysis.buckets || !analysis.regime) {
    throw new Error(`the analysis (state '${analysis.state}') carries no indicators, buckets or regime to describe`);
  }
  const out = allNull();

  const last = win[win.length - 1];
  const price = last.c;
  // The analysis must be of this window and this history, or every feature
  // below is of a different moment (review, 17 Oct 2026).
  checkProvenance(analysis, { hist, win, price, t, pair: args.pair ?? null });
  const a = NUM(analysis.atr);
  const perAtr = (x) => (a !== null && a > 0 && NUM(x) !== null ? x / a : null);

  // --- the engine's read
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  const { net, confidence } = engineScore(analysis, { windowLength: win.length, lastStretch });
  out.net = net;
  out.confidence = confidence;
  for (const name of DIRECTIONAL_BUCKETS) out[`b_${name}`] = NUM(analysis.buckets[name] && analysis.buckets[name].score);
  out.volume_abstain = analysis.buckets.volume && analysis.buckets.volume.noData ? 1 : 0;

  // --- volatility
  out.b_volatility = NUM(analysis.buckets.volatility && analysis.buckets.volatility.score);
  // As a logarithm: a release bar can multiply ATR several times in an hour,
  // and a plain ratio's right tail would own the coefficient.
  const aPrev = NUM(valueAt(ind.atr, t.barsPerHour));
  out.log_atr_change_1h = a !== null && a > 0 && aPrev !== null && aPrev > 0 ? Math.log(a / aPrev) : null;
  out.bb_width_pctile = NUM(analysis.regime.widthPercentile);
  out.adx = NUM(analysis.regime.adx);
  // A frozen feed's ATR is genuinely 0; only the divisions by it are undefined.
  out.atr_over_price = a !== null && price > 0 ? a / price : null;
  // Where today's volatility sits among the last ATR_RANK_BARS values of the
  // history (see ATR_RANK_BARS for why a plain mean): the share strictly below
  // the newest, as the engine's Bollinger-width percentile counts.
  const vol = rangeOverPrice(hist, 14).slice(-ATR_RANK_BARS);
  if (vol.length >= 100) {
    const now = vol[vol.length - 1];
    out.atr_pctile = vol.filter((v) => v < now).length / vol.length;
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

  // The NEWEST bar's relative volume, as a logarithm (a ratio around 1 whose
  // release bars run to 20–50×). The engine's volume bucket reads the last bar
  // that had a baseline (a known quirk, LEARNING-PLAN.md), which can be an
  // older bar; the feature does not inherit that.
  const rv = newest(ind.relVol);
  out.log_rel_volume = rv === null ? null : Math.log(Math.max(rv, REL_VOLUME_FLOOR));

  // --- when: London's clock, never cfg.window.tz (see BANDS_TZ)
  const h = localHour(nowMs, BANDS_TZ);
  for (const b of HOUR_BANDS) out[b.key] = h >= b.from && h < b.to ? 1 : 0;
  const dow = localWeekday(nowMs, BANDS_TZ);
  for (const d of WEEKDAYS) out[d.key] = dow === d.day ? 1 : 0;

  return out;
}

/**
 * The features of a check from the bars a feed returned, which may include
 * the bar still forming: closedBars() at `nowMs`, the last 1,000, then
 * featuresAt(). `analysis` is the live read's own when there is one (an idea);
 * without it (a blocked moment) the features-only re-read is made here. One
 * place for the live path to build features, so it can never hand in a bare
 * window or a different history from the dataset's.
 */
export function featuresFromBars({ bars, nowMs, cfg, pair, tf = null, analysis = null, spreadNum = null }) {
  const t = tfInfo(tf ?? cfg.timeframe);
  const closed = closedBars(bars || [], t.minutes, nowMs).slice(-HISTORY_BARS);
  const an = analysis ?? analysisForFeatures({ closed, pair, cfg, nowMs, tf: t.id, spreadNum });
  return featuresAt({ closed, analysis: an, nowMs, cfg, pair, tf: t.id });
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

const confidenceLabel = (c) => (c < 0.3 ? 'low' : c < 0.55 ? 'moderate' : 'firm');
const sgn = (v) => (v === null || v === undefined ? null : Math.sign(v) + 0);

/**
 * The coarse condition a check falls in, for the by-condition table
 * (desk/conditions.mjs reads exactly this, and nothing else builds it):
 *
 *   { regime, confidenceLabel, h1, h4, agree,
 *     buckets: { trend, momentum, structure, location, volume },
 *     hourBand, weekday, side }
 *
 *  - regime: one of REGIMES (detectRegime's names).
 *  - confidenceLabel: the engine's words, low < 0.3 ≤ moderate < 0.55 ≤ firm.
 *  - h1, h4: −1, 0 or +1 RELATIVE TO THE SIDE (+1 points the trade's way).
 *    A bias the history was too short to measure reads 0: the engine itself
 *    gives it no weight, and counts the pair as not agreeing.
 *  - agree: true or false, the engine's htf.agree (false when either is missing).
 *  - buckets: each directional bucket's sign relative to the side, or null
 *    when it abstained ("no data" is not "no lean"). Volatility is not here:
 *    it has no direction.
 *  - hourBand '08-10' | '10-12' | '12-14' | '14-16', weekday 'Mon'…'Fri', both
 *    on London's clock, null outside them.
 *  - side: 'buy' or 'sell'. Required: a cell is a trade's, and a sign "relative
 *    to the side" means nothing without one.
 *
 * A row the engine could not read (all null) has no cell, and throws.
 */
export function conditionOf(raw, { side } = {}) {
  const s = sideNum(side);
  if (s === null) throw new Error(`conditionOf needs the trade's side (buy/sell or +1/-1), not ${side}`);
  const regime = REGIMES.find((r) => raw[`regime_${r}`] === 1);
  if (!regime || NUM(raw.confidence) === null) {
    throw new Error('this row has no regime or confidence (the engine could not read the chart), so it has no condition');
  }
  const f = sideSigned(raw, s);
  const buckets = {};
  for (const name of DIRECTIONAL_BUCKETS) buckets[name] = sgn(f[`b_${name}`]);
  if (raw.volume_abstain === 1) buckets.volume = null;
  return {
    regime,
    confidenceLabel: confidenceLabel(raw.confidence),
    h1: sgn(f.h1_bias) ?? 0,
    h4: sgn(f.h4_bias) ?? 0,
    agree: raw.htf_agree === 1,
    buckets,
    hourBand: (HOUR_BANDS.find((b) => raw[b.key] === 1) || {}).label || null,
    weekday: (WEEKDAYS.find((d) => raw[d.key] === 1) || {}).label || null,
    side: s === 1 ? 'buy' : 'sell',
  };
}
