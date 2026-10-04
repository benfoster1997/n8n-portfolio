#!/usr/bin/env node
/**
 * desk.mjs — the scalp desk's commands, run by the Claude session the user is
 * chatting with. The user never types these; they send a screenshot and a
 * price, and the session follows .claude/skills/scalp-desk/SKILL.md.
 *
 *   now                                   both instruments: open, closed, warnings; next news; plan
 *   brief [--pair P] [--high H --low L --now N]
 *   news  [--pair P] [--days 7]
 *   gate  --pair P --price N [--spread S] [--mode thorough|fast]
 *                                         may a screenshot be read now? writes the reader prompts
 *   head  --run ID                        after the three readings: the head trader's prompt
 *   check --run ID                        the checks, the lot size and the reply text
 *   size  --stop D [--pair P] [--price N] lots for a stop the user typed
 *   plan  set --setups "a, b" --max N [--other "..."] | took | undo | show | clear
 *   config [key=value ...]                show or change the account settings
 *   edge  [--trades N --wins W --rr R --planned P --perday D --stop S]
 *
 * Output: a STATUS line for the session, then the text to send the user
 * between "--- reply ---" and "--- end ---". The session sends that text as
 * it is; it does not add a direction, a level or a time to the close.
 *
 * State lives in $SCALP_DESK_HOME (default ~/.scalp-desk): runs, today's plan,
 * the last spread typed. The account settings live in desk/config.json, which
 * is committed so they survive the container being reclaimed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  withDefaults, pairOf, label, digitsOf, gateFor, contextFor, formatBlocked, formatIdea,
  formatNow, formatBrief, formatNews, formatEdge, sizeFor, lotsOnlyLines, ticketLines,
  planLine, nextNewsLine, latestUpload, forChat, fmt, costFor,
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

/* ---------------------------------------------------------------- plumbing */

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const cfg = withDefaults(readJson(CONFIG, {}));
const planPath = join(HOME, 'plan.json');
const loadPlan = () => readJson(planPath, null);

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

/** The spread for this screenshot: typed now, typed within the hour, or the confirmed usual one. */
function spreadFor(pair, typed) {
  const store = readJson(join(HOME, 'spread.json'), {});
  if (typed > 0) {
    store[pair] = { value: typed, atMs: NOW };
    writeJson(join(HOME, 'spread.json'), store);
    return { spreadNum: typed, spreadTyped: true, note: null };
  }
  const s = store[pair];
  if (s && s.value > 0 && NOW - s.atMs <= SPREAD_REUSE_MS) {
    return { spreadNum: s.value, spreadTyped: true, note: `Using the spread you sent at ${formatHM(s.atMs, cfg.window.tz)}: ${fmt(s.value, digitsOf(pair))}.` };
  }
  return { spreadNum: INSTRUMENTS[pair].typicalSpread.observed, spreadTyped: false, note: null };
}

const runDir = (id) => join(HOME, 'runs', id);

