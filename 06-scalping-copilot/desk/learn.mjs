#!/usr/bin/env node
/**
 * desk/learn.mjs — the learning layer (LEARNING-PLAN.md, Part 4): which
 * measurable conditions came before better or worse alerts, and whether that
 * still held on years the learner never saw.
 *
 * Why this exists. The user asked for "a way for the tool to learn the
 * algorithm of the charts". Markets do not run on a fixed algorithm; what can
 * be learned is which moments came before better or worse results in the
 * past. Most such patterns fade, so everything here is built to find out
 * honestly whether one did not:
 *
 *  - TWO SMALL MODELS, NOTHING CLEVER. Ridge regression in plain JavaScript,
 *    solved exactly, deterministic. The FILTER predicts the watcher's own
 *    trade (label a) at every check where the engine leaned, and can only
 *    REMOVE an alert the engine would have sent — never propose a side, never
 *    get past the gate, the dead zone, a blackout or checkPlan (plan rule 3).
 *    The RANKING model predicts a standard long and a standard short (label b)
 *    at every check, pooled with mirrored features; it answers "did it learn
 *    anything about the charts?" and never switches anything on.
 *  - EVERYTHING CHOSEN ON DEVELOPMENT YEARS. Walk-forward over 2019–2024: each
 *    year is predicted by a model trained only on the years before it (with a
 *    two-day gap), and the penalty and the kept share are picked from those
 *    out-of-sample results alone. The filter is judged THROUGH the alert
 *    sequence (reads.mjs alertPass with a predicate), because removing one
 *    alert changes which later ones are still-running-blocked or inside the
 *    cooldown; deleting rows from the unfiltered alert list would be wrong.
 *  - THE HOLDOUT IS LOOKED AT ONCE (plan rule 2), in two steps. `final`
 *    checks everything that sees no outcome — the recipe still matches
 *    today's code, every method file is committed and clean, the bars rise
 *    strictly and cover the window, the held-back reads (which hold no
 *    outcome) are complete within the recipe's tolerance — and records an
 *    "armed" entry for the session to commit. `final --run` refuses unless
 *    that entry is in the committed model.json; it writes "started" to
 *    model.json and to three logs outside the working tree
 *    ($SCALP_DESK_HOME/learn/finals.log; ~/.scalp-desk/learn/finals.log, with
 *    ~ the account's home from the system (os.userInfo), not $HOME; and <git
 *    common dir>/scalp-desk-finals.log — no checkout, stash, reset or clean
 *    touches any of them, and no environment variable moves the last two)
 *    immediately before the first outcome is computed, then the results. It
 *    holds a lock in $SCALP_DESK_HOME and another in the git common dir, so
 *    two finals started together under different homes still exclude each
 *    other. A final that
 *    started or ran, for an overlapping window, in ANY committed version of
 *    model.json, the working copy or any of the logs, refuses every later
 *    final and every refit. Both fit and final work only on
 *    <project>/desk/model.json (another model file would have a history of
 *    its own) and refuse in a shallow clone (its history is cut short). The two tests are declared in advance
 *    (T1 filter, T2 ranking, each at z = 2.241), 2025 (clean) and 2026 (seen
 *    while choosing the 1.5R rule) are printed apart, and kept alerts are
 *    always shown beside removed ones.
 *  - NO HELD-BACK ROW IS READ OUTSIDE `final --run`. The dataset stops at
 *    2024-12-31 (dataset.mjs refuses later checks without --holdout), `fit`
 *    refuses rows whose manifest runs into 2025, and rows from 2025-01-01 are
 *    in any case dropped as the file is read; `fit` and `similar` never see
 *    them, and their bars stop at 2024-12-31.
 *
 * What it is not. A forecast, a trading signal, or a reason to trade. Nothing
 * here reaches a live alert or a push, in any mode (plan rule 3); "similar
 * setups" is description for the journal or on request, never validated as a
 * predictor. A fail is worded "could not show an improvement", never "found
 * nothing": the test has little power against a small real edge (Part 4).
 *
 *   node desk/learn.mjs status|report --pair bitcoin
 *   node desk/learn.mjs fit --pair bitcoin [--rows <file>] [--bars <file>] [--store <file>] [--test-model <file>]
 *   node desk/learn.mjs final [--run] --pair bitcoin [--bars <file>] [--workers <n>]
 *   node desk/learn.mjs similar --pair bitcoin --at <UTC time> --side buy|sell [--rows <file>]
 *
 * Paths: the rows are exactly dataset.mjs rowsPath() for the recipe's dataset
 * settings (cost scaled, calendar rules, bars from binance), under
 * $SCALP_DESK_HOME/learn/, with its '<rows file>.manifest.json' beside it — no
 * other file is picked up by itself; only `fit` and `similar` read rows. The
 * model file is $SCALP_DESK_MODEL or model.json beside the config
 * ($SCALP_DESK_CONFIG or desk/config.json), as the replay's "looks" already
 * are; `fit` and `final` refuse any but desk/model.json. --test-model <file>
 * (scratch runs only) names another for `fit`; `final` refuses it on the
 * command line — a second model file committed beside the first would carry a
 * history of its own, and a fresh clone could run a second final on it
 * (review, 17 Oct 2026). Tests reach armFinal and runFinal through the module.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, createReadStream, openSync, writeSync, fsyncSync, closeSync, unlinkSync, realpathSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_NAMES, FEATURES_VERSION, DIRECTIONAL, SWAPPED, sideSigned,
} from './features.mjs';
import {
  alertPass, computeReads, checkIndices, engineFiles, extraFor, loadBarsFile, loadStore, sliceOf, spreadAt, storePath, defaultWorkers, DEFAULT_RULES, GAP_BARS,
} from './reads.mjs';
import { outcome } from './outcome.mjs';
import { clusteredByDay } from './stats.mjs';
import { byCondition, formatConditions, HOLDOUT } from './conditions.mjs';
import { loadHistory, historyPath } from './history.mjs';
import { costFor, withDefaults, pairOf, timeframeFor } from './lib.mjs';
import { TARGET_RULE } from './live.mjs';
import { windowState } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { INSTRUMENTS } from '../src/instruments.js';
import * as dataset from './dataset.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

/* ------------------------------------------------------- the declared method */

/** The penalty grid (on the MEAN loss, so a λ means the same at any sample size). */
export const LAMBDAS = Object.freeze([0.01, 0.1, 1, 10]);
/** The filter's kept share: the top 75%, 60% or 50% of training-period predictions. */
export const QS = Object.freeze([0.75, 0.6, 0.5]);
/** Walk-forward test years: each predicted by a model trained only on the years before it. */
export const TEST_YEARS = Object.freeze([2019, 2020, 2021, 2022, 2023, 2024]);
/** Days left out between the last training row and the first test row. */
export const PURGE_DAYS = 2;
/** One-sided 1.25%: 5% over two tests, two-sided halves → Bonferroni over T1 and T2. */
export const Z_TEST = 2.241;
/** T1 needs at least this many kept alerts on the holdout, whatever their average. */
export const MIN_KEPT = 140;
/** Day-block bootstrap: resamples, the quantile read as the lower bound, and a fixed seed. */
export const BOOT = Object.freeze({ B: 2000, quantile: 0.0125, seed: 20261016 });
/** T2's bootstrap seed: its own stream, declared beside T1's. */
export const T2_SEED = BOOT.seed + 1;
/** The standard trade of label (b): 1.5 times its stop distance. */
export const B_TARGET = 1.5;

/**
 * The calendars (lead decision, 17 Oct). Training and walk-forward rows use
 * 'rules', the same for every development year (2017–2024, whose tier-1
 * tables are incomplete); the one held-back evaluation uses 'full', the live
 * desk's calendar. Features do not depend on the calendar; only which checks
 * are tradeable (blocked or not) does.
 */
export const TRAIN_CALENDAR = 'rules';
export const HOLDOUT_CALENDAR = 'full';
/** The training rows' cost mode (the plan's development figures), and the holdout's. */
export const TRAIN_COST = 'scaled';
export const HOLDOUT_COST = 'max';
/** Where the rows' bars came from (dataset.mjs names Binance's history so). */
export const TRAIN_SOURCE = 'binance';

/**
 * What the held-back bars and reads must be before anything is recorded:
 * at least `barsBefore` bars before 2025-01-01 (the first check's 999-bar
 * slice, live.mjs CLOSED_BARS, and one to spare), and of the window checks
 * the calendar expects, at most
 * `maxMissingShare` without a bar and at most `maxGapShare` read as 'gap',
 * 'no-data' or 'stale'. None of this sees an outcome.
 */
export const HOLDOUT_DATA = Object.freeze({ barsBefore: 1000, maxMissingShare: 0.01, maxGapShare: 0.02, gapKinds: Object.freeze(['gap', 'no-data', 'stale']) });

/**
 * Heavy-tailed features (distances in ATRs), clipped at each training fold's
 * own 1st and 99th percentiles before standardising, so that a handful of
 * release bars cannot own a coefficient. features.mjs stores them as measured
 * and leaves the clipping to the fold: no fold, no percentiles.
 */
export const CLIPPED = Object.freeze([
  'ret_1', 'ret_4', 'ret_16', 'ret_96', 'close_vs_ema21', 'close_vs_ema50', 'close_vs_vwap', 'level_ahead', 'level_behind',
]);
export const CLIP_AT = Object.freeze([0.01, 0.99]);

const P = FEATURE_NAMES.length;
const FROM_MS = Date.parse(HOLDOUT.from), SEEN_MS = Date.parse(HOLDOUT.seenFrom), TO_MS = Date.parse(HOLDOUT.to);
const DAY_MS = 86400e3;
const FEATURES_EXTRA = join(here, 'features-extra.mjs');

/* --------------------------------------------------------------- linear algebra */

/**
 * Solves A x = b for a symmetric positive-definite A (n×n, array of rows) by
 * Cholesky. A ridge system with λ > 0 is always positive definite; a failure
 * here means a NaN got in, and is an error rather than a quiet fallback.
 */
export function choleskySolve(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) throw new Error('The ridge system is not positive definite (a feature holds NaN or infinity).');
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

/**
 * Ridge for every λ in `lambdas` from one pass over the data: minimises
 *   (1/n) Σ (y − b − x·w)² + λ ‖w‖²
 * with the intercept b unpenalised, solved exactly on the centred normal
 * equations (Σ/n + λI) w = c/n, b = ȳ − x̄·w. X is an array of equal-length
 * Float64Arrays (already standardised by the caller, though nothing here
 * assumes it). Returns [{ lambda, intercept, w }] in the order given.
 */
