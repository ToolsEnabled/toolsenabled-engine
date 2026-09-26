---
name: cws-publish
description: Upload and publish an existing Chrome extension item through the official Chrome Web Store V2 API. OWNER-SIDE ONLY -- the three tools it names are absent from a default install.
---

**Check the tools exist before planning a run.** All three names below moved to
`src/lib/tool-packs/owner-release-automation.js`, which is owner-side and not
shipped, so `registeredTools()` on a default install does not carry them. If they
are absent, use `launch.execute` with `chromeWebStore` identifiers instead — see
the `extension-package` skill.

Use `chrome_web_store.status` to inspect the item, `chrome_web_store.upload` for the
ZIP, then `chrome_web_store.publish`. The adapter only operates on an existing
publisher account and item with an authorized OAuth token.
