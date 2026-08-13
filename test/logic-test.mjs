/**
 * Tests the deterministic Code nodes in both workflows.
 *
 * The model-dependent nodes need an API key; these do not. The Code nodes are
 * where the arithmetic, date handling and routing rules live — the parts where a
 * bug is silent and expensive — so they are worth testing on their own.
 *
 * The node source is read out of workflow.json itself, so these tests exercise
 * exactly the code that runs in n8n. They cannot drift from it.
 *
 * Run:  node test/logic-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`); }
}

function assert(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? '\n          ' + detail : ''}`); }
}

/** Pull a Code node's jsCode straight out of the workflow definition. */
function loadNodeCode(workflowPath, nodeName) {
  const wf = JSON.parse(readFileSync(join(root, workflowPath), 'utf8'));
  const node = wf.nodes.find(n => n.name === nodeName);
  if (!node) throw new Error(`Node "${nodeName}" not found in ${workflowPath}`);
  return node.parameters.jsCode;
}

/**
 * Run a Code node body with n8n's globals stubbed.
 * items       - what $input.all() returns
 * nodeOutputs - what $('Node Name').all() / .item returns
 */
function runNode(jsCode, items, nodeOutputs = {}, staticData = null) {
  const $input = { all: () => items };
  const $ = (name) => {
    const data = nodeOutputs[name] || [];
    return {
      all: () => data,
      // Mirrors n8n: itemMatching(i) resolves the paired input item by index.
      itemMatching: (i) => data[i],
      get item() { return data[runNode._pairedIndex] ?? data[0]; },
    };
  };
  const $getWorkflowStaticData = () => staticData;
  const fn = new Function('$input', '$', '$getWorkflowStaticData', `${jsCode}`);
  return fn($input, $, $getWorkflowStaticData);
}

// ---------------------------------------------------------------------------
console.log('\n01-invoice-extractor — Validate & Normalise\n');
// ---------------------------------------------------------------------------

const validateCode = loadNodeCode('01-invoice-extractor/workflow.json', 'Validate & Normalise');

// Stand in for what the extractor returns for the three sample documents.
const extracted = [
  { // clean invoice, arithmetic reconciles
    supplier_name: 'Northgate Supplies Ltd', document_reference: 'NG-2026-0417',
    issue_date: '14/07/2026', currency: 'GBP',
    net_amount: 268.70, vat_amount: 53.74, gross_amount: 322.44,
  },
  { // till receipt: no reference, no net stated
    supplier_name: 'Cafe Rosetta', document_reference: '',
    issue_date: '09 Jul 2026', currency: 'GBP',
    net_amount: 0, vat_amount: 2.06, gross_amount: 12.35,
  },
  { // euro invoice, prose layout
    supplier_name: 'Meridian Cloud Services', document_reference: 'MER-88213',
    issue_date: '1 July 2026', currency: 'EUR',
    net_amount: 247.20, vat_amount: 49.44, gross_amount: 296.64,
  },
];

const sources = extracted.map((_, i) => ({ json: { source: `doc-${i}` } }));
const validated = runNode(validateCode, extracted.map(json => ({ json })), {
  'Load Sample Documents': sources,
});

check('three documents in, three out', validated.length, 3);

const [inv, receipt, euro] = validated.map(r => r.json);

// Clean invoice
check('clean invoice passes validation', inv.review_required, false);
check('UK date parsed day-first', inv.date, '2026-07-14');
check('net preserved', inv.net, 268.70);

// Till receipt
check('receipt is flagged', receipt.review_required, true);
check('net derived from gross minus VAT', receipt.net, 10.29);
assert('derivation is explained',
  receipt.review_reasons.some(r => /derived/i.test(r)),
  `reasons: ${JSON.stringify(receipt.review_reasons)}`);
assert('missing reference is reported',
  receipt.review_reasons.some(r => /reference/i.test(r)),
  `reasons: ${JSON.stringify(receipt.review_reasons)}`);
check('spelled-out date parsed', receipt.date, '2026-07-09');

// Euro invoice
check('euro invoice reconciles', euro.review_required, false);
check('currency preserved', euro.currency, 'EUR');
check('long-form date parsed', euro.date, '2026-07-01');

