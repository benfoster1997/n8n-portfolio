/**
 * The automatic journal (desk/journal.mjs): what may be stored, how events
 * fold into entries whatever their order, how the method's record is replayed
 * on the reference feed, how what the user was shown is scored and linked to
 * their own trades, when the committed sample gives its verdict, and what is
 * said.
 *
 * Bars are the recorded Binance BTCUSDT fifteen-minute candles of
 * fixtures/btc-m15.json, moved two weeks later (Wed 7 Oct → Wed 21 Oct 2026,
 * both in British Summer Time): the journal refuses to read the held-back
 * years (rule 2), and the recording sits inside them. A few invented bars
 * cover the rare cases. Nothing here touches the network; every file is in a
 * temporary folder. Reads are memoised, so the whole suite makes about 64.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED, FORBIDDEN, SOURCES, VERDICTS, IN_SESSION_LINE, TAKEN_WITHIN_MS, DEFAULT_PLANNED_ALERTS, MIN_PLANNED_ALERTS,
  MIN_VERDICT_DAYS, REFERENCE_FEEDS, HOLDOUT, LiveConsentError,
  sanitize, setFeatureNames, journalPath, readEvents, appendEvents, fold, foldSample, foldSamples, foldCanonical, foldConsent,
  canonicalAlerts, shownEvent, resolveOpen, markTicketed, markTaken, markActual, needsLiveConsent, consentEvent,
  setSample, sampleStatus, outcomeSentence, summary, fmtR, noVerdictLine, sampleQuestion, idOf, methodOf, methodKey, takenWithinMs,
} from '../desk/journal.mjs';
import { liveRead, ideaRecord } from '../desk/live.mjs';
import { outcome } from '../desk/outcome.mjs';
import { clusteredByDay } from '../desk/stats.mjs';
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
const DAY = 86400e3;
const SHIFT = 14 * DAY;
const BARS = F.bars.map(([t, o, h, l, c, v]) => ({ t: t + SHIFT, o, h, l, c, v }));
const M15 = 15 * 60000;
const cfg = withDefaults({});
const live = withDefaults({ account: { mode: 'live' } });
const FEED = { id: 'binance-vision', label: 'Binance (BTCUSDT)' };
const REF = REFERENCE_FEEDS.BTCUSD;
const METHOD = methodOf({ version: 'm1', tf: 'M15' });
const STUB_FEATURES = ['engineNet', 'relVol', 'bucket.volume', 'volume', 'abstain', 'hour.08-10'];
setFeatureNames(STUB_FEATURES);
const tmp = () => mkdtempSync(join(tmpdir(), 'journal-'));
const kOf = (closeMs) => BARS.findIndex((b) => b.t + M15 === closeMs);
const NOW = Date.UTC(2026, 9, 27);
const LOOKBACK = 520;          // the recording holds 999 bars; the watcher reads 1,000

// Wed 21 Oct 2026: the 13:15 UTC (14:15 London) close brings a sell idea the
// watcher sends; the same idea comes back at every close to 14:30, each held
// back while the first is still running. Thu 22 Oct 13:45 brings the next.
const C1315 = Date.UTC(2026, 9, 21, 13, 15), C1330 = Date.UTC(2026, 9, 21, 13, 30), NEXT_DAY = Date.UTC(2026, 9, 22, 13, 45);

const memo = new Map();
let readsMade = 0;
const read = (args) => {
  const b = args.bars;
  const key = `${args.pair}|${args.nowMs}|${b.length}|${b[0].t}|${b[b.length - 1].t}|${args.targetRule}|${args.cfg.timeframe}`;
  if (!memo.has(key)) { readsMade++; memo.set(key, liveRead(args)); }
  return memo.get(key);
};
const canon = (o = {}) => canonicalAlerts({ pair: 'BTCUSD', bars: BARS, cfg, method: METHOD, lookback: LOOKBACK, nowMs: NOW, read, fromMs: Date.UTC(2026, 9, 21), toMs: Date.UTC(2026, 9, 23), ...o });
const recAt = (closeMs) => {
  const k = kOf(closeMs);
  const r = read({ pair: 'BTCUSD', bars: BARS.slice(k - LOOKBACK + 1, k + 1), nowMs: closeMs + 20000, cfg: { ...cfg, timeframe: 'M15' }, source: FEED, targetRule: '1.5R' });
  assert.equal(r.kind, 'idea', `expected an idea at ${new Date(closeMs).toISOString()}`);
  return ideaRecord(r);
};

/* Synthetic events, for the tests that need many. */
const lv = { refPrice: 84000, stopDist: 100, tp1Dist: 150, spreadNum: 6, commNum: 0, netR: 1.48, confidence: 'moderate', reasons: ['engine reason'], against: [] };
const mkAlert = ({ pair = 'BTCUSD', closeMs, side = 'sell', r = 1, how = r >= 1 ? 'target' : r === -1 ? 'stop' : 'window', method = METHOD, gap = false, bothTouched = false, ...rest }) =>
  sanitize({ type: 'alert', id: idOf(pair, method.tf, closeMs), at: closeMs + 20000, pair, tf: method.tf, method, barCloseMs: closeMs, side, feed: REFERENCE_FEEDS[pair].label, feedId: REFERENCE_FEEDS[pair].id, ...lv, ...rest, outcome: { r, how, bars: 3, mfe: 1, mae: 0.5, bothTouched, scoring: 'half', gap } });
const mkShown = ({ pair = 'BTCUSD', closeMs, side = 'sell', source = 'watch', account = 'demo', method = METHOD, at = closeMs + 20000, ...rest }) =>
  sanitize({ type: 'shown', id: idOf(pair, method.tf, closeMs), at, account, source, pair, tf: method.tf, method, barCloseMs: closeMs, side, feed: FEED.label, feedId: FEED.id, ...lv, ...rest });
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const mkDay = (pair, day, alerts = 0, method = METHOD) => sanitize({ type: 'day', id: `${pair}-${method.tf}-${day}`, at: Date.parse(`${day}T15:00:00Z`), pair, tf: method.tf, method, day, alerts, kinds: {} });
const resolvedEv = (id, r, how = r >= 1 ? 'target' : r === -1 ? 'stop' : 'window', extra = {}) =>
  sanitize({ type: 'resolved', id, at: 1, account: 'demo', r, how, bars: 3, mfe: 1, mae: 0.5, bothTouched: false, scoring: 'half', gap: false, feed: FEED.label, spreadNum: 6, ...extra });
const FORBIDDEN_WORDS = /\bwon\b|\blost\b|you made|£|\bwin(s|ning|ner)?\b|\bloss(es)?\b|\bprofit|missed/i;
const PRICE_LEVEL = /\d{1,3}(,\d{3})+|\d{4,}/;

