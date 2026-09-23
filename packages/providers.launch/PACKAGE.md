# `providers.launch` package charter

## Purpose

Owns application launch and installation-provider adapters. It is a narrowly
bounded execution bridge, not a scheduler, desktop controller, or policy surface.

## Public API

`src/lib/providers/launch.js`, `src/lib/providers/workstation.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `fra`, `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`providers.chrome-web-store`, `providers.google.suite`, `providers.infrastructure`.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not launch unapproved commands or bypass process-visibility and audit paths;
add no dependency without a new Q46 edge.

## Verification

`npm run test:providers.launch`; `node tests/package-charters.js`. Queue:
`BUILD-QUEUE.md`.
