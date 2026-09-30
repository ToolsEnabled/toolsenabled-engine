# ToolsEnabled Fleet for OpenShell

ToolsEnabled Fleet provides agent fleet management and mediation for Codex and Claude Code inside an NVIDIA OpenShell sandbox. Its terminal MCP server adds a shared work record, memory, coordinated file edits and an optional tree of worker agents. All user controls are terminal commands.

Fleet installs the `toolsenabled` command.

OpenShell provides filesystem and network confinement, access approvals and custody of the credentials it manages. ToolsEnabled Fleet provides the tools and coordination inside that boundary. Its work record, actor labels and optional signed audit run as the same sandbox user as the agents; they are not tamper-proof against those agents.

ToolsEnabled Fleet for OpenShell **beta 2, version 1.4.1**, is published as [openshell-beta2-20260930](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta2-20260930). Its release notes record the completed checks and known limits. The tag `openshell-beta2-20260930` is this release's fixed public source: every ToolsEnabled Fleet file in the release archive is byte-identical to it.

The earlier [beta 1](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) keeps its fixed source at the tag `openshell-beta-20260930` (`546fc62`).

## Install the runtime archive

The release artifact is `toolsenabled-openshell-linux-x64.tar.gz`, installed into an existing **Linux x86-64 OpenShell sandbox**. It contains ToolsEnabled Fleet and its production JavaScript dependencies. Install Node.js **22.19.0 or newer**, Python 3 at `/usr/bin/python3`, and Codex and/or Claude Code separately in the sandbox image first. Fleet's installer runs offline and does not install those prerequisites or change OpenShell policy.

Obtain the chosen archive and its matching `SHA256SUMS`. On the host, verify the checksum and upload the archive:

```bash
sha256sum -c SHA256SUMS
openshell sandbox upload --no-git-ignore YOUR_SANDBOX toolsenabled-openshell-linux-x64.tar.gz /sandbox/
```

Inside that sandbox:

```bash
cd /sandbox
tar -xzf toolsenabled-openshell-linux-x64.tar.gz
bash toolsenabled-installer/install.sh
source ~/.local/toolsenabled/env.sh
toolsenabled setup --add
toolsenabled status
```

Sign in through each CLI's own flow. `setup --add` registers ToolsEnabled Fleet with each installed CLI. To enable worker agents, use `toolsenabled setup --agents --providers codex,claude --add`; choose only the providers you intend to use. `--providers` selects agent-tree workers and requires `--agents`.

See the [installer guide](installer/openshell/README.md) for alternate installation paths, upgrades, `--version` and uninstall. The [OpenShell setup guide](adapters/openshell/README.md) covers sandbox policy, provider attachment, sign-in and runtime limitations.

## What it adds

- **Work that carries across sessions:** agents claim, checkpoint and finish durable tasks; the ledger shows tasks, standing rules and questions for the person using the terminal.
- **Shared memory and local search:** notes and indexed files available across Codex and Claude sessions.
- **Coordinated file edits:** byte-mediated reads, writes and patches detect stale overlapping changes and merge edits that do not overlap.
- **An optional agent tree:** Codex and Claude workers can delegate, send reports, stop and resume, with limits on nesting, roles and provider choices.
- **OpenShell policy helpers:** explain recent denials and propose a narrow rule for the person to review outside the sandbox.

Use `toolsenabled ledger`, `toolsenabled tree`, `toolsenabled settings` and `toolsenabled status` for the terminal controls. The [reviewed tool list](src/lib/openshell-surface.js) defines what this build offers. Desktop automation, Fleet-managed sandboxes and credential capture are outside this terminal surface.

## Platforms and models

The compatibility baseline is OpenShell **0.1.2** on Linux x86-64 with rootful Docker. The [compatibility report](adapters/openshell/COMPATIBILITY.md) records the tested setup and probe scope; it is not a promise for every OpenShell release.

Windows uses **WSL 2 and Docker Desktop's Linux engine**, with the same Linux archive installed inside OpenShell. This route is experimental; there is no native Windows runtime installer for this terminal build. Use the same [runtime installation steps](installer/openshell/README.md) inside the sandbox and follow the [Windows source-build and qualification guide](adapters/openshell/WINDOWS.md).

`toolsenabled model` configures custom endpoints for Codex. This path requires a compatible Responses API and support for the tool format Codex sends. A successful simulator run does not establish that a hosted model can call Fleet tools; some custom backends do not handle Codex's namespace tools. General support for arbitrary models, or workers independent of Codex and Claude Code, is not established. Read the [model guide and known gaps](adapters/openshell/MODELS.md) before choosing an endpoint. Credentials for this path belong in OpenShell providers.

## Develop and qualify a candidate

From a clean, committed checkout on a build machine with Node.js and npm:

```bash
bash installer/openshell/build.sh
```

The build writes the runtime archive and `SHA256SUMS` to `dist/openshell/`; its manifest records the source commit. The [development image recipe](adapters/openshell/image/) is a separate convenience for sandbox development. A source test or development-image pass does not qualify the runtime archive.

Builds from a public source export record that export's commit and timestamp. See the [source mapping note](installer/openshell/README.md#public-source-and-archive-identity) before comparing their checksums with a published archive.

Release qualification must use the exact archive: audit its contents, install it offline, check refusals and both CLI connections, run the frozen hand-test pair and continuous soak, verify worker cleanup, and prove real Codex and Claude tool calls. Windows claims also need an artifact-specific parity report. This development branch and its historical test reports do not by themselves establish a qualified release.

ToolsEnabled Fleet is MIT licensed; see [LICENSE](LICENSE), [NOTICE](NOTICE) and [third-party notices](THIRD-PARTY-LICENSES.md). Provider CLIs remain under their own terms. ToolsEnabled Fleet is not affiliated with or endorsed by NVIDIA, Anthropic or OpenAI. Report security issues using [SECURITY.md](SECURITY.md).
