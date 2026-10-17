/**
 * The journal wired into the desk (desk/desk.mjs with desk/journal.mjs), end
 * to end through the command line: what watch and scan record, what take,
 * plan took and journal result add, what `journal` says in and after the
 * session, the method's own record with `journal update`, the live-account
 * question, the silent update's time limit, and the learning layer's words.
 *
 * Bars are the recorded Binance BTCUSDT fifteen-minute candles
 * (fixtures/btc-m15.json) with a copy of themselves prepended, so every check
 * has the watcher's 999 bars behind it, moved two weeks later (Wed 7 Oct →
 * Wed 21 Oct 2026, both in British Summer Time): the journal starts after the
 * held-back years. Every desk has its own temporary home, config and journal;
 * $SCALP_DESK_BARS stands in for the feeds, naming Binance as the one its
 * bars stand for. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWED, FORBIDDEN, sanitize, setFeatureNames, IN_SESSION_LINE } from '../desk/journal.mjs';
import { FEATURE_NAMES } from '../desk/features.mjs';
import { METHOD_VERSION, TARGET_RULE } from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { buildRows } from '../desk/dataset.mjs';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); }
  });
};

const here = dirname(fileURLToPath(import.meta.url));
const DESK = join(here, '..', 'desk', 'desk.mjs');
const REAL_JOURNAL = join(here, '..', 'desk', 'journal.jsonl');
const realBefore = existsSync(REAL_JOURNAL) ? statSync(REAL_JOURNAL).mtimeMs : null;
const F = JSON.parse(readFileSync(join(here, 'fixtures', 'btc-m15.json'), 'utf8'));
const M15 = 15 * 60000, DAY = 86400e3;
const RAW = F.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
// The fixture with a scaled copy of itself before it (no price jump at the seam), two weeks later.
const LONG = (() => {
  const span = RAW.length * M15, s = RAW[0].o / RAW[RAW.length - 1].c;
  return [...RAW.map((b) => ({ ...b, t: b.t - span, o: b.o * s, h: b.h * s, l: b.l * s, c: b.c * s })), ...RAW].map((b) => ({ ...b, t: b.t + 14 * DAY }));
})();
const ALERT_CLOSE = Date.UTC(2026, 9, 21, 13, 15);          // Wed 21 Oct, 14:15 London: the watcher's sell (live.test.mjs, two weeks on)
const FOOTER = '_From the live chart, not your screenshot, and not your broker\'s price. It has no live record yet, and the decision is yours._';
const MONEY_WORDS = /£|\bwon\b|\blost\b|you made|\bprofit|\bloss(es)?\b/i;
setFeatureNames(FEATURE_NAMES);

/** A desk of its own: temporary home, config and journal; the test feeds named as Binance's. */
function desk({ bars = LONG, config = {}, sources = { BTCUSD: 'binance-vision' } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'desk-journal-'));
  const barsFile = join(home, 'bars.json');
  const configFile = join(home, 'config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const setBars = (b) => writeFileSync(barsFile, JSON.stringify({ BTCUSD: b, ...(sources ? { sources } : {}) }));
  setBars(bars);
  const env = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_CONFIG: configFile, SCALP_DESK_BARS: barsFile, TWELVEDATA_API_KEY: '', SCALP_DESK_MODEL: join(home, 'model.json') };
  delete env.SCALP_DESK_JOURNAL;
  const run = (args, at, more = {}) => {
    try { return execFileSync('node', [DESK, ...args], { encoding: 'utf8', env: { ...env, SCALP_DESK_NOW: at, ...more }, timeout: 120000 }); } catch (x) { return `EXIT ${x.status ?? x.signal}\n${x.stdout}`; }
  };
  const journal = join(home, 'journal.jsonl');
  const events = () => (existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const config_ = () => JSON.parse(readFileSync(configFile, 'utf8'));
  return { home, run, journal, events, config: config_, setBars, env };
}
const reply = (out) => (out.split('--- reply ---\n')[1] || '').split('\n--- end ---')[0];
const iso = (ms) => new Date(ms).toISOString();
const of = (evs, type) => evs.filter((e) => e.type === type);
const keysOk = (e) => { const ok = new Set([...ALLOWED.common, ...ALLOWED[e.type]]); return Object.keys(e).every((k) => ok.has(k)); };
const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
function noForbidden(v, path = '') {
  if (Array.isArray(v)) return v.forEach((x, i) => noForbidden(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (path === 'features' || path.endsWith('.features')) assert.ok(FEATURE_NAMES.includes(k), `feature ${k}`);
    else assert.ok(!FORBIDDEN.includes(norm(k)), `${path}.${k} is forbidden`);
    noForbidden(x, path ? `${path}.${k}` : k);
  }
}
/** Every line of a journal file passes journal.mjs's own sanitiser, keeps only allowed fields, and names nothing forbidden. */
function privacyOk(d) {
  for (const e of d.events()) {
    assert.deepEqual(sanitize(e), e, `${e.type} ${e.id} is exactly what sanitize keeps`);
    assert.ok(keysOk(e), `${e.type} keys`);
    noForbidden(e);
  }
}

console.log('\nwhat the watcher sends is recorded, as sent');
test('watch: the alert goes out with the new footer and nothing about the learner; the journal gets a shown event with the method and the read\'s features', () => {
  const d = desk();
  const out = d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  assert.match(out, /STATUS: alert/);
  const r = reply(out);
  assert.match(r, /▼ Sell idea · Bitcoin · live M15 chart/);
  assert.ok(r.endsWith(FOOTER), r.slice(-200));
  assert.doesNotMatch(r, /similar|learn|model|in 100/i, 'nothing about the learner on an alert (rule 3)');
  assert.match(out, /^NOTE: the journal changed — pull with rebase, then commit and push .*journal\.jsonl\.$/m);
  const shown = of(d.events(), 'shown');
  assert.equal(shown.length, 1);
  const e = shown[0];
  assert.deepEqual([e.id, e.source, e.account, e.pair, e.tf, e.side, e.feedId, e.feed], [`BTCUSD-M15-${ALERT_CLOSE}`, 'watch', 'demo', 'BTCUSD', 'M15', 'sell', 'binance-vision', 'Binance (BTCUSDT)']);
  assert.deepEqual([e.method.version, e.method.targetRule, e.method.tf, e.method.filter], [String(METHOD_VERSION), TARGET_RULE, 'M15', 'none']);
  assert.deepEqual(Object.keys(e.method.costs), ['BTCUSD'], 'one instrument\'s line carries only its own costs');
  assert.deepEqual(Object.keys(e.features), [...FEATURE_NAMES], 'the features of the read that alerted, every name');
  assert.ok(Object.values(e.features).filter((x) => typeof x === 'number').length > 30);
  privacyOk(d);
});
test('scan: every idea it reports is recorded as source "scan"; the watcher\'s record of the same bar outranks it', () => {
  const d = desk();
  const out = d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  assert.match(reply(out), /▼ Sell idea · Bitcoin/);
  assert.deepEqual(of(d.events(), 'shown').map((e) => e.source), ['scan']);
  // The scan's alert state is the watcher's too: the same bar is not sent again.
  assert.doesNotMatch(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
  assert.equal(of(d.events(), 'shown').length, 1);
  const during = reply(d.run(['journal'], iso(ALERT_CLOSE + 3600e3)));
  assert.match(during, /^- Alerts sent to you: 0$/m);
  assert.match(during, /^- Ideas from a one-off scan: 1$/m);
  // With that state gone, the watcher sends the bar, and its record outranks the scan's.
  writeFileSync(join(d.home, 'watch', 'state.json'), JSON.stringify({ lastAlert: {} }));
  writeFileSync(join(d.home, 'watch', 'ideas.json'), '{}');
  assert.match(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
  assert.deepEqual(of(d.events(), 'shown').map((e) => e.source), ['scan', 'watch']);
  const after = reply(d.run(['journal'], iso(ALERT_CLOSE + 3600e3)));
  assert.match(after, /^- Alerts sent to you: 1$/m, 'counted once, as the watcher sent it');
  assert.doesNotMatch(after, /one-off scan/);
  privacyOk(d);
});
test('a stand-in feed names no price feed, so nothing read from it is recorded', () => {
  const d = desk({ sources: null });
  assert.match(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
  assert.equal(existsSync(d.journal), false);
});

console.log('\nwhat the user did');
test('take → ticketed (the MT5 prices only); plan took → taken through the ticket; journal in session gives counts only; after it, the outcome and their own trade', () => {
  const d = desk();
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  const shown = of(d.events(), 'shown')[0];
  // For take, the feed's "live" price is its newest bar: end the bars at the alert's own bar, so nothing has moved.
  const k = LONG.findIndex((b) => b.t + M15 === ALERT_CLOSE);
  d.setBars(LONG.slice(0, k + 1));
  const price = shown.refPrice + 25;
  const t = d.run(['take', '--price', String(price)], iso(ALERT_CLOSE + 60000));
  assert.match(t, /STATUS: done · ticket/);
  assert.match(reply(t), /MT5 ticket — SELL BTCUSD/);
  const tk = of(d.events(), 'ticketed');
  assert.equal(tk.length, 1);
  assert.deepEqual(Object.keys(tk[0]).sort(), ['account', 'at', 'id', 'stopLoss', 'takeProfit', 'type', 'userPrice']);
  assert.equal(tk[0].userPrice, price);
  assert.ok(Math.abs(tk[0].stopLoss - (price + shown.stopDist)) < 0.01 && Math.abs(tk[0].takeProfit - (price - shown.tp1Dist)) < 0.01, 'the ticket\'s levels from the user\'s price');
  d.setBars(LONG);
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 2 * 60000));
  const took = d.run(['plan', 'took'], iso(ALERT_CLOSE + 4 * 60000));
  assert.match(took, /1 of 3 trades/);
  assert.deepEqual(of(d.events(), 'taken').map((e) => [e.id, e.how, e.account]), [[shown.id, 'ticket', 'demo']]);
  // A second "took it" has no fresh ticket left: only the count changes.
  d.run(['plan', 'took'], iso(ALERT_CLOSE + 5 * 60000));
  assert.equal(of(d.events(), 'taken').length, 1);
  // In the session: counts only, and rule 4's sentence.
  const during = reply(d.run(['journal'], iso(ALERT_CLOSE + 45 * 60000)));
  assert.match(during, /^\*\*Today so far\*\*$/m);
  assert.match(during, /^- Alerts sent to you: 1$/m);
  assert.match(during, /^- Tickets you asked for: 1$/m);
  assert.match(during, /^- Trades you told me you took: 1$/m);
  assert.ok(during.endsWith(IN_SESSION_LINE));
  assert.doesNotMatch(during, /times the risk|target|stop/);
  // After it: the silent update scored the alert on the feed; two blocks, never added together.
  const evening = Date.UTC(2026, 9, 21, 18, 0);
  const after = reply(d.run(['journal'], iso(evening)));
  assert.equal(of(d.events(), 'resolved').length, 1, 'resolved silently, before the summary');
  assert.match(after, /^\*\*The alerts\*\*: scored on Binance's prices, not your MT5 trades; your own result can differ\.$/m);
  assert.match(after, /^- The 14:15 bitcoin sell alert (reached its target|hit its stop|was closed at the end of the session|touched its stop and its target)/m);
  assert.match(after, /^\*\*Your trades\*\*: what you told me \(0 of them\)\.$/m);
  assert.doesNotMatch(after, MONEY_WORDS);
  // Their own result, in R only: by its time, or as pounds against the ticket's risk.
  const res = d.run(['journal', 'result', '--alert', '14:15', '--pounds', '-40', '--risk', '80'], iso(evening + 60000));
  assert.match(res, /STATUS: done/);
  assert.equal(reply(res), 'Noted for your record: your trade on the 14:15 bitcoin sell alert, closed by hand (−0.5 times the risk).');
  const act = of(d.events(), 'actual');
  assert.deepEqual(act.map((e) => [e.r, e.how, e.account]), [[-0.5, 'by-hand', 'demo']]);
  assert.deepEqual(Object.keys(act[0]).sort(), ['account', 'at', 'how', 'id', 'r', 'type']);
  d.run(['journal', 'result', '--alert', 'last', '--how', 'stop'], iso(evening + 120000));
  assert.deepEqual(of(d.events(), 'actual').map((e) => e.r), [-0.5, -1], 'a correction is a later line; the latest stands');
  const final = reply(d.run(['journal'], iso(evening + 180000)));
  assert.match(final, /^\*\*Your trades\*\*: what you told me \(1 of them\)\.\n- Demo: 1 trade, on average −1 times the risk$/m);
  // A direct question about one named alert, in R.
  const one = reply(d.run(['journal', 'alert', '--alert', '14:15'], iso(evening + 240000)));
  assert.match(one, /^The 14:15 bitcoin sell alert .*\. On the way it went as far as [+−]?[\d.]+ times the risk in its favour and [−]?[\d.]+ against, over \d+ bars?\. Scored on Binance's prices, not your MT5 trade\.$/);
  privacyOk(d);
});
test('plan took --alert names the alert; journal took marks one without counting; an unknown alert is a question', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 60000));
  d.run(['plan', 'took', '--alert', '14:15', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 90000));
  assert.deepEqual(of(d.events(), 'taken').map((e) => e.how), ['named']);
  const d2 = desk();
  d2.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  const j = d2.run(['journal', 'took', '--alert', 'last'], iso(ALERT_CLOSE + 90000));
  assert.match(reply(j), /^Noted: you took the 14:15 bitcoin sell alert\.$/);
  assert.equal(existsSync(join(d2.home, 'plan.json')), false, 'the plan\'s count is not touched');
  assert.match(d2.run(['journal', 'result', '--alert', '09:00', '--r', '1'], iso(ALERT_CLOSE + 120000)), /STATUS: need-input[\s\S]*no alert sent at 09:00/);
});

console.log('\nthe live account (rule 6)');
test('config account=live asks the question in plain words; nothing live is written until the answer; the answer is a journal event', () => {
  const d = desk();
  const c = d.run(['config', 'account=live'], iso(ALERT_CLOSE - 3600e3));
  assert.match(c, /STATUS: changed · commit desk\/config\.json/);
  assert.equal(d.config().account.mode, 'live');
  const r = reply(c);
  assert.match(r, /- Account \*\*live\*\* · the alerts you are sent and your trades go in your record as live — once you say whether a live record may sit in the public repository/);
  assert.match(r, /May a record of your live-account alerts and trades sit there\?/);
  assert.match(r, /public repository on GitHub/);
  assert.match(r, /the account balance among them: rather than typing in your live balance, you can set a shadow balance/);
  assert.match(c, /^NOTE: when they answer, run: config livejournal=yes \(or no\)/m);
  // An alert under live with no answer yet: sent, but not written.
  const w = d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  assert.match(w, /STATUS: alert/);
  assert.match(w, /^NOTE: journal — a live-account entry was not written: the user has not said/m);
  assert.equal(of(d.events(), 'shown').length, 0);
  // "No": recorded, and live entries stay out.
  const no = d.run(['config', 'livejournal=no'], iso(ALERT_CLOSE + 60000));
  assert.match(no, /STATUS: changed · commit .*journal\.jsonl/);
  assert.match(reply(no), /Noted: nothing from your live account will go in your record\. Demo alerts and trades still do\./);
  assert.deepEqual(of(d.events(), 'consent').map((e) => e.answer), ['no']);
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  assert.equal(of(d.events(), 'shown').length, 0);
  // "Yes": a live record from then on.
  d.run(['config', 'livejournal=yes'], iso(ALERT_CLOSE + 120000));
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  assert.deepEqual(of(d.events(), 'shown').map((e) => e.account), ['live']);
  assert.match(reply(d.run(['config'], iso(ALERT_CLOSE))), /- Account \*\*live\*\* · the alerts you are sent and your trades go in your record as live$/m);
  assert.throws(() => execFileSync('node', [DESK, 'config', 'account=paper'], { env: { ...d.env, SCALP_DESK_NOW: iso(ALERT_CLOSE) }, stdio: 'pipe' }));
  privacyOk(d);
});
test('a trade on an alert shown under the other account: the reply asks which account, and the answer marks it', () => {
  const d = desk();
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));              // shown as demo
  d.run(['config', 'account=live'], iso(ALERT_CLOSE + 40000));
  const k = LONG.findIndex((b) => b.t + M15 === ALERT_CLOSE);
  d.setBars(LONG.slice(0, k + 1));
  const shown = of(d.events(), 'shown')[0];
  const t = d.run(['take', '--price', String(shown.refPrice + 25)], iso(ALERT_CLOSE + 60000));
  assert.match(t, /STATUS: done · ticket/);
  assert.match(reply(t), /MT5 ticket — SELL BTCUSD[\s\S]*That alert came while your settings said demo; they now say live\. Was this trade on your demo account or your live account\?$/);
  assert.equal(of(d.events(), 'ticketed').length, 0, 'not marked until they say');
  assert.match(t, /^NOTE: when they say which account it was, run: journal account demo \(or live\)\.$/m);
  const ans = d.run(['journal', 'account', 'demo'], iso(ALERT_CLOSE + 90000));
  assert.match(reply(ans), /^Noted: on your demo account\.$/);
  assert.deepEqual(of(d.events(), 'ticketed').map((e) => e.account), ['demo']);
  assert.match(reply(d.run(['journal', 'account', 'demo'], iso(ALERT_CLOSE + 95000))), /nothing waiting/);
  // journal result on the same alert asks too, and takes the answer as --account.
  const q = d.run(['journal', 'result', '--alert', 'last', '--r', '0.4'], Date.UTC(2026, 9, 21, 18) && iso(Date.UTC(2026, 9, 21, 18)));
  assert.match(q, /STATUS: need-input[\s\S]*Was this trade on your demo account or your live account\?/);
  assert.match(reply(d.run(['journal', 'result', '--alert', 'last', '--r', '0.4', '--account', 'demo'], iso(Date.UTC(2026, 9, 21, 18, 1)))), /\+0\.4 times the risk/);
  privacyOk(d);
});

