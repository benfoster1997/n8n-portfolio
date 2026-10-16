/**
 * desk/conditions.mjs — the replay's "--by-condition" table (LEARNING-PLAN.md, Part 2).
 *
 * A developer report, never a user-facing one. It splits past alerts by the
 * conditions they fired in — the engine's regime, its confidence word, whether
 * H1 and H4 agreed, the sign of each scoring bucket, the London hour band, the
 * weekday and the side — and gives each split the average result in R, how
 * many trades it holds, and a range around that average.
 *
 * The danger in a table like this is that it is 32 questions asked at once.
 * Ask 32 questions of pure noise at the usual 95% and about 1.6 of them come
 * back "significant" — someone reading the table then has a "finding" that is
 * nothing but the number of rows. So, as the plan declares:
 *   - a cell is marked only when its range clears zero at the Bonferroni z for
 *     every cell in the table (3.16 for 32), so the chance that ANY cell is
 *     marked on an edgeless system is about 1 in 20, not about 4 in 5;
 *   - the number of cells expected to clear the ordinary 95% by chance is
 *     printed next to the number that did, so a reader sees "1.6 expected,
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
 * Input trades are { at: 'YYYY-MM-DDTHH:MM' (UTC), r, cond }, where `cond`
 * comes from features.mjs conditionOf(): { regime, confidenceLabel, h1, h4,
 * agree, buckets: { trend, momentum, structure, location, volume, volatility }
 * (each −1, 0 or +1), hourBand ('08-10'|'10-12'|'12-14'|'14-16', London),
 * weekday ('Mon'..'Fri'), side ('buy'|'sell') }.
 */
import { clusteredByDay } from './stats.mjs';

/**
 * The held-back years start here (plan rule 2). This module aggregates, so it
 * refuses held-back rows unless the caller says it may use them — the replay
 * decides that (after model.json records the final run, or for the 2026
 * window marked "already seen"); this is only a second lock on the same door.
 */
export const HOLDOUT_FROM = '2025-01-01';

const MULTI_YEAR_CAVEAT = 'Before 2025 there is no news calendar, so these years include trades around releases that the live desk would have sat out.';

