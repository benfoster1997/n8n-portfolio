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
 *   config [key=value ...] [--end-sample] show or change the account settings; a change that
 *                                         would end the alert sample in progress asks first
 *                                         (--end-sample: the user agreed); --end-sample alone
 *                                         ends a paused sample (settings changed outside config)
 *   edge  [--trades N --wins W --rr R --planned P --perday D --stop S]   totals, not increments
 *   scan  [--pair P]                      one read of the live chart now (desk/live.mjs)
 *   watch [--pair P] [--hours H] [--anytime] [--once] | --stop
 *                                         read the live chart at every bar close; exits with
 *                                         STATUS: alert (and the reply) when an idea passes
 *   take  --price N [--pair P] [--spread S] [--account demo|live]
 *                                         the last alert, as a ticket from the user's MT5 price
 *   journal [summary] | update | result --alert A (--r R | --how H | --pounds P --risk X) [--account M] [--replace]
 *         | sample [--alerts N] | took --alert A [--account M] | alert --alert A | account demo|live
 *                                         the automatic record of alerts (desk/journal.mjs);
 *                                         A is an alert id, "last" or its London time (HH:MM);
 *                                         for a trade, "last" is the alert they acted on, and
 *                                         "last" or a time reaches back only 24 hours; a result
 *                                         by "last" or a time on an alert that has one asks
 *                                         first (the full id or --replace replaces it)
 *   learn status | report | similar --at <UTC bar close> [--side buy|sell]
 *                                         the learning layer's words for the user (desk/learn.mjs);
 *                                         similar describes one standard trade: without --side it
 *                                         asks which side, never shows both, never the engine's lean
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
 * otherwise, and every request fails with ENOTFOUND (desk/net.mjs). $SCALP_DESK_BARS (a JSON
 * file of bars per instrument) stands in for the feeds under test — the live
 * feeds and the reference feed's history alike; an optional "sources" entry
 * ({ "BTCUSD": "binance-vision" }) names the live feed the bars stand for —
 * and $SCALP_DESK_NOW sets the clock; under it the watcher's waits move the
 * clock on instead of sleeping.
 *
 * The journal (desk/journal.mjs) lives beside the config (journal.jsonl), or
 * at $SCALP_DESK_JOURNAL, so a test's config in a temporary folder gets a
 * temporary journal. watch and scan record every idea they send; take, plan
 * took and journal result record what the user did; `journal update` records
 * the method's own alerts on the reference feed. watch, scan, now, brief and
 * journal also run that update silently first, inside about five seconds:
 * it never adds a line, and nothing it does can fail the command.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureProxy } from './net.mjs';
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
import { loadBars, closedBars, BTC_SOURCES, XAU_SOURCES } from '../src/data-feeds.js';
import { windowState, localDate } from '../src/sessions.js';
import { zonedTimeToUtc } from '../src/timezone.js';
import {
  FETCH_BARS, CLOSED_BARS, METHOD_VERSION, TARGET_RULE, liveRead, shouldAlert, ideaRecord, formatLiveIdea, formatLiveNone, takeIdea,
  nextPollMs, inWatchHours, minHistory, alertState,
} from './live.mjs';
import {
  journalPath, readEvents, appendEvents, setFeatureNames, methodOf, keyFor, fold, foldDays, foldSample, foldConsent, sampleStatus,
  canonicalAlerts, shownEvent, resolveOpen, markTicketed, markTaken, markActual, accountMismatch, needsLiveConsent, consentEvent,
  setSample, sampleEndEvent, summary, outcomeSentence, sampleQuestion, fmtR, idOf, KNOWN_FEEDS, REFERENCE_FEEDS, ACCOUNT_MODES, PAIRS as JOURNAL_PAIRS,
  DEFAULT_PLANNED_ALERTS, HOLDOUT as JOURNAL_HOLDOUT, forPair, dayLabel, takenWithinMs, samplePause, pauseReason, METHOD_PART_WORDS,
} from './journal.mjs';
import { FEATURE_NAMES, featuresFromBars } from './features.mjs';
import { loadHistory, HISTORY_FEEDS, fromForBars } from './history.mjs';

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
  // The journal's notes (journalNotes, below) ride with whatever the command says.
  for (const n of [...notes, ...journalNotes.splice(0)]) console.log(n);
  if (reply) console.log(`--- reply ---\n${reply}\n--- end ---`);
}

/** NOTE lines from the journal for the session, printed with the command's STATUS; never part of the reply. */
const journalNotes = [];

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

// now, brief and journal reach the network too: the journal's silent update
// reads the reference feed's history (desk/history.mjs); learn similar may.
const NET_CMDS = ['scan', 'watch', 'take', 'now', 'brief', 'journal', 'learn'];
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
    const file = readJson(fixture, {});
    const bars = file[pair] || [];
    // The stand-in may say which live feed its bars stand for; otherwise it is
    // no feed the journal can name, and nothing read from it is recorded.
    const named = file.sources && [...BTC_SOURCES, ...XAU_SOURCES].find((x) => x.id === file.sources[pair]);
    if (bars.length) return { ok: true, bars, source: named ? { id: named.id, label: named.label } : { id: 'test', label: 'test bars' } };
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

/**
 * The watcher's memory of its last alert per instrument (watch/state.json,
 * which shouldAlert reads: no repeat bar, the cooldown, nothing while the
 * last alert is still running) lives in $SCALP_DESK_HOME and is lost when the
 * container is reclaimed; the journal, committed, still holds every alert
 * sent. So before watching, the newest alert the journal holds for each
 * instrument (on this timeframe) is put back wherever the state has none as
 * recent. Never throws.
 */
function seedAlertState(pairs, tf) {
  try {
    const state = readJson(watchPath('state.json'), { lastAlert: {} }) || { lastAlert: {} };
    state.lastAlert = state.lastAlert || {};
    const shown = [...fold(journalEvents()).values()].filter((e) => e.shown && e.tf === tf && pairs.includes(e.pair));
    let changed = false;
    for (const pair of pairs) {
      const e = shown.filter((x) => x.pair === pair).sort((x, y) => y.barCloseMs - x.barCloseMs)[0];
      const prev = state.lastAlert[pair];
      if (!e || (prev && prev.barCloseMs >= e.barCloseMs)) continue;
      state.lastAlert[pair] = alertState({ ...e.shown, side: e.side, barCloseMs: e.barCloseMs });
      changed = true;
    }
    if (changed) writeJson(watchPath('state.json'), state);
  } catch { /* the watch runs without it, as before */ }
}

const KEY_HOW = 'Gold needs a free key from twelvedata.com (sign up, then API Keys). Add it in this session\'s cloud environment settings (title bar → environment → Edit) as an environment variable named TWELVEDATA_API_KEY — not in this chat — then start a new session. Bitcoin needs nothing.';

/* ---------------------------------------------------------------- the journal */

// Beside the config (or $SCALP_DESK_JOURNAL): a test's temporary config gets a
// temporary journal, never desk/journal.jsonl.
const JOURNAL = journalPath({ env: process.env, configPath: CONFIG });
// The feature names an alert may carry are features.mjs's own (journal.mjs
// refuses features under any other name).
setFeatureNames(FEATURE_NAMES);
/** How long the silent update may take before the command goes on without it. */
const SILENT_MS = 5000;
/** How long a mark waiting for "which account was it on?" stays answerable. */
const PENDING_MS = 2 * 3600e3;
const pendingPath = join(HOME, 'journal-pending.json');
// Commit first: git refuses a pull with rebase while the journal has changes
// not committed (and the NOTE comes only when it has just changed).
const COMMIT_JOURNAL = `NOTE: the journal changed — commit ${JOURNAL}, then git pull --rebase, then push.`;
const DAY_MS = 86400e3;
const LONDON = 'Europe/London';
const nameOf = (pair) => label(pair).toLowerCase();

/** The method the desk runs now: live.mjs METHOD_VERSION and target rule, the settings' timeframe, window and costs. */
const methodNow = (c = cfg) => methodOf({ version: METHOD_VERSION, targetRule: TARGET_RULE, tf: timeframeFor(c), cfg: c });
const knownFeed = (id) => KNOWN_FEEDS.some((f) => f.id === id);
const journalEvents = () => { try { return readEvents(JOURNAL); } catch { return []; } };

