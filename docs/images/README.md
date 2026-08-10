# Figures

Rendered figures used in write-ups about this work. **Every value on them is real output** — nothing
is mocked up, and each image carries its own disclosure line on its face stating that these are
self-initiated demonstration projects rather than client work.

| File | What it shows | Where it comes from |
|---|---|---|
| `test-run-62-passed.png` | The test suite run: `62 passed, 0 failed`, with a sample of assertions from all three workflows | Verbatim output of `node test/logic-test.mjs`. The `⋮` marks indicate the listing is truncated for space — the totals are not |
| `runbook-symptom-table.png` | The four-row runbook symptom table handed over with workflow 03: canary silence, dead-letter depth, duplicates, silent deactivation | Every string is verbatim from [`03-reliable-pipeline/README.md`](../../03-reliable-pipeline/README.md) § Runbook |
| `invoice-to-structured-data.png` | A receipt read into structured JSON, with `review_required: true` and both reasons — the net figure was **derived** (12.35 − 2.06 = 10.29) rather than read, and the image says so | [`01-invoice-extractor/workflow.json`](../../01-invoice-extractor/workflow.json), node *"Validate & Normalise"*. **The sample document is invented; the extracted values are the workflow's real output**, and the image discloses exactly that |
| `arctic-air-demo-site.png` | Hero of a **separate** demonstration project — a scroll-driven 3D site for a fictional air-conditioning company | A headless-Chrome capture of the live page at `arctic-air-hvac-uk.netlify.app`. Included here only because it needs a stable public URL; **it is not part of this repository's code.** The fixed banner declaring the company fictional is retained deliberately |

## Reproducing the test figure

```bash
node test/logic-test.mjs
```

Needs no API key and no credentials. The 62 assertions cover all three workflows (22 invoice
extractor, 13 enquiry triage, 27 reliable pipeline); the audit verifier in `04-audit-example` is a
separate 10 checks and is not included in that 62.

## Note on the 26-hour canary

The runbook figure shows the canary reporting on *"no deliveries in 26h"*. 26 rather than 24 is
deliberate: a scheduled job that runs slightly late should not raise an alarm. The corresponding
assertions are `30 hours of silence trips the alarm` and `25 hours does not false-alarm`.

## Framing

`arctic-air-demo-site.png` is cropped in CSS rather than pre-cropped, so the framing stays
reviewable: the capture is 2560×1538 and the figure keeps the top 2560×1356, which drops an
un-dismissed cookie-consent control at the foot of the viewport and leaves the ratio at 1.89:1.
Nothing else is altered — no retouching, no recolouring, and the disclosure bar is untouched.
