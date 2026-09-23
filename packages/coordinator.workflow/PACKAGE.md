# `coordinator.workflow` package charter

## Purpose

Defines coordinator mission envelopes, trusted artifacts, review packets, and fences.

## Public API

`src/lib/coordinator-workflow/`.

## Allowed dependencies

None observed by Q46.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not perform effects or elevate untrusted mission/feed content to authority.

## Verification

`node tests/coordinator.workflow/coordinator-workflow-acceptance.test.js`;
`node tests/package-charters.js`.
