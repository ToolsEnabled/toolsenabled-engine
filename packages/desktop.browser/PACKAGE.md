# `desktop.browser` package charter

## Purpose

Provides host-owned browser preflight, audited browser-call wrappers, and the
bounded agent-browser ownership, operation, lifecycle/media, and shell plans.

## Public API

`src/lib/agent-browser-contract.js`, `src/lib/agent-browser-operations.js`,
`src/lib/agent-browser-lifecycle.js`, `src/lib/agent-browser-shell.js`; tools:
`tools/canvas-session-preflight.js`, `tools/playwright-call.js`.

## Allowed dependencies

Q46-observed: `entry`.

## Action classes

`BROWSER`, `LOCAL-WORK`.

## Must not do

Do not clone authenticated profiles into containers, drive pages without a
fresh snapshot and ownership fence, mutate human/unknown surfaces, or commit a
media plan without its canonical atomic revision check.

## Verification

`npm run test:desktop.browser`; `node tests/package-charters.js`.
