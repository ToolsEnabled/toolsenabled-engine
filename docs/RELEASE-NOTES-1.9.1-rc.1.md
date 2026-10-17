# ToolsEnabled Fleet 1.9.1-rc.1

This is a release candidate of the standalone MCP server, built from 1.9.0
plus the host-mode fixes of a second development line (Windows/WSL host mode)
and shared-engine fixes from the ToolsEnabled Fleet plugin for Claude Code. It
is not published; 1.9.0 remains the current release. Its version numbers are
its own: the plugin is a separate product with separate release numbers.

## Workers and the agent tree

- **Questions from a worker's agent.** In host mode a Codex worker's MCP
  confirmation request (for example before a Fleet write tool below level 4)
  can now be answered by you: run `toolsenabled-host interactions --watch` in
  your own terminal and choose accept, decline or cancel for that exact
  request. Requests nobody answers expire after about 110 seconds and are
  cancelled. Without that route (OpenShell workers, other agents) a question is
  still declined at once and the worker's report says so, as in 1.9.0.
- **Speed.** `agent.set_speed` chooses standard or fast for a worker's next
  turn where its agent offers a speed choice; other agents refuse it by name.
- **Model, effort and role controls** work on a Standard host tree, and the
  tree itself checks that the caller holds each control.
  `serve --enable-role-control` lets an unedited organisation root change
  roles; it is off by default.
- **Assigned-task continuation.** `agent.continue` lets a manager enrol a
  running worker in a bounded run over owner task records already assigned to
  it (`docs/LEDGER-CONTINUATION.md`). Nothing starts on its own.
- **Turn events** change a worker's turn only when they name its session and
  the accepted turn; events that arrive before the agent accepts a turn wait
  for it. A worker whose agent exits mid-turn is still ended as failed, and a
  message an agent refuses before starting a turn is reported to the parent.
- **Requests a worker cannot answer** no longer end or stall it: an ACP agent
  (Gemini CLI, OpenCode) asking for something Fleet does not offer gets
  "method not found", a Claude Code request Fleet cannot answer is refused at
  once, and the worker's report says so.
- **Continuation pauses** when any agent was denied a permission or had a
  question declined, not only on Codex approval requests.
- **Managers can wait** (`agent.wait`) on reports from their own workers, and
  each worker tool call has a protection boundary. A stopped worker's open tool
  calls are retired, and a mid-turn delivery that never reached the agent
  leaves its messages for the next turn. A direct message to a worker that
  already holds 64 unread items is refused instead of dropping the oldest.
- **Resuming a particular tree:** `serve --tree-key KEY` reopens exactly that
  existing tree of the same lead, or refuses.
- **The ledger actor is fixed at startup** from `serve --actor`; a server
  started without one cannot file ledger records.

## Files and errors

- `host.read_file` refuses binary, image and non-UTF-8 files by name instead
  of returning replacement characters.
- An unknown Codex failure code no longer suggests a sign-in problem; a refused
  sign-in (HTTP 401) or request (HTTP 403) is still said by name.
- An internal error tells the agent to check whether the action took effect
  before trying again.
- `t_ledger.complete` and `task.start` are no longer marked idempotent, and
  standing rules that do not fit are left to you (`toolsenabled ledger`)
  instead of being fetched by the agent.
- The `sonnet` alias shows as Sonnet 5.5 on Claude Code 2.1.292 and later.

## Upgrading host mode

The host archive also carries `handoff_preflight.py` and `owner_handoff.py`,
which check a release, then uninstall and install it with a verified receipt
and reconnect an existing tree. Close every agent session that uses Fleet
before an upgrade.

## Known limits

- The interactive answer route covers Codex workers in host mode only, on
  Linux and WSL.
- Speed selection is offered only by agents whose adapter reports speed
  choices (Codex today).
- Launch policy observations are recorded for Codex workers only; other
  workers show them as unknown.
