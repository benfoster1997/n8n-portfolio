/**
 * desk/journal.mjs — the automatic record of every alert the method sends,
 * how each one ended on the price feed, and which ones the user took.
 *
 * Why this exists. The user asked (14 Oct 2026) for "an automatic log of every
 * live alert, its reasons, its outcome on the price feed, and whether they
 * took it". The replay says what the method did on the past; this says what it
 * does from now on, alert by alert, so that a committed sample can be judged
 * at the end (LEARNING-PLAN.md Part 3; decision 8).
 *
 * How it is stored, and why that way:
 *  - AN APPEND-ONLY LOG OF EVENTS (JSON Lines), not a file of entries edited in
 *    place. `watch` and `scan` can run at the same moment and both write; an
 *    edit-in-place would let one overwrite the other. Each event is one line —
 *    alert, ticketed, taken, resolved, actual, sample — and the entries are
 *    folded from them. Folding is idempotent: the last event of each type for
 *    an id wins, so a line written twice (a retry, or git's union merge of two
 *    branches) changes nothing.
 *  - A NATURAL ID, `${pair}-${barCloseMs}`. The watcher, a one-off scan and the
 *    backfill can all meet the same bar; one id means one entry.
 *  - WRITTEN UNDER A LOCK, THEN A TEMPORARY FILE RENAMED OVER THE OLD ONE. The
 *    lock stops two writers reading the same old file and the second dropping
 *    the first's lines; the rename means a crash never leaves half a line.
 *  - BESIDE THE CONFIG (or $SCALP_DESK_JOURNAL), so a test's config in a
 *    temporary folder gets a temporary journal and never the real one.
 *
 * What may be in it. The repository is public. Every event goes through
 * `sanitize()`, which keeps only an allowlist of fields and THROWS on anything
 * on the forbidden list (rule 6): no volume or lots, no money amount, no
 * balance, no risk %, no account number, login, server, email or phone, and no
 * free text from the user or a screenshot. A test checks both lists.
 *
 * What it says, and when (rules 4 and 5). Resolution is silent. During the
 * user's session on a weekday the summary gives process counts only — results
 * mid-session tend to make the next decision worse. Afterwards it gives two
 * blocks that are never added together: the alerts, scored on the feed's
 * prices; and the user's own trades, as they told them. Outcomes are said in
 * one of three ways ("reached its target", "hit its stop", "was closed at the
 * end of the session"), in R, never as won or lost, never in pounds, never with
 * a feed price.
 *
 * What it is not. Not the user's MT5 history: an alert is scored on Binance's
 * or Twelve Data's bars whether or not it was taken. Not a verdict before the
 * committed number of alerts (decision 8). Not wired into the commands here —
 * desk.mjs calls these functions.
 *
 * Pure apart from the file functions (journalPath, readEvents, appendEvents);
 * bars are handed in, so it is tested without a network.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveRead, shouldAlert, alertState, ideaRecord, TARGET_RULE } from './live.mjs';
import { outcome } from './outcome.mjs';
import { clusteredByDay } from './stats.mjs';
import { costFor, label, timeframeFor } from './lib.mjs';
import { windowState, localDate } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { formatHM, zonedTimeToUtc } from '../src/timezone.js';
import { INSTRUMENTS } from '../src/instruments.js';

/* ---------------------------------------------------------------- vocabulary */

export const TYPES = Object.freeze(['alert', 'ticketed', 'taken', 'resolved', 'actual', 'sample']);
export const ACCOUNT_MODES = Object.freeze(['demo', 'live']);

/**
 * Where an alert came from:
 *   watch       sent by the watcher, as sent
 *   scan        a one-off scan's idea that the watcher would also have sent
 *   scan-extra  a one-off scan's idea the watcher would NOT have sent (it skips
 *               shouldAlert) — kept, but outside the sample
 *   unseen      the method would have sent it while nothing was watching; found
 *               afterwards from the feed's bars. It counts in the sample — the
 *               sample is the method's alerts, not the ones that happened to be
 *               seen — and is never described as a missed trade.
 */
export const SOURCES = Object.freeze(['watch', 'scan', 'scan-extra', 'unseen']);

/** How the user says a trade ended. A short list, so no free text is ever stored. */
export const ACTUAL_HOW = Object.freeze(['target', 'stop', 'by-hand', 'end-of-session']);

/** How a trade was linked to an alert: the conversation named it, or a ticket was just built for it. */
export const TAKEN_HOW = Object.freeze(['named', 'ticket']);

/** The ticket's freshness on M15 (decision 25): "took it" within this links to the ticket. */
export const TAKEN_WITHIN_MS = 30 * 60000;

/**
 * The committed sample's size, declared before any live alert is seen
 * (LEARNING-PLAN.md Part 3): detecting +0.2R per alert, 5% one-sided, 80%
 * power, at sd ≈1.10R, clustered by day, needs about 190.
 */
export const DEFAULT_PLANNED_ALERTS = 190;

/** The question that commits the sample, in the plan's words. */
export const sampleQuestion = (n = DEFAULT_PLANNED_ALERTS) =>
  `Shall I judge the alerts on the next ${n} of them, every alert scored on the price feed whether you take it or not, and give no verdict before then? Your own trades stay in 'Is it working yet?', separately.`;

/** Rule 4, verbatim. */
export const IN_SESSION_LINE = 'Results are shown once your session is over; checking them mid-session tends to make the next decision worse.';

