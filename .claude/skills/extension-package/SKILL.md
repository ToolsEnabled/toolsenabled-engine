---
name: extension-package
description: Validate, package, upload, and publish a local Manifest V3 Chrome extension using ToolsEnabled MCP.
---

Run `extension.validate`, then `extension.package`. For an existing store item,
include `chromeWebStore` identifiers in `launch.execute` to build, test, package,
upload, and optionally publish in one run — `launch.plan` and `launch.execute`
both still take that configuration.

The separate `chrome_web_store.*` tools are NOT on a default surface: they moved
to the owner-side `src/lib/tool-packs/owner-release-automation.js`, which is not
shipped. Do not plan a run around them without confirming they are registered.