export function ridgePath(X, y, lambdas) {
  const n = X.length;
  if (!n) throw new Error('ridge needs at least one row');
  const p = X[0].length;
  const xbar = new Float64Array(p);
  let ybar = 0;
  for (let i = 0; i < n; i++) { const x = X[i]; for (let j = 0; j < p; j++) xbar[j] += x[j]; ybar += y[i]; }
  for (let j = 0; j < p; j++) xbar[j] /= n;
  ybar /= n;
  const G = Array.from({ length: p }, () => new Float64Array(p));
  const c = new Float64Array(p);
  const d = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const x = X[i];
    for (let j = 0; j < p; j++) d[j] = x[j] - xbar[j];
    const r = y[i] - ybar;
    for (let a = 0; a < p; a++) {
      const da = d[a];
      if (da === 0) continue;
      c[a] += da * r;
      const Ga = G[a];
      for (let b = a; b < p; b++) Ga[b] += da * d[b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { G[a][b] /= n; G[b][a] = G[a][b]; }
  for (let a = 0; a < p; a++) c[a] /= n;
  return lambdas.map((lambda) => {
    if (!(lambda > 0)) throw new Error(`λ must be above 0, not ${lambda}`);
    const A = G.map((row, a) => { const r = Float64Array.from(row); r[a] += lambda; return r; });
    const w = p ? choleskySolve(A, c) : new Float64Array(0);
    let b = ybar;
    for (let j = 0; j < p; j++) b -= xbar[j] * w[j];
    return { lambda, intercept: b, w };
  });
}

/** One λ: ridgePath's single fit. */
export const ridgeFit = (X, y, lambda) => ridgePath(X, y, [lambda])[0];

/* --------------------------------------------------------------- standardising */

/** Type-7 quantile (linear between order statistics) of a SORTED array. */
export function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
export const quantile = (xs, p) => quantileSorted(Float64Array.from(xs).sort(), p);

const CLIP_SET = new Set(CLIPPED);

/**
 * The standardiser of one training fold, fitted on that fold's rows ONLY
 * (vectors as Float64Arrays in FEATURE_NAMES order, NaN for "not measurable").
 * Per feature: the clipped ones get the fold's 1st/99th percentiles; then the
 * mean and standard deviation of the measured values. A feature with no
 * measured value or no spread in this fold is dropped from it (sd = 0 would
 * divide by zero; a constant carries nothing a ridge intercept does not).
 * A null becomes the training mean — 0 once standardised — and nothing else:
 * no "was missing" indicator (the plan's rule for nulls).
 */
export function fitStandardiser(X, { clip = true } = {}) {
  const keep = [], mean = [], sd = [], lo = [], hi = [];
  for (let j = 0; j < P; j++) {
    const vals = [];
    for (const x of X) { const v = x[j]; if (!Number.isNaN(v)) vals.push(v); }
    if (!vals.length) continue;
    let l = null, h = null;
    if (clip && CLIP_SET.has(FEATURE_NAMES[j])) {
      const s = Float64Array.from(vals).sort();
      l = quantileSorted(s, CLIP_AT[0]); h = quantileSorted(s, CLIP_AT[1]);
      for (let i = 0; i < vals.length; i++) vals[i] = Math.min(h, Math.max(l, vals[i]));
    }
    let m = 0;
    for (const v of vals) m += v;
    m /= vals.length;
    let ss = 0;
    for (const v of vals) ss += (v - m) ** 2;
    const s = Math.sqrt(ss / vals.length);
    if (!(s > 1e-12)) continue;
    keep.push(j); mean.push(m); sd.push(s); lo.push(l); hi.push(h);
  }
  return { idx: keep, names: keep.map((j) => FEATURE_NAMES[j]), mean, sd, lo, hi };
}

/** A vector (FEATURE_NAMES order, NaN = null) through a fitted standardiser. */
export function standardise(st, x) {
  const z = new Float64Array(st.idx.length);
  for (let i = 0; i < st.idx.length; i++) {
    let v = x[st.idx[i]];
    if (Number.isNaN(v) || v === null || v === undefined) { z[i] = 0; continue; }
    if (st.lo[i] !== null) v = Math.min(st.hi[i], Math.max(st.lo[i], v));
    z[i] = (v - st.mean[i]) / st.sd[i];
  }
  return z;
}

/** A fitted model's gross-R prediction for one vector. */
export function predict(m, x) {
  const z = standardise(m.st, x);
  let s = m.intercept;
  for (let i = 0; i < z.length; i++) s += m.w[i] * z[i];
  return s;
}

/** The features of a check as seen from `side`, as a vector: sideSigned(f, side) in FEATURE_NAMES order. */
export function vectorOf(f, side) {
  const s = sideSigned(f, side);
  const v = new Float64Array(P);
  for (let j = 0; j < P; j++) { const x = s[FEATURE_NAMES[j]]; v[j] = typeof x === 'number' && Number.isFinite(x) ? x : NaN; }
  return v;
}

/* ------------------------------------------------------------------- rows */

const SIDE_OF = { buy: 'long', sell: 'short' };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One stored row (the plan's pinned format) reduced to what the learner reads:
 * the feature vectors from both sides (so a fold never re-signs them), the
 * labels' results without their paths, and `gapAhead` (a trade from this check
 * would cross a hole in the bars: label (a) has its levels but no result, and
 * the walk-forward's alert passes leave the check out).
 */
export function compactRow(row) {
  const out = {
    t: row.t, closeMs: row.closeMs, day: row.day, pair: row.pair, tf: row.tf, kind: row.kind, lean: row.lean ?? null,
    spreadNum: row.spreadNum, cost: row.cost, calendar: row.calendar, cond: row.cond ?? null,
    atr: row.atr ?? null, stopStd: row.stopStd ?? null, alerted: row.alerted === true, gapAhead: row.gapAhead === true,
    vL: null, vS: null, a: null, b: null,
  };
  if (row.f) { out.vL = vectorOf(row.f, 1); out.vS = vectorOf(row.f, -1); }
  if (row.a) {
    const a = row.a;
    out.a = {
      side: a.side, stopDist: a.stopDist, tp1Dist: a.tp1Dist, confidence: a.confidence ?? null, netR: a.netR ?? null,
      gross: a.gross ? { r: a.gross.r, how: a.gross.how } : null, net: a.net ? { r: a.net.r, how: a.net.how } : null,
    };
  }
  if (row.b) {
    const side = (s) => (s ? { gross: s.gross ? { r: s.gross.r, how: s.gross.how } : null, net: s.net ? { r: s.net.r, how: s.net.how } : null } : null);
    out.b = { stopDist: row.b.stopDist, tp1Dist: row.b.tp1Dist, long: side(row.b.long), short: side(row.b.short) };
  }
  return out;
}

/**
 * Throws, naming the problem, unless a stored row is one this learner can
 * read: the pair asked for, today's feature definitions (a row from another
 * FEATURES_VERSION means something else), every feature name present, and an
 * idea with its label (a) — an idea always has a checkPlan stop and target,
 * so one without is a damaged row, and the alert pass could not take it.
 */
function checkRow(row, pair, line) {
  const where = `Row ${line}`;
  if (!row || typeof row !== 'object') throw new Error(`${where} is not a JSON object.`);
  if (row.pair !== pair) throw new Error(`${where} is ${row.pair}, not ${pair}.`);
  if (!Number.isFinite(row.closeMs) || !Number.isFinite(row.t)) throw new Error(`${where} has no bar times (t, closeMs).`);
  if (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new Error(`${where} has no London day (YYYY-MM-DD).`);
  if (row.fv !== FEATURES_VERSION) throw new Error(`${where} was made with features version ${row.fv}; this learner reads version ${FEATURES_VERSION}. Rebuild the rows.`);
  if (row.f) for (const n of FEATURE_NAMES) if (!(n in row.f)) throw new Error(`${where} has no feature "${n}".`);
  if (row.kind === 'idea' && !(row.a && typeof row.a === 'object')) throw new Error(`${where} is an idea without its label (a); the rows are damaged. Rebuild them.`);
}

/** The manifest dataset.mjs writes beside a rows file. */
export const manifestPath = (rowsPath) => dataset.manifestPath(rowsPath);

/**
 * rowsKey for a manifest, recomputed from today's code (dataset.mjs
 * rowsKeyFor), with this desk's config and the manifest's own bar source.
 */
export function rowsKeyNow(manifest, cfg) {
  if (typeof dataset.rowsKeyFor !== 'function') throw new Error('desk/dataset.mjs has no rowsKeyFor(): it cannot say which rows today\'s code would make.');
  return dataset.rowsKeyFor(manifest.settings, { cfg, ...(manifest.source !== undefined ? { source: manifest.source } : {}) });
}

/** A manifest as the recipe keeps it: everything but when it was built. */
export const manifestRecord = (m) => {
  const { builtAt: _b, ...rest } = m;
  return rest;
};

/**
 * Reads and checks a rows file's manifest: it must exist, its sha256 must be
 * the file's, and its rowsKey must be the one today's code computes for its
 * settings — rows made by an older engine, features module or label code are
 * refused, whatever the file is called. Returns the manifest.
 *   rowsKeyFor   (settings, manifest) => key; default rowsKeyNow with `cfg` (tests stand in)
 */
export async function checkManifest(path, { pair, cfg, rowsKeyFor = null }) {
  if (!existsSync(path)) throw new Error(`No rows at ${path}. Build them first (node desk/dataset.mjs --pair bitcoin).`);
  const mp = manifestPath(path);
  if (!existsSync(mp)) throw new Error(`The rows at ${path} have no manifest (${mp}); they cannot be tied to the code that made them. Build them again with node desk/dataset.mjs.`);
  let m;
  try { m = JSON.parse(readFileSync(mp, 'utf8')); } catch { throw new Error(`The manifest ${mp} is not valid JSON. Build the rows again.`); }
  for (const k of ['fromMs', 'toMs', 'rows', 'sha256', 'rowsKey', 'storeKey', 'settings', 'featuresVersion', 'labelVersion']) {
    if (m[k] === undefined) throw new Error(`The manifest ${mp} has no "${k}". Build the rows again.`);
  }
  if (m.settings.pair !== pair) throw new Error(`The rows at ${path} are ${m.settings.pair}, not ${pair}.`);
  const sha = await dataset.sha256File(path);
  if (sha !== m.sha256) throw new Error(`The rows at ${path} are not the file their manifest describes (sha256 differs): the file was changed or cut short. Build them again.`);
  const now = rowsKeyFor ? rowsKeyFor(m.settings, m) : rowsKeyNow(m, cfg);
  if (now !== m.rowsKey) throw new Error(`The rows at ${path} were made by different code or settings (rows key ${m.rowsKey}; today's code gives ${now}). Build them again with node desk/dataset.mjs.`);
  if (m.featuresVersion !== FEATURES_VERSION) throw new Error(`The rows at ${path} were made with features version ${m.featuresVersion}; this learner reads ${FEATURES_VERSION}. Build them again.`);
  return m;
}

/**
 * The development rows from a JSONL file, read line by line (a bitcoin file
 * is ~150 MB). Held-back rows — closeMs from 2025-01-01 — are dropped as they
 * are read and nothing of them is kept, counted only as a number: the plan's
 * rule 2 forbids printing or aggregating them before the final run, and the
 * final run computes its own. Returns { rows (time order), heldBack, settings
 * { cost, calendar, tf } } and refuses a file that mixes settings, holds two
 * rows for one close, or (with `manifest`) disagrees with its manifest.
 */
export async function loadRows(path, { pair, manifest = null }) {
  if (!existsSync(path)) throw new Error(`No rows at ${path}. Build them first (node desk/dataset.mjs).`);
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  const rows = [];
  let heldBack = 0, n = 0, count = 0;
  const seen = { cost: new Set(), calendar: new Set(), tf: new Set() };
  const closes = new Set();
  for await (const line of lines) {
    n++;
    if (!line.trim()) continue;
    count++;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`Row ${n} of ${path} is not valid JSON (a run cut short?). Rebuild the rows.`); }
    if (row && Number.isFinite(row.closeMs) && row.closeMs >= FROM_MS) { heldBack++; continue; }
    checkRow(row, pair, n);
    if (closes.has(row.closeMs)) throw new Error(`Row ${n} repeats the check at ${new Date(row.closeMs).toISOString()}; a check is one row. Rebuild the rows.`);
    closes.add(row.closeMs);
    seen.cost.add(row.cost); seen.calendar.add(row.calendar); seen.tf.add(row.tf);
    rows.push(compactRow(row));
  }
  for (const k of Object.keys(seen)) {
    if (seen[k].size > 1) throw new Error(`The rows mix ${k} settings (${[...seen[k]].join(', ')}); a learner run uses one.`);
  }
  const settings = { cost: [...seen.cost][0] ?? null, calendar: [...seen.calendar][0] ?? null, tf: [...seen.tf][0] ?? null };
  if (manifest) {
    if (count !== manifest.rows) throw new Error(`The rows file holds ${count} rows; its manifest says ${manifest.rows}. Build it again.`);
    for (const k of ['cost', 'calendar', 'tf']) {
      if (settings[k] !== null && settings[k] !== manifest.settings[k]) throw new Error(`The rows say ${k} ${settings[k]}; their manifest says ${manifest.settings[k]}. Build them again.`);
    }
  }
  rows.sort((x, y) => x.closeMs - y.closeMs);
  return { rows, heldBack, settings };
}

/**
 * The training dataset: the manifest checked (checkManifest), then the rows
 * read and checked against it. Returns { rows, heldBack, settings, manifest }.
 */
export async function loadDataset(path, { pair, cfg, rowsKeyFor = null }) {
  const manifest = await checkManifest(path, { pair, cfg, rowsKeyFor });
  const got = await loadRows(path, { pair, manifest });
  return { ...got, manifest };
}

/** The decision-time cost of a trade in R: (spread + commission) over its stop distance. */
export const costInR = (spreadNum, comm, stopDist) => (spreadNum + comm) / stopDist;

/* ------------------------------------------------------------------- models */

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
// Training and thresholds take only rows with a scored label: a gap-ahead row's
// a.gross is null, and so is a trade still open when the bars ran out.
const filterRow = (r) => (r.kind === 'idea' || r.kind === 'rejected') && r.a && r.a.gross && finite(r.a.gross.r) && r.vL && r.a.stopDist > 0;
const rankingRow = (r) => r.b && r.vL && r.b.long && r.b.short && r.b.long.gross && r.b.short.gross
  && finite(r.b.long.gross.r) && finite(r.b.short.gross.r) && r.b.stopDist > 0;
const sideVec = (r, side) => (side === 'buy' || side === 'long' || side === 1 ? r.vL : r.vS);

/** The filter's training set: every engine-lean check with label (a), on the lean's side. */
export function filterData(rows) {
  const X = [], y = [];
  for (const r of rows) if (filterRow(r)) { X.push(sideVec(r, r.a.side)); y.push(r.a.gross.r); }
  return { X, y };
}

/** The ranking model's: every check with label (b), long and short pooled, mirrored, one intercept. */
export function rankingData(rows) {
  const X = [], y = [];
  for (const r of rows) if (rankingRow(r)) {
    X.push(r.vL); y.push(r.b.long.gross.r);
    X.push(r.vS); y.push(r.b.short.gross.r);
  }
  return { X, y };
}

/**
 * Ridge on one data set for every λ: the standardiser fitted on these rows,
 * then one fit per λ. Returns { st, n, fits: { [λ]: { st, intercept, w } } }.
 */
export function fitOne({ X, y }, lambdas = LAMBDAS) {
  if (!X.length) throw new Error('No training rows for this model.');
  const st = fitStandardiser(X);
  const Z = X.map((x) => standardise(st, x));
  const fits = {};
  for (const f of ridgePath(Z, y, lambdas)) fits[f.lambda] = { st, intercept: f.intercept, w: f.w };
  return { st, n: X.length, fits };
}

/** Both models on one set of training rows. */
export function fitModels(trainRows, lambdas = LAMBDAS) {
  return { filter: fitOne(filterData(trainRows), lambdas), ranking: fitOne(rankingData(trainRows), lambdas) };
}

/** The filter's predicted NET R for a row with label (a): predicted gross minus the decision-time cost. */
export const filterNet = (m, r, comm) => predict(m, sideVec(r, r.a.side)) - costInR(r.spreadNum, comm, r.a.stopDist);

/** The ranking model's predicted net R for one side of a row with label (b). */
export const rankingNet = (m, r, side, comm) => predict(m, sideVec(r, side)) - costInR(r.spreadNum, comm, r.b.stopDist);

/**
 * The filter's threshold for kept share q: the (1 − q) quantile of the
 * training-period predicted net R among training rows the unfiltered watcher
 * ALERTED on. A check is kept when its prediction is at or above it.
 */
export function thresholdFor(m, trainRows, q, comm) {
  const preds = [];
  for (const r of trainRows) if (r.alerted && filterRow(r)) preds.push(filterNet(m, r, comm));
  if (!preds.length) throw new Error('No alerted training rows to set the filter\'s threshold from.');
  return quantile(preds, 1 - q);
}

/** A check where the gate was open (the engine read the chart): only those are ever tradeable. */
export const GATE_OPEN_ROW = Object.freeze(['none', 'idea', 'rejected']);
export const GATE_OPEN_READ = Object.freeze(['none', 'lean']);

/**
 * P2's own threshold, on the ranking model's scale (the filter's is on the
 * filter's). Over the training rows where the gate was open and label (b) is
 * known, each check's higher-side predicted net R; the threshold is the
 * (1 − share) quantile of those, where share = (gate-open training checks the
 * unfiltered watcher alerted on ÷ gate-open training checks) × q. So P2 is
 * offered about as many checks as the kept filter, on the ranking model's own
 * scale. This rule was proposed in review and confirmed by the lead (17 Oct)
 * before any recipe was committed; once a recipe is committed it is fixed.
 * Returns { threshold, share }.
 */
export function p2ThresholdFor(m, trainRows, q, comm) {
  const best = [];
  let open = 0, alerted = 0;
  for (const r of trainRows) {
    if (!GATE_OPEN_ROW.includes(r.kind)) continue;
    open++;
    if (r.alerted) alerted++;
    if (rankingRow(r)) best.push(Math.max(rankingNet(m, r, 'long', comm), rankingNet(m, r, 'short', comm)));
  }
  if (!alerted || !best.length) throw new Error('No alerted gate-open training rows to set P2\'s threshold from.');
  const share = (alerted / open) * q;
  return { threshold: quantile(best, 1 - share), share };
}

/* ------------------------------------------------------------- the statistics */

/** A deterministic PRNG (mulberry32): the same seed gives the same bootstrap, on any machine. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayOfAt = (at) => at.slice(0, 10);

/**
 * Mean, count, days and a day-clustered range of trades ({ at, r }), with the
 * G/(G−1) small-sample factor on the clustered error. `z` sets the range
 * (1.96 for the usual 95%; Z_TEST for the tests' one-sided bound).
 */
export function summary(trades, z = 1.96) {
  const st = clusteredByDay(trades);
  if (!st) return { n: 0, mean: null, days: 0, se: null, lo: null, hi: null };
  const G = st.days;
  const se = G > 1 ? st.seDay * Math.sqrt(G / (G - 1)) : null;
  return { n: st.n, mean: st.mean, days: G, se, lo: se === null ? null : st.mean - z * se, hi: se === null ? null : st.mean + z * se };
}

/**
 * T1 — the filter, on the same holdout as the unfiltered watcher. Passes only
 * if (a) the kept alerts' day-clustered lower bound at z is above 0, (b) the
 * kept-minus-unfiltered mean R per trade has a day-block-bootstrap lower bound
 * (the 1.25% quantile of B resamples of whole days) above 0, and (c) there are
 * at least `minKept` kept alerts. kept, unfiltered: [{ at, r }].
 */
export function t1Test(kept, unfiltered, { z = Z_TEST, B = BOOT.B, q = BOOT.quantile, seed = BOOT.seed, minKept = MIN_KEPT } = {}) {
  const k = summary(kept, z), u = summary(unfiltered, z);
  const days = new Map();
  const slot = (d) => { if (!days.has(d)) days.set(d, { sk: 0, nk: 0, su: 0, nu: 0 }); return days.get(d); };
  for (const t of kept) { const s = slot(dayOfAt(t.at)); s.sk += t.r; s.nk++; }
  for (const t of unfiltered) { const s = slot(dayOfAt(t.at)); s.su += t.r; s.nu++; }
  const D = [...days.keys()].sort().map((d) => days.get(d));
  const diff = k.n && u.n ? k.mean - u.mean : null;
  let diffLo = null;
  if (D.length > 1 && k.n && u.n) {
    const rand = prng(seed);
    const stats = [];
    for (let b = 0; b < B; b++) {
      let sk = 0, nk = 0, su = 0, nu = 0;
      for (let i = 0; i < D.length; i++) { const s = D[Math.floor(rand() * D.length)]; sk += s.sk; nk += s.nk; su += s.su; nu += s.nu; }
      if (nk && nu) stats.push(sk / nk - su / nu);
    }
    diffLo = quantileSorted(Float64Array.from(stats).sort(), q);
  }
  const a = k.lo !== null && k.lo > 0, bOk = diffLo !== null && diffLo > 0, c = k.n >= minKept;
  return { pass: a && bOk && c, a, b: bOk, c, kept: k, unfiltered: u, diff, diffLo, minKept, z, B, quantile: q };
}

/** Pearson correlation from running sums. */
function pearson(s) {
  const vx = s.n * s.xx - s.x * s.x, vy = s.n * s.yy - s.y * s.y;
  if (!(vx > 0 && vy > 0)) return null;
  return (s.n * s.xy - s.x * s.y) / Math.sqrt(vx * vy);
}

/**
 * T2 — ranking: the correlation between side-aligned predicted net R and the
 * realised label-(b) net R across every check (both sides), with a day-block
 * bootstrap: whole days are resampled, so the strong same-day overlap of the
 * labels is kept inside each draw. Passes if the 1.25% quantile is above 0.
 * pairs: [{ day, pred, real }].
 */
export function t2Test(pairs, { B = BOOT.B, q = BOOT.quantile, seed = T2_SEED } = {}) {
  const days = new Map();
  const all = { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 };
  for (const p of pairs) {
    if (!days.has(p.day)) days.set(p.day, { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 });
    for (const s of [days.get(p.day), all]) { s.n++; s.x += p.pred; s.y += p.real; s.xx += p.pred * p.pred; s.yy += p.real * p.real; s.xy += p.pred * p.real; }
  }
  const corr = pearson(all);
  const D = [...days.keys()].sort().map((d) => days.get(d));
  let lo = null;
  if (D.length > 1 && corr !== null) {
    const rand = prng(seed);
    const stats = [];
    for (let b = 0; b < B; b++) {
      const s = { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 };
      for (let i = 0; i < D.length; i++) { const d = D[Math.floor(rand() * D.length)]; for (const k in s) s[k] += d[k]; }
      const c = pearson(s);
      if (c !== null) stats.push(c);
    }
    lo = quantileSorted(Float64Array.from(stats).sort(), q);
  }
  return { pass: lo !== null && lo > 0, corr, lo, n: all.n, days: D.length, B, quantile: q };
}

/* ------------------------------------------------------------ reads for the pass */

/**
 * Reads the alert pass can take, rebuilt from rows: the kind, the spread, and
 * for an engine lean its 1.5R-rule verdict with the plan's levels. checkPlan's
 * entry is the last close (a market order at the current price), so entry and
 * the first target come back exactly from the bar and the row's distances.
 * Used when the read store for the dataset's settings is not on disk (and in
 * tests); a store, when present, is preferred and its reads are checked
 * against the rows.
 */
export function readsFromRows(rows, bars) {
  const index = new Map(bars.map((b, k) => [b.t, k]));
  const out = [];
  for (const r of rows) {
    const k = index.get(r.t);
    if (k === undefined) throw new Error(`The bars have no bar at ${new Date(r.t).toISOString()} for a stored row.`);
    if (r.kind === 'idea' && !r.a) throw new Error(`The row at ${new Date(r.closeMs).toISOString()} is an idea without its label (a); the rows are damaged.`);
    const read = { k, closeMs: r.closeMs, nowMs: r.closeMs + 20000, spreadNum: r.spreadNum, kind: r.kind };
    if ((r.kind === 'idea' || r.kind === 'rejected') && r.a) {
      const entry = bars[k].c;
      const buy = r.a.side === 'buy';
      read.kind = 'lean';
      read.rules = {
        [TARGET_RULE]: {
          kind: r.kind, decision: r.kind === 'idea' ? r.a.side : 'no_trade', confidence: r.a.confidence, entry,
          stopDistance: r.a.stopDist, takeProfit1: buy ? entry + r.a.tp1Dist : entry - r.a.tp1Dist, netR: r.a.netR,
        },
      };
    }
    out.push(read);
  }
  return out.sort((x, y) => x.k - y.k);
}

/**
 * The read store's reads for these rows, when a store made with the dataset's
 * settings is on disk and holds every one of them from the same bars. The
 * store the rows' manifest names (`storeKey`) is tried first, then the keys
 * the dataset may have used (or `file` names the store). Returns { reads, path } or
 * null. A store read whose spread or kind disagrees with its row is an error:
 * the rows and the store were made by different runs.
 */
export async function readsFromStore(rows, bars, { pair, cfg, cost, calendar, home, file = null, storeKey = null }) {
  const index = new Map(bars.map((b, k) => [b.t, k]));
  const candidates = [];
  if (file) candidates.push(file);
  else if (home) {
    // The store the rows' manifest names comes first.
    if (storeKey) candidates.push(join(home, 'learn', `${pair}-${tfInfo(timeframeFor(cfg)).id}-${storeKey}.reads.jsonl`));
    for (const extraModule of [FEATURES_EXTRA, null]) {
      if (extraModule && !existsSync(extraModule)) continue;
      for (const source of ['binance', null]) {
        for (const rules of [DEFAULT_RULES, [TARGET_RULE]]) {
          try { candidates.push(storePath(home, { pair, cfg, rules, cost, calendar, source, extraModule })); } catch { /* not a keyable combination */ }
        }
      }
    }
  }
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    const stored = await loadStore(path);
    const reads = [];
    let complete = true;
    for (const r of rows) {
      const s = stored.get(r.closeMs);
      const k = index.get(r.t);
      if (!s || k === undefined) { complete = false; break; }
      const sl = sliceOf(bars, k);
      if (!s.slice || s.slice.from !== sl.from || s.slice.n !== sl.n || s.slice.hash !== sl.hash) { complete = false; break; }
      const kind = s.kind === 'lean' ? s.rules[TARGET_RULE].kind : s.kind;
      if (kind !== r.kind || s.spreadNum !== r.spreadNum) {
        throw new Error(`The read store ${path} disagrees with the rows at ${new Date(r.closeMs).toISOString()} (${kind} at ${s.spreadNum} against ${r.kind} at ${r.spreadNum}); they were made by different runs.`);
      }
      const { extra: _x, ...lean } = s;
      reads.push({ ...lean, k });
    }
    if (complete) return { reads: reads.sort((x, y) => x.k - y.k), path };
  }
  return null;
}

/* ------------------------------------------------------------------ walk-forward */

/** The last day a fold for `year` may train on, exclusive: 1 January minus the purge. */
export const trainBefore = (year, purgeDays = PURGE_DAYS) => isoDay(Date.UTC(year, 0, 1) - purgeDays * DAY_MS);

/** Rows a fold for `year` trains on: London day strictly before trainBefore(year). */
export const trainRowsFor = (rows, year, purgeDays = PURGE_DAYS) => {
  const cut = trainBefore(year, purgeDays);
  return rows.filter((r) => r.day < cut);
};

const yearOf = (r) => Number(r.day.slice(0, 4));

/**
 * The walk-forward on development years. For each test year: both models
 * trained on the rows before it (minus the purge), the filter's threshold set
 * for each q from the training rows that alerted, and the filtered watcher
 * simulated over that year's reads THROUGH the alert sequence. Each (λ, q) is
 * scored by the mean net R of its kept alerts over all test years; the best
 * wins, and anything within one day-clustered SE of it counts as a tie,
 * settled towards the larger λ and then the larger q (the plainer model).
 *   rows   compact development rows (loadRows), time order
 *   bars   the bars the rows were made from (to 2024-12-31 at most)
 *   reads  optional reads for the test years (readsFromStore); default rebuilt from rows
 * A check whose trade would cross a hole in the bars (gapAhead: the dataset
 * declined to score it) is left out of BOTH the unfiltered and the filtered
 * alert passes, in the same way (the predicate refuses it, so it neither
 * alerts nor starts a cooldown), so kept-minus-unfiltered compares one set of
 * trades. The rows' `alerted` flag, from the dataset's plain pass, is checked
 * against a third pass that leaves nothing out.
 * Never reads a row from 2025 on: it refuses one.
 */
export function walkForward(rows, { bars, reads = null, cfg, pair, lambdas = LAMBDAS, qs = QS, years = TEST_YEARS, purgeDays = PURGE_DAYS, checkGrid = true } = {}) {
  if (rows.some((r) => r.closeMs >= FROM_MS)) throw new Error('The walk-forward is given a held-back row (2025 or later); it runs on development years only.');
  const comm = costFor(pair, 0, cfg).comm;
  const minutes = tfInfo(timeframeFor(cfg)).minutes;
  const allReads = reads || readsFromRows(rows, bars);
  const rowAt = new Map(rows.map((r) => [r.closeMs, r]));
  const readsOfYear = (y) => allReads.filter((rd) => { const r = rowAt.get(rd.closeMs); return r && yearOf(r) === y; });
  const gapAt = new Set(rows.filter((r) => r.gapAhead).map((r) => r.closeMs));
  const scorable = (rd) => !gapAt.has(rd.closeMs);
  const rawPass = (rd, predicate) => alertPass(rd, bars, { cfg, rule: TARGET_RULE, pair, predicate, bothTouched: 'half', tfMinutes: minutes }).trades;
  // Every pass the filter is judged by leaves the gap-ahead checks out the same way.
  const pass = (rd, predicate) => rawPass(rd, predicate ? (x) => scorable(x) && predicate(x) : scorable);

  const folds = [];
  const pooled = {};   // `${λ}|${q}` → kept trades over all years
  for (const year of years) {
    const train = trainRowsFor(rows, year, purgeDays);
    const test = rows.filter((r) => yearOf(r) === year);
    if (!train.length || !test.length) {
      const span = rows.length ? ` The rows run from ${rows[0].day} to ${rows[rows.length - 1].day}.` : '';
      throw new Error(`The walk-forward has no ${!train.length ? 'training rows before' : 'test rows in'} ${year}, its ${!train.length ? 'first' : ''} test year.${span} Build the rows from 2017-09-01 to 2024-12-31.`.replace('  ', ' '));
    }
    const models = fitModels(train, lambdas);
    const yearReads = readsOfYear(year);
    const unfiltered = pass(yearReads, null);
    const plain = gapAt.size ? rawPass(yearReads, null) : unfiltered;
    const testIdeas = test.filter((r) => r.kind === 'idea' && filterRow(r));

    if (checkGrid) {
      // The grid is only a choice if it changes something: a λ that moves no
      // prediction means the penalty is mis-scaled for this data.
      const preds = lambdas.map((l) => testIdeas.map((r) => filterNet(models.filter.fits[l], r, comm)));
      for (let i = 1; i < preds.length; i++) {
        const moved = preds[i].some((p, j) => Math.abs(p - preds[i - 1][j]) > 1e-9);
        if (testIdeas.length && !moved) throw new Error(`In ${year}, λ ${lambdas[i - 1]} and ${lambdas[i]} give the same predictions: the penalty grid changes nothing.`);
      }
    }

    const fold = {
      year, trainBefore: trainBefore(year, purgeDays), train: { rows: train.length, filter: models.filter.n, ranking: models.ranking.n, lastDay: train[train.length - 1].day },
      thresholds: {}, unfiltered, plain, test, models, grid: {},
    };
    for (const l of lambdas) {
      fold.thresholds[l] = {};
      const m = models.filter.fits[l];
      const predAt = new Map(testIdeas.map((r) => [r.closeMs, filterNet(m, r, comm)]));
      for (const q of qs) {
        const tau = thresholdFor(m, train, q, comm);
        fold.thresholds[l][q] = tau;
        const keep = (rd) => (predAt.get(rd.closeMs) ?? -Infinity) >= tau;
        const kept = pass(yearReads, keep);
        fold.grid[`${l}|${q}`] = { kept, keepSet: new Set([...predAt].filter(([, p]) => p >= tau).map(([c]) => c)) };
        (pooled[`${l}|${q}`] ||= []).push(...kept);
      }
    }
    folds.push(fold);
  }

  const grid = [];
  for (const l of lambdas) for (const q of qs) grid.push({ lambda: l, q, ...summary(pooled[`${l}|${q}`] || []) });
  const scored = grid.filter((g) => g.n > 0);
  // No setting kept a single alert: nothing to choose between, so the plainest
  // model (largest λ, largest q) is taken, and the report says why.
  const best = scored.length ? scored.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
  const tol = best ? best.se ?? 0 : 0;
  const ties = best ? scored.filter((g) => g.mean >= best.mean - tol) : [...grid];
  const pick = ties.sort((a, b) => b.lambda - a.lambda || b.q - a.q)[0];
  const chosen = {
    lambda: pick.lambda, q: pick.q, tiedWith: ties.length, nothingKept: !best,
    best: best ? { lambda: best.lambda, q: best.q, mean: best.mean, se: best.se } : null,
  };

  // Per test year, at the chosen setting.
  const key = `${chosen.lambda}|${chosen.q}`;
  const perYear = [];
  const keptAll = [], removedAll = [];
  for (const f of folds) {
    const { kept, keepSet } = f.grid[key];
    const removed = f.unfiltered.filter((t) => !keepSet.has(t.closeMs));
    const rm = f.models.ranking.fits[chosen.lambda];
    const pairs = [];
    for (const r of f.test) {
      if (!rankingRow(r) || !r.b.long.net || !r.b.short.net) continue;
      pairs.push({ day: r.day, pred: rankingNet(rm, r, 'long', comm), real: r.b.long.net.r });
      pairs.push({ day: r.day, pred: rankingNet(rm, r, 'short', comm), real: r.b.short.net.r });
    }
    const corr = t2Test(pairs, { B: 0 }).corr;
    const alertedRows = new Set(f.test.filter((r) => r.alerted).map((r) => r.closeMs));
    const mine = new Set(f.plain.map((t) => t.closeMs));
    const mismatch = [...alertedRows].filter((c) => !mine.has(c)).length + [...mine].filter((c) => !alertedRows.has(c)).length;
    const short = (s) => ({ n: s.n, mean: s.mean });
    perYear.push({
      year: f.year, train: f.train, threshold: f.thresholds[chosen.lambda][chosen.q],
      unfiltered: short(summary(f.unfiltered)), kept: short(summary(kept)), removed: short(summary(removed)),
      rankCorr: corr, rankPairs: pairs.length, alertedMismatch: mismatch,
      gapAheadLeftOut: f.test.filter((r) => r.gapAhead && r.kind === 'idea').length,
    });
    keptAll.push(...kept); removedAll.push(...removed);
  }

  // What helped and what hurt: out-of-sample mean net R per condition, of the
  // alerts the chosen filter kept and of those it removed — never coefficients,
  // which in a ridge with correlated features say little about any one condition.
  const withCond = (ts) => ts.map((t) => ({ at: t.at, r: t.r, cond: (rowAt.get(t.closeMs) || {}).cond ?? null }));
  const conditions = { kept: byCondition(withCond(keptAll)), removed: byCondition(withCond(removedAll)) };

  return {
    folds: folds.map((f) => ({ year: f.year, trainBefore: f.trainBefore, train: f.train, thresholds: f.thresholds })),
    grid, chosen, perYear, conditions,
    pooled: { unfiltered: summary(folds.flatMap((f) => f.unfiltered)), kept: summary(keptAll), removed: summary(removedAll) },
  };
}

/** A fitted model in the form model.json keeps: weights by feature name, with its standardiser. */
export function serialiseModel(fit, lambda) {
  const { st } = fit;
  const weights = {}, standardiser = {};
  st.names.forEach((n, i) => {
    weights[n] = fit.w[i];
    standardiser[n] = { mean: st.mean[i], sd: st.sd[i], ...(st.lo[i] !== null ? { clip: [st.lo[i], st.hi[i]] } : {}) };
  });
  return { lambda, intercept: fit.intercept, weights, standardiser };
}

/** model.json's form back into one predict() takes. Features missing from it were dropped in training. */
export function deserialiseModel(m) {
  const idx = [], mean = [], sd = [], lo = [], hi = [], w = [];
  FEATURE_NAMES.forEach((n, j) => {
    const s = m.standardiser[n];
    if (!s) return;
    idx.push(j); mean.push(s.mean); sd.push(s.sd); lo.push(s.clip ? s.clip[0] : null); hi.push(s.clip ? s.clip[1] : null); w.push(m.weights[n]);
  });
  return { st: { idx, names: idx.map((j) => FEATURE_NAMES[j]), mean, sd, lo, hi }, intercept: m.intercept, w: Float64Array.from(w) };
}

/* ------------------------------------------------------------------- the recipe */

/** JSON with every object's keys sorted, at every depth: the same recipe always hashes the same. */
export function canonicalJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const recipeHashOf = (recipe) => sha256(canonicalJSON(recipe));

/**
 * The files the method hash covers, relative to the project: everything
 * learn.mjs and dataset.mjs import, followed to the end (reads.mjs and its
 * worker, features-extra.mjs, stats.mjs, conditions.mjs, history.mjs, lib.mjs,
 * outcome.mjs, the engine under src/ …), the files the plan names, and
 * desk/net.mjs, which both import dynamically for the proxy (it computes
 * nothing, but D5 says every file they import, and it is cheaper to hash it
 * than to argue the exception).
 */
export function methodFiles() {
  const files = new Set([...engineFiles(), ...engineFiles(fileURLToPath(import.meta.url)), ...engineFiles(join(here, 'dataset.mjs'))]);
  if (existsSync(FEATURES_EXTRA)) for (const f of engineFiles(FEATURES_EXTRA)) files.add(f);
  for (const f of ['src/signal-engine.js', 'src/indicators.js', 'src/sessions.js', 'src/timeframes.js', 'desk/live.mjs', 'desk/features.mjs', 'desk/learn.mjs', 'desk/dataset.mjs', 'desk/stats.mjs', 'desk/conditions.mjs', 'desk/history.mjs', 'desk/net.mjs']) {
    files.add(join(ROOT, f));
  }
  return [...files].filter((f) => existsSync(f)).map((f) => relative(ROOT, f).split(sep).join('/')).sort();
}

/**
 * A hash of the source of everything that decides a read, a feature, a label
 * or this learner's arithmetic (methodFiles). Over-inclusive on purpose:
 * between committing the recipe and the final run nothing should change at
 * all, and a refusal costs a refit; a quietly changed method costs the holdout.
 */
export function engineHash() {
  const h = createHash('sha256');
  for (const f of methodFiles()) h.update(f).update('\0').update(readFileSync(join(ROOT, f))).update('\0');
  return h.digest('hex');
}

/**
 * The config inputs the method depends on: the window (which checks exist,
 * when trades close), the broker block (when the market counts as open), the
 * timeframe, and the two account inputs of the commission. No balance, no
 * money: model.json is committed.
 */
export const configOf = (cfg) => ({
  window: cfg.window ?? null, broker: cfg.broker ?? null, timeframe: tfInfo(timeframeFor(cfg)).id,
  account: { gbpusd: cfg.account?.gbpusd ?? null, commissionPerSideGBP: cfg.account?.commissionPerSideGBP ?? null },
});

/**
 * Everything that defines the method, written before any held-back result is
 * seen. `dataset` is the training rows' manifest without its build time
 * (manifestRecord): the rows the model learns from are part of the method.
 * Returned through JSON, so the recipe in memory hashes exactly as the one
 * read back from model.json.
 */
export function buildRecipe({ pair, tf, cfg, dataset: ds }) {
  if (!cfg) throw new Error('buildRecipe needs the desk config (window, broker, account inputs).');
  if (!ds || !ds.settings || !ds.rowsKey) throw new Error('buildRecipe needs the training rows\' manifest.');
  const recipe = {
    method: 'ridge filter and ranking, walk-forward selected (LEARNING-PLAN.md Part 4)',
    pair, timeframe: tf, targetRule: TARGET_RULE,
    dataset: ds,
    config: configOf(cfg),
    features: {
      names: [...FEATURE_NAMES], version: FEATURES_VERSION, directional: [...DIRECTIONAL], swapped: SWAPPED.map((p) => [...p]),
      sideSigned: 'features.mjs sideSigned(f, side): +1 long, -1 short',
      nulls: 'the training fold\'s mean (0 once standardised), no missing indicator',
      standardise: 'fitted on each training fold only; features with no spread in the fold dropped',
      clip: { features: [...CLIPPED], at: [...CLIP_AT] },
    },
    labels: {
      a: 'the watcher\'s own trade on the engine\'s lean, kinds idea and rejected only, the read\'s 1.5R-rule stop and first target (rejected rows from toPlan); gross = spread 0 and no commission, net = the read\'s spread and the pair\'s commission; keeps r, how, bars, mfe, mae',
      b: `a standard long and short at every check with features: stop = max(1.2 x ATR, the engine's noise-scaled minimum stop), target ${B_TARGET} x stop; same fills and window close; the result only (r, how), gross and net`,
      bothTouched: 'half',
      outcome: 'desk/outcome.mjs outcome(): buys fill at the ask, exits trigger on the bid (sells the reverse), closed at the window\'s end',
    },
    models: {
      penalty: 'mean squared error + lambda x ||w||^2 on the mean loss; intercept unpenalised; exact solve (Cholesky)',
      filter: 'trained on every check of kind idea or rejected with label (a), target a.gross.r, features signed by a.side',
      ranking: 'trained on every check with label (b), long and short rows pooled with mirrored features, one intercept, no side term',
      predictedNet: 'predicted gross R minus (spread + commission) / stop distance at the decision',
      threshold: 'the (1 - q) quantile of training-period predicted net R among training checks the unfiltered watcher alerted on; kept when at or above',
      p2Threshold: 'the ranking model\'s own: the (1 - share) quantile of the higher-side predicted net R over gate-open training checks (kinds none, idea, rejected) with label (b), share = (gate-open training checks alerted on / gate-open training checks) x q; traded when at or above',
    },
    lambdaGrid: [...LAMBDAS], qGrid: [...QS],
    walkForward: {
      testYears: [...TEST_YEARS], purgeDays: PURGE_DAYS, train: 'London day before 1 January of the test year minus the purge, expanding',
      score: 'mean net R of kept alerts over all test years, from the filtered watcher simulated through the alert sequence (reads.mjs alertPass with the predicate)',
      nearTie: 'within one day-clustered SE (x sqrt(G/(G-1))) of the best: prefer the larger lambda, then the larger q',
      finalFit: 'both models refitted on every development day before 2025-01-01 minus the purge, at the chosen lambda; both thresholds from those rows',
      gaps: `a check whose trade (label (a), or label (b) long or short, gross or net) would cross a hole of more than ${GAP_BARS} bars on its way to its exit is gapAhead (dataset.mjs rowFor): not scored, so out of training, and left out of every alert pass (the predicate refuses it: it neither alerts nor starts a cooldown)`,
    },
    holdout: {
      ...HOLDOUT,
      rule: 'looked at once. `final` checks everything that sees no outcome and records an armed entry to commit; `final --run` needs that entry committed, records started (model.json, $SCALP_DESK_HOME/learn/finals.log, ~/.scalp-desk/learn/finals.log and <git common dir>/scalp-desk-finals.log) immediately before the first outcome, then the results. A final that started or ran for an overlapping window, in any committed version of model.json, the working copy or any of the logs, refuses every later final and every refit. fit and final run only on <project>/desk/model.json and never in a shallow clone.',
      data: { ...HOLDOUT_DATA, expected: 'every bar close in the window that src/sessions.js windowState calls open on a weekday, at the timeframe' },
      reads: `computed by the final itself (never dataset rows): reads.mjs at cost ${HOLDOUT_COST}, calendar ${HOLDOUT_CALENDAR}, rule ${TARGET_RULE}, with desk/features-extra.mjs`,
      gaps: `the walk-forward's rule: a held-back check that dataset.mjs rowFor marks gapAhead (a trade crossing a hole of more than ${GAP_BARS} bars) is left out of the unfiltered and kept passes (so of the coin-flip baseline), of T2's pairs and of P2`,
    },
    tests: {
      z: Z_TEST,
      T1: `filter: kept alerts' day-clustered lower bound of mean net R (x sqrt(G/(G-1))) above 0 at z, AND kept-minus-unfiltered mean net R per trade with a day-block-bootstrap lower bound (seed ${BOOT.seed}) above 0, AND at least ${MIN_KEPT} kept alerts; the filter applied before shouldAlert. Status becomes shadow only if T1 passes and the held-back window had not been looked at before (replay looks in model.json)`,
      T2: `ranking: day-block-bootstrap lower bound (seed ${T2_SEED}) of the correlation between side-aligned predicted net R and realised label-(b) net R, every holdout check with features, both sides, above 0; switches nothing on`,
      P2: 'exploratory only: the higher-predicted side where it is at or above P2\'s own threshold (models.p2Threshold), one position at a time, label (b), gate-open checks only',
      baselines: 'the unfiltered watcher; a coin-flip side at each unfiltered alert = the average of the long and short outcomes with the alert\'s own distances, paired and day-clustered',
      bootstrap: { B: BOOT.B, quantile: BOOT.quantile, seed: BOOT.seed, seeds: { T1: BOOT.seed, T2: T2_SEED }, unit: 'London day (UTC date of the alert)' },
    },
    floors: { minKeptAlerts: MIN_KEPT },
    costs: {
      training: 'gross (spread 0, no commission)', dataset: TRAIN_COST,
      holdoutEvaluation: `${HOLDOUT_COST}: per check the larger of the fixed and the scaled spread, in the read and in the outcome`,
    },
    calendar: {
      training: TRAIN_CALENDAR, holdout: HOLDOUT_CALENDAR,
      why: `walk-forward and training rows use '${TRAIN_CALENDAR}', the same for every development year (2017-2024, whose tier-1 tables are incomplete); the one held-back evaluation (T1, T2, P2 and the baselines on ${HOLDOUT.from}..${HOLDOUT.to}) uses '${HOLDOUT_CALENDAR}', the live desk's calendar. Features do not depend on the calendar; only which checks are tradeable does`,
    },
    engine: { files: methodFiles(), hash: engineHash() },
  };
  return JSON.parse(JSON.stringify(recipe));
}

/** The training rows' manifest a recipe was built with, to rebuild it from today's code. */
export const datasetOf = (recipe) => recipe.dataset;

/* ------------------------------------------------------------------ model.json */

export function readModel(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Written whole to a temporary file with a name of its own, then renamed: never half a model.json. */
export function writeModel(path, model) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(model, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Appends one entry to model.json's finals, keeping everything else. */
export function recordFinal(path, entry) {
  const m = readModel(path);
  m.finals = [...(m.finals || []), entry];
  writeModel(path, m);
  return m;
}

/** The hash of the frozen model and its choice, so the final can check it is the committed one too. */
export const modelHashOf = (m) => sha256(canonicalJSON({ chosen: m.chosen ?? null, model: m.model ?? null }));

/* ------------------------------------------------------- what has been used */

const WINDOW = { from: HOLDOUT.from, to: HOLDOUT.to };
const sameWindow = (w) => !!w && w.from === WINDOW.from && w.to === WINDOW.to;
/** Whether a recorded window overlaps the held-back one. A window that cannot be read counts as overlapping. */
export function overlapsHoldout(w) {
  if (!w || !w.from || !w.to) return true;
  const a = Date.parse(w.from), b = Date.parse(w.to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a <= TO_MS && b >= FROM_MS;
}
/** Kinds of final record that mean the held-back years were (or may have been) looked at. */
const USE_KINDS = new Set(['started', 'ran', 'crashed', 'unreadable']);
const isUse = (f, pair) => !!f && typeof f === 'object'
  && (USE_KINDS.has(f.kind) || (f.kind === undefined && f.ran === true))
  && (!f.pair || f.pair === pair) && overlapsHoldout(f.window);

const gitRun = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 });

/** The git repository a file is in: { top, rel } (rel with forward slashes), or null. */
function repoOf(path) {
  try {
    const abs = resolve(path);
    const dir = realpathSync(dirname(abs));
    const top = realpathSync(gitRun(dir, ['rev-parse', '--show-toplevel']).trim());
    return { top, rel: relative(top, join(dir, basename(abs))).split(sep).join('/') };
  } catch {
    return null;
  }
}

/** model.json as committed at git HEAD, or null (not in a repository, or never committed). */
export function committedModel(modelPath) {
  const r = repoOf(modelPath);
  if (!r) return null;
  try { return JSON.parse(gitRun(r.top, ['show', `HEAD:${r.rel}`])); } catch { return null; }
}

/**
 * Every committed version of model.json, on any ref (stashes included):
 * `git log --all --format=%H -- <path>`, then `git show <hash>:<path>`.
 * A commit that deleted the file, or holds something unreadable, is skipped.
 */
export function committedVersions(modelPath) {
  const r = repoOf(modelPath);
  if (!r) return [];
  let hashes;
  try { hashes = gitRun(r.top, ['log', '--all', '--format=%H', '--', r.rel]).split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const h of hashes) {
    try { out.push({ commit: h, model: JSON.parse(gitRun(r.top, ['show', `${h}:${r.rel}`])) }); } catch { /* deleted in this commit, or not JSON */ }
  }
  return out;
}

/**
 * The account's home directory as the system records it (os.userInfo), not
 * $HOME: a final's default log must not move with an environment variable
 * (review, 17 Oct 2026). homedir() only where the system has no record.
 */
export function accountHome() {
  try { return userInfo().homedir || homedir(); } catch { return homedir(); }
}

/** The append-only record of finals under a desk home: outside the repository, so no git step erases it. */
export const finalsLogPath = (home) => join(home, 'learn', 'finals.log');

/** The name of the log kept in the repository's git common directory (beside the objects, never in the working tree). */
export const GIT_FINALS_LOG = 'scalp-desk-finals.log';

/** The git common directory (absolute) of the repository a file is in, or null. Worktrees share it. */
export function gitCommonDirOf(path) {
  try {
    const dir = realpathSync(dirname(resolve(path)));
    return resolve(dir, gitRun(dir, ['rev-parse', '--git-common-dir']).trim());
  } catch {
    return null;
  }
}

/**
 * Every log a final is written to and looked for in, deduplicated:
 *   - $SCALP_DESK_HOME's (`home`), as before;
 *   - the default desk home's, ~/.scalp-desk/learn/finals.log, whatever the
 *     variable says, with ~ the account's home as the system records it
 *     (os.userInfo), which $HOME does not move (`userHome` stands in for ~
 *     under test only);
 *   - <git common dir>/scalp-desk-finals.log of the repository model.json is
 *     in: no checkout, stash, reset or clean touches it, and every worktree
 *     of the repository shares it.
 */
export function finalsLogPaths({ home = null, modelPath = null, userHome = null } = {}) {
  const out = [];
  if (home) out.push(finalsLogPath(home));
  out.push(finalsLogPath(join(userHome || accountHome(), '.scalp-desk')));
  const common = modelPath ? gitCommonDirOf(modelPath) : null;
  if (common) out.push(join(common, GIT_FINALS_LOG));
  return [...new Set(out.map((p) => resolve(p)))];
}

/** A log file's entries; a line that cannot be read counts as a use (it may have been one). */
export function readLogFile(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { kind: 'unreadable', line: l.slice(0, 200) }; }
  });
}