/** Rule 6's question, in plain words, with the point about config.json's balance. */
const LIVE_QUESTION = 'One question before anything from your live account goes in your record: the record of alerts and of your trades is kept in a public repository on GitHub, where anyone can read it. It never holds money amounts, lot sizes or account details — only the alerts, the MT5 prices of a ticket and your results as multiples of the risk. May a record of your live-account alerts and trades sit there? Your desk settings are public there too, the account balance among them: rather than typing in your live balance, you can set a shadow balance to size from, and the real figure never goes in.';
const LIVE_NOTE = 'NOTE: when they answer, run: config livejournal=yes (or no), then commit the journal, git pull --rebase, and push. Until then nothing from the live account is written.';

/**
 * Writes events through journal.mjs (which sanitises every one). A live-account
 * event before the user has answered rule 6's question is held, not written,
 * and the session is told why. Never throws: a journal problem is a NOTE for
 * the session, and the command's reply goes out regardless.
 */
function writeJournal(events, { note = true, quiet = false } = {}) {
  if (!events.length) return { added: [], held: [] };
  try {
    const res = appendEvents(JOURNAL, events, { liveWithoutConsent: 'hold' });
    if (res.held.length && !quiet) {
      const answer = foldConsent(journalEvents());
      journalNotes.push(answer === 'no'
        ? 'NOTE: journal — the user said no to a live-account record in the public repository, so that live entry was not written. Nothing to do.'
        : `NOTE: journal — ${res.held.length === 1 ? 'a live-account entry was' : `${res.held.length} live-account entries were`} not written: the user has not said whether a live record may sit in the public repository. Ask them, in the words "config account=live" prints, then run config livejournal=yes (or no).`);
    }
    if (note && res.added.length) journalNotes.push(COMMIT_JOURNAL);
    return res;
  } catch (e) {
    if (!quiet) journalNotes.push(`NOTE: journal — not written: ${e.message}`);
    return { added: [], held: [], error: e };
  }
}

/** features.mjs featuresAt for a live read, from exactly the closed bars it read (null, with a NOTE, if they cannot be had). */
function liveFeatures(r, bars) {
  try {
    const closed = closedBars(bars || [], tfInfo(r.tf).minutes, r.nowMs).slice(-CLOSED_BARS);
    return featuresFromBars({ bars: closed, nowMs: r.nowMs, cfg, pair: r.pair, tf: r.tf, analysis: r.analysis ?? null });
  } catch (e) {
    journalNotes.push(`NOTE: journal — the ${r.pair} read's features could not be described (${e.message}); it is recorded without them.`);
    return null;
  }
}

/**
 * Records the ideas the user was sent: `watch` (each alert, as sent) or `scan`
 * (each idea a one-off scan reported, which skips shouldAlert: journal.mjs
 * keeps it as source 'scan', never part of the sample). Each carries the
 * method and the features of its own read, nothing else beyond journal.mjs's
 * allowlist. A read from a stand-in feed (tests) names no price feed and is
 * not recorded.
 */
function recordShown(items, source) {
  const events = [];
  for (const { r, bars } of items) {
    const rec = ideaRecord(r);
    if (!knownFeed(rec.sourceId)) continue;
    try {
      events.push(shownEvent(rec, { source, method: methodNow(), cfg, at: clock(), features: liveFeatures(r, bars) }));
    } catch (e) {
      journalNotes.push(`NOTE: journal — the ${rec.pair} idea was not recorded: ${e.message}`);
    }
  }
  return writeJournal(events);
}

/** A London calendar date (YYYY-MM-DD) and its midnight. */
const dayOf = (ms) => { const { y, m, d } = localDate(ms, LONDON); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const midnightOf = (day) => { const [y, m, d] = day.split('-').map(Number); return zonedTimeToUtc(y, m, d, 0, 0, LONDON); };
const nextDay = (day) => dayOf(midnightOf(day) + 36 * 3600e3);

/**
 * The reference feed's closed bars for the method's record and for scoring
 * what the user was shown: bitcoin from Binance, gold from Twelve Data
 * (desk/history.mjs, cached and extended), or the test file's bars under
 * $SCALP_DESK_BARS (standing in for that history). { ok, bars, feedId } or
 * { ok: false, needKey?, reason }.
 */
async function referenceBars(pair, tf, fromMs, { signal = null, deadlineMs = null } = {}) {
  const fixture = process.env.SCALP_DESK_BARS;
  if (fixture) {
    // From fromMs on, as loadHistory serves them, so a test sees the window the desk asked for;
    // "BTCUSD-M5" in the file stands for that timeframe's history, else the pair's bars serve any.
    const file = readJson(fixture, {});
    const bars = (file[`${pair}-${tf}`] || file[pair] || []).filter((b) => !(fromMs > b.t));
    if (bars.length) return { ok: true, bars, feedId: HISTORY_FEEDS[pair] };
    return pair === 'XAUUSD' ? { ok: false, needKey: true, reason: 'no Twelve Data key' } : { ok: false, reason: 'no test bars' };
  }
  if (pair === 'XAUUSD' && !goldKey()) return { ok: false, needKey: true, reason: 'no Twelve Data key ($TWELVEDATA_API_KEY)' };
  const h = await loadHistory(pair, tf, {
    fromMs, home: HOME, keys: { twelvedata: goldKey() },
    ...(signal ? { signal } : {}), ...(deadlineMs ? { deadlineMs: Math.max(1, Math.round(deadlineMs)) } : {}),
  });
  return h.ok ? { ok: true, bars: h.bars, feedId: h.source } : { ok: false, needKey: !!h.needKey, reason: h.reason };
}

/**
 * `journal update`: the method's own alerts on the reference feed for each
 * instrument of a committed sample — every weekday from the first one not yet
 * recorded, one day at a time (journal.mjs canonicalAlerts: whole days, a day
 * once recorded frozen) — then the silent resolution of what the user was
 * shown (resolveOpen), scored on the same feed. With `deadlineMs` (the silent
 * run at the start of watch, scan, now, brief and journal) it stops between
 * days when the time is up and passes the time left to history.mjs, so it
 * never holds a command up for long; nothing it meets is thrown.
 * `quiet` (the silent run) leaves no NOTE behind either. While the sample is
 * paused (journal.mjs samplePause: the settings or the desk's rules no longer
 * match its method), neither run records a day: nothing is counted while
 * they differ, and once they match again the days in between are recorded
 * like any other.
 * Returns { recorded: {pair: days}, alerts: {pair: n}, resolved, needKey: [pairs], pending, problems, paused }.
 */
async function journalUpdate({ deadlineMs = null, quiet = false } = {}) {
  const out = { recorded: {}, alerts: {}, resolved: 0, needKey: [], pending: [], problems: [], wrote: false, paused: null };
  if (!existsSync(JOURNAL)) return out;
  let events = journalEvents();
  if (!events.length) return out;
  const until = deadlineMs ? Date.now() + deadlineMs : Infinity;
  const left = () => until - Date.now();
  const signal = deadlineMs ? AbortSignal.timeout(deadlineMs) : null;
  const nowMs = clock();
  const m = methodNow();
  const tf = m.tf;
  const cfgM = { ...cfg, timeframe: tf };
  const sample = foldSample(events);
  // A paused sample (its method is not the one the desk runs now, for one of
  // its instruments: a setting changed outside `config`, or a new version of
  // the rules) gets no day recorded, by this run or the full one, for any of
  // its instruments: nothing is counted while they differ. Paused is not
  // ended — only the user's agreement ends a sample (config --end-sample) —
  // so once the method matches again the days in between are recorded then.
  out.paused = samplePause(events, { cfg, methodNow: m });
  const samplePairs = sample && !out.paused ? sample.pairs : [];

  // Days of the record still to compute, per instrument: weekdays from the
  // commitment (or the end of the held-back years) to today with no day record.
  const todo = {};
  for (const pair of samplePairs) {
    const recorded = foldDays(events, m);
    const days = [];
    for (let d = dayOf(Math.max(sample.committedAt, JOURNAL_HOLDOUT.toMs + 1)); d <= dayOf(nowMs); d = nextDay(d)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6 || recorded.has(`${pair}-${tf}-${d}`)) continue;
      days.push(d);
    }
    todo[pair] = days;
  }
  // What the user was shown and has not been scored, once its window has closed.
  const unscored = () => [...fold(events).values()].filter((e) => e.shown && !e.shownOutcome && nowMs >= windowState(e.barCloseMs, cfg.window).closesAtMs);
  const open = unscored();
  // Bars per instrument and timeframe: the setting's for the record; each
  // shown alert's own for scoring it (an M15 alert is never scored on M5 bars
  // because the setting changed since).
  const tfMsOf = (t) => tfInfo(t).minutes * 60000;
  const want = new Map();
  const need = (pair, t, fromMs) => { const k = `${pair}|${t}`; want.set(k, Math.min(want.get(k) ?? Infinity, fromMs)); };
  for (const pair of samplePairs) if (todo[pair].length) need(pair, tf, midnightOf(todo[pair][0]));
  for (const e of open) need(e.pair, e.tf, e.barCloseMs - tfMsOf(e.tf));

  const barsBy = {};
  for (const [k, needFrom] of want) {
    if (left() <= 0) break;
    const [pair, t] = k.split('|');
    // The watcher's 999 closed bars before the first check, a day more: counted in bars, not
    // calendar time, so gold's breaks and weekends do not leave a read short (fromForBars).
    const got = await referenceBars(pair, t, fromForBars(pair, t, needFrom, CLOSED_BARS + 96), { signal, deadlineMs: deadlineMs ? left() : null });
    if (!got.ok) {
      if (got.needKey) { if (!out.needKey.includes(pair)) out.needKey.push(pair); } else out.problems.push(`${pair} ${t}: ${got.reason}`);
      continue;
    }
    barsBy[k] = got;
  }
  const bars = Object.fromEntries(samplePairs.filter((p) => barsBy[`${p}|${tf}`]).map((p) => [p, barsBy[`${p}|${tf}`]]));

  // The method's record, a day at a time.
  for (const pair of samplePairs) {
    if (!bars[pair]) continue;
    const featuresFor = (r, seen) => { try { return featuresFromBars({ bars: seen, nowMs: r.nowMs, cfg: cfgM, pair, tf, analysis: r.analysis ?? null }); } catch { return null; } };
    for (const day of todo[pair]) {
      if (left() <= 0) break;
      let res;
      try {
        res = canonicalAlerts({ pair, bars: bars[pair].bars, feedId: bars[pair].feedId, cfg, fromMs: midnightOf(day), toMs: midnightOf(nextDay(day)), method: m, events, nowMs, featuresFor });
      } catch (e) { out.problems.push(`${pair} ${day}: ${e.message}`); break; }
      out.pending.push(...res.pending);
      if (!res.events.length) continue;
      const w = writeJournal(res.events, { note: false, quiet });
      if (w.error) break;
      if (w.added.length) out.wrote = true;
      events = journalEvents();
      out.recorded[pair] = (out.recorded[pair] || 0) + res.days.length;
      out.alerts[pair] = (out.alerts[pair] || 0) + res.alerts.length;
    }
  }

  // What the user was shown, scored on the same feed, each on its own timeframe's bars.
  const scorable = unscored().filter((e) => barsBy[`${e.pair}|${e.tf}`]);
  for (const t of [...new Set(scorable.map((e) => e.tf))]) {
    const group = scorable.filter((e) => e.tf === t);
    const got = Object.fromEntries([...new Set(group.map((e) => e.pair))].map((p) => [p, barsBy[`${p}|${t}`]]));
    try {
      const resolved = resolveOpen(new Map(group.map((e) => [e.id, e])), Object.fromEntries(Object.entries(got).map(([p, g]) => [p, g.bars])), cfg,
        { feed: Object.fromEntries(Object.keys(got).map((p) => [p, REFERENCE_FEEDS[p].label])), nowMs });
      const w = writeJournal(resolved, { note: false, quiet });
      if (w.added.length) out.wrote = true;
      out.resolved += w.added.length;
    } catch (e) { out.problems.push(`scoring what was shown: ${e.message}`); }
  }
  return out;
}

