/**
 * desk/journal.mjs — the automatic record of the alerts the method sends, how
 * each one ended on the price feed, what the user was shown, and which ones
 * they took.
 *
 * Why this exists. The user asked (14 Oct 2026) for "an automatic log of every
 * live alert, its reasons, its outcome on the price feed, and whether they
 * took it". The replay says what the method did on the past; this says what it
 * does from now on, alert by alert, so that a committed sample can be judged
 * at the end (LEARNING-PLAN.md Part 3; decision 8).
 *
 * Two records, kept apart on purpose:
 *  - THE METHOD'S RECORD (`alert` and `day` events). `canonicalAlerts()`
 *    replays the method over every weekday window bar close on the REFERENCE
 *    feed's bars (bitcoin: Binance BTCUSDT; gold: Twelve Data), serially, with
 *    the watcher's own liveRead + shouldAlert, and scores each alert with
 *    outcome(). It is a pure function of the method and those bars, so the
 *    committed sample is the same whoever ran it, whenever, on whichever
 *    machine — not "whatever the watcher happened to catch". An earlier
 *    design counted the watcher's alerts plus a backfill of bars "nobody
 *    watched"; which alerts made the sample then depended on which writer ran
 *    first and on watcher state that lived in one container (review, 16 Oct).
 *    A DAY ONCE RECORDED IS FROZEN ON THIS MACHINE. Each day's `day` record
 *    lists the ids of the alerts it found, with a checksum of each line. The
 *    record keeps only the alerts the STANDING day record names: the
 *    earliest-recorded day record for that pair, timeframe, method and day,
 *    ties broken by the text of the line. canonicalAlerts() never recomputes a
 *    day that already has one, and the writer refuses a second. So a later
 *    replay over revised bars cannot add or swap an alert, and the fold is the
 *    same in any order of the lines. What this does NOT stop: a git union
 *    merge bringing in another machine's DIFFERENT record of the same day,
 *    recorded earlier — it would then stand. Such a day is CONTESTED:
 *    sampleStatus() lists it and gives no verdict while any day is contested,
 *    so a merge can never quietly change a verdict; it has to be settled by
 *    hand. A day record dated before that day's window closed is refused, so
 *    a wrong clock or a hand edit cannot win by an early `at` (re-check, 17 Oct).
 *    A day with any bar missing (in any read's slice, or in the window,
 *    outside gold's scheduled closures) is held until the feed fills it; 48
 *    hours after the close it is recorded as it is, and flagged `gap` — its
 *    alerts left out of the sample — only if a hole is of more than 4 bars.
 *  - THE METHOD is more than the engine: its version, target rule, filter,
 *    timeframe and reference feeds, and also the settings that shape what it
 *    reads and how it scores — the window (open, close, time zone) and the
 *    costs (the spread it reads with and the commission as a price distance,
 *    per instrument). Changing any of them in the settings is a new method
 *    and ends a sample in progress (rule 1), whether or not an alert was
 *    shown under the new one: the first day recorded under it is enough. An
 *    instrument's record is keyed by the shared parts and ITS OWN feed and
 *    costs (keyFor), so gold's commission or GBP/USD changing does not end a
 *    sample of bitcoin alone. The broker's server offset is not part of the
 *    method: it can only make a read "market closed", and a day is recorded
 *    only when every read of it falls inside the broker's session under the
 *    configured offset (canonicalAlerts), so on a recorded day no offset can
 *    change a read — correcting it in the clocks-change week (SKILL.md)
 *    does not end a sample (re-check, 17 Oct).
 *  - WHAT THE USER WAS SHOWN (`shown`, and their `ticketed`, `taken`, `actual`).
 *    The watcher's and a scan's alerts, as sent, linked to the method's record
 *    by the same natural id. They are never the sample. A method alert with no
 *    shown event is one the user did not see — never "a missed trade".
 *
 * How it is stored, and why that way:
 *  - AN APPEND-ONLY LOG OF EVENTS (JSON Lines), folded into entries. Folding
 *    does not depend on the order of the lines: git's union merge and a pull
 *    with rebase both put the other side's lines after this side's, so "last
 *    line wins" would let a merge change history. Which event stands is
 *    decided by its own fields (see fold()).
 *  - A NATURAL ID, `${pair}-${tf}-${barCloseMs}`. The timeframe is in it because
 *    10:15 closes an M5 bar and an M15 bar alike.
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
 * free text from the user or a screenshot. Feature names must be on the list
 * desk/features.mjs exports, handed in with setFeatureNames(). An event from a
 * live account is refused until the user has said yes to a live record in a
 * public repository — checked where every write passes, appendEvents().
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
 * DECLARED ADDITIONS TO RULE 5 (two cases its three forms do not cover; to be
 * recorded as a HANDOFF decision at integration):
 *  - "…touched its stop and its target in the same bar, so it counts as half
 *    of each (+0.14)": the plan scores such a bar as half of each (Part 3),
 *    and calling it a stop or a target would misstate the score;
 *  - "…has not finished yet": an alert whose window is still open, or whose
 *    bars are not in, has no outcome to say.
 * A result across a gap in the feed adds a clause to one of the forms rather
 * than a new form.
 *
 * DECLARED RULES (the rules that decide the verdict, fixed before the first
 * alert is recorded; to be written into LEARNING-PLAN.md Part 3 and a HANDOFF
 * decision at integration, with the API notes at the end):
 *  - MIN_PLANNED_ALERTS = 100: no sample is committed below 100 alerts
 *    (DEFAULT_PLANNED_ALERTS = 190, the plan's size).
 *  - MIN_VERDICT_DAYS = 30: no verdict until the judged alerts span 30
 *    London days; if the first N span fewer, the judged set runs on to the
 *    END of the 30th distinct day, every alert of it — a rule on dates alone.
 *  - Outcomes are said in rule 5's three forms plus the two DECLARED
 *    ADDITIONS above ("counts as half of each", "has not finished yet").
 *  - Holed days: a day with any bar missing is held up to 48 h after its
 *    window closes (GAP_SETTLE_MS), then recorded as it stands; if a hole
 *    is of more than 4 bars it is flagged `gap` and its alerts are left out
 *    of the sample (so is any alert whose own trade spans a gap).
 *  - The sample ends ('method-changed') at the first day recorded (by its
 *    `at`, not its date), alert recorded or alert shown, after the
 *    commitment, under a different method key for one of its instruments:
 *    version, target rule, filter, timeframe, window, or that instrument's
 *    reference feed or costs. The server offset is not in the key; a day
 *    with a read outside the broker's session is never recorded instead.
 *    A verdict reached before the end is kept.
 *  - Contested days (two records of one day that differ in their alert ids,
 *    checksums or gap flag — a merge) withhold the verdict while any falls on
 *    or before the last judged alert; they are settled by hand.
 *  - Every weekday from the commitment to the last judged alert must be
 *    recorded for every instrument in the sample before a verdict.
 *  - API: setSample needs cfg (a method out of date with the settings is
 *    refused); canonicalAlerts' feedId is a SOURCE id (e.g.
 *    'binance-vision'), one of REFERENCE_FEEDS[pair].sources, never a
 *    fallback feed; run a pull before `journal update`, so that contested
 *    days stay rare. forPair and keyFor give one instrument's view of a
 *    method; a day held for the broker's session comes back pending with why
 *    'outside-session'. A scan's ideas are shown events of source 'scan'
 *    (the plan's "scan-extra"): never the sample, whether or not they would
 *    have passed shouldAlert, and outranked by the watcher's record of the
 *    same bar. A journal written before commit 9e5f123 must be discarded and
 *    recorded again, not read as the same method: sanitize now strips each
 *    line's server offset and the other instrument's costs, so its alerts no
 *    longer match their day records' checksums (none exists anywhere).
 *
 * What it is not. Not the user's MT5 history: an alert is scored on Binance's
 * or Twelve Data's bars whether or not it was taken. Not a verdict before the
 * committed number of alerts (decision 8). Not wired into the commands here —
 * desk.mjs calls these functions. It never looks at the held-back years
 * (rule 2): the method's record starts after 14 Oct 2026 20:45 UTC.
 *
 * Pure apart from the file functions (journalPath, readEvents, appendEvents);
 * bars are handed in, so it is tested without a network.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, statSync, linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveRead, shouldAlert, alertState, ideaRecord, inWatchHours, TARGET_RULE, CLOSED_BARS } from './live.mjs';
import { outcome } from './outcome.mjs';
import { clusteredByDay } from './stats.mjs';
import { costFor, label, serverOffsetFor } from './lib.mjs';
import { windowState, localDate } from '../src/sessions.js';
import { tfInfo } from '../src/timeframes.js';
import { formatHM, zonedTimeToUtc } from '../src/timezone.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { BTC_SOURCES, XAU_SOURCES } from '../src/data-feeds.js';
import { marketOpenNow } from '../src/shot.js';
import { gapsIn, gapInWindow } from './history.mjs';

/* ---------------------------------------------------------------- vocabulary */

export const TYPES = Object.freeze(['alert', 'day', 'shown', 'resolved', 'ticketed', 'taken', 'actual', 'sample', 'consent']);
export const ACCOUNT_MODES = Object.freeze(['demo', 'live']);
export const PAIRS = Object.freeze(['XAUUSD', 'BTCUSD']);

/**
 * Where a shown alert came from: the watcher, as sent; or a one-off scan
 * (which skips shouldAlert). Neither decides the sample.
 */
export const SOURCES = Object.freeze(['watch', 'scan']);

/**
 * The feeds the method's record is read on. One per instrument, so the record
 * does not change with whichever fallback the watcher reached that minute.
 * The ids name the series, not the host; `sources` are the ids of the feeds
 * that serve that series, as history.mjs (HISTORY_FEEDS) and
 * src/data-feeds.js name them — data-api.binance.vision ('binance-vision') and
 * the main Binance API ('binance') serve the same BTCUSDT candles. Bars from
 * any other source (coinbase, kraken, paxg-kraken, ...) are a fallback and
 * are refused for the record. The record's lines carry the series id, so
 * two machines on different hosts of one series write the same line.
 */
export const REFERENCE_FEEDS = Object.freeze({
  BTCUSD: Object.freeze({ id: 'binance-btcusdt', label: 'Binance (BTCUSDT)', sources: Object.freeze(['binance-vision', 'binance']) }),
  XAUUSD: Object.freeze({ id: 'twelvedata-xauusd', label: 'Twelve Data (XAU/USD)', sources: Object.freeze(['twelvedata']) }),
});

/** How long after a day's window closes a day whose bars have a hole is held, waiting for the feed to fill it. */
export const GAP_SETTLE_MS = 48 * 3600e3;

/**
 * Every feed an event may name: the reference feeds and the live desk's
 * sources (src/data-feeds.js). A feed is a name from this list, never free
 * text, so nothing else can ride in on it.
 */
export const KNOWN_FEEDS = Object.freeze([...Object.values(REFERENCE_FEEDS), ...BTC_SOURCES, ...XAU_SOURCES]
  .map(({ id, label: name }) => Object.freeze({ id, label: name })));
const FEED_IDS = new Set(KNOWN_FEEDS.map((f) => f.id));
const FEED_LABELS = new Set(KNOWN_FEEDS.map((f) => f.label));

/**
 * The held-back window (rule 2), fixed. 2025 is clean; 2026 to the end was
 * seen while choosing the 1.5R rule. The journal's own record is "fresh":
 * after the end, and nothing here reads or scores a day inside it.
 */
export const HOLDOUT = Object.freeze({ fromMs: Date.UTC(2025, 0, 1), toMs: Date.UTC(2026, 9, 14, 20, 45) });

/** Days are counted, clustered and named in London, whatever the window's zone. */
export const DAY_TZ = 'Europe/London';

/** How the user says a trade ended. A short list, so no free text is ever stored. */
export const ACTUAL_HOW = Object.freeze(['target', 'stop', 'by-hand', 'end-of-session']);

/** How a trade was linked to an alert: the conversation named it, or a ticket was just built for it. */
export const TAKEN_HOW = Object.freeze(['named', 'ticket']);

/**
 * How long after a ticket "took it" still links to it: the ticket's own
 * freshness (decision 25) — 30 minutes on M15, 15 on M5.
 */
export const takenWithinMs = (tf) => tfInfo(tf).maxAgeMin * 60000;
export const TAKEN_WITHIN_MS = takenWithinMs('M15');

/**
 * The committed sample's size, declared before any live alert is seen
 * (LEARNING-PLAN.md Part 3): detecting +0.2R per alert, 5% one-sided, 80%
 * power, at sd ≈1.10R, clustered by day, needs about 190.
 */
export const DEFAULT_PLANNED_ALERTS = 190;

/**
 * Below this a "sample" cannot detect anything the plan cares about, and a
 * smaller N invites committing to a short run and calling it.
 */
export const MIN_PLANNED_ALERTS = 100;

/**
 * Alerts on the same day share one market, so the range is clustered by day.
 * With few days the clustered error is far too small (with one day it is
 * exactly zero, and any positive mean would read as an edge). So no verdict
 * until the judged alerts span this many days.
 *
 * Declared before any alert: if the first N alerts span fewer than 30 London
 * days, the judged set runs on to the END of the 30th distinct London day —
 * every alert of that day, so the last day's cluster is whole. It is a rule
 * on dates alone, never on results (sampleStatus).
 */
