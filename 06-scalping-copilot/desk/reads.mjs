/**
 * desk/reads.mjs — the watcher's read at every check in history, computed once.
 *
 * Why this exists. The replay, the dataset the learner trains on and the
 * by-condition report all need the same thing: what the live watcher would
 * have read at each bar close in the trading window. That read is a pure
 * function of the 1,000 bars ending at the check, the clock 20 seconds after
 * the close, the config and the costs — it does not depend on any earlier
 * alert. Only the alert sequence does (no repeat bar, the cooldown, no new
 * alert while the last is still running). So the work is split in two:
 *   1. reads: one record per check, independent of each other, so they are
 *      computed in parallel (worker threads, each given a range of checks and
 *      the path of the bar file, which it parses itself) and kept in a read
 *      store on disk;
 *   2. the alert pass: shouldAlert → alertState → outcome, applied serially
 *      over the merged reads, exactly as the watcher applies them live.
 * With one worker the same two phases run in this process; the 2026 replay
 * gives the same figures either way (test/reads.test.mjs, and the parity runs
 * recorded in HANDOFF decision 26).
 *
 * One read runs the engine ONCE and judges the lean under every target rule
 * asked for ('level', '1.5R', '2R' by default): the engine's read does not
 * depend on the rule, only toPlan's first target and checkPlan's verdict do.
 *
 * The alert pass takes a `predicate`, applied BEFORE shouldAlert. A filter
 * that removes an alert changes which later alerts are still-running-blocked
 * or inside the cooldown, so a filtered result cannot be had by deleting rows
 * from the unfiltered alert list (LEARNING-PLAN.md, engineering review).
 *
 * What it is not. No network and no side effects on import: everything here
 * is a function, and workers start only when computeReads() asks for them, so
 * a worker of another tool may import this file freely.
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { engineRead, judgeLean, shouldAlert, alertState, FETCH_BARS } from './live.mjs';
import { costFor, timeframeFor } from './lib.mjs';
import { outcome } from './outcome.mjs';
import { windowState } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { INSTRUMENTS } from '../src/instruments.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The target rules a read is judged under unless told otherwise. */
export const DEFAULT_RULES = ['level', '1.5R', '2R'];

/** A check is skipped when its 1,000-bar slice is missing more than this many bars in a row. */
export const GAP_BARS = 4;

/**
 * Cost modes. 'fixed' is the confirmed usual spread (bitcoin $6), as live and
 * as decision 26 measured. 'scaled' keeps the spread at the same share of the
 * price — bitcoin's $6 was measured at about $84,400, and in 2019 bitcoin cost
 * a tenth of that — so it is spread × close / reference. The commission (gold
 * only) comes from the config either way.
 */
export const COST_MODES = ['fixed', 'scaled'];
export const SCALED_REFERENCE = { BTCUSD: 84400 };

/** The spread a read at this bar assumes, under a cost mode. */
export function spreadAt(pair, close, cost = 'fixed') {
  const observed = INSTRUMENTS[pair].typicalSpread.observed;
  if (cost === 'fixed') return observed;
  if (cost === 'scaled') {
    const ref = SCALED_REFERENCE[pair];
    if (!ref) throw new Error(`No reference price for scaling ${pair}'s spread; only ${Object.keys(SCALED_REFERENCE).join(', ')} has one.`);
    return observed * close / ref;
  }
  throw new Error(`Unknown cost mode "${cost}" (fixed or scaled).`);
}

/**
 * Bars from a file: the history cache (an array of {t,o,h,l,c,v}), the desk's
 * test file of bars per instrument ({ BTCUSD: [...] }), or a recorded fixture
 * ({ bars: [[t,o,h,l,c,v], ...] }).
 */
export function loadBarsFile(file, pair) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const rows = Array.isArray(d) ? d : Array.isArray(d[pair]) ? d[pair] : d.bars;
  if (!Array.isArray(rows)) throw new Error(`${file} holds no ${pair} bars.`);
  return rows.map((b) => (Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : b));
}

/**
 * The checks in a range: every bar whose close falls in [fromMs, toMs] and in
 * the user's window on a weekday — what the watcher polls live.
 */