/** The silent update: bounded, wordless, and nothing it does can fail the command. */
async function resolveSilently() {
  try { await journalUpdate({ deadlineMs: SILENT_MS, quiet: true }); } catch { /* silent by design */ }
}

/**
 * The shown alert an argument names: an id (BTCUSD-M15-…), "last", or its
 * London bar-close time ("10:15"), the latest such, narrowed by `pair`.
 * { entry } or { error: why, in words for the session }.
 */
function shownAlert(ref, pair = null) {
  const all = [...fold(journalEvents()).values()].filter((e) => e.shown && (!pair || e.pair === pair)).sort((x, y) => y.barCloseMs - x.barCloseMs);
  if (!all.length) return { error: 'no alert sent to the user is in the journal' };
  if (ref === undefined || ref === true || ref === 'last') return { entry: all[0] };
  const hm = /^(\d{1,2}):(\d\d)$/.exec(String(ref));
  if (hm) {
    const want = `${hm[1].padStart(2, '0')}:${hm[2]}`;
    const at = all.filter((e) => formatHM(e.barCloseMs, cfg.window.tz) === want);
    if (!at.length) return { error: `no alert sent at ${want} London is in the journal` };
    const day = dayOf(at[0].barCloseMs);
    const same = at.filter((e) => dayOf(e.barCloseMs) === day);
    if (same.length > 1) return { error: `${same.length} alerts were sent at ${want} (${same.map((e) => e.pair).join(', ')}): add --pair` };
    return { entry: at[0] };
  }
  const e = all.find((x) => x.id === ref);
  return e ? { entry: e } : { error: `no alert ${ref} sent to the user is in the journal` };
}

/** How far back a short reference ("last", HH:MM) reaches: today's London day, or the last 24 hours. */
const RECENT_MS = 24 * 3600e3;
const ALERT_ID = /^(XAUUSD|BTCUSD)-[MH]\d{1,3}-\d{13}$/;
const recentAlert = (e) => dayOf(e.barCloseMs) === dayOf(clock()) || clock() - e.barCloseMs <= RECENT_MS;
const alertWords = (e, withDay = false) => `${formatHM(e.barCloseMs, cfg.window.tz)} ${nameOf(e.pair)} ${e.side} alert${withDay ? ` on ${dayLabel(e.barCloseMs, cfg.window.tz)}` : ''}`;

/**
 * The alert a trade of the user's is on (journal result, journal took, plan
 * took --alert). Never inferred from recency alone:
 *  - an id (BTCUSD-M15-…): that alert, at any age;
 *  - "last" (or none): the newest recent alert they asked a ticket for or said
 *    they took — never a scan idea or an alert they did nothing with — and
 *    of those, the one still `open` (no result yet for `result`, not marked
 *    taken for `took`); two open ones, and the desk asks which;
 *  - "HH:MM": the alert sent at that London time, recent only.
 * Recent is today's London day or the last 24 hours: an older alert is named
 * with its day and needs its id (a result on Wednesday for Monday's alert is
 * far more often a trade from a screenshot, which is not kept).
 * Returns { entry } or { error (for the session), older?, ask? (a question for
 * the user), retry? (what --alert takes once they say which) }.
 */
