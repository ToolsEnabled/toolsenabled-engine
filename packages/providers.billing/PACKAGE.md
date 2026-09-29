# `providers.billing` package charter

## Purpose

Owns payment, billing, license, Paddle, Stripe, and spend-cap provider adapters.
It is the provider layer; authorization and records remain at the surface.

## Public API

`src/lib/providers/billing.js`, `hosted-relay-entitlement.js`, `license.js`,
`paddle.js`, `pay.js`, `stripe.js`; `src/lib/entitlement.js`,
`src/lib/entitlement-fulfilment.js`; `tools/entitlement.js`.

`entitlement.js` is **the one place that says what an unlicensed install does**:
`full-function`, permanently. `GATED_CAPABILITIES` is closed, so a new gate can
only be added there. `entitlement-fulfilment.js` turns a signature-verified
payment event into a licence and into the `resolveLicenseKey` the admission gate
calls; no outbound request, no merchant account.

`hosted-relay-entitlement.js` (R1229 item 2) is the ONE entitlement check R1228
requires and forbids everywhere else: it refuses a connect before the relay is
reached unless the pair has an active licence. Direct and self-hosted operators
never construct it, so they never load `license.js` at all -- see that file's
header for the structural argument and its test for the proof.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`kernel.state`, `models`, `entry.approvals`, `providers.misc`.

## Action classes

`OUTWARD`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not charge, create a payment instrument, or disclose payment data outside
the approved provider flow; add no dependency without a new Q46 edge. Do not
call `hosted-relay-entitlement.js` from local execution, direct transport, or
a self-hosted relay path -- that is the one thing this file exists to prevent.

## Verification

`node tests/package-charters.js`; `node tests/providers.billing/hosted-relay-entitlement.js`;
`node tests/entitlement.js`. Queue: `BUILD-QUEUE.md`.
