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
function runNode(jsCode, items, nodeOutputs = {}) {
  const $input = { all: () => items };
  const $ = (name) => {
    const data = nodeOutputs[name] || [];
    return {
      all: () => data,
      get item() { return data[runNode._pairedIndex] ?? data[0]; },
    };
  };
  const fn = new Function('$input', '$', `${jsCode}`);
  return fn($input, $);
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

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(failed === 0 ? 0 : 1);
