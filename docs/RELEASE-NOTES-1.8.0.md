# ToolsEnabled Fleet 1.8.0

ToolsEnabled Fleet is an MCP server for any agent. Version 1.8.0 is this release,
published on [toolsenabled.ai](https://toolsenabled.ai). Public source will follow
on GitHub. It continues the version line above the Claude Code plugin's 1.7;
the changes below are relative to the terminal edition's 1.4.3 (beta 4) base.
The published OpenShell beta 3 remains version 1.4.2.

## Use the agents and models you already have

Agents are described in files rather than fixed into Fleet's launch code.
The bundled descriptors cover Claude Code, Codex, Gemini CLI and OpenCode as
lead agents; Codex, Gemini CLI and OpenCode can also be workers. Claude Code
workers are not part of 1.8.0. You can add a descriptor for another compatible
agent in your Fleet state folder's `agents/` directory. Fleet supports stream-json,
app-server and ACP worker protocols; a descriptor must describe a supported
protocol and enforceable limits before Fleet can start it as a worker.

`toolsenabled agents` discovers installed agents, asks each agent's own status
command whether it is signed in, checks which API key names are set, and lists
models served by local servers you already run. Discovery makes no model calls,
does not read key values and does not start a local server.

ACP agents can now join the worker tree, including stopping and resuming a
session and selecting a model when their protocol supports it. API and local
models can also work directly with Fleet's tools, without an agent CLI, using
OpenAI Chat Completions, OpenAI Responses or Anthropic Messages. Saved model
connections work in both host and OpenShell trees, including mixed trees of
CLI and direct model workers. The endpoint and model must support structured
tool calls. See the [worker guide](GENERIC-WORKERS.md).

## Permissions follow the lead

You start your lead agent yourself, with its own permission choices. Fleet reads
that launch and gives each worker the same level, reduced by its role and every
ancestor: 1 reads only, 2 asks, 3 edits on its own, and 4 allows everything. An
unknown lead uses level 2. Headless workers decline requests that would need a
prompt, because they cannot show an approval prompt to you.

Fleet adds no permission grants to agent settings. Roles can lower the maximum
level and remove native shell or web tools. Workers' own sub-agent features are
disabled so delegation stays in Fleet's tree. If an agent cannot enforce a
required limit, Fleet refuses to start it with a plain explanation; it never
widens the inherited level. Even a later role change cannot give a descendant
more than its ancestors were launched with.

The fixed setup tiers are now optional caps on Fleet's tools. With no cap,
level 1 receives read tools, levels 2 and 3 receive workspace tools, and level 4
receives the full available surface. Existing `guided` and `standard` settings
still narrow that surface. The default `unrestricted` setting adds no cap and
does not grant permissions to an agent.

## Choose host mode or OpenShell

Host mode runs on Linux x86_64 or WSL 2 with the agent CLIs you installed. Its
workspace can be one project or your operating-system account home for a global
setup. With the home as workspace, hidden top-level entries remain outside the
workspace, including agent settings and shell startup files. Workers start in
the lead's working folder when it is inside that workspace. The host command
also works through a symbolic link placed on your PATH. Host workers remain
experimental and require explicit enablement and a passing process containment
check. See the [host guide](HOST-MODE.md).

OpenShell mode installs Fleet into an existing sandbox. OpenShell supplies the
filesystem and network boundary; Fleet supplies its tools and shared records
inside that boundary. Fleet installs no agent CLI, signs in to no account and
changes no OpenShell policy during installation. See the
[OpenShell installer guide](../installer/openshell/README.md).

The optional `toolsenabled-authority` service keeps the ledger of record,
settings, answers and audit key on the machine outside an OpenShell sandbox.
Agents can create and collect their own questions, but only the person can
answer them through the authority's terminal commands. When an authority is
configured, the sandbox does not offer local question tools or accept local
answers. Registration can use a described agent's HTTP MCP method with a bearer
token environment-variable name. Fleet's registration code never reads or
prints the token. See the [authority guide](../adapters/openshell/HOST-OUTSIDE.md).

Status in both modes, and authority status, now records the MCP revision each
client requested and the revision Fleet answered, alongside the client's name
and version. This makes protocol compatibility easier to inspect.

## Sign-ins stay with each agent

Fleet asks each lead to pass its profile folders to Fleet so workers use the same profiles. Codex and Gemini CLI do not pass API keys or tokens to MCP servers unless you allow them. To let workers use a key from your environment, run `toolsenabled setup --add --pass-env NAME[,NAME...]`. Fleet records names only; the agent forwards values at runtime. Setup keeps the recorded names on reruns; `--pass-env ""` clears them. `toolsenabled status` shows the names.

Fleet no longer strips sign-in environment variables from agent CLI children.
Workers receive the sign-in environment you gave them; helper processes retain
their credential scrub. Fleet has no login flow and never reads, copies or
stores an agent's sign-in files or tokens.

Account rotation and the Codex login copier have been removed. Fleet does not
choose accounts, switch accounts at a usage limit or copy a login into another
environment. Each agent signs in with its own tool where it runs, under your own
account and terms. These removals keep sign-in and usage choices with you and
the agent, without a second authentication path managed by Fleet.

## Known limits

- Claude Code is supported as a lead; Claude Code workers are not part of
  1.8.0. Start Claude Code yourself and register Fleet through its MCP command.
  Choose another agent or a direct model for workers.
- For Gemini CLI, use your own Gemini API key, Vertex AI, or a Gemini Code
  Assist Standard or Enterprise sign-in in `gemini`. Google ended Login with
  Google for individual plans in Gemini CLI on 2026-06-18.
- OpenCode workers need a level-4 lead, and their inherited level must remain 4
  after role limits. At lower levels their tool requests would need prompts a
  worker cannot show, so Fleet refuses them. OpenCode can still be a lead.
- Gemini CLI's folder trust can disable MCP servers until you trust the folder
  through the agent's own controls.
- A direct model (API or local) leading or managing a tree starts Fleet's tools
  with a minimal environment: paths, locale, proxy and certificate settings. A
  CLI worker under it signs in from its own stored sign-in (for example
  `codex login`, or Gemini CLI's `~/.gemini/.env`), not from key variables in
  your shell. Under an agent CLI lead, use `--pass-env` as described above.
- Local models need enough context for Fleet's tool definitions, about 55 KB
  with every tool, plus conversation history and output. A narrow role reduces
  the tool list. The direct worker budget now allows multiple tool-use rounds;
  it cannot enlarge a model's context window.
- Host mode is not a sandbox. Agents run as your operating-system user with
  your network access. Fleet's workspace checks do not confine an agent's
  native tools, and same-user processes can alter local records and audit keys.
- OpenShell 0.1.2 on Linux x86_64 with rootful Docker is the tested baseline.
  WSL 2 remains experimental; there is no native Windows or macOS installer.
- Release qualification must use the exact published archives and checksums.
  Source tests and local archive checks alone do not qualify real agent sessions
  or an OpenShell deployment.