// --- Edge cases the samples do not cover -----------------------------------
console.log('\n  edge cases:\n');

const edges = runNode(validateCode, [
  { json: { supplier_name: 'Broken Totals Ltd', document_reference: 'X1', issue_date: '01/02/2026', currency: 'GBP', net_amount: 100, vat_amount: 20, gross_amount: 999 } },
  { json: { supplier_name: 'Odd Rate Ltd', document_reference: 'X2', issue_date: '01/02/2026', currency: 'GBP', net_amount: 100, vat_amount: 13, gross_amount: 113 } },
  { json: { supplier_name: '', document_reference: 'X3', issue_date: 'not a date', currency: 'GBP', net_amount: 10, vat_amount: 2, gross_amount: 12 } },
  { json: { supplier_name: 'Zero VAT Ltd', document_reference: 'X4', issue_date: '01/02/2026', currency: 'GBP', net_amount: 50, vat_amount: 0, gross_amount: 50 } },
], { 'Load Sample Documents': [] });

const [broken, oddRate, noSupplier, zeroVat] = edges.map(r => r.json);

assert('mismatched totals caught',
  broken.review_required && broken.review_reasons.some(r => /reconcile/i.test(r)),
  JSON.stringify(broken.review_reasons));
assert('implausible VAT rate caught',
  oddRate.review_reasons.some(r => /Unusual VAT rate/i.test(r)),
  JSON.stringify(oddRate.review_reasons));
assert('unreadable date caught',
  noSupplier.review_reasons.some(r => /Unreadable date/i.test(r)),
  JSON.stringify(noSupplier.review_reasons));
assert('missing supplier caught',
  noSupplier.review_reasons.some(r => /Supplier name missing/i.test(r)),
  JSON.stringify(noSupplier.review_reasons));
check('date-first ambiguity resolved as UK (1 Feb, not 2 Jan)', broken.date, '2026-02-01');
check('legitimate zero-VAT invoice is not flagged', zeroVat.review_required, false);

// --- Shape handling --------------------------------------------------------
// Regression: the Information Extractor nests its result under `output`.
// Reading item.json directly returned undefined for every field, and the run
// silently flagged all three documents as unreadable instead of extracting them.
console.log('\n  extractor output shape:\n');

const wrapped = runNode(validateCode, [{
  json: {
    output: {
      supplier_name: 'Northgate Supplies Ltd', document_reference: 'NG-2026-0417',
      issue_date: '14/07/2026', currency: 'GBP',
      net_amount: 268.70, vat_amount: 53.74, gross_amount: 322.44,
    },
  },
}], { 'Load Sample Documents': [] })[0].json;

check('nested {output:{...}} is read correctly', wrapped.supplier, 'Northgate Supplies Ltd');
check('nested payload passes validation', wrapped.review_required, false);
check('nested amounts parsed', wrapped.gross, 322.44);
check('flat payload still works', inv.supplier, 'Northgate Supplies Ltd');

// ---------------------------------------------------------------------------
console.log('\n02-enquiry-triage — Score & Prioritise\n');
// ---------------------------------------------------------------------------

const scoreCode = loadNodeCode('02-enquiry-triage/workflow.json', 'Score & Prioritise');

const enquirySources = [{ json: { from: 'l.hartley@brightpath-dental.co.uk', subject: 'Automating our appointment reminders' } }];

const strongLead = runNode(scoreCode, [{
  json: {
    contact_name: 'Louise Hartley', organisation: 'Brightpath Dental',
    problem_summary: 'Reception staff phone patients manually to remind them of appointments.',
    systems_mentioned: 'Dentally, Twilio',
    budget_stated: 2000, deadline_mentioned: 'end of September', manual_hours_claimed: 15,
  },
}], { 'Load Sample Enquiries': enquirySources })[0].json;

// 40 (budget>=2k) + 23 (15h x 1.5 = 22.5, rounds to 23) + 15 (deadline) + 10 (systems) + 5 (identified) = 93
check('strong lead scores 93', strongLead.lead_score, 93);
check('strong lead is priority A', strongLead.priority, 'A — reply today');
check('named systems parsed into a list', strongLead.systems_list, ['Dentally', 'Twilio']);
check('nothing blocking a quote', strongLead.scoping_blockers, []);
check('original sender carried through', strongLead.original_from, 'l.hartley@brightpath-dental.co.uk');

