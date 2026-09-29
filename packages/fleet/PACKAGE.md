# `fleet` package charter

## Purpose

Runs bounded agent lanes, review, worktree, session/roster supervision, and
the cloud-agent (FileKeeper/Codex Cloud) and native-agent custody loops.

Account probes, registry writes and rotation execute here. The canonical
account-home schema, registry location and pure allowance-ordering rules are
owned by `surface.policy`, which supplies their admission policy.

## Public API

`src/lib/build-queue-corpus.js`, `src/lib/build-queue-migration.js`,
`src/lib/build-queue-package-contract.js`, `src/lib/build-queue-projection.js`,
`src/lib/build-queue-slice.js`, `src/lib/build-queue-writer.js`,
`src/lib/fleet-supervisor/`, `src/lib/agent-lane.js`, `src/lib/agent-onboarding.js`,
`src/lib/agent-presence.js`, `src/lib/agent-wake.js`, `src/lib/agent-wake/`,
`src/lib/cloud-agent/`, `src/lib/council/`, `src/lib/providers/codex-cloud.js`,
`sidecars/native-agent/`; tools: `tools/agent-roster.js`,
`tools/build-queue-migrate.js`, `tools/fleet-supervisor.js`, `tools/gemini-agentic-run.js`,
`tools/gemini-fleet.js`, `tools/gemini-fleet.test.js`,
`tools/agent-preflight.js`, `tools/agent-onboarding.js`,
`tools/agent-preflight-role-line.js`, `tools/agent-sweep.js`, `tools/agent-wake.js`,
`tools/claude-session-heartbeat.js`, `tools/claude-session-register.js`,
`tools/cloud-lane.js`, `tools/council-tally.js`, `tools/lane-quality.js`,
`tools/lane-run.js`, `tools/lane-territory-check.js`,
`tools/native-agent-submit.js`, `tools/native-agent-worker-reconcile.js`.

Customer-facing role and project-hook activation directions ship at
`docs/AGENT-ONBOARDING.md`. Documentation is recorded here rather than in
`config/packages.json`, whose executable package contract accepts only JavaScript
under `src/`, `tools/`, and `sidecars/`.

## Allowed dependencies

Q46-observed: `controller`, `fra`, `grepsaver`, `coordinator.core`, `kernel.audit`,
`kernel.policy`, `kernel.runtime`, `models`, `owner.digest`, `owner.inbox`,
`owner.ledger`, `providers.gateway`, `repo-gate`, `sched`, `surface.policy`,
`surface.registry`.

`grepsaver`: `tools/agent-preflight.js` reads `tools/prior-work-index.js` so an
onboarding agent is oriented from the prior-work index, not from a fresh grep.

## Action classes

`SPAWN`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not accept a lane without independent review or bypass worktree isolation.

## Verification

`node tests/fleet-supervisor.js`; `node tests/package-charters.js`.
