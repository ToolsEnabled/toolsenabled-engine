# `mission-bridge` package charter

## Purpose

Owns the local Mission Control HTTP bridge: bounded action dispatch, owner
prompts, agent-lane dispatch, purchase recording, and termination control.

## Public API

In `src/lib/mission-bridge/`: `server.js`, `actions.js`,
`agent-lane-dispatch.js`, `codex-native-pair.js`, `errors.js`,
`owner-prompts.js`, `purchase-recording.js`, `termination.js`,
`research-actions.js`. Tools: `tools/mission-bridge.js`,
`tools/bridge-action-smoke.js`.

`api-contract.js` owns the versioned, data-only action-surface descriptor and
its schema/compatibility validator. Authenticated `GET /v1/contract` derives
the advertised action names from the actual server route table. Registration
does not promise platform readiness, credentials or permission, and does not
authorize a retry. This descriptor does not replace the action input schemas,
audit/approval gates, runtime discovery or the separate FRA transport protocol.

The owner's launch-approvals cart CONTENT is not here: `entry.approvals` owns
`tools/launch-approvals-cart.js`. It composes this package's owner-prompt engine
with three others and nothing imports it, which is the entry layer's shape, not
this domain's. Filed here it made two correct imports read as violations.

## Allowed dependencies

Q46-observed: `controller`, `delegation`, `entry.setup`, `fleet`, `kernel.audit`,
`kernel.policy`, `kernel.runtime` (state root), `models` (`local-node-runtime.js`
dispatch), `owner.inbox`, `owner.ledger`, `providers.billing`,
`providers.gateway`, `surface.policy`, `surface.registry`, `providers.research`.

Two names left this list with the cart: the fra and sched read-only lookups of
the dashboard port and the scheduled-task names. Those reads still happen, from
`entry.approvals`, and are declared in that charter instead. They are written
unbackticked here on purpose: names are backticked only in the list itself, so
removing one from the list is what this charter's test actually notices.

## Action classes

`RECORD`, `ASK`, `SPAWN`, `LOCAL-WORK`.

## Must not do

Do not bind beyond `127.0.0.1`, hand out the bootstrap bearer on an Origin
check alone, or let a dispatched action skip the registry's audit/approval
gates.

## Verification

`node tests/mission-bridge.test.js`; `node tests/mission-bridge-agent-lane.test.js`;
`node tests/mission-bridge-ledger-archive.test.js`; `node tests/package-charters.js`.
