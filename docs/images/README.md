# Figures

Rendered figures used in write-ups about this work. **Every value on them is real output** — nothing
is mocked up, and each image carries a disclosure line on its face.

## From the audit example (`04-audit-example`)

⚠️ **These describe a deliberately flawed workflow that is the *subject* of the example, not a sample
of how I build.** It is my own workflow, written for the demonstration. No client work and no client
data appears in it. Every figure says so on its face.

| File | What it shows | Where it comes from |
|---|---|---|
| `audit-risk-register.png` | The five-row failure-risk register: `R1` duplicates 4h, `R2` loses data 2h (**fix first**), `R3` loses data 3h, `R4` stops silently 2h, `R5` stops silently 3h. Totals 20 hours | [`AUDIT-REPORT.md`](../../04-audit-example/AUDIT-REPORT.md) §2 |
| `audit-dependency-map.png` | What calls what across both flows, with `SHARED-GOOGLE-001` spanning three nodes in two independent flows, and `R2`'s missing error path annotated | [`AUDIT-REPORT.md`](../../04-audit-example/AUDIT-REPORT.md) §1 |
| `audit-prioritised-backlog.png` | The eight-item backlog ordered by risk against effort, 20 hours total, with items 1–2 (five hours) closing both data-loss findings | [`AUDIT-REPORT.md`](../../04-audit-example/AUDIT-REPORT.md) §4 |

Findings `R3`, `R4` and backlog item 4 were verified by **executing the audited workflow's own Code
node source**, read straight out of `naive-workflow.json` so it cannot drift:

```bash
node 04-audit-example/verify-findings.mjs   # 10 checks, no API key, no n8n instance
```

## From the three working workflows

| File | What it shows | Where it comes from |
|---|---|---|
| `test-run-62-passed.png` | The test suite: `62 passed, 0 failed`, with a sample of assertions from all three workflows | Verbatim `node test/logic-test.mjs`. The `⋮` marks show the listing is truncated for space — the totals are not |
| `runbook-symptom-table.png` | The four-row runbook symptom table handed over with workflow 03 | Verbatim from [`03-reliable-pipeline/README.md`](../../03-reliable-pipeline/README.md) § Runbook |
| `invoice-to-structured-data.png` | A receipt read into structured JSON with `review_required: true`, where the net was **derived** (12.35 − 2.06 = 10.29) rather than read | [`01-invoice-extractor/workflow.json`](../../01-invoice-extractor/workflow.json), node *"Validate & Normalise"*. **Sample document invented, extracted values real** — the image says so |
| `flagged-for-review.png` | The same workflow declining to guess: `review_required: true` with both real reasons, cross-referenced to the fields they explain | As above |
| `pipeline-dedup-fingerprints.png` | Five events in, two messages out — with the real content fingerprints that suppressed the duplicates | Workflow 03. Fingerprints reproduced by executing the real `fnv1a` source from the *Normalise & Fingerprint* node |
| `dead-letter-entry.png` | A dead-letter entry from a **real execution**, showing the captured error and `replayable: true` | Read out of the stored execution record in n8n's SQLite database after a genuine `ECONNREFUSED` |

## Not from this repository

| File | What it shows |
|---|---|
| `arctic-air-demo-site.png` | Hero of a **separate** demonstration project — a scroll-driven 3D site for a fictional air-conditioning company. A headless-Chrome capture of the live page; included only because it needs a stable public URL. Its fixed banner declaring the company fictional is retained deliberately |

## Framing

`arctic-air-demo-site.png` is cropped in CSS rather than pre-cropped, so the framing stays
reviewable: the capture is 2560×1538 and the figure keeps the top 2560×1356, dropping an
un-dismissed cookie-consent control. Nothing is retouched or recoloured.
