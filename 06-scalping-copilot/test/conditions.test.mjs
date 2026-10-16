/**
 * The by-condition table (desk/conditions.mjs). Trades are synthetic, made by
 * a seeded generator so every run sees the same numbers: a planted effect in
 * one cell must be found, pure noise must find nothing, and the warnings must
 * say what the table can and cannot show. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import {
  CELLS, BUCKETS, HOLDOUT, PERIODS, byCondition, formatConditions, bonferroniZ, tQuantile,
  headerWarning, periodOf, splitByPeriod, validateCond,
} from '../desk/conditions.mjs';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  };
  pending.push(run);
};

// mulberry32: small, seeded, good enough to stand in for noise.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (u) => () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
const pick = (u, xs) => xs[Math.floor(u() * xs.length)];

/** A random condition in conditionOf()'s exact shape, each part drawn independently. */
function randomCond(u) {
  const sgn = () => pick(u, [-1, 0, 1]);
  const h1 = sgn(), h4 = sgn();
  return {
    regime: pick(u, ['trending', 'ranging', 'mixed', 'compressed']),
    confidenceLabel: pick(u, ['low', 'moderate', 'firm']),
    h1, h4, agree: h1 === h4 && h1 !== 0,
    buckets: { trend: sgn(), momentum: sgn(), structure: sgn(), location: sgn(), volume: pick(u, [-1, 0, 1, null]) },
    hourBand: pick(u, ['08-10', '10-12', '12-14', '14-16']),
    weekday: pick(u, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
    side: pick(u, ['buy', 'sell']),
  };
}
const FIXED = Object.freeze({
  regime: 'trending', confidenceLabel: 'firm', h1: 1, h4: 1, agree: true,
  buckets: { trend: 1, momentum: 1, structure: 0, location: -1, volume: null },
  hourBand: '08-10', weekday: 'Mon', side: 'buy',
});
const fixedCond = (over = {}) => ({ ...FIXED, buckets: { ...FIXED.buckets }, ...over });

/** Weekdays from `start`, `days` of them, `perDay` trades each, hours 08–15 UTC. */
function makeTrades({ seed, days = 400, perDay = 3, r, start = Date.UTC(2019, 0, 1), cond = randomCond }) {
  const u = rng(seed), g = gauss(u);
  const out = [];
  let d = start, made = 0;
  while (made < days) {
    const wd = new Date(d).getUTCDay();
    if (wd >= 1 && wd <= 5) {
      const dayShock = g();
      for (let i = 0; i < perDay; i++) {
        const c = cond(u);
        const at = new Date(d + (8 + i % 8) * 3600000).toISOString().slice(0, 16);
        out.push({ at, cond: c, r: r(c, g, dayShock) });
      }
      made++;
    }
    d += 86400000;
  }
  return out;
}

const ADVICE = /\b(avoid|only trade|best|worst|should|recommend|won|lost|profit|edge here)\b|£/i;
const EXCLUSIVE = ['Regime', 'Confidence', 'Higher timeframes', 'Hour (London)', 'Weekday', 'Side'];

test('there are 30 cells, no volatility, each with a unique id, and the result counts every one of them', () => {
  assert.equal(CELLS.length, 30);
  assert.equal(new Set(CELLS.map((c) => c.id)).size, 30);
  assert.ok(!CELLS.some((c) => /volatility/i.test(c.id + c.label)));
  const groups = {};
  for (const c of CELLS) groups[c.group] = (groups[c.group] || 0) + 1;
  assert.deepEqual(groups, { Regime: 4, Confidence: 3, 'Higher timeframes': 2, Buckets: 10, 'Hour (London)': 4, Weekday: 5, Side: 2 });
  assert.deepEqual([...BUCKETS], ['trend', 'momentum', 'structure', 'location', 'volume']);
  const res = byCondition(makeTrades({ seed: 1, days: 50, r: (c, g) => g() }));
  assert.equal(res.cells, 30);
  assert.equal(res.rows.length, 30);
  assert.deepEqual(res.rows.map((r) => r.cell), CELLS.map((c) => c.id));
  assert.equal(res.expectedByChance, 30 * 0.05);
});

test('the Bonferroni z is 1.96 for one cell and 3.14 for 30; the t quantiles match the tables', () => {
  assert.ok(Math.abs(bonferroniZ(1) - 1.959964) < 1e-5);
  assert.ok(Math.abs(bonferroniZ(30) - 3.1440) < 5e-4, String(bonferroniZ(30)));
  assert.equal(byCondition([]).z, bonferroniZ(CELLS.length));
  assert.equal(byCondition([]).alpha, 0.05);
  // Published values: t(0.975, 9) 2.262157, t(0.995, 29) 2.756386, t(0.9995, 9) 4.780913, t(0.975, 1) 12.7062.
  assert.ok(Math.abs(tQuantile(0.025, 9) - 2.262157) < 1e-5);
  assert.ok(Math.abs(tQuantile(0.005, 29) - 2.756386) < 1e-5);
  assert.ok(Math.abs(tQuantile(0.0005, 9) - 4.780913) < 1e-5);
  assert.ok(Math.abs(tQuantile(0.025, 1) - 12.7062) < 1e-3);
  assert.ok(Math.abs(tQuantile(0.025, 1e7) - 1.959964) < 1e-5);
});

test('a planted effect in one cell clears zero; nothing else does', () => {
  // Tuesdays +0.5R, the other four weekdays −0.125R, so the overall average is
  // zero and cells outside the weekday group carry no effect at all. The other
  // weekdays do carry a real −0.125R, so on some seeds one of them clears too —
  // rightly; what must never clear is a cell outside the weekday group. This
  // seed is one where only Tuesday does (any seed fails that 1 time in 20).
  const trades = makeTrades({ seed: 14, days: 600, perDay: 3, r: (c, g) => g() + (c.weekday === 'Tue' ? 0.5 : -0.125) });
  const res = byCondition(trades);
  const tue = res.rows.find((r) => r.cell === 'weekday:Tue');
  assert.equal(tue.clearsZero, true);
  assert.ok(tue.lo > 0 && tue.mean > 0.35);
  assert.deepEqual(res.rows.filter((r) => r.clearsZero && r.group !== 'Weekday').map((r) => r.cell), []);
  assert.deepEqual(res.rows.filter((r) => r.clearsZero).map((r) => r.cell), ['weekday:Tue']);
  assert.equal(res.found, 1);
  assert.match(formatConditions(res), /^ {2}Tuesday .* clears zero, above$/m);
});

test('pure noise: no cell clears with all 30 counted, while about 1.5 a run clear the ordinary 95%', () => {
  let found = 0, at95 = 0;
  const runs = 20;
  for (let s = 100; s < 100 + runs; s++) {
    const res = byCondition(makeTrades({ seed: s, days: 300, perDay: 3, r: (c, g) => g() }));
    found += res.found; at95 += res.foundAt95;
    if (s === 100) assert.equal(res.found, 0);
  }
  // Family-wise 5% a run, so a handful at most over twenty runs.
  assert.ok(found <= 3, `found ${found} over ${runs} noise runs`);
  const avg = at95 / runs;
  assert.ok(avg > 0.6 && avg < 2.7, `average at 95%: ${avg}`);
});

test('a small cell is held to its own level: noise on 10 days clears no more often than declared', () => {
  // Thirty trades on ten days, three a day, independent normal noise. With
  // alpha 1 each cell is tested at 1/30 two-sided, so the cell holding every
  // trade should clear zero in about 3.3% of runs. The plain normal z with no
  // G/(G−1) factor clears about 5.2% — the overconfidence the review measured.
  let hits = 0;
  const runs = 6000;
  const u = rng(4242), g = gauss(u);
  const cond = fixedCond();
  for (let k = 0; k < runs; k++) {
    const trades = [];
    for (let d = 0; d < 10; d++) for (let i = 0; i < 3; i++) trades.push({ at: `2020-02-${String(3 + d).padStart(2, '0')}T${String(8 + i).padStart(2, '0')}:00`, r: g(), cond });
    if (byCondition(trades, { alpha: 1 }).rows[0].clearsZero) hits++;
  }
  const rate = hits / runs;
  assert.ok(rate > 0.026 && rate < 0.041, `rate ${rate} (declared 0.0333)`);
});

test('below 30 trades, or on too few days, a cell is too few to say: no average, never marked', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    at: `2020-03-${String(1 + i % 28).padStart(2, '0')}T09:00`,
    r: 1.5 + (i % 3) * 0.1,
    cond: fixedCond(),
  }));
  const at29 = byCondition(mk(29)).rows.find((r) => r.cell === 'regime:trending');
  assert.equal(at29.n, 29);
  assert.equal(at29.tooFew, true);
  assert.equal(at29.why, 'trades');
  assert.equal(at29.mean, null);
  assert.equal(at29.clearsZero, false);
  const at30 = byCondition(mk(30)).rows.find((r) => r.cell === 'regime:trending');
  assert.equal(at30.tooFew, false);
  assert.ok(Math.abs(at30.mean - 1.6) < 1e-9);
  // Thirty trades on too few days are too few observations as well.
  const oneDay = mk(40).map((t) => ({ ...t, at: '2020-03-02T09:00' }));
  assert.equal(byCondition(oneDay).rows.find((r) => r.cell === 'regime:trending').why, 'days');
  assert.match(formatConditions(byCondition(mk(29))), /^ {2}Trending +29 +28 +— +too few to say$/m);
});

