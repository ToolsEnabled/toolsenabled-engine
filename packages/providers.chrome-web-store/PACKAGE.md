# `providers.chrome-web-store` package charter

## Purpose

Owns configured project boundaries and the Chrome Web Store and extension
provider adapters that remain assigned to this Q46 family.

## Public API

`src/lib/configured-project-boundary.js`;
`src/lib/providers/chrome-web-store-oauth.js`, `chrome-web-store.js`,
`extension.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `auth.google`, `desktop.native`,
`kernel.audit`, `kernel.policy`, `kernel.runtime`.

## Action classes

`OUTWARD`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not publish, change store configuration, or cross a configured project
boundary without the existing approval, policy, and audit path; add no
dependency without a new Q46 edge.

## Verification

`node tests/provider-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
