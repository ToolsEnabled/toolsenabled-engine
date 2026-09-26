# `internal-vcs` package charter

## Purpose

Implements the internal version-control control plane from immutable control
records through bounded protected-stream migration, while retaining Git as the
parallel content and worktree adapter.

## Public API

`packages/internal-vcs/src/index.js`.

## Allowed dependencies

Node.js built-ins only. Runtime I/O is injected through explicit content, Git,
identity, signature, participant, backup, rollback, clock, and control-store
adapters. The Git CLI adapter uses explicit argv, `shell:false`, and hidden
processes. No third-party runtime dependency or embedded credential exists.

## Action classes

`LOCAL-WORK`, `RECORD`, `SYNC`.

## Must not do

Must not issue identity keys, store raw secrets, infer authorization from Git
author strings, convert `UNKNOWN` to success, publish a protected stream outside
its registered receipt gateway, hard-delete retained content, or treat Git
coexistence as a cutover. Unbound public methods fail closed and direct callers
must use `createInternalVcsSystem(options)`.

## Verification

From PowerShell, pass all package test files to
`node tests/run-isolated.js`; syntax-check every JavaScript file under
`packages/internal-vcs/src` and `packages/internal-vcs/test`.
