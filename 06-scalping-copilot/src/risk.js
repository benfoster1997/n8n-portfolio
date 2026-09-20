/**
 * risk.js — position sizing, and the arithmetic that says whether a scalp is
 * worth taking at all.
 *
 * The second part matters more than the first. On a five-minute chart the
 * spread is not a rounding error: it is a fixed toll on every single trade,
 * and at gold's typical M5 range it can be a third of your target. Any tool
 * that shows a setup without showing that toll is flattering you.
 */

/**
 * Lot size from account risk.
 *
 *   lots = riskAmount / (stopDistance * valuePerUnitMovePerLot)
 *
 * stopDistance is in PRICE UNITS (dollars of gold, dollars of bitcoin), and
 * MUST already include the spread — you pay it on entry, so a 3.00 stop with a
 * 0.20 spread is really a 3.20 stop. `includeSpread` does that for you.
 *
 * Returns nulls with a `blocked` reason rather than a number it cannot stand
 * behind.
 */
export function positionSize({
  accountBalance,
  riskPercent,
  stopDistance,
  valuePerUnitMovePerLot,
  spread = 0,
  includeSpread = true,
  minLot = 0.01,
  lotStep = 0.01,
  maxLot = 100,
  accountCurrency = 'USD',
  quoteCurrency = 'USD',
  fxRate = 1,          // units of ACCOUNT currency per 1 unit of QUOTE currency
}) {
  const problems = [];
  if (!(accountBalance > 0)) problems.push('account balance not set');
  if (!(riskPercent > 0)) problems.push('risk % not set');
  if (!(stopDistance > 0)) problems.push('stop distance not set');
  if (!(valuePerUnitMovePerLot > 0)) problems.push('contract value not confirmed for this symbol');
  if (accountCurrency !== quoteCurrency && !(fxRate > 0)) {
    problems.push(`no ${quoteCurrency}/${accountCurrency} rate to convert the risk`);
  }
  if (problems.length) {
    return { lots: null, riskAmount: null, blocked: problems, effectiveStop: null };
  }

  const effectiveStop = includeSpread ? stopDistance + spread : stopDistance;
  const riskAmount = accountBalance * (riskPercent / 100);

  // Risk per lot is expressed in the QUOTE currency, so convert it into the
  // account currency before dividing.
  const riskPerLotQuote = effectiveStop * valuePerUnitMovePerLot;
  const riskPerLotAccount = riskPerLotQuote * fxRate;

  const raw = riskAmount / riskPerLotAccount;
  const stepped = Math.floor(raw / lotStep) * lotStep;
  const lots = Math.min(maxLot, Math.max(0, +stepped.toFixed(4)));

  const belowMin = lots < minLot;
  return {
    lots: belowMin ? 0 : lots,
    rawLots: +raw.toFixed(4),
    riskAmount: +riskAmount.toFixed(2),
    effectiveStop: +effectiveStop.toFixed(4),
    actualRisk: belowMin ? 0 : +(lots * riskPerLotAccount).toFixed(2),
    spreadCostAtSize: belowMin ? 0 : +(lots * spread * valuePerUnitMovePerLot * fxRate).toFixed(2),
    blocked: belowMin
      ? [`this stop needs ${raw.toFixed(3)} lots, below the ${minLot} minimum — the stop is too wide for the balance and risk %`]
      : [],
  };
}

/**
 * The win rate a setup must achieve merely to break even, once the spread is
 * paid on every trade.
 *
 *   Each win nets   (target - spread) ; each loss costs (stop + spread).
 *   Break-even p solves  p*(target - spread) = (1-p)*(stop + spread)
 *
 * This is the number that quietly kills most scalping. At 1:1 with a spread
 * worth a fifth of the stop you already need about 60%, not 50%.
 */
export function breakEvenWinRate(target, stop, spread = 0) {
  const win = target - spread;
  const loss = stop + spread;
  if (!(win > 0)) {
    return { rate: null, impossible: true, reason: 'the target does not clear the spread' };
  }
  if (!(loss > 0)) return { rate: null, impossible: true, reason: 'stop distance not set' };
  // Equivalent to the compact form p = (1 + c/S) / (1 + R), where c is the
  // round-trip cost in price units, S the stop distance and R the gross
  // reward:risk. Stated as win/loss here because that shows the mechanism.
  const grossR = target / stop;
  return {
    rate: +((loss / (win + loss)) * 100).toFixed(1),
    impossible: false,
    netR: +(win / loss).toFixed(2),
    grossR: +grossR.toFixed(2),
    // What it would be if the spread were free — the gap between the two IS
    // the spread's tax, and it is the number worth showing beside the answer.
    costlessRate: +((1 / (1 + grossR)) * 100).toFixed(1),
  };
}

/**
 * What the spread costs over a session of scalping — the number nobody
 * calculates before they start.
 */
