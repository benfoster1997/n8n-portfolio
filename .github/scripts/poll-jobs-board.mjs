// Jobs board monitor — the always-on copy.
//
// WHY THIS EXISTS, given 05-jobs-board-monitor/ already does it in n8n.
//
// The n8n copy is correct and tested. It cannot be reliable, because it runs on
// a laptop, and the laptop sleeps ~180 times a day: measured 17 Sept 2026, seven
// days of `pmset -g log`, 170–187 sleep/wake cycles per day. A ten-minute poll on
// a machine that sleeps that often achieved roughly 10–20% coverage — 1 execution
// on 8 Sept, 6 on the 9th, against the 144 a full day should produce.
//
// It cost a real job. `[Hiring] Contract implementer` (topic 313974) was posted
// 16 Sept 03:18 UTC and closed "This req is filled" at 18:46 the same day. The
// laptop was asleep at 03:18, so the poll that should have caught it never ran;
// the first poll after waking fired at 15:13, leaving 3h33m of a 15h window.
//
// The local watchdog cannot fix this and does not claim to: its own plist says
// "Interval firings are MISSED while asleep". It restarts things that crashed,
// and nothing had crashed — 3 restarts in 7 days, OK every 2 minutes.
//
// So the poll moved here. GitHub-hosted, free on a public repo, no machine of
// Ben's involved.
//
// ⛔ THE FILTER BELOW IS A FAITHFUL PORT, NOT A REWRITE. Every regex, threshold
// and comment comes from 05-jobs-board-monitor/workflow.json, where it was
// measured against 179–180 real board titles and carries two fixes that were
// each found the expensive way (a hyphen is not whitespace; a bracketed tag beats
// the buyer override). If you change the rules, change them THERE first, re-run
// that suite, and port the result back. Do not let the two drift.
//
// Differences from the n8n copy, and only these:
//   - state lives in state.json (GitHub Actions cache), not workflow static data
//   - the board is fetched here rather than by a preceding node
//   - the ntfy topic comes from the NTFY_TOPIC env var, never a literal
//   - a failed fetch exits non-zero so GitHub's own failure mail is the canary,
//     replacing the 6-hourly canary leg

import { fileURLToPath } from 'node:url';

