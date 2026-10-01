# ToolsEnabled Fleet for OpenShell: runtime

ToolsEnabled Fleet adds an MCP server and an optional agent tree to an existing OpenShell sandbox on Linux x86_64.

Fleet installs the `toolsenabled` command.

Consult the chosen [release's notes](https://github.com/ToolsEnabled/toolsenabled-engine/releases) for its qualification results and limitations. The installed manifest and `toolsenabled --version` identify the runtime's version and source commit.

## Requirements

Install these in your sandbox image before installing ToolsEnabled Fleet:

- Node.js **22.19.0 or newer**, available as `node` on `PATH`.
- Python **3.9 or newer** at `/usr/bin/python3`.
- Codex and/or Claude Code, installed separately using the provider's instructions and available on `PATH`.

The release archive contains ToolsEnabled Fleet and its locked production JavaScript dependencies. It does not bundle Node, npm, npx, Python, or provider CLIs. Installation is offline and does not install system packages or change OpenShell policy. Your sandbox's existing provider configuration and network policy govern provider access.

## Install

Version **1.4.2 (beta 3)** uses two commands: one on your host to transfer the verified archive, then one inside the sandbox to install it. Copy the release-specific host command from the chosen release's notes; it contains the fixed helper and archive hashes. Earlier releases retain their own installation instructions.

1. On your Linux or WSL host, run the release-specific command in Bash with your chosen OpenShell gateway, workspace and sandbox. Check the printed target. The command verifies the helper and archive hashes, checks the authenticated HTTPS target twice, and uploads the archive into a new random destination. It prints `Transfer completed; installation has not run.` followed by the command for that sandbox.
2. In the chosen sandbox's Bash shell, run the exact printed command. It rechecks the archive, extracts into a private stage, installs, runs setup and status, and makes `toolsenabled` available in that same shell. It does not edit shell startup files. A successful install reports the committed result; use `toolsenabled --version` and `toolsenabled status` to inspect it.

The host helper requires existing Python 3.9+, working Linux pidfds, OpenShell **0.1.2**, Bash, curl, sha256sum and mktemp. Consult the chosen release's qualification results for supported Linux/WSL combinations. The helper does not install host packages, execute a sandbox command, change gateway selection or change policy. The supported upload transport uses OpenShell's tar-over-SSH path in a trusted sandbox.

A fresh install defaults to `~/.local/toolsenabled`, agents enabled, unrestricted tier, both worker providers and audit disabled. The host command accepts `--prefix ABSOLUTE_SANDBOX_PATH`, `--tier guided|standard|unrestricted` and `--providers codex|claude|codex,claude`. Worker provider selection does not restrict which installed CLIs `setup --add` registers. Provider sign-in remains the provider CLI's own flow.

Fresh installation refuses an existing Fleet setup or an unproven same-name registration before provisioning or changing setup. This also applies after uninstall when the old setup state was kept; use a fresh scope for a new setup. To replace an existing runtime while preserving its setup, use upgrade. Qualified Codex inspection uses CLI **0.158.0**. Claude **2.1.284** freshness support is deliberately conservative: the selected profile must be empty or absent, and the default USER-store/backup names must be absent. The helper does not read Claude configuration or credential contents and does not call Claude `mcp get` or `list`, which can start servers. Existing Claude stores require a separately reviewed route; no blind removal is performed to establish freshness.

Runtime upgrades take an absolute archive and its independently published release digest:

```text
toolsenabled upgrade --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256
```

The release host command also accepts `--upgrade` for older runtimes. Upgrade preserves state, registrations and setup choices. Every runtime entry must match a pinned release inventory and the exact generated wrappers; unrelated files or unsafe paths refuse replacement. The old generation remains until the new one is verified and committed. Candidate 7 and beta 2 manual runtimes have independently pinned legacy inventories. An arbitrary manifest or copied ownership receipt does not establish ownership.

For a generation outside that fixed legacy catalog, also supply `--previous-archive ABSOLUTE_PREVIOUS_ARCHIVE --previous-sha256 PREVIOUS_RELEASE_SHA256` to the local upgrade command. Keep each uploaded release archive and its independently published digest; the runtime receipt alone is not deletion authority.

All participating setup, model, settings and lifecycle writers share one fixed per-user lock across prefixes and profiles. A partial setup or uncertain interruption keeps a durable recovery barrier, the runtime and its evidence. Do not delete that barrier or blindly rerun setup. Runtime transaction recovery uses the exact staged command printed on failure; it rechecks identities and never automatically replays a partial setup. If a committed old generation gains unknown contents, cleanup retains it and reports the remainder. Recovery accepts the printed intended journal path even if preparation stopped before creating that journal. After proving the active runtime unchanged, it can clear the preparation barrier while retaining partial or unknown preparation files; `PREPARATION_RETAINED` exits nonzero and does not claim cleanup succeeded.

Use `toolsenabled --version` to see the installed version and source. To remove a beta 3 runtime while keeping state, supply its original archive and independently published digest:

```sh
toolsenabled uninstall --keep-state --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256
```

Uninstall verifies the entire installed tree against that archive plus exact generated files before changing registrations. It retains ancestor, runtime and subdirectory handles through registration removal and deletes through those handles only while the complete inventory and identities remain valid. Unknown files, changed paths, protected roots, mounts or copied ownership receipts refuse removal. Partial provider removal, interruption or incomplete filesystem cleanup keeps a durable barrier and the runtime or remainder; preserve that evidence for review. State purge remains unimplemented: answering yes to plain uninstall refuses before mutation.

The new helper can also remove candidate 7 and beta 2 manual runtimes using the fixed release catalog. Run the reviewed beta 3 helper from a verified extracted package outside the old runtime: `/usr/bin/python3 -B ABSOLUTE_VERIFIED_PACKAGE/fleet_uninstall.py --prefix ABSOLUTE_OLD_PREFIX --keep-state`. Other generations require the explicit archive/digest pair above, also accepted by the helper. Running an old runtime's own uninstall command does not acquire these new protections.

Before either registration is removed, Codex **0.158.0** metadata must prove absence or show the canonical Node command and exact server argument for this runtime in the selected profile. Unknown versions, metadata formats, extra arguments or a different target refuse both removals. A distinct `.codex/config.toml` in the working HOME or its ancestors also refuses, because trusted project metadata can shadow the selected global profile. Only path metadata is checked; configuration contents are not read. The Node executable must resolve to the one running uninstall; changing it requires resolving the registration manually first. Claude retains the beta 2 successful-remove or exact version-qualified absence contract: **a Claude registration pointing to a different install could be removed by name**. Unavailable CLIs require sealed setup history for this exact installation and profile. Claude config files are not parsed and its connecting `mcp get/list` commands are not used. Other profiles and shadowing Claude registrations are outside this guarantee. All lifecycle operations require a trusted, quiescent target; they cannot prevent unrelated same-user programs from changing files concurrently.

For a new shell, source the installed prefix's `env.sh`. A verified stage is removed only after success and complete ownership verification. The uploaded archive remains available for recovery; failure messages identify retained stages and journals.

## Build a runtime archive

From a clean checkout of this branch, with Node.js and npm on the build machine:

```bash
bash installer/openshell/build.sh
```

This packages committed runtime files and runs `npm ci --omit=dev --ignore-scripts` in a temporary build directory. Output is the archive and `SHA256SUMS` in `dist/openshell/`. The build does not copy the build machine's Node installation, npm installation, global packages, or credentials. `manifest.json` records the source commit and runtime requirements.

After the archive freeze, the publisher runs `installer/openshell/render-fleet-fetch.py` with the literal archive/source/version/release pins and target choices. It emits a separately published `fleet-fetch.py`, the complete `host-command.txt` and a hash receipt. The helper is outside the archive to avoid circular hashing. Rendering is offline; it does not qualify upload or installation.

The older `adapters/openshell/image/` recipe is an optional development image build, separate from this release installer.

### Public source and archive identity

The [2026-09-30 beta1](https://github.com/ToolsEnabled/toolsenabled-engine/releases/tag/openshell-beta-20260930) archive was built from development commit `2d77e45e70b37b2911a2da342dda8ff23b583030`. Its public source export is [commit `546fc62faeadeaedb3562ccf784a2d8d66e62279`](https://github.com/ToolsEnabled/toolsenabled-engine/tree/546fc62faeadeaedb3562ccf784a2d8d66e62279). Fleet's beta1 release notes report that 1,220 project files in that archive match the snapshot byte for byte. This dated mapping applies only to beta1; later documentation or beta2 source changes are outside that claim.

The build script embeds the current checkout's commit in `manifest.json` and uses that commit's timestamp for archive entries. Building the public export therefore produces a different archive checksum. Obtain the published asset and its `SHA256SUMS` from the release when testing that release's exact bytes.

## Validation and scope

The archive is checked with installation and refusal tests, a content audit, and MCP initialization in an OpenShell sandbox. Release qualification also runs the frozen hand tests and continuous soak on the exact candidate archive. OpenShell process cleanup includes a fallback for sandboxes where `pidfd_open` is unavailable.

The MIT license, NOTICE, and third-party dependency notices are included in the runtime.