// The engine's own names (src/signal-engine.js detectRegime and the
// confidenceLabel in analyse()). The plan's "confidence ×3" is low / moderate /
// firm. A low-confidence idea is refused by checkPlan(), so on alerts that cell
// will normally be empty and say "too few to say"; it is still counted in the
// Bonferroni total, because it was one of the questions declared in advance.
const REGIMES = ['trending', 'ranging', 'mixed', 'compressed'];
const CONFIDENCE = ['low', 'moderate', 'firm'];
const BUCKETS = ['trend', 'momentum', 'structure', 'location', 'volume', 'volatility'];
const HOUR_BANDS = ['08-10', '10-12', '12-14', '14-16'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

/**
 * The cells, in the order the table prints them. Each is
 * { id, group, label, test(cond) → boolean }. A bucket's sign is whatever
 * conditionOf() hands over; the labels say "positive" and "negative" rather
 * than "for the trade" so they stay true whichever way it is signed. A bucket
 * at 0 (including volume abstaining) falls in neither of its two cells; a
 * value the table does not know (a new regime name, a missing H1) falls in no
 * cell of that group, and the group's cells then add up to fewer than the
 * total — which the table shows rather than hides.
 */
export const CELLS = Object.freeze([
  ...REGIMES.map((v) => ({ id: `regime:${v}`, group: 'Regime', label: `${v[0].toUpperCase()}${v.slice(1)}`, test: (c) => c.regime === v })),
  ...CONFIDENCE.map((v) => ({ id: `confidence:${v}`, group: 'Confidence', label: `${v[0].toUpperCase()}${v.slice(1)}`, test: (c) => c.confidenceLabel === v })),
  { id: 'htf:agree', group: 'H1 and H4', label: 'Agree', test: (c) => c.agree === true },
  { id: 'htf:differ', group: 'H1 and H4', label: 'Do not agree', test: (c) => c.agree === false },
  ...BUCKETS.flatMap((b) => [
    { id: `${b}:+`, group: 'Buckets', label: `${b[0].toUpperCase()}${b.slice(1)} positive`, test: (c) => !!c.buckets && c.buckets[b] > 0 },
    { id: `${b}:-`, group: 'Buckets', label: `${b[0].toUpperCase()}${b.slice(1)} negative`, test: (c) => !!c.buckets && c.buckets[b] < 0 },
  ]),
  ...HOUR_BANDS.map((v) => ({ id: `hour:${v}`, group: 'Hour (London)', label: `${v.slice(0, 2)}:00 to ${v.slice(3)}:00`, test: (c) => c.hourBand === v })),
  ...WEEKDAYS.map((v) => ({ id: `weekday:${v}`, group: 'Weekday', label: DAY_NAMES[v], test: (c) => c.weekday === v })),
  { id: 'side:buy', group: 'Side', label: 'Buy alerts', test: (c) => c.side === 'buy' },
  { id: 'side:sell', group: 'Side', label: 'Sell alerts', test: (c) => c.side === 'sell' },
].map((c) => Object.freeze(c)));

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

/**
 * The z that keeps the chance of ANY of `cells` two-sided tests clearing zero
 * by luck at `alpha`: 1.96 for one cell, 3.16 for 32.
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
 *   z                defaults to bonferroniZ(CELLS.length).
 *   cluster ('day')  'none' treats trades as independent. Only for showing how
 *                    much narrower — and wronger — that makes the ranges.
 *   allowHeldBack    false refuses any trade on or after HOLDOUT_FROM.
 * Returns {
 *   rows: [{ cell, group, label, n, days, mean, lo, hi, tooFew, clearsZero,
 *            clearsAt95 }],  one per CELLS entry, same order;
 *   all: { n, days, mean, lo, hi, tooFew, clearsZero, clearsAt95 } — every trade, the
 *   baseline the cells are read against (not a cell, not counted);
 *   cells, z, expectedByChance (cells × 0.05: how many would clear the
 *   ordinary 95% on noise), found (cells marked at z), foundAt95 (cells whose
 *   ordinary 95% range clears zero — compare with expectedByChance),
 *   trades, days, from, to, minN, minDays, cluster }.
 * lo/hi are mean ± z × (day-clustered standard error); clearsZero means the
 * whole of that range is above zero or the whole is below.
 */
export function byCondition(trades, { minN = 30, minDays = 10, z = bonferroniZ(CELLS.length), cluster = 'day', allowHeldBack = false } = {}) {
  if (cluster !== 'day' && cluster !== 'none') throw new Error(`cluster must be 'day' or 'none', not ${cluster}`);
  const usable = trades.filter((t) => t && t.cond && Number.isFinite(t.r) && typeof t.at === 'string');
  if (!allowHeldBack) {
    const late = usable.find((t) => t.at.slice(0, 10) >= HOLDOUT_FROM);
    if (late) throw new Error(`Trade at ${late.at} is in the held-back years (from ${HOLDOUT_FROM}). The by-condition table does not look at them until the replay says it may.`);
  }
  const ats = usable.map((t) => t.at).sort();

  // One set of trades → its count, days, average and the two ranges.
  const summarise = (these) => {
    const st = clusteredByDay(these);
    const n = these.length, days = st ? st.days : 0;
    if (n < minN || days < minDays) return { n, days, mean: null, lo: null, hi: null, tooFew: true, clearsZero: false, clearsAt95: false };
    const se = cluster === 'day' ? st.seDay : st.sd / Math.sqrt(n);
    const lo = st.mean - z * se, hi = st.mean + z * se;
    const lo95 = st.mean - 1.96 * se, hi95 = st.mean + 1.96 * se;
    return { n, days, mean: st.mean, lo, hi, tooFew: false, clearsZero: lo > 0 || hi < 0, clearsAt95: lo95 > 0 || hi95 < 0 };
  };

  const rows = CELLS.map((cell) => ({
    cell: cell.id, group: cell.group, label: cell.label,
    ...summarise(usable.filter((t) => cell.test(t.cond))),
  }));

  // The whole sample on the same footing, printed above the cells and not
  // counted among them. A cell's test is "is its average away from zero", not
  // "is it different from the rest": if every trade averaged +0.2R, most cells
  // would clear zero for that reason alone. The baseline makes that visible.
  const all = summarise(usable);

  return {
    rows,
    all,
    cells: CELLS.length,
    z,
    expectedByChance: CELLS.length * 0.05,
    found: rows.filter((r) => r.clearsZero).length,
    foundAt95: rows.filter((r) => r.clearsAt95).length,
    trades: usable.length,
    days: new Set(usable.map((t) => t.at.slice(0, 10))).size,
    from: ats[0] || null,
    to: ats[ats.length - 1] || null,
    minN, minDays, cluster,
  };
}

/** "about 1 to 2" for 1.6; "about 3" for 3; "less than 1" below one. */
function aboutHowMany(x) {
  if (x < 1) return 'less than 1';
  if (Number.isInteger(x)) return `about ${x}`;
  return `about ${Math.floor(x)} to ${Math.ceil(x)}`;
}

const signed = (x, dp = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}`;
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

/** The opening warning, worded from the result so it never drifts from it. */
export function headerWarning(result) {
  return `Developer report — ${aboutHowMany(result.expectedByChance)} of these cells will clear zero by chance at 95%; `
    + `a cell is only marked when it clears zero at z = ${result.z.toFixed(2)} (all ${result.cells} cells counted). `
    + 'None of these is a rule to trade by.';
}

/**
 * The table as text, for the developer's terminal or HANDOFF — never for the
 * user, never on an alert (plan rules 3 and 7). Options: title (first line);
 * multiYear ('auto') adds the plan's rule-8 caveat when any trade is before
 * 2025, true always adds it, false leaves it to the caller.
 */
export function formatConditions(result, { title = 'Alerts by condition', multiYear = 'auto' } = {}) {
  const out = [title, headerWarning(result)];
  const before2025 = result.from && result.from.slice(0, 10) < HOLDOUT_FROM;
  if (multiYear === true || (multiYear === 'auto' && before2025)) out.push(MULTI_YEAR_CAVEAT);
  out.push(
    `${result.trades} trades on ${result.days} days${result.from ? `, ${result.from.slice(0, 10)} to ${result.to.slice(0, 10)}` : ''}. `
    + `Results in R (1 = the risk). Ranges are clustered by day${result.cluster === 'none' ? ' — NOT HERE: this run treats every trade as independent, so its ranges are too narrow' : ''}.`,
    '',
  );

  const W = Math.max(...result.rows.map((r) => r.label.length), 4) + 2;
  const rangeHead = `range at z = ${result.z.toFixed(2)}`;
  out.push(`${pad('', 2)}${pad('Cell', W)}${lpad('n', 6)}${lpad('days', 6)}${lpad('mean', 8)}  ${rangeHead}`);
  const line = (label, r, markIt) => {
    const head = `${pad('', 2)}${pad(label, W)}${lpad(r.n, 6)}${lpad(r.days, 6)}`;
    if (r.tooFew) return `${head}${lpad('—', 8)}  too few to say`;
    const range = `${signed(r.lo)} to ${signed(r.hi)}`;
    const mark = markIt && r.clearsZero ? `clears zero, ${r.lo > 0 ? 'above' : 'below'}` : '';
    return `${head}${lpad(signed(r.mean), 8)}  ${pad(range, 18)}${mark}`.trimEnd();
  };
  // The baseline is never marked: it is not one of the cells.
  if (result.all) out.push(line('All trades', result.all, false));
  let group = null;
  for (const r of result.rows) {
    if (r.group !== group) { group = r.group; out.push(group); }
    out.push(line(r.label, r, true));
  }

  out.push(
    '',
    `Cleared zero at z = ${result.z.toFixed(2)}: ${result.found} of ${result.cells}. On a system with no edge at all, the chance of even one is about 1 in 20.`,
    `Cleared zero at the ordinary 95%: ${result.foundAt95} of ${result.cells}, against ${result.expectedByChance.toFixed(1)} expected by chance alone.`,
    ...(result.all && result.all.clearsZero
      ? [`All trades together clear zero ${result.all.lo > 0 ? 'above' : 'below'} as well, so a cell clearing zero here mostly repeats the whole sample's average; it says little about the cell itself.`]
      : []),
    'A cell counts here only with at least '
      + `${result.minN} trades on at least ${result.minDays} days. The cells overlap (every trade sits in one regime, one hour band, one weekday and so on), so they are not ${result.cells} separate results.`,
    'Using any cell to pick trades would change the method: it ends the sample in progress and needs a new one of its own before anything can be said about it.',
  );
  return out.join('\n');
}