test('identical results have no range, so they are never marked', () => {
  const same = Array.from({ length: 40 }, (_, i) => ({ at: `2020-03-${String(1 + i % 28).padStart(2, '0')}T09:00`, r: 1.5, cond: fixedCond() }));
  const row = byCondition(same).rows.find((r) => r.cell === 'regime:trending');
  assert.equal(row.tooFew, true);
  assert.equal(row.why, 'spread');
  assert.equal(row.clearsZero, false);
  assert.match(formatConditions(byCondition(same)), /^ {2}Trending +40 +28 +— +every result the same, no range$/m);
});

test('ranges clustered by day are wider than independent ones when same-day trades move together', () => {
  // Six trades a day sharing most of their result: the day's market.
  const together = makeTrades({ seed: 3, days: 200, perDay: 6, r: (c, g, day) => 0.9 * day + 0.3 * g() });
  const apart = makeTrades({ seed: 3, days: 200, perDay: 6, r: (c, g) => g() });
  const width = (res, id) => { const r = res.rows.find((x) => x.cell === id); return r.hi - r.lo; };
  const ratioTogether = width(byCondition(together), 'side:buy') / width(byCondition(together, { cluster: 'none' }), 'side:buy');
  const ratioApart = width(byCondition(apart), 'side:buy') / width(byCondition(apart, { cluster: 'none' }), 'side:buy');
  assert.ok(ratioTogether > 1.4, `together: ${ratioTogether}`);
  assert.ok(ratioApart > 0.8 && ratioApart < 1.25, `apart: ${ratioApart}`);
  const indep = byCondition(together, { cluster: 'none' }), clus = byCondition(together);
  assert.ok(indep.found + indep.foundAt95 >= clus.found + clus.foundAt95);
  assert.match(formatConditions(indep), /NOT HERE: this run treats every trade as independent/);
});