/** Appends one line to a log file and waits for the disk. */
export function appendLogFile(p, entry) {
  mkdirSync(dirname(p), { recursive: true });
  const fd = openSync(p, 'a');
  try { writeSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

/** The entries of the log under one desk home. */
export const readFinalsLog = (home) => readLogFile(finalsLogPath(home));

/** Appends one line to the log under one desk home. */
export const appendFinalsLog = (home, entry) => appendLogFile(finalsLogPath(home), entry);

/** Appends one line to every log (finalsLogPaths). */
export function appendFinalsLogs(opts, entry) {
  for (const p of finalsLogPaths(opts)) appendLogFile(p, entry);
}

/**
 * Every record of a final that started or ran on the held-back years for
 * this pair, for a window overlapping them: in the working copy of model.json
 * (or `model`), in every committed version of it, and in every log
 * (finalsLogPaths). Returns [{ where, entry }]; empty means unused.
 *   userHome   test-only: stands in for ~ (the default desk home's log)
 */
export function usedFinals({ pair, modelPath, home = null, model = undefined, userHome = null }) {
  const out = [];
  const scan = (m, where) => { for (const f of (m && Array.isArray(m.finals) ? m.finals : [])) if (isUse(f, pair)) out.push({ where, entry: f }); };
  scan(model === undefined ? readModel(modelPath) : model, 'the working copy of model.json');
  for (const v of committedVersions(modelPath)) scan(v.model, `model.json as committed in ${v.commit.slice(0, 10)}`);
  for (const p of finalsLogPaths({ home, modelPath, userHome })) for (const e of readLogFile(p)) if (isUse(e, pair)) out.push({ where: p, entry: e });
  return out;
}

/** The one model file fit and final work on: <project>/desk/model.json. */
export const MODEL_PATH = join(ROOT, 'desk', 'model.json');

/**
 * Why fit or final may not use `modelPath`, or null. Only MODEL_PATH: the
 * record of a final is looked for in that file's git history, so a copy under
 * another name would start a history of its own. `anyModelPath` is for tests
 * and scratch runs only (the command line's --test-model).
 */
export function modelPathRefusal(modelPath, { anyModelPath = false } = {}) {
  if (anyModelPath) return null;
  if (!modelPath) return 'No model file given.';
  const same = (() => {
    if (resolve(modelPath) === MODEL_PATH) return true;
    try { return basename(modelPath) === 'model.json' && realpathSync(dirname(resolve(modelPath))) === realpathSync(dirname(MODEL_PATH)); } catch { return false; }
  })();
  return same ? null : `fit and final work only on ${MODEL_PATH}, not ${resolve(modelPath)}: the record of a final is looked for in that file's git history, and another file would have a history of its own. (Tests and scratch runs name another with --test-model.)`;
}

/** Whether the repository a file is in is a shallow clone (its history cut short). False outside git. */
export function isShallowRepo(path) {
  try {
    const dir = realpathSync(dirname(resolve(path)));
    return gitRun(dir, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return false;
  }
}

const SHALLOW = 'This is a shallow clone: git history older than its depth is missing, so a final recorded in an older commit of model.json could go unseen. Run `git fetch --unshallow` first.';

const describeUse = (u) => `A final ${u.entry.kind || 'run'}${u.entry.at ? ` on ${u.entry.at}` : ''} is recorded in ${u.where}.`;

/** Replay looks (--holdout) at a range overlapping the held-back window, in the working copy or any committed version. */
export function earlierLooks({ modelPath, model = undefined }) {
  const seen = new Map();
  const scan = (m) => {
    for (const l of (m && Array.isArray(m.looks) ? m.looks : [])) {
      if (!l || typeof l !== 'object' || !overlapsHoldout(l.range)) continue;
      seen.set(canonicalJSON(l), l);
    }
  };
  scan(model === undefined ? readModel(modelPath) : model);
  for (const v of committedVersions(modelPath)) scan(v.model);
  return [...seen.values()];
}

/**
 * Whether the method's code is on record: every file committed at HEAD and
 * unchanged since (`git ls-files`, `git diff HEAD`), and model.json (when
 * given) in the same repository. Returns { ok, commit } or { ok: false, reason }.
 *   root    the directory the file names are relative to (default the project)
 */
export function codeClean({ root = ROOT, files = methodFiles(), modelPath = null } = {}) {
  let top, commit;
  try { top = realpathSync(gitRun(root, ['rev-parse', '--show-toplevel']).trim()); } catch {
    return { ok: false, reason: `The method's files are not in a git repository (${root}); the final runs only on committed code.` };
  }
  try { commit = gitRun(root, ['rev-parse', '--verify', 'HEAD']).trim(); } catch {
    return { ok: false, reason: 'The repository has no commit yet; the final runs only on committed code.' };
  }
  const tracked = new Set(gitRun(root, ['ls-files', '-z', '--', ...files]).split('\0').filter(Boolean));
  const untracked = files.filter((f) => !tracked.has(f));
  if (untracked.length) return { ok: false, reason: `These method files are not committed: ${untracked.join(', ')}. Commit them, refit if they changed the method, and commit model.json; the final runs only on code that is on record.` };
  const dirty = gitRun(root, ['diff', '--relative', '--name-only', '-z', 'HEAD', '--', ...files]).split('\0').filter(Boolean);
  if (dirty.length) return { ok: false, reason: `These method files differ from the last commit: ${dirty.join(', ')}. Commit them (and refit if they change the method) or put them back; the final runs only on code that is on record.` };
  if (modelPath) {
    const r = repoOf(modelPath);
    if (!r || r.top !== top) return { ok: false, reason: `model.json (${modelPath}) is not in the same git repository as the code (${top}); the final's record has to sit beside the code it ran.` };
  }
  return { ok: true, commit };
}

/* ------------------------------------------------------------------------ fit */

/**
 * `fit`: the walk-forward, the choice, and both models refitted on every
 * development day, written into model.json beside whatever else is there
 * (the replay's "looks"). Refuses once any final has started or run, found
 * anywhere (usedFinals): refitting after the holdout has been used would be a
 * new method on seen data. Refuses rows whose manifest is not the recipe's
 * dataset (cost scaled, calendar rules, bars from binance, development years
 * only), any model file but desk/model.json (unless `anyModelPath`, tests
 * only), and a shallow clone.
 */
export function fitAll(rows, { bars, reads = null, cfg, pair, tf, settings, manifest, modelPath, home = null, now = new Date(), userHome = null, anyModelPath = false }) {
  const where = modelPathRefusal(modelPath, { anyModelPath });
  if (where) throw new Error(where);
  if (isShallowRepo(modelPath)) throw new Error(SHALLOW);
  const used = usedFinals({ pair, modelPath, home, userHome });
  if (used.length) throw new Error(`${ALREADY_USED} ${describeUse(used[0])} Refitting now would be a new method on data already seen.`);
  if (!manifest) throw new Error('fit needs the rows\' manifest (loadDataset): a model must say which rows it learned from.');
  const ms = manifest.settings || {};
  if (ms.pair !== pair || ms.tf !== tf) throw new Error(`The rows are ${ms.pair} ${ms.tf}, not ${pair} ${tf}.`);
  if (ms.calendar !== TRAIN_CALENDAR || settings.calendar !== TRAIN_CALENDAR) throw new Error(`The recipe trains on calendar "${TRAIN_CALENDAR}"; these rows were made with "${ms.calendar}". Rebuild them with --calendar ${TRAIN_CALENDAR}.`);
  if (ms.cost !== TRAIN_COST || settings.cost !== TRAIN_COST) throw new Error(`The recipe trains on rows made with cost "${TRAIN_COST}"; these were made with "${ms.cost}". Rebuild them with --cost ${TRAIN_COST}.`);
  if (manifest.source !== TRAIN_SOURCE) throw new Error(`The recipe trains on rows made from ${TRAIN_SOURCE}'s bars; these were made from ${manifest.source === null || manifest.source === undefined ? 'bars handed in with no source' : `"${manifest.source}"`}. Build them with node desk/dataset.mjs (no $SCALP_DESK_BARS).`);
  if (manifest.holdout) throw new Error('These rows were built with --holdout: they are not the development rows. Build the training rows to 2024-12-31, the dataset\'s default.');
  if (!(manifest.toMs < FROM_MS)) throw new Error('These rows run into the held-back years (2025-01-01 on). Build the training rows to 2024-12-31, the dataset\'s default.');
  const wf = walkForward(rows, { bars, reads, cfg, pair });
  const comm = costFor(pair, 0, cfg).comm;
  const train = rows.filter((r) => r.day < trainBefore(Number(HOLDOUT.from.slice(0, 4))));
  const models = fitModels(train, [wf.chosen.lambda]);
  const filter = models.filter.fits[wf.chosen.lambda], ranking = models.ranking.fits[wf.chosen.lambda];
  const threshold = thresholdFor(filter, train, wf.chosen.q, comm);
  const p2 = p2ThresholdFor(ranking, train, wf.chosen.q, comm);
  const recipe = buildRecipe({ pair, tf, cfg, dataset: manifestRecord(manifest) });
  const existing = readModel(modelPath);
  const out = {
    ...existing,
    recipe, recipeHash: recipeHashOf(recipe),
    walkForward: {
      at: now.toISOString(), rows: rows.length, trainedOn: { from: rows[0].day, to: train[train.length - 1].day, rows: train.length },
      grid: wf.grid, perYear: wf.perYear, pooled: wf.pooled, chosen: wf.chosen,
      conditions: { kept: conditionsSummary(wf.conditions.kept), removed: conditionsSummary(wf.conditions.removed) },
    },
    chosen: { lambda: wf.chosen.lambda, q: wf.chosen.q },
    model: {
      filter: { ...serialiseModel(filter, wf.chosen.lambda), threshold },
      ranking: { ...serialiseModel(ranking, wf.chosen.lambda), threshold: p2.threshold, p2Share: p2.share },
    },
    finals: existing.finals || [],
    status: existing.status || 'info-only',
  };
  out.modelHash = modelHashOf(out);
  writeModel(modelPath, out);
  return { model: out, wf };
}

/** byCondition's result trimmed to what model.json keeps (the table is re-printed from this). */
function conditionsSummary(c) {
  return { ...c, rows: c.rows.map(({ cell, group, label, n, days, mean, lo, hi, crit, tooFew, why, clearsZero, clearsAt95 }) => ({ cell, group, label, n, days, mean, lo, hi, crit, tooFew, why, clearsZero, clearsAt95 })) };
}

/* ------------------------------------------------------------------- the final */

export const ALREADY_USED = 'The held-back years have already been used once; this result is not on unseen data.';

/**
 * Whether a final step may go on, before anything held back is computed. In
 * order:
 *   - the model file is desk/model.json (unless `anyModelPath`, tests only),
 *     and its repository is not a shallow clone;
 *   - model.json holds a fitted recipe and model, for this pair and timeframe;
 *   - no final has started or run for an overlapping window, in the working
 *     copy, in ANY committed version of model.json, or in any of the logs
 *     (finalsLogPaths; refused and armed entries do not count: they looked
 *     at nothing);
 *   - the recipe rebuilt from today's code and config hashes to model.json's
 *     recipeHash, and today's dataset code still gives the training rows'
 *     rowsKey — nothing changed since the fit;
 *   - every method file is committed and unchanged, and model.json sits in
 *     the same repository (codeClean);
 *   - model.json's recipeHash and modelHash are the ones committed at HEAD.
 * Returns { ok: true, head, codeCommit } or { ok: false, code, reason }.
 *   codeCheck   (files) => codeClean-shaped result; default codeClean on this project
 *   rowsKeyFor  (settings, manifest) => key; default dataset.mjs's, with `cfg`
 */
export function finalGuard(model, { pair, tf, cfg, modelPath, home = null, codeCheck = null, rowsKeyFor = null, userHome = null, anyModelPath = false }) {
  const where = modelPathRefusal(modelPath, { anyModelPath });
  if (where) return { ok: false, code: 'model-path', reason: where };
  if (isShallowRepo(modelPath)) return { ok: false, code: 'shallow', reason: SHALLOW };
  if (!model.recipe || !model.recipeHash || !model.model || !model.chosen) {
    return { ok: false, code: 'no-recipe', reason: 'There is no fitted recipe in model.json yet. Run `node desk/learn.mjs fit --pair bitcoin` on the development years, commit model.json, then arm the final.' };
  }
  if (model.recipe.pair !== pair || model.recipe.timeframe !== tf) {
    return { ok: false, code: 'other-pair', reason: `model.json's recipe is for ${model.recipe.pair} ${model.recipe.timeframe}, not ${pair} ${tf}.` };
  }
  const used = usedFinals({ pair, modelPath, home, model, userHome });
  if (used.length) return { ok: false, code: 'already-run', reason: `${ALREADY_USED} ${describeUse(used[0])} A second final run is refused.` };
  const changed = (why) => ({ ok: false, code: 'changed', reason: `The method has changed since the fit (${why}): refit on the development years and commit model.json before the final.` });
  let now;
  try { now = recipeHashOf(buildRecipe({ pair, tf, cfg, dataset: datasetOf(model.recipe) })); } catch (e) { return changed(e.message); }
  if (recipeHashOf(model.recipe) !== model.recipeHash) return changed('the recipe in model.json is not the one its hash was taken of');
  if (now !== model.recipeHash) return changed('the engine, the features, the learner, the dataset code or the config');
  const ds = datasetOf(model.recipe);
  let key;
  try { key = rowsKeyFor ? rowsKeyFor(ds.settings, ds) : rowsKeyNow(ds, cfg); } catch (e) { return changed(e.message); }
  if (key !== ds.rowsKey) return changed('today\'s code would make different training rows');
  const code = codeCheck ? codeCheck(methodFiles()) : codeClean({ files: methodFiles(), modelPath });
  if (!code.ok) return { ok: false, code: 'code', reason: code.reason };
  const head = committedModel(modelPath);
  if (!head) return { ok: false, code: 'not-committed', reason: 'model.json is not committed at git HEAD. Commit it (the recipe must be on record before the held-back years are looked at), then arm the final.' };
  if (head.recipeHash !== model.recipeHash) return { ok: false, code: 'not-committed', reason: 'The recipe in model.json is not the one committed at git HEAD. Commit it first.' };
  if (head.modelHash !== modelHashOf(model) || model.modelHash !== modelHashOf(model)) {
    return { ok: false, code: 'not-committed', reason: 'The fitted model in model.json is not the one committed at git HEAD. Commit it first.' };
  }
  return { ok: true, head, codeCommit: code.commit ?? null };
}

/** The 'max' cost: per check, the larger of the fixed spread and the spread scaled with price (reads.mjs spreadAt). */
export const maxSpread = (pair, close) => spreadAt(pair, close, HOLDOUT_COST);

/**
 * The holdout's reads: every window check from 2025-01-01 to 2026-10-14 20:45
 * UTC, calendar 'full', cost 'max' — each check's own larger spread goes into
 * the read itself, not only into the outcome, since the spread feeds the
 * engine's verdict and checkPlan's stop floor — with the features module's
 * extra (f, cond, atr, stopStd) as the rows were made. A read holds no
 * outcome. Worker threads need the whole bar file (`file`, which `bars` must
 * be read from); otherwise the reads are made in this process.
 */
export async function holdoutReads(bars, { pair, cfg, extra = null, workers = 1, file = null }) {
  const ks = checkIndices(bars, { fromMs: FROM_MS, toMs: TO_MS, cfg });
  const opts = { pair, cfg, rules: [TARGET_RULE], cost: HOLDOUT_COST, calendar: HOLDOUT_CALENDAR };
  if (workers > 1 && file) return computeReads(bars, ks, { ...opts, workers, file, extraModule: FEATURES_EXTRA });
  return computeReads(bars, ks, { ...opts, extra: extra || await extraFor({ extraModule: FEATURES_EXTRA }) });
}

/**
 * The bars a final may use: strictly rising in time, at least
 * HOLDOUT_DATA.barsBefore of them before 2025-01-01, and a bar closing at or
 * after 14 October 2026 20:45 UTC. Returns { ok, reason }.
 */
export function checkHoldoutBars(bars, { cfg }) {
  const tfMs = tfInfo(timeframeFor(cfg)).minutes * 60000;
  if (!Array.isArray(bars) || !bars.length) return { ok: false, reason: 'There are no bars for the held-back window.' };
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].t > bars[i - 1].t)) return { ok: false, reason: `The bars do not rise strictly in time at ${new Date(bars[i].t).toISOString()} (a repeated or out-of-order bar). Rebuild the price history.` };
  }
  let before = 0;
  while (before < bars.length && bars[before].t < FROM_MS) before++;
  if (before < HOLDOUT_DATA.barsBefore) return { ok: false, reason: `The bars hold ${before} bars before 2025-01-01; the first held-back check needs ${HOLDOUT_DATA.barsBefore}.` };
  if (bars[bars.length - 1].t + tfMs < TO_MS) return { ok: false, reason: 'The price history does not reach the end of the held-back window (14 October 2026, 20:45 UTC).' };
  return { ok: true, before };
}