function tradeAlert(ref, pair, open) {
  const all = [...fold(journalEvents()).values()].filter((e) => e.shown && (!pair || e.pair === pair)).sort((x, y) => y.barCloseMs - x.barCloseMs);
  if (!all.length) return { error: 'no alert sent to the user is in the journal' };
  if (typeof ref === 'string' && ALERT_ID.test(ref)) {
    const e = all.find((x) => x.id === ref);
    return e ? { entry: e } : { error: `no alert ${ref} sent to the user is in the journal` };
  }
  if (ref === undefined || ref === true || ref === 'last') {
    const marked = all.filter((e) => e.ticketed || e.taken);
    const recent = marked.filter(recentAlert);
    if (!recent.length) {
      return marked.length ? { error: `the last alert they asked a ticket for or took is from an earlier day (${marked[0].id})`, older: marked[0] }
        : { error: 'no alert they asked a ticket for or said they took is in the journal ("last" never means a scan idea or an alert they did nothing with)' };
    }
    const waiting = recent.filter(open);
    if (waiting.length > 1) {
      return { error: `${waiting.length} recent alerts have a ticket or a "took it" (${waiting.map((e) => e.id).join(', ')})`, retry: '<its time or id>',
        ask: `Which alert was that — ${waiting.map((e) => `the ${alertWords(e)}`).join(' or ')}?` };
    }
    return { entry: waiting[0] || recent[0] };
  }
  const hm = /^(\d{1,2}):(\d\d)$/.exec(String(ref));
  if (!hm) return { error: `no alert ${ref} sent to the user is in the journal` };
  const want = `${hm[1].padStart(2, '0')}:${hm[2]}`;
  const at = all.filter((e) => formatHM(e.barCloseMs, cfg.window.tz) === want);
  if (!at.length) return { error: `no alert sent at ${want} London is in the journal` };
  const recent = at.filter(recentAlert);
  if (!recent.length) return { error: `the alert sent at ${want} London is from an earlier day (${at[0].id})`, older: at[0] };
  const day = dayOf(recent[0].barCloseMs);
  const same = recent.filter((e) => dayOf(e.barCloseMs) === day);
  if (same.length > 1) return { error: `${same.length} alerts were sent at ${want} (${same.map((e) => e.pair).join(', ')})`, retry: `${want} --pair <the instrument>` };
  return { entry: recent[0] };
}

/**
 * What to say when a trade's alert was not found (or is too old): on a live
 * account without a yes to the live record, that answer first — the alert
 * was never kept, so asking "which alert?" again would go round in circles;
 * an older alert, named with its day; else the question, with `fallback`.
 * `rerun(ref)` is what the session's NOTE tells it to run once the user says
 * which alert — by default the same command again; for `plan took` it is
 * `journal took`, since the plan's count is already done and running plan
 * took again would count the trade twice. `prefix` goes before the error.
 * Returns [reply, notes].
 */
function notFound(found, fallback, { rerun = (ref) => `run the same command again with --alert ${ref}`, prefix = '' } = {}) {
  const answer = foldConsent(journalEvents());
  if ((cfg.account.mode || 'demo') === 'live' && answer !== 'yes') {
    if (answer === 'no') return ['You asked for nothing from your live account to go in your record, so there is nothing to note.', [`NOTE: ${prefix}${found.error}; the settings say live and the user said no to a live record.`]];
    return [`${LIVE_QUESTION}\n\nAlerts sent before you answer are not kept, so a trade on one of them cannot be added to your record afterwards.`, [LIVE_NOTE, `NOTE: ${prefix}${found.error}.`]];
  }
  if (found.older) {
    return [`The ${alertWords(found.older, true)} is the one I have. Was your trade on that alert? (A trade on an idea from a screenshot is not kept in the record.)`,
      [`NOTE: ${prefix}${found.error}. Only if they say it was, ${rerun(found.older.id)}.`]];
  }
  return [found.ask || fallback, [`NOTE: ${prefix}${found.error}${found.retry ? `; ask which, then ${rerun(found.retry)}` : ''}.`]];
}

const readPending = () => (readJson(pendingPath, []) || []).filter((p) => p && clock() - p.atMs <= PENDING_MS);
const addPending = (item) => writeJson(pendingPath, [...readPending().filter((p) => !(p.kind === item.kind && p.id === item.id)), item]);
const dropPending = (kind, id) => { if (readPending().some((p) => p.kind === kind && p.id === id)) writeJson(pendingPath, readPending().filter((p) => !(p.kind === kind && p.id === id))); };

/**
 * Marks something the user did on an alert they were sent: 'ticketed' (take
 * returned a ticket), 'taken', or 'actual' (how their trade ended, in R). When the settings' account mode is not the
 * one the alert was shown under (journal.mjs accountMismatch), nothing is
 * marked: the mark waits (for `journal account demo|live`) and the reply asks
 * which account it was on. Returns a line to add to the reply, or null.
 */
function markUserEvent(kind, entry, payload, account = null) {
  try {
    const mismatch = accountMismatch(entry, cfg);
    if (mismatch && !account) {
      addPending({ kind, id: entry.id, payload, atMs: clock() });
      journalNotes.push('NOTE: when they say which account it was, run: journal account demo (or live).');
      return mismatch.question;
    }
    let ev;
    if (kind === 'ticketed') ev = markTicketed(entry, { ...payload, at: clock(), account });
    else if (kind === 'actual') ev = markActual(entry, { ...payload, at: clock(), account });
    else {
      const t = markTaken(fold(journalEvents()), { alertId: entry.id, nowMs: clock(), account });
      if (!t.ok) return null;
      ev = { ...t.event, how: payload.how || t.event.how };
    }
    const res = writeJournal([ev]);
    if (res.held.length && foldConsent(journalEvents()) === null) { journalNotes.push(LIVE_NOTE); return LIVE_QUESTION; }
  } catch (e) {
    journalNotes.push(`NOTE: journal — the ${kind} mark was not recorded: ${e.message}`);
  }
  return null;
}

/**
 * `plan took`: a trade the user took is linked to an alert only explicitly —
 * the alert named (--alert), or the one ticket built within the ticket's
 * freshness (journal.mjs markTaken) — never by recency alone. Otherwise only
 * the plan's count changes. Returns a line for the reply, or null.
 */
function journalTaken(a) {
  const events = journalEvents();
  if (!events.length) return null;
  const account = a.account && a.account !== true ? String(a.account).toLowerCase() : null;
  if (account && !ACCOUNT_MODES.includes(account)) usage('--account is demo or live.');
  let res;
  if (a.alert !== undefined) {
    const found = tradeAlert(a.alert, a.pair ? pairOf(a.pair) : null, (e) => !e.taken);
    if (found.error) {
      // The plan's count is done whatever happens here: the NOTE names
      // journal took, which links the trade without counting it again.
      const [ask, notes] = notFound(found, null, { rerun: (ref) => `run: journal took --alert ${ref} (the count is already done)`, prefix: 'journal — not linked to an alert: ' });
      journalNotes.push(...notes);
      return ask;
    }
    res = markTaken(fold(events), { alertId: found.entry.id, nowMs: clock() });
  } else {
    res = markTaken(fold(events), { tf: timeframeFor(cfg), nowMs: clock() });
  }
  if (!res.ok && res.reason === 'no-ticket' && a.alert === undefined) {
    // The ticket may itself be waiting for "which account was it on?": the
    // trade waits with it, and the one answer marks both.
    const waiting = readPending().filter((p) => p.kind === 'ticketed' && clock() - p.atMs <= takenWithinMs(timeframeFor(cfg)));
    if (waiting.length === 1) {
      const entry = fold(events).get(waiting[0].id);
      if (entry && entry.shown) {
        addPending({ kind: 'taken', id: entry.id, payload: { how: 'ticket' }, atMs: clock() });
        journalNotes.push('NOTE: the ticket is still waiting for which account it was on; this trade waits with it. When they say, run: journal account demo (or live).');
        const mismatch = accountMismatch(entry, cfg);
        return mismatch ? mismatch.question : null;
      }
    }
  }
  if (!res.ok) {
    if (res.reason === 'ambiguous') journalNotes.push(`NOTE: journal — tickets were built for ${res.candidates.length} alerts in the last ${tfInfo(timeframeFor(cfg)).maxAgeMin} minutes (${res.candidates.join(', ')}); ask which one they took, then run: journal took --alert <its time or id> (the count is already done).`);
    return null;
  }
  const entry = fold(events).get(res.event.id);
  return markUserEvent('taken', entry, { how: res.event.how }, account);
}

/** What a change to the method's parts means, in the user's words. */
const METHOD_PARTS = [
  ['tf', 'the chart timeframe'], ['costs', 'the costs (commission or GBP/USD)'], ['window', 'the session window'],
  ['feeds', 'the price feed'], ['version', 'the rules that decide alerts'], ['targetRule', 'the target rule'], ['filter', 'the filter'],
];

/**
 * Whether settings `file` would end the alert sample in progress (rule 1):
 * the sample is still running (no verdict, not ended, and today's settings
 * are still its method), and under `file` the desk would be a different
 * method for one of its instruments. null, or { sample, count, planned,
 * question } — the question in plain words: what changes, that the sample
 * then stops for good with no verdict, and that a new one starts from zero.
 */