test('the report opens with the chance warning, word for word, and no line reads as advice', () => {
  const res = byCondition(makeTrades({ seed: 14, days: 600, perDay: 3, r: (c, g) => g() + (c.weekday === 'Tue' ? 0.5 : -0.125) }));
  const text = formatConditions(res, { title: 'Bitcoin M15, by condition' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Bitcoin M15, by condition');
  assert.equal(lines[1], 'Developer report — about 1 to 2 of these cells will clear zero by chance at 95%; a cell is only marked when it clears zero with all 30 cells counted (z = 3.14 on many days, wider on few). None of these is a rule to trade by.');
  assert.equal(headerWarning(res), lines[1]);
  for (const l of lines) assert.doesNotMatch(l, ADVICE, l);
  for (const c of CELLS) assert.doesNotMatch(c.label, ADVICE, c.label);
  assert.match(text, /Cleared zero with all 30 cells counted: 1 of 30\. On a system with no edge at all, the chance of even one is at most about 1 in 20/);
  assert.match(text, /against 1\.5 expected by chance alone/);
  assert.match(text, /^Higher timeframes \(H1 and H4\)$/m);
  // Every cell has its line, in order, under its group.
  let at = 0;
  for (const c of CELLS) { const i = lines.findIndex((l, k) => k > at && l.startsWith('  ' + c.label + ' ')); assert.ok(i > at, c.label); at = i; }
});

test('the family chance is computed, not fixed text: other alphas say so, independent ranges disown it', () => {
  const trades = makeTrades({ seed: 9, days: 200, r: (c, g) => g() });
  assert.match(formatConditions(byCondition(trades, { alpha: 0.5 })), /chance of even one is at most about 1 in 2 /);
  assert.match(formatConditions(byCondition(trades, { alpha: 0.01 })), /at most about 1 in 100 /);
  const none = formatConditions(byCondition(trades, { cluster: 'none' }));
  assert.doesNotMatch(none, /1 in 20/);
  assert.match(none, /The chance of a false mark is not known here: these ranges ignore same-day overlap\./);
  // A looser alpha really does loosen each cell: the multiplier is smaller.
  const crit = (a) => byCondition(trades, { alpha: a }).rows.find((r) => r.cell === 'side:buy').crit;
  assert.ok(crit(0.5) < crit(0.05));
});

test('the whole sample is printed as a baseline, and says so when it alone explains the cells', () => {
  const flat = byCondition(makeTrades({ seed: 11, days: 300, r: (c, g) => g() }));
  assert.equal(flat.all.n, flat.trades);
  assert.equal(flat.all.clearsZero, false);
  assert.match(formatConditions(flat), /^ {2}All trades +900 +300 +[+−]0\.\d\d +[+−]0\.\d\d to [+−]0\.\d\d$/m);
  assert.doesNotMatch(formatConditions(flat), /All trades together/);
  const lifted = byCondition(makeTrades({ seed: 11, days: 300, r: (c, g) => g() + 0.3 }));
  assert.equal(lifted.all.clearsZero, true);
  assert.ok(lifted.found > 10);
  const text = formatConditions(lifted);
  assert.match(text, /All trades together clear zero above as well, so a cell clearing zero here mostly repeats the whole sample's average; it says little about the cell itself\./);
  assert.doesNotMatch(text.split('\n').find((l) => l.startsWith('  All trades')), /clears zero/);
});

test('development years carry their period line and the missing-calendar caveat', () => {
  const res = byCondition(makeTrades({ seed: 2, days: 60, r: (c, g) => g() }));
  assert.equal(res.period, 'dev');
  const text = formatConditions(res);
  assert.match(text, /^Development years, before 2025\.$/m);
  assert.match(text, /Before 2025 there is no news calendar, so these years include trades around releases that the live desk would have sat out\./);
  assert.doesNotMatch(formatConditions(res, { multiYear: false }), /Before 2025/);
});

test('periods follow the fixed holdout to the minute', () => {
  assert.deepEqual(HOLDOUT, { from: '2025-01-01T00:00Z', seenFrom: '2026-01-01T00:00Z', to: '2026-10-14T20:45Z' });
  assert.equal(periodOf('2024-12-31T23:59'), 'dev');
  assert.equal(periodOf('2025-01-01T00:00'), 'clean');
  assert.equal(periodOf('2025-12-31T23:45Z'), 'clean');
  assert.equal(periodOf('2026-01-01T00:00'), 'seen');
  assert.equal(periodOf('2026-10-14T20:45'), 'seen');
  assert.equal(periodOf('2026-10-14T20:46'), 'fresh');
  assert.equal(periodOf('2026-11-02T09:00'), 'fresh');
  const t = (at) => ({ at, r: 0.1, cond: fixedCond() });
  const split = splitByPeriod([t('2023-05-01T09:00'), t('2025-05-01T09:00'), t('2026-05-01T09:00'), t('2026-10-20T09:00'), null]);
  assert.deepEqual(Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v.length])), { dev: 1, clean: 1, seen: 1, fresh: 1 });
});