const expectedMemo = new Map();
/**
 * How many window checks the calendar expects in [fromMs, toMs]: every bar
 * close at the timeframe that windowState calls open on a weekday — what
 * checkIndices finds when no bar is missing.
 */
export function expectedChecks(cfg, { fromMs = FROM_MS, toMs = TO_MS } = {}) {
  const tfMs = tfInfo(timeframeFor(cfg)).minutes * 60000;
  const key = canonicalJSON({ w: cfg.window, tfMs, fromMs, toMs });
  if (expectedMemo.has(key)) return expectedMemo.get(key);
  let n = 0;
  for (let t = Math.ceil(fromMs / tfMs) * tfMs; t <= toMs; t += tfMs) {
    const w = windowState(t, cfg.window);
    if (w.open && w.phase !== 'weekend') n++;
  }
  expectedMemo.set(key, n);
  return n;
}

/**
 * The held-back reads against the calendar: no more missing checks, and no
 * more 'gap' / 'no-data' / 'stale' reads, than HOLDOUT_DATA allows, and none
 * outside the window. Kinds and counts only: a read holds no outcome.
 */
export function holdoutDataCheck(reads, expected) {
  const got = reads.length;
  const outside = reads.filter((r) => !(r.closeMs >= FROM_MS && r.closeMs <= TO_MS)).length;
  const missing = Math.max(0, expected - got);
  const gaps = reads.filter((r) => HOLDOUT_DATA.gapKinds.includes(r.kind)).length;
  const out = { expected, got, missing, gaps, outside };
  if (!expected) return { ok: false, ...out, reason: 'The calendar expects no checks in the held-back window: the config\'s window is wrong.' };
  if (outside) return { ok: false, ...out, reason: `${outside} held-back reads fall outside the window.` };
  if (got > expected) return { ok: false, ...out, reason: `There are ${got} held-back reads; the calendar expects ${expected}.` };
  if (missing > HOLDOUT_DATA.maxMissingShare * expected) return { ok: false, ...out, reason: `${missing} of the ${expected} held-back checks have no bar (more than ${HOLDOUT_DATA.maxMissingShare * 100}%, the recipe's tolerance). Fill the price history first.` };
  if (gaps > HOLDOUT_DATA.maxGapShare * expected) return { ok: false, ...out, reason: `${gaps} of the ${expected} held-back checks read as a gap in the bars (more than ${HOLDOUT_DATA.maxGapShare * 100}%, the recipe's tolerance). Fill the price history first.` };
  return { ok: true, ...out };
}

