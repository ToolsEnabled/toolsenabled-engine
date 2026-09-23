# `entry.ledger` package charter

## Purpose

Composes the desktop's Ledger continuation and owner-confirmed category reset
entrypoints. The controller schedules authorized work; the canonical stores
retain task, rule, ask, purchase and reset-journal authority.

## Public API

`src/lib/agent-ledger-continuation.js` retains the host's existing constructor
and exports. It supplies the controller with a fresh canonical T-ledger read
and history verification. The controller receives this reader as a dependency
and checks it again before sending a delayed turn.

`src/lib/ledger-category-reset.js` previews and confirms T/R/A/P resets for the
owner. Purchase resets compose the canonical Ledger and owner-prompt journal
so retries finish the captured reset without deleting later purchases.

## Allowed dependencies

`controller` for continuation scheduling, `owner.ledger` for canonical records
and history, and `mission-bridge` for the purchase reset journal.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not complete or claim tasks, bypass Stop or reset fences, approve purchases,
spend money, or accept agent-origin category resets. Do not duplicate canonical
stores, journals or the controller's scheduling logic.

## Verification

`node --test tests/owner-request-store.test.js tests/reset-delayed-consumers.test.js
tests/agent-continuation-person-stop.test.js tests/agent-continuation-acp-success-status.test.js`;
`node tools/package-check.js`.