console.log('\nthe method\'s own record');
test('journal sample asks the plan\'s question; on a yes it commits; journal update records each weekday on the reference feed, and journal reports the sample', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));   // the journal exists
  const q = d.run(['journal', 'sample'], iso(Date.UTC(2026, 9, 20, 6)));
  assert.match(q, /STATUS: need-input/);
  assert.equal(reply(q), 'Shall I judge the alerts on the next 190 of them, every alert scored on the price feed whether you take it or not, and give no verdict before then? Your own trades stay in \'Is it working yet?\', separately.');
  assert.match(reply(d.run(['journal', 'sample', '--alerts', '99'], iso(Date.UTC(2026, 9, 20, 6)))), /^Not committed: the sample needs a whole number of at least 100 alerts\.$/);
  const yes = d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  assert.match(reply(yes), /^Committed: I will judge the alerts on bitcoin on the next 100 of them/);
  const sample = of(d.events(), 'sample')[0];
  assert.deepEqual([sample.plannedAlerts, sample.pairs, sample.method.version], [100, ['BTCUSD'], String(METHOD_VERSION)]);
  // Saturday: Tuesday to Friday are recorded, one day at a time, from the 999 bars before each close.
  const sat = Date.UTC(2026, 9, 24, 12);
  const u = d.run(['journal', 'update'], iso(sat));
  assert.match(u, /STATUS: done/);
  assert.match(reply(u), /^Checked on the price feed: 4 days of bitcoin \(\d+ alerts?\)\./);
  const days = of(d.events(), 'day');
  assert.deepEqual(days.map((e) => e.day), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  assert.ok(days.every((e) => e.method.version === String(METHOD_VERSION) && e.pair === 'BTCUSD'));
  const alerts = of(d.events(), 'alert');
  assert.ok(alerts.length >= 1, 'the method sent alerts of its own that week');
  assert.deepEqual(days.map((e) => e.alerts).reduce((x, y) => x + y, 0), alerts.length, 'each day names its alerts');
  assert.ok(alerts.every((e) => e.feedId === 'binance-btcusdt' && e.method.version === String(METHOD_VERSION) && Object.keys(e.features).length === FEATURE_NAMES.length && Number.isFinite(e.outcome.r)));
  // The scan's 14:15 idea was scored too (resolution), on the same feed.
  assert.match(reply(u), /1 alert you were sent has finished and is scored\./);
  assert.equal(of(d.events(), 'resolved')[0].feed, 'Binance (BTCUSDT)');
  // Run again: nothing new (a recorded day is frozen).
  assert.match(reply(d.run(['journal', 'update'], iso(sat + 60000))), /^Nothing new to check on the price feed\./);
  const text = reply(d.run(['journal'], iso(sat + 120000)));
  assert.match(text, new RegExp(`\\*\\*The alert sample\\*\\*: ${alerts.length} of the 100 alerts you committed to`));
  assert.match(text, /No verdict until all 100 are in/);
  assert.doesNotMatch(text, MONEY_WORDS);
  privacyOk(d);
});
test('the desk\'s method changing stops the sample at once, and the desk says so', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  d.run(['config', 'timeframe=M5'], iso(Date.UTC(2026, 9, 24, 12)));
  const text = reply(d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 5))));
  assert.match(text, /\*\*The alert sample\*\*: stopped at 0 of 100 because the desk's method changed after you committed to it/);
});