const vagueLead = runNode(scoreCode, [{
  json: {
    contact_name: '', organisation: '',
    problem_summary: 'Wants some automation.',
    systems_mentioned: '', budget_stated: 0, deadline_mentioned: '', manual_hours_claimed: 0,
  },
}], { 'Load Sample Enquiries': enquirySources })[0].json;

check('vague enquiry scores 0', vagueLead.lead_score, 0);
check('vague enquiry is priority C', vagueLead.priority, 'C — reply when convenient');
check('all three blockers raised', vagueLead.scoping_blockers.length, 3);

const painNoBudget = runNode(scoreCode, [{
  json: {
    contact_name: 'Sam', organisation: 'Acme',
    problem_summary: 'Manual data entry.',
    systems_mentioned: 'Xero', budget_stated: 0, deadline_mentioned: '', manual_hours_claimed: 40,
  },
}], { 'Load Sample Enquiries': enquirySources })[0].json;

// 0 (no budget) + 25 (pain, capped) + 0 + 10 (systems) + 5 (identified) = 40
check('high pain without budget still reaches B', painNoBudget.priority, 'B — reply within 48h');
assert('pain points are capped at 25',
  painNoBudget.lead_score === 40,
  `score was ${painNoBudget.lead_score}, expected 40 — cap may not be applied`);
assert('missing budget flagged as a blocker',
  painNoBudget.scoping_blockers.some(b => /budget/i.test(b)),
  JSON.stringify(painNoBudget.scoping_blockers));

// Same nesting regression as the invoice workflow.
const wrappedLead = runNode(scoreCode, [{
  json: {
    output: {
      contact_name: 'Louise Hartley', organisation: 'Brightpath Dental',
      problem_summary: 'Manual appointment reminders.',
      systems_mentioned: 'Dentally, Twilio',
      budget_stated: 2000, deadline_mentioned: 'end of September', manual_hours_claimed: 15,
    },
  },
}], { 'Load Sample Enquiries': enquirySources })[0].json;

check('nested {output:{...}} scores identically', wrappedLead.lead_score, 93);
check('nested payload keeps systems list', wrappedLead.systems_list, ['Dentally', 'Twilio']);

// ---------------------------------------------------------------------------
console.log('\n03-reliable-pipeline — fingerprint, idempotency, DLQ, canary\n');
// ---------------------------------------------------------------------------

const WF3 = '03-reliable-pipeline/workflow.json';
const fpCode     = loadNodeCode(WF3, 'Normalise & Fingerprint');
const gateCode   = loadNodeCode(WF3, 'Idempotency Gate');
const dlqCode    = loadNodeCode(WF3, 'Dead Letter Queue');
const canaryCode = loadNodeCode(WF3, 'Canary Check');

const ev = (over = {}) => ({ json: { event_id: 'evt_1', type: 'deal.stage_changed', deal: 'Acme', from: 'A', to: 'B', value_gbp: 100, ...over } });

const fps = runNode(fpCode, [ev(), ev(), ev({ to: 'C' }), ev({ event_id: 'different_id' })]);
check('identical content produces identical fingerprints', fps[0].json.fingerprint, fps[1].json.fingerprint);
assert('changed content produces a different fingerprint', fps[0].json.fingerprint !== fps[2].json.fingerprint);
check('a new event_id alone does NOT change the fingerprint', fps[0].json.fingerprint, fps[3].json.fingerprint);

// Webhook payloads arrive nested under .body — a classic source of silent breakage.
const wrappedWebhook = runNode(fpCode, [{ json: { body: { type: 'deal.stage_changed', deal: 'Acme', from: 'A', to: 'B', value_gbp: 100 } } }]);
check('webhook .body payloads are unwrapped', wrappedWebhook[0].json.fingerprint, fps[0].json.fingerprint);

console.log('\n  idempotency:\n');