function loadRun(id) {
  const rid = id && id !== true ? id : readText(join(HOME, 'last-run.txt'))?.trim();
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

/* ---------------------------------------------------------------- commands */

const cmds = {
  now() {
    say('info', formatNow(NOW, cfg, loadPlan()));
  },

  brief(a) {
    const pair = a.pair ? pairOf(a.pair) : null;
    const range = pair && num(a.high) && num(a.low) && num(a.now)
      ? { pair, high: num(a.high), low: num(a.low), now: num(a.now) } : null;
    say('info', formatBrief(NOW, cfg, loadPlan(), pair ? [pair] : ['XAUUSD', 'BTCUSD'], range));
  },

  news(a) {
    say('info', formatNews(NOW, cfg, a.pair ? pairOf(a.pair) : null, num(a.days) || 7));
  },

  gate(a) {
    const pair = pairOf(a.pair);
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin');
    const priceNow = num(a.price);
    const nm = label(pair).toLowerCase();
    if (!(priceNow > 0)) {
      return say('need-price', `What is the ${nm} price now in MT5? (The Quotes tab — the lower of the two prices.) I need it before I read the chart: it is the one check that does not depend on reading the picture.`);
    }
    const g = gateFor(pair, NOW, cfg);
    if (!g.allowed) return say('blocked', formatBlocked(pair, g));
    const sp = spreadFor(pair, num(a.spread));
    if (g.needsSpread && !sp.spreadTyped) {
      return say('need-spread', `${forChat(g.message)}\n\nWhat is the ${nm} spread in MT5 right now? It is the gap between the two prices on the Quotes tab (84,400.00 and 84,406.00 is 6.00), not the "points" figure MT5 can show.`);
    }
    let mode = a.mode === 'fast' || a.mode === 'thorough' ? a.mode : cfg.mode;
    const image = latestUpload(UPLOADS, NOW);
    const notes = [];
    if (mode === 'thorough' && !image) {
      mode = 'fast';
      notes.push('NOTE: no uploaded picture found on disk in the last 15 minutes, so the three readers cannot open it. Fast mode: read it yourself. Tell the user it was a Fast read and why.');
    }
    const c = contextFor({ nowMs: NOW, pair, gate: g, priceNow, spreadNum: sp.spreadNum, spreadTyped: sp.spreadTyped, cfg, plan: loadPlan() });
    const id = `${new Date(NOW).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${pair}-${String(NOW % 100000).padStart(5, '0')}`;
    const dir = runDir(id);
    writeJson(join(dir, 'ctx.json'), { c, pair, mode, atMs: NOW, spreadNum: sp.spreadNum, image: image ? image.path : null, minStopPct: INSTRUMENTS[pair].minStopPct });
    writeFileSync(join(HOME, 'last-run.txt'), id + '\n');
    if (sp.note) notes.push(`TELL THE USER: ${sp.note}`);
    if (g.state === 'caution') notes.push(`CAUTION (it is repeated in the final reply): ${forChat(g.message)}`);
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
      return say('unreadable', `**■ No trade · ${label(ctx.pair)}**\n\nFewer than two of the three readers could read the chart. Send a new screenshot with the price scale on the right showing, on the M5 chart.`);
    }
    writeFileSync(join(dir, 'head.txt'), headPrompt(readings, ctx.c));
    console.log(`STATUS: go · head · run ${id}`);
    console.log(`NEXT: start ONE head-trader agent with exactly this task: Use the Read tool to open the image ${ctx.image}, then read ${join(dir, 'head.txt')} and do exactly what it says. Read no other file. Write only the JSON object it asks for to ${join(dir, 'plan.json')} with the Write tool, then reply with that JSON.`);
    console.log(`THEN: node ${join(here, 'desk.mjs')} check --run ${id}`);
  },

  check(a) {
    const { id, dir, ctx } = loadRun(a.run);
    const { pair, c } = ctx;
    const plan = parseReply(readText(join(dir, 'plan.json')) || '');
    if (!plan) return say('error', `The analysis came back in the wrong shape (no plan in ${join(dir, 'plan.json')}). Write the JSON there and run check again.`);
    const thorough = ctx.mode === 'thorough';
    const readings = thorough ? readingsOf(dir) : [];
    const result = checkPlan(plan, readings, {
      priceNow: c.priceNow, cost: c.costNum, digits: c.digits, pair, minStopPct: ctx.minStopPct,
      asked: thorough ? LENSES.length : 0, lastStretch: c.lastStretch,
    });
    // The gate again, at the end: a release or the quiet hours may have begun meanwhile.
    const after = gateFor(pair, NOW, cfg);
    if (!after.allowed) {
      writeJson(join(dir, 'result.json'), { discarded: true, result });
      return say('discarded', `**■ ${after.state === 'stand-aside' ? 'Stand aside' : after.state === 'closed' ? 'Closed' : 'Stand down'} · ${label(pair)}**\n\n${forChat(after.message)} The analysis was discarded.`);
    }
    const trade = result.decision === 'buy' || result.decision === 'sell';
    const sized = trade ? sizeFor({
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
    const lastId = readText(join(HOME, 'last-run.txt'))?.trim();
    const last = lastId ? readJson(join(runDir(lastId), 'ctx.json')) : null;
    const lastRes = lastId ? readJson(join(runDir(lastId), 'result.json')) : null;
    const pair = a.pair ? pairOf(a.pair) : last ? last.pair : null;
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin');
    const fresh = last && lastRes && !lastRes.discarded && last.pair === pair && NOW - last.atMs <= SHOT_MAX_AGE_MS
      && ['buy', 'sell'].includes(lastRes.result.decision) && gateFor(pair, NOW, cfg).allowed;
    if (fresh) {
      const r = lastRes.result;
      const s = sizeFor({ pair, cfg, stop, entry: r.entry, spreadNum: last.spreadNum, side: r.decision, stopLoss: r.stopLoss, target: r.takeProfit1 });
      const d = digitsOf(pair);
      return say('info', [...ticketLines(s, pair, cfg), `Stop loss set at your ${fmt(stop, d)} stop distance, not the analysis's ${fmt(r.stopDistance, d)}.`].join('\n'));
    }
    const price = num(a.price) || (pair === 'XAUUSD' ? 4390 : 84400);   // lots do not depend on price; only margin does
    const s = sizeFor({ pair, cfg, stop, entry: price, spreadNum: INSTRUMENTS[pair].typicalSpread.observed });
    say('info', lotsOnlyLines(s, stop, cfg).join('\n'));
  },

  plan(a) {
    const sub = a._[1] || 'show';
    const today = dayKey(NOW, cfg.window);
    const cur = loadPlan();
    if (sub === 'set') {
      const named = String(a.setups || '').split(',').map((x) => x.trim()).filter(Boolean);
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
      const kept = planStatus(cur, today);
      writeJson(planPath, { date: today, ...draft, taken: kept ? kept.taken : 0 });
    } else if (sub === 'took' || sub === 'undo') {
      const ps = planStatus(cur, today);
      if (!ps) return say('need-input', 'No plan set for today, so there is nothing to count against. Tell me your setups and the most trades you will take.');
      writeJson(planPath, { ...cur, taken: Math.max(0, ps.taken + (sub === 'took' ? 1 : -1)) });
    } else if (sub === 'clear') {
      writeJson(planPath, null);
      return say('info', 'Plan cleared.');
    }
    const ps = planStatus(loadPlan(), today);
    say('info', ps ? `Today's plan: ${ps.setups.join(' · ')}, up to ${ps.max} trades.\n${planLine(loadPlan(), NOW, cfg.window)}` : 'No plan set for today.');
  },

  config(a) {
    const file = readJson(CONFIG, {});
    const sets = a._.slice(1);
    const KEYS = {
      balance: ['account', 'balance', Number], currency: ['account', 'currency', (v) => v.toUpperCase()],
      risk: ['account', 'riskPct', Number], gbpusd: ['account', 'gbpusd', Number], leverage: ['account', 'leverage', Number],
      shadow: ['account', 'shadowBalance', (v) => (v === 'none' ? null : Number(v))],
      sizefrom: ['account', 'sizeFrom', (v) => (v === 'shadow' ? 'shadow' : 'account')],
      commission: ['account', 'commissionPerSideGBP', (v) => (v === 'spec' ? null : Number(v))],
      serveroffset: ['broker', 'serverOffset', Number], mode: [null, 'mode', (v) => (v === 'fast' ? 'fast' : 'thorough')],
    };
    for (const kv of sets) {
      const [k, ...rest] = kv.split('=');
      const v = rest.join('=');
      const spec = KEYS[k.toLowerCase()];
      if (!spec) usage(`Unknown setting ${k}. Known: ${Object.keys(KEYS).join(', ')}`);
      const [section, key, conv] = spec;
      const val = conv(v);
      if (typeof val === 'number' && !Number.isFinite(val)) usage(`${k} needs a number.`);
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
      `- MT5 server clock UTC+${c.broker.serverOffset} · screenshots read **${c.mode === 'fast' ? 'Fast (one reader)' : 'Thorough (three readers and a head trader)'}** unless you say otherwise`,
    ].join('\n'));
  },

  edge(a) {
    const file = readJson(CONFIG, {});
    const rec = { ...withDefaults(file).record };
    const map = { trades: 'trades', wins: 'wins', rr: 'rewardRisk', planned: 'plannedSample', perday: 'perDay', stop: 'typicalStop' };
    let changed = false;
    for (const [k, key] of Object.entries(map)) if (num(a[k]) !== null) { rec[key] = num(a[k]); changed = true; }
    if (changed) { file.record = rec; writeJson(CONFIG, file); }
    // Cost in R, from gold's usual cost unless told otherwise: the larger share of trades is gold.
    const pair = a.pair ? pairOf(a.pair) : 'XAUUSD';
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
