/**
 * The by-condition table (desk/conditions.mjs). Trades are synthetic, made by
 * a seeded generator so every run sees the same numbers: a planted effect in
 * one cell must be found, pure noise must find nothing, and the warnings must
 * say what the table can and cannot show. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { CELLS, byCondition, formatConditions, bonferroniZ, headerWarning, HOLDOUT_FROM } from '../desk/conditions.mjs';

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

/** A random condition, each part drawn independently. */
function randomCond(u) {
  const sgn = () => pick(u, [-1, 0, 1]);
  const h1 = pick(u, ['up', 'down', 'flat']), h4 = pick(u, ['up', 'down', 'flat']);
  return {
    regime: pick(u, ['trending', 'ranging', 'mixed', 'compressed']),
    confidenceLabel: pick(u, ['low', 'moderate', 'firm']),
    h1, h4, agree: h1 === h4 && h1 !== 'flat',
    buckets: { trend: sgn(), momentum: sgn(), structure: sgn(), location: sgn(), volume: sgn(), volatility: sgn() },
    hourBand: pick(u, ['08-10', '10-12', '12-14', '14-16']),
    weekday: pick(u, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
    side: pick(u, ['buy', 'sell']),
  };
}

/** Weekdays from 2019-01-01, `days` of them, `perDay` trades each, hours 08–15 UTC. */
function makeTrades({ seed, days = 400, perDay = 3, r }) {
  const u = rng(seed), g = gauss(u);
  const out = [];
  let d = Date.UTC(2019, 0, 1), made = 0;
  while (made < days) {
    const wd = new Date(d).getUTCDay();
    if (wd >= 1 && wd <= 5) {
      const dayShock = g();
      for (let i = 0; i < perDay; i++) {
        const cond = randomCond(u);
        const at = new Date(d + (8 + i % 8) * 3600000).toISOString().slice(0, 16);
        out.push({ at, cond, r: r(cond, g, dayShock) });
      }
      made++;
    }
    d += 86400000;
  }
  return out;
}

const ADVICE = /\b(avoid|only trade|best|worst|should|recommend|won|lost|profit|edge here)\b|£/i;

test('there are 32 cells, each with a unique id, and the result counts every one of them', () => {
  assert.equal(CELLS.length, 32);
  assert.equal(new Set(CELLS.map((c) => c.id)).size, 32);
  const groups = {};
  for (const c of CELLS) groups[c.group] = (groups[c.group] || 0) + 1;
  assert.deepEqual(groups, { Regime: 4, Confidence: 3, 'H1 and H4': 2, Buckets: 12, 'Hour (London)': 4, Weekday: 5, Side: 2 });
  const res = byCondition(makeTrades({ seed: 1, days: 50, r: (c, g) => g() }));
  assert.equal(res.cells, 32);
  assert.equal(res.rows.length, 32);
  assert.deepEqual(res.rows.map((r) => r.cell), CELLS.map((c) => c.id));
  assert.equal(res.expectedByChance, 32 * 0.05);
});

test('the Bonferroni z is 1.96 for one cell and 3.16 for all 32, and is the default', () => {
  assert.ok(Math.abs(bonferroniZ(1) - 1.959964) < 1e-5);
  assert.ok(Math.abs(bonferroniZ(32) - 3.163) < 5e-4, String(bonferroniZ(32)));
  assert.equal(byCondition([]).z, bonferroniZ(CELLS.length));
});

test('a planted effect in one cell clears zero; nothing else does', () => {
  // Tuesdays +0.5R, the other four weekdays −0.125R, so the overall average is
  // zero and cells outside the weekday group carry no effect at all.
  const trades = makeTrades({ seed: 7, days: 600, perDay: 3, r: (c, g) => g() + (c.weekday === 'Tue' ? 0.5 : -0.125) });
  const res = byCondition(trades);
  const tue = res.rows.find((r) => r.cell === 'weekday:Tue');
  assert.equal(tue.clearsZero, true);
  assert.ok(tue.lo > 0 && tue.mean > 0.35);
  assert.deepEqual(res.rows.filter((r) => r.clearsZero).map((r) => r.cell), ['weekday:Tue']);
  assert.equal(res.found, 1);
  assert.match(formatConditions(res), /^ {2}Tuesday .* clears zero, above$/m);
});

test('pure noise: no cell clears at z = 3.16, while about 1.6 a run clear the ordinary 95%', () => {
  let found = 0, at95 = 0;
  const runs = 20;
  for (let s = 100; s < 100 + runs; s++) {
    const res = byCondition(makeTrades({ seed: s, days: 300, perDay: 3, r: (c, g) => g() }));
    found += res.found; at95 += res.foundAt95;
    if (s === 100) assert.equal(res.found, 0);
  }
  // Family-wise 5% a run, so a handful at most over twenty runs.
  assert.ok(found <= 3, `found ${found} over ${runs} noise runs`);
  // The header's "about 1 to 2" is what noise actually gives at 95%.
  const avg = at95 / runs;
  assert.ok(avg > 0.7 && avg < 2.8, `average at 95%: ${avg}`);
});

test('below 30 trades a cell is too few to say: no average, never marked, however large the effect', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    at: `2020-03-${String(1 + i % 28).padStart(2, '0')}T09:00`,
    r: 1.5,
    cond: { regime: 'trending', confidenceLabel: 'firm', agree: true, buckets: {}, hourBand: '08-10', weekday: 'Mon', side: 'buy' },
  }));
  const at29 = byCondition(mk(29)).rows.find((r) => r.cell === 'regime:trending');
  assert.equal(at29.n, 29);
  assert.equal(at29.tooFew, true);
  assert.equal(at29.mean, null);
  assert.equal(at29.clearsZero, false);
  const at30 = byCondition(mk(30)).rows.find((r) => r.cell === 'regime:trending');
  assert.equal(at30.tooFew, false);
  assert.equal(at30.mean, 1.5);
  // Thirty trades on too few days are too few observations as well.
  const oneDay = mk(40).map((t) => ({ ...t, at: '2020-03-02T09:00' }));
  assert.equal(byCondition(oneDay).rows.find((r) => r.cell === 'regime:trending').tooFew, true);
  assert.match(formatConditions(byCondition(mk(29))), /^ {2}Trending +29 +28 +— +too few to say$/m);
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
  // And treating them as independent marks cells that clustering does not.
  const indep = byCondition(together, { cluster: 'none' }), clus = byCondition(together);
  assert.ok(indep.found + indep.foundAt95 >= clus.found + clus.foundAt95);
  assert.match(formatConditions(indep), /NOT HERE: this run treats every trade as independent/);
});

