# `repo-protocol` package charter

## Purpose

Owns the repository's root queue protocol, declared package-slice index, and
the `queue/repo-protocol.md` work slice without claiming application source.

## Public API

`BUILD-QUEUE.md` and the package slice paths it canonically declares.

## Allowed dependencies

Package ids from `config/packages.json`; no runtime dependency.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not infer phase ownership, admit unindexed slices, duplicate phase ids, or
rewrite verbatim queue bodies during migration.

## Verification

`node tests/build-queue-corpus.js`; `node tests/build-queue-migration.js`;
`node tests/package-charters.js`.
