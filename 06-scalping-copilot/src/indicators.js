/**
 * indicators.js — dependency-free technical analysis.
 *
 * CONVENTIONS, held to by every function in this file:
 *
 *  1. Input is an array of bars, oldest first:
 *       { t: epochMs, o, h, l, c, v }
 *  2. Output is an array of the SAME LENGTH, index-aligned with the input, and
 *     null-padded through the warm-up. `out[i]` always describes `bars[i]`.
 *     This matters more than it sounds: mismatched lengths are the single
 *     commonest source of "my indicator is off by two bars" bugs.
 *  3. Nothing mutates its input.
 *  4. Insufficient data returns nulls, never an exception.
 *
 * SEEDING. Smoothed indicators disagree between libraries on how the first
 * value is produced, and the disagreement never washes out completely — it
 * decays geometrically but is still visible dozens of bars later. This file
 * follows the TradingView / MetaTrader convention throughout:
 *
 *  - EMA seeds from the SMA of the first `period` values.
 *  - RSI and ATR use WILDER smoothing: the first average is a simple mean of
 *    the first `period` values, and thereafter
 *        avg = (prevAvg * (period - 1) + current) / period
 *    which is an EMA with alpha = 1/period, NOT the 2/(period+1) used by a
 *    standard EMA. Using the wrong alpha gives an RSI that looks plausible and
 *    is consistently wrong.
 *  - Bollinger Bands use the POPULATION standard deviation (divide by N),
 *    matching TradingView's ta.stdev. Sample stdev (N-1) gives visibly wider
 *    bands on short periods.
 *
 * Where a value could not be computed the entry is null. Callers should use
 * `lastOf()` rather than indexing from the end, so a null tail cannot be
 * mistaken for a reading.
 */

/* ---------------------------------------------------------------- helpers */

import { tzOffsetMs } from './timezone.js';

const nulls = (n) => new Array(n).fill(null);

/** Last non-null value of an indicator series, or null. */
export function lastOf(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null && series[i] !== undefined && !Number.isNaN(series[i])) return series[i];
  }
  return null;
}

/** Value `back` bars before the end, or null. */
export function valueAt(series, back = 0) {
  const i = series.length - 1 - back;
  if (i < 0 || i >= series.length) return null;
  const v = series[i];
  return v === undefined || Number.isNaN(v) ? null : v;
}

export const closes = (bars) => bars.map((b) => b.c);
export const highs = (bars) => bars.map((b) => b.h);
export const lows = (bars) => bars.map((b) => b.l);
export const volumes = (bars) => bars.map((b) => (typeof b.v === 'number' ? b.v : 0));
/** Typical price (HLC/3) — the standard VWAP input. */
export const typical = (bars) => bars.map((b) => (b.h + b.l + b.c) / 3);

/* ------------------------------------------------------------- averages */