export function checkIndices(bars, { fromMs, toMs, cfg }) {
  const tfMs = tfInfo(timeframeFor(cfg)).minutes * 60000;
  const ks = [];
  for (let k = 0; k < bars.length; k++) {
    const closeMs = bars[k].t + tfMs;
    if (closeMs < fromMs || closeMs > toMs) continue;
    const w = windowState(closeMs, cfg.window);
    if (!w.open || w.phase === 'weekend') continue;
    ks.push(k);
  }
  return ks;
}

/** The longest run of missing bars between bars[lo] and bars[hi]. */
export function longestGap(bars, lo, hi, tfMs) {
  let worst = 0;
  for (let j = Math.max(lo, 0) + 1; j <= hi; j++) worst = Math.max(worst, Math.round((bars[j].t - bars[j - 1].t) / tfMs) - 1);
  return worst;
}

/** The kind of a read under one rule, in the watcher's words (idea, rejected, none, blocked, ...). */
export const kindFor = (read, rule) => (read.kind === 'lean' ? read.rules[rule].kind : read.kind);

/** What the read keeps of checkPlan's verdict (and of the plan, for a rejected idea's levels). */
function verdict(plan, result) {
  const idea = result.decision === 'buy' || result.decision === 'sell';
  return {
    kind: idea ? 'idea' : 'rejected',
    decision: result.decision, confidence: result.confidence ?? null,
    entry: result.entry ?? null, stopDistance: result.stopDistance ?? null,
    takeProfit1: result.takeProfit1 ?? null, takeProfit2: result.takeProfit2 ?? null,
    netR: result.netR ?? null,
    ...(idea ? {} : { problems: result.problems || [] }),
    plan: { side: plan.decision, stopLoss: plan.stop_loss, takeProfit1: plan.take_profit_1, takeProfit2: plan.take_profit_2 },
  };
}

/**
 * One check: the watcher's read at bar k, as it would have been 20 seconds
 * after that bar closed, from the 1,000 bars ending there.
 *   opts.pair, opts.cfg      instrument and desk config
 *   opts.rules               target rules to judge the lean under (DEFAULT_RULES)
 *   opts.cost                'fixed' | 'scaled' (COST_MODES); opts.spreadNum overrides both
 *   opts.calendar            'full' | 'rules' | 'none'
 *   opts.extra(ctx)          optional; its return value is stored as `extra`.
 *                            ctx = { pair, k, bars, window, closed, analysis, nowMs, cfg, read }
 *                            (window: the engine's 300 bars; analysis null when the
 *                            gate stopped the read before the engine)
 * Kinds: 'gap' (skipped: the slice is missing more than GAP_BARS bars in a
 * row), 'no-data', 'stale', 'blocked', 'none', or 'lean' — the engine leaned,
 * and `rules[rule].kind` says 'idea' or 'rejected' under each rule.
 */
export function readAt(bars, k, opts) {
  const { pair, cfg, rules = DEFAULT_RULES, cost = 'fixed', calendar = 'full', extra = null } = opts;
  const tfMs = tfInfo(timeframeFor(cfg)).minutes * 60000;
  const lo = Math.max(0, k - (FETCH_BARS - 1));
  const closeMs = bars[k].t + tfMs;
  const nowMs = closeMs + 20000;
  const spreadNum = Number.isFinite(opts.spreadNum) ? opts.spreadNum : spreadAt(pair, bars[k].c, cost);
  const head = { k, closeMs, nowMs, spreadNum };
  if (longestGap(bars, lo, k, tfMs) > GAP_BARS) return { ...head, kind: 'gap', blackoutId: null };

  const seen = bars.slice(lo, k + 1);
  const core = engineRead({ pair, bars: seen, nowMs, cfg, spreadNum, calendar });
  const r = core.done || core.out;
  const read = { ...head, kind: core.done ? r.kind : 'lean', blackoutId: r.blackoutId ?? null };
  if (r.gate) read.gate = r.gate.state;
  if (r.spreadUnknown) read.spreadUnknown = true;
  if (!core.done) {
    read.rules = {};
    for (const rule of rules) {
      const { plan, result } = judgeLean(core, rule);
      read.rules[rule] = verdict(plan, result);
    }
  }
  if (extra) {
    read.extra = extra({
      pair, k, bars, window: core.window || seen.slice(-300), closed: core.closed || seen,
      analysis: core.a || null, nowMs, cfg, read,
    });
  }
  return read;
}

