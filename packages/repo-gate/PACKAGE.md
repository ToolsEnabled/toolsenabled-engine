# `repo-gate` package charter

## Purpose

Standalone CLI tools that gate or aggregate other checks before a commit or
push, and the repo-hygiene measurement primitives (test census, invocation
graph, dependency/naming/single-copy checks) those gates and the test runner
both read.

## Public API

`tools/check-chain-runner.js`, `tools/fork-ledger.js`,
`tools/lane-territory-gate.js`, `tools/check-comms-names.js`,
`tools/check-naming.js`, `tools/check-single-copy-work.js`,
`tools/dependency-acceptance.js`, `tools/git-destructive-reflog-check.js`,
`tools/invocation-graph.js`,
`tools/invocation-guard.js`, `tools/repo-sync.js`,
`tools/status-visibility-hook.js`, `tools/test-census.js`, `tools/test-run.js`,
`tools/resolve-node.js`.
Supporting library: `src/lib/dependency-acceptance.js`, `src/lib/proc/run.js`,
`src/lib/repo-sync-status.js`.

## Allowed dependencies

Q46-observed: `fleet`, `kernel.audit`, `kernel.runtime`, `surface.policy`. Most
files still spawn `git`/`node` as a child process rather than requiring another
package's module; the four declared edges are the exceptions, not a general
import right.

`kernel.runtime`: `repo-sync-status.js` reads `runtime-state-root.js` for the
sync-state directory.

Undeclared on purpose: three tools here require
`providers/subscription-launch-env.js`, so Q46 sees an edge to
providers.gateway -- unbackticked, so the finding stays visible. See
`packages/kernel.runtime/PACKAGE.md`: move that file, do not declare it.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not require another package's internals directly except the four declared
edges; invoke other checks as spawned child processes, the way
`tools/check-chain-runner.js` already does.

## Verification

`node tools/package-check.js`; `node tests/package-charters.js`;
`node tests/test-run-reconciliation.test.js`.
