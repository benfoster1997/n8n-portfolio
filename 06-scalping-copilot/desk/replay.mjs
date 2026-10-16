#!/usr/bin/env node
/**
 * replay.mjs — the watcher, run over past bars, with what happened next.
 *
 * Why this exists. The engine had never been tested against outcomes. Before
 * the user relies on live alerts, this replays a stretch of history through
 * exactly what the watcher does (desk/live.mjs liveRead: gate, engine,
 * checkPlan; shouldAlert: no new alert while the last one on the instrument
 * is still running, and the cooldown) at every bar close inside the trading
 * window, and follows each alert forward on the same bars:
 *   - a buy fills at the ask (bid + spread); its stop and target trigger on
 *     the bid. A sell fills at the bid; its stop and target trigger on the ask.
 *   - a bar that touches both the stop and the target counts as the stop
 *     (--both-touched half scores it as the average of the two instead).
 *   - still open when the window closes: closed at that bar's close.
 * Results are in R (one R = the stop distance plus the spread), after the
 * spread and any commission.
 *
 * How. desk/reads.mjs computes the watcher's read at every check once — in
 * parallel, and judged under all three target rules from one engine run —
 * then applies the alert sequence serially, so every rule's figures come from
 * one pass. Reads are kept in a read store under $SCALP_DESK_HOME/learn/,
 * keyed by the engine's source and the settings, so a second run is quick and
 * a changed engine is never answered from old reads.
 *
 * Held-back years. 2025-01-01 onward is kept for one final test
 * (LEARNING-PLAN.md rule 2). Rows from then are reported only with
 * --holdout, and every such run is recorded in desk/model.json under "looks".
 * The one exception: 1 Jan – 11 Oct 2026 with the default settings, which
 * decision 26 already used to choose the 1.5R rule; it is labelled
 * "already seen (decision 26)" and is never a test on unseen data.
 *
 * What it is not. A reference feed's bars, not the broker's; no slippage, no
 * partial fills, no weekend spreads (the watcher is silent then anyway). The
 * news calendar's dated releases cover 2026 only (--calendar rules uses only
 * the rule-derived events, the same in every year). One stretch of one
 * market: an average with its uncertainty, not a promise.
 *
 *   node desk/replay.mjs --pair bitcoin --from 2026-01-01 [--to 2026-10-11]
 *        [--rule level|1.5R|2R] [--workers N] [--cost fixed|scaled]
 *        [--calendar full|rules|none] [--both-touched stop|half]
 *        [--holdout] [--no-store] [--list] [--by-condition]
 *
 * History is cached under $SCALP_DESK_HOME/history/ and only ever extended,
 * never replaced. Under test, $SCALP_DESK_BARS (the desk's file of bars per
 * instrument) stands in for it, $SCALP_DESK_CONFIG for desk/config.json and
 * $SCALP_DESK_MODEL for desk/model.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { COOLDOWN_BARS } from './live.mjs';
import { withDefaults, pairOf } from './lib.mjs';
import { clusteredByDay } from './stats.mjs';
import { ensureProxy } from './net.mjs';
import {
  DEFAULT_RULES, COST_MODES, SCALED_REFERENCE, loadBarsFile, checkIndices, readsFor, alertPass, defaultWorkers,
} from './reads.mjs';
import { CALENDAR_MODES } from '../src/news-calendar.js';
import { tfInfo } from '../src/timeframes.js';
import { INSTRUMENTS } from '../src/instruments.js';

ensureProxy();

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const fail = (msg) => { console.log(msg); process.exit(2); };
const HOME = process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');
const CONFIG = process.env.SCALP_DESK_CONFIG || fileURLToPath(new URL('./config.json', import.meta.url));
const MODEL = process.env.SCALP_DESK_MODEL || join(dirname(CONFIG), 'model.json');
const pair = pairOf(arg('pair', 'bitcoin'));
const cfg = withDefaults(JSON.parse(readFileSync(CONFIG, 'utf8')));
const tf = tfInfo(cfg.timeframe);
const tfMs = tf.minutes * 60000;
const fromMs = Date.parse(arg('from', '2026-01-01'));
let toMs = arg('to') ? Date.parse(arg('to')) : Date.now();
const rules = arg('rule') ? [arg('rule')] : DEFAULT_RULES;
const cost = arg('cost', 'fixed');
const calendar = arg('calendar', 'full');
const bothTouched = arg('both-touched', 'stop');
const workers = Number(arg('workers', defaultWorkers()));
if (pair !== 'BTCUSD') fail('Only bitcoin has a keyless history feed here (Binance).');
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) fail('--from and --to take dates like 2026-01-01.');
if (!rules.every((r) => DEFAULT_RULES.includes(r))) fail(`--rule is one of ${DEFAULT_RULES.join(', ')}.`);
if (!COST_MODES.includes(cost)) fail(`--cost is one of ${COST_MODES.join(', ')}.`);
if (!CALENDAR_MODES.includes(calendar)) fail(`--calendar is one of ${CALENDAR_MODES.join(', ')}.`);
if (!['stop', 'half'].includes(bothTouched)) fail('--both-touched is stop or half.');
if (!(workers >= 1)) fail('--workers takes a whole number, 1 or more.');

/* ------------------------------------------------------- held-back years */

