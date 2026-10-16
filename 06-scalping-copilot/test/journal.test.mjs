/**
 * The automatic journal (desk/journal.mjs): what may be stored, how events
 * fold into entries, how alerts are found, scored and linked to the user's
 * own trades, when the committed sample gives its verdict, and what is said.
 * Bars are the recorded Binance BTCUSDT fifteen-minute candles of
 * fixtures/btc-m15.json, or a few invented ones where a rare case is needed.
 * Nothing here touches the network; every file is in a temporary folder.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED, FORBIDDEN, SOURCES, VERDICTS, IN_SESSION_LINE, TAKEN_WITHIN_MS, DEFAULT_PLANNED_ALERTS,
  sanitize, journalPath, readEvents, appendEvents, fold, foldSample, alertEvent, classifyScan,
  backfillUnseen, resolveOpen, markTicketed, markTaken, markActual, needsLiveConsent,
  setSample, sampleStatus, outcomeSentence, summary, fmtR, noVerdictLine, sampleQuestion, idOf,
} from '../desk/journal.mjs';
import { liveRead, ideaRecord } from '../desk/live.mjs';
import { outcome } from '../desk/outcome.mjs';
import { withDefaults, costFor } from '../desk/lib.mjs';
import { windowState } from '../src/sessions.js';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  };
  pending.push(run);
};

const here = dirname(fileURLToPath(import.meta.url));
const JOURNAL = join(here, '..', 'desk', 'journal.mjs');
const F = JSON.parse(readFileSync(join(here, 'fixtures', 'btc-m15.json'), 'utf8'));
const BARS = F.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const M15 = 15 * 60000;
const cfg = withDefaults({});
const FEED = { id: 'binance', label: 'Binance (BTCUSDT)' };
const METHOD = { version: 'm1', targetRule: '1.5R', filter: 'none' };
const tmp = () => mkdtempSync(join(tmpdir(), 'journal-'));
const kOf = (closeMs) => BARS.findIndex((b) => b.t + M15 === closeMs);
// Wednesday 7 Oct 2026: bar 581 closes 13:15 UTC (14:15 London) with a sell idea
// the watcher sends; 582 at 13:30 is the same idea again, held back while the
// first is still running. Thursday 8 Oct 13:45 UTC brings the next one.
const C1315 = Date.UTC(2026, 9, 7, 13, 15), C1330 = Date.UTC(2026, 9, 7, 13, 30), NEXT_DAY = Date.UTC(2026, 9, 8, 13, 45);
const reads = new Map();
const recAt = (closeMs) => {
  if (!reads.has(closeMs)) {
    const k = kOf(closeMs);
    const r = liveRead({ pair: 'BTCUSD', bars: BARS.slice(Math.max(0, k - 999), k + 1), nowMs: closeMs + 20000, cfg, source: FEED });
    assert.equal(r.kind, 'idea', `expected an idea at ${new Date(closeMs).toISOString()}`);
    reads.set(closeMs, ideaRecord(r));
  }
  return reads.get(closeMs);
};
/** A synthetic alert event, for the tests that need many. */
const mk = ({ pair = 'BTCUSD', closeMs, side = 'sell', source = 'watch', method = METHOD, account = 'demo', stopDist = 100, tp1Dist = 150, spreadNum = 6 }) =>
  sanitize({ type: 'alert', id: idOf(pair, closeMs), at: closeMs + 20000, account, pair, tf: 'M15', source, method, barCloseMs: closeMs, side, feed: FEED.label, refPrice: 84000, stopDist, tp1Dist, spreadNum, netR: 1.48, confidence: 'moderate', reasons: ['engine reason'], against: [] });
const resolvedEv = (id, r, how = r >= 1 ? 'target' : r === -1 ? 'stop' : 'window', extra = {}) =>
  sanitize({ type: 'resolved', id, at: 1, r, how, bars: 3, mfe: 1, mae: 0.5, bothTouched: false, scoring: 'half', feed: FEED.label, spreadNum: 6, ...extra });
const FORBIDDEN_WORDS = /\bwon\b|\blost\b|you made|£|\bwin(s|ning|ner)?\b|\bloss(es)?\b|\bprofit/i;
const PRICE_LEVEL = /\d{1,3}(,\d{3})+|\d{4,}/;

