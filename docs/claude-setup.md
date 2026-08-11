# Claude Code setup

What lives in `.claude/`, and how to make the parts that are not repository-specific available in
every project.

## What is here

| Path | Scope | What it does |
|---|---|---|
| `CLAUDE.md` (repo root) | This project | The conventions that are load-bearing — model reads/code decides, tests read node source, `04-audit-example` is deliberately flawed and must not be fixed |
| `.claude/skills/runbook/` | Portable | Writes a client handover runbook in the house format |
| `.claude/skills/automation-audit/` | Portable | Audits an existing automation for the ways it fails without anyone finding out |
| `.claude/global-CLAUDE.md` | Not loaded from here | Standing preferences for every project. Nothing in this repo reads it — it only takes effect once symlinked to `~/.claude/CLAUDE.md` below |
| `.claude/settings.json` | This project | The test hook, plus a short allowlist pre-approving the repo's own read-only and test commands |
| `.claude/hooks/run-logic-tests.sh` | This project | The script that hook calls |

## Installing the portable parts globally

Symlink rather than copy. A copy is a second source of truth and will drift from this one — the
same reason the runbook PDFs are generated from their markdown rather than maintained alongside
it.

**Read this before running the block.** `~/.claude/CLAUDE.md` is your existing global memory file
and the third symlink replaces it; if you already have skills called `runbook` or
`automation-audit`, those are replaced too. The block below moves anything it finds to a `.bak`
name first rather than deleting it, but check what you have.

```bash
REPO="$HOME/path/to/n8n-portfolio"     # wherever this repository lives
[ -d "$REPO/.claude/skills" ] || { echo "REPO is wrong: $REPO"; return 2>/dev/null || exit 1; }

mkdir -p ~/.claude/skills

# Move anything real out of the way; a dangling symlink is fine to overwrite.
for p in ~/.claude/CLAUDE.md ~/.claude/skills/runbook ~/.claude/skills/automation-audit; do
  [ -e "$p" ] && [ ! -L "$p" ] && mv "$p" "$p.bak" && echo "kept your $p as $p.bak"
done

# -T so an existing directory is replaced rather than linked *inside*.
ln -sfnT "$REPO/.claude/skills/runbook"           ~/.claude/skills/runbook
ln -sfnT "$REPO/.claude/skills/automation-audit"  ~/.claude/skills/automation-audit
ln -sfnT "$REPO/.claude/global-CLAUDE.md"         ~/.claude/CLAUDE.md
```

On macOS `ln` has no `-T`; use `ln -sfn` there, having confirmed the destinations are not existing
directories — `ln -sfn` into a real directory creates the link *inside* it and still exits 0, so
the skill silently does not install.

Verify with `/skills` (both should be listed) and `/memory` (the global file should appear as a
user-scope memory). Edits to the files in this repository take effect immediately in every
project, because the symlinks point at one copy.

**What this couples.** `~/.claude/CLAUDE.md` now points inside a git working tree, so ordinary git
operations move your global preferences: switching branches rewrites the file, and moving or
deleting the checkout leaves the symlink dangling. If that is not a trade you want, copy the file
instead and accept that it will drift.

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

When **Claude** edits a `workflow.json` or anything under `test/` with the Edit or Write tool, it
runs `node test/logic-test.mjs` immediately and the failure is reported back in the same turn
rather than discovered later.

It is a safety net on Claude's edits, not on the repository. Changes made through the shell
(`sed -i`, a heredoc, `git checkout`, applying a patch) or by you in an editor do not trigger it,
so run the suite yourself before committing. The suite re-runs itself under four timezones, so a
date regression that is invisible under UTC still fails.

Editing anything under `04-audit-example/` runs `node 04-audit-example/verify-findings.mjs`
instead. That workflow is the *subject* of the audit and its bugs are load-bearing, so the
verifier failing is the signal that somebody has "improved" it and invalidated the report.

The hook is approved on first use. To see it, run `/hooks`.