/** Simple moving average. Warm-up: period - 1 bars. */
export function sma(values, period) {
  const out = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded from the SMA of the first `period` values
 * (TradingView / MT5 convention). Warm-up: period - 1 bars.
 */
export function ema(values, period) {
  const out = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average — linear weights, heaviest on the newest bar. */
export function wma(values, period) {
  const out = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - j] * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

/** Hull moving average: WMA(2*WMA(n/2) - WMA(n), sqrt(n)). Fast, low lag. */
export function hma(values, period) {
  if (period <= 1 || values.length < period) return nulls(values.length);
  const half = Math.max(1, Math.floor(period / 2));
  const root = Math.max(1, Math.round(Math.sqrt(period)));
  const a = wma(values, half);
  const b = wma(values, period);
  const diff = values.map((_, i) => (a[i] === null || b[i] === null ? null : 2 * a[i] - b[i]));
  const firstValid = diff.findIndex((x) => x !== null);
  if (firstValid < 0) return nulls(values.length);
  const dense = diff.slice(firstValid).map((x) => (x === null ? 0 : x));
  const smoothed = wma(dense, root);
  const out = nulls(values.length);
  for (let i = 0; i < smoothed.length; i++) out[firstValid + i] = smoothed[i];
  return out;
}

/**
 * Wilder's smoothing. Seeds with the simple mean of the first `period` values,
 * then avg = (prev*(period-1) + x) / period. Used by RSI, ATR and ADX.
 */
function wilder(values, period) {
  const out = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/* --------------------------------------------------------- momentum etc */

/**
 * RSI, Wilder-smoothed. Warm-up: `period` bars (one is consumed producing the
 * first delta). Flat price gives avgLoss == 0; we return 100 rather than
 * dividing by zero, and 50 when both averages are zero (dead flat).
 */
export function rsi(values, period = 14) {
  const out = nulls(values.length);
  if (values.length < period + 1) return out;
  const gains = [], losses = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = wilder(gains, period);
  const al = wilder(losses, period);
  for (let i = 0; i < gains.length; i++) {
    if (ag[i] === null || al[i] === null) continue;
    // Algebraically identical to 100 - 100/(1+RS), but with no infinite-RS
    // branch to special-case: when both averages are zero the price is dead
    // flat and 50 is the honest reading.
    const denom = ag[i] + al[i];
    out[i + 1] = denom > 0 ? (100 * ag[i]) / denom : 50;   // +1: gains[0] describes bars[1]
  }
  return out;
}

/**
 * True Range.
 *
 * Bar 0 is NULL, not (high - low). True Range is defined against the previous
 * close, and the first bar has none. Substituting (high - low) there looks
 * harmless but feeds a bogus value into the Wilder seed, which shifts every
 * ATR reading downstream by one bar — and ATR is what sizes the stop.
 * TA-Lib starts its TR at index 1 for exactly this reason.
 */
export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return null;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** ATR, Wilder-smoothed, starting from the first real TR. Warm-up: period bars. */
export function atr(bars, period = 14) {
  if (!bars.length) return [];
  const tr = trueRange(bars);
  const smoothed = wilder(tr.slice(1), period);
  return [null, ...smoothed];   // realign: smoothed[0] describes bars[1]
}

/** MACD. The signal line is an EMA of the MACD line's own valid history. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const n = values.length;
  // The two EMAs must have seed windows that END ON THE SAME BAR. Computed
  // independently from bar 0, the fast EMA has had (slow - fast) extra bars of
  // smoothing by the time the slow one starts, so the difference between them
  // is not a clean MACD on the early bars. Offsetting the fast EMA's input so
  // its seed window closes at index slow-1 is what TA-Lib does.
  const offset = Math.max(0, slow - fast);
  const efShifted = ema(values.slice(offset), fast);
  const ef = [...nulls(offset), ...efShifted];
  const es = ema(values, slow);
  const line = nulls(n);
  for (let i = 0; i < n; i++) if (ef[i] !== null && es[i] !== null) line[i] = ef[i] - es[i];

  const firstValid = line.findIndex((x) => x !== null);
  const signal = nulls(n);
  const hist = nulls(n);
  if (firstValid >= 0) {
    const dense = line.slice(firstValid);
    const sig = ema(dense, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] === null) continue;
      signal[firstValid + i] = sig[i];
      hist[firstValid + i] = line[firstValid + i] - sig[i];
    }
  }
  return { line, signal, histogram: hist };
}

/** Bollinger Bands, population stdev (TradingView convention). */
export function bollingerBands(values, period = 20, mult = 2) {
  const n = values.length;
  const mid = sma(values, period);
  const upper = nulls(n), lower = nulls(n), width = nulls(n), pctB = nulls(n);
  for (let i = period - 1; i < n; i++) {
    if (mid[i] === null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(acc / period);       // population, not sample
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] === 0 ? null : ((upper[i] - lower[i]) / mid[i]) * 100;
    const span = upper[i] - lower[i];
    pctB[i] = span === 0 ? 0.5 : (values[i] - lower[i]) / span;
  }
  return { middle: mid, upper, lower, width, percentB: pctB };
}

/** Stochastic oscillator. %D is an SMA of %K. */
export function stochastic(bars, kPeriod = 14, dPeriod = 3, smooth = 3) {
  const n = bars.length;
  const rawK = nulls(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    const span = hh - ll;
    rawK[i] = span === 0 ? 50 : ((bars[i].c - ll) / span) * 100;
  }
  const firstValid = rawK.findIndex((x) => x !== null);
  const k = nulls(n), d = nulls(n);
  if (firstValid >= 0) {
    const dense = rawK.slice(firstValid);
    const ks = sma(dense, smooth);
    for (let i = 0; i < ks.length; i++) if (ks[i] !== null) k[firstValid + i] = ks[i];
    const kFirst = k.findIndex((x) => x !== null);
    if (kFirst >= 0) {
      const ds = sma(k.slice(kFirst).map((x) => (x === null ? 0 : x)), dPeriod);
      for (let i = 0; i < ds.length; i++) if (ds[i] !== null) d[kFirst + i] = ds[i];
    }
  }
  return { k, d };
}

/* --------------------------------------------------------------- trend */

/**
 * ADX / DMI, full Wilder three-step.
 *   1. Smooth TR, +DM and -DM over `period`.
 *   2. +DI = 100 * smoothed(+DM)/smoothed(TR); likewise -DI.
 *   3. DX = 100 * |+DI - -DI| / (+DI + -DI); ADX = Wilder-smoothed DX.
 * ADX therefore needs roughly 2 * period bars before it means anything.
 */
export function adx(bars, period = 14) {
  const n = bars.length;
  const out = { adx: nulls(n), plusDI: nulls(n), minusDI: nulls(n) };
  if (n < period * 2) return out;

  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const pc = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }

  const strTR = wilder(tr, period);
  const strP = wilder(plusDM, period);
  const strM = wilder(minusDM, period);

  const dx = [];
  const dxIndex = [];
  for (let i = 0; i < tr.length; i++) {
    if (strTR[i] === null || strTR[i] === 0) { continue; }
    const pdi = (strP[i] / strTR[i]) * 100;
    const mdi = (strM[i] / strTR[i]) * 100;
    out.plusDI[i + 1] = pdi;
    out.minusDI[i + 1] = mdi;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
    dxIndex.push(i + 1);
  }
  const adxVals = wilder(dx, period);
  for (let i = 0; i < adxVals.length; i++) {
    if (adxVals[i] !== null) out.adx[dxIndex[i]] = adxVals[i];
  }
  return out;
}

/**
 * Supertrend. The band-locking rule is the part implementations get wrong:
 * the final upper band may only ratchet DOWN while price stays below it, and
 * resets when price closes above. Without that lock the indicator flip-flops.
 */
export function supertrend(bars, period = 10, mult = 3) {
  const n = bars.length;
  const a = atr(bars, period);
  const value = nulls(n), dir = nulls(n);
  let fUpper = null, fLower = null, prevDir = 1;

  for (let i = 0; i < n; i++) {
    if (a[i] === null) continue;
    const mid = (bars[i].h + bars[i].l) / 2;
    const bUpper = mid + mult * a[i];
    const bLower = mid - mult * a[i];
    const pc = i > 0 ? bars[i - 1].c : bars[i].c;

    fUpper = (fUpper === null || bUpper < fUpper || pc > fUpper) ? bUpper : fUpper;
    fLower = (fLower === null || bLower > fLower || pc < fLower) ? bLower : fLower;

    let d = prevDir;
    if (bars[i].c > fUpper) d = 1;
    else if (bars[i].c < fLower) d = -1;

    dir[i] = d;
    value[i] = d === 1 ? fLower : fUpper;
    prevDir = d;
  }
  return { value, direction: dir };
}

/* ----------------------------------------------------------- channels */

export function donchian(bars, period = 20) {
  const n = bars.length;
  const upper = nulls(n), lower = nulls(n), mid = nulls(n);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    upper[i] = hh; lower[i] = ll; mid[i] = (hh + ll) / 2;
  }
  return { upper, lower, middle: mid };
}

export function keltner(bars, period = 20, mult = 2, atrPeriod = 10) {
  const n = bars.length;
  const mid = ema(typical(bars), period);
  const a = atr(bars, atrPeriod);
  const upper = nulls(n), lower = nulls(n);
  for (let i = 0; i < n; i++) {
    if (mid[i] === null || a[i] === null) continue;
    upper[i] = mid[i] + mult * a[i];
    lower[i] = mid[i] - mult * a[i];
  }
  return { middle: mid, upper, lower };
}

/* --------------------------------------------------------------- VWAP */

/**
 * Session-anchored VWAP with standard-deviation bands.
 *
 * `sessionResetUtcHour` is where the two instruments genuinely differ:
 *   - Gold anchors to the futures/forex day (22:00 or 23:00 UTC depending on
 *     DST — pass whichever matches the broker's server day).
 *   - Bitcoin trades continuously and anchors to 00:00 UTC, which is what
 *     every crypto venue uses for its daily candle.
 * Pass null to anchor at the first bar instead (useful for an intraday
 * anchored VWAP from a chosen event).
 *
 * Note: MT5 gold feeds carry TICK volume, not traded volume. The shape is
 * usually informative; the magnitude is not comparable across venues.
 */
export function sessionVwap(bars, sessionReset = 0, devMult = [1, 2]) {
  // `sessionReset` is either a fixed UTC hour (bitcoin: 0, matching every
  // crypto venue's daily candle) or {h, tz} for an instrument whose trading
  // day is anchored to a local clock that moves with daylight saving. Gold's
  // futures day rolls at 17:00 New York, which is 21:00 UTC in summer and
  // 22:00 UTC in winter — hardcoding either is wrong for half the year.
  const resolveResetHour = (t) => {
    if (sessionReset === null) return null;
    if (typeof sessionReset === 'number') return sessionReset;
    const off = tzOffsetMs(t, sessionReset.tz) / 3600e3;
    return ((sessionReset.h - off) % 24 + 24) % 24;
  };
  const n = bars.length;
  const vwap = nulls(n);
  const bands = devMult.map(() => ({ upper: nulls(n), lower: nulls(n) }));

  let cumPV = 0, cumV = 0, anchorDay = null;
  let session = [];   // [typicalPrice, volume] for the current session

  for (let i = 0; i < n; i++) {
    const d = new Date(bars[i].t);
    let dayKey;
    const resetHour = resolveResetHour(bars[i].t);
    if (resetHour === null) {
      dayKey = 'single';
    } else {
      const shifted = new Date(bars[i].t - resetHour * 3600e3);
      dayKey = `${shifted.getUTCFullYear()}-${shifted.getUTCMonth()}-${shifted.getUTCDate()}`;
    }
    if (dayKey !== anchorDay) { anchorDay = dayKey; cumPV = 0; cumV = 0; session = []; }

    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    // Tick-volume feeds can report 0; fall back to 1 so VWAP degrades to a
    // simple typical-price average rather than dividing by zero.
    const vol = bars[i].v && bars[i].v > 0 ? bars[i].v : 1;
    cumPV += tp * vol;
    cumV += vol;
    session.push([tp, vol]);

    const vw = cumPV / cumV;
    vwap[i] = vw;
    // TWO-PASS variance. The textbook one-pass form E[x^2] - mean^2
    // catastrophically cancels at gold's price level: tp^2 is ~19,000,000 and
    // the variance being extracted from it is a few units, which float64
    // cannot resolve — it goes negative and the bands collapse. Re-walking the
    // session is a few hundred multiplications and is simply correct.
    let acc = 0;
    for (let k = 0; k < session.length; k++) acc += session[k][1] * (session[k][0] - vw) ** 2;
    const variance = Math.max(0, acc / cumV);
    const sd = Math.sqrt(variance);
    devMult.forEach((m, bi) => {
      bands[bi].upper[i] = vw + m * sd;
      bands[bi].lower[i] = vw - m * sd;
    });
    void d;
  }
  return { vwap, bands };
}

/* ------------------------------------------------- structure and levels */

/**
 * Fractal swing pivots. A pivot high at i needs `lookback` lower highs on both
 * sides, so it CANNOT be confirmed until `lookback` bars have printed after it.
 *
 * Anything within `lookback` of the right edge is therefore unconfirmed. We
 * refuse to emit those rather than emitting and later revoking them — an
 * indicator that repaints is worse than one that is late, because a scalper
 * acts on it.
 */
export function swingPivots(bars, lookback = 3) {
  const highsArr = [], lowsArr = [];
  const lastConfirmable = bars.length - 1 - lookback;
  for (let i = lookback; i <= lastConfirmable; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highsArr.push({ index: i, price: bars[i].h, t: bars[i].t });
    if (isLow) lowsArr.push({ index: i, price: bars[i].l, t: bars[i].t });
  }
  return { highs: highsArr, lows: lowsArr, unconfirmedBars: lookback };
}

/**
 * Merge nearby pivots into support/resistance levels.
 *
 * Tolerance is expressed in ATR rather than in price, so the same code works
 * for $3,900 gold and $95,000 bitcoin without a magic number per instrument.
 * Strength counts touches, weighted towards recent ones — a level respected
 * this morning matters more to a scalp than one from three days ago.
 */
export function clusterLevels(bars, atrValue, opts = {}) {
  const { lookback = 3, toleranceAtr = 0.5, maxLevels = 8 } = opts;
  if (!atrValue || atrValue <= 0 || bars.length < lookback * 2 + 1) return [];

  const { highs: ph, lows: pl } = swingPivots(bars, lookback);
  const points = [
    ...ph.map((p) => ({ ...p, kind: 'resistance' })),
    ...pl.map((p) => ({ ...p, kind: 'support' })),
  ].sort((a, b) => a.price - b.price);
  if (!points.length) return [];

  const tol = atrValue * toleranceAtr;
  const clusters = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].price - cur[cur.length - 1].price <= tol) cur.push(points[i]);
    else { clusters.push(cur); cur = [points[i]]; }
  }
  clusters.push(cur);

  const lastIdx = bars.length - 1;
  const levels = clusters.map((c) => {
    const price = c.reduce((s, p) => s + p.price, 0) / c.length;
    // Recency weight decays linearly to 0.3 across the visible window.
    const strength = c.reduce((s, p) => s + (0.3 + 0.7 * (p.index / lastIdx)), 0);
    const resCount = c.filter((p) => p.kind === 'resistance').length;
    return {
      price,
      touches: c.length,
      strength,
      lastTouchIndex: Math.max(...c.map((p) => p.index)),
      bias: resCount > c.length / 2 ? 'resistance' : resCount < c.length / 2 ? 'support' : 'both',
    };
  });

  return levels.sort((a, b) => b.strength - a.strength).slice(0, maxLevels)
    .sort((a, b) => a.price - b.price);
}

