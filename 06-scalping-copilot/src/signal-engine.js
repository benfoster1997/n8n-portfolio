/**
 * signal-engine.js — turning indicator readings into an honest observation.
 *
 * ===========================================================================
 * WHAT THIS ENGINE CANNOT SEE
 * ===========================================================================
 * Read this before you read anything it outputs.
 *
 *  - ORDER FLOW. It sees bars, not the book. It has no idea where the resting
 *    orders are, who is buying, or how much size is behind a move.
 *  - REAL VOLUME. An MT5 gold feed reports TICK volume — the number of price
 *    updates, not contracts traded. Every volume-derived reading here is a
 *    proxy for activity, not a measure of participation.
 *  - YOUR BROKER'S PRICE. It reads a reference feed. Your fill, your spread
 *    and your slippage are your broker's, and they diverge most at exactly the
 *    moments this tool finds interesting.
 *  - CORRELATED MARKETS. It does not watch DXY, real yields, the Nasdaq, or
 *    bitcoin's funding. Gold can be technically perfect and get run over by a
 *    move in the dollar.
 *  - POSITIONING. No COT, no open interest, no options gamma.
 *  - THE NEWS ITSELF. It knows WHEN scheduled releases happen. It cannot read
 *    the number, and it has no idea an unscheduled headline just landed.
 *  - WHETHER IT IS RIGHT. It has no memory of its own past readings and no
 *    track record. Nothing here has been backtested. The weights below are
 *    reasoned, not fitted, which makes them honest rather than optimal.
 *
 * The engine therefore describes what the chart is doing. It does not predict
 * and it does not instruct. Phrasing is deliberate: "price is above the M15
 * VWAP with range expanding", never "BUY NOW".
 * ===========================================================================
 */

import {
  ema, rsi, atr, macd, bollingerBands, adx, supertrend, stochastic,
  sessionVwap, swingPivots, clusterLevels, marketStructure, findFVGs,
  detectLiquiditySweep, relativeVolume, resample, closes, lastOf, valueAt,
} from './indicators.js';
import { breakEvenWinRate, rMultiple } from './risk.js';
import { minStop } from './instruments.js';

/** Bars of M5 history below which the engine simply declines to read. */
export const MIN_BARS = 60;

/* ------------------------------------------------------------- regime */

/**
 * Kaufman efficiency ratio: net movement divided by total movement.
 * 1.0 is a straight line; near 0 is churn covering no ground. It is the single
 * most useful regime statistic on a five-minute chart because it directly
 * measures the thing that decides whether trend-following can work.
 */
export function efficiencyRatio(values, period = 20) {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let total = 0;
  for (let i = 1; i < slice.length; i++) total += Math.abs(slice[i] - slice[i - 1]);
  return total === 0 ? 0 : net / total;
}

/**
 * Trending / ranging / compressed.
 *
 * This gate runs FIRST and changes everything downstream. In a range, trend
 * signals are not merely less useful — they are actively harmful, because a
 * range manufactures convincing-looking breakouts that fail. So rather than
 * quietly down-weighting them, the engine says out loud that it is discarding
 * them.
 */
