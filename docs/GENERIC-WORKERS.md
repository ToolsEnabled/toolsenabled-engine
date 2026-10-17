# Generic Fleet workers

Fleet can run a model directly through Chat Completions, Responses or Anthropic
Messages endpoints. The model uses Fleet's reviewed tools through the same MCP
dispatcher and recorded permission tier. Agent CLIs retain their native adapters.
Saved model connections can join the worker tree in host mode and OpenShell;
a tree can contain only local models, only API models, or a mixture with CLIs.

This generic transport is separate from `toolsenabled model`, which
configures Codex's own model provider. It does not depend on Codex exposing
MCP tools to another model.

## Configure and run

The standalone module is runnable directly from a checkout:

```shell
node src/lib/openshell-worker-command.js help
```

The installed CLI command in either mode is `toolsenabled worker`. The examples below use that prefix. Run ordinary
Fleet setup first; `worker run` requires its existing saved permission level.

For a keyed endpoint inside OpenShell, attach the corresponding provider on
the host first. Its endpoint policy must authorize the Node executable running
Fleet and the exact route. Fleet reads the injected placeholder value from
the provider's named environment variable, validates its prefix and identifier
syntax, and forwards it unchanged. It never synthesizes that value from the
variable name. Missing, malformed or raw-key-looking values are refused. The
real key remains with OpenShell; the placeholder is neither logged nor saved.

```shell
toolsenabled worker add nvidia \
  --transport openai-chat \
  --endpoint https://integrate.api.nvidia.com/v1/chat/completions \
  --model EXACT_MODEL_ID --source api \
  --auth openshell --token-env NVIDIA_API_KEY

toolsenabled worker run nvidia \
  --prompt 'Read the Fleet task list and report the unfinished tasks.'
```

For Responses, use `--transport openai-responses` and the full `/responses`
route. Requests are bounded, non-streaming JSON. The endpoint must support
function tools and `tool_choice: required`; accepting ordinary chat alone is
insufficient. Chat Completions defaults to `max_tokens`; set
`--token-parameter max_completion_tokens` when the endpoint requires it.
Responses uses `max_output_tokens`. Messages uses `--transport anthropic-messages`
with an endpoint ending in `/v1/messages` and `max_tokens`. Its requests use
`x-api-key` and version `2023-06-01`; Fleet maps its own tool schemas and results
to `tool_use` and `tool_result` blocks. Only text and client tool calls are
supported; other content blocks fail closed.

A local unauthenticated endpoint uses an explicit no-auth connection:

```shell
toolsenabled worker add local-model \
  --transport openai-chat \
  --endpoint http://127.0.0.1:11434/v1/chat/completions \
  --model EXACT_MODEL_ID --source local --auth none
toolsenabled worker run local-model --prompt 'Read the Fleet task list.'
```

Plain HTTP is limited to exact `localhost`, `127.0.0.1`, or `[::1]` hosts,
plus `host.openshell.internal` for an explicit local source. Inside OpenShell,
use `http://host.openshell.internal:PORT/v1/chat/completions` with `--source local
--auth none` to reach an already running host server through OpenShell policy.
Every other plain-HTTP host is refused. Fleet never starts or stops model servers.

On a normal host, use `--auth env --token-env YOUR_MODEL_KEY_VARIABLE`; supply
that variable through the host's environment. This mode is refused inside
OpenShell, and `--auth openshell` is refused outside it. The model variable is
not passed to the Fleet MCP child. No credential file is consulted by the
generic model transport.

Host execution requires the generic host shim and an installed Fleet host
runtime, selected explicitly with `TOOLSENABLED_RUNTIME_MODE=host` and the
installation's `TOOLSENABLED_STATE_ROOT` capability directory. The shim starts
the fixed `bin/toolsenabled-generic-host.js` entry, verifies the sealed tier and
workspace, and keeps standalone agent spawning off even when the installation
has opted into worker trees. Builds without the host runtime fail with
`OPENSHELL_WORKER_HOST_RUNTIME_UNAVAILABLE` before contacting a model. A missing
OpenShell marker does not silently grant a host runtime or enable host workers.

The host CLI reads its configured host container; append `--state-root ABS` to
select a different installation. For example:

```shell
toolsenabled worker add host-model \
  --transport openai-chat --endpoint https://YOUR_HOST/v1/chat/completions \
  --model EXACT_MODEL_ID --source api --auth env --token-env YOUR_MODEL_KEY_VARIABLE
toolsenabled worker run host-model --prompt 'Read the Fleet task list.'
```