/** The verdicts, declared in the plan before any alert was seen. */
export const VERDICTS = Object.freeze({
  edge: 'evidence of an edge, not proof',
  against: 'evidence against',
  'break-even': 'not distinguishable from break-even',
});

/* ------------------------------------------------------------------ privacy */

/**
 * Fields an event may carry, by type (rule 6). Anything not listed is dropped;
 * anything on FORBIDDEN makes `sanitize` throw, so a mistake is loud, not a
 * silent leak into a public repository.
 *
 * `spreadNum` is a distance in price units (the spread the alert was costed
 * with), not money. `features` is a flat object of numbers or true/false;
 * `filter` is the learner's keep/remove call; neither can carry text.
 */
export const ALLOWED = Object.freeze({
  common: Object.freeze(['type', 'id', 'at', 'account']),
  alert: Object.freeze([
    'pair', 'tf', 'source', 'method', 'barCloseMs', 'validUntilMs', 'side', 'feed', 'feedId',
    'refPrice', 'stopDist', 'tp1Dist', 'tp2Dist', 'spreadNum', 'netR', 'confidence',
    'reasons', 'against', 'features', 'filter',
  ]),
  ticketed: Object.freeze(['userPrice', 'stopLoss', 'takeProfit']),
  taken: Object.freeze(['how']),
  resolved: Object.freeze(['r', 'how', 'bars', 'mfe', 'mae', 'bothTouched', 'scoring', 'feed', 'spreadNum']),
  actual: Object.freeze(['r', 'how']),
  sample: Object.freeze(['plannedAlerts', 'method', 'committedAt']),
  method: Object.freeze(['version', 'targetRule', 'filter']),
  filter: Object.freeze(['id', 'keep', 'predicted']),
});

/**
 * Keys that may never be written, at any depth. Matched after lower-casing and
 * dropping everything but letters and digits, so `account_number`,
 * `accountNumber` and `Account Number` are one key.
 */
export const FORBIDDEN = Object.freeze([
  // size of the position
  'volume', 'volumes', 'lot', 'lots', 'lotsize', 'positionsize',
  // money
  'money', 'amount', 'cash', 'balance', 'shadowbalance', 'equity', 'margin', 'freemargin',
  'pnl', 'profit', 'loss', 'profitloss', 'gbp', 'usd', 'currency', 'commissiongbp', 'commissionpersidegbp',
  // risk as money or as a share of the account
  'risk', 'riskpct', 'riskpercent', 'riskamount', 'riskgbp',
  // who and where the account is
  'account number', 'accountno', 'accountid', 'login', 'loginid', 'password', 'server',
  'email', 'emailaddress', 'phone', 'phonenumber', 'mobile', 'name', 'username', 'fullname',
  // free text from the user or a picture
  'note', 'notes', 'text', 'freetext', 'comment', 'comments', 'message', 'caption', 'said',
  'words', 'usertext', 'screenshot', 'image', 'upload',
].map((k) => k.replace(/[^a-z0-9]/g, '')));

/*
 * Inside `features` the word "volume" means the market's traded volume (the
 * engine's relative-volume bucket), not the user's position, so the volume
 * words are allowed there. Every other forbidden word still is not.
 */
const FEATURE_OK = new Set(['volume', 'volumes']);

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const FORBIDDEN_SET = new Set(FORBIDDEN);
const PAIRS = ['XAUUSD', 'BTCUSD'];
const MAX_TEXT = 300;
// A pound sign or an email address is never engine text.
const SENSITIVE_TEXT = /£|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

function forbiddenWalk(value, path, inFeatures = false) {
  if (Array.isArray(value)) { value.forEach((v, i) => forbiddenWalk(v, `${path}[${i}]`, inFeatures)); return; }
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT.test(value)) throw new Error(`journal: ${path} holds a money amount or an email address, which may not be stored`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const n = norm(k);
    if (FORBIDDEN_SET.has(n) && !(inFeatures && FEATURE_OK.has(n))) {
      throw new Error(`journal: "${k}" may not be stored (the repository is public)`);
    }
    forbiddenWalk(v, path ? `${path}.${k}` : k, inFeatures || (path === '' && k === 'features'));
  }
}

const num = (x, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`journal: ${what} must be a number`);
  return x;
};
const oneOf = (x, list, what) => {
  if (x === null || x === undefined) return null;
  if (!list.includes(x)) throw new Error(`journal: ${what} must be one of ${list.join(', ')}`);
  return x;
};
const shortText = (x, max, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string') throw new Error(`journal: ${what} must be text`);
  return x.slice(0, max);
};

function cleanMethod(m) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object') throw new Error('journal: method must be an object');
  return {
    version: m.version === null || m.version === undefined ? null : shortText(String(m.version), 40, 'method.version'),
    targetRule: shortText(m.targetRule ?? null, 10, 'method.targetRule'),
    filter: shortText(m.filter ?? 'none', 40, 'method.filter'),
  };
}

function cleanFeatures(f) {
  if (f === null || f === undefined) return null;
  if (typeof f !== 'object' || Array.isArray(f)) throw new Error('journal: features must be an object');
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!/^[A-Za-z0-9_.]{1,40}$/.test(k)) throw new Error(`journal: feature name "${k}" is not allowed`);
    if (typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = num(v, `features.${k}`);
  }
  return out;
}