test('the report opens with the chance warning, word for word, and no line reads as advice', () => {
  const res = byCondition(makeTrades({ seed: 7, days: 600, perDay: 3, r: (c, g) => g() + (c.weekday === 'Tue' ? 0.5 : -0.125) }));
  const text = formatConditions(res, { title: 'Bitcoin M15, by condition' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Bitcoin M15, by condition');
  assert.equal(lines[1], 'Developer report — about 1 to 2 of these cells will clear zero by chance at 95%; a cell is only marked when it clears zero at z = 3.16 (all 32 cells counted). None of these is a rule to trade by.');
  assert.equal(headerWarning(res), lines[1]);
  for (const l of lines) assert.doesNotMatch(l, ADVICE, l);
  for (const c of CELLS) assert.doesNotMatch(c.label, ADVICE, c.label);
  assert.match(text, /Cleared zero at z = 3\.16: 1 of 32\./);
  assert.match(text, /against 1\.6 expected by chance alone/);
  // Every cell has its line, in order, under its group.
  let at = 0;
  for (const c of CELLS) { const i = lines.findIndex((l, k) => k > at && l.startsWith('  ' + c.label + ' ')); assert.ok(i > at, c.label); at = i; }
});

test('the whole sample is printed as a baseline, and says so when it alone explains the cells', () => {
  const flat = byCondition(makeTrades({ seed: 11, days: 300, r: (c, g) => g() }));
  assert.equal(flat.all.n, flat.trades);
  assert.equal(flat.all.clearsZero, false);
  assert.match(formatConditions(flat), /^ {2}All trades +900 +300 +[+−]0\.\d\d +[+−]0\.\d\d to [+−]0\.\d\d$/m);
  assert.doesNotMatch(formatConditions(flat), /All trades together/);
  // Everything +0.3R: most cells clear zero only because the whole sample does.
  const lifted = byCondition(makeTrades({ seed: 11, days: 300, r: (c, g) => g() + 0.3 }));
  assert.equal(lifted.all.clearsZero, true);
  assert.ok(lifted.found > 10);
  const text = formatConditions(lifted);
  assert.match(text, /All trades together clear zero above as well, so a cell clearing zero here mostly repeats the whole sample's average; it says little about the cell itself\./);
  assert.doesNotMatch(text.split('\n').find((l) => l.startsWith('  All trades')), /clears zero/);
});

test('years before 2025 carry the missing-calendar caveat', () => {
  const res = byCondition(makeTrades({ seed: 2, days: 60, r: (c, g) => g() }));
  assert.match(formatConditions(res), /Before 2025 there is no news calendar, so these years include trades around releases that the live desk would have sat out\./);
  assert.doesNotMatch(formatConditions(res, { multiYear: false }), /Before 2025/);
});

test('held-back trades are refused unless the caller allows them', () => {
  const t = { at: `${HOLDOUT_FROM}T09:15`, r: 0.5, cond: randomCond(rng(1)) };
  assert.throws(() => byCondition([t]), /held-back years/);
  const res = byCondition([t], { allowHeldBack: true });
  assert.equal(res.trades, 1);
  assert.doesNotMatch(formatConditions(res), /Before 2025/);
});

test('trades with no condition or no result are left out, and unknown values sit in no cell', () => {
  const u = rng(5);
  const good = Array.from({ length: 40 }, (_, i) => ({ at: `2021-0${1 + i % 9}-1${i % 10}T10:00`, r: 0.1, cond: { ...randomCond(u), regime: 'sideways' } }));
  const res = byCondition([...good, { at: '2021-01-04T10:00', r: 1 }, { at: '2021-01-04T10:00', r: NaN, cond: randomCond(u) }, null]);
  assert.equal(res.trades, 40);
  assert.ok(res.rows.filter((r) => r.group === 'Regime').every((r) => r.n === 0));
  assert.equal(res.rows.find((r) => r.cell === 'side:buy').n + res.rows.find((r) => r.cell === 'side:sell').n, 40);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