export function detectRegime(bars, ind) {
  const cs = closes(bars);
  const er = efficiencyRatio(cs, 20);
  const adxVal = lastOf(ind.adx.adx);
  const bbw = lastOf(ind.bb.width);

  // Where does current Bollinger width sit within its own recent history?
  const widthHist = ind.bb.width.filter((x) => x !== null).slice(-96);
  let widthPct = null;
  if (widthHist.length > 20 && bbw !== null) {
    widthPct = widthHist.filter((w) => w < bbw).length / widthHist.length;
  }

  const notes = [];
  let regime = 'ranging';

  // Bottom fifth of the recent distribution. Bollinger's own "Squeeze" is
  // stricter (a multi-month low), but on M5 that would fire a handful of times
  // a year and be useless. A fifth is the common intraday convention and is
  // what a scalper can act on: quieter than four-fifths of the last eight hours.
  if (widthPct !== null && widthPct < 0.20) {
    regime = 'compressed';
    notes.push(`Bollinger width is in the bottom ${Math.round(widthPct * 100)}% of its recent range — coiled`);
  } else if (adxVal !== null && adxVal > 23 && er !== null && er > 0.35) {
    regime = 'trending';
    notes.push(`ADX ${adxVal.toFixed(0)} with efficiency ${er.toFixed(2)} — price is covering ground`);
  } else if (adxVal !== null && adxVal < 20 && er !== null && er < 0.25) {
    regime = 'ranging';
    notes.push(`ADX ${adxVal.toFixed(0)} with efficiency ${er.toFixed(2)} — churning, not travelling`);
  } else {
    regime = 'mixed';
    notes.push('neither clearly trending nor clearly ranging — the least tradeable state');
  }

  return { regime, efficiency: er, adx: adxVal, bbWidth: bbw, widthPercentile: widthPct, notes };
}

/** Weights per regime. They sum to 1 and are reasoned, not fitted. */
const WEIGHTS = {
  trending:   { trend: 0.30, momentum: 0.18, structure: 0.20, location: 0.10, volatility: 0.10, volume: 0.12 },
  ranging:    { trend: 0.04, momentum: 0.14, structure: 0.20, location: 0.36, volatility: 0.10, volume: 0.16 },
  compressed: { trend: 0.06, momentum: 0.10, structure: 0.16, location: 0.20, volatility: 0.34, volume: 0.14 },
  mixed:      { trend: 0.16, momentum: 0.16, structure: 0.20, location: 0.22, volatility: 0.12, volume: 0.14 },
};

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/* ------------------------------------------------------------ buckets */

/**
 * Each bucket returns a score in [-1, +1] and its reasoning.
 *
 * The bucket structure is the point. EMA slope, MACD and ADX all measure
 * roughly the same underlying thing; a flat weighted sum over individual
 * indicators would let one observation vote three times and manufacture
 * confidence that is not there. Inside a bucket, indicators average. Only the
 * bucket gets a weight.
 */
function trendBucket(bars, ind) {
  const reasons = [];
  const parts = [];
  const price = bars[bars.length - 1].c;

  const e9 = lastOf(ind.ema9), e21 = lastOf(ind.ema21), e50 = lastOf(ind.ema50);
  if (e9 !== null && e21 !== null && e50 !== null) {
    if (e9 > e21 && e21 > e50) { parts.push(1); reasons.push('EMAs stacked 9 > 21 > 50'); }
    else if (e9 < e21 && e21 < e50) { parts.push(-1); reasons.push('EMAs stacked 9 < 21 < 50'); }
    else { parts.push(0); reasons.push('EMAs tangled — no clean stack'); }
  }

  // Slope of the 21 EMA over 5 bars, normalised by ATR so it is comparable
  // across instruments.
  const e21Prev = valueAt(ind.ema21, 5);
  const a = lastOf(ind.atr);
  if (e21 !== null && e21Prev !== null && a) {
    const slope = (e21 - e21Prev) / a;
    parts.push(clamp(slope * 2));
    if (Math.abs(slope) > 0.15) reasons.push(`21 EMA sloping ${slope > 0 ? 'up' : 'down'} at ${Math.abs(slope).toFixed(2)} ATR / 5 bars`);
  }

  const stDir = lastOf(ind.supertrend.direction);
  if (stDir !== null) { parts.push(stDir); reasons.push(`Supertrend ${stDir > 0 ? 'long' : 'short'}`); }

  // DMI is deliberately ABSENT from the directional score.
  //
  // Under close-only true range, (+DI - -DI) is algebraically identical to
  // 2*RSI - 100 — not merely correlated, the same quantity. Scoring DMI here
  // and RSI in the momentum bucket would be the exact double-count the bucket
  // structure exists to prevent, smuggled across two buckets instead of within
  // one. RSI keeps the seat because it is the more directly interpretable of
  // the two. ADX itself is a MAGNITUDE measure (it correlates ~0.86 with
  // |MACD| and ~0.02 with signed MACD), so it lives in regime detection where
  // it belongs, and never votes on direction.
  const pdi = lastOf(ind.adx.plusDI), mdi = lastOf(ind.adx.minusDI);
  if (pdi !== null && mdi !== null) {
    reasons.push(`DMI reads ${pdi > mdi ? 'up' : 'down'} (${pdi.toFixed(0)} vs ${mdi.toFixed(0)}) — shown, not scored, because it duplicates RSI`);
  }

  if (e50 !== null) reasons.push(`price ${price > e50 ? 'above' : 'below'} the 50 EMA`);
  return { score: parts.length ? clamp(parts.reduce((s, x) => s + x, 0) / parts.length) : 0, reasons };
}