export const MIN_VERDICT_DAYS = 30;

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
 * `spreadNum` and `commNum` are distances in price units (what the alert was
 * costed with), not money. `features` is a flat object of numbers or
 * true/false under names from features.mjs — on the method's alerts (read on
 * the reference feed) and on what the user was shown (read on the live feed
 * the alert came from); `filter` is the learner's keep/remove call; neither
 * can carry text. `account` sits only on what the
 * user was shown and did — the method's record belongs to no account.
 */
const LEVELS = ['pair', 'tf', 'method', 'barCloseMs', 'validUntilMs', 'side', 'feed', 'feedId',
  'refPrice', 'stopDist', 'tp1Dist', 'tp2Dist', 'spreadNum', 'commNum', 'netR', 'confidence', 'reasons', 'against'];
export const ALLOWED = Object.freeze({
  common: Object.freeze(['type', 'id', 'at']),
  alert: Object.freeze([...LEVELS, 'features', 'filter', 'outcome']),
  day: Object.freeze(['pair', 'tf', 'method', 'day', 'alerts', 'ids', 'sums', 'kinds', 'gap']),
  shown: Object.freeze(['account', 'source', ...LEVELS, 'features']),
  resolved: Object.freeze(['account', 'r', 'how', 'bars', 'mfe', 'mae', 'bothTouched', 'scoring', 'gap', 'feed', 'spreadNum']),
  ticketed: Object.freeze(['account', 'userPrice', 'stopLoss', 'takeProfit']),
  taken: Object.freeze(['account', 'how']),
  actual: Object.freeze(['account', 'r', 'how']),
  sample: Object.freeze(['plannedAlerts', 'method', 'pairs', 'committedAt', 'replaces']),
  consent: Object.freeze(['answer']),
  outcome: Object.freeze(['r', 'how', 'bars', 'mfe', 'mae', 'bothTouched', 'scoring', 'gap']),
  kinds: Object.freeze(['idea', 'rejected', 'none', 'blocked', 'stale', 'no-data']),
  method: Object.freeze(['version', 'targetRule', 'filter', 'tf', 'feeds', 'window', 'costs']),
  window: Object.freeze(['open', 'close', 'tz']),
  costs: Object.freeze(['spread', 'comm']),
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
 * A feature name containing one of these is refused even if it is on the
 * injected list: they can only mean the account. ("lot", "risk" and "loss"
 * are left out — they sit inside honest market words like "slot".)
 */
const FEATURE_ROOTS = ['balance', 'equity', 'pnl', 'gbp', 'money', 'account', 'login', 'password', 'email', 'phone', 'profit'];

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const FORBIDDEN_SET = new Set(FORBIDDEN);
const MAX_TEXT = 300;
/*
 * Engine text never holds a pound or euro sign, a currency sign or an ISO
 * currency code next to a number (before or after it: "$400", "400$"), a
 * money word after a number ("400 pounds", "50 quid", "20 bucks"), the word
 * balance or equity within about 15 characters of a number, a word that names
 * an account or a phone (login, account, password, phone, mobile, call, ...)
 * within about 15 characters of a number ("login: 123456.78" — even one
 * written like a price), an email address (an @ of any width, or spelt out:
 * "ben at example.com", "ben [at] example [dot] com"), or seven or more
 * digits in a run.
 *
 * The text is NFKC-normalised first, so fullwidth digits and signs count as
 * their plain forms ("０７７００"); a digit is any \p{Nd}. Every run of
 * whitespace counts as one space ("07700    900123", tabs too: the re-check
 * of 17 Oct found 4 spaces slipped past), then up to three characters that
 * are not letters between two digits do not break a run ("07700/900123",
 * "077 00  900 123", "(07700) 900123", "07700:900:123", "07700;900123",
 * "07700|900123"), and a letter O between digits is read as a zero
 * ("07700 9OO123").
 *
 * Prices are the one exemption: the engine writes them with two decimals
 * ("84250.00", "84,399.55", "4375.20", a gap "84250.00-84300.00"), never more
 * than six digits before the point. Such a price is set aside before the
 * digit run is looked for — but only when it stands alone, so "5123.4567.89",
 * "5123-4567.89", "077 4375.20" or "51234567.89" is still a run. (The engine's
 * own text — EMA stacks such as "9 < 21 < 50", RSI and ADX readings, bar
 * counts — passes; the suite checks every read it makes.)
 */
const JOIN = '[.,\\-/_\\u2013\\u2014]';
const AT_WORD = '(?:\\s*[(\\[{]\\s*at\\s*[)\\]}]\\s*|\\s+at\\s+)';
const DOT_WORD = '(?:\\.|\\s*[(\\[{]\\s*dot\\s*[)\\]}]\\s*|\\s+dot\\s+)';
const SPELT_EMAIL = new RegExp(`\\b[a-z0-9._%+-]+${AT_WORD}[a-z0-9-]+(?:${DOT_WORD}[a-z0-9-]+)*${DOT_WORD}[a-z]{2,}\\b`, 'i');
const MONEY_TEXT = /£|€|[@＠﹫]|[$¥]\s?\d|\d\s?[$¥]|\d\s*(?:pounds?|quid|dollars?|bucks?|euros?)\b/i;
const CODES = '(?:USDT|USD|GBP|EUR|JPY|CHF|AUD|CAD|NZD|GBX)';
const CURRENCY_NUMBER = new RegExp(`(?<![A-Za-z/])${CODES}\\s?[\\d.,]*\\d|\\d\\s?${CODES}(?![A-Za-z])`, 'i');
const BALANCE_NUMBER = /\b(?:balance|equity)\b[^\d\n]{0,15}\d|\d[^\d\n]{0,15}\b(?:balance|equity)\b/i;
const ID_WORDS = '(?:login|log-?in|account|acct|a/c|password|passcode|passwd|phone|mobile|tel|telephone|whatsapp|sms|call|ring|text me)';
const ID_NUMBER = new RegExp(`(?<![A-Za-z])${ID_WORDS}(?![A-Za-z])[^\\d\\n]{0,15}\\d`, 'i');
const NOT_LETTER = '[^\\p{L}\\p{Nd}]';
const PRICE_P = '(?:\\d{1,3},\\d{3}|\\d{1,6})\\.\\d{1,2}';
const PRICE = new RegExp(`(?<![\\d.,/_\\u2013\\u2014]|\\d[-\\s])${PRICE_P}(?:-${PRICE_P})?(?!\\d|${JOIN}\\d|\\s+\\d)`, 'g');
const O_DIGIT = new RegExp(`(?<=\\p{Nd}${NOT_LETTER}{0,3})[Oo]+(?=${NOT_LETTER}{0,3}\\p{Nd})`, 'gu');
const DIGIT_RUN = new RegExp(`\\p{Nd}(?:${NOT_LETTER}{0,3}\\p{Nd}){6,}`, 'u');
export function sensitiveText(raw) {
  const s = String(raw).normalize('NFKC');
  if (MONEY_TEXT.test(s) || SPELT_EMAIL.test(s) || CURRENCY_NUMBER.test(s) || BALANCE_NUMBER.test(s) || ID_NUMBER.test(s)) return true;
  const digits = s.replace(/\s+/gu, ' ').replace(O_DIGIT, (o) => '0'.repeat(o.length));
  return DIGIT_RUN.test(digits.replace(PRICE, ' '));
}
const TOKEN = /^[A-Za-z0-9._-]{1,40}$/;

// Fields checked by their exact shape instead of as text: ids hold a bar time
// (a 13-digit number) and a day is YYYY-MM-DD.
const SHAPED = /^(?:id|day|ids\[\d+\])$/;

function forbiddenWalk(value, path, inFeatures = false) {
  if (Array.isArray(value)) { value.forEach((v, i) => forbiddenWalk(v, `${path}[${i}]`, inFeatures)); return; }
  if (typeof value === 'string') {
    if (!SHAPED.test(path) && sensitiveText(value)) throw new Error(`journal: ${path} holds a money amount, an email address or a long number, which may not be stored`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const n = norm(k);
    // Inside `features` "volume" is the market's traded volume, not the user's position.
    if (FORBIDDEN_SET.has(n) && !(inFeatures && (n === 'volume' || n === 'volumes'))) {
      throw new Error(`journal: "${k}" may not be stored (the repository is public)`);
    }
    forbiddenWalk(v, path ? `${path}.${k}` : k, inFeatures || (path === '' && k === 'features'));
  }
}

let featureNames = null;
/**
 * The feature names an alert may carry: desk/features.mjs FEATURE_NAMES,
 * handed in by the caller (this module does not import features.mjs, so the
 * two can be built and tested apart). Until it is called, an alert with
 * features is refused rather than trusted.
 */
export function setFeatureNames(names) {
  if (names === null) { featureNames = null; return; }
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(n))) {
    throw new Error('journal: feature names must be a list of plain names');
  }
  for (const n of names) {
    const k = norm(n);
    if ((FORBIDDEN_SET.has(k) && k !== 'volume' && k !== 'volumes') || FEATURE_ROOTS.some((r) => k.includes(r))) {
      throw new Error(`journal: "${n}" can only describe the account, not the market`);
    }
  }
  featureNames = new Set(names);
}

const fail = (msg) => { throw new Error(`journal: ${msg}`); };
const num = (x, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${what} must be a number`);
  return x;
};
/*
 * A number in a plausible band for its field, so a number field cannot carry
 * a phone, account or balance figure the text filter would have caught
 * (re-check, 17 Oct). `int` also refuses a fraction.
 */
const within = (x, what, lo, hi, { int = false } = {}) => {
  const v = num(x, what);
  if (v === null) return null;
  if (v < lo || v > hi || (int && !Number.isInteger(v))) fail(`${what} must be ${int ? 'a whole number ' : ''}from ${lo} to ${hi}`);
  return v;
};
/** Milliseconds since 1970 as thirteen digits (2001 to 2286): every bar time and commitment. */
const epochMs = (x, what) => within(x, what, 1e12, 1e13 - 1, { int: true });
/** A price of either instrument: above zero, at most six digits before the point. */
const price = (x, what) => { const v = within(x, what, 0, 999999.99); if (v !== null && !(v > 0)) fail(`${what} must be above zero`); return v; };
const R_MAX = 50;
const oneOf = (x, list, what) => {
  if (x === null || x === undefined) return null;
  if (!list.includes(x)) fail(`${what} must be one of ${list.join(', ')}`);
  return x;
};
const token = (x, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string' || !TOKEN.test(x)) fail(`${what} must be a short name (letters, digits, . _ -)`);
  return x;
};
const shortText = (x, max, what) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string') fail(`${what} must be text`);
  return x.slice(0, max);
};
const tfField = (x) => {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string' || !/^[MH]\d{1,3}$/.test(x)) fail('tf must look like M15');
  return x;
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/;
function cleanWindow(w) {
  if (w === null || w === undefined) return null;
  if (typeof w !== 'object' || Array.isArray(w)) fail('method.window must be an object');
  if (!HM.test(w.open) || !HM.test(w.close)) fail('method.window needs open and close as HH:MM');
  if (typeof w.tz !== 'string' || !TZ.test(w.tz)) fail('method.window needs a time zone name');
  return { open: w.open, close: w.close, tz: w.tz };
}
/*
 * Costs per instrument. A method from the settings (methodOf) holds both; a
 * line of the method's record holds only its own instrument's (forPair), so a
 * change to the other instrument's costs is not a change to its record.
 */
function cleanCosts(c) {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'object' || Array.isArray(c)) fail('method.costs must be an object');
  const out = {};
  for (const p of PAIRS) {
    const x = c[p];
    if (x === null || x === undefined) continue;
    if (typeof x !== 'object') fail(`method.costs.${p} must be an object`);
    out[p] = { spread: within(x.spread, `method.costs.${p}.spread`, 0, 1e4), comm: within(x.comm, `method.costs.${p}.comm`, 0, 1e4) };
    if (out[p].spread === null || out[p].comm === null) fail(`method.costs.${p} must be two distances of zero or more`);
  }
  if (!Object.keys(out).length) fail(`method.costs needs at least one of ${PAIRS.join(', ')}`);
  return out;
}

function cleanMethod(m) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object' || Array.isArray(m)) fail('method must be an object');
  const feeds = {};
  for (const p of PAIRS) feeds[p] = token((m.feeds && m.feeds[p]) ?? REFERENCE_FEEDS[p].id, `method.feeds.${p}`);
  return {
    version: token(m.version === null || m.version === undefined ? null : String(m.version), 'method.version'),
    targetRule: token(m.targetRule ?? null, 'method.targetRule'),
    filter: token(m.filter ?? 'none', 'method.filter'),
    tf: tfField(m.tf ?? null),
    feeds,
    window: cleanWindow(m.window),
    costs: cleanCosts(m.costs),
  };
}

function cleanFeatures(f, { read = false } = {}) {
  if (f === null || f === undefined) return null;
  if (typeof f !== 'object' || Array.isArray(f)) fail('features must be an object');
  if (!read && !featureNames && Object.keys(f).length) fail('feature names are not set (setFeatureNames), so features cannot be checked');
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(k)) fail(`feature name "${k}" is not allowed`);
    if (!read && !featureNames.has(k)) fail(`feature "${k}" is not on the features list`);
    if (typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = num(v, `features.${k}`);
  }
  return out;
}

function cleanFilter(f) {
  if (f === null || f === undefined) return null;
  if (typeof f !== 'object' || Array.isArray(f)) fail('filter must be an object');
  return { id: token(f.id ?? null, 'filter.id'), keep: typeof f.keep === 'boolean' ? f.keep : null, predicted: within(f.predicted ?? null, 'filter.predicted', -1e3, 1e3) };
}

/*
 * How an alert ended: its target, its stop, the window's close — or 'both',
 * which desk/outcome.mjs returns under bothTouched: 'half' for a bar touching
 * the stop and the target (scored half of each; said as such, see
 * DECLARED ADDITIONS TO RULE 5).
 */
const OUTCOME_HOW = ['target', 'stop', 'window', 'both'];
function cleanOutcome(o) {
  if (o === null || o === undefined) return null;
  if (typeof o !== 'object' || Array.isArray(o)) fail('outcome must be an object');
  return {
    r: within(o.r, 'outcome.r', -R_MAX, R_MAX), how: oneOf(o.how, OUTCOME_HOW, 'outcome.how'), bars: within(o.bars ?? null, 'outcome.bars', 0, 5000, { int: true }),
    mfe: within(o.mfe ?? null, 'outcome.mfe', 0, 1e3), mae: within(o.mae ?? null, 'outcome.mae', 0, 1e3),
    bothTouched: !!o.bothTouched, scoring: oneOf(o.scoring ?? 'half', ['half', 'stop'], 'outcome.scoring'), gap: !!o.gap,
  };
}

function cleanKinds(k) {
  if (k === null || k === undefined) return null;
  if (typeof k !== 'object' || Array.isArray(k)) fail('kinds must be an object');
  const out = {};
  for (const name of [...ALLOWED.kinds, 'gap']) if (k[name] !== undefined) out[name] = within(k[name], `kinds.${name}`, 0, 5000, { int: true });
  return out;
}

const textList = (xs, what) => {
  if (xs === null || xs === undefined) return [];
  if (!Array.isArray(xs)) fail(`${what} must be a list`);
  return xs.slice(0, 3).map((x, i) => shortText(String(x), MAX_TEXT, `${what}[${i}]`));
};

/** Per-field checks: each keeps the value in a known shape or throws. */
const FIELD = {
  id: (x) => { if (typeof x !== 'string' || !/^[A-Za-z0-9-]{1,60}$/.test(x)) fail('an id is letters, digits and dashes'); return x; },
  at: (x) => within(x, 'at', 0, 1e13 - 1, { int: true }),
  account: (x) => oneOf(x, ACCOUNT_MODES, 'account'),
  pair: (x) => oneOf(x, PAIRS, 'pair'),
  pairs: (x) => {
    if (!Array.isArray(x) || !x.length) fail('pairs must be a list of instruments');
    return [...new Set(x.map((p) => oneOf(p, PAIRS, 'pairs')))].sort();
  },
  tf: tfField,
  source: (x) => oneOf(x, SOURCES, 'source'),
  method: cleanMethod,
  barCloseMs: (x) => epochMs(x, 'barCloseMs'),
  validUntilMs: (x) => epochMs(x, 'validUntilMs'),
  side: (x) => oneOf(x, ['buy', 'sell'], 'side'),
  feed: (x) => { if (x === null || x === undefined) return null; if (!FEED_LABELS.has(x)) fail('feed must be the name of a known price feed'); return x; },
  feedId: (x) => { if (x === null || x === undefined) return null; if (!FEED_IDS.has(x)) fail('feedId must be a known price feed'); return x; },
  refPrice: (x) => price(x, 'refPrice'),
  stopDist: (x) => within(x, 'stopDist', 0, 1e5),
  tp1Dist: (x) => within(x, 'tp1Dist', 0, 1e5),
  tp2Dist: (x) => within(x, 'tp2Dist', 0, 1e5),
  spreadNum: (x) => within(x, 'spreadNum', 0, 1e4),
  commNum: (x) => within(x, 'commNum', 0, 1e4),
  netR: (x) => within(x, 'netR', -R_MAX, R_MAX),
  confidence: (x) => oneOf(x, ['high', 'moderate', 'low'], 'confidence'),
  reasons: (x) => textList(x, 'reasons'),
  against: (x) => textList(x, 'against'),
  filter: cleanFilter,
  outcome: cleanOutcome,
  day: (x) => { if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(x)) fail('day must be YYYY-MM-DD'); return x; },
  alerts: (x) => within(x, 'alerts', 0, 200, { int: true }),
  ids: (xs) => {
    if (!Array.isArray(xs) || xs.length > 200) fail('ids must be a list of alert ids');
    return xs.map((x) => { if (typeof x !== 'string' || !ALERT_ID.test(x)) fail('ids must be alert ids'); return x; });
  },
  sums: (xs) => {
    if (!Array.isArray(xs) || xs.length > 200) fail('sums must be a list of checksums');
    return xs.map((x) => { if (typeof x !== 'string' || !/^[a-p]{24}$/.test(x)) fail('a checksum is 24 letters a to p'); return x; });
  },
  kinds: cleanKinds,
  userPrice: (x) => price(x, 'userPrice'),
  stopLoss: (x) => price(x, 'stopLoss'),
  takeProfit: (x) => price(x, 'takeProfit'),
  r: (x) => within(x, 'r', -R_MAX, R_MAX),
  bars: (x) => within(x, 'bars', 0, 5000, { int: true }),
  mfe: (x) => within(x, 'mfe', 0, 1e3),
  mae: (x) => within(x, 'mae', 0, 1e3),
  bothTouched: (x) => (x === null || x === undefined ? null : !!x),
  gap: (x) => (x === null || x === undefined ? null : !!x),
  scoring: (x) => oneOf(x, ['half', 'stop'], 'scoring'),
  plannedAlerts: (x) => within(x, 'plannedAlerts', 1, 10000, { int: true }),
  committedAt: (x) => epochMs(x, 'committedAt'),
  replaces: (x) => oneOf(x, ['method-changed'], 'replaces'),
  answer: (x) => oneOf(x, ['yes', 'no'], 'answer'),
};
// `how` means different things on different events, each from a short list.
const HOW = { taken: TAKEN_HOW, actual: ACTUAL_HOW, resolved: OUTCOME_HOW };

/** The natural id of one bar's alert. */
export const idOf = (pair, tf, barCloseMs) => `${pair}-${tf}-${barCloseMs}`;
/* An alert id's bar time is milliseconds since 1970: thirteen digits from 2001 to 2286. */
const ALERT_ID = /^(XAUUSD|BTCUSD)-[MH]\d{1,3}-\d{13}$/;
const dayIdOf = (pair, tf, day) => `${pair}-${tf}-${day}`;
/** The settings' window shape ({start, end, tz}) from a method's ({open, close, tz}). */
const winOf = (mw) => ({ start: { h: +mw.open.slice(0, 2), m: +mw.open.slice(3) }, end: { h: +mw.close.slice(0, 2), m: +mw.close.slice(3) }, tz: mw.tz });
/** windowState for a London day (YYYY-MM-DD), read at its noon in London, as canonicalAlerts reads it. */
const dayWindow = (day, mw) => {
  const [y, mo, d] = day.split('-').map(Number);
  return windowState(zonedTimeToUtc(y, mo, d, 12, 0, DAY_TZ), mw.start ? mw : winOf(mw));
};
export const sampleIdOf = (committedAt) => `sample-${committedAt}`;
export const CONSENT_ID = 'live-record';

/*
 * What each type must carry, so a half-written or hand-edited line cannot fold
 * into an entry with no pair, side or bar (review, 16 Oct).
 */
function required(e) {
  const need = (cond, what) => { if (!cond) fail(`a ${e.type} event needs ${what}`); };
  const refuse = (cond, what) => { if (cond) fail(`a ${e.type} event ${what}`); };
  need(Number.isFinite(e.at), 'its time (at)');
  const fullMethod = (m, pairs) => m && m.version && m.window && m.costs && Array.isArray(pairs) && pairs.every((p) => m.costs[p]);
  // The method's record, and what the user was shown, start after the held-back years (rule 2).
  const heldBack = (ms) => refuse(!(ms > HOLDOUT.toMs), `is dated inside the held-back years (rule 2); the journal starts after ${new Date(HOLDOUT.toMs).toISOString()}`);
  const levels = () => {
    need(e.pair && e.tf && e.side && Number.isFinite(e.barCloseMs), 'pair, tf, side and barCloseMs');
    need(e.stopDist > 0 && e.tp1Dist > 0, 'a stop and a target distance');
    need(fullMethod(e.method, [e.pair]) && e.method.tf === e.tf, 'its method, with a version, window, its instrument\'s costs and the same timeframe');
    need(e.barCloseMs % (tfInfo(e.tf).minutes * 60000) === 0, 'a bar close on its timeframe\'s grid');
    need(e.id === idOf(e.pair, e.tf, e.barCloseMs), `the id ${idOf(e.pair, e.tf, e.barCloseMs)}`);
    need(Number.isFinite(e.at) && e.at >= 1e12, 'its time (at) in milliseconds');
    heldBack(e.barCloseMs);
  };
  if (e.type === 'alert') { levels(); need(e.outcome && Number.isFinite(e.outcome.r) && e.outcome.how, 'its outcome'); }
  if (e.type === 'shown') { levels(); need(e.source && e.account && e.feedId, 'its source, account mode and feed'); }
  if (e.type === 'day') {
    need(e.pair && e.tf && e.day && Number.isFinite(e.alerts), 'pair, tf, day and alerts');
    need(fullMethod(e.method, [e.pair]) && e.method.tf === e.tf, 'its method');
    need(e.id === dayIdOf(e.pair, e.tf, e.day), 'the day id');
    // A day lists the alerts it found, so the record can be frozen (foldCanonical).
    need(Array.isArray(e.ids) && Array.isArray(e.sums) && e.ids.length === e.alerts && e.sums.length === e.alerts, 'the ids and checksums of its alerts');
    need(e.ids.every((id) => id.startsWith(`${e.pair}-${e.tf}-`) && dayOf(Number(id.slice(id.lastIndexOf('-') + 1))) === e.day), 'ids of its own pair, timeframe and day');
    const w = dayWindow(e.day, e.method.window);
    heldBack(w.opensAtMs);
    // A day is recorded only once its window has closed: an earlier `at` is a
    // wrong clock or a hand edit, and would otherwise win as the earliest record.
    refuse(!(e.at >= w.closesAtMs), `is dated before ${e.day}'s window closed (${new Date(w.closesAtMs).toISOString()}), so it cannot be a record of that day`);
  }
  if (['resolved', 'ticketed', 'taken', 'actual'].includes(e.type)) {
    need(e.account, 'the account mode of the alert it belongs to');
    need(ALERT_ID.test(e.id), 'an alert id (pair, timeframe and a 13-digit bar close)');
  }
  if (e.type === 'resolved' || e.type === 'actual') need(Number.isFinite(e.r) && e.how, 'r and how');
  if (e.type === 'taken') need(e.how, 'how it was linked');
  if (e.type === 'ticketed') need(Number.isFinite(e.userPrice), 'the user\'s price');
  if (e.type === 'sample') {
    need(Number.isInteger(e.plannedAlerts) && fullMethod(e.method, e.pairs) && e.method.tf && e.pairs && Number.isFinite(e.committedAt), 'plannedAlerts, method, pairs and committedAt');
    need(e.id === sampleIdOf(e.committedAt), 'the sample id');
  }
  if (e.type === 'consent') need(e.answer && e.id === CONSENT_ID, `an answer and the id "${CONSENT_ID}"`);
}

