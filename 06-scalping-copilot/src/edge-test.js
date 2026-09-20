/**
 * edge-test.js — whether a run of results means anything yet.
 *
 * This is the module that answers "when should I go live", and the answer is
 * almost always "later than you think", for a reason that is arithmetic rather
 * than caution.
 *
 * A scalper taking roughly fixed-R trades is running a Bernoulli sequence.
 * Distinguishing a real edge from a lucky streak is a hypothesis test, and the
 * sample size it needs scales with the INVERSE SQUARE of the effect you are
 * trying to detect. A 60% win rate at 1:1 separates from break-even in about
 * 180 trades. A 52% win rate — which is still profitable — needs over ten
 * thousand. Nobody's first hundred trades tell them anything.
 *
 * None of this is discouragement. It is the difference between running an
 * experiment and collecting anecdotes.
 */

/** Standard normal quantile (Acklam's rational approximation, ~1e-9 accurate). */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

const Z_ALPHA = invNorm(0.95);   // one-sided, 5%
const Z_POWER = invNorm(0.80);   // 80% power

/**
 * Break-even win rate, net of cost, expressed as a probability.
 * The null hypothesis is NOT 50% — it is whatever the costs make it.
 */
export function breakEvenRate(rewardRisk, costInRisk = 0) {
  if (!(rewardRisk > 0)) return null;
  const win = rewardRisk - costInRisk;
  const loss = 1 + costInRisk;
  if (win <= 0) return null;
  return loss / (win + loss);
}

/**
 * Trades needed to distinguish a true rate from break-even.
 *
 * The inverse-square scaling is the whole story: halving the edge you are
 * trying to detect quadruples the sample you need to see it.
 */
export function tradesNeeded(trueRate, breakEven) {
  if (!(trueRate > breakEven) || !(breakEven > 0) || !(breakEven < 1)) return null;
  const num = Z_ALPHA * Math.sqrt(breakEven * (1 - breakEven))
    + Z_POWER * Math.sqrt(trueRate * (1 - trueRate));
  return Math.ceil((num * num) / ((trueRate - breakEven) ** 2));
}

/**
 * What an observed record actually supports.
 *
 * The confidence interval is the point. Sixty percent over thirty trades sounds
 * like an edge and is statistically indistinguishable from a coin — the
 * interval runs from about 42% to 78%. The verdict here is deliberately
 * three-valued: a result can be evidence of an edge, evidence AGAINST one, or
 * simply not yet informative, and conflating the third with the second is how
 * working systems get abandoned.
 */
export function assessRecord({ trades, wins, rewardRisk = 1, costInRisk = 0 }) {
  if (!(trades > 0) || wins < 0 || wins > trades) return null;
  const be = breakEvenRate(rewardRisk, costInRisk);
  if (be === null) return { impossible: true, reason: 'the target does not clear the cost' };

  const p = wins / trades;
  const se = Math.sqrt(Math.max(p * (1 - p), 1e-12) / trades);
  const lo = Math.max(0, p - 1.96 * se);
  const hi = Math.min(1, p + 1.96 * se);

  // Expectancy in R, and its standard error — the honest version of "is this
  // working", since win rate alone says nothing without the payoff.
  const ev = p * (rewardRisk - costInRisk) - (1 - p) * (1 + costInRisk);
  const varPer = p * (rewardRisk - costInRisk) ** 2 + (1 - p) * (1 + costInRisk) ** 2 - ev ** 2;
  const evSe = Math.sqrt(Math.max(varPer, 0) / trades);

  let verdict, text;
  if (lo > be) {
    verdict = 'edge';
    text = `Across ${trades} trades this is above break-even with the interval clear of it. That is evidence of an edge, not proof of one — keep the sample growing.`;
  } else if (hi < be) {
    verdict = 'negative';
    text = `Across ${trades} trades the whole interval sits below the ${(be * 100).toFixed(1)}% you need. This is evidence the approach is not working as traded, which is worth more than another month of hoping.`;
  } else {
    const need = tradesNeeded(Math.max(p, be + 0.01), be);
    verdict = 'inconclusive';
    text = `${(p * 100).toFixed(0)}% over ${trades} trades is consistent with anything from ${(lo * 100).toFixed(0)}% to ${(hi * 100).toFixed(0)}%, and break-even is ${(be * 100).toFixed(1)}%. It is not yet distinguishable from luck in either direction.${need ? ` At this observed rate it would take roughly ${need} trades to separate them.` : ''}`;
  }

  return {
    trades, wins, observedRate: +p.toFixed(4),
    breakEven: +be.toFixed(4),
    ci: [+lo.toFixed(4), +hi.toFixed(4)],
    expectancyR: +ev.toFixed(4),
    expectancySe: +evSe.toFixed(4),
    expectancyClearOfZero: ev - 1.96 * evSe > 0,
    verdict, text,
  };
}

/**
 * The losing run to expect — so it is not mistaken for the system breaking.
 *
 * At a 55% win rate a seven-loss run is near-certain within 300 trades. A
 * trader who has not been told that will conclude, correctly by their own
 * evidence and wrongly in fact, that something has stopped working.
 */
export function expectedStreak(winRate, trades) {
  if (!(winRate > 0) || !(winRate < 1) || !(trades > 0)) return null;
  const q = 1 - winRate;
  const probAtLeast = (k) =>
    Math.min(1, 1 - (1 - (q ** k) * winRate) ** Math.max(0, trades - k + 1));

  const rows = [];
  for (let k = 3; k <= 15; k++) rows.push({ length: k, probability: +probAtLeast(k).toFixed(3) });
  // The longest run that is more likely than not — the one to actually brace for.
  const likely = rows.filter((r) => r.probability >= 0.5).map((r) => r.length).pop() || 0;
  return { rows, likelyWorst: likely, trades, winRate };
}

/** Calendar time for a sample, at a given trade frequency. */
export function timeToSample(trades, tradesPerDay, daysPerWeek = 5) {
  if (!(trades > 0) || !(tradesPerDay > 0)) return null;
  const days = trades / tradesPerDay;
  return {
    days: Math.ceil(days),
    weeks: +(days / daysPerWeek).toFixed(1),
    months: +(days / (daysPerWeek * 4.33)).toFixed(1),
  };
}
