/**
 * The learning layer (desk/learn.mjs). Synthetic rows and bars only, seeded,
 * no network: what these hold it to is the arithmetic and the discipline, not
 * a result.
 *  - ridge is the exact minimiser of the mean loss plus λ‖w‖², intercept free,
 *    and λ really shrinks;
 *  - the standardiser and everything else a fold learns come from its own
 *    training rows: altering the test year and every later row moves nothing
 *    a fold fitted, and no fold trains on a day inside the purge;
 *  - long and short rows pool with mirrored features;
 *  - a filter that keeps everything gives exactly the unfiltered watcher;
 *  - T1 and T2 find a planted effect and stay quiet on noise, the same way
 *    every run (seeded bootstrap);
 *  - the final arms only after everything that sees no outcome passes, runs
 *    only when the armed entry is committed, records "started" in model.json
 *    and finals.log before the first outcome, and refuses a second run found
 *    anywhere: the working copy, any commit (a stash included) or the log;
 *    a dirty or untracked method file, a changed config and stale rows refuse;
 *  - rows are read only with a manifest whose sha256 and rowsKey hold today;
 *  - similar setups take one moment a day, strictly before the day asked,
 *    against the same label on the same side;
 *  - the recipe's hash does not depend on key order.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ridgeFit, ridgePath, fitStandardiser, standardise, predict, vectorOf, compactRow, filterData, rankingData, fitOne, fitModels,
  trainBefore, trainRowsFor, walkForward, readsFromRows, t1Test, t2Test, prng, summary, evaluateHoldout, serialiseModel,
  deserialiseModel, canonicalJSON, recipeHashOf, buildRecipe, finalGuard, runFinal, armFinal, readModel, writeModel, modelHashOf,
  similarSetups, similarWords, userReport, loadRows, loadDataset, manifestRecord, manifestPath, quantile, ALREADY_USED, CLIPPED, LAMBDAS,
  recordFinal, appendFinalsLog, readFinalsLog, finalsLogPath, codeClean, methodFiles, fitAll, p2ThresholdFor, defaultRowsPath, MULTI_YEAR, T2_SEED,
  finalsLogPaths, readLogFile, GIT_FINALS_LOG, MODEL_PATH, modelPathRefusal, isShallowRepo, readsHashOf,
} from '../desk/learn.mjs';
import { rowsKeyFor, rowsPath, sha256File } from '../desk/dataset.mjs';
import { FEATURE_NAMES, FEATURES_VERSION, DIRECTIONAL, SWAPPED, sideSigned, conditionOf } from '../desk/features.mjs';
import { alertPass } from '../desk/reads.mjs';
import { windowState } from '../src/sessions.js';
import { withDefaults } from '../desk/lib.mjs';
import { HOLDOUT } from '../desk/conditions.mjs';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
  });
};

const cfg = withDefaults({});
const M15 = 15 * 60000;
// The default desk home's finals log is ~/.scalp-desk/learn/finals.log: under
// test, ~ is a scratch folder (passed as userHome everywhere, and HOME too, so
// nothing here can ever write to the real one).
const USER_HOME = mkdtempSync(join(tmpdir(), 'learn-user-home-'));
process.env.HOME = USER_HOME;
/** The test-only options: any model file, and the scratch ~. */
const T = { anyModelPath: true, userHome: USER_HOME };
const P = FEATURE_NAMES.length;
const gauss = (rand) => { const u = Math.max(rand(), 1e-12), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** A plain Gaussian-elimination solve, written independently of learn.mjs's Cholesky. */
function gaussSolve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** A feature object: every name, plausible values, one regime and the hour/weekday from the time. */
function features(rand, closeMs) {
  const f = {};
  for (const n of FEATURE_NAMES) f[n] = gauss(rand);
  for (const r of ['trending', 'ranging', 'compressed', 'mixed']) f[`regime_${r}`] = 0;
  f[`regime_${['trending', 'ranging', 'compressed', 'mixed'][Math.floor(rand() * 4)]}`] = 1;
  f.confidence = 0.2 + 0.6 * rand();
  f.volume_abstain = 0; f.level_ahead_none = 0; f.level_behind_none = 0; f.htf_agree = rand() < 0.5 ? 1 : 0;
  const h = new Date(closeMs).getUTCHours();
  for (const [k, a, b] of [['hour_08_10', 8, 10], ['hour_10_12', 10, 12], ['hour_12_14', 12, 14], ['hour_14_16', 14, 16]]) f[k] = h >= a && h < b ? 1 : 0;
  const wd = new Date(closeMs).getUTCDay();
  ['wd_mon', 'wd_tue', 'wd_wed', 'wd_thu', 'wd_fri'].forEach((k, i) => { f[k] = wd === i + 1 ? 1 : 0; });
  if (rand() < 0.05) f.adx = null;   // a feature that is sometimes not measurable
  return f;
}

/**
 * Synthetic bars (a random walk on M15) and rows in the pinned format for
 * every `every`-th window check between two days, with `alerted` from the
 * unfiltered alert pass over the same reads, as dataset.mjs sets it.
 */
function synth({ from = '2021-01-04', to = '2024-12-31', every = 4, seed = 7 } = {}) {
  const rand = prng(seed);
  const t0 = Date.parse(`${from}T00:00Z`) - 12 * 86400e3, t1 = Date.parse(`${to}T23:45Z`) + 86400e3;
  const bars = [];
  let c = 30000;
  for (let t = t0; t <= t1; t += M15) {
    const o = c; c = Math.max(1000, c + gauss(rand) * 40);
    bars.push({ t, o, h: Math.max(o, c) + rand() * 30, l: Math.min(o, c) - rand() * 30, c, v: 100 });
  }
  // reads.mjs checkIndices asks the window about every bar (about 5 s for
  // four years); only weekday bars between 06:00 and 17:00 UTC can be in a
  // London 08:00-16:00 window, so only those are asked, the same way.
  const lo = Date.parse(`${from}T00:00Z`), hi = Date.parse(`${to}T23:59Z`);
  const ks = [];
  bars.forEach((b, k) => {
    const closeMs = b.t + M15, d = new Date(closeMs), h = d.getUTCHours(), wd = d.getUTCDay();
    if (closeMs < lo || closeMs > hi || wd === 0 || wd === 6 || h < 6 || h > 17) return;
    const w = windowState(closeMs, cfg.window);
    if (w.open && w.phase !== 'weekend') ks.push(k);
  });
  const picked = ks.filter((_, i) => i % every === 0);
  const rows = picked.map((k) => {
    const closeMs = bars[k].t + M15;
    const f = features(rand, closeMs);
    const u = rand();
    const kind = u < 0.15 ? 'idea' : u < 0.45 ? 'rejected' : u < 0.85 ? 'none' : 'blocked';
    const leaning = kind === 'idea' || kind === 'rejected';
    const side = rand() < 0.5 ? 'buy' : 'sell';
    const res = (r) => ({ r, how: r >= 1.4 ? 'target' : r <= -1 ? 'stop' : 'window' });
    const g = () => Math.max(-1, Math.min(1.5, gauss(rand) * 0.8));
    const gl = g(), gs = g(), ga = g();
    return {
      t: bars[k].t, closeMs, day: new Date(closeMs).toISOString().slice(0, 10), pair: 'BTCUSD', tf: 'M15',
      kind, lean: leaning ? (side === 'buy' ? 'long' : 'short') : null, spreadNum: 6, cost: 'scaled', calendar: 'rules', blackoutId: null,
      f, fv: FEATURES_VERSION, cond: leaning ? conditionOf(f, { side }) : null, atr: 80, stopStd: 100,
      a: leaning ? { side, stopDist: 100, tp1Dist: 150, confidence: 'moderate', netR: 0.4, gross: { ...res(ga), bars: 3, mfe: 1, mae: 1 }, net: { ...res(ga - 0.06), bars: 3, mfe: 1, mae: 1 } } : null,
      b: { stopDist: 100, tp1Dist: 150, long: { gross: res(gl), net: res(gl - 0.06) }, short: { gross: res(gs), net: res(gs - 0.06) } },
      alerted: false,
    };
  });
  const reads = readsFromRows(rows.map(compactRow), bars);
  const alerted = new Set(alertPass(reads, bars, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half' }).trades.map((t) => t.closeMs));
  for (const r of rows) r.alerted = alerted.has(r.closeMs);
  return { bars, rows, compact: rows.map(compactRow) };
}

/* ------------------------------------------------------------------ ridge */

console.log('\nridge');
test('ridge is the exact minimiser: matches the normal equations with a free intercept', () => {
  const rand = prng(1);
  const n = 12, p = 3, lambda = 0.37;
  const X = Array.from({ length: n }, () => Float64Array.from({ length: p }, () => gauss(rand)));
  const y = X.map((x) => 0.5 + 2 * x[0] - x[1] + 0.3 * gauss(rand));
  const fit = ridgeFit(X, y, lambda);
  // (1/n)‖y − b − Xw‖² + λ‖w‖²  ⇔  [n, 1ᵀX; Xᵀ1, XᵀX + nλI] [b; w] = [1ᵀy; Xᵀy]
  const A = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const rhs = new Array(p + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    for (let a = 0; a <= p; a++) { rhs[a] += row[a] * y[i]; for (let b = 0; b <= p; b++) A[a][b] += row[a] * row[b]; }
  }
  for (let a = 1; a <= p; a++) A[a][a] += n * lambda;
  const want = gaussSolve(A, rhs);
  assert.ok(Math.abs(fit.intercept - want[0]) < 1e-9, `intercept ${fit.intercept} vs ${want[0]}`);
  for (let j = 0; j < p; j++) assert.ok(Math.abs(fit.w[j] - want[j + 1]) < 1e-9, `w${j} ${fit.w[j]} vs ${want[j + 1]}`);
});
test('λ shrinks the weights, and never the intercept towards zero', () => {
  const rand = prng(2);
  const X = Array.from({ length: 200 }, () => Float64Array.from({ length: 4 }, () => gauss(rand)));
  const y = X.map((x) => 3 + x[0] + 0.5 * x[2] + gauss(rand));
  const fits = ridgePath(X, y, [0.01, 0.1, 1, 10]);
  const norm = (w) => Math.sqrt(w.reduce((s, v) => s + v * v, 0));
  for (let i = 1; i < fits.length; i++) assert.ok(norm(fits[i].w) < norm(fits[i - 1].w), `‖w‖ at λ ${fits[i].lambda}`);
  assert.ok(norm(fits[3].w) < 0.2 * norm(fits[0].w), 'λ 10 on standardised-scale data shrinks hard');
  const ybar = y.reduce((s, v) => s + v, 0) / y.length;
  assert.ok(fits.every((f) => Math.abs(f.intercept - ybar) < 0.5), 'the intercept stays near the mean of y at every λ');
});

/* ---------------------------------------------------------- standardising */

console.log('\nstandardising');
test('a feature with no spread or no measured value is dropped; nulls become the mean (0)', () => {
  const rand = prng(3);
  const X = Array.from({ length: 50 }, () => {
    const v = Float64Array.from({ length: P }, () => gauss(rand));
    v[FEATURE_NAMES.indexOf('volume_abstain')] = 0;          // constant
    v[FEATURE_NAMES.indexOf('log_rel_volume')] = NaN;        // never measured
    return v;
  });
  X[0][FEATURE_NAMES.indexOf('adx')] = NaN;
  const st = fitStandardiser(X);
  assert.ok(!st.names.includes('volume_abstain') && !st.names.includes('log_rel_volume'));
  assert.equal(st.names.length, P - 2);
  const z = standardise(st, X[0]);
  assert.equal(z[st.names.indexOf('adx')], 0, 'a null is the training mean, 0 once standardised');
  assert.ok([...z].every(Number.isFinite));
});
test('heavy-tailed features are clipped at the fold\'s own 1st and 99th percentiles', () => {
  const j = FEATURE_NAMES.indexOf('ret_16');
  assert.ok(CLIPPED.includes('ret_16'));
  const X = Array.from({ length: 1000 }, (_, i) => { const v = new Float64Array(P).fill(1); v[j] = i === 0 ? 1e6 : i / 1000; v[0] = i % 2; return v; });
  const st = fitStandardiser(X);
  const i = st.names.indexOf('ret_16');
  assert.ok(st.hi[i] < 1.1, 'the 1e6 release bar does not set the scale');
  assert.equal(standardise(st, X[0])[i], (st.hi[i] - st.mean[i]) / st.sd[i], 'an outlier is clipped before scaling');
});

/* ------------------------------------------------------- sides and pooling */

console.log('\nsides');
test('a short sees the mirror of a long, and the pool holds both with their own labels', () => {
  const { rows } = synth({ from: '2024-03-04', to: '2024-03-08', every: 8 });
  const row = rows[0];
  const L = vectorOf(row.f, 1), S = vectorOf(row.f, -1);
  const want = sideSigned(row.f, 'sell');
  FEATURE_NAMES.forEach((n, j) => {
    const v = want[n] === null ? NaN : want[n];
    assert.ok(Object.is(S[j], v) || S[j] === v, n);
    if (DIRECTIONAL.includes(n) && row.f[n] !== null) assert.equal(S[j], -L[j] + 0, n);
  });
  for (const [a, b] of SWAPPED) assert.equal(S[FEATURE_NAMES.indexOf(a)], L[FEATURE_NAMES.indexOf(b)]);
  const c = rows.map(compactRow);
  const { X, y } = rankingData(c);
  assert.equal(X.length, 2 * c.length);
  assert.deepEqual([...X[0]], [...c[0].vL]); assert.deepEqual([...X[1]], [...c[0].vS]);
  assert.equal(y[0], rows[0].b.long.gross.r); assert.equal(y[1], rows[0].b.short.gross.r);
});
test('pooled mirrored rows learn "momentum with the trade" as one weight, with no side term', () => {
  const rand = prng(4);
  const rows = Array.from({ length: 600 }, (_, i) => {
    const f = features(rand, Date.parse('2022-03-01T09:00Z') + i * 86400e3);
    const m = f.ret_4;
    return compactRow({ t: 0, closeMs: 0, day: '2022-03-01', f, kind: 'none', b: { stopDist: 100, long: { gross: { r: 0.4 * m + 0.1 * gauss(rand) } }, short: { gross: { r: -0.4 * m + 0.1 * gauss(rand) } } } });
  });
  const m = fitOne(rankingData(rows), [0.01]).fits[0.01];
  const w = m.w[m.st.names.indexOf('ret_4')];
  assert.ok(w > 0.3, `the side-aligned weight is learned (${w})`);
  const f = rows[0];
  assert.ok(Math.abs(predict(m, f.vL) - m.intercept + (predict(m, f.vS) - m.intercept)) < 0.2, 'mirrored moments predict near-mirrored results');
  assert.ok(Math.abs(m.intercept) < 0.05, 'one intercept, no side term, near zero for a symmetric label');
});

/* ------------------------------------------------------------ walk-forward */

console.log('\nwalk-forward');
const data = synth();
const years = [2023, 2024];
const wf = walkForward(data.compact, { bars: data.bars, cfg, pair: 'BTCUSD', years });
test('the purge: a fold for 2023 trains on days before 30 Dec 2022, never on the 30th or 31st', () => {
  assert.equal(trainBefore(2019), '2018-12-30');
  assert.equal(trainBefore(2023), '2022-12-30');
  const rows = ['2022-12-29', '2022-12-30', '2022-12-31', '2023-01-02'].map((day) => ({ day }));
  assert.deepEqual(trainRowsFor(rows, 2023).map((r) => r.day), ['2022-12-29']);
});
test('no fold trains on its test year or anything later', () => {
  for (const f of wf.folds) {
    assert.ok(f.train.lastDay < trainBefore(f.year), `${f.year}: last training day ${f.train.lastDay}`);
    assert.ok(f.train.lastDay < `${f.year}-01-01`);
  }
});
test('leak test: changing the test year and every later row (features and labels) moves nothing a fold fitted', () => {
  const year = 2023, cut = trainBefore(year);
  const altered = data.rows.map((r) => {
    if (r.day < cut) return r;
    const f = { ...r.f, adx: 1000 + (r.f.adx ?? 0), ret_1: 50 };
    const flip = (o) => (o ? { ...o, r: -o.r } : o);
    return { ...r, f, a: r.a ? { ...r.a, gross: flip(r.a.gross), net: flip(r.a.net) } : null, b: { ...r.b, long: { gross: flip(r.b.long.gross), net: flip(r.b.long.net) }, short: { gross: flip(r.b.short.gross), net: flip(r.b.short.net) } } };
  }).map(compactRow);
  const a = fitModels(trainRowsFor(data.compact, year)), b = fitModels(trainRowsFor(altered, year));
  assert.deepEqual(a.filter.st, b.filter.st, 'the standardiser comes from the training rows only');
  assert.deepEqual([...a.filter.fits[1].w], [...b.filter.fits[1].w]);
  const wf2 = walkForward(altered, { bars: data.bars, cfg, pair: 'BTCUSD', years: [year] });
  assert.deepEqual(wf2.folds[0].thresholds, wf.folds[0].thresholds, 'the thresholds come from the training rows only');
});
test('the grid is a real choice: predictions differ across λ, and a tie goes to the larger λ, then the larger q', () => {
  assert.equal(wf.grid.length, LAMBDAS.length * 3);
  const { chosen, grid } = wf;
  const best = grid.filter((g) => g.n).reduce((a, b) => (b.mean > a.mean ? b : a));
  const ties = grid.filter((g) => g.n && g.mean >= best.mean - best.se);
  const want = ties.sort((x, y) => y.lambda - x.lambda || y.q - x.q)[0];
  assert.deepEqual([chosen.lambda, chosen.q], [want.lambda, want.q]);
  const fit = fitModels(trainRowsFor(data.compact, 2024));
  const test = data.compact.filter((r) => r.day.startsWith('2024') && r.a);
  const preds = LAMBDAS.map((l) => test.map((r) => predict(fit.filter.fits[l], r.a.side === 'buy' ? r.vL : r.vS)));
  for (let i = 1; i < preds.length; i++) assert.ok(preds[i].some((p, k) => Math.abs(p - preds[i - 1][k]) > 1e-9));
});
test('the walk-forward\'s own unfiltered alerts are exactly the rows\' alerted flags', () => {
  for (const y of wf.perYear) assert.equal(y.alertedMismatch, 0, String(y.year));
  for (const y of wf.perYear) assert.ok(y.kept.n <= y.unfiltered.n + 5 && y.kept.n > 0 && Number.isFinite(y.rankCorr));
});
test('the walk-forward refuses a held-back row', () => {
  const late = { ...data.compact[data.compact.length - 1], closeMs: Date.parse('2025-01-02T10:00Z'), day: '2025-01-02' };
  assert.throws(() => walkForward([...data.compact, late], { bars: data.bars, cfg, pair: 'BTCUSD', years }), /held-back/);
});
test('a filter that keeps everything gives exactly the unfiltered watcher (through the alert pass)', () => {
  const rows = data.compact.filter((r) => r.day >= '2024-01-01');
  const reads = readsFromRows(rows, data.bars);
  const plain = alertPass(reads, data.bars, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half' }).trades;
  const all = alertPass(reads, data.bars, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half', predicate: () => true }).trades;
  assert.deepEqual(all, plain);
  assert.ok(plain.length > 20);
  // The same through the final's evaluation, with a threshold nothing falls below.
  const fit = fitModels(trainRowsFor(data.compact, 2024), [1]);
  const model = { model: { filter: { ...serialiseModel(fit.filter.fits[1], 1), threshold: -Infinity }, ranking: { ...serialiseModel(fit.ranking.fits[1], 1), threshold: 0 } } };
  const holdReads = reads.map((rd) => { const r = rows.find((x) => x.closeMs === rd.closeMs); return { ...rd, extra: { f: Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, Number.isNaN(r.vL[j]) ? null : r.vL[j]])), stopStd: r.stopStd } }; });
  const ev = evaluateHoldout({ reads: holdReads, bars: data.bars, cfg, pair: 'BTCUSD', model });
  assert.equal(ev.t1.kept.n, ev.t1.unfiltered.n);
  assert.equal(ev.t1.kept.mean, ev.t1.unfiltered.mean);
  assert.equal(ev.t1.diff, 0);
  // And a real threshold only ever removes ideas: every kept alert is one the filter called "keep".
  const strict = { model: { ...model.model, filter: { ...model.model.filter, threshold: quantile([...Array(9).keys()], 0.5) - 100 } } };
  assert.ok(evaluateHoldout({ reads: holdReads, bars: data.bars, cfg, pair: 'BTCUSD', model: strict }).t1.kept.n <= plain.length);
});
test('the held-back evaluation leaves out a check whose trade crosses a hole, as the walk-forward does', async () => {
  const { rowFor } = await import('../desk/dataset.mjs');
  const { outcome } = await import('../desk/outcome.mjs');
  const rows = data.compact.filter((r) => r.day >= '2024-01-01');
  const fit = fitModels(trainRowsFor(data.compact, 2024), [1]);
  const model = { model: { filter: { ...serialiseModel(fit.filter.fits[1], 1), threshold: -Infinity }, ranking: { ...serialiseModel(fit.ranking.fits[1], 1), threshold: 0 } } };
  const withExtra = (reads, rs) => reads.map((rd) => { const r = rs.find((x) => x.closeMs === rd.closeMs); return { ...rd, extra: { f: Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, Number.isNaN(r.vL[j]) ? null : r.vL[j]])), stopStd: r.stopStd } }; });
  const pass = (reads, bars, predicate = null) => alertPass(reads, bars, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half', predicate }).trades;
  const T = pass(readsFromRows(rows, data.bars), data.bars).find((t) => t.bars >= 2);
  // Six bars missing straight after the alert's entry: its trade would be scored across them.
  const cut = data.bars.filter((_, i) => i <= T.k || i > T.k + 6);
  const have = new Set(cut.map((b) => b.t));
  const kept = rows.filter((r) => have.has(r.t));
  const reads = withExtra(readsFromRows(kept, cut), kept);
  const gap = new Set(reads.filter((rd) => rowFor(rd, cut, { pair: 'BTCUSD', cfg, cost: 'max', calendar: 'full', comm: 0 }).gapAhead).map((rd) => rd.k));
  const kT = reads.find((rd) => rd.closeMs === T.closeMs).k;
  assert.ok(gap.has(kT), 'the alert\'s own check is gap-ahead');
  const ev = evaluateHoldout({ reads, bars: cut, cfg, pair: 'BTCUSD', model });
  assert.equal(ev.gapAhead.checks, gap.size);
  assert.ok(ev.gapAhead.ideas >= 1);
  // Both passes leave it out through the predicate, so later alerts are judged as the walk-forward judges them.
  const expected = pass(reads, cut, (rd) => !gap.has(rd.k));
  assert.equal(ev.t1.unfiltered.n, expected.length);
  assert.ok(Math.abs(ev.t1.unfiltered.mean - summary(expected).mean) < 1e-12);
  assert.equal(ev.t1.kept.n, expected.length, 'the kept pass (keep everything) leaves it out too');
  assert.ok(pass(reads, cut).some((t) => t.closeMs === T.closeMs) && !expected.some((t) => t.closeMs === T.closeMs), 'without the rule it would have been scored');
  // And T2's pairs (so P2) skip the same checks.
  const closes = (rd) => windowState(rd.closeMs, cfg.window).closesAtMs;
  const scored = (rd, side) => outcome(cut, rd.k, { side, stopDist: rd.extra.stopStd, tp1Dist: 1.5 * rd.extra.stopStd }, { spread: rd.spreadNum, comm: 0, closesAtMs: closes(rd), tfMinutes: 15, bothTouched: 'half' });
  const pairs = reads.filter((rd) => rd.extra.f && rd.extra.stopStd > 0 && !gap.has(rd.k) && scored(rd, 'buy') && scored(rd, 'sell')).length * 2;
  assert.equal(ev.t2.n, pairs);
  // The recipe says so, for the walk-forward and the holdout alike.
  assert.match(recipe.walkForward.gaps, /more than 4 bars/);
  assert.match(recipe.holdout.gaps, /walk-forward's rule/);
});
test('a model survives model.json: serialised and read back, it predicts the same', () => {
  const fit = fitModels(trainRowsFor(data.compact, 2024), [0.1]).filter.fits[0.1];
  const back = deserialiseModel(JSON.parse(JSON.stringify(serialiseModel(fit, 0.1))));
  for (const r of data.compact.slice(0, 50)) assert.equal(predict(back, r.vL), predict(fit, r.vL));
});

/* --------------------------------------------------------------- the tests */

console.log('\nT1 and T2');
function trades({ seed, effect, days = 220, perDay = 2 }) {
  const rand = prng(seed);
  const all = [], kept = [];
  for (let d = 0; d < days; d++) {
    const at = new Date(Date.UTC(2025, 0, 2) + d * 86400e3).toISOString().slice(0, 10);
    const dayShock = 0.3 * gauss(rand);
    for (let i = 0; i < perDay; i++) {
      const s = gauss(rand);
      const r = effect * s + dayShock + gauss(rand);
      const t = { at: `${at}T1${i}:00`, r };
      all.push(t);
      if (s > -0.1) kept.push(t);
    }
  }
  return { all, kept };
}
test('T1 passes a planted filter and does not fire on noise', () => {
  const good = trades({ seed: 11, effect: 0.6 });
  const r1 = t1Test(good.kept, good.all);
  assert.ok(r1.pass && r1.a && r1.b && r1.c, JSON.stringify({ lo: r1.kept.lo, diffLo: r1.diffLo, n: r1.kept.n }));
  const noise = trades({ seed: 12, effect: 0 });
  const r0 = t1Test(noise.kept, noise.all);
  assert.equal(r0.pass, false);
  assert.equal(r0.b, false, 'the kept-minus-all bound does not clear zero on noise');
});
test('T1 needs 140 kept alerts however good they look', () => {
  const few = trades({ seed: 13, effect: 1.5, days: 60 });
  const r = t1Test(few.kept, few.all);
  assert.ok(r.kept.n < 140 && r.a && !r.c && !r.pass);
});
test('T2 finds a planted ranking and does not fire on noise', () => {
  const make = (seed, rho) => {
    const rand = prng(seed);
    const pairs = [];
    for (let d = 0; d < 300; d++) {
      const day = new Date(Date.UTC(2025, 0, 2) + d * 86400e3).toISOString().slice(0, 10);
      const shock = gauss(rand);
      for (let i = 0; i < 20; i++) { const pred = gauss(rand); pairs.push({ day, pred, real: rho * pred + 0.5 * shock + gauss(rand) }); }
    }
    return pairs;
  };
  const yes = t2Test(make(21, 0.15));
  assert.ok(yes.pass && yes.corr > 0.05, JSON.stringify(yes));
  const no = t2Test(make(22, 0));
  assert.equal(no.pass, false, JSON.stringify(no));
});
test('the bootstrap is deterministic: same seed, same bound; another seed, another draw', () => {
  const t = trades({ seed: 31, effect: 0.2 });
  const a = t1Test(t.kept, t.all), b = t1Test(t.kept, t.all), c = t1Test(t.kept, t.all, { seed: 99 });
  assert.equal(a.diffLo, b.diffLo);
  assert.notEqual(a.diffLo, c.diffLo);
  const s = summary(t.all, 1.96);
  assert.ok(s.se > 0 && s.lo < s.mean && s.hi > s.mean && s.days === 220);
});

/* ------------------------------------------------------ rows and manifest */

/** Writes rows and a manifest beside them as dataset.mjs does (bars from binance, the recipe's source), with today's rowsKey. */
async function writeRows(dir, rows, { name = 'rows.jsonl', settings = {}, fromMs = Date.parse('2017-09-01T00:00Z'), toMs = Date.parse('2024-12-31T23:59:59.999Z'), rowsKey = null } = {}) {
  const path = join(dir, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = { pair: 'BTCUSD', tf: 'M15', cost: 'scaled', calendar: 'rules', ...settings };
  const manifest = {
    fromMs, toMs, rows: rows.length, sha256: await sha256File(path),
    rowsKey: rowsKey ?? rowsKeyFor(s, { cfg, source: 'binance' }), storeKey: 'store-key', settings: s, source: 'binance',
    featuresVersion: FEATURES_VERSION, labelVersion: 1, builtAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath(path), JSON.stringify(manifest));
  return { path, manifest };
}

/* --------------------------------------------------------------- the final */

console.log('\nthe final');
const baseManifest = { fromMs: Date.parse('2017-09-01T00:00Z'), toMs: Date.parse('2024-12-31T23:59:59.999Z'), rows: 1, sha256: '0'.repeat(64), storeKey: 's', source: 'binance', featuresVersion: FEATURES_VERSION, labelVersion: 1 };
const trainSettings = { pair: 'BTCUSD', tf: 'M15', cost: 'scaled', calendar: 'rules' };
const trainDataset = { ...baseManifest, settings: trainSettings, rowsKey: rowsKeyFor(trainSettings, { cfg, source: 'binance' }) };
const recipe = buildRecipe({ pair: 'BTCUSD', tf: 'M15', cfg, dataset: trainDataset });
const fitted = (() => {
  const fit = fitModels(trainRowsFor(data.compact, 2024), [1]);
  const m = { recipe, recipeHash: recipeHashOf(recipe), walkForward: null, chosen: { lambda: 1, q: 0.6 },
    model: { filter: { ...serialiseModel(fit.filter.fits[1], 1), threshold: 0 }, ranking: { ...serialiseModel(fit.ranking.fits[1], 1), threshold: 0.2, p2Share: 0.01 } }, finals: [], status: 'info-only' };
  m.modelHash = modelHashOf(JSON.parse(JSON.stringify(m)));
  return JSON.parse(JSON.stringify(m));
})();
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
const okCode = () => ({ ok: true, commit: 'test' });
const W = { from: HOLDOUT.from, to: HOLDOUT.to };
/** A scratch home and a git repository holding model.json (committed when `commit`). */
function scratch(model = fitted, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'learn-'));
  const path = join(dir, 'model.json');
  const home = join(dir, 'home');
  git(dir, 'init', '-q');
  writeModel(path, model);
  if (commit) { git(dir, 'add', 'model.json'); git(dir, 'commit', '-q', '-m', 'recipe'); }
  // Each scratch has its own stand-in for ~, so one test's final never reaches another's guard.
  return { dir, path, home, userHome: join(dir, 'user-home'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const guardOf = (s, model = readModel(s.path), extra = {}) => finalGuard(model, { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: s.path, home: s.home, codeCheck: okCode, ...T, userHome: s.userHome, ...extra });

test('the guard refuses without a recipe, outside git, uncommitted, tampered, or with the recipe, code or config changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-'));
  try {
    const path = join(dir, 'model.json');
    writeModel(path, { looks: [] });
    const g = (extra = {}) => finalGuard(readModel(path), { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: path, home: dir, codeCheck: okCode, ...T, ...extra });
    assert.equal(g().code, 'no-recipe');
    writeModel(path, fitted);
    assert.equal(g().code, 'not-committed', 'not a git repository at all');
    git(dir, 'init', '-q');
    assert.equal(g().code, 'not-committed', 'a repository, never committed');
    git(dir, 'add', 'model.json'); git(dir, 'commit', '-q', '-m', 'recipe');
    const open = g();
    assert.equal(open.ok, true);
    assert.equal(open.codeCommit, 'test');
    const tampered = readModel(path); tampered.model.filter.threshold = -5;
    assert.equal(finalGuard(tampered, { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: path, home: dir, codeCheck: okCode, ...T }).code, 'not-committed', 'a model edited after the commit');
    const other = { ...readModel(path), recipe: { ...recipe, lambdaGrid: [1] } };
    assert.equal(finalGuard(other, { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: path, home: dir, codeCheck: okCode, ...T }).code, 'changed', 'a recipe edited by hand');
    const moved = { ...cfg, window: { ...cfg.window, end: { h: 17, m: 0 } } };
    assert.equal(g({ cfg: moved }).code, 'changed', 'the window changed in config');
    const fee = { ...cfg, account: { ...cfg.account, commissionPerSideGBP: 3 } };
    assert.equal(g({ cfg: fee }).code, 'changed', 'the commission inputs changed in config');
    assert.equal(g({ rowsKeyFor: () => 'not-the-same' }).code, 'changed', 'today\'s dataset code would make other rows');
    assert.equal(g({ codeCheck: () => ({ ok: false, reason: 'dirty' }) }).code, 'code');
    assert.equal(g({ pair: 'XAUUSD' }).code, 'other-pair');
    assert.equal(g({ anyModelPath: false }).code, 'model-path', 'any model file but desk/model.json, without the test-only option');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a started final erased from the working copy (git checkout, git stash) is still found: finals.log and the stash ref', () => {
  const s = scratch();
  try {
    const started = { kind: 'started', at: '2026-10-17T01:00:00.000Z', pair: 'BTCUSD', recipeHash: fitted.recipeHash, window: W };
    // The log alone refuses, in a model.json that has never heard of it.
    appendFinalsLog(s.home, started);
    const g = guardOf(s);
    assert.equal(g.code, 'already-run');
    assert.ok(g.reason.startsWith(ALREADY_USED) && g.reason.includes('finals.log'));
    // A record in the working copy, then `git checkout -- model.json`: the log still has it.
    rmSync(finalsLogPath(s.home));
    assert.equal(guardOf(s).ok, true);
    recordFinal(s.path, started);
    assert.equal(guardOf(s).code, 'already-run');
    git(s.dir, 'checkout', '--', 'model.json');
    assert.equal(guardOf(s).ok, true, 'without the log, checkout would reopen it: that is why the run writes both');
    // `git stash` keeps the record in a commit on refs/stash: found too.
    recordFinal(s.path, started);
    git(s.dir, 'stash', '-q');
    assert.deepEqual(readModel(s.path).finals, []);
    assert.equal(guardOf(s).code, 'already-run');
    assert.match(guardOf(s).reason, /as committed in/);
  } finally { s.done(); }
});

test('a ran final committed, then erased and refitted and committed again, still refuses the final and the fit', () => {
  const s = scratch();
  try {
    const ran = { kind: 'ran', at: '2026-10-17T01:00:00.000Z', pair: 'BTCUSD', recipeHash: fitted.recipeHash, window: W, outcome: 'T1 did not pass' };
    recordFinal(s.path, ran);
    git(s.dir, 'commit', '-q', '-am', 'final recorded');
    writeModel(s.path, { ...fitted, finals: [] });
    git(s.dir, 'commit', '-q', '-am', 'refit as if nothing happened');
    rmSync(s.path);   // and the file deleted too
    writeModel(s.path, { ...fitted, finals: [] });
    const g = guardOf(s);
    assert.equal(g.code, 'already-run');
    assert.match(g.reason, /as committed in [0-9a-f]{10}/);
    assert.throws(() => fitAll([], { cfg, pair: 'BTCUSD', tf: 'M15', settings: {}, manifest: null, modelPath: s.path, home: s.home, ...T, userHome: s.userHome }), (e) => e.message.startsWith(ALREADY_USED));
    // The old record format (ran: true, no kind) counts the same.
    const t = scratch({ ...fitted, finals: [{ at: 'x', pair: 'BTCUSD', window: W, ran: true }] });
    try { assert.equal(guardOf(t).code, 'already-run'); } finally { t.done(); }
  } finally { s.done(); }
});

test('an overlapping window counts as used; refused and armed entries, and a window outside the holdout, do not', () => {
  const kinds = (finals) => { const s = scratch({ ...fitted, finals }); try { return guardOf(s).code ?? 'ok'; } finally { s.done(); } };
  assert.equal(kinds([{ kind: 'started', pair: 'BTCUSD', window: { from: '2025-06-01T00:00Z', to: '2025-07-01T00:00Z' } }]), 'already-run');
  assert.equal(kinds([{ kind: 'crashed', pair: 'BTCUSD', window: W }]), 'already-run');
  assert.equal(kinds([{ kind: 'started', pair: 'BTCUSD' }]), 'already-run', 'no window: counted');
  assert.equal(kinds([{ kind: 'started', pair: 'BTCUSD', window: { from: '2027-01-01T00:00Z', to: '2027-06-01T00:00Z' } }]), 'ok');
  assert.equal(kinds([{ kind: 'refused', pair: 'BTCUSD', window: W }, { kind: 'armed', pair: 'BTCUSD', window: W }]), 'ok');
  assert.equal(kinds([{ kind: 'ran', pair: 'XAUUSD', window: W }]), 'ok', 'another pair\'s holdout');
  // An unreadable line in the log is counted: it may have been a start.
  const s = scratch();
  try {
    mkdirSync(join(s.home, 'learn'), { recursive: true });
    writeFileSync(finalsLogPath(s.home), '{"kind":"star\n');
    assert.equal(guardOf(s).code, 'already-run');
  } finally { s.done(); }
});

test('the code check: an untracked or changed method file refuses, and so does model.json in another repository', () => {
  const code = mkdtempSync(join(tmpdir(), 'learn-code-'));
  const s = scratch();
  try {
    git(code, 'init', '-q');
    mkdirSync(join(code, 'desk'));
    writeFileSync(join(code, 'desk', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(code, 'model.json'), '{}\n');
    git(code, 'add', '.'); git(code, 'commit', '-q', '-m', 'code');
    const files = ['desk/a.mjs'];
    assert.equal(codeClean({ root: code, files, modelPath: join(code, 'model.json') }).ok, true);
    assert.match(codeClean({ root: code, files, modelPath: s.path }).reason, /not in the same git repository/);
    writeFileSync(join(code, 'desk', 'a.mjs'), 'export const a = 2;\n');
    const dirty = codeClean({ root: code, files });
    assert.equal(dirty.ok, false); assert.match(dirty.reason, /differ from the last commit: desk\/a\.mjs/);
    git(code, 'add', 'desk/a.mjs');
    assert.match(codeClean({ root: code, files }).reason, /differ from the last commit/, 'staged but not committed');
    git(code, 'checkout', 'HEAD', '--', 'desk/a.mjs');
    writeFileSync(join(code, 'desk', 'b.mjs'), 'export const b = 1;\n');
    assert.match(codeClean({ root: code, files: [...files, 'desk/b.mjs'] }).reason, /not committed: desk\/b\.mjs/);
    // Through the guard: a dirty method file refuses the final.
    writeFileSync(join(code, 'desk', 'a.mjs'), 'export const a = 3;\n');
    const g = guardOf(s, undefined, { codeCheck: () => codeClean({ root: code, files }) });
    assert.equal(g.code, 'code');
    // The recipe hashes every file learn.mjs and dataset.mjs import, and the plan's.
    for (const f of ['desk/stats.mjs', 'desk/conditions.mjs', 'desk/history.mjs', 'desk/dataset.mjs', 'desk/reads.mjs', 'desk/outcome.mjs', 'desk/features-extra.mjs', 'desk/learn.mjs', 'src/signal-engine.js', 'desk/net.mjs']) {
      assert.ok(methodFiles().includes(f), f);
    }
  } finally { rmSync(code, { recursive: true, force: true }); s.done(); }
});

/* Synthetic held-back bars and reads: a random walk over the whole window, kind 'none' everywhere. */
const holdBars = (() => {
  const rand = prng(41);
  const t0 = Date.parse(HOLDOUT.from) - 1100 * M15, t1 = Date.parse(HOLDOUT.to) + 86400e3;
  const bars = [];
  let c = 90000;
  for (let t = t0; t <= t1; t += M15) { const o = c; c = Math.max(1000, c + gauss(rand) * 60); bars.push({ t, o, h: Math.max(o, c) + rand() * 40, l: Math.min(o, c) - rand() * 40, c, v: 100 }); }
  return bars;
})();
const holdF = features(prng(42), Date.parse('2025-03-04T10:00Z'));
let holdMemo = null;
const fakeReads = async (bars) => {
  if (bars === holdBars && holdMemo) return holdMemo;
  const out = [];
  const from = Date.parse(HOLDOUT.from), to = Date.parse(HOLDOUT.to);
  bars.forEach((b, k) => {
    const closeMs = b.t + M15;
    if (closeMs < from || closeMs > to) return;
    const w = windowState(closeMs, cfg.window);
    if (w.open && w.phase !== 'weekend') out.push({ k, closeMs, nowMs: closeMs + 20000, spreadNum: 6, kind: 'none', extra: { f: holdF, stopStd: 100 } });
  });
  if (bars === holdBars) holdMemo = out;
  return out;
};
const finalOpts = (s, extra = {}) => ({ pair: 'BTCUSD', cfg, modelPath: s.path, home: s.home, bars: holdBars, readsFn: fakeReads, codeCheck: okCode, ...T, userHome: s.userHome, ...extra });

test('arming sees no outcome: it checks the bars and the reads first, and refuses before anything counts as a look', async () => {
  const s = scratch();
  try {
    const dup = [...holdBars.slice(0, 3000), holdBars[2999], ...holdBars.slice(3000)];
    assert.equal((await armFinal(finalOpts(s, { bars: dup }))).code, 'bars');
    assert.match(readModel(s.path).finals.at(-1).reason, /rise strictly/);
    const late = holdBars.filter((b) => b.t >= Date.parse(HOLDOUT.from) - 500 * M15);
    assert.match((await armFinal(finalOpts(s, { bars: late }))).reason, /bars before 2025-01-01/);
    const short = holdBars.filter((b) => b.t < Date.parse('2026-06-01T00:00Z'));
    assert.match((await armFinal(finalOpts(s, { bars: short }))).reason, /does not reach the end/);
    const gappy = async (b) => (await fakeReads(b)).map((r, i) => (i % 20 === 0 ? { ...r, kind: 'gap' } : r));
    assert.match((await armFinal(finalOpts(s, { readsFn: gappy }))).reason, /read as a gap/);
    const holes = async (b) => (await fakeReads(b)).filter((_, i) => i % 50 !== 0);
    assert.match((await armFinal(finalOpts(s, { readsFn: holes }))).reason, /have no bar/);
    // None of that is a use of the holdout: the guard is still open, and --run was never reached.
    assert.ok(readModel(s.path).finals.every((f) => f.kind === 'refused'));
    assert.equal(guardOf(s).ok, true);
    const res = await armFinal(finalOpts(s));
    assert.equal(res.refused, false);
    assert.equal(res.armed.kind, 'armed');
    assert.equal(res.armed.data.missing, 0);
    assert.equal(res.armed.data.got, res.armed.data.expected);
    assert.ok(res.armed.data.expected > 14000 && res.armed.data.expected < 16000, String(res.armed.data.expected));
    assert.ok(!readFinalsLog(s.home).length, 'arming writes nothing to the log of looks');
  } finally { s.done(); }
});

test('--run refuses until the armed entry is committed; then it records started (model.json and finals.log) before the results', async () => {
  const s = scratch();
  try {
    let evaluated = 0;
    const spy = (args) => { evaluated++; return evaluateHoldout(args); };
    await armFinal(finalOpts(s));
    const r0 = await runFinal(finalOpts(s, { evaluate: spy }));
    assert.equal(r0.code, 'not-armed', 'armed in the working copy only');
    assert.equal(evaluated, 0);
    assert.ok(!readFinalsLog(s.home).length, 'nothing started');
    git(s.dir, 'commit', '-q', '-am', 'armed');
    // The reads changed since arming (other bars or code): refused, before anything starts.
    const shifted = async (b) => (await fakeReads(b)).map((r, i) => (i === 7 ? { ...r, spreadNum: 7 } : r));
    assert.equal((await runFinal(finalOpts(s, { readsFn: shifted, evaluate: spy }))).code, 'reads-changed');
    assert.equal(evaluated, 0);
    // Another run holding the lock.
    mkdirSync(join(s.home, 'learn'), { recursive: true });
    writeFileSync(join(s.home, 'learn', 'final.lock'), 'x');
    assert.equal((await runFinal(finalOpts(s, { evaluate: spy }))).code, 'locked');
    rmSync(join(s.home, 'learn', 'final.lock'));
    // The run: started first, everywhere, then the results.
    const order = [];
    const watch = (args) => { order.push(['evaluate', readFinalsLog(s.home).map((e) => e.kind), readModel(s.path).finals.map((f) => f.kind).filter((k) => k !== 'refused')]); return spy(args); };
    const res = await runFinal(finalOpts(s, { evaluate: watch }));
    assert.equal(res.refused, false);
    assert.deepEqual(order, [['evaluate', ['started'], ['armed', 'started']]]);
    assert.deepEqual(readFinalsLog(s.home).map((e) => e.kind), ['started', 'ran']);
    const m = readModel(s.path);
    assert.deepEqual(m.finals.filter((f) => f.kind !== 'refused').map((f) => f.kind), ['armed', 'started', 'ran']);
    assert.equal(m.status, 'info-only');
    assert.ok(Number.isFinite(m.finals.at(-1).results.p2Threshold) && m.finals.at(-1).results.p2Threshold === 0.2, 'P2 used its own threshold');
    assert.ok(!existsSync(join(s.home, 'learn', 'final.lock')), 'the lock is released');
    // A second run, a re-arm and a refit are all refused.
    assert.equal((await runFinal(finalOpts(s, { evaluate: spy }))).code, 'already-run');
    assert.equal((await armFinal(finalOpts(s))).code, 'already-run');
    assert.throws(() => fitAll([], { cfg, pair: 'BTCUSD', tf: 'M15', settings: {}, manifest: null, modelPath: s.path, home: s.home, ...T, userHome: s.userHome }), (e) => e.message.startsWith(ALREADY_USED));
    assert.equal(evaluated, 1);
  } finally { s.done(); }
});

test('the same reads from a bar array that starts earlier (the whole cached file, or a refilled cache) are the reads armed', async () => {
  const s = scratch();
  try {
    await armFinal(finalOpts(s));
    git(s.dir, 'commit', '-q', '-am', 'armed');
    // 300 more bars before the first: every read's index moves, nothing else does.
    const earlier = Array.from({ length: 300 }, (_, i) => ({ ...holdBars[0], t: holdBars[0].t - (300 - i) * M15 }));
    const longer = [...earlier, ...holdBars];
    const a = await fakeReads(holdBars), b = await fakeReads(longer);
    assert.equal(b[0].k - a[0].k, 300);
    assert.equal(readsHashOf(a), readsHashOf(b), 'the index is not part of the hash');
    assert.notEqual(readsHashOf(a), readsHashOf(a.map((r, i) => (i === 7 ? { ...r, spreadNum: 7 } : r))), 'a changed read still is');
    const res = await runFinal(finalOpts(s, { bars: longer, evaluate: () => { throw new Error('boom'); } }));
    assert.notEqual(res.code, 'reads-changed');
    assert.equal(res.crashed, true, 'it got past the reads check to the run');
  } finally { s.done(); }
});

test('a run that fails after it started counts as the one look, and the report says it did not finish', async () => {
  const s = scratch();
  try {
    await armFinal(finalOpts(s));
    git(s.dir, 'commit', '-q', '-am', 'armed');
    const res = await runFinal(finalOpts(s, { evaluate: () => { throw new Error('boom'); } }));
    assert.equal(res.crashed, true);
    assert.deepEqual(readFinalsLog(s.home).map((e) => e.kind), ['started', 'crashed']);
    assert.match(userReport(readModel(s.path)), /^\*\*Bitcoin on past prices: the held-back test did not finish\*\*\nThe held-back test was started on \d{4}-\d{2}-\d{2} but did not finish; the held-back years .* count as used/);
    // Put model.json back as committed: the log still refuses.
    git(s.dir, 'checkout', '--', 'model.json');
    assert.equal((await runFinal(finalOpts(s))).code, 'already-run');
  } finally { s.done(); }
});

test('earlier replay looks at 2025–26: a passing T1 cannot set shadow, and the user report says so beside the result line', async () => {
  const looks = [{ at: '2026-10-16T00:00:00.000Z', range: { from: '2025-01-01T00:00:00.000Z', to: '2025-06-30T23:59:59.999Z' } }, { at: 'old', range: { from: '2019-01-01T00:00Z', to: '2019-12-31T00:00Z' } }];
  const s = scratch({ ...fitted, looks });
  try {
    const blk = (n, mean) => ({ n, mean, lo: mean - 0.2, hi: mean + 0.2, days: n, se: 0.1 });
    const block = { unfiltered: blk(250, 0.03), kept: blk(150, 0.05), removed: blk(100, 0), coinFlip: blk(250, -0.02), watcherMinusCoin: blk(250, 0.05), p2: blk(10, 0), bothTouched: {}, checks: 1, label: 'x' };
    const fake = () => ({ t1: { pass: true, kept: { lo: 0.1, n: 150 }, minKept: 140 }, t2: { pass: false }, blocks: { clean: block, seen: block, pooled: block } });
    await armFinal(finalOpts(s));
    git(s.dir, 'commit', '-q', '-am', 'armed');
    const res = await runFinal(finalOpts(s, { evaluate: fake }));
    assert.equal(res.earlierLooks, 1, 'only the look overlapping the held-back window');
    assert.equal(res.status, 'info-only');
    const m = readModel(s.path);
    assert.equal(m.status, 'info-only');
    const first = userReport(m).split('\n')[0];
    assert.equal(first, `**Bitcoin on past prices: held up** — ${ALREADY_USED} (the held-back years were looked at 1 time before this test.)`);
  } finally { s.done(); }
});

test('the user report is the plan\'s shape and never says more than T1 allows', () => {
  const blk = (n, mean) => ({ n, mean, lo: mean - 0.2, hi: mean + 0.2, days: n, se: 0.1 });
  const block = { unfiltered: blk(250, 0.03), kept: blk(150, 0.05), removed: blk(100, 0), coinFlip: blk(250, -0.02), watcherMinusCoin: blk(250, 0.05), p2: blk(10, 0), bothTouched: {}, checks: 1 };
  const final = { kind: 'ran', results: { t1: { pass: false }, t2: { pass: false }, blocks: { clean: block, seen: block, pooled: block } } };
  const text = userReport({ finals: [final] }, { pair: 'BTCUSD' });
  const lines = text.split('\n');
  assert.equal(lines[0], '**Bitcoin on past prices: could not show an improvement**');
  assert.equal(lines[1], 'Held back and never used to build it: 2025 to mid-October 2026 (2026 had already been used to pick the 1.5R target).');
  assert.match(lines[2], /^- All alerts: 250, on average \+0\.03 times the risk \(range −0\.17 to \+0\.23\)$/);
  assert.match(lines[3], /^- Alerts the filter kept: 150, on average \+0\.05/);
  assert.match(lines[4], /^- Coin-flip side, same stops: on average −0\.02 times the risk$/);
  assert.match(text, /2025 alone/); assert.match(text, /2026 alone \(already seen\)/);
  assert.match(lines[lines.length - 1], /^This is a test on past prices, not a forecast\. It is not the verdict on your alerts/);
  assert.doesNotMatch(text, /\bwon\b|\blost\b|£|profit/i);
  const pass = userReport({ finals: [{ ...final, results: { ...final.results, t1: { pass: true } } }] });
  assert.match(pass, /^\*\*Bitcoin on past prices: held up\*\*\n/);
  assert.match(pass, /overstates/);
  assert.match(userReport({}), /not tested yet/);
  assert.match(userReport({ finals: [{ kind: 'armed', at: '2026-10-17T09:00:00Z' }] }), /not tested yet\*\*\nThe held-back years .* have not been used\. The one held-back test was readied on 2026-10-17/);
});

/* ---------------------------------------------------------- similar setups */

console.log('\nsimilar setups');
test('one neighbour a day, only days strictly before the one asked, nearest first', () => {
  const rows = data.compact.filter((r) => r.day < '2022-06-01');
  const q = rows[rows.length - 1];
  const s = similarSetups(q.vL, rows, { k: 200, beforeDay: q.day, side: 'buy' });
  assert.equal(s.n, 200);
  assert.equal(s.days, 200, 'every neighbour from a different day');
  assert.equal(s.reachedTarget + s.hitStop + s.closedAtEnd + s.bothInOneBar, 100, 'in 100, adding up');
  // Strictly before: a perfect twin on the day itself, or later, is never used.
  const twinSameDay = { ...q, closeMs: q.closeMs + 1, b: { ...q.b, long: { gross: { r: 1.5, how: 'target' }, net: { r: 99, how: 'target' } } } };
  const s2 = similarSetups(q.vL, [...rows, twinSameDay], { k: 200, beforeDay: q.day, side: 'buy' });
  assert.deepEqual(s2, s);
  // Allowed the day after, the twin is the nearest and its day's only member.
  const s3 = similarSetups(q.vL, [...rows.filter((r) => r !== q), twinSameDay], { k: 1, beforeDay: '2022-06-01', side: 'buy' });
  assert.equal(s3.meanR, 99);
  // The stored row format works too, and a k larger than the days available returns what there is.
  const few = data.rows.filter((r) => r.day < '2021-01-12');
  const s4 = similarSetups(vectorOf(few[0].f, 1), few, { k: 500, beforeDay: '2021-01-12' });
  assert.equal(s4.n, new Set(few.map((r) => r.day)).size);
  assert.throws(() => similarSetups(q.vL, rows, {}), /beforeDay/);
});
test('the baseline is the same label on the same side over the same pool, not label (a) of alerts', () => {
  const rows = data.compact.filter((r) => r.day < '2022-06-01');
  const q = rows[rows.length - 1];
  for (const [side, S] of [['buy', 'long'], ['sell', 'short']]) {
    const s = similarSetups(side === 'buy' ? q.vL : q.vS, rows, { k: 50, beforeDay: q.day, side });
    const pool = rows.filter((r) => r.day < q.day && r.b && r.b[S].net);
    assert.equal(s.side, S);
    assert.equal(s.baseline.n, pool.length);
    assert.ok(Math.abs(s.baseline.meanR - pool.reduce((t, r) => t + r.b[S].net.r, 0) / pool.length) < 1e-12);
  }
  // Changing label (a) everywhere moves nothing.
  const noA = rows.map((r) => ({ ...r, a: r.a ? { ...r.a, net: { r: 50, how: 'target' } } : null }));
  assert.deepEqual(similarSetups(q.vL, noA, { k: 50, beforeDay: q.day }).baseline, similarSetups(q.vL, rows, { k: 50, beforeDay: q.day }).baseline);
});
test('the wording is "in 100", beside the same trade at every earlier moment, says it is the past, and carries the multi-year caveat', () => {
  const w = similarWords({ n: 200, days: 200, side: 'long', reachedTarget: 20, hitStop: 34, closedAtEnd: 46, bothInOneBar: 0, meanR: 0.03, baseline: { n: 9000, meanR: 0.028 } });
  assert.equal(w, 'On bitcoin\'s 2017–2024 prices, of the 200 moments most like this one (from 200 different days), for a standard buy, 20 in 100 reached the target, 34 hit the stop, and the rest were closed at the end of the session. On average that is +0.03 times the risk, about the same as a standard buy at every earlier moment (+0.03). That describes the past; it is not a forecast for this trade. ' + MULTI_YEAR);
  assert.match(similarWords({ n: 10, days: 10, side: 'short', reachedTarget: 50, hitStop: 20, closedAtEnd: 30, bothInOneBar: 0, meanR: 0.4, baseline: { n: 10, meanR: 0 } }), /above a standard sell at every earlier moment/);
  assert.match(w, /Before 2025 there is no news calendar/);
  assert.doesNotMatch(w, /won|%/);
});

test('similar setups describe one standard trade: the developer command needs --side, and the module has no both-sides form', async () => {
  const mod = await import('../desk/learn.mjs');
  assert.equal(mod.similarBothWords, undefined, 'no buy-and-sell side-by-side wording to reach for');
  const LEARN = fileURLToPath(new URL('../desk/learn.mjs', import.meta.url));
  const home = mkdtempSync(join(tmpdir(), 'learn-similar-'));
  try {
    const env = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_MODEL: join(home, 'model.json') };
    const cli = (args) => { try { return `ran\n${execFileSync('node', [LEARN, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })}`; } catch (e) { return `EXIT ${e.status}\n${e.stdout}`; } };
    const at = ['similar', '--pair', 'bitcoin', '--at', '2024-06-05T10:15', '--rows', join(home, 'none.jsonl')];
    for (const side of [[], ['--side'], ['--side', 'both']]) {
      assert.match(cli([...at, ...side]), /^EXIT 2\n--side buy or --side sell: similar setups describe one standard trade/, side.join(' ') || 'no side');
    }
    // With a side it goes on (here to the missing rows): unchanged.
    for (const side of ['buy', 'sell']) assert.match(cli([...at, '--side', side]), /^EXIT 2\nNo rows at/, side);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/* -------------------------------------------------------- recipe and rows */

console.log('\nrecipe and rows');
test('the recipe hash does not depend on key order, and changes with any setting, the config or the rows', () => {
  const shuffled = (v) => (Array.isArray(v) ? v.map(shuffled) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, shuffled(v[k])])) : v);
  assert.equal(canonicalJSON(shuffled(recipe)), canonicalJSON(recipe));
  assert.equal(recipeHashOf(shuffled(recipe)), recipeHashOf(recipe));
  assert.notEqual(JSON.stringify(shuffled(recipe)), JSON.stringify(recipe), 'the shuffle really reorders');
  assert.notEqual(recipeHashOf({ ...recipe, qGrid: [0.75, 0.6] }), recipeHashOf(recipe));
  assert.deepEqual(recipe.features.names, [...FEATURE_NAMES]);
  assert.equal(recipe.tests.z, 2.241); assert.equal(recipe.floors.minKeptAlerts, 140);
  assert.deepEqual(recipe.tests.bootstrap.seeds, { T1: 20261016, T2: T2_SEED });
  assert.equal(T2_SEED, 20261017);
  assert.deepEqual([recipe.calendar.training, recipe.calendar.holdout], ['rules', 'full']);
  assert.match(recipe.calendar.why, /Features do not depend on the calendar/);
  assert.deepEqual(recipe.config, { window: cfg.window, broker: cfg.broker, timeframe: 'M15', account: { gbpusd: cfg.account.gbpusd, commissionPerSideGBP: null } });
  assert.ok(!JSON.stringify(recipe).includes('balance'), 'no money in the recipe');
  assert.deepEqual(recipe.dataset, trainDataset);
  assert.equal(recipe.holdout.data.maxGapShare, 0.02);
  assert.match(recipe.models.p2Threshold, /ranking model's own/);
  assert.ok(recipe.engine.files.includes('src/signal-engine.js') && recipe.engine.files.includes('desk/features.mjs') && /^[0-9a-f]{64}$/.test(recipe.engine.hash));
  const again = (o = {}) => recipeHashOf(buildRecipe({ pair: 'BTCUSD', tf: 'M15', cfg, dataset: trainDataset, ...o }));
  assert.equal(again(), recipeHashOf(recipe), 'rebuilt from the same code, the same hash');
  assert.notEqual(again({ cfg: { ...cfg, broker: { ...cfg.broker, serverOffset: 2 } } }), recipeHashOf(recipe));
  assert.notEqual(again({ dataset: { ...trainDataset, sha256: '1'.repeat(64) } }), recipeHashOf(recipe));
});
test('loading rows drops every held-back row unread, and refuses another features version, a mixed file, a damaged idea or a repeated check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-'));
  try {
    const path = join(dir, 'rows.jsonl');
    const some = data.rows.slice(0, 30);
    const late = { ...some[0], closeMs: Date.parse('2025-03-03T10:00Z'), day: '2025-03-03', fv: 999, pair: 'XAUUSD' };   // would fail every check if read
    writeFileSync(path, [...some, late].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const got = await loadRows(path, { pair: 'BTCUSD' });
    assert.equal(got.rows.length, 30);
    assert.equal(got.heldBack, 1);
    assert.deepEqual(got.settings, { cost: 'scaled', calendar: 'rules', tf: 'M15' });
    writeFileSync(path, JSON.stringify({ ...some[0], fv: FEATURES_VERSION + 1 }) + '\n');
    await assert.rejects(loadRows(path, { pair: 'BTCUSD' }), /features version/);
    writeFileSync(path, [some[0], { ...some[1], calendar: 'full' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await assert.rejects(loadRows(path, { pair: 'BTCUSD' }), /mix calendar/);
    const idea = some.find((r) => r.kind === 'idea');
    writeFileSync(path, JSON.stringify({ ...idea, a: null }) + '\n');
    await assert.rejects(loadRows(path, { pair: 'BTCUSD' }), /idea without its label \(a\)/);
    assert.throws(() => readsFromRows([compactRow({ ...idea, a: null })], data.bars), /idea without its label/);
    writeFileSync(path, [some[0], some[1], { ...some[2], closeMs: some[1].closeMs, t: some[1].t }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await assert.rejects(loadRows(path, { pair: 'BTCUSD' }), /repeats the check/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rows are tied to the code that made them: no manifest, another sha256, a stale rowsKey or a short file are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-'));
  try {
    const some = data.rows.slice(0, 40);
    const { path, manifest } = await writeRows(dir, some);
    const ok = await loadDataset(path, { pair: 'BTCUSD', cfg });
    assert.equal(ok.rows.length, 40);
    assert.equal(ok.manifest.rowsKey, manifest.rowsKey);
    assert.equal(manifestRecord(ok.manifest).builtAt, undefined, 'the recipe keeps the manifest without its build time');
    // Edited after the build: the sha256 no longer matches.
    writeFileSync(path, some.slice(0, 39).map((r) => JSON.stringify(r)).join('\n') + '\n');
    await assert.rejects(loadDataset(path, { pair: 'BTCUSD', cfg }), /sha256 differs/);
    // Made by older code: the rowsKey today's code gives is another.
    const stale = await writeRows(dir, some, { name: 'stale.jsonl', rowsKey: '0000000000000000' });
    await assert.rejects(loadDataset(stale.path, { pair: 'BTCUSD', cfg }), /made by different code or settings/);
    // Another config makes other rows too.
    const fresh = await writeRows(dir, some, { name: 'fresh.jsonl' });
    await assert.rejects(loadDataset(fresh.path, { pair: 'BTCUSD', cfg: { ...cfg, window: { ...cfg.window, start: { h: 9, m: 0 } } } }), /different code or settings/);
    // No manifest at all.
    rmSync(manifestPath(fresh.path));
    await assert.rejects(loadDataset(fresh.path, { pair: 'BTCUSD', cfg }), /have no manifest/);
    // A manifest that counts other rows than the file holds (with a matching hash).
    const n = await writeRows(dir, some, { name: 'count.jsonl' });
    writeFileSync(manifestPath(n.path), JSON.stringify({ ...n.manifest, rows: 41 }));
    await assert.rejects(loadDataset(n.path, { pair: 'BTCUSD', cfg }), /its manifest says 41/);
    // The default path is exactly dataset.mjs's rowsPath for the recipe's settings.
    assert.equal(defaultRowsPath(dir, { pair: 'BTCUSD', cfg }), rowsPath(dir, { pair: 'BTCUSD', cfg, cost: 'scaled', calendar: 'rules', source: 'binance' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('fit refuses rows that are not the recipe\'s dataset (another cost, calendar or bar source, held-back rows) and any model file but desk/model.json', async () => {
  const s = scratch({}, { commit: false });
  try {
    const base = { cfg, pair: 'BTCUSD', tf: 'M15', modelPath: s.path, home: s.home, bars: data.bars, ...T };
    const m = (settings, extra = {}) => ({ ...baseManifest, settings: { ...trainSettings, ...settings }, rowsKey: 'k', ...extra });
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'fixed', calendar: 'rules' }, manifest: m({ cost: 'fixed' }) }), /cost "scaled"/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'full' }, manifest: m({ calendar: 'full' }) }), /calendar "rules"/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'rules' }, manifest: m({}, { toMs: Date.parse('2026-10-14T20:45Z') }) }), /held-back years/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'rules' }, manifest: null }), /manifest/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'rules' }, manifest: m({}, { source: null }) }), /binance's bars; these were made from bars handed in/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'rules' }, manifest: m({}, { source: 'file:/tmp/bars.json' }) }), /"file:\/tmp\/bars\.json"/);
    assert.throws(() => fitAll(data.compact, { ...base, settings: { cost: 'scaled', calendar: 'rules' }, manifest: m({}, { holdout: true }) }), /built with --holdout/);
    assert.throws(() => fitAll(data.compact, { ...base, anyModelPath: false, settings: { cost: 'scaled', calendar: 'rules' }, manifest: m({}) }), /work only on .*desk\/model\.json/);
    assert.deepEqual(readModel(s.path), {}, 'nothing written');
  } finally { s.done(); }
});
test('fit end to end: rows with a manifest in, a recipe that records the manifest, both thresholds, and a guard that opens once committed', async () => {
  const d = synth({ from: '2018-01-02', to: '2024-12-31', every: 6, seed: 9 });
  const s = scratch({ looks: [{ at: 'kept' }] }, { commit: false });
  try {
    const { path } = await writeRows(s.dir, d.rows, { name: 'train.jsonl' });
    const ds = await loadDataset(path, { pair: 'BTCUSD', cfg });
    const { model } = fitAll(ds.rows, { bars: d.bars, cfg, pair: 'BTCUSD', tf: 'M15', settings: ds.settings, manifest: ds.manifest, modelPath: s.path, home: s.home, ...T, userHome: s.userHome });
    assert.deepEqual(model.recipe.dataset, manifestRecord(ds.manifest));
    assert.ok(Number.isFinite(model.model.filter.threshold) && Number.isFinite(model.model.ranking.threshold) && model.model.ranking.p2Share > 0);
    assert.deepEqual(readModel(s.path).looks, [{ at: 'kept' }], 'other keys are kept');
    assert.equal(guardOf(s).code, 'not-committed');
    git(s.dir, 'add', 'model.json'); git(s.dir, 'commit', '-q', '-m', 'recipe');
    assert.equal(guardOf(s).ok, true, 'the recipe rebuilds from today\'s code, config and rows key');
  } finally { s.done(); }
});
test('P2 has its own threshold on the ranking model\'s scale, offered about as many checks as the kept filter (the rule the lead confirmed)', () => {
  const train = trainRowsFor(data.compact, 2024);
  const fit = fitModels(train, [1]).ranking.fits[1];
  const comm = 0;
  const { threshold, share } = p2ThresholdFor(fit, train, 0.6, comm);
  const open = train.filter((r) => ['none', 'idea', 'rejected'].includes(r.kind));
  assert.ok(Math.abs(share - (open.filter((r) => r.alerted).length / open.length) * 0.6) < 1e-12);
  const best = open.filter((r) => r.b).map((r) => Math.max(predict(fit, r.vL), predict(fit, r.vS)) - 6 / 100);
  const above = best.filter((p) => p >= threshold).length / best.length;
  assert.ok(Math.abs(above - share) < 0.01, `${above} vs ${share}`);
});
test('the filter trains on every engine lean with label (a), signed by its side', () => {
  const { X, y } = filterData(data.compact);
  const leans = data.compact.filter((r) => (r.kind === 'idea' || r.kind === 'rejected') && r.a);
  assert.equal(X.length, leans.length);
  assert.ok(leans.some((r) => r.kind === 'rejected') && !data.compact.some((r) => r.kind === 'blocked' && r.a));
  leans.forEach((r, i) => { assert.equal(X[i], r.a.side === 'buy' ? r.vL : r.vS); assert.equal(y[i], r.a.gross.r); });
});