function sampleEndedBy(file) {
  const events = journalEvents();
  const s = foldSample(events);
  const st = s ? sampleStatus(events, s) : null;
  if (!st || st.complete || st.ended) return null;
  const was = methodNow(cfg), will = methodNow(withDefaults(file));
  const pairs = s.pairs.filter((p) => keyFor(was, p) === keyFor(s.method, p) && keyFor(will, p) !== keyFor(s.method, p));
  if (!pairs.length) return null;
  const parts = METHOD_PARTS.filter(([k]) => pairs.some((p) => JSON.stringify(forPair(was, p)[k]) !== JSON.stringify(forPair(will, p)[k]))).map(([, w]) => w);
  const count = Math.min(st.count, st.planned);
  const what = parts.length ? parts.join(' and ') : 'how the alerts are decided';
  return {
    sample: s, count, planned: st.planned,
    question: `Before I change that: it changes ${what} for ${pairs.map(nameOf).join(' and ')}, and that ends the alert sample you committed to on ${dayLabel(s.committedAt, LONDON)}, now at ${count} of ${st.planned} alerts. The alerts after the change would come from a different method, so they cannot be judged together with the ones before it: the sample stops for good, with no verdict, even if you change the setting back later, and a new sample would start again from zero. Shall I change it anyway?`,
  };
}

/**
 * The session's NOTE for a paused sample (journal.mjs samplePause): it is not
 * ended, nothing is counted while the method differs, and only the user's
 * words decide — put the settings back, or end it with config --end-sample.
 */
function pausedNote(pause) {
  const back = [];
  if (pause.parts.includes('tf')) back.push(`config timeframe=${pause.sample.method.tf}`);
  if (pause.parts.includes('costs')) back.push('config commission=… (or gbpusd=…) as it was when the sample was committed — git log -p on desk/config.json shows it');
  if (pause.parts.includes('window')) back.push('the session window in desk/config.json as it was when the sample was committed');
  const what = pause.parts.map((k) => METHOD_PART_WORDS[k]).join(' and ');
  const how = pause.settingsOnly ? `to carry on, put the settings back (${back.join('; ')}); to end it` : 'the desk\'s rules cannot be put back from the settings; to end it';
  return `NOTE: the alert sample is paused, not ended: ${what} for ${pause.pairs.map(nameOf).join(' and ')} no longer match its method. Send the reply as it is. Only as they answer: ${how}, run config --end-sample, then commit ${JOURNAL}, git pull --rebase, and push. Never end it without their words.`;
}

const HOW_WORDS = { stop: 'stop', target: 'target', manual: 'by-hand', 'by-hand': 'by-hand', hand: 'by-hand', end: 'end-of-session', 'end-of-session': 'end-of-session' };
const SAID_HOW = { target: 'at its target', stop: 'at its stop', 'by-hand': 'closed by hand', 'end-of-session': 'closed at the end of the session' };

/* ---------------------------------------------------------------- commands */

