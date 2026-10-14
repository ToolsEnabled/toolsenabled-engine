#!/usr/bin/env bash
# ITEM 2 (a) -- the account router must answer "which account am I on".
#
# WHAT THIS GATES. Before this change, listAccountRouter returned allowance and
# health per account and nothing about which account was RUNNING.
# rotation.js activeAccountRecord() returns exactly that answer and had zero
# production callers in either repository. The owner reported "checking account
# status does not work"; the Accounts panel was correct all along, the
# agent-facing surface never answered. This gate holds the answer in place.
#
# EVERY MUTATION ASSERTS THREE THINGS, not one:
#   * the search string is NON-EMPTY -- an empty needle matches everywhere and
#     reports a huge count from a mangled file, a gate that proved nothing;
#   * the match count is NON-ZERO -- a needle that matches nothing mutates
#     nothing and reports "still green";
#   * the count is PLAUSIBLE for the edit -- a count equal to the file's line
#     count is the tell that the needle was empty, not that the edit was wide.
#
# Usage:  bash tools/repro/item2-router-says-which-account.sh
#         NODE_BIN=/path/to/node bash tools/repro/...
set -u

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OUT="$(mktemp -d)"

SUITE=tests/multi-account-rotation.test.js
PATTERN='account router'
ROUTER=src/lib/tool-registry.js
RECORD=src/lib/multi-account/rotation.js

cd "$ENGINE"

version="$("$NODE_BIN" -v 2>/dev/null || true)"
if [ "$version" != "v22.19.0" ]; then
  echo "REFUSED - this suite needs node v22.19.0; \$NODE_BIN reports '${version:-nothing}'."
  exit 2
fi

BR="$(mktemp)"; BC="$(mktemp)"
cp "$ROUTER" "$BR"; cp "$RECORD" "$BC"
restore() { cp "$BR" "$ROUTER"; cp "$BC" "$RECORD"; }
trap 'restore; rm -f "$BR" "$BC"' EXIT

mutate() {
  FROM="$1" TO="$2" FILE="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { FILE: f, FROM: from, TO: to } = process.env;
    if (!from || from.length === 0) {
      console.error("     REFUSED: the search string is EMPTY - an empty needle matches everywhere and proves nothing");
      process.exit(3);
    }
    const src = fs.readFileSync(f, "utf8");
    const lines = src.split("\n").length;
    const count = src.split(from).length - 1;
    console.log("     match count: " + count + "   (file is " + lines + " lines)");
    if (count === 0) { console.error("     REFUSED: matched nothing - nothing was mutated"); process.exit(3); }
    if (count >= lines) { console.error("     REFUSED: count >= line count - the needle cannot be this broad; treat as an empty/mangled needle"); process.exit(3); }
    fs.writeFileSync(f, src.split(from).join(to));
  '
}

run() {
  local out="$1"
  "$NODE_BIN" "$SUITE" > "$out" 2>&1
  local code=$?
  echo "     exit=$code"
  tail -1 "$out" | sed 's/^/       /'
  grep '^not ok' "$out" | grep -i "$PATTERN" | sed 's/^/       /'
  return $code
}

echo "node    $version"
echo "subject $ROUTER  +  $RECORD"
echo "logs    $OUT"
echo

echo "== GREEN: the tree as it stands"
run "$OUT/green.log" && GREEN=0 || GREEN=1
[ $GREEN -eq 0 ] && echo "   => GREEN" || echo "   => RED (expected GREEN)"

missed=0
check_mutant() {
  local label="$1" from="$2" to="$3" file="$4" log="$5"
  echo
  echo "== MUTANT $label"
  restore
  mutate "$from" "$to" "$file" || exit 2
  if run "$log"; then echo "   => GREEN (expected RED - the gate did NOT catch this)"; missed=1
  else echo "   => RED (the gate caught it)"; fi
}

# M1 -- the router stops carrying the answer at all. This is the state the
# product was in before item 2.
# Single-line needle: this subject is CRLF on disk, and a multi-line literal
# written with LF would match nothing and mutate nothing.
check_mutant "M1 router no longer reports the account in use" \
  '    inUse,' \
  '' \
  "$ROUTER" "$OUT/m1.log"

# M2 -- the active name is carried but the person's standing choice is not, so
# a start that ran somewhere they did not choose cannot be explained.
check_mutant "M2 the pin is dropped from the record" \
  '        PROVIDER_IDS.map(id => [id, manualPin(state, id)])' \
  '        PROVIDER_IDS.map(id => [id, null])' \
  "$RECORD" "$OUT/m2.log"

# M3 -- an unreadable reading silently becomes an empty one, so "not known"
# reads as "nothing is running".
check_mutant "M3 unreadable is reported as nothing running" \
  '      code: (error && error.code) || '"'"'ACCOUNT_SERVICES_ROOT_UNAVAILABLE'"'"',' \
  '      code: null,' \
  "$ROUTER" "$OUT/m3.log"

restore
echo
if [ $GREEN -eq 0 ] && [ $missed -eq 0 ]; then
  echo "PASS - tree GREEN and every mutant RED"; exit 0
fi
echo "FAIL - expected a green tree and every mutant caught"; exit 1
