# `auth.google` package charter

## Purpose

Provides Google account/OAuth helpers and authenticated Drive upload support.

## Public API

`src/lib/google-accounts.js`, `src/lib/google-oauth.js`; tools:
`tools/drive-upload.js`, `tools/google-oauth-login.js`.

## Allowed dependencies

Q46-observed: `kernel.policy`, `kernel.runtime`, `providers.google.suite`.

## Action classes

`OUTWARD`, `BROWSER`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not log tokens, copy browser profiles, or bypass external account controls.

## Verification

`node tests/google-oauth.js`; `node tests/package-charters.js`.
