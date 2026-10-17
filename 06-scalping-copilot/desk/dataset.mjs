#!/usr/bin/env node
/**
 * desk/dataset.mjs — one row per window check, with what the learner may know
 * at that moment and what happened afterwards, written to a file.
 *
 * Why this exists. The learning layer (LEARNING-PLAN.md, Part 4) asks which
 * measurable conditions came before better or worse trades, and whether that
 * held on years it never saw. It needs every weekday check from 08:00 to 16:00
 * London described the same way, and two labels for each:
 *   (a) the watcher's own trade on the engine's lean — the 1.5R rule's stop
 *       and first target from the read itself (a rejected idea's from its
 *       plan) — only where the engine leaned (kind idea or rejected);
 *   (b) a standard long and a standard short from the same bar, with the stop
 *       label (b) defines (features-extra.mjs standardStop) and a 1.5R target,
 *       on every row with features, whatever the engine did.
 * Each is scored gross (spread 0, no commission: what the learner trains on)
 * and net (the read's own spread and the pair's commission), with the same
 * fills as the replay, to the close of the same day's window, and a bar that
 * touches both stop and target scored as half of each (outcome.mjs 'half').
 * Label (a) keeps the path (bars, MFE, MAE); label (b) keeps the result only
 * ({ r, how }; a both-touched bar shows as how 'both').
 * `alerted` says whether the watcher, with no filter, would have sent the
 * idea: the replay's serial alert pass (reads.mjs alertPass, rule 1.5R) over
 * the same reads, so the cooldown and "still running" are exactly the live
 * desk's.
 *
 * A hole ahead. The read's gap rule looks back only (no more than GAP_BARS
 * missing bars in its slice). A check just before a hole in the bars would
 * have its trades scored on whatever bar comes after the hole, hours or days
 * later. So when any scored trade's path, from the check to its exit (or to
 * the end of the bars), crosses a hole of more than GAP_BARS bars, the row
 * says `gapAhead: true`: label (a) keeps its levels (side, stopDist, tp1Dist,
 * confidence, netR) with gross and net null, the shape of a trade still open
 * when the bars run out, and label (b) is null. Nothing is scored on bars that
 * are not there, and an idea still carries what the alert pass needs to
 * rebuild its read (desk/learn.mjs refuses an idea without label (a)).
 *
 * How. The reads come from desk/reads.mjs, computed in worker threads with
 * desk/features-extra.mjs as the features hook and kept in its read store, so
 * a second build re-reads nothing. The hook sees only the bars up to the
 * check. The labels are added here, in the parent, from the full bars: they
 * are the only thing in a row that looks forward, and only to the end of that
 * day's window. Rows are streamed to the file (a bitcoin build is ~110 MB) and
 * read back the same way, line by line.
 *
 * Calendar. Features never depend on the calendar mode; only which checks are
 * tradeable (blocked) does. Training rows are built under calendar 'rules'
 * (the same rules in every year: the tier-1 tables for 2017-2024 are
 * incomplete); the one held-back evaluation is made by desk/learn.mjs under
 * 'full', the live desk's calendar, from reads of its own, not from rows here.
 *
 * The row (one JSON line; field order fixed, desk/learn.mjs reads it):
 *   t, closeMs     the check's bar: open time and close time, UTC ms
 *   day            London date of the check, YYYY-MM-DD
 *   pair, tf       'BTCUSD' | 'XAUUSD', 'M15'
 *   kind           idea | rejected | none | blocked | gap | no-data | stale
 *   lean           'long' | 'short' (idea and rejected only), else null
 *   spreadNum      the spread the read assumed, price units
 *   cost, calendar the modes the reads were made under
 *   blackoutId     the news event in force, or null
 *   f              every FEATURE_NAMES key, number or null; null as a whole
 *                  only for gap, no-data and stale
 *   fv             FEATURES_VERSION
 *   cond           conditionOf(f) for the lean, or null without one
 *   atr, stopStd   ATR at the check and label (b)'s stop, price units
 *   a              null, or { side, stopDist, tp1Dist, confidence, netR,
 *                  gross: { r, how, bars, mfe, mae }, net: { same } };
 *                  gross and net null when the trade cannot be scored
 *   b              null, or { stopDist, tp1Dist, long: { gross: { r, how },
 *                  net: { r, how } }, short: { same } }
 *   gapAhead       true when a scored trade's path crosses a hole of more
 *                  than GAP_BARS bars (a.gross, a.net and b are then null),
 *                  else false
 *   alerted        true | false
 * A trade still open when the bars run out (the last session of the history
 * only) has gross and net null. For the same reason an alert in that last
 * session is not counted as alerted: alertPass keeps only trades it can score.
 *
 * The file and its manifest. Rows go to rowsPath(home, settings), named by
 * the settings and rowsKey (the read store's key, FEATURES_VERSION, LABELS and
 * the source of outcome.mjs and this file); a --holdout build's name carries a
 * '-holdout' segment, so it never replaces the development rows. Beside it,
 * <rows file>.manifest.json says what it holds: { fromMs, toMs, firstCloseMs,
 * lastCloseMs (the first and last check written, null when none), rows, sha256
 * (of the rows file's bytes), rowsKey, storeKey, settings: { pair, tf, cost,
 * calendar }, source, holdout, featuresVersion, labelVersion, builtAt }.
 * desk/learn.mjs refuses rows without a manifest, with another hash, or whose
 * rowsKey today's code (rowsKeyFor(manifest.settings)) would not give. Unless
 * --replace is given, a build never replaces a rows file whose manifest covers
 * a range this one does not, or whose checks it would not all write again
 * (fewer rows, a later first check or an earlier last one), and never writes
 * an empty one. The test is made before any read and again immediately before
 * the new file is renamed into place, and a lock file beside the rows file
 * (<rows file>.lock) keeps a second build of the same file out meanwhile.
 *
 * Held-back years. The dataset holds no labels from 2025-01-01 (conditions.mjs
 * HOLDOUT) unless asked: the default --to is 2024-12-31, and a range with
 * checks closing on or after 2025-01-01 is refused without --holdout. With
 * it, the rows go to a file of their own (a '-holdout' segment in the name, so
 * the development rows are never replaced or displaced by them), and the look
 * is appended to desk/model.json under "looks", as the replay
 * records its own (plan rule 2), and the command line still gives the
 * held-back rows' number and nothing else. desk/learn.mjs's final test does
 * not use these rows. For the development years it prints counts by year and
 * kind, never an outcome. Results are desk/learn.mjs's to report.
 *
 * What it is not. A reference feed's bars, not the broker's; no slippage.
 *
 *   node desk/dataset.mjs --pair bitcoin [--from 2017-09-01] [--to 2024-12-31]
 *        [--workers 4] [--cost scaled|fixed|max] [--calendar rules|full|none]
 *        [--no-store] [--replace] [--holdout]
 *
 * A date alone in --to means the end of that day. Times are UTC. A date that
 * does not exist, a flag without its value (or with an empty one, --to ""),
 * or an unknown flag is an error.
 * Under test, $SCALP_DESK_BARS stands in for the history, $SCALP_DESK_CONFIG
 * for desk/config.json and $SCALP_DESK_MODEL for desk/model.json, as in the
 * replay.
 */
