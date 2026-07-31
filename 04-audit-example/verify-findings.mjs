#!/usr/bin/env node
/**
 * Proves the audit findings in AUDIT-REPORT.md rather than asserting them.
 *
 * The code under test is read straight out of naive-workflow.json, so this
 * cannot drift from what actually runs in n8n. Same discipline as test/logic-test.mjs.
 *
 *   node 04-audit-example/verify-findings.mjs
 *
 * No API key, no install, no n8n instance needed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wf = JSON.parse(readFileSync(join(here, 'naive-workflow.json'), 'utf8'));

const node = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node not found: ${name}`);
  return n;
};

/** Run a Code node's real source against sample items. */
const runCodeNode = (name, items) => {
  const src = node(name).parameters.jsCode;
  const $input = { all: () => items.map((json) => ({ json })) };
  return new Function('$input', src)($input);
};

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const order = (over) => ({
  id: 'SO-1001',
  customer_name: 'Example Ltd',
  email: 'buyer@example.com',
  total: '980.00',
  line_items: [{ sku: 'SKU-1', quantity: 2 }],
  created_at: '2026-07-15T14:00:00+01:00',
  ...over,
});

console.log('\nnaive-workflow.json — verifying the audit findings\n');

// ── R3 — only the first line item survives ───────────────────────────────────
console.log('R3  Only the first line item is recorded  [LOSES DATA]');
{
  const rows = runCodeNode('Build Order Summary', [
    order({ line_items: [
      { sku: 'SKU-1', quantity: 2 },
      { sku: 'SKU-2', quantity: 5 },
      { sku: 'SKU-3', quantity: 1 },
    ] }),
  ]);
  const dropped = 5 + 1;
  check('a 3-line order produces exactly 1 row', rows.length === 1,
    `rows=${rows.length}, kept sku=${rows[0].json.sku} qty=${rows[0].json.qty}`);
  check(`${dropped} units are silently dropped`, rows[0].json.qty === 2,
    'the order total stays correct, so the sheet looks internally consistent');
}

// ── R4 — an empty basket kills the execution ─────────────────────────────────
console.log('\nR4  Unguarded payload shape  [STOPS SILENTLY]');
{
  let threw = null;
  try {
    runCodeNode('Build Order Summary', [order({ line_items: [] })]);
  } catch (e) {
    threw = e;
  }
  check('an order with no line items throws', threw !== null,
    threw ? `${threw.constructor.name}: ${threw.message}` : 'it did not throw');
}

// ── Backlog 4 — toISOString() misfiles orders placed just after midnight ─────
console.log('\nB4  Date recorded a day early  [data correctness]');
{
  const rows = runCodeNode('Build Order Summary', [
    order({ created_at: '2026-07-01T00:30:00+01:00' }),
  ]);
  check('an order placed 1 July 00:30 BST is filed as 30 June',
    rows[0].json.placed_at === '2026-06-30',
    `placed_at=${rows[0].json.placed_at} — toISOString() converts to UTC first, ` +
    'so the hour after midnight during BST lands on the previous day');
}

// ── Structural findings, read from the JSON ──────────────────────────────────
console.log('\nStructural  read directly from the exported JSON');
{
  const withRetry = wf.nodes.filter((n) => n.retryOnFail);
  const withOnError = wf.nodes.filter((n) => n.onError);
  check('no node sets retryOnFail', withRetry.length === 0,
    'a failure aborts the execution; nothing is preserved for replay');
  check('no node sets onError', withOnError.length === 0,
    'R2: Notify Slack failing prevents Append to Orders Log from ever running');

  const creds = {};
  for (const n of wf.nodes)
    for (const c of Object.values(n.credentials ?? {}))
      (creds[c.id] ??= []).push(n.name);
  const shared = Object.entries(creds).filter(([, ns]) => ns.length > 1);
  check('one credential is shared across three nodes', shared.length === 1 && shared[0][1].length === 3,
    shared.length ? `${shared[0][0]} → ${shared[0][1].join(', ')}` : 'none found');

  const secrets = wf.nodes.filter((n) => {
    const p = JSON.stringify(n.parameters ?? {});
    return /hooks\.slack\.com\/services\//.test(p) || /"Bearer /.test(p);
  });
  check('two secrets are hardcoded in node parameters', secrets.length === 2,
    secrets.map((n) => n.name).join(', '));

  const dedup = wf.nodes.some((n) =>
    /fingerprint|idempot|seen|dedup/i.test(JSON.stringify(n.parameters ?? {})));
  check('R1: nothing performs duplicate suppression', dedup === false,
    'a retried webhook writes a second order row and decrements stock twice');

  const canary = wf.nodes.some((n) => /canary|heartbeat|stale|quiet/i.test(n.name));
  check('R5: nothing observes either flow', canary === false,
    'both flows can stop permanently with no signal');
}

console.log('\n' + '-'.repeat(52));
console.log(`${pass} verified, ${fail} failed`);
console.log('-'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