function cleanFilter(f) {
  if (f === null || f === undefined) return null;
  if (typeof f !== 'object') throw new Error('journal: filter must be an object');
  return {
    id: shortText(f.id ?? null, 40, 'filter.id'),
    keep: typeof f.keep === 'boolean' ? f.keep : null,
    predicted: num(f.predicted ?? null, 'filter.predicted'),
  };
}

const textList = (xs, what) => {
  if (xs === null || xs === undefined) return [];
  if (!Array.isArray(xs)) throw new Error(`journal: ${what} must be a list`);
  return xs.slice(0, 3).map((x, i) => shortText(String(x), MAX_TEXT, `${what}[${i}]`));
};

/** Per-field checks: each keeps the value in a known shape or throws. */
const FIELD = {
  id: (x) => shortText(x, 60, 'id'),
  at: (x) => num(x, 'at'),
  account: (x) => oneOf(x ?? 'demo', ACCOUNT_MODES, 'account'),
  pair: (x) => oneOf(x, PAIRS, 'pair'),
  tf: (x) => { if (x != null && !/^[MH]\d{1,3}$/.test(x)) throw new Error('journal: tf must look like M15'); return x ?? null; },
  source: (x) => oneOf(x, SOURCES, 'source'),
  method: cleanMethod,
  barCloseMs: (x) => num(x, 'barCloseMs'),
  validUntilMs: (x) => num(x, 'validUntilMs'),
  side: (x) => oneOf(x, ['buy', 'sell'], 'side'),
  feed: (x) => shortText(x, 60, 'feed'),
  feedId: (x) => shortText(x, 40, 'feedId'),
  refPrice: (x) => num(x, 'refPrice'),
  stopDist: (x) => num(x, 'stopDist'),
  tp1Dist: (x) => num(x, 'tp1Dist'),
  tp2Dist: (x) => num(x, 'tp2Dist'),
  spreadNum: (x) => num(x, 'spreadNum'),
  netR: (x) => num(x, 'netR'),
  confidence: (x) => oneOf(x, ['high', 'moderate', 'low'], 'confidence'),
  reasons: (x) => textList(x, 'reasons'),
  against: (x) => textList(x, 'against'),
  features: cleanFeatures,
  filter: cleanFilter,
  userPrice: (x) => num(x, 'userPrice'),
  stopLoss: (x) => num(x, 'stopLoss'),
  takeProfit: (x) => num(x, 'takeProfit'),
  r: (x) => num(x, 'r'),
  bars: (x) => num(x, 'bars'),
  mfe: (x) => num(x, 'mfe'),
  mae: (x) => num(x, 'mae'),
  bothTouched: (x) => (x === null || x === undefined ? null : !!x),
  scoring: (x) => oneOf(x, ['half', 'stop'], 'scoring'),
  plannedAlerts: (x) => num(x, 'plannedAlerts'),
  committedAt: (x) => num(x, 'committedAt'),
};
// `how` means different things on different events, each from a short list.
const HOW = { taken: TAKEN_HOW, actual: ACTUAL_HOW, resolved: ['target', 'stop', 'window'] };

/**
 * The only way an event reaches the file. Returns a new object holding only
 * the allowed fields for its type; throws on a forbidden key anywhere in it,
 * on an unknown type, or on a field of the wrong shape.
 */
export function sanitize(event) {
  if (!event || typeof event !== 'object') throw new Error('journal: an event must be an object');
  forbiddenWalk(event, '');
  if (!TYPES.includes(event.type)) throw new Error(`journal: unknown event type "${event.type}"`);
  if (typeof event.id !== 'string' || !event.id) throw new Error('journal: an event needs an id');
  const out = {};
  for (const k of [...ALLOWED.common, ...ALLOWED[event.type]]) {
    if (!(k in event) && k !== 'account') continue;
    if (k === 'type') { out.type = event.type; continue; }
    out[k] = k === 'how' ? oneOf(event.how, HOW[event.type], `${event.type}.how`) : FIELD[k](event[k]);
  }
  return out;
}

/* ------------------------------------------------------------------- storage */

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url));

/** Where the journal lives: $SCALP_DESK_JOURNAL, or journal.jsonl beside the config. */
export function journalPath({ env = process.env, configPath = env.SCALP_DESK_CONFIG || DEFAULT_CONFIG_PATH } = {}) {
  return env.SCALP_DESK_JOURNAL || join(dirname(configPath), 'journal.jsonl');
}

/** Every event in the file, oldest first. A line that does not parse (a torn write) is skipped. */
export function readEvents(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line from an older writer: skip it */ }
  }
  return out;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Hold `${path}.lock` while `fn` runs. A lock older than `staleMs` belongs to
 * a command that died mid-write and is taken over.
 */
function withLock(path, fn, { timeoutMs = 5000, staleMs = 10000 } = {}) {
  const lock = `${path}.lock`;
  const until = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try { fd = openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('journal: another command is writing the journal; try again in a moment');
      sleepMs(5 + Math.floor(Math.random() * 10));
    }
  }
  try { writeSync(fd, String(process.pid)); return fn(); } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * Add events to the journal: sanitised first (nothing is written if any one
 * is refused), then — under the lock — the file is re-read, alerts whose id
 * is already there are dropped (first one in stands: the watcher's "as sent"
 * record is not replaced by a later scan or backfill), as is any event exactly
 * equal to the last one of its type for that id, and the rest are written to a
 * temporary file renamed over the old one.
 * Returns { added: [events written], skipped: number }.
 */