const BOARD = 'https://community.n8n.io/c/jobs/13.json';
// fileURLToPath, NOT URL.pathname. `.pathname` percent-encodes, so a checkout in
// a directory with a space in it ("…/Claude Code/…") yields "Claude%20Code",
// existsSync misses the state file, and EVERY run reads as a first run: silently
// seeding and never notifying anything, for ever. It fails only where the path
// has a space, so CI would have stayed green and the local test lied.
const STATE_FILE = fileURLToPath(new URL('../../state.json', import.meta.url));
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!NTFY_TOPIC && !DRY_RUN) {
  console.error('NTFY_TOPIC is not set. Refusing to run: a poll that cannot notify is worse than no poll, because it silently consumes the new postings into the seen-set.');
  process.exit(1);
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ── the filter, ported verbatim ────────────────────────────────────────────
const SELF_PROMO = /\[?\s*for[\s\-]+hire\s*\]?|\bavailable\b|\bdisponible\b|open to (work|collaboration)|looking for work|seeking (a )?(role|work|job)|offering (assistance|help|my|free|low-cost)|\bfreelancer\s*[-–—:]/i;
const BUYER_ASKING = /\bhiring\b|\blooking (for|to hire)\b|\bwe need\b|\bwanted\b|\bjob title\b|\bopportunit(y|ies)\b|\b(position|role|vacancy|opening|budget)\b|\b(anyone|someone|somebody)\b|\bwho can\b/i;
const SELF_PROMO_TAGGED = /\[\s*(available\s+)?(for[\s\-]+hire|hire\s+me|available|open\s+to\s+work|offering\s+assistance)\s*\]/i;

const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const GRACE_MS = 5 * 60 * 1000;

// ── state ──────────────────────────────────────────────────────────────────
let store = {};
if (existsSync(STATE_FILE)) {
  try {
    store = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    // A corrupt state file must NOT be treated as a cold start: that would
    // re-notify everything on the board. Fail loudly and keep the old file.
    console.error('state.json is unreadable:', e.message);
    process.exit(1);
  }
}
const firstRun = store.seenTopics === undefined;
store.seenTopics = store.seenTopics || {};

const now = Date.now();
const prevPollAt = store.lastPollAt ?? null;
store.lastPollAt = now;

// ── fetch ──────────────────────────────────────────────────────────────────
let topics = [];
try {
  const res = await fetch(BOARD, {
    headers: { 'User-Agent': 'n8n-jobs-board-monitor (github.com/benfoster1997/n8n-portfolio)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  topics = body?.topic_list?.topics ?? [];
  if (!Array.isArray(topics) || topics.length === 0) throw new Error('listing was empty');
} catch (e) {
  // ⛔ Do NOT write state on a failed fetch. Writing lastPollAt here would move
  // the window forward over postings this run never saw, and they would then
  // fail the isNew test on the next successful run.
  console.error('board unreachable:', e.message);
  process.exit(1);
}

for (const [id, ts] of Object.entries(store.seenTopics)) {
  if (now - ts > TTL_MS) delete store.seenTopics[id];
}

const humanAge = (mins) => {
  if (mins === null) return 'age unknown';
  if (mins < 90) return mins + 'm old';
  if (mins < 2880) return Math.round(mins / 60) + 'h old';
  return Math.round(mins / 1440) + 'd old';
};

const out = [];
for (const t of topics) {
  const id = String(t.id);
  if (store.seenTopics[id]) continue;
  store.seenTopics[id] = now;

  if (t.pinned || t.pinned_globally) continue;
  const title = t.title || '';
  if (SELF_PROMO_TAGGED.test(title)) continue;
  if (SELF_PROMO.test(title) && !BUYER_ASKING.test(title)) continue;
  if (firstRun) continue;

  const createdMs = Date.parse(t.created_at);
  const unknownDate = Number.isNaN(createdMs);
  const ageMinutes = unknownDate ? null : Math.round((now - createdMs) / 60000);

  const freshness = ageMinutes === null ? 'unknown'
    : ageMinutes <= 60 ? 'fresh'
    : ageMinutes <= 1440 ? 'today'
    : 'stale';

  const isNew = unknownDate ? true
    : prevPollAt == null ? ageMinutes <= 1440
    : createdMs > prevPollAt - GRACE_MS;

  const priority = !isNew ? 'min' : freshness === 'fresh' ? 'high' : 'default';

  out.push({
    topic_id: t.id,
    title: t.title,
    url: 'https://community.n8n.io/t/' + t.slug + '/' + t.id,
    age_minutes: ageMinutes,
    freshness,
    is_new: isNew,
    priority,
    tags: isNew ? 'briefcase' : 'mag',
    notify_title: isNew
      ? 'n8n jobs: ' + freshness + ' (' + humanAge(ageMinutes) + ')'
      : 'n8n jobs: re-listed (' + humanAge(ageMinutes) + ')',
    replies: Math.max(0, (t.posts_count == null ? 1 : t.posts_count) - 1),
  });
}

const ids = Object.keys(store.seenTopics);
if (ids.length > MAX_ENTRIES) {
  ids.sort((a, b) => store.seenTopics[a] - store.seenTopics[b])
     .slice(0, ids.length - MAX_ENTRIES)
     .forEach(k => delete store.seenTopics[k]);
}

// ── notify ─────────────────────────────────────────────────────────────────
// Each posting is sent individually and the state file is only written once all
// sends have succeeded. A posting that failed to send stays OUT of the seen-set,
// so the next run re-detects it — the same "a failed notification releases the
// topic" behaviour the n8n copy has.
let failed = 0;
for (const p of out) {
  const body = `${p.title}\n\n${p.replies} replies\n${p.url}`;
  if (DRY_RUN) {
    console.log(`[dry-run] ${p.priority.padEnd(7)} ${p.notify_title} — ${p.title}`);
    continue;
  }
  try {
    const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
      method: 'POST',
      headers: {
        Title: p.notify_title,
        Priority: p.priority,
        Tags: p.tags,
        Click: p.url,
      },
      body,
    });
    if (!r.ok) throw new Error('ntfy HTTP ' + r.status);
    console.log(`sent [${p.priority}] ${p.title}`);
  } catch (e) {
    console.error(`FAILED to notify ${p.topic_id}: ${e.message} — releasing it for the next run`);
    delete store.seenTopics[String(p.topic_id)];
    failed++;
  }
}

if (!DRY_RUN) writeFileSync(STATE_FILE, JSON.stringify(store));

if (firstRun) {
  console.log(`first run: seeded ${Object.keys(store.seenTopics).length} topics, deliberately silent`);
} else if (out.length === 0) {
  console.log(`nothing new (${topics.length} topics on the board, ${Object.keys(store.seenTopics).length} seen)`);
} else {
  console.log(`${out.length} new, ${failed} failed to send`);
}

// A send failure is a real fault worth GitHub's failure mail, but the state file
// has already been written with those topics released, so the retry is automatic.
if (failed > 0) process.exit(1);
