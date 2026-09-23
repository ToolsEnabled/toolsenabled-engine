# `code.intel` package charter

## Purpose

Provides semantic source navigation behind the MCP code-intelligence surface.

## Public API

`src/lib/lsp-client.js`, `tools/code-intel-handshake.js`, and
`tools/agent-parity.js`.

## Allowed dependencies

Q46-observed: `surface.registry` (the handshake uses its established one-shot
MCP client rather than bypassing broker policy).

## Action classes

`LOCAL-WORK`.

## Must not do

Do not claim complete reference coverage when language-server evidence is partial.

## Verification

`npm run test:code-intel`; `node tests/package-charters.js`.