export function appendEvents(path, events, lockOpts = {}) {
  const clean = (events || []).map(sanitize);
  if (!clean.length) return { added: [], skipped: 0 };
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const alerts = new Set(), last = new Map();
    for (const e of readEvents(path)) {
      if (e.type === 'alert') alerts.add(e.id);
      last.set(`${e.id}|${e.type}`, JSON.stringify(e));
    }
    const added = [];
    for (const e of clean) {
      const key = `${e.id}|${e.type}`, line = JSON.stringify(e);
      if (e.type === 'alert' && alerts.has(e.id)) continue;
      if (last.get(key) === line) continue;
      if (e.type === 'alert') alerts.add(e.id);
      last.set(key, line);
      added.push(e);
    }
    if (added.length) {
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      const head = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
      writeFileSync(tmp, head + added.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(tmp, path);
    }
    return { added, skipped: clean.length - added.length };
  }, lockOpts);
}

/* --------------------------------------------------------------------- fold */

const byClose = (a, b) => a.barCloseMs - b.barCloseMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const list = (entries) => (entries instanceof Map ? [...entries.values()] : [...(entries || [])]);

/**
 * The entries, folded from the events: Map id → entry, in bar-close order.
 * For each id the last event of each type wins, so applying the same events
 * twice changes nothing. Events for an id with no alert are left out (an
 * alert line may arrive later in a merge); `sample` events are not entries
 * (see foldSample).
 *
 * entry = {
 *   id, pair, tf, source, method {version, targetRule, filter}, account,
 *   alertAt, barCloseMs, validUntilMs, side, feed, feedId, refPrice,
 *   stopDist, tp1Dist, tp2Dist, spreadNum, netR, confidence,
 *   reasons [], against [], features {}|null, filter {id, keep, predicted}|null,
 *   status: 'open' | 'resolved',
 *   outcome:  {r, how, bars, mfe, mae, bothTouched, scoring, feed, spreadNum, at, account} | null,
 *   ticketed: {userPrice, stopLoss, takeProfit, at, account} | null,
 *   taken:    {how, at, account} | null,
 *   actual:   {r, how, at, account} | null,
 * }
 */
export function fold(events) {
  const last = new Map();
  for (const e of events || []) {
    if (!e || typeof e !== 'object' || !e.id || e.type === 'sample' || !TYPES.includes(e.type)) continue;
    if (!last.has(e.id)) last.set(e.id, {});
    last.get(e.id)[e.type] = e;
  }
  const out = [];
  for (const [id, by] of last) {
    const a = by.alert;
    if (!a) continue;
    const pick = (e, keys) => (e ? Object.fromEntries([...keys.map((k) => [k, e[k] ?? null]), ['at', e.at ?? null], ['account', e.account ?? 'demo']]) : null);
    out.push({
      id, pair: a.pair, tf: a.tf, source: a.source, method: a.method ?? null, account: a.account ?? 'demo',
      alertAt: a.at ?? null, barCloseMs: a.barCloseMs, validUntilMs: a.validUntilMs ?? null,
      side: a.side, feed: a.feed ?? null, feedId: a.feedId ?? null, refPrice: a.refPrice ?? null,
      stopDist: a.stopDist, tp1Dist: a.tp1Dist, tp2Dist: a.tp2Dist ?? null, spreadNum: a.spreadNum ?? null,
      netR: a.netR ?? null, confidence: a.confidence ?? null,
      reasons: [...(a.reasons || [])], against: [...(a.against || [])],
      features: a.features ? { ...a.features } : null, filter: a.filter ? { ...a.filter } : null,
      status: by.resolved ? 'resolved' : 'open',
      outcome: pick(by.resolved, ALLOWED.resolved),
      ticketed: pick(by.ticketed, ALLOWED.ticketed),
      taken: pick(by.taken, ALLOWED.taken),
      actual: pick(by.actual, ALLOWED.actual),
    });
  }
  out.sort(byClose);
  return new Map(out.map((e) => [e.id, e]));
}

/** The committed alert sample: the last `sample` event, or null. */
export function foldSample(events) {
  let s = null;
  for (const e of events || []) if (e && e.type === 'sample') s = e;
  return s ? { plannedAlerts: s.plannedAlerts, method: s.method, committedAt: s.committedAt, at: s.at ?? null } : null;
}

/* -------------------------------------------------------------- the events */

const modeOf = (cfg) => oneOf((cfg && cfg.account && cfg.account.mode) || 'demo', ACCOUNT_MODES, 'account.mode');
export const idOf = (pair, barCloseMs) => `${pair}-${barCloseMs}`;

/** A canonical string for a method, so two alerts' methods compare equal only when they are. */
export const methodKey = (m) => {
  const c = cleanMethod(m) || { version: null, targetRule: null, filter: 'none' };
  return JSON.stringify([c.version, c.targetRule, c.filter]);
};

/**
 * The alert event for one desk/live.mjs ideaRecord(r). Only allowed fields
 * are kept; the record's caution text, lastStretch flag and source id are
 * left behind except as `feedId`.
 *   source  'watch' | 'scan' | 'scan-extra' | 'unseen'
 *   method  {version, targetRule, filter}
 */
