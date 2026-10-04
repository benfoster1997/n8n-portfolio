/**
 * The in-chat desk (desk/): the same gate, checks and sizing as the page, run
 * from a Claude session the user sends screenshots to. These tests hold it to
 * the page's rules — especially the ones a chat reply could quietly break: no
 * direction from a blocked or rejected reading, no time to the close, and the
 * gate checked again when the analysis finishes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withDefaults, pairOf, gateFor, formatIdea, formatBlocked, forChat, cautionAfter, latestUpload,
  sizeFor, contextFor, formatNow, formatBrief, phaseWords, serverOffsetFor, clockCheckLine,
} from '../desk/lib.mjs';
import { checkPlan } from '../src/shot.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const here = dirname(fileURLToPath(import.meta.url));
const DESK = join(here, '..', 'desk', 'desk.mjs');
const cfg = withDefaults({});
const T = (iso) => Date.parse(iso);
// No time to the close, in any reply (decision 1). News times are fine.
const CLOSE_TALK = /(left|remaining) in (your|the) (session|window)|until (the )?close|to the close|minutes left|before 16:00/i;

console.log('\nwhich instrument');
test('gold and bitcoin by any of their names', () => {
  for (const s of ['gold', 'Gold', 'XAU', 'xauusd', 'XAUUSD.pro']) assert.equal(pairOf(s), 'XAUUSD', s);
  for (const s of ['btc', 'Bitcoin', 'BTCUSD', 'xbt']) assert.equal(pairOf(s), 'BTCUSD', s);
  assert.equal(pairOf('eurusd'), null);
});

console.log('\nthe gate, at frozen moments (London is UTC+1 in October until the 25th)');
const SUN_NIGHT = T('2026-10-04T21:20:00Z');   // Sunday 22:20 London
const MON_DEAD = T('2026-10-05T09:00:00Z');    // Monday 10:00 London, gold's dead zone
const MON_GREEN = T('2026-10-05T13:00:00Z');   // Monday 14:00 London
const NFP_IN = T('2026-10-02T12:35:00Z');      // Friday 13:35 London, five minutes after NFP
test('Sunday night: gold closed, bitcoin open with a warning and the spread required', () => {
  const g = gateFor('XAUUSD', SUN_NIGHT, cfg);
  assert.equal(g.allowed, false); assert.equal(g.state, 'closed');
  const b = gateFor('BTCUSD', SUN_NIGHT, cfg);
  assert.equal(b.allowed, true); assert.equal(b.state, 'caution'); assert.equal(b.needsSpread, true);
});
test('gold dead zone stands down; bitcoin in its quiet hours is still read (decision 23)', () => {
  const g = gateFor('XAUUSD', MON_DEAD, cfg);
  assert.equal(g.state, 'stand-down');
  assert.match(g.message, /until 12:30/);
  assert.equal(gateFor('BTCUSD', MON_DEAD, cfg).allowed, true);
});
test('NFP blackout: gold stands aside, bitcoin is a caution with the spread required', () => {
  assert.equal(gateFor('XAUUSD', NFP_IN, cfg).state, 'stand-aside');
  const b = gateFor('BTCUSD', NFP_IN, cfg);
  assert.equal(b.allowed, true); assert.equal(b.needsSpread, true);
});
test('a blocked reply carries no direction and no levels', () => {
  const t = formatBlocked('XAUUSD', gateFor('XAUUSD', MON_DEAD, cfg));
  assert.doesNotMatch(t, /\bbuy\b|\bsell\b|▲|▼|\blean|\bgoing (up|down)\b/i);
  assert.match(t, /Stand down/);
});
test('phase words never count down to the close', () => {
  for (const at of [T('2026-10-05T14:40:00Z'), T('2026-10-05T14:10:00Z'), MON_GREEN, MON_DEAD]) {
    assert.doesNotMatch(phaseWords(at, 'XAUUSD', cfg.window), /\d+ ?min|\d\d:\d\d/);
  }
  assert.match(phaseWords(T('2026-10-05T14:40:00Z'), 'XAUUSD', cfg.window), /Final stretch/);
});

console.log('\nwording for a chat');
test('page wording is replaced where it points at the page', () => {
  assert.equal(forChat('Check the instrument selected at the top.'), 'Check the instrument you named.');
  assert.match(forChat('This page builds market orders only.'), /The desk builds/);
});
test('once the spread is in, the caution keeps the warning and drops the request', () => {
  assert.equal(cautionAfter('Weekend: bitcoin trades, but liquidity is thin and the spread can widen — type today\'s spread before you analyse.'),
    'Weekend: bitcoin trades, but liquidity is thin and the spread can widen.');
  assert.equal(cautionAfter('Outside your trading hours — type the spread from MT5 before you analyse.'), 'Outside your trading hours.');
  assert.equal(cautionAfter('NFP is about to be released: spreads can jump. Type the spread as it is right now. The usual all-clear is 14:05.'),
    'NFP is about to be released: spreads can jump. The usual all-clear is 14:05.');
});

console.log('\nreplies');
const gGreen = gateFor('XAUUSD', MON_GREEN, cfg);
const ctxGold = contextFor({ nowMs: MON_GREEN, pair: 'XAUUSD', gate: gGreen, priceNow: 4400, spreadNum: 0.05, spreadTyped: false, cfg });
const goodPlan = {
  decision: 'buy', instrument_seen: 'XAUUSD', timeframe_seen: 'M5', price_now: 4400.02, axis_low: 4388, axis_high: 4412,
  stop_loss: 4395, take_profit_1: 4407, take_profit_2: 4410, confidence: 'moderate',
  summary: 'Higher lows into support.', reasons: ['Higher lows'], against: ['Near the high'], invalidated_if: 'A close below 4395.',
};
const reading = (view) => ({ readable: true, instrument_seen: 'XAUUSD', timeframe_seen: 'M5', price_now: 4400, axis_low: 4388, axis_high: 4412, view });
const checkCtx = { priceNow: 4400, cost: ctxGold.costNum, digits: 2, pair: 'XAUUSD', minStopPct: 0.0005, asked: 3 };
test('an accepted idea carries the levels and an MT5 ticket, and no time to the close', () => {
  const result = checkPlan(goodPlan, [reading('buy'), reading('buy'), reading('none')], checkCtx);
  assert.equal(result.decision, 'buy');
  const sized = sizeFor({ pair: 'XAUUSD', cfg, stop: result.stopDistance, entry: result.entry, spreadNum: 0.05, side: 'buy', stopLoss: result.stopLoss, target: result.takeProfit1 });
  const t = formatIdea({ result, pair: 'XAUUSD', ctx: ctxGold, cfg, mode: 'thorough', atMs: MON_GREEN, nowMs: MON_GREEN, sized });
  assert.match(t, /▲ Buy idea · Gold/);
  assert.match(t, /2 of 3 readings agree/);
  assert.match(t, /MT5 ticket — BUY XAUUSD/);
  assert.match(t, /Stop loss \*\*4,395\.00\*\*/);
  assert.match(t, /Take profit \*\*4,407\.00\*\*/);
  assert.doesNotMatch(t, CLOSE_TALK);
});
test('a rejected idea shows the failed checks, never its direction, summary or levels', () => {
  const result = checkPlan(goodPlan, [reading('buy'), reading('none'), reading('none')], checkCtx);
  assert.equal(result.rejected, true);
  const t = formatIdea({ result, pair: 'XAUUSD', ctx: ctxGold, cfg, mode: 'thorough', atMs: MON_GREEN, nowMs: MON_GREEN });
  assert.match(t, /No trade/);
  assert.match(t, /Only 1 of 3 analysts agreed/);
  assert.doesNotMatch(t, /buy|sell|▲|▼|4,395|4395|4,407|4407|Higher lows/i);
});
test('a plain No trade gives its reasons but not the case for a trade, and counts the readers who saw none', () => {
  const nt = { ...goodPlan, decision: 'no_trade', stop_loss: null, take_profit_1: null, take_profit_2: null,
    summary: 'Mid-range, no edge.', reasons: ['Price is mid-range'], against: ['Green candles are climbing toward the highs'] };
  const rs = [reading('none'), reading('none'), { readable: false }];
  const result = checkPlan(nt, rs, checkCtx);
  const t = formatIdea({ result, pair: 'XAUUSD', ctx: ctxGold, cfg, mode: 'thorough', atMs: MON_GREEN, nowMs: MON_GREEN, readings: rs });
  assert.match(t, /Price is mid-range/);
  assert.doesNotMatch(t, /climbing/);
  assert.match(t, /2 of 3 readers saw no trade \(1 could not read it\)/);
});
test('an idea more than 15 minutes old says so', () => {
  const result = checkPlan(goodPlan, [], { ...checkCtx, asked: 0 });
  const t = formatIdea({ result, pair: 'XAUUSD', ctx: ctxGold, cfg, mode: 'fast', atMs: MON_GREEN, nowMs: MON_GREEN + 16 * 60000 });
  assert.match(t, /over 15 minutes old/);
});
test('the final stretch marks confidence down and says so, without a countdown', () => {
  const at = T('2026-10-05T14:40:00Z');
  const g = gateFor('XAUUSD', at, cfg);
  const c = contextFor({ nowMs: at, pair: 'XAUUSD', gate: g, priceNow: 4400, spreadNum: 0.05, spreadTyped: false, cfg });
  assert.equal(c.lastStretch, true);
  const result = checkPlan(goodPlan, [], { ...checkCtx, asked: 0, lastStretch: true });
  assert.equal(result.confidence, 'low');
  const t = formatIdea({ result, pair: 'XAUUSD', ctx: c, cfg, mode: 'fast', atMs: at, nowMs: at });
  assert.match(t, /Final stretch — confidence is marked down/);
  assert.doesNotMatch(t, CLOSE_TALK);
});
test('now and the brief name no time to the close', () => {
  for (const at of [SUN_NIGHT, T('2026-10-05T06:30:00Z'), MON_DEAD, T('2026-10-05T14:40:00Z')]) {
    assert.doesNotMatch(formatNow(at, cfg, null), CLOSE_TALK);
    assert.doesNotMatch(formatBrief(at, cfg, null), CLOSE_TALK);
  }
});
test('the brief before the open lists the day and asks for a plan', () => {
  const t = formatBrief(T('2026-10-05T06:30:00Z'), cfg, null);
  assert.match(t, /Before the open/);
  assert.match(t, /Sit out 09:00–12:30/);
  assert.match(t, /15:00 \*\*ISM Svc\*\*/);
  assert.match(t, /No plan yet for today/);
});

