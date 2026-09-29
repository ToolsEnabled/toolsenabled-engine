# `delegation` package charter

## Purpose

Defines delegation contracts, qualification, enforcement, and UAC client paths.

## Public API

`src/lib/delegation-*.js`, `src/lib/uac-delegation.js`.

## Allowed dependencies

Q46-observed: `kernel.audit`, `kernel.policy`, `kernel.runtime`.

`kernel.runtime`: `uac-delegation.js` reads `runtime-state-root.js` for the
elevation-state directory rather than deriving a second state root.

Not declared, deliberately: `uac-posture.js` requires
`providers/subscription-launch-env.js`, so Q46 sees an edge to providers.gateway
(written unbackticked, so this charter's test still reports it). That file is a
repo-wide spawn-environment helper misfiled under a provider family, not a
delegation dependency on model routing. The fix is to move the file; declaring
it here would only hide the move.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not elevate an unqualified delegate or convert a request into authority.

## Verification

`node tests/delegation-adapter-contracts.js`; `node tests/package-charters.js`.
