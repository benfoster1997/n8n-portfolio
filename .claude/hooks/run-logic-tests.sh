#!/usr/bin/env bash
#
# Runs the relevant test suite immediately after Claude edits a Code node or a test,
# so a broken node cannot be handed over without it being noticed in the same turn.
#
# Editing anything under 04-audit-example/ instead runs the audit verifier, which fails
# if the deliberately-flawed workflow has been "improved" — that workflow is the subject
# of AUDIT-REPORT.md and its bugs are load-bearing.
#
# Wired up as a PostToolUse hook in .claude/settings.json.
# Exit 2 reports the failure back to Claude; exit 0 stays silent.

set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

file="$(node -e '
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const input = JSON.parse(s).tool_input || {};
      process.stdout.write(input.file_path || "");
    } catch {
      process.stdout.write("");
    }
  });
' 2>/dev/null)"

[ -n "$file" ] || exit 0

# run <label> <script> — prints failures to stderr, returns 1 if the suite failed
run() {
  local label="$1" script="$2" output
  [ -f "$root/$script" ] || return 0

  if ! output="$(cd "$root" && node "$script" 2>&1)"; then
    printf '%s failed after editing %s\n\n%s\n' "$label" "$file" "$output" >&2
    return 1
  fi
  return 0
}

failed=0

case "$file" in
  *04-audit-example*)
    run 'The audit verifier' '04-audit-example/verify-findings.mjs' || failed=1
    ;;
  *workflow.json | */test/* | test/* | *logic-test.mjs)
    run 'The logic tests' 'test/logic-test.mjs' || failed=1
    ;;
esac

[ "$failed" -eq 0 ] || exit 2
exit 0