console.log('\nwhere it lives');
test('beside the config by default, or wherever $SCALP_DESK_JOURNAL says', () => {
  assert.equal(journalPath({ env: {}, configPath: '/x/desk/config.json' }), '/x/desk/journal.jsonl');
  assert.equal(journalPath({ env: { SCALP_DESK_CONFIG: '/t/c.json' } }), '/t/journal.jsonl');
  assert.equal(journalPath({ env: { SCALP_DESK_JOURNAL: '/j/x.jsonl' }, configPath: '/x/config.json' }), '/j/x.jsonl');
  assert.match(journalPath({ env: {} }), /desk[\\/]journal\.jsonl$/);
});

console.log('\nprivacy (the repository is public)');
test('every forbidden key throws, at the top and nested, however it is spelt', () => {
  const base = { type: 'alert', id: 'BTCUSD-1', pair: 'BTCUSD', source: 'watch', barCloseMs: 1, side: 'buy', stopDist: 1, tp1Dist: 2 };
  for (const k of ['volume', 'lots', 'balance', 'riskPct', 'account_number', 'Account Number', 'login', 'server', 'email', 'phone', 'note', 'text', 'profit', 'money', 'amount']) {
    assert.throws(() => sanitize({ ...base, [k]: 1 }), /may not be stored/, k);
    assert.throws(() => sanitize({ ...base, method: { ...METHOD, [k]: 1 } }), /may not be stored/, `method.${k}`);
  }
  assert.throws(() => sanitize({ ...base, features: { balance: 9816107.46 } }), /may not be stored/);
  assert.throws(() => sanitize({ ...base, account: { mode: 'demo', balance: 1 } }), /may not be stored/);
  assert.throws(() => sanitize({ type: 'actual', id: 'x', r: 1, how: 'target', lots: 0.5 }), /may not be stored/);
});
test('the lists are exported, and nothing forbidden is on any allowed list', () => {
  const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = Object.values(ALLOWED).flat().map(norm);
  for (const f of FORBIDDEN) assert.ok(!allowed.includes(f), f);
  for (const must of ['volume', 'lots', 'balance', 'riskpct', 'accountnumber', 'login', 'server', 'email', 'phone']) assert.ok(FORBIDDEN.includes(must), must);
  assert.deepEqual([...SOURCES], ['watch', 'scan', 'scan-extra', 'unseen']);
});
test('unknown fields are dropped; a pound sign or an email address in any text throws', () => {
  const e = sanitize({ type: 'taken', id: 'BTCUSD-1', how: 'named', mood: 'great', at: 5 });
  assert.deepEqual(e, { type: 'taken', id: 'BTCUSD-1', at: 5, account: 'demo', how: 'named' });
  assert.throws(() => sanitize({ type: 'alert', id: 'a', reasons: ['up £40'] }), /money amount or an email/);
  assert.throws(() => sanitize({ type: 'alert', id: 'a', against: ['ben@example.com'] }), /money amount or an email/);
});
test('free text from the user cannot get in: how a trade ended is one of a short list', () => {
  assert.throws(() => markActual('BTCUSD-1', { r: 0.5, how: 'closed it early, news was coming' }), /must be one of/);
  assert.throws(() => markActual('BTCUSD-1', { r: '+£40', how: 'by-hand' }), /number of R/);
  assert.deepEqual(Object.keys(markActual('BTCUSD-1', { r: 0.8, how: 'by-hand', at: 9 })).sort(), ['account', 'at', 'how', 'id', 'r', 'type']);
});
test('"volume" inside features is the market\'s volume and is allowed; features hold numbers only', () => {
  const e = sanitize({ type: 'alert', id: 'a', features: { volume: 0.4, relVol: 1.2, 'bucket.volume': -1, abstain: true } });
  assert.deepEqual(e.features, { volume: 0.4, relVol: 1.2, 'bucket.volume': -1, abstain: true });
  assert.throws(() => sanitize({ type: 'alert', id: 'a', features: { why: 'because' } }), /must be a number/);
});
test('an alert from a real watcher record keeps only allowed fields', () => {
  const rec = { ...recAt(C1315), caution: 'some gate text', lastStretch: false };
  const e = alertEvent(rec, { source: 'watch', method: METHOD, at: 1 });
  const ok = new Set([...ALLOWED.common, ...ALLOWED.alert]);
  for (const k of Object.keys(e)) assert.ok(ok.has(k), k);
  assert.equal(e.id, `BTCUSD-${C1315}`);
  assert.equal(e.feed, 'Binance (BTCUSDT)');
  assert.equal(e.side, 'sell');
  assert.equal(e.account, 'demo');
  assert.ok(!('caution' in e) && !('lastStretch' in e));
});
test('every event carries the account mode from the settings, demo by default', () => {
  const live = withDefaults({ account: { mode: 'live' } });
  assert.equal(alertEvent(recAt(C1315), { source: 'watch', cfg: live }).account, 'live');
  assert.equal(markActual('x', { r: 1, how: 'target', cfg: live }).account, 'live');
  assert.equal(markActual('x', { r: 1, how: 'target', cfg }).account, 'demo');
  assert.throws(() => alertEvent(recAt(C1315), { source: 'watch', cfg: withDefaults({ account: { mode: 'paper' } }) }), /must be one of/);
  const entries = fold([mk({ closeMs: C1315 })]);
  assert.equal(needsLiveConsent(entries, live), true);
  assert.equal(needsLiveConsent(entries, cfg), false);
  assert.equal(needsLiveConsent(fold([mk({ closeMs: C1315, account: 'live' })]), live), false);
});