test('held-back rows need permission, are never pooled, and say which period they are', () => {
  const at = (y) => makeTrades({ seed: y, days: 200, r: (c, g) => g(), start: Date.UTC(y, 0, 1) });
  const y23 = at(2023), y25 = at(2025), y26 = at(2026).filter((x) => periodOf(x.at) === 'seen');
  assert.throws(() => byCondition(y25), /held-back window/);
  assert.throws(() => byCondition(y26), /held-back window/);
  // Pooling is refused even with permission: rule 2 reports them separately.
  assert.throws(() => byCondition([...y23, ...y25, ...y26], { allowHeldBack: true }), /span dev and clean and seen.*rule 2/);
  assert.throws(() => byCondition([...y25, ...y26], { allowHeldBack: true }), /span clean and seen/);
  const clean = byCondition(y25, { allowHeldBack: true });
  assert.equal(clean.period, 'clean');
  assert.match(formatConditions(clean), /^2025: held back, not used to build anything\.$/m);
  assert.doesNotMatch(formatConditions(clean), /Before 2025/);
  const seen = byCondition(y26, { allowHeldBack: true });
  assert.equal(seen.period, 'seen');
  assert.match(formatConditions(seen), /^2026 to 14 October: already used to choose the 1\.5R rule; this is not unseen data\.$/m);
  // Rows after the window are not held back: no permission needed.
  const fresh = byCondition([{ at: '2026-11-02T09:00', r: 0.4, cond: fixedCond() }]);
  assert.equal(fresh.period, 'fresh');
  assert.match(formatConditions(fresh), new RegExp(PERIODS.fresh.replace(/[.]/g, '\\.')));
});

