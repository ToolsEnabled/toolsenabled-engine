# OpenShell candidate soak

The runner installs the newest numbered candidate from the channel, verifies its
archive identity, and exercises K1–K9 with scratch profiles. It uses the local
model simulator; it needs no provider sign-in or model allowance.

```sh
python3 adapters/openshell/soak/run.py --channel /sandbox/port-channel --once
```

Omit `--once` for the continuous release run. It requires inherited nice 10 or
permission to lower its own priority, pauses for 60 seconds between iterations,
honors `soak/PAUSE`, and holds the channel's runner lock. The coordinator owns the
dedicated release runner; do not start a competing continuous run in the login
sandbox. `--through K6` and similar partial runs are diagnostic evidence only.

K1–K8 use a fresh installation and state each iteration. K9 has a separate
installation of the same archive and keeps its MCP process and scratch state
alive across iterations. It repeatedly updates one fixed memory entry, checks
its revision and value, reads and patches one fixed file, and reads the ledger
and task queue. Its measurements
cover the retained process, descriptors, descendants, mutable state and services,
and tool-call latency. Audit is off for this bounded workload so normal audit
history is not mistaken for a leak.

K4 reads answers, completed ledger tasks and queue checkpoints back through a
second MCP session, then compares more than 50 filed records with both MCP
pagination and the terminal's `ledger --all`. K8 seeds a task, memory entry and
nondefault setting in the prior candidate, reads them after upgrade and after
a retained-state reinstall, and checks both state directories after confirmed
uninstall.

K7 reports whether audit was enabled and actually verified in
`verificationCoverage`. The standard setup has audit off. To check the
enabled-audit restart separately against an archive, use the opt-in isolated
test with `TOOLSENABLED_K7_CANDIDATE_DIRECTORY` set to its candidate directory:

```sh
TOOLSENABLED_K7_CANDIDATE_DIRECTORY=/sandbox/port-channel/candidates/candidate-6 \
  node tests/run-isolated.js tests/openshell-soak-restart.test.js
```

`soak/summary.json` records the candidate digest, process identity, sample count,
and elapsed lifetime with the latest K9 metrics. `trendReady` means enough
samples exist for the growth comparison; it does not mean the release's required
soak duration has elapsed. A one-shot run tests operation but cannot establish a
cross-iteration leak trend. An unexpected process exit is an error; the runner
does not silently replace that process and reset its baseline.

A candidate change closes and removes the old K9 installation before starting a
new series. Normal runner shutdown also closes its MCP process and removes its
scratch state. Harness restarts begin a new series, which the summary identifies
by its process start time and sample count.

All errors are classified in `soak/errors.jsonl`. The owner's release gate and
the coordinator's archive and hand-test records remain authoritative; passing a
local harness check does not publish or qualify a release.