export function spreadDrag({ spread, valuePerUnitMovePerLot, lots, tradesPerDay, daysPerMonth = 21 }) {
  const perTrade = spread * valuePerUnitMovePerLot * lots;
  return {
    perTrade: +perTrade.toFixed(2),
    perDay: +(perTrade * tradesPerDay).toFixed(2),
    perMonth: +(perTrade * tradesPerDay * daysPerMonth).toFixed(2),
  };
}

/** Distance in price units from entry to a stop expressed in ATR. */
export function atrStop(atrValue, multiple = 1.2) {
  return atrValue > 0 ? +(atrValue * multiple).toFixed(4) : null;
}

/** R-multiple of a target, net of the spread paid on entry. */
export function rMultiple(entry, stop, target, spread = 0) {
  const risk = Math.abs(entry - stop) + spread;
  const reward = Math.abs(target - entry) - spread;
  if (!(risk > 0)) return null;
  return +(reward / risk).toFixed(2);
}

/**
 * Margin required for a position, and what it leaves free.
 *
 * Position sizing from risk alone will happily hand you a trade you cannot
 * hold. Under the FCA's 20:1 cap on gold, a 1%-risk position on a modest
 * account can consume more than half the available margin — the sizing
 * formula has no idea, because margin is not a function of stop distance.
 */
export function marginRequired({ price, lots, contractSize, leverage, accountBalance, fxRate = 1 }) {
  if (!(price > 0) || !(lots > 0) || !(contractSize > 0) || !(leverage > 0)) return null;
  const notional = price * lots * contractSize * fxRate;
  const margin = notional / leverage;
  const pctOfAccount = accountBalance > 0 ? (margin / accountBalance) * 100 : null;
  return {
    notional: +notional.toFixed(2),
    margin: +margin.toFixed(2),
    pctOfAccount: pctOfAccount === null ? null : +pctOfAccount.toFixed(1),
    freeAfter: accountBalance > 0 ? +(accountBalance - margin).toFixed(2) : null,
    tight: pctOfAccount !== null && pctOfAccount > 40,
  };
}

/* ===========================================================================
   UK ACCOUNT MODELS
   ===========================================================================
   Two ways the same trade gets sized, and one constraint that binds before
   either of them does.
   =========================================================================== */

/**
 * Margin as a fraction of equity:   M/E = m * r / s
 *
 * where m is the margin factor (0.05 under the FCA's 20:1 cap on gold), r the
 * risk fraction, and s the stop expressed as a FRACTION OF PRICE.
 *
 * The striking property is what is absent: account size and the absolute price
 * both cancel. Margin depends only on how tight the stop is relative to price.
 *
 * And that is why this is the constraint that actually bites a scalper. A
 * $3.00 stop was 0.15% of price when gold was $2,000 and is 0.068% at $4,391 —
 * so the same nominal stop that once used a third of the account now uses
 * three quarters of it. The requirement tightens every time gold rises, which
 * is exactly the direction dollar rules of thumb fail in.
 */
export function marginFraction(marginFactor, riskFraction, stopFractionOfPrice) {
  if (!(stopFractionOfPrice > 0) || !(marginFactor > 0) || !(riskFraction > 0)) return null;
  return (marginFactor * riskFraction) / stopFractionOfPrice;
}

/** The tightest stop, in price units, that keeps margin under a ceiling. */
export function minStopForMargin(marginFactor, riskFraction, price, maxMarginFraction = 0.5) {
  if (!(price > 0) || !(maxMarginFraction > 0)) return null;
  return +((marginFactor * riskFraction / maxMarginFraction) * price).toFixed(4);
}

/**
 * Size one trade under both the spread bet and the CFD model at once, from a
 * single risk number, and check it against the margin ceiling.
 *
 * Both are returned because the tool cannot know which the user is on, and
 * showing both lets one sanity-check the other. They reconcile exactly before
 * rounding — verified to the penny — and differ afterwards only by however
 * much each was rounded down.
 *
 * `fxRate` is GBP/USD AS NORMALLY QUOTED (1.35 means one pound buys $1.35),
 * because that is the number read off a chart. Risk in the account currency is
 * MULTIPLIED by it to reach risk in the quote currency: £100 at 1.35 is $135.
 * Getting that direction backwards misstates the position by the square of the
 * rate, so it is stated here rather than left to the caller.
 */