/**
 * The only way an event reaches the file. Returns a new object holding only
 * the allowed fields for its type; throws on a forbidden key or sensitive text
 * anywhere in it, on an unknown type, on a field of the wrong shape, or on a
 * missing required field. `read: true` is for lines already in the file: the
 * feature names are not checked against the list then (the reader may not
 * have set it), only their shape.
 */
export function sanitize(event, { read = false } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('an event must be an object');
  forbiddenWalk(event, '');
  if (!TYPES.includes(event.type)) fail(`unknown event type "${event.type}"`);
  if (typeof event.id !== 'string' || !event.id) fail('an event needs an id');
  const out = {};
  for (const k of [...ALLOWED.common, ...ALLOWED[event.type]]) {
    if (!(k in event) || event[k] === undefined) continue;
    if (k === 'type') { out.type = event.type; continue; }
    if (k === 'how') out.how = oneOf(event.how, HOW[event.type], `${event.type}.how`);
    else if (k === 'features') out.features = cleanFeatures(event.features, { read });
    else out[k] = FIELD[k](event[k]);
  }
  required(out);
  // A line of one instrument carries only that instrument's feed and costs
  // (forPair), so two writers whose settings differ only for the other
  // instrument write the same line.
  if (['alert', 'day', 'shown'].includes(out.type)) out.method = forPair(out.method, out.pair);
  return out;
}

/* ------------------------------------------------------------------- storage */

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url));

/** Where the journal lives: $SCALP_DESK_JOURNAL, or journal.jsonl beside the config. */
export function journalPath({ env = process.env, configPath = env.SCALP_DESK_CONFIG || DEFAULT_CONFIG_PATH } = {}) {
  return env.SCALP_DESK_JOURNAL || join(dirname(configPath), 'journal.jsonl');
}

/**
 * Every valid event in the file, in file order. A line that does not parse (a
 * torn write), is not an object, or fails sanitize (a bad hand edit or merge)
 * is skipped, so one bad line never stops the rest from being read.
 */
export function readEvents(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(sanitize(JSON.parse(line), { read: true })); } catch { /* skip it */ }
  }
  return out;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/*
 * A lock older than `staleMs` belongs to a command that died mid-write. It is
 * moved aside with an atomic rename (only one waiter's rename can succeed),
 * and if what was moved turns out to be fresh — another writer took the lock
 * between our look and our rename — it is linked back.
 */