To turn discovery into a connection, use its printed id and an exact model id:

```shell
toolsenabled agents
toolsenabled agents add anthropic --model EXACT_MODEL_ID --name messages-worker
toolsenabled agents add ollama --model EXACT_MODEL_ID --name local-worker
```

API discovery checks only whether the key name exists in the environment.
`agents add` saves that name with `auth env` on a host, or `auth openshell` inside
OpenShell. An empty or invalid key is refused at request time. A local connection
requires a running server and uses its discovered URL with `auth none`.
`--name` defaults to the discovered id; choose a different name when that id
is already an agent descriptor's name. These saves use the same validation and
host authorization as `worker add`. Restart the Fleet session to refresh its
model catalog.

On a host, `worker add` issues a private seal for the complete normalized
connection. Existing unsigned host connections must be added again using that
operator command. Each request checks the current saved connection and its
seal before resolving the named environment credential. Editing the JSON,
copying a seal from another state root, or removing the connection cannot
authorize a request. Removing a connection revokes its seal. The metadata-only
`saveConnection` helper does not issue host authority.

The host file tools refuse writes and patches to Fleet's canonical state and
control roots, including aliases and custom host containers. The seal key is
also excluded from file reads. This protects against a model using Fleet's
mediated tools; native code running as the same OS account remains outside
that boundary.

Host file reads, writes and patches stay inside the sealed setup workspace.
Known credential stores are excluded from reads; known VCS hooks and
configuration, editor and task-runner automation, executable search-path
directories, and shell startup files are excluded from writes. Keep provider
keys and other secrets outside the workspace; a hostile model endpoint can
receive text a worker reads and submits to it. We recommend the `standard`
host tier for new setup.

```shell
toolsenabled worker list --json
toolsenabled worker run nvidia --prompt 'Continue checking the task list.' \
  --resume THREAD_ID_FROM_THE_PREVIOUS_RUN
toolsenabled worker remove nvidia
```

Restart the Fleet MCP server/client session after adding, changing or removing
a connection so the agent-tree model catalog and `model-NAME` tier metadata
refresh. `worker run` reads the saved connection on each launch and needs no
catalog restart.

The command prints a resumable thread ID and assistant text. Terminal controls
and directional formatting in model text display as literal Unicode escapes;
ordinary text and newlines are preserved. Protocol data and histories remain
raw. Connection
metadata is saved under the Fleet state root in
`state/openshell-model-connections.json`; conversation histories are under
`state/generic-workers/CONNECTION/`. Histories include prompts and tool results.
Changing the endpoint, model, protocol, authentication or limits prevents
reusing a conversation bound to the previous connection. Unfinished or invalid
tool history is refused rather than replayed as completed work.

## Permissions and execution

`worker run` generates exactly one Fleet MCP entry. It offers only the
intersection of the saved permission tier, the reviewed base Fleet tools and
any active `TOOLSENABLED_TOOL_ALLOWLIST`. An explicitly empty list refuses
startup. The Unrestricted tier is still narrowed to the reviewed list.

The standalone command identifies its ledger actor as `local` and leaves the
agent tree off. It does not inherit a parent's agent identity, opt into spawning
workers, accept an executable path, or accept an arbitrary MCP server. A
configured `model-NAME` tier can also be used by the Fleet agent-tree integration
where that tree is explicitly enabled; its inherited role and tool restrictions
still apply. At inherited level 1, only Fleet tools whose declared effect is
`local-read` or `external-read` are offered and callable. Unknown levels default
to level 2; roles can narrow the inherited level and surface further.

Enable the host tree through setup's `--enable-workers`, or the OpenShell tree
through setup's `--agents` option, with the
chosen permission tier and workspace. A call to `agent.spawn` supplies its
normal CONTRACT/1 plus `tier: "model-nvidia"` and `surface: "tree"`. If setup
uses an explicit `--providers` list, include the saved connection name
`nvidia`; saving a connection never widens that restriction. Generic tiers
refuse reasoning-effort overrides and detached execution requests.

The connection's optional `--tier cheap|standard|premium` classifies it for
tree routing. It does not change the installation's `unrestricted`, `standard`
or `guided` permission level, and does not state a provider price.