console.log('\nthe log and the fold');
test('folding is idempotent, and the last event of each type for an id wins', () => {
  const a = mk({ closeMs: C1315 }), b = mk({ closeMs: C1330 });
  const evs = [a, b, resolvedEv(a.id, -1), resolvedEv(a.id, 1.48), markActual(a.id, { r: 0.5, how: 'by-hand', at: 7 })];
  const once = fold(evs);
  assert.deepEqual(fold([...evs, ...evs]), once);
  assert.deepEqual(fold([...evs, resolvedEv(a.id, 1.48)]), once);
  assert.equal(once.get(a.id).outcome.r, 1.48);
  assert.equal(once.get(a.id).status, 'resolved');
  assert.equal(once.get(b.id).status, 'open');
  assert.equal(once.get(a.id).actual.r, 0.5);
  assert.deepEqual([...once.keys()], [a.id, b.id]);
});
test('events for an id with no alert yet are held back; the sample is not an entry', () => {
  const s = setSample({ plannedAlerts: 5, method: METHOD, committedAt: 10, at: 10 });
  const m = fold([resolvedEv('BTCUSD-9', 1), s]);
  assert.equal(m.size, 0);
  assert.deepEqual(foldSample([s]), { plannedAlerts: 5, method: METHOD, committedAt: 10, at: 10 });
  assert.equal(foldSample([]), null);
});
test('one entry per bar: a second alert for the same id is dropped, the first stands', () => {
  const path = join(tmp(), 'journal.jsonl');
  const w = mk({ closeMs: C1315, source: 'watch' });
  assert.equal(appendEvents(path, [w]).added.length, 1);
  const again = appendEvents(path, [w, mk({ closeMs: C1315, source: 'scan-extra' }), mk({ closeMs: C1315, source: 'unseen' })]);
  assert.deepEqual([again.added.length, again.skipped], [0, 3]);
  const r = resolvedEv(w.id, 1.48);
  appendEvents(path, [r]);
  assert.equal(appendEvents(path, [r]).skipped, 1);           // the same line twice is not written twice
  const evs = readEvents(path);
  assert.equal(evs.length, 2);
  assert.equal(fold(evs).get(w.id).source, 'watch');
});
test('a refused event writes nothing at all', () => {
  const path = join(tmp(), 'journal.jsonl');
  assert.throws(() => appendEvents(path, [mk({ closeMs: C1315 }), { type: 'actual', id: 'x', r: 1, how: 'target', balance: 5 }]), /may not be stored/);
  assert.equal(existsSync(path), false);
});
test('two commands appending at once keep every line (lock, temporary file, rename)', async () => {
  const dir = tmp();
  const path = join(dir, 'journal.jsonl');
  const child = join(dir, 'child.mjs');
  writeFileSync(child, `
    const [mod, path, tag, n] = process.argv.slice(2);
    const { appendEvents } = await import(mod);
    for (let i = 0; i < +n; i++) appendEvents(path, [{ type: 'alert', id: 'BTCUSD-' + tag + i, at: i, pair: 'BTCUSD', tf: 'M15', source: 'watch', barCloseMs: +(tag + i), side: 'buy', stopDist: 1, tp1Dist: 2 }]);
  `);
  const run = (tag) => new Promise((ok, no) => {
    const p = spawn(process.execPath, [child, pathToFileURL(JOURNAL).href, path, tag, '40'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? ok() : no(new Error(err))));
  });
  await Promise.all([run('1000'), run('2000')]);
  const evs = readEvents(path);
  assert.equal(evs.length, 80);
  assert.equal(new Set(evs.map((e) => e.id)).size, 80);
  assert.deepEqual(readdirSync(dir).sort(), ['child.mjs', 'journal.jsonl']);   // no lock or temporary file left
});
test('a lock left by a command that died is taken over; a live one makes the writer wait, then give up', () => {
  const path = join(tmp(), 'journal.jsonl');
  writeFileSync(`${path}.lock`, '1');
  assert.throws(() => appendEvents(path, [mk({ closeMs: C1315 })], { timeoutMs: 60 }), /another command is writing/);
  const old = (Date.now() - 60000) / 1000;
  utimesSync(`${path}.lock`, old, old);
  assert.equal(appendEvents(path, [mk({ closeMs: C1315 })]).added.length, 1);
  assert.equal(existsSync(`${path}.lock`), false);
});
test('a torn last line is skipped on reading and does not swallow the next event', () => {
  const path = join(tmp(), 'journal.jsonl');
  writeFileSync(path, JSON.stringify(mk({ closeMs: C1315 })) + '\n{"type":"alert","id":"BTC');
  appendEvents(path, [mk({ closeMs: C1330 })]);
  assert.deepEqual([...fold(readEvents(path)).keys()], [`BTCUSD-${C1315}`, `BTCUSD-${C1330}`]);
});

