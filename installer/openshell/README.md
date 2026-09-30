# ToolsEnabled Fleet for OpenShell: runtime

ToolsEnabled adds an MCP server and an optional agent tree to an existing OpenShell sandbox on Linux x86_64.

## Requirements

Install these in your sandbox image before installing ToolsEnabled:

- Node.js **22.19.0 or newer**, available as `node` on `PATH`.
- Python 3 at `/usr/bin/python3`.
- Codex and/or Claude Code, installed separately using the provider's instructions and available on `PATH`.

The release archive contains ToolsEnabled and its locked production JavaScript dependencies. It does not bundle Node, npm, npx, Python, or provider CLIs. Installation is offline and does not install system packages or change OpenShell policy. Your sandbox's existing provider configuration and network policy govern provider access.

## Install

Download `toolsenabled-openshell-linux-x64.tar.gz` and `SHA256SUMS` from the chosen [ToolsEnabled release](https://github.com/ToolsEnabled/toolsenabled-engine/releases). Verify and upload the archive from your host:

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
toolsenabled setup --agents --providers codex,claude --add
toolsenabled status
```

To limit agent-tree workers to one provider, keep `--agents` and add `--providers codex` or `--providers claude` to the setup command. `--providers` controls the agent tree; `setup --add` registers each installed CLI. Sign in through each CLI's own login flow. Run `source ~/.local/toolsenabled/env.sh` in each new shell, or add that line to your shell profile.

The default installation directory is `~/.local/toolsenabled`. Pass an absolute path as the installer's first argument to choose another location. A relative path is refused. Re-run the installer to upgrade an existing ToolsEnabled installation in place; it replaces the runtime, keeps state, and prints both source commits. An unrelated existing directory is refused. `bash toolsenabled-installer/install.sh --help` shows usage without installing anything.

The installer installs `toolsenabled` and its `toolsenabled-openshell` alias. After a successful install it prints the exact command for optionally removing the uploaded tarball and extracted installer folder; it does not remove them itself.

Use `toolsenabled --version` to see the version and commit recorded in the installed `manifest.json`. To remove an installation, run `toolsenabled uninstall`. It removes the runtime and command wrappers, asks before deleting state, and deregisters ToolsEnabled from both installed CLIs. Use `toolsenabled uninstall --keep-state` to retain state without a prompt. Re-run `source ~/.local/toolsenabled/env.sh` in a new shell after an upgrade.

## Build a runtime archive

From a clean checkout of this branch, with Node.js and npm on the build machine:

```bash
bash installer/openshell/build.sh
```

This packages committed runtime files and runs `npm ci --omit=dev --ignore-scripts` in a temporary build directory. Output is the archive and `SHA256SUMS` in `dist/openshell/`. The build does not copy the build machine's Node installation, npm installation, global packages, or credentials. `manifest.json` records the source commit and runtime requirements.

The older `adapters/openshell/image/` recipe is an optional development image build, separate from this release installer.

### Public source and archive identity

The [2026-09-30 beta](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) archive was built from development commit `2d77e45e70b37b2911a2da342dda8ff23b583030`. Its public source export is [commit `546fc62faeadeaedb3562ccf784a2d8d66e62279`](https://github.com/ToolsEnabled/toolsenabled-engine/tree/546fc62faeadeaedb3562ccf784a2d8d66e62279). The release notes report that 1,220 ToolsEnabled files in the archive match that snapshot byte for byte. The source branch may contain later documentation updates.

The build script embeds the current checkout's commit in `manifest.json` and uses that commit's timestamp for archive entries. Building the public export therefore produces a different archive checksum. Obtain the published asset and its `SHA256SUMS` from the release when testing that release's exact bytes.

## Validation and scope

The archive is checked with installation and refusal tests, a content audit, and MCP initialization in an OpenShell sandbox. Release qualification also runs the frozen hand tests and continuous soak on the exact candidate archive. OpenShell process cleanup includes a fallback for sandboxes where `pidfd_open` is unavailable.

The MIT license, NOTICE, and third-party dependency notices are included in the runtime.
