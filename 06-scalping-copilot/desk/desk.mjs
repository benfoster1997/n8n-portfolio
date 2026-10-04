#!/usr/bin/env node
/**
 * desk.mjs — the scalp desk's commands, run by the Claude session the user is
 * chatting with. The user never types these; they send a screenshot and a
 * price, and the session follows .claude/skills/scalp-desk/SKILL.md.
 *
 *   now                                   both instruments: open, closed, warnings; next news; plan
 *   brief [--only P] [--high H --low L --now N [--pair P]]
 *   news  [--pair P] [--days 7]
 *   gate  --pair P [--price N] [--spread S] [--mode thorough|fast] [--image PATH]
 *                                         may a screenshot be read now? writes the reader prompts
 *   head  --run ID                        after the three readings: the head trader's prompt
 *   check --run ID                        the checks, the lot size and the reply text
 *   size  --stop D [--pair P] [--spread S] [--price N]
 *                                         lots for a stop the user typed
 *   plan  set --setups "a, b" --max N [--other "..."] [--taken N] | took | undo | show | clear
 *   config [key=value ...]                show or change the account settings
 *   edge  [--trades N --wins W --rr R --planned P --perday D --stop S]   totals, not increments
 *
 * Output: a STATUS line for the session, maybe NOTE lines for the session
 * only, then the text to send the user between "--- reply ---" and
 * "--- end ---". The session sends that text as it is; it does not add a
 * direction, a level or a time to the close.
 *
 * State lives in $SCALP_DESK_HOME (default ~/.scalp-desk): runs, today's plan,
 * the last spread typed. The account settings live in desk/config.json, which
 * is committed so they survive the container being reclaimed.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  withDefaults, pairOf, label, digitsOf, gateFor, gateWord, contextFor, formatBlocked, formatIdea,
  formatNow, formatBrief, formatNews, formatEdge, sizeFor, lotsOnlyLines, ticketLines,
  planLine, nextNewsLine, recentUploads, forChat, fmt, costFor,
} from './lib.mjs';
import { INSTRUMENTS } from '../src/instruments.js';
import { LENSES, analystPrompt, headPrompt, fastPrompt, checkPlan, parseReply, SHOT_MAX_AGE_MS } from '../src/shot.js';
import { SETUPS, planProblem, planStatus, dayKey } from '../src/brief.js';
import { formatHM } from '../src/timezone.js';

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
    const nm = label(pair).toLowerCase();
    // The gate first: a shut market or a stand-down needs no price.
    const g = gateFor(pair, NOW, cfg);
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
      const recent = recentUploads(UPLOADS, NOW);
      const batch = recent.filter((x) => recent[0].mtimeMs - x.mtimeMs <= BURST_MS);
      if (batch.length > 1) {
        // Two or more pictures sent together: the session must say which is this instrument's chart.
        return say('need-image', null, [
          `NOTE: ${batch.length} pictures arrived together. Open each with the Read tool, find the ${pair} M5 chart, and run gate again with --image <its path>:`,
          ...batch.map((x) => `  ${x.path} (${Math.round(x.ageMs / 1000)} s ago)`),
        ]);
      }
      image = recent[0] || null;
      if (image && imagesAlreadyRead().includes(image.path)) {
        notes.push(`NOTE: this picture was already read in the last run. If the user has just sent a new screenshot, it is not on disk yet — open the newest upload or use --mode fast.`);
      }
      if (!image) {
        mode = 'fast';
        notes.push('NOTE: no uploaded picture found on disk in the last 15 minutes, so the three readers cannot open it. Fast mode: read it yourself. Tell the user it was a Fast read and why.');
      }
    }

    const c = contextFor({ nowMs: NOW, pair, gate: g, priceNow, spreadNum: sp.spreadNum, spreadTyped: sp.spreadTyped, cfg, plan: loadPlan() });
    const id = newRunId(pair);
    const dir = runDir(id);
    writeJson(join(dir, 'ctx.json'), { c, pair, mode, atMs: NOW, spreadNum: sp.spreadNum, image: image ? image.path : null, minStopPct: INSTRUMENTS[pair].minStopPct });
    writeFileSync(join(HOME, 'last-run.txt'), id + '\n');
    if (sp.note) notes.push(`TELL THE USER: ${sp.note}`);
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
      return say('unreadable', `**■ No trade · ${label(ctx.pair)}**\n\nFewer than two of the three readers could read the chart. Send a new screenshot of the M5 chart with the price scale on the right showing, and the price.`);
    }
    writeFileSync(join(dir, 'head.txt'), headPrompt(readings, ctx.c));
    console.log(`STATUS: go · head · run ${id}`);
    console.log(`NEXT: start ONE head-trader agent with exactly this task: Use the Read tool to open the image ${ctx.image}, then read ${join(dir, 'head.txt')} and do exactly what it says. Read no other file. Write only the JSON object it asks for to ${join(dir, 'plan.json')} with the Write tool, then reply with that JSON.`);
    console.log(`THEN: node ${join(here, 'desk.mjs')} check --run ${id}`);
  },

  check(a) {
    const { id, dir, ctx } = loadRun(a.run);
    const { pair, c } = ctx;
    const discard = (g) => say('discarded', `**■ ${gateWord(g)} · ${label(pair)}**\n\n${forChat(g.message)} The analysis was discarded.`);
    const prior = readJson(join(dir, 'result.json'));
    if (prior && prior.discarded) return discard(prior.gate || gateFor(pair, NOW, cfg));
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
      asked: thorough ? LENSES.length : 0, lastStretch: c.lastStretch,
    });
    // The gate again, at the end: a release or the quiet hours may have begun meanwhile.
    const after = gateFor(pair, NOW, cfg);
    if (!after.allowed) {
      writeJson(join(dir, 'result.json'), { discarded: true, gate: after, result });
      return discard(after);
    }
    const trade = result.decision === 'buy' || result.decision === 'sell';
    // Over 15 minutes old: the levels and the warning, but no ticket (the page hides it too).
    const fresh = NOW - ctx.atMs <= SHOT_MAX_AGE_MS;
    const sized = trade && fresh ? sizeFor({
      pair, cfg, stop: result.stopDistance, entry: result.entry, spreadNum: ctx.spreadNum,
      side: result.decision, stopLoss: result.stopLoss, target: result.takeProfit1,
    }) : null;
    writeJson(join(dir, 'result.json'), { result, checkedAtMs: NOW });
    const tail = [nextNewsLine(NOW, pair, cfg.window), planLine(loadPlan(), NOW, cfg.window)].filter(Boolean).join('\n');
    const reply = formatIdea({ result, pair, ctx: c, cfg, mode: ctx.mode, atMs: ctx.atMs, nowMs: NOW, sized, readings }) + (tail ? `\n\n${tail}` : '');
    say(`done · ${result.decision}${result.rejected ? ' (rejected)' : ''}`, reply,
      result.rejected ? ['RULE: a rejected idea\'s direction and levels are never passed on — not in your own words either.'] : []);
  },

  size(a) {
    const stop = num(a.stop);
    if (!(stop > 0)) usage('size --stop D, where D is the stop distance in dollars (8 means $8 on gold).');
    const lastId = lastRunId();
    const last = lastId ? readJson(join(runDir(lastId), 'ctx.json')) : null;
    const lastRes = lastId ? readJson(join(runDir(lastId), 'result.json')) : null;
    const lastFresh = last && NOW - last.atMs <= SHOT_MAX_AGE_MS;
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
      : isIdea ? [`Your last ${label(pair).toLowerCase()} idea is over 15 minutes old — send a new screenshot and the price for levels.`]
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
    if (sets.length) writeJson(CONFIG, file);
    const c = withDefaults(file);
    const ac = c.account;
    say(sets.length ? 'changed · commit desk/config.json' : 'info', [
      '**Desk settings**',
      `- Balance ${ac.currency} ${fmt(ac.balance, 2)} · risk ${ac.riskPct}% a trade`,
      `- Shadow balance ${ac.shadowBalance ? `${ac.currency} ${fmt(ac.shadowBalance, 2)}` : 'not set'} · sizing from **${ac.sizeFrom === 'shadow' && ac.shadowBalance ? 'the shadow balance' : 'the account balance'}**`,
      `- GBP/USD ${ac.gbpusd} · leverage 1:${ac.leverage}`,
      `- Commission ${ac.commissionPerSideGBP === null ? 'from the spec (gold £2.75 a lot each side, bitcoin none)' : `£${ac.commissionPerSideGBP} a lot each side`}`,
      `- MT5 server clock ${c.broker.serverOffset === 'auto' ? 'follows New York + 7 (UTC+3 now, UTC+2 from 1 November)' : `UTC${c.broker.serverOffset >= 0 ? '+' : ''}${c.broker.serverOffset}`} · screenshots read **${c.mode === 'fast' ? 'Fast (one reader)' : 'Thorough (three readers and a head trader)'}** unless you say otherwise`,
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
};

const args = parseArgs(process.argv.slice(2));
const cmd = cmds[args._[0]];
if (!cmd) usage(`Commands: ${Object.keys(cmds).join(', ')}`);
mkdirSync(HOME, { recursive: true });
cmd(args);
