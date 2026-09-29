# ToolsEnabled OpenShell preview

ToolsEnabled adds an MCP server and an optional agent tree to an existing OpenShell sandbox on Linux x86_64.

## Requirements

Install these in your sandbox image before installing ToolsEnabled:

- Node.js **22.19.0 or newer**, available as `node` on `PATH`.
- Python 3 at `/usr/bin/python3`.
- Codex and/or Claude Code, installed separately using the provider's instructions and available on `PATH`.

The release archive contains ToolsEnabled and its locked production JavaScript dependencies. It does not bundle Node, npm, npx, Python, or provider CLIs. Installation is offline and does not install system packages or change OpenShell policy. Your sandbox's existing provider configuration and network policy govern provider access.

## Install

Download `toolsenabled-openshell-linux-x64.tar.gz` and `SHA256SUMS` from the [release](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-preview-20260929). Verify and upload the archive from your host:

```bash
sha256sum -c SHA256SUMS
openshell sandbox upload YOUR_SANDBOX toolsenabled-openshell-linux-x64.tar.gz /sandbox/toolsenabled-openshell-linux-x64.tar.gz
```

Inside that sandbox:

```bash
cd /sandbox
tar -xzf toolsenabled-openshell-linux-x64.tar.gz
bash toolsenabled-installer/install.sh
source ~/.local/toolsenabled/env.sh
toolsenabled setup --agents --providers codex,claude --add
toolsenabled status
```

Use `--providers codex` or `--providers claude` if you use only one provider. Sign in through that CLI's own login flow. Run `source ~/.local/toolsenabled/env.sh` in each new shell, or add that line to your shell profile.

The default installation directory is `~/.local/toolsenabled`. Pass an absolute path as the installer's first argument to choose another location. The installer refuses an existing destination. It installs only the `toolsenabled` and `toolsenabled-openshell` commands; existing runtime and provider commands keep their own locations.

## Build the release

From a clean checkout of this branch, with Node.js and npm on the build machine:

```bash
bash installer/openshell/build.sh
```

This packages committed runtime files and runs `npm ci --omit=dev --ignore-scripts` in a temporary build directory. Output is the archive and `SHA256SUMS` in `dist/openshell/`. The build does not copy the build machine's Node installation, npm installation, global packages, or credentials. `manifest.json` records the source commit and runtime requirements.

The older `adapters/openshell/image/` recipe is an optional development image build, separate from this release installer.

## Validation and scope

The packaging fix is checked with installation and prerequisite failures, an archive-content audit, and MCP initialization in an OpenShell sandbox. It does not qualify every desktop-engine feature or a real provider model turn. The OpenShell runtime uses sandbox-compatible process-group handling; features using the general Linux pidfd helper remain subject to OpenShell's syscall restrictions.

The MIT license, NOTICE, and third-party dependency notices are included in the runtime.