export function alertEvent(rec, { source, method = null, features = null, filter = null, cfg = null, at = Date.now() } = {}) {
  if (!rec || !rec.pair || !(rec.barCloseMs > 0)) throw new Error('journal: an alert needs its pair and bar close');
  return sanitize({
    type: 'alert', id: idOf(rec.pair, rec.barCloseMs), at, account: modeOf(cfg),
    pair: rec.pair, tf: rec.tf, source: oneOf(source, SOURCES, 'source'),
    method: method || { version: null, targetRule: TARGET_RULE, filter: 'none' },
    barCloseMs: rec.barCloseMs, validUntilMs: rec.validUntilMs ?? null, side: rec.side,
    feed: rec.source ?? null, feedId: rec.sourceId ?? null, refPrice: rec.refPrice,
    stopDist: rec.stopDist, tp1Dist: rec.tp1Dist, tp2Dist: rec.tp2Dist ?? null, spreadNum: rec.spreadNum ?? null,
    netR: rec.netR ?? null, confidence: rec.confidence ?? null,
    reasons: rec.reasons || [], against: rec.against || [], features, filter,
  });
}

/** The journal's latest alert on this instrument before `beforeMs` — the one the watcher's state would hold. */
function previousAlert(entries, pair, beforeMs) {
  let prev = null;
  for (const e of list(entries)) {
    if (e.pair !== pair || e.source === 'scan-extra' || !(e.barCloseMs < beforeMs)) continue;
    if (!prev || e.barCloseMs > prev.barCloseMs) prev = e;
  }
  return prev;
}

/**
 * A one-off scan skips shouldAlert. Its idea is logged as 'scan' only when
 * the watcher would also have sent it — checked against the journal's previous
 * alert on that instrument, on the bars up to the idea's own close — and as
 * 'scan-extra' otherwise, which keeps it out of the sample.
 */
export function classifyScan(rec, entries, bars, cfg) {
  const tfMs = tfInfo(rec.tf).minutes * 60000;
  const prev = previousAlert(entries, rec.pair, rec.barCloseMs);
  const seen = (bars || []).filter((b) => b.t + tfMs <= rec.barCloseMs);
  const r = { pair: rec.pair, tf: rec.tf, barCloseMs: rec.barCloseMs, nowMs: rec.barCloseMs + 20000, spreadNum: rec.spreadNum || 0, result: { decision: rec.side } };
  const state = { lastAlert: prev ? { [rec.pair]: alertState(prev) } : {} };
  return shouldAlert(state, r, seen, cfg) ? 'scan' : 'scan-extra';
}

/**
 * `journal update`'s backfill: every bar close in the user's window, between
 * fromMs and toMs, that no entry covers, read exactly as the watcher reads it
 * (liveRead at close + 20 s on the last 1,000 bars; shouldAlert against the
 * journal's own entries in order, plus what this run adds). Each alert the
 * method would have sent comes back as an 'unseen' alert event.
 *
 *   coveredMs   bar closes a watcher already read (skipped, like an entry)
 *   feed        {id, label} of the bars' source, stored as the alert's feed
 *   featuresFor (r, seen) → features, filterFor (r, seen) → filter output
 *   keep        (r, seen) → false to drop an idea before shouldAlert (a live filter)
 *   nowMs       bars whose close + 20 s is after this are still forming: skipped
 *
 * A liveRead costs ~65 ms today (~10 ms once the formatter cache lands), so a
 * whole session's window is a few seconds.
 */
export function backfillUnseen({
  pair, bars, entries, cfg, fromMs = -Infinity, toMs = Infinity, method = null, source = 'unseen',
  feed = null, featuresFor = null, filterFor = null, keep = null, coveredMs = null, nowMs = Date.now(),
}) {
  const tf = tfInfo(timeframeFor(cfg));
  const tfMs = tf.minutes * 60000;
  const all = list(entries);
  const ids = new Set(all.map((e) => e.id));
  const covered = new Set(coveredMs || []);
  const known = all.filter((e) => e.pair === pair && e.source !== 'scan-extra').sort(byClose);
  const targetRule = (method && method.targetRule) || TARGET_RULE;
  const out = [];
  let i = 0, prev = null;
  for (let k = 0; k < (bars || []).length; k++) {
    const closeMs = bars[k].t + tfMs;
    if (closeMs < fromMs || closeMs > toMs || closeMs + 20000 > nowMs) continue;
    while (i < known.length && known[i].barCloseMs < closeMs) {
      if (!prev || known[i].barCloseMs >= prev.barCloseMs) prev = known[i];
      i++;
    }
    const w = windowState(closeMs, cfg.window);
    if (!w.open || w.phase === 'weekend') continue;
    const id = idOf(pair, closeMs);
    if (ids.has(id) || covered.has(closeMs)) continue;
    const seen = bars.slice(Math.max(0, k - 999), k + 1);
    const r = liveRead({ pair, bars: seen, nowMs: closeMs + 20000, cfg, source: feed, targetRule });
    if (r.kind !== 'idea') continue;
    if (keep && !keep(r, seen)) continue;
    if (!shouldAlert({ lastAlert: prev ? { [pair]: alertState(prev) } : {} }, r, seen, cfg)) continue;
    const rec = ideaRecord(r);
    out.push(alertEvent(rec, {
      source, method, cfg, at: nowMs,
      features: featuresFor ? featuresFor(r, seen) : null, filter: filterFor ? filterFor(r, seen) : null,
    }));
    ids.add(id);
    prev = rec;
  }
  return out;
}

/** What a target pays in R after costs, as desk/outcome.mjs computes it. */
function targetR(entry, spread, comm) {
  const buy = entry.side === 'buy';
  const risk = (buy ? entry.stopDist + spread : entry.stopDist) + comm;
  const win = (buy ? entry.tp1Dist - spread : entry.tp1Dist) - comm;
  return win / risk;
}