const HOLDOUT_FROM = Date.UTC(2025, 0, 1);
// Decision 26's stretch, seen while choosing the 1.5R rule: 1 Jan – 11 Oct 2026 inclusive.
const SEEN = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 9, 12) };
const defaults = cost === 'fixed' && calendar === 'full' && bothTouched === 'stop';
const settings = { pair, timeframe: tf.id, rules, cost, calendar, bothTouched, window: cfg.window };
const notes = [];
if (toMs >= HOLDOUT_FROM) {
  if (has('holdout')) {
    const model = existsSync(MODEL) ? JSON.parse(readFileSync(MODEL, 'utf8')) : {};
    const looks = Array.isArray(model.looks) ? model.looks : [];
    if (looks.length) notes.push(`The held-back years have already been looked at ${looks.length} time${looks.length > 1 ? 's' : ''}; this result is not on unseen data.`);
    looks.push({ at: new Date().toISOString(), range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }, settings });
    model.looks = looks;
    mkdirSync(dirname(MODEL), { recursive: true });
    writeFileSync(MODEL, JSON.stringify(model, null, 2) + '\n');
    notes.push(`Held-back rows (from 2025-01-01) included: this look is recorded in ${MODEL}.`);
  } else if (defaults && fromMs >= SEEN.from && toMs < SEEN.to) {
    notes.push('1 Jan – 11 Oct 2026: already seen (decision 26) — the 1.5R rule was chosen on these bars, so this is not a test on unseen data.');
  } else {
    if (fromMs >= HOLDOUT_FROM) fail('2025-01-01 onward is held back for one final test. Nothing before it is in this range; add --holdout only for that test (it is recorded).');
    toMs = HOLDOUT_FROM - 1;
    notes.push('Stopped at 2024-12-31: 2025-01-01 onward is held back for one final test (--holdout, recorded in model.json).');
  }
}

/* ----------------------------------------------------------------- bars */

/**
 * Binance BTCUSDT bars, cached. The cache is only ever extended — backwards
 * to 12 days before `start` (the reads' warm-up), forwards from its last bar
 * (refetched, in case it was still forming) — and rewritten only when the
 * merged history is at least as long as the old one. The previous version
 * refetched the whole range and overwrote the file whenever the cache did not
 * reach `end`, which could have replaced nine years of bars with twelve days.
 * A failed fetch leaves the cache as it was and the replay uses what it has.
 */
