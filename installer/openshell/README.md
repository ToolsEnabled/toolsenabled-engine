# ToolsEnabled Fleet for OpenShell: runtime

ToolsEnabled Fleet adds an MCP server and an optional agent tree to an existing OpenShell sandbox on Linux x86_64.

Fleet installs the `toolsenabled` command.

Consult the chosen [release's notes](https://github.com/ToolsEnabled/toolsenabled-engine/releases) for its qualification results and limitations. The installed manifest and `toolsenabled --version` identify the runtime's version and source commit.

## Requirements

Install these in your sandbox image before installing ToolsEnabled Fleet:

- Node.js **22.19.0 or newer**, available as `node` on `PATH`.
- Python 3 at `/usr/bin/python3`.
- Codex and/or Claude Code, installed separately using the provider's instructions and available on `PATH`.

The release archive contains ToolsEnabled Fleet and its locked production JavaScript dependencies. It does not bundle Node, npm, npx, Python, or provider CLIs. Installation is offline and does not install system packages or change OpenShell policy. Your sandbox's existing provider configuration and network policy govern provider access.

## Install

Download `toolsenabled-openshell-linux-x64.tar.gz` and `SHA256SUMS` from the chosen [ToolsEnabled Fleet release](https://github.com/ToolsEnabled/toolsenabled-engine/releases). Verify and upload the archive from your host:

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

The default installation directory is `~/.local/toolsenabled`. Pass an absolute path as the installer's first argument to choose another location. A relative path is refused. Re-run the installer to upgrade an existing ToolsEnabled Fleet installation in place; it replaces the runtime, keeps state, and prints both source commits. An unrelated existing directory is refused. `bash toolsenabled-installer/install.sh --help` shows usage without installing anything.

The installer installs `toolsenabled` and its `toolsenabled-openshell` alias. After a successful install it prints the exact command for optionally removing the uploaded tarball and extracted installer folder; it does not remove them itself.

Use `toolsenabled --version` to see the version and commit recorded in the installed `manifest.json`. To remove an installation while retaining its state, run `toolsenabled uninstall --keep-state`. It deregisters ToolsEnabled Fleet from available CLIs and removes the runtime and command wrappers. Version 1.4.1 retains all state: existing and manual state directories have no proof of exclusive Fleet ownership. Plain `toolsenabled uninstall` still asks about state; answering yes refuses before changing registrations or runtime. Re-run with `--keep-state` to remove the runtime. State paths that overlap the runtime, including aliases and ancestors, are refused.

An unavailable CLI keeps the runtime and returns an error unless the sealed setup record proves no registration attempt for that exact installation and selected profile. Older records and changed or unverified context mean unknown. This evidence describes setup history in that record's scope; it does not discover manual registrations or other profiles. A failed removal keeps the runtime unless absence is verified. The qualified contracts are Codex CLI **0.158.0** (fresh metadata-only `mcp get`) and Claude Code **2.1.284** (exact user-scope remove exit status and complete message). Other versions, signals, errors or different messages keep the runtime and print the manual removal command. Claude `mcp get`/`list` can start the server and are never used by this check. Earlier successful removals are not rolled back; the qualified absence checks allow a retry after partial success. Re-run `source ~/.local/toolsenabled/env.sh` in a new shell after an upgrade.

Uninstall refuses when the runtime contains a home directory, default or selected provider profile, a known OpenShell configuration/state/TLS path, or any mount point reported by `/proc/self/mountinfo`. Unreadable or ambiguous path/mount information also refuses. Beta 2 does not protect against concurrent ancestor replacement during removal; full descriptor-based traversal is deferred to beta 3. Use a trusted, idle sandbox and keep unrelated files outside the installation prefix. The install steps above are unchanged; the proposed host fetch flow is also deferred to beta 3.

## Build a runtime archive

From a clean checkout of this branch, with Node.js and npm on the build machine:

```bash
bash installer/openshell/build.sh
```

This packages committed runtime files and runs `npm ci --omit=dev --ignore-scripts` in a temporary build directory. Output is the archive and `SHA256SUMS` in `dist/openshell/`. The build does not copy the build machine's Node installation, npm installation, global packages, or credentials. `manifest.json` records the source commit and runtime requirements.

The older `adapters/openshell/image/` recipe is an optional development image build, separate from this release installer.

### Public source and archive identity

The [2026-09-30 beta1](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) archive was built from development commit `2d77e45e70b37b2911a2da342dda8ff23b583030`. Its public source export is [commit `546fc62faeadeaedb3562ccf784a2d8d66e62279`](https://github.com/ToolsEnabled/toolsenabled-engine/tree/546fc62faeadeaedb3562ccf784a2d8d66e62279). Fleet's beta1 release notes report that 1,220 project files in that archive match the snapshot byte for byte. This dated mapping applies only to beta1; later documentation or beta2 source changes are outside that claim.

The build script embeds the current checkout's commit in `manifest.json` and uses that commit's timestamp for archive entries. Building the public export therefore produces a different archive checksum. Obtain the published asset and its `SHA256SUMS` from the release when testing that release's exact bytes.

## Validation and scope

The archive is checked with installation and refusal tests, a content audit, and MCP initialization in an OpenShell sandbox. Release qualification also runs the frozen hand tests and continuous soak on the exact candidate archive. OpenShell process cleanup includes a fallback for sandboxes where `pidfd_open` is unavailable.

The MIT license, NOTICE, and third-party dependency notices are included in the runtime.
