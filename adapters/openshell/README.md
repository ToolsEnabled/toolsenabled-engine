# ToolsEnabled Fleet for OpenShell: sandbox and development image guide

ToolsEnabled Fleet's engine is an MCP server. This folder runs it inside your own
[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, next to the
agent CLIs you install and sign in yourself.

For Gemini CLI, use your own Gemini API key, Vertex AI, or a Gemini Code Assist Standard or Enterprise sign-in in `gemini`. Google ended Login with Google for individual plans in Gemini CLI on 2026-06-18.

Fleet asks each lead to pass its profile folders to Fleet so workers use the same profiles. Codex and Gemini CLI do not pass API keys or tokens to MCP servers unless you allow them. To let workers use a key from your environment, run `toolsenabled setup --add --pass-env NAME[,NAME...]`. Fleet records names only; the agent forwards values at runtime. Setup keeps the recorded names on reruns; `--pass-env ""` clears them. `toolsenabled status` shows the names.

Fleet installs the `toolsenabled` command.

The work is split this way:

- **OpenShell** provides the sandbox, the network policy, custody of the
  credentials it holds, and access approvals.
- **ToolsEnabled Fleet** adds:
  - a shared work record (tasks and a ledger), so work started in one agent
    can be picked up in another;
  - memory and local search that carry across sessions and agents;
  - tools that read the sandbox's own policy and recent denials through
    OpenShell's `policy.local` advisor, explain each denial in plain words, and
    file the narrowest proposal for you to approve or reject with the
    `openshell` CLI;
  - optionally, a tree of agent CLI, API and local model workers inside the same
    sandbox, which can start workers of their own (`--agents`) within inherited limits.

This guide covers sandbox setup and a development image recipe. For the
published runtime archive, follow the
[installer guide](../../installer/openshell/README.md). Build the optional
development image yourself from this folder; its third-party CLIs stay under
their own terms.

ToolsEnabled Fleet is not made by, affiliated with, or endorsed by NVIDIA, Anthropic
or OpenAI.

> Fleet **1.9.1** is the current release, published on
> [toolsenabled.ai](https://toolsenabled.ai), with public source to follow on GitHub.
> See the [1.9.1 release notes](../../docs/RELEASE-NOTES-1.9.1.md). The earlier
> Linux beta 3 release is version 1.4.2.
> Consult the chosen release notes for qualification results. The
> [Supported versions](#supported-versions) table records historical image
> tests, and [Known limitations](#known-limitations) describes this recipe.

---

## What you need

- A Linux x86-64 machine with **Docker Engine**, or a Windows x86-64 machine with WSL 2 and Docker Desktop's Linux engine. The Windows path is experimental; see [WINDOWS.md](WINDOWS.md).
- **OpenShell 0.1.2** installed, with a running local gateway that uses Docker.
  To install it, follow OpenShell's own documentation.
- `git`.
- For each agent you want inside the sandbox, a way for it to sign in: your
  own account with that agent's own sign-in, or an API key you attach as an
  OpenShell provider.
- A web browser on the host, for account sign-ins.

**ToolsEnabled has no sign-in step of its own.** Each agent signs in with its
own tool, inside the sandbox, the way it would on a new computer. ToolsEnabled
never reads, copies, stores or forwards a sign-in, and never removes the
variables an agent uses to sign in.

## Quickstart

In the commands below, `te` is the sandbox name. Pick any short name (OpenShell
allows up to 19 characters).

### 1. Build the image

Download the public source archive (`toolsenabled-fleet-<version>-source.tar.gz`) and
its checksum from [toolsenabled.ai/fleet-mcp](https://toolsenabled.ai/fleet-mcp/),
verify it, then from inside a git checkout of that source (`git init`, `git add -A`,
`git commit` once, so the builder has committed files to read):

```shell
adapters/openshell/image/build.sh toolsenabled-openshell:wip
```

`build.sh` builds only from committed files. The image has to end up in the
container engine that your OpenShell gateway uses. If that engine is not your
`docker` CLI's current context, set `DOCKER_HOST` first, for example
`DOCKER_HOST=unix:///var/run/docker.sock`.

The image contains NVIDIA's `nvcr.io/nvidia/base/ubuntu:24.04` base; Node.js
22.19.0, checked against nodejs.org's published SHA-256 list; Claude Code
2.1.284 and Codex 0.158.0, installed unmodified from npm; the ToolsEnabled
engine at `/opt/toolsenabled/engine`; and the `toolsenabled-openshell` command.

### 2. Create the sandbox

```shell
openshell sandbox create --name te --from toolsenabled-openshell:wip \
  --policy adapters/openshell/policy/cli-sign-in.yaml \
  --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --detach

openshell settings set te --key agent_policy_proposals_enabled --value true
```

- To use an API key instead of an account sign-in, create an OpenShell provider
  for it on your machine and add `--provider <name>`. The sandbox then sees only
  a placeholder, and OpenShell swaps in the real key on that provider's endpoints.
- `--env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stops Claude Code's
  self-updater, telemetry and error reporting, which the policy blocks anyway;
  `/usr/local` is read-only in the sandbox, so rebuild the image to update.
  OpenShell starts sandbox commands with its own environment, not the image's,
  which is why this is passed here. Codex's update check is also blocked and
  harmless.
- The second command turns on OpenShell's policy advisor for this sandbox. The
  `openshell.*` tools need it. It took up to about 30 seconds to take effect
  in our runs.

Read `policy/cli-sign-in.yaml` before you use it. It sets read-only system
paths, a writable workspace (`/sandbox`) and `/tmp`, and one network rule per
agent, covering the hosts each agent's own sign-in and inference use.

### 3. Inside the sandbox: connect your agents

Use agents you have already installed and configured yourself. Fleet has no
sign-in step and never installs an agent CLI. The bundled descriptors cover
Claude Code, Codex, Gemini CLI, and OpenCode equally. Add your own descriptor
under `<TOOLSENABLED_STATE_ROOT>/agents/` for another agent.

```shell
openshell sandbox exec -n te --tty -- bash
# Inside your sandbox:
toolsenabled setup --add              # add --agents for workers, --audit for activity records
toolsenabled status
toolsenabled setup --print-server-json
```

`setup --add` finds every described agent on PATH, independently of worker
`--providers`, and uses its documented registration command or MCP config
writer. Missing programs are skipped with a note. Existing conflicting
registrations are retained when ownership cannot be proven. Without `--add`,
setup prints the registration commands. Restart your agent session afterwards.

`--print-server-json` prints only the server entry (`command`, `args`, `env`),
with no sign-in values, from the existing setup. Use that entry with any MCP
client. Include the same `--agents`, worker limits, and lead-role options you
want in the printed entry. `status` asks each installed agent's own sign-in
status command when one is documented, and shows registration information;
unknown or unverified states are labeled explicitly.

Fleet tools follow how you started your agent, minus role limits: level 1
offers reads, levels 2 and 3 offer workspace tools, and level 4 offers the full
available surface. `--tier` is optional: narrow Fleet’s own tools further.
The default `unrestricted` adds no cap; `standard` and `guided` remain valid caps. `--workspace DIR` must stay inside the
sandbox account's home. It never changes the sandbox policy or adds agent
permission grants. Descriptor settings keep MCP tools visible and startup
reliable in OpenShell; existing user values are preserved. The bundled Codex
descriptor specifies `omit_tools_from = ["deferred"]`, `required = true`, and
`daemon_auto_start = false` for those purposes.

Registration methods follow the clients' documentation:
[Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://developers.openai.com/codex/mcp),
[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), and
[OpenCode](https://opencode.ai/docs/mcp-servers/).

Uninstall requires proof of the selected registration's ownership or absence.
Unknown versions, changed entries, removed descriptors, and clients without a
qualified nonconnecting inspection retain the runtime for review. In
particular, setup history alone cannot prove that a client entry is unchanged.

### Other models

To run Codex on a model you choose, such as NVIDIA's API catalog, OpenRouter,
or a vLLM, NIM or Ollama server on your own machine, with the key held by an
OpenShell provider, see [MODELS.md](MODELS.md) (work in progress).

---

## What ToolsEnabled adds so far

36 tools, plus 7 agent tools with `--agents`. None of them reaches outside the sandbox.

| Group | Tools | What they do |
|---|---|---|
| Shared work record | `task.submit`, `task.claim`, `task.start`, `task.heartbeat`, `task.checkpoint`, `task.complete`, `task.fail`, `task.cancel`, `task.get`, `task.list` | Durable tasks any agent can claim, checkpoint and finish, so work carries from one agent or session to the next. |
| Ledger | `ledger.read`, `t_ledger.file`, `t_ledger.progress`, `t_ledger.complete`, `r_ledger.file` | Task records and your standing rules, labelled with the CLI that filed them. |
| Memory and search | `memory.get`, `memory.set`, `memory.search`, `search.index`, `search.query`, `search.status` | Notes and values that last across sessions; local search over files you index (lexical, with no model needed). |
| File editing (byte-mediated) | `host.read_file`, `host.write_file`, `host.patch_file`, `host.list_dir` | Edits coordinated between agents: a write or patch needs the agent's read of the current bytes, edits that do not overlap are merged, and stale edits refuse. Contained to the sandbox home; sign-in files and the vault are refused. Needs level 4 with no narrower optional cap. |
| Asks | `a_ledger.file` | An agent files a question for you; you answer it with `toolsenabled ledger`. |
| Status and audit | `settings.read`, `capability.find`, `system.status`, `system.doctor`, `audit.status`, `audit.tail`, `audit.verify` | What is set up and allowed, and the signed record of tool calls (turn it on with `setup --audit`). |
| Sandbox policy | `openshell.status`, `openshell.denials`, `openshell.propose` | Read the sandbox's advisor state and network rules; explain recent denials; propose the narrowest rule for one of them. |
| Agent tree (`--agents`) | `agent.spawn`, `agent.stop`, `agent.restart`, `agent.remove`, `agent.resume`, `agent_comms.send_local`, `agent_comms.local_roster` | Start Codex and Claude workers in the same sandbox, which can start their own; stop, restart, resume and remove them; message them; their reports come back to you. |

All state lives in `/sandbox/.toolsenabled`, which both CLIs share.

### In your terminal

| Command | What it does |
|---|---|
| `toolsenabled status` | Sandbox, policy advisor, network rules and setup at a glance. |
| `toolsenabled tree` | The agent tree: each worker's id, name, provider, model, role, state and parent, and whether a server holds the tree now. `--json` for a script. |
| `toolsenabled ledger` | Open asks, tasks and rules; `ledger answer A3 <words>`, `ledger decline A3 <reason>`, `ledger done T4`, `ledger remove T4`; `ledger add rule <words>` and `ledger add task <words>` for every agent, in your words. |
| `toolsenabled settings` | Every setting with its value and source; `settings set <id> <value>` changes one after validation. |

Inside one sandbox these are product rules, not a boundary: an agent could run
the same commands. Each page says so.

Every ledger change typed at the terminal (`ledger answer`, `decline`, `done`,
`remove` and `add`, and `ledger apply` for terminal integrations) first writes
a signed `ledger.apply.intent` event to the audit ledger, with the actor
`owner-claimed`. If that event cannot be written, the ledger is not changed.
The event records who acted only as far as the local user account is trusted:
any process running as the same user, an agent included, can create an
identical event that verifies. It is a signed claim, not proof that a person
typed the command.

### Ledger data for terminal integrations

`toolsenabled ledger --json` returns the read-only
`ai.toolsenabled/fleet-ledger/v1` contract. The host-mode CLI supports the same
options with its usual `--state-root`. This reads the existing ledger and does
not create, answer, close or remove records. The JSON mode refuses ledger actions.

Open items are the default; `--all` includes closed and removed items. `--limit`
accepts 1–100 (default 50); `--offset` defaults to 0 and counts records after
filtering. Follow `nextOffset` until null, keeping the same open/all filter.
Pass the returned `revision` as `--revision N` on later pages. If the ledger
changes, the reader refuses and asks you to reload from offset 0; do not combine
pages from different revisions. The module error code is `LEDGER_PAGE_CHANGED`.

Each response includes `schema`, `revision`, `updatedAt`, `view`, `records`,
`total`, `offset`, `limit`, `nextOffset` and `grantsAuthority: false`. Each row
has `id`, `kind` (R/T/A), `title`, bounded `words`, `truncated`, `status`,
`filedAt`, `filedBy`, `scope`, `scopeKey`, `completedAt` and an optional `answer`
(`words`, `truncated`, `at`). The title is a shortened single line; use `words`
for row details and `filedAt` to calculate age. Words and answers are capped at
8,000 Unicode characters; `truncated` says whether more text was present. The
engine replaces terminal and direction controls before display, and consumers
must still treat all record text as untrusted. The output excludes store paths,
capture logs, history and authority metadata.

The same reader is available to a vendored plugin as
`openshell-ledger-page.machineView({ includeClosed, offset, limit, revision })`
after that plugin has selected its own verified runtime and state root. Missing
plugin setup must be handled before this read, without silently using another
installation's state. No MCP call or model turn is needed to display this data.

The engine's own records (for example the audit signing key) are kept in an
owner-only file under `/sandbox/.toolsenabled/vault`; a credential an OpenShell
provider injects under the same name is used instead, as its placeholder.

### How the policy tools and approvals work

1. `openshell.denials` reads recent denials from `http://policy.local`,
   explains each one in plain words, and shows the narrowest rule that would
   allow exactly that request: the host and port for a blocked connection, or
   the method and path for a blocked request.
2. `openshell.propose` files that rule with the advisor. It only accepts a
   denial that actually happened recently, and a proposal changes nothing by
   itself.
3. You review and decide from outside the sandbox:

   ```shell
   openshell rule get te
   openshell rule approve te --chunk-id <id>    # or: openshell rule reject te --chunk-id <id>
   ```

Review the rule `openshell rule get` shows, not the agent's description of it.
The tools never hand you a ready-made command that widens the policy, cannot
approve a proposal (OpenShell offers no way to approve from inside a sandbox),
never edit the policy and never run `openshell` on the host. OpenShell may also
draft proposals of its own from denials; those appear in the same list.

### The agent tree

With `setup --agents`, the agent you talk to (Claude Code or Codex) holds a tree
of worker agents in the same sandbox:

- **Workers.** `agent.spawn` starts an agent CLI or direct model worker on the tier
  you name. Each worker runs its own ToolsEnabled server, bound to that worker,
  so a worker can start workers of its own. Each agent has at most 4 direct child slots and the tree goes at most
  3 levels below you (the `fleet.tree_width` and `fleet.tree_depth` settings);
  an agent manages every worker below it, never a sibling or one above it.
- **Reports come back.** When a worker finishes a turn, its last message is
  delivered to the agent that started it, as a new turn, or held until that
  agent runs again. Reports for your own session arrive on its next
  `agent.*` or `agent_comms.*` answer, as `reports`. `agent_comms.send_local`
  sends a message to a manager or a direct report the same way.
- **Lifecycle.** `agent.stop` ends a worker and keeps its conversation;
  `agent.resume` continues it, optionally with a next assignment;
  `agent.restart` starts it over from its brief; `agent.remove` deletes a
  stopped worker with nothing below it.
- **Never wider than its parent.** A worker may use only the tools its parent
  has (roles narrow them), and only a provider and tier class that every agent
  above it allows. `setup --providers codex,claude` and
  `--max-tier cheap|standard|premium` set the limits for the whole tree;
  `--lead-role` chooses your session's role.
- **Processes.** Each worker leads a process group of its own; stopping it, or
  closing your session, ends everything it started.
- **It is kept.** The tree is saved under `/sandbox/.toolsenabled`. When your
  CLI starts again, its ToolsEnabled server takes the tree back with every
  worker stopped and resumable. `toolsenabled tree` shows it.

Workers inherit the lead’s level, lowered by their role and every ancestor.
If a CLI cannot enforce that level inside OpenShell, Fleet refuses to start it.
OpenShell’s policy also bounds every process. Same-agent workers keep the lead’s
settings sources. Agent API `Only` mode removes native tools without adding
permission grants. Roles can additionally remove native `shell` or `web`
categories; workers that cannot enforce those removals are refused.

---

## Who enforces what

| Enforced by OpenShell | ToolsEnabled product rules |
|---|---|
| **Filesystem.** Paths are read-only or writable as the policy lists them (Landlock, required). Under `cli-sign-in.yaml`, `/usr`, `/etc` and `/opt/toolsenabled` are read-only; `/sandbox` and `/tmp` are writable. | **Shared record and memory.** Kept in `/sandbox/.toolsenabled`. Every process in the sandbox, including every agent, can read and change these files. |
| **Network.** Denied by default. Only the programs a rule lists can reach its hosts, and each rule also covers every process those programs start. | **Actor labels.** `claude` and `codex` label who filed a record. They are not authentication. |
| **Codex credentials.** The gateway holds and refreshes the refresh token. The sandbox sees placeholders, and the proxy swaps in the real access token only on requests to the provider's endpoints. | **Tool list.** Sets which tools the server offers. It lives in each CLI's own settings, which agents in the sandbox can edit. |
| **Access approvals.** New network access needs a proposal that you approve. An agent cannot approve its own proposal. | **Policy tools.** Draft the narrowest rule they can. They never approve and never edit the policy. |
| **Denial log.** OpenShell records blocked connections and requests. | **Credentials.** ToolsEnabled never reads, copies or relays a credential. Nothing enforces this; the Claude sign-in is readable inside the sandbox. |

Only the left column is a security boundary. The right column is code that runs
inside the sandbox as the same user as the agents.

---

## Supported versions

The table below records the image recipe tested on 2026-09-28. It does not
describe the qualification status of a later runtime archive. That archive's
release notes and parity report identify its tested commit and checksum.
The Windows host route uses WSL2 and Docker Desktop's Linux engine to run the
same Linux x64 archive inside OpenShell; it is not a native Windows runtime.

| Component | Tested | Not tested |
|---|---|---|
| OpenShell | 0.1.2 | Any other version. OpenShell ships stable releases often. |
| Host | Linux x86-64, Ubuntu, kernel 7.0 | arm64 (the Dockerfile accepts it), macOS, Windows/WSL |
| Runtime | Docker Engine 29.8, rootful | Podman, Docker Desktop, Kubernetes, MicroVM, rootless Docker |
| Claude Code | 2.1.284 (pinned) | Other versions |
| Codex CLI | 0.158.0 (pinned) | Other versions |
| Node.js | 22.19.0 | Other versions |

### What has been run (2026-09-28, in sandboxes built from this recipe)

- Codex answered through the gateway-held sign-in, with only placeholders in
  the sandbox.
- `toolsenabled-openshell setup --add` registered ToolsEnabled with both CLIs.
- Codex called `openshell.status`, `task.submit`, `task.list`, `t_ledger.file`
  and `ledger.read` through ToolsEnabled.
- Codex read a real denial with `openshell.denials` and filed it with
  `openshell.propose`; from outside, `openshell rule get` showed it pending
  with the stated reason and OpenShell's prover reporting no new findings.
- With `--agents`, Codex started a Codex worker with `agent.spawn`, read its
  answer and stopped it.
- Called directly inside the sandbox: `memory.set/get`, `search.index/query/status`,
  `settings.read`, `capability.find`, `system.status`, `system.doctor`.
- Claude Code signed in inside the sandbox with its own `/login`, filed a task
  with `task.submit`, and Codex read the same task with `task.list`.

### The agent tree (2026-09-29, with scripted model answers)

Run in a sandbox built from this recipe, with the real, unmodified CLIs and a
local stand-in answering both providers' APIs from scripts, so no model
allowance was used. A test client played your session over MCP.

- A Claude worker started a Codex worker of its own through its own
  ToolsEnabled server; the Codex worker's answer reached the Claude worker as
  a new turn, and both reports reached your session.
- A Claude worker listed its place on the tree with `agent_comms.local_roster`.
- A fourth level below your session, a fifth child of one agent and a premium
  model under a standard parent were refused, each with its own sentence.
- `agent.stop` ended a worker's process group; `agent.resume` with an
  assignment continued its conversation.
- Closing your session left no worker process running. The next server took
  the tree back with every worker stopped; a report for a stopped worker was
  held and delivered when it was resumed.
- Killing the server outright: its workers ended when their input closed.

A Codex worker calling ToolsEnabled tools has since been run end to end: the
stand-in now drives Codex 0.158's code mode (below).

### A scripted hand test (2026-09-29, work in progress)

A hand test of 41 items runs the real, unmodified Claude Code 2.1.284 and Codex
0.158.0 inside OpenShell 0.1.2 sandboxes built from this recipe, with a local
stand-in answering both providers' APIs from scripts, including Codex's code
mode, which every current model in Codex's catalogue uses. It covers setup,
what agents are told, tasks, the ledger and its terminal page, memory, search,
byte-mediated file edits by two agents at once, long files read in windows,
settings, the signed audit and its off switch, the OpenShell policy tools with
a proposal approved and one rejected, the agent tree (workers, nesting, limits,
roles, reports, a sandbox stopped under a running tree, resume afterwards), a
model endpoint whose key only OpenShell holds, and credential leaks. On one
commit it passed 40 items twice, from the same frozen scripts; the remaining
item, one turn with a real model, has not been run. No model allowance was used.

---

## Known limitations

- **The Claude sign-in is stored in the sandbox.** OpenShell's Claude profile
  accepts API keys only; gateway-held sign-in for subscriptions is tracked
  upstream as [NVIDIA/OpenShell#3331](https://github.com/NVIDIA/OpenShell/issues/3331).
  Until then Claude Code keeps its sign-in under `/sandbox/.claude`, where any
  process in the sandbox can read it. When #3331 lands this moves to the
  gateway.
- **Codex's account id is left unset.** With the provider's account-id
  placeholder written into `auth.json`, Codex 0.158.0 exits with "selected
  workspace missing from routing discovery". Unset, Codex uses the workspace
  the server returns, so if you belong to more than one ChatGPT workspace you
  cannot choose which one.
- **Codex may reach hosts outside its profile.** In our runs Codex also tried
  an `*.oaiusercontent.com` host that OpenShell's example profile does not
  list. OpenShell blocked it and drafted a proposal; you decide.
- **Placeholders and inherited rules.** Placeholder values are visible to every
  process in the sandbox, and a network rule also covers every process its
  listed programs start. The ToolsEnabled server a CLI launches can therefore
  reach that CLI's endpoints. The tools listed above make no outside network calls.
- **The work record is not tamper-proof.** Any agent in the sandbox can change
  it.
- **The signed audit log is not tamper-proof inside one sandbox.** Its key is
  in the sandbox vault file, which every process in the sandbox can read. It
  shows what happened; it cannot prove it against an agent in the same
  sandbox. OpenShell's own logs record connections and requests.
- **The agent tree runs on one sign-in per CLI.** Claude workers use Claude
  Code's sign-in in the sandbox (or a Claude provider's key); there is no
  account to choose, so `agent.set_account` is not offered. They share the
  lead's `CLAUDE_CONFIG_DIR`. A short overlapping run kept both sessions
  signed in; concurrent token refresh has not been qualified, and Fleet does
  not serialize the CLI's internal refresh operation.
- **Workers are kept apart by rule, not by a boundary.** Every worker runs as
  the same user in the same sandbox. The link that tells the tree which worker
  is asking binds cooperating workers; it does not stop a worker that goes
  looking for another's files.
- **Only mode keeps native file edits.** Codex's read-only native
  sandbox cannot run here and `apply_patch` has no off switch, so a Codex
  worker in `Only` mode can still read and patch files natively. Claude
  workers in `Only` mode may Read, Edit and Write inside the recorded
  workspace with `--restricted`; a CLI without that flag is refused. Other
  built-in tools stay off. Claude's path rules are a CLI
  permission boundary; OpenShell is the OS file boundary.
- **Your own session is not woken.** After starting workers, call `agent.wait`
  before answering the person. It waits up to 30 seconds by default, returns
  reports once and shows how many worker turns remain active. Repeat it after
  a timeout up to three times, then report which workers remain active and stop waiting. A report arriving after your final tool
  call waits in the inbox until the next turn; `tree --json` exposes only its
  `reportsReady` count for a status-line notice.
- **Tasks are handed out by an agent, not picked up by themselves.** To get a
  queued task worked on, ask your session to start a worker whose brief names
  it, or to send an
  existing worker the task id; the worker claims and completes it with the
  task tools, and its report comes back to you.
- **Requests can fail right after changes.** A request made just after the
  sandbox starts, or just after a policy change, can occasionally fail while
  the new policy loads. Retry it.
- **No published image.** You build it yourself (step 1).

---

## Files in this folder

| Path | Purpose |
|---|---|
| `image/Dockerfile`, `image/build.sh` | Image recipe |
| `policy/cli-sign-in.yaml` | Sandbox policy: one network rule per agent's own sign-in and inference hosts |
| `MODELS.md` | Plugging in another model: hosted OpenAI-compatible APIs and servers on your machine |
| `providers/*.template.yaml` | OpenShell provider profile templates for a model endpoint |
| `COMPATIBILITY.md` | What was probed on the tested OpenShell setup, and the results |

The setup command is `bin/toolsenabled-openshell.js`; the reviewed tool list is
`src/lib/openshell-surface.js`; the policy tools are
`src/lib/providers/openshell.js`; the agent tree is
`src/lib/openshell-agent-host.js`, with its worker sessions in
`src/lib/openshell-worker-session.js`, its record in
`src/lib/openshell-tree-store.js` and the link between workers' servers and
the tree in `src/lib/openshell-tree-link.js`.

## Your agreements with Anthropic and OpenAI

Claude Code and Codex run unmodified and sign in through their own flows. Your
usage is billed to your own plan or key, under your own agreement with
Anthropic or OpenAI. ToolsEnabled does not pay for, resell or route that usage.
Subscription plans are meant for one person's own use; for unattended or
larger teams of agents, use API keys.

## Licence and names

The ToolsEnabled engine is MIT licensed. Claude Code, Codex, Node.js and the
base image each stay under their own terms.

NVIDIA and OpenShell are trademarks of NVIDIA Corporation. Claude and Claude
Code are trademarks of Anthropic. OpenAI and Codex are trademarks of OpenAI.
They are used here only to say what this works with.

## Reporting problems

- Bugs: email support@toolsenabled.ai.
- Security reports: see `SECURITY.md` in this source. Please do not report
  security problems publicly.

### Terminal questions and notices

Agents can use `system.ask` for a yes/no question and `system.notify` for a
notice. Read them with `toolsenabled approvals` or follow them with
`toolsenabled watch`. After reading a question, use
`toolsenabled approvals approve Q1 [words...]` or
`toolsenabled approvals deny Q1 <reason...>`. A yes can be taken back with
`deny` until the agent collects it.

An ask waits at most 30 seconds, then returns `pending`. Asking again with the
same title and message collects the answer once. Unanswered questions expire
after a day; uncollected answers expire after an hour. The CLI's own timeout
can end a call sooner. A notice being posted does not mean the person saw it.
Answers never issue tool tokens or change agent permissions. Fleet offers no
paying tools and no spend cap.

These pages share the sandbox's files, so they cannot prove who answered.
For settings, ledger and audit records outside the sandbox, see
[the host authority](HOST-OUTSIDE.md).
