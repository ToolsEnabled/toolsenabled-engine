# `providers.google.suite` package charter

## Purpose

Owns Google Drive, Firebase, gcloud-account-login, and Google provider adapters.
It does not own browser-session custody or provider-wide authorization policy.

## Public API

`src/lib/providers/drive.js`, `firebase.js`, `gcloud-account-login.js`,
`google.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `auth.google`, `kernel.audit`, `kernel.policy`,
`kernel.runtime`.

## Action classes

`OUTWARD`, `BROWSER`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not copy browser credentials, upload, or change cloud state without registry
preflight and audit; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