/**
 * A hash of the held-back reads, so `--run` can confirm it evaluates exactly
 * what was checked when armed. Each read's index into its bar array (`k`) is
 * left out: it depends only on where that array starts (the whole cached file
 * with workers, the loaded window without; a cache refilled in a fresh
 * container), while closeMs and the slice's fingerprint already pin the read.
 */
export const readsHashOf = (reads) => sha256(canonicalJSON(reads.map(({ k: _k, ...r }) => r)));

/**
 * The steps of a final that see no outcome: the pair, the features module,
 * the bars (checkHoldoutBars), the held-back reads, and their completeness
 * (holdoutDataCheck). Returns { ok, bars, reads, readsHash, data } or
 * { ok: false, code, reason }.
 */
async function prepareHoldout({ pair, cfg, tf, home, bars, workers, readsFn }) {
  if (!INSTRUMENTS[pair] || pair !== 'BTCUSD') return { ok: false, code: 'pair', reason: 'The held-back test is built for bitcoin only so far (gold has no scaled spread to take the larger of).' };
  if (!existsSync(FEATURES_EXTRA)) return { ok: false, code: 'no-features', reason: 'desk/features-extra.mjs is missing: the final needs it to describe each held-back check as the rows were described.' };
  // `bars` may be a function, so a bar file is read only once the guard has passed.
  let b = typeof bars === 'function' ? bars() : bars, file = null;
  if (!b) {
    const h = await loadHistory(pair, tf, { home, fromMs: FROM_MS - 20 * DAY_MS, toMs: TO_MS + DAY_MS });
    if (!h.ok) return { ok: false, code: 'no-bars', reason: h.reason };
    // Workers parse the bar file themselves and index into it, so they are
    // handed the whole cached history, and so is the parent.
    file = historyPath(pair, tf, home);
    b = workers > 1 ? loadBarsFile(file, pair) : h.bars;
    if (workers <= 1) file = null;
  }
  const bc = checkHoldoutBars(b, { cfg });
  if (!bc.ok) return { ok: false, code: 'bars', reason: bc.reason };
  const reads = await readsFn(b, { pair, cfg, workers, file });
  const dc = holdoutDataCheck(reads, expectedChecks(cfg));
  if (!dc.ok) return { ok: false, code: 'data', reason: dc.reason };
  const { ok: _ok, reason: _r, ...data } = dc;
  return { ok: true, bars: b, reads, readsHash: readsHashOf(reads), data };
}