test('a cond outside the contract stops the table instead of quietly emptying a cell', () => {
  const t = (over) => [{ at: '2021-03-01T09:00', r: 0.2, cond: fixedCond(over) }];
  assert.throws(() => byCondition(t({ confidenceLabel: 'high' })), /confidenceLabel is 'high'/);
  assert.throws(() => byCondition(t({ regime: 'sideways' })), /regime is 'sideways'/);
  assert.throws(() => byCondition(t({ agree: null })), /agree is null/);
  assert.throws(() => byCondition(t({ side: 'long' })), /side is 'long'/);
  assert.throws(() => byCondition(t({ hourBand: '16-18' })), /hourBand/);
  assert.throws(() => byCondition(t({ weekday: 'Sat' })), /weekday/);
  assert.throws(() => byCondition(t({ h1: 'up' })), /h1/);
  assert.throws(() => byCondition(t({ buckets: { ...FIXED.buckets, volatility: 1 } })), /buckets key is 'volatility'/);
  assert.throws(() => byCondition(t({ buckets: { ...FIXED.buckets, trend: 0.4 } })), /buckets\.trend is 0\.4/);
  const noVolume = { ...FIXED.buckets }; delete noVolume.volume;
  assert.throws(() => byCondition(t({ buckets: noVolume })), /buckets\.volume is undefined/);
  assert.doesNotThrow(() => validateCond(fixedCond({ hourBand: null, weekday: null })));
});

test('every exclusive group adds up to the total, and trades in no cell are printed, not hidden', () => {
  const trades = makeTrades({ seed: 5, days: 120, r: (c, g) => g(), cond: (uu) => {
    const c = randomCond(uu);
    if (uu() < 0.1) c.hourBand = null;
    if (uu() < 0.05) c.weekday = null;
    return c;
  } });
  const res = byCondition(trades);
  for (const g of EXCLUSIVE) {
    const sum = res.rows.filter((r) => r.group === g).reduce((s, r) => s + r.n, 0);
    assert.equal(sum + res.outside[g], res.trades, g);
  }
  assert.ok(res.outside['Hour (London)'] > 0 && res.outside.Weekday > 0);
  assert.equal(res.outside.Regime, 0);
  for (const b of BUCKETS) {
    const plus = res.rows.find((r) => r.cell === `${b}:+`).n, minus = res.rows.find((r) => r.cell === `${b}:-`).n;
    assert.equal(plus + minus + res.bucketsNeither[b].zero + res.bucketsNeither[b].abstained, res.trades, b);
  }
  const text = formatConditions(res);
  const lines = text.split('\n');
  const hourHead = lines.indexOf('Hour (London)'), dayHead = lines.indexOf('Weekday');
  const noneHour = lines.findIndex((l, k) => k > hourHead && k < dayHead && /^ {2}None of these +\d+ +\(not a cell\)$/.test(l));
  assert.ok(noneHour > hourHead, 'hour group prints its trades in no cell');
  assert.ok(lines[noneHour].includes(String(res.outside['Hour (London)'])));
  assert.match(text, new RegExp(`Neither way \\(not cells\\):.*volume ${res.bucketsNeither.volume.zero} at zero, ${res.bucketsNeither.volume.abstained} abstained`));
});