/**
 * Market structure from confirmed pivots.
 *   BOS   — Break of Structure: trend continues (higher high in an uptrend).
 *   CHoCH — Change of Character: the first break the other way, i.e. the
 *           earliest structural hint that the trend is over.
 * Both are computed only from CONFIRMED pivots, so neither repaints.
 */
export function marketStructure(bars, lookback = 3) {
  const { highs: ph, lows: pl } = swingPivots(bars, lookback);
  if (ph.length < 2 || pl.length < 2) {
    return { trend: 'undefined', events: [], lastHigh: null, lastLow: null, reason: 'not enough confirmed pivots' };
  }
  const seq = [...ph.map((p) => ({ ...p, kind: 'H' })), ...pl.map((p) => ({ ...p, kind: 'L' }))]
    .sort((a, b) => a.index - b.index);

  let trend = 'undefined';
  let prevH = null, prevL = null;
  const events = [];
  for (const p of seq) {
    if (p.kind === 'H') {
      if (prevH !== null) {
        if (p.price > prevH) {
          events.push({ type: trend === 'down' ? 'CHoCH' : 'BOS', dir: 'up', index: p.index, price: p.price });
          trend = 'up';
        }
      }
      prevH = p.price;
    } else {
      if (prevL !== null) {
        if (p.price < prevL) {
          events.push({ type: trend === 'up' ? 'CHoCH' : 'BOS', dir: 'down', index: p.index, price: p.price });
          trend = 'down';
        }
      }
      prevL = p.price;
    }
  }
  return {
    trend,
    events: events.slice(-6),
    lastHigh: ph.length ? ph[ph.length - 1] : null,
    lastLow: pl.length ? pl[pl.length - 1] : null,
    reason: null,
  };
}

