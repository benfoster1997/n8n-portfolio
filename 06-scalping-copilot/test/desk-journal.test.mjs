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
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWED, FORBIDDEN, sanitize, setFeatureNames, IN_SESSION_LINE } from '../desk/journal.mjs';
import { FEATURE_NAMES } from '../desk/features.mjs';
import { METHOD_VERSION, TARGET_RULE } from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { buildRows } from '../desk/dataset.mjs';
import { goldOnBreak, fromForBars } from '../desk/history.mjs';
import { CLOSED_BARS } from '../desk/live.mjs';

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
function desk({ bars = LONG, config = {}, sources = { BTCUSD: 'binance-vision' }, gold = null, more = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'desk-journal-'));
  const barsFile = join(home, 'bars.json');
  const configFile = join(home, 'config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const setBars = (b) => writeFileSync(barsFile, JSON.stringify({ BTCUSD: b, ...(gold ? { XAUUSD: gold } : {}), ...more, ...(sources ? { sources } : {}) }));
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
  assert.match(out, /^NOTE: the journal changed — commit .*journal\.jsonl, then git pull --rebase, then push\.$/m, 'commit first: git refuses a rebase pull over changes not committed');
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
  // Another machine's watcher, which saw neither the scan nor its journal line, sends the bar; the two
  // journals are merged (a union merge puts the lines together), and the watcher's record outranks the scan's.
  const scanLines = readFileSync(d.journal, 'utf8');
  rmSync(d.journal);
  writeFileSync(join(d.home, 'watch', 'state.json'), JSON.stringify({ lastAlert: {} }));
  writeFileSync(join(d.home, 'watch', 'ideas.json'), '{}');
  assert.match(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
  writeFileSync(d.journal, scanLines + readFileSync(d.journal, 'utf8'));
  assert.deepEqual(of(d.events(), 'shown').map((e) => e.source), ['scan', 'watch']);
  const after = reply(d.run(['journal'], iso(ALERT_CLOSE + 3600e3)));
  assert.match(after, /^- Alerts sent to you: 1$/m, 'counted once, as the watcher sent it');
  assert.doesNotMatch(after, /one-off scan/);
  privacyOk(d);
});
test('after a restart that lost the watcher\'s files, its last alert comes back from the journal: no second alert while the first is still running', () => {
  const d = desk();
  assert.match(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
  // With its state kept, the next bar is quiet (the alert is still running).
  assert.match(d.run(['watch', '--pair', 'bitcoin', '--once'], iso(ALERT_CLOSE + M15 + 20000)), /STATUS: quiet/);
  // The container reclaimed: the home's files gone, the journal (committed) kept.
  rmSync(join(d.home, 'watch'), { recursive: true, force: true });
  assert.match(d.run(['watch', '--pair', 'bitcoin', '--once'], iso(ALERT_CLOSE + M15 + 20000)), /STATUS: quiet/);
  const state = JSON.parse(readFileSync(join(d.home, 'watch', 'state.json'), 'utf8'));
  assert.equal(state.lastAlert.BTCUSD.barCloseMs, ALERT_CLOSE);
  assert.equal(of(d.events(), 'shown').length, 1);
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
  // "last" again, on an alert that has their result: asked first (a second trade?), and nothing written.
  const again = d.run(['journal', 'result', '--alert', 'last', '--how', 'stop'], iso(evening + 120000));
  assert.match(again, /STATUS: need-input/);
  assert.equal(reply(again), 'You told me that trade ended at −0.5. Is this a different trade?');
  assert.equal(of(d.events(), 'actual').length, 1);
  // Their word that it corrects the same trade: --replace.
  d.run(['journal', 'result', '--alert', 'last', '--how', 'stop', '--replace'], iso(evening + 150000));
  assert.deepEqual(of(d.events(), 'actual').map((e) => e.r), [-0.5, -1], 'a correction is a later line; the latest stands');
  const final = reply(d.run(['journal'], iso(evening + 180000)));
  assert.match(final, /^\*\*Your trades\*\*: what you told me \(1 of them\)\.\n- Demo: 1 trade, on average −1 times the risk$/m);
  // A direct question about one named alert, in R.
  const one = reply(d.run(['journal', 'alert', '--alert', '14:15'], iso(evening + 240000)));
  assert.match(one, /^The 14:15 bitcoin sell alert .*\. On the way it went as far as [+−]?[\d.]+ times the risk in its favour and [−]?[\d.]+ against, over \d+ bars?\. Scored on Binance's prices, not your MT5 trade\.$/);
  privacyOk(d);
});
test('plan took --alert to an older or ambiguous alert: the NOTE names journal took (the count is already done), and following it leaves the plan count unchanged', () => {
  const planCount = (d) => JSON.parse(readFileSync(join(d.home, 'plan.json'), 'utf8')).taken;
  const notPlanTook = (out) => { for (const n of out.split('\n').filter((l) => l.startsWith('NOTE:'))) assert.doesNotMatch(n, /plan took/, n); };
  // Older: the 14:15 alert of Wednesday, named by its time on Friday.
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  const fri = Date.UTC(2026, 9, 23, 9);
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(fri));
  const old = d.run(['plan', 'took', '--alert', '14:15'], iso(fri + 60000));
  assert.match(reply(old), /1 of 3 trades[\s\S]*The 14:15 bitcoin sell alert on Wed 21 Oct is the one I have\. Was your trade on that alert\?/);
  const id = `BTCUSD-M15-${ALERT_CLOSE}`;
  assert.match(old, new RegExp(`^NOTE: journal — not linked to an alert: .*\\. Only if they say it was, run: journal took --alert ${id} \\(the count is already done\\)\\.$`, 'm'));
  notPlanTook(old);
  assert.equal(planCount(d), 1);
  assert.equal(of(d.events(), 'taken').length, 0);
  // Following the NOTE (they say it was): linked, and the count stays where it is.
  const follow = d.run(['journal', 'took', '--alert', id], iso(fri + 120000));
  assert.match(reply(follow), /^Noted: you took the 14:15 bitcoin sell alert\.$/);
  assert.deepEqual(of(d.events(), 'taken').map((e) => e.id), [id]);
  assert.equal(planCount(d), 1, 'following the NOTE does not count the trade again');
  assert.match(reply(d.run(['plan', 'show'], iso(fri + 180000))), /1 of 3 trades/);

  // Ambiguous: two recent alerts with a ticket, neither marked taken; "took it" on "last".
  const d2 = desk();
  const k = (close) => LONG.findIndex((b) => b.t + M15 === close);
  d2.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  d2.setBars(LONG.slice(0, k(ALERT_CLOSE) + 1));
  const s1 = of(d2.events(), 'shown')[0];
  assert.match(d2.run(['take', '--price', String(s1.refPrice + 25)], iso(ALERT_CLOSE + 60000)), /STATUS: done · ticket/);
  d2.setBars(LONG);
  const next = ALERT_CLOSE + M15;
  assert.match(reply(d2.run(['scan', '--pair', 'bitcoin'], iso(next + 20000))), /Sell idea · Bitcoin/);
  d2.setBars(LONG.slice(0, k(next) + 1));
  const s2 = of(d2.events(), 'shown').find((e) => e.id !== s1.id);
  assert.match(d2.run(['take', '--price', String(s2.refPrice + 25)], iso(next + 60000)), /STATUS: done · ticket/);
  d2.setBars(LONG);
  assert.equal(of(d2.events(), 'ticketed').length, 2);
  d2.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(next + 90000));
  const amb = d2.run(['plan', 'took', '--alert', 'last'], iso(next + 120000));
  assert.match(reply(amb), /1 of 3 trades[\s\S]*Which alert was that — the 14:30 bitcoin sell alert or the 14:15 bitcoin sell alert\?$/);
  assert.match(amb, /^NOTE: journal — not linked to an alert: 2 recent alerts have a ticket or a "took it" \(.*\); ask which, then run: journal took --alert <its time or id> \(the count is already done\)\.$/m);
  notPlanTook(amb);
  assert.equal(planCount(d2), 1);
  d2.run(['journal', 'took', '--alert', '14:15'], iso(next + 150000));
  assert.deepEqual(of(d2.events(), 'taken').map((e) => e.id), [s1.id]);
  assert.equal(planCount(d2), 1, 'following the NOTE does not count the trade again');
});
test('a result by "last" or a London time on an alert that already has one: the desk asks, naming the earlier result; the full id or --replace replaces it', () => {
  const d = desk();
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  d.run(['journal', 'took', '--alert', '14:15'], iso(ALERT_CLOSE + 60000));
  const evening = Date.UTC(2026, 9, 21, 18);
  assert.match(d.run(['journal', 'result', '--alert', '14:15', '--how', 'stop'], iso(evening)), /STATUS: done/);
  const id = `BTCUSD-M15-${ALERT_CLOSE}`;
  for (const ref of ['14:15', 'last']) {
    const out = d.run(['journal', 'result', '--alert', ref, '--how', 'target'], iso(evening + 60000));
    assert.match(out, /STATUS: need-input/, ref);
    assert.equal(reply(out), 'You told me that trade ended at −1. Is this a different trade?', ref);
    assert.match(out, new RegExp(`^NOTE: the 14:15 bitcoin sell alert on Wed 21 Oct \\(${id}\\) already has their result \\(−1\\); nothing was written\\. Only if they say it is the same trade and this result replaces it, run the same command again with --alert ${id} \\(or add --replace\\)\\.`, 'm'), ref);
  }
  assert.deepEqual(of(d.events(), 'actual').map((e) => e.r), [-1], 'nothing written');
  // By the full id, or with --replace, it replaces (as before).
  const byId = reply(d.run(['journal', 'result', '--alert', id, '--r', '0.5'], iso(evening + 120000)));
  assert.match(byId, /^Noted for your record: your trade on the 14:15 bitcoin sell alert, closed by hand \(\+0\.5 times the risk\)\. This replaces the result you gave before \(−1\)\.$/);
  const rep = reply(d.run(['journal', 'result', '--alert', '14:15', '--how', 'stop', '--replace'], iso(evening + 180000)));
  assert.match(rep, /This replaces the result you gave before \(\+0\.5\)\.$/);
  assert.deepEqual(of(d.events(), 'actual').map((e) => e.r), [-1, 0.5, -1]);
});
test('plan took --alert names the alert; journal took marks one without counting; an unknown alert is a question', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 60000));
  d.run(['plan', 'took', '--alert', '14:15', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 90000));
  assert.deepEqual(of(d.events(), 'taken').map((e) => e.how), ['named']);
  const d2 = desk();
  d2.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  // "last" never means a scan idea nobody asked a ticket for: the desk asks.
  assert.match(d2.run(['journal', 'took', '--alert', 'last'], iso(ALERT_CLOSE + 80000)), /STATUS: need-input[\s\S]*never means a scan idea/);
  const j = d2.run(['journal', 'took', '--alert', '14:15'], iso(ALERT_CLOSE + 90000));
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