/** readAt over a list of check indices, in order. */
export function readRange(bars, ks, opts) {
  return ks.map((k) => readAt(bars, k, opts));
}

/** The options a worker can be sent: everything but functions. */
function portable(opts) {
  const { pair, cfg, rules, cost, calendar, spreadNum, extraModule } = opts;
  return { pair, cfg, rules, cost, calendar, spreadNum, extraModule };
}

/** opts.extra, or the `extra` export of opts.extraModule (how a worker gets it). */
export async function extraFor(opts) {
  if (opts.extra) return opts.extra;
  if (!opts.extraModule) return null;
  const m = await import(pathToFileURL(resolve(opts.extraModule)).href);
  if (typeof m.extra !== 'function') throw new Error(`${opts.extraModule} has no "extra" export.`);
  return m.extra;
}

/**
 * Reads for every k in `ks`, merged in k order.
 *   workers  1: in this process, on `bars`; more: worker threads, each parsing
 *            `file` itself and taking chunks of checks from a queue.
 *   file     the bar file `bars` came from (needed for workers > 1)
 *   chunk    checks per message (default 200)
 * A worker's reads are checked against `bars` by close time, so a bar file
 * changed underneath the run fails loudly instead of misaligning.
 */
export async function computeReads(bars, ks, opts) {
  const workers = Math.max(1, Math.min(opts.workers || 1, Math.ceil(ks.length / 50) || 1));
  const extra = await extraFor(opts);
  if (workers === 1) return readRange(bars, ks, { ...opts, extra });
  if (opts.extra && !opts.extraModule) throw new Error('An extra() function cannot be sent to a worker; pass extraModule (a file exporting `extra`).');
  if (!opts.file) throw new Error('computeReads needs the bar file for workers.');
  const tfMs = tfInfo(timeframeFor(opts.cfg)).minutes * 60000;
  const size = opts.chunk || 200;
  const chunks = [];
  for (let i = 0; i < ks.length; i += size) chunks.push(ks.slice(i, i + size));
  const results = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: workers }, () => new Promise((ok, fail) => {
    const w = new Worker(join(here, 'reads-worker.mjs'), { workerData: { file: opts.file, opts: portable(opts) } });
    const give = () => {
      if (next >= chunks.length) { w.postMessage({ done: true }); return; }
      const id = next++;
      w.postMessage({ id, ks: chunks[id] });
    };
    w.on('message', (m) => {
      if (m.error) { fail(new Error(m.error)); w.terminate(); return; }
      if (m.reads) results[m.id] = m.reads;
      give();
    });
    w.on('error', fail);
    w.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`a read worker exited with code ${code}`))));
  })));
  const reads = results.flat();
  for (const r of reads) {
    if (!bars[r.k] || bars[r.k].t + tfMs !== r.closeMs) throw new Error(`The bar file changed during the run (check ${r.k}); run it again.`);
  }
  return reads;
}

/** min(4, CPUs): the default for --workers. */
export const defaultWorkers = () => Math.min(4, availableParallelism());

/**
 * The serial alert pass over reads (sorted by k), for one target rule, exactly
 * as the watcher would have sent them, and what became of each alert.
 *   predicate(read)  optional; a read it refuses is not offered to shouldAlert,
 *                    so it neither alerts nor blocks later alerts
 *   bothTouched      'stop' (default, decision 26's rule) | 'half' (outcome.mjs)
 * Each alert is scored with the spread its own read assumed. Returns
 * { checks, kinds, trades } in the replay's shapes.
 */