/**
 * Fair Value Gaps (three-candle imbalance).
 * Bullish: low of bar i is above high of bar i-2 — the middle candle ran so
 * hard that no trade happened in the gap. Bearish is the mirror.
 * Only gaps of at least `minAtr` ATR are kept; on M5 the small ones are noise.
 * A gap is marked filled once a later bar trades back through it.
 */
export function findFVGs(bars, atrValue, opts = {}) {
  const { minAtr = 0.25, maxAgeBars = 120, includeFilled = false } = opts;
  const out = [];
  if (!atrValue || atrValue <= 0) return out;
  const start = Math.max(2, bars.length - maxAgeBars);

  for (let i = start; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    if (c.l > a.h && c.l - a.h >= atrValue * minAtr) {
      out.push({ type: 'bullish', from: a.h, to: c.l, index: i, t: c.t, size: c.l - a.h });
    } else if (a.l > c.h && a.l - c.h >= atrValue * minAtr) {
      out.push({ type: 'bearish', from: c.h, to: a.l, index: i, t: c.t, size: a.l - c.h });
    }
  }
  for (const g of out) {
    g.filled = false;
    for (let j = g.index + 1; j < bars.length; j++) {
      if (bars[j].l <= g.from && bars[j].h >= g.to) { g.filled = true; break; }
      if (g.type === 'bullish' && bars[j].l <= g.from) { g.filled = true; break; }
      if (g.type === 'bearish' && bars[j].h >= g.to) { g.filled = true; break; }
    }
  }
  return (includeFilled ? out : out.filter((g) => !g.filled)).slice(-6);
}

