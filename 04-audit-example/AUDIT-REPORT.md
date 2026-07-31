# Reliability audit — *Shop Orders → Slack, Sheet & Daily Summary*

**Subject:** `naive-workflow.json` · 9 nodes · 2 triggers
**Audited:** 31 July 2026 · **Method:** exported JSON only, no live access
**Scope:** fixed. Dependency map, failure-risk register, five standing checks, prioritised
backlog, runbook gap list. **No implementation.**

> **This is a demonstration.** The workflow audited here is one I wrote myself as an example of
> how this kind of integration usually looks when it has been built quickly by someone competent.
> It is not a client's workflow and no client data appears anywhere in it. It is deliberately
> ordinary — it works, and if you ran it today it would do what it is supposed to.

**The summary in one line:** the workflow does what it was built to do, and there are **five ways
it can fail without anyone finding out** — three of which lose order data outright. Estimated
**20 hours** to close everything, of which the first **2 hours** remove the largest single risk.

---

## 1. Dependency map

```
  ┌─ TRIGGER ────────────┐
  │  Order Received      │  POST /webhook/new-order
  └──────────┬───────────┘
             ▼
     Build Order Summary            (Code — maps payload → sheet columns)
             ▼
        Large Order?                (IF — value_gbp > 500)
        ┌────┴─────┐
   true │          │ false
        ▼          │
   Notify Slack    │               ⚠ hardcoded URL · no error path
        │          │
        └────┬─────┘
             ▼
   Append to Orders Log             🔑 SHARED-GOOGLE-001
             ▼
    Update Stock Sheet              🔑 SHARED-GOOGLE-001

  ┌─ TRIGGER ────────────┐
  │  Daily 07:00         │
  └──────────┬───────────┘
             ▼
  Read Yesterday's Orders           🔑 SHARED-GOOGLE-001
             ▼
    Send Daily Summary              ⚠ hardcoded URL · hardcoded bearer token · no error path
```

**Two independent flows share one credential.** `SHARED-GOOGLE-001` ("Google account (shop)")
authenticates three nodes across both flows. It is the only thing joining them, and nothing in the
workflow records that. Revoke or rotate it for any reason and the order log, the stock sheet and
the daily summary all stop — three failures, two flows, one cause, and no error that names it.

**External dependencies:** Slack incoming webhook (URL hardcoded), Google Sheets ×2 documents,
a mail API (URL and bearer token hardcoded). **Four external services, zero of them monitored.**

---

## 2. Failure-risk register

Every point where this workflow can fail *without telling anyone*, classified by consequence.

| # | Failure | Class | What actually happens | Fix |
|---|---|---|---|---|
| **R1** | No idempotency anywhere between the webhook and the writes | 🟠 **DUPLICATES** | The shop retries the webhook — every shop platform does, on timeout or 5xx. The same order posts to Slack twice, appends a **second row** to the orders log, and **decrements stock a second time**. Stock drift has no audit trail and is discovered at stocktake | 4h |
| **R2** | `Notify Slack` runs *before* the sheet write and has no error output | 🔴 **LOSES DATA** | Slack has a bad thirty seconds → the node throws → the execution stops → **`Append to Orders Log` never runs**. The order is never recorded. This only affects orders **over £500**, because small orders bypass Slack entirely — so the orders you lose are the largest ones, and the pattern looks random | 2h |
| **R3** | `Build Order Summary` reads `line_items[0]` only | 🔴 **LOSES DATA** | Any multi-line order is silently truncated to its first line. **Verified: a 3-line order produced 1 row and dropped 6 units.** The order total is still correct, so the sheet looks internally consistent and the loss is invisible without reconciling against the shop | 3h |
| **R4** | No guard on the payload shape | 🟡 **STOPS SILENTLY** | An order with an empty `line_items` array throws `TypeError: Cannot read properties of undefined (reading 'sku')` — **verified**. The execution fails, nothing alerts, and the order is lost. Refunds, zero-value and subscription-renewal payloads are the usual triggers | 2h |
| **R5** | Nothing observes either flow | 🟡 **STOPS SILENTLY** | If the shop stops calling the webhook, or the schedule is deactivated by an edit, or the Google token expires — there is no error, no alert, and no evidence. The first signal is a human noticing the sheet stopped growing, which on a quiet week takes a fortnight | 3h |

**R2 is the one to fix first.** Two hours, and it is the only finding here that loses your
highest-value orders specifically.

---

## 3. The five standing checks

Run on every audit, so the absence of a finding is as meaningful as its presence.

