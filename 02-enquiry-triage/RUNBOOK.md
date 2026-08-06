# Runbook — Inbound Enquiry Triage & Reply Drafter

*The artefact that makes a maintenance retainer worth buying. Handed over with every build.*

Written for whoever operates this day to day, not for a developer.

---

## What it does

Reads incoming enquiries, sorts them by what they actually are, scores the genuine ones so you
know which to answer first, and writes a draft reply for you to edit and send.

**It never sends anything.** Every draft lands in a queue for a human. Auto-replying to inbound
enquiries is a fast way for an automation to cost a business more than it saves, so that decision
is deliberately not the workflow's to make.

## Where each enquiry goes

Four categories, decided by the model, then routed:

| Category | Where it goes | What happens |
|---|---|---|
| `new_project` | **Queue for Human Review** | Scored, prioritised, and given a drafted reply |
| `existing_client_support` | **Support Queue** | Routed straight through — an existing client with a broken system is not a lead to be scored |
| `sales_pitch_or_spam` | **Discard** | Kept, not deleted, so you can check what it is dropping |
| `recruitment` | **Recruitment** | Separated out — a job offer is not a sale |
| *(anything it cannot place)* | **Unclassified** | Goes to a human rather than being guessed at |

## How the score is worked out

The model reads and extracts. **The ranking is plain code**, so it is auditable and you can change
it without touching a prompt:

| Signal | Points |
|---|---|
| Budget stated ≥ £2,000 | +40 |
| Budget stated ≥ £750 | +28 |
| Any budget stated | +15 |
| Manual hours claimed | +1.5 per hour per week, capped at 25 |
| A deadline mentioned | +15 |
| Named systems or tools | +10 |
| Sender identified by name **and** organisation | +5 |

| Total | Priority |
|---|---|
| 70+ | **A — reply today** |
| 40–69 | **B — reply within 48h** |
| under 40 | **C — reply when convenient** |

Each enquiry also carries **blockers** — the questions that must be answered before it can be
quoted at a fixed price. No budget, no named systems and no deadline each add one. These exist so
a first reply asks the right questions instead of guessing at scope.

## Normal operation

A drafted reply that needs editing is **normal**. The draft is a starting point that already names
the sender's real systems and asks their blockers — it is not meant to go out untouched.

Enquiries landing in **Discard** should be checked weekly at first. It is the branch most worth
watching early on, because the cost of wrongly discarding one genuine enquiry is much higher than
the cost of reading a few pieces of spam.

## What breaks it, and what to do

| Symptom | Likely cause | Fix |
|---|---|---|
| Everything lands in **Unclassified** | The Google AI Studio key has hit its limit or been revoked. All three model nodes retry three times, five seconds apart, then give up | Check the key at <https://aistudio.google.com/apikey>. A `429` is a rate limit, not a broken workflow |
| A genuine enquiry was **discarded as spam** | The category descriptions do not fit the kind of enquiry you actually get | Tell me what it was. The four category descriptions are plain English and adjusting them is a small change — but it should be measured against real examples, not guessed at |
| Every score is 0 or identical | The extraction step returned nothing, so there are no signals to score | Check the *Extract Details* output. If it is empty, the run failed upstream — usually the key again |
| Priority A on almost everything | Your enquiries are richer than the default thresholds assume | The tiers and thresholds are one object at the top of *Score & Prioritise*. They are meant to be tuned to your business, and it is worth doing after the first month of real traffic |
| A draft reply names a system the sender never mentioned | The extractor over-reached | **This is why nothing sends automatically.** Report it — the extraction prompt forbids inventing values and a case where it did is worth fixing properly |
| Nothing runs at all, no errors | The workflow was deactivated by an edit | Re-activate it. Editing can silently deactivate a workflow |
| An existing client's problem sat in the new-project queue | They wrote in as though it were new work | Move it. If it keeps happening, the two category descriptions need to be sharpened against each other |

## What it will not do

- **It does not send.** Not a limitation to be worked around later — a deliberate design decision.
- **It does not qualify people out.** A low score means "answer this one second", not "ignore".
- **It does not do cold outreach**, build contact lists, or scrape senders. It reads what arrives.
- **It does not decide price.** The score ranks attention, not value.

## What monthly maintenance covers

Reviewing the Discard branch for anything wrongly dropped, tuning the scoring thresholds against
what actually converts, sharpening the category descriptions as the mix of enquiries changes,
rotating the API key, keeping up with model version changes, and testing n8n upgrades against this
workflow before you take them.

The test suite (`node test/logic-test.mjs`) is run after every change, so a tweak to the scoring
cannot quietly break the routing.

## Hosting

Delivered as version-controlled JSON that runs on **your** n8n instance, under your credentials
and your Google AI Studio key. You own it and you host it — no lock-in, and it keeps running
whatever happens to me.

---

*This runbook describes the demonstration workflow in this repository. A client build gets the
same document with the real intake source, queue destinations and escalation contacts filled in.*