function takeOverStale(lock, staleMs) {
  let st;
  try { st = statSync(lock); } catch { return true; }
  if (Date.now() - st.mtimeMs <= staleMs) return false;
  const aside = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try { renameSync(lock, aside); } catch { return true; }
  try {
    if (Date.now() - statSync(aside).mtimeMs <= staleMs) { try { linkSync(aside, lock); } catch { /* a new lock exists: leave it */ } }
  } finally { try { unlinkSync(aside); } catch { /* gone */ } }
  return true;
}

/** Hold `${path}.lock` while `fn` runs; release it only if it is still ours. */
function withLock(path, fn, { timeoutMs = 5000, staleMs = 10000 } = {}) {
  const lock = `${path}.lock`;
  const mine = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { writeFileSync(lock, mine, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (takeOverStale(lock, staleMs)) continue;
      if (Date.now() > until) fail('another command is writing the journal; try again in a moment');
      sleepMs(5 + Math.floor(Math.random() * 10));
    }
  }
  try { return fn(); } finally {
    try { if (readFileSync(lock, 'utf8') === mine) unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Thrown when a live-account event would be written before the user said yes (rule 6). */
export class LiveConsentError extends Error {
  constructor(answer, events) {
    super(answer === 'no'
      ? 'journal: the user said no to a live-account record in the public repository, so live events are not written'
      : 'journal: ask the user first whether a live-account record may sit in a public repository (needsLiveConsent)');
    this.code = answer === 'no' ? 'live-refused' : 'live-consent-needed';
    this.events = events;
  }
}

const json = (e) => JSON.stringify(e);
const sameKey = (e) => (e.type === 'alert' || e.type === 'day' ? `${e.type}|${e.id}|${keyFor(e.method, e.pair)}` : null);

/**
 * Add events to the journal. Each is sanitised first (nothing is written if
 * any one is refused). Then, under the lock, the file is re-read and:
 *  - a live-account event is refused unless the user has said yes
 *    (LiveConsentError; or, with `liveWithoutConsent: 'hold'`, those events
 *    are left out and returned as `held` — for the silent writers);
 *  - a line already in the file is not written again;
 *  - the method's record is written once per id and method (a second
 *    computation of the same bar adds nothing), and a day already recorded
 *    is frozen: a second day record for it, or an alert on it that is not
 *    already in the file, is not written (foldCanonical would ignore them);
 *  - a shown alert is written once per id, except that the watcher's record
 *    replaces a scan's (the watcher's is "as sent").
 * Returns { added: [events written], skipped: number, held: [events] }.
 */
export function appendEvents(path, events, { liveWithoutConsent = 'throw', ...lockOpts } = {}) {
  const clean = (events || []).map((e) => sanitize(e));
  if (!clean.length) return { added: [], skipped: 0, held: [] };
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const existing = readEvents(path);
    const lines = new Set(existing.map(json));
    const keys = new Set(existing.map(sameKey).filter(Boolean));
    const shownBy = new Map(existing.filter((e) => e.type === 'shown').map((e) => [e.id, e]));
    const frozen = new Set(existing.filter((e) => e.type === 'day').map((e) => `${keyFor(e.method, e.pair)}|${e.id}`));
    const frozenDay = (e) => e.type === 'alert' && frozen.has(`${keyFor(e.method, e.pair)}|${dayIdOf(e.pair, e.tf, dayOf(e.barCloseMs))}`);
    const consent = foldConsent([...existing, ...clean.filter((e) => e.type === 'consent')]);
    const added = [], held = [];
    const live = clean.filter((e) => e.account === 'live');
    if (live.length && consent !== 'yes' && liveWithoutConsent !== 'hold') throw new LiveConsentError(consent, live);
    for (const e of clean) {
      if (e.account === 'live' && consent !== 'yes') { held.push(e); continue; }
      const line = json(e), key = sameKey(e);
      if (lines.has(line) || (key && keys.has(key)) || frozenDay(e)) continue;
      if (e.type === 'shown') {
        const prev = shownBy.get(e.id);
        if (prev && SHOWN_RANK[prev.source] <= SHOWN_RANK[e.source]) continue;
        shownBy.set(e.id, e);
      }
      lines.add(line);
      if (key) keys.add(key);
      added.push(e);
    }
    if (added.length) {
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      const head = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
      writeFileSync(tmp, head + added.map(json).join('\n') + '\n');
      renameSync(tmp, path);
    }
    return { added, skipped: clean.length - added.length - held.length, held };
  }, lockOpts);
}

/* --------------------------------------------------------------------- fold */

/*
 * Which of two events of the same kind stands, decided by the events alone so
 * that the order of the lines never matters:
 *  - the method's record, a shown alert, a sample: the EARLIEST stands (it is
 *    what was known or sent at the time); for shown alerts the watcher's
 *    record outranks a scan's first.
 *  - the user's ticket, link, result, consent and a shown alert's resolution:
 *    the LATEST stands (a correction replaces what it corrects).
 * Ties fall to the text of the line, so identical sets of lines fold the same.
 */
const SHOWN_RANK = { watch: 0, scan: 1 };
const earlier = (a, b) => a.at < b.at || (a.at === b.at && json(a) <= json(b));
const firstOf = (a, b) => (!a ? b : earlier(a, b) ? a : b);
const lastOf = (a, b) => (!a ? b : earlier(a, b) ? b : a);
const shownOf = (a, b) => {
  if (!a) return b;
  if (SHOWN_RANK[a.source] !== SHOWN_RANK[b.source]) return SHOWN_RANK[a.source] < SHOWN_RANK[b.source] ? a : b;
  return firstOf(a, b);
};
const byClose = (a, b) => a.barCloseMs - b.barCloseMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const valid = (e) => e && typeof e === 'object' && typeof e.id === 'string' && TYPES.includes(e.type) && Number.isFinite(e.at);

/**
 * A canonical string for a method: version, target rule, filter, timeframe,
 * reference feeds, window and costs — the settings that can change what the
 * record holds. Two methods are the same only if every one of these is.
 *
 * The broker's server offset is NOT part of it. It reaches a read only
 * through gateFor's marketOpenNow, which can only stop a read as "closed";
 * canonicalAlerts records a day only when every read of it falls inside the
 * broker's session under the configured offset, so on any day it records the
 * offset cannot change a read (re-check, 17 Oct: offsets from −5 to +4 gave
 * the same alerts, R and kinds as 'auto'). Correcting it in the clocks-change
 * week therefore does not end a sample.
 */
export const methodKey = (m) => {
  const c = cleanMethod(m) || { version: null, targetRule: null, filter: 'none', tf: null, feeds: {}, window: null, costs: null };
  return JSON.stringify([c.version, c.targetRule, c.filter, c.tf,
    PAIRS.map((p) => `${p}:${c.feeds[p] ?? REFERENCE_FEEDS[p].id}`).join('|'),
    c.window ? `${c.window.open}-${c.window.close}@${c.window.tz}` : null,
    c.costs ? PAIRS.filter((p) => c.costs[p]).map((p) => `${p}:${c.costs[p].spread}/${c.costs[p].comm}`).join('|') : null]);
};

/**
 * The method as one instrument's record sees it: the shared parts, and only
 * that instrument's feed and costs. Alert and day lines carry this, and every
 * comparison of a line with a sample's method goes through keyFor, so a
 * change to gold's costs (its commission, or GBP/USD) does not end a sample
 * of bitcoin alone, whose record it cannot change (re-check, 17 Oct).
 */
export function forPair(m, pair) {
  const c = cleanMethod(m);
  if (!c) return null;
  // A method with no costs for this instrument matches no line of its record.
  return cleanMethod({ ...c, feeds: { [pair]: c.feeds[pair] }, costs: c.costs && c.costs[pair] ? { [pair]: c.costs[pair] } : null });
}
/** The key of a method for one instrument's record. */
export const keyFor = (m, pair) => methodKey(forPair(m, pair));

const hm = (t) => `${pad(t.h)}:${pad(t.m)}`;
/**
 * The settings a method is read and scored with: the window; and per
 * instrument the spread read with and the commission as a price distance.
 * (Not the broker's server offset: see methodKey.)
 */
function settingsOf(cfg) {
  if (!cfg || !cfg.window || !cfg.account) fail('a method needs the settings (cfg), for its window and costs');
  const w = cfg.window;
  const costs = {};
  // liveRead reads with the instrument's observed spread; costFor turns the
  // commission per side in pounds into a round-turn price distance.
  for (const p of PAIRS) costs[p] = { spread: INSTRUMENTS[p].typicalSpread.observed, comm: +costFor(p, 0, cfg).comm.toFixed(10) };
  return { window: { open: hm(w.start), close: hm(w.end), tz: w.tz }, costs };
}

/**
 * A full method description from its parts and the settings; the reference
 * feeds are filled in, and the window and costs are taken from `cfg`, so a
 * change to either in the settings is a different method (rule 1).
 * `version` is live.mjs METHOD_VERSION once it exists; it is required, so an
 * alert cannot silently carry a method that matches no sample.
 */
export function methodOf({ version, targetRule = TARGET_RULE, filter = 'none', tf, cfg } = {}) {
  const m = cleanMethod({ version, targetRule, filter, tf, ...settingsOf(cfg) });
  if (!m.version || !m.tf || !m.targetRule) fail('a method needs a version, a target rule and a timeframe');
  return m;
}

/** The method `m` would be under the settings `cfg`: its own version, rule, filter, timeframe and feeds, the settings' window and costs. */
const methodUnder = (m, cfg) => cleanMethod({ ...m, ...settingsOf(cfg) });

/** Whether the settings make a different method of `m` for any of `pairs` (only those instruments' records count). */
const settingsDiffer = (m, cfg, pairs) => { const u = methodUnder(m, cfg); return pairs.some((p) => keyFor(u, p) !== keyFor(m, p)); };

/** Refuse a method whose window or costs (for `pairs`) are not the settings' own (they changed: a new method). */
function sameSettings(m, cfg, what, pairs = PAIRS) {
  if (settingsDiffer(m, cfg, pairs)) fail(`${what}: the settings' window or costs differ from the method's, so this is a different method (rule 1)`);
}

/** A method handed in whole (with its window, and costs for each of `pairs`), checked. */
function checkedMethod(method, pairs = PAIRS) {
  const m = cleanMethod(method || {});
  if (!m.version || !m.tf || !m.targetRule) fail('a method needs a version, a target rule and a timeframe');
  if (!m.window || !m.costs || !pairs.every((p) => m.costs[p])) fail('a method needs its window and costs (methodOf with the settings)');
  return m;
}

/*
 * The checksum a day record keeps of each alert line: sha-256 of the line,
 * written as 24 letters a–p (no digits, so it can never look like a number).
 */
const sumOf = (e) => [...createHash('sha256').update(json(e)).digest().subarray(0, 12)]
  .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
/** The checksum a day record lists for one alert event (as sanitize() returns it). */
export const alertChecksum = (alertEvent) => sumOf(sanitize(alertEvent, { read: true }));

/**
 * The standing day record per method and day: the earliest recorded, ties by
 * the line's text. Map `${keyFor}|${dayId}` → record. With `method`, only
 * day records under that method for their own instrument.
 */
function standingDays(events, method = null) {
  const by = new Map();
  for (const e of events || []) {
    if (!valid(e) || e.type !== 'day') continue;
    const mk = keyFor(e.method, e.pair);
    if (method && mk !== keyFor(method, e.pair)) continue;
    by.set(`${mk}|${e.id}`, firstOf(by.get(`${mk}|${e.id}`), e));
  }
  return by;
}

/**
 * The method's record for one method: one alert per id, in bar-close order.
 * Only alerts named by their day's standing record (id and checksum) count,
 * so the record of a day is frozen once it is written: a later replay of the
 * day, or a union merge of two machines' replays, folds the same way.
 */
export function foldCanonical(events, method) {
  const named = new Map();
  for (const [k, d] of standingDays(events, method)) {
    const mk = k.slice(0, k.lastIndexOf('|'));
    d.ids.forEach((id, i) => named.set(`${mk}|${id}`, d.sums[i]));
  }
  const by = new Map();
  for (const e of events || []) {
    if (!valid(e) || e.type !== 'alert') continue;
    const mk = keyFor(e.method, e.pair);
    if (method && mk !== keyFor(method, e.pair)) continue;
    const want = named.get(`${mk}|${e.id}`);
    if (want === undefined || sumOf(e) !== want) continue;
    by.set(e.id, firstOf(by.get(e.id), e));
  }
  return [...by.values()].sort(byClose);
}

/** The method's standing day records for one method: Map dayId → record. */
export function foldDays(events, method) {
  const by = new Map();
  for (const d of standingDays(events, method).values()) by.set(d.id, firstOf(by.get(d.id), d));
  return by;
}

/** Every committed sample, oldest commitment first. */
export function foldSamples(events) {
  const by = new Map();
  for (const e of events || []) if (valid(e) && e.type === 'sample') by.set(e.id, firstOf(by.get(e.id), e));
  return [...by.values()].sort((a, b) => a.committedAt - b.committedAt)
    .map((s) => ({ id: s.id, plannedAlerts: s.plannedAlerts, method: s.method, pairs: s.pairs, committedAt: s.committedAt, replaces: s.replaces ?? null, at: s.at }));
}

/** The sample in force: the latest commitment, or null. */
export function foldSample(events) {
  const all = foldSamples(events);
  return all.length ? all[all.length - 1] : null;
}

/** The user's answer about a live record in a public repository: 'yes', 'no' or null (not asked). */
export function foldConsent(events) {
  let c = null;
  for (const e of events || []) if (valid(e) && e.type === 'consent' && e.id === CONSENT_ID) c = lastOf(c, e);
  return c ? c.answer : null;
}

/**
 * The entries, folded from the events: Map id → entry, in bar-close order.
 * An entry exists for an id with a method alert or a shown alert; events for
 * any other id are left out (their alert may arrive later in a merge).
 * `method` picks which method's record to attach; without it, any method's
 * (the earliest, if two methods alerted on one bar).
 *
 * entry = {
 *   id, pair, tf, barCloseMs, side,
 *   alert:   the method's alert event (with .outcome) | null — in the method's record
 *   shown:   the shown event {source, account, feed, levels...} | null — what the user was sent
 *   shownOutcome: {r, how, bars, mfe, mae, bothTouched, scoring, gap, feed, spreadNum, at} | null
 *   ticketed: {userPrice, stopLoss, takeProfit, at, account} | null,
 *   taken:    {how, at, account} | null,
 *   actual:   {r, how, at, account} | null,
 *   account:  the shown alert's account mode | null
 * }
 */
export function fold(events, { method = null } = {}) {
  const canon = new Map(foldCanonical(events, method).map((a) => [a.id, a]));
  const by = new Map();
  const slot = (id) => { if (!by.has(id)) by.set(id, {}); return by.get(id); };
  for (const e of events || []) {
    if (!valid(e)) continue;
    if (e.type === 'shown') slot(e.id).shown = shownOf(slot(e.id).shown, e);
    else if (['resolved', 'ticketed', 'taken', 'actual'].includes(e.type)) slot(e.id)[e.type] = lastOf(slot(e.id)[e.type], e);
  }
  const ids = new Set([...canon.keys(), ...[...by.entries()].filter(([, v]) => v.shown).map(([id]) => id)]);
  const pick = (e, keys) => (e ? Object.fromEntries([...keys.filter((k) => k !== 'account').map((k) => [k, e[k] ?? null]), ['at', e.at], ['account', e.account ?? null]]) : null);
  const out = [];
  for (const id of ids) {
    const a = canon.get(id) || null, v = by.get(id) || {}, s = v.shown || null;
    const base = a || s;
    out.push({
      id, pair: base.pair, tf: base.tf, barCloseMs: base.barCloseMs, side: base.side,
      alert: a, shown: s,
      shownOutcome: s ? pick(v.resolved, ALLOWED.resolved) : null,
      ticketed: pick(v.ticketed, ALLOWED.ticketed),
      taken: pick(v.taken, ALLOWED.taken),
      actual: pick(v.actual, ALLOWED.actual),
      account: s ? s.account : null,
    });
  }
  out.sort(byClose);
  return new Map(out.map((e) => [e.id, e]));
}

/** Entries from a fold() result, or from raw events. */
const entriesOf = (x) => (x instanceof Map ? [...x.values()] : [...fold(x || []).values()]);

/* ------------------------------------------------------- scoring on the feed */

/** What a target pays in R after costs, as desk/outcome.mjs computes it. */
function targetR(rec, spread, comm) {
  const buy = rec.side === 'buy';
  return ((buy ? rec.tp1Dist - spread : rec.tp1Dist) - comm) / ((buy ? rec.stopDist + spread : rec.stopDist) + comm);
}

/** Index of the bar opening at `t` (bars sorted by t), or −1. */
function indexOfOpen(bars, t) {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/**
 * One alert's result on a feed's CLOSED bars, or null while its window's bars
 * are not all in. Only bars inside the alert's own window are used: a gap in
 * the feed before the close must not let a stop or target on the next day's
 * bars score this alert. A bar touching both levels is scored as half of
 * each, (target R − 1) / 2 — the plan's rule for the journal; outcome() alone
 * counts it as the stop. `gap` is set when the bars from entry to exit are not
 * contiguous, or the window's last bars are missing; such a result is kept
 * but left out of the sample.
 */
function scoreOn(bars, rec, { spread, comm, closesAtMs, tfMs }) {
  const k = indexOfOpen(bars, rec.barCloseMs - tfMs);
  if (k < 0) return null;
  let end = k;
  while (end + 1 < bars.length && bars[end + 1].t + tfMs <= closesAtMs) end++;
  const inWin = bars.slice(0, end + 1);
  const opts = { spread, comm, closesAtMs, tfMinutes: tfMs / 60000, bothTouched: 'half' };
  let o = outcome(inWin, k, rec, opts), gap = false;
  if (!o) {
    if (end === bars.length - 1) return null;          // the feed has not reached the window's close yet
    gap = true;                                         // it has, but the window's last bars are missing
    o = end > k ? outcome(inWin, k, rec, { ...opts, closesAtMs: inWin[end].t + tfMs })
      : { r: (-spread - comm) / ((rec.side === 'buy' ? rec.stopDist + spread : rec.stopDist) + comm), how: 'window', bars: 0, bothTouched: false, mfe: 0, mae: 0 };
  }
  for (let j = k + 1; j <= k + o.bars; j++) if (inWin[j].t - inWin[j - 1].t !== tfMs) gap = true;
  // outcome.mjs with bothTouched: 'half' returns how 'both' and the half
  // already. An older one, without that option, returns the stop (−1) with
  // the flag; it is turned into the same half here.
  const old = o.bothTouched && o.how === 'stop' && o.r === -1;
  const r = old ? (targetR(rec, spread, comm) - 1) / 2 : o.r;
  const how = o.bothTouched ? 'both' : o.how;
  return { r: +r.toFixed(4), how, bars: o.bars, mfe: o.mfe, mae: o.mae, bothTouched: !!o.bothTouched, scoring: 'half', gap };
}

/* ------------------------------------------------------ the method's record */

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const { y, m, d } = localDate(ms, DAY_TZ); return `${y}-${pad(m)}-${pad(d)}`; };
const DAY_MS = 86400e3;
/** London calendar dates from `fromDay` to `toDay` inclusive, as YYYY-MM-DD, with their weekday (0 = Sunday). */
function* calendar(fromDay, toDay) {
  const [y, m, d] = fromDay.split('-').map(Number);
  for (let t = Date.UTC(y, m - 1, d); ; t += DAY_MS) {
    const s = new Date(t).toISOString().slice(0, 10);
    if (s > toDay) return;
    yield { day: s, dow: new Date(t).getUTCDay() };
  }
}

/**
 * The method's alerts on the reference feed's bars, as the watcher would have
 * sent them had it read every bar: for each London weekday whose window lies
 * in [fromMs, toMs), every window bar close T (the closes a watcher polling at
 * T + 20 s reads), liveRead on the last `lookback` closed bars with nowMs =
 * T + 20 s, then shouldAlert with state carried only from earlier alerts of
 * this record (seeded from `events`). Each alert is scored at once with
 * outcome() (both touched = half).
 *
 * Whole days only. A day is processed only when every one of its closes can
 * be read on a full `lookback` of bars and the feed has reached the window's
 * close; otherwise it comes back in `pending` and nothing of it is written,
 * so a later run gives the same result as one that had all the bars. A day
 * that starts before fromMs is processed from its own start (a commitment at
 * 11:00 does not change what the 11:15 alert sees).
 *
 * Holes. A day is held (pending, why 'gap') while ANY bar is missing from
 * any of its closes' slices or from the window's own bars, outside gold's
 * scheduled closures (history.mjs gapsIn with minMissing 1) — the feed may
 * still fill it, and a recorded day cannot be recomputed; even one missing
 * bar moves which close an alert comes on (re-check, 17 Oct). Once
 * GAP_SETTLE_MS (48 h) has passed since the window closed it is recorded as
 * it stands, and flagged `gap: true` only if a hole is of more than 4 bars
 * (the plan's rule); sampleStatus leaves a flagged day's alerts out of the
 * sample. The rule looks only at the bars and the clock, never at results.
 *
 * The broker's session. The server offset is not part of the method
 * (methodKey): it reaches a read only through gateFor's marketOpenNow, which
 * turns a read "closed" when the broker's market is shut. So a day is
 * recorded only when every one of its reads falls inside the broker's
 * session under the configured offset (serverOffsetFor at T + 20 s); then no
 * offset can change any of them. Otherwise the day is held (pending, why
 * 'outside-session') and never recorded under these settings: a window that
 * reached into gold's daily break would make the record depend on the
 * offset. With the 08:00–16:00 London window every offset from −5 to +8
 * hours keeps every read inside both instruments' sessions, in summer time
 * and in winter (the broker's own is +2 or +3).
 *
 * A day that already has a day record for this method in `events` is FROZEN:
 * it is never recomputed (it comes back in `frozen`), so a replay over
 * revised bars, other settings or another machine cannot change it.
 *
 *   pair, bars   the reference feed's bars for this pair (forming ones are dropped)
 *   feedId       the id of the source the bars came from (history.mjs
 *                HISTORY_FEEDS, src/data-feeds.js): one of
 *                REFERENCE_FEEDS[pair].sources — a fallback feed's bars are
 *                refused, not mislabelled as the reference
 *   method       methodOf(...): its tf and targetRule are what is read; its
 *                window and this instrument's costs must be the settings'
 *                (cfg) own. The lines carry forPair(method, pair).
 *   events       the journal's events, to seed the state from earlier alerts
 *   featuresFor, filterFor   (r, seen) → features / filter output, stored on the alert
 *   keep         (r, seen) → false drops an idea before shouldAlert (a live filter;
 *                it must then be part of `method.filter`)
 *   lookback     bars per read: CLOSED_BARS (999), the closed bars of the
 *                watcher's 1,000-bar fetch, so the record reads each close
 *                exactly as the watcher does
 *   read         the read function (liveRead; a test may memoise it)
 *
 * Returns { events: [...alert events, ...day events], alerts, days, pending: [{day, pair, why}],
 * frozen: [{day, pair}] } where why is 'window-open' | 'outside-session' | 'short-history' | 'not-yet' | 'gap'.
 */
export function canonicalAlerts({
  pair, bars, feedId, cfg, fromMs, toMs, method, events = [], nowMs = Date.now(),
  featuresFor = null, filterFor = null, keep = null, lookback = CLOSED_BARS, read = liveRead,
}) {
  if (!PAIRS.includes(pair)) fail(`unknown instrument ${pair}`);
  const ref = REFERENCE_FEEDS[pair];
  if (!ref.sources.includes(feedId)) fail(`the method's record is read only on ${ref.label} (a source among ${ref.sources.join(', ')}), not on ${feedId ?? 'an unnamed feed'}`);
  const m = checkedMethod(method, [pair]);
  if (m.feeds[pair] !== ref.id) fail(`the method names ${m.feeds[pair]} for ${pair}, but its record is read only on the reference feed ${ref.id}`);
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs))) fail('canonicalAlerts needs fromMs and toMs');
  sameSettings(m, cfg, 'canonicalAlerts', [pair]);
  const mp = forPair(m, pair);                           // what each line carries
  const inst = INSTRUMENTS[pair];
  const offsetCfg = cfg.broker ? cfg : { ...cfg, broker: { serverOffset: 'auto' } };
  const inSession = (T) => marketOpenNow(inst, T + 20000, serverOffsetFor(T + 20000, offsetCfg)) !== false;
  const tfMs = tfInfo(m.tf).minutes * 60000;
  const cfgM = { ...cfg, timeframe: m.tf };
  const feed = { id: REFERENCE_FEEDS[pair].id, label: REFERENCE_FEEDS[pair].label };
  const closed = (bars || []).filter((b) => b.t + tfMs <= nowMs).sort((a, b) => a.t - b.t);
  const lastClose = closed.length ? closed[closed.length - 1].t + tfMs : -Infinity;
  const comm = m.costs[pair].comm;
  // Any missing bar holds a day; only a hole of more than 4 (GAP_MIN_MISSING) flags it.
  const missing = gapsIn(closed, m.tf, { pair, minMissing: 1 });
  const missingIn = gapInWindow(closed, missing, lookback);
  const holes = gapsIn(closed, m.tf, { pair });
  const holeIn = gapInWindow(closed, holes, lookback);

  // Days already recorded are frozen. The state at the start of each day
  // processed is the latest alert before that day's own start — from this
  // record (frozen days included) or from this run — not before fromMs, since
  // the day is replayed whole.
  const recorded = foldDays(events, m);
  const earlierAlerts = foldCanonical(events, m).filter((a) => a.pair === pair);
  const latestBefore = (ms) => {
    let p = null;
    for (const a of earlierAlerts) if (a.barCloseMs < ms) p = a;
    const q = alerts.length ? alerts[alerts.length - 1] : null;
    return !p ? q : !q ? p : q.barCloseMs > p.barCloseMs ? q : p;
  };
  let prev = null;

  const alerts = [], days = [], pending = [], frozen = [];
  let idx = -1;                                          // last bar closed by the current T
  for (const { day, dow } of calendar(dayOf(fromMs), dayOf(Math.max(fromMs, toMs - 1)))) {
    if (dow === 0 || dow === 6) continue;
    const [y, mo, d] = day.split('-').map(Number);
    const w = windowState(zonedTimeToUtc(y, mo, d, 12, 0, DAY_TZ), cfgM.window);
    if (w.weekend) continue;
    if (w.opensAtMs <= HOLDOUT.toMs) fail(`${day} is inside the held-back years (rule 2); the journal's record starts after ${new Date(HOLDOUT.toMs).toISOString()}`);
    if (recorded.has(dayIdOf(pair, m.tf, day))) { frozen.push({ day, pair }); continue; }
    if (w.closesAtMs > Math.min(toMs, nowMs)) { if (w.opensAtMs < toMs) pending.push({ day, pair, why: 'window-open' }); continue; }
    const closes = [];
    for (let T = Math.floor(w.opensAtMs / tfMs) * tfMs; T <= w.closesAtMs; T += tfMs) if (inWatchHours(T + 20000, cfgM)) closes.push(T);
    if (!closes.every(inSession)) { pending.push({ day, pair, why: 'outside-session' }); continue; }
    if (lastClose < w.closesAtMs) { pending.push({ day, pair, why: 'not-yet' }); continue; }
    const at = (T) => { while (idx + 1 < closed.length && closed[idx + 1].t + tfMs <= T) idx++; while (idx >= 0 && closed[idx].t + tfMs > T) idx--; return idx; };
    if (closes.some((T) => at(T) + 1 < lookback)) { pending.push({ day, pair, why: 'short-history' }); continue; }
    // A missing bar in any read's slice, or among the window's own bars (the
    // missing stretch overlapping [open, close)), holds the day until it
    // settles; a hole of more than 4 bars then flags it.
    const inWin = (g) => g.afterT + tfMs < w.closesAtMs && g.nextT > w.opensAtMs;
    const short = closes.some((T) => missingIn(at(T))) || missing.some(inWin);
    const gap = closes.some((T) => holeIn(at(T))) || holes.some(inWin);
    if (short && nowMs < w.closesAtMs + GAP_SETTLE_MS) { pending.push({ day, pair, why: 'gap' }); continue; }

    prev = latestBefore(w.opensAtMs);
    const kinds = {};
    const dayAlerts = [];
    for (const T of closes) {
      const k = at(T);
      const seen = closed.slice(k - lookback + 1, k + 1);
      const r = read({ pair, bars: seen, nowMs: T + 20000, cfg: cfgM, source: feed, targetRule: m.targetRule });
      kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      if (r.kind !== 'idea') continue;
      if (keep && !keep(r, seen)) continue;
      if (!shouldAlert({ lastAlert: prev ? { [pair]: alertState(prev) } : {} }, r, seen, cfgM)) continue;
      const rec = ideaRecord(r);
      const scored = scoreOn(closed, rec, { spread: rec.spreadNum, comm, closesAtMs: windowState(rec.barCloseMs, cfgM.window).closesAtMs, tfMs });
      if (!scored) fail(`could not score ${idOf(pair, m.tf, rec.barCloseMs)} although the window's bars are in`);
      dayAlerts.push(sanitize({
        // `at` is when the method could have known it, not when this ran, so two
        // runs over the same bars write the same line.
        type: 'alert', id: idOf(pair, m.tf, rec.barCloseMs), at: rec.barCloseMs + 20000,
        pair, tf: m.tf, method: mp, barCloseMs: rec.barCloseMs, validUntilMs: rec.validUntilMs, side: rec.side,
        feed: feed.label, feedId: feed.id, refPrice: rec.refPrice, stopDist: rec.stopDist, tp1Dist: rec.tp1Dist,
        tp2Dist: rec.tp2Dist ?? null, spreadNum: rec.spreadNum, commNum: comm, netR: rec.netR ?? null,
        confidence: rec.confidence ?? null, reasons: rec.reasons || [], against: rec.against || [],
        features: featuresFor ? featuresFor(r, seen) : null, filter: filterFor ? filterFor(r, seen) : null,
        outcome: scored,
      }));
      prev = rec;
    }
    alerts.push(...dayAlerts);
    // `at` is when the day was recorded: the earliest recorded day record stands.
    days.push(sanitize({
      type: 'day', id: dayIdOf(pair, m.tf, day), at: Math.max(nowMs, w.closesAtMs), pair, tf: m.tf, method: mp, day,
      alerts: dayAlerts.length, ids: dayAlerts.map((a) => a.id), sums: dayAlerts.map(sumOf), kinds,
      ...(gap ? { gap: true } : {}),
    }));
  }
  return { events: [...alerts, ...days], alerts, days, pending, frozen };
}