export function sizeBothModels({
  equity,
  riskPercent,
  stopDistance,          // price units (dollars per ounce for gold)
  price,
  pointSize = 0.10,      // spread bet: USD of price per "point". FIRM-SPECIFIC.
  contractSize = 100,    // CFD: units per 1.00 lot
  marginFactor = 0.05,   // 0.05 = the FCA's 20:1 cap on gold
  fxRate = 1,            // quote currency per 1 unit of account currency
  accountCurrency = 'GBP',
  stakeStep = 0.10,
  minStake = 0.50,
  lotStep = 0.01,
  minLot = 0.01,
  spread = 0,
  commissionPerLotRoundTurn = 0,
  maxMarginFraction = 0.5,
}) {
  const blocked = [];
  if (!(equity > 0)) blocked.push('account equity not set');
  if (!(riskPercent > 0)) blocked.push('risk % not set');
  if (!(stopDistance > 0)) blocked.push('stop distance not set');
  if (!(price > 0)) blocked.push('no live price');
  if (!(pointSize > 0)) blocked.push('point size not confirmed — it is firm-specific and cannot be assumed');
  if (blocked.length) return { ok: false, blocked };

  const r = riskPercent / 100;
  const riskAccount = equity * r;
  // The spread is paid on entry, so it is part of the stop whether you like it
  // or not. Sizing against the raw stop quietly overshoots the risk budget.
  const effStop = stopDistance + spread;
  const s = effStop / price;

  /* ---- spread bet: staked in account currency per point, no FX on P&L ---- */
  const stopPoints = effStop / pointSize;
  const stakeRaw = riskAccount / stopPoints;
  const stake = Math.floor(stakeRaw / stakeStep) * stakeStep;
  const stakeOk = stake >= minStake;

  /* ---- CFD: sized in lots, P&L in the quote currency ---- */
  const riskQuote = riskAccount * fxRate;
  const perLotQuote = effStop * contractSize + commissionPerLotRoundTurn;
  const lotsRaw = riskQuote / perLotQuote;
  const lots = Math.floor(lotsRaw / lotStep) * lotStep;
  const lotsOk = lots >= minLot;

  /* ---- margin: identical under both, because notional is ---- */
  const notionalQuote = (riskQuote / effStop) * price;   // unrounded, model-free
  const marginQuote = notionalQuote * marginFactor;
  const marginAccount = marginQuote / fxRate;
  const marginPct = marginFraction(marginFactor, r, s);

  const overMargin = marginPct !== null && marginPct > maxMarginFraction;
  const minStop = minStopForMargin(marginFactor, r, price, maxMarginFraction);

  return {
    ok: true,
    effectiveStop: +effStop.toFixed(4),
    stopFractionOfPrice: +(s * 100).toFixed(4),
    riskBudget: +riskAccount.toFixed(2),

    spreadBet: {
      stake: +stake.toFixed(2),
      stakeRaw: +stakeRaw.toFixed(4),
      stopPoints: +stopPoints.toFixed(1),
      actualRisk: +(stake * stopPoints).toFixed(2),
      belowMinimum: !stakeOk,
      // Rounding DOWN is not fussiness: rounding £3.333 up to £3.50 turns a
      // 1% risk into 1.05% on every trade, silently and permanently.
      note: stakeOk ? null : `Below the ${accountCurrency} ${minStake.toFixed(2)} minimum stake. Either the stop is too tight or the risk % too small for this account.`,
    },

    cfd: {
      lots: +lots.toFixed(2),
      lotsRaw: +lotsRaw.toFixed(4),
      actualRisk: +((lots * perLotQuote) / fxRate).toFixed(2),
      belowMinimum: !lotsOk,
      note: lotsOk ? null : `Below the ${minLot} minimum lot.`,
    },

    margin: {
      amount: +marginAccount.toFixed(2),
      notional: +(notionalQuote / fxRate).toFixed(0),
      pctOfEquity: marginPct === null ? null : +(marginPct * 100).toFixed(1),
      ceiling: maxMarginFraction * 100,
      over: overMargin,
      minStopForCeiling: minStop,
      verdict: overMargin
        ? `This takes ${(marginPct * 100).toFixed(0)}% of the account in margin for one position. Risk sizing has no idea margin exists — a "safe" ${riskPercent}% trade can still leave you unable to hold anything else, and close to where a small adverse move starts forcing closures. A stop of at least ${minStop} (${((marginFactor * r / maxMarginFraction) * 100).toFixed(3)}% of price) brings it under ${maxMarginFraction * 100}%.`
        : null,
    },

    // The two models reconcile exactly before rounding. Showing both lets one
    // check the other, and the tool does not need to know which account it is.
    bridge: {
      stakeFromLots: +((lotsRaw * contractSize * pointSize) / fxRate).toFixed(2),
      lotsFromStake: +((stakeRaw * fxRate) / (contractSize * pointSize)).toFixed(3),
      reconciles: Math.abs((lotsRaw * contractSize * pointSize) / fxRate - stakeRaw) < 0.01,
    },
  };
}

/**
 * What the same risk budget produces under each point-size convention.
 *
 * Point size on gold is NOT standard — $0.01, $0.10 and $1.00 are all in live
 * use, and the stake number changes by 10x or 100x between them while margin
 * and notional do not. Showing all three side by side makes a mis-set value
 * obvious on sight rather than after the trade.
 */
export function stakeAcrossPointSizes(equity, riskPercent, stopDistance) {
  if (!(equity > 0) || !(riskPercent > 0) || !(stopDistance > 0)) return [];
  const risk = equity * (riskPercent / 100);
  return [0.01, 0.10, 1.00].map((p) => ({
    pointSize: p,
    stopPoints: +(stopDistance / p).toFixed(1),
    stake: +(risk / (stopDistance / p)).toFixed(2),
    perDollarMove: +((risk / (stopDistance / p)) / p).toFixed(2),
  }));
}
