# n8n automation portfolio

Three working n8n workflows, built to demonstrate how I approach business automation,
plus a worked example of reviewing an automation somebody else already built.
All three run end-to-end with no paid services.

**These are self-initiated demonstration projects, not client work.** Sample data is
invented. Nothing here represents a real customer.

| | Workflow | What it shows |
|---|---|---|
| 1 | [Invoice & Receipt → Structured Data](01-invoice-extractor/) | Reading messy supplier documents into clean accounting rows, with arithmetic validated in code rather than trusted to a model |
| 2 | [Inbound Enquiry Triage & Reply Drafter](02-enquiry-triage/) | Classifying incoming enquiries by intent, scoring them by deterministic rules, and drafting replies that a human sends |
| 3 | [Reliable Event Pipeline → Slack](03-reliable-pipeline/) | Running unattended: idempotency, a replayable dead-letter queue, an audit trail and a canary that catches silence |
| 4 | [Audit example](04-audit-example/) | ⚠️ **Deliberately flawed — the subject, not a sample of my work.** An ordinary integration of the kind that already exists in a lot of businesses, and the written report from reviewing it |

---

## The idea behind them

The interesting part of an AI automation is not the model call. It is everything around it:
what happens when the model is wrong, who checks, and what the business does with the output.

The first two are built on the same three principles. The third is about what happens
after handover, when nobody is watching.

**The model reads; code decides.** Language models are good at pulling structure out of messy
text and bad at arithmetic and consistency. So extraction is the model's job, and every
calculation, threshold and routing rule lives in a Code node where it is auditable, adjustable
without prompt engineering, and identical on every run.

**Say when not to trust the output.** Workflow 1 re-checks that net plus VAT equals gross and
flags anything that fails, rather than writing a plausible-looking wrong number into the
accounts. A client trusts an automation because it tells them which three documents to look at,
not because it claims all three hundred are fine.

**A human stays in the loop where reputation is at stake.** Workflow 2 drafts replies to
prospects and queues them. It never sends. Auto-replying to inbound enquiries is a fast way for
an automation to cost a business more than it saves.

---

## Running them

**Requirements:** n8n (tested on 2.32.6, Node 22 LTS). Workflows 1 and 2 need a Google AI Studio
API key — free, no card: <https://aistudio.google.com/apikey>. Both use `gemini-3-flash-preview`
at temperature 0, and a full run costs nothing on the free tier. **Workflow 3 needs no key at
all** — it uses no model.

1. Start n8n and open <http://localhost:5678>.
2. **Credentials → Add credential → Google Gemini (PaLM) API**, paste the key, save.
3. **Workflows → Import from File** and choose a `workflow.json`.
4. Open the *Gemini Chat Model* node and select the credential you just created.
   (Workflow 3 has no such node — skip this step for it, but do start its demo sink:
   `node 03-reliable-pipeline/demo-sink.mjs`.)
5. Click **Test workflow**.

No other credentials are needed. Sample inputs are inlined in the first Code node of each
workflow, so nothing depends on an inbox, a spreadsheet or a webhook being set up first —
in a real deployment that node is swapped for the client's actual source.

### Note on Node version

n8n depends on `isolated-vm`, which does not currently compile on Node 26. Node 22 LTS works.

---

## Deployment and hosting

n8n's [Sustainable Use Licence](https://docs.n8n.io/sustainable-use-license/) does not permit
hosting a client's workflows on my own instance as a paid service without an Enterprise licence.
So anything I build for a client is **deployed to their own n8n instance or n8n Cloud account**,
under their credentials, and they own it outright. Ongoing maintenance is done on their
infrastructure.

That is the honest constraint, and it is also the better arrangement for a client: no lock-in,
no dependency on my uptime, and the workflow keeps running whatever happens to me.

---

## Tests

The Code nodes — where the arithmetic, date handling and routing rules live — are covered by a
test suite that reads the node source directly out of `workflow.json`, so the tests cannot drift
from what actually runs in n8n.

```bash
node test/logic-test.mjs
```

62 assertions, no dependencies, no API key needed. They are also run under several timezones,
because the first bug they caught was a date being formatted via `toISOString()` — which, under
British Summer Time, silently booked every spelled-out invoice date one day early and could put
an invoice in the wrong VAT quarter.

The audit example carries its own verifier, which proves that report's findings by executing the
audited workflow's code rather than asserting them:

```bash
node 04-audit-example/verify-findings.mjs
```

## Repo layout

```
01-invoice-extractor/
  workflow.json     import this
  README.md         how it works, and the demo script
02-enquiry-triage/
  workflow.json
  README.md
03-reliable-pipeline/
  workflow.json
  demo-sink.mjs     node 03-reliable-pipeline/demo-sink.mjs
  README.md         includes the client runbook
04-audit-example/
  naive-workflow.json   deliberately flawed — the subject of the audit
  AUDIT-REPORT.md       the deliverable: risk register, backlog, runbook gaps
  verify-findings.mjs   node 04-audit-example/verify-findings.mjs
  README.md
test/
  logic-test.mjs    node test/logic-test.mjs
```
