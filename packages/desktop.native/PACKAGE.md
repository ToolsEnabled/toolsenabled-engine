# `desktop.native` package charter

## Purpose

Owns local desktop/browser ownership, screenshots, and account URL handoff.

`src/lib/accessibility.js` and `src/lib/app-context.js` are authenticated
in-process desktop-host adapters for inspected controls and situational
context. Installing a host is private application wiring, not an agent tool;
role selection never grants local opt-in or confirmation authority.

## Public API

`src/lib/desktop.js`, `src/lib/screenshot-relay.js`; tools:
`tools/screenshot-to-owner.js`, `tools/zed-context-terminal.js`,
`tools/zed-context-terminal-commands.js`.

## Allowed dependencies

Q46-observed: `kernel.audit`, `kernel.runtime`, `owner.inbox`.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not capture unrelated application content or expose screenshots outside owner controls.

## Verification

`npm run test:desktop.native`; `node tests/pkg.tree/package-check.js`.
