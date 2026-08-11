# n8n automation portfolio

Four demonstration projects showing how I approach business automation. The portfolio's argument
is **operational rigour** — what happens when the model is wrong, who checks, and what the client
is handed — not volume of generated workflows. Changes that weaken that argument are not
improvements.

## Commands

```bash
node test/logic-test.mjs                    # 62 assertions, no deps, no API key
node 04-audit-example/verify-findings.mjs   # proves the audit's findings by execution
node render-pdf.mjs <file.md>               # regenerate a runbook PDF from its markdown
node 03-reliable-pipeline/demo-sink.mjs     # local sink for the pipeline demo
```

Run the test suite after any change to a Code node. It is fast and has no dependencies, so there
is no reason not to.

## Conventions that are load-bearing

**The model reads; code decides.** Extraction from messy text is the model's job. Every
calculation, threshold, comparison and routing rule lives in a Code node where it is auditable and
identical on every run. Never move arithmetic or a routing decision into a prompt — that is the
central claim of this portfolio and moving it breaks the point.

**Flag rather than guess.** When the workflow cannot be confident, it says so and names the
specific reason in `review_reasons`. A run that flags three documents out of forty has done its
job. Never add a fallback that invents a plausible value to avoid a flag.

**A human stays in the loop where reputation is at stake.** Workflow 2 drafts replies and queues
them. It never sends. Do not add a send step.

**Tests read node source out of `workflow.json`.** `test/logic-test.mjs` extracts the actual Code
node source and executes it, so the tests cannot drift from what runs in n8n. Never copy node
logic into the test file to make a test pass — fix the node, or fix the extraction.

**PDFs are generated, never edited.** `RUNBOOK.pdf` comes from `RUNBOOK.md` via `render-pdf.mjs`.
Edit the markdown and regenerate. The two cannot be allowed to diverge.

**Dates are UK day-first, and never formatted with `toISOString()`.** `07/08/2026` is 7 August.
Formatting via `toISOString()` under British Summer Time books dates one day early and can put an
invoice in the wrong VAT quarter — this was a real bug the tests caught, and the tests run under
several timezones because of it. Format from local parts.

## `04-audit-example/` is deliberately flawed

`naive-workflow.json` is **the subject of an audit, not a sample of my work**. Its bugs are the
point: no idempotency, Slack notified before the sheet write, `line_items[0]` only, no payload
guard, nothing watching for silence, two hardcoded secrets. **Do not fix them.** If you improve
that workflow you invalidate `AUDIT-REPORT.md` and `verify-findings.mjs`, which prove their
findings by executing its code.

## Every build ships a runbook

Written for whoever operates it day to day, not for a developer. Fixed structure: what it does,
what normal looks like, what breaks it and what to do, **what it will not do**, what monthly
maintenance covers, hosting. Use the `/runbook` skill rather than improvising the format.

## Honesty constraints

- These are **self-initiated demonstration projects, not client work.** Sample data is invented.
  Never write anything implying a real customer, a real engagement, or a testimonial.
- Client workflows deploy to **the client's own n8n instance under their credentials** — n8n's
  Sustainable Use Licence does not permit hosting a client's workflows as a paid service without
  an Enterprise licence. Do not describe a hosted-for-the-client arrangement.
- Claims in the READMEs marked "verified" are verified by executing code. Do not add a "verified"
  claim without a script that demonstrates it.

## Style

British English (`normalise`, `prioritised`, `artefact`). Prose over bullet soup in the client
facing documents. Em-dashes and plain sentences; no marketing register. Tables for symptom/cause/
fix and for anything with a repeating shape.