There is no shell, generic executor, browser, arbitrary HTTP tool or hidden
vendor CLI in the direct worker. File operations are the existing mediated
Fleet tools when the saved permission tier permits them. Tool names are mapped
to portable wire names for model APIs; only names offered to that request can
be dispatched. Provider tool-call IDs are preserved across tool results and
resume. The transport validates the batch's protocol structure, call IDs,
offered tool names and argument JSON shape before delivery. Fleet checks each
tool's argument schema and permissions immediately before its handler runs.
Calls are separate operations: a later refusal does not roll back an earlier
successful tool.

The first model request in every assignment requires a function call. This
proves that the endpoint and selected model can request a reviewed Fleet tool
before a worker is treated as successful. An endpoint that rejects tools or
answers without the required call fails with `MODEL_API_TOOL_UNSUPPORTED`.
Later rounds may finish with ordinary assistant text. Prompts should request a
useful Fleet action, such as reading the task list, rather than a greeting alone.

## Limits and failure handling

**Fleet does not limit a worker's rounds, tokens or time.** You give a worker a task and it runs
until the model answers. (Until 2026-10-17 Fleet stopped a generic worker at 16 rounds, at a
cumulative 1,048,576-byte "admission budget" and at a 3-minute deadline, and a native local node at
24 rounds. Nobody asked for those limits and they ended working assignments, so they were removed.)
If you pay per token, set a spending limit with your provider; that is where a money cap belongs.

| Setting | Default | Accepted range |
|---|---:|---:|
| `--max-output-tokens` (length of one reply, sent to the endpoint) | 2,048 | 1–32,768 |

`--max-output-tokens` is a protocol parameter, not a budget: it is how long one reply may be, and
some APIs (Anthropic's Messages API) require it. A reply that reaches it ends that assignment with
`MODEL_API_OUTPUT_LIMIT`, because a cut-off reply cannot be trusted to carry complete tool calls;
raise it if your model writes long replies.

Connections saved before 2026-10-17 may carry `maxTurns`, `maxTotalTokens` and `timeoutMs`. They
still load, the values are dropped, and nothing enforces them. `worker add` still accepts
`--max-turns`, `--max-total-tokens` and `--timeout-ms` so that older scripts keep working, and says
that they do nothing.

The one stop that remains is **liveness**: a model request or a tool call that gives no answer at
all for 30 minutes means the endpoint or the tool is dead, and the assignment ends with
`MODEL_API_TIMEOUT` saying so, rather than hanging forever and holding its slot. It is re-armed on
every request and every tool call, so a worker that keeps making progress is never stopped,
however long it runs.

Cancellation of an already-running tool is cooperative: an external effect may have happened before
interruption. Fleet does not claim to undo it. Failed or interrupted work must be checked before
retrying. HTTP failures, redirects and ambiguous model responses are not automatically retried.

Transport defaults cap request and response bodies at 4 MiB and tool calls per
response at 128. Strict schemas, malformed argument refusal and advertised-name
checks apply before a tool is run. Raw authorization values, provider error
bodies and credential-bearing endpoint URLs are not printed by transport
errors.

## Qualification

The isolated tests cover Chat Completions, Responses and Messages, tool execution and
results, authentication classification, malformed calls, bounded output,
cancellation and resume. They use protocol stubs and do not establish that a
particular remote model or endpoint calls tools correctly. Validate each
model and endpoint before relying on it for agent work. Local OpenCode 1.x
conformance establishes MCP interoperability, not model behavior.

## MCP peers

Generate a separate OpenCode 1.x configuration after Fleet setup:

```shell
toolsenabled peer opencode --version 1.18.33 \
  --output /absolute/new/fleet-opencode.json
OPENCODE_CONFIG=/absolute/new/fleet-opencode.json opencode
```

The output path must be new; registration never opens or replaces an existing
client configuration or authentication file. Omit `--output` to print JSON.
The MCP server uses actor `local`, the same Fleet state directory and the
saved Fleet tier. OpenCode merges its configuration sources; this file does
not disable its native tools or act as a security boundary for the client.
Only the Fleet MCP surface is governed by Fleet's tier and allowlist.

OpenCode's stable 1.x dialect is supported. Version 2 uses a different MCP
configuration shape and is refused. Gemini CLI and Goose should work as
MCP peers, untested; no automatic registration or compatibility claim is made
for them. Peer conformance checks the shared durable work record, not shared
private conversation or agent-tree identity.
