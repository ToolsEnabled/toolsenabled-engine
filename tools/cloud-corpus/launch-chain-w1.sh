#!/bin/bash
# Wave-one serial launch chain: S4 -> S1 -> S2 -> website mirror republish ->
# plan+launch S5 -> plan+launch S6. Strictly serial (the batch runner has no
# cross-batch rate awareness; overlapping batches double the real rate), 30s
# breathing gap between batches. Each step's exit code is checked; a failed
# step stops the chain loudly rather than launching the next batch blind.
set -u
SP="${CORPUS_ROOT:?set CORPUS_ROOT to the directory holding decl-*.json and wave1/}"
ENGINE="${ENGINE_ROOT:?set ENGINE_ROOT to the engine repository root}"
export TOOLSENABLED_STATE_ROOT="$APPDATA/ToolsEnabled/capability"
if [ ! -d "$ENGINE" ]; then
  echo "CHAIN STOPPED: ENGINE_ROOT is not a directory" >&2
  exit 2
fi
cd -- "$ENGINE" || exit $?

step() {
  echo "=== $(date -u +%H:%M:%SZ) $1 ==="
}

launch() { # name, declaration
  step "LAUNCH $1"
  node tools/cloud-lane.js batch --declaration "$2"
  rc=$?
  if [ $rc -ne 0 ]; then echo "CHAIN STOPPED: batch $1 exited $rc"; exit $rc; fi
  sleep 30
}

launch s4-engine-tools "$SP/decl-w1-s4.json"
launch s1-app-src "$SP/decl-w1-s1.json"
launch s2-app-tests "$SP/decl-w1-s2.json"

step "republish website mirror"
node tools/cloud-mirror.js publish --project website
rc=$?
if [ $rc -ne 0 ]; then echo "CHAIN STOPPED: website mirror publish exited $rc"; exit $rc; fi

step "plan s5"
node tools/cloud-batch-plan.js --corpus "$SP/wave1/s5-products" --project website --batch-id w1-s5-products --launches-per-minute 43 --accounts 1 --provider "$SP/provider-w1-website.json" --out "$SP/decl-w1-s5.json"
rc=$?
if [ $rc -ne 0 ]; then echo "CHAIN STOPPED: s5 plan exited $rc"; exit $rc; fi
launch s5-products "$SP/decl-w1-s5.json"

step "plan s6"
node tools/cloud-batch-plan.js --corpus "$SP/wave1/s6-website" --project website --batch-id w1-s6-website --launches-per-minute 43 --accounts 1 --provider "$SP/provider-w1-website.json" --out "$SP/decl-w1-s6.json"
rc=$?
if [ $rc -ne 0 ]; then echo "CHAIN STOPPED: s6 plan exited $rc"; exit $rc; fi
launch s6-website "$SP/decl-w1-s6.json"

step "CHAIN COMPLETE: all six wave-one batches dispatched"
