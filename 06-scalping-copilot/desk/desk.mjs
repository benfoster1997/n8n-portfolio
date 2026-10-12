#!/usr/bin/env node
/**
 * desk.mjs — the scalp desk's commands, run by the Claude session the user is
 * chatting with. The user never types these; they send a screenshot and a
 * price, and the session follows .claude/skills/scalp-desk/SKILL.md.
 *
 *   now                                   both instruments: open, closed, warnings; next news; plan
 *   brief [--only P] [--high H --low L --now N [--pair P]]
 *   news  [--pair P] [--days 7]
 *   gate  --pair P [--price N] [--spread S] [--mode thorough|fast] [--image PATH] [--tf M5|M15]
 *                                         may a screenshot be read now? writes the reader prompts
 *                                         (--tf: a timeframe the user named for this chart; else the setting)
 *   head  --run ID                        after the three readings: the head trader's prompt
 *   check --run ID                        the checks, the lot size and the reply text
 *   size  --stop D [--pair P] [--spread S] [--price N]
 *                                         lots for a stop the user typed
 *   plan  set --setups "a, b" --max N [--other "..."] [--taken N] | took | undo | show | clear
 *   config [key=value ...]                show or change the account settings
 *   edge  [--trades N --wins W --rr R --planned P --perday D --stop S]   totals, not increments
 *   scan  [--pair P]                      one read of the live chart now (desk/live.mjs)
 *   watch [--pair P] [--hours H] [--anytime] [--once] | --stop
 *                                         read the live chart at every bar close; exits with
 *                                         STATUS: alert (and the reply) when an idea passes
 *   take  --price N [--pair P] [--spread S]
 *                                         the last alert, as a ticket from the user's MT5 price
 *
 * Output: a STATUS line for the session, maybe NOTE lines for the session
 * only, then the text to send the user between "--- reply ---" and
 * "--- end ---". The session sends that text as it is; it does not add a
 * direction, a level or a time to the close.
 *
 * State lives in $SCALP_DESK_HOME (default ~/.scalp-desk): runs, today's plan,
 * the last spread typed, the watcher's alerts and status. The account settings
 * live in desk/config.json, which is committed so they survive the container
 * being reclaimed. The gold feed's key is read from $TWELVEDATA_API_KEY, set in
 * the cloud environment's settings — never in the repo or the chat.
 *
 * Network commands re-run themselves with NODE_USE_ENV_PROXY=1 when the
 * environment has a proxy and it is not set: Node's fetch ignores HTTPS_PROXY
 * otherwise, and every request fails with ENOTFOUND. $SCALP_DESK_BARS (a JSON
 * file of bars per instrument) stands in for the feeds under test, and
 * $SCALP_DESK_NOW sets the clock; under it the watcher's waits move the clock
 * on instead of sleeping.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  withDefaults, pairOf, label, digitsOf, gateFor, gateWord, contextFor, formatBlocked, formatIdea,
  formatNow, formatBrief, formatNews, formatEdge, sizeFor, lotsOnlyLines, ticketLines,
  planLine, nextNewsLine, recentUploads, forChat, fmt, costFor, formatUnreadable, timeframeFor,
} from './lib.mjs';
import { INSTRUMENTS } from '../src/instruments.js';
import { LENSES, analystPrompt, headPrompt, fastPrompt, checkPlan, parseReply, shotMaxAgeMs } from '../src/shot.js';
import { tfInfo, timeframeOf } from '../src/timeframes.js';
import { SETUPS, planProblem, planStatus, dayKey } from '../src/brief.js';
import { formatHM } from '../src/timezone.js';
import { loadBars, closedBars } from '../src/data-feeds.js';
import { windowState } from '../src/sessions.js';
import {
  FETCH_BARS, liveRead, shouldAlert, ideaRecord, formatLiveIdea, formatLiveNone, takeIdea, nextPollMs, inWatchHours,
  minHistory, alertState,
} from './live.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.SCALP_DESK_HOME || join(homedir(), '.scalp-desk');
const UPLOADS = process.env.SCALP_DESK_UPLOADS || join(homedir(), '.claude', 'uploads');
const CONFIG = process.env.SCALP_DESK_CONFIG || join(here, 'config.json');
const NOW = process.env.SCALP_DESK_NOW ? Date.parse(process.env.SCALP_DESK_NOW) : Date.now();
const SPREAD_REUSE_MS = 60 * 60000;   // a spread typed within the hour still counts as typed
const BURST_MS = 2 * 60000;           // pictures this close together were sent as one batch

/* ---------------------------------------------------------------- plumbing */

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);   // never a half-written file
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      const next = argv[i + 1];
      // A following "-5" is a value, not a flag.
      out[k] = next !== undefined && !/^--[a-z]/i.test(next) ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

function say(status, reply, notes = []) {
  console.log(`STATUS: ${status}`);
  for (const n of notes) console.log(n);
  if (reply) console.log(`--- reply ---\n${reply}\n--- end ---`);
}

function usage(msg) {
  console.log(`STATUS: usage\n${msg}`);
  process.exit(2);
}

const num = (x) => (x === undefined || x === true || String(x).trim() === '' ? null : Number(String(x).replace(/,/g, '')));