| Check | Verdict | Evidence |
|---|---|---|
| **Duplicate suppression** | ❌ **Absent** | No fingerprint, no key, no lookup. Nothing between `Order Received` and either write distinguishes a retry from a new order |
| **Dead-letter capture** | ❌ **Absent** | No node has `retryOnFail` or `onError` set. A failure is an aborted execution — the payload is not preserved anywhere it can be replayed from |
| **Unbounded state growth** | ⚪ **Not applicable** | The workflow keeps no state at all. That is *why* the first check fails — it is not a clean bill of health, it is the same finding seen from the other side |
| **Credential handling / hardcoded secrets** | ❌ **Two secrets in plain text** | A Slack webhook URL in `Notify Slack`, and a bearer token in the `Authorization` header of `Send Daily Summary`. Both sit in the node parameters, which means both appear in **every export and every execution log**. Separately, one credential spans three nodes across two independent flows |
| **Would anything notice silence?** | ❌ **No** | No canary, no heartbeat, no downstream freshness check. Both flows can stop permanently with no signal |

---

## 4. Prioritised backlog

Ordered by risk against effort, estimated in hours. **Written so you can hand it to any developer,
including one who isn't me.**

| # | Task | Hours | Closes | Why here |
|---|---|---|---|---|
| **1** | **Write to the orders sheet before notifying Slack, and give `Notify Slack` an error output** that continues rather than aborting | **2** | R2 | Highest risk, lowest effort. A notification failing should never prevent the record. This is a wiring change, not new code |
| **2** | **Iterate every line item** in `Build Order Summary` — emit one row per line, not per order | **3** | R3 | Silent data loss on exactly the orders that matter most (multi-line = larger baskets) |
| **3** | **Add an idempotency key on `order_id`** — look up before writing, skip if already present | **4** | R1 | Highest severity, but genuinely more work: needs a store, and a decision on what "already seen" means for legitimate re-orders |
| **4** | **Format dates from local parts**, not `new Date(...).toISOString()` | **1** | — | An order placed at 00:30 on 1 July is recorded as 30 June. **Verified.** One hour, and it silently misfiles orders across month and quarter boundaries |
| **5** | **Validate the payload before mapping** — reject and log anything without a usable `line_items` | **2** | R4 | Turns a crash into a handled, visible rejection |
| **6** | **Move both hardcoded secrets into the credential store** | **2** | — | The bearer token is in plain text in every export you have ever sent anyone, including this audit |
| **7** | **Add a daily canary** on the orders sheet — alert if no row has been written in 26 hours | **3** | R5 | 26 not 24, so a quiet Sunday or a late run doesn't cry wolf |
| **8** | **Write a one-page runbook** covering the gaps in §5 | **3** | — | Last by risk, first by what it costs you the day someone is off sick |

**Total: 20 hours.** Items 1–2 are five hours and remove both data-loss findings.

---

## 5. Runbook gap list

What a competent person covering for you **could not work out** from the workflow alone:

1. **Which Google account is `SHARED-GOOGLE-001`**, who controls it, and what else depends on it.
2. **Which Slack channel the webhook posts to.** The URL is opaque by design — you cannot tell
   from it, and there is no note anywhere.
3. **Which spreadsheets `1DEMOxxxxOrdersSheetId…` and `1DEMOxxxxStockSheetId…` are.** Two raw
   document IDs, no names, no links.
4. **What to do when the daily summary doesn't arrive.** There is no documented first check, and
   the likeliest causes (expired token, deactivated schedule, mail API rejection) each look
   identical from the outside: nothing happens.
5. **Whether a failed execution is safe to re-run.** It is **not** — with no idempotency, a manual
   retry duplicates the order row and double-counts stock. Nothing in the workflow says so, and
   re-running a failed execution is the first thing anyone tries.
6. **Where the mail API bearer token came from**, whose account it bills, and how to rotate it.

---

## 6. What was not examined

Stated so the scope is unambiguous:

- **No implementation.** Nothing in the backlog has been built.
- **No live access.** Findings come from the exported JSON. Anything that only appears at runtime —
  actual Slack rate limits, real Google quota behaviour, the shop's true retry policy — is out of
  scope and flagged as an assumption rather than a fact.
- **No security or compliance opinion.** The hardcoded-secret finding is a reliability and handover
  finding, not a penetration test and not a certification statement.
- **No verdict on whether the workflow is "good".** It was built to do a job and it does it. This
  report is a fixed examination, not a judgement.

---

*Findings R3, R4 and backlog item 4 were verified by executing the `Build Order Summary` node's
actual source against sample payloads, not by reading it. The remaining findings are structural and
are visible in the exported JSON: no node in this workflow sets `retryOnFail` or `onError`, and
`SHARED-GOOGLE-001` appears on three of the nine nodes.*