console.log('\nholes ahead, logs, model file, shallow clones');
test('a check with a hole ahead is left out of the unfiltered and the filtered alert passes alike, and out of training', () => {
  const ideas2024 = data.compact.filter((r) => r.day.startsWith('2024') && r.kind === 'idea' && r.alerted);
  const gap = ideas2024[3];
  const rows = data.compact.map((r) => (r === gap ? { ...r, gapAhead: true, a: { ...r.a, gross: null, net: null } } : r));
  assert.equal(compactRow({ ...data.rows[0], gapAhead: true }).gapAhead, true, 'compactRow carries the flag');
  assert.equal(compactRow(data.rows[0]).gapAhead, false);
  assert.equal(filterData(rows).X.length, filterData(data.compact).X.length - 1, 'training ignores a row with no scored label (a)');
  const wf3 = walkForward(rows, { bars: data.bars, cfg, pair: 'BTCUSD', years: [2024] });
  const y = wf3.perYear[0];
  const reads = readsFromRows(rows.filter((r) => r.day.startsWith('2024')), data.bars);
  const without = alertPass(reads, data.bars, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half', predicate: (rd) => rd.closeMs !== gap.closeMs }).trades;
  assert.equal(y.unfiltered.n, without.length, 'the unfiltered pass leaves the gap-ahead idea out');
  assert.ok(Math.abs(y.unfiltered.mean - summary(without).mean) < 1e-12);
  assert.equal(y.gapAheadLeftOut, 1);
  assert.equal(y.alertedMismatch, 0, 'the rows\' alerted flags are still checked against the plain pass');
});

test('a final is recorded in three logs: $SCALP_DESK_HOME\'s, ~/.scalp-desk\'s and the git common directory\'s; a fresh home is still refused', async () => {
  const s = scratch();
  try {
    const logs = finalsLogPaths({ home: s.home, modelPath: s.path, userHome: s.userHome });
    assert.equal(logs.length, 3);
    assert.equal(logs[0], finalsLogPath(s.home));
    assert.equal(logs[1], join(s.userHome, '.scalp-desk', 'learn', 'finals.log'));
    assert.match(logs[2], new RegExp(`\\.git/${GIT_FINALS_LOG}$`));
    const other = mkdtempSync(join(tmpdir(), 'learn-other-user-'));
    const opts = (home, userHome) => finalOpts(s, { home, userHome });
    await armFinal(finalOpts(s));
    git(s.dir, 'commit', '-q', '-am', 'armed');
    const res = await runFinal(finalOpts(s));
    assert.equal(res.refused, false);
    for (const p of logs) assert.deepEqual(readLogFile(p).map((e) => e.kind), ['started', 'ran'], p);
    // The working copy put back, another $SCALP_DESK_HOME and another ~: the git common directory's log still refuses.
    git(s.dir, 'checkout', '--', 'model.json');
    const g = guardOf(s, undefined, { home: join(s.dir, 'fresh-home'), userHome: other });
    assert.equal(g.code, 'already-run');
    assert.ok(g.reason.includes(GIT_FINALS_LOG), g.reason);
    assert.equal((await runFinal(opts(join(s.dir, 'fresh-home'), other))).code, 'already-run');
    // And the default desk home's log alone refuses too.
    const t = scratch();
    try {
      assert.equal(guardOf(t).ok, true, 'another repository, another home, another ~: unused');
      const g2 = guardOf(t, undefined, { userHome: s.userHome });
      assert.equal(g2.code, 'already-run', 'the same ~ as the run: its default desk home\'s log refuses');
      assert.ok(g2.reason.includes(join(s.userHome, '.scalp-desk')), g2.reason);
    } finally { t.done(); }
  } finally { s.done(); }
});

test('the default desk home\'s log follows the account\'s home, not $HOME; a final also locks the git common directory', async () => {
  const { userInfo } = await import('node:os');
  const { finalLockPaths, GIT_FINAL_LOCK, accountHome } = await import('../desk/learn.mjs');
  assert.notEqual(process.env.HOME, userInfo().homedir, 'this suite moved $HOME to a scratch folder');
  assert.equal(accountHome(), userInfo().homedir);
  const s = scratch();
  try {
    const logs = finalsLogPaths({ home: s.home, modelPath: s.path });
    assert.equal(logs[1], join(userInfo().homedir, '.scalp-desk', 'learn', 'finals.log'), 'not under $HOME');
    const locks = finalLockPaths({ home: s.home, modelPath: s.path });
    assert.equal(locks.length, 2);
    assert.match(locks[1], new RegExp(`\\.git/${GIT_FINAL_LOCK}$`));
    await armFinal(finalOpts(s));
    git(s.dir, 'commit', '-q', '-am', 'armed');
    // Another final under ANOTHER home holds the repository's lock: refused, and nothing of ours is left behind.
    writeFileSync(locks[1], 'x');
    const r = await runFinal(finalOpts(s, { home: join(s.dir, 'other-home') }));
    assert.equal(r.code, 'locked');
    assert.ok(r.reason.includes(GIT_FINAL_LOCK), r.reason);
    assert.ok(!existsSync(join(s.dir, 'other-home', 'learn', 'final.lock')), 'the home lock taken first is released');
    rmSync(locks[1]);
    assert.equal((await runFinal(finalOpts(s))).refused, false);
    for (const p of locks) assert.ok(!existsSync(p), `released: ${p}`);
  } finally { s.done(); }
});

test('fit and final work only on <project>/desk/model.json without the test-only option', async () => {
  assert.equal(MODEL_PATH, join(fileURLToPath(new URL('..', import.meta.url)), 'desk', 'model.json'));
  assert.equal(modelPathRefusal(MODEL_PATH), null);
  assert.match(modelPathRefusal(join(dirname(MODEL_PATH), 'model-b.json')), /work only on/, 'a copy beside it under another name');
  assert.equal(modelPathRefusal('/tmp/x/model.json', { anyModelPath: true }), null);
  const s = scratch();
  try {
    assert.equal((await armFinal(finalOpts(s, { anyModelPath: false }))).code, 'model-path');
    assert.equal((await runFinal(finalOpts(s, { anyModelPath: false }))).code, 'model-path');
    // The command line: SCALP_DESK_MODEL elsewhere is refused for fit and final; --test-model names another file.
    const LEARN = fileURLToPath(new URL('../desk/learn.mjs', import.meta.url));
    const env = { ...process.env, SCALP_DESK_HOME: s.home, SCALP_DESK_MODEL: s.path };
    const cli = (args) => { try { execFileSync('node', [LEARN, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }); return 'ran'; } catch (e) { return `EXIT ${e.status}\n${e.stdout}`; } };
    const rows = ['--rows', join(s.dir, 'none.jsonl')];
    assert.match(cli(['fit', '--pair', 'bitcoin', ...rows]), /^EXIT 2\nfit and final work only on .*desk\/model\.json/);
    assert.match(cli(['final', '--pair', 'bitcoin']), /^EXIT 2\nfit and final work only on/);
    assert.match(cli(['fit', '--pair', 'bitcoin', ...rows, '--test-model', s.path]), /^EXIT 2\nNo rows at/, 'with --test-model it goes on (to the missing rows)');
    assert.match(cli(['fit', '--pair', 'bitcoin', '--test-model']), /^EXIT 2\n--test-model needs a file/);
    // A final never takes another model file on the command line (review, 17 Oct: a fresh clone ran a second final that way).
    assert.match(cli(['final', '--pair', 'bitcoin', '--test-model', s.path]), /^EXIT 2\n--test-model is for scratch fits only/);
    assert.match(cli(['final', '--run', '--pair', 'bitcoin', '--test-model', s.path]), /^EXIT 2\n--test-model is for scratch fits only/);
  } finally { s.done(); }
});

test('fit and final refuse in a shallow clone and say to unshallow it', () => {
  const src = mkdtempSync(join(tmpdir(), 'learn-src-'));
  const dst = join(mkdtempSync(join(tmpdir(), 'learn-shallow-')), 'clone');
  try {
    git(src, 'init', '-q');
    writeModel(join(src, 'model.json'), fitted);
    git(src, 'add', 'model.json'); git(src, 'commit', '-q', '-m', 'one');
    recordFinal(join(src, 'model.json'), { kind: 'ran', at: 'x', pair: 'BTCUSD', window: W });
    git(src, 'commit', '-q', '-am', 'two: a final on record');
    writeModel(join(src, 'model.json'), fitted);
    git(src, 'commit', '-q', '-am', 'three: erased');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src}`, dst], { stdio: 'pipe' });
    const path = join(dst, 'model.json');
    assert.equal(isShallowRepo(path), true);
    assert.equal(isShallowRepo(join(src, 'model.json')), false);
    const g = finalGuard(readModel(path), { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: path, home: join(dst, 'home'), codeCheck: okCode, ...T });
    assert.equal(g.code, 'shallow');
    assert.match(g.reason, /git fetch --unshallow/);
    assert.throws(() => fitAll([], { cfg, pair: 'BTCUSD', tf: 'M15', settings: {}, manifest: null, modelPath: path, home: join(dst, 'home'), ...T }), /git fetch --unshallow/);
    // Unshallowed, the final recorded two commits back is found.
    execFileSync('git', ['-C', dst, 'fetch', '-q', '--unshallow'], { stdio: 'pipe' });
    assert.equal(finalGuard(readModel(path), { pair: 'BTCUSD', tf: 'M15', cfg, modelPath: path, home: join(dst, 'home'), codeCheck: okCode, ...T }).code, 'already-run');
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dirname(dst), { recursive: true, force: true }); }
});

for (const p of pending) await p();
rmSync(USER_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
