/**
 * instruments.js — contract specifications.
 *
 * READ THIS BEFORE TRUSTING ANY NUMBER BELOW.
 *
 * Contract size, tick value and minimum lot are set by YOUR BROKER, not by the
 * market. They vary — materially — between brokers, and between account types
 * at the same broker. A "standard lot" of bitcoin is 1 BTC at some brokers and
 * 0.01 BTC at others. Getting this wrong scales every position size by 100.
 *
 * So everything marked `confirm: true` is a DEFAULT AWAITING CONFIRMATION, not
 * a fact. The tool shows these as unconfirmed until you have checked them
 * against your own platform, and the position-size calculator refuses to give
 * a lot size while a value it depends on is still unconfirmed.
 *
 * Where to check on the MT5 iPhone app:
 *   Quotes -> press and hold the symbol -> Specification.
 * Read off "Contract size", "Digits", "Tick size"/"Tick value" and
 * "Volume min / step".
 */

export const INSTRUMENTS = {
  XAUUSD: {
    id: 'XAUUSD',
    label: 'Gold',
    display: 'XAU/USD',
    quoteCurrency: 'USD',

    // CONFIRMED from the symbol specification, 20 September 2026.
    contractSize: { value: 100, unit: 'XAU per 1.00 lot', confirmed: true },
    digits: { value: 2, confirmed: true },

    // Digits 2 means one point is $0.01, so $1.00 of gold is 100 points and a
    // $1.00 move is $100 per 1.00 lot. The 3-digit variant would make every
    // point value a tenth of this — which is why it was worth checking.
    dollarMoveValuePerLot: { value: 100, confirmed: true },

    // Margin is LEVERAGE-DERIVED here, not a fixed percentage. The spec says
    // Calculation: Forex and Margin currency: XAU, which is what made the
    // "Initial margin: 100" row look impossible — it is 100 OUNCES, the
    // contract size, not 100 dollars. Under MT5's Forex mode:
    //
    //     margin per lot = contractSize / leverage, in ounces
    //                    -> converted to the account currency at the gold price
    //
    // At 1:20 that is 5 oz = $21,875 a lot at $4,375 gold, which is exactly 5%
    // of the $437,500 notional. So the account's leverage setting is what
    // decides margin, and the tool asks for that rather than a percentage.
    marginCurrency: 'XAU',
    marginCalculation: 'forex',

    // Floating. Observed at $0.05 (bid 4375.00 / ask 4375.05), which is tight
    // enough to imply a commission-charging account.
    typicalSpread: {
      observed: 0.05,
      note: 'floating; observed $0.05 in a quiet hour. Expect it to widen sharply at 13:30 London.',
      confirmed: true,
    },

    // The chart is drawn from BID prices, which creates an asymmetry worth
    // knowing about on shorts. See chartIsBid below.
    chartIsBid: true,

    // CONFIRMED: zero. The broker imposes no minimum distance between price
    // and a stop, so nothing will be rejected for being too tight — and there
    // is correspondingly no safety net against placing one inside the noise.
    stopsLevel: { value: 0, confirmed: true },

    vwapReset: { h: 17, tz: 'America/New_York' },
    minLot: { value: 0.01, confirmed: true },
    lotStep: { value: 0.01, confirmed: true },

    minStopPct: 0.0005,
    tradesAroundTheClock: false,
    symbolAliases: ['XAUUSD', 'GOLD', 'XAUUSD.m', 'XAUUSD.pro', 'XAUUSD.r', 'GOLD.spot'],
    decimalsForDisplay: 2,
  },

  BTCUSD: {
    id: 'BTCUSD',
    label: 'Bitcoin',
    display: 'BTC/USD',
    quoteCurrency: 'USD',

    // THE most broker-dependent number in this file. 1 lot = 1 BTC is common
    // but far from universal.
    contractSize: { value: 1, unit: 'BTC per 1.00 lot', confirm: true },
    digits: { value: 2, confirm: true },
    dollarMoveValuePerLot: { value: 1, confirm: true },

    // CFD spreads on bitcoin are wide and are the dominant cost of scalping it.
    typicalSpread: {
      asia: 28, london: 22, newYork: 20, rollover: 60,
      note: 'CFD markup is far wider than spot-exchange spread; measure yours',
      confirm: true,
    },

    // Bitcoin anchors to the 00:00 UTC day used by every crypto venue.
    vwapReset: 0,

    minLot: { value: 0.01, confirm: true },
    lotStep: { value: 0.01, confirm: true },

    // 0.15% of $95,000 is ~$143. Same reasoning as gold: bitcoin has traded
    // between $16k and six figures within a few years, so an absolute floor
    // is meaningless across regimes.
    minStopPct: 0.0015,
    tradesAroundTheClock: true,
    symbolAliases: ['BTCUSD', 'BTCUSD.m', 'BITCOIN', 'BTCUSD.pro', 'BTC/USD'],
    decimalsForDisplay: 1,
  },
};