console.log('\nthe silent update');
test('now with a stalled feed: the reply is unchanged and out within the time limit; nothing fails, no line is added', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));     // an alert to score, so the update reaches for the feed
  const stub = join(d.home, 'stall.mjs');
  writeFileSync(stub, 'globalThis.fetch = () => new Promise(() => {});\n');
  const env = { ...d.env, SCALP_DESK_NOW: iso(Date.UTC(2026, 9, 21, 18)), NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' };
  delete env.SCALP_DESK_BARS;                                          // the real history path, with fetch stalled
  const quiet = desk();
  const plain = execFileSync('node', [DESK, 'now'], { encoding: 'utf8', env: { ...quiet.env, SCALP_DESK_NOW: env.SCALP_DESK_NOW, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  const t0 = Date.now();
  const r = spawnSync('node', ['--import', pathToFileURL(stub).href, DESK, 'now'], { encoding: 'utf8', env, timeout: 30000 });
  const took = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, plain, 'the same reply, and no line added');
  assert.ok(took < 9000, `ended within the limit (${took} ms)`);
  assert.equal(of(d.events(), 'resolved').length, 0);
});
test('now and brief score a finished alert silently, before the next look', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  const out = d.run(['brief'], iso(Date.UTC(2026, 9, 22, 6)));
  assert.match(out, /^STATUS: info\n--- reply ---/, 'no NOTE, nothing but the brief');
  assert.equal(of(d.events(), 'resolved').length, 1);
});