test('rows with no condition or no result are counted and said, not dropped silently', () => {
  const good = Array.from({ length: 40 }, (_, i) => ({ at: `2021-0${1 + i % 9}-1${i % 10}T10:00`, r: 0.1 * (i % 4), cond: fixedCond() }));
  const res = byCondition([...good, { at: '2021-01-04T10:00', r: 1 }, { at: '2021-01-04T10:00', r: NaN, cond: fixedCond() }, null]);
  assert.equal(res.trades, 40);
  assert.deepEqual(res.skipped, { noCond: 2, noResult: 1 });
  assert.match(formatConditions(res), /40 alerts on \d+ days, .* \(left out: 2 with no condition, 1 with no result yet\)\./);
});

test('a malformed or offset trade time is refused, never read as an old row', () => {
  const t = (at) => [{ at, r: 0.2, cond: fixedCond() }];
  for (const at of [' 2025-01-03T09:00', '1735900000000', '2025', '2024-12-31T23:30-01:00', '2025-02-30T09:00', '2024-12-31 09:00']) {
    assert.throws(() => byCondition(t(at)), /Trade time/, at);
  }
  assert.throws(() => byCondition(t(Date.UTC(2020, 0, 2, 9))), /Trade time/);
  assert.equal(byCondition(t('2024-12-31T09:00:30.5Z')).trades, 1);
});

test('bad inputs and options fail with a clear message', () => {
  assert.throws(() => byCondition(null), /needs an array/);
  assert.throws(() => byCondition([], { minN: 0 }), /minN/);
  assert.throws(() => byCondition([], { minDays: 1 }), /minDays/);
  assert.throws(() => byCondition([], { alpha: 0 }), /alpha/);
  assert.throws(() => byCondition([], { alpha: null }), /alpha/);
  assert.throws(() => byCondition([], { cluster: 'week' }), /cluster/);
  // The smallest legal settings on a cell with no trades do not crash.
  const res = byCondition([{ at: '2020-01-02T09:00', r: 0.3, cond: fixedCond() }, { at: '2020-01-03T09:00', r: -0.1, cond: fixedCond() }], { minN: 2, minDays: 2 });
  assert.equal(res.rows.find((r) => r.cell === 'regime:ranging').tooFew, true);
  assert.equal(res.rows.find((r) => r.cell === 'regime:trending').tooFew, false);
  assert.doesNotThrow(() => formatConditions(res));
});

test('labels follow the timeframe and the unit; the journal gets it only after its sample, on fresh rows', () => {
  const res = byCondition(makeTrades({ seed: 13, days: 60, r: (c, g) => g() }));
  const m5 = formatConditions(res, { htfIds: ['M15', 'H1'], unit: 'checks' });
  assert.match(m5, /^Checks by condition$/m);
  assert.match(m5, /^Higher timeframes \(M15 and H1\)$/m);
  assert.match(m5, /^\d+ checks on \d+ days/m);
  assert.doesNotMatch(m5, /H4/);
  const fresh = byCondition(makeTrades({ seed: 14, days: 40, r: (c, g) => g(), start: Date.UTC(2026, 9, 19) }));
  assert.equal(fresh.period, 'fresh');
  assert.throws(() => formatConditions(fresh, { audience: 'journal' }), /before its committed sample is complete/);
  assert.throws(() => formatConditions(res, { audience: 'journal', sampleComplete: true }), /fresh rows only/);
  const j = formatConditions(fresh, { audience: 'journal', sampleComplete: true });
  assert.doesNotMatch(j, /Developer report|ends the sample in progress/);
  assert.match(j, /^Described, not tested — /m);
  for (const l of j.split('\n')) assert.doesNotMatch(l, ADVICE, l);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
