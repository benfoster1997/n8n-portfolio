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

    // Commonly 100 troy ounces per standard lot, so a $1.00 move in the gold
    // price is $100 per lot. Micro/cent accounts differ.
    contractSize: { value: 100, unit: 'oz per 1.00 lot', confirm: true },

    // Most feeds quote gold to 2 decimals, so the smallest increment is 0.01.
    // Some quote 3. The tool reads this rather than assuming.
    digits: { value: 2, confirm: true },

    // Value of one full $1.00 move, per 1.00 lot, in the quote currency.
    dollarMoveValuePerLot: { value: 100, confirm: true },

    // Typical all-in spread by session, in dollars of gold price. Indicative
    // only — your broker's is the one that matters, and the tool measures the
    // live spread when it can rather than relying on this.
    typicalSpread: {
      asia: 0.45, london: 0.28, newYork: 0.25, rollover: 1.60,
      note: 'indicative at ~$4,400 gold; scales with price, so measure yours. Rollover ~21:00-23:00 UTC is when it widens worst.',
      confirm: true,
    },

    // The gold trading day rolls at 17:00 New York. Expressed as a local time
    // in a named zone so it follows DST: 21:00 UTC in summer, 22:00 in winter.
    vwapReset: { h: 17, tz: 'America/New_York' },

    minLot: { value: 0.01, confirm: true },
    lotStep: { value: 0.01, confirm: true },

    // Minimum sensible M5 scalp stop, as a FRACTION OF PRICE rather than a
    // dollar amount. Gold traded near $2,000 for years and most published
    // rules of thumb are still calibrated to that; it was ~$4,378 in
    // September 2026, having peaked at $5,602 in January. A hardcoded "$1.50
    // stop" silently halves in real terms every time gold reprices, so the
    // floor is expressed relatively and resolved against live price.
    // 0.05% of $4,378 is ~$2.19.
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