console.log('\nwhere it lives');
test('beside the config by default, or wherever $SCALP_DESK_JOURNAL says', () => {
  assert.equal(journalPath({ env: {}, configPath: '/x/desk/config.json' }), '/x/desk/journal.jsonl');
  assert.equal(journalPath({ env: { SCALP_DESK_CONFIG: '/t/c.json' } }), '/t/journal.jsonl');
  assert.equal(journalPath({ env: { SCALP_DESK_JOURNAL: '/j/x.jsonl' }, configPath: '/x/config.json' }), '/j/x.jsonl');
  assert.match(journalPath({ env: {} }), /desk[\\/]journal\.jsonl$/);
});

console.log('\nprivacy (the repository is public)');
const base = () => mkShown({ closeMs: C1315 });
test('every forbidden key throws, at the top and nested, however it is spelt', () => {
  for (const k of ['volume', 'lots', 'balance', 'riskPct', 'account_number', 'Account Number', 'login', 'server', 'email', 'phone', 'note', 'text', 'profit', 'money', 'amount']) {
    assert.throws(() => sanitize({ ...base(), [k]: 1 }), /may not be stored/, k);
    assert.throws(() => sanitize({ ...base(), method: { ...METHOD, [k]: 1 } }), /may not be stored/, `method.${k}`);
  }
  assert.throws(() => sanitize({ ...base(), account: { mode: 'demo', balance: 1 } }), /may not be stored/);
  assert.throws(() => sanitize({ type: 'actual', id: base().id, at: 1, account: 'demo', r: 1, how: 'target', lots: 0.5 }), /may not be stored/);
});
test('the lists are exported, and nothing forbidden is on any allowed list', () => {
  const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = Object.values(ALLOWED).flat().map(norm);
  for (const f of FORBIDDEN) assert.ok(!allowed.includes(f), f);
  for (const must of ['volume', 'lots', 'balance', 'riskpct', 'accountnumber', 'login', 'server', 'email', 'phone']) assert.ok(FORBIDDEN.includes(must), must);
  assert.deepEqual([...SOURCES], ['watch', 'scan']);
});
test('unknown fields are dropped; money, an email, a phone or a login number in any text throws', () => {
  const e = sanitize({ type: 'taken', id: base().id, at: 5, account: 'demo', how: 'named', mood: 'great' });
  assert.deepEqual(e, { type: 'taken', id: base().id, at: 5, account: 'demo', how: 'named' });
  for (const bad of ['up £40', 'ben@example.com', 'ring me on 07700 900123', 'login 51234567 pw hunter2', 'made $400 today', 'about €50']) {
    assert.throws(() => sanitize({ ...base(), reasons: [bad] }), /money amount, an email address or a long number/, bad);
    assert.throws(() => sanitize({ ...base(), against: [bad] }), /money amount, an email address or a long number/, bad);
  }
  // Engine text with prices to two decimals is fine.
  assert.equal(sanitize({ ...base(), reasons: ['0.8 ATR below a 3-touch level at 84250.00'] }).reasons[0], '0.8 ATR below a 3-touch level at 84250.00');
  // Names are short tokens: no room for "acct 51234567 icmarkets-live" or "call 07700900123".
  assert.throws(() => sanitize({ ...base(), method: { ...METHOD, version: 'call 07700900123' } }), /long number|short name/);
  assert.throws(() => mkAlert({ closeMs: C1315, filter: { id: 'acct 51234567 icmarkets-live', keep: true } }), /long number|short name/);
});
test('features: only names on the injected list; account-like names are refused even there', () => {
  const withF = (features) => mkAlert({ closeMs: C1315, features });
  assert.deepEqual(withF({ volume: 0.4, relVol: 1.2, 'bucket.volume': -1, abstain: true }).features, { volume: 0.4, relVol: 1.2, 'bucket.volume': -1, abstain: true });
  for (const k of ['accountBalance', 'balanceGbp', 'lots2', 'riskAmountGbp', 'pnlToday']) assert.throws(() => withF({ [k]: 9816107.46 }), /not on the features list|may not be stored/, k);
  assert.throws(() => withF({ relVol: 'because' }), /must be a number/);
  for (const k of ['accountBalance', 'pnlToday', 'balanceGbp', 'equityCurve']) assert.throws(() => setFeatureNames([...STUB_FEATURES, k]), /only describe the account/, k);
  setFeatureNames(null);
  try { assert.throws(() => withF({ relVol: 1 }), /feature names are not set/); } finally { setFeatureNames(STUB_FEATURES); }
});
test('free text from the user cannot get in: how a trade ended is one of a short list', () => {
  const entry = fold([base()]).get(base().id);
  assert.throws(() => markActual(entry, { r: 0.5, how: 'closed it early, news was coming' }), /must be one of/);
  assert.throws(() => markActual(entry, { r: '+£40', how: 'by-hand' }), /number of R/);
  assert.deepEqual(Object.keys(markActual(entry, { r: 0.8, how: 'by-hand', at: 9 })).sort(), ['account', 'at', 'how', 'id', 'r', 'type']);
});
test('a shown alert comes only from a live feed read, and keeps only allowed fields', () => {
  const rec = { ...recAt(C1315), caution: 'some gate text', lastStretch: false };
  const e = shownEvent(rec, { source: 'watch', method: METHOD, cfg, at: 1 });
  const ok = new Set([...ALLOWED.common, ...ALLOWED.shown]);
  for (const k of Object.keys(e)) assert.ok(ok.has(k), k);
  assert.deepEqual([e.id, e.feed, e.feedId, e.side, e.account], [`BTCUSD-M15-${C1315}`, 'Binance (BTCUSDT)', 'binance-vision', 'sell', 'demo']);
  assert.throws(() => shownEvent({ ...rec, sourceId: null }, { source: 'watch', method: METHOD, cfg }), /live feed read/);
  assert.throws(() => shownEvent(rec, { source: 'watch', method: methodOf({ version: 'm1', tf: 'M5' }), cfg }), /on M15 but the method is on M5/);
  assert.throws(() => shownEvent(rec, { source: 'watch', method: { targetRule: '1.5R', tf: 'M15' }, cfg }), /needs a version/);
  assert.throws(() => shownEvent(rec, { source: 'watch', method: METHOD, cfg: withDefaults({ account: { mode: 'paper' } }) }), /must be one of/);
});
test('each type needs its core fields; the id must match pair, timeframe and bar', () => {
  assert.throws(() => sanitize({ type: 'alert', id: 'whatever', at: 1 }), /needs/);
  assert.throws(() => sanitize({ ...base(), id: `BTCUSD-${C1315}` }), /needs the id BTCUSD-M15-/);
  assert.throws(() => sanitize({ ...base(), stopDist: 0 }), /stop and a target/);
  assert.throws(() => sanitize({ type: 'resolved', id: base().id, at: 1, account: 'demo', how: 'stop' }), /r and how/);
  assert.throws(() => sanitize({ type: 'taken', id: base().id, at: 1, how: 'named' }), /account mode/);
});
test('reading skips torn, non-object and invalid lines, and keeps the rest', () => {
  const path = join(tmp(), 'journal.jsonl');
  writeFileSync(path, ['null', '[]', '{"type":"alert","id":"whatever"}', JSON.stringify(base()), '{"type":"shown","id":"BTC'].join('\n'));
  assert.deepEqual(readEvents(path).map((e) => e.id), [base().id]);
  assert.equal(appendEvents(path, [mkShown({ closeMs: C1330 })]).added.length, 1);   // a null line does not crash the writer
  assert.deepEqual([...fold(readEvents(path)).keys()], [base().id, `BTCUSD-M15-${C1330}`]);
});