function momentumBucket(bars, ind) {
  const reasons = [];
  const parts = [];

  const r = lastOf(ind.rsi);
  if (r !== null) {
    parts.push(clamp((r - 50) / 25));
    if (r > 70) reasons.push(`RSI ${r.toFixed(0)} — stretched up`);
    else if (r < 30) reasons.push(`RSI ${r.toFixed(0)} — stretched down`);
    else reasons.push(`RSI ${r.toFixed(0)}`);
  }

  const h = lastOf(ind.macd.histogram), hPrev = valueAt(ind.macd.histogram, 1);
  const a = lastOf(ind.atr);
  if (h !== null && a) {
    parts.push(clamp((h / a) * 3));
    if (hPrev !== null) {
      const growing = Math.abs(h) > Math.abs(hPrev);
      reasons.push(`MACD histogram ${h > 0 ? 'positive' : 'negative'} and ${growing ? 'expanding' : 'contracting'}`);
    }
  }

  const k = lastOf(ind.stoch.k);
  if (k !== null) {
    parts.push(clamp((k - 50) / 35));
    if (k > 80) reasons.push(`Stochastic ${k.toFixed(0)} — overbought`);
    else if (k < 20) reasons.push(`Stochastic ${k.toFixed(0)} — oversold`);
  }

  return { score: parts.length ? clamp(parts.reduce((s, x) => s + x, 0) / parts.length) : 0, reasons };
}

function structureBucket(bars, ind) {
  const reasons = [];
  const parts = [];

  const ms = ind.structure;
  if (ms.trend === 'up') { parts.push(0.8); reasons.push('structure making higher highs and higher lows'); }
  else if (ms.trend === 'down') { parts.push(-0.8); reasons.push('structure making lower highs and lower lows'); }
  else reasons.push('structure unclear — not enough confirmed swings');

  const recentChoch = ms.events.filter((e) => e.type === 'CHoCH').slice(-1)[0];
  if (recentChoch && bars.length - recentChoch.index < 20) {
    parts.push(recentChoch.dir === 'up' ? 0.9 : -0.9);
    reasons.push(`CHoCH ${recentChoch.dir} ${bars.length - 1 - recentChoch.index} bars ago — the first structural turn`);
  }

  for (const s of ind.sweeps) {
    if (s.barsAgo <= 3) {
      // A sweep is a reversal hint AGAINST the direction it swept.
      parts.push(s.type === 'buy-side-sweep' ? 0.7 : -0.7);
      reasons.push(`${s.type === 'buy-side-sweep' ? 'lows' : 'highs'} swept at ${s.level.toFixed(2)} then reclaimed, ${s.barsAgo} bars ago`);
    }
  }

  const openGaps = ind.fvgs.filter((g) => !g.filled);
  if (openGaps.length) {
    const g = openGaps[openGaps.length - 1];
    reasons.push(`unfilled ${g.type} gap ${g.from.toFixed(2)}-${g.to.toFixed(2)} overhead`);
  }

  return { score: parts.length ? clamp(parts.reduce((s, x) => s + x, 0) / parts.length) : 0, reasons };
}

