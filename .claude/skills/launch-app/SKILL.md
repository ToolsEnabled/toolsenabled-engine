---
name: launch-app
description: Reliably detect, install, build, test, and deploy supported local applications.
---

Call `launch.plan` before `launch.execute` when project conventions are uncertain.
Execution stops at a failed install, build, test, or deploy rather than publishing a
known-broken artifact. Supported deployment targets are Firebase, Vercel, and
Cloudflare, detected from local project configuration; `provider` can override auto
detection. Use `skipTests` only when the user explicitly permits it.