import { readFileSync, writeFileSync, createReadStream, createWriteStream, mkdirSync, renameSync, statSync, existsSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readsFor, checkIndices, alertPass, kindFor, storeKey, defaultWorkers, loadBarsFile, longestGap, COST_MODES, GAP_BARS } from './reads.mjs';
import { outcome } from './outcome.mjs';
import { FEATURES_VERSION, FEATURE_NAMES } from './features.mjs';
import { STOP_ATR_MULTIPLE } from './features-extra.mjs';
import { HOLDOUT } from './conditions.mjs';
import { costFor, timeframeFor, withDefaults, pairOf } from './lib.mjs';
import { windowState, localDate } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { CALENDAR_MODES } from '../src/news-calendar.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The features hook every dataset read is made with. */
export const EXTRA_MODULE = join(here, 'features-extra.mjs');

/** The one target rule the watcher alerts on (live.mjs TARGET_RULE), and the only one the reads are judged under here. */
export const RULE = '1.5R';

/**
 * What the labels mean. Part of the rows file's key, with outcome.mjs's and
 * this file's source: a row scored one way must never be read as scored
 * another. Bump `version` with any change to how a label is made.
 */
export const LABELS = Object.freeze({
  version: 3,
  a: { rule: RULE, levels: 'the read: an idea\'s checkPlan stop and first target, a rejected idea\'s plan', keeps: 'r, how, bars, mfe, mae' },
  b: { stopAtr: STOP_ATR_MULTIPLE, stopFloor: 'minStop x noiseScale', targetR: 1.5, keeps: 'r, how' },
  gapAhead: `a.gross, a.net and b null (a's levels kept) when a scored trade's path crosses more than ${GAP_BARS} missing bars`,
  bothTouched: 'half',
  gross: 'spread 0, no commission',
  net: 'the read\'s spreadNum and the pair\'s commission',
  close: 'the same day\'s window close',
});