console.log('\nwhere alerts come from');
const pick = (rec) => ({ side: rec.side, stopDist: rec.stopDist, tp1Dist: rec.tp1Dist, spreadNum: rec.spreadNum });
test('a scan\'s idea is "scan" only when the watcher would also have sent it', () => {
  const r1330 = recAt(C1330);
  assert.equal(classifyScan(r1330, new Map(), BARS, cfg), 'scan');                                   // nothing before it
  assert.equal(classifyScan(r1330, fold([mk({ closeMs: C1315, ...pick(recAt(C1315)) })]), BARS, cfg), 'scan-extra');  // the 13:15 alert is still running
  assert.equal(classifyScan(r1330, fold([mk({ closeMs: C1315, source: 'scan-extra', ...pick(recAt(C1315)) })]), BARS, cfg), 'scan');  // an extra is not an alert
  assert.equal(classifyScan(recAt(NEXT_DAY), fold([mk({ closeMs: C1315, ...pick(recAt(C1315)) })]), BARS, cfg), 'scan');  // next day: run its course
});
test('the backfill finds what the method would have sent while nothing was watching', () => {
  const evs = backfillUnseen({ pair: 'BTCUSD', bars: BARS, entries: new Map(), cfg, fromMs: Date.UTC(2026, 9, 7, 13, 0), toMs: Date.UTC(2026, 9, 7, 13, 45), method: METHOD, feed: FEED, nowMs: Date.UTC(2026, 9, 12) });
  assert.deepEqual(evs.map((e) => [e.id, e.source, e.side]), [[`BTCUSD-${C1315}`, 'unseen', 'sell']]);   // 13:30 and 13:45 held back by the first
  assert.equal(evs[0].feed, 'Binance (BTCUSDT)');
  assert.deepEqual(evs[0].method, METHOD);
  // Run again with its own result in the journal: nothing new.
  assert.deepEqual(backfillUnseen({ pair: 'BTCUSD', bars: BARS, entries: fold(evs), cfg, fromMs: Date.UTC(2026, 9, 7, 13, 0), toMs: Date.UTC(2026, 9, 7, 13, 45), method: METHOD, nowMs: Date.UTC(2026, 9, 12) }), []);
});
test('the backfill rebuilds the watcher\'s state from the journal, and skips covered bars', () => {
  const at1330 = { pair: 'BTCUSD', bars: BARS, cfg, fromMs: C1330, toMs: C1330, method: METHOD, nowMs: Date.UTC(2026, 9, 12) };
  assert.deepEqual(backfillUnseen({ ...at1330, entries: new Map() }).map((e) => e.id), [`BTCUSD-${C1330}`]);
  assert.deepEqual(backfillUnseen({ ...at1330, entries: fold([alertEvent(recAt(C1315), { source: 'watch', method: METHOD })]) }), []);
  assert.deepEqual(backfillUnseen({ ...at1330, entries: new Map(), coveredMs: [C1330] }), []);
  assert.deepEqual(backfillUnseen({ ...at1330, entries: new Map(), nowMs: C1330 + 10000 }), []);   // still forming
});