/**
 * Order blocks: the last opposing candle before an impulsive move that breaks
 * structure. Deliberately narrow — the loose definitions match almost any
 * candle and are therefore meaningless.
 */
export function findOrderBlocks(bars, atrValue, opts = {}) {
  const { impulseAtr = 1.5, maxAgeBars = 120, lookahead = 3 } = opts;
  const out = [];
  if (!atrValue || atrValue <= 0) return out;
  const start = Math.max(1, bars.length - maxAgeBars);

  for (let i = start; i < bars.length - lookahead; i++) {
    const b = bars[i];
    const isDown = b.c < b.o, isUp = b.c > b.o;
    let move = 0;
    for (let j = i + 1; j <= i + lookahead; j++) move = Math.max(move, Math.abs(bars[j].c - b.c));
    if (move < atrValue * impulseAtr) continue;

    const wentUp = bars[i + lookahead].c > b.c;
    if (isDown && wentUp) out.push({ type: 'bullish', top: Math.max(b.o, b.c), bottom: b.l, index: i, t: b.t });
    else if (isUp && !wentUp) out.push({ type: 'bearish', top: b.h, bottom: Math.min(b.o, b.c), index: i, t: b.t });
  }
  // Drop blocks price has already traded back through and closed beyond.
  return out.filter((ob) => {
    for (let j = ob.index + 1; j < bars.length; j++) {
      if (ob.type === 'bullish' && bars[j].c < ob.bottom) return false;
      if (ob.type === 'bearish' && bars[j].c > ob.top) return false;
    }
    return true;
  }).slice(-4);
}

