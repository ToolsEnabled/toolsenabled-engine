# `pkg.tree` package charter

## Purpose

Defines package-manifest contracts, report-only boundary checking, and pure
repository-hygiene preflights that decide whether a separately reviewed index
action is eligible.

## Public API

`src/lib/package-manifest-contract.js`,
`src/lib/repo-hygiene/quarantine-preflight.js`; tool: `tools/package-check.js`.

## Allowed dependencies

None observed by Q46.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not modify the tree, make boundary findings fatal, bless a violation, or
perform or authorize a repository-hygiene action from a preflight result.

## Verification

`node tests/package-manifest-contract.js`; `node tests/package-charters.js`.