console.log('\nresolution (silent)');
test('an alert is scored on the feed with its own spread once its window has closed', () => {
  const rec = recAt(C1315);
  const entries = fold([alertEvent(rec, { source: 'watch', method: METHOD })]);
  const evs = resolveOpen(entries, BARS, cfg, { pair: 'BTCUSD', feed: FEED });
  const k = kOf(C1315);
  const o = outcome(BARS, k, rec, { spread: rec.spreadNum, comm: costFor('BTCUSD', 0, cfg).comm, closesAtMs: windowState(C1315, cfg.window).closesAtMs, tfMinutes: 15 });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].how, o.how);
  assert.equal(evs[0].r, +o.r.toFixed(4));
  assert.equal(evs[0].feed, 'Binance (BTCUSDT)');
  assert.equal(evs[0].spreadNum, rec.spreadNum);
  assert.equal(evs[0].scoring, 'half');
  // Resolved entries are not scored again.
  assert.deepEqual(resolveOpen(fold([alertEvent(rec, { source: 'watch' }), ...evs]), BARS, cfg, { pair: 'BTCUSD' }), []);
});
test('an alert whose window is still open, or whose bars run out first, stays open', () => {
  const entries = fold([alertEvent(recAt(C1315), { source: 'watch' })]);
  assert.deepEqual(resolveOpen(entries, BARS, cfg, { pair: 'BTCUSD', nowMs: Date.UTC(2026, 9, 7, 14, 0) }), []);
  assert.deepEqual(resolveOpen(entries, BARS.slice(0, kOf(C1315) + 3), cfg, { pair: 'BTCUSD', nowMs: Date.UTC(2026, 9, 12) }), []);
  assert.deepEqual(resolveOpen(entries, { XAUUSD: BARS }, cfg), []);   // gold's bars do not score bitcoin
  assert.equal(resolveOpen(entries, { BTCUSD: BARS }, cfg).length, 1);
  assert.throws(() => resolveOpen(entries, BARS, cfg), /needs opts.pair/);
});
test('a bar touching both the stop and the target is scored as half of each', () => {
  const t0 = Date.UTC(2026, 9, 7, 9, 0);
  const bars = [{ t: t0, o: 100, h: 101, l: 99, c: 100 }, { t: t0 + M15, o: 100, h: 200, l: 50, c: 100 }];
  const entries = fold([mk({ closeMs: t0 + M15, side: 'buy', stopDist: 10, tp1Dist: 15, spreadNum: 1 })]);
  const [ev] = resolveOpen(entries, bars, cfg, { pair: 'BTCUSD', nowMs: Date.UTC(2026, 9, 7, 16) });
  const comm = costFor('BTCUSD', 0, cfg).comm;
  const target = (15 - 1 - comm) / (10 + 1 + comm);
  assert.equal(ev.bothTouched, true);
  assert.equal(ev.r, +((target - 1) / 2).toFixed(4));
  const said = outcomeSentence(fold([mk({ closeMs: t0 + M15, side: 'buy' }), ev]).get(ev.id), cfg);
  assert.match(said, /^The 10:15 bitcoin buy alert touched its stop and its target in the same bar, so it counts as half of each \(\+0\.14\)$/);
});

