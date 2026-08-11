---
name: runbook
description: Write or review a client handover runbook for an automation or integration — the operator-facing document covering what it does, what normal looks like, what breaks it, what it will not do, and what maintenance covers. Use when handing over a workflow, when asked for a runbook or handover document, or when a build is finished and needs its operator documentation.
when_to_use: A workflow, integration or automation is being handed to someone who will operate it but did not build it. Also use to review an existing runbook for gaps.
argument-hint: <workflow directory or name>
---

# Client handover runbook

The artefact that makes a maintenance retainer worth buying. It is written for **whoever operates
this day to day, not for a developer** — if they can find the workflow and open a node, they can
follow it.

A runbook that only describes the happy path is worse than none, because it implies the failures
do not exist.

## Before writing

Read the workflow itself — not the README. You need the actual node names, the actual flag
strings, the actual thresholds, the actual retry settings. Every symptom in the table below must
be one this workflow can really produce, and every fix must name the real node it happens in.

If something cannot be determined from the workflow (which Slack channel an opaque webhook posts
to, whose account a token bills), do not invent it. Either mark it as a gap for the client to fill
at handover, or leave a clearly-marked placeholder.

## Structure

Use these sections in this order. Sections marked optional are included only when the workflow
warrants them.

**Title and standfirst** — `# Runbook — <Workflow name>`, then this exact italic line, which is
fixed across the whole handover set and is not to be reworded:

> *The artefact that makes a maintenance retainer worth buying. Handed over with every build.*

Then the line addressing the operator: written for whoever operates this day to day, not for a
developer — if they can find the workflow in n8n and open a node, they can follow it. Close the
preamble with a `---` rule. Use `---` between major sections thereafter; they carry the page
breaks in the rendered PDF.

**What it does** — Two or three sentences of plain description, then the single most important
behavioural fact in bold. For an extractor that is *"It is designed to tell you when not to trust
it."* For anything that drafts outbound communication it is *"It never sends anything."* Lead with
whichever fact prevents the most expensive misunderstanding.

**Where each item goes** *(optional)* — When a workflow routes into more than one destination, a
table of destination, what lands there, and what the operator does with it. Always include the
fallback route — the one that catches anything the rules did not match — because that is the row
the operator meets when something unexpected arrives.

**How the score is worked out** *(optional)* — When routing depends on a calculation, show all
three parts: the points table, the thresholds that turn a score into a priority, and any
condition that overrides the score outright. Showing only the points table leaves the operator
unable to answer why something scored 40 and still came out top priority.

**Normal operation** — What a healthy run looks like, and explicitly **which warnings are normal
and healthy**. Name the routine flags verbatim so nobody escalates them. Then say what *is* worth
noticing, which is almost always a *change* in rate rather than any single occurrence.

**The checks it runs** *(when the workflow validates or scores in code)* — A numbered table of
every check and precisely what makes each one fire. State that these run in code rather than in
the model. A workflow that only classifies and routes has no such table; do not invent one.

**What breaks it, and what to do** — The centrepiece. A three-column table: symptom as the
operator experiences it, likely cause, and what to do. Cover at minimum: the credential expiring
or hitting a limit, a date or format read the wrong way, an input shape the workflow has not seen,
the workflow silently deactivating after an edit, duplicates, and anything ambiguous by nature
such as currency symbols. Write symptoms as observed effects, not as error classes — "everything
is suddenly flagged", not "authentication failure".

Include whichever of these the workflow can actually produce: the credential expiring or hitting
a rate limit; a date or number format read the wrong way round; an input shape never seen before;
the workflow silently deactivating after an edit; duplicates from a double trigger; a value
ambiguous by nature such as a currency symbol. For anything model-driven, add the two classes
specific to it — output that is confidently wrong rather than absent, and a change in behaviour
after a model version update. Never list a symptom the workflow cannot produce.

**Re-running** *(optional but strongly preferred)* — State plainly whether a re-run is safe, and
why. If there is no idempotency, say re-running duplicates and say what to delete. This is the
first thing anyone tries and the most common way a well-built workflow causes damage.

**What to do with a flagged item** *(optional)* — Where to look, what names the failing check, and
that repeated flags for the same source are worth reporting because they are usually a small
permanent fix.

**What it will not do** — Stated plainly so there are no surprises. Include what it does not send
or file on its own, what input it is unreliable on, and what judgements it does not make. This
section is a scope boundary and protects both sides; never soften it.

**What monthly maintenance covers** — What the retainer actually buys, in concrete terms:
watching rates for change, adding new sources as they appear, rotating keys, keeping up with model
version changes, testing platform upgrades before they are taken. Where a test suite exists, name
the command and give the concrete cross-breakage clause rather than a general reassurance — "the
test suite (`node test/logic-test.mjs`) is run after every change, so a fix to one supplier's date
format cannot quietly break another's arithmetic".

**Hosting** — Whose infrastructure and whose credentials. Say the client owns it outright and it
keeps running whatever happens to you.

**Footer** — After a closing `---`, an italic paragraph distinguishing the demonstration version
from a client build *and naming what a client build fills in* — the supplier or source list, the
real destinations, and the contact routes. Two sentences, matching the existing runbooks.

## Voice

- Address the operator as "you". Refer to the builder as "me".
- British English. `normalise`, `prioritised`, `artefact`.
- Plain declarative sentences. No marketing register, no reassurance that is not earned.
- Bold the fact that prevents an expensive mistake, not every third phrase.
- Where a limit is a real trade-off, name the number and why — "26 hours, not 24, so a quiet
  Sunday doesn't cry wolf". Round numbers with no reasoning read as guesses.
- Never claim the workflow is reliable. Show what it does when it is not.

## Finishing

If the project renders runbooks to PDF, regenerate it from the markdown rather than editing the
PDF — they must not be allowed to diverge. In this repository that is `node render-pdf.mjs <file>`.

Then re-read the "what breaks it" table and ask the honest question: if the person covering for me
were handed only this, what would they still not be able to work out? Anything that surfaces goes
in the table or into a gap list.
