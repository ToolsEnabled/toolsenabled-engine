# `entry.setup` package charter

## Purpose

First-run setup: turns a fresh install into a working configuration with no
hand-edited JSON. Owns the tier question, workspace choice, provider sign-in,
machine-record generation, and pairing a second computer.

## Public API

CLI `tools/mcsetup.js` (`plan`, `apply`, `run`, `verify`, `pair invite`,
`pair join`). Library `src/lib/setup/{machine-record,plan,probe,provider-auth,
workspace,pairing}.js`.

## Allowed dependencies

`fra` (`peer-enrollment.js`, `tools/peer-enroll.js`) for pairing;
`surface.policy` (`permission-tier-policy.js`); `surface.registry`
(`tool-registry.js`) for the effect classification the generated allowlist comes
from; `kernel.runtime` (`runtime.js`).

**Entry layer, not domain; the id says so.** `fan-in=0` — nothing imports it; it
composes domains behind one command. Filed as a domain it produced two
`SIDEWAYS_DOMAIN_IMPORT` violations for correct edges. Fixed by naming its real
layer, not by raising the baseline.

## Action classes

`LOCAL-WORK`; `ASK` when setup needs the owner (provider sign-in, a pairing
code). Never `OUTWARD` — setup contacts no host its plan has not declared.

## Must not do

Do not re-implement pairing: `pairing.js` wraps `fra`'s, one implementation with
two voices. Do not write outside the workspace and services root the plan
declares; `plan` refuses itself on an escaping write or a step wanting elevation.

Do not emit a tier as configuration and call it enforcement — the tier is
recorded and shapes the allowlist, but confining a running agent is T5 and is
NOT built. `verify` says so aloud rather than showing a green tier that means
less than it looks like.

Do not name a restriction the runtime never reads. The first generated config set
`TOOLSENABLED_READ_ONLY`, which nothing here reads — it would have shipped the
full tool surface under a read-only name.

## Verification

`node tests/setup/first-run-setup.test.js`; `node tools/mcsetup.js verify`;
`node tests/package-charters.js`.
