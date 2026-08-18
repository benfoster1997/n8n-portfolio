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
 * Run:  node test/logic-test.mjs                       (everything)
 *       node test/logic-test.mjs 01-invoice-extractor  (one workflow only)
 *
 * The optional filter exists because a test count is only meaningful next to the
 * thing it covers. The repo total describes the repo; a gig selling ONE workflow
 * needs that workflow's own number, and quoting the repo-wide figure there
 * overstates the deliverable several-fold. The whole file still executes under a
 * filter — a failure anywhere still fails the run — but only the selected section
 * is printed and counted, so any number on a listing can be reproduced by a buyer
 * running the command printed beside it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Optional single-section filter, e.g. `node test/logic-test.mjs 01-invoice-extractor`.
const only = process.argv[2] || null;
let current = null;
const shown = () => !only || current === only;

// Suppress output from sections the filter excludes. Bound first so the summary
// at the bottom can still print unconditionally.
const out = console.log.bind(console);
console.log = (...args) => { if (shown()) out(...args); };

/** Start a section. The first word is the id the filter matches on. */
function section(title) {
  current = title.trim().split(/\s/)[0];
  console.log(`\n${title}\n`);
}

let passed = 0;     // reported — the selected section, or everything when unfiltered
let failed = 0;
let anyFailed = 0;  // every failure anywhere, so a filter can never hide a broken repo

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) anyFailed++;
  if (!shown()) return;
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`); }
}

function assert(label, condition, detail = '') {
  if (!condition) anyFailed++;
  if (!shown()) return;
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
section('01-invoice-extractor — Validate & Normalise');
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
section('02-enquiry-triage — Score & Prioritise');
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
section('03-reliable-pipeline — fingerprint, idempotency, DLQ, canary');
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
section('05-jobs-board-monitor — diffing, filtering, DLQ, canary');

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

// `[FOR HIRE]` is only the tidiest shape of the advert. Measured against 150
// real titles on 17 Aug, the same people also write "Available:", "[Available]",
// "Available for Remote Work" and "Senior engineer available for n8n work" —
// and one of those reached the phone that morning.
const store3c = { seenTopics: {} };
const availables = runNode(selectCode, listing(
  topic(25, 'Available: AI Automation Engineer — n8n + LLM + WhatsApp (Shipped, Production)'),
  topic(26, '[Available] AI Automation Engineer & n8n Specialist $15-25/hr'),
  topic(27, 'N8n Automation Developer Available for Freelance Work'),
  topic(28, 'Senior engineer available for n8n work — AI agents, migrations'),
  topic(29, 'Especialista en n8n — Disponible para proyectos freelance'),
  topic(40, '[Offering Assistance] YIS Agency: Free or Low-Cost n8n Automations'),
  topic(41, 'Need an n8n workflow built for order intake'),
), {}, store3c);
check('every shape of "available" advert is dropped', availables.map(r => r.json.topic_id), [41]);

// The asymmetry that decides the ambiguous cases: dropping a buyer loses a job
// silently, keeping an advert costs one line in a list. So a buyer's own words
// override the filter, and the override can only ever cost an extra
// notification. "Anyone available to fix a broken webhook?" is a customer.
const store3d = { seenTopics: {} };
const buyersSayingAvailable = runNode(selectCode, listing(
  topic(42, 'Anyone available to fix a broken webhook? Paid.'),
  topic(43, 'n8n developer position available — remote, £400/day'),
  topic(44, 'Offering $2,000 for a complete n8n build'),
  topic(45, 'Budget available for ongoing n8n work'),
  topic(46, 'Paid opportunity available for an n8n expert'),
), {}, store3d);
check('a buyer who happens to say "available" is never dropped',
  buyersSayingAvailable.map(r => r.json.topic_id), [42, 43, 44, 45, 46]);

// ...but the override must not reach a BRACKETED seller tag. On 18 Aug at 07:20,
// `[For Hire] Free n8n Automation Build - Looking for 2-3 Beta Businesses` reached
// the phone at high priority: SELF_PROMO matched "For Hire", BUYER_ASKING matched
// "Looking for", and the override let it through. The seller was looking for
// CUSTOMERS - the one direction the buyer regex cannot read.
const store3f = { seenTopics: {} };
const taggedSeller = runNode(selectCode, listing(
  topic(50, '[For Hire] Free n8n Automation Build \u2014 Looking for 2-3 Beta Businesses'),
  topic(51, '[FOR HIRE] Free n8n automation audit \u2014 I will find one improvement in your process'),
  topic(52, '[Available for Hire] n8n Automation Architect \u2014 anyone needing Voice AI'),
  topic(53, 'Need an n8n workflow built for order intake'),
), {}, store3f);
check('a bracketed seller tag is not rescued by the buyer override',
  taggedSeller.map(r => r.json.topic_id), [53]);

// The tag rule must never touch the board's BUYER conventions. Measured on 179
// live titles: 57 carry a seller tag, 12 carry one of these, and `[Freelance]` is
// used by both sides - which is why it appears on neither list.
const store3g = { seenTopics: {} };
const taggedBuyer = runNode(selectCode, listing(
  topic(54, '[HIRING] N8N AI Automation Developer (Remote)'),
  topic(55, '[PAID JOB] German-speaking n8n Expert for Advanced Telegram Bot'),
  topic(56, '[recruitment] Looking for long-term AI Agent / Automation collaborators'),
  topic(57, '[Freelance] Looking for an n8n + Python Instructor (Remote, DE/EN)'),
), {}, store3g);
check('every bracketed BUYER tag survives the tag rule',
  taggedBuyer.map(r => r.json.topic_id), [54, 55, 56, 57]);

// `freelance`, `specialist` and `developer` occur on both sides of this board in
// roughly equal numbers, so neither list may use them as evidence.
const store3e = { seenTopics: {} };
const bothSides = runNode(selectCode, listing(
  topic(47, 'Looking for skilled n8n freelancers'),
  topic(48, '🚀 Hiring: Freelance AI Automation Engineer (Remote)'),
  topic(49, '[Freelance] Looking for an n8n + Python Instructor (Remote, DE/EN)'),
), {}, store3e);
check('buyers using the word freelance all survive', bothSides.map(r => r.json.topic_id), [47, 48, 49]);

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

console.log('\n  re-listings vs genuinely new posts:\n');

// Discourse orders the listing by ACTIVITY, not by creation. A month-old thread
// that collects one reply re-enters the top thirty and looks exactly like a new
// post to a pure diff. On 15 Aug that delivered a 269-day-old thread as a
// full-priority alert, twice in one day.
const store4b = { seenTopics: {}, lastPollAt: Date.now() - 10 * 60000 };
const mixed = runNode(selectCode, listing(
  topic(33, 'Month-old thread someone just replied to', { ageMinutes: 33 * 1440 }),
  topic(34, 'Posted four minutes ago', { ageMinutes: 4 }),
), {}, store4b);
check('a re-listed old thread is not treated as new', mixed[0].json.is_new, false);
check('and is downgraded so it never buzzes', mixed[0].json.priority, 'min');
check('and says re-listed rather than claiming freshness', mixed[0].json.notify_title, 'n8n jobs: re-listed (33d old)');
check('but it is still delivered, not dropped', mixed.length, 2);
check('a post made since the last poll is new', mixed[1].json.is_new, true);
check('and a minutes-old one still comes through at high priority', mixed[1].json.priority, 'high');

// The gap this must not reintroduce: the 14 Aug execution log has gaps of 82 and
// 151 minutes where the Mac slept. A flat "older than a day is stale" rule would
// silently swallow every post made over a sleeping weekend.
const store4c = { seenTopics: {}, lastPollAt: Date.now() - 24 * 3600000 };
const afterSleep = runNode(selectCode,
  listing(topic(35, 'Posted while the machine was asleep', { ageMinutes: 12 * 60 })), {}, store4c);
check('a post made during a 24-hour sleep is still new', afterSleep[0].json.is_new, true);
check('and is not silenced for being over a day old', afterSleep[0].json.priority, 'default');

// An unparseable date fails loud. A wrong buzz is cheaper than a silent drop.
const store4d = { seenTopics: {}, lastPollAt: Date.now() - 10 * 60000 };
const undated = runNode(selectCode,
  [{ json: { topic_list: { topics: [{ ...topic(36, 'No usable date'), created_at: 'not-a-date' }] } } }], {}, store4d);
check('a topic with an unreadable date is treated as new', undated[0].json.is_new, true);
check('and says so rather than inventing an age', undated[0].json.notify_title, 'n8n jobs: unknown (age unknown)');

// "387496m old" is unreadable on a lock screen; "269d old" is not.
// Polled a day ago, so the 12-hour-old post is genuinely new and the 269-day-old
// one is still a re-listing — both labels exercised in the same run.
const store4e = { seenTopics: {}, lastPollAt: Date.now() - 24 * 3600000 };
const ages = runNode(selectCode, listing(
  topic(37, 'Hours', { ageMinutes: 12 * 60 }),
  topic(38, 'Days', { ageMinutes: 269 * 1440 }),
), {}, store4e);
check('an age in hours reads as hours', ages[0].json.notify_title, 'n8n jobs: today (12h old)');
check('and a 269-day-old thread reads as days, not 387360 minutes', ages[1].json.notify_title, 'n8n jobs: re-listed (269d old)');

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

console.log('\n  the DLQ is bounded, and no longer 5.7KB per failure:\n');

// The shape n8n actually produces on an error output: the error object arrives
// on item.json, NOT on item.error. The fixture above sets item.error, which is
// why the old code looked correct in tests while production stored the whole
// object — stack trace included — and then stored it AGAIN inside payload.
// 5.2KB of a 5.7KB entry, rewritten into the database every ten minutes.
const realShape = {
  json: {
    timestamp: '2026-08-17T07:13:22.919+01:00',
    'Readable date': 'August 17th 2026, 7:13:22 am',
    error: {
      message: 'getaddrinfo ENOTFOUND community.n8n.io',
      name: 'Error',
      stack: 'Error: getaddrinfo ENOTFOUND community.n8n.io\n    at AxiosError.from (...)\n'.repeat(30),
    },
  },
};
const store9 = { seenTopics: {}, dlq: [] };
runNode(monDlqCode, [realShape], {}, store9);
const fetchEntry = store9.dlq[0];
check('the error is stored as a message, not the whole object',
  fetchEntry.error, 'getaddrinfo ENOTFOUND community.n8n.io');
check('a failed fetch keeps no payload — the trigger output is no use to anyone',
  fetchEntry.payload, null);
check('and is not claimed to be replayable, because there is nothing to re-send',
  fetchEntry.replayable, false);
assert(`the whole entry is now small (${JSON.stringify(fetchEntry).length} bytes)`,
  JSON.stringify(fetchEntry).length < 400,
  'A fetch failure used to cost 5,726 bytes, most of it a stack trace stored twice.');

// A failed NOTIFICATION is the case that genuinely can be sent again, so it
// keeps its payload — minus the duplicated error.
const store10 = { seenTopics: { '888': Date.now() }, dlq: [] };
const notifyEntry = runNode(monDlqCode, [{
  json: { topic_id: 888, title: 'Real job', url: 'https://community.n8n.io/t/x/888', error: { message: 'ECONNREFUSED', stack: 'x'.repeat(2000) } },
}], {}, store10)[0].json;
check('a failed notification stays replayable', notifyEntry.replayable, true);
check('and keeps what it needs to be re-sent', notifyEntry.payload.title, 'Real job');
assert('but not a second copy of its own error',
  !('error' in notifyEntry.payload),
  'The error is already on the entry; keeping it twice is what made these huge.');

// Unbounded growth is finding #3 of the audit in this repo — "does anything
// accumulate forever?" — and this queue had neither a TTL nor a cap while the
// seen-set three nodes away had both.
const old = (days) => ({ failed_at: new Date(Date.now() - days * 86400000).toISOString(), error: 'old' });
const store11 = { seenTopics: {}, dlq: [old(45), old(31), old(29), old(1)] };
runNode(monDlqCode, [{ json: {}, error: { message: 'fresh' } }], {}, store11);
check('failures past 30 days are evicted', store11.dlq.length, 3);
check('and the recent ones survive', store11.dlq.map(e => e.error), ['old', 'old', 'fresh']);

const store12 = { seenTopics: {}, dlq: Array.from({ length: 60 }, () => old(0)) };
runNode(monDlqCode, [{ json: {}, error: { message: 'newest' } }], {}, store12);
check('and the queue is hard-capped', store12.dlq.length, 50);
check('keeping the newest, not the oldest', store12.dlq[store12.dlq.length - 1].error, 'newest');

// Dropping the only record of a failure is precisely what this queue exists to
// prevent, so an unreadable date is kept and left to the cap.
const store13 = { seenTopics: {}, dlq: [{ failed_at: 'not-a-date', error: 'undated' }] };
runNode(monDlqCode, [{ json: {}, error: { message: 'fresh' } }], {}, store13);
check('an entry with an unreadable date is kept, not silently discarded',
  store13.dlq.map(e => e.error), ['undated', 'fresh']);

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

console.log('\n  waking from sleep — a blip vs a broken fetch:\n');

// Over the weekend of 15-17 Aug three polls fired as the Mac woke, all three hit
// `getaddrinfo ENOTFOUND community.n8n.io` before the network was back, and all
// three went quietly into the DLQ. Nothing said so. The monitor looked identical
// to a monitor that was working and had simply found nothing.
//
// Elapsed time cannot separate the two cases on a laptop, because a closed lid
// produces exactly the same silence as a dead monitor. Consecutive FAILURES can:
// they only accumulate while the machine is awake enough to run the workflow.

const store8 = { seenTopics: {}, dlq: [] };
const fetchFail = () => runNode(monDlqCode,
  [{ json: {}, error: { message: 'getaddrinfo ENOTFOUND community.n8n.io' } }], {}, store8);

const firstFail = fetchFail();
check('a failed fetch is recorded as the fetch leg, not the notify leg', firstFail[0].json.failed_leg, 'fetch');
check('and starts the streak at one', store8.fetchFailStreak, 1);
fetchFail(); fetchFail();
check('three failures in a row count as three', store8.fetchFailStreak, 3);

// A failed NOTIFICATION is a different fault and must not inflate the streak —
// it means the board was reached fine and ntfy was the thing that broke.
const notifyFail = runNode(monDlqCode,
  [{ json: { topic_id: 777, title: 'Real job' }, error: { message: 'ECONNREFUSED' } }], {}, store8);
check('a failed notification is the notify leg', notifyFail[0].json.failed_leg, 'notify');
check('and leaves the fetch streak alone', store8.fetchFailStreak, 3);

// Reaching Select New Postings at all means the board answered.
runNode(selectCode, listing(topic(60, 'Board is back')), {}, store8);
check('one successful poll clears the streak', store8.fetchFailStreak, 0);

const fetchDown = runNode(monCanaryCode, [{ json: {} }], {},
  { lastPollAt: Date.now() - 5 * 60000, fetchFailStreak: 3 })[0].json;
check('three consecutive failures read as a broken fetch', fetchDown.fetch_broken, true);
check('and the verdict says which fault it is', fetchDown.verdict,
  'FETCH FAILING — 3 polls in a row could not reach the board');
check('while polling itself is not reported as stalled', fetchDown.silent, false);

const blip = runNode(monCanaryCode, [{ json: {} }], {},
  { lastPollAt: Date.now() - 5 * 60000, fetchFailStreak: 2 })[0].json;
check('two failures is a blip on waking, not a fault', blip.fetch_broken, false);

// The case that keeps the alert leg usable: a Mac that was simply off all
// weekend is silent, but nothing failed, so it must never read as broken.
const wasOff = runNode(monCanaryCode, [{ json: {} }], {}, { lastPollAt: Date.now() - 40 * 3600000 })[0].json;
check('a machine that was off is silent', wasOff.silent, true);
check('but not a broken fetch', wasOff.fetch_broken, false);

console.log('\n  the alert leg — wired to the unambiguous fault only:\n');

// The canary spent its first weeks unable to reach anything: Raise Alert was a
// terminal Set node. It now ends at an ntfy call, but only for `fetch_broken`.
// Wiring it to `silent` instead would buzz every morning the lid had been shut,
// and it could never catch a deactivated workflow anyway — the canary runs
// inside the thing it is watching.
const wf5 = JSON.parse(readFileSync(join(root, WF5), 'utf8'));
const node5 = (name) => wf5.nodes.find(n => n.name === name);
const targets = (name, output = 0) =>
  (wf5.connections[name]?.main?.[output] ?? []).map(c => c.node);

check('the canary gate asks whether the fetch is broken',
  node5('Fetch Broken?').parameters.conditions.conditions[0].leftValue, '={{ $json.fetch_broken }}');
check('and the alert path now ends at a notification', targets('Raise Alert'), ['Notify Canary']);
check('reached from the true branch of the gate', targets('Fetch Broken?', 0), ['Raise Alert']);
check('while the healthy branch still goes nowhere', targets('Healthy'), []);

// The trap this avoids: the DLQ reads an entry with no topic_id as a failed
// FETCH and increments the streak. Routing the alert's own failures there would
// let a broken alert manufacture the fault it exists to report.
assert('a failed alert cannot feed the DLQ and inflate the streak',
  !targets('Notify Canary', 0).includes('Dead Letter Queue') &&
  !targets('Notify Canary', 1).includes('Dead Letter Queue'),
  'The alert must never be able to report a fault it caused itself.');

const alertNode = node5('Notify Canary');
check('the alert retries as far as n8n allows', alertNode.maxTries, 5);
check('and waits as long as n8n allows', alertNode.waitBetweenTries, 5000);

const alerting = runNode(monCanaryCode, [{ json: {} }], {},
  { lastPollAt: Date.now() - 5 * 60000, fetchFailStreak: 4, lastFetchFailAt: Date.now() - 60000 })[0].json;
assert('the canary builds its own ntfy URL', /^https:\/\/ntfy\.sh\/.+/.test(alerting.notify_url));
check('and asks for a priority that actually buzzes', alerting.notify_priority, 'high');
assert('and names the fault on the lock screen', /unreachable/i.test(alerting.notify_title));

// Two Code nodes, no shared module between them. If one topic is ever changed
// and the other is not, the alert silently goes to a topic nobody is subscribed
// to — which looks exactly like no alert at all.
const topicOf = (code) => code.match(/const NTFY_TOPIC = '([^']+)';/)?.[1];
check('both legs send to the same topic', topicOf(monCanaryCode), topicOf(selectCode));
assert('and the canary leg has not leaked a real one either',
  /CHANGE-ME/.test(monCanaryCode),
  'Replace the placeholder locally, never in the committed file.');

// n8n clamps both retry settings at runtime, in workflow-execute.js:
//   maxTries         = Math.min(5, Math.max(2, maxTries || 3))
//   waitBetweenTries = Math.min(5000, Math.max(0, waitBetweenTries || 1000))
// So the widest window the node itself can cover is 5 tries 5s apart, about 20
// seconds. Writing 30000 here would look like half a minute of patience and
// silently behave as five seconds, which is exactly the kind of change that
// reads as a fix and is not one.
const fetchNode = JSON.parse(readFileSync(join(root, WF5), 'utf8'))
  .nodes.find(n => n.name === 'Fetch Jobs Board');
check('the fetch retries', fetchNode.retryOnFail, true);
check('as many times as n8n allows', fetchNode.maxTries, 5);
check('as far apart as n8n allows', fetchNode.waitBetweenTries, 5000);
assert('and no further, because n8n silently clamps anything larger',
  fetchNode.maxTries <= 5 && fetchNode.waitBetweenTries <= 5000,
  'Values above the clamp read as patience the workflow does not actually have.');

const store7 = {};
const rec = runNode(recordCode, [{ json: { topic_id: 1 } }], {}, store7);
check('a delivered notification is timestamped', typeof store7.lastNotifyAt, 'number');
check('and counted', store7.notifyCount, 1);
check('and the item keeps its topic', rec[0].json.topic_id, 1);

console.log('\n  the sticky notes actually render:\n');

// Every note was written with literal backslash-n instead of real newlines, so
// each one rendered as a single unbroken paragraph and the `##` headings never
// became headings. Invisible in the JSON, obvious the moment you open the canvas.
const stickies = JSON.parse(readFileSync(join(root, WF5), 'utf8'))
  .nodes.filter(n => n.type.includes('stickyNote'));
check('all four sticky notes are still there', stickies.length, 4);
for (const note of stickies) {
  assert(`${note.name} uses real newlines, not the two characters \\ and n`,
    !note.parameters.content.includes('\\n'),
    'A literal backslash-n renders as text and flattens the whole note.');
  assert(`${note.name} still opens with a markdown heading`,
    /^##\s/.test(note.parameters.content),
    'The heading is what makes the note readable at a glance on the canvas.');
}

// An ntfy topic is effectively a password: anyone who knows the string can read
// the notifications. This repo is public, so committing a real one leaks it.
assert('the ntfy topic is still a placeholder, not a real one committed by accident',
  /CHANGE-ME/.test(selectCode),
  'Replace the placeholder locally, never in the committed file.');

// ---------------------------------------------------------------------------
out(`\n${'-'.repeat(52)}`);
out(`${passed} passed, ${failed} failed`);
out(`${'-'.repeat(52)}\n`);
// Exit on ANY failure, including one in a section the filter hid.
process.exit(anyFailed === 0 ? 0 : 1);