console.log('\nsizing');
test('a shadow balance sizes like the live account: £10,000 at 1%, $5 gold stop → 0.26 lots', () => {
  const c = withDefaults({ account: { shadowBalance: 10000, sizeFrom: 'shadow' } });
  const s = sizeFor({ pair: 'XAUUSD', cfg: c, stop: 5, entry: 4400, spreadNum: 0.05, side: 'buy', stopLoss: 4395, target: 4410 });
  // $135 of risk over ($5.05 x 100 oz + $7.425 commission) a lot = 0.263 → 0.26.
  assert.equal(s.tk.volume, 0.26);
  assert.equal(s.split.needsSplit, false);
});
test('at demo scale a bitcoin position is split into orders of 10 lots and says to use a shadow balance', () => {
  const s = sizeFor({ pair: 'BTCUSD', cfg, stop: 250, entry: 84400, spreadNum: 6, side: 'buy', stopLoss: 84150, target: 84800 });
  assert.equal(s.split.needsSplit, true);
  assert.equal(s.split.perOrder, 10);
});

console.log('\nthe uploaded picture');
test('the newest image within the age limit, and nothing once it is too old', () => {
  const root = mkdtempSync(join(tmpdir(), 'uploads-'));
  mkdirSync(join(root, 's1')); mkdirSync(join(root, 's2'));
  const a = join(root, 's1', 'a-image.jpg'), b = join(root, 's2', 'b-image.png'), n = join(root, 's2', 'notes.txt');
  for (const p of [a, b, n]) writeFileSync(p, 'x');
  const now = Date.now();
  utimesSync(a, new Date(now - 120e3), new Date(now - 120e3));
  utimesSync(b, new Date(now - 30e3), new Date(now - 30e3));
  utimesSync(n, new Date(now), new Date(now));
  assert.equal(latestUpload(root, now).path, b);
  assert.equal(latestUpload(root, now + 20 * 60000), null);
  assert.equal(latestUpload(join(root, 'missing'), now), null);
});

