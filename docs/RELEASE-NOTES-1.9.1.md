# ToolsEnabled Fleet 1.9.1

Fleet 1.9.1 is the standalone MCP server built from 1.9.0 plus the host-mode fixes of a second
development line (Windows/WSL host mode), shared-engine fixes from the ToolsEnabled Fleet plugin for
Claude Code, and one change made on 2026-10-17: Fleet no longer limits a worker's rounds, tokens or
time. It was qualified as release candidates 1.9.1-rc.1 and 1.9.1-rc.2. Its version numbers are its
own: the plugin is a separate product with separate release numbers.

## Workers run until they answer

- **No round cap.** Generic model-API workers stopped at 16 rounds by default (hard maximum 64), and
  native local-model nodes stopped at 24 tool rounds. Neither happens now: the work ends when the
  model answers.
- **No token budget.** Generic workers carried a cumulative "aggregate token admission budget" of
  1,048,576 (about 15 rounds, because every request resends the conversation). It is gone. If you
  pay per token, set a spending limit with your provider.
- **No deadline.** The 3-minute assignment deadline for generic workers (hard maximum one hour),
  which also timed out each single request, and the 30-minute whole-turn deadline for local nodes
  are gone.
- **Liveness instead.** A model request or a tool call that gives no answer at all for 30 minutes
  means the endpoint or tool is dead, and the assignment ends with `MODEL_API_TIMEOUT` saying so.
  It re-arms on every request and every tool call, so a worker that keeps making progress is never
  stopped.
- **No continuation turn cap.** Assigned-task continuation (`agent.continue`) stopped a run after
  20 automatic turns unless the manager chose another number, and no number above 100 was
  accepted. Now a run continues until its tasks are done, held or blocked, or it is disabled or
  stopped. A manager that wants a turn limit still passes `maxTurns`, any whole number from 1.
- **Saved connections keep working.** Connections that carry `maxTurns`, `maxTotalTokens` or
  `timeoutMs` still load; the values are dropped. `worker add` still accepts `--max-turns`,
  `--max-total-tokens` and `--timeout-ms` and says they do nothing. `--max-output-tokens`, the
  length of one reply, is unchanged.

Nobody asked for these limits, and they ended working assignments on free local GPUs. No Anthropic
or OpenAI policy requires them.

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
  running worker in a run over owner task records already assigned to it
  (`docs/LEDGER-CONTINUATION.md`). Nothing starts on its own.
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
