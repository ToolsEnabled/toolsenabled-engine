# `memory` package charter

## Purpose

Reserved boundary for future provider-neutral durable memory adapters.

## Public API

No Q46 file claim yet; durable-run memory remains in `coordinator.core`.

## Allowed dependencies

None observed by Q46.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not absorb coordinator mission context, secret data, or an unbounded event log.

## Verification

`node tests/package-charters.js`.
