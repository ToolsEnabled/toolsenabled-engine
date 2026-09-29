# `evidence` package charter

## Purpose

Stores compact, verifiable evidence artifacts for later independent review.

## Public API

`src/lib/evidence-store.js`.

## Allowed dependencies

Q46-observed: `kernel.runtime`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not treat an evidence pointer as proof without checking its referenced record.

## Verification

`npm run test:evidence`; `node tests/package-charters.js`.