console.log('\nthe commands, end to end');
function deskEnv(nowIso, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'desk-'));
  const uploads = join(home, 'uploads');
  mkdirSync(join(uploads, 'session'), { recursive: true });
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify(extra.config || {}));
  const env = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_UPLOADS: uploads, SCALP_DESK_CONFIG: config, SCALP_DESK_NOW: nowIso };
  const run = (args, at = nowIso) => execFileSync('node', [DESK, ...args], { encoding: 'utf8', env: { ...env, SCALP_DESK_NOW: at } });
  const upload = () => {
    const p = join(uploads, 'session', 'chart-image.jpg');
    writeFileSync(p, 'jpg');
    const t = new Date(Date.parse(nowIso) - 20e3);
    utimesSync(p, t, t);
    return p;
  };
  return { home, run, upload };
}
const runId = (out) => out.match(/run (\S+)/)[1];
const replyOf = (out) => (out.split('--- reply ---\n')[1] || '').split('\n--- end ---')[0];

test('no price: it asks for the price and reads nothing', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const out = d.run(['gate', '--pair', 'gold']);
  assert.match(out, /STATUS: need-price/);
  assert.equal(existsSync(join(d.home, 'runs')), false);
});
test('thorough: three readings, the head trader, then a checked idea with a ticket', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const img = d.upload();
  const out = d.run(['gate', '--pair', 'gold', '--price', '4400']);
  assert.match(out, /STATUS: go · thorough/);
  assert.ok(out.includes(img), 'names the uploaded picture for the readers');
  const id = runId(out), dir = join(d.home, 'runs', id);
  for (const k of [1, 2, 3]) assert.ok(existsSync(join(dir, `analyst-${k}.txt`)));
  assert.match(readFileSync(join(dir, 'analyst-1.txt'), 'utf8'), /Trend and structure|trend and market structure/);
  writeFileSync(join(dir, 'reading-1.json'), JSON.stringify(reading('buy')));
  writeFileSync(join(dir, 'reading-2.json'), 'Here it is:\n```json\n' + JSON.stringify(reading('buy')) + '\n```');
  writeFileSync(join(dir, 'reading-3.json'), JSON.stringify(reading('none')));
  const h = d.run(['head', '--run', id]);
  assert.match(h, /STATUS: go · head/);
  assert.match(readFileSync(join(dir, 'head.txt'), 'utf8'), /Analyst 2 \(Levels and liquidity\)/);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(goodPlan));
  const c = d.run(['check', '--run', id]);
  assert.match(c, /STATUS: done · buy/);
  const reply = replyOf(c);
  assert.match(reply, /MT5 ticket — BUY XAUUSD/);
  assert.match(reply, /2 of 3 readings agree/);
  assert.doesNotMatch(reply, /STATUS|\/tmp|\.json|desk\.mjs/, 'no plumbing in the reply');
});
test('thorough asked for, but no picture on disk: falls back to Fast and says so', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const out = d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'thorough']);
  assert.match(out, /STATUS: go · fast/);
  assert.match(out, /NOTE: no uploaded picture/);
  assert.match(out, /--- reader instructions ---/);
});
test('fewer than two readable readings: no head trader, a No trade', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  d.upload();
  const id = runId(d.run(['gate', '--pair', 'gold', '--price', '4400']));
  const dir = join(d.home, 'runs', id);
  writeFileSync(join(dir, 'reading-1.json'), JSON.stringify({ readable: false }));
  writeFileSync(join(dir, 'reading-2.json'), JSON.stringify(reading('buy')));
  writeFileSync(join(dir, 'reading-3.json'), 'not json at all');
  const h = d.run(['head', '--run', id]);
  assert.match(h, /STATUS: unreadable/);
  assert.equal(existsSync(join(dir, 'head.txt')), false);
});
test('NFP starts while it is being read: the analysis is discarded', () => {
  // Friday 2 Oct, 13:00 London: allowed (NFP at 13:30 is not yet inside 30 minutes).
  const d = deskEnv('2026-10-02T12:00:00Z');
  const out = d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'fast']);
  assert.match(out, /STATUS: go · fast/);
  const id = runId(out);
  writeFileSync(join(d.home, 'runs', id, 'plan.json'), JSON.stringify(goodPlan));
  const c = d.run(['check', '--run', id], '2026-10-02T12:20:00Z');   // 13:20 London, inside the blackout
  assert.match(c, /STATUS: discarded/);
  assert.match(replyOf(c), /Stand aside/);
  assert.doesNotMatch(replyOf(c), /buy|4,395|4,407/i);
});
test('bitcoin at the weekend: the spread is asked for, then remembered for the hour', () => {
  const d = deskEnv('2026-10-04T21:20:00Z');
  assert.match(d.run(['gate', '--pair', 'btc', '--price', '84400']), /STATUS: need-spread/);
  assert.match(d.run(['gate', '--pair', 'btc', '--price', '84400', '--spread', '12', '--mode', 'fast']), /STATUS: go · fast/);
  const again = d.run(['gate', '--pair', 'btc', '--price', '84410', '--mode', 'fast'], '2026-10-04T21:40:00Z');
  assert.match(again, /STATUS: go · fast/);
  assert.match(again, /Using the spread you sent at 22:20/);
  assert.match(d.run(['gate', '--pair', 'btc', '--price', '84410'], '2026-10-04T22:30:00Z'), /STATUS: need-spread/);
});
test('the plan: set, count, and refuse without a max', () => {
  const d = deskEnv('2026-10-05T07:00:00Z');
  assert.match(d.run(['plan', 'set', '--setups', 'Breakout, fade the open']), /STATUS: need-input/);
  assert.match(d.run(['plan', 'set', '--setups', 'breakout, fade the open', '--max', '3']), /Breakout · fade the open, up to 3 trades/);
  d.run(['plan', 'took']); d.run(['plan', 'took']);
  assert.match(d.run(['plan', 'show']), /2 of 3 trades/);
  assert.match(d.run(['plan', 'undo']), /1 of 3 trades/);
});
test('size: a typed stop on a fresh idea moves the ticket stop; with no idea, lots only', () => {
  const d = deskEnv('2026-10-05T13:00:00Z', { config: { account: { shadowBalance: 10000, sizeFrom: 'shadow' } } });
  assert.match(d.run(['size', '--stop', '5', '--pair', 'gold']), /Gold: volume for your 5\.00 stop is \*\*0\.26 lots\*\*/);
  const id = runId(d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'fast']));
  writeFileSync(join(d.home, 'runs', id, 'plan.json'), JSON.stringify(goodPlan));
  d.run(['check', '--run', id]);
  const s = d.run(['size', '--stop', '6']);
  assert.match(s, /Stop loss \*\*4,394\.00\*\*/);
  assert.match(s, /not the analysis's 5\.00/);
});
test('config: changes are written and shown; unknown keys are refused', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  assert.match(d.run(['config', 'risk=0.5', 'shadow=10000', 'sizefrom=shadow']), /risk 0\.5%[\s\S]*sizing from \*\*the shadow balance\*\*/);
  assert.throws(() => d.run(['config', 'colour=blue']));
});
test('edge: no verdict before the committed sample', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  assert.match(d.run(['edge', '--trades', '40', '--wins', '26', '--planned', '200']), /Collecting — 20% of the way/);
});

