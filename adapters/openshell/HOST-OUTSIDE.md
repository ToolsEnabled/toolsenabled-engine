# The Fleet authority outside OpenShell

`toolsenabled-authority` in the OpenShell package serves the person's settings,
ledger and signed audit from the machine that runs OpenShell. It listens on
`127.0.0.1` only. Each agent gets a separate `/mcp/<grant-id>` endpoint and a
separate token held by an OpenShell provider. There is no HTTP admin route.

From this checkout, use `node bin/toolsenabled-openshell-host.js`. The separately packaged local-host edition keeps its existing
`bin/toolsenabled-host.js` command and serves its installed host over stdio.
The authority entry ships with OpenShell and public source, not the plugin.

```sh
toolsenabled-authority init --root /absolute/fleet-authority --audit
toolsenabled-authority grant add worker-one --root /absolute/fleet-authority \
  --actor AGENT_ID --tools settings.read,ledger.read,a_ledger.file,system.ask,system.notify \
  --token-file /absolute/new-token-file
toolsenabled-authority profile worker-one --root /absolute/fleet-authority --env-var TE_HOST_WORKER
toolsenabled-authority policy worker-one --root /absolute/fleet-authority --binary /absolute/agent-executable
toolsenabled-authority serve --root /absolute/fleet-authority --port 18795
```

`AGENT_ID` is an id from `config/agents/*.json` or the person's descriptor under
`<root>/state/agents/`. Every described agent is treated equally; a grant does
not require a Fleet worker driver. A separate agent instance in another
sandbox should get its own grant even if it uses the same descriptor.

The token is generated for Fleet, written once to a new owner-only file and
never printed. The grants file stores only its SHA-256. The person imports the
printed provider profile, creates that provider with the generated token,
attaches it to the sandbox, reviews and installs the printed policy, and
removes their temporary token file. Fleet runs none of those commands. Fleet
never reads an agent's sign-in or token. At the person's request, setup registers
Fleet using the agent's documented MCP command or MCP configuration dialect;
it never installs an agent CLI or changes its permissions.

Inside the sandbox, register that instance's URL with its agent:

```sh
toolsenabled setup --add-authority http://host.openshell.internal:18795/mcp/worker-one \
  --token-env TE_HOST_WORKER --authority-agent AGENT_ID
```

Repeat for each installed agent instance with its own grant URL and variable
name. `--authority-agent` may be omitted when only one described agent is
installed. A single per-grant URL is never registered with several agents.
Separate instances of the same descriptor need separate sandbox profiles.
The variable must already contain the OpenShell placeholder supplied by its
provider; setup never reads its value, fetches a token, or runs OpenShell.
Only the agent expands the reference when connecting. Its Bearer header
carries the placeholder for `TE_HOST_WORKER`; the proxy substitutes the actual Fleet token.
The sandbox must never receive that token. A token works only on its own path,
and every call uses the grant's actor and tool list. Changing the actor in a
request is refused. A grant does not change an agent's permissions.

The served tools are `system.ask`, `system.notify`, `settings.read`, `ledger.read`, `t_ledger.file`,
`t_ledger.progress`, `t_ledger.complete`, `r_ledger.file`, `a_ledger.file`,
`audit.status`, `audit.tail`, and `audit.verify`. `--tier guided` narrows that
surface to reads; the default `standard` permits the listed writes subject to
the engine's existing settings, audit, and standing-rule evidence checks.
Only the person answers asks, changes settings, or edits the ledger on the host:

```sh
toolsenabled-authority ask list --root /absolute/fleet-authority
toolsenabled-authority ask answer Q1 yes "Proceed carefully" --root /absolute/fleet-authority
toolsenabled-authority ask answer Q2 no "Wait for review" --root /absolute/fleet-authority
toolsenabled-authority watch --once --root /absolute/fleet-authority
```

Read the question in full with `ask list` or `watch` before answering. The
`approvals` alias and `ask approve|deny` commands also work; a denial can take
back an uncollected yes. Ledger and settings keep their existing host commands.
Questions are scoped to a grant, even when several grants name the same agent
descriptor. Calling `system.ask` again with the same title and message reads
that grant's pending question or collects its answer once. There is no HTTP
answer, settings-write, ledger-admin, or file-read route. Tool results name no
path on the host: a path under the authority's root (a settings file, the audit
database) reads `kept on the ToolsEnabled host`; the host's own pages show the paths.

