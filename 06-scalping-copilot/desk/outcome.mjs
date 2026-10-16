/**
 * desk/outcome.mjs — what happened to one trade after it was taken, on a feed's bars.
 *
 * Shared by the replay, the dataset the learner trains on, and the journal of
 * live alerts, so all three score a trade the same way:
 *   - a buy fills at the ask (bid + spread); its stop and target trigger on the
 *     bid. A sell fills at the bid; its stop and target trigger on the ask.
 *   - a bar that touches both the stop and the target counts as the stop
 *     (flagged `bothTouched`, so a finer feed can settle it later).
 *   - still open when the trading window closes: closed at that bar's close.
 * Results are in R after costs, where 1R is what the stop actually loses: a buy
 * pays the spread in its fill, so its stop loses stopDist + spread and its
 * target makes tp1Dist − spread; a sell pays the spread in exits that trigger
 * on the ask — sooner, but for exactly the distances.
 *
 * `mfe` and `mae` are how far the trade went for and against it before it
 * ended, in R, measured on the side its exits trigger on. They describe the
 * path; they are not a second result.
 */

/**
 * bars: the feed's bars ({t,o,h,l,c}); k: index of the bar whose close is the
 * entry; rec: { side: 'buy'|'sell', stopDist, tp1Dist }; spread and comm in
 * price units; closesAtMs: when the trading window closes for this trade;
 * tfMinutes: the bar length. Returns null when the bars run out first.
 */
export function outcome(bars, k, rec, { spread, comm, closesAtMs, tfMinutes }) {
  const buy = rec.side === 'buy';
  const entryBid = bars[k].c;
  const sl = buy ? entryBid - rec.stopDist : entryBid + rec.stopDist;
  const tp = buy ? entryBid + rec.tp1Dist : entryBid - rec.tp1Dist;
  const riskPx = (buy ? rec.stopDist + spread : rec.stopDist) + comm;
  const winPx = (buy ? rec.tp1Dist - spread : rec.tp1Dist) - comm;
  // The price the exits are measured from, on the side they trigger on.
  const ref = buy ? entryBid : entryBid + spread;
  let mfe = 0, mae = 0;
  for (let j = k + 1; j < bars.length; j++) {
    const b = bars[j];
    const lo = buy ? b.l : b.l + spread, hi = buy ? b.h : b.h + spread;   // the side the levels trigger on
    mfe = Math.max(mfe, (buy ? hi - ref : ref - lo) / riskPx);
    mae = Math.max(mae, (buy ? ref - lo : hi - ref) / riskPx);
    const hitSl = buy ? lo <= sl : hi >= sl;
    const hitTp = buy ? hi >= tp : lo <= tp;
    const path = { mfe: +mfe.toFixed(3), mae: +mae.toFixed(3) };
    if (hitSl) return { r: -1, how: 'stop', bars: j - k, bothTouched: hitTp, ...path };
    if (hitTp) return { r: winPx / riskPx, how: 'target', bars: j - k, bothTouched: false, ...path };
    if (b.t + tfMinutes * 60000 >= closesAtMs) {
      const exit = buy ? b.c : b.c + spread;
      const pnl = buy ? exit - (entryBid + spread) : entryBid - exit;
      return { r: (pnl - comm) / riskPx, how: 'window', bars: j - k, bothTouched: false, ...path };
    }
  }
  return null;
}
