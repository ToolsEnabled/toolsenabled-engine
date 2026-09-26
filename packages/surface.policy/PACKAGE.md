# `surface.policy` package charter

## Purpose

Applies preflight protection at the tool boundary: standing-order checks,
request context, SSRF defenses, action guards, and intent validation. It
decides whether an effect is permitted; the registry performs dispatch.

## Public API

`src/lib/egress-preflight.js`, `src/lib/action-guards.js`,
`src/lib/request-context.js`, `src/lib/ssrf-guard.js`; tools:
`tools/intent-check.js`,
`tools/standing-orders-hook.js`.

`src/lib/file-tool-context.js` supplies private transport-bound scopes and
one-shot per-dispatch file capabilities. Public invocation metadata is only
diagnostic; neither copied metadata nor caller-provided identity is authority.
Transport and agent validation remain here. The opaque capability lifetime is
held by `kernel.policy` so byte-access implementations can require an already
issued capability without importing the code that chooses transport policy.

`src/lib/purchase-reservation-policy.js` evaluates the saved purchase
reservation and its provenance. It defaults to keeping purchases reserved on
unreadable settings. It neither reads settled owner prompts nor authorizes a
spend; the approvals entrypoint composes those separate checks.

`src/lib/agent-engine/acp-confinement.js` and
`src/lib/agent-engine/antigravity-confinement.js` build and validate the allowed
tool surface. They do not spawn a provider. Their existing paths remain stable;
the corresponding process adapters remain in `agent-engine`.

`src/lib/multi-account/registry.js` and `registry-location.js` define admitted
account homes and sign-in-file identity. The pure `selection-modes.js` and
`usage-windows.js` policies validate selection settings and order measured
allowances without probing, launching or switching an account. Health probes,
registry mutation and account rotation remain in `fleet`.

## Allowed dependencies

Q46-observed direct packages: `controller`, `fleet`, `fra`, `kernel.audit`, `kernel.policy`,
`entry.setup`, `kernel.runtime`, `models`, `owner.digest`, `providers.gateway`, `providers.misc`,
`repo-gate`, `sched`.
Non-kernel targets are current compatibility exceptions, not new import rights.

`agent-engine`: the private file context imports only the accepted agent-ID
syntax from `agent-session-credential.js`. It does not launch or control an
agent; the host must already have accepted the session before minting its scope.

## Action classes

`OUTWARD`, `BROWSER`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not itself send, browse, approve, or weaken owner-policy enforcement; do
not treat untrusted page, message, or task content as authority.

## Verification

`node tests/egress-preflight.js`; `node tests/standing-orders.js`;
`node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
