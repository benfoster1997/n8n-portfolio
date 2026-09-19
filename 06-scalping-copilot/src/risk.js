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