function locationBucket(bars, ind) {
  const reasons = [];
  const parts = [];
  const price = bars[bars.length - 1].c;
  const a = lastOf(ind.atr);

  const vw = lastOf(ind.vwap.vwap);
  if (vw !== null && a) {
    const dist = (price - vw) / a;
    // Deliberately MEAN-REVERTING: being far above VWAP is a reason to be
    // cautious about buying, not a reason to chase.
    parts.push(clamp(-dist / 2));
    reasons.push(`${Math.abs(dist).toFixed(1)} ATR ${dist > 0 ? 'above' : 'below'} session VWAP`);
  }

  const pb = lastOf(ind.bb.percentB);
  if (pb !== null) {
    parts.push(clamp(-(pb - 0.5) * 2));
    if (pb > 1) reasons.push('trading outside the upper Bollinger band');
    else if (pb < 0) reasons.push('trading outside the lower Bollinger band');
    else reasons.push(`sitting ${(pb * 100).toFixed(0)}% up the Bollinger range`);
  }

  // Proximity to a clustered level, which cuts both ways: near resistance is
  // a reason not to buy, near support a reason not to sell.
  if (ind.levels.length && a) {
    let nearest = null, best = Infinity;
    for (const L of ind.levels) {
      const d = Math.abs(L.price - price);
      if (d < best) { best = d; nearest = L; }
    }
    if (nearest && best < a * 0.75) {
      const above = nearest.price > price;
      parts.push(above ? -0.5 : 0.5);
      reasons.push(`${(best / a).toFixed(1)} ATR ${above ? 'below' : 'above'} a ${nearest.touches}-touch level at ${nearest.price.toFixed(2)}`);
    }
  }

  return { score: parts.length ? clamp(parts.reduce((s, x) => s + x, 0) / parts.length) : 0, reasons };
}

/**
 * Volatility is DIRECTIONLESS. It scores whether conditions suit a scalp at
 * all, not which way to go, so it returns a magnitude that modulates
 * confidence rather than a signed direction.
 */
function volatilityBucket(bars, ind, inst) {
  const reasons = [];
  const a = lastOf(ind.atr);
  const aPrev = valueAt(ind.atr, 12);
  let quality = 0;

  if (a && aPrev) {
    const ratio = a / aPrev;
    if (ratio > 1.25) { quality += 0.6; reasons.push(`range expanding — ATR up ${((ratio - 1) * 100).toFixed(0)}% over the last hour`); }
    else if (ratio < 0.75) { quality -= 0.4; reasons.push(`range contracting — ATR down ${((1 - ratio) * 100).toFixed(0)}% over the last hour`); }
    else reasons.push('range steady');
  }

  if (a) {
    reasons.push(`M5 ATR ${a.toFixed(inst.decimalsForDisplay)}`);
    if (a < minStop(inst, bars[bars.length - 1].c) * 0.6) {
      quality -= 0.8;
      reasons.push('ATR is small relative to the spread — thin conditions, costs dominate');
    }
  }
  return { score: clamp(quality), reasons, directionless: true };
}

function volumeBucket(bars, ind) {
  const reasons = [];
  const rv = lastOf(ind.relVol);
  // No data is NOT the same as no direction. Relative volume needs several
  // days of history to compare like-for-like time slots; until it has them
  // this bucket abstains, and abstaining must not quietly redistribute its
  // weight onto the others.
  if (rv === null) {
    return {
      score: 0,
      reasons: ['relative volume needs a few days of history for this time of day — abstaining'],
      noData: true,
    };
  }
  const last = bars[bars.length - 1];
  const bullish = last.c > last.o;
  let s = 0;
  if (rv > 1.6) { s = bullish ? 0.7 : -0.7; reasons.push(`volume ${rv.toFixed(1)}x normal for this time of day, on a ${bullish ? 'up' : 'down'} bar`); }
  else if (rv < 0.6) { s = 0; reasons.push(`volume ${rv.toFixed(1)}x normal — quiet for the time of day`); }
  else reasons.push(`volume ${rv.toFixed(1)}x normal`);
  return { score: clamp(s), reasons };
}

