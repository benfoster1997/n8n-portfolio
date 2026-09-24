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
    maxVolume: { value: 100, unit: 'lots per order', confirmed: true },

    // CONFIRMED 24 Sep 2026 — and it contradicts the assumption that a demo
    // charges nothing. The specification lists "Instant by deal volume, in/out
    // deals: 2.75 GBP per lot", i.e. charged on BOTH the opening and the
    // closing deal. So a round turn is £5.50 a lot, about $7.40.
    commission: { perSide: 2.75, currency: 'GBP', confirmed: true },

    // Swap in POINTS: -60.891 points on a long is 60.891 x $0.01 x 100 oz,
    // about $60.89 per lot per night. Shorts EARN 42.602 points. Charged
    // Mon-Fri with Wednesday tripled for the weekend: seven charges a week.
    swap: { mode: 'points', long: -60.891, short: 42.602, chargesPerWeek: 7, tripleDay: 'Wednesday', confirmed: true },

    // Trading session in SERVER time: 01:02-23:59, Friday to 23:57. The gap
    // 00:00-01:02 is the daily gold break, which is 17:00-18:00 New York —
    // so server time is New York + 7 hours, which is UTC+3 while the US is on
    // daylight time. That confirms the server offset without a chart screenshot.
    sessionServer: { open: '01:02', close: '23:59', fridayClose: '23:57', confirmed: true },

    // Margin shown by the broker: ~£647 per lot (Initial = Maintenance, on
    // notional). At ~$4,340 gold and GBP/USD ~1.34 that is 0.2% of notional,
    // which is exactly what contractSize / 500 gives. It corroborates 1:500.
    unitLabel: 'oz',

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

    // CONFIRMED from the symbol specification, 24 September 2026. This was the
    // most broker-dependent number in the file — 1 lot is 1 BTC at some
    // brokers and a fraction of one at others — and here it is 1 BTC.
    contractSize: { value: 1, unit: 'BTC per 1.00 lot', confirmed: true },
    digits: { value: 2, confirmed: true },
    dollarMoveValuePerLot: { value: 1, confirmed: true },

    // CFD spreads on bitcoin are wide and are the dominant cost of scalping it.
    // Still UNMEASURED on this account — no bid/ask screenshot yet.
    typicalSpread: {
      asia: 28, london: 22, newYork: 20, rollover: 60,
      note: 'CFD markup is far wider than spot-exchange spread; measure yours',
      confirm: true,
    },

    // Bitcoin anchors to the 00:00 UTC day used by every crypto venue.
    vwapReset: 0,

    minLot: { value: 0.01, confirmed: true },
    lotStep: { value: 0.01, confirmed: true },

    // A tenth of gold's cap. At demo scale a 1%-risk bitcoin position runs to
    // hundreds of lots, which is dozens of separate tickets at 10 each.
    maxVolume: { value: 10, unit: 'lots per order', confirmed: true },
    stopsLevel: { value: 0, confirmed: true },

    // No commission section appears on the bitcoin specification, unlike
    // gold's. On this account the cost of trading bitcoin is in the spread.
    commission: { perSide: 0, currency: 'GBP', confirmed: true },

    // Swap in PERCENTAGE terms of the current price, per year: -20% on a long,
    // zero on a short, charged every night INCLUDING weekends. MT5 computes
    // this over a 360-day bank year, so about 0.056% of the position a night —
    // roughly $44 per lot at $80,000. Irrelevant flat by 16:00; brutal if not.
    swap: { mode: 'percent', long: -20, short: 0, chargesPerWeek: 7, confirmed: true },

    chartIsBid: true,
    marginCurrency: 'USD',
    marginCalculation: 'contracts',
    // Margin per lot NOT yet read — the rows sit below where the screenshot
    // stopped. Leverage on bitcoin is usually far lower than on gold.

    minStopPct: 0.0015,
    tradesAroundTheClock: true,
    symbolAliases: ['BTCUSD', 'BTCUSD.m', 'BITCOIN', 'BTCUSD.pro', 'BTC/USD'],
    decimalsForDisplay: 1,
    unitLabel: 'BTC',
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

/**
 * Commission for one round turn per lot, in the QUOTE currency (USD), which
 * is what the sizing and cost models work in.
 *
 * Brokers quote commission however they like. This one shows it in GBP, per
 * lot, per SIDE — charged on the entry deal and again on the exit — so the
 * round turn is double the figure on the screen, and has to be converted
 * before it can be added to a dollar spread. `gbpusd` is the rate as normally
 * quoted (1.34 = one pound buys $1.34), so pounds multiply into dollars.
 *
 * `overridePerSide` lets the user replace the broker's figure; pass null or
 * undefined to use it. Zero is a real override, not "use the default".
 */
export function commissionRoundTurnQuote(inst, gbpusd, overridePerSide = null) {
  const c = inst && inst.commission;
  const perSide = overridePerSide !== null && overridePerSide !== undefined && overridePerSide !== ''
    ? Number(overridePerSide)
    : (c ? c.perSide : 0);
  if (!(perSide >= 0) || !Number.isFinite(perSide)) return null;
  const currency = c ? c.currency : 'USD';
  const toQuote = currency === 'GBP' ? (gbpusd > 0 ? gbpusd : null) : 1;
  if (toQuote === null) return null;
  return +(perSide * 2 * toQuote).toFixed(4);
}

/**
 * What holding a position overnight costs, per lot per night, in USD. Positive
 * is paid TO you, negative is charged.
 *
 * Two different conventions, and the tool has to speak both:
 *   points  - a fixed number of price points: swap x 10^-digits x contract size
 *   percent - an annual percentage of the CURRENT price, over MT5's 360-day
 *             bank year, so it grows as the price does
 */
export function swapPerNight(inst, price, side = 'long') {
  const sw = inst && inst.swap;
  if (!sw) return null;
  const rate = side === 'short' ? sw.short : sw.long;
  const contract = spec(inst, 'contractSize');
  if (sw.mode === 'points') {
    const point = 10 ** -spec(inst, 'digits');
    return +(rate * point * contract).toFixed(2);
  }
  if (sw.mode === 'percent') {
    if (!(price > 0)) return null;
    return +((price * contract * (rate / 100)) / 360).toFixed(2);
  }
  return null;
}
