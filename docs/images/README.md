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
| `test-run-all-workflows.png` | The test suite: **`158 passed, 0 failed`**, with a sample of assertions from three of the four workflows | Verbatim `node test/logic-test.mjs`. The `⋮` marks show the listing is truncated for space — the total is not |
| `test-run-invoice-extractor.png` | **`22 passed, 0 failed`** — the invoice extractor's own tests | Verbatim `node test/logic-test.mjs 01-invoice-extractor`. Use this one wherever the claim is about the invoice workflow alone |

> ### ⚠️ These were named `test-run-62-passed*.png` until 18 Aug 2026, and the count in the filename is why they went stale
>
> The suite has run 62, then 92, 113, 156 and now **158** assertions. **A number baked into a filename
> cannot be kept true**, and it silently contradicts the image the moment a test is added — which is
> exactly what happened: the file still said 62 long after the total had moved.
> ▶️ **The new names say what the image COVERS, not how many.** Renamed with `git mv`, so history follows.
>
> 🔑 **And the number on the image must match the command printed above it.** Relabelling the all-workflows
> image to `22` was considered and rejected: its `ok` lines come from three different workflows, so a
> filtered command would not produce them. That is why the invoice figure is a **separate render**, not
> an edit — see `income-2k-2026/launch/gallery/README.md`.
>
> **Per workflow: 22 · 13 · 27 · 96 → 158.** Quote the one that matches what is being claimed.
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