let store = {};
const batch = runNode(fpCode, [ev({ deal: 'One' }), ev({ deal: 'Two' }), ev({ deal: 'One' }), ev({ deal: 'Three' }), ev({ deal: 'Two' })]);
const gated = runNode(gateCode, batch, {}, store);
const fresh = gated.filter(r => !r.json.is_duplicate);
const dupes = gated.filter(r => r.json.is_duplicate);
check('5 events with 2 repeats yields 3 new', fresh.length, 3);
check('and 2 suppressed duplicates', dupes.length, 2);
assert('duplicates report when they were first seen', typeof dupes[0].json.first_seen_at === 'string');

const secondRun = runNode(gateCode, runNode(fpCode, [ev({ deal: 'One' })]), {}, store);
check('re-running a past event later is still a duplicate', secondRun[0].json.is_duplicate, true);

// TTL eviction: age an entry past 7 days and it should be treated as new again.
const aged = {};
const oneFp = runNode(fpCode, [ev({ deal: 'Ancient' })]);
runNode(gateCode, oneFp, {}, aged);
Object.keys(aged.seen).forEach(k => { aged.seen[k] = Date.now() - 8 * 24 * 60 * 60 * 1000; });
const afterTtl = runNode(gateCode, oneFp, {}, aged);
check('an event older than the 7-day TTL is treated as new', afterTtl[0].json.is_duplicate, false);

console.log('\n  dead letter queue:\n');

const dlqStore = { seen: {}, dlq: [] };
const failingEvent = runNode(fpCode, [ev({ deal: 'Fails' })]);
runNode(gateCode, failingEvent, {}, dlqStore);
assert('the failing event is marked seen before delivery is attempted',
  Object.keys(dlqStore.seen).length === 1);

const dlqRows = runNode(dlqCode,
  [{ json: { error: { message: 'connect ECONNREFUSED' } } }],
  { 'Idempotency Gate': [{ json: failingEvent[0].json }] },
  dlqStore);

check('the failure is captured in the DLQ', dlqStore.dlq.length, 1);
check('with the error message', dlqRows[0].json.error, 'connect ECONNREFUSED');
assert('and the full payload needed to replay it', !!dlqRows[0].json.payload.fingerprint);
// The interaction that is easy to get wrong: if the fingerprint stayed in the
// seen-set, replaying the event would be silently suppressed as a duplicate and
// the message would be lost for good.
check('the fingerprint is RELEASED so a replay is not swallowed',
  Object.keys(dlqStore.seen).length, 0);
const replay = runNode(gateCode, failingEvent, {}, dlqStore);
check('replaying after a failure is accepted, not suppressed', replay[0].json.is_duplicate, false);

console.log('\n  audit trail pairing:\n');

// Regression: $('Node').item inside a .map() returns the SAME item every
// iteration, so every audit row was labelled with the first event's subject.
// The live run delivered the right two messages but logged both as "Brightpath
// Dental" — wrong provenance in the one artefact whose job is provenance.
const logCode = loadNodeCode(WF3, 'Log Delivered');
const twoSources = runNode(fpCode, [ev({ deal: 'Alpha' }), ev({ deal: 'Beta' })]);
const logRows = runNode(logCode,
  [{ json: { statusCode: 200 } }, { json: { statusCode: 200 } }],
  { 'Idempotency Gate': twoSources },
  { audit: [] });

check('two deliveries produce two audit rows', logRows.length, 2);
check('first row names the first event', logRows[0].json.subject, 'Alpha');
check('second row names the SECOND event, not the first', logRows[1].json.subject, 'Beta');
assert('the two rows carry different fingerprints',
  logRows[0].json.fingerprint !== logRows[1].json.fingerprint,
  `${logRows[0].json.fingerprint} vs ${logRows[1].json.fingerprint}`);

const dlqPaired = { seen: {}, dlq: [] };
const dlqRows2 = runNode(dlqCode,
  [{ json: { error: { message: 'e1' } } }, { json: { error: { message: 'e2' } } }],
  { 'Idempotency Gate': twoSources },
  dlqPaired);
check('DLQ rows are paired correctly too', dlqRows2.map(r => r.json.subject), ['Alpha', 'Beta']);

console.log('\n  canary:\n');