/**
 * Liquidity sweep / stop hunt: a wick pushes through a confirmed pivot, then
 * the bar CLOSES back inside. That close-back-inside is the whole signal —
 * without it, it is just a breakout.
 */
export function detectLiquiditySweep(bars, opts = {}) {
  const { lookback = 3, withinBars = 6, minWickAtrFrac = 0.15, atrValue = null } = opts;
  const { highs: ph, lows: pl } = swingPivots(bars, lookback);
  const res = [];
  const from = Math.max(0, bars.length - withinBars);

  for (let i = from; i < bars.length; i++) {
    const b = bars[i];
    for (const p of ph) {
      if (p.index >= i) continue;
      const wick = b.h - Math.max(b.o, b.c);
      if (b.h > p.price && b.c < p.price && (!atrValue || wick >= atrValue * minWickAtrFrac)) {
        res.push({ type: 'sell-side-sweep', level: p.price, index: i, t: b.t, barsAgo: bars.length - 1 - i });
        break;
      }
    }
    for (const p of pl) {
      if (p.index >= i) continue;
      const wick = Math.min(b.o, b.c) - b.l;
      if (b.l < p.price && b.c > p.price && (!atrValue || wick >= atrValue * minWickAtrFrac)) {
        res.push({ type: 'buy-side-sweep', level: p.price, index: i, t: b.t, barsAgo: bars.length - 1 - i });
        break;
      }
    }
  }
  return res.slice(-4);
}

