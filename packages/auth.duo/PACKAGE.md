# `auth.duo` package charter

## Purpose

Integrates desktop Duo/UCR sign-in flows through bounded owner-approved routes.

## Public API

`src/lib/providers/duo-desktop.js`, `src/lib/ucr-sso.js`; tools:
`tools/uac-run.js`, `tools/ucr-login.js`.

## Allowed dependencies

Q46-observed: `auth.google`, `delegation`, `desktop.native`, `kernel.audit`, `kernel.policy`,
`kernel.runtime`, `providers.chrome-web-store`, `providers.misc`.

## Action classes

`BROWSER`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not bypass MFA or reuse credentials/approval artifacts outside their route.

## Verification

`node tests/uac-delegation.js`; `node tests/package-charters.js`.
