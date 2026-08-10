# Figures

Rendered figures used in write-ups about this repo. **Every value on them is real output from the
code in this repository** — nothing is mocked up, and each image carries its own disclosure line
stating that these are self-initiated demonstration projects rather than client work.

| File | What it shows | Where the values come from |
|---|---|---|
| `test-run-62-passed.png` | The test suite run: `62 passed, 0 failed`, with a sample of assertions from all three workflows | Verbatim output of `node test/logic-test.mjs`. The `⋮` marks indicate the listing is truncated for space — the totals are not |
| `runbook-symptom-table.png` | The four-row runbook symptom table handed over with workflow 03: canary silence, dead-letter depth, duplicates, and silent deactivation | Every string is verbatim from [`03-reliable-pipeline/README.md`](../../03-reliable-pipeline/README.md) § Runbook |

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