/** The config file: missing means defaults; unreadable stops everything, so nothing overwrites it. */
function loadConfigFile() {
  if (!existsSync(CONFIG)) return {};
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) || {}; } catch (e) {
    console.log(`STATUS: error\nNOTE: ${CONFIG} is not valid JSON (${e.message}). Fix it from git (git diff / git checkout) before running the desk; nothing was changed.`);
    process.exit(1);
  }
}

const configFile = loadConfigFile();
const cfg = withDefaults(configFile);
const planPath = join(HOME, 'plan.json');
const loadPlan = () => readJson(planPath, null);
const spreadPath = join(HOME, 'spread.json');

/** A spread typed within the hour, or null. Reading never writes. */
function recentSpread(pair) {
  const s = readJson(spreadPath, {})[pair];
  return s && s.value > 0 && NOW - s.atMs <= SPREAD_REUSE_MS ? s : null;
}

/** The spread for this trade: typed now, typed within the hour, or the confirmed usual one. */
function spreadFor(pair, typed) {
  if (typed > 0) {
    writeJson(spreadPath, { ...readJson(spreadPath, {}), [pair]: { value: typed, atMs: NOW } });
    return { spreadNum: typed, spreadTyped: true, note: null };
  }
  const s = recentSpread(pair);
  if (s) return { spreadNum: s.value, spreadTyped: true, note: `Using the spread you sent at ${formatHM(s.atMs, cfg.window.tz)}: ${fmt(s.value, digitsOf(pair))}.` };
  return { spreadNum: INSTRUMENTS[pair].typicalSpread.observed, spreadTyped: false, note: null };
}

const spreadExample = (pair) => (pair === 'XAUUSD' ? '4,400.10 and 4,400.15 is 0.05' : '84,400.00 and 84,406.00 is 6.00');

const runDir = (id) => join(HOME, 'runs', id);
// Runs written before the timeframe setting (11 Oct 2026) were all M5.
const runTf = (ctx) => (ctx && timeframeOf(ctx.tf)) || 'M5';
const lastRunId = () => readText(join(HOME, 'last-run.txt'))?.trim() || null;

function loadRun(id) {
  const rid = id && id !== true ? id : lastRunId();
  if (!rid) usage('No run. Start with: gate --pair P --price N');
  const ctx = readJson(join(runDir(rid), 'ctx.json'));
  if (!ctx) usage(`No run called ${rid}.`);
  return { id: rid, dir: runDir(rid), ctx };
}

function readingsOf(dir) {
  return LENSES.map((lens, k) => {
    const v = parseReply(readText(join(dir, `reading-${k + 1}.json`)) || '');
    return v ? { ...v, lens: lens.name } : null;
  }).filter(Boolean);
}

/** A run id that cannot collide, even for two runs in the same minute. */
function newRunId(pair) {
  const base = `${new Date(NOW).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${pair}`;
  for (let k = 1; ; k++) if (!existsSync(runDir(`${base}-${k}`))) return `${base}-${k}`;
}

/** Images earlier runs already read, so a re-sent old picture is noticed. */
function imagesAlreadyRead() {
  const id = lastRunId();
  const c = id ? readJson(join(runDir(id), 'ctx.json')) : null;
  return c && c.image ? [c.image] : [];
}

/* ------------------------------------------------------------ live prices */

const NET_CMDS = ['scan', 'watch', 'take'];
// Under test ($SCALP_DESK_NOW) the clock starts there and moves only when the
// watcher waits: a wait advances it instead of sleeping, so a whole morning of
// bar closes runs in a second. Otherwise both are the real clock.
let testSkewMs = 0;
const clock = () => (process.env.SCALP_DESK_NOW ? NOW + testSkewMs : Date.now());
const pause = (ms) => {
  if (process.env.SCALP_DESK_NOW) { testSkewMs += Math.max(0, ms); return Promise.resolve(); }
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
};
const watchPath = (f) => join(HOME, 'watch', f);
const goldKey = () => process.env.TWELVEDATA_API_KEY || '';
/** Can gold be read at all here: its key, or (under test) bars for it. */
const goldAvailable = () => (process.env.SCALP_DESK_BARS ? !!(readJson(process.env.SCALP_DESK_BARS, {}).XAUUSD || []).length : !!goldKey());

/**
 * Live bars for one instrument: the feeds, or $SCALP_DESK_BARS under test.
 * `preferred` asks for one source first — `take` compares prices only within
 * the source the alert was read from, since the feeds sit tens of dollars apart.
 */
