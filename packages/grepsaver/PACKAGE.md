# `grepsaver` package charter

## Purpose

Maintains bounded orientation, extraction, and system-card discovery helpers.

## Public API

Tools: `tools/grepsaver-check.js`, `tools/grepsaver-extract.js`,
`tools/grepsaver-lib.js`, `tools/grepsaver-migrate-zones.js`,
`tools/grepsaver-orient.js`, `tools/grepsaver-tooldigest.js`,
`tools/grepsaver-reindex.js`.

## Allowed dependencies

Q46-observed: `kernel.runtime`.

`kernel.runtime`: `tools/grepsaver-tooldigest.js` spawns a child to build the
digest and takes the scrubbed environment from `env-scrub.js` rather than
hand-rolling a delete list.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not present cards as authority or replace live verification with a search hit.

## Verification

`node tools/grepsaver-check.js`; `node tests/package-charters.js`.
