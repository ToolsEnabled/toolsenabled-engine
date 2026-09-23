# `kernel.runtime` package charter

## Purpose

Supplies shared runtime configuration, schemas, HTTP primitives, errors, and
health invariants. It is common infrastructure, not an owner-facing workflow.

The non-JavaScript helper `src/linux-vault.py` belongs to this package alongside
`src/lib/vault-linux.js`. It remains in the runtime payload boundary, but is
not a JavaScript ownership claim in `config/packages.json`.

## Public API

`src/lib/runtime.js`, `src/lib/schema-validator.js`, `src/lib/http.js`,
`src/lib/error-taxonomy.js`, `src/lib/health-invariants.js`,
`src/lib/machine-profile.js`.

`src/lib/tool-performance-settings.js` reads the three bounded audit-batching
and credential-presence-cache preferences using the shared kernel settings
schema and saved-value reader. It retains the canonical per-installation path,
provenance checks, shipped fallbacks and short read cache without importing
the settings surface or requiring a particular startup order.

`src/lib/agent-engine/codex-startup-cleanup.js` is the shared owned-child
startup/cleanup primitive used by Codex, ACP, Antigravity and account probes.
It inspects retained process receipts and enforces cleanup deadlines without
provider protocol, account selection or credential access. The existing path
and diagnostic codes remain compatible with those callers.

`src/lib/providers/provider-safety.js` is shared runtime infrastructure: it
validates inputs, redacts credentials, and records durable mutation outcomes
through injected dependencies. It has no provider-specific endpoint or policy.
Its existing path is retained for consumers; ownership belongs here so every
provider can use the same boundary without importing another provider family.

The machine profile is here rather than in `fra` because it is shared runtime
configuration, not fleet behaviour: it is a dependency-free reader of one
per-installation user setting (`config/machines.profile.json`), imports nothing
from this repository, and is read across layers. Owning it in a domain made
every reader outside that domain an illegal sideways import.

## Allowed dependencies

Q46-observed direct packages: `controller`, `owner.inbox`, `sched`, `secrets`.
These are current upward compatibility exceptions; new imports must remain in
the kernel or be moved behind a surface boundary.

LEFT UNDECLARED ON PURPOSE. `vault-presence.js` requires
`providers/subscription-launch-env.js`, so Q46 sees an edge to
providers.gateway -- written unbackticked, so `tests/package-charters.js` keeps
reporting it. Every exception above is a domain package; none is a provider,
and "Must not do" below says to keep shared helpers provider-neutral. Declaring
this one would contradict that line to change a test's colour. The edge is real
but the file is misplaced: it is a repo-wide safe spawn environment (a union
credential scrub, imported from every layer), so its home is here beside
`env-scrub.js`, not a provider family. Moving it clears this finding and five
identical ones in kernel.audit, delegation, fra, repo-gate, and secrets.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not dispatch tools, send owner messages, or read secret values. Keep shared
helpers provider-neutral.

## Verification

`node tests/schema-validator.js`; `node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