Setup seals the nonsecret URL/variable-name mapping in the machine record
before attempting registration. While an authority is configured, the sandbox
stdio server omits `system.ask` and `system.notify`, refuses direct calls to
them, and its local approvals commands cannot answer. Use the authority's
tools instead. This also applies to existing stdio registrations and survives
another setup run. If registration fails, the local answer path stays disabled.
The setup output and MCP initialization instructions explain where questions
go. Host approvals and watch pages read the authority's state root.

### Confirmed registration methods

The optional descriptor `register.http` contains either `kind: "command"`
with an `add` argv template, or `kind: "config"` with its JSON dialect. Both
name the `Authorization` header and the agent's `envSyntax`. Only whole
`{name}`, `{url}`, `{tokenEnv}`, or `{header}` placeholders are accepted in
their designated positions; literal credentials, shell fragments, permission
flags and unknown keys are refused.

- Claude Code: installed `claude mcp add --help` confirms `--transport http`,
  `--scope user`, and `--header`. Its [MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)
  confirms `Bearer ${NAME}` in headers. Fleet passes that text literally.
- Codex: installed `codex mcp add --help` confirms
  `mcp add NAME --url URL --bearer-token-env-var NAME`. Fleet passes only the
  variable name; the CLI owns its configuration and expansion.
- Gemini CLI: installed `gemini mcp add --help` confirms HTTP and `--header`,
  but its [MCP documentation](https://geminicli.com/docs/tools/mcp-server/#environment-variable-expansion)
  documents expansion in `env`, not HTTP headers. No `register.http` block
  ships until header expansion is confirmed. Setup prints a plain entry with
  the URL, bearer header name and variable name for manual registration.
- OpenCode: its [remote MCP documentation](https://opencode.ai/docs/mcp-servers/#disabling-oauth)
  confirms `type: "remote"`, `headers`, `Bearer {env:NAME}`, and `oauth: false`.
  Setup writes only this MCP entry in the described JSON configuration,
  preserving unrelated settings and refusing an existing conflicting entry.

`setup --add-authority URL --token-env NAME --authority-agent AGENT_ID
--print-server-json` prints the plain entry without changing setup. It is a
transport-neutral description, not an unverified client configuration dialect.

## Policy and identity limits

The earlier OpenShell 0.1.2 experiment found that placeholder resolution is
bound to host, port and path, not to the executable. A second rule with the
same credential binding gives every program it admits access to the grant.
Fleet therefore never drafts or proposes rules for the gateway host, even on
custom ports or broad paths. It also refuses loopback aliases and wildcard
host patterns that include those hosts. Only the person writes those rules
outside the sandbox. The guard reads no agent configuration to discover ports.
It cannot prevent the person or another policy client from writing such a rule.

OpenShell's executable match also includes ancestors: a program launched by an
admitted CLI can use its grant. A grant proves which sandbox rule admitted a
request, not the identity of a worker process. Use separate sandboxes and
separate grants when that distinction matters.

## MCP revisions

The HTTP service uses `SUPPORTED_PROTOCOLS` from `src/mcp-server.js` and
negotiates `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`.
`toolsenabled-authority status` shows the latest requested and answered
revision and client name/version for each grant actor. `toolsenabled status`
does the same for stdio clients in both runtime modes. Fleet retains at most
64 actors and 60 characters per client field in its own state, no other
client data. These are past handshake observations, not a live connection
check; reconnect each agent to refresh them. No newer revision is enabled.
The generated policy explicitly permits the three 2025 revisions recognized
by the measured OpenShell 0.1.2 MCP inspector. In the earlier experiment the
bundled stream-json agent negotiated `2025-11-25` and the app-server agent
negotiated `2025-06-18`. Omitting the policy's `mcp.versions` rejected the latter
after initialization, so it must stay explicit.

`2024-11-05` works directly on the service, but this inspector cannot be made
to accept it by adding an unknown revision to its policy. A client that only
uses that revision needs an inspector version supporting it; Fleet does not
weaken inspection to accommodate it. Unknown `server/discover` requests and
GET/DELETE streams are also outside this measured route; the bundled clients
fell back to ordinary POST requests. This port is tested with local HTTP
clients, not a new live OpenShell experiment.

The service runs in the foreground. Token rotation requires removing and
recreating a grant and updating the provider. The sandbox's own editable
ledger and audit remain separate from these host records. The host does not
anchor the sandbox audit, enforce a spend cap, or control sandbox file access.
