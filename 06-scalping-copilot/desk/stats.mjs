/**
 * desk/stats.mjs — the replay's arithmetic, kept apart so it is tested on its own.
 *
 * Alerts on the same day share one market, so their results are not
 * independent: a range that treats them as independent is too narrow. The
 * range here is clustered by day — each day's deviations from the average are
 * summed before squaring (the usual cluster-robust standard error, without a
 * small-sample correction). Trades are { at: 'YYYY-MM-DDTHH:MM' (UTC), r }.
 */
export function clusteredByDay(trades) {
  const n = trades.length;
  if (!n) return null;
  const mean = trades.reduce((s, t) => s + t.r, 0) / n;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.r - mean) ** 2, 0) / (n - 1)) : 0;
  const days = new Map();
  for (const t of trades) { const d = t.at.slice(0, 10); days.set(d, (days.get(d) || 0) + (t.r - mean)); }
  const seDay = Math.sqrt([...days.values()].reduce((s, x) => s + x * x, 0)) / n;
  return {
    n, mean, sd, days: days.size, seDay,
    range: [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)],
    clustered: [mean - 1.96 * seDay, mean + 1.96 * seDay],
  };
}
