# Invoice & Receipt → Structured Data

Turns unstructured supplier documents — invoices, till receipts, subscription bills — into
clean rows ready for an accounting system, and flags the ones a human should actually look at.

Self-initiated demonstration project. The three sample documents are invented.

---

## The problem it solves

A small business receives supplier documents in every format there is: a properly laid-out PDF
invoice, a photographed till receipt, a subscription email in euros. Someone types them into
Xero or a spreadsheet. It takes hours a week, and the errors it produces are the expensive kind,
because a mistyped VAT figure is not obviously wrong.

Straightforward AI extraction makes this worse rather than better. A model asked to read an
invoice will confidently return a total that does not match its own line items, and nothing
downstream notices.

## How it works

```
Trigger → Load documents → Extract fields (Gemini) → Validate & normalise (code) → ├─ flagged for review
                                                                                   └─ ready to export
```

**1. Load documents.** Three sample documents inline. In a deployment this is a Gmail trigger on
an accounts inbox, a Drive folder watcher, or a webhook — everything downstream is unchanged.

**2. Extract fields.** An Information Extractor node with a typed schema: supplier, reference,
date, currency, net, VAT, gross. Temperature 0, and the system prompt explicitly forbids
inventing values — a missing field returns empty rather than plausible.

**3. Validate and normalise.** This is the node that matters, and it is plain JavaScript:

- **Does the arithmetic hold?** Net + VAT must equal gross within 2p. If not, flagged.
- **Reconstruct what was not stated.** A till receipt shows gross and VAT but no net. Net is
  derived and the derivation recorded, rather than left as zero.
- **Is the VAT rate plausible?** Checked against the UK bands (0%, 5%, 20%) with tolerance.
  Anything else is flagged as unusual rather than silently accepted.
- **Normalise the date.** `14/07/2026`, `09 Jul 2026` and `1 July 2026` all become ISO. UK
  day-first order is assumed, which matters: `07/08/2026` is 7 August, not 8 July.
- **Are the required fields present?** Missing supplier or gross is flagged.

**4. Two outcomes.** Clean rows go to export. Doubtful ones carry the specific reason they were
flagged, so the person reviewing knows what to check instead of re-reading the document.

## What the samples demonstrate

| Document | What it tests |
|---|---|
| Northgate Supplies invoice | The clean case — well-formed invoice, UK date format, arithmetic reconciles |
| Café Rosetta till receipt | No invoice number, no net stated, VAT inclusive. Net must be derived and the missing reference flagged |
| Meridian Cloud invoice | Non-GBP currency, prose layout rather than a table, spelled-out date |

## Deploying it for a client

Replace the *Load Sample Documents* node with the real source, and add an output node — Google
Sheets, Xero, or a CSV export. Everything between stays as it is.

The two things worth setting up properly at deployment: where flagged documents go (a Slack
channel or an email digest works better than a spreadsheet nobody opens), and whether the client
wants derived values written automatically or held for approval.

---

## Demo video script — 90 seconds

**0:00–0:10 — the problem.** Screen shows the three sample documents side by side.
> "Three supplier documents. A proper invoice, a photographed till receipt, and a subscription
> bill in euros. Someone has to type all of these into the accounts."

**0:10–0:25 — the run.** Click Test workflow. Nodes light up in sequence.
> "This reads all three, pulls out supplier, date, net, VAT and total, and checks the numbers
> actually add up."

**0:25–0:45 — the clean result.** Open the *Ready to Export* node output.
> "Two came through clean. Structured, dated in ISO format, ready to import into Xero or a sheet."

**0:45–1:10 — the flagged one, the important bit.** Open the *Flag for Review* output and point
at `review_reasons`.
> "This one is flagged. The receipt had no invoice number and didn't state a net figure, so the
> workflow derived it and said so. It's not guessing and hoping — it's telling you exactly what
> it wasn't sure about."

**1:10–1:25 — why that matters.**
> "The arithmetic isn't done by the AI. The AI reads the document; the checking is plain code.
> That's why you can trust the output — because it tells you when not to."

**1:25–1:30 — close.**
> "Runs on your own n8n, connects to your inbox and your accounting system. Repo linked below."

**Recording notes:** 1280×720 minimum. No music. Show real node output, not slides — the output
panel with actual JSON is the most convincing thing in the video. Keep the cursor still while
talking.