/* ------------------------------------------------- higher-timeframe bias */

/**
 * Bias from M15 and H1, using only CLOSED bars. `resample` drops the forming
 * bar, so a half-built H1 candle can never leak into the read.
 */
function higherTimeframeBias(bars) {
  const out = { m15: null, h1: null, agree: false, notes: [] };

  for (const [key, mins, need] of [['m15', 15, 30], ['h1', 60, 30]]) {
    const htf = resample(bars, mins, true);
    if (htf.length < need) { out.notes.push(`not enough closed ${key.toUpperCase()} bars yet`); continue; }
    const cs = closes(htf);
    const e21 = lastOf(ema(cs, 21));
    const price = cs[cs.length - 1];
    const st = supertrend(htf, 10, 3);
    const dir = lastOf(st.direction);
    let score = 0;
    if (e21 !== null) score += price > e21 ? 1 : -1;
    if (dir !== null) score += dir;
    out[key] = { bias: score > 0 ? 'up' : score < 0 ? 'down' : 'flat', score, closedBars: htf.length };
    out.notes.push(`${key.toUpperCase()} ${out[key].bias} (last closed bar only)`);
  }

  if (out.m15 && out.h1) out.agree = out.m15.bias === out.h1.bias && out.m15.bias !== 'flat';
  return out;
}

/* ------------------------------------------------------------- the read */

/**
 * The main entry point.
 *
 * Returns an observation, never an instruction. Guarantees, enforced below:
 *   - a directional read always carries an invalidation price;
 *   - a tier-1 news blackout overrides everything;
 *   - a target that does not clear the spread by `minSpreadMultiple` is
 *     rejected with the arithmetic shown;
 *   - `whyNot` is never empty for a directional read — the engine always
 *     argues the other side.
 */
