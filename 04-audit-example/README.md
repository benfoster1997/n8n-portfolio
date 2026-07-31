# 4 · Audit example — a workflow, and what an audit of it finds

> ⚠️ **The workflow in this folder is deliberately flawed. It is not an example of my work — it is
> the *subject* of the example.** The other three folders show how I build. This one shows what I
> look for when reviewing something already built.

The other three workflows in this repo are things I would hand to a client. This folder is the
opposite: an ordinary integration of the kind that already exists in a lot of small businesses,
plus the written report I would produce after reviewing it.

| File | What it is |
|---|---|
| [`naive-workflow.json`](naive-workflow.json) | The subject. 9 nodes, 2 triggers. Imports into n8n |
| [`AUDIT-REPORT.md`](AUDIT-REPORT.md) | The deliverable — dependency map, failure-risk register, five standing checks, prioritised backlog, runbook gap list |
| [`verify-findings.mjs`](verify-findings.mjs) | Proves the findings by executing the workflow's own code |

---

## Why it is built badly on purpose

A straw man proves nothing. If the example workflow were obviously broken, anyone technical would
spot it in five seconds and the audit would look like theatre.

So `naive-workflow.json` is written the way a competent person in a hurry actually writes one. It
works. If you ran it today it would take orders from a shop webhook, post the large ones to Slack,
append them to a Google Sheet, update a stock sheet, and email a summary every morning. Nobody
would file a bug against it.

It has no deduplication, no error handling on any node, two secrets pasted into node parameters,
one credential spanning two unrelated flows, and nothing watching whether it still runs. Every one
of those is a normal thing to end up with when the job was "get orders into the sheet by Friday".

**None of this is client work.** The workflow is mine, written for this example. The document IDs,
the webhook URL and the API token are placeholders — the token in particular is deliberately a
harmless placeholder rather than a realistic-looking secret, because this repo is public and
putting something that *looks* live in it would be the exact mistake the report criticises.

---

## What the audit finds

Five ways it can fail without anyone finding out, three of which lose order data outright. The one
I would fix first takes two hours:

> `Notify Slack` runs *before* the sheet write and has no error output. Slack has a bad thirty
> seconds, the node throws, the execution stops, and **`Append to Orders Log` never runs**. The
> order is never recorded. It only affects orders over £500, because smaller ones bypass Slack
> entirely — so the orders you lose are the largest ones, and the pattern looks random.

Full detail, with a dependency map and a backlog estimated in hours, is in
[`AUDIT-REPORT.md`](AUDIT-REPORT.md).

---

## Check it yourself

The findings are verified by running the workflow's own code, not by reading it. The verifier
pulls the Code node's source straight out of `naive-workflow.json`, so it cannot drift from what
would actually run in n8n — same discipline as the main test suite.

```bash
node 04-audit-example/verify-findings.mjs
```

No API key, no install, no n8n instance needed. It prints 10 checks:

```
R3  Only the first line item is recorded  [LOSES DATA]
  ok    a 3-line order produces exactly 1 row
  ok    6 units are silently dropped

R4  Unguarded payload shape  [STOPS SILENTLY]
  ok    an order with no line items throws

B4  Date recorded a day early  [data correctness]
  ok    an order placed 1 July 00:30 BST is filed as 30 June
```

That last one is the same class of bug as the first real one this repo's test suite caught —
`toISOString()` converts to UTC before the date is taken, so during British Summer Time anything
in the hour after midnight is filed a day early.

To see it on a canvas, import `naive-workflow.json` into n8n. **It will show credential warnings,
and that is correct** — this is what an exported workflow looks like when the secrets have been
stripped, which is exactly the format I ask a client to send. The credential *references* survive
an export while the secrets do not, which is why the shared-credential finding is visible from the
JSON alone.

---

## The five standing checks

Run on every audit, so that finding nothing is as meaningful as finding something:

1. **Duplicate suppression** — does a retry produce one outcome or two?
2. **Dead-letter capture** — when a delivery fails, is the payload kept somewhere replayable?
3. **Unbounded state growth** — does anything accumulate forever?
4. **Credential handling** — hardcoded secrets, and how wide the blast radius of one credential is
5. **Would anything notice silence?** — the failure that costs money is not a red error, it is a
   webhook that quietly stops firing

On this workflow the third check comes back *not applicable* — it keeps no state at all. That is
not a clean bill of health, it is the first finding seen from the other side.