/* ------------------------------------------------------- what the user saw */

const modeOf = (cfg) => oneOf((cfg && cfg.account && cfg.account.mode) || 'demo', ACCOUNT_MODES, 'account.mode');

/**
 * The shown event for one desk/live.mjs ideaRecord(r) that the watcher sent
 * (`watch`) or a scan reported (`scan`). The account mode is taken from the
 * settings here, once, and every later event for this alert copies it. Only
 * a record from liveRead — one that names its feed — can become an alert, so
 * nothing read from a screenshot ever does. `features` (optional) is
 * features.mjs featuresAt of that very read, under the names setFeatureNames
 * was given.
 */
export function shownEvent(rec, { source, method, cfg, at = Date.now(), features = null } = {}) {
  if (!rec || !rec.pair || !(rec.barCloseMs > 0)) fail('a shown alert needs its pair and bar close');
  if (!rec.sourceId) fail('a shown alert must come from a live feed read (it names no feed)');
  if (!PAIRS.includes(rec.pair)) fail(`unknown instrument ${rec.pair}`);
  const m = checkedMethod(method, [rec.pair]);
  sameSettings(m, cfg, 'shownEvent', [rec.pair]);
  if (rec.tf !== m.tf) fail(`the alert is on ${rec.tf} but the method is on ${m.tf}`);
  return sanitize({
    type: 'shown', id: idOf(rec.pair, rec.tf, rec.barCloseMs), at, account: modeOf(cfg),
    source: oneOf(source, SOURCES, 'source'), pair: rec.pair, tf: rec.tf, method: forPair(m, rec.pair),
    barCloseMs: rec.barCloseMs, validUntilMs: rec.validUntilMs ?? null, side: rec.side,
    feed: rec.source ?? null, feedId: rec.sourceId, refPrice: rec.refPrice,
    stopDist: rec.stopDist, tp1Dist: rec.tp1Dist, tp2Dist: rec.tp2Dist ?? null, spreadNum: rec.spreadNum ?? null,
    commNum: costFor(rec.pair, 0, cfg).comm, netR: rec.netR ?? null, confidence: rec.confidence ?? null,
    reasons: rec.reasons || [], against: rec.against || [],
    ...(features ? { features } : {}),
  });
}