console.log('\nthe live-account question (rule 6)');
test('silent resolution under live settings writes no live line and leaves the question unasked', () => {
  const path = join(tmp(), 'journal.jsonl');
  const demoAlert = shownEvent(recAt(C1315), { source: 'watch', method: METHOD, cfg, at: C1315 + 20000 });
  appendEvents(path, [demoAlert]);
  assert.equal(needsLiveConsent(readEvents(path), live), true);
  const evs = resolveOpen(fold(readEvents(path)), BARS, live, { pair: 'BTCUSD', feed: FEED, nowMs: NOW });
  assert.deepEqual(evs.map((e) => e.account), ['demo']);       // the alert's own mode, not the settings'
  appendEvents(path, evs);
  assert.equal(needsLiveConsent(readEvents(path), live), true);
  assert.ok(readEvents(path).every((e) => e.account !== 'live'));
});
test('a live event is refused by every writer until the user says yes; "no" is recorded and holds', () => {
  const path = join(tmp(), 'journal.jsonl');
  const liveAlert = shownEvent(recAt(C1315), { source: 'watch', method: METHOD, cfg: live, at: C1315 + 20000 });
  assert.throws(() => appendEvents(path, [liveAlert]), (e) => e instanceof LiveConsentError && e.code === 'live-consent-needed');
  assert.equal(existsSync(path), false);
  const held = appendEvents(path, [liveAlert, mkShown({ closeMs: NEXT_DAY })], { liveWithoutConsent: 'hold' });
  assert.deepEqual([held.added.length, held.held.length], [1, 1]);
  // Silent resolution of a live alert is caught the same way.
  const res = resolveOpen(fold([liveAlert]), BARS, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: NOW });
  assert.deepEqual(res.map((e) => e.account), ['live']);
  assert.throws(() => appendEvents(path, res), LiveConsentError);
  appendEvents(path, [consentEvent({ answer: 'no', at: 1 })]);
  assert.equal(needsLiveConsent(readEvents(path), live), false);   // asked once; the answer stands
  assert.throws(() => appendEvents(path, [liveAlert]), (e) => e.code === 'live-refused');
  appendEvents(path, [consentEvent({ answer: 'yes', at: 2 })]);
  assert.equal(appendEvents(path, [liveAlert, ...res]).added.length, 2);
  assert.equal(foldConsent(readEvents(path)), 'yes');
});
test('the user\'s ticket, link and result carry the alert\'s mode, whatever the settings say now', () => {
  const entry = fold([mkShown({ closeMs: C1315, account: 'demo' })]).get(`BTCUSD-M15-${C1315}`);
  assert.equal(markTicketed(entry, { userPrice: 84100, at: 1 }).account, 'demo');
  assert.equal(markActual(entry, { r: 1, how: 'target', at: 2 }).account, 'demo');
  assert.equal(markTaken(new Map([[entry.id, entry]]), { alertId: entry.id, at: 3 }).event.account, 'demo');
});

