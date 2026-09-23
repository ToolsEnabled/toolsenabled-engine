#!/usr/bin/env bash
# T378 -- the engine rotation gate, mutation-checked.
#
# THE GATE. tests/multi-account-rotation.test.js, check "Rotate recorded at the
# top of the registry takes turns across eight starts with a stale by-hand
# choice still saved (T378)". It holds two things T378 turns on: with no
# program rule of its own the resolver runs ROTATE and takes turns across
# eight starts, and with one recorded, that program's own rule still outranks
# the rule above while DYNAMIC still honours the by-hand pin.
#
# The engine was never at fault for the 18-of-30 measurement, so this file is
# a characterisation gate: it exists to catch a LATER change that breaks what
# already works. A gate nothing can break is not a gate, so it is mutated.
#
# THE MUTATION. src/lib/multi-account/rotation.js, the `pinned` decision that
# suppresses a standing by-hand pin while ROTATE is the chosen mode. The
# mutant lets the pin decide under ROTATE too, which is the shape of the T378
# complaint: every start returns to the one pinned account. A behaviour
# change, not a spelling change.
#
# Usage:  bash tools/repro/t378-rotation-gate.sh
#         NODE_BIN=/path/to/node bash tools/repro/...
set -u

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OUT="$(mktemp -d)"

SUBJECT=src/lib/multi-account/rotation.js
SUITE=tests/multi-account-rotation.test.js
ORIGINAL='const pinned = chosenSelection === MODE.ROTATE ? null : recordedPin;'
MUTANT='const pinned = recordedPin;'

cd "$ENGINE"

version="$("$NODE_BIN" -v 2>/dev/null || true)"
if [ "$version" != "v22.19.0" ]; then
  echo "REFUSED - this suite needs node v22.19.0; \$NODE_BIN reports '${version:-nothing}'."
  echo "          Set NODE_BIN to a v22.19.0 binary and run again."
  exit 2
fi

BACKUP="$(mktemp)"
cp "$SUBJECT" "$BACKUP"
restore() { cp "$BACKUP" "$SUBJECT"; }
trap 'restore; rm -f "$BACKUP"' EXIT

# Literal (not regex) replace that PRINTS ITS MATCH COUNT and refuses at zero:
# the line contains [key]-style brackets elsewhere in this file that a regex
# would read as a character class, and a mutation that matched nothing would
# report "still green" while nothing was mutated.
mutate() {
  FROM="$1" TO="$2" FILE="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { FILE: f, FROM: from, TO: to } = process.env;
    const src = fs.readFileSync(f, "utf8");
    const count = src.split(from).length - 1;
    console.log("     match count: " + count);
    if (count === 0) { console.error("     MUTATION MATCHED NOTHING - refusing to report a verdict"); process.exit(3); }
    fs.writeFileSync(f, src.split(from).join(to));
  '
}

run() {
  local label="$1" out="$2"
  # Redirected, never piped: a pipe discards the exit code.
  "$NODE_BIN" "$SUITE" > "$out" 2>&1
  local code=$?
  echo "   [$label] exit=$code"
  tail -1 "$out" | sed 's/^/     /'
  grep '^not ok' "$out" | sed 's/^/     /'
  return $code
}

echo "node      $version"
echo "subject   $ENGINE/$SUBJECT  (the ROTATE pin suppression)"
echo "logs      $OUT"
echo

echo "== tip (as shipped)"
run "tip" "$OUT/tip.log"; TIP=$?
[ $TIP -eq 0 ] && echo "   => tip VERDICT: GREEN" || echo "   => tip VERDICT: RED"

echo
echo "== mutant (a standing by-hand pin decides under ROTATE too)"
mutate "$ORIGINAL" "$MUTANT" "$SUBJECT" || exit 2
run "mutant" "$OUT/mutant.log"; MUT=$?
[ $MUT -ne 0 ] && echo "   => mutant VERDICT: RED" || echo "   => mutant VERDICT: GREEN"

restore

echo
if [ $TIP -eq 0 ] && [ $MUT -ne 0 ]; then
  echo "PASS - tip GREEN, mutant RED (expected GREEN, RED)"; exit 0
fi
echo "FAIL - expected tip GREEN and mutant RED"; exit 1