test('on a live account with no yes to the live record, "hit my stop" or "took it" gets that answer, never "which alert?" again', () => {
  for (const answer of [null, 'no']) {
    const d = desk();
    d.run(['config', 'account=live', ...(answer ? [`livejournal=${answer}`] : [])], iso(ALERT_CLOSE - 3600e3));
    assert.match(d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000)), /STATUS: alert/);
    assert.equal(of(d.events(), 'shown').length, 0, 'the alert was not kept');
    for (const args of [['journal', 'result', '--alert', 'last', '--how', 'stop'], ['journal', 'result', '--alert', '14:15', '--pair', 'bitcoin', '--how', 'stop'], ['journal', 'took', '--alert', '14:15', '--pair', 'bitcoin']]) {
      const out = d.run(args, iso(ALERT_CLOSE + 3600e3));
      assert.match(out, /STATUS: need-input/);
      assert.doesNotMatch(reply(out), /Which alert/, args.join(' '));
      if (answer === null) {
        assert.match(reply(out), /May a record of your live-account alerts and trades sit there\?[\s\S]*Alerts sent before you answer are not kept/);
        assert.match(out, /^NOTE: when they answer, run: config livejournal=yes/m);
      } else assert.equal(reply(out), 'You asked for nothing from your live account to go in your record, so there is nothing to note.');
    }
    d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 3600e3));
    assert.doesNotMatch(reply(d.run(['plan', 'took', '--alert', '14:15'], iso(ALERT_CLOSE + 3600e3))), /Which alert/);
    assert.match(reply(d.run(['journal', 'alert', '--alert', '14:15'], iso(ALERT_CLOSE + 3600e3))), /nothing from your live account is kept/);
    assert.equal(of(d.events(), 'actual').length + of(d.events(), 'taken').length, 0);
  }
});
test('marks made while "which account?" is open are kept: "took it" waits with the ticket, and a result waits for journal account', () => {
  const d = desk();
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));              // shown as demo
  d.run(['config', 'account=live', 'livejournal=yes'], iso(ALERT_CLOSE + 40000));
  const k = LONG.findIndex((b) => b.t + M15 === ALERT_CLOSE);
  d.setBars(LONG.slice(0, k + 1));
  const shown = of(d.events(), 'shown')[0];
  assert.match(reply(d.run(['take', '--price', String(shown.refPrice + 25)], iso(ALERT_CLOSE + 60000))), /Was this trade on your demo account or your live account\?$/);
  d.setBars(LONG);
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 70000));
  const took = d.run(['plan', 'took'], iso(ALERT_CLOSE + 80000));
  assert.match(reply(took), /1 of 3 trades[\s\S]*Was this trade on your demo account or your live account\?$/);
  assert.match(took, /^NOTE: the ticket is still waiting for which account it was on; this trade waits with it\./m);
  d.run(['journal', 'account', 'demo'], iso(ALERT_CLOSE + 90000));
  assert.deepEqual(of(d.events(), 'ticketed').map((e) => e.account), ['demo']);
  assert.deepEqual(of(d.events(), 'taken').map((e) => [e.account, e.how]), [['demo', 'ticket']], 'the trade is not lost');
  // A result on the same alert: asked, held, and applied by the answer as the skill maps it.
  const evening = Date.UTC(2026, 9, 21, 18);
  const q = d.run(['journal', 'result', '--alert', 'last', '--r', '0.4'], iso(evening));
  assert.match(q, /STATUS: need-input[\s\S]*Was this trade on your demo account or your live account\?/);
  assert.match(q, /^NOTE: when they answer, run: journal account demo \(or live\)\.$/m);
  assert.equal(of(d.events(), 'actual').length, 0);
  assert.match(reply(d.run(['journal', 'account', 'demo'], iso(evening + 60000))), /^Noted: on your demo account\.$/);
  assert.deepEqual(of(d.events(), 'actual').map((e) => [e.r, e.how, e.account]), [[0.4, 'by-hand', 'demo']]);
  privacyOk(d);
});
test('"last" is the alert they took, not a later scan idea; and a short reference does not reach back to another day', () => {
  const d = desk();
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  d.run(['plan', 'set', '--setups', 'Breakout', '--max', '3'], iso(ALERT_CLOSE + 60000));
  d.run(['plan', 'took', '--alert', '14:15'], iso(ALERT_CLOSE + 90000));
  // At 14:30 they ask what the live chart says: a scan idea, shown, not taken.
  const scan = reply(d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + M15 + 20000)));
  assert.match(scan, /Sell idea · Bitcoin/);
  assert.equal(of(d.events(), 'shown').length, 2);
  const res = d.run(['journal', 'result', '--alert', 'last', '--how', 'stop'], iso(ALERT_CLOSE + 55 * 60000));
  assert.equal(reply(res), 'Noted for your record: your trade on the 14:15 bitcoin sell alert, at its stop (−1 times the risk).');
  assert.deepEqual(of(d.events(), 'actual').map((e) => e.id), [`BTCUSD-M15-${ALERT_CLOSE}`]);
  // Two days later, "hit my stop" (a trade from a screenshot, say): the old alert is named with its day, and nothing is written.
  const fri = Date.UTC(2026, 9, 23, 17);
  for (const ref of ['last', '14:15']) {
    const out = d.run(['journal', 'result', '--alert', ref, '--how', 'target'], iso(fri));
    assert.match(out, /STATUS: need-input/);
    assert.equal(reply(out), 'The 14:15 bitcoin sell alert on Wed 21 Oct is the one I have. Was your trade on that alert? (A trade on an idea from a screenshot is not kept in the record.)');
    assert.match(out, new RegExp(`^NOTE: .*run the same command again with --alert BTCUSD-M15-${ALERT_CLOSE}\\.$`, 'm'));
  }
  assert.equal(of(d.events(), 'actual').length, 1);
  // Named by its id, it is recorded, and the reply names the day.
  const byId = reply(d.run(['journal', 'result', '--alert', `BTCUSD-M15-${ALERT_CLOSE}`, '--how', 'stop'], iso(fri)));
  assert.equal(byId, 'Noted for your record: your trade on the 14:15 bitcoin sell alert on Wed 21 Oct, at its stop (−1 times the risk). This replaces the result you gave before (−1).');
  // An alert nobody took is never "last".
  const d2 = desk();
  d2.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  assert.match(d2.run(['journal', 'result', '--alert', 'last', '--how', 'stop'], iso(fri)), /STATUS: need-input[\s\S]*Which alert was that trade on\?/);
  assert.equal(of(d2.events(), 'actual').length, 0);
});

