# Claude Code setup

What lives in `.claude/`, and how to make the parts that are not repository-specific available in
every project.

## What is here

| Path | Scope | What it does |
|---|---|---|
| `CLAUDE.md` (repo root) | This project | The conventions that are load-bearing — model reads/code decides, tests read node source, `04-audit-example` is deliberately flawed and must not be fixed |
| `.claude/skills/runbook/` | Portable | Writes a client handover runbook in the house format |
| `.claude/skills/automation-audit/` | Portable | Audits an existing automation for the ways it fails without anyone finding out |
| `.claude/global-CLAUDE.md` | Portable | Standing preferences that apply to every project, not just this one |
| `.claude/settings.json` | This project | Runs the relevant test suite after any edit to a Code node or test |
| `.claude/hooks/run-logic-tests.sh` | This project | The script that hook calls |

## Installing the portable parts globally

Symlink rather than copy. A copy is a second source of truth and will drift from this one — the
same reason the runbook PDFs are generated from their markdown rather than maintained alongside
it.

```bash
REPO="$HOME/path/to/n8n-portfolio"     # wherever this repository lives

mkdir -p ~/.claude/skills
ln -sfn "$REPO/.claude/skills/runbook"           ~/.claude/skills/runbook
ln -sfn "$REPO/.claude/skills/automation-audit"  ~/.claude/skills/automation-audit
ln -sfn "$REPO/.claude/global-CLAUDE.md"         ~/.claude/CLAUDE.md
```

If `~/.claude/CLAUDE.md` already exists, move it aside first — that symlink replaces it.

Verify with `/skills` (both should be listed) and `/memory` (the global file should appear as a
user-scope memory). Edits to the files in this repository take effect immediately in every
project, because the symlinks point at one copy.

## What you get

`/runbook <workflow>` produces a handover document in the fixed structure: what it does, what
normal looks like, which warnings are healthy, what breaks it and what to do, what it will not do,
what maintenance covers, and hosting. Written for an operator rather than a developer.

`/automation-audit <export file>` produces a dependency map, a failure-risk register classified by
consequence, the five standing checks, a prioritised backlog with hour estimates, a runbook gap
list, and an explicit statement of what was not examined. Findings that concern code are proven by
executing that code, not asserted.

Both are usable against any n8n, Make or Zapier export, so they travel to client work rather than
only applying to this repository.

## The test hook

Any edit to a `workflow.json`, or to anything under `test/`, runs `node test/logic-test.mjs`
immediately. If it fails, the failure is reported back to Claude in the same turn rather than
being discovered later.

Editing anything under `04-audit-example/` runs `node 04-audit-example/verify-findings.mjs`
instead. That workflow is the *subject* of the audit and its bugs are load-bearing, so the
verifier failing is the signal that somebody has "improved" it and invalidated the report.

The hook is approved on first use. To see it, run `/hooks`.