/**
 * Relative volume: this bar against the mean of the SAME five-minute slot on
 * previous days. Comparing against a flat rolling average instead would flag
 * every London open as unusual, which is useless — the London open is
 * supposed to be busy.
 */
export function relativeVolume(bars, daysBack = 5) {
  const n = bars.length;
  const out = nulls(n);
  const bySlot = new Map();
  for (let i = 0; i < n; i++) {
    const d = new Date(bars[i].t);
    const slot = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push({ i, v: bars[i].v || 0 });
  }
  for (const entries of bySlot.values()) {
    for (let k = 0; k < entries.length; k++) {
      const prior = entries.slice(Math.max(0, k - daysBack), k);
      if (prior.length < 2) continue;
      const mean = prior.reduce((s, e) => s + e.v, 0) / prior.length;
      if (mean > 0) out[entries[k].i] = entries[k].v / mean;
    }
  }
  return out;
}

/**
 * Volume profile approximated from OHLCV.
 *
 * LIMIT, stated plainly: without tick data we do not know where inside a bar
 * the volume traded. This spreads each bar's volume uniformly across its
 * high-low range, which is wrong in detail but produces a usable picture of
 * where price has spent time. Treat the Point of Control as "where price
 * lingered", not as a true traded-volume peak. On an MT5 gold feed the input
 * is tick volume anyway, so this is an approximation of an approximation.
 */
export function volumeProfile(bars, buckets = 40) {
  if (!bars.length) return { levels: [], poc: null, vah: null, val: null };
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (!(hi > lo)) return { levels: [], poc: null, vah: null, val: null };

  const size = (hi - lo) / buckets;
  const vol = new Array(buckets).fill(0);
  for (const b of bars) {
    const v = b.v && b.v > 0 ? b.v : 1;
    const from = Math.max(0, Math.floor((b.l - lo) / size));
    const to = Math.min(buckets - 1, Math.floor((b.h - lo) / size));
    const span = to - from + 1;
    for (let k = from; k <= to; k++) vol[k] += v / span;
  }
  const levels = vol.map((v, k) => ({ price: lo + size * (k + 0.5), volume: v }));
  const total = vol.reduce((s, v) => s + v, 0);

  let pocIdx = 0;
  for (let k = 1; k < buckets; k++) if (vol[k] > vol[pocIdx]) pocIdx = k;

  // Value area: expand from the POC until 70% of volume is enclosed.
  let acc = vol[pocIdx], lowI = pocIdx, highI = pocIdx;
  while (acc < total * 0.7 && (lowI > 0 || highI < buckets - 1)) {
    const below = lowI > 0 ? vol[lowI - 1] : -1;
    const above = highI < buckets - 1 ? vol[highI + 1] : -1;
    if (above >= below) { highI++; acc += vol[highI]; } else { lowI--; acc += vol[lowI]; }
  }
  return {
    levels,
    poc: levels[pocIdx].price,
    vah: levels[highI].price,
    val: levels[lowI].price,
  };
}

/* ---------------------------------------------------------- resampling */

/**
 * Resample M5 bars up to a higher timeframe.
 *
 * `dropPartial` defaults to true and should almost never be turned off. The
 * newest higher-timeframe bar is still forming; treating it as closed is
 * look-ahead bias in the only direction that flatters a backtest. When we take
 * a bias from H1 we must take it from the last CLOSED H1 bar.
 */
export function resample(bars, minutes, dropPartial = true) {
  if (!bars.length) return [];
  const ms = minutes * 60000;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, count: 1 };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v || 0;
      cur.count++;
    }
  }
  if (cur) out.push(cur);

  if (dropPartial && out.length) {
    const expected = minutes / 5;
    if (out[out.length - 1].count < expected) out.pop();
  }
  return out;
}