console.log('\nthe log and the fold');
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = (xs, rand) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
test('the fold does not depend on the order of the lines (a union merge, a rebase)', () => {
  const id = `BTCUSD-M15-${C1315}`;
  const evs = [
    mkAlert({ closeMs: C1315, r: 0.62 }), mkAlert({ closeMs: C1315, r: 0.62, at: C1315 + 99999 }),   // the same bar computed twice
    mkShown({ closeMs: C1315, source: 'scan', at: C1315 + 5000 }), mkShown({ closeMs: C1315, source: 'watch', at: C1315 + 30000 }),
    mkShown({ closeMs: C1330, source: 'scan' }),
    markActual(fold([mkShown({ closeMs: C1315 })]).get(id), { r: 0.8, how: 'by-hand', at: 1000 }),
    markActual(fold([mkShown({ closeMs: C1315 })]).get(id), { r: 0.5, how: 'by-hand', at: 2000 }),   // the correction
    resolvedEv(id, -1), resolvedEv(id, 0.3, 'window', { at: 5 }),
    setSample({ plannedAlerts: 100, method: METHOD, committedAt: C1315 - 1, events: [] }),
  ];
  const once = fold(evs, { method: METHOD });
  const e = once.get(id);
  assert.deepEqual([e.shown.source, e.actual.r, e.shownOutcome.r, e.alert.at], ['watch', 0.5, 0.3, C1315 + 20000]);
  const rand = rng(7);
  for (let i = 0; i < 20; i++) {
    const evs2 = shuffle([...evs, ...evs.slice(0, 3)], rand);
    assert.deepEqual(fold(evs2, { method: METHOD }), once);
    assert.deepEqual(foldSample(evs2), foldSample(evs));
  }
});
test('the writer: a line once; the method\'s record once per bar and method; the watcher\'s record replaces a scan\'s', () => {
  const path = join(tmp(), 'journal.jsonl');
  const id = `BTCUSD-M15-${C1315}`;
  const scan = mkShown({ closeMs: C1315, source: 'scan', at: C1315 + 5000 }), watch = mkShown({ closeMs: C1315, source: 'watch' });
  assert.equal(appendEvents(path, [scan]).added.length, 1);
  assert.equal(appendEvents(path, [scan]).skipped, 1);
  assert.equal(appendEvents(path, [watch]).added.length, 1);
  assert.equal(appendEvents(path, [mkShown({ closeMs: C1315, source: 'scan', at: C1315 + 90000 })]).skipped, 1);
  assert.equal(fold(readEvents(path)).get(id).shown.source, 'watch');
  assert.equal(appendEvents(path, [mkAlert({ closeMs: C1315 })]).added.length, 1);
  assert.equal(appendEvents(path, [mkAlert({ closeMs: C1315, r: -1 })]).skipped, 1);       // first computation stands
  assert.equal(appendEvents(path, [mkAlert({ closeMs: C1315, method: methodOf({ version: 'm2', tf: 'M15' }) })]).added.length, 1);
});
test('a refused event writes nothing at all', () => {
  const path = join(tmp(), 'journal.jsonl');
  assert.throws(() => appendEvents(path, [base(), { type: 'actual', id: base().id, at: 1, account: 'demo', r: 1, how: 'target', balance: 5 }]), /may not be stored/);
  assert.equal(existsSync(path), false);
});
test('two commands appending at once keep every line (lock, temporary file, rename)', async () => {
  const dir = tmp();
  const path = join(dir, 'journal.jsonl');
  const child = join(dir, 'child.mjs');
  writeFileSync(child, `
    const [mod, path, tag, n] = process.argv.slice(2);
    const { appendEvents } = await import(mod);
    const method = { version: 'm1', targetRule: '1.5R', filter: 'none', tf: 'M15' };
    for (let i = 0; i < +n; i++) {
      const t = (+tag + i) * 900000;
      appendEvents(path, [{ type: 'shown', id: 'BTCUSD-M15-' + t, at: i, account: 'demo', pair: 'BTCUSD', tf: 'M15', source: 'watch', method, barCloseMs: t, side: 'buy', feedId: 'binance-vision', stopDist: 1, tp1Dist: 2 }]);
    }
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
  assert.deepEqual(readdirSync(dir).sort(), ['child.mjs', 'journal.jsonl']);   // no lock, temporary or moved-aside file left
});
test('a lock left by a command that died is taken over; a live one makes the writer wait, then give up', () => {
  const path = join(tmp(), 'journal.jsonl');
  writeFileSync(`${path}.lock`, '1');
  assert.throws(() => appendEvents(path, [base()], { timeoutMs: 60 }), /another command is writing/);
  const old = (Date.now() - 60000) / 1000;
  utimesSync(`${path}.lock`, old, old);
  assert.equal(appendEvents(path, [base()]).added.length, 1);
  assert.deepEqual(readdirSync(dirname(path)), ['journal.jsonl']);
});

console.log('\nthe method\'s record, on the reference feed');
test('the method is replayed serially over every window close; each alert scored at once', () => {
  const { alerts, days, pending: p } = canon();
  assert.deepEqual(alerts.map((a) => a.id), [`BTCUSD-M15-${C1315}`, `BTCUSD-M15-${NEXT_DAY}`]);   // 13:30–14:30 held back by the first
  assert.deepEqual(days.map((d) => [d.day, d.alerts]), [['2026-10-21', 1], ['2026-10-22', 1]]);
  assert.equal(Object.values(days[0].kinds).reduce((s, n) => s + n, 0), 32);                       // 08:00 … 15:45 London
  assert.deepEqual(p, []);
  const a = alerts[0], rec = recAt(C1315);
  assert.deepEqual([a.at, a.feed, a.feedId, a.side, a.tf], [C1315 + 20000, REF.label, REF.id, 'sell', 'M15']);
  assert.ok(!('account' in a));                                     // the method's record belongs to no account
  const o = outcome(BARS, kOf(C1315), rec, { spread: rec.spreadNum, comm: costFor('BTCUSD', 0, cfg).comm, closesAtMs: windowState(C1315, cfg.window).closesAtMs, tfMinutes: 15 });
  assert.deepEqual([a.outcome.how, a.outcome.r, a.outcome.bars, a.outcome.gap], [o.how, +o.r.toFixed(4), o.bars, false]);
});
test('the record is the same however it is run: day by day, from mid-day, with more bars, or a forming bar', () => {
  const whole = canon().events;
  const d1 = canon({ toMs: Date.UTC(2026, 9, 22) }).events;
  const d2 = canon({ fromMs: Date.UTC(2026, 9, 22), events: d1 }).events;
  assert.deepEqual([...d1, ...d2].sort((x, y) => (x.id < y.id ? -1 : 1)), [...whole].sort((x, y) => (x.id < y.id ? -1 : 1)));
  // A commitment at 11:00 still reads the day from its own start.
  assert.deepEqual(canon({ fromMs: Date.UTC(2026, 9, 21, 10, 0) }).events, whole);
  // …even when the journal already holds that day's alerts: the state is seeded from before the day.
  assert.deepEqual(canon({ fromMs: Date.UTC(2026, 9, 21, 13, 20), events: whole }).events, whole);
  // A bar still forming at nowMs is dropped; more history than a read uses changes nothing.
  const forming = [...BARS, { t: NOW - 5 * 60000, o: 1, h: 1e9, l: 1, c: 1 }];
  assert.deepEqual(canon({ bars: forming }).events, whole);
  assert.deepEqual(canon({ bars: BARS.slice(kOf(Date.UTC(2026, 9, 21, 7, 0)) - LOOKBACK) }).events, whole);
});
test('a day is all or nothing: still open, too little history, or bars not in yet', () => {
  const open = canon({ toMs: Date.UTC(2026, 9, 21, 12, 0) });
  assert.deepEqual([open.events, open.pending], [[], [{ day: '2026-10-21', pair: 'BTCUSD', why: 'window-open' }]]);
  const notYet = canon({ bars: BARS.slice(0, kOf(Date.UTC(2026, 9, 21, 14, 0)) + 1) });
  assert.deepEqual([notYet.events, notYet.pending.map((x) => x.why)], [[], ['not-yet', 'not-yet']]);
  const short = canon({ bars: BARS.slice(kOf(Date.UTC(2026, 9, 21, 7, 0)) - 100) });
  assert.deepEqual(short.pending.map((x) => [x.day, x.why]), [['2026-10-21', 'short-history'], ['2026-10-22', 'short-history']]);
  assert.throws(() => canon({ bars: F.bars.map(([t, o, h, l, c]) => ({ t, o, h, l, c })), fromMs: Date.UTC(2026, 9, 7), toMs: Date.UTC(2026, 9, 8) }), /held-back years/);
  assert.throws(() => canon({ method: { targetRule: '1.5R', tf: 'M15' } }), /needs a version/);
});
test('the method key holds the timeframe and the reference feeds; ids hold the timeframe', () => {
  const m5 = methodOf({ version: 'm1', tf: 'M5' });
  assert.notEqual(methodKey(m5), methodKey(METHOD));
  assert.notEqual(methodKey({ ...METHOD, feeds: { ...METHOD.feeds, BTCUSD: 'coinbase-btcusd' } }), methodKey(METHOD));
  assert.equal(methodKey({ version: 'm1', targetRule: '1.5R', filter: 'none', tf: 'M15' }), methodKey(METHOD));   // feeds default to the reference
  assert.notEqual(idOf('BTCUSD', 'M5', C1315), idOf('BTCUSD', 'M15', C1315));
  const evs = [mkAlert({ closeMs: C1315 }), mkAlert({ closeMs: C1315, method: m5 }), mkDay('BTCUSD', '2026-10-21')];
  const sample = { plannedAlerts: 100, method: METHOD, pairs: ['BTCUSD'], committedAt: C1315 - 1 };
  assert.equal(sampleStatus(evs, sample).count, 1);                // an M5 alert is not in an M15 sample
});

console.log('\nwhat the user was shown: scoring (silent)');
test('a shown alert is scored on the feed it names, with its own spread, once its window has closed', () => {
  const rec = recAt(C1315);
  const entries = fold([shownEvent(rec, { source: 'watch', method: METHOD, cfg, at: 1 })]);
  const [ev] = resolveOpen(entries, BARS, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: NOW });
  const o = outcome(BARS, kOf(C1315), rec, { spread: rec.spreadNum, comm: costFor('BTCUSD', 0, cfg).comm, closesAtMs: windowState(C1315, cfg.window).closesAtMs, tfMinutes: 15 });
  assert.deepEqual([ev.how, ev.r, ev.feed, ev.spreadNum, ev.scoring], [o.how, +o.r.toFixed(4), 'Binance (BTCUSDT)', rec.spreadNum, 'half']);
  assert.deepEqual(resolveOpen(fold([...entries.values()].map((e) => e.shown).concat([ev])), BARS, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: NOW }), []);
  assert.throws(() => resolveOpen(entries, BARS, cfg, { pair: 'BTCUSD', nowMs: NOW }), /needs opts.feed/);
  assert.throws(() => resolveOpen(entries, BARS, cfg, { feed: FEED }), /needs opts.pair/);
  assert.deepEqual(resolveOpen(entries, { XAUUSD: BARS }, cfg, { feed: FEED, nowMs: NOW }), []);   // gold's bars do not score bitcoin
  assert.equal(resolveOpen(entries, { BTCUSD: BARS }, cfg, { feed: { BTCUSD: FEED }, nowMs: NOW }).length, 1);
});
// Invented bars on Wed 9 Jan 2030 (GMT): the window closes at 16:00 UTC.
const T0 = Date.UTC(2030, 0, 9, 15, 0);
const bar = (t, o = 100, h = 100.5, l = 99.5, c = 100) => ({ t, o, h, l, c });
const buyAt1515 = () => fold([mkShown({ closeMs: T0 + M15, side: 'buy', stopDist: 10, tp1Dist: 15, spreadNum: 0, commNum: 0 })]);
test('the clock decides when a window is over, not the last bar: a forming bar never scores an alert', () => {
  // 15:00, 15:15, 15:30 closed; 15:45 still forming at 15:50.
  const bars = [bar(T0), bar(T0 + M15), bar(T0 + 2 * M15), bar(T0 + 3 * M15, 100, 100.2, 99.9, 100.1)];
  assert.deepEqual(resolveOpen(buyAt1515(), bars, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: T0 + 50 * 60000 }), []);
  assert.deepEqual(resolveOpen(buyAt1515(), bars, cfg, { pair: 'BTCUSD', feed: FEED }), []);                       // default: the real clock
  assert.equal(resolveOpen(buyAt1515(), bars, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: T0 + 61 * 60000 })[0].how, 'window');
});
test('a gap in the feed: no score from the next day\'s bars, and the result is flagged', () => {
  // The 15:30 and 15:45 bars are missing; the next bar is 08:00 the next day, through the stop.
  const bars = [bar(T0), bar(T0 + M15), bar(Date.UTC(2030, 0, 10, 8, 0), 100, 100, 80, 85)];
  const [ev] = resolveOpen(buyAt1515(), bars, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: Date.UTC(2030, 0, 10, 9) });
  assert.deepEqual([ev.how, ev.bars, ev.gap], ['window', 1, true]);       // closed at the 15:30 close, flagged
  // A missing bar between entry and exit is flagged too.
  const mid = [bar(T0), bar(T0 + M15), bar(T0 + 3 * M15)];
  const [ev2] = resolveOpen(buyAt1515(), mid, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: Date.UTC(2030, 0, 10, 9) });
  assert.deepEqual([ev2.how, ev2.gap], ['window', true]);
  // Bars not in yet: stays open.
  assert.deepEqual(resolveOpen(buyAt1515(), [bar(T0), bar(T0 + M15)], cfg, { pair: 'BTCUSD', feed: FEED, nowMs: Date.UTC(2030, 0, 10, 9) }), []);
});
test('a bar touching both the stop and the target is scored as half of each', () => {
  const bars = [bar(T0), bar(T0 + M15), bar(T0 + 2 * M15, 100, 200, 50, 100)];
  const entries = fold([mkShown({ closeMs: T0 + M15, side: 'buy', stopDist: 10, tp1Dist: 15, spreadNum: 1, commNum: 0 })]);
  const [ev] = resolveOpen(entries, bars, cfg, { pair: 'BTCUSD', feed: FEED, nowMs: Date.UTC(2030, 0, 9, 17) });
  const target = (15 - 1) / (10 + 1);
  assert.deepEqual([ev.bothTouched, ev.r], [true, +((target - 1) / 2).toFixed(4)]);
  const said = outcomeSentence(fold([...entries.values()].map((e) => e.shown).concat([ev])).get(ev.id), cfg);
  assert.equal(said, 'The 15:15 bitcoin buy alert touched its stop and its target in the same bar, so it counts as half of each (+0.14)');
});

console.log('\ntaken: only by an explicit link');
test('"took it" links to a ticket built within its freshness (30 minutes on M15, 15 on M5), and to nothing else', () => {
  assert.deepEqual([TAKEN_WITHIN_MS, takenWithinMs('M15'), takenWithinMs('M5')], [30 * 60000, 30 * 60000, 15 * 60000]);
  const t = C1315 + 2 * 60000;
  const a = mkShown({ closeMs: C1315 }), b = mkShown({ closeMs: C1330 });
  const ticketed = markTicketed(fold([a]).get(a.id), { userPrice: 84123.45, stopLoss: 84700, takeProfit: 83300, at: t });
  assert.deepEqual(Object.keys(ticketed).sort(), ['account', 'at', 'id', 'stopLoss', 'takeProfit', 'type', 'userPrice']);
  const entries = fold([a, b, ticketed]);
  const ok = markTaken(entries, { tf: 'M15', nowMs: t + 10 * 60000 });
  assert.deepEqual([ok.ok, ok.event.id, ok.event.how], [true, a.id, 'ticket']);
  assert.deepEqual(markTaken(entries, { tf: 'M15', nowMs: t + 31 * 60000 }), { ok: false, reason: 'no-ticket' });
  assert.deepEqual(markTaken(entries, { tf: 'M5', nowMs: t + 16 * 60000 }), { ok: false, reason: 'no-ticket' });
});
test('a ticket already taken is not a candidate again; a second trade 15 minutes later links cleanly', () => {
  const a = mkShown({ closeMs: C1315 }), b = mkShown({ closeMs: C1330 });
  const ta = markTicketed(fold([a]).get(a.id), { userPrice: 1, at: C1315 + 60000 });
  const taken = markTaken(fold([a, ta]), { tf: 'M15', nowMs: C1315 + 120000 }).event;
  const tb = markTicketed(fold([b]).get(b.id), { userPrice: 1, at: C1315 + 16 * 60000 });
  const r = markTaken(fold([a, b, ta, taken, tb]), { tf: 'M15', nowMs: C1315 + 17 * 60000 });
  assert.deepEqual([r.ok, r.event.id], [true, b.id]);
});
test('never by recency; two fresh tickets are asked about; an alert never sent cannot be taken', () => {
  const a = mkShown({ closeMs: C1315 }), b = mkShown({ closeMs: C1330 });
  assert.deepEqual(markTaken(fold([a, b]), { tf: 'M15', nowMs: C1330 + 60000 }), { ok: false, reason: 'no-ticket' });
  const two = fold([a, b, markTicketed(fold([a]).get(a.id), { userPrice: 1, at: C1315 + 60000 }), markTicketed(fold([b]).get(b.id), { userPrice: 1, at: C1330 + 60000 })]);
  assert.deepEqual(markTaken(two, { tf: 'M15', nowMs: C1330 + 120000 }), { ok: false, reason: 'ambiguous', candidates: [a.id, b.id] });
  const r = markTaken(fold([a]), { alertId: a.id, at: 5 });
  assert.deepEqual([r.ok, r.event.how, r.event.id], [true, 'named', a.id]);
  assert.deepEqual(markTaken(fold([a]), { alertId: 'BTCUSD-M15-1' }), { ok: false, reason: 'no-alert' });
  assert.deepEqual(markTaken(fold([mkAlert({ closeMs: NEXT_DAY })]), { alertId: `BTCUSD-M15-${NEXT_DAY}` }), { ok: false, reason: 'not-shown' });
  assert.throws(() => markTicketed(fold([mkAlert({ closeMs: NEXT_DAY })]).get(`BTCUSD-M15-${NEXT_DAY}`), { userPrice: 1 }), /never sent/);
  assert.throws(() => markTaken(fold([a]), {}), /needs an alert id, or a timeframe/);
});

console.log('\nthe committed sample');
// Weekdays from Mon 2 Nov 2026 (GMT), `perDay` alerts a day from 10:00 UTC, each day checked.
const weekdays = (n, from = Date.UTC(2026, 10, 2)) => {
  const out = [];
  for (let t = from; out.length < n; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
};
const COMMIT = Date.UTC(2026, 10, 2, 9, 0);
const sampleOf = (rs, { perDay = 2, N = rs.length, method = METHOD, extra = [], dropDays = [] } = {}) => {
  const days = weekdays(Math.ceil(rs.length / perDay));
  const evs = rs.map((r, i) => mkAlert({ closeMs: days[Math.floor(i / perDay)] + (10 + (i % perDay)) * 3600e3, r, method }));
  for (const d of days) if (!dropDays.includes(dayStr(d))) evs.push(mkDay('BTCUSD', dayStr(d), perDay, method));
  evs.push(setSample({ plannedAlerts: N, method: METHOD, pairs: ['BTCUSD'], committedAt: COMMIT, events: [] }));
  return [...evs, ...extra];
};
const wave = (n, a, b) => Array.from({ length: n }, (_, i) => (i % 2 ? a : b));
// Alternating by day (two a day), so the days differ and the clustered range has width.
const byDay = (n, a, b, perDay = 2) => Array.from({ length: n }, (_, i) => (Math.floor(i / perDay) % 2 ? a : b));
test('at N, over 30 or more days: lower bound above zero is evidence of an edge, not proof', () => {
  const st = sampleStatus(sampleOf(byDay(100, 1.4, 0.2)));
  assert.deepEqual([st.complete, st.days, st.verdict, st.verdictText], [true, 50, 'edge', 'evidence of an edge, not proof']);
  assert.ok(st.range[1] > st.range[0]);
  assert.ok(st.range[0] > 0);
});
test('at N: upper bound below zero is evidence against; a range across zero is break-even', () => {
  const against = sampleStatus(sampleOf(byDay(100, -1, -0.4)));
  assert.deepEqual([against.verdict, against.verdictText], ['against', VERDICTS.against]);
  assert.ok(against.range[1] < 0);
  const even = sampleStatus(sampleOf(byDay(100, 1.48, -1)));
  assert.deepEqual([even.verdict, even.verdictText], ['break-even', 'not distinguishable from break-even']);
  assert.ok(even.range[0] < 0 && even.range[1] > 0);
});
test('the range is clustered by London day with the small-sample correction G/(G−1)', () => {
  const rs = [...wave(60, 1.48, -1), ...wave(40, 0.3, -0.2)];
  const st = sampleStatus(sampleOf(rs, { perDay: 3 }));
  const days = weekdays(34);
  const raw = clusteredByDay(rs.map((r, i) => ({ at: new Date(days[Math.floor(i / 3)]).toISOString(), r })));
  assert.equal(st.days, 34);
  assert.ok(Math.abs(st.se - raw.seDay * Math.sqrt(34 / 33)) < 1e-12);
  assert.ok(Math.abs(st.range[0] - (raw.mean - 1.96 * st.se)) < 1e-12);
});
test('few days: no verdict, however good; the judged set runs on until it spans 30 days', () => {
  const tenDays = sampleOf(wave(100, 1.4, -1), { perDay: 10 });
  const st = sampleStatus(tenDays);
  assert.deepEqual([st.count, st.days, st.tooFewDays, st.complete, st.verdict], [100, 10, true, false, null]);
  // One day, five alerts, would once have read as an edge with a zero-width range.
  const d0 = weekdays(1)[0];
  const oneDay = [[1.4, -1, 1.4, -1, 0.1].map((r, i) => mkAlert({ closeMs: d0 + (8 + i) * 3600e3, r })), mkDay('BTCUSD', dayStr(d0), 5)].flat();
  const one = sampleStatus(oneDay, { plannedAlerts: 5, method: METHOD, pairs: ['BTCUSD'], committedAt: COMMIT - 3600e3 });
  assert.deepEqual([one.days, one.range, one.verdict], [1, null, null]);
  // Twenty more days of one alert each: the judged set reaches 30 days at 120 alerts.
  const more = weekdays(30).slice(10).map((d) => mkAlert({ closeMs: d + 10 * 3600e3, r: 1.2 }));
  const st2 = sampleStatus([...tenDays, ...more, ...weekdays(30).slice(10).map((d) => mkDay('BTCUSD', dayStr(d), 1))]);
  assert.deepEqual([st2.judged, st2.days, st2.complete], [120, 30, true]);
  assert.equal(MIN_VERDICT_DAYS, 30);
});
test('a weekday not yet checked on the feed holds the verdict back, so a late check cannot change the N judged', () => {
  const st = sampleStatus(sampleOf(byDay(100, 1.4, 0.2), { dropDays: ['2026-11-11'] }));
  assert.deepEqual([st.complete, st.verdict, st.uncovered], [false, null, ['2026-11-11 BTCUSD']]);
  const before = sampleStatus(sampleOf(wave(60, 1.4, 0.9), { N: 100, dropDays: ['2026-11-11'] }));
  assert.deepEqual(before.uncovered, ['2026-11-11 BTCUSD']);
});
test('only the method\'s record counts: not what the watcher sent, not scans, not before commitment, not gaps', () => {
  const rs = wave(100, 1.4, 0.9);
  const baseline = sampleStatus(sampleOf(rs));
  const shownMany = weekdays(50).flatMap((d) => [mkShown({ closeMs: d + 13 * 3600e3 }), mkShown({ closeMs: d + 14 * 3600e3, source: 'scan' })]);
  assert.deepEqual(sampleStatus(sampleOf(rs, { extra: shownMany })), baseline);
  const st = sampleStatus(sampleOf(rs, { N: 150, extra: [
    mkAlert({ closeMs: COMMIT - DAY }),                                       // before the commitment
    mkAlert({ closeMs: COMMIT + 6 * 3600e3, method: methodOf({ version: 'm1', targetRule: '2R', tf: 'M15' }) }),
    mkAlert({ closeMs: COMMIT + 7 * 3600e3, gap: true }),                      // across a feed gap
  ] }));
  assert.deepEqual([st.count, st.gapped], [100, 1]);
});
test('committing: at least 100 alerts, after the held-back years, and no restart of a sample in progress', () => {
  const evs = sampleOf(wave(60, 1.4, 0.9), { N: 100 });
  assert.equal(DEFAULT_PLANNED_ALERTS, 190);
  assert.equal(MIN_PLANNED_ALERTS, 100);
  assert.throws(() => setSample({ plannedAlerts: 99, method: METHOD, events: [] }), /at least 100/);
  assert.throws(() => setSample({ method: METHOD }), /journal's events/);
  assert.throws(() => setSample({ method: METHOD, events: [], committedAt: HOLDOUT.toMs }), /held-back/);
  assert.throws(() => setSample({ method: METHOD, events: evs, committedAt: NOW + 60 * DAY }), /no verdict yet; it ends only when the method changes/);
  assert.throws(() => setSample({ method: METHOD, events: evs, committedAt: NOW + 60 * DAY, replaces: 'method-changed' }), /method is unchanged/);
  const m2 = methodOf({ version: 'm2', tf: 'M15' });
  const s2 = setSample({ method: m2, events: evs, committedAt: Date.UTC(2027, 0, 4), replaces: 'method-changed' });
  const after = [...evs, s2];
  assert.deepEqual(foldSamples(after).map((s) => s.id), [`sample-${COMMIT}`, `sample-${Date.UTC(2027, 0, 4)}`]);
  const old = sampleStatus(after, foldSamples(after)[0]);
  assert.deepEqual([old.ended, old.endedReason, old.verdict], [true, 'new-sample', null]);
  // A sample that reached its verdict may be followed by another, and keeps its verdict.
  const done = sampleOf(byDay(100, 1.4, 0.2));
  const next = setSample({ method: METHOD, events: done, committedAt: Date.UTC(2027, 3, 5) });
  assert.equal(sampleStatus([...done, next], foldSamples([...done, next])[0]).verdict, 'edge');
  assert.match(sampleQuestion(), /^Shall I judge the alerts on the next 190 of them, every alert scored on the price feed whether you take it or not, and give no verdict before then\?/);
});
test('the live method changing under a sample ends it, with no verdict', () => {
  const m2 = methodOf({ version: 'm2', tf: 'M15' });
  const evs = sampleOf(byDay(100, 1.4, 0.2), { extra: [mkShown({ closeMs: Date.UTC(2026, 10, 3, 13), method: m2 })] });
  const st = sampleStatus(evs);
  // Only the four alerts before the first one sent under the new method are this sample's.
  assert.deepEqual([st.ended, st.endedReason, st.count, st.complete, st.verdict], [true, 'method-changed', 4, false, null]);
  assert.match(summary(evs, { nowMs: Date.UTC(2027, 0, 20, 18), cfg }), /\*\*The alert sample\*\*: stopped at 4 of 100 because the method changed, so it gives no verdict\./);
});

console.log('\nwhat it says');
const at1015 = Date.UTC(2026, 9, 21, 9, 15);       // 10:15 London (BST)
const said = (o) => outcomeSentence(fold([mkShown({ closeMs: at1015 }), ...(o ? [resolvedEv(`BTCUSD-M15-${at1015}`, o.r, o.how)] : [])]).get(`BTCUSD-M15-${at1015}`), cfg);
test('an outcome is said in exactly one of rule 5\'s three forms, the time in London', () => {
  assert.equal(said({ r: 1.5, how: 'target' }), 'The 10:15 bitcoin sell alert reached its target (+1.5 times the risk)');
  assert.equal(said({ r: -1, how: 'stop' }), 'The 10:15 bitcoin sell alert hit its stop (−1)');
  assert.equal(said({ r: 0.3, how: 'window' }), 'The 10:15 bitcoin sell alert was closed at the end of the session (+0.3)');
  assert.equal(said({ r: -0.25, how: 'window' }), 'The 10:15 bitcoin sell alert was closed at the end of the session (−0.25)');
  assert.equal(said(null), 'The 10:15 bitcoin sell alert has not finished yet');
});
test('R is rounded half away from zero, and a value that is not a number is a dash', () => {
  assert.deepEqual([fmtR(1.4799), fmtR(-1), fmtR(0), fmtR(0.004), fmtR(-0.125), fmtR(0.125), fmtR(NaN), fmtR(undefined)], ['+1.48', '−1', '0', '0', '−0.13', '+0.13', '—', '—']);
});
// One Wednesday with every kind of entry.
const t = (h, m) => Date.UTC(2026, 9, 21, h, m);
const dayEvents = () => {
  const ids = (c, pair = 'BTCUSD') => idOf(pair, 'M15', c);
  const evs = [
    mkAlert({ closeMs: t(7, 15), r: 1.4823, how: 'target' }), mkShown({ closeMs: t(7, 15) }),                 // sent, in the record
    mkAlert({ closeMs: t(8, 30), side: 'buy', r: -1 }), mkShown({ closeMs: t(8, 30), side: 'buy' }),
    mkAlert({ closeMs: t(10, 0), r: 0.31, how: 'window' }), mkShown({ closeMs: t(10, 0) }),
    mkAlert({ closeMs: t(11, 45), r: -1 }),                                                                     // not sent to the user
    mkShown({ closeMs: t(12, 0), source: 'scan' }), resolvedEv(ids(t(12, 0)), 0.2, 'window'),                  // sent, not in the record
    mkAlert({ pair: 'XAUUSD', closeMs: t(13, 0), side: 'buy', r: 0.0813, how: 'window', stopDist: 3, tp1Dist: 4.5, spreadNum: 0.05 }),
    mkShown({ pair: 'XAUUSD', closeMs: t(13, 0), side: 'buy', stopDist: 3, tp1Dist: 4.5, spreadNum: 0.05 }),
    mkDay('BTCUSD', '2026-10-21', 4), mkDay('XAUUSD', '2026-10-21', 1),
    setSample({ plannedAlerts: 190, method: METHOD, committedAt: t(0, 0), events: [] }),
  ];
  const e = fold(evs).get(ids(t(7, 15)));
  evs.push(markTicketed(e, { userPrice: 84123.45, stopLoss: 84700.1, takeProfit: 83300.2, at: t(7, 17) }));
  evs.push(markTaken(fold(evs), { alertId: e.id, at: t(7, 18) }).event);
  evs.push(markActual(e, { r: 1.3, how: 'target', at: t(9, 0) }));
  return evs;
};
test('during the session on a weekday: process counts only, and rule 4\'s sentence', () => {
  const text = summary(dayEvents(), { nowMs: t(13, 30), cfg });
  assert.ok(text.startsWith('**Today so far**'));
  assert.ok(text.endsWith(IN_SESSION_LINE));
  assert.match(text, /^- Alerts sent to you: 4 \(1 gold, 3 bitcoin\)$/m);
  assert.match(text, /^- Ideas from a one-off scan: 1$/m);
  assert.match(text, /^- Tickets you asked for: 1$/m);
  assert.match(text, /^- Trades you told me you took: 1$/m);
  assert.match(text, /^- Alert sample: 5 of 190, counted from the price feed after each session$/m);
  assert.doesNotMatch(text, /target|stop|risk|average|range|[+−]\d|verdict/i);
});
test('after the session: two blocks never added together; alerts not sent are never "missed"', () => {
  const text = summary(dayEvents(), { nowMs: t(16, 30), cfg });
  const blocks = text.split('\n\n');
  assert.match(blocks[0], /^\*\*The alerts\*\*: scored on Binance's and Twelve Data's prices, not your MT5 trades; your own result can differ\.$/m);
  assert.match(blocks[0], /^- The 08:15 bitcoin sell alert reached its target \(\+1\.48 times the risk\)$/m);
  assert.match(blocks[0], /^- The 09:30 bitcoin buy alert hit its stop \(−1\)$/m);
  assert.match(blocks[0], /^- The 11:00 bitcoin sell alert was closed at the end of the session \(\+0\.31\)$/m);
  assert.match(blocks[0], /^- The 14:00 gold buy alert was closed at the end of the session \(\+0\.08\)$/m);
  assert.match(blocks[0], /you were not sent, found afterwards on the price feed \(they count in the sample\):\n {2}- The 12:45 bitcoin sell alert hit its stop \(−1\)$/m);
  assert.match(blocks[0], /not in the method's record on the price feed \(not counted in the sample\):\n {2}- The 13:00 bitcoin sell alert was closed at the end of the session \(\+0\.2\)$/m);
  assert.match(blocks[1], /^\*\*Your trades\*\*: what you told me \(1 of them\)\.\n- Demo: 1 trade, on average \+1\.3 times the risk$/);
  assert.match(blocks[2], /^\*\*The alert sample\*\*: 5 of the 190 alerts you committed to, so far on average −0\.03 times the risk — too few days yet for a range\.$/m);
  assert.ok(blocks[2].endsWith(noVerdictLine(190)));
  assert.equal(blocks.length, 3);
  assert.doesNotMatch(text, /missed/i);
});
test('a day not yet checked on the feed: shown alerts listed with the rest, and the day named', () => {
  const evs = dayEvents().filter((e) => e.type !== 'day');
  const text = summary(evs, { nowMs: t(16, 30), cfg });
  assert.match(text, /^- The 13:00 bitcoin sell alert was closed at the end of the session \(\+0\.2\)$/m);
  assert.match(text, /^- Not yet checked on the price feed: Wed 21 Oct \(bitcoin, gold\)\.$/m);
  assert.doesNotMatch(text, /not in the method's record/);
});
test('the default period is the latest session day: the next morning, and at the weekend', () => {
  const evs = dayEvents();
  for (const nowMs of [Date.UTC(2026, 9, 22, 6, 30), Date.UTC(2026, 9, 21, 22, 0)]) {
    assert.match(summary(evs, { nowMs, cfg }), /^- The 08:15 bitcoin sell alert reached its target/m, new Date(nowMs).toISOString());
  }
  const fri = [mkAlert({ closeMs: Date.UTC(2026, 9, 23, 9, 0), r: -1 }), mkDay('BTCUSD', '2026-10-23', 1)];
  assert.match(summary(fri, { nowMs: Date.UTC(2026, 9, 25, 12, 0), cfg }), /- The 10:00 bitcoin sell alert hit its stop \(−1\)/);
});
test('a period of several days names the day on each line', () => {
  const evs = [mkAlert({ closeMs: t(13, 15), r: 1.48 }), mkShown({ closeMs: t(13, 15) }), mkAlert({ closeMs: Date.UTC(2026, 9, 22, 13, 15), r: -1 }), mkShown({ closeMs: Date.UTC(2026, 9, 22, 13, 15) })];
  const text = summary(evs, { nowMs: Date.UTC(2026, 9, 24, 12), cfg, fromMs: Date.UTC(2026, 9, 19), toMs: Date.UTC(2026, 9, 24) });
  assert.match(text, /^- On Wed 21 Oct, the 14:15 bitcoin sell alert reached its target \(\+1\.48 times the risk\)$/m);
  assert.match(text, /^- On Thu 22 Oct, the 14:15 bitcoin sell alert hit its stop \(−1\)$/m);
});
test('with nothing to show: no feed name is invented, and with no sample it says there is no verdict', () => {
  const text = summary([], { nowMs: Date.UTC(2026, 9, 24, 12, 0), cfg });
  assert.match(text, /^\*\*The alerts\*\*: scored on the price feed, not your MT5 trades/);
  assert.match(text, /^- No alerts in this period\.$/m);
  assert.match(text, /\*\*The alert sample\*\*: none committed yet, so there is no verdict to give\.$/);
  assert.throws(() => summary([], { nowMs: 1 }), /needs the settings/);
});
test('the verdict, once complete, is said in the declared words', () => {
  const evs = sampleOf(byDay(100, 1.48, -1));
  const text = summary(evs, { nowMs: Date.UTC(2027, 0, 20, 18), cfg });
  assert.match(text, /\*\*The alert sample\*\*: complete — 100 alerts over 50 days, on average \+0\.24 times the risk \(range −0\.\d+ to \+0\.\d+, clustered by day\)\. Verdict: not distinguishable from break-even\.$/);
  assert.doesNotMatch(text, /No verdict until/);
});
test('never "won", "lost", "you made", "missed", pounds, or a feed price, in any summary', () => {
  const evs = dayEvents();
  const texts = [[13, 30], [16, 30], [20, 0]].map(([h, m]) => summary(evs, { nowMs: t(h, m), cfg }));
  texts.push(summary(sampleOf(wave(100, 1.4, 0.9)), { nowMs: Date.UTC(2027, 0, 20, 18), cfg }));
  for (const x of texts) {
    assert.doesNotMatch(x, FORBIDDEN_WORDS);
    assert.doesNotMatch(x, PRICE_LEVEL);
  }
  for (const r of [1.5, -1, 0.3]) assert.doesNotMatch(said({ r, how: r === 1.5 ? 'target' : r === -1 ? 'stop' : 'window' }), FORBIDDEN_WORDS);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed (${readsMade} engine reads)`);
process.exit(failed ? 1 : 0);