test('after a switch to M5, an M15 alert is scored on M15 bars, never on the five-minute ones', () => {
  // Each fifteen-minute bar split in three, standing for the M5 history (same path, other bars).
  const m5 = LONG.flatMap((b) => [0, 1, 2].map((i) => ({ t: b.t + i * 5 * 60000, o: i ? b.c : b.o, h: b.h, l: b.l, c: i < 2 ? (b.o + b.c) / 2 : b.c, v: b.v / 3 })));
  const d = desk({ more: { 'BTCUSD-M5': m5 } });
  d.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  d.run(['config', 'timeframe=M5'], iso(ALERT_CLOSE + 3600e3));
  const u = d.run(['journal', 'update'], iso(Date.UTC(2026, 9, 21, 18)));
  assert.match(reply(u), /1 alert you were sent has finished and is scored\./);
  const res = of(d.events(), 'resolved');
  assert.equal(res.length, 1);
  assert.equal(res[0].gap, false, 'no false gap from five-minute steps');
  // The same alert scored by a desk that never left M15.
  const ref = desk();
  ref.run(['watch', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 30000));
  ref.run(['journal', 'update'], iso(Date.UTC(2026, 9, 21, 18)));
  assert.deepEqual([res[0].r, res[0].how, res[0].bars], ['r', 'how', 'bars'].map((k) => of(ref.events(), 'resolved')[0][k]));
});