const cmds = {
  async now() {
    // The journal's silent update starts with the command and is waited for
    // after the reply is out (at most about five seconds); it says nothing.
    const quiet = resolveSilently();
    say('info', formatNow(NOW, cfg, loadPlan()));
    await quiet;
  },

  async brief(a) {
    const quiet = resolveSilently();
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
    await quiet;
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
      // The journal links the trade to an alert only explicitly (--alert, or
      // the one ticket built in the last 30 minutes); the count is the plan's.
      const ask = sub === 'took' ? journalTaken(a) : null;
      const ps = planStatus(cur, today);
      if (!ps) return say('need-input', ['No plan set for today, so there is nothing to count it against yet. Tell me your setups and the most trades you will take, and I will count this one.', ask].filter(Boolean).join('\n\n'));
      writeJson(planPath, { ...cur, taken: Math.max(0, ps.taken + (sub === 'took' ? 1 : -1)) });
      if (ask) {
        const now = planStatus(loadPlan(), today);
        return say('info', `Today's plan: ${now.setups.join(' · ')}, up to ${now.max} trades.\n${planLine(loadPlan(), NOW, cfg.window)}\n\n${ask}`);
      }
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
    // --end-sample: the user agreed that this change ends the alert sample in
    // progress (asked first, below). parseArgs takes a setting written after
    // the flag as its value; it is a setting all the same.
    if (typeof a['end-sample'] === 'string') sets.push(a['end-sample']);
    const endSample = a['end-sample'] !== undefined;
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
      // Which account the trades are on, for the journal (not `mode`, which is how screenshots are read).
      account: ['account', 'mode', (v) => (ACCOUNT_MODES.includes(v.toLowerCase()) ? v.toLowerCase() : NaN)],
    };
    // The answer to rule 6's question is an event in the journal, not a setting.
    let consent = null;
    for (const kv of sets.filter((x) => /^livejournal=/i.test(x))) {
      const v = kv.slice(kv.indexOf('=') + 1).trim().toLowerCase();
      if (v !== 'yes' && v !== 'no') usage('livejournal=yes or livejournal=no: whether a live-account record may sit in the public repository.');
      consent = v;
    }
    for (const kv of sets.filter((x) => !/^livejournal=/i.test(x))) {
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
    // Rule 1: a change that makes the desk a different method for an
    // instrument of the sample in progress ends that sample. The desk says so
    // and asks first; only with --end-sample (their yes) is it changed, and
    // the end is recorded in the journal. A sample already PAUSED (the
    // settings were changed outside config, or the desk's rules changed:
    // journal.mjs samplePause) is ended the same way, by --end-sample alone —
    // never by anything else; settings put back with config resume it.
    const pauseBefore = samplePause(journalEvents(), { cfg, methodNow: methodNow() });
    const ends = changed ? sampleEndedBy(file) : null;
    if (ends && !endSample) {
      return say('need-input', ends.question, [`NOTE: nothing was changed. Send this as it is and wait. Only if they say to go ahead, run the same config command again with --end-sample (then commit desk/config.json and ${JOURNAL}, git pull --rebase, and push).`]);
    }
    const endable = ends || (endSample && pauseBefore ? { sample: pauseBefore.sample, count: Math.min(pauseBefore.st.count, pauseBefore.st.planned), planned: pauseBefore.st.planned } : null);
    let ended = null;
    if (endSample && endable) {
      const w = writeJournal([sampleEndEvent({ sample: endable.sample, at: clock() })], { note: false });
      if (w.error) return say('error', 'Nothing was changed: the end of your alert sample could not be written to your record just now.');
      ended = endable;
    }
    // --end-sample with nothing to end: a running sample whose method is the
    // desk's is never ended on request alone (decision 8: no optional stopping).
    const runningKept = endSample && !ended ? (() => { const ev = journalEvents(), sm = foldSample(ev), st = sm ? sampleStatus(ev, sm) : null; return st && !st.complete && !st.ended ? st : null; })() : null;
    if (changed) writeJson(CONFIG, file);
    const c = withDefaults(file);
    const pauseAfter = ended ? null : samplePause(journalEvents(), { cfg: c, methodNow: methodNow(c) });
    const ac = c.account;
    let journalChanged = !!ended;
    if (consent) journalChanged = writeJournal([consentEvent({ answer: consent, at: clock() })], { note: false }).added.length > 0 || journalChanged;
    const events = journalEvents();
    const answer = foldConsent(events);
    const live = ac.mode === 'live';
    const ask = live && needsLiveConsent(events, c);
    if (ask) journalNotes.push(LIVE_NOTE);
    if (pauseAfter) journalNotes.push(pausedNote(pauseAfter));
    const what = [changed && 'desk/config.json', journalChanged && JOURNAL].filter(Boolean);
    say(what.length ? `changed · commit ${what.join(' and ')}` : sets.length ? 'unchanged' : 'info', [
      '**Desk settings**',
      `- Balance ${ac.currency} ${fmt(ac.balance, 2)} · risk ${ac.riskPct}% a trade`,
      `- Shadow balance ${ac.shadowBalance ? `${ac.currency} ${fmt(ac.shadowBalance, 2)}` : 'not set'} · sizing from **${ac.sizeFrom === 'shadow' && ac.shadowBalance ? 'the shadow balance' : 'the account balance'}**`,
      `- GBP/USD ${ac.gbpusd} · leverage 1:${ac.leverage}`,
      `- Commission ${ac.commissionPerSideGBP === null ? 'from the spec (gold £2.75 a lot each side, bitcoin none)' : `£${ac.commissionPerSideGBP} a lot each side`}`,
      `- MT5 server clock ${c.broker.serverOffset === 'auto' ? 'follows New York + 7 (UTC+3 now, UTC+2 from 1 November)' : `UTC${c.broker.serverOffset >= 0 ? '+' : ''}${c.broker.serverOffset}`} · screenshots read **${c.mode === 'fast' ? 'Fast (one reader)' : 'Thorough (three readers and a head trader)'}** unless you say otherwise`,
      `- Chart **${timeframeFor(c)}** (${tfInfo(timeframeFor(c)).words}) · an idea feeds a ticket for ${tfInfo(timeframeFor(c)).maxAgeMin} minutes`,
      `- Account **${live ? 'live' : 'demo'}** · the alerts you are sent and your trades go in your record as ${live ? 'live' : 'demo'}${!live ? '' : answer === 'yes' ? '' : answer === 'no' ? ' — but nothing from it is written, as you asked' : ' — once you say whether a live record may sit in the public repository'}`,
      ...(ended ? ['', `Your alert sample has stopped at ${ended.count} of ${ended.planned}, with no verdict, as you agreed. A new one can be committed under these settings whenever you like.`] : []),
      ...(pauseAfter ? ['', `Your alert sample is paused at ${Math.min(pauseAfter.st.count, pauseAfter.st.planned)} of ${pauseAfter.st.planned}, because ${pauseReason(pauseAfter)}: nothing is counted while it differs.${pauseAfter.settingsOnly ? ' Put the settings back and it carries on, or tell me to end it, with no verdict.' : ' Tell me if you want it ended, with no verdict.'}`]
        : pauseBefore && !ended ? ['', `Your alert sample carries on from ${Math.min(pauseBefore.st.count, pauseBefore.st.planned)} of ${pauseBefore.st.planned}: the settings match it again.`] : []),
      ...(runningKept ? ['', `Your alert sample (${Math.min(runningKept.count, runningKept.planned)} of ${runningKept.planned}) is running under these settings, so it has not been ended: it ends only with a change to how the alerts are decided, and I ask first.`] : []),
      ...(consent ? [consent === 'yes'
        ? 'Noted: your live-account alerts and trades will go in your record, in the public repository. You can change your mind with a word.'
        : 'Noted: nothing from your live account will go in your record. Demo alerts and trades still do.'] : []),
      ...(ask ? ['', LIVE_QUESTION] : []),
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
    const quiet = resolveSilently();
    const replies = [], notes = [], recs = [], shown = [];
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
        shown.push({ r, bars: lb.bars });
        replies.push(formatLiveIdea(rec, cfg, clock(), loadPlan()));
      } else replies.push(formatLiveNone(r, cfg));
    }
    if (recs.length) recordAlerts(recs);
    // Every idea a scan reports is recorded as what the user was shown (source
    // 'scan': never part of the sample, whatever shouldAlert would have said).
    if (shown.length) recordShown(shown, 'scan');
    say('info', replies.join('\n\n'), notes);
    await quiet;
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
    // The journal's silent update, once (at most about five seconds): after
    // WATCHING and the start-up notes are out, which the session reads while
    // the watch runs in the background, and before the first poll.
    let silentDone = false;
    const silentOnce = async () => { if (!silentDone) { silentDone = true; await resolveSilently(); } };
    // Its memory of the last alert, from the journal if the container lost it.
    seedAlertState(pairs, tf);
    const started = clock();
    const errors = {};
    const status = { startedAtMs: clock(), pairs, tf, polls: 0, last: {} };
    // Said once the watch is really under way (reading, or waiting for the open), with
    // the start-up notes straight after it: the session reads these while the watch
    // runs in the background, to tell the user what is watched. A watch that stops
    // at once (after 16:00, the weekend) says only that.
    let announced = false;
    const announce = () => {
      if (announced) return;
      console.log(`WATCHING: ${pairs.map((p) => label(p)).join(' and ')} on ${tfInfo(tf).id}${anytime ? ', at any hour' : ', in the window'}.`);
      for (const n of notes) console.log(n);
      announced = true;
    };
    const finish = (st, reply, extra = []) => {
      rmSync(pidFile, { force: true });
      writeJson(watchPath('status.json'), { ...status, endedAtMs: clock(), ended: st });
      say(st, reply, announced ? extra : [...notes, ...extra]);
      process.exit(0);
    };

    for (;;) {
      let now = clock();
      if (!inWatchHours(now, cfg, anytime)) {
        const w = windowState(now, cfg.window);
        if (w.phase === 'before' && !a.once) {
          // Wait for the open — in real time, up to the cap. An instant exit here
          // had the session restarting it in a tight loop before 06:00.
          const left = maxMs - (clock() - started);
          if (left <= 60000) { await silentOnce(); finish('timeout', null, ['NOTE: the window has not opened yet; start the watch again (no message to the user).']); }
          announce();
          await silentOnce();
          const wait = maxMs - (clock() - started);
          await pause(Math.min(w.opensAtMs - clock() + 20000, wait - 30000));
          continue;
        }
        await silentOnce();
        finish('stopped', null, [`NOTE: outside the watch hours (${w.phase}). Tell the user the watch has stopped for today, in one line.`]);
      }
      announce();
      if (!silentDone) { await silentOnce(); now = clock(); }
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
        if (r.kind === 'idea' && shouldAlert(state, r, closedBars(lb.bars, tfInfo(tf).minutes, now), cfg)) alerts.push({ r, bars: lb.bars });
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
        const recs = alerts.map(({ r }) => ideaRecord(r));
        recordAlerts(recs);
        // Each alert as sent, in the journal (source 'watch').
        recordShown(alerts, 'watch');
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
    const account = a.account && a.account !== true ? String(a.account).toLowerCase() : null;
    if (account && !ACCOUNT_MODES.includes(account)) usage('--account is demo or live.');
    let ask = null;
    if (res.ok) {
      // A ticket built: the user's MT5 price and its levels go in the journal,
      // never the lot size or any money (journal.mjs markTicketed).
      const entry = fold(journalEvents()).get(idOf(rec.pair, rec.tf, rec.barCloseMs));
      if (entry && entry.shown) ask = markUserEvent('ticketed', entry, { userPrice: price, stopLoss: res.result.stopLoss ?? null, takeProfit: res.result.takeProfit1 ?? null }, account);
    }
    say(res.ok ? 'done · ticket' : res.needSpread ? 'need-spread' : 'refused', ask ? `${res.text}\n\n${ask}` : res.text, lb.ok ? [] : [`NOTE: feeds — ${lb.reason}`]);
  },
  /**
   * The journal (desk/journal.mjs). With no subcommand, what it says now: in
   * the user's session, process counts only and rule 4's sentence; after it,
   * the alerts (scored on the feed) and the user's trades (as they told them),
   * never added together, then the sample.
   */
  async journal(a) {
    const sub = a._[1] || 'summary';
    const pair = a.pair && a.pair !== true ? pairOf(a.pair) : null;
    if (a.pair && !pair) usage('Which instrument? --pair gold or --pair bitcoin');
    const account = a.account && a.account !== true ? String(a.account).toLowerCase() : null;
    if (account && !ACCOUNT_MODES.includes(account)) usage('--account is demo or live.');

    if (sub === 'summary' || sub === 'show') {
      await resolveSilently();
      if (!existsSync(JOURNAL)) return say('info', 'Nothing is in your record yet: it starts with the first alert I send you.');
      const events = journalEvents();
      const pause = samplePause(events, { cfg, methodNow: methodNow() });
      return say('info', summary(events, { nowMs: clock(), cfg, methodNow: methodNow() }), pause ? [pausedNote(pause)] : []);
    }

    if (sub === 'update') {
      // Without a time limit: every weekday of a committed sample not yet
      // recorded, then what the user was shown. Run after a pull (journal.mjs).
      const u = await journalUpdate();
      const notes = [...u.problems.map((p) => `NOTE: journal update — ${p}`), ...u.pending.filter((p) => p.why !== 'window-open').map((p) => `NOTE: ${p.pair} ${p.day} not recorded yet (${p.why})`)];
      if (u.wrote) notes.push(COMMIT_JOURNAL);
      const days = Object.entries(u.recorded).map(([p, n]) => `${n} ${n === 1 ? 'day' : 'days'} of ${nameOf(p)} (${u.alerts[p] || 0} ${u.alerts[p] === 1 ? 'alert' : 'alerts'})`);
      const lines = [];
      lines.push(days.length ? `Checked on the price feed: ${days.join(' and ')}.`
        : u.paused ? `Nothing checked on the price feed for your alert sample: it is paused, because ${pauseReason(u.paused)}, and nothing is counted while it differs.`
          : 'Nothing new to check on the price feed.');
      if (u.paused) notes.push(pausedNote(u.paused));
      if (u.resolved) lines.push(`${u.resolved} ${u.resolved === 1 ? 'alert you were sent has' : 'alerts you were sent have'} finished and ${u.resolved === 1 ? 'is' : 'are'} scored.`);
      if (u.needKey.includes('XAUUSD')) lines.push(KEY_HOW);
      return say(u.problems.length ? 'done · with problems' : 'done', lines.join('\n\n'), notes);
    }

    if (sub === 'result') {
      const found = tradeAlert(a.alert, pair, (e) => !e.actual);
      if (found.error) return say('need-input', ...notFound(found, 'Which alert was that trade on? Tell me the time it came and the instrument. (A trade on an idea from a screenshot is not kept in the record.)'));
      const entry = found.entry;
      // A short reference ("last", a London time) to an alert that already has
      // their result is more often a second trade than a correction: ask, and
      // replace it only by the full id or --replace, on their word.
      const byId = typeof a.alert === 'string' && ALERT_ID.test(a.alert);
      if (entry.actual && !byId && !a.replace) {
        return say('need-input', `You told me that trade ended at ${fmtR(entry.actual.r)}. Is this a different trade?`,
          [`NOTE: the ${alertWords(entry, true)} (${entry.id}) already has their result (${fmtR(entry.actual.r)}); nothing was written. Only if they say it is the same trade and this result replaces it, run the same command again with --alert ${entry.id} (or add --replace). If it is a different trade, ask which alert it was on (a trade on a screenshot idea is not kept).`]);
      }
      const how = a.how === undefined ? null : HOW_WORDS[String(a.how).toLowerCase()];
      if (a.how !== undefined && !how) usage('--how is stop, target, manual (closed by hand) or end (closed at the end of the session).');
      let r = num(a.r);
      if (a.pounds !== undefined) {
        // Pounds are turned into R with the risk the ticket gave, and only R is kept.
        const p = num(a.pounds), risk = num(a.risk);
        if (!Number.isFinite(p) || !(risk > 0)) usage('--pounds P needs --risk X, the amount the ticket said it risked: R = P / X. Neither is stored.');
        r = p / risk;
      }
      if (r === null && how === 'stop') r = -1;
      if (r === null && how === 'target') r = entry.shown.netR;
      if (!Number.isFinite(r)) return say('need-input', 'How did that trade end — at its stop, at its target, or closed by hand? If by hand, what did it make or lose, as a multiple of the risk, or in pounds?');
      let ev;
      try { ev = markActual(entry, { r, how: how || 'by-hand', at: clock(), account }); } catch (e) { return say('refused', 'That result could not be recorded: it must be a number of times the risk, between −50 and +50.', [`NOTE: ${e.message}`]); }
      const mismatch = accountMismatch(entry, cfg);
      if (mismatch && !account) {
        // Waits for the answer like a ticket or a "took it": `journal account demo|live` applies it.
        addPending({ kind: 'actual', id: entry.id, payload: { r: ev.r, how: ev.how }, atMs: clock() });
        return say('need-input', mismatch.question, ['NOTE: when they answer, run: journal account demo (or live).']);
      }
      const res = writeJournal([ev]);
      if (res.error) return say('error', 'Your record could not be updated just now.');
      dropPending('actual', entry.id);
      if (res.held.length) return say('need-input', foldConsent(journalEvents()) === null ? LIVE_QUESTION : 'Noted — but you asked for nothing from your live account to go in your record, so it was not written.', foldConsent(journalEvents()) === null ? [LIVE_NOTE] : []);
      const before = entry.actual ? ` This replaces the result you gave before (${fmtR(entry.actual.r)}).` : '';
      return say('done', `Noted for your record: your trade on the ${alertWords(entry, !recentAlert(entry))}, ${SAID_HOW[ev.how]} (${fmtR(ev.r)} times the risk).${before}`);
    }

    if (sub === 'took') {
      // Marks a trade taken without touching the plan's count (plan took does both).
      const found = tradeAlert(a.alert, pair, (e) => !e.taken);
      if (found.error) return say('need-input', ...notFound(found, 'Which alert did you take? Tell me the time it came and the instrument.'));
      const ask = markUserEvent('taken', found.entry, { how: 'named' }, account);
      return say(ask ? 'need-input' : 'done', ask || `Noted: you took the ${formatHM(found.entry.barCloseMs, cfg.window.tz)} ${nameOf(found.entry.pair)} ${found.entry.side} alert.`);
    }

    if (sub === 'alert') {
      // A direct question about one named alert is answered in R, at any hour (rule 4).
      const found = shownAlert(a.alert, pair);
      if (found.error) {
        const live = (cfg.account.mode || 'demo') === 'live' && foldConsent(journalEvents()) !== 'yes';
        return say('need-input', live ? 'That alert came while nothing from your live account is kept in your record, so I have nothing on it.' : 'Which alert do you mean? Tell me the time it came and the instrument.', [`NOTE: ${found.error}.`]);
      }
      const e = found.entry;
      const o = (e.alert && e.alert.outcome) || e.shownOutcome;
      const lines = [`${outcomeSentence(e, cfg, { withDay: !recentAlert(e) })}.`];
      if (o && Number.isFinite(o.mfe)) lines.push(`On the way it went as far as ${fmtR(o.mfe)} times the risk in its favour and ${fmtR(-o.mae)} against, over ${o.bars} ${o.bars === 1 ? 'bar' : 'bars'}.`);
      if (o) lines.push(`Scored on ${(e.alert ? e.alert.feed : e.shownOutcome.feed).split(' (')[0]}'s prices, not your MT5 trade.`);
      return say('info', lines.join(' '));
    }

    if (sub === 'sample') {
      const events = journalEvents();
      const n = num(a.alerts);
      // A paused sample is not ended (only the user's agreement ends one), so
      // no new one can be asked for or committed over it: say so in plain words.
      const pause = samplePause(events, { cfg, methodNow: methodNow() });
      if (pause) {
        return say('refused', `Not committed: your alert sample is paused at ${Math.min(pause.st.count, pause.st.planned)} of ${pause.st.planned}, not ended, because ${pauseReason(pause)}. ${pause.settingsOnly ? 'Put the settings back and it carries on; or, if you want it ended, with no verdict, say so, and then a new one can be committed.' : 'If you want it ended, with no verdict, say so, and then a new one can be committed.'}`,
          [pausedNote(pause), 'NOTE: after config --end-sample (on their words only), ask the sample question again: journal sample.']);
      }
      if (n === null) return say('need-input', sampleQuestion(DEFAULT_PLANNED_ALERTS), [`NOTE: only on their yes, run: journal sample --alerts ${DEFAULT_PLANNED_ALERTS} — then commit the journal, git pull --rebase, and push.`]);
      // Only instruments the desk can read on the reference feed: a sample of
      // gold without a Twelve Data key could never be checked, so never judged.
      const pairs = a.pairs && a.pairs !== true ? String(a.pairs).split(',').map((x) => pairOf(x.trim())) : ['BTCUSD', ...(goldAvailable() ? ['XAUUSD'] : [])];
      if (pairs.includes(null)) usage('--pairs gold,bitcoin (either or both).');
      const m = methodNow();
      // An ended sample (the user agreed to end it) can be followed at once; setSample refuses one still running.
      let ev;
      try {
        ev = setSample({ plannedAlerts: n, method: m, cfg, pairs, committedAt: clock(), events });
      } catch (e) {
        const why = e.message.replace(/^journal: /, '');
        return say('refused', `Not committed: ${why[0].toLowerCase()}${why.slice(1)}.`.replace(/\.\.$/, '.'), [`NOTE: ${e.message}`]);
      }
      const res = writeJournal([ev]);
      if (res.error) return say('error', 'The commitment could not be written just now; nothing was committed.');
      const names = ev.pairs.map(nameOf).join(' and ');
      return say('done', `Committed: I will judge the alerts on ${names} on the next ${n} of them, every alert scored on the price feed whether you take it or not, and give no verdict before then. Your own trades stay in 'Is it working yet?', separately.`);
    }

    if (sub === 'account') {
      // The user's answer to "which account was that trade on?" for the marks waiting on it.
      const mode = String(a._[2] || a.is || '').toLowerCase();
      if (!ACCOUNT_MODES.includes(mode)) usage('journal account demo | live');
      const waiting = readPending();
      if (!waiting.length) return say('info', 'There is nothing waiting for that answer.');
      const lines = [];
      for (const p of waiting) {
        const entry = fold(journalEvents()).get(p.id);
        if (!entry || !entry.shown) continue;
        const ask = markUserEvent(p.kind, entry, p.payload, mode);
        if (ask) lines.push(ask);
      }
      writeJson(pendingPath, []);
      return say(lines.length ? 'need-input' : 'done', lines.length ? [...new Set(lines)].join('\n\n') : `Noted: on your ${mode} account.`);
    }

    usage('journal [summary] | update | result --alert A (--r R | --how stop|target|manual|end | --pounds P --risk X) [--account demo|live] [--replace] | took --alert A | alert --alert A | sample [--alerts N] | account demo|live');
  },

  /**
   * The learning layer's words for the user (desk/learn.mjs): where it stands,
   * its report in the plan's shape, and "similar setups" — only ever when
   * asked, never on an alert or a push (plan rule 3). fit and final stay
   * developer commands of desk/learn.mjs itself.
   */
  async learn(a) {
    const L = await import('./learn.mjs');
    const sub = a._[1] || 'status';
    const pair = pairOf(a.pair && a.pair !== true ? a.pair : 'bitcoin');
    if (!pair) usage('Which instrument? --pair gold or --pair bitcoin');
    const MODEL = process.env.SCALP_DESK_MODEL || join(dirname(CONFIG), 'model.json');
    let model;
    try { model = L.readModel(MODEL); } catch (e) { return say('error', 'The learning layer\'s record could not be read.', [`NOTE: ${MODEL}: ${e.message}`]); }
    const word = label(pair);
    const sample = foldSample(journalEvents());

    if (sub === 'report') return say('info', L.userReport(model, { pair, committedAlerts: sample ? sample.plannedAlerts : null }));

    if (sub === 'status') {
      const ran = L.lastFinal(model);
      const started = (model.finals || []).some((f) => f && ['started', 'crashed'].includes(f.kind));
      const notes = [`NOTE: developer status: node 06-scalping-copilot/desk/learn.mjs status --pair ${pair === 'XAUUSD' ? 'gold' : 'bitcoin'}`];
      if (ran || started) return say('info', `${L.userReport(model, { pair }).split('\n').slice(0, ran ? 1 : 2).join('\n')}${ran ? '\nAsk for the report for the figures.' : ''}`, notes);
      if (!model.recipeHash) return say('info', `The learning layer has not been built yet for ${word.toLowerCase()}: nothing has been fitted to past prices, so there is nothing to report.`, notes);
      return say('info', `The learning layer is fitted to ${word.toLowerCase()}'s 2017–2024 prices. The one test on prices it never saw (2025 to mid-October 2026) has not run yet, so there is nothing to report. It does not change which alerts you get.`, notes);
    }

    if (sub === 'similar') {
      if (!a.at || a.at === true) usage('learn similar --at 2026-10-21T13:15 (the bar close, UTC) [--side buy|sell]');
      const closeMs = Date.parse(/Z$/.test(a.at) ? a.at : `${a.at}Z`);
      if (!Number.isFinite(closeMs)) usage('--at takes a time like 2026-10-21T13:15 (UTC).');
      if (a.side !== undefined && !['buy', 'sell'].includes(a.side)) usage('--side is buy or sell.');
      const heldFrom = Date.UTC(2025, 0, 1);
      if (closeMs >= heldFrom && closeMs <= JOURNAL_HOLDOUT.toMs) {
        return say('refused', 'That moment is inside the stretch held back for the learner\'s one test (2025 to mid-October 2026), so I will not set it against the past. Ask about an earlier moment, or one from now on.');
      }
      const rowsFile = L.defaultRowsPath(HOME, { pair, cfg });
      if (!existsSync(rowsFile)) return say('info', 'Similar setups need the history of past prices the learner reads, and it has not been built yet.', [`NOTE: no rows at ${rowsFile} (node desk/dataset.mjs --pair bitcoin builds them).`]);
      let rows;
      try { ({ rows } = await L.loadDataset(rowsFile, { pair, cfg })); } catch (e) {
        return say('info', 'Similar setups are not available just now: the history of past prices the learner reads needs rebuilding.', [`NOTE: ${e.message}`]);
      }
      if (!rows.length) return say('info', 'Similar setups need the history of past prices the learner reads, and it holds no rows.');
      // One standard trade, on the side the user named. With none named the
      // desk asks — it never shows both at once (two figures side by side read
      // as a comparison, and the better one as a lean) and never takes the
      // engine's lean, which on a rejected idea or a closed gate is a
      // direction the desk withheld (decisions 2, 22; plan rule 3).
      if (!a.side || a.side === true) {
        return say('need-input', 'Similar setups describe one standard trade. Which side are you thinking of — buy or sell?',
          ['NOTE: run it again with --side buy or --side sell only as they answer; never pick a side for them, and never from an alert\'s or the engine\'s direction.']);
      }
      let vecOf, day;
      if (closeMs < heldFrom) {
        const row = rows.find((x) => x.closeMs === closeMs);
        if (!row || !row.vL) return say('need-input', 'I have no check of the chart at that moment. Give me the close of a fifteen-minute bar inside your window, in UTC.');
        vecOf = (sd) => (sd === 'sell' ? row.vS : row.vL);
        day = row.day;
      } else {
        // A moment from now on: described from the reference feed's bars up to it, as the watcher would have read it.
        const tf = timeframeFor(cfg), tfMs = tfInfo(tf).minutes * 60000;
        const got = await referenceBars(pair, tf, fromForBars(pair, tf, closeMs, CLOSED_BARS + 96));
        if (!got.ok) return got.needKey ? say('need-key', KEY_HOW) : say('error', 'The price feed is not answering just now; ask again in a minute.', [`NOTE: ${got.reason}`]);
        const closed = got.bars.filter((b) => b.t + tfMs <= closeMs).slice(-CLOSED_BARS);
        if (!closed.length || closed[closed.length - 1].t + tfMs !== closeMs) return say('need-input', 'The price feed has no bar closing at that time. Give me the close of a fifteen-minute bar, in UTC.');
        const nowMs = closeMs + 20000;
        const r = liveRead({ pair, bars: closed, nowMs, cfg });
        let f;
        try { f = featuresFromBars({ bars: closed, nowMs, cfg, pair, tf, analysis: r.analysis ?? null }); } catch (e) {
          return say('info', 'That moment cannot be described: the price feed has too few bars before it.', [`NOTE: ${e.message}`]);
        }
        vecOf = (sd) => L.vectorOf(f, sd === 'sell' ? -1 : 1);
        day = dayOf(closeMs);
      }
      const s1 = L.similarSetups(vecOf(a.side), rows, { beforeDay: day, side: a.side });
      const first = rows[0].day.slice(0, 4), last = String(Math.min(2024, Number(day.slice(0, 4))));
      const words = { pairWord: word.toLowerCase(), years: first === last ? first : `${first}–${last}` };
      return say('info', L.similarWords(s1, words));
    }

    usage('learn status | report | similar --at <UTC bar close> [--side buy|sell] [--pair bitcoin]');
  },
};

const args = parseArgs(process.argv.slice(2));
const cmd = cmds[args._[0]];
if (!cmd) usage(`Commands: ${Object.keys(cmds).join(', ')}`);
ensureProxy({ when: NET_CMDS.includes(args._[0]) });
mkdirSync(HOME, { recursive: true });
await cmd(args);
