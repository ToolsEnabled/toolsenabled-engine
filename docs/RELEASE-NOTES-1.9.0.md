# ToolsEnabled Fleet 1.9.0

ToolsEnabled Fleet is an MCP server for any agent. Version 1.9.0 follows 1.8.0
and is published on [toolsenabled.ai](https://toolsenabled.ai). This is the
standalone MCP server, and its version numbers are its own: the ToolsEnabled
Fleet plugin for Claude Code is a separate product with separate release
numbers.

## Claude Code workers

Claude Code can be a worker again, beside Codex, Gemini CLI, OpenCode and
direct models. 1.8.0 held Claude Code to the lead role; that hold is gone.
A Claude Code worker starts at the level it inherits, like every other worker.
Below level 4 it asks before any tool its own settings do not already allow,
and a worker cannot show you that question, so it is declined. To let such
workers use Fleet's tools, add allow rules for exactly those tools in your
Claude Code user settings; the [host guide](HOST-MODE.md) shows how. Fleet
never writes these rules.

## Workers keep their own tools by default

The saved Agent API mode (`agent.agent_api`) used to default to `Only`. That
removed Codex's shell from every worker and refused Gemini CLI and OpenCode
workers outright, even under a lead started with full permissions. The default
is now `Enabled`: workers keep their agent's own tools, limited only by the
level they inherit and their role. If you chose a mode yourself, your choice is
kept. `Only`, `Optimized` and `Disabled` remain available.

## Clearer refusals and failures

- A worker refused for its level now names the exact options that start your
  lead at level 4, read from the lead's own description, for example
  `--sandbox danger-full-access --ask-for-approval never` for Codex.
- A Codex worker whose sign-in is refused (HTTP 401) now says so, and says
  where a worker finds its sign-in: the Codex home (`CODEX_HOME`) Fleet's
  server was started with. A refused request (HTTP 403) says to check that the
  account may use the chosen model and provider. Other Codex failures quote the
  HTTP status beside Codex's failure code. Codex's own message is still never
  passed on, because it can contain account details.
- A Codex usage limit no longer suggests choosing another account. It suggests
  another agent or model for that worker, or waiting for the limit to reset.
- A failed request from an ACP agent (Gemini CLI, OpenCode) is reported in one
  line of at most 240 characters, with anything shaped like a key or token
  replaced. It used to quote the agent's whole message.
- An ACP mode or reasoning effort the agent does not offer is reported as
  "choose another", not "try again later".
- A Codex worker below level 4 that asks for your confirmation (for example
  before Fleet's file-write tool) is answered "decline", and its report says a
  worker cannot show you a prompt. This used to end the worker's session.
- A worker that starts but refuses its first task is ended with one failed
  report. It used to stay running without a report and keep a place under the
  width limit.
- An out-of-date or incompatible agent CLI is reported as something to update,
  not "try again later".
- `agent.spawn` offers only the agent tree. Fleet always refused a detached
  "lane", but the tool used to offer one.

## Models and setup

- Codex: `sol` now runs `gpt-6.1-sol` and `luna` runs `gpt-6-luna`, the
  current models in Codex's own catalogue. Claude Code adds
  `claude-sonnet-5-5`.
- An ACP agent that reports thought tokens in its usage no longer fails the
  turn, and one that lists hundreds of models (OpenCode with an OpenRouter key
  lists 389) is no longer refused at start.
- Workers no longer receive the lead Claude Code session's own variables
  (`CLAUDE_PID`, `CLAUDE_EFFORT` and the like), and keep the person's
  `CLAUDE_CODE_OAUTH_SCOPES` with their OAuth token.
- `toolsenabled setup --print-server-json` now includes each agent's profile
  folder variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`,
  `XDG_CONFIG_HOME`) when it is set where you run setup.
- Codex's `CODEX_SQLITE_HOME` is forwarded with `CODEX_HOME`, so a Codex
  profile shared from Windows into WSL works for workers too. A client that starts
  Fleet with a minimal environment otherwise left workers on the default,
  signed-out home. Only folder paths are printed, never a key or token.
- `toolsenabled tree --json` shows each worker's permission level (`level`,
  1 to 4), and shows a pending provider change for any agent, not only two.

## Documentation

Links to an unpublished source repository were replaced. Report problems to
support@toolsenabled.ai, and security problems as described in `SECURITY.md`.
The public source is the archive published beside each release.

## Known limits

- For Gemini CLI, use your own Gemini API key, Vertex AI, or a Gemini Code
  Assist Standard or Enterprise sign-in in `gemini`. Google ended Login with
  Google for individual plans in Gemini CLI on 2026-06-18.
- OpenCode workers need a level-4 lead, and their inherited level must remain 4
  after role limits. At lower levels their tool requests would need prompts a
  worker cannot show, so Fleet refuses them. OpenCode can still be a lead.
- Codex workers inside an OpenShell sandbox need level 4, because Codex's own
  sandbox cannot start inside OpenShell's. OpenShell's rules still apply to them.
- Each agent's model list is part of its description and is updated with
  releases. A model the list does not name cannot be chosen for a worker yet.
- A Windows agent that starts Fleet in WSL through `wsl.exe` counts as a
  level-2 lead, because its command line is not visible from WSL. See the
  [host guide](HOST-MODE.md#windows-agents-through-wsl).
- Gemini CLI's folder trust can disable MCP servers until you trust the folder
  through the agent's own controls.
- A direct model (API or local) leading or managing a tree starts Fleet's tools
  with a minimal environment: paths, locale, proxy and certificate settings. A
  CLI worker under it signs in from its own stored sign-in, not from key
  variables in your shell. Under an agent CLI lead, use `setup --pass-env`.
- Local models need enough context for Fleet's tool definitions, about 55 KB
  with every tool, plus conversation history and output. Give a local model a
  context window of at least 16,000 tokens. Ollama's default is 4,096: in that
  window `qwen3.5:9b` answered without calling a tool, while the same model
  with a 32,768-token context (a variant made with `PARAMETER num_ctx 32768`)
  read a value through Fleet's `memory.get` and reported it. When a model skips
  a required tool call, the failure now says to check the context window. A
  narrow role reduces the tool list.
- After an agent session ends, the audit's text and JSON copies
  (`logs/actions.log`, `logs/actions.jsonl`) can trail the signed audit ledger
  until the next Fleet session brings them up to date. Until then
  `toolsenabled audit verify` reports `projection-divergence`; the signed
  ledger itself is complete.
- Host mode is not a sandbox. Agents run as your operating-system user with
  your network access. Fleet's workspace checks do not confine an agent's
  native tools, and same-user processes can alter local records and audit keys.
- OpenShell 0.1.2 on Linux x86_64 with rootful Docker is the tested baseline.
  WSL 2 remains experimental; there is no native Windows or macOS installer.
- Release qualification must use the exact published archives and checksums.
