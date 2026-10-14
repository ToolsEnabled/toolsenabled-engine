# `tools.misc` package charter

## Purpose

This is the explicit attic package for transitional standalone tools that do
not yet fit a stable domain. Each entry below is deprecated from new use and
must move to a named package or be retired when its successor lands.

## Public API

- `tools/check-cross-repo-boundaries.js` — deprecated: retire after boundary checks move to a package.
- `tools/generate-error-taxonomy-bindings.js` — deprecated: move with runtime generation.
- `tools/generate-ownership-types.js` — deprecated: move with manifest tooling.
- `tools/ingest-cli-session-usage.js` — deprecated: move to `models`.
- `tools/lock-agent-sandbox-image.js` — deprecated: move to `providers.sandbox`.
- `tools/register-managed-tasks.js` — deprecated: move to `sched`.
- `tools/run-vertex-report-wave.js` — deprecated: move to `fleet`.
- `tools/verify-evidence-store.js` — deprecated: move to `evidence`.
- `tools/wepa-email-print.js` — deprecated: retire or move to a named provider family.

## Allowed dependencies

Q46-observed: `auth.google`, `controller`, `evidence`, `fleet`, `models`, `owner.digest`,
`providers.chrome-web-store`, `providers.misc`, `providers.sandbox`, `sched`, `surface.policy`.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not add new tools here; no attic item is a permanent public API.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`.
