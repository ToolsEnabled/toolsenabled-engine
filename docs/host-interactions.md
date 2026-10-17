# Reviewing Fleet requests in an owner terminal

Keep a terminal open for incoming worker requests:

```sh
node /path/to/engine/bin/toolsenabled-host.js interactions --watch --state-root /absolute/fleet-state
```

Use the engine and state directory from your installed Fleet receipt. On Windows, run this command in the same WSL distribution and Linux owner account as Fleet. The interactive review route currently supports Linux and WSL.

The terminal waits when no requests are pending. For each request, choose its number, review the displayed tool and target, then choose accept, decline, or cancel. Acceptance of a form also requires its JSON response, including `{}` for an empty form. Each decision applies only to that exact request. No choice is selected automatically.

Expired requests clear from the prompt; the watcher then waits for current requests. An expired or previously cancelled operation is not replayed. Press Ctrl+C to stop watching. Omitting `--watch` reviews at most one pending request and exits.

The command uses the existing interactive owner route. It does not change provider permission settings, store approval defaults, or manage provider login. A disconnected worker or unavailable approval route requires separate diagnosis; this terminal cannot recover its task ownership.