/** Which values still need the user's confirmation, for the settings screen. */
export function unconfirmedFields(inst, confirmed = {}) {
  const out = [];
  for (const [key, val] of Object.entries(inst)) {
    if (val && typeof val === 'object' && val.confirm === true && !confirmed[key]) {
      out.push({ key, current: val.value ?? val, unit: val.unit || null });
    }
  }
  return out;
}

/** Read a spec value, whether or not the user has overridden it. */
export function spec(inst, key, overrides = {}) {
  if (overrides[key] !== undefined && overrides[key] !== null) return overrides[key];
  const v = inst[key];
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

/**
 * The minimum sensible stop for this instrument at the current price.
 * Resolved live rather than stored, so it cannot go stale as price reprices.
 */
export function minStop(inst, price) {
  return price > 0 ? price * inst.minStopPct : 0;
}

/**
 * Margin per lot, derived from the account's leverage rather than a percentage.
 *
 * This is the right model for a symbol whose specification says
 * Calculation: Forex with a margin currency of XAU: margin is
 * contractSize / leverage OUNCES, converted at the current gold price. The
 * equivalent percentage is simply 1/leverage, but deriving it this way means
 * the number tracks the live price the way the broker's own does.
 */
export function marginPerLot(contractSize, leverage, price) {
  if (!(contractSize > 0) || !(leverage > 0) || !(price > 0)) return null;
  const ounces = contractSize / leverage;
  return {
    units: +ounces.toFixed(4),
    amount: +(ounces * price).toFixed(2),
    asFraction: 1 / leverage,
  };
}

/**
 * The bid-chart asymmetry.
 *
 * When the chart is drawn from bid prices — which this one is — a long and a
 * short do not behave symmetrically against the levels you draw:
 *
 *   LONG  opens at the ASK (above the candle you can see) and its stop and
 *         target are checked against the BID, so they line up with the chart.
 *
 *   SHORT opens at the BID (on the candle) but its stop and target are checked
 *         against the ASK, which sits a spread above. So a short's stop fires
 *         when the chart is still a spread short of the drawn level, and its
 *         target needs the chart to travel a spread further than drawn.
 *
 * It is only the spread being paid, in both cases. But on a short it is paid
 * somewhere you cannot see it, which is why a stop can appear to be hit
 * "before price got there".
 */
export function bidChartNote(side, spread, digits = 2) {
  if (!spread || spread <= 0) return null;
  if (side === 'buy') {
    return {
      side,
      aligned: true,
      text: `Your chart is drawn from bid prices. A long fills at the ask, about ${spread.toFixed(digits)} above the candle, but its stop and target are checked against the bid — so both levels line up with what you see.`,
    };
  }
  return {
    side,
    aligned: false,
    text: `Your chart is drawn from bid prices, and a short's stop and target are checked against the ASK. So the stop fires when the chart is still about ${spread.toFixed(digits)} short of the level you drew, and the target needs the chart to travel about ${spread.toFixed(digits)} past it. Nothing is wrong when that happens — it is the spread, paid where the chart does not show it.`,
  };
}
