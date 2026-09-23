# `secrets` package charter

## Purpose

Provides metadata-only credential handling boundaries for capability checks.

## Public API

`src/lib/credential-metadata.js`, `src/lib/secret-store/`; tools:
`tools/secret-doctor.js`.

## Allowed dependencies

Q46-observed: `fra`, `kernel.runtime`.

`kernel.runtime`: `key-custody.js` takes the custody register's location from
`runtime.js`, and `secret-store/requirements.js` reads `paddle-environment.js`
to know which environment a Paddle credential is required for.
`fra`: `key-custody.js` uses `online-tunnel-contract.js`'s `authorityKeyId` --
a pure contract constant that opens no socket and reads no credential.

Not declared, deliberately: `tools/secret-escrow.js` requires
`providers/subscription-launch-env.js`, so Q46 sees an edge to providers.gateway
(unbackticked, so the finding stays visible). That helper is a repo-wide safe
spawn environment misfiled under a provider family; move the file rather than
give this package an import right over model routing.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not print, log, cache, or expose secret values.

## Verification

`node tests/credential-metadata.js`; `node tests/package-charters.js`.