/** The name of the final's lock kept in the git common directory, beside GIT_FINALS_LOG. */
export const GIT_FINAL_LOCK = 'scalp-desk-final.lock';

/** Where a final's locks are: under $SCALP_DESK_HOME, and in the git common dir of model.json's repository. */
export function finalLockPaths({ home, modelPath = null }) {
  const common = modelPath ? gitCommonDirOf(modelPath) : null;
  return [join(home, 'learn', 'final.lock'), ...(common ? [join(common, GIT_FINAL_LOCK)] : [])];
}

/**
 * Takes every lock of finalLockPaths (O_EXCL), in order. The home's alone did
 * not exclude two finals started together under different $SCALP_DESK_HOMEs;
 * the git common dir's is shared by every checkout and worktree of the
 * repository. Returns { release } with all of them held, or { busy: path }
 * naming the one another final holds (and holding none).
 */
function takeLock(home, modelPath = null) {
  const held = [];
  const release = () => { for (const p of held.splice(0)) { try { unlinkSync(p); } catch { /* already gone */ } } };
  for (const p of finalLockPaths({ home, modelPath })) {
    mkdirSync(dirname(p), { recursive: true });
    try {
      const fd = openSync(p, 'wx');
      try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
      held.push(p);
    } catch (e) {
      release();
      if (e && e.code === 'EEXIST') return { busy: p };
      throw e;
    }
  }
  return { release };
}

const BLOCKS = [
  { id: 'clean', label: '2025 (held back, clean)', from: FROM_MS, to: SEEN_MS },
  { id: 'seen', label: '2026 to 14 October (already seen while choosing the 1.5R rule)', from: SEEN_MS, to: TO_MS + 1 },
  { id: 'pooled', label: 'Whole held-back window (the test)', from: FROM_MS, to: TO_MS + 1 },
];

/**
 * Everything the final reports, from the holdout's reads and the frozen model.
 * Pure given its inputs, so it is tested on synthetic reads.
 *
 * Holes ahead, exactly as the walk-forward: a check whose trade — label (a)
 * on the 1.5R levels, or label (b)'s long or short, gross or net — would
 * cross a hole of more than GAP_BARS bars on its way to its exit is left out
 * of both alert passes (the predicate refuses it, so it neither alerts nor
 * starts a cooldown), and so out of the coin-flip baseline, and out of T2's
 * pairs and P2. The test is dataset.mjs rowFor's own `gapAhead`, the flag the
 * development rows carry, so the two periods are judged by one rule
 * (review, 17 Oct 2026). outcome() has no hole guard of its own: without
 * this, a trade before a hole would be scored on the bar after it.
 */
export function evaluateHoldout({ reads, bars, cfg, pair, model }) {
  const comm = costFor(pair, 0, cfg).comm;
  const gapAt = new Set(reads.filter((rd) => dataset.rowFor(rd, bars, { pair, cfg, cost: HOLDOUT_COST, calendar: HOLDOUT_CALENDAR, comm }).gapAhead).map((rd) => rd.k));
  const scorable = (rd) => !gapAt.has(rd.k);
  const minutes = tfInfo(timeframeFor(cfg)).minutes;
  const filter = deserialiseModel(model.model.filter), ranking = deserialiseModel(model.model.ranking);
  const tau = model.model.filter.threshold, tau2 = model.model.ranking.threshold;
  const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);
  if (!isNum(tau) || !isNum(tau2)) throw new Error('model.json has no filter or P2 threshold: refit.');
  const byK = new Map(reads.map((r) => [r.k, r]));
  const verdict = (rd) => rd.rules && rd.rules[TARGET_RULE];

  // The filter's call on every idea read.
  const keepCall = new Map();
  for (const rd of reads) {
    const v = verdict(rd);
    if (!v || v.kind !== 'idea' || !rd.extra || !rd.extra.f) continue;
    const pred = predict(filter, vectorOf(rd.extra.f, v.decision)) - costInR(rd.spreadNum, comm, v.stopDistance);
    keepCall.set(rd.k, pred >= tau);
  }
  const predicate = (rd) => keepCall.get(rd.k) === true;
  // Every pass leaves the gap-ahead checks out the same way (see above).
  const pass = (p) => alertPass(reads, bars, { cfg, rule: TARGET_RULE, pair, predicate: p ? (rd) => scorable(rd) && p(rd) : scorable, bothTouched: 'half', tfMinutes: minutes }).trades;
  const unfiltered = pass(null), kept = pass(predicate);
  const removed = unfiltered.filter((t) => keepCall.get(t.k) !== true);

  const closes = (rd) => windowState(rd.closeMs, cfg.window).closesAtMs;
  const scoreSide = (rd, side, stopDist, tp1Dist) => outcome(bars, rd.k, { side, stopDist, tp1Dist }, { spread: rd.spreadNum, comm, closesAtMs: closes(rd), tfMinutes: minutes, bothTouched: 'half' });

  // Coin-flip side at each unfiltered alert, with that alert's own distances.
  const paired = [];
  for (const t of unfiltered) {
    const rd = byK.get(t.k), v = verdict(rd);
    const tp1 = Math.abs(v.takeProfit1 - v.entry);
    const L = scoreSide(rd, 'buy', v.stopDistance, tp1), S = scoreSide(rd, 'sell', v.stopDistance, tp1);
    if (!L || !S) continue;
    const coin = (L.r + S.r) / 2;
    paired.push({ at: t.at, closeMs: t.closeMs, coin, diff: t.r - coin });
  }

  // Label (b) at every check with features; the ranking model's two predictions.
  const pairs = [], checks = [];
  for (const rd of reads) {
    const x = rd.extra;
    if (!x || !x.f || !(x.stopStd > 0) || !scorable(rd)) continue;
    const L = scoreSide(rd, 'buy', x.stopStd, B_TARGET * x.stopStd), S = scoreSide(rd, 'sell', x.stopStd, B_TARGET * x.stopStd);
    if (!L || !S) continue;
    const cost = costInR(rd.spreadNum, comm, x.stopStd);
    const pL = predict(ranking, vectorOf(x.f, 1)) - cost, pS = predict(ranking, vectorOf(x.f, -1)) - cost;
    const day = new Date(rd.closeMs).toISOString().slice(0, 10);
    pairs.push({ day, closeMs: rd.closeMs, pred: pL, real: L.r }, { day, closeMs: rd.closeMs, pred: pS, real: S.r });
    checks.push({ rd, L, S, pL, pS });
  }

  // P2 (exploratory): the higher-predicted side where it clears P2's own
  // threshold (on the ranking model's scale), one position at a time,
  // gate-open checks only (a blocked check is never tradeable, plan Engineering).
  const p2 = [];
  let busyUntil = -1;
  for (const c of checks) {
    if (!GATE_OPEN_READ.includes(c.rd.kind) || c.rd.k <= busyUntil) continue;
    const long = c.pL >= c.pS, best = long ? c.pL : c.pS;
    if (!(best >= tau2)) continue;
    const o = long ? c.L : c.S;
    p2.push({ at: new Date(c.rd.closeMs).toISOString().slice(0, 16), closeMs: c.rd.closeMs, side: long ? 'buy' : 'sell', r: o.r, how: o.how });
    busyUntil = c.rd.k + o.bars;
  }

  const inB = (b) => (x) => x.closeMs >= b.from && x.closeMs < b.to;
  const blocks = {};
  for (const b of BLOCKS) {
    const f = inB(b);
    const pr = pairs.filter(f);
    const t2 = t2Test(pr, { B: 0 });
    blocks[b.id] = {
      label: b.label,
      checks: reads.filter(f).length,
      unfiltered: summary(unfiltered.filter(f)), kept: summary(kept.filter(f)), removed: summary(removed.filter(f)),
      coinFlip: summary(paired.filter(f).map((p) => ({ at: p.at, r: p.coin }))),
      watcherMinusCoin: summary(paired.filter(f).map((p) => ({ at: p.at, r: p.diff }))),
      rankCorr: t2.corr, rankPairs: pr.length,
      p2: summary(p2.filter(f)),
      bothTouched: { unfiltered: unfiltered.filter(f).filter((t) => t.how === 'both').length, kept: kept.filter(f).filter((t) => t.how === 'both').length },
    };
  }
  const t1 = t1Test(kept, unfiltered);
  const t2 = t2Test(pairs);
  const gapIdeas = reads.filter((rd) => gapAt.has(rd.k) && verdict(rd) && verdict(rd).kind === 'idea').length;
  return { t1, t2, blocks, threshold: tau, p2Threshold: tau2, ideas: keepCall.size, keptIdeas: [...keepCall.values()].filter(Boolean).length, gapAhead: { checks: gapAt.size, ideas: gapIdeas } };
}

/**
 * `final` (step one): everything that sees no outcome — the guard, the bars,
 * the held-back reads and their completeness — then an "armed" entry in
 * model.json { kind: 'armed', at, pair, recipeHash, modelHash, window,
 * codeCommit, readsHash, data } for the session to commit. Refusals are
 * recorded too. Returns { refused, code?, reason?, armed? }.
 *   readsFn   (bars, { pair, cfg, workers, file }) => reads; default holdoutReads (tests stand in)
 */
