---
name: browser
description: Use the isolated persistent browser profile for an authenticated HTTPS website when no official API can perform the requested supported operation.
---

Call `browser.status` first if browser availability is unknown, then use the
`playwright` MCP tools for page navigation and normal authenticated website actions.
`browser.start` is available to open the same profile for an initial interactive
login. The profile lives under `profiles/chrome` and is intentionally separate from
the user's default browser. Prefer a provider API for mutations.