const never = runNode(canaryCode, [{ json: {} }], {}, {})[0].json;
check('a pipeline that has never delivered reads as silent', never.silent, true);
check('and reports no last delivery', never.last_delivery_at, null);

const healthy = runNode(canaryCode, [{ json: {} }], {}, { lastSuccessAt: Date.now() - 2 * 3600000, dlq: [] })[0].json;
check('a delivery 2 hours ago is healthy', healthy.silent, false);
check('and says so', healthy.verdict, 'healthy');

const stale = runNode(canaryCode, [{ json: {} }], {}, { lastSuccessAt: Date.now() - 30 * 3600000, dlq: [1, 2] })[0].json;
check('30 hours of silence trips the alarm', stale.silent, true);
check('and the DLQ depth is surfaced with it', stale.dlq_depth, 2);
// 26h not 24h, so a slightly late scheduled run does not cry wolf.
const justUnder = runNode(canaryCode, [{ json: {} }], {}, { lastSuccessAt: Date.now() - 25 * 3600000, dlq: [] })[0].json;
check('25 hours does not false-alarm', justUnder.silent, false);

// ---------------------------------------------------------------------------
console.log('\n05-jobs-board-monitor — diffing, filtering, DLQ, canary\n');

const WF5 = '05-jobs-board-monitor/workflow.json';
const selectCode    = loadNodeCode(WF5, 'Select New Postings');
const monDlqCode    = loadNodeCode(WF5, 'Dead Letter Queue');
const monCanaryCode = loadNodeCode(WF5, 'Canary Check');
const recordCode    = loadNodeCode(WF5, 'Record Notified');

/** Build a Discourse-shaped category listing. */
const listing = (...topics) => [{ json: { topic_list: { topics } } }];
const topic = (id, title, opts = {}) => ({
  id,
  title,
  slug: String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
  created_at: new Date(Date.now() - (opts.ageMinutes ?? 10) * 60000).toISOString(),
  posts_count: opts.posts ?? 1,
  pinned: opts.pinned ?? false,
});

// The cold-start bug this is built to avoid: a naive diff has an empty seen-set
// on the first run, decides all thirty existing topics are new, and fires thirty
// notifications at once.
const store1 = {};
const firstRun = runNode(selectCode, listing(topic(1, 'Need an n8n dev'), topic(2, 'Another job')), {}, store1);
check('the first run notifies nothing at all', firstRun.length, 1);
check('and reports the quiet path rather than looking broken', firstRun[0].json.none_new, true);
check('and seeds every topic it saw', Object.keys(store1.seenTopics).length, 2);

const monSecondPoll = runNode(selectCode, listing(topic(1, 'Need an n8n dev'), topic(3, 'Brand new job post')), {}, store1);
check('a genuinely new topic on the next poll is surfaced', monSecondPoll.map(r => r.json.topic_id), [3]);
check('and one already seen is not surfaced twice', monSecondPoll.length, 1);

console.log('\n  filtering:\n');

const store2 = { seenTopics: {} };
const pinnedOnly = runNode(selectCode, listing(topic(10, 'Read this before posting', { pinned: true })), {}, store2);
check('a pinned announcement never reaches the phone', pinnedOnly[0].json.none_new, true);

// 23 [FOR HIRE] topics went up in the first 13 days of August and drew zero
// replies between them. They are other freelancers, not buyers.
const store3 = { seenTopics: {} };
const promo = runNode(selectCode, listing(
  topic(20, '[FOR HIRE] Senior n8n developer, 5 years'),
  topic(21, 'Open to work - automation engineer'),
  topic(22, 'Available for hire, n8n specialist'),
  topic(23, 'Need someone to build an n8n workflow'),
), {}, store3);
check('freelancers advertising themselves are all dropped', promo.map(r => r.json.topic_id), [23]);

// "looking for work" is self-promotion; "looking for help" is a buyer. The
// distinction is one word and getting it wrong silently discards real jobs.
const store3b = { seenTopics: {} };
const nearMiss = runNode(selectCode, listing(topic(24, 'Looking for help syncing HubSpot into Sheets')), {}, store3b);
check('but "looking for help" is a buyer and survives the filter', nearMiss.map(r => r.json.topic_id), [24]);