export function analyse({
  bars,
  instrument,
  spread = null,
  blackout = null,
  nowMs = null,
  minSpreadMultiple = 3,
  atrStopMultiple = 1.2,
}) {
  const inst = instrument;
  const dp = inst.decimalsForDisplay;
  const fmt = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(dp));

  if (!bars || bars.length < MIN_BARS) {
    return {
      ok: false,
      state: 'insufficient-data',
      headline: 'Not enough history to read the chart',
      detail: `Need at least ${MIN_BARS} five-minute bars, have ${bars ? bars.length : 0}.`,
      bias: 'none', confidence: 0, invalidation: null, whyNot: [], reasons: [],
    };
  }

  const price = bars[bars.length - 1].c;
  const cs = closes(bars);
  const effSpread = spread !== null && spread > 0 ? spread : null;

  const ind = {
    ema9: ema(cs, 9), ema21: ema(cs, 21), ema50: ema(cs, 50),
    rsi: rsi(cs, 14), atr: atr(bars, 14), macd: macd(cs, 12, 26, 9),
    bb: bollingerBands(cs, 20, 2), adx: adx(bars, 14),
    supertrend: supertrend(bars, 10, 3), stoch: stochastic(bars, 14, 3, 3),
    vwap: sessionVwap(bars, inst.vwapReset ?? 0, [1, 2]),
    relVol: relativeVolume(bars, 5),
    structure: marketStructure(bars, 3),
    pivots: swingPivots(bars, 3),
  };
  const atrNow = lastOf(ind.atr);
  ind.levels = clusterLevels(bars, atrNow, { lookback: 3, toleranceAtr: 0.5, maxLevels: 8 });
  ind.fvgs = findFVGs(bars, atrNow, { minAtr: 0.25 });
  ind.sweeps = detectLiquiditySweep(bars, { lookback: 3, withinBars: 6, atrValue: atrNow });

  const regime = detectRegime(bars, ind);
  const htf = higherTimeframeBias(bars);

  const buckets = {
    trend: trendBucket(bars, ind),
    momentum: momentumBucket(bars, ind),
    structure: structureBucket(bars, ind),
    location: locationBucket(bars, ind),
    volatility: volatilityBucket(bars, ind, inst),
    volume: volumeBucket(bars, ind),
  };

  const w = WEIGHTS[regime.regime];

  // Three kinds of bucket, kept strictly apart:
  //   directionless — volatility, which describes conditions, not direction;
  //   abstaining    — has no data this bar, so it votes on nothing;
  //   contributing  — everything else.
  // Abstaining buckets are removed from the numerator AND the denominator, so
  // a missing input never inflates the remaining ones. The lost information is
  // charged to confidence instead, which is where it belongs.
  const contributing = Object.entries(buckets).filter(([, b]) => !b.directionless && !b.noData);
  const abstaining = Object.entries(buckets).filter(([, b]) => !b.directionless && b.noData);

  let net = 0;
  for (const [name, b] of contributing) net += b.score * w[name];
  const liveWeight = contributing.reduce((s, [n]) => s + w[n], 0);
  const abstainedWeight = abstaining.reduce((s, [n]) => s + w[n], 0);
  net = liveWeight > 0 ? net / liveWeight : 0;

  // --- confidence -------------------------------------------------------
  // Low by default. It rises only when independent buckets agree, and is
  // capped hard when conditions or data do not support a read.
  const directional = contributing;
  const agreeing = directional.filter(([, b]) => Math.sign(b.score) === Math.sign(net) && Math.abs(b.score) > 0.2).length;
  let confidence = directional.length
    ? Math.min(0.95, Math.abs(net) * 0.55 + (agreeing / directional.length) * 0.35)
    : 0;

  // Every abstaining bucket is information the engine does not have.
  if (abstainedWeight > 0) confidence *= (1 - abstainedWeight);

  if (regime.regime === 'mixed') confidence *= 0.55;
  if (regime.regime === 'compressed') confidence *= 0.6;
  if (buckets.volatility.score < 0) confidence *= 0.7;
  if (!htf.agree) confidence *= 0.8;
  if (bars.length < 150) confidence *= 0.85;
  confidence = Math.max(0, Math.min(0.95, confidence));

  const bias = Math.abs(net) < 0.12 ? 'neutral' : net > 0 ? 'long' : 'short';

  // --- invalidation: mandatory -----------------------------------------
  // Prefer a structural level (the swing the read would be wrong beneath).
  // Fall back to ATR. If neither can be produced, the engine refuses.
  let invalidation = null, invalidationBasis = null;
  if (bias !== 'neutral' && atrNow) {
    const piv = bias === 'long' ? ind.pivots.lows : ind.pivots.highs;
    const recent = piv.filter((p) => (bias === 'long' ? p.price < price : p.price > price)).slice(-3);
    if (recent.length) {
      const chosen = bias === 'long'
        ? Math.max(...recent.map((p) => p.price))
        : Math.min(...recent.map((p) => p.price));
      const pad = atrNow * 0.25;
      const candidate = bias === 'long' ? chosen - pad : chosen + pad;
      if (Math.abs(price - candidate) >= minStop(inst, price) * 0.5) {
        invalidation = candidate;
        invalidationBasis = `beyond the last confirmed swing ${bias === 'long' ? 'low' : 'high'} at ${fmt(chosen)}, plus a quarter-ATR of room`;
      }
    }
    if (invalidation === null) {
      const d = Math.max(atrNow * atrStopMultiple, minStop(inst, price));
      invalidation = bias === 'long' ? price - d : price + d;
      invalidationBasis = `${atrStopMultiple} x M5 ATR — no usable swing level nearby, so this is a volatility stop, not a structural one`;
    }
  }

  const stopDistance = invalidation !== null ? Math.abs(price - invalidation) : null;

  // --- targets and the spread gate -------------------------------------
  const targets = [];
  let spreadVerdict = null;
  if (bias !== 'neutral' && stopDistance) {
    const nextLevels = ind.levels
      .filter((L) => (bias === 'long' ? L.price > price : L.price < price))
      .sort((a, b) => (bias === 'long' ? a.price - b.price : b.price - a.price));

    if (nextLevels.length) {
      targets.push({
        price: nextLevels[0].price,
        basis: `next clustered level (${nextLevels[0].touches} touches)`,
        r: rMultiple(price, invalidation, nextLevels[0].price, effSpread || 0),
      });
    }
    const oneR = bias === 'long' ? price + stopDistance : price - stopDistance;
    // Only add the 1R target if it is meaningfully different from the level
    // target already listed. Two rows a few cents apart, both reading 1R, is
    // noise dressed up as confluence.
    const dupe = targets.some((t) => Math.abs(t.price - oneR) < (atrNow || stopDistance) * 0.25);
    if (!dupe) {
      targets.push({ price: oneR, basis: '1R from the invalidation level', r: rMultiple(price, invalidation, oneR, effSpread || 0) });
    }

    if (effSpread !== null) {
      const first = targets[0];
      const reach = Math.abs(first.price - price);
      const targetOk = reach >= effSpread * minSpreadMultiple;

      // The STOP-to-spread ratio matters at least as much as the target one.
      // Below 5x, the spread costs more than ten points of win rate at 1:1 and
      // the setup is arithmetically unsound however good the pattern looks.
      // Between 5x and 10x it is workable but expensive.
      const stopMult = stopDistance / effSpread;
      const stopOk = stopMult >= 5;
      spreadVerdict = {
        ok: targetOk && stopOk,
        targetOk,
        stopOk,
        stopMultiple: +stopMult.toFixed(1),
        spread: effSpread,
        firstTargetDistance: reach,
        multiple: +(reach / effSpread).toFixed(1),
        required: minSpreadMultiple,
        text: !stopOk
          ? `the stop is only ${stopMult.toFixed(1)}x the spread — below 5x the cost structure is unsound whatever the chart looks like`
          : targetOk
            ? `first target is ${(reach / effSpread).toFixed(1)}x the spread away, stop is ${stopMult.toFixed(1)}x`
            : `first target is only ${(reach / effSpread).toFixed(1)}x the spread away — below the ${minSpreadMultiple}x floor, the cost eats the move`,
        warn: stopOk && stopMult < 10
          ? `A stop ${stopMult.toFixed(1)}x the spread is workable but expensive; 10x is the comfortable floor.`
          : null,
      };
    }
  }

  const be = (bias !== 'neutral' && stopDistance && targets.length)
    ? breakEvenWinRate(Math.abs(targets[0].price - price), stopDistance, effSpread || 0)
    : null;

  // --- the case against -------------------------------------------------
  const whyNot = [];
  if (regime.regime === 'ranging' && Math.abs(buckets.trend.score) > 0.4) {
    whyNot.push('Trend readings are being discarded: in a range they generate breakouts that fail. This read rests on location, not direction.');
  }
  if (regime.regime === 'mixed') whyNot.push('Neither trending nor ranging cleanly — historically the least tradeable state, and the one where a confluence score is least meaningful.');
  if (regime.regime === 'compressed') whyNot.push('Volatility is compressed. The break can come either way, and compression alone says nothing about which.');
  if (!htf.agree) whyNot.push(`M15 and H1 do not agree (${htf.notes.join('; ')}) — a scalp against the higher timeframe needs to be quicker and smaller.`);
  for (const [name, b] of directional) {
    if (Math.sign(b.score) !== Math.sign(net) && Math.abs(b.score) > 0.3) {
      whyNot.push(`${name} argues the other way: ${b.reasons[0] || 'opposed'}.`);
    }
  }
  if (buckets.volatility.score < 0) whyNot.push(buckets.volatility.reasons.join('; ') + '.');
  if (spreadVerdict && !spreadVerdict.ok) whyNot.push(spreadVerdict.text + '.');
  if (spreadVerdict && spreadVerdict.warn) whyNot.push(spreadVerdict.warn);
  if (be && be.impossible) whyNot.push(`The target does not clear the spread at all — ${be.reason}.`);
  if (be && !be.impossible && be.rate > 55) whyNot.push(`This shape needs a ${be.rate}% win rate just to break even after the spread.`);
  for (const [name, b] of abstaining) {
    whyNot.push(`No ${name} input this bar: ${b.reasons[0]}. The read is being made on less than the full picture.`);
  }
  if (confidence < 0.35) whyNot.push('Bucket agreement is weak. Treat this as an observation about the chart, not a setup.');
  if (bias !== 'neutral' && whyNot.length === 0) {
    whyNot.push('Nothing in the visible data argues against this read — which usually means the engine is missing something it cannot see, not that the trade is safe.');
  }

  // --- news blackout: a hard override, not a factor ---------------------
  if (blackout && blackout.active) {
    return {
      ok: true,
      state: 'stand-aside',
      headline: `Stand aside — ${blackout.event.name}`,
      detail: blackout.phase === 'before'
        ? `${blackout.event.name} is released in ${blackout.minutesAway} minutes. Spreads widen and stops get skipped through before the number lands, not after.`
        : `${blackout.event.name} was released ${blackout.minutesSince} minutes ago. The spread has not normalised yet.`,
      bias: 'none',
      technicalBiasSuppressed: bias,
      confidence: 0,
      blackout,
      regime, htf, buckets, indicators: ind, price, atr: atrNow,
      invalidation: null,
      whyNot: ['A scheduled release overrides the technical read entirely. The chart cannot see the number.'],
      reasons: [`Technicals read ${bias} before the override, at ${(confidence * 100).toFixed(0)}% confidence. That is shown so you know what you are setting aside, not as a reason to trade it.`],
    };
  }

  // --- refuse rather than emit a read with no invalidation ---------------
  if (bias !== 'neutral' && invalidation === null) {
    return {
      ok: true,
      state: 'no-read',
      headline: 'No usable invalidation level',
      detail: 'The technicals lean one way but no defensible level to be wrong at could be found. A scalp without an invalidation price is a guess with a position on it.',
      bias: 'neutral', confidence: 0, invalidation: null,
      regime, htf, buckets, indicators: ind, price, atr: atrNow,
      whyNot: ['No structural or volatility-based stop could be derived from the visible bars.'],
      reasons: [],
    };
  }

  const reasons = [];
  const order = regime.regime === 'ranging'
    ? ['location', 'structure', 'momentum', 'volume', 'volatility', 'trend']
    : ['trend', 'structure', 'momentum', 'location', 'volume', 'volatility'];
  for (const name of order) {
    for (const r of buckets[name].reasons) reasons.push({ bucket: name, text: r });
  }

  const headline = bias === 'neutral'
    ? 'No directional edge visible'
    : `${bias === 'long' ? 'Upward' : 'Downward'} lean, ${regime.regime} conditions`;

  return {
    ok: true,
    state: bias === 'neutral' ? 'neutral' : 'read',
    headline,
    bias,
    net: +net.toFixed(3),
    confidence: +confidence.toFixed(2),
    confidenceLabel: confidence < 0.3 ? 'low' : confidence < 0.55 ? 'moderate' : 'firm',
    price, atr: atrNow,
    regime, htf, buckets,
    weights: w,
    abstained: abstaining.map(([n]) => n),
    liveWeight: +liveWeight.toFixed(3),
    invalidation,
    invalidationBasis,
    stopDistance,
    targets,
    spreadVerdict,
    breakEven: be,
    levels: ind.levels,
    reasons,
    whyNot,
    indicators: ind,
    generatedAtMs: nowMs,
    // Deliberate phrasing: this describes, it does not instruct.
    statement: bias === 'neutral'
      ? 'The chart is not offering a directional read right now.'
      : `Price is leaning ${bias === 'long' ? 'up' : 'down'} in ${regime.regime} conditions. This read is wrong ${bias === 'long' ? 'below' : 'above'} ${fmt(invalidation)}.`,
  };
}

export { WEIGHTS };
