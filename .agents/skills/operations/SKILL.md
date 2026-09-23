---
name: operations
description: Schedule recurring work, manage Gmail/Calendar tasks, inspect audit logs, and enforce the local spend ledger.
---

Use `scheduler.*`, `gmail.*`, `calendar.*`, and `pay.*` through ToolsEnabled MCP.
Scheduled actions are explicitly allowlisted by `src/job-runner.js`; check
`system.status` before creating a job.

Chat messaging is no longer part of this skill. The five `telegram.*` tools were
removed 2026-08-23 by owner ruling ("you can rip out telegram", the product now
ships its own mobile app) and Discord had already left before them; both are
recorded in `src/lib/tool-registry.js`. Reaching a person goes through owner
delivery and the `ask.primary_channel` setting.