async function liveBars(pair, tf, preferred = null) {
  const fixture = process.env.SCALP_DESK_BARS;
  if (fixture) {
    const bars = readJson(fixture, {})[pair] || [];
    if (bars.length) return { ok: true, bars, source: { id: 'test', label: 'test bars' } };
    // No gold bars stands for no gold key, as goldAvailable() reads it.
    return pair === 'XAUUSD' ? { ok: false, noKey: true, reason: 'no Twelve Data key ($TWELVEDATA_API_KEY)' } : { ok: false, reason: 'no test bars' };
  }
  if (pair === 'XAUUSD' && !goldKey()) return { ok: false, noKey: true, reason: 'no Twelve Data key ($TWELVEDATA_API_KEY)' };
  const r = await loadBars(pair, { keys: { twelvedata: goldKey() }, limit: FETCH_BARS, minutes: tfInfo(tf).minutes, allowProxy: false, preferred, minBars: minHistory(tf) });
  return r.ok
    ? { ok: true, bars: r.bars, source: { id: r.source.id, label: r.source.label } }
    : { ok: false, reason: r.attempts.map((x) => `${x.label}: ${x.reason}`).join('; ') };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Record alerts: re-read both files just before writing, so a scan and the watcher never undo each other. */
function recordAlerts(recs) {
  const ideas = readJson(watchPath('ideas.json'), {});
  const state = readJson(watchPath('state.json'), { lastAlert: {} });
  for (const rec of recs) { ideas[rec.pair] = rec; state.lastAlert[rec.pair] = alertState(rec); }
  writeJson(watchPath('ideas.json'), ideas);
  writeJson(watchPath('state.json'), state);
}

const KEY_HOW = 'Gold needs a free key from twelvedata.com (sign up, then API Keys). Add it in this session\'s cloud environment settings (title bar → environment → Edit) as an environment variable named TWELVEDATA_API_KEY — not in this chat — then start a new session. Bitcoin needs nothing.';

/* ---------------------------------------------------------------- commands */

const cmds = {
  now() {
    say('info', formatNow(NOW, cfg, loadPlan()));
  },

  brief(a) {
    const only = a.only ? pairOf(a.only) : null;
    const [h, l, n] = [num(a.high), num(a.low), num(a.now)];
    let range = null;
    if (h || l || n) {
      if (!(h > 0 && l > 0 && n > 0)) usage('The overnight range needs all three: --high, --low and --now.');
      // The range belongs to the instrument named, or to whichever one the prices are.
      const pair = (a.pair && pairOf(a.pair)) || (h > 20000 ? 'BTCUSD' : 'XAUUSD');
      range = { pair, high: h, low: l, now: n };
    }
    say('info', formatBrief(NOW, cfg, loadPlan(), only ? [only] : ['XAUUSD', 'BTCUSD'], range));
  },

  news(a) {
    const pair = a.pair ? pairOf(a.pair) : null;
    if (a.pair && !pair) usage('Which instrument? --pair gold or --pair bitcoin');
    say('info', formatNews(NOW, cfg, pair, num(a.days) || 7));
  },

  gate(a) {
    const pair = pairOf(a.pair);
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin');
    if (a.tf !== undefined && !timeframeOf(a.tf)) usage('--tf must be M5 or M15.');
    const tf = timeframeFor(cfg, a.tf);
    const nm = label(pair).toLowerCase();
    // The gate first: a shut market or a stand-down needs no price.
    const g = gateFor(pair, NOW, cfg, tf);
    if (!g.allowed) return say('blocked', formatBlocked(pair, g));
    const priceNow = num(a.price);
    const typedSpread = num(a.spread);
    if (typedSpread !== null && !(typedSpread > 0)) usage('--spread must be a positive number.');
    const spreadMissing = g.needsSpread && !(typedSpread > 0) && !recentSpread(pair);
    const askSpread = `the spread: the gap between the two prices on the Quotes tab (${spreadExample(pair)}), not the "points" figure MT5 can show`;
    if (!(priceNow > 0)) {
      if (typedSpread > 0) spreadFor(pair, typedSpread);
      return say('need-price', [
        `What is the ${nm} price now in MT5? (The Quotes tab — the lower of the two prices.)${spreadMissing ? ` And ${askSpread}.` : ''}`,
        'I need the price before I read the chart: it is the one check that does not depend on reading the picture.',
        spreadMissing ? forChat(g.message) : '',
      ].filter(Boolean).join('\n\n'));
    }
    const sp = spreadFor(pair, typedSpread);
    if (g.needsSpread && !sp.spreadTyped) {
      return say('need-spread', `${forChat(g.message)}\n\nWhat is ${askSpread}?`);
    }

    let mode = a.mode === 'fast' || a.mode === 'thorough' ? a.mode : cfg.mode;
    const notes = [];
    let image = null;
    if (a.image && a.image !== true) {
      if (!existsSync(a.image)) usage(`No picture at ${a.image}.`);
      image = { path: String(a.image), ageMs: 0 };
    } else if (mode === 'thorough') {
      // As old as the readers would still accept (15 minutes on M5, 30 on M15).
      const recent = recentUploads(UPLOADS, NOW, tfInfo(tf).staleChartMin * 60000);
      const batch = recent.filter((x) => recent[0].mtimeMs - x.mtimeMs <= BURST_MS);
      if (batch.length > 1) {
        // Two or more pictures sent together: the session must say which is this instrument's chart.
        return say('need-image', null, [
          `NOTE: ${batch.length} pictures arrived together. Open each with the Read tool, find the ${pair} chart (the ${tf} one, if there are two), and run gate again with --image <its path>:`,
          ...batch.map((x) => `  ${x.path} (${Math.round(x.ageMs / 1000)} s ago)`),
        ]);
      }
      image = recent[0] || null;
      if (image && imagesAlreadyRead().includes(image.path)) {
        notes.push(`NOTE: this picture was already read in the last run. If the user has just sent a new screenshot, it is not on disk yet — open the newest upload or use --mode fast.`);
      }
      if (!image) {
        mode = 'fast';
        notes.push(`NOTE: no uploaded picture found on disk in the last ${tfInfo(tf).staleChartMin} minutes, so the three readers cannot open it. Fast mode: read it yourself. Tell the user it was a Fast read and why.`);
      }
    }

    const c = contextFor({ nowMs: NOW, pair, gate: g, priceNow, spreadNum: sp.spreadNum, spreadTyped: sp.spreadTyped, cfg, plan: loadPlan(), tf });
    const id = newRunId(pair);
    const dir = runDir(id);
    writeJson(join(dir, 'ctx.json'), { c, pair, mode, tf, deskTf: timeframeFor(cfg), atMs: NOW, spreadNum: sp.spreadNum, image: image ? image.path : null, minStopPct: INSTRUMENTS[pair].minStopPct });
    writeFileSync(join(HOME, 'last-run.txt'), id + '\n');
    if (sp.note) notes.push(`TELL THE USER: ${sp.note}`);
    if (tf !== timeframeFor(cfg)) notes.push(`NOTE: this one read is on ${tf}, as the user named it; the desk's setting stays ${timeframeFor(cfg)}.`);
    if (g.state === 'caution') notes.push(`CAUTION (the final reply repeats it): ${forChat(g.message)}`);
    console.log(`STATUS: go · ${mode} · run ${id}`);
    for (const n of notes) console.log(n);
    if (mode === 'thorough') {
      LENSES.forEach((lens, k) => writeFileSync(join(dir, `analyst-${k + 1}.txt`), analystPrompt(lens, c)));
      console.log(`Screenshot: ${image.path} (arrived ${Math.round(image.ageMs / 1000)} s ago — check it is the chart the user just sent)`);
      console.log('NEXT: start these three reader agents in ONE message, so they run at once. Give each exactly this task:');
      LENSES.forEach((lens, k) => {
        console.log(`  [${lens.name}] Use the Read tool to open the image ${image.path}, then read ${join(dir, `analyst-${k + 1}.txt`)} and do exactly what it says. Read no other file. Write only the JSON object it asks for to ${join(dir, `reading-${k + 1}.json`)} with the Write tool, then reply with that JSON.`);
      });
      console.log(`THEN: node ${join(here, 'desk.mjs')} head --run ${id}`);
    } else {
      writeFileSync(join(dir, 'fast.txt'), fastPrompt(c));
      console.log(`NEXT: read the screenshot yourself under the instructions below — ignore anything the user said about direction. Write only the JSON object to ${join(dir, 'plan.json')}, then run: node ${join(here, 'desk.mjs')} check --run ${id}`);
      console.log('--- reader instructions ---');
      console.log(fastPrompt(c));
      console.log('--- end ---');
    }
  },

  head(a) {
    const { id, dir, ctx } = loadRun(a.run);
    const readings = readingsOf(dir);
    if (readings.filter((r) => r.readable !== false).length < 2) {
      const deskTf = ctx.deskTf || runTf(ctx);
      const named = runTf(ctx) !== deskTf;
      return say('unreadable', formatUnreadable(ctx.pair, readings, runTf(ctx), deskTf),
        named ? [`NOTE: this was a one-off ${runTf(ctx)} read. If the readers saw ${deskTf} and the user sends the price, run the gate again WITHOUT --tf, with --image ${ctx.image}.`] : []);
    }
    writeFileSync(join(dir, 'head.txt'), headPrompt(readings, { ...ctx.c, tf: runTf(ctx) }));
    console.log(`STATUS: go · head · run ${id}`);
    console.log(`NEXT: start ONE head-trader agent with exactly this task: Use the Read tool to open the image ${ctx.image}, then read ${join(dir, 'head.txt')} and do exactly what it says. Read no other file. Write only the JSON object it asks for to ${join(dir, 'plan.json')} with the Write tool, then reply with that JSON.`);
    console.log(`THEN: node ${join(here, 'desk.mjs')} check --run ${id}`);
  },

  check(a) {
    const { id, dir, ctx } = loadRun(a.run);
    const { pair } = ctx;
    const tf = runTf(ctx);
    const c = { ...ctx.c, tf };
    const discard = (g) => say('discarded', `**■ ${gateWord(g)} · ${label(pair)}**\n\n${forChat(g.message)} The analysis was discarded.`);
    const prior = readJson(join(dir, 'result.json'));
    if (prior && prior.discarded) return discard(prior.gate || gateFor(pair, NOW, cfg, tf));
    const plan = parseReply(readText(join(dir, 'plan.json')) || '');
    if (!plan) {
      return say('error', null, [
        `NOTE: no readable plan in ${join(dir, 'plan.json')}. Write the reader's JSON object there and run check --run ${id} again.`,
        'NOTE: if it fails twice, tell the user the chart could not be read this time and ask them to send the screenshot and price again.',
      ]);
    }
    const thorough = ctx.mode === 'thorough';
    const readings = thorough ? readingsOf(dir) : [];
    const result = checkPlan(plan, readings, {
      priceNow: c.priceNow, cost: c.costNum, digits: c.digits, pair, minStopPct: ctx.minStopPct,
      asked: thorough ? LENSES.length : 0, lastStretch: c.lastStretch, timeframe: tf,
    });
    // The gate again, at the end: a release or the quiet hours may have begun meanwhile.
    const after = gateFor(pair, NOW, cfg, tf);
    if (!after.allowed) {
      writeJson(join(dir, 'result.json'), { discarded: true, gate: after, result });
      return discard(after);
    }
    const trade = result.decision === 'buy' || result.decision === 'sell';
    // Past its timeframe's age limit (15 minutes on M5, 30 on M15): the levels
    // and the warning, but no ticket (the page hides it too).
    const fresh = NOW - ctx.atMs <= shotMaxAgeMs(tf);
    const sized = trade && fresh ? sizeFor({
      pair, cfg, stop: result.stopDistance, entry: result.entry, spreadNum: ctx.spreadNum,
      side: result.decision, stopLoss: result.stopLoss, target: result.takeProfit1,
    }) : null;
    writeJson(join(dir, 'result.json'), { result, checkedAtMs: NOW });
    const tail = [nextNewsLine(NOW, pair, cfg.window), planLine(loadPlan(), NOW, cfg.window)].filter(Boolean).join('\n');
    const reply = formatIdea({ result, pair, ctx: c, cfg, mode: ctx.mode, atMs: ctx.atMs, nowMs: NOW, sized, readings, deskTf: ctx.deskTf || tf }) + (tail ? `\n\n${tail}` : '');
    say(`done · ${result.decision}${result.rejected ? ' (rejected)' : ''}`, reply,
      result.rejected ? ['RULE: a rejected idea\'s direction and levels are never passed on — not in your own words either.'] : []);
  },

  size(a) {
    const stop = num(a.stop);
    if (!(stop > 0)) usage('size --stop D, where D is the stop distance in dollars (8 means $8 on gold).');
    const lastId = lastRunId();
    const last = lastId ? readJson(join(runDir(lastId), 'ctx.json')) : null;
    const lastRes = lastId ? readJson(join(runDir(lastId), 'result.json')) : null;
    const lastFresh = last && NOW - last.atMs <= shotMaxAgeMs(runTf(last));
    // The instrument: as named, or the last screenshot's if that is recent. Never a guess.
    const pair = a.pair ? pairOf(a.pair) : lastFresh ? last.pair : null;
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin (ask the user if the conversation does not say).');
    const g = gateFor(pair, NOW, cfg);
    const d = digitsOf(pair);
    const isIdea = lastRes && !lastRes.discarded && last.pair === pair && ['buy', 'sell'].includes(lastRes.result.decision);
    if (isIdea && lastFresh && g.allowed) {
      const r = lastRes.result;
      const s = sizeFor({ pair, cfg, stop, entry: r.entry, spreadNum: last.spreadNum, side: r.decision, stopLoss: r.stopLoss, target: r.takeProfit1, typedStop: true });
      const lines = ticketLines(s, pair, cfg);
      if (s.tk) lines.push(`Stop loss set at your ${fmt(stop, d)} stop distance, not the analysis's ${fmt(r.stopDistance, d)}.`);
      return say('info', lines.join('\n'));
    }
    // Lots only — with the reason there is no idea to attach them to, as the page says it.
    const lead = !g.allowed ? [`**■ ${gateWord(g)} · ${label(pair)}**`, forChat(g.message)]
      : isIdea ? [`Your last ${label(pair).toLowerCase()} idea is over ${tfInfo(runTf(last)).maxAgeMin} minutes old — send a new screenshot and the price for levels.`]
        : [];
    const sp = spreadFor(pair, num(a.spread));
    const price = num(a.price) || (pair === 'XAUUSD' ? 4390 : 84400);   // lots do not depend on price; only margin does
    const s = sizeFor({ pair, cfg, stop, entry: price, spreadNum: sp.spreadNum });
    say('info', [...lead, ...lotsOnlyLines(s, stop, cfg, pair)].join('\n'));
  },

  plan(a) {
    const sub = a._[1] || 'show';
    const today = dayKey(NOW, cfg.window);
    const cur = loadPlan();
    if (sub === 'set') {
      const named = String(a.setups === true ? '' : a.setups || '').split(',').map((x) => x.trim()).filter(Boolean);
      const setups = [], other = [];
      for (const n of named) {
        const hit = SETUPS.find((s) => s.toLowerCase() === n.toLowerCase());
        if (hit) setups.push(hit); else other.push(n);
      }
      if (a.other && a.other !== true) other.push(String(a.other));
      const maxTrades = num(a.max);
      const draft = { setups, other: other.join(', '), maxTrades };
      const problem = planProblem(draft);
      if (problem) return say('need-input', problem);
      const typedTaken = num(a.taken);
      if (typedTaken !== null && !(Number.isInteger(typedTaken) && typedTaken >= 0)) usage('--taken must be a whole number, 0 or more.');
      const kept = planStatus(cur, today);
      writeJson(planPath, { date: today, ...draft, taken: typedTaken !== null ? typedTaken : kept ? kept.taken : 0 });
    } else if (sub === 'took' || sub === 'undo') {
      const ps = planStatus(cur, today);
      if (!ps) return say('need-input', 'No plan set for today, so there is nothing to count it against yet. Tell me your setups and the most trades you will take, and I will count this one.');
      writeJson(planPath, { ...cur, taken: Math.max(0, ps.taken + (sub === 'took' ? 1 : -1)) });
    } else if (sub === 'clear') {
      writeJson(planPath, null);
      return say('info', 'Plan cleared.');
    } else if (sub !== 'show') usage('plan set | took | undo | show | clear');
    const ps = planStatus(loadPlan(), today);
    say('info', ps ? `Today's plan: ${ps.setups.join(' · ')}, up to ${ps.max} trades.\n${planLine(loadPlan(), NOW, cfg.window)}` : 'No plan set for today.');
  },

  config(a) {
    const file = { ...configFile };
    const sets = a._.slice(1);
    const pos = (v) => { const n = Number(v); return n > 0 && Number.isFinite(n) ? n : NaN; };
    const KEYS = {
      balance: ['account', 'balance', pos],
      currency: ['account', 'currency', (v) => (['GBP', 'USD', 'EUR'].includes(v.toUpperCase()) ? v.toUpperCase() : NaN)],
      risk: ['account', 'riskPct', (v) => { const n = Number(v); return n > 0 && n <= 5 ? n : NaN; }],
      gbpusd: ['account', 'gbpusd', (v) => { const n = Number(v); return n > 0.5 && n < 3 ? n : NaN; }],
      leverage: ['account', 'leverage', (v) => ([20, 30, 50, 100, 200, 500].includes(Number(v)) ? Number(v) : NaN)],
      shadow: ['account', 'shadowBalance', (v) => (v === 'none' ? null : pos(v))],
      sizefrom: ['account', 'sizeFrom', (v) => (v === 'shadow' || v === 'account' ? v : NaN)],
      commission: ['account', 'commissionPerSideGBP', (v) => (v === 'spec' ? null : Number(v) >= 0 && v !== '' ? Number(v) : NaN)],
      serveroffset: ['broker', 'serverOffset', (v) => (v === 'auto' ? 'auto' : Number.isInteger(Number(v)) && v !== '' && Math.abs(Number(v)) <= 14 ? Number(v) : NaN)],
      mode: [null, 'mode', (v) => (v === 'fast' || v === 'thorough' ? v : NaN)],
      timeframe: [null, 'timeframe', (v) => timeframeOf(v) || NaN],
    };
    for (const kv of sets) {
      const eq = kv.indexOf('=');
      if (eq < 1 || eq === kv.length - 1) usage(`Write settings as key=value, e.g. risk=0.5. Known: ${Object.keys(KEYS).join(', ')}`);
      const k = kv.slice(0, eq), v = kv.slice(eq + 1).replace(/,/g, '').trim();
      const spec = KEYS[k.toLowerCase()];
      if (!spec) usage(`Unknown setting ${k}. Known: ${Object.keys(KEYS).join(', ')}`);
      const [section, key, conv] = spec;
      const val = conv(v);
      if (typeof val === 'number' && Number.isNaN(val)) usage(`${k}=${v} is not allowed. Nothing was changed.`);
      if (section) file[section] = { ...(file[section] || {}), [key]: val };
      else file[key] = val;
    }
    // A setting given its current value changes nothing, and needs no commit.
    const changed = sets.length > 0 && JSON.stringify(file) !== JSON.stringify(configFile);
    if (changed) writeJson(CONFIG, file);
    const c = withDefaults(file);
    const ac = c.account;
    say(changed ? 'changed · commit desk/config.json' : sets.length ? 'unchanged' : 'info', [
      '**Desk settings**',
      `- Balance ${ac.currency} ${fmt(ac.balance, 2)} · risk ${ac.riskPct}% a trade`,
      `- Shadow balance ${ac.shadowBalance ? `${ac.currency} ${fmt(ac.shadowBalance, 2)}` : 'not set'} · sizing from **${ac.sizeFrom === 'shadow' && ac.shadowBalance ? 'the shadow balance' : 'the account balance'}**`,
      `- GBP/USD ${ac.gbpusd} · leverage 1:${ac.leverage}`,
      `- Commission ${ac.commissionPerSideGBP === null ? 'from the spec (gold £2.75 a lot each side, bitcoin none)' : `£${ac.commissionPerSideGBP} a lot each side`}`,
      `- MT5 server clock ${c.broker.serverOffset === 'auto' ? 'follows New York + 7 (UTC+3 now, UTC+2 from 1 November)' : `UTC${c.broker.serverOffset >= 0 ? '+' : ''}${c.broker.serverOffset}`} · screenshots read **${c.mode === 'fast' ? 'Fast (one reader)' : 'Thorough (three readers and a head trader)'}** unless you say otherwise`,
      `- Chart **${timeframeFor(c)}** (${tfInfo(timeframeFor(c)).words}) · an idea feeds a ticket for ${tfInfo(timeframeFor(c)).maxAgeMin} minutes`,
    ].join('\n'));
  },

  edge(a) {
    const rec = { ...withDefaults(configFile).record };
    const map = { trades: 'trades', wins: 'wins', rr: 'rewardRisk', planned: 'plannedSample', perday: 'perDay', stop: 'typicalStop' };
    let changed = false;
    for (const [k, key] of Object.entries(map)) if (num(a[k]) !== null) { rec[key] = num(a[k]); changed = true; }
    const whole = (x) => Number.isInteger(x) && x >= 0;
    const bad = !whole(rec.trades) ? 'Trades must be a whole number, 0 or more.'
      : !whole(rec.wins) ? 'Winners must be a whole number, 0 or more.'
        : rec.wins > rec.trades ? 'Winners cannot be more than trades.'
          : !(rec.rewardRisk > 0) ? 'Reward-to-risk must be above 0.'
            : !whole(rec.plannedSample || 0) ? 'The committed sample must be a whole number.'
              : !(rec.perDay > 0) ? 'Trades per day must be above 0.'
                : rec.typicalStop !== undefined && !(rec.typicalStop > 0) ? 'A typical stop must be above 0.' : null;
    if (bad) return say('need-input', `${bad} Nothing was saved.`);
    if (changed) writeJson(CONFIG, { ...configFile, record: rec });
    // Cost in R, from gold's usual cost unless told otherwise.
    const pair = a.pair ? pairOf(a.pair) : 'XAUUSD';
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin');
    const cost = costFor(pair, INSTRUMENTS[pair].typicalSpread.observed, cfg).cost;
    const costInRisk = rec.typicalStop > 0 ? cost / rec.typicalStop : 0;
    say(changed ? 'changed · commit desk/config.json' : 'info', formatEdge(rec, costInRisk));
  },

  async scan(a) {
    const tf = timeframeFor(cfg);
    const pairs = a.pair ? [pairOf(a.pair)] : ['XAUUSD', 'BTCUSD'];
    if (pairs.includes(null)) usage('Which instrument? --pair gold or --pair bitcoin');
    const replies = [], notes = [], recs = [];
    for (const pair of pairs) {
      const lb = await liveBars(pair, tf);
      if (!lb.ok) {
        if (lb.noKey) { if (a.pair) replies.push(KEY_HOW); else notes.push(`NOTE: ${pair} skipped — ${lb.reason}.`); }
        else replies.push(`**${label(pair)}:** the live feed is not answering just now. Send a screenshot instead.`), notes.push(`NOTE: ${pair} feeds — ${lb.reason}`);
        continue;
      }
      const r = liveRead({ pair, bars: lb.bars, nowMs: clock(), cfg, plan: loadPlan(), source: lb.source });
      if (r.kind === 'idea') {
        const rec = ideaRecord(r);
        recs.push(rec);
        replies.push(formatLiveIdea(rec, cfg, clock(), loadPlan()));
      } else replies.push(formatLiveNone(r, cfg));
    }
    if (recs.length) recordAlerts(recs);
    say('info', replies.join('\n\n'), notes);
  },

  async watch(a) {
    const pidFile = watchPath('watch.pid');
    const running = Number(readText(pidFile)) || 0;
    if (a.stop) {
      if (running && alive(running) && running !== process.pid) process.kill(running);
      rmSync(pidFile, { force: true });
      return say('stopped', running ? 'Stopped watching.' : 'I was not watching.');
    }
    if (running && running !== process.pid && alive(running)) {
      return say('already', null, [`NOTE: a watcher is already running (pid ${running}). Stop it first with: watch --stop`]);
    }
    const tf = timeframeFor(cfg);
    const anytime = !!a.anytime;
    const maxMs = (num(a.hours) || 1.9) * 3600e3;
    let pairs = a.pair ? [pairOf(a.pair)] : ['XAUUSD', 'BTCUSD'];
    if (pairs.includes(null)) usage('Which instrument? --pair gold or --pair bitcoin');
    const notes = [];
    if (!goldAvailable() && pairs.includes('XAUUSD')) {
      pairs = pairs.filter((p) => p !== 'XAUUSD');
      notes.push('NOTE: gold is not watched — no Twelve Data key ($TWELVEDATA_API_KEY) in this session.');
      if (!pairs.length) return say('need-key', KEY_HOW, notes);
    }
    mkdirSync(watchPath(''), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
    const started = clock();
    const errors = {};
    const status = { startedAtMs: clock(), pairs, tf, polls: 0, last: {} };
    console.log(`WATCHING: ${pairs.map((p) => label(p)).join(' and ')} on ${tfInfo(tf).id}${anytime ? ', at any hour' : ', in the window'}.`);
    const finish = (st, reply, extra = []) => {
      rmSync(pidFile, { force: true });
      writeJson(watchPath('status.json'), { ...status, endedAtMs: clock(), ended: st });
      say(st, reply, [...notes, ...extra]);
      process.exit(0);
    };

    for (;;) {
      const now = clock();
      if (!inWatchHours(now, cfg, anytime)) {
        const w = windowState(now, cfg.window);
        if (w.phase === 'before' && !a.once) {
          // Wait for the open — in real time, up to the cap. An instant exit here
          // had the session restarting it in a tight loop before 06:00.
          const left = maxMs - (clock() - started);
          if (left <= 60000) finish('timeout', null, ['NOTE: the window has not opened yet; start the watch again (no message to the user).']);
          await pause(Math.min(w.opensAtMs - now + 20000, left - 30000));
          continue;
        }
        finish('stopped', null, [`NOTE: outside the watch hours (${w.phase}). Tell the user the watch has stopped for today, in one line.`]);
      }
      const alerts = [], gone = [];
      for (const pair of pairs) {
        const lb = await liveBars(pair, tf);
        if (!lb.ok) {
          errors[pair] = (errors[pair] || 0) + 1;
          status.last[pair] = { kind: 'feed-error', atMs: now, reason: lb.reason };
          if (errors[pair] >= 3) gone.push({ pair, reason: lb.reason });
          continue;
        }
        errors[pair] = 0;
        const r = liveRead({ pair, bars: lb.bars, nowMs: now, cfg, plan: loadPlan(), source: lb.source });
        status.last[pair] = { kind: r.kind, atMs: now, price: r.price ?? null, source: lb.source.label, barCloseMs: r.barCloseMs ?? null };
        const state = readJson(watchPath('state.json'), { lastAlert: {} });
        // Whether the last alert is still running is judged on closed bars, as the replay does.
        if (r.kind === 'idea' && shouldAlert(state, r, closedBars(lb.bars, tfInfo(tf).minutes, now), cfg)) alerts.push(r);
      }
      status.polls += 1;
      writeJson(watchPath('status.json'), status);
      // A feed that failed three polls in a row is dropped, and only that one. The
      // other instrument is still read on the same poll, so an idea on it is sent
      // rather than lost to the exit.
      const names = (ps) => ps.map((p) => label(p).toLowerCase()).join(' and ');
      const rest = pairs.filter((p) => !gone.some((g) => g.pair === p));
      const goneNotes = gone.map((g) => `NOTE: ${g.reason}`);
      if (gone.length && !rest.length) finish('error', `The live ${names(pairs)} feed${pairs.length > 1 ? 's have' : ' has'} stopped answering, so I have stopped watching. Send screenshots meanwhile, or tell me to start watching again.`, goneNotes);
      const goneLine = gone.length ? `The live ${names(gone.map((g) => g.pair))} feed has stopped answering, so I have stopped watching ${names(gone.map((g) => g.pair))}. Still watching ${names(rest)}.` : null;
      const again = gone.length ? ` with: watch --pair ${rest.map((p) => (p === 'XAUUSD' ? 'gold' : 'bitcoin')).join(' ')}` : '.';
      if (alerts.length) {
        const recs = alerts.map((r) => ideaRecord(r));
        recordAlerts(recs);
        finish('alert', [...recs.map((rec) => formatLiveIdea(rec, cfg, now, loadPlan())), goneLine].filter(Boolean).join('\n\n'), [...goneNotes, `NOTE: send the reply, push a one-line notification, then start the watch again${again}`]);
      }
      if (gone.length) finish('dropped', goneLine, [...goneNotes, `NOTE: send the reply, then start the watch again${again}`]);
      if (a.once) finish('quiet', null, pairs.map((p) => `NOTE: ${p} ${status.last[p] ? status.last[p].kind : 'not read'}`));
      const next = nextPollMs(clock(), tf);
      if (next - started > maxMs) finish('timeout', null, ['NOTE: the watch reached its time limit; start it again (no message to the user).']);
      await pause(next - clock());
    }
  },

  async take(a) {
    const price = num(a.price);
    if (!(price > 0)) usage('take --price N, the price on MT5\'s Quotes tab now.');
    const ideas = readJson(watchPath('ideas.json'), {});
    // The instrument named; else the alerts still in date, and if both are, the one
    // whose price the typed one is near (gold ~4,000 and bitcoin ~84,000 cannot be confused).
    const live = Object.values(ideas).filter((x) => clock() <= x.validUntilMs);
    const near = (x) => Math.abs(Math.log(price / x.refPrice));
    const pair = a.pair ? pairOf(a.pair)
      : (live.length ? live.sort((x, y) => near(x) - near(y))[0] : Object.values(ideas).sort((x, y) => y.barCloseMs - x.barCloseMs)[0])?.pair;
    const rec = pair ? ideas[pair] : null;
    if (!rec) return say('need-input', 'There is no live idea to take. Wait for an alert, or send a screenshot and the price.');
    const typed = num(a.spread);
    if (typed !== null && !(typed > 0)) usage('--spread must be a positive number.');
    const sp = spreadFor(pair, typed);
    const lb = await liveBars(pair, rec.tf, rec.sourceId);
    // Only a price from the same feed as the alert says whether it has moved.
    const livePrice = lb.ok && (lb.source.id === rec.sourceId || rec.sourceId === null) ? lb.bars[lb.bars.length - 1].c : null;
    const res = takeIdea({ rec, priceNow: price, livePrice, nowMs: clock(), cfg, spreadNum: sp.spreadNum, typedSpread: sp.spreadTyped });
    say(res.ok ? 'done · ticket' : res.needSpread ? 'need-spread' : 'refused', res.text, lb.ok ? [] : [`NOTE: feeds — ${lb.reason}`]);
  },
};

const args = parseArgs(process.argv.slice(2));
const cmd = cmds[args._[0]];
if (!cmd) usage(`Commands: ${Object.keys(cmds).join(', ')}`);
if (NET_CMDS.includes(args._[0]) && !process.env.SCALP_DESK_BARS && (process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  process.exit(r.status ?? 1);
}
mkdirSync(HOME, { recursive: true });
await cmd(args);