test('the silent update leaves no line even when it holds a live entry back', () => {
  const d = desk();
  d.run(['config', 'account=live', 'livejournal=yes'], iso(ALERT_CLOSE));
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));                  // shown under live, with the user's yes
  d.run(['config', 'livejournal=no'], iso(ALERT_CLOSE + 60000));                    // then they change their mind
  const out = d.run(['brief'], iso(Date.UTC(2026, 9, 22, 6)));
  assert.match(out, /^STATUS: info\n--- reply ---/, 'no NOTE about the held entry');
  assert.equal(of(d.events(), 'resolved').length, 0, 'the live result is not written');
});

console.log('\nthe learning layer, on request only');
test('learn status, report and similar say where it stands, in plain words, and refuse the held-back years', async () => {
  const d = desk();
  assert.match(reply(d.run(['learn', 'status'], iso(ALERT_CLOSE))), /^The learning layer has not been built yet for bitcoin: nothing has been fitted to past prices/);
  assert.match(reply(d.run(['learn', 'report'], iso(ALERT_CLOSE))), /^\*\*Bitcoin on past prices: not tested yet\*\*/);
  assert.match(d.run(['learn', 'similar', '--at', '2025-06-04T10:15'], iso(ALERT_CLOSE)), /STATUS: refused[\s\S]*held back for the learner's one test/);
  assert.match(reply(d.run(['learn', 'similar', '--at', '2024-10-09T09:15'], iso(ALERT_CLOSE))), /has not been built yet/);
  // With development rows (the recorded bars moved back two years), similar setups in the plan's words.
  const dev = RAW.map((b) => ({ ...b, t: b.t - 728 * DAY }));
  const cfg = withDefaults({});
  await buildRows({ pair: 'BTCUSD', bars: dev, fromMs: dev[0].t, toMs: dev[dev.length - 1].t + M15, cfg, cost: 'scaled', calendar: 'rules', source: 'binance', home: d.home, workers: 1 });
  const past = reply(d.run(['learn', 'similar', '--at', '2024-10-10T13:15'], iso(ALERT_CLOSE)));
  assert.match(past, /^On bitcoin's 2024 prices, of the \d+ moments most like this one \(from \d+ different days\), for a standard (buy|sell), \d+ in 100 reached the target, \d+ hit the stop, and the rest were closed at the end of the session/);
  assert.match(past, /That describes the past; it is not a forecast for this trade\./);
  // A moment from now on, described from the reference feed's bars up to it.
  const now = reply(d.run(['learn', 'similar', '--at', iso(ALERT_CLOSE).slice(0, 16), '--side', 'sell'], iso(ALERT_CLOSE + 3600e3)));
  assert.match(now, /^On bitcoin's 2024 prices, of the \d+ moments most like this one .* for a standard sell, /);
  assert.doesNotMatch(now, /won|lost|£/);
});

console.log('\nisolation');
test('no test here wrote the real desk/journal.jsonl', () => {
  assert.equal(existsSync(REAL_JOURNAL) ? statSync(REAL_JOURNAL).mtimeMs : null, realBefore);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