/**
 * Silent resolution of what the user was shown: 'resolved' events for shown
 * alerts whose window has closed by `nowMs` and whose feed bars reach that
 * far, scored with the alert's own stored spread and commission. (The
 * method's record scores itself in canonicalAlerts.)
 *
 *   bars   the feed's bars: one array with opts.pair, or {XAUUSD: [...], BTCUSD: [...]}
 *   opts   { pair, feed (required: the label of the feed the bars came from, or per pair),
 *            nowMs (default now: bars still forming are dropped) }
 * Each event carries the shown alert's account mode, so appendEvents' consent
 * check applies to it like any other.
 */
export function resolveOpen(entries, bars, cfg, { pair = null, feed = null, nowMs = Date.now() } = {}) {
  if (Array.isArray(bars) && pair === null) fail('resolveOpen needs opts.pair when given one array of bars');
  if (!feed) fail('resolveOpen needs opts.feed: the feed the bars came from');
  const barsFor = (p) => (Array.isArray(bars) ? (pair === p ? bars : null) : (bars && bars[p]) || null);
  const feedFor = (p) => {
    const f = typeof feed === 'object' && !('label' in feed) ? feed[p] : feed;
    return typeof f === 'string' ? f : f && f.label;
  };
  const out = [];
  for (const e of entriesOf(entries)) {
    const s = e.shown;
    if (!s || e.shownOutcome) continue;
    const b = barsFor(s.pair);
    if (!b || !b.length || !feedFor(s.pair)) continue;
    const tfMs = tfInfo(s.tf).minutes * 60000;
    const closesAtMs = windowState(s.barCloseMs, cfg.window).closesAtMs;
    if (nowMs < closesAtMs) continue;
    const closed = b.filter((x) => x.t + tfMs <= nowMs);
    const spread = s.spreadNum ?? INSTRUMENTS[s.pair].typicalSpread.observed;
    const comm = s.commNum ?? costFor(s.pair, 0, cfg).comm;
    const o = scoreOn(closed, s, { spread, comm, closesAtMs, tfMs });
    if (!o) continue;
    out.push(sanitize({ type: 'resolved', id: e.id, at: nowMs, account: s.account, ...o, feed: feedFor(s.pair), spreadNum: spread }));
  }
  return out;
}

/* ------------------------------------------------------- the user's own trades */

const shownEntry = (entry, what) => {
  if (!entry || !entry.id) fail(`${what} needs the alert's entry`);
  if (!entry.shown) fail(`${what}: ${entry.id} was never sent to the user`);
  return entry.shown;
};

/*
 * The account a trade of the user's goes down as: the alert's own mode, unless
 * the user said which account it was on (after accountMismatch asked).
 */
const accountFor = (s, account) => (account === null || account === undefined ? s.account : oneOf(account, ACCOUNT_MODES, 'account'));

/**
 * Before marking the user's own trade on an alert: when the settings' account
 * mode now differs from the mode the alert was shown under (say it was shown
 * on demo and the user has since switched to live), ask which account the
 * trade was on and pass the answer as `account` to markTicketed, markTaken
 * and markActual. A live answer then goes through the live-record question
 * like any other live event. Returns null when they agree (or the alert was
 * never shown), else { shownAs, settingsSay, question }.
 */
export function accountMismatch(entry, cfg) {
  if (!entry || !entry.shown) return null;
  const now = modeOf(cfg);
  if (now === entry.shown.account) return null;
  return {
    shownAs: entry.shown.account, settingsSay: now,
    question: `That alert came while your settings said ${entry.shown.account}; they now say ${now}. Was this trade on your demo account or your live account?`,
  };
}

/** How far from the shown alert's price the user's ticket prices may be: 20%. */
export const TICKET_BAND = 0.2;

/**
 * `take` returned a ticket for this alert. The prices are the user's MT5
 * price and the levels built from it — allowed (rule 6); the lot size is not.
 */
export function markTicketed(entry, { userPrice, stopLoss = null, takeProfit = null, at = Date.now(), account = null } = {}) {
  const s = shownEntry(entry, 'markTicketed');
  // The user's MT5 prices sit near the feed's (tens of dollars apart, decision
  // 26): one far from the shown alert's price is a mistake, or not a price.
  if (s.refPrice > 0) {
    for (const [what, x] of [['userPrice', userPrice], ['stopLoss', stopLoss], ['takeProfit', takeProfit]]) {
      if (x === null || x === undefined) continue;
      if (!(typeof x === 'number' && Math.abs(x - s.refPrice) <= TICKET_BAND * s.refPrice)) fail(`${what} must be within ${TICKET_BAND * 100}% of the alert's price`);
    }
  }
  return sanitize({ type: 'ticketed', id: entry.id, at, account: accountFor(s, account), userPrice, stopLoss, takeProfit });
}

/**
 * "I took it" — linked to an alert only explicitly, never by recency alone:
 *   { alertId }                    the conversation named the alert (it must have been sent)
 *   { tf | lastTicketedWithinMs, nowMs }  a ticket built within the ticket's freshness
 *                                  (takenWithinMs(tf)), not already taken, and exactly one
 * `account`: the user's answer when accountMismatch asked; else the alert's mode.
 * Returns { ok: true, event } or { ok: false, reason: 'no-alert' | 'not-shown' |
 * 'no-ticket' | 'ambiguous', candidates? } — on false, ask the user which alert it was.
 */
export function markTaken(entries, { alertId = null, tf = null, lastTicketedWithinMs = null, nowMs = Date.now(), at = nowMs, account = null } = {}) {
  const all = entriesOf(entries);
  const event = (e, how) => ({ ok: true, event: sanitize({ type: 'taken', id: e.id, at, account: accountFor(e.shown, account), how }) });
  if (alertId) {
    const e = all.find((x) => x.id === alertId);
    if (!e) return { ok: false, reason: 'no-alert' };
    return e.shown ? event(e, 'named') : { ok: false, reason: 'not-shown' };
  }
  const within = lastTicketedWithinMs ?? (tf ? takenWithinMs(tf) : null);
  if (!(within > 0)) fail('markTaken needs an alert id, or a timeframe for the ticket window');
  const fresh = all.filter((e) => e.shown && e.ticketed && !e.taken && e.ticketed.at <= nowMs && nowMs - e.ticketed.at <= within);
  if (!fresh.length) return { ok: false, reason: 'no-ticket' };
  if (fresh.length > 1) return { ok: false, reason: 'ambiguous', candidates: fresh.map((e) => e.id) };
  return event(fresh[0], 'ticket');
}

/**
 * How the user says their trade ended, in R only. The session turns "+£40"
 * into R with the risk amount before calling this; pounds never reach here.
 *   how  'target' | 'stop' | 'by-hand' | 'end-of-session'
 */
export function markActual(entry, { r, how, at = Date.now(), account = null } = {}) {
  const s = shownEntry(entry, 'markActual');
  if (typeof r !== 'number' || !Number.isFinite(r) || Math.abs(r) > 50) fail('the result must be a number of R');
  return sanitize({ type: 'actual', id: entry.id, at, account: accountFor(s, account), r: +r.toFixed(4), how });
}

/**
 * True when the settings say live and the user has not yet answered whether a
 * live trade record may sit in a public repository: ask before the next write
 * (rule 6), then record the answer with consentEvent(). `events` are the raw
 * journal events.
 */
export function needsLiveConsent(events, cfg) {
  return modeOf(cfg) === 'live' && foldConsent(events) === null;
}

