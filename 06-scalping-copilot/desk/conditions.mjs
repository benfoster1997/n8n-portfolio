/**
 * desk/conditions.mjs — the replay's "--by-condition" table (LEARNING-PLAN.md, Part 2).
 *
 * A developer report by default. It splits past alerts (or window checks) by
 * the conditions they fired in — the engine's regime, its confidence word,
 * whether the two higher timeframes agreed, the sign of each directional
 * scoring bucket relative to the trade, the London hour band, the weekday and
 * the side — and gives each split the average result in R, how many trades it
 * holds, and a range around that average.
 *
 * The danger in a table like this is that it is 30 questions asked at once.
 * Ask 30 questions of pure noise at the usual 95% and about 1.5 of them come
 * back "significant" — someone reading the table then has a "finding" that is
 * nothing but the number of rows. So, as the plan declares:
 *   - a cell is marked only when its range clears zero at the Bonferroni level
 *     for every cell in the table, so the chance that ANY cell is marked on an
 *     edgeless system is at most about 1 in 20, not about 4 in 5;
 *   - that level is a Student-t quantile on the number of days, with the
 *     usual G/(G−1) small-sample factor on the day-clustered error. The plain
 *     normal z (3.14 for 30 cells) is only right for a cell on many days: on
 *     30 trades over 10 days it lets noise through about ten times as often
 *     as it claims, which is the error this table exists to prevent;
 *   - the number of cells expected to clear the ordinary 95% by chance is
 *     printed next to the number that did, so a reader sees "1.5 expected,
 *     2 found" and draws the right conclusion (nothing);
 *   - below 30 trades a cell says "too few to say" and shows no average at all:
 *     an average of 12 trades invites a reading it cannot bear;
 *   - every range is clustered by day (desk/stats.mjs): alerts on the same day
 *     share one market, and treating them as independent makes every range too
 *     narrow — exactly the error that turns noise into a "finding".
 * Even a marked cell is not a rule. Turning one into a filter would be a
 * change to the method, which ends the committed sample and needs a sample of
 * its own (plan rule 1; HANDOFF decision 8). That is why no line here is ever
 * worded as advice: no "avoid", no "only trade", no "best" or "worst".
 *
 * Input trades are { at: 'YYYY-MM-DDTHH:MM' (UTC, optional seconds and Z), r,
 * cond }. `cond` is exactly what features.mjs conditionOf(raw, { side })
 * returns, and nothing else builds it (the contract, checked row by row here
 * and refused when broken — a vocabulary drift must stop the table, not
 * quietly empty a cell):
 *   { regime: one of REGIMES, confidenceLabel: one of CONFIDENCE,
 *     h1, h4: −1 | 0 | 1, agree: true | false,
 *     buckets: { trend, momentum, structure, location, volume } — each −1, 0
 *       or 1 RELATIVE TO THE SIDE, or null when the bucket abstained,
 *     hourBand: one of HOUR_BANDS or null, weekday: one of WEEKDAYS or null
 *       (both on London's clock), side: 'buy' | 'sell' }.
 * There is no volatility bucket: volatility has no direction, so "for" and
 * "against" the trade mean nothing for it.
 *
 * This module does no I/O and reads no file. It does not decide whether the
 * held-back years may be looked at — the replay does, from model.json — and it
 * does not decide whether the journal's committed sample is complete: rows
 * after the holdout (the live sample's period) are refused unless the caller
 * says the sample is complete (allowFresh).
 *
 * conditionReport() is the adapter desk/replay.mjs calls for --by-condition:
 * it takes the replay's reads (made with desk/features-extra.mjs, so each
 * lean carries features.mjs conditionOf's cell) and its alerts, and prints a
 * table per period.
 */
import { clusteredByDay } from './stats.mjs';
import { REGIMES as FEATURE_REGIMES, HOUR_BANDS as FEATURE_HOUR_BANDS, WEEKDAYS as FEATURE_WEEKDAYS, DIRECTIONAL } from './features.mjs';
import { tfInfo } from '../src/timeframes.js';

