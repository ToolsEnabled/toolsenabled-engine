# `kernel.policy` package charter

## Purpose

Evaluates policy, authorization, and kill-switch state before a capability is
used. It supplies decisions to the surface; it does not itself perform the
requested effect.

## Public API

`src/lib/policy.js`, `src/lib/policy-evaluator.js`, `src/lib/policy-authorizations.js`,
`src/lib/kill-switch.js`.

`src/lib/file-tool-capabilities.js` retains opaque file-scope and one-use
invocation identities in memory. It checks currentness and retirement without
interpreting transport credentials, selecting agent identities or performing
file operations. Surface policy alone constructs and validates those inputs.

`src/lib/settings-registry.js` validates and reads the shipped settings schema.
`src/lib/settings-values.js` validates stored document structure, scalar types,
ranges and provenance. It accepts caller-supplied readback and domain rules;
it never imports the settings surface or loads machine authority. Both the
settings surface and runtime tuning use these same saved-value checks.

## Allowed dependencies

Q46-observed direct packages: `kernel.runtime`, `kernel.state`,
`providers.misc`, `surface.registry`. The latter two are current upward
compatibility exceptions, not precedent for new imports.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not execute tools or bypass an authorization decision; do not add a
surface/domain import unless the boundary design is deliberately changed.

## Verification

`node tests/runtime-security.js`; `node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