/**
 * Silent resolution: 'resolved' events for open entries whose day's window
 * has closed and whose feed bars reach that far, scored by desk/outcome.mjs
 * with the alert's own stored spread. A bar touching both the stop and the
 * target is scored as half of each, (target R − 1) / 2 — the plan's rule for
 * the journal; outcome() alone counts it as the stop.
 *
 *   bars   an array of the feed's bars for `opts.pair`, or {XAUUSD: [...], BTCUSD: [...]}
 *   opts   { pair, feed (name, {label}, or per pair), nowMs (default: the last bar's close) }
 * Entries still inside their window, or past the end of the bars, stay open.
 */
export function resolveOpen(entries, bars, cfg, { pair = null, feed = null, nowMs = null } = {}) {
  const barsFor = (p) => (Array.isArray(bars) ? (pair === null || pair === p ? bars : null) : (bars && bars[p]) || null);
  if (Array.isArray(bars) && pair === null) throw new Error('journal: resolveOpen needs opts.pair when given one array of bars');
  const feedFor = (p, e) => {
    const f = feed && typeof feed === 'object' && !('label' in feed) ? feed[p] : feed;
    return (typeof f === 'string' ? f : f && f.label) || e.feed || null;
  };
  const out = [];
  for (const e of list(entries)) {
    if (e.status !== 'open') continue;
    const b = barsFor(e.pair);
    if (!b || !b.length) continue;
    const tfMs = tfInfo(e.tf || timeframeFor(cfg)).minutes * 60000;
    const closesAtMs = windowState(e.barCloseMs, cfg.window).closesAtMs;
    const now = nowMs ?? b[b.length - 1].t + tfMs;
    if (now < closesAtMs) continue;
    const k = indexOfClose(b, e.barCloseMs - tfMs);
    if (k < 0) continue;
    const spread = e.spreadNum ?? INSTRUMENTS[e.pair].typicalSpread.observed;
    const { comm } = costFor(e.pair, 0, cfg);
    // bothTouched: 'half' is passed for outcome.mjs versions that take it; an
    // older one ignores it, returns −1 with the flag set, and it is halved here.
    const o = outcome(b, k, { side: e.side, stopDist: e.stopDist, tp1Dist: e.tp1Dist }, { spread, comm, closesAtMs, tfMinutes: tfMs / 60000, bothTouched: 'half' });
    if (!o) continue;
    const r = o.bothTouched && o.r === -1 ? (targetR(e, spread, comm) + -1) / 2 : o.r;
    out.push(sanitize({
      type: 'resolved', id: e.id, at: nowMs ?? Date.now(), account: modeOf(cfg),
      r: +r.toFixed(4), how: o.how, bars: o.bars, mfe: o.mfe, mae: o.mae, bothTouched: !!o.bothTouched,
      scoring: 'half', feed: feedFor(e.pair, e), spreadNum: spread,
    }));
  }
  return out;
}