console.log('\nthe method\'s own record');
test('journal sample asks the plan\'s question; on a yes it commits; journal update records each weekday on the reference feed, and journal reports the sample', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));   // the journal exists
  const q = d.run(['journal', 'sample'], iso(Date.UTC(2026, 9, 20, 6)));
  assert.match(q, /STATUS: need-input/);
  assert.equal(reply(q), 'Shall I judge the alerts on the next 240 of them, every alert scored on the price feed whether you take it or not, and give no verdict before then? Your own trades stay in \'Is it working yet?\', separately.');
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
test('a settings change that would end the sample in progress: the desk says so and asks first; only --end-sample changes it, and the end is recorded', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  for (const set of ['timeframe=M5', 'commission=1']) {
    const ask = d.run(['config', set], iso(Date.UTC(2026, 9, 22, 18)));
    assert.match(ask, /STATUS: need-input/, set);
    assert.match(reply(ask), /^Before I change that: it changes the (chart timeframe|costs \(commission or GBP\/USD\)) for bitcoin, and that ends the alert sample you committed to on Tue 20 Oct, now at \d+ of 100 alerts\. .*the sample stops for good, with no verdict, even if you change the setting back later, and a new sample would start again from zero\. Shall I change it anyway\?$/);
    assert.match(ask, /^NOTE: nothing was changed\. .*--end-sample/m);
    assert.deepEqual(d.config(), {}, 'nothing written');
  }
  // A change that is not part of the method needs no question.
  assert.match(d.run(['config', 'risk=0.5'], iso(Date.UTC(2026, 9, 22, 18))), /STATUS: changed · commit desk\/config\.json$/m);
  assert.match(d.run(['config', 'serveroffset=2'], iso(Date.UTC(2026, 9, 22, 18))), /STATUS: changed/);
  assert.equal(of(d.events(), 'ended').length, 0);
  // Their yes: changed, and the end is in the journal at once.
  const yes = d.run(['config', 'timeframe=M5', '--end-sample'], iso(Date.UTC(2026, 9, 22, 18, 5)));
  assert.match(yes, /STATUS: changed · commit desk\/config\.json and .*journal\.jsonl/);
  assert.match(reply(yes), /Your alert sample has stopped at \d+ of 100, with no verdict, as you agreed\./);
  assert.equal(d.config().timeframe, 'M5');
  assert.deepEqual(of(d.events(), 'ended').map((e) => [e.id, e.reason]), [[of(d.events(), 'sample')[0].id, 'method-changed']]);
  privacyOk(d);
  // Changed back before anything was recorded under M5: the sample has still ended, as they were told.
  assert.match(d.run(['config', 'timeframe=M15'], iso(Date.UTC(2026, 9, 22, 18, 10))), /STATUS: changed · commit desk\/config\.json$/m);
  assert.match(reply(d.run(['journal'], iso(Date.UTC(2026, 9, 22, 18, 15)))), /\*\*The alert sample\*\*: stopped at \d+ of 100, with no verdict: you agreed to end it for a change that makes the desk a different method\./);
  // And a new sample can be committed straight away, under the settings they are back on.
  const again = d.run(['journal', 'sample', '--alerts', '240'], iso(Date.UTC(2026, 9, 23, 6)));
  assert.match(again, /STATUS: done/);
  assert.deepEqual(of(d.events(), 'sample').map((e) => [e.plannedAlerts, e.replaces ?? null]), [[100, null], [240, 'method-changed']]);
});
test('a settings change outside config pauses the sample — never ends it: nothing recorded or counted while they differ; put back, it carries on', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  d.run(['journal', 'update'], iso(Date.UTC(2026, 9, 22, 6)));
  const before = of(d.events(), 'day').length;
  assert.ok(before >= 1);
  // The settings file changed outside the desk (a pull, a hand edit).
  writeFileSync(join(d.home, 'config.json'), JSON.stringify({ account: { commissionPerSideGBP: 1 } }));
  const u = d.run(['journal', 'update'], iso(Date.UTC(2026, 9, 24, 12)));
  assert.match(reply(u), /^Nothing checked on the price feed for your alert sample: it is paused, because your settings no longer match it, and nothing is counted while it differs\./);
  assert.match(u, /^NOTE: the alert sample is paused, not ended: the costs \(commission or GBP\/USD\) for bitcoin no longer match its method\. .*config --end-sample.*Never end it without their words\.$/m);
  assert.equal(of(d.events(), 'day').length, before, 'not even the full update records a day while it is paused');
  const j = d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 5)));
  const PAUSED = /\*\*The alert sample\*\*: paused at (\d+) of 100\. Your settings no longer match the ones it is judged under: the costs \(commission or GBP\/USD\) changed since you committed to it, so nothing is counted while they differ\. You can change them back, and it carries on where it left off \(the days in between are then checked on the price feed like any other\); or you can end it, with no verdict, and commit a new one under the new settings\./;
  assert.match(reply(j), PAUSED);
  assert.match(j, /^NOTE: the alert sample is paused, not ended: .*to carry on, put the settings back \(config commission=… .*\); to end it, run config --end-sample/m);
  assert.doesNotMatch(reply(j), /stopped at|config|--end-sample/, 'no command in the reply');
  assert.equal(of(d.events(), 'ended').length, 0, 'paused is not ended');
  // No new sample over a paused one.
  const again = d.run(['journal', 'sample', '--alerts', '240'], iso(Date.UTC(2026, 9, 24, 12, 10)));
  assert.match(again, /STATUS: refused/);
  assert.match(reply(again), /^Not committed: your alert sample is paused at \d+ of 100, not ended, because your settings no longer match it\./);
  // Put back (by hand, as it was changed): it carries on, and the days in between are recorded then.
  writeFileSync(join(d.home, 'config.json'), JSON.stringify({}));
  d.run(['journal', 'update'], iso(Date.UTC(2026, 9, 24, 12, 15)));
  assert.deepEqual(of(d.events(), 'day').map((e) => e.day), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  assert.ok(of(d.events(), 'day').every((e) => e.method.costs.BTCUSD.comm === 0), 'all under the sample\'s own method');
  const back = reply(d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 20))));
  assert.match(back, /\*\*The alert sample\*\*: \d+ of the 100 alerts you committed to/);
  assert.doesNotMatch(back, /paused|stopped/);
});
test('a paused sample ends only when the user agrees (config --end-sample); a new one can then be committed', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  writeFileSync(join(d.home, 'config.json'), JSON.stringify({ timeframe: 'M5' }));
  // config shows the settings and says it is paused, with the session's NOTE; nothing ends.
  const show = d.run(['config'], iso(Date.UTC(2026, 9, 24, 12)));
  assert.match(reply(show), /Your alert sample is paused at \d+ of 100, because your settings no longer match it: nothing is counted while it differs\. Put the settings back and it carries on, or tell me to end it, with no verdict\./);
  assert.match(show, /^NOTE: the alert sample is paused, not ended: the chart timeframe for bitcoin .*config timeframe=M15/m);
  assert.equal(of(d.events(), 'ended').length, 0);
  // Their words: end it.
  const end = d.run(['config', '--end-sample'], iso(Date.UTC(2026, 9, 24, 12, 5)));
  assert.match(end, /STATUS: changed · commit .*journal\.jsonl/);
  assert.match(reply(end), /Your alert sample has stopped at \d+ of 100, with no verdict, as you agreed\./);
  assert.deepEqual(of(d.events(), 'ended').map((e) => e.reason), ['method-changed']);
  assert.match(reply(d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 10)))), /stopped at \d+ of 100, with no verdict: you agreed to end it/);
  const out = d.run(['journal', 'sample', '--alerts', '240'], iso(Date.UTC(2026, 9, 24, 12, 15)));
  assert.match(out, /STATUS: done/, out);
  assert.match(reply(d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 20)))), /\*\*The alert sample\*\*: 0 of the 240 alerts you committed to\./);
  // --end-sample on a sample running under its own settings ends nothing (no optional stopping, decision 8).
  const keep = d.run(['config', '--end-sample'], iso(Date.UTC(2026, 9, 24, 12, 25)));
  assert.match(reply(keep), /Your alert sample \(0 of 240\) is running under these settings, so it has not been ended/);
  assert.equal(of(d.events(), 'ended').length, 1);
});
test('the silent update records no day under a method other than the running sample\'s (paused: settings changed outside config)', () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));
  d.run(['journal', 'sample', '--alerts', '100'], iso(Date.UTC(2026, 9, 20, 6)));
  // A hand edit that changes the method but not the bars it reads (the M15 history serves it):
  // without the guard the silent update would record these days under the other costs.
  writeFileSync(join(d.home, 'config.json'), JSON.stringify({ account: { commissionPerSideGBP: 1 } }));
  d.run(['now'], iso(Date.UTC(2026, 9, 24, 12)));
  d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 1)));
  assert.equal(of(d.events(), 'day').length, 0, 'nothing recorded while paused, without a word');
  assert.equal(of(d.events(), 'ended').length, 0, 'and nothing ended');
  // Settings back: the sample is still running and the silent update records its days.
  writeFileSync(join(d.home, 'config.json'), JSON.stringify({}));
  d.run(['now'], iso(Date.UTC(2026, 9, 24, 12, 5)));
  assert.ok(of(d.events(), 'day').length >= 1 && of(d.events(), 'day').every((e) => e.tf === 'M15' && e.method.costs.BTCUSD.comm === 0));
  assert.doesNotMatch(reply(d.run(['journal'], iso(Date.UTC(2026, 9, 24, 12, 6)))), /stopped|paused/);
});

