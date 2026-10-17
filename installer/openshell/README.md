# ToolsEnabled Fleet for OpenShell: runtime

ToolsEnabled Fleet 1.9.1 adds an MCP server and an optional agent tree to an existing OpenShell sandbox on Linux x86_64.

Fleet installs the `toolsenabled` command.

Version 1.9.1 is published on [toolsenabled.ai](https://toolsenabled.ai), with public source to follow on GitHub. Consult the release notes and qualification results there; the runtime also includes `docs/RELEASE-NOTES-1.9.1.md` under its engine directory. The installed manifest and `toolsenabled --version` identify the runtime's version and source commit.

## Requirements

Install these in your sandbox image before installing ToolsEnabled Fleet:

- Node.js **22.19.0 or newer**, available as `node` on `PATH`.
- Python **3.9 or newer** at `/usr/bin/python3`.
- The agent CLIs you use, installed separately using their own instructions and available on `PATH`. Bundled descriptors cover Claude Code, Codex, Gemini CLI and OpenCode.

The release archive contains ToolsEnabled Fleet. The 1.9.1 release declares no production npm dependencies. It does not bundle Node, npm, npx, Python, or provider CLIs. Installation is offline and does not install system packages or change OpenShell policy. Your sandbox's existing provider configuration and network policy govern provider access.

## Install

The **1.9.1** archive is `toolsenabled-openshell-1.9.1-linux-x64.tar.gz`. Installation uses two commands, shown in full in the [README](../../README.md#install-the-runtime-archive): on your host, verify the archive against the release's `SHA256SUMS` and upload it with `openshell sandbox upload`; then, inside the sandbox, extract it and run `toolsenabled-installer/install.sh --setup --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256`. The installer rechecks the archive, extracts into a private stage, installs, runs setup and status, and makes `toolsenabled` available after `source ~/.local/toolsenabled/env.sh`. It does not edit shell startup files. Use `toolsenabled --version` and `toolsenabled status` to inspect the result. The earlier beta 3 release is version 1.4.2.

Package staging in this source tree refuses group-writable manual extractions, even in a private staging directory. If you trust the verified package and its extraction location, run `chmod -R go-w ABSOLUTE_VERIFIED_PACKAGE` yourself and retry; the installer does not silently change those permissions.

The host helper requires existing Python 3.9+, working Linux pidfds, OpenShell **0.1.2**, Bash, curl, sha256sum and mktemp. Consult the chosen release's qualification results for supported Linux/WSL combinations. The helper does not install host packages, execute a sandbox command, change gateway selection or change policy. The supported upload transport uses OpenShell's tar-over-SSH path in a trusted sandbox.

A fresh install defaults to `~/.local/toolsenabled`, agents enabled, no optional tool cap (`unrestricted`), every described worker agent and audit disabled. The host command accepts `--prefix ABSOLUTE_SANDBOX_PATH`, `--tier guided|standard|unrestricted` and `--providers AGENT[,AGENT...]` (agent ids from `toolsenabled agents`). Fleet tools follow how you started your agent, minus role limits. `--tier` is optional: narrow Fleet’s own tools further; `standard` confines the surface to workspace tools and `guided` to reads. Worker provider selection does not restrict which installed CLIs `setup --add` registers. Provider sign-in remains the provider CLI's own flow.

Fresh installation refuses an existing Fleet setup or an unproven same-name registration before provisioning or changing setup. This also applies after uninstall when the old setup state was kept; use a fresh scope for a new setup. To replace an existing runtime while preserving its setup, use upgrade. Qualified Codex inspection uses CLI **0.158.0**. Claude **2.1.284** freshness support is deliberately conservative: the selected profile must be empty or absent, and the default USER-store/backup names must be absent. The helper does not read Claude configuration or credential contents and does not call Claude `mcp get` or `list`, which can start servers. Existing Claude stores require a separately reviewed route; no blind removal is performed to establish freshness.

Runtime upgrades take an absolute archive and its independently published release digest:

```text
toolsenabled upgrade --archive /absolute/path/toolsenabled-openshell-1.9.1-linux-x64.tar.gz --sha256 RELEASE_SHA256
```

Before upgrading, stop active agent sessions and Fleet tree hosts that use this installation. Restart them only after upgrade commits or reviewed recovery finishes. A process left running across the generation swap can load modules from different versions or fail while loading them.

The release host command also accepts `--upgrade` for older runtimes. Upgrade preserves state, registrations and setup choices. Every runtime entry must match a pinned release inventory and the exact generated wrappers; unrelated files or unsafe paths refuse replacement. The old generation remains until the new one is verified and committed. Earlier supported manual runtimes, including the published beta 3 release, have pinned legacy inventories. The release host command can upgrade these without a second archive. An arbitrary manifest or copied ownership receipt does not establish ownership.

For a generation outside that fixed legacy catalog, also supply `--previous-archive ABSOLUTE_PREVIOUS_ARCHIVE --previous-sha256 PREVIOUS_RELEASE_SHA256` to the local upgrade command. Keep each uploaded release archive and its independently published digest; the runtime receipt alone is not deletion authority.

All participating setup, model, settings and lifecycle writers share one fixed per-user lock across prefixes and profiles. A partial setup or uncertain interruption keeps a durable recovery barrier, the runtime and its evidence. Do not delete that barrier or blindly rerun setup. Runtime transaction recovery uses the exact staged command printed on failure; it rechecks identities and never automatically replays a partial setup. If a committed old generation gains unknown contents, cleanup retains it and reports the remainder. Recovery accepts the printed intended journal path even if preparation stopped before creating that journal. After proving the active runtime unchanged, it can clear the preparation barrier while retaining partial or unknown preparation files; `PREPARATION_RETAINED` exits nonzero and does not claim cleanup succeeded.

Use `toolsenabled --version` to see the installed version and source. To remove a 1.9.1 runtime while keeping state, supply its original archive and independently published digest:

```sh
toolsenabled uninstall --keep-state --archive /absolute/path/toolsenabled-openshell-1.9.1-linux-x64.tar.gz --sha256 RELEASE_SHA256
```

Uninstall verifies the entire installed tree against that archive plus exact generated files before changing registrations. It retains ancestor, runtime and subdirectory handles through registration removal and deletes through those handles only while the complete inventory and identities remain valid. Unknown files, changed paths, protected roots, mounts or copied ownership receipts refuse removal. Partial provider removal, interruption or incomplete filesystem cleanup keeps a durable barrier and the runtime or remainder; preserve that evidence for review. State purge remains unimplemented: answering yes to plain uninstall refuses before mutation.

The helper can also remove supported earlier manual runtimes using its fixed release catalog. Run it from a verified extracted package outside the old runtime: `/usr/bin/python3 -B ABSOLUTE_VERIFIED_PACKAGE/fleet_uninstall.py --prefix ABSOLUTE_OLD_PREFIX --keep-state`. Other generations require the explicit archive/digest pair above, also accepted by the helper. Running an old runtime's own uninstall command does not acquire these protections.

Before either registration is removed, Codex **0.158.0** metadata must prove absence or show the canonical Node command and exact server argument for this runtime in the selected profile. Unknown versions, metadata formats, extra arguments or a different target refuse both removals. A distinct `.codex/config.toml` in the working HOME or its ancestors also refuses, because trusted project metadata can shadow the selected global profile. Only path metadata is checked; configuration contents are not read. The Node executable must resolve to the one running uninstall; changing it requires resolving the registration manually first. Claude removal succeeds only on a verified remove or version-qualified absence; **a Claude registration pointing to a different install could be removed by name**. Unavailable CLIs require sealed setup history for this exact installation and profile. Claude config files are not parsed and its connecting `mcp get/list` commands are not used. Other profiles and shadowing Claude registrations are outside this guarantee. All lifecycle operations require a trusted, quiescent target; they cannot prevent unrelated same-user programs from changing files concurrently.

For a new shell, source the installed prefix's `env.sh`. A verified stage is removed only after success and complete ownership verification. The uploaded archive remains available for recovery; failure messages identify retained stages and journals.

## Build a runtime archive

From a clean, committed checkout of this branch, with Node.js on the build machine:

```bash
bash installer/openshell/build.sh
```

This packages the exact files in `SOURCE-ALLOWLIST` from the committed tree. Output is the archive and `SHA256SUMS` in `dist/openshell/`. The build does not copy the build machine's Node installation, npm installation, global packages, untracked files or credentials. `manifest.json` records the source commit and runtime requirements.

The builder pins umask 077 before staging. OpenShell archive directories are 0700 and ordinary files are 0600; its `install.sh` is 0755. In the host archive, `install.sh`, the `toolsenabled` wrapper and the runtime CLI entry files are 0700 executables. The archive bytes must match under caller umasks 0002, 0022 and 0077.

After the archive freeze, the publisher runs `installer/openshell/render-fleet-fetch.py` with the literal archive/source/version/release pins and target choices. It emits a separately published `fleet-fetch.py`, the complete `host-command.txt` and a hash receipt. The helper is outside the archive to avoid circular hashing. Rendering is offline; it does not qualify upload or installation.

The older `adapters/openshell/image/` recipe is an optional development image build, separate from this release installer.

### Public source and archive identity

The 1.9.1 release is published on toolsenabled.ai with its archive checksums. Public source will follow on GitHub with a public source commit and `MAPPING-RECEIPT.json`. The receipt maps the reviewed development commit and archive hashes to the public source commit and its rebuilt archive hashes. The two archive builds differ only in `manifest.source_commit`. The builder embeds the checkout commit and timestamp, so use the exact published asset and checksum when testing this release. Fleet upgrades from the earlier beta 3 (version 1.4.2) are supported.

The build script uses the committed file list and source timestamp for archive entries. Compare archive files to the source commit named in `manifest.json` and consult `MAPPING-RECEIPT.json` when the public source release is available for the reviewed-to-public source mapping.

## Validation and scope

The archive is checked with installation and refusal tests, a content audit, and MCP initialization in an OpenShell sandbox. Release qualification also runs the frozen hand tests and continuous soak on the exact candidate archive. OpenShell process cleanup includes a fallback for sandboxes where `pidfd_open` is unavailable.

The MIT license, NOTICE, and third-party dependency notices are included in the runtime.