const HELD_BACK_MS = Date.parse(HOLDOUT.from);
const SEEN_MS = Date.parse(HOLDOUT.seenFrom);
const FRESH_AFTER_MS = Date.parse(HOLDOUT.to);
const LONDON = 'Europe/London';

/** The cfg with its timeframe set to `tf` when one is named. */
function cfgFor(cfg, tf) {
  const base = withDefaults(cfg || {});
  return tf ? { ...base, timeframe: tfInfo(timeframeFor(base, tf)).id } : base;
}

/**
 * The reads.mjs options a dataset build uses: its read store is keyed by them,
 * so a test or learn.mjs that wants the very reads a build made asks with these.
 */
export function readOptions({ pair, tf = null, cfg, cost = 'scaled', calendar = 'rules', workers = 1, file = null, source = null, chunk, minPerWorker }) {
  if (!COST_MODES.includes(cost)) throw new Error(`Unknown cost mode "${cost}" (${COST_MODES.join(', ')}).`);
  if (!CALENDAR_MODES.includes(calendar)) throw new Error(`Unknown calendar mode "${calendar}" (${CALENDAR_MODES.join(', ')}).`);
  return {
    pair, cfg: cfgFor(cfg, tf), rules: [RULE], cost, calendar, workers, file,
    source: source ?? (file ? `file:${resolve(file)}` : null),
    extraModule: EXTRA_MODULE, chunk, minPerWorker,
  };
}