/**
 * The fixed holdout (plan rule 2): from 2025-01-01 00:00 UTC to 2026-10-14
 * 20:45 UTC, inclusive. Inside it, 2025 is clean and 2026 was already looked
 * at while choosing the 1.5R rule; the plan reports them separately, always.
 * Later rows (the live journal) are fresh: after the window, not in it.
 *
 * A trade's `at` is its BAR CLOSE time, as desk/replay.mjs and reads.mjs
 * alertPass write it (the moment the watcher could have sent it), and the
 * boundaries are compared with that instant. The plan defines the window by
 * bars, whose history times are open times, so the bar opening 2026-10-14
 * 20:45 (closing 21:00) counts as fresh here, and the bar opening 2024-12-31
 * 23:45 (closing at midnight) as 2025. Both lie outside the London window, so
 * no check of the table falls on either edge.
 */
export const HOLDOUT = Object.freeze({ from: '2025-01-01T00:00Z', seenFrom: '2026-01-01T00:00Z', to: '2026-10-14T20:45Z' });
const FROM_MS = Date.parse(HOLDOUT.from), SEEN_MS = Date.parse(HOLDOUT.seenFrom), TO_MS = Date.parse(HOLDOUT.to);

/** The four periods a row can belong to, and the line each prints. A table never mixes two. */
export const PERIODS = Object.freeze({
  dev: 'Development years, before 2025.',
  clean: '2025: held back, not used to build anything.',
  seen: '2026 to 14 October: already used to choose the 1.5R rule; this is not unseen data.',
  fresh: 'After 14 October 2026, 20:45 UTC: later than the held-back window.',
});

const MULTI_YEAR_CAVEAT = 'Before 2025 there is no news calendar, so these years include trades around releases that the live desk would have sat out.';

// The contract's vocabulary, from features.mjs, which builds every cond
// (conditionOf): its regimes, the labels of its hour bands and weekdays, and
// its directional buckets (the b_* names among DIRECTIONAL). Imported rather
// than copied, so the two cannot drift (test/conditions.test.mjs runs the real
// conditionOf() through validateCond()). The confidence words are the
// engine's (features.mjs confidenceLabel). A low-confidence idea is refused by
// checkPlan(), so on alerts that cell will normally be empty; it is still
// counted in the Bonferroni total, because it was declared in advance.
export const REGIMES = Object.freeze([...FEATURE_REGIMES]);
export const CONFIDENCE = Object.freeze(['low', 'moderate', 'firm']);
export const BUCKETS = Object.freeze(DIRECTIONAL.filter((n) => n.startsWith('b_')).map((n) => n.slice(2)));
export const HOUR_BANDS = Object.freeze(FEATURE_HOUR_BANDS.map((b) => b.label));
export const WEEKDAYS = Object.freeze(FEATURE_WEEKDAYS.map((d) => d.label));
const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

/**
 * The cells, in the order the table prints them. Each is
 * { id, group, label, test(cond) → boolean }. Buckets are signed by side in
 * conditionOf(), so "with the trade" is true of buys and sells alike. A bucket
 * at 0 or abstaining falls in neither of its two cells; an hour or weekday of
 * null falls in no cell of its group. Both are counted and printed (see
 * `outside` and `bucketsNeither`), so a group's rows always add up.
 */
export const CELLS = Object.freeze([
  ...REGIMES.map((v) => ({ id: `regime:${v}`, group: 'Regime', label: cap(v), test: (c) => c.regime === v })),
  ...CONFIDENCE.map((v) => ({ id: `confidence:${v}`, group: 'Confidence', label: cap(v), test: (c) => c.confidenceLabel === v })),
  { id: 'htf:agree', group: 'Higher timeframes', label: 'Agree', test: (c) => c.agree === true },
  { id: 'htf:differ', group: 'Higher timeframes', label: 'Do not agree', test: (c) => c.agree === false },
  ...BUCKETS.flatMap((b) => [
    { id: `${b}:+`, group: 'Buckets', label: `${cap(b)} with the trade`, test: (c) => c.buckets[b] === 1 },
    { id: `${b}:-`, group: 'Buckets', label: `${cap(b)} against the trade`, test: (c) => c.buckets[b] === -1 },
  ]),
  ...HOUR_BANDS.map((v) => ({ id: `hour:${v}`, group: 'Hour (London)', label: `${v.slice(0, 2)}:00 to ${v.slice(3)}:00`, test: (c) => c.hourBand === v })),
  ...WEEKDAYS.map((v) => ({ id: `weekday:${v}`, group: 'Weekday', label: DAY_NAMES[v], test: (c) => c.weekday === v })),
  { id: 'side:buy', group: 'Side', label: 'Buys', test: (c) => c.side === 'buy' },
  { id: 'side:sell', group: 'Side', label: 'Sells', test: (c) => c.side === 'sell' },
].map((c) => Object.freeze(c)));