console.log('\ntaken: only by an explicit link');
test('"took it" links to a ticket built within 30 minutes, and to nothing else', () => {
  const t = Date.UTC(2026, 9, 7, 13, 17);
  const a = mk({ closeMs: C1315 }), b = mk({ closeMs: C1330 });
  const ticketed = markTicketed(fold([a]).get(a.id), { userPrice: 84123.45, stopLoss: 84700, takeProfit: 83300, at: t });
  assert.deepEqual(Object.keys(ticketed).sort(), ['account', 'at', 'id', 'stopLoss', 'takeProfit', 'type', 'userPrice']);
  const entries = fold([a, b, ticketed]);
  const ok = markTaken(entries, { lastTicketedWithinMs: TAKEN_WITHIN_MS, nowMs: t + 10 * 60000 });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.event.id, ok.event.how], [a.id, 'ticket']);
  assert.deepEqual(markTaken(entries, { lastTicketedWithinMs: TAKEN_WITHIN_MS, nowMs: t + 31 * 60000 }), { ok: false, reason: 'no-ticket' });
});
test('a recent alert with no ticket is never taken by recency; two fresh tickets are asked about', () => {
  const a = mk({ closeMs: C1315 }), b = mk({ closeMs: C1330 });
  assert.deepEqual(markTaken(fold([a, b]), { lastTicketedWithinMs: TAKEN_WITHIN_MS, nowMs: C1330 + 60000 }), { ok: false, reason: 'no-ticket' });
  const two = fold([a, b, markTicketed(fold([a]).get(a.id), { userPrice: 1, at: C1315 + 60000 }), markTicketed(fold([b]).get(b.id), { userPrice: 1, at: C1330 + 60000 })]);
  const r = markTaken(two, { lastTicketedWithinMs: TAKEN_WITHIN_MS, nowMs: C1330 + 120000 });
  assert.deepEqual(r, { ok: false, reason: 'ambiguous', candidates: [a.id, b.id] });
});
test('naming the alert links it; an unknown name does not', () => {
  const a = mk({ closeMs: C1315 });
  const r = markTaken(fold([a]), { alertId: a.id, at: 5 });
  assert.deepEqual([r.ok, r.event.how, r.event.id], [true, 'named', a.id]);
  assert.deepEqual(markTaken(fold([a]), { alertId: 'BTCUSD-1' }), { ok: false, reason: 'no-alert' });
  assert.throws(() => markTaken(fold([a]), {}), /needs an alert id or a ticket window/);
});

console.log('\nthe committed sample');
const DAY = 86400e3;
const day0 = Date.UTC(2026, 10, 2, 10, 0);       // Monday 2 Nov 2026
const sampleOf = (rs, { N = rs.length, method = METHOD, extra = [] } = {}) => {
  const evs = [];
  rs.forEach((r, i) => {
    const a = mk({ closeMs: day0 + i * DAY, method });
    evs.push(a);
    if (r !== null) evs.push(resolvedEv(a.id, r));
  });
  return { entries: fold([...evs, ...extra]), sample: foldSample([setSample({ plannedAlerts: N, method: METHOD, committedAt: day0 - 1 })]) };
};
test('at N: lower bound above zero is evidence of an edge, not proof', () => {
  const { entries, sample } = sampleOf([1.4, 1.5, 1.2, 0.9, 1.3, 1.1, 0.8, 1.48, 1.0, 1.2]);
  const st = sampleStatus(entries, sample);
  assert.deepEqual([st.complete, st.verdict, st.verdictText], [true, 'edge', 'evidence of an edge, not proof']);
  assert.ok(st.range[0] > 0);
});
test('at N: upper bound below zero is evidence against', () => {
  const st = sampleStatus(...Object.values(sampleOf([-1, -1, -0.8, -1, -0.9, -1, -1, -0.7, -1, -1])));
  assert.deepEqual([st.verdict, st.verdictText], ['against', VERDICTS.against]);
  assert.ok(st.range[1] < 0);
});
test('at N: a range across zero is not distinguishable from break-even', () => {
  const st = sampleStatus(...Object.values(sampleOf([1.48, -1, 1.48, -1, 0.2, -1, 1.48, -1, -0.3, -1])));
  assert.deepEqual([st.verdict, st.verdictText], ['break-even', 'not distinguishable from break-even']);
  assert.ok(st.range[0] < 0 && st.range[1] > 0);
});
test('before N, or with one of the N still open, there is no verdict', () => {
  const st = sampleStatus(...Object.values(sampleOf([1.4, 1.5, 1.2, 0.9, 1.3, 1.1, 0.8, 1.48, 1.0], { N: 10 })));
  assert.deepEqual([st.count, st.complete, st.verdict], [9, false, null]);
  assert.ok(st.mean > 1);
  const open = sampleStatus(...Object.values(sampleOf([1.4, 1.5, 1.2, 0.9, 1.3, 1.1, 0.8, 1.48, 1.0, null])));
  assert.deepEqual([open.count, open.open, open.verdict], [10, 1, null]);
});
test('the sample counts the method\'s alerts after commitment, once each, unseen in, scan-extras out', () => {
  const other = { ...METHOD, targetRule: '2R' };
  const extra = [
    mk({ closeMs: day0 + 20 * DAY, source: 'scan-extra' }),
    mk({ closeMs: day0 + 21 * DAY, source: 'unseen' }),
    mk({ closeMs: day0 + 22 * DAY, method: other }),
    mk({ closeMs: day0 - DAY }),                              // before the commitment
    mk({ closeMs: day0, source: 'scan' }),                    // same id as the first: one entry
  ];
  const st = sampleStatus(...Object.values(sampleOf([1, -1], { N: 190, extra })));
  assert.equal(st.count, 3);
  assert.equal(sampleStatus(new Map(), null), null);
  assert.equal(DEFAULT_PLANNED_ALERTS, 190);
  assert.match(sampleQuestion(), /^Shall I judge the alerts on the next 190 of them, every alert scored on the price feed whether you take it or not, and give no verdict before then\?/);
});