/** The rows file's key: the read store's key, FEATURES_VERSION and the label definitions (with the code that applies them). */
export function rowsKey(opts) {
  const h = createHash('sha256');
  h.update(storeKey(opts)).update('\0').update(String(FEATURES_VERSION)).update('\0').update(JSON.stringify(LABELS));
  for (const f of [join(here, 'outcome.mjs'), fileURLToPath(import.meta.url)]) h.update('\0').update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

/** desk/config.json ($SCALP_DESK_CONFIG under test), with the desk's defaults. */
export function deskConfig() {
  const file = process.env.SCALP_DESK_CONFIG || join(here, 'config.json');
  return withDefaults(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

/**
 * The rowsKey today's code gives for a manifest's settings ({ pair, tf, cost,
 * calendar }). The config (window, broker, account) and the bars' source are
 * in the key too: by default the desk's config and 'binance' (the history
 * feed's name), or the manifest's own `source` (null included: bars handed in
 * with no file) when it is passed as opts.source or settings.source. desk/learn.mjs compares it with the rows'
 * manifest, so rows made by older code, or for other settings, are refused.
 */
export function rowsKeyFor(settings, { cfg = null, source } = {}) {
  const { pair, tf, cost, calendar } = settings;
  const src = source !== undefined ? source : settings.source !== undefined ? settings.source : 'binance';
  return rowsKey(readOptions({ pair, tf, cost, calendar, cfg: cfg || deskConfig(), source: src }));
}

/** The manifest beside a rows file. */
export const manifestPath = (rowsFile) => `${rowsFile}.manifest.json`;

/** A rows file's manifest, or null when it has none (or it does not parse). */
export function readManifest(rowsFile) {
  const p = manifestPath(rowsFile);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** The sha256 of a file's bytes, read in pieces (a rows file is ~110 MB). */
export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/**
 * $SCALP_DESK_HOME/learn/<pair>-<tf>-<cost>-<calendar>-<hash>.rows.jsonl, for
 * readOptions-shaped settings; with { holdout: true }, <…>-<calendar>-holdout-
 * <hash>.rows.jsonl, so rows holding held-back labels never sit at (or
 * replace) the development rows' path.
 */
export function rowsPath(home, settings, { holdout = false } = {}) {
  const opts = settings.extraModule ? settings : readOptions(settings);
  const tf = tfInfo(timeframeFor(opts.cfg)).id;
  return join(home, 'learn', `${opts.pair}-${tf}-${opts.cost}-${opts.calendar}${holdout ? '-holdout' : ''}-${rowsKey(opts)}.rows.jsonl`);
}

/** The lock file a build holds beside the rows file it writes. */
export const lockPath = (rowsFile) => `${rowsFile}.lock`;

/**
 * Why a build may not replace the rows file at `path` without --replace, or
 * null when it may: the file has no readable manifest; its manifest covers a
 * range this build does not; or this build, over a range containing it, writes
 * fewer rows than it records, or starts after its first check or ends before
 * its last one. `next` is { fromMs, toMs, rows, firstCloseMs, lastCloseMs }.
 */
export function replaceRefusal(path, next) {
  if (!existsSync(path)) return null;
  const prior = readManifest(path);
  const iso = (ms) => new Date(ms).toISOString();
  if (!prior || !Number.isFinite(prior.fromMs) || !Number.isFinite(prior.toMs)) {
    return `${path} exists with no readable manifest, so what it covers is unknown. Add --replace to build it again.`;
  }
  if (prior.fromMs < next.fromMs || prior.toMs > next.toMs) {
    return `${path} covers ${iso(prior.fromMs)} to ${iso(prior.toMs)}, wider than this build; add --replace to replace it with the narrower one.`;
  }
  if (Number.isFinite(prior.rows) && next.rows < prior.rows) {
    return `${path} holds ${prior.rows} rows for ${iso(prior.fromMs)} to ${iso(prior.toMs)}; this build, over a range containing it, writes only ${next.rows} (bars missing?). Add --replace to replace it all the same.`;
  }
  if (Number.isFinite(prior.firstCloseMs) && !(Number.isFinite(next.firstCloseMs) && next.firstCloseMs <= prior.firstCloseMs)) {
    return `${path} starts with the check at ${iso(prior.firstCloseMs)}; this build would not write it again. Add --replace to replace it all the same.`;
  }
  if (Number.isFinite(prior.lastCloseMs) && !(Number.isFinite(next.lastCloseMs) && next.lastCloseMs >= prior.lastCloseMs)) {
    return `${path} ends with the check at ${iso(prior.lastCloseMs)}; this build would not write it again. Add --replace to replace it all the same.`;
  }
  return null;
}

/** The parts of outcome() a label keeps: label (a) the path too, label (b) the result only. */
const full = (o) => (o ? { r: o.r, how: o.how, bars: o.bars, mfe: o.mfe, mae: o.mae } : null);
const brief = (o) => (o ? { r: o.r, how: o.how } : null);

/**
 * Label (a)'s levels from a read: an idea's as checkPlan passed them (the
 * replay's alert pass takes the same: stopDistance, and the first target's
 * distance from the entry), a rejected idea's from its plan, measured from the
 * close the trade would enter at. Null when the plan has no usable stop or
 * target (nothing to score).
 */
export function planLevels(read, bars) {
  const res = read.rules && read.rules[RULE];
  if (!res) return null;
  let side, stopDist, tp1Dist;
  if (res.kind === 'idea') {
    side = res.decision;
    stopDist = res.stopDistance;
    tp1Dist = Math.abs(res.takeProfit1 - res.entry);
  } else {
    const p = res.plan || {};
    const price = bars[read.k].c;
    side = p.side;
    stopDist = Number.isFinite(p.stopLoss) ? Math.abs(price - p.stopLoss) : null;
    tp1Dist = Number.isFinite(p.takeProfit1) ? Math.abs(p.takeProfit1 - price) : null;
  }
  if ((side !== 'buy' && side !== 'sell') || !(stopDist > 0) || !(tp1Dist > 0)) return null;
  return { side, stopDist, tp1Dist };
}

/**
 * One row from one read (which must carry `k`, its index in `bars`, and the
 * features hook's `extra`). `alerted` is decided by the caller's alert pass.
 */
export function rowFor(read, bars, { pair, cfg, cost, calendar, comm, alerted = false }) {
  const tf = tfInfo(timeframeFor(cfg));
  const scored = [];   // every outcome() result, to find how far the trades ran
  const kind = kindFor(read, RULE);
  const ex = read.extra || { f: null, cond: null, atr: null, stopStd: null };
  const res = read.rules && read.rules[RULE];
  const leaned = kind === 'idea' || kind === 'rejected';
  const side = leaned && res.plan ? res.plan.side : null;
  const d = localDate(read.closeMs, LONDON);
  const closesAtMs = windowState(read.closeMs, cfg.window).closesAtMs;
  const score = (rec, spread, c) => {
    const o = outcome(bars, read.k, rec, { spread, comm: c, closesAtMs, tfMinutes: tf.minutes, bothTouched: 'half' });
    scored.push(o);
    return o;
  };

  let a = null;
  const lv = leaned ? planLevels(read, bars) : null;
  if (lv) {
    a = {
      side: lv.side, stopDist: lv.stopDist, tp1Dist: lv.tp1Dist,
      confidence: res.confidence ?? null, netR: res.netR ?? null,
      gross: full(score(lv, 0, 0)), net: full(score(lv, read.spreadNum, comm)),
    };
  }

  let b = null;
  if (ex.f && ex.stopStd > 0) {
    const stopDist = ex.stopStd, tp1Dist = 1.5 * ex.stopStd;
    const both = (s) => ({
      gross: brief(score({ side: s, stopDist, tp1Dist }, 0, 0)),
      net: brief(score({ side: s, stopDist, tp1Dist }, read.spreadNum, comm)),
    });
    b = { stopDist, tp1Dist, long: both('buy'), short: both('sell') };
  }

  // A hole ahead: the furthest bar any scored trade reached (its exit, or the
  // last bar when the bars ran out first). More than GAP_BARS missing on the
  // way and nothing is scored: label (a) keeps its levels (an idea's read is
  // rebuilt from them) with gross and net null, label (b) goes.
  let gapAhead = false;
  if (scored.length) {
    const last = Math.max(...scored.map((o) => (o ? read.k + o.bars : bars.length - 1)));
    if (longestGap(bars, read.k, last, tf.minutes * 60000) > GAP_BARS) {
      gapAhead = true;
      if (a) a = { ...a, gross: null, net: null };
      b = null;
    }
  }

  return {
    t: bars[read.k].t, closeMs: read.closeMs,
    day: `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`,
    pair, tf: tf.id, kind,
    lean: side === 'buy' ? 'long' : side === 'sell' ? 'short' : null,
    spreadNum: read.spreadNum, cost, calendar, blackoutId: read.blackoutId ?? null,
    f: ex.f, fv: FEATURES_VERSION, cond: ex.cond ?? null,
    atr: ex.atr ?? null, stopStd: ex.stopStd ?? null,
    a, b, gapAhead, alerted,
  };
}

/** Which part of the fixed holdout a check's close falls in: 'dev', 'clean' (2025), 'seen' (2026) or 'fresh'. */
export function periodOfMs(closeMs) {
  if (closeMs < HELD_BACK_MS) return 'dev';
  if (closeMs > FRESH_AFTER_MS) return 'fresh';
  return closeMs < SEEN_MS ? 'clean' : 'seen';
}

/**
 * Builds the rows for every check whose close falls in [fromMs, toMs] and
 * writes them, in time order, to rowsPath(home, …), with its manifest beside
 * it. Both go to uniquely named temporary files first, renamed when complete,
 * so a killed build never leaves half a file under the real name and two
 * builds at once never write into each other's.
 *   bars      every bar the reads and labels may use (sorted, the full history
 *             when workers > 1: each worker parses `file` and indexes into it)
 *   file      the bar file `bars` came from (needed for workers > 1)
 *   source    names where the bars came from, for the read store's key
 *   useStore  default true; false recomputes every read and keeps none
 *   replace   default false: refuses to replace a rows file it may not
 *             (replaceRefusal: no manifest, a range this one does not cover,
 *             or checks this one would not write again), tested before any
 *             read and again just before the rename; and refuses to write a
 *             build with no checks at all
 *   holdout   default false: refuses checks closing on or after 2025-01-01
 *             (the caller records the look; the command line does). True
 *             writes to the '-holdout' rows path (rowsPath), never the
 *             development rows'
 * A lock file beside the rows file (lockPath) is held for the whole build; a
 * second build of the same file is refused while it exists.
 * Returns { path, manifest, rows, bytes, counts, gapAhead, heldBack, reads:
 * { fromStore, computed, replaced, workers }, ms: { reads, rows, total } }.
 * `counts` is by year and kind, and `gapAhead` the rows withheld across a hole
 * by year, for the development years only; `heldBack` is the number of rows
 * from 2025-01-01 on, by period (clean, seen, fresh), and nothing else.
 */
export async function buildRows({ pair, tf = null, bars, fromMs, toMs, cfg, cost = 'scaled', calendar = 'rules', workers = 1, home, file = null, source = null, useStore = true, chunk, minPerWorker, replace = false, holdout = false }) {
  if (!home) throw new Error('buildRows needs a home directory for the read store and the rows file.');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new Error('buildRows needs a range: fromMs <= toMs.');
  const t0 = Date.now();
  const opts = readOptions({ pair, tf, cfg, cost, calendar, workers, file, source, chunk, minPerWorker });
  const tfMs = tfInfo(timeframeFor(opts.cfg)).minutes * 60000;
  const path = rowsPath(home, opts, { holdout });
  const ks = checkIndices(bars, { fromMs, toMs, cfg: opts.cfg });

  // Refusals first, before any read is made.
  if (!holdout && ks.some((k) => bars[k].t + tfMs >= HELD_BACK_MS)) {
    throw new Error('Checks closing on or after 2025-01-01 are held back for one final test; the dataset holds none of their labels. End the range at 2024-12-31, or add --holdout (recorded in model.json).');
  }
  if (!ks.length && !replace) throw new Error(`No window checks between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()}: nothing to write (an empty rows file is written only with --replace).`);
  const planned = {
    fromMs, toMs, rows: ks.length,
    firstCloseMs: ks.length ? bars[ks[0]].t + tfMs : null, lastCloseMs: ks.length ? bars[ks[ks.length - 1]].t + tfMs : null,
  };
  if (!replace) { const why = replaceRefusal(path, planned); if (why) throw new Error(why); }

  // The lock: one build of this file at a time.
  mkdirSync(dirname(path), { recursive: true });
  const lock = lockPath(path);
  try {
    const fd = openSync(lock, 'wx');
    try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new Error(`Another build holds ${lock}. If none is running, one was killed: remove the file and build again.`);
    throw e;
  }
  try {
    return await writeRowsLocked();
  } finally {
    rmSync(lock, { force: true });
  }

  async function writeRowsLocked() {
    const stats = {};
    const got = await readsFor(bars, ks, { ...opts, stats }, { home, useStore });
    const t1 = Date.now();

    // The watcher with no filter, over these very reads. Its trades are scored
    // with the half rule so they match label (a); which ideas alert does not
    // depend on the scoring rule.
    const sent = new Set(alertPass(got.reads, bars, { cfg: opts.cfg, rule: RULE, pair, bothTouched: 'half' }).trades.map((t) => t.closeMs));
    const comm = costFor(pair, 0, opts.cfg).comm;

    const suffix = `${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    const tmp = `${path}.${suffix}`;
    const out = createWriteStream(tmp, 'utf8');
    const hash = createHash('sha256');
    const counts = {}, gapAhead = {}, heldBack = { clean: 0, seen: 0, fresh: 0 };
    let n = 0, firstCloseMs = null, lastCloseMs = null;
    try {
      for (const read of got.reads) {
        const row = rowFor(read, bars, { pair, cfg: opts.cfg, cost, calendar, comm, alerted: sent.has(read.closeMs) });
        const period = periodOfMs(row.closeMs);
        if (period === 'dev') {
          const y = row.day.slice(0, 4);
          counts[y] = counts[y] || {};
          counts[y][row.kind] = (counts[y][row.kind] || 0) + 1;
          if (row.gapAhead) gapAhead[y] = (gapAhead[y] || 0) + 1;
        } else heldBack[period]++;
        const line = JSON.stringify(row) + '\n';
        hash.update(line, 'utf8');
        if (!out.write(line)) await once(out, 'drain');
        if (firstCloseMs === null) firstCloseMs = row.closeMs;
        lastCloseMs = row.closeMs;
        n++;
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    }
    const manifest = {
      fromMs, toMs, firstCloseMs, lastCloseMs, rows: n, sha256: hash.digest('hex'),
      rowsKey: rowsKey(opts), storeKey: storeKey(opts),
      settings: { pair, tf: tfInfo(timeframeFor(opts.cfg)).id, cost, calendar },
      source: opts.source, holdout: !!holdout,
      featuresVersion: FEATURES_VERSION, labelVersion: LABELS.version,
      builtAt: new Date().toISOString(),
    };
    const mtmp = `${manifestPath(path)}.${suffix}`;
    writeFileSync(mtmp, JSON.stringify(manifest, null, 2) + '\n');
    // The same test once more, on what was really written and on the file as
    // it is now: whatever else wrote it during the reads is not undone quietly.
    if (!replace) {
      const why = replaceRefusal(path, { fromMs, toMs, rows: n, firstCloseMs, lastCloseMs });
      if (why) { rmSync(tmp, { force: true }); rmSync(mtmp, { force: true }); throw new Error(why); }
    }
    renameSync(tmp, path);
    renameSync(mtmp, manifestPath(path));
    const t2 = Date.now();
    return {
      path, manifest, rows: n, bytes: statSync(path).size, counts, gapAhead, heldBack,
      reads: { fromStore: got.fromStore, computed: got.computed, replaced: got.replaced, workers: stats.workers || 0 },
      ms: { reads: t1 - t0, rows: t2 - t1, total: t2 - t0 },
    };
  }
}

/**
 * The rows of a file, one at a time, in file order: `for await (const row of
 * readRows(path))`. Line by line, so a 110 MB file is never held whole. A line
 * that does not parse is an error (a rows file is written whole or not at
 * all, so one means the file was damaged), not something to skip quietly.
 */
export async function* readRows(path) {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let i = 0;
  for await (const line of lines) {
    i++;
    if (!line) continue;
    try { yield JSON.parse(line); } catch { throw new Error(`${path}: line ${i} is not a row (the file is damaged; build it again).`); }
  }
}

/** Every key a row has, in order (the ROW FORMAT). */
export const ROW_KEYS = Object.freeze(['t', 'closeMs', 'day', 'pair', 'tf', 'kind', 'lean', 'spreadNum', 'cost', 'calendar', 'blackoutId', 'f', 'fv', 'cond', 'atr', 'stopStd', 'a', 'b', 'gapAhead', 'alerted']);
export { FEATURE_NAMES };

/* ------------------------------------------------------------ command line */

/**
 * "2024-12-31" → that day's start (its end with endOfDay); "2026-10-14T20:45"
 * → that minute, UTC unless the string names a zone (Z, +01:00). Strict: a
 * date that does not exist (2024-02-30, 25:00) or any other shape is NaN,
 * never rolled over into a neighbouring day.
 */
export function parseWhen(s, { endOfDay = false } = {}) {
  if (s == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(String(s));
  if (!m) return NaN;
  const [, y, mo, d, hh, mi, ss = '00', frac = '0', zone = 'Z'] = m;
  const day = Date.UTC(+y, +mo - 1, +d);
  const back = new Date(day);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return NaN;
  if (hh === undefined) return endOfDay ? day + 86400e3 - 1 : day;
  if (+hh > 23 || +mi > 59 || +ss > 59) return NaN;
  let offMin = 0;
  if (zone !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (+z[2] > 14 || +z[3] > 59) return NaN;
    offMin = (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +z[3]);
  }
  return day + ((+hh * 60 + +mi - offMin) * 60 + +ss) * 1000 + Number(frac.padEnd(3, '0'));
}

/** The command line's flags: those that take a value, and those that stand alone. */
const VALUE_FLAGS = new Set(['pair', 'from', 'to', 'workers', 'cost', 'calendar']);
const PLAIN_FLAGS = new Set(['no-store', 'replace', 'holdout']);

/**
 * argv → { flags, error }. Every token must be a known --flag, a value flag
 * must have its value (not missing, not empty, not another --flag), and no
 * flag twice: a mistyped or half-given flag is an error, never its default
 * quietly.
 */
export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) return { error: `Unexpected "${tok}": every argument is a --flag.` };
    const k = tok.slice(2);
    if (k in flags) return { error: `--${k} is given twice.` };
    if (PLAIN_FLAGS.has(k)) { flags[k] = true; continue; }
    if (!VALUE_FLAGS.has(k)) return { error: `Unknown flag --${k} (${[...VALUE_FLAGS, ...PLAIN_FLAGS].map((f) => `--${f}`).join(', ')}).` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--') || v.trim() === '') return { error: `--${k} needs a value.` };
    flags[k] = v;
    i++;
  }
  return { flags };
}

async function main() {
  const fail = (msg) => { console.log(msg); process.exit(2); };
  const { flags, error } = parseArgs(process.argv.slice(2));
  if (error) fail(error);
  const has = (k) => flags[k] === true;
  const arg = (k, d = null) => (typeof flags[k] === 'string' ? flags[k] : d);

  const { ensureProxy } = await import('./net.mjs');
  ensureProxy();
  const { loadHistory, historyPath, deskHome } = await import('./history.mjs');

  const home = deskHome();
  const modelFile = process.env.SCALP_DESK_MODEL || join(dirname(process.env.SCALP_DESK_CONFIG || join(here, 'config.json')), 'model.json');
  const cfg = deskConfig();
  const pair = pairOf(arg('pair', 'bitcoin'));
  const tf = tfInfo(timeframeFor(cfg)).id;
  const fromMs = flags.from !== undefined ? parseWhen(flags.from) : parseWhen('2017-09-01');
  // Default: the last moment before the held-back years.
  const toMs = flags.to !== undefined ? parseWhen(flags.to, { endOfDay: true }) : HELD_BACK_MS - 1;
  const cost = arg('cost', 'scaled');
  const calendar = arg('calendar', 'rules');
  const workers = Number(arg('workers', defaultWorkers()));
  if (!pair) fail('--pair is bitcoin or gold.');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) fail('--from and --to take real dates like 2017-09-01 or 2024-12-31T20:45 (UTC), --from first.');
  if (!COST_MODES.includes(cost)) fail(`--cost is one of ${COST_MODES.join(', ')}.`);
  if (!CALENDAR_MODES.includes(calendar)) fail(`--calendar is one of ${CALENDAR_MODES.join(', ')}.`);
  if (!(Number.isInteger(workers) && workers >= 1)) fail('--workers takes a whole number, 1 or more.');

  // The held-back years: refused without --holdout; with it, the look is
  // recorded in model.json before anything is built, as the replay does.
  const notes = [];
  if (toMs >= HELD_BACK_MS) {
    if (!has('holdout')) fail('2025-01-01 onward is held back for one final test: the dataset holds none of its labels. End --to at 2024-12-31 (the default), or add --holdout (recorded in model.json).');
    const model = existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : {};
    const looks = Array.isArray(model.looks) ? model.looks : [];
    if (looks.length) notes.push(`The held-back years have already been looked at ${looks.length} time${looks.length > 1 ? 's' : ''}; these rows are not unseen data.`);
    looks.push({
      at: new Date().toISOString(), by: 'desk/dataset.mjs',
      range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      settings: { pair, timeframe: tf, rules: [RULE], cost, calendar, bothTouched: 'half', window: cfg.window },
      flags: Object.keys(flags).filter((f) => !['pair', 'from', 'to', 'workers', 'cost', 'calendar', 'holdout'].includes(f)),
    });
    model.looks = looks;
    mkdirSync(dirname(modelFile), { recursive: true });
    writeFileSync(modelFile, JSON.stringify(model, null, 2) + '\n');
    notes.push(`Held-back rows (from 2025-01-01) included: this look is recorded in ${modelFile}.`);
  }

  const t0 = Date.now();
  let bars, file, source;
  if (process.env.SCALP_DESK_BARS) {
    file = process.env.SCALP_DESK_BARS;
    bars = loadBarsFile(file, pair);
    source = `file:${resolve(file)}`;
  } else {
    // Extend the cache to cover the range (twelve days of warm-up before it,
    // and the day after for the last check's trade), then read the whole file:
    // the workers parse that same file and index into it.
    const h = await loadHistory(pair, tf, { fromMs: fromMs - 12 * 86400e3, toMs: toMs + 86400e3, home });
    if (!h.ok) fail(h.reason);
    file = historyPath(pair, tf, home);
    bars = loadBarsFile(file, pair);
    source = h.source === 'binance-vision' ? 'binance' : h.source;
  }
  if (!bars.length) fail(`No ${pair} ${tf} bars to build from.`);
  const tLoad = Date.now();
  const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${pair} ${tf} dataset · cost ${cost} · calendar ${calendar} · checks ${day(fromMs)} → ${day(toMs)} UTC · ${bars.length} bars loaded in ${((tLoad - t0) / 1000).toFixed(1)} s`);
  for (const n of notes) console.log(n);

  let r;
  try {
    r = await buildRows({ pair, bars, fromMs, toMs, cfg, cost, calendar, workers, home, file, source, useStore: !has('no-store'), replace: has('replace'), holdout: has('holdout') });
  } catch (e) {
    fail(`The rows could not be built: ${e.message}`);
  }
  const rd = r.reads;
  console.log(`reads: ${rd.fromStore + rd.computed} (${rd.fromStore} from the read store, ${rd.computed} computed${rd.computed ? (rd.workers ? ` on ${rd.workers} workers` : ' in this process') : ''}${rd.replaced ? `, ${rd.replaced} stored from other bars and recomputed` : ''}) in ${(r.ms.reads / 1000).toFixed(1)} s`);
  console.log(`rows written: ${r.rows} in ${(r.ms.rows / 1000).toFixed(1)} s → ${r.path} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  console.log(`manifest → ${manifestPath(r.path)} · rowsKey ${r.manifest.rowsKey} · sha256 ${r.manifest.sha256.slice(0, 16)}…`);
  const KINDS = ['idea', 'rejected', 'none', 'blocked', 'gap', 'no-data', 'stale'];
  const years = Object.keys(r.counts).sort();
  if (years.length) {
    console.log('development years, rows by kind:');
    for (const y of years) {
      const c = r.counts[y];
      const total = Object.values(c).reduce((s, x) => s + x, 0);
      const ahead = r.gapAhead[y] ? ` · labels withheld for a hole ahead ${r.gapAhead[y]}` : '';
      console.log(`  ${y}  ${KINDS.filter((k) => c[k]).map((k) => `${k} ${c[k]}`).join(' · ')} · total ${total}${ahead}`);
    }
  }
  const hb = r.heldBack;
  if (hb.clean + hb.seen + hb.fresh) {
    console.log(`held back from 2025-01-01, counted only: 2025 ${hb.clean} rows · 2026 to 14 October ${hb.seen} rows${hb.fresh ? ` · after the held-back window ${hb.fresh} rows` : ''}`);
  }
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
