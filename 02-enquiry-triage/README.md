# Inbound Enquiry Triage & Reply Drafter

Sorts incoming enquiries by what the sender actually wants, scores the genuine leads against
rules you can read, and drafts a reply for a human to send.

Self-initiated demonstration project. The four sample enquiries are invented.

---

## The problem it solves

A small service business gets a mixed inbox: real prospects, existing clients whose system has
broken, cold sales pitches, and recruiters. They all look similar at a glance and they all arrive
in the same place. Two things go wrong. Urgent client problems sit behind sales spam. And good
leads go cold because replying properly takes twenty minutes of reading and thinking.

The tempting fix is to auto-reply to everything. That is worse than doing nothing: an automated
reply to a serious enquiry reads as an automated reply, and the prospect goes elsewhere.

## How it works

```
Intake → Classify intent ─┬─ new project  → Extract → Score (code) → Draft reply → human review queue
                          ├─ client support   → support queue, priority A
                          ├─ sales pitch      → discard
                          ├─ recruitment      → no action
                          └─ unclassified     → read manually
```

**1. Classify by intent.** Five outputs. The prompt directs the classifier to judge what the
sender *wants*, not how politely they wrote — otherwise a well-written cold pitch scores as a
lead and a blunt one-liner from a paying client gets ignored. Only genuine new business goes down
the expensive path; the other four are handled cheaply and never touch the model again.

**2. Extract what was actually written.** Contact, organisation, the problem in one sentence,
systems named, budget, deadline, and any hours-per-week figure the sender claims. The prompt
explicitly forbids inferring a budget or deadline that is not stated, because a hallucinated
budget leads directly to a wrong quote.

**3. Score in plain JavaScript.** Not in a prompt — in a Code node, so the rules are visible,
auditable, and adjustable by the client without touching AI at all:

| Signal | Points |
|---|---|
| Budget £2,000+ / £750+ / any stated | 40 / 28 / 15 |
| Claimed manual hours per week | 1.5 each, capped at 25 |
| Deadline mentioned | 15 |
| Named at least one system | 10 |
| Identified sender and organisation | 5 |

A (70+) reply today · B (40–69) within 48h · C (under 40) when convenient.

It also outputs **scoping blockers** — the specific things still unknown that stop the job being
quoted at a fixed price. That list is what turns the drafted reply into one useful question
rather than a generic "tell me more".

**4. Draft, never send.** A reply is written and queued for review. The prompt forbids claiming
past clients, experience or results, forbids quoting a price or a date, and requires it to end on
exactly one question. Nothing is sent automatically. That boundary is deliberate, and it is a
selling point rather than a limitation.

## What the samples demonstrate

| Enquiry | Expected route |
|---|---|
| Dental practice, £2–3k budget, 15h/week manual work, names Dentally and Twilio | New project, score 93, priority A, no blockers |
| Logistics client, stock sync broke overnight | Support queue, priority A — never queued behind a sales pitch |
| Cold outreach selling AI lead generation | Discarded |
| Recruiter offering a £65k role | No action |

## Tests

The scoring logic is covered by [`../test/logic-test.mjs`](../test/logic-test.mjs), which reads
the Code node straight out of `workflow.json` so the tests cannot drift from what runs in n8n.

```bash
node test/logic-test.mjs
```

## Deploying it for a client

Replace *Load Sample Enquiries* with a Webhook (contact form) or Gmail trigger, and send the
review queue somewhere the client already looks — Slack, or a daily digest email. The scoring
weights are constants at the top of the Code node and are meant to be tuned per business; a
£2,000 job is a big deal to one client and a rounding error to another.

---

## Runbook

**→ [RUNBOOK.md](RUNBOOK.md)** — handed over with every build.

Where each of the five branches sends an enquiry, how the score is actually worked out, a
symptom-cause-fix table, and **what it will not do** — starting with the fact that it never sends
anything. The branch worth watching in the first few weeks is *Discard*, and the runbook says so.

---

## Demo video script — 90 seconds

**0:00–0:12 — the problem.** Show the four sample enquiries in the first node's output.
> "Four emails that arrived on the same morning. A real prospect, a client whose system has
> broken, a sales pitch, and a recruiter. They all landed in the same inbox."

**0:12–0:28 — the run.** Click Test workflow. The classifier fans out to five branches.
> "This sorts them by what the sender actually wants — not by how polite the email is."

**0:28–0:45 — routing.** Point at the branches lighting up.
> "The broken stock sync goes straight to the support queue marked reply-today. The sales pitch
> is discarded. The recruiter, no action. None of those touch the AI again."

**0:45–1:08 — the lead.** Open *Score & Prioritise* output, show `lead_score`, `priority`,
`score_reasons`.
> "The real lead scores 93 and shows its working — budget stated, fifteen hours a week of manual
> work, a named deadline, two named systems. That scoring is plain JavaScript, not a prompt, so
> you can read it and change it."

**1:08–1:25 — the draft.** Open `draft_reply`.
> "And it drafts a reply that names their actual problem and asks the one question that's still
> missing. It does not send it. You read it, you send it. Automating the send is how you lose
> the client."

**1:25–1:30 — close.**
> "Runs on your own n8n, wired to your contact form or inbox. Repo linked below."

**Recording notes:** 1280×720 minimum, no music. Let the branch animation play — the fan-out is
the clearest visual in either workflow. Show real output panels, not slides.
