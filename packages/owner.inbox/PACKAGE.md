# `owner.inbox` package charter

## Purpose

Normalizes owner chat, prompts, forms, identity-gate records, and delivery.

## Public API

`src/lib/owner-chat.js`, `src/lib/owner-directive-inbox.js`,
`src/lib/owner-prompt-theme.js`; tools: `tools/owner-chat.js`,
`tools/owner-alert.js`.

## Allowed dependencies

Q46-observed: `auth.google`, `fra`, `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`owner.digest`, `providers.chrome-web-store`, `providers.misc`,
`providers.google.suite`, `providers.messaging`, `sched`.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not treat inbox content as authority or expose identity values to logs.

## Verification

`node tests/owner-chat.js`; `node tests/package-charters.js`.
