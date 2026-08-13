# 5 · Jobs Board Monitor

A workflow that watches the n8n Community **Jobs** board and pushes new postings to my phone,
so I find out in minutes rather than the next time I happen to open a laptop.

> **Self-initiated demonstration project. Nobody has paid me for any of this.** I am a gas engineer
> by trade and I build these in the evenings. Everything here runs on my own instance against a
> public forum, with no account, no API key and no credentials.

---

## Why this one exists

I built it because I needed it, which makes it the most honest thing in this repo.

Looking at the Jobs board properly, three things are true:

1. **Supply is thin** — roughly 5–8 genuine hiring posts a month, of which 2–3 are ones I could
   actually deliver.
2. **Position in the thread does not matter.** I had assumed being an early reply won the job. It
   does not: on the thread that evidence was drawn from, the buyer sent six near-identical
   outreach messages in ten minutes to replies 2, 3, 4, 6, 7 and 8. He was working top-to-bottom
   collecting contact details, not picking a favourite.
3. **The same *day* does matter.** Replies inside the first day got contacted. On one thread,
   roughly 28 people who replied from day three onward — several with production experience, one
   with a working prototype — got nothing at all.

So the only variable actually worth improving is **how fast I find out a post exists**, and that is
a monitoring problem, not a writing problem. You cannot watch a forum from under a boiler.

## How it works

```
Schedule (10 min) ─→ Fetch /c/jobs/13.json ─┐
                                            ├─→ Select New Postings ─→ anything new?
Run Demo ─→ Load Demo Topics ───────────────┘         │                   │
                                                      │            ┌──────┴──────┐
                                            drops: pinned         yes            no
                                                   [FOR HIRE]      │              │
                                                   already seen    │        Nothing New
                                                                   ▼
                                                            Notify (3 retries)
                                                                   │
                                                        ┌──────────┴──────────┐
                                                     success                fail
                                                        │                     │
                                                 Record Notified      Dead Letter Queue
                                                                    (releases the topic)

Canary (6h) ─→ has it POLLED in 3h? ─→ alert / watching
```

### The first run says nothing, deliberately

On a cold start the seen-set is empty. A naive diff decides all thirty topics currently on the
board are new and fires thirty notifications at once — which is exactly the sort of thing that
gets a monitor muted on day one, and then it may as well not exist.

**The first run seeds the set and stays silent.** There is a test for it.

### The canary watches polling, not findings

This is the design decision I would defend hardest, and it is the opposite of what
`03-reliable-pipeline`'s canary does.

That pipeline alarms when nothing has been *delivered* in 26 hours, because deliveries are supposed
to be constant. Here, **2–3 addressable posts a month means weeks of silence is the expected
state.** A canary that alarmed on "no notifications" would cry wolf constantly and get ignored,
which is worse than having none.

So it watches `lastPollAt` — did the monitor actually run — with a 3-hour threshold, which is 18
consecutive missed polls at a 10-minute interval. Clearly broken, not a blip.

### A failed notification releases the topic

When a push cannot be delivered it is parked with the full payload and the real error. It **also
deletes the topic from the seen-set**, so the next poll re-detects it.

Without that, one thirty-second outage means the one job worth answering is marked as handled and
silently never seen again. It is the same trap as the dead-letter/idempotency interaction in
`03-reliable-pipeline`, and there is a test for it here too.

### Bounded state

Seen topics are TTL'd at 90 days and hard-capped at 2,000. An unbounded seen-set is a memory leak
that only shows up in month four, long after you have stopped thinking about it.

## Running it

```bash
node test/logic-test.mjs        # from the repo root — no n8n, no network, no key
```

Then import `workflow.json` into n8n and press **Run Demo**. The demo path uses a built-in sample
listing shaped exactly like Discourse's response, so it runs offline. Four topics, chosen to
exercise every branch: a fresh hiring post, a three-day-old one, a pinned announcement and a
`[FOR HIRE]` advert.

**To point it at the real board**, one line in `Select New Postings`:

```js
const NTFY_TOPIC = 'CHANGE-ME-to-something-long-and-unguessable';
```

Install [ntfy](https://ntfy.sh) on your phone, subscribe to that topic, activate the workflow.
Free, no account.

> ⚠️ **An ntfy topic is effectively a password** — anyone who knows the string can read your
> notifications. Pick something long and random, and do not commit it. The test suite fails if the
> placeholder has been replaced in the committed file.

## What this does not do

- **It does not reply to anything.** It tells me a post exists; the reading and the writing are
  mine. Automating a reply on a forum would be both against the spirit of the place and a fast way
  to be ignored.
- **It does not read post bodies.** It works off the category listing only — title, age, reply
  count, URL.
- **It does not filter by whether a job suits me.** That needs judgement, and a filter tight enough
  to be useful would discard most of an already-thin inventory. It drops self-promotion and pinned
  announcements; everything else reaches me and I decide.
- **It does not deduplicate across edits.** A topic renamed after I have seen it will not fire
  again.
- **It is not a scraper.** One request every ten minutes to a public JSON endpoint, with a real
  User-Agent identifying me.

## Tests

30 assertions in `test/logic-test.mjs`, covering: the silent first run, the diff, the pinned and
`[FOR HIRE]` filters, the near-miss between *"looking for work"* and *"looking for help"*, the
freshness banding, TTL eviction, the dead-letter release-and-re-detect interaction, and the canary
threshold in both directions.

The node source is read straight out of `workflow.json`, so the tests cannot drift from what
actually runs.