console.log('\n  freshness — the only variable worth optimising:\n');

const store4 = { seenTopics: {} };
const monAged = runNode(selectCode, listing(
  topic(30, 'Job A', { ageMinutes: 12 }),
  topic(31, 'Job B', { ageMinutes: 300 }),
  topic(32, 'Job C', { ageMinutes: 5000 }),
), {}, store4);
check('a 12-minute-old post is flagged fresh', monAged[0].json.freshness, 'fresh');
check('a 5-hour-old post is today', monAged[1].json.freshness, 'today');
check('a 3-day-old post is stale', monAged[2].json.freshness, 'stale');
check('and the age is carried in minutes, not guessed at', monAged[0].json.age_minutes, 12);
check('reply count excludes the original post', monAged[0].json.replies, 0);
assert('the notification carries a working topic URL', monAged[0].json.url.startsWith('https://community.n8n.io/t/'));

console.log('\n  bounded state:\n');

const store5 = { seenTopics: { '900': Date.now() - 100 * 24 * 3600 * 1000, '901': Date.now() } };
runNode(selectCode, listing(), {}, store5);
check('a topic past the 90-day TTL is evicted', Object.keys(store5.seenTopics), ['901']);
assert('and every poll stamps lastPollAt for the canary', typeof store5.lastPollAt === 'number');

console.log('\n  dead letter queue:\n');

const store6 = { seenTopics: { '555': Date.now() }, dlq: [] };
const dlqOut = runNode(monDlqCode,
  [{ json: { topic_id: 555, title: 'Lost one', url: 'https://community.n8n.io/t/x/555' }, error: { message: 'ECONNREFUSED' } }],
  {}, store6);
check('a failed notification is captured, not dropped', store6.dlq.length, 1);
check('with the real error attached', store6.dlq[0].error, 'ECONNREFUSED');
check('and marked replayable', dlqOut[0].json.replayable, true);
// The interaction that is easy to get wrong: without releasing the topic, one
// thirty-second outage means that job is silently never seen again.
check('and the topic is released from the seen-set', store6.seenTopics['555'], undefined);
const redetect = runNode(selectCode, listing(topic(555, 'Lost one')), {}, store6);
check('so the next poll genuinely re-surfaces it', redetect.map(r => r.json.topic_id), [555]);

console.log('\n  canary — watches polling, not findings:\n');

// 2-3 addressable posts a month means weeks of no notifications is the EXPECTED
// state. A canary that alarmed on that would cry wolf constantly.
const quiet = runNode(monCanaryCode, [{ json: {} }], {},
  { lastPollAt: Date.now() - 30 * 60000, lastNotifyAt: Date.now() - 40 * 24 * 3600 * 1000 })[0].json;
check('forty days with no job found is still healthy', quiet.silent, false);
check('because it watches polls, not notifications', quiet.verdict, 'watching');

const stalled = runNode(monCanaryCode, [{ json: {} }], {}, { lastPollAt: Date.now() - 4 * 3600000 })[0].json;
check('but four hours without a poll is an alarm', stalled.silent, true);
const monJustUnder = runNode(monCanaryCode, [{ json: {} }], {}, { lastPollAt: Date.now() - 2.5 * 3600000 })[0].json;
check('while 2.5 hours does not false-alarm', monJustUnder.silent, false);
const neverPolled = runNode(monCanaryCode, [{ json: {} }], {}, {})[0].json;
check('a monitor that has never polled reads as silent', neverPolled.silent, true);

const store7 = {};
const rec = runNode(recordCode, [{ json: { topic_id: 1 } }], {}, store7);
check('a delivered notification is timestamped', typeof store7.lastNotifyAt, 'number');
check('and counted', store7.notifyCount, 1);
check('and the item keeps its topic', rec[0].json.topic_id, 1);

// An ntfy topic is effectively a password: anyone who knows the string can read
// the notifications. This repo is public, so committing a real one leaks it.
assert('the ntfy topic is still a placeholder, not a real one committed by accident',
  /CHANGE-ME/.test(selectCode),
  'Replace the placeholder locally, never in the committed file.');

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(failed === 0 ? 0 : 1);