/** The user's answer to the live-record question. */
export function consentEvent({ answer, at = Date.now() } = {}) {
  return sanitize({ type: 'consent', id: CONSENT_ID, at, answer });
}

/* ------------------------------------------------------------------ the sample */

/**
 * Commit the alert sample (the user said yes to sampleQuestion). Refused while
 * an earlier sample is unfinished, unless the method changed — restarting a
 * run after a bad start is the optional stopping decision 8 forbids — and
 * refused below MIN_PLANNED_ALERTS, or with a commitment inside the held-back
 * years. `events` are the journal's events (pass [] for an empty one). `cfg`
 * is the settings: a method whose window or costs (for the sample's
 * instruments) are not the settings' own is out of date and is refused, so a
 * sample is never committed to a method the record will not be read with.
 */
export function setSample({ plannedAlerts = DEFAULT_PLANNED_ALERTS, method, cfg, pairs = [...PAIRS], committedAt = Date.now(), at = committedAt, events, replaces = null } = {}) {
  if (!Number.isInteger(plannedAlerts) || plannedAlerts < MIN_PLANNED_ALERTS) fail(`the sample needs a whole number of at least ${MIN_PLANNED_ALERTS} alerts`);
  if (!cfg) fail('setSample needs the settings (cfg), to check the method is the current one');
  pairs = FIELD.pairs(pairs);
  const m = checkedMethod(method, pairs);
  sameSettings(m, cfg, 'setSample', pairs);
  if (!Array.isArray(events)) fail('setSample needs the journal\'s events, to check for a sample in progress');
  if (!(committedAt > HOLDOUT.toMs)) fail('a sample cannot start inside the held-back years');
  const current = foldSample(events);
  if (current) {
    if (!(committedAt > current.committedAt)) fail('a new sample must start after the one in force');
    const st = sampleStatus(events, current);
    if (!st.complete) {
      if (replaces !== 'method-changed') fail(`the sample in progress (${st.count} of ${st.planned}) has no verdict yet; it ends only when the method changes`);
      if (current.pairs.every((p) => keyFor(m, p) === keyFor(current.method, p))) fail('the method is unchanged, so the sample in progress cannot be restarted');
    }
  }
  return sanitize({ type: 'sample', id: sampleIdOf(committedAt), at, plannedAlerts, method: m, pairs, committedAt, replaces });
}

const iso16 = (day) => `${day}T00:00`;

/**
 * Day records of the same method, pair, timeframe and day that disagree on
 * which alerts the day had (their ids or checksums differ) or on whether the
 * day had a hole (its `gap` flag, which decides whether its alerts count): a
 * union merge of two machines' different computations. Only one can stand, and which one is
 * decided by when each was recorded, not by the bars — so the verdict waits
 * until it is settled by hand. ['YYYY-MM-DD PAIR'], sorted.
 */
function contestedDays(events, method, pairs) {
  const by = new Map();
  for (const e of events || []) {
    if (!valid(e) || e.type !== 'day' || !pairs.includes(e.pair) || keyFor(e.method, e.pair) !== keyFor(method, e.pair)) continue;
    const what = JSON.stringify([e.ids, e.sums, !!e.gap]);
    if (!by.has(e.id)) by.set(e.id, { e, what: new Set() });
    by.get(e.id).what.add(what);
  }
  return [...by.values()].filter((x) => x.what.size > 1).map((x) => `${x.e.day} ${x.e.pair}`).sort();
}

/** London midnight at the start of a day (YYYY-MM-DD). */
const dayStartMs = (day) => { const [y, mo, d] = day.split('-').map(Number); return zonedTimeToUtc(y, mo, d, 0, 0, DAY_TZ); };

/**
 * Where a committed sample stands. It counts only the method's record — the
 * alerts canonicalAlerts found on the reference feeds for the sample's method
 * and instruments, from the commitment on — never what the watcher or a scan
 * happened to send. Alerts whose trade spans a gap in the feed, and every
 * alert of a day recorded with a hole in its bars (`gap` on its day record),
 * are left out (counted in `gapped`).
 *
 * The verdict, exactly as declared: on the first N alerts, mean R per alert
 * after costs with the by-day clustered 95% range (variance × G/(G−1), G =
 * days, the usual small-sample correction). Given only when
 *  - N alerts are in, and the judged alerts span at least MIN_VERDICT_DAYS
 *    days (if the first N span fewer, the judged set runs on to the end of
 *    the 30th London day, whole days — declared before any alert, a rule on
 *    dates alone, never on results);
 *  - every weekday from the commitment to the last judged alert has been
 *    checked on the feed for every instrument in the sample (otherwise a late
 *    check could still add an earlier alert and change which N are judged);
 *  - no day up to the last judged alert is CONTESTED (two different records
 *    of it, from a merge): which one stands would otherwise decide the verdict;
 *  - the sample has not ended. A later commitment ends it ('new-sample'); so
 *    does the method changing under it ('method-changed'): the first alert
 *    shown, alert recorded, or day recorded, for the sample's instruments
 *    after the commitment, under a different method for that instrument
 *    (keyFor: version, target rule, filter, timeframe, window, and that
 *    instrument's feed and costs) — a settings change ends it even with the
 *    watcher off. The server offset and the other instrument's costs cannot
 *    change the record, so they never end it.
 *
 * Returns null without a sample, else {
 *   planned, pairs, committedAt, count, judged, gapped, days, mean, se,
 *   range [lo, hi] | null, uncovered ['YYYY-MM-DD PAIR'], contested ['YYYY-MM-DD PAIR'],
 *   gapDays ['YYYY-MM-DD PAIR'], tooFewDays,
 *   ended, endedReason 'new-sample' | 'method-changed' | null,
 *   complete, verdict 'edge' | 'against' | 'break-even' | null, verdictText
 * }
 */
export function sampleStatus(events, sample = foldSample(events)) {
  if (!sample) return null;
  const same = (e) => keyFor(e.method, e.pair) === keyFor(sample.method, e.pair);
  const N = sample.plannedAlerts;
  const next = foldSamples(events).find((s) => s.committedAt > sample.committedAt);
  const nextMs = next ? next.committedAt : Infinity;
  const ours = (e) => sample.pairs.includes(e.pair) && e.barCloseMs >= sample.committedAt;
  // The method changed at the first sign of another method after the
  // commitment, for the sample's instruments:
  //  - an alert shown under it: at its bar close;
  //  - a day recorded under it: at the time it was RECORDED (its `at`, never
  //    before that day's window closed). Not at the day's own date: a replay
  //    under the new settings may record days from before the change, and
  //    must not cut alerts the old method recorded while it was in force (or
  //    take away a verdict already reached);
  //  - an alert recorded under it: at its day record's time, as above; one no
  //    day record names (not part of the record — a hand edit) at its own `at`.
  const commitDay = dayOf(sample.committedAt);
  const otherDays = new Map();
  for (const d of standingDays(events).values()) if (sample.pairs.includes(d.pair) && !same(d)) d.ids.forEach((id) => otherDays.set(`${keyFor(d.method, d.pair)}|${id}`, d.at));
  const changeAt = (e) => {
    if (!valid(e) || !sample.pairs.includes(e.pair) || same(e)) return Infinity;
    if (e.type === 'shown') return ours(e) ? e.barCloseMs : Infinity;
    if (e.type === 'day') return e.at >= sample.committedAt ? e.at : Infinity;
    if (e.type === 'alert') { const t = otherDays.get(`${keyFor(e.method, e.pair)}|${e.id}`) ?? e.at; return t >= sample.committedAt ? t : Infinity; }
    return Infinity;
  };
  const changedMs = Math.min(Infinity, ...(events || []).map(changeAt));
  const endMs = Math.min(nextMs, changedMs);
  const dayRecs = foldDays(events, sample.method);
  const gapDay = (a) => { const d = dayRecs.get(dayIdOf(a.pair, a.tf, dayOf(a.barCloseMs))); return !!(d && d.gap); };
  const all = foldCanonical(events, sample.method).filter((e) => ours(e) && e.barCloseMs < endMs);
  const counted = all.filter((a) => !a.outcome.gap && !gapDay(a));

  let M = Math.min(N, counted.length);
  const daysIn = (xs) => new Set(xs.map((a) => dayOf(a.barCloseMs))).size;
  // Declared before any alert (MIN_VERDICT_DAYS): if the first N span fewer
  // than 30 London days, the judged set runs on to the END of the 30th
  // distinct day — whole days, so the last day's cluster is not cut.
  if (counted.length >= N && daysIn(counted.slice(0, N)) < MIN_VERDICT_DAYS) {
    const seen = new Set();
    for (M = 0; M < counted.length; M++) {
      const d = dayOf(counted[M].barCloseMs);
      if (!seen.has(d) && seen.size === MIN_VERDICT_DAYS) break;
      seen.add(d);
    }
  }
  const judged = counted.slice(0, M);
  const G = daysIn(judged);
  const reachedN = counted.length >= N;
  const enoughDays = G >= MIN_VERDICT_DAYS;

  // Weekdays that should have been checked on the feed and were not; days
  // recorded twice, differently; days recorded with a hole.
  const inSample = [...dayRecs.values()].filter((d) => sample.pairs.includes(d.pair) && d.day >= commitDay && dayStartMs(d.day) < endMs);
  const checkedDays = inSample.map((d) => d.day).sort();
  const lastDay = reachedN && judged.length ? dayOf(judged[judged.length - 1].barCloseMs) : checkedDays[checkedDays.length - 1] || null;
  const uncovered = [];
  if (lastDay) {
    for (const { day, dow } of calendar(commitDay, lastDay)) {
      if (dow === 0 || dow === 6 || dayStartMs(day) >= endMs) continue;
      for (const p of sample.pairs) if (!dayRecs.has(dayIdOf(p, sample.method.tf, day))) uncovered.push(`${day} ${p}`);
    }
  }
  const contested = contestedDays(events, sample.method, sample.pairs).filter((x) => x.slice(0, 10) >= commitDay && dayStartMs(x.slice(0, 10)) < endMs);
  // Once N are in, a contested day after the last judged one cannot change the verdict.
  const blocking = reachedN && lastDay ? contested.filter((x) => x.slice(0, 10) <= lastDay) : contested;
  const gapDays = inSample.filter((d) => d.gap).map((d) => `${d.day} ${d.pair}`).sort();

  const st = clusteredByDay(judged.map((a) => ({ at: iso16(dayOf(a.barCloseMs)), r: a.outcome.r })));
  const se = st && G > 1 ? st.seDay * Math.sqrt(G / (G - 1)) : null;
  const range = se === null ? null : [st.mean - 1.96 * se, st.mean + 1.96 * se];
  // A sample that reached its verdict before it ended keeps it.
  const reached = reachedN && enoughDays && !uncovered.length && !blocking.length;
  const ended = !reached && Number.isFinite(endMs);
  const complete = reached;
  const verdict = complete ? (range[0] > 0 ? 'edge' : range[1] < 0 ? 'against' : 'break-even') : null;
  return {
    planned: N, pairs: sample.pairs, committedAt: sample.committedAt,
    count: counted.length, judged: judged.length, gapped: all.length - counted.length,
    days: G, mean: st ? st.mean : null, se, range, uncovered, contested, gapDays,
    tooFewDays: reachedN && !enoughDays,
    ended, endedReason: !ended ? null : nextMs <= changedMs ? 'new-sample' : 'method-changed',
    complete, verdict, verdictText: verdict ? VERDICTS[verdict] : null,
  };
}

/* ------------------------------------------------------------------- wording */

/** R as said to the user: "+1.48", "−1", "0"; halves round away from zero. The minus is a real one. */
export function fmtR(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  const v = Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;
  if (v === 0) return '0';
  const s = String(Math.abs(v));
  return v > 0 ? `+${s}` : `−${s}`;
}

const tzOf = (cfg) => (cfg && cfg.window && cfg.window.tz) || DAY_TZ;
const nameOf = (pair) => label(pair).toLowerCase();
const dayFmt = new Map();
const dayLabel = (ms, tz) => {
  if (!dayFmt.has(tz)) dayFmt.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }));
  return dayFmt.get(tz).format(ms).replace(',', '');
};

/**
 * One alert's outcome, in one of rule 5's three forms:
 *   "The 10:15 bitcoin sell alert reached its target (+1.5 times the risk)"
 *   "The 10:15 bitcoin sell alert hit its stop (−1)"
 *   "The 10:15 bitcoin sell alert was closed at the end of the session (+0.3)"
 * Two cases the three forms do not cover are said just as plainly: a bar that
 * touched both levels (scored half of each), and an alert not finished yet.
 * A result across a gap in the feed says so. The time is the bar close it was
 * read at; `withDay` puts the day in front when a summary spans several.
 * The method's own result is used when there is one, else the shown alert's.
 */
export function outcomeSentence(entry, cfg, { withDay = false } = {}) {
  const tz = tzOf(cfg);
  const head = `${withDay ? `On ${dayLabel(entry.barCloseMs, tz)}, the` : 'The'} ${formatHM(entry.barCloseMs, tz)} ${nameOf(entry.pair)} ${entry.side} alert`;
  const o = (entry.alert && entry.alert.outcome) || entry.shownOutcome || entry.outcome || null;
  if (!o) return `${head} has not finished yet`;
  const gap = o.gap ? ' — the price feed has a gap during it, so it is left out of the sample' : '';
  if (o.bothTouched) return `${head} touched its stop and its target in the same bar, so it counts as half of each (${fmtR(o.r)})${gap}`;
  if (o.how === 'target') return `${head} reached its target (${fmtR(o.r)} times the risk)${gap}`;
  if (o.how === 'stop') return `${head} hit its stop (${fmtR(o.r)})${gap}`;
  return `${head} was closed at the end of the session (${fmtR(o.r)})${gap}`;
}

