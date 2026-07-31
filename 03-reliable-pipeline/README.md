# Reliable Event Pipeline → Slack

An event pipeline built to run unattended: it does not send duplicates, it does not lose events
when the downstream service is down, and it tells you when it has gone quiet.

Self-initiated demonstration project. The sample events are invented.

---

## The problem it solves

Connecting a CRM to Slack takes ten minutes. Connecting it so that it is still trustworthy in
six months is a different job, and it is the difference between a build fee and a retainer.

Three things break naive integrations, and all three are silent:

1. **Duplicates.** Upstream systems retry. Webhooks get replayed. One deal change becomes four
   Slack messages, the channel becomes noise, and the client turns the integration off.
2. **Lost events.** The downstream API has a bad thirty seconds, the message is dropped, and
   nobody finds out until a customer asks why they were never told.
3. **Silence.** A webhook quietly stops firing. Everything *looks* fine — no errors, no alerts,
   just nothing. This is the expensive one, because it can run for weeks.

## How it works

```
Webhook ─┐
         ├─→ Normalise & Fingerprint → Idempotency Gate → first time seen?
Demo ────┘                                                   │
                                                    ┌────────┴────────┐
                                                   yes               no → suppressed
                                                    │
                                            Deliver (3 retries)
                                                    │
                                          ┌─────────┴─────────┐
                                       success              failure
                                          │                    │
                                    Audit log          Dead letter queue
                                                        (releases fingerprint)

Daily schedule → Canary check → gone quiet? → alert / healthy
```

### Fingerprinting, not event IDs

The deduplication key is a hash of the event's *content*, not the upstream `event_id`. Some
systems reuse ids, some omit them, and some resend the same change under a fresh id — hashing
content catches all three. The hash is plain JavaScript rather than `require('crypto')`, so the
node behaves identically on hosted n8n where module access is restricted.

### Idempotency, with the boring parts done

State lives in n8n's workflow static data, so it survives between executions. It is **TTL'd at
seven days and hard-capped at 5,000 entries** — an unbounded seen-set is a memory leak that only
shows up in month four, long after handover.

### Dead letter queue that can actually be replayed

After three retries a failed delivery is captured with its full payload and the real error.
Crucially it **also releases the fingerprint** — otherwise the replay would be recognised as a
duplicate and silently dropped, and the event would be lost for good. That interaction between
the two mechanisms is easy to get wrong and expensive to discover late; there is a test for it.

### Canary

Runs daily. If nothing has been delivered in 26 hours it says so, along with the current
dead-letter depth. 26 rather than 24 so that a slightly late scheduled run does not cry wolf.

## Verified behaviour

A live run of the five sample events — three distinct, two exact repeats, one aimed at an
unreachable host:

| | |
|---|---|
| Delivered over real HTTP | **2** — Brightpath Dental, Vantage Logistics |
| Suppressed as duplicates | **2** |
| Captured in the dead letter queue | **1**, `connect ECONNREFUSED`, marked replayable |
| Audit rows written | **2**, each naming the correct event |

## Running it

```bash
node 03-reliable-pipeline/demo-sink.mjs      # stands in for Slack, prints what arrives
```

Then import `workflow.json` into n8n and hit **Test workflow**. No credentials, no accounts, no
external services. The sink is a five-line Node script; in production the delivery node points at
a real Slack incoming webhook instead and the sink is irrelevant.

Tests: `node test/logic-test.mjs` — the pipeline's share is 27 assertions covering fingerprinting,
idempotency, TTL eviction, the DLQ/replay interaction, audit pairing and the canary thresholds.

---

## Runbook

*The artefact that makes a maintenance retainer worth buying. Handed over with every build.*

**What it does.** Receives deal-change events on `POST /webhook/deal-update`, suppresses repeats,
posts once to Slack, retries three times on failure, and parks anything still failing in a
dead-letter queue. A daily check reports if the pipeline has gone quiet.

**Normal operation.** One Slack message per genuine change. Duplicates appear in the execution
log as `duplicate_suppressed` — that is the system working, not an error.

**What breaks it, and what to do:**

| Symptom | Likely cause | Fix |
|---|---|---|
| Canary reports "no deliveries in 26h" | Upstream stopped sending | Check the CRM's webhook config first — the pipeline is usually innocent |
| Dead-letter depth climbing | Slack webhook URL revoked or rate-limited | Reissue the webhook URL, then replay the DLQ |
| Duplicate messages appearing | Static data was cleared, or content genuinely differs | Compare fingerprints in the execution log before assuming a bug |
| Nothing in Slack but no errors | Workflow deactivated after an edit | Re-activate; edits can silently deactivate |

**Replaying the dead letter queue.** Each entry holds the full original payload. Re-send it to the
intake webhook — the fingerprint was released on failure, so it will be accepted rather than
suppressed.

**What monthly maintenance covers.** Canary monitoring, DLQ review and replay, credential rotation
when Slack URLs are reissued, adjusting the event filter as the CRM pipeline changes, and n8n
version upgrades tested against this workflow.

**Hosting.** Delivered as version-controlled JSON that runs on **your** n8n instance, under your
credentials. You own it and you host it — no lock-in, and it keeps running whatever happens to me.

---

## Demo video script — 90 seconds

**0:00–0:12 — the setup.** Show the five sample events.
> "Five events. Three real changes, two duplicate replays, and one where the downstream service
> is down. This is what an integration actually receives — not the happy path."

**0:12–0:30 — the run.** Test workflow. Branches light up. Cut to the sink terminal.
> "Two messages delivered. Not five, not four. Two."

**0:30–0:48 — idempotency.** Show the suppressed branch.
> "The two replays were recognised and dropped. It fingerprints the content, not the event id,
> because plenty of systems reuse ids or don't send one at all."

**0:48–1:12 — the dead letter queue.** Show the DLQ entry, then replay it.
> "This one couldn't be delivered. It's not lost — it's parked with the full payload and the real
> error, ready to replay once the service is back. And it releases the dedupe key, so the replay
> actually goes through instead of being mistaken for a duplicate."

**1:12–1:25 — the canary.**
> "And this runs daily. The failure that costs you money isn't a loud error — it's a webhook that
> quietly stops firing and nobody notices for two weeks. This one tells you."

**1:25–1:30 — close.**
> "Runs on your own n8n. Comes with a runbook. Repo linked below."

**Recording notes:** put the terminal running the sink beside the n8n canvas — watching real
messages arrive as nodes light up is the whole persuasion. The DLQ replay is the strongest twenty
seconds; do not rush it.
