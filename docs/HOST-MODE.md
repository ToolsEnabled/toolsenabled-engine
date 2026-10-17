# ToolsEnabled Fleet host mode

Host mode adds an explicit Linux x86_64 / WSL 2 entry for people who already use an agent CLI. It uses the same Fleet MCP broker, durable task and memory stores, inherited permission levels, and byte-mediated file tools as the OpenShell edition. Host mode is included in Fleet 1.9.1, published on [toolsenabled.ai](https://toolsenabled.ai). Consult the release for its exact archive and real CLI qualification results.

For Gemini CLI, use your own Gemini API key, Vertex AI, or a Gemini Code Assist Standard or Enterprise sign-in in `gemini`. Google ended Login with Google for individual plans in Gemini CLI on 2026-06-18.

## Boundaries and defaults

Host workers run as your operating-system user. Fleet reads how you started your lead agent: level 1 reads, level 2 asks, level 3 edits on its own, and level 4 allows everything. Unknown leads use level 2. Each worker inherits that level, lowered by its role and every ancestor. Fleet refuses a worker when its CLI cannot enforce the inherited limits. Your agent’s own settings sources stay in force, and Fleet adds no permission grants.

The separate `installer/host/install.sh --host` entry and `bin/toolsenabled-host.js` runtime select the mode explicitly. The installed terminal wrapper is named `toolsenabled`. A missing OpenShell marker never selects host mode. The host entry refuses `OPENSHELL_SANDBOX=1`; the existing OpenShell installer and its inside-sandbox refusal are unchanged. Host configuration uses the distinct MCP name `toolsenabled-fleet-host`, so it does not replace an existing OpenShell registration.

Workers are **experimental** and off by default. `--enable-workers` remains an explicit installation choice. Headless workers cannot display approval prompts, so requests that would need approval are declined. Reports explain these denials. Workers use the person’s existing CLI environment and settings; Fleet never signs in or reads sign-in files. Concurrent CLI token refresh remains unqualified.

Agent CLI workers and saved `model-NAME` connections share Fleet's tree and lifecycle machinery. They use a private local Unix socket for tree coordination and add no TCP or HTTP listener. The client-facing MCP transport remains stdio. Direct model workers use the same private tree link, inherited roles and levels, and may spawn model workers of their own. They support Chat Completions, Responses and Anthropic Messages, including already running local servers. At level 1 they receive only Fleet tools with read effects. Save a connection using `toolsenabled worker add` or `toolsenabled agents add DISCOVERED_ID --model ID [--name NAME]`, then select `tier: "model-NAME"` with `surface: "tree"` in `agent.spawn`. Host API connections read only the explicitly named environment key at request time. Standalone `worker run` retains its separate shim and leaves the tree off. See [GENERIC-WORKERS.md](GENERIC-WORKERS.md) for authentication and limits.

Worker tree records remain under the configured state directory. Unix worker sockets use a short per-user runtime directory instead: `$XDG_RUNTIME_DIR/tef/<short-hash>/` when that directory is direct, owned by the account and mode 0700; otherwise `/tmp/tef-<uid>/<short-hash>/`. Fleet creates the selected child directories mode 0700, checks their owners and modes, and refuses links or occupied socket names. A long account home or plugin state path does not prevent setup. Each root startup chooses a fresh random socket name; the socket path stays under the Linux 100-byte limit. `TMPDIR` does not select the socket location.

## Prerequisites

- Linux x86_64, including the Linux filesystem inside WSL 2. Native Windows is not supported by this installer.
- Node.js 22.19.0 or newer and Python 3.11 or newer (`tomllib` validates Codex configuration).
- Experimental workers additionally require Linux 5.3+ with usable `pidfd_open`, process observation/signalling, and subreaper support. A container or seccomp policy can block these on a newer kernel. Enable and startup checks refuse with `LINUX_PROCESS_NATIVE_UNAVAILABLE` when containment is unavailable. There is no weaker containment fallback; keep workers off on such systems.
- Workers need an agent CLI installed separately on PATH or a saved direct model connection. Bundled descriptors cover Claude Code, Codex, Gemini CLI, and OpenCode; setup detects the installed CLIs. For an all-model plugin tree, set up Fleet without workers, save the connections, then enable workers. `--providers` accepts connection names and `--models` accepts their `model-NAME` tiers. Setup never installs providers, signs in, starts a model turn, or reads auth files.
- A workspace inside the operating-system account home reported by the passwd record (`os.userInfo().homedir`), outside its top-level dot folders such as `~/.config` and `~/.ssh`. For a global setup, the workspace may be the account home itself: Fleet's file tools then reach every folder in the home except its hidden top-level entries (dot folders and dotfiles such as `~/.ssh`, `~/.config`, `~/.claude` and `~/.bashrc`), which are never inside a workspace, and workers start in the folder the lead works in. Keep the release archive outside the workspace too, for a global setup outside the home folder or in a hidden folder such as `~/.cache`: install and uninstall refuse runtime, state, workspace and archive paths that overlap. Symbolic-link aliases are refused. Overriding `HOME` does not move this boundary. Use the Linux home filesystem in WSL 2.
- Close all agent sessions, editors, and other processes that write the selected provider configuration before setup or uninstall. Keep them closed until the command finishes or recovery is complete. Fleet's configuration lock coordinates Fleet operations only; it cannot lock out an ordinary editor or a provider CLI.

## Download, verify, and install

Obtain the reviewed `toolsenabled-host-1.9.1-linux-x64.tar.gz` for 1.9.1 and its SHA-256 from the release channel. Verify the checksum using an independently obtained release digest before extracting or executing any package code. `SHA256SUMS` fetched alongside an archive detects corruption; authenticate the expected digest through the release channel too.

```bash
# Replace both values with the chosen release's absolute path and digest.
archive=/absolute/path/toolsenabled-host-1.9.1-linux-x64.tar.gz
release_sha256=REPLACE_WITH_APPROVED_64_CHARACTER_SHA256
printf '%s  %s\n' "$release_sha256" "$archive" | sha256sum -c -
umask 077
stage=$(mktemp -d)
tar -xzf "$archive" -C "$stage"
bash "$stage/toolsenabled-installer/install.sh" --host \
  --archive "$archive" --sha256 "$release_sha256"
```

That one setup command verifies the archive and its private extraction again, creates the separate runtime, initializes shared state, and registers each installed CLI. Restart CLI sessions to load the new MCP entry. The installer is offline; it does not fetch dependencies or edit shell startup files.

The Claude Code plugin uses a separate explicit setup path from its vendored runtime. Its `/fleet setup` command confirms the current project, then invokes `toolsenabled-host.js setup --plugin --workspace ABSOLUTE_PROJECT --enable-workers`. That command detects installed agent CLIs, writes the private `host-mode.json` and sealed permission record for the plugin's own runtime, and does not register another MCP server in either CLI configuration. When a plugin update moves the vendored runtime, Fleet asks for `/fleet setup` again before serving tools; the prior state is retained.

Optional installation arguments are `--prefix ABS`, `--state-root ABS`, `--workspace ABS`, `--tier unrestricted|standard|guided`, and `--enable-workers`. Fleet tools follow how you started your agent, minus role limits. Level 1 offers read tools, levels 2 and 3 offer workspace tools, and level 4 offers the full available surface. `--tier` is optional: narrow Fleet’s own tools further. The default `unrestricted` adds no cap; existing `guided` and `standard` choices remain caps. The MCP surface is still explicitly restricted to host Fleet tools; OpenShell policy tools are excluded.

Host file reads, writes and patches are confined to the sealed setup workspace at every tier. Fleet refuses known credential stores on reads, and known executable control paths on writes, including VCS hooks and configuration, editor and task-runner automation, shell startup files, `.envrc`, and directories on the host process's `PATH`. Keep secrets outside the workspace and review the files a worker can access there. Host workers still run as your operating-system user, so choose their native CLI permissions and provider endpoints accordingly. An optional `standard` cap confines Fleet tools to workspace operations; `guided` limits them to reads. Neither cap changes native CLI permissions.

Defaults:

| Purpose | Location |
| --- | --- |
| Immutable runtime package | `~/.local/toolsenabled-host/toolsenabled-installer/` |
| Terminal command | `~/.local/toolsenabled-host/toolsenabled-installer/toolsenabled` |
| Private state container | `~/.toolsenabled-host/` |
| Work record and memory | `~/.toolsenabled-host/capability/` |
| Setup and settings | `~/.toolsenabled-host/services/` |
| Optional worker tree records | `~/.toolsenabled-host/workers/` |
| Workspace | `~/work` |

Use the installed command by its full path for `status`, `ledger`, `settings`, and `tree`; setup does not add it to PATH. With a custom state location, add `--state-root ABS`. `setup --add` connects every installed described agent through its own registration method. Missing agents are skipped with a note. `setup --print-server-json` prints the exact nonsecret server entry for any MCP client, without initializing or changing state. With a custom state location, include `--state-root ABS` in either command. A person-added descriptor goes under the Fleet capability state root's `agents/` directory.

`status` reports each described agent's sign-in state using its own status command, alongside Fleet registration information. It labels unknown state explicitly and never opens a sign-in file. Registration adds no permission grants. Status shows the optional Fleet tool cap; each server detects its session’s level at startup.

Fleet asks each lead to pass its profile folders to Fleet so workers use the same profiles. Codex and Gemini CLI do not pass API keys or tokens to MCP servers unless you allow them. To let workers use a key from your environment, run `toolsenabled setup --add --pass-env NAME[,NAME...]`. The standalone installer also accepts `install.sh --host --pass-env NAME[,NAME...]`. Fleet records names only; the agent forwards values at runtime. Setup keeps the recorded names on reruns; `--pass-env ""` clears them. `toolsenabled status` shows the names.


## Audit on headless hosts

Audit signatures and actor attribution work without a desktop login keyring. Host mode uses the operating-system key store when available; otherwise Fleet generates its own audit signing key and head checkpoint under `STATE_ROOT/capability/audit-keys/`. Only these Fleet audit records use the fallback. It does not store provider credentials or change CLI sign-in.

Collection follows the saved audit settings and defaults off. To collect successful tool calls with actor attribution, choose these settings using the installed terminal command (add `--state-root ABS` for a custom state location):

```bash
~/.local/toolsenabled-host/toolsenabled settings set audit.enabled true
~/.local/toolsenabled-host/toolsenabled settings set audit.activity Full
```

The fallback directory is 0700 and its files are 0600. Key contents are never included in status or logs. `system.status` reports `audit.keyStore.kind` (`private-file` or `os-keyring` once selected), `workspace`, and `host.workers.experimental`. **Same-user processes can read the file key; it is not tamper-proof against agents running as you.** This retains actor attribution and signed consistency checks without claiming an operating-system security boundary.

Ledger changes typed at the terminal (`ledger answer`, `decline`, `done`, `remove`, `add` and `ledger apply`) first write a signed `ledger.apply.intent` event with the actor `owner-claimed`, and are refused if that event cannot be written. The event records who acted only as far as the local user account is trusted: any process running as you can create an identical event that verifies.

The selected store remains stable across restarts. Fleet refuses to generate a replacement identity for existing signed history if its key becomes unavailable. Keep the audit key and checkpoint with the retained state; do not delete them to clear an error. A genuine `AUDIT_SIGNING_KEY_UNAVAILABLE` failure requires repair and is non-retryable. Inspect `system.status`, `audit.status` and the reported store rather than repeatedly retrying writes.

## Claude Code worker permissions

A Claude Code worker below level 4 asks before any tool its settings do not already allow, and a worker cannot show you the question, so it is declined. To let such workers use Fleet's tools, add user-level allow rules for exactly the tools you intend. Project allow rules can be ignored in an untrusted workspace, and a headless worker cannot present the trust dialog. Read the denial report, then add only the exact tools you intend to permit. Claude Code's deny and ask rules still take precedence. [Claude Code permission rules](https://code.claude.com/docs/en/permissions)

In your own interactive Claude Code session, use `/permissions` to inspect the rules and their sources. Merge the selected rules into your user settings, normally `~/.claude/settings.json`, or `settings.json` inside your chosen `CLAUDE_CONFIG_DIR`. Preserve existing settings and rules. This example grants only the reported task-list tool:

```json
{
  "permissions": {
    "allow": ["mcp__toolsenabled-fleet-host__task_list"]
  }
}
```

Use the exact name in your worker's report and restart or resume the worker after your change. Fleet never creates these grants. [Claude Code settings](https://code.claude.com/docs/en/settings)

## Windows agents through WSL

Host mode runs inside a WSL 2 distribution. A Windows agent can use it by starting Fleet through `wsl.exe` in its MCP entry (`setup --print-server-json` inside WSL prints the Linux command to wrap). Two things differ from a lead that runs inside WSL:

- Fleet reads a lead's permission level from the lead's own command line, and a Windows process is not visible from inside WSL. Such a lead counts as level 2: workers decline anything that would ask.
- Workers sign in from the agent profile Fleet's server sees. To use the Windows Codex profile, name it in the entry's environment, for example `CODEX_HOME=/mnt/c/Users/NAME/.codex`, and give Codex a Linux folder for its database with `CODEX_SQLITE_HOME`. Fleet forwards both to Codex workers and their own Fleet servers. Fleet never copies a sign-in.

## Configuration ownership

The verified Python installer updates the selected MCP configuration through its existing transaction writer, using the same validated descriptors as terminal setup. Terminal `setup --add` runs descriptor argv commands, or the described MCP config writer, and retains failures for review. The installer edits one described JSON MCP member or one delimited TOML MCP table. It supports the bundled Claude Code, Codex, Gemini CLI, and OpenCode configuration formats and preserves the existing recovery transaction checks. Existing Fleet-name collisions refuse. Unrelated byte spans and settings are checked for preservation. When Fleet created the configuration file, uninstall can leave an empty `config.toml` or a Claude file containing `{"mcpServers":{}}`.

Removal verifies that the current Fleet entry matches the recorded command and arguments. A changed entry is retained and reported. Registration does not use connecting inspection commands such as `mcp list` or `mcp get`. No daemon feature flags, other servers, project configs, approval settings, or model settings are selected by host setup.

Configuration and state operations refuse symbolic links, hard-linked regular files, and unsafe parent ownership or permissions. New state directories are 0700 and files 0600, regardless of the calling shell's umask. The runtime sets umask 077 before loading state modules, and rejects preexisting unsafe state rather than silently changing its permissions.

Host installation and removal accept a runtime prefix beneath a shared ancestor mount, including the shared `/` mount common on systemd hosts. A mount at the runtime prefix itself or anywhere inside it still refuses. This policy is selected explicitly by the host installer; environment variables, archive metadata and receipts cannot enable it for the OpenShell installer, which keeps its stricter ancestor policy.

New provider configuration files are 0600. Replacing an existing file preserves its safe mode, owner and group. Read-only files and unsupported access metadata are refused before mutation; Fleet does not add write permission or discard access controls. Configuration transactions are serialized by the selected configuration's identity, independently of the Fleet state root. These protections still require the closed-writer prerequisite above; they are not an atomic compare-and-swap contract with other applications.

Each selected configuration has a persistent, empty 0600 `.fleet-host-lock-*` file beside it. The stable lock inode is retained after uninstall so different Fleet installations use the same lock. A transaction uses a private 0700 `.fleet-host-tx-*` directory beside the configuration. Existing-file commits use Linux `renameat2` exchange to retain the generation actually displaced; new-file commits refuse if a destination appears. The directory contains configuration data during recovery and must remain private.

## Uninstall and failure handling

Keep the approved archive and digest. Run uninstall from a fresh private extraction of that same archive, outside the installed runtime:

```bash
bash "$stage/toolsenabled-installer/install.sh" --uninstall \
  --archive "$archive" --sha256 "$release_sha256"
```

Repeat the original `--prefix`, `--state-root`, and `--workspace` arguments if customized. Uninstall removes only this installation's matching CLI entries and the independently verified runtime package. All shared state remains. There is no state deletion option and no automatic edition migration.

The shared `fleet_fs.py` verifier retains no-follow directory descriptors and checks the complete pinned archive inventory before provider removal. Unknown files, changed bytes or modes, hard links, ancestor substitutions, protected-path overlap, and mount hazards refuse cleanup. The receipt in state records identities and progress; the independent archive determines which filesystem entries may be deleted. As with the bounded edition, safe mutation assumes the target is quiescent; POSIX does not provide an inode-conditional unlink against a hostile writer running as the same user.

If setup or registration fails, runtime and a nonsecret `install-receipt.json` remain for inspection. The receipt records pending operations before configuration mutation, so a failure is never represented as success. Provider configuration contents are never copied into the lifecycle receipt or diagnostics. The verified uninstall path can remove a fully materialized runtime after a partial registration failure. An interrupted extraction or deletion retains the remaining files and requires inspection; there is no broad recursive cleanup fallback.

Configuration commit failures attempt conditional rollback after checking the current and retained generations. If a newer or unproven generation is detected, Fleet retains recovery material and refuses further configuration mutation. Keep all configuration writers closed. Do not delete the transaction directory or copy its saved file over the live configuration. Review the reported state and retained generations before retrying.

For reviewed recovery, use `host_registration.recover(record)` from the verified staging package. Reconstruct `record` from the original selected provider profile, runtime command, state arguments and protected roots, and compare it with the lifecycle receipt as uninstall does; do not take a configuration path from a recovery journal. The helper locks that exact configuration and restores or finalizes only a recognized transaction state. A verified empty transaction directory left after journal removal can be removed without touching configuration. A changed live file, incomplete nonempty preparation, missing journal with retained files, or unknown recovery entry requires inspection; the helper refuses to guess. After resolving recovery, inspect registration and use the verified uninstall to remove an incomplete installation while retaining shared state.

The host installer defers SIGINT, SIGTERM and SIGHUP until a lifecycle operation has written its stable receipt. If interrupted, inspect `install-receipt.json` in the private state directory before retrying. A `materializing` receipt means extraction did not reach a verified runtime: retain the receipt, prefix and archive for review; do not run the prefix or delete it by pathname. A `removal-pending` receipt with the prefix still present can be retried with the same pinned archive and provider profiles after configuration recovery. A `cleanup-pending` receipt with a missing prefix is finalized as `uninstalled` only after both selected registrations are proven absent. If the prefix is missing at `removal-pending`, or a partial runtime remains at `materializing`, preserve the evidence for reviewed repair rather than guessing which files to remove.

The closed-writer requirement also applies during rollback and cleanup. POSIX checks followed by exchange cannot exclude another writer in the final syscall window. If such a race is detected, retained generations are evidence for recovery; they do not establish an atomic transaction with that writer. Never interpret a recovery refusal as permission to discard a newer file.

## Shared source and packaging

`installer/host/build.sh` packages the committed `installer/openshell/SOURCE-ALLOWLIST` Fleet runtime with the host lifecycle/registration helpers and shared filesystem verifier. It emits `dist/host/toolsenabled-host-1.9.1-linux-x64.tar.gz` and `SHA256SUMS`; the manifest records `mode: host`, source commit and runtime requirements. The current runtime has no production npm dependencies. Provider CLIs and npm/Node toolchains are excluded. Every packaged directory is 0700 and every regular file is 0600 or executable 0700.

A fixture build proves layout and reproducibility; it does not qualify real provider behavior. Build and install/setup/uninstall require no package download.

## macOS feasibility

The Node stdio broker and most shared task/memory/file code can plausibly run on macOS. This release deliberately does not build or advertise that platform. The shared filesystem verifier currently requires Linux `O_PATH`, `/proc/self/mountinfo`, and descriptor operations. A macOS edition needs equivalent reviewed filesystem and mount safety, platform-qualified process cleanup, separate archives for supported architectures, and real CLI qualification. Removing the platform check would not establish those guarantees.

## Host release qualification

1. Review source security at the bundle's exact commit, including private path handling, registration drift, worker permission defaults, and retained descriptor deletion.
2. Build the exact release archive from a clean committed checkout. Verify its manifest, all archive entries, absence of bundled provider/toolchains, independent digest, and a second reproducible build.
3. On a disposable ordinary Linux x86_64 account, download and verify that artifact, then run the single `--host` setup with Codex only, Claude only, and both CLIs. Repeat on WSL 2 using the Linux home filesystem. Record actual CLI/OS/Node/Python versions.
4. Close configuration writers. Preserve sentinel unrelated servers, settings, comments, modes, owner/group and project files; compare before and after setup/uninstall. Exercise custom profile paths and quoted/spaced prefixes. Verify same-name collisions, changed Fleet targets, read-only configurations and unsupported access metadata refuse. Exercise failed commits, conditional rollback, interrupted recovery, and two Fleet installations targeting the same configuration. Confirm newer edits survive recovery refusal.
5. Run real Codex and Claude turns using the frozen archive. Verify one can save memory/create a durable task and the other can read it. Exercise mediated reads, overlapping stale edits, disjoint edits, checkpoint/claim behavior, and terminal ledger/settings controls.
6. Confirm workers are absent and dispatch refuses in the default installation. In a separate explicit `--enable-workers` install, verify inherited levels and role removals on start and resume, preserved settings sources, and the corresponding denial reports. Check the optional tool caps separately from native CLI permissions. Check tree delegation and worker cleanup on EOF, stop and interruption.
7. Confirm no TCP/HTTP listener is introduced. Inspect 0700/0600 state with permissive shell umasks after actual tool calls and CLI restarts. Inspect both stdio MCP actor labels and shared state locations. On a headless account, verify the audit store report, signed Codex/Claude attribution, stable key identity after restart, private fallback modes, and refusal when signing cannot be established. Do not print private key material.
8. Exercise archive corruption, symlink/hardlink/state overlap/mounted-path refusals, partial provider failure, and runtime tampering. Uninstall the unchanged runtime, prove exact Fleet entry removal and retained memory/task state; verify other configurations survive. Review retained incomplete-operation behavior.
9. Re-run the unchanged OpenShell installer refusal outside a sandbox and its existing bounded installer gates. Host installation must not convert or mutate any OpenShell runtime, state or registration.
10. Exercise experimental worker enable/start on a normal pidfd-capable Linux/WSL 2 host and on a system blocking `pidfd_open`. The latter must report the native prerequisite and must not start a provider or select weaker containment. Complete an unmodified signed-in worker turn and verify native cleanup before removing the experimental label.

Publish only after these gates, real CLI qualification and security review. No host release is currently published.

Protocol/config references: [Codex MCP configuration](https://developers.openai.com/codex/mcp), [Claude Code MCP configuration and user scope](https://code.claude.com/docs/en/mcp).

Roles may also remove native `shell` (command execution) or `web` (fetch and search) tools. Custom roles inherit their base role’s removals and may add more. Every descendant keeps its ancestors’ removals. A CLI without a documented removal mechanism is refused for that category; direct model workers have no native tools, so these removals apply to the corresponding Fleet tools.