async function history(start, end) {
  const file = join(HOME, 'history', `${pair}-${tf.id}.json`);
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const want = start - 12 * 86400e3;
  const now = Date.now();
  const fetchRange = async (from, until) => {
    const out = [];
    for (let t = from; t < until;) {
      const u = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${tf.minutes}m&startTime=${t}&limit=1000`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d.length) break;
      for (const k of d) if (k[0] + tfMs <= now) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      t = d[d.length - 1][0] + tfMs;
    }
    return out;
  };
  const parts = [];
  try {
    if (!old.length) parts.push(await fetchRange(want, end));
    else {
      if (old[0].t > want) parts.push(await fetchRange(want, old[0].t));
      if (old[old.length - 1].t < end - 2 * tfMs) parts.push(await fetchRange(old[old.length - 1].t, end));
    }
  } catch (e) {
    if (!old.length) throw e;
    console.error(`Could not extend the bar cache (${e.message}); using the bars it has.`);
    return old;
  }
  if (!parts.some((p) => p.length)) return old;
  const byT = new Map(old.map((b) => [b.t, b]));
  for (const p of parts) for (const b of p) byT.set(b.t, b);
  const merged = [...byT.values()].sort((a, b) => a.t - b.t);
  if (merged.length < old.length) return old;   // never shrink the cache
  mkdirSync(join(HOME, 'history'), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(merged));
  renameSync(`${file}.tmp`, file);
  return merged;
}

const barFile = process.env.SCALP_DESK_BARS || join(HOME, 'history', `${pair}-${tf.id}.json`);
const bars = process.env.SCALP_DESK_BARS ? loadBarsFile(barFile, pair) : await history(fromMs, toMs);
const inst = INSTRUMENTS[pair];
const spread = inst.typicalSpread.observed;
const costWords = cost === 'scaled' ? `spread ${spread} scaled with price (${spread} × close / ${SCALED_REFERENCE[pair].toLocaleString('en-GB')})` : `spread ${spread}`;
const extras = [calendar !== 'full' ? `calendar ${calendar}` : null, bothTouched !== 'stop' ? 'a bar touching both stop and target scores half' : null].filter(Boolean);
console.log(`${pair} ${tf.id}: ${bars.length} bars ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 16)} · ${costWords} · cooldown ${COOLDOWN_BARS} bars${extras.map((x) => ` · ${x}`).join('')}`);

/* ---------------------------------------------------------------- reads */

const ks = checkIndices(bars, { fromMs, toMs, cfg });
const t0 = Date.now();
const { reads, fromStore, computed } = await readsFor(bars, ks, { pair, cfg, rules: DEFAULT_RULES, cost, calendar, workers, file: barFile }, { home: HOME, useStore: !has('no-store') });
// Timing goes to stderr (a terminal only), so the report itself is the same whatever the workers.
if (process.stderr.isTTY) console.error(`${reads.length} reads (${fromStore} from the read store, ${computed ? `${computed} computed with --workers ${workers}` : 'none computed'}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

/* --------------------------------------------------------------- report */

for (const rule of rules) {
  const { checks, kinds, trades } = alertPass(reads, bars, { cfg, rule, bothTouched, tfMinutes: tf.minutes, pair });
  const n = trades.length;
  const st = clusteredByDay(trades);
  const mean = st ? st.mean : 0, sd = st ? st.sd : 0;
  const weeks = (Math.min(toMs, bars[bars.length - 1].t) - fromMs) / (7 * 86400e3);
  const by = (f) => trades.reduce((m, t) => (m[f(t)] = (m[f(t)] || 0) + 1, m), {});
  console.log(`\n== rule ${rule}: ${checks} checks in the window → ${n} alerts (${(n / weeks).toFixed(1)} a week)`);
  console.log('   reads:', JSON.stringify(kinds));
  if (n) {
    console.log(`   outcome: ${JSON.stringify(by((t) => t.how))} · sides ${JSON.stringify(by((t) => t.side))}`);
    console.log(`   average ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}R a trade, 95% range ${st.range[0].toFixed(3)} to ${st.range[1].toFixed(3)} · total ${trades.reduce((s, t) => s + t.r, 0).toFixed(1)}R`);
    // Trades on the same day share the same market, so they are not independent:
    // the range is also given with the uncertainty clustered by day (desk/stats.mjs).
    console.log(`   clustered by day: 95% range ${st.clustered[0].toFixed(3)} to ${st.clustered[1].toFixed(3)} · spread of results ${sd.toFixed(2)}R · trades for the range to clear zero at this average: about ${mean > 0 ? Math.round((1.96 * st.seDay * Math.sqrt(n) / mean) ** 2) : '—'}`);
    // The same average in each half of the stretch: a real effect should not live in one half only.
    const half = Math.floor(n / 2);
    const avg = (xs) => (xs.length ? xs.reduce((s, t) => s + t.r, 0) / xs.length : 0);
    console.log(`   first half ${avg(trades.slice(0, half)).toFixed(3)}R (${half} trades, to ${trades[half - 1] ? trades[half - 1].at.slice(0, 10) : '—'}) · second half ${avg(trades.slice(half)).toFixed(3)}R (${n - half})`);
    if (has('list')) for (const t of trades) console.log(`   ${t.at} ${t.side} ${t.conf} netR ${t.netR} → ${t.how} ${t.r.toFixed(2)}R after ${t.bars} bars`);
  }
  if (has('by-condition')) {
    // The by-condition table (LEARNING-PLAN.md Part 2) is desk/conditions.mjs,
    // built separately. It is handed every read and this rule's alerts, and
    // returns the lines to print. Until it exists the flag says so.
    let report = null;
    try { ({ conditionReport: report } = await import('./conditions.mjs')); } catch { /* not built yet */ }
    if (typeof report !== 'function') console.log('   by condition: not built yet (desk/conditions.mjs, export conditionReport).');
    else {
      const out = await report({ reads, trades, rule, cfg, bars, settings });
      console.log([].concat(out).join('\n'));
    }
  }
}

console.log(`\nsettings: cost ${cost} · calendar ${calendar} · both-touched ${bothTouched}`);
for (const n of notes) console.log(n);
