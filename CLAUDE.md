# CLAUDE.md

## Active work: `06-scalping-copilot/`

A 5-minute scalping dashboard for XAUUSD and BTCUSD, built for one user who trades
the London session on MetaTrader 5 on an iPhone.

**Before touching it, read `06-scalping-copilot/HANDOFF.md` in full.** It holds the
live page URL and how to republish it from a new conversation, the user's confirmed
broker specification, the research behind the design, and a list of decisions that
look like mistakes and are not — among them the absence of any session countdown,
the dead zone withholding its read, and the edge test refusing a verdict before a
pre-declared sample. Several of those were reversed once already, deliberately.

```
cd 06-scalping-copilot
node build.mjs          # src/*.js -> index.html (never edit index.html by hand)
node test/run-all.mjs   # unit suites
node test/smoke.mjs     # real browser; run after any UI change
```

Branch: `claude/xauusd-btcusd-chart-analysis-8pvje5`.

## The rest of this repository

Directories `01`–`05` are an n8n automation portfolio. Its conventions are in the
root `README.md`: every build ships a runbook, and every README says plainly what
the thing does **not** do. The same standard applies to `06`.
