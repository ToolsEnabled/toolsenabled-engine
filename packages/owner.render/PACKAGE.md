# `owner.render` package charter

## Purpose

Reserved boundary for future owner-facing rendering shared outside digest output.

## Public API

No Q46 file claim yet; `owner.digest` currently owns digest-specific rendering.

## Allowed dependencies

None observed by Q46.

## Action classes

`LOCAL-WORK`.

## Must not do

Do not become a catch-all for delivery, messaging, or provider effects.

## Verification

`node tests/package-charters.js`.
