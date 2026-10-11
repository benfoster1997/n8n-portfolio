/**
 * timeframes.js — what changes with the chart's candle length.
 *
 * M15 is the default from 11 Oct 2026, at the user's choice; M5 is kept. A
 * Thorough screenshot read takes about two minutes, plus the screenshot and
 * the typing: close to half of a five-minute candle, a small part of a
 * fifteen-minute one. And a wider stop makes bitcoin's fixed $6 spread a
 * smaller share of each trade.
 *
 * One table, read by the screenshot checks (shot.js), the live engine
 * (signal-engine.js) and the in-chat desk, so none of them can disagree.
 *
 *  - noiseScale  the noise part of every stop floor. Over a random walk a
 *                candle's range grows with the square root of its length, so
 *                an M15 candle is about √3 ≈ 1.7× an M5 one.
 *  - maxAgeMin   how long a screenshot analysis may feed a ticket: three M5
 *                candles, but two M15 candles, not three. 45 minutes would
 *                match M5's drift against the stop, but the structure the
 *                readers saw changes too, and a two-minute read does not need
 *                the time.
 *  - staleChartMin  a screenshot whose last candle is this far behind the
 *                chart clock is an old one.
 *  - newsSoonMin a major release this close is a caution: a trade opened now
 *                may still be open when it lands, and M15 trades last longer.
 *  - newsAheadMin how far ahead the readers are told about releases.
 *  - barsPerHour, widthLookbackBars, htf   for the live engine: "the last
 *                hour" in bars, the Bollinger-width history (eight hours on
 *                either), and the two higher timeframes its bias is read from
 *                (the next two up: M15 and H1 for M5, H1 and H4 for M15).
 *
 * Deliberately not scaled: the cost part of the floor (a trade costs the same
 * on any chart), the price tolerance and the drift warning (already fractions
 * of the stop), the gate's clock rules, and the final stretch (decision 1 is
 * about the session's end, not the candle).
 */
export const TIMEFRAMES = {
  M5: {
    id: 'M5', minutes: 5, words: 'five-minute', noiseScale: 1,
    maxAgeMin: 15, staleChartMin: 15, newsSoonMin: 30, newsAheadMin: 90,
    barsPerHour: 12, widthLookbackBars: 96, htf: [{ id: 'M15', minutes: 15 }, { id: 'H1', minutes: 60 }],
  },
  M15: {
    id: 'M15', minutes: 15, words: 'fifteen-minute', noiseScale: Math.sqrt(3),
    maxAgeMin: 30, staleChartMin: 30, newsSoonMin: 60, newsAheadMin: 180,
    barsPerHour: 4, widthLookbackBars: 32, htf: [{ id: 'H1', minutes: 60 }, { id: 'H4', minutes: 240 }],
  },
};
export const DEFAULT_TIMEFRAME = 'M15';

/** A timeframe as typed — "M15", "m5", "15", "5m", "5 min" — → 'M5' / 'M15', or null for anything else. */
export function timeframeOf(x) {
  const s = String(x ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^M?(\d+)(M|MIN|MINS|MINUTE|MINUTES)?$/);
  const id = m ? `M${Number(m[1])}` : null;
  return id && TIMEFRAMES[id] ? id : null;
}

/** A timeframe's settings; anything unrecognised gets the default's. */
export const tfInfo = (tf) => TIMEFRAMES[timeframeOf(tf)] || TIMEFRAMES[DEFAULT_TIMEFRAME];