/**
 * Decision 8, for the alerts: why there is no verdict yet. Said only while
 * fewer than N are in; once N are in but they span too few days, the 'days'
 * variant says why instead.
 */
export const noVerdictLine = (n, why = 'count') => (why === 'days'
  ? `No verdict until the alerts span at least ${MIN_VERDICT_DAYS} days: alerts on the same day share one market, so a range from fewer days looks surer than it is. This was set before any alert was seen.`
  : `No verdict until all ${n} are in: checking after every alert and stopping on a good run turns a 5% test into a 20% one, which is how a method with no edge gets mistaken for one that has one.`);

/** "Binance's prices" from "Binance (BTCUSDT)"; several feeds joined; "the price feed" with none known. */
function feedWords(labels) {
  const names = [...new Set(labels.filter(Boolean).map((f) => f.split(' (')[0]))];
  if (!names.length) return 'the price feed';
  return `${names.map((n) => `${n}'s`).join(' and ')} prices`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CONTESTED_WHY = (n) => `${plural(n, 'day')} recorded twice, with different alerts or a different hole flag (two machines' journals merged), to be settled by hand first`;
const GAP_LINE = (n) => `${plural(n, 'day')} had a hole in the price feed's bars, so ${n === 1 ? 'its' : 'their'} alerts are left out of the sample.`;

/*
 * `settingsChanged`: the settings' window or costs (for the sample's
 * instruments) are no longer the sample's method's (summary works it out from cfg). The record is
 * then read under a different method, so the sample has stopped, whether or
 * not a day has been recorded under the new settings yet.
 * `methodChanged`: the desk now runs another method for one of the sample's
 * instruments (summary's `methodNow`): a new METHOD_VERSION of the rules that
 * decide alerts, another target rule or chart timeframe. The same: stopped,
 * and said so at once (rule 1), before anything is recorded under it.
 */
function sampleLines(st, { settingsChanged = false, methodChanged = false } = {}) {
  if (!st) return ['**The alert sample**: none committed yet, so there is no verdict to give.'];
  if (!st.complete && methodChanged) {
    return [`**The alert sample**: stopped at ${Math.min(st.count, st.planned)} of ${st.planned} because the desk's method changed after you committed to it (a new version of the rules that decide alerts, the target rule or the chart timeframe), and that makes it a different method; it gives no verdict. A new sample can be committed under the new one.`];
  }
  if (!st.complete && settingsChanged) {
    return [`**The alert sample**: stopped at ${Math.min(st.count, st.planned)} of ${st.planned} because your settings changed after you committed to it (the session window or the costs), and that makes it a different method; it gives no verdict. A new sample can be committed under the new settings.`];
  }
  if (st.ended) {
    return [`**The alert sample**: stopped at ${Math.min(st.count, st.planned)} of ${st.planned} because the method changed, so it gives no verdict.`];
  }
  if (st.complete) {
    return [`**The alert sample**: complete — ${st.judged} alerts over ${st.days} days, on average ${fmtR(st.mean)} times the risk (range ${fmtR(st.range[0])} to ${fmtR(st.range[1])}, clustered by day). Verdict: ${st.verdictText}.`];
  }
  const out = [];
  if (st.count >= st.planned) {
    const why = [];
    if (st.tooFewDays) why.push(`they come from only ${plural(st.days, 'day')}, and a verdict needs at least ${MIN_VERDICT_DAYS}, so the judged alerts run on to the end of the ${MIN_VERDICT_DAYS}th day`);
    if (st.uncovered.length) why.push(`${plural(st.uncovered.length, 'day')} still to be checked on the price feed`);
    if (st.contested.length) why.push(CONTESTED_WHY(st.contested.length));
    out.push(`**The alert sample**: all ${st.planned} alerts are in, but no verdict yet: ${why.join('; ')}.`);
  } else {
    let head = `**The alert sample**: ${st.count} of the ${st.planned} alerts you committed to`;
    if (st.count >= 1) {
      head += st.range
        ? `, so far on average ${fmtR(st.mean)} times the risk (range ${fmtR(st.range[0])} to ${fmtR(st.range[1])}, clustered by day).`
        : `, so far on average ${fmtR(st.mean)} times the risk — too few days yet for a range.`;
    } else head += '.';
    out.push(head);
    if (st.uncovered.length) out.push(`${plural(st.uncovered.length, 'day')} not yet checked on the price feed; the count can still grow for them.`);
    if (st.contested.length) out.push(`${CONTESTED_WHY(st.contested.length)[0].toUpperCase()}${CONTESTED_WHY(st.contested.length).slice(1)}.`);
    out.push(noVerdictLine(st.planned));
  }
  if (st.gapDays.length) out.push(GAP_LINE(st.gapDays.length));
  if (st.count >= st.planned && st.tooFewDays) out.push(noVerdictLine(st.planned, 'days'));
  return out;
}

/** The most recent London weekday whose window has opened by nowMs: [its midnight, min(now, next midnight)). */
function defaultPeriod(nowMs, cfg) {
  const tz = tzOf(cfg);
  for (let back = 0; back < 8; back++) {
    const t = nowMs - back * DAY_MS;
    const { y, m, d } = localDate(t, tz);
    const w = windowState(zonedTimeToUtc(y, m, d, 12, 0, tz), cfg.window);
    if (w.weekend || w.opensAtMs > nowMs) continue;
    const from = zonedTimeToUtc(y, m, d, 0, 0, tz);
    const n = localDate(from + 36 * 3600e3, tz);
    return [from, Math.min(nowMs, zonedTimeToUtc(n.y, n.m, n.d, 0, 0, tz))];
  }
  return [nowMs - DAY_MS, nowMs];
}

/**
 * What `journal` says. Between the start and end of the user's window on a
 * weekday: process counts only, and rule 4's sentence. Otherwise: the alerts
 * (scored on the feed) and the user's trades (as they told them) in two
 * blocks never added together, then the sample. Covers bar closes in
 * [fromMs, toMs); by default the most recent session day. `method` picks
 * whose record is shown (default: the sample's). `methodNow` is the method
 * the desk runs now (methodOf with live.mjs METHOD_VERSION and the settings'
 * timeframe): when it is not the sample's for one of its instruments, the
 * sample has stopped and the summary says so, and the record shown is the
 * new method's.
 */
export function summary(events, { nowMs = Date.now(), cfg, method = null, fromMs = null, toMs = null, methodNow = null } = {}) {
  if (!cfg || !cfg.window) fail('summary needs the settings (cfg.window)');
  const tz = tzOf(cfg);
  const [defFrom, defTo] = defaultPeriod(nowMs, cfg);
  const from = fromMs ?? defFrom, to = toMs ?? defTo;
  const sample = foldSample(events);
  // The method the settings make of the sample's: if the window or costs (of
  // the sample's instruments) changed since the commitment, the record is now
  // read under that one, and the sample has stopped.
  const current = sample && cfg.account ? methodUnder(sample.method, cfg) : sample ? sample.method : null;
  const settingsChanged = !!sample && cfg.account ? settingsDiffer(sample.method, cfg, sample.pairs) : false;
  const methodChanged = !!sample && !!methodNow && sample.pairs.some((p) => keyFor(methodNow, p) !== keyFor(current, p));
  const m = method || (methodChanged ? methodNow : current) || null;
  const st = sampleStatus(events, sample);
  const running = st && !st.ended && !((settingsChanged || methodChanged) && !st.complete);
  const entries = [...fold(events, { method: m }).values()];
  const inPeriod = (t) => Number.isFinite(t) && t >= from && t < to;
  const period = entries.filter((e) => inPeriod(e.barCloseMs));
  const multiDay = dayOf(from) !== dayOf(Math.max(from, to - 1));
  const w = windowState(nowMs, cfg.window);

  if (w.open) {
    const watch = period.filter((e) => e.shown && e.shown.source === 'watch');
    const scans = period.filter((e) => e.shown && e.shown.source === 'scan');
    const tickets = entries.filter((e) => e.ticketed && inPeriod(e.ticketed.at)).length;
    const taken = entries.filter((e) => e.taken && inPeriod(e.taken.at)).length;
    const byPair = PAIRS.map((p) => [p, watch.filter((e) => e.pair === p).length]).filter(([, n]) => n).map(([p, n]) => `${n} ${nameOf(p)}`);
    const head = multiDay ? `**So far, ${dayLabel(from, tz)} to ${dayLabel(to - 1, tz)}**` : '**Today so far**';
    return [head, [
      `- Alerts sent to you: ${watch.length}${byPair.length > 1 ? ` (${byPair.join(', ')})` : ''}`,
      ...(scans.length ? [`- Ideas from a one-off scan: ${scans.length}`] : []),
      `- Tickets you asked for: ${tickets}`,
      `- Trades you told me you took: ${taken}`,
      ...(running ? [`- Alert sample: ${Math.min(st.count, st.planned)} of ${st.planned}, counted from the price feed after each session`] : []),
    ].join('\n'), IN_SESSION_LINE].join('\n\n');
  }

  // A shown alert on a day the feed has not been checked yet is listed with the
  // method's alerts; once the day is checked, one the method did not send is
  // listed apart and not counted.
  const dayRecs = foldDays(events, m);
  const checked = (e) => dayRecs.has(dayIdOf(e.pair, e.tf, dayOf(e.barCloseMs)));
  const main = period.filter((e) => (e.alert && e.shown) || (!e.alert && e.shown && !checked(e)));
  const notSent = period.filter((e) => e.alert && !e.shown);
  const notInRecord = period.filter((e) => !e.alert && e.shown && checked(e));
  const say = (e) => outcomeSentence(e, cfg, { withDay: multiDay });
  const labels = [...main, ...notSent].map((e) => (e.alert ? e.alert.feed : (e.shownOutcome && e.shownOutcome.feed) || e.shown.feed));
  const body = [];
  if (!main.length && !notSent.length && !notInRecord.length) body.push('- No alerts in this period.');
  for (const e of main) body.push(`- ${say(e)}`);
  if (notSent.length) {
    body.push(`- The method's alerts you were not sent, found afterwards on the price feed${running ? ' (they count in the sample)' : ''}:`);
    for (const e of notSent) body.push(`  - ${say(e)}`);
  }
  if (notInRecord.length) {
    body.push('- Sent to you, but not in the method\'s record on the price feed (not counted in the sample):');
    for (const e of notInRecord) body.push(`  - ${say(e)}`);
  }
  const holed = [...dayRecs.values()].filter((d) => d.gap && inPeriod(dayStartMs(d.day) + 12 * 3600e3)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const d of holed) body.push(`- ${dayLabel(dayStartMs(d.day) + 12 * 3600e3, tz)}: the price feed's ${nameOf(d.pair)} bars have a hole that day, so its alerts are left out of the sample.`);
  if (running) {
    const todo = [];
    for (const { day, dow } of calendar(dayOf(from), dayOf(Math.min(Math.max(from, to - 1), nowMs)))) {
      if (dow === 0 || dow === 6) continue;
      const [y, mo, d] = day.split('-').map(Number);
      if (windowState(zonedTimeToUtc(y, mo, d, 12, 0, DAY_TZ), cfg.window).opensAtMs > nowMs) continue;
      const missing = st.pairs.filter((p) => !dayRecs.has(dayIdOf(p, m.tf, day)));
      if (missing.length) todo.push(`${dayLabel(zonedTimeToUtc(y, mo, d, 12, 0, DAY_TZ), tz)} (${missing.map(nameOf).join(', ')})`);
    }
    if (todo.length) body.push(`- Not yet checked on the price feed: ${todo.join('; ')}.`);
  }
  const done = [...main, ...notSent].filter((e) => e.alert && !e.alert.outcome.gap);
  if (done.length > 1) body.push(`- On average ${fmtR(done.reduce((s, e) => s + e.alert.outcome.r, 0) / done.length)} times the risk over the method's ${plural(done.length, 'finished alert')}.`);
  const alerts = [`**The alerts**: scored on ${feedWords(labels)}, not your MT5 trades; your own result can differ.`, body.join('\n')];

  const told = entries.filter((e) => e.actual && inPeriod(e.actual.at));
  const trades = [`**Your trades**: what you told me (${told.length} of them).`];
  const modes = ACCOUNT_MODES.map((mode) => [mode, told.filter((e) => e.actual.account === mode)]).filter(([, xs]) => xs.length);
  if (modes.length) {
    trades.push(modes.map(([mode, xs]) => `- ${mode === 'live' ? 'Live' : 'Demo'}: ${plural(xs.length, 'trade')}, on average ${fmtR(xs.reduce((s, e) => s + e.actual.r, 0) / xs.length)} times the risk`).join('\n'));
  }

  const blocks = [alerts.join('\n'), trades.join('\n'), sampleLines(st, { settingsChanged, methodChanged }).join('\n')];
  const earlierEnded = foldSamples(events).filter((s) => sample && s.committedAt < sample.committedAt)
    .map((s) => ({ s, x: sampleStatus(events, s) })).filter(({ x }) => !x.complete);
  if (earlierEnded.length) blocks.push(earlierEnded.map(({ s, x }) => `An earlier sample (committed ${dayLabel(s.committedAt, tz)}) stopped at ${Math.min(x.count, x.planned)} of ${x.planned} when the method changed.`).join('\n'));
  return blocks.join('\n\n');
}
