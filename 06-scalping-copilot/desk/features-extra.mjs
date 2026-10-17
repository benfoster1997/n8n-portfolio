/**
 * desk/features-extra.mjs — the read store's features hook: what the learner
 * is told about each window check, computed beside the watcher's own read.
 *
 * Why this exists. desk/reads.mjs computes the watcher's read at every check
 * once, in worker threads, and hands an optional extra(ctx) hook the bars up
 * to the check and nothing after. A worker can only be given that hook as a
 * module to import (a function cannot be sent to a thread), and the read store
 * keys its reads by that module's source, so a change to any feature
 * definition can never be answered from reads made under the old one. This is
 * that module. desk/dataset.mjs passes it as `extraModule`.
 *
 * For every check it returns { f, cond, atr, stopStd }:
 *   f        desk/features.mjs featuresAt(): every FEATURE_NAMES key, number
 *            or null. Null as a whole only when there are no bars to describe
 *            (gap, no-data, stale): the watcher sends nothing then either.
 *   cond     conditionOf(f) for the side the engine leaned, or null when it
 *            did not lean (none, blocked) or could not read the chart at all.
 *   atr      the engine's ATR at the check, in price units.
 *   stopStd  label (b)'s stop distance, the same for both sides: the larger of
 *            1.2 × ATR and the engine's noise-scaled minimum stop. That is the
 *            engine's own volatility stop (signal-engine.js: max(atr ×
 *            atrStopMultiple, minStop × noiseScale)), so the standard long and
 *            short are the trade the engine would have drawn with no swing
 *            level nearby, and never one narrower than its noise floor.
 *
 * Which analysis the features come from. The watcher's own whenever the
 * engine returned one with buckets, indicators and a regime: a lean, a neutral
 * read, and the 'none' rows that end in stand-aside, stand-down or no-read
 * (signal-engine.js returns all three with them). The features are then of
 * exactly what the watcher saw. A blocked row never reached the engine, and an
 * 'insufficient-data' read carries nothing to describe; only those are re-read
 * by analysisForFeatures() with the blackout and dead zone off. In practice
 * that is the blocked rows. The re-read is a description only: it never gives
 * a blocked row a lean, a label (a) or an alert (features.mjs; LEARNING-PLAN.md
 * rule 7).
 *
 * What it is not. It decides nothing and sees no bar after the check (the
 * hook is handed the frozen slice ending there). Pure and side-effect free on
 * import, as a worker needs.
 */
import { featuresAt, analysisForFeatures, conditionOf } from './features.mjs';
import { minStop, INSTRUMENTS } from '../src/instruments.js';
import { tfInfo } from '../src/timeframes.js';

/** The engine's volatility stop multiple (signal-engine.js analyse's atrStopMultiple default). */
export const STOP_ATR_MULTIPLE = 1.2;

/** An engine read featuresAt can describe: every state but 'insufficient-data' carries buckets, indicators and a regime. */
const describable = (a) => !!a && a.state !== 'insufficient-data' && !!a.buckets && !!a.indicators && !!a.regime;

/**
 * The noise-scaled minimum stop at this price on this timeframe: minStop (the
 * instrument's minStopPct of price, M5-sized) times the timeframe's noiseScale
 * (√3 on M15), exactly as analyse() floors its stops.
 */
export function noiseStop(pair, price, tf) {
  const inst = INSTRUMENTS[pair];
  if (!inst) throw new Error(`unknown instrument ${pair}`);
  return minStop(inst, price) * tfInfo(tf).noiseScale;
}

/**
 * label (b)'s stop: max(1.2 × ATR, the noise-scaled minimum). An ATR of 0 (a
 * frozen feed) gives the noise floor, as max() does; null only when there is
 * no ATR or price to measure from (not finite, or negative).
 */
export function standardStop(pair, price, atr, tf) {
  if (!(Number.isFinite(atr) && atr >= 0) || !(price > 0)) return null;
  return Math.max(STOP_ATR_MULTIPLE * atr, noiseStop(pair, price, tf));
}

/** The side the engine leaned at this check ('buy' | 'sell'), or null. */
function leanOf(ctx) {
  if (ctx.kind !== 'lean' || !ctx.analysis) return null;
  return ctx.analysis.bias === 'long' ? 'buy' : ctx.analysis.bias === 'short' ? 'sell' : null;
}

/** reads.mjs's hook. ctx = { pair, tf, cfg, nowMs, spreadNum, kind, closed, window, analysis, read }. */
export function extra(ctx) {
  const { pair, tf, cfg, nowMs, spreadNum, kind, closed } = ctx;
  if (kind === 'gap' || kind === 'no-data' || kind === 'stale' || !closed || !closed.length) {
    return { f: null, cond: null, atr: null, stopStd: null };
  }
  const analysis = describable(ctx.analysis)
    ? ctx.analysis
    : analysisForFeatures({ closed, pair, cfg, nowMs, tf, spreadNum });
  const f = featuresAt({ closed, analysis, nowMs, cfg, pair, tf });
  const side = leanOf(ctx);
  // A row the engine could not read at all (every feature null) has no cell;
  // conditionOf would throw on it, and a lean cannot come from such a row anyway.
  const cond = side && f.confidence !== null ? conditionOf(f, { side }) : null;
  const atr = Number.isFinite(analysis.atr) ? analysis.atr : null;
  const price = closed[closed.length - 1].c;
  return { f, cond, atr, stopStd: standardStop(pair, price, atr, tf) };
}
