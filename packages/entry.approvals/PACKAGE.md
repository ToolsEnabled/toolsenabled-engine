# `entry.approvals` package charter

## Purpose

Produces the CONTENT of the owner's launch-approvals cart and hands it to the
mission-bridge owner-prompt engine through that engine's existing contract. The
pipeline (engine, route, tools, renderer) was already finished and wired; what
was missing was a real queue instead of an empty one.

## Public API

CLI `tools/launch-approvals-cart.js` (`plan`, `load`, `status`).

## Allowed dependencies

`mission-bridge` (`owner-prompts.js`) to enqueue; `surface.registry`
(`tool-registry.js`) for `purchase.request` / `purchase.decision`; `fra`
(`service-registry.js`), `kernel.runtime` (`schema-validator.js`), and `sched` (`managed-processes.js`) to report where the
popup is actually served from.

**Entry layer, not domain; the id says so.** `fan-in=0` — nothing in `src/`,
`tools/`, or `sidecars/` imports it; it composes four packages behind one command
a person runs. Filed under `mission-bridge` it typed as a domain, so those
composing edges read as two `SIDEWAYS_DOMAIN_IMPORT` violations for imports that
are correct. The edges were never wrong; the layer label was. Same shape and
same fix as `entry.setup`.

## Action classes

`LOCAL-WORK`, `ASK`, `RECORD`.

## Must not do

Never spend, and never touch the code that can. It must not require
`src/lib/mission-bridge/purchase-recording.js` — the only module that can move
an approval onto the capped spend ledger — nor `src/lib/providers/pay.js` or
`stripe.js`. Do not re-implement the prompt store, the HTTP route, or the
renderer: this package is content, and duplicating the engine would give the
owner two carts that disagree.

Do not grow into a second mission-bridge. New owner-facing workflow belongs in
`mission-bridge`; only the composing entrypoint belongs here.

## Verification

`node tests/launch-approvals-cart.test.js`; `node tests/package-charters.js`;
`node tools/package-check.js`.