test('gold days are recorded: the history the desk asks for holds the 999 bars before each check, across gold\'s breaks and weekends', () => {
  // Synthetic gold M15 bars, open only outside its scheduled breaks (daily hour, Friday to Sunday evening, New York).
  let c = 4000, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gold = [];
  for (let t = Date.UTC(2026, 8, 7); t < Date.UTC(2026, 9, 24, 12); t += M15) {
    if (goldOnBreak(t)) continue;
    const o = c; c = o + (rnd() - 0.5) * 4;
    gold.push({ t, o, h: Math.max(o, c) + rnd() * 1.5, l: Math.min(o, c) - rnd() * 1.5, c, v: 100 + Math.round(rnd() * 50) });
  }
  // The window asked for holds at least 999 + a day of bars before the first day's midnight; the old one (in calendar time) did not.
  const midnight = Date.UTC(2026, 9, 19, 23);
  const from = fromForBars('XAUUSD', 'M15', midnight, CLOSED_BARS + 96);
  assert.ok(gold.filter((b) => b.t >= from && b.t < midnight).length >= CLOSED_BARS + 96);
  assert.ok(gold.filter((b) => b.t >= midnight - (CLOSED_BARS + 96) * M15 && b.t < midnight).length < CLOSED_BARS, 'calendar time would have left it short');
  assert.equal(fromForBars('BTCUSD', 'M15', midnight, 1000), midnight - 1000 * M15, 'bitcoin trades around the clock');
  const d = desk({ gold });
  assert.match(d.run(['journal', 'sample', '--alerts', '100', '--pairs', 'gold'], iso(Date.UTC(2026, 9, 20, 5))), /STATUS: done/);
  const u = d.run(['journal', 'update'], iso(Date.UTC(2026, 9, 24, 12)));
  assert.doesNotMatch(u, /short-history/);
  assert.match(reply(u), /^Checked on the price feed: 4 days of gold/);
  assert.deepEqual(of(d.events(), 'day').map((e) => [e.pair, e.day]), ['20', '21', '22', '23'].map((x) => ['XAUUSD', `2026-10-${x}`]));
  privacyOk(d);
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

test('watch says WATCHING before the silent update, so the session reading its output at once can tell what is watched', async () => {
  const d = desk();
  d.run(['scan', '--pair', 'bitcoin'], iso(ALERT_CLOSE + 20000));     // a finished alert to score: the update reaches for the feed
  const stub = join(d.home, 'stall.mjs');
  writeFileSync(stub, 'globalThis.fetch = () => new Promise(() => {});\n');
  const env = { ...d.env, SCALP_DESK_NOW: iso(Date.UTC(2026, 9, 22, 5, 30)), NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' };
  delete env.SCALP_DESK_BARS;                                          // the real history path, with fetch stalled
  const child = spawn('node', ['--import', pathToFileURL(stub).href, DESK, 'watch', '--pair', 'bitcoin'], { env });
  const t0 = Date.now();
  const first = await new Promise((res) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; if (/WATCHING:/.test(out)) res({ out, ms: Date.now() - t0 }); });
    setTimeout(() => res({ out, ms: Infinity }), 4500);
  });
  child.kill('SIGKILL');
  assert.match(first.out, /^WATCHING: Bitcoin on M15, in the window\.$/m);
  assert.ok(first.ms < 3000, `WATCHING came after ${first.ms} ms; the silent update takes up to five seconds`);
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
  const past = reply(d.run(['learn', 'similar', '--at', '2024-10-10T13:15', '--side', 'buy'], iso(ALERT_CLOSE)));
  assert.match(past, /^On bitcoin's 2024 prices, of the \d+ moments most like this one \(from \d+ different days\), for a standard buy, \d+ in 100 reached the target, \d+ hit the stop, and the rest were closed at the end of the session/);
  assert.match(past, /That describes the past; it is not a forecast for this trade\./);
  // No side named: the desk asks which, and shows neither side — never both at once (rule 3; decisions 2, 22).
  const ASK_SIDE = 'Similar setups describe one standard trade. Which side are you thinking of — buy or sell?';
  const noSide = d.run(['learn', 'similar', '--at', '2024-10-10T13:15'], iso(ALERT_CLOSE));
  assert.match(noSide, /STATUS: need-input/);
  assert.equal(reply(noSide), ASK_SIDE);
  assert.match(noSide, /^NOTE: run it again with --side buy or --side sell only as they answer; never pick a side for them/m);
  assert.doesNotMatch(reply(noSide), /in 100|standard (buy|sell)|times the risk/);
  // A moment from now on, described from the reference feed's bars up to it.
  const now = reply(d.run(['learn', 'similar', '--at', iso(ALERT_CLOSE).slice(0, 16), '--side', 'sell'], iso(ALERT_CLOSE + 3600e3)));
  assert.match(now, /^On bitcoin's 2024 prices, of the \d+ moments most like this one .* for a standard sell, /);
  assert.doesNotMatch(now, /standard buy/, 'the side named, only');
  assert.doesNotMatch(now, /won|lost|£/);
  // A moment whose idea the checks rejected (08:00 London on 21 Oct): the scan shows no direction, and
  // "similar setups" with no side asks — the engine's lean is never passed on, and no side is shown.
  const rejectedAt = Date.UTC(2026, 9, 21, 7, 0);
  assert.match(reply(d.run(['scan', '--pair', 'bitcoin'], iso(rejectedAt + 20000))), /No idea[\s\S]*failed these checks/);
  const r = d.run(['learn', 'similar', '--at', iso(rejectedAt).slice(0, 16)], iso(rejectedAt + 3600e3));
  assert.match(r, /STATUS: need-input/);
  assert.equal(reply(r), ASK_SIDE);
  // With the side they name, unchanged: that side only.
  const named = reply(d.run(['learn', 'similar', '--at', iso(rejectedAt).slice(0, 16), '--side', 'buy'], iso(rejectedAt + 3600e3)));
  assert.match(named, /^On bitcoin's 2024 prices, of the \d+ moments most like this one .* for a standard buy, /);
  assert.doesNotMatch(named, /standard sell/);
});

console.log('\nisolation');
test('no test here wrote the real desk/journal.jsonl', () => {
  assert.equal(existsSync(REAL_JOURNAL) ? statSync(REAL_JOURNAL).mtimeMs : null, realBefore);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