console.log('\nwhat the review found (4 Oct 2026)');
const sh = (d, args, at) => { try { return d.run(args, at); } catch (e) { return `EXIT ${e.status}\n${e.stdout}`; } };
test('the broker clock follows New York + 7: UTC+3 now, UTC+2 from 1 November, and asks in the week they disagree', () => {
  assert.equal(serverOffsetFor(T('2026-10-04T21:00:00Z'), cfg), 3);
  assert.equal(serverOffsetFor(T('2026-11-03T10:00:00Z'), cfg), 2);
  assert.equal(serverOffsetFor(T('2026-11-03T10:00:00Z'), withDefaults({ broker: { serverOffset: 3 } })), 3);
  assert.match(clockCheckLine(T('2026-10-27T10:00:00Z'), cfg), /MT5 chart read about \*\*13:00\*\*/);
  assert.equal(clockCheckLine(T('2026-10-20T10:00:00Z'), cfg), '');
  // Gold reopens at 01:02 server = 23:02 UTC in November; at 22:30 UTC it is still in its break.
  assert.equal(gateFor('XAUUSD', T('2026-11-03T22:30:00Z'), cfg).state, 'closed');
  assert.equal(gateFor('XAUUSD', T('2026-11-03T23:10:00Z'), cfg).allowed, true);
});
test('a check more than 15 minutes after the gate keeps the levels and the warning but gives no ticket', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const id = runId(d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'fast']));
  writeFileSync(join(d.home, 'runs', id, 'plan.json'), JSON.stringify(goodPlan));
  const r = replyOf(d.run(['check', '--run', id], '2026-10-05T13:20:00Z'));
  assert.match(r, /over 15 minutes old/);
  assert.doesNotMatch(r, /MT5 ticket|Volume/);
});
test('a discarded run stays discarded when checked again after the blackout ends', () => {
  const d = deskEnv('2026-10-02T12:00:00Z');
  const id = runId(d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'fast']));
  writeFileSync(join(d.home, 'runs', id, 'plan.json'), JSON.stringify(goodPlan));
  assert.match(d.run(['check', '--run', id], '2026-10-02T12:20:00Z'), /STATUS: discarded/);
  const again = d.run(['check', '--run', id], '2026-10-02T13:30:00Z');
  assert.match(again, /STATUS: discarded/);
  assert.doesNotMatch(again, /MT5 ticket/);
});
test('size during a gold blackout leads with the stand-aside; it names the instrument; it will not guess one', () => {
  const d = deskEnv('2026-10-02T12:35:00Z');
  const r = d.run(['size', '--stop', '8', '--pair', 'gold']);
  assert.match(r, /■ Stand aside · Gold[\s\S]*Non-Farm Payrolls[\s\S]*Gold: volume for your 8\.00 stop/);
  assert.match(sh(d, ['size', '--stop', '8']), /EXIT 2[\s\S]*Which instrument/);
});
test('size uses a spread the user typed, so a wide one sizes smaller', () => {
  const d = deskEnv('2026-10-04T21:20:00Z');
  const usual = d.run(['size', '--stop', '300', '--pair', 'btc']).match(/\*\*([\d,.]+) lots\*\*/)[1];
  const wide = d.run(['size', '--stop', '300', '--pair', 'btc', '--spread', '60']).match(/\*\*([\d,.]+) lots\*\*/)[1];
  assert.ok(Number(wide.replace(/,/g, '')) < Number(usual.replace(/,/g, '')), `${wide} < ${usual}`);
});
test('the gate runs before the price is asked for; a missing price and spread are asked for together', () => {
  const d = deskEnv('2026-10-04T21:20:00Z');
  assert.match(d.run(['gate', '--pair', 'gold']), /STATUS: blocked/);
  const r = d.run(['gate', '--pair', 'btc']);
  assert.match(r, /STATUS: need-price/);
  assert.match(r, /price now in MT5[\s\S]*And the spread/);
});
test('the spread example matches the instrument', () => {
  const d = deskEnv('2026-10-05T17:30:00Z');   // Monday 18:30 London: outside the window
  assert.match(d.run(['gate', '--pair', 'btc', '--price', '84400']), /84,400\.00 and 84,406\.00 is 6\.00/);
});
test('two pictures sent together: the session is asked which is the chart; --image picks one', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const a = d.upload();
  const b = join(dirname(a), 'second-image.jpg');
  writeFileSync(b, 'jpg');
  const t = new Date(Date.parse('2026-10-05T13:00:00Z') - 10e3);
  utimesSync(b, t, t);
  const out = d.run(['gate', '--pair', 'gold', '--price', '4400']);
  assert.match(out, /STATUS: need-image/);
  assert.ok(out.includes(a) && out.includes(b));
  assert.doesNotMatch(out, /--- reply ---/);
  const go = d.run(['gate', '--pair', 'gold', '--price', '4400', '--image', b]);
  assert.match(go, /STATUS: go · thorough/);
  assert.ok(go.includes(`open the image ${b}`));
});
test('an unreadable plan gives the session a note and the user nothing technical', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  const id = runId(d.run(['gate', '--pair', 'gold', '--price', '4400', '--mode', 'fast']));
  const out = d.run(['check', '--run', id]);
  assert.match(out, /STATUS: error/);
  assert.doesNotMatch(out, /--- reply ---/);
});
test('config refuses nonsense and leaves the file alone; a corrupt file stops the desk instead of being overwritten', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  for (const bad of ['leverage', 'leverage=7', 'risk=50', 'balance=abc', 'serveroffset=', 'sizefrom=demo']) {
    assert.match(sh(d, ['config', bad]), /EXIT 2/, bad);
  }
  const cfgPath = join(d.home, 'config.json');
  assert.equal(readFileSync(cfgPath, 'utf8'), '{}');
  writeFileSync(cfgPath, '{"account": {"balance": 10');
  assert.match(sh(d, ['config', 'risk=0.5']), /EXIT 1[\s\S]*not valid JSON/);
  assert.equal(readFileSync(cfgPath, 'utf8'), '{"account": {"balance": 10');
});
test('--key=value works like --key value', () => {
  const d = deskEnv('2026-10-04T21:20:00Z');
  assert.match(d.run(['gate', '--pair=btc', '--price=84400', '--spread=12', '--mode=fast']), /STATUS: go · fast/);
});
test('edge refuses an impossible record and saves nothing', () => {
  const d = deskEnv('2026-10-05T13:00:00Z');
  assert.match(d.run(['edge', '--trades', '10', '--wins', '12']), /STATUS: need-input[\s\S]*Winners cannot be more than trades/);
  assert.equal(readFileSync(join(d.home, 'config.json'), 'utf8'), '{}');
  assert.match(sh(d, ['edge', '--pair', 'eurusd']), /EXIT 2/);
});
test('a plan can be set with the count so far, so a lost count is restored', () => {
  const d = deskEnv('2026-10-05T10:00:00Z');
  assert.match(d.run(['plan', 'set', '--setups', 'Breakout', '--max', '4', '--taken', '2']), /2 of 4 trades/);
});
test('a brief with an overnight range and no instrument named keeps both instruments', () => {
  const d = deskEnv('2026-10-05T06:30:00Z');
  const r = d.run(['brief', '--high', '84700', '--low', '83900', '--now', '84650']);
  assert.match(r, /\*\*Gold\*\*/);
  assert.match(r, /\*\*Bitcoin\*\*[\s\S]*Overnight 83,900\.00–84,700\.00: price is near the overnight high/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