/** Index of the bar opening at `t` (bars sorted by t), or −1. */
function indexOfClose(bars, t) {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/* ------------------------------------------------------- the user's own trades */

/**
 * `take` returned a ticket for this alert. The prices are the user's MT5
 * price and the levels built from it — allowed (rule 6); the lot size is not.
 */
export function markTicketed(entry, { userPrice, stopLoss = null, takeProfit = null, at = Date.now(), cfg = null } = {}) {
  if (!entry || !entry.id) throw new Error('journal: markTicketed needs the alert entry');
  return sanitize({ type: 'ticketed', id: entry.id, at, account: cfg ? modeOf(cfg) : entry.account || 'demo', userPrice, stopLoss, takeProfit });
}

/**
 * "I took it" — linked to an alert only explicitly, never by recency alone:
 *   { alertId }                         the conversation named the alert
 *   { lastTicketedWithinMs, nowMs }     a ticket built within that time (30
 *                                       minutes on M15), and exactly one
 * Returns { ok: true, event } or { ok: false, reason: 'no-alert' | 'no-ticket'
 * | 'ambiguous', candidates? } — on false, ask the user which alert it was.
 */
export function markTaken(entries, { alertId = null, lastTicketedWithinMs = null, nowMs = Date.now(), at = nowMs, cfg = null } = {}) {
  const all = list(entries);
  const event = (e, how) => ({ ok: true, event: sanitize({ type: 'taken', id: e.id, at, account: modeOf(cfg), how }) });
  if (alertId) {
    const e = all.find((x) => x.id === alertId);
    return e ? event(e, 'named') : { ok: false, reason: 'no-alert' };
  }
  if (!(lastTicketedWithinMs > 0)) throw new Error('journal: markTaken needs an alert id or a ticket window');
  const fresh = all.filter((e) => e.ticketed && e.ticketed.at <= nowMs && nowMs - e.ticketed.at <= lastTicketedWithinMs);
  if (!fresh.length) return { ok: false, reason: 'no-ticket' };
  if (fresh.length > 1) return { ok: false, reason: 'ambiguous', candidates: fresh.map((e) => e.id) };
  return event(fresh[0], 'ticket');
}

/**
 * How the user says their trade ended, in R only. The session turns "+£40"
 * into R with the risk amount before calling this; pounds never reach here.
 *   how  'target' | 'stop' | 'by-hand' | 'end-of-session'
 */
export function markActual(id, { r, how, at = Date.now(), cfg = null } = {}) {
  if (typeof r !== 'number' || !Number.isFinite(r) || Math.abs(r) > 50) throw new Error('journal: the result must be a number of R');
  return sanitize({ type: 'actual', id, at, account: modeOf(cfg), r: +r.toFixed(4), how });
}

/** True when the next entry would be the first from a live account: ask first (rule 6). */
export function needsLiveConsent(entries, cfg) {
  if (modeOf(cfg) !== 'live') return false;
  return !list(entries).some((e) => e.account === 'live' || [e.outcome, e.ticketed, e.taken, e.actual].some((x) => x && x.account === 'live'));
}

/* ------------------------------------------------------------------ the sample */

/** Commit the alert sample (the user said yes to sampleQuestion). Changing the method ends it (rule 1). */
export function setSample({ plannedAlerts = DEFAULT_PLANNED_ALERTS, method, committedAt = Date.now(), at = committedAt, cfg = null } = {}) {
  if (!Number.isInteger(plannedAlerts) || plannedAlerts < 1) throw new Error('journal: the sample needs a whole number of alerts');
  if (!method) throw new Error('journal: the sample needs the method it judges');
  return sanitize({ type: 'sample', id: 'sample', at, account: modeOf(cfg), plannedAlerts, method, committedAt });
}

const iso16 = (ms) => new Date(ms).toISOString().slice(0, 16);

/**
 * Where the committed sample stands. It counts the method's alerts from the
 * moment of commitment — one per id, scan-extras left out, unseen ones in —
 * and judges the first N once all N have finished, exactly as declared: mean R
 * per alert after costs, with the by-day clustered 95% range. Before then
 * there is no verdict, only the count and the running average.
 *
 * Returns null without a sample, else {
 *   planned, count, resolved, open, complete,
 *   mean, range [lo, hi] | null, days, verdict 'edge'|'against'|'break-even'|null, verdictText
 * } — mean, range and days are over the finished alerts among the first N.
 */
export function sampleStatus(entries, sample) {
  if (!sample) return null;
  const key = methodKey(sample.method);
  const inSample = list(entries)
    .filter((e) => e.source !== 'scan-extra' && e.barCloseMs >= (sample.committedAt ?? 0) && methodKey(e.method) === key)
    .sort(byClose);
  const N = sample.plannedAlerts;
  const first = inSample.slice(0, N);
  const done = first.filter((e) => e.outcome && Number.isFinite(e.outcome.r));
  const st = clusteredByDay(done.map((e) => ({ at: iso16(e.barCloseMs), r: e.outcome.r })));
  const complete = inSample.length >= N && done.length === N;
  let verdict = null;
  if (complete) verdict = st.clustered[0] > 0 ? 'edge' : st.clustered[1] < 0 ? 'against' : 'break-even';
  return {
    planned: N, count: inSample.length, resolved: done.length, open: first.length - done.length, complete,
    mean: st ? st.mean : null, range: st ? st.clustered : null, days: st ? st.days : 0,
    verdict, verdictText: verdict ? VERDICTS[verdict] : null,
  };
}

/* ------------------------------------------------------------------- wording */

/** R as said to the user: "+1.48", "−1", "0". The minus is a real one. */
export function fmtR(x) {
  const v = Math.round(x * 100) / 100;
  if (v === 0) return '0';
  const s = String(Math.abs(v));
  return v > 0 ? `+${s}` : `−${s}`;
}

const tzOf = (cfg) => (cfg && cfg.window && cfg.window.tz) || 'Europe/London';
const nameOf = (pair) => label(pair).toLowerCase();

/**
 * One alert's outcome, in one of rule 5's three forms:
 *   "The 10:15 bitcoin sell alert reached its target (+1.5 times the risk)"
 *   "The 10:15 bitcoin sell alert hit its stop (−1)"
 *   "The 10:15 bitcoin sell alert was closed at the end of the session (+0.3)"
 * Two cases the three forms do not cover are said just as plainly: a bar that
 * touched both levels (scored half of each), and an alert not finished yet.
 * The time is the bar close it was read at, in London.
 */
export function outcomeSentence(entry, cfg) {
  const head = `The ${formatHM(entry.barCloseMs, tzOf(cfg))} ${nameOf(entry.pair)} ${entry.side} alert`;
  const o = entry.outcome;
  if (!o) return `${head} has not finished yet`;
  if (o.bothTouched) return `${head} touched its stop and its target in the same bar, so it counts as half of each (${fmtR(o.r)})`;
  if (o.how === 'target') return `${head} reached its target (${fmtR(o.r)} times the risk)`;
  if (o.how === 'stop') return `${head} hit its stop (${fmtR(o.r)})`;
  return `${head} was closed at the end of the session (${fmtR(o.r)})`;
}

/** Decision 8, for the alerts: why there is no verdict yet. */
export const noVerdictLine = (n) =>
  `No verdict until all ${n} are in: checking after every alert and stopping on a good run turns a 5% test into a 20% one, which is how a method with no edge gets mistaken for one that has one.`;

/** "Binance" from "Binance (BTCUSDT)"; several feeds joined. */
function feedWords(entries) {
  const names = [...new Set(entries.map((e) => (e.outcome && e.outcome.feed) || e.feed).filter(Boolean).map((f) => f.split(' (')[0]))];
  if (!names.length) return "the price feed's prices";
  return `${names.map((n) => `${n}'s`).join(' and ')} prices`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sampleLines(st) {
  if (!st) return ['**The alert sample**: none committed yet, so there is no verdict to give.'];
  if (st.complete) {
    return [`**The alert sample**: complete — ${st.planned} alerts, on average ${fmtR(st.mean)} times the risk (range ${fmtR(st.range[0])} to ${fmtR(st.range[1])}, clustered by day). Verdict: ${st.verdictText}.`];
  }
  const head = st.count >= st.planned
    ? `**The alert sample**: all ${st.planned} alerts are in; the verdict comes once the last ${st.open} ${st.open === 1 ? 'has' : 'have'} finished.`
    : `**The alert sample**: ${st.count} of the ${st.planned} alerts you committed to`;
  const avg = st.resolved >= 1 && st.count < st.planned
    ? st.days >= 2
      ? ` (${st.resolved} finished), so far on average ${fmtR(st.mean)} times the risk (range ${fmtR(st.range[0])} to ${fmtR(st.range[1])}, clustered by day).`
      : ` (${st.resolved} finished), so far on average ${fmtR(st.mean)} times the risk — too few days yet for a range.`
    : st.count < st.planned ? '.' : '';
  return [head + avg, noVerdictLine(st.planned)];
}

/**
 * What `journal` says. Between the start and end of the user's window on a
 * weekday: process counts only, and rule 4's sentence. Otherwise: the alerts
 * (scored on the feed) and the user's trades (as they told them) in two
 * blocks never added together, then the sample. Covers bar closes from
 * `fromMs` (default: London midnight of nowMs) to `toMs` (default nowMs).
 */
export function summary(entries, { nowMs = Date.now(), cfg, sample = null, fromMs = null, toMs = null } = {}) {
  const tz = tzOf(cfg);
  const { y, m, d } = localDate(nowMs, tz);
  const from = fromMs ?? zonedTimeToUtc(y, m, d, 0, 0, tz);
  const to = toMs ?? nowMs;
  const all = list(entries).sort(byClose);
  const inPeriod = (t) => t !== null && t !== undefined && t >= from && t <= to;
  const period = all.filter((e) => inPeriod(e.barCloseMs));
  const sent = period.filter((e) => e.source === 'watch' || e.source === 'scan');
  const unseen = period.filter((e) => e.source === 'unseen');
  const extra = period.filter((e) => e.source === 'scan-extra');
  const st = sampleStatus(all, sample);
  const w = windowState(nowMs, cfg.window);

  if (w.open && !w.weekend) {
    const tickets = all.filter((e) => e.ticketed && inPeriod(e.ticketed.at)).length;
    const taken = all.filter((e) => e.taken && inPeriod(e.taken.at)).length;
    const byPair = PAIRS.map((p) => [p, sent.filter((e) => e.pair === p).length]).filter(([, n]) => n).map(([p, n]) => `${n} ${nameOf(p)}`);
    const lines = ['**Today so far**', [
      `- Alerts sent: ${sent.length}${byPair.length > 1 ? ` (${byPair.join(', ')})` : ''}`,
      ...(unseen.length ? [`- Alerts logged afterwards from the price feed, while nothing was watching: ${unseen.length}`] : []),
      ...(extra.length ? [`- Ideas from a one-off scan that the watcher would not have sent: ${extra.length}`] : []),
      `- Tickets you asked for: ${tickets}`,
      `- Trades you told me you took: ${taken}`,
      ...(st ? [`- Alert sample: ${Math.min(st.count, st.planned)} of ${st.planned}`] : []),
    ].join('\n'), IN_SESSION_LINE];
    return lines.join('\n\n');
  }

  const counted = [...sent, ...unseen];
  const alerts = [`**The alerts**: scored on ${feedWords(counted)}, not your MT5 trades; your own result can differ.`];
  const body = [];
  if (!counted.length) body.push('- No alerts in this period.');
  for (const e of sent) body.push(`- ${outcomeSentence(e, cfg)}`);
  if (unseen.length) {
    body.push(`- Logged afterwards from the price feed, while nothing was watching (they count in the sample):`);
    for (const e of unseen) body.push(`  - ${outcomeSentence(e, cfg)}`);
  }
  const done = counted.filter((e) => e.outcome);
  if (done.length > 1) body.push(`- On average ${fmtR(done.reduce((s, e) => s + e.outcome.r, 0) / done.length)} times the risk over ${plural(done.length, 'finished alert')}.`);
  if (extra.length) body.push(`- Not counted: ${plural(extra.length, 'idea')} from a one-off scan that the watcher would not have sent.`);
  alerts.push(body.join('\n'));

  const told = all.filter((e) => e.actual && inPeriod(e.actual.at ?? e.barCloseMs));
  const trades = [`**Your trades**: what you told me (${told.length} of them).`];
  const modes = ACCOUNT_MODES.map((mode) => [mode, told.filter((e) => e.actual.account === mode)]).filter(([, xs]) => xs.length);
  if (modes.length) {
    trades.push(modes.map(([mode, xs]) => `- ${mode === 'live' ? 'Live' : 'Demo'}: ${plural(xs.length, 'trade')}, on average ${fmtR(xs.reduce((s, e) => s + e.actual.r, 0) / xs.length)} times the risk`).join('\n'));
  }

  return [alerts.join('\n'), trades.join('\n'), sampleLines(st).join('\n')].join('\n\n');
}
