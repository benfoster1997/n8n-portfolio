#!/usr/bin/env node
/**
 * replay.mjs — the watcher, run over past bars, with what happened next.
 *
 * Why this exists. The engine had never been tested against outcomes. Before
 * the user relies on live alerts, this replays a stretch of history through
 * exactly what the watcher does (desk/live.mjs liveRead: gate, engine,
 * checkPlan, the alert cooldown) at every bar close inside the trading
 * window, and follows each alert forward on the same bars:
 *   - a buy fills at the ask (bid + spread); its stop and target trigger on
 *     the bid. A sell fills at the bid; its stop and target trigger on the ask.
 *   - a bar that touches both the stop and the target counts as the stop.
 *   - still open when the window closes: closed at that bar's close.
 * Results are in R (one R = the stop distance plus the spread), after the
 * spread and any commission.
 *
 * What it is not. A reference feed's bars, not the broker's; no slippage, no
 * partial fills, no weekend spreads (the watcher is silent then anyway). The
 * news calendar covers 2026 only, so earlier history would miss blackouts.
 * One stretch of one market: an average with its uncertainty, not a promise.
 *
 *   node desk/replay.mjs --pair bitcoin --from 2026-01-01 [--to 2026-10-11] [--rule level|1.5R|2R]
 *
 * History is cached under $SCALP_DESK_HOME/history/.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { liveRead, shouldAlert, COOLDOWN_BARS } from './live.mjs';
import { withDefaults, pairOf, costFor } from './lib.mjs';
import { windowState } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { INSTRUMENTS } from '../src/instruments.js';

if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(r.status ?? 1);
}

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const HOME = process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');
const pair = pairOf(arg('pair', 'bitcoin'));
const cfg = withDefaults(JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')));
const tf = tfInfo(cfg.timeframe);
const fromMs = Date.parse(arg('from', '2026-01-01'));
const toMs = arg('to') ? Date.parse(arg('to')) : Date.now();
const rules = arg('rule') ? [arg('rule')] : ['level', '1.5R', '2R'];
if (pair !== 'BTCUSD') { console.log('Only bitcoin has a keyless history feed here (Binance).'); process.exit(2); }

/** Binance BTCUSDT bars from `start`, 1,000 at a time, cached. Warm-up starts 12 days early. */
async function history(start, end) {
  const file = join(HOME, 'history', `${pair}-${tf.id}.json`);
  let bars = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const want = start - 12 * 86400e3;
  const have = (t) => bars.length && bars[0].t <= t && bars[bars.length - 1].t >= end - 2 * tf.minutes * 60000;
  if (!have(want)) {
    bars = [];
    for (let t = want; t < end;) {
      const u = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${tf.minutes}m&startTime=${t}&limit=1000`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d.length) break;
      for (const k of d) bars.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      t = d[d.length - 1][0] + tf.minutes * 60000;
    }
    mkdirSync(join(HOME, 'history'), { recursive: true });
    writeFileSync(file, JSON.stringify(bars));
  }
  return bars;
}

/**
 * Follow one alert forward to the stop, the target, or the window's close.
 * Returns R after costs, where 1R is what the stop actually loses. A buy pays
 * the spread in its fill (ask), so its stop loses stopDist + spread and its
 * target makes tp1Dist - spread. A sell fills at the bid and pays the spread
 * in its exits triggering on the ask — sooner, but for exactly the distances.
 */
function outcome(bars, k, rec, spread, comm) {
  const buy = rec.side === 'buy';
  const entryBid = bars[k].c;
  const sl = buy ? entryBid - rec.stopDist : entryBid + rec.stopDist;
  const tp = buy ? entryBid + rec.tp1Dist : entryBid - rec.tp1Dist;
  const riskPx = (buy ? rec.stopDist + spread : rec.stopDist) + comm;
  const winPx = (buy ? rec.tp1Dist - spread : rec.tp1Dist) - comm;
  const close = windowState(rec.barCloseMs, cfg.window).closesAtMs;
  for (let j = k + 1; j < bars.length; j++) {
    const b = bars[j];
    const lo = buy ? b.l : b.l + spread, hi = buy ? b.h : b.h + spread;   // the side the levels trigger on
    const hitSl = buy ? lo <= sl : hi >= sl;
    const hitTp = buy ? hi >= tp : lo <= tp;
    if (hitSl) return { r: -1, how: 'stop', bars: j - k };
    if (hitTp) return { r: winPx / riskPx, how: 'target', bars: j - k };
    if (b.t + tf.minutes * 60000 >= close) {
      const exit = buy ? b.c : b.c + spread;
      const pnl = buy ? exit - (entryBid + spread) : entryBid - exit;
      return { r: (pnl - comm) / riskPx, how: 'window', bars: j - k };
    }
  }
  return null;
}

const bars = await history(fromMs, toMs);
const inst = INSTRUMENTS[pair];
const spread = inst.typicalSpread.observed;
const comm = costFor(pair, 0, cfg).comm;
console.log(`${pair} ${tf.id}: ${bars.length} bars ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 16)} · spread ${spread} · cooldown ${COOLDOWN_BARS} bars`);

for (const rule of rules) {
  let state = { lastAlert: {} };
  const trades = [], kinds = {};
  let polls = 0;
  for (let k = 0; k < bars.length; k++) {
    const closeMs = bars[k].t + tf.minutes * 60000;
    if (closeMs < fromMs || closeMs > toMs) continue;
    const w = windowState(closeMs, cfg.window);
    if (!w.open || w.phase === 'weekend') continue;
    polls++;
    const r = liveRead({ pair, bars: bars.slice(Math.max(0, k - 999), k + 1), nowMs: closeMs + 20000, cfg, targetRule: rule });
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    if (r.kind !== 'idea' || !shouldAlert(state, r)) continue;
    state.lastAlert[pair] = { side: r.result.decision, barCloseMs: r.barCloseMs };
    const res = r.result;
    const rec = { side: res.decision, stopDist: res.stopDistance, tp1Dist: Math.abs(res.takeProfit1 - res.entry), barCloseMs: r.barCloseMs };
    const o = outcome(bars, k, rec, spread, comm);
    if (o) trades.push({ at: new Date(closeMs).toISOString().slice(0, 16), side: rec.side, conf: res.confidence, netR: res.netR, ...o });
  }
  const n = trades.length;
  const mean = n ? trades.reduce((s, t) => s + t.r, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.r - mean) ** 2, 0) / (n - 1)) : 0;
  const weeks = (Math.min(toMs, bars[bars.length - 1].t) - fromMs) / (7 * 86400e3);
  const by = (f) => trades.reduce((m, t) => (m[f(t)] = (m[f(t)] || 0) + 1, m), {});
  console.log(`\n== rule ${rule}: ${polls} checks in the window → ${n} alerts (${(n / weeks).toFixed(1)} a week)`);
  console.log('   reads:', JSON.stringify(kinds));
  if (n) {
    console.log(`   outcome: ${JSON.stringify(by((t) => t.how))} · sides ${JSON.stringify(by((t) => t.side))}`);
    console.log(`   average ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}R a trade, 95% range ${(mean - 1.96 * sd / Math.sqrt(n)).toFixed(3)} to ${(mean + 1.96 * sd / Math.sqrt(n)).toFixed(3)} · total ${trades.reduce((s, t) => s + t.r, 0).toFixed(1)}R`);
    // The same average in each half of the stretch: a real effect should not live in one half only.
    const half = Math.floor(n / 2);
    const avg = (xs) => (xs.length ? xs.reduce((s, t) => s + t.r, 0) / xs.length : 0);
    console.log(`   first half ${avg(trades.slice(0, half)).toFixed(3)}R (${half} trades, to ${trades[half - 1] ? trades[half - 1].at.slice(0, 10) : '—'}) · second half ${avg(trades.slice(half)).toFixed(3)}R (${n - half})`);
    if (process.argv.includes('--list')) for (const t of trades) console.log(`   ${t.at} ${t.side} ${t.conf} netR ${t.netR} → ${t.how} ${t.r.toFixed(2)}R after ${t.bars} bars`);
  }
}