export function alertPass(reads, bars, { cfg, rule, predicate = null, bothTouched = 'stop', tfMinutes = null, pair = 'BTCUSD' }) {
  const tf = tfInfo(timeframeFor(cfg));
  const minutes = tfMinutes || tf.minutes;
  const comm = costFor(pair, 0, cfg).comm;
  const state = { lastAlert: {} };
  const kinds = {}, trades = [];
  for (const read of reads) {
    const kind = kindFor(read, rule);
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind !== 'idea') continue;
    if (predicate && !predicate(read)) continue;
    const k = read.k;
    const res = read.rules[rule];
    const seen = bars.slice(Math.max(0, k - (FETCH_BARS - 1)), k + 1);
    const r = { pair, tf: tf.id, nowMs: read.nowMs, barCloseMs: read.closeMs, spreadNum: read.spreadNum, result: { decision: res.decision } };
    if (!shouldAlert(state, r, seen, cfg)) continue;
    const tp1Dist = Math.abs(res.takeProfit1 - res.entry);
    state.lastAlert[pair] = alertState({ side: res.decision, barCloseMs: read.closeMs, refPrice: res.entry, stopDist: res.stopDistance, tp1Dist });
    const rec = { side: res.decision, stopDist: res.stopDistance, tp1Dist, barCloseMs: read.closeMs };
    const o = outcome(bars, k, rec, { spread: read.spreadNum, comm, closesAtMs: windowState(read.closeMs, cfg.window).closesAtMs, tfMinutes: minutes, bothTouched });
    if (o) trades.push({ at: new Date(read.closeMs).toISOString().slice(0, 16), k, closeMs: read.closeMs, side: rec.side, conf: res.confidence, netR: res.netR, ...o });
  }
  return { checks: reads.length, kinds, trades };
}

/* ------------------------------------------------------------ read store */

/**
 * The files whose code decides a read: this file and everything it imports,
 * followed through relative imports. Hashing them keys the read store, so a
 * change to the engine, the gate, the calendar or checkPlan can never be
 * answered from reads the old code made. Over-inclusive on purpose (lib.mjs
 * pulls in the brief and the edge test): a needless recompute costs minutes;
 * a stale read costs a wrong conclusion.
 */
export function engineFiles(entry = fileURLToPath(import.meta.url)) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) walk(resolve(dirname(f), m[1]));
  };
  walk(entry);
  walk(join(here, 'reads-worker.mjs'));
  return [...seen].sort();
}

/**
 * The read store's key: the engine's source, the cost and calendar modes, the
 * window, the timeframe and the rules — everything a read depends on besides
 * the bars. The account's commission inputs are in it too (gold's cost).
 */
export function storeKey({ pair, cfg, rules = DEFAULT_RULES, cost = 'fixed', calendar = 'full', extraModule = null }) {
  const h = createHash('sha256');
  const root = resolve(here, '..');
  for (const f of engineFiles()) h.update(f.slice(root.length)).update('\0').update(readFileSync(f)).update('\0');
  if (extraModule) h.update(readFileSync(resolve(extraModule)));
  h.update(JSON.stringify({
    pair, cost, calendar, rules, window: cfg.window, timeframe: tfInfo(timeframeFor(cfg)).id,
    commission: [cfg.account.gbpusd, cfg.account.commissionPerSideGBP], extra: !!extraModule,
  }));
  return h.digest('hex').slice(0, 16);
}

/** Where the store for these settings lives: $SCALP_DESK_HOME/learn/<pair>-<tf>-<key>.reads.jsonl. */
export function storePath(home, opts) {
  return join(home, 'learn', `${opts.pair}-${tfInfo(timeframeFor(opts.cfg)).id}-${storeKey(opts)}.reads.jsonl`);
}

/**
 * Stored reads, read line by line (a full bitcoin store is ~150 MB), as a Map
 * of close time → read. Lines it cannot parse (a run killed mid-write) are
 * skipped; a later read of the same close replaces an earlier one.
 */
export async function loadStore(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && typeof r.closeMs === 'number') out.set(r.closeMs, r);
  }
  return out;
}

/** Appends reads to the store, one JSON line each. */
export function appendStore(path, reads) {
  if (!reads.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, reads.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * Reads for the checks `ks`: those already in the store (re-indexed to `bars`
 * by close time, since the history may have grown at its start), the rest
 * computed and appended. Returns { reads, fromStore, computed }.
 */
export async function readsFor(bars, ks, opts, { home, useStore = true } = {}) {
  const tfMs = tfInfo(timeframeFor(opts.cfg)).minutes * 60000;
  const path = useStore && home ? storePath(home, opts) : null;
  const stored = path ? await loadStore(path) : new Map();
  const have = [], missing = [];
  for (const k of ks) {
    const r = stored.get(bars[k].t + tfMs);
    if (r) have.push({ ...r, k }); else missing.push(k);
  }
  const fresh = missing.length ? await computeReads(bars, missing, opts) : [];
  if (path) appendStore(path, fresh);
  const reads = [...have, ...fresh].sort((a, b) => a.k - b.k);
  return { reads, fromStore: have.length, computed: fresh.length, path };
}
