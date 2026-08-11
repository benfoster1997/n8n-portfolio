---
name: automation-audit
description: Audit an existing automation or integration (n8n, Make, Zapier, or a scripted pipeline) for the ways it can fail without anyone finding out — producing a dependency map, failure-risk register, five standing checks, prioritised backlog with hour estimates, and a runbook gap list. Use when reviewing somebody else's workflow, assessing a workflow's reliability, or when asked what could go wrong with an automation.
when_to_use: Someone wants an existing automation reviewed rather than built. Also use when inheriting a workflow, before quoting maintenance on one, or when a prospect asks what is wrong with what they already have.
argument-hint: <workflow export file>
---

# Reliability audit

A fixed examination of how an automation fails **without telling anyone**. Not a code review, not
a security assessment, and not a verdict on whether the workflow is good — most audited workflows
work, and would do their job if run today. The finding is almost never "this is broken". It is
"here are five ways this stops being true and nobody finds out for a fortnight".

## Method

**Work from the export.** Findings come from the exported JSON. State this in the header. Anything
that only appears at runtime — real rate limits, actual quota behaviour, the source system's true
retry policy — is out of scope and must be flagged as an assumption rather than a fact.

**Verify what can be verified by executing it.** This is what separates this audit from an
opinion. Where a finding concerns code — a mapper that reads `line_items[0]`, a date formatted via
`toISOString()`, a payload shape that throws — extract that node's actual source and run it
against a sample payload that demonstrates the failure. Write the verifier as a script that ships
with the report. Mark those findings **verified** and say in the footer which ones were proven by
execution rather than by reading. Never mark a finding verified without a script behind it.

**Scope is fixed and stated up front.** No implementation. Nothing in the backlog gets built as
part of the audit — the deliverable is the examination.

## Structure

**Title** — `# Reliability audit — *<Workflow name>*`, the workflow's own name in italics, taken
from the export rather than invented.

**Header block** — Subject (file, node count, trigger count), date audited, method, and scope in
one line ending **No implementation.** If the audited workflow is a demonstration you wrote
yourself, say so in a blockquote immediately: that it is not a client's, contains no client data,
and is deliberately ordinary rather than deliberately terrible.

**The summary in one line** — Bold. How many ways it can fail unnoticed, how many of those lose
data, total hours to close everything, and the hours for the single highest-value fix. A reader
who stops here should still be able to make a decision.

**1 · Dependency map** — An ASCII diagram of every flow showing triggers, nodes and branches, with
a marker against each node for the credential it uses (`🔑 SHARED-GOOGLE-001`) and a marker for
hardcoded values and missing error paths (`⚠ hardcoded URL · no error path`). The credential
marker is what makes the shared-credential finding visible in the diagram rather than only in the
prose beneath it. Then, in prose, the thing the diagram
reveals that a node list cannot: which credential spans which flows. *Two independent flows
sharing one credential is the single most common structural finding, and nothing in the workflow
records it.* Close with a count of external dependencies and how many are monitored.

**2 · Failure-risk register** — Every point where the workflow fails without telling anyone.
**Number the findings R1, R2, R3…** — the backlog's "Closes" column and the "fix this first"
sentence both cross-reference these identifiers, so they have to exist here. Classify each by
consequence:

| Class | Meaning |
|---|---|
| 🔴 **LOSES DATA** | A record that should exist does not, and nothing indicates it |
| 🟠 **DUPLICATES** | The same event is processed more than once, corrupting a count or a total |
| 🟡 **STOPS SILENTLY** | Processing halts with no error, no alert and no evidence |

For each: what *actually happens*, told as a sequence of events, not as a category. Include the
detail that makes it real — that Slack failing before the sheet write loses only orders over £500,
so the losses look random while being systematically the largest ones. Give each an hour estimate.
Then name the one to fix first and say why in a sentence.

**3 · The five standing checks** — Run on every audit, so the absence of a finding is as
meaningful as its presence. Verdict and evidence for each:

1. **Duplicate suppression** — Is there a fingerprint, key or lookup between the trigger and the
   writes that distinguishes a retry from a new event?
2. **Dead-letter capture** — Does any node set `retryOnFail` or `onError`? Is a failed payload
   preserved anywhere it can be replayed from?
3. **Unbounded state growth** — Does retained state have a bound? When a workflow keeps no state
   at all, say so and note that this is *why* check 1 fails — the same finding from the other
   side, not a clean bill of health.
4. **Credential handling and hardcoded secrets** — Secrets in node parameters appear in every
   export and every execution log, including the ones already emailed to people. Also flag one
   credential spanning multiple independent flows.
5. **Would anything notice silence?** — Canary, heartbeat, or downstream freshness check. If both
   flows can stop permanently with no signal, that is the finding.

**4 · Prioritised backlog** — Ordered by risk against effort, in hours, **written so it can be
handed to any developer, including one who isn't you**. Columns: task, hours, which risk it
closes, and why it sits at that position. Highest risk with lowest effort goes first even when a
more severe finding exists — say that explicitly, and say what makes the severe one more work
(usually that it needs a store and a decision about what "already seen" means). Include items that
close no register entry but are cheap and consequential, such as date formatting. Total the hours
and state which first few remove the data-loss findings.

**5 · Runbook gap list** — What a competent person covering for the owner **could not work out**
from the workflow alone. Opaque webhook URLs, raw document IDs with no names, which account owns a
credential, what to do when a scheduled output simply does not arrive, where a token came from and
how to rotate it. Always include **whether a failed execution is safe to re-run**, because it is
the first thing anyone tries and with no idempotency it duplicates.

**6 · What was not examined** — Stated so scope is unambiguous: no implementation, no live access,
no security or compliance opinion, no verdict on quality.

**Footer** — One italic paragraph naming which findings were verified by execution and which are
structural and visible in the export.

## Voice

- Neutral and specific. The workflow was built to do a job and it does it — the report is an
  examination, not a judgement, and reads as one.
- Never editorialise about the builder. "Built quickly by someone competent" is the register.
- Quantify everything: hours, node counts, how long the first signal takes to arrive.
- Bold the consequence, not the fault.
- British English.

## Deliverables

`AUDIT-REPORT.md` and a verifier script that proves the executable findings. If the client is
being handed the report, render it to PDF from the markdown rather than writing a second document.
