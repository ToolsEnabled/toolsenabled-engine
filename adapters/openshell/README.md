# ToolsEnabled Fleet for OpenShell: sandbox and development image guide

ToolsEnabled Fleet's engine is an MCP server. This folder runs it inside your own
[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, next to the
official Claude Code and Codex CLIs.

Fleet installs the `toolsenabled` command.

The work is split this way:

- **OpenShell** provides the sandbox, the network policy, custody of the
  credentials it holds, and access approvals.
- **ToolsEnabled Fleet** adds:
  - a shared work record (tasks and a ledger), so work started in Claude Code
    can be picked up in Codex and the other way round;
  - memory and local search that carry across sessions and agents;
  - tools that read the sandbox's own policy and recent denials through
    OpenShell's `policy.local` advisor, explain each denial in plain words, and
    file the narrowest proposal for you to approve or reject with the
    `openshell` CLI;
  - optionally, a tree of Codex and Claude worker agents inside the same
    sandbox, which can start workers of their own (`--agents`).

This guide covers sandbox setup and a development image recipe. For the
published runtime archive, follow the
[installer guide](../../installer/openshell/README.md). Build the optional
development image yourself from this folder; its third-party CLIs stay under
their own terms.

ToolsEnabled Fleet is not made by, affiliated with, or endorsed by NVIDIA, Anthropic
or OpenAI.

> **Status recorded 2026-09-30 08:20 UTC:** the [Linux beta1](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930)
> was published with remaining qualification work listed in its release notes.
> Beta2, version 1.4.1, was still in development, pending publication and qualification.
> The [Windows WSL 2 route](WINDOWS.md#qualification-status-2026-09-30) was also
> under qualification. Consult release notes for later results. The [Supported versions](#supported-versions) table records
> historical image tests. Read [Known limitations](#known-limitations) before
> relying on Fleet.

---

## What you need

- A Linux x86-64 machine with **Docker Engine**, or a Windows x86-64 machine with WSL 2 and Docker Desktop's Linux engine. The Windows path is experimental; see [WINDOWS.md](WINDOWS.md).
- **OpenShell 0.1.2** installed, with a running local gateway that uses Docker.
  To install it, follow OpenShell's own documentation.
- `git`, `jq`, and the **Codex CLI on the host**. The Codex CLI on the host is
  used once, to create the sign-in that OpenShell will hold.
- A ChatGPT account with Codex access and/or a Claude account that can sign in
  to Claude Code.
- A web browser on the host, for the sign-ins.

## Quickstart

In the commands below, `te` is the sandbox name. Pick any short name (OpenShell
allows up to 19 characters).

### 1. Build the image

```shell
git clone https://github.com/ToolsEnabled/toolsenabled-engine.git
cd toolsenabled-engine
adapters/openshell/image/build.sh toolsenabled-openshell:wip
```

`build.sh` builds only from committed files. The image has to end up in the
container engine that your OpenShell gateway uses. If that engine is not your
`docker` CLI's current context, set `DOCKER_HOST` first, for example
`DOCKER_HOST=unix:///var/run/docker.sock`.

The image contains NVIDIA's `nvcr.io/nvidia/base/ubuntu:24.04` base; Node.js
22.19.0, checked against nodejs.org's published SHA-256 list; Claude Code
2.1.284 and Codex 0.158.0, installed unmodified from npm; the ToolsEnabled
engine at `/opt/toolsenabled/engine`; and two small commands,
`toolsenabled-openshell` and `codex-openshell-auth`.

### 2. Import the Codex provider profile from OpenShell's example

Skip steps 2 and 3 if you will only use Claude Code. This uses the profile
from OpenShell's `examples/codex-app-server` example, unchanged:

```shell
curl -fsSLO https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/examples/codex-app-server/codex.yaml
openshell provider profile lint --file codex.yaml
openshell provider profile import --file codex.yaml
```

### 3. Create the `codex` provider from a dedicated sign-in

This follows the example's own provider flow, with two differences:

- **You sign in to Codex once, just for OpenShell, in a private temporary
  directory.** The sign-in you use for Codex every day is not involved, so the
  gateway's refreshes never compete with it.
- **Token values are passed through environment variables.** They never
  appear on a command line.

```shell
umask 077
signin_dir="$(mktemp -d)"
CODEX_HOME="$signin_dir" codex login        # opens your browser

tok() { jq -er ".tokens.$1" "$signin_dir/auth.json"; }

CODEX_AUTH_ACCESS_TOKEN="$(tok access_token)" CODEX_AUTH_ACCOUNT_ID="$(tok account_id)" \
  openshell provider create --name codex --type codex \
    --credential CODEX_AUTH_ACCESS_TOKEN --credential CODEX_AUTH_ACCOUNT_ID

CODEX_AUTH_REFRESH_TOKEN="$(tok refresh_token)" \
  openshell provider refresh configure codex \
    --credential-key CODEX_AUTH_ACCESS_TOKEN \
    --strategy oauth2-refresh-token \
    --material client_id=app_EMoamEEZ73f0CkXaXp7hrann \
    --secret-material-env refresh_token=CODEX_AUTH_REFRESH_TOKEN

openshell provider refresh rotate codex --credential-key CODEX_AUTH_ACCESS_TOKEN

shred -u "$signin_dir/auth.json"; rm -rf "$signin_dir"
```

After these commands the gateway holds the refresh token and refreshes the
access token itself. The sandbox never receives the refresh token; it sees the
access token only as a placeholder.

### 4. Create the sandbox

```shell
openshell sandbox create --name te --from toolsenabled-openshell:wip \
  --policy adapters/openshell/policy/cli-sign-in.yaml \
  --provider codex --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --detach

openshell settings set te --key agent_policy_proposals_enabled --value true
```

- Leave out `--provider codex` if you skipped steps 2 and 3.
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
paths, a writable workspace (`/sandbox`) and `/tmp`, and one network rule that
lets Claude Code reach `api.anthropic.com` and `platform.claude.com` for
inference and sign-in. Codex's network rule comes from the provider.

### 5. Inside the sandbox: sign in and set up ToolsEnabled

```shell
openshell sandbox exec -n te --tty -- bash
```

Then, inside the sandbox:

```shell
codex-openshell-auth                  # only if you attached the codex provider
claude                                # type /login, approve in your browser, paste the code, /exit
toolsenabled setup --add              # add --agents for worker agents, --audit for the signed activity log
toolsenabled status
```

- **`codex-openshell-auth`** writes `~/.codex/auth.json` from the provider's
  placeholders. It contains no secret: the access-token placeholder, an
  unsigned stand-in ID token that carries no identity, an empty refresh token
  and no account id. OpenShell's proxy swaps in the real access token only on
  requests to the provider's endpoints. It follows the pattern of OpenShell's
  `examples/codex-app-server/start-codex-app-server`.
- **Claude Code's sign-in** uses Claude Code's own `/login` flow. See
  [Known limitations](#known-limitations) for where it is stored.
- **`toolsenabled setup`** (also installed as `toolsenabled-openshell`)
  records the permission level in the engine's sealed machine record:
  `unrestricted` by default inside a sandbox, because the sandbox is the
  boundary and the byte-mediated file tools need it; `--tier standard` or
  `--tier guided` (read-only) narrow it further. It creates `/sandbox/work`, and registers ToolsEnabled with each
  CLI through the CLI's own documented command (`claude mcp add-json` and
  `codex mcp add`). Without `--add` it prints those commands instead of running
  them. `--workspace DIR` must name a folder under the sandbox account's home
  (normally `/sandbox`), where the file tools can work; setup refuses a file or
  a symlink that leads outside it. It never signs in, reads a credential or
  touches the sandbox policy. With `--add`, it sets Codex's
  `daemon_auto_start = false` so each interactive app server stays inside its
  session, and marks the MCP entry `required = true` so Codex waits for
  ToolsEnabled before its first request. It keeps values you set yourself.

Check with `claude mcp list` and `codex mcp list`.

**Signing Codex in inside the sandbox instead of the provider.** Create the
sandbox with the policy's optional `codex_signed_in_here` rule uncommented. The
browser sign-in returns to `127.0.0.1:1455` on your machine, so forward that
port to the sandbox first, then sign in:

```shell
openshell forward start -d 1455 te            # on your machine
codex login                                    # in the sandbox; open the printed link
openshell forward stop 1455 te                 # on your machine, afterwards
```

`codex login --device-auth` also works when device-code sign-in is turned on
for your ChatGPT account. Codex then keeps its sign-in in `/sandbox/.codex`,
readable by processes in the sandbox, like Claude Code's.

### Other models

To run Codex on a model you choose, such as NVIDIA's API catalog, OpenRouter,
or a vLLM, NIM or Ollama server on your own machine, with the key held by an
OpenShell provider, see [MODELS.md](MODELS.md) (work in progress).

---

## What ToolsEnabled adds so far

36 tools, plus 11 agent tools with `--agents`. None of them reaches outside the sandbox.

| Group | Tools | What they do |
|---|---|---|
| Shared work record | `task.submit`, `task.claim`, `task.start`, `task.heartbeat`, `task.checkpoint`, `task.complete`, `task.fail`, `task.cancel`, `task.get`, `task.list` | Durable tasks any agent can claim, checkpoint and finish, so work carries from one agent or session to the next. |
| Ledger | `ledger.read`, `t_ledger.file`, `t_ledger.progress`, `t_ledger.complete`, `r_ledger.file` | Task records and your standing rules, labelled with the CLI that filed them. |
| Memory and search | `memory.get`, `memory.set`, `memory.search`, `search.index`, `search.query`, `search.status` | Notes and values that last across sessions; local search over files you index (lexical, with no model needed). |
| File editing (byte-mediated) | `host.read_file`, `host.write_file`, `host.patch_file`, `host.list_dir` | Edits coordinated between agents: a write or patch needs the agent's read of the current bytes, edits that do not overlap are merged, and stale edits refuse. Contained to the sandbox home; sign-in files and the vault are refused. Needs the `unrestricted` level. |
| Asks | `a_ledger.file` | An agent files a question for you; you answer it with `toolsenabled ledger`. |
| Status and audit | `settings.read`, `capability.find`, `system.status`, `system.doctor`, `audit.status`, `audit.tail`, `audit.verify` | What is set up and allowed, and the signed record of tool calls (turn it on with `setup --audit`). |
| Sandbox policy | `openshell.status`, `openshell.denials`, `openshell.propose` | Read the sandbox's advisor state and network rules; explain recent denials; propose the narrowest rule for one of them. |
| Agent tree (`--agents`) | `agent.spawn`, `agent.stop`, `agent.restart`, `agent.remove`, `agent.resume`, `agent.set_model`, `agent.set_effort`, `agent.set_provider`, `agent.set_role`, `agent_comms.send_local`, `agent_comms.local_roster` | Start Codex and Claude workers in the same sandbox, which can start their own; stop, restart, resume, reconfigure and remove them; message them; their reports come back to you. |

All state lives in `/sandbox/.toolsenabled`, which both CLIs share.

### In your terminal

| Command | What it does |
|---|---|
| `toolsenabled status` | Sandbox, policy advisor, network rules and setup at a glance. |
| `toolsenabled tree` | The agent tree: each worker's id, name, provider, model, role, state and parent, and whether a server holds the tree now. `--json` for a script. |
| `toolsenabled ledger` | Open asks, tasks and rules; `ledger answer A3 <words>`, `ledger decline A3 <reason>`, `ledger done T4`, `ledger remove T4`; `ledger add rule <words>` and `ledger add task <words>` for every agent, in your words. |
| `toolsenabled settings` | Every setting with its value and source; `settings set <id> <value>` changes one, validated like the desktop app. |

Inside one sandbox these are product rules, not a boundary: an agent could run
the same commands. Each page says so.

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

- **Workers.** `agent.spawn` starts a Codex or Claude Code worker on the tier
  you name. Each worker runs its own ToolsEnabled server, bound to that worker,
  so a worker can start workers of its own. The tree works like the desktop
  app's: each agent has at most 4 direct child slots and the tree goes at most
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
  stopped worker with nothing below it. `agent.set_model`, `set_effort` and
  `set_provider` apply at once to an idle worker and otherwise at its next turn
  boundary or start; `agent.set_role` records a role for the next session.
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

Neither CLI's own command sandbox can run inside OpenShell (it needs user
namespaces, which OpenShell denies), so Codex workers run with its sandbox and
approvals off and Claude workers with `bypassPermissions`. **OpenShell's policy
is what bounds them**, the same as any process in the sandbox; in this mode
ToolsEnabled's own permission level does not narrow what a worker can do.
Workers follow the saved Agent API mode (`toolsenabled settings get
agent.agent_api`): in `Only`, the default, Claude workers have no native tools
and Codex workers run without their shell, browser and delegation features.

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
- `agent.set_effort` relaunched an idle Claude worker in the same
  conversation; `agent.stop` ended its process group; `agent.resume` with an
  assignment continued the conversation.
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
  account to choose, so `agent.set_account` is not offered.
- **Workers are kept apart by rule, not by a boundary.** Every worker runs as
  the same user in the same sandbox. The link that tells the tree which worker
  is asking binds cooperating workers; it does not stop a worker that goes
  looking for another's files.
- **Only mode cannot close everything on Codex.** Codex's read-only native
  sandbox cannot run here and `apply_patch` has no off switch, so a Codex
  worker in `Only` mode can still read and patch files natively. Claude
  workers in `Only` mode have no native tools.
- **Your own session is not woken.** Nothing can start a turn in your CLI, so
  reports for you wait for your session's next `agent.*` or `agent_comms.*`
  call (`agent_comms.local_roster` is a cheap one).
- **Tasks are handed out by an agent, not picked up by themselves.** The
  desktop's `t_ledger.assign` is not offered here. To get a queued task worked
  on, ask your session to start a worker whose brief names it, or to send an
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
| `image/codex-openshell-auth` | Writes Codex's `auth.json` from the provider's placeholders |
| `policy/cli-sign-in.yaml` | Sandbox policy for the two CLIs |
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
base image each stay under their own terms. `codex-openshell-auth` follows the
pattern of an Apache-2.0 example from NVIDIA OpenShell.

NVIDIA and OpenShell are trademarks of NVIDIA Corporation. Claude and Claude
Code are trademarks of Anthropic. OpenAI and Codex are trademarks of OpenAI.
They are used here only to say what this works with.

## Reporting problems

- Bugs: https://github.com/ToolsEnabled/toolsenabled-engine/issues
- Security reports: see `SECURITY.md` in this repository. Please do not use
  public issues for security reports.