console.log('\nwhat it says');
const at1015 = Date.UTC(2026, 9, 7, 9, 15);       // 10:15 London (BST)
const said = (o) => outcomeSentence(fold([mk({ closeMs: at1015 }), ...(o ? [resolvedEv(`BTCUSD-${at1015}`, o.r, o.how)] : [])]).get(`BTCUSD-${at1015}`), cfg);
test('an outcome is said in exactly one of rule 5\'s three forms, the time in London', () => {
  assert.equal(said({ r: 1.5, how: 'target' }), 'The 10:15 bitcoin sell alert reached its target (+1.5 times the risk)');
  assert.equal(said({ r: -1, how: 'stop' }), 'The 10:15 bitcoin sell alert hit its stop (−1)');
  assert.equal(said({ r: 0.3, how: 'window' }), 'The 10:15 bitcoin sell alert was closed at the end of the session (+0.3)');
  assert.equal(said({ r: -0.25, how: 'window' }), 'The 10:15 bitcoin sell alert was closed at the end of the session (−0.25)');
  assert.equal(said(null), 'The 10:15 bitcoin sell alert has not finished yet');
  assert.deepEqual([fmtR(1.4799), fmtR(-1), fmtR(0), fmtR(0.004)], ['+1.48', '−1', '0', '0']);
});
// A day with every kind of entry: sent alerts that ended each way, an unseen one,
// a scan-extra, a ticket, a trade the user took and told the result of.
const dayEvents = () => {
  const t = (h, m) => Date.UTC(2026, 9, 7, h, m);
  const a = mk({ closeMs: t(7, 15) }), b = mk({ closeMs: t(8, 30), side: 'buy' }), c = mk({ closeMs: t(10, 0) });
  const u = mk({ closeMs: t(11, 45), source: 'unseen' }), x = mk({ closeMs: t(12, 0), source: 'scan-extra' });
  const g = mk({ pair: 'XAUUSD', closeMs: t(13, 0), side: 'buy', stopDist: 3, tp1Dist: 4.5, spreadNum: 0.05 });
  return [a, b, c, u, x, g,
    resolvedEv(a.id, 1.4823, 'target'), resolvedEv(b.id, -1, 'stop'), resolvedEv(c.id, 0.31, 'window'), resolvedEv(u.id, -1, 'stop'),
    resolvedEv(g.id, 0.0813, 'window', { feed: 'Twelve Data (XAU/USD)' }),
    markTicketed(fold([a]).get(a.id), { userPrice: 84123.45, stopLoss: 84700.1, takeProfit: 83300.2, at: t(7, 17) }),
    markTaken(fold([a]), { alertId: a.id, at: t(7, 18) }).event,
    markActual(a.id, { r: 1.3, how: 'target', at: t(9, 0) }),
    setSample({ plannedAlerts: 190, method: METHOD, committedAt: t(0, 0), at: t(0, 0) }),
  ];
};
test('during the session on a weekday: process counts only, and rule 4\'s sentence', () => {
  const evs = dayEvents();
  const text = summary(fold(evs), { nowMs: Date.UTC(2026, 9, 7, 13, 30), cfg, sample: foldSample(evs) });
  assert.ok(text.endsWith(IN_SESSION_LINE));
  assert.match(text, /^- Alerts sent: 4 \(1 gold, 3 bitcoin\)$/m);
  assert.match(text, /^- Alerts logged afterwards from the price feed, while nothing was watching: 1$/m);
  assert.match(text, /^- Tickets you asked for: 1$/m);
  assert.match(text, /^- Trades you told me you took: 1$/m);
  assert.match(text, /^- Alert sample: 5 of 190$/m);
  assert.doesNotMatch(text, /target|stop|risk|average|range|[+−]\d|verdict/i);
});
test('after the session: two blocks never added together, then the sample and decision 8', () => {
  const evs = dayEvents();
  const text = summary(fold(evs), { nowMs: Date.UTC(2026, 9, 7, 16, 30), cfg, sample: foldSample(evs) });
  const blocks = text.split('\n\n');
  assert.match(blocks[0], /^\*\*The alerts\*\*: scored on Binance's and Twelve Data's prices, not your MT5 trades; your own result can differ\.$/m);
  assert.match(blocks[0], /^- The 08:15 bitcoin sell alert reached its target \(\+1\.48 times the risk\)$/m);
  assert.match(blocks[0], /^- The 09:30 bitcoin buy alert hit its stop \(−1\)$/m);
  assert.match(blocks[0], /^- The 11:00 bitcoin sell alert was closed at the end of the session \(\+0\.31\)$/m);
  assert.match(blocks[0], /^- The 14:00 gold buy alert was closed at the end of the session \(\+0\.08\)$/m);
  assert.match(blocks[0], /while nothing was watching \(they count in the sample\):\n {2}- The 12:45 bitcoin sell alert hit its stop \(−1\)$/m);
  assert.match(blocks[0], /^- Not counted: 1 idea from a one-off scan that the watcher would not have sent\.$/m);
  assert.match(blocks[1], /^\*\*Your trades\*\*: what you told me \(1 of them\)\.\n- Demo: 1 trade, on average \+1\.3 times the risk$/);
  assert.match(blocks[2], /^\*\*The alert sample\*\*: 5 of the 190 alerts you committed to \(5 finished\), so far on average −0\.03 times the risk — too few days yet for a range\.$/m);
  assert.ok(blocks[2].endsWith(noVerdictLine(190)));
  assert.equal(blocks.length, 3);
  assert.doesNotMatch(text, /missed/i);
});
test('at the weekend it is never "in session"; with no sample it says there is no verdict', () => {
  const evs = dayEvents().filter((e) => e.type !== 'sample');
  const text = summary(fold(evs), { nowMs: Date.UTC(2026, 9, 10, 12, 0), cfg, fromMs: Date.UTC(2026, 9, 5), sample: null });
  assert.match(text, /^\*\*The alerts\*\*/);
  assert.match(text, /\*\*The alert sample\*\*: none committed yet, so there is no verdict to give\.$/);
});
test('the verdict, once all N have finished, is said in the declared words', () => {
  const { entries, sample } = sampleOf([1.48, -1, 1.48, -1, 0.2, -1, 1.48, -1, -0.3, -1]);
  const text = summary(entries, { nowMs: day0 + 30 * DAY + 8 * 3600e3, cfg, sample, fromMs: day0 });
  assert.match(text, /\*\*The alert sample\*\*: complete — 10 alerts, on average −0\.07 times the risk \(range −0\.\d+ to \+0\.\d+, clustered by day\)\. Verdict: not distinguishable from break-even\.$/);
  assert.doesNotMatch(text, /No verdict until/);
});
test('never "won", "lost", "you made", pounds, or a feed price, in any summary', () => {
  const evs = dayEvents();
  const texts = [13.5, 16.5, 20].map((h) => summary(fold(evs), { nowMs: Date.UTC(2026, 9, 7, Math.floor(h), (h % 1) * 60), cfg, sample: foldSample(evs) }));
  const { entries, sample } = sampleOf([1.4, 1.5, 1.2, 0.9, 1.3, 1.1, 0.8, 1.48, 1.0, 1.2]);
  texts.push(summary(entries, { nowMs: day0 + 30 * DAY + 8 * 3600e3, cfg, sample, fromMs: day0 }));
  for (const t of texts) {
    assert.doesNotMatch(t, FORBIDDEN_WORDS);
    assert.doesNotMatch(t, PRICE_LEVEL);
  }
  for (const r of [1.5, -1, 0.3]) assert.doesNotMatch(said({ r, how: r === 1.5 ? 'target' : r === -1 ? 'stop' : 'window' }), FORBIDDEN_WORDS);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