export async function armFinal({ pair, cfg, modelPath, home, bars = null, workers = 1, readsFn = holdoutReads, codeCheck = null, rowsKeyFor = null, now = () => new Date(), userHome = null, anyModelPath = false }) {
  const tf = tfInfo(timeframeFor(cfg)).id;
  const model = readModel(modelPath);
  const base = () => ({ at: now().toISOString(), pair, recipeHash: model.recipeHash ?? null, window: { ...WINDOW } });
  const refuse = (code, reason) => { recordFinal(modelPath, { kind: 'refused', step: 'arm', ...base(), code, reason }); return { refused: true, code, reason }; };
  const g = finalGuard(model, { pair, tf, cfg, modelPath, home, codeCheck, rowsKeyFor, userHome, anyModelPath });
  if (!g.ok) return refuse(g.code, g.reason);
  const prep = await prepareHoldout({ pair, cfg, tf, home, bars, workers, readsFn });
  if (!prep.ok) return refuse(prep.code, prep.reason);
  const armed = { kind: 'armed', ...base(), modelHash: model.modelHash, codeCommit: g.codeCommit, readsHash: prep.readsHash, data: prep.data };
  recordFinal(modelPath, armed);
  return { refused: false, armed };
}

/**
 * `final --run` (step two): refuses unless an armed entry for this recipe,
 * model and window is in the model.json committed at HEAD, and unless the
 * guard, the bars and the reads still pass and the reads are the ones armed.
 * Then, under an exclusive lock and after one more look at the logs, it
 * appends { kind: 'started' } to every log and to model.json immediately before
 * the first outcome is computed (evaluateHoldout); a run cut short after
 * that still counts as the one look. A throw is recorded as { kind:
 * 'crashed' }. The results go in as { kind: 'ran' }. Status becomes 'shadow'
 * only if T1 passes AND the held-back window had not been looked at before
 * (replay looks); 'info-only' otherwise.
 *   evaluate  default evaluateHoldout (tests stand in)
 */