/** Groups in which every trade sits in exactly one cell, or (hour, weekday) in none. */
const EXCLUSIVE = ['Regime', 'Confidence', 'Higher timeframes', 'Hour (London)', 'Weekday', 'Side'];

const SIGNS = [-1, 0, 1];
const show = (v) => (typeof v === 'string' ? `'${v}'` : String(v));

/**
 * Throws, naming the field, unless `cond` is exactly the contract's shape.
 * Exported so the integration test can run the real conditionOf() through it.
 */
const COND_KEYS = Object.freeze(['regime', 'confidenceLabel', 'h1', 'h4', 'agree', 'buckets', 'hourBand', 'weekday', 'side']);
export function validateCond(cond) {
  if (!cond || typeof cond !== 'object') throw new Error(`cond must be an object from conditionOf(), not ${show(cond)}`);
  const bad = (field, v, allowed) => new Error(`cond.${field} is ${show(v)}, not one of ${allowed} (the contract: features.mjs conditionOf)`);
  // An extra key (cond.volatility, say) is a contract drift too: refused, not ignored.
  for (const k of Object.keys(cond)) if (!COND_KEYS.includes(k)) throw bad('key', k, COND_KEYS.join(', '));
  if (!REGIMES.includes(cond.regime)) throw bad('regime', cond.regime, REGIMES.join(', '));
  if (!CONFIDENCE.includes(cond.confidenceLabel)) throw bad('confidenceLabel', cond.confidenceLabel, CONFIDENCE.join(', '));
  for (const k of ['h1', 'h4']) if (!SIGNS.includes(cond[k])) throw bad(k, cond[k], '−1, 0, 1');
  if (cond.agree !== true && cond.agree !== false) throw bad('agree', cond.agree, 'true, false');
  if (!cond.buckets || typeof cond.buckets !== 'object') throw bad('buckets', cond.buckets, 'an object of the five directional buckets');
  for (const k of Object.keys(cond.buckets)) if (!BUCKETS.includes(k)) throw bad(`buckets key`, k, BUCKETS.join(', '));
  for (const b of BUCKETS) if (cond.buckets[b] !== null && !SIGNS.includes(cond.buckets[b])) throw bad(`buckets.${b}`, cond.buckets[b], '−1, 0, 1, null');
  if (cond.hourBand !== null && !HOUR_BANDS.includes(cond.hourBand)) throw bad('hourBand', cond.hourBand, `${HOUR_BANDS.join(', ')}, null`);
  if (cond.weekday !== null && !WEEKDAYS.includes(cond.weekday)) throw bad('weekday', cond.weekday, `${WEEKDAYS.join(', ')}, null`);
  if (cond.side !== 'buy' && cond.side !== 'sell') throw bad('side', cond.side, 'buy, sell');
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?$/;

/**
 * A trade's time in ms, or a throw. The holdout lock depends on it, so a
 * malformed time is an error, never a guess: a leading space, an offset, a
 * bare year or a number (a barCloseMs) would otherwise slip past as an old row.
 */
function atMs(at) {
  if (typeof at !== 'string' || !AT.test(at)) throw new Error(`Trade time ${show(at)} is not 'YYYY-MM-DDTHH:MM' in UTC`);
  const ms = Date.parse(at.endsWith('Z') ? at : `${at}Z`);
  // Date.parse rolls 30 February into March; the round trip catches it.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== at.slice(0, 16)) throw new Error(`Trade time ${show(at)} is not a real date and time`);
  return ms;
}

/** 'dev' | 'clean' | 'seen' | 'fresh' for a trade time (see HOLDOUT). */
export function periodOf(at) {
  const ms = atMs(at);
  if (ms < FROM_MS) return 'dev';
  if (ms < SEEN_MS) return 'clean';
  if (ms <= TO_MS) return 'seen';
  return 'fresh';
}

/**
 * Trades split into { dev, clean, seen, fresh }, for one byCondition() call
 * each. Anything that is not a trade object throws: dropping it here would
 * hide it from byCondition's coverage line (`skipped`).
 */
export function splitByPeriod(trades) {
  if (!Array.isArray(trades)) throw new Error('splitByPeriod needs an array of trades');
  const out = { dev: [], clean: [], seen: [], fresh: [] };
  trades.forEach((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`splitByPeriod: entry ${i} is ${show(t)}, not a trade`);
    out[periodOf(t.at)].push(t);
  });
  return out;
}

