# ToolsEnabled Fleet 1.9.1-rc.2

This release candidate is 1.9.1-rc.1 with one change: **Fleet no longer limits a worker's rounds,
tokens or time.** It is not published.

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
- **Saved connections keep working.** Connections that carry `maxTurns`, `maxTotalTokens` or
  `timeoutMs` still load; the values are dropped. `worker add` still accepts `--max-turns`,
  `--max-total-tokens` and `--timeout-ms` and says they do nothing. `--max-output-tokens`, the
  length of one reply, is unchanged.

Nobody asked for these limits, and they ended working assignments on free local GPUs. No Anthropic
or OpenAI policy requires them.