export async function runFinal({ pair, cfg, modelPath, home, bars = null, workers = 1, readsFn = holdoutReads, evaluate = evaluateHoldout, codeCheck = null, rowsKeyFor = null, now = () => new Date(), userHome = null, anyModelPath = false }) {
  const tf = tfInfo(timeframeFor(cfg)).id;
  const model = readModel(modelPath);
  const base = () => ({ at: now().toISOString(), pair, recipeHash: model.recipeHash ?? null, window: { ...WINDOW } });
  const refuse = (code, reason) => { recordFinal(modelPath, { kind: 'refused', step: 'run', ...base(), code, reason }); return { refused: true, code, reason }; };
  const lock = takeLock(home, modelPath);
  if (!lock.release) return refuse('locked', `Another final holds the lock (${lock.busy}). If none is running, a run was killed: it may have been before it started or after. Look for a 'started' record in model.json and the finals logs (${finalsLogPaths({ home, modelPath, userHome }).join(', ')}); if there is one, the held-back years are used. Otherwise remove the lock file and try again.`);
  const release = lock.release;
  const logs = { home, modelPath, userHome };
  try {
    const g = finalGuard(model, { pair, tf, cfg, modelPath, home, codeCheck, rowsKeyFor, userHome, anyModelPath });
    if (!g.ok) return refuse(g.code, g.reason);
    const armed = (g.head.finals || []).filter((f) => f && f.kind === 'armed' && f.pair === pair && f.recipeHash === model.recipeHash
      && f.modelHash === model.modelHash && sameWindow(f.window)).pop();
    if (!armed) return refuse('not-armed', 'The final is not armed in the committed model.json. Run `node desk/learn.mjs final --pair bitcoin`, commit model.json, then run `final --run`.');
    const prep = await prepareHoldout({ pair, cfg, tf, home, bars, workers, readsFn });
    if (!prep.ok) return refuse(prep.code, prep.reason);
    if (prep.readsHash !== armed.readsHash) return refuse('reads-changed', 'The held-back reads are not the ones checked when the final was armed (the bars they were read from, the code or the settings differ). Arm it again and commit model.json.');
    const looks = earlierLooks({ modelPath, model });
    const again = usedFinals({ pair, modelPath, home, userHome });
    if (again.length) return refuse('already-run', `${ALREADY_USED} ${describeUse(again[0])} A second final run is refused.`);

    const started = { kind: 'started', ...base(), modelHash: model.modelHash, armedAt: armed.at, codeCommit: g.codeCommit, readsHash: prep.readsHash, earlierLooks: looks.length };
    appendFinalsLogs(logs, started);
    recordFinal(modelPath, started);
    let results;
    try {
      results = evaluate({ reads: prep.reads, bars: prep.bars, cfg, pair, model });
    } catch (e) {
      const crashed = { kind: 'crashed', ...base(), startedAt: started.at, error: String((e && e.message) || e).slice(0, 500) };
      appendFinalsLogs(logs, crashed);
      recordFinal(modelPath, crashed);
      return { refused: false, crashed: true, error: crashed.error };
    }
    const status = results.t1.pass && !looks.length ? 'shadow' : 'info-only';
    const outcomeWord = results.t1.pass ? 'T1 passed' : 'T1 did not pass';
    const ran = { kind: 'ran', ...base(), modelHash: model.modelHash, startedAt: started.at, outcome: outcomeWord, earlierLooks: looks.length, status, results };
    appendFinalsLogs(logs, { kind: 'ran', ...base(), startedAt: started.at, outcome: outcomeWord, earlierLooks: looks.length, status });
    const m = readModel(modelPath);
    m.finals = [...(m.finals || []), ran];
    m.status = status;
    writeModel(modelPath, m);
    return { refused: false, results, status, earlierLooks: looks.length };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ similar setups */

/**
 * "Similar past setups", for explanation only (never a predictor, never on a
 * live alert). The k nearest past checks to `vec` (a side-signed feature
 * vector, as an object or in FEATURE_NAMES order) by standardised distance —
 * the scaling fitted on the candidates themselves, all strictly before
 * `beforeDay` — taking at most one per day, so one busy afternoon cannot fill
 * the list. Each neighbour is scored by its label (b) on `side`, net; the
 * baseline is the same label on the same side over the same pool (every
 * candidate check), so the two figures describe one trade definition.
 * Rows: compact (loadRows) or the stored format. Returns, "in 100" terms,
 * { n, days, side, reachedTarget, hitStop, closedAtEnd, bothInOneBar, meanR,
 *   baseline: { n, meanR } }.
 */
export function similarSetups(vec, rows, { k = 200, beforeDay, side = 'buy' } = {}) {
  if (typeof beforeDay !== 'string') throw new Error('similarSetups needs beforeDay (YYYY-MM-DD): only days strictly before it are used.');
  const S = SIDE_OF[side] || side;
  const compact = rows.map((r) => (r.vL !== undefined ? r : compactRow(r)));
  const pool = compact.filter((r) => r.day < beforeDay && r.vL && r.b && r.b[S] && r.b[S].net && finite(r.b[S].net.r));
  if (!pool.length) return { n: 0, days: 0, side: S, reachedTarget: 0, hitStop: 0, closedAtEnd: 0, bothInOneBar: 0, meanR: null, baseline: { n: 0, meanR: null } };
  const baseline = { n: pool.length, meanR: pool.reduce((t, r) => t + r.b[S].net.r, 0) / pool.length };
  const X = pool.map((r) => sideVec(r, S));
  const st = fitStandardiser(X, { clip: false });
  const q = Array.isArray(vec) || ArrayBuffer.isView(vec) ? Float64Array.from(vec, (v) => (v === null ? NaN : v))
    : Float64Array.from(FEATURE_NAMES, (n) => (finite(vec[n]) ? vec[n] : NaN));
  const zq = standardise(st, q);
  const nearestByDay = new Map();
  pool.forEach((r, i) => {
    const z = standardise(st, X[i]);
    let d = 0;
    for (let j = 0; j < z.length; j++) d += (z[j] - zq[j]) ** 2;
    const cur = nearestByDay.get(r.day);
    if (!cur || d < cur.d || (d === cur.d && r.closeMs < cur.r.closeMs)) nearestByDay.set(r.day, { d, r });
  });
  const near = [...nearestByDay.values()].sort((a, b) => a.d - b.d || a.r.closeMs - b.r.closeMs).slice(0, k);
  const n = near.length;
  const count = (how) => near.filter((x) => x.r.b[S].net.how === how).length;
  const raw = { target: count('target'), stop: count('stop'), both: count('both') };
  raw.window = n - raw.target - raw.stop - raw.both;
  const in100 = largestRemainder(raw, n);
  return {
    n, days: new Set(near.map((x) => x.r.day)).size, side: S,
    reachedTarget: in100.target, hitStop: in100.stop, closedAtEnd: in100.window, bothInOneBar: in100.both,
    meanR: near.reduce((s, x) => s + x.r.b[S].net.r, 0) / n,
    baseline,
  };
}

/** Counts as whole numbers out of 100 that add up to exactly 100 (largest remainder). */
function largestRemainder(counts, n) {
  const keys = Object.keys(counts);
  const exact = keys.map((k) => (100 * counts[k]) / n);
  const out = Object.fromEntries(keys.map((k, i) => [k, Math.floor(exact[i])]));
  let left = 100 - keys.reduce((s, k) => s + out[k], 0);
  for (const i of keys.map((_, i) => i).sort((a, b) => (exact[b] % 1) - (exact[a] % 1))) { if (left <= 0) break; out[keys[i]]++; left--; }
  return out;
}

const signedR = (x, dp = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(dp)}`;

/** Plan rule 8: in every multi-year report. */
export const MULTI_YEAR = 'Before 2025 there is no news calendar, so these years include trades around releases that the live desk would have sat out.';

/**
 * The plan's wording for similar setups: always "in 100", always beside the
 * baseline of the same standard trade at every earlier moment, never "won",
 * never a lone percentage, always that it describes the past, and the
 * multi-year caveat (plan rule 8).
 */
export function similarWords(s, { pairWord = 'bitcoin', years = '2017–2024' } = {}) {
  if (!s.n) return `There are no earlier moments on ${pairWord}'s ${years} prices to compare this one with.`;
  const trade = s.side === 'short' ? 'a standard sell' : 'a standard buy';
  const both = s.bothInOneBar ? ` (${s.bothInOneBar} in 100 touched both in one bar and count as half of each)` : '';
  let vs = '';
  const b = s.baseline && Number.isFinite(s.baseline.meanR) ? s.baseline.meanR : null;
  if (b !== null) {
    const d = s.meanR - b;
    vs = Math.abs(d) < 0.05 ? `, about the same as ${trade} at every earlier moment (${signedR(b)})` : `, ${d > 0 ? 'above' : 'below'} ${trade} at every earlier moment (${signedR(b)})`;
  }
  return `On ${pairWord}'s ${years} prices, of the ${s.n} moments most like this one (from ${s.days} different days), for ${trade}, `
    + `${s.reachedTarget} in 100 reached the target, ${s.hitStop} hit the stop, and the rest were closed at the end of the session${both}. `
    + `On average that is ${signedR(s.meanR)} times the risk${vs}. That describes the past; it is not a forecast for this trade. ${MULTI_YEAR}`;
}

/* -------------------------------------------------------------------- reports */

const PAIR_WORD = { BTCUSD: 'Bitcoin', XAUUSD: 'Gold' };
const avg = (s) => (s && s.n && s.mean !== null ? `on average ${signedR(s.mean)} times the risk` : 'none');
const rangeOf = (s) => (s && s.lo !== null ? ` (range ${signedR(s.lo)} to ${signedR(s.hi)})` : '');
const isRan = (f) => !!f && (f.kind === 'ran' || (f.kind === undefined && f.ran === true));
const dayOf = (at) => (typeof at === 'string' ? at.slice(0, 10) : 'an unknown date');

/** The last final that ran to its results, or null. */
export const lastFinal = (model) => [...(model.finals || [])].reverse().find((f) => isRan(f) && f.results) || null;

/**
 * The user's report, in the plan's shape, from the recorded final. The one
 * result line first; "held up" only if T1 passed, and then with the caution
 * that a pass on this sample overstates the edge; beside it, when the
 * held-back window had been looked at before, that this is not unseen data.
 * 2025 and 2026 follow apart. A final that started and did not finish says
 * so: the held-back years count as used.
 */
export function userReport(model, { pair = 'BTCUSD', committedAlerts = null } = {}) {
  const f = lastFinal(model);
  const word = PAIR_WORD[pair] || pair;
  const finals = model.finals || [];
  if (!f) {
    const started = [...finals].reverse().find((x) => x && (x.kind === 'started' || x.kind === 'crashed' || isRan(x)));
    if (started) {
      return `**${word} on past prices: the held-back test did not finish**\nThe held-back test was started on ${dayOf(started.at)} but did not finish; the held-back years (2025 to mid-October 2026) count as used, so there will be no result on unseen data.`;
    }
    const armed = [...finals].reverse().find((x) => x && x.kind === 'armed');
    return `**${word} on past prices: not tested yet**\nThe held-back years (2025 to mid-October 2026) have not been used.${armed ? ` The one held-back test was readied on ${dayOf(armed.at)} and has not run.` : ''} There is nothing to report until the one held-back test has run.`;
  }
  const r = f.results, p = r.blocks.pooled;
  const held = r.t1.pass;
  const looked = f.earlierLooks ? ` — ${ALREADY_USED} (the held-back years were looked at ${f.earlierLooks} time${f.earlierLooks > 1 ? 's' : ''} before this test.)` : '';
  const lines = [
    `**${word} on past prices: ${held ? 'held up' : 'could not show an improvement'}**${looked}`,
    'Held back and never used to build it: 2025 to mid-October 2026 (2026 had already been used to pick the 1.5R target).',
    `- All alerts: ${p.unfiltered.n}, ${avg(p.unfiltered)}${rangeOf(p.unfiltered)}`,
    `- Alerts the filter kept: ${p.kept.n}, ${avg(p.kept)}${rangeOf(p.kept)}`,
    `- Coin-flip side, same stops: ${avg(p.coinFlip)}`,
  ];
  for (const id of ['clean', 'seen']) {
    const b = r.blocks[id];
    lines.push(`  ${id === 'clean' ? '2025 alone' : '2026 alone (already seen)'}: all alerts ${b.unfiltered.n}, ${avg(b.unfiltered)}; kept ${b.kept.n}, ${avg(b.kept)}.`);
  }
  if (held) lines.push('Passing on this sample overstates how large the improvement really is.');
  lines.push('This is a test on past prices, not a forecast. It is not the verdict on your alerts: that still waits for '
    + `${committedAlerts ? `the ${committedAlerts} live alerts you committed to` : 'the live alerts you commit to'}.`);
  return lines.join('\n');
}

const fmt = (x, dp = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : signedR(x, dp));

/** The developer's report: the walk-forward, the choice, and the final's every figure. */
export function developerReport(model) {
  const out = ['Learning layer — developer report', MULTI_YEAR];
  if (model.recipeHash) out.push(`Recipe ${model.recipeHash.slice(0, 16)} · chosen λ ${model.chosen?.lambda} · kept share ${model.chosen?.q} · status ${model.status}`);
  if (model.model?.ranking && Number.isFinite(model.model.ranking.threshold)) out.push(`Thresholds: filter ${fmt(model.model.filter.threshold)} · P2 (ranking scale) ${fmt(model.model.ranking.threshold)}, share ${model.model.ranking.p2Share?.toFixed(4)}`);
  const wf = model.walkForward;
  if (wf) {
    out.push('', `Walk-forward on development years (trained on ${wf.trainedOn.from} → ${wf.trainedOn.to} for the final model; ${wf.rows} rows):`);
    out.push('  grid (mean net R of kept alerts, all test years):');
    for (const g of wf.grid) out.push(`    λ ${String(g.lambda).padEnd(5)} q ${String(g.q).padEnd(5)} n ${String(g.n).padStart(5)}  mean ${fmt(g.mean)}  se ${g.se === null ? '—' : g.se.toFixed(3)}`);
    out.push(wf.chosen.best
      ? `  chosen λ ${wf.chosen.lambda}, q ${wf.chosen.q} (best λ ${wf.chosen.best.lambda}, q ${wf.chosen.best.q} at ${fmt(wf.chosen.best.mean)}; ${wf.chosen.tiedWith} setting(s) within one SE, the larger λ then q preferred)`
      : `  chosen λ ${wf.chosen.lambda}, q ${wf.chosen.q}: no setting kept a single alert out of sample, so the plainest model was taken`);
    out.push('  year  train-to     unfiltered n/mean   kept n/mean      removed n/mean   rank corr  (alert check vs rows)');
    for (const y of wf.perYear) {
      out.push(`  ${y.year}  ${y.train.lastDay}  ${String(y.unfiltered.n).padStart(5)} ${fmt(y.unfiltered.mean)}   ${String(y.kept.n).padStart(5)} ${fmt(y.kept.mean)}   ${String(y.removed.n).padStart(5)} ${fmt(y.removed.mean)}   ${fmt(y.rankCorr)}  ${y.alertedMismatch ? `${y.alertedMismatch} differ` : 'same'}`);
    }
    out.push(`  pooled: unfiltered ${wf.pooled.unfiltered.n} ${fmt(wf.pooled.unfiltered.mean)} · kept ${wf.pooled.kept.n} ${fmt(wf.pooled.kept.mean)} · removed ${wf.pooled.removed.n} ${fmt(wf.pooled.removed.mean)}`);
    if (wf.conditions) {
      out.push('', 'What helped and what hurt (out-of-sample walk-forward results by condition; not coefficients):');
      out.push('', formatConditions(wf.conditions.kept, { title: 'Alerts the filter kept, by condition (test years 2019–2024)' }));
      out.push('', formatConditions(wf.conditions.removed, { title: 'Alerts the filter removed, by condition (test years 2019–2024)' }));
    }
  }
  for (const f of model.finals || []) {
    const kind = f.kind || (f.ran ? 'ran' : 'attempt');
    const what = f.outcome || f.code || f.error || '';
    out.push('', `Final ${kind} ${f.at}${what ? `: ${what}` : ''}${f.reason ? ` — ${f.reason}` : ''}`);
    if (kind === 'armed' && f.data) out.push(`  checks expected ${f.data.expected}, read ${f.data.got}, missing ${f.data.missing}, gap reads ${f.data.gaps}; code ${String(f.codeCommit).slice(0, 10)}`);
    if (!f.results) continue;
    const r = f.results;
    if (f.earlierLooks) out.push(`  Note: the held-back window had been looked at ${f.earlierLooks} time(s) before (model.json looks): ${ALREADY_USED} Status cannot be shadow.`);
    out.push(`  T1 filter: ${r.t1.pass ? 'PASS' : 'not passed'} — (a) kept lower bound ${fmt(r.t1.kept.lo)} ${r.t1.a ? '> 0' : '≤ 0'}; (b) kept − all ${fmt(r.t1.diff)}, bootstrap lower ${fmt(r.t1.diffLo)} ${r.t1.b ? '> 0' : '≤ 0'}; (c) ${r.t1.kept.n} kept ${r.t1.c ? '≥' : '<'} ${r.t1.minKept}`);
    out.push(`  T2 ranking: ${r.t2.pass ? 'PASS' : 'not passed'} — correlation ${fmt(r.t2.corr)}, bootstrap lower ${fmt(r.t2.lo)} over ${r.t2.days} days (switches nothing on)`);
    if (r.gapAhead) out.push(`  holes ahead: ${r.gapAhead.checks} checks left out (${r.gapAhead.ideas} of them ideas), by the walk-forward's rule`);
    for (const id of ['clean', 'seen', 'pooled']) {
      const b = r.blocks[id];
      out.push(`  ${b.label}: ${b.checks} checks`);
      out.push(`    unfiltered ${b.unfiltered.n} ${fmt(b.unfiltered.mean)} [${fmt(b.unfiltered.lo)}, ${fmt(b.unfiltered.hi)}] · kept ${b.kept.n} ${fmt(b.kept.mean)} · removed ${b.removed.n} ${fmt(b.removed.mean)}`);
      out.push(`    coin-flip ${fmt(b.coinFlip.mean)} · watcher minus coin-flip ${fmt(b.watcherMinusCoin.mean)} [${fmt(b.watcherMinusCoin.lo)}, ${fmt(b.watcherMinusCoin.hi)}] · rank corr ${fmt(b.rankCorr)} · P2 (exploratory) ${b.p2.n} ${fmt(b.p2.mean)} · both-touched bars ${b.bothTouched.unfiltered}/${b.bothTouched.kept}`);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------------ CLI */

/**
 * The rows file for the recipe's dataset settings: exactly dataset.mjs
 * rowsPath() for cost scaled, calendar rules, bars from binance. No other file
 * in the folder is ever picked up by itself; --rows names one explicitly (and
 * it is checked against its manifest all the same).
 */
export function defaultRowsPath(home, { pair, cfg }) {
  return dataset.rowsPath(home, { pair, cfg, cost: TRAIN_COST, calendar: TRAIN_CALENDAR, source: TRAIN_SOURCE });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (e) {
    // A refusal or a missing file is said in plain words, not as a stack trace.
    console.log(e && e.message ? e.message : String(e));
    process.exit(2);
  }
}

async function main() {
  const { ensureProxy } = await import('./net.mjs');
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const has = (k) => argv.includes(`--${k}`);
  const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const fail = (msg) => { console.log(msg); process.exit(2); };
  const HOME = process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');
  const CONFIG = process.env.SCALP_DESK_CONFIG || join(here, 'config.json');
  // --test-model names another model file for fit (scratch runs only);
  // final refuses it. Without it both refuse any but desk/model.json.
  const testModel = arg('test-model');
  if (has('test-model') && !testModel) fail('--test-model needs a file.');
  const MODEL = testModel ? resolve(testModel) : process.env.SCALP_DESK_MODEL || join(dirname(CONFIG), 'model.json');
  const anyModelPath = !!testModel;
  const cfg = withDefaults(JSON.parse(readFileSync(CONFIG, 'utf8')));
  const tf = tfInfo(timeframeFor(cfg)).id;
  const pair = pairOf(arg('pair', 'bitcoin'));
  if (!['status', 'fit', 'final', 'report', 'similar'].includes(cmd)) fail('Usage: node desk/learn.mjs status|report|fit|final [--run]|similar --pair bitcoin [--rows <file>] [--bars <file>] [--store <file>] [--workers <n>] [--at <UTC time> --side buy|sell] [--test-model <file>]');
  if (!pair) fail('--pair is bitcoin or gold.');
  // A final runs on desk/model.json alone: its git history is where every
  // final is looked for, and a second model file would start a history of its
  // own (review, 17 Oct 2026: a fresh clone ran a second final that way).
  if (cmd === 'final' && has('test-model')) fail('--test-model is for scratch fits only: a final runs on desk/model.json alone, whose git history records every final.');
  if (cmd === 'fit' || cmd === 'final') { const where = modelPathRefusal(MODEL, { anyModelPath }); if (where) fail(where); }
  if (pair === 'XAUUSD' && !process.env.TWELVEDATA_API_KEY) fail('Gold needs a free key from twelvedata.com (sign up, then API Keys). Add it in this session\'s cloud environment settings (title bar → environment → Edit) as an environment variable named TWELVEDATA_API_KEY — not in this chat — then start a new session. Bitcoin needs nothing.');
  const barsFile = arg('bars', process.env.SCALP_DESK_BARS || null);
  // Rows are looked up only by the two commands that read them.
  const rowsFile = () => arg('rows') || defaultRowsPath(HOME, { pair, cfg });

  /** Development bars only: the fit never holds a held-back bar. */
  const devBars = async (fromMs) => {
    if (barsFile) return loadBarsFile(barsFile, pair).filter((b) => b.t < FROM_MS);
    const h = await loadHistory(pair, tf, { home: HOME, fromMs, toMs: FROM_MS });
    if (!h.ok) fail(h.reason);
    return h.bars.filter((b) => b.t < FROM_MS);
  };

  if (cmd === 'status') {
    const model = readModel(MODEL);
    console.log(`Model file: ${MODEL}`);
    if (!model.recipeHash) console.log('No recipe fitted yet (node desk/learn.mjs fit --pair bitcoin).');
    else {
      let same;
      try { same = recipeHashOf(buildRecipe({ pair: model.recipe.pair, tf: model.recipe.timeframe, cfg, dataset: datasetOf(model.recipe) })) === model.recipeHash; } catch { same = false; }
      const head = committedModel(MODEL);
      console.log(`Recipe hash ${model.recipeHash} (${model.recipe.pair} ${model.recipe.timeframe}) · chosen λ ${model.chosen.lambda}, kept share ${model.chosen.q} · status ${model.status}`);
      console.log(same ? 'The code and config still match the recipe.' : 'The code or config has changed since the fit: the final will refuse until it is refitted and committed.');
      console.log(!head ? 'Not committed at git HEAD.' : head.recipeHash === model.recipeHash && head.modelHash === modelHashOf(model) ? 'Committed at git HEAD.' : 'git HEAD holds a different recipe or model: commit before the final.');
      const armedAtHead = (head?.finals || []).some((f) => f && f.kind === 'armed' && f.recipeHash === model.recipeHash && f.modelHash === model.modelHash && sameWindow(f.window));
      console.log(armedAtHead ? 'The final is armed in the committed model.json.' : 'The final is not armed in the committed model.json.');
    }
    const used = usedFinals({ pair, modelPath: MODEL, home: HOME });
    console.log(used.length ? `The held-back years are used: ${describeUse(used[0])}` : 'The held-back years have not been used.');
    const finals = model.finals || [];
    console.log(finals.length ? `Final entries (${finals.length}):` : 'No final entries recorded.');
    for (const f of finals) console.log(`  ${f.at} ${f.pair} ${f.kind || (f.ran ? 'ran' : 'attempt')}${f.outcome ? ` ${f.outcome}` : ''}${f.reason ? ` — ${f.reason}` : ''}`);
    const looks = earlierLooks({ modelPath: MODEL, model });
    if (looks.length) console.log(`Replay looks at held-back rows recorded: ${looks.length}.`);
  } else if (cmd === 'fit') {
    ensureProxy({ when: !barsFile });
    const path = rowsFile();
    const { rows, heldBack, settings, manifest } = await loadDataset(path, { pair, cfg });
    if (!rows.length) fail('No development rows (before 2025) in the file.');
    console.log(`${rows.length} development rows from ${path}, ${rows[0].day} → ${rows[rows.length - 1].day} · cost ${settings.cost} · calendar ${settings.calendar} · rows key ${manifest.rowsKey}${heldBack ? ` · ${heldBack} held-back rows left unread` : ''}`);
    const bars = await devBars(rows[0].t - 12 * DAY_MS);
    const testRows = rows.filter((r) => TEST_YEARS.includes(yearOf(r)));
    const store = await readsFromStore(testRows, bars, { pair, cfg, cost: settings.cost, calendar: settings.calendar, home: HOME, file: arg('store'), storeKey: manifest.storeKey });
    if (arg('store') && !store) fail(`The read store ${arg('store')} does not hold every test-year read from these bars.`);
    console.log(store ? `Alert pass on the read store ${store.path}.` : 'Alert pass on reads rebuilt from the rows (no complete read store for these settings).');
    const { model } = fitAll(rows, { bars, reads: store ? store.reads : null, cfg, pair, tf, settings, manifest, modelPath: MODEL, home: HOME, anyModelPath });
    console.log(developerReport(model));
    console.log(`\nWritten to ${MODEL}. Recipe hash ${model.recipeHash}. Commit model.json (and every method file), then arm the final: node desk/learn.mjs final --pair bitcoin.`);
  } else if (cmd === 'final') {
    ensureProxy({ when: !barsFile });
    const bars = barsFile ? () => loadBarsFile(barsFile, pair) : null;
    const workers = Number(arg('workers', barsFile ? 1 : defaultWorkers()));
    if (!has('run')) {
      const res = await armFinal({ pair, cfg, modelPath: MODEL, home: HOME, bars, workers, anyModelPath });
      if (res.refused) fail(`Refused: ${res.reason}\n(The attempt is recorded in ${MODEL}.)`);
      const d = res.armed.data;
      console.log(`Armed: the recipe, the model and the code are on record, and the held-back reads are complete (${d.got} of ${d.expected} checks, ${d.missing} missing, ${d.gaps} gap reads; no outcome was computed).`);
      const looks = earlierLooks({ modelPath: MODEL });
      if (looks.length) console.log(`Note: model.json records ${looks.length} replay look(s) at the held-back years (--holdout). The result will say it is not on unseen data, and T1 cannot set status shadow.`);
      console.log(`Commit ${MODEL} now. Then, and only then: node desk/learn.mjs final --run --pair bitcoin (the one look at the held-back years).`);
      return;
    }
    const res = await runFinal({ pair, cfg, modelPath: MODEL, home: HOME, bars, workers, anyModelPath });
    if (res.refused) fail(`Refused: ${res.reason}\n(The attempt is recorded in ${MODEL}.)`);
    if (res.crashed) fail(`The held-back test started and then failed: ${res.error}\nIt is recorded as crashed in ${MODEL} and ${finalsLogPaths({ home: HOME, modelPath: MODEL }).join(', ')}; the held-back years count as used. Commit ${MODEL} at once.`);
    const model = readModel(MODEL);
    console.log(userReport(model, { pair }));
    console.log('\n' + developerReport(model));
    console.log(`\nStatus: ${res.status}. Recorded in ${MODEL} and ${finalsLogPaths({ home: HOME, modelPath: MODEL }).join(', ')}. Commit ${MODEL} at once.`);
  } else if (cmd === 'report') {
    const model = readModel(MODEL);
    console.log(userReport(model, { pair }));
    console.log('\n---\n' + developerReport(model));
  } else if (cmd === 'similar') {
    const at = arg('at');
    if (!at) fail('--at takes the close time of a development check, like 2024-06-05T10:15 (UTC).');
    const closeMs = Date.parse(at.endsWith('Z') ? at : `${at}Z`);
    if (!Number.isFinite(closeMs)) fail('--at takes a time like 2024-06-05T10:15 (UTC).');
    if (closeMs >= FROM_MS) fail('Similar setups from the command line cover development checks only (before 2025).');
    // One standard trade, on the side asked about: never both at once, never
    // the engine's lean (plan rule 3; decisions 2, 22).
    const side = arg('side');
    if (!['buy', 'sell'].includes(side)) fail('--side buy or --side sell: similar setups describe one standard trade, on the side asked about (never both at once, never the engine\'s lean).');
    const { rows } = await loadDataset(rowsFile(), { pair, cfg });
    const row = rows.find((r) => r.closeMs === closeMs);
    if (!row || !row.vL) fail(`No check with features closes at ${at} in the rows.`);
    const first = rows[0].day.slice(0, 4), last = String(Math.min(2024, Number(row.day.slice(0, 4))));
    const words = { pairWord: (PAIR_WORD[pair] || pair).toLowerCase(), years: `${first}–${last}` };
    console.log(similarWords(similarSetups(side === 'sell' ? row.vS : row.vL, rows, { beforeDay: row.day, side }), words));
  }
}