/**
 * Inverse of the standard normal distribution (Acklam's rational
 * approximation, relative error about 1e-9 — far finer than any range here
 * needs). Kept local so the module adds no dependency.
 */
function normalQuantile(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lowTail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return lowTail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -lowTail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// log Γ(x), Lanczos (g = 7, nine terms): about 15 significant digits for x > 0.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let s = LANCZOS[0];
  for (let i = 1; i < 9; i++) s += LANCZOS[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

// The regularised incomplete beta I_x(a, b), by its continued fraction (modified Lentz).
function incBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (aa, bb, xx) => {
    const tiny = 1e-300;
    let c = 1, d = 1 - (aa + bb) * xx / (aa + 1);
    d = 1 / (Math.abs(d) < tiny ? tiny : d);
    let h = d;
    for (let m = 1; m <= 500; m++) {
      const m2 = 2 * m;
      let num = m * (bb - m) * xx / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
      num = -(aa + m) * (aa + bb + m) * xx / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d; d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? front * cf(a, b, x) / a : 1 - front * cf(b, a, 1 - x) / b;
}

const tUpperTail = (t, df) => 0.5 * incBeta(df / (df + t * t), df / 2, 0.5);
const tCache = new Map();

/**
 * The t with P(T > t) = p for Student's t on `df` degrees of freedom (p in
 * (0, 0.5)), by bisection on the exact tail: slow next to a closed form, but a
 * table asks for a few dozen values and they are cached.
 */
export function tQuantile(p, df) {
  if (!(p > 0 && p < 0.5) || !(df >= 1)) throw new Error(`tQuantile needs 0 < p < 0.5 and df ≥ 1, not p=${p}, df=${df}`);
  const key = `${p}|${df}`;
  if (tCache.has(key)) return tCache.get(key);
  let lo = 0, hi = 1;
  while (tUpperTail(hi, df) > p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (tUpperTail(mid, df) > p) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  tCache.set(key, t);
  return t;
}

/**
 * The large-sample z that keeps the chance of ANY of `cells` two-sided tests
 * clearing zero by luck at `alpha`: 1.96 for one cell, 3.14 for 30. Printed
 * for reference; each cell's own level is the t version on its days.
 */
export function bonferroniZ(cells, alpha = 0.05) {
  return normalQuantile(1 - alpha / (2 * cells));
}

/**
 * The table's numbers. trades: as described at the top. Options:
 *   minN (30)        below this a cell is "too few to say": mean, lo and hi are
 *                    null and it is never marked.
 *   minDays (10)     the same when its trades fall on fewer days than this — a
 *                    range clustered by day rests on the number of days, and
 *                    thirty trades on three days are three observations.
 *   alpha (0.05)     the family-wise chance, over all cells, of marking any
 *                    cell on an edgeless system. Each cell is tested at
 *                    alpha / cells, two-sided.
 *   cluster ('day')  'none' treats trades as independent. Only for showing how
 *                    much narrower — and wronger — that makes the ranges.
 *   allowHeldBack    false refuses any row inside HOLDOUT.
 *   allowFresh       false refuses rows after HOLDOUT: they are the live
 *                    journal's committed sample in progress, which gets no
 *                    by-condition breakdown before it is complete (plan Part
 *                    3). Pass true only when it is (the journal, after its
 *                    verdict) or for synthetic rows in a test.
 * Throws when the trades span more than one period (dev, clean 2025, seen
 * 2026, fresh): rule 2 reports them separately, so split with splitByPeriod().
 * Rows with no cond, or with r null, undefined or NaN (still running), are
 * left out and counted in `skipped`; a malformed time, an r of another type
 * (a string, an infinity) or a cond outside the contract throws.
 * Returns {
 *   rows: [{ cell, group, label, n, days, mean, lo, hi, crit, tooFew, why,
 *            clearsZero, clearsAt95 }],  one per CELLS entry, same order;
 *   all: the same fields for every trade — the baseline the cells are read
 *        against (not a cell, not counted);
 *   outside: { [exclusive group]: trades in no cell of it },
 *   bucketsNeither: { [bucket]: { zero, abstained } },
 *   cells, alpha, z (large-sample reference), expectedByChance (cells × 0.05),
 *   found (cells marked), foundAt95 (cells whose ordinary 95% range clears
 *   zero — compare with expectedByChance),
 *   period ('dev'|'clean'|'seen'|'fresh'|null), trades, days, from, to,
 *   skipped: { noCond, noResult }, minN, minDays, cluster }.
 * lo/hi are mean ± crit × se, where se is the day-clustered error times
 * √(G/(G−1)) and crit the t quantile on G−1 days of freedom at alpha/cells.
 * `why` is null, 'trades', 'days' or 'spread' (no spread between days — every
 * day's average the same, identical results included — so no range can be
 * measured, and nothing is marked).
 */
export function byCondition(trades, { minN = 30, minDays = 10, alpha = 0.05, cluster = 'day', allowHeldBack = false, allowFresh = false } = {}) {
  if (!Array.isArray(trades)) throw new Error(`byCondition needs an array of trades, not ${show(trades)}`);
  if (cluster !== 'day' && cluster !== 'none') throw new Error(`cluster must be 'day' or 'none', not ${cluster}`);
  if (!Number.isInteger(minN) || minN < 2) throw new Error(`minN must be a whole number of at least 2, not ${minN}`);
  if (!Number.isInteger(minDays) || minDays < 2) throw new Error(`minDays must be a whole number of at least 2 (a range needs two days), not ${minDays}`);
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`alpha must be above 0 and at most 1, not ${alpha}`);

  const skipped = { noCond: 0, noResult: 0 };
  const usable = [];
  for (const t of trades) {
    if (!t || typeof t !== 'object') { skipped.noCond++; continue; }
    atMs(t.at);
    if (t.cond === undefined || t.cond === null) { skipped.noCond++; continue; }
    // Still running is null, undefined or NaN; anything else that is not a
    // finite number is a mistake, not a trade without a result.
    if (t.r === null || t.r === undefined || Number.isNaN(t.r)) { skipped.noResult++; continue; }
    if (typeof t.r !== 'number' || !Number.isFinite(t.r)) throw new Error(`Trade at ${t.at} has r ${show(t.r)}: a result is a finite number of R, or null while it runs`);
    validateCond(t.cond);
    usable.push(t);
  }

  const periods = [...new Set(usable.map((t) => periodOf(t.at)))];
  if (periods.length > 1) {
    throw new Error(`These trades span ${periods.join(' and ')}. Plan rule 2 reports each period on its own (2025 and 2026 never pooled, with each other or the development years); split them with splitByPeriod().`);
  }
  const period = periods[0] || null;
  if ((period === 'clean' || period === 'seen') && !allowHeldBack) {
    const late = usable[0];
    throw new Error(`Trade at ${late.at} is in the held-back window (${HOLDOUT.from} to ${HOLDOUT.to}). The by-condition table does not look at it until the replay says it may.`);
  }
  if (period === 'fresh' && !allowFresh) {
    throw new Error(`Trade at ${usable[0].at} is after the held-back window (${HOLDOUT.to}): that is the live journal's committed sample in progress, which gets no by-condition breakdown before it is complete (plan Part 3).`);
  }
  const ats = usable.map((t) => t.at).sort();

  const cells = CELLS.length;
  const pCell = alpha / (2 * cells);

  // One set of trades → its count, days, average and the two ranges.
  const summarise = (these) => {
    const st = clusteredByDay(these);
    const n = these.length, days = st ? st.days : 0;
    const empty = (why) => ({ n, days, mean: null, lo: null, hi: null, crit: null, tooFew: true, why, clearsZero: false, clearsAt95: false });
    if (n < minN) return empty('trades');
    if (days < minDays) return empty('days');
    const [se, df] = cluster === 'day'
      ? [st.seDay * Math.sqrt(days / (days - 1)), days - 1]
      : [st.sd / Math.sqrt(n), n - 1];
    if (!(se > 0)) return empty('spread');
    const crit = tQuantile(pCell, df), crit95 = tQuantile(0.025, df);
    const lo = st.mean - crit * se, hi = st.mean + crit * se;
    const lo95 = st.mean - crit95 * se, hi95 = st.mean + crit95 * se;
    return { n, days, mean: st.mean, lo, hi, crit, tooFew: false, why: null, clearsZero: lo > 0 || hi < 0, clearsAt95: lo95 > 0 || hi95 < 0 };
  };

  const rows = CELLS.map((cell) => ({
    cell: cell.id, group: cell.group, label: cell.label,
    ...summarise(usable.filter((t) => cell.test(t.cond))),
  }));

  // Every trade has to be somewhere. In an exclusive group, the trades that
  // are in none of its cells (only possible for a null hour or weekday, since
  // the rest are validated) are counted here and printed, so the group's
  // rows add up to the total in front of the reader.
  const outside = {};
  for (const g of EXCLUSIVE) outside[g] = usable.length - rows.filter((r) => r.group === g).reduce((s, r) => s + r.n, 0);
  const bucketsNeither = {};
  for (const b of BUCKETS) {
    bucketsNeither[b] = {
      zero: usable.filter((t) => t.cond.buckets[b] === 0).length,
      abstained: usable.filter((t) => t.cond.buckets[b] === null).length,
    };
  }

  // The whole sample on the same footing, printed above the cells and not
  // counted among them. A cell's test is "is its average away from zero", not
  // "is it different from the rest": if every trade averaged +0.2R, most cells
  // would clear zero for that reason alone. The baseline makes that visible.
  const all = summarise(usable);

  return {
    rows,
    all,
    outside,
    bucketsNeither,
    cells,
    alpha,
    z: bonferroniZ(cells, alpha),
    expectedByChance: cells * 0.05,
    found: rows.filter((r) => r.clearsZero).length,
    foundAt95: rows.filter((r) => r.clearsAt95).length,
    period,
    trades: usable.length,
    days: new Set(usable.map((t) => t.at.slice(0, 10))).size,
    from: ats[0] || null,
    to: ats[ats.length - 1] || null,
    skipped,
    minN, minDays, cluster,
  };
}

/** "about 1 to 2" for 1.5; "about 3" for 3; "less than 1" below one. */
function aboutHowMany(x) {
  if (x < 1) return 'less than 1';
  if (Number.isInteger(x)) return `about ${x}`;
  return `about ${Math.floor(x)} to ${Math.ceil(x)}`;
}

/** "about 1 in 20" for 0.05; "about 1 in 2" for 0.5; "a near certainty" at 1. */
function oneIn(p) {
  if (p >= 0.75) return 'close to certain';
  return `about 1 in ${Math.round(1 / p)}`;
}

const signed = (x, dp = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}`;
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

/**
 * The opening warning, worded from the result so it never drifts from it.
 * `audience` 'journal' drops "Developer report" for the plan's descriptive
 * after-the-sample breakdown.
 */
export function headerWarning(result, { audience = 'developer' } = {}) {
  // The journal's breakdown is description only (plan Part 3): nothing in it
  // is marked, so its header does not promise a mark.
  if (audience === 'journal') {
    return `Described, not tested — ${aboutHowMany(result.expectedByChance)} of these cells would clear zero by chance at 95%, so none is marked; `
      + `each range is drawn with all ${result.cells} cells counted. None of these is a rule to trade by.`;
  }
  return `Developer report — ${aboutHowMany(result.expectedByChance)} of these cells will clear zero by chance at 95%; `
    + `a cell is only marked when it clears zero with all ${result.cells} cells counted (z = ${result.z.toFixed(2)} on many days, wider on few). `
    + 'None of these is a rule to trade by.';
}

/**
 * The table as text. Never on an alert or a push (plan rules 3 and 7).
 * Options:
 *   title       first line; defaults to "Alerts by condition" (or "Checks …").
 *   unit        'alerts' (default) or 'checks' — Part 4's window checks.
 *   htfIds      the two higher timeframes' names, from tf.htf (['H1', 'H4']
 *               on M15; ['M15', 'H1'] on M5): exactly two strings.
 *   multiYear   'auto' adds the plan's rule-8 caveat when any trade is before
 *               2025, true always adds it, false leaves it to the caller.
 *   audience    'developer' (default) or 'journal'. The journal may show this
 *               only after its committed sample is complete (Part 3), so
 *               'journal' throws unless sampleComplete is true, and takes only
 *               fresh rows; it drops the developer and sample-in-progress lines,
 *               and marks no cell (a description, not a test).
 */
export function formatConditions(result, { title = null, unit = 'alerts', htfIds = ['H1', 'H4'], multiYear = 'auto', audience = 'developer', sampleComplete = false } = {}) {
  if (unit !== 'alerts' && unit !== 'checks') throw new Error(`unit must be 'alerts' or 'checks', not ${unit}`);
  if (audience !== 'developer' && audience !== 'journal') throw new Error(`audience must be 'developer' or 'journal', not ${audience}`);
  if (!Array.isArray(htfIds) || htfIds.length !== 2 || !htfIds.every((x) => typeof x === 'string' && x)) throw new Error(`htfIds must be the two higher timeframes' names, like ['H1', 'H4'], not ${show(htfIds)}`);
  const journal = audience === 'journal';
  if (audience === 'journal') {
    if (sampleComplete !== true) throw new Error('No by-condition breakdown of the journal before its committed sample is complete (plan Part 3).');
    if (result.period !== 'fresh' && result.period !== null) throw new Error(`The journal's breakdown covers fresh rows only, not ${result.period}.`);
  }
  const out = [title || `${cap(unit)} by condition`, headerWarning(result, { audience })];
  if (result.period) out.push(PERIODS[result.period]);
  const before2025 = result.period === 'dev';
  if (multiYear === true || (multiYear === 'auto' && before2025)) out.push(MULTI_YEAR_CAVEAT);
  const sk = result.skipped || { noCond: 0, noResult: 0 };
  const left = [sk.noCond && `${sk.noCond} with no condition`, sk.noResult && `${sk.noResult} with no result yet`].filter(Boolean);
  out.push(
    `${result.trades} ${unit} on ${result.days} days${result.from ? `, ${result.from.slice(0, 10)} to ${result.to.slice(0, 10)}` : ''}`
    + `${left.length ? ` (left out: ${left.join(', ')})` : ''}. `
    + `Results in R (1 = the risk). Ranges are clustered by day${result.cluster === 'none' ? ' — NOT HERE: this run treats every trade as independent, so its ranges are too narrow' : ''}.`,
    '',
  );

  const W = Math.max(...result.rows.map((r) => r.label.length), 'None of these'.length) + 2;
  out.push(`${pad('', 2)}${pad('Cell', W)}${lpad('n', 6)}${lpad('days', 6)}${lpad('mean', 8)}  range, all ${result.cells} cells counted`);
  const line = (label, r, markIt) => {
    const head = `${pad('', 2)}${pad(label, W)}${lpad(r.n, 6)}${lpad(r.days, 6)}`;
    if (r.tooFew) return `${head}${lpad('—', 8)}  ${r.why === 'spread' ? 'no spread between days, no range' : r.why === 'days' ? 'too few days to say' : 'too few to say'}`;
    const range = `${signed(r.lo)} to ${signed(r.hi)}`;
    const mark = markIt && r.clearsZero ? `clears zero, ${r.lo > 0 ? 'above' : 'below'}` : '';
    return `${head}${lpad(signed(r.mean), 8)}  ${pad(range, 18)}${mark}`.trimEnd();
  };
  const groupHead = (g) => (g === 'Higher timeframes' ? `Higher timeframes (${htfIds[0]} and ${htfIds[1]})` : g);
  // The baseline is never marked: it is not one of the cells.
  if (result.all) out.push(line('All trades', result.all, false));
  const outside = result.outside || {};
  const closeGroup = (g) => {
    if (outside[g] > 0) out.push(`${pad('', 2)}${pad('None of these', W)}${lpad(outside[g], 6)}  (not a cell)`);
    if (g === 'Buckets' && result.bucketsNeither) {
      const parts = BUCKETS.map((b) => {
        const { zero, abstained } = result.bucketsNeither[b];
        const bits = [zero && `${zero} at zero`, abstained && `${abstained} abstained`].filter(Boolean);
        return bits.length ? `${b} ${bits.join(', ')}` : null;
      }).filter(Boolean);
      if (parts.length) out.push(`${pad('', 2)}Neither way (not cells): ${parts.join('; ')}.`);
    }
  };
  let group = null;
  for (const r of result.rows) {
    if (r.group !== group) { if (group) closeGroup(group); group = r.group; out.push(groupHead(group)); }
    out.push(line(r.label, r, !journal));
  }
  if (group) closeGroup(group);

  // The family chance is alpha by construction (Bonferroni over the cells, a
  // t level per cell); it is not a fixed "1 in 20" sentence, and it does not
  // hold at all when the ranges ignore same-day overlap. The t level is exact
  // for normal results; on the desk's skewed R (a third at −1, a fifth at
  // +1.5) a simulation put a 30-trade cell at about 2.4 times its share and a
  // 200-trade cell at 1.3 times, hence the bracket.
  // The "about twice" was measured for cells near 30 trades; with a larger
  // minimum the excess is smaller (about a third more at 100 trades), so the
  // clause follows minN rather than claiming twice for every table.
  const small = result.minN <= 50
    ? `; somewhat more when many cells sit near the ${result.minN}-trade minimum: results as lopsided as a 1.5R target against a −1 stop clear by luck up to about twice as often in a cell that small`
    : `; a little more in cells near the ${result.minN}-trade minimum, because results as lopsided as a 1.5R target against a −1 stop are not spread like a bell curve`;
  const family = result.cluster === 'none'
    ? 'The chance of a false mark is not known here: these ranges ignore same-day overlap.'
    : result.alpha >= 0.75
      ? 'On a system with no edge at all, at least one is close to certain to clear by luck at this setting.'
      : `On a system with no edge at all, the chance of even one is ${oneIn(result.alpha)} when every cell rests on many days${small}.`;
  out.push(
    '',
    ...(journal ? [] : [`Cleared zero with all ${result.cells} cells counted: ${result.found} of ${result.cells}. ${family}`]),
    `Cleared zero at the ordinary 95%: ${result.foundAt95} of ${result.cells}, against ${result.expectedByChance.toFixed(1)} expected by chance alone.`,
    ...(!journal && result.all && result.all.clearsZero
      ? [`All trades together clear zero ${result.all.lo > 0 ? 'above' : 'below'} as well, so a cell clearing zero here mostly repeats the whole sample's average; it says little about the cell itself.`]
      : []),
    'A cell counts here only with at least '
      + `${result.minN} trades on at least ${result.minDays} days. The cells overlap (every trade sits in one regime, one hour band, one weekday and so on), so they are not ${result.cells} separate results.`,
    journal
      ? 'Using any cell to pick trades would change the method and would need a new sample of its own before anything could be said about it.'
      : 'Using any cell to pick trades would change the method: it ends the sample in progress and needs a new one of its own before anything can be said about it.',
  );
  return out.join('\n');
}

/**
 * The adapter desk/replay.mjs calls for --by-condition: one table per period
 * of the replay's alerts, by the cell each fired in.
 *   reads   the block's reads, made with desk/features-extra.mjs (the replay
 *           passes it when --by-condition is set): a lean's `extra.cond` is
 *           features.mjs conditionOf() for the side the engine leaned, which
 *           is the alert's side
 *   trades  the alerts reads.mjs alertPass sent ({ at, closeMs, r, ... })
 *   rule    the target rule they were judged under, for the title
 *   cfg, settings   the timeframe (for the higher timeframes' names)
 *   bars, block     accepted as the replay hands them; the table needs no bar
 * The replay has already decided whether held-back rows may be looked at (it
 * requires --holdout and records the look), so a 2025 or 2026 block is passed
 * with allowHeldBack. Rows after the holdout are the live journal's sample in
 * progress: they are counted and left out, never broken down (plan Part 3).
 * Returns the lines to print.
 */
export function conditionReport({ reads, trades, rule, cfg = null, settings = null } = {}) {
  if (!Array.isArray(reads) || !Array.isArray(trades)) throw new Error('conditionReport needs the replay\'s reads and trades');
  if (reads.some((r) => r.kind === 'lean') && !reads.some((r) => r.extra && 'cond' in r.extra)) {
    throw new Error('conditionReport: the reads carry no features. The replay makes them with desk/features-extra.mjs when --by-condition is set; these were made without it.');
  }
  const condAt = new Map(reads.map((r) => [r.closeMs, r.extra ? r.extra.cond ?? null : null]));
  const rows = trades.map((t) => ({ at: t.at, r: t.r, cond: condAt.get(t.closeMs) ?? null }));
  const tf = (settings && settings.timeframe) || (cfg && cfg.timeframe) || 'M15';
  const htfIds = tfInfo(tf).htf.map((x) => x.id);
  const parts = splitByPeriod(rows);
  const out = [];
  for (const period of ['dev', 'clean', 'seen']) {
    if (!parts[period].length) continue;
    const res = byCondition(parts[period], { allowHeldBack: period !== 'dev' });
    out.push(formatConditions(res, { title: `Alerts by condition (rule ${rule})`, htfIds }));
  }
  if (parts.fresh.length) {
    out.push(`${parts.fresh.length} alert${parts.fresh.length === 1 ? '' : 's'} after 14 October 2026 20:45 UTC left out: that is the live journal's committed sample in progress, which is not broken down by condition before it is complete.`);
  }
  if (!out.length) out.push(`Alerts by condition (rule ${rule}): no alerts in this block.`);
  return out.join('\n\n');
}
