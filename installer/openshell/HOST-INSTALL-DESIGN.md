# Beta 3 two-command installer design — accepted design, implementation pending

2026-09-30, revision 5 with review followup. Design only. Coordinator09:51:07 moved this flow and descriptor-bound traversal to beta3; beta2/candidate8 keeps the existing install steps. Codex review at7ee7059 returned SOUND TO BUILD at09:55:12 under the09:48:07 trusted-target model. The one low timeout-classification finding is corrected below. Implement only after candidate8 is cut, as directed. This preserves the ownership/locking/journal/honesty contract under the deferred B2.2 feature entry. The published lifecycle quick fixes are narrower and do not implement this design.

## Accepted threat model

**Install only into a sandbox you trust.** The target sandbox's own user environment, login profiles, BASH_ENV and shell are inside the trust boundary. Fleet cannot protect installation into an already-compromised sandbox; the manual flow runs in that same user environment. OpenShell's tar-over-SSH upload is acceptable under this model. Reverification inside the sandbox catches accidents/corruption; it is not a defense against a compromised target.

The host helper must verify bytes before upload; never execute, eval or use sandbox-returned data as authority for any host-side decision; never change policy/providers or require root; explicitly route to and display an unambiguous existing gateway/sandbox; upload only the verified archive to a fresh path with a cryptographically random suffix; and print the expected SHA-256 for the user's sandbox-side verification. Parse only the bounded expected control-plane metadata needed to identify the target, not command output from the sandbox. Treat all transfer output as untrusted diagnostic text, bound it and escape controls; it never supplies a command, host path, checksum, retry destination or success proof for the installed product.

A fresh random path prevents accidental clobber with negligible collision probability; it is not an atomic exclusive-create or malicious-sandbox defense. Target lookup is explicit and checked again immediately before upload; no atomic immutable-target-ID guarantee is claimed. The operator is responsible for a trusted target and control plane. The local ownership/locking/journal safeguards below still protect against accidental deletion, conflicting operations and incomplete upgrades.

The one-command host-exec path remains deferred for beta2 on time grounds and may be revisited in beta3 under this same threat model. There is no remaining stock0.1.2 upload-startup blocker under this accepted model; implementation and review are still required.

## Scope

The intended beta3 flow has two user commands:

1. On an ordinary Linux/WSL host, a release-specific `fleet-fetch` downloads and verifies one pinned archive, uploads only that archive to one explicitly named existing OpenShell sandbox, and prints the complete sandbox command.
2. In their own Bash sandbox shell, the user runs that command to reverify/extract/install the runtime, run setup and status, write the PATH hook, and source it into that shell.

No host `sandbox exec`, sandbox creation/start, policy/provider changes, bundled prerequisites, root requirement, sign-in or model calls. Native Windows/macOS hosts are outside this design's claim. Upgrade and uninstall execute only from the user's sandbox shell through `toolsenabled`, with explicit staged-driver exceptions for older runtimes and interruption recovery as specified below.

OpenShell v0.1.2 upload uses `sandbox_sync_up` and `ssh_tar_upload` to run a remote mkdir/cat/tar command through the supervisor's default login shell; `-T` only disables the TTY. We retain this source fact and make no shell-free claim. It is accepted under the threat model above. References: [upload implementation](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-cli/src/ssh.rs), [supervisor dispatch](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-supervisor-process/src/ssh.rs), channel `release/BETA2-UPLOAD-TRANSPORT-REVIEW.md`. No live reproduction is claimed.

## Interfaces and context

After verifying the separate release helper, the host command is:

```text
fleet-fetch --gateway NAME --sandbox NAME [--workspace NAME]
            [--prefix ABSOLUTE_SANDBOX_PATH]
            [--tier unrestricted|standard|guided]
            [--providers codex,claude|codex|claude]
            [--upgrade]
```

Gateway and sandbox are mandatory. Workspace means OpenShell namespace and defaults to the literal `default`, passed on every call. Names/options are bounded; reject leading options, controls, repetitions, unknown flags and missing values before I/O. Paths with spaces remain separate arguments; no input is a shell fragment. The default prefix is resolved in the user's sandbox context as `$HOME/.local/toolsenabled`, never from host HOME. `--tier` and `--providers` apply only to a fresh install; refuse them with `--upgrade`.

Fresh installation explicitly displays agents on, providers codex,claude and tier unrestricted unless overridden. At least one selected provider CLI must be installed; an explicitly selected single provider requires that CLI. Existing `--providers` controls workers, while `--add` registers every installed supported CLI; say so. Do not enable audit implicitly. The default working folder is the existing setup default. No profile credentials or host HOME/CODEX_HOME/CLAUDE_CONFIG_DIR/environment are forwarded.

Local commands proposed within this reviewed scope:

```text
# Extracted, verified release entry, called by the printed sandbox command:
bash PRIVATE_STAGE/toolsenabled-installer/install.sh --setup [ABSOLUTE_PREFIX]
     --tier TIER --providers PROVIDERS

# Existing verified runtime, executed by the person inside the sandbox:
toolsenabled upgrade --archive ABSOLUTE_ARCHIVE --sha256 PINNED_SHA256
toolsenabled uninstall [--keep-state]

# Recovery through the independently verified driver outside PREFIX:
bash PRIVATE_STAGE/toolsenabled-installer/install.sh --recover ABSOLUTE_JOURNAL
```

The upgrade digest must come from the trusted release command, not an adjacent untrusted checksum file. The printed `--upgrade` flow may invoke the newly verified staged lifecycle with an explicit target to support an older installed CLI that lacks `upgrade`; it never executes the older runtime merely because its manifest claims a known source/version. No host-side uninstall command. The recommended local removal command is `toolsenabled uninstall --keep-state`. Preserve the existing local plain-uninstall prompt: state purge is not implemented by this design, so affirmative deletion of existing state refuses before any mutation and explains `--keep-state`. The former host-uninstall default no longer describes a shipped command.

## Release integrity and host transfer

Publish a separate release-specific helper rendered after the archive freeze, embedding literal release tag, archive basename, SHA-256, source commit, version and size ceiling. Keeping it outside the archive avoids circular hashing. The published bootstrap creates private host temporary storage, downloads that fixed helper, verifies its literal independently published hash, then executes it. Never execute a download stream. Review/test the actual generated command with real pins and argument quoting; placeholders are not a usable release command.

Bootstrap and helper use `curl -q` as the first option, fixed public HTTPS URLs, HTTPS-only redirects, HTTP failure handling, connect/overall deadlines and bounded retries. Independently bound helper/checksum/archive bytes even without Content-Length. No credentials, headers, arbitrary mirror, latest/branch URL, npm/source fallback or host environment forwarding. Fetch exact-release SHA256SUMS and require exactly one well-formed entry for the exact archive basename. Reject duplicates, path-bearing names and malformed digests. The entry must equal the embedded pin and actual archive bytes; never execute an untrusted checksum list with `sha256sum -c`.

Trust is relative to the reviewed published bootstrap hash. Compromise of both assets and that trusted command is outside this integrity guarantee; this is not a signing system and raw curl-pipe-shell is not equivalent. Source pins identify the build commit, not the separate public export commit.

Host preflight needs Bash, OpenShell, curl, sha256sum, mktemp and bounded process execution. Use umask077/private storage. Read only nonsecret gateway/sandbox metadata, clear inherited endpoint/insecure routing overrides, and pass explicit gateway/workspace/name. Verify and display resolved TLS endpoint, namespace, sandbox name/identity and Ready status before transfer; fail on missing tools/target/authentication or insecure/ambiguous routing. Repeat the metadata lookup immediately before upload and refuse a changed identity. This is a race-reduction check within the trusted control plane, not an atomic resource-version condition. Never select/change a gateway or fall back to the last-used sandbox. No exec-specific last-used-sandbox effects are claimed or relied on; any upload metadata side effects need separate acceptance evidence.

For the supported stock v0.1.2 transport, invoke `openshell … sandbox upload --no-git-ignore NAME LOCAL_ARCHIVE DESTINATION` using host arrays. Upload ONLY the already verified archive file. Generate at least128 random bits on the host for a new `/sandbox/.toolsenabled-fetch-<nonce>/` destination, outside runtime/state/protected profiles. Never reuse that destination after failure or uncertainty. OpenShell upload creates that directory through its documented remote shell path; no separate sandbox exec is used. Do not call it atomic exclusive creation or claim protection from a compromised sandbox. The only member transferred is the verified archive, with its fixed basename. No full folder, source tree, host configuration, credentials or helper script is uploaded.

Return success only after transfer completion; print the target, remote archive path, digest/source/version and the exact single sandbox command. No claim that setup, sign-in or a model turn has occurred. Download/upload limits are180s each, target metadata30s, host-owned cleanup20s. Report UPLOAD_OUTCOME_UNCERTAIN only when a transfer was attempted and its completion is unknown. Metadata/preflight/download/checksum failures before transfer retain their own TARGET, DOWNLOAD or INTEGRITY phase classification; a known transfer refusal is UPLOAD_FAILED. Do not delete a remote path or retry an uncertain upload into the same destination. Retain/report owned local evidence without exposing credentials.

## The one sandbox command

Uploading only an archive cannot make an extracted install.sh already exist. The printed command must therefore include the bootstrap extraction. It is one safely quoted compound command executed explicitly by the user in their chosen sandbox shell, not by the host helper or an uploaded unchecked script.

The printed command is supported in Bash; fish/dash/other caller shells are outside the current-shell PATH promise. Its fixed, reviewed bootstrap first verifies OPENSHELL_SANDBOX=1 without setting it; Linux x86_64; Node>=22.19; Python3 and required utilities. Rehash the uploaded archive against the literal pin before extracting or executing any member. Allocate an exclusively created private stage under a verified safe parent, validate the expected toolsenabled-installer root, bounded contents, types, paths and link targets, and extract without following unsafe links. Refuse traversal, devices, escaping links, duplicate/conflicting paths and corruption. Use existing Python capabilities, not an assumed new tarfile filter API. Extraction must not write outside the stage.

Then execute the verified staged installer with explicit selected arguments, run setup and status after installation, and source the newly verified prefix/env.sh in the SAME user shell only after success. `install.sh` running as a child cannot change its parent's PATH. The installer already writes env.sh; this is the PATH hook promised here. Do not edit `.bashrc`, `.profile` or another shell profile in this scope. The final concrete command is rendered/tested with the actual helper/archive; no illustrative nonexistent path is presented as executable.

Shell quoting must preserve spaces, quotes and dollar signs without interpolation as code. The driver reads path/choice arguments, never evals metadata/receipts/output. It runs the newly verified archive code by absolute path and validates installed bytes/source/version before setup or success. Report setup/status failures accurately and preserve repair evidence. Remove an owned stage only after confirmed completion and the ownership checks below; a failed or interrupted local command never triggers a blanket cleanup of /tmp or /sandbox.

## Local serialization and fresh setup

Use a single fixed private per-uid lifecycle mutex shared across HOME/profile/prefix selections; this conservatively serializes every mutable setup/profile scope and every prefix. Its reviewed namespace must be outside every replaceable/deletable root, with no-follow checks for owner/modes/parent, and stable across different shells/hosts reaching this sandbox. A kernel lock alone is not crash state: a private pending/uncertain operation record and per-prefix journal also gate reentry. Never steal an unresolved operation because its PID looks absent. No prefix-only or host-only lock.

All participating install, upgrade, uninstall and manual setup/configuration writers must use the same lock, including `toolsenabled model add/use/remove`, which write the selected Codex profile. Hold it from freshness/context/registration inspection through mutation and verification; revalidate canonical identities after acquisition. Reuse one in-process transaction context or a validated inherited lock handle to avoid nested reacquisition deadlocks. Ordinary read-only status need not acquire a mutation lock. Locks do not protect against unrelated same-uid writers or provider CLIs that do not participate; supported lifecycle operations require a trusted, quiescent target, and otherwise refuse or retain affected trees.

A new prefix is not a fresh setup scope. Before workspace provisioning, machine-record writes or registration changes, verify no prior machine record and no same-name CLI registrations in the selected profiles. Read machine records with adopt:false; invalid/ambiguous evidence refuses. Existing guided scopes must not be overwritten by default unrestricted setup. Resolve the actual services root rather than guessing it from a product basename. Capture the selected nonsecret uid, profiles, state/services, workspace, tier/provider choices and target identity in a private operation record.

After a partial setup failure, preserve runtime/state/journal and report SETUP/RECOVERY_REQUIRED with the original choices. Do not print a raw setup retry command: current setup overwrites records, and a replay could erase subsequent permission/registration changes. Automatic partial-setup recovery is outside this scope; any future retry must reacquire the same lock and compare recorded effects/current identities first. Do not roll back partial registration edits by guessing.

## Whole-tree ownership and local uninstall

Canonical paths, receipts, a familiar basename, manifest claims, authentic executable bytes and consent do not authorize deletion of arbitrary contents. Apply the same complete-tree, protected-overlap, mount, safe-parent and descriptor-bound rules to runtime removal, old-generation cleanup, rollback and staging cleanup. There is no manual-install exception.

Inventory EVERY entry without following links against an independently hash-pinned official archive payload plus exactly specified installer-generated wrappers/env.sh/manifest. Compare paths, types, bytes, link targets, ownership and root identity. Validate allowed private lifecycle receipts/journal entries separately against strict schemas and their recorded exclusive-creation identities. No extra files/directories/caches/provider profiles/mounted subtrees are silently accepted. A receipt cannot whitelist an arbitrary unexpected path. Pinned internal Node_modules symlinks may be unlinked but never traversed.

Reject root/home/protected ancestors and overlap in either direction with state/services, provider credentials/profiles, OpenShell config/state/TLS, lock namespace or another Fleet install. Check every ancestor/descendant for unsafe ownership, symlink substitution and mount/bind/shared subtrees, retaining the tree if proof is unavailable. Keep verified directory descriptors and compare entry identities during no-follow traversal; do not run pathname-only recursive rm after a separate preflight. Unknown entries encountered during cleanup are retained with an honest incomplete result, never erased to make cleanup look successful.

Use a narrow reviewed helper through the already required Python3 `dir_fd`/no-follow APIs for these filesystem operations; Node's pathname-only recursive removal does not establish this contract. No new toolchain is bundled. Capability checks and substitution tests are mandatory.

For a manual candidate7 runtime, a separately reviewed inventory/template tied to the independently pinned candidate7 archive can establish the complete expected tree; source/version strings alone cannot. If no such trusted inventory is available or the tree differs, refuse upgrade before renaming and uninstall before deregistration. Fresh installs create their private ownership records only after exclusive directory creation and payload verification; never retroactively mark an arbitrary existing directory as owned. No state ownership marker writer is added: all existing/manual state is retained; explicit purge refuses before any CLI/runtime mutation.

Before local uninstall mutates anything, inspect both selected CLI registrations without starting/connecting to any MCP server. Exact scope matters (Claude user, not a shadowing project/local entry); bind canonical command/argv to the target server, never a substring. Missing/unknown inspection capability or ambiguous context refuses the stronger installer lifecycle. Do not inspect credentials or print complete registration environments. A validated absent entry differs from a CLI that cannot be inspected. Accept only a documented version-specific absent result with exact scope, or a fresh nonconnecting post-removal inspection proving absence. Any unknown/nonzero removal error preserves runtime; broad 'not found' matching is forbidden. Qualified parser formats and versions are acceptance requirements, not already established by echo-only fixtures.

For staged operations on an older prefix, load the verified new lifecycle module by absolute path and pass the canonical locked `TARGET/runtime/engine/bin` as an explicit argument to its exported function; never use the stage's __dirname as the target and never execute the old CLI to establish trust. Stage and target must be disjoint. Lifecycle independently rechecks the handed-off target identity, inventory and context under the same lock. Test old target identity, spaces, incorrect manifest claims, and stage preservation.

## Upgrade commit and interruption recovery

The current install.sh replacement block cannot be reused unchanged: it removes its backup before helper validation. Under the lifecycle mutex, prepare a private sibling `PREFIX.transaction-<nonce>/` containing journal.json, new/ and later old/. Persist nonsecret paths, scope, nonce, inventory and phase. Fully validate new/, preserve and validate the ownership/registration-context receipt, then rename PREFIX to old/ and new/ to PREFIX. Retain old/ through full installed-byte and receipt validation. Persist COMMITTED only after those checks; this is the commit point. Then clean up only positively owned old/ and transaction entries with the same descriptor/identity rules.

PREPARED leaves the old active prefix; OLD_MOVED leaves PREFIX absent and old/ recoverable; NEW_ACTIVE leaves uncommitted PREFIX plus old/; COMMITTED leaves validated PREFIX plus an optional cleanup remainder. Record intent before renames and fsync the journal/affected directories as supported. Recovery checks actual exact identities, not just a phase that may lag a rename. Before commit, best-effort rollback restores old/ only when conflicting paths are absent or positively ours. Preserve conflicts and report exact paths. After commit, finish cleanup, never roll back the validated new runtime merely because old/ gained an unexpected entry. Report committed-with-cleanup-pending and retain that generation instead.

No setup, tier, provider, workspace, registration or state rewrite during runtime-only upgrade. A missing helper receipt does not itself forbid manual upgrade, but missing full-tree proof does. Two renames and an EXIT trap are not atomic replacement or crash recovery; no such claim. Reentry with an unresolved transaction refuses until a reviewed recovery path establishes the outcome.

Load/launch the independently verified staged driver outside PREFIX before the first rename; no lazy imports from the moving runtime. Retain that stage and the archive while an operation is unresolved. Recovery cannot depend on `PREFIX/bin/toolsenabled`, which is absent in OLD_MOVED. Print the exact quoted staged `install.sh --recover JOURNAL` command only after recording its verified archive/driver identity; if the stage was lost, require re-verification/extraction of the same pinned archive before recovery. Recovery reacquires the same mutex and reconciles the actual old/new/prefix identities before any action. This is runtime transaction recovery only, not automatic partial-setup replay.

## Required validation and release gates

Use scratch host/OpenShell metadata, sandbox HOME, profiles, state/services and prefixes only. Stubs must never fall through to real commands. Run focused tests through the isolated launcher; actual helper/archive tests are separate evidence. Every newly found product failure needs a preserved red check.

| Area | Required positive and negative evidence |
| --- | --- |
| Host bootstrap | Actual rendered pins; helper/archive mismatches, changed tag, duplicate/path checksum, truncated/chunked/oversized response, HTTP downgrade, hostile curlrc; no execution/upload after refusal |
| Routing/upload | Explicit target/TLS/name and repeated identity lookup; missing/not-ready target, auth failure, inherited overrides and changed identity refuse; fresh random destination on every attempt; ONLY archive uploaded; no sandbox exec CLI or policy/provider change |
| Upload startup | Reviewed tar-over-SSH/login-shell call chain accepted within trusted sandbox; untrusted returned bytes never execute or influence host paths, pins or routing; no hidden shell-free or compromised-sandbox protection claim |
| Printed command | Fresh target, spaces/quotes/dollar signs, exact remote hash, no host context forwarded, safe archive extraction, missing Node/Python/CLI, source/version mismatch, PATH available in caller after success without shell-profile edits |
| Fresh scope/locking | Two prefixes sharing any profile/state/services serialize; direct manual writer participates; guided/invalid/existing scope refuses before mutation; aliases, stale records and uncertain operation remain blocked |
| Ownership | Manual unrelated-data sentinel, nested state/provider/OpenShell/mounted roots, copied receipts, unexpected cache, symlink/parent/entry swaps; upgrade and keep-state uninstall refuse or retain as specified; no unowned deletion |
| Uninstall honesty | Exact nonconnecting scope/absence proof; sentinel MCP server never starts; shadowing, unavailable CLI, unknown format, dependency/config 'not found', signal/error or retained registration keep runtime; purge refuses before mutation |
| Upgrade/recovery | Candidate7 supported manual inventory and fresh install; state/registrations byte-identical; receipt preserved; failure/crash between every rename/journal/validation step; conflict retained; changed old/ retained after commit |
| Failure reporting | Stable TARGET, UPLOAD, SCOPE_BUSY, INTEGRITY, INSTALL, SETUP, DEREGISTER, STATE_OWNERSHIP_UNPROVEN, RECOVERY_REQUIRED and OUTCOME_UNCERTAIN; no automatic raw setup retry or false success |
| Exact acceptance | Exact generated helper/archive on claimed ordinary-user Linux/WSL hosts; no sudo/toolchain/model dependence; install/setup/status/PATH, upgrade, keep-state uninstall and purge refusal; actual timeout/upload behavior and cleanup |

Record helper/archive SHA, exact source, OpenShell version/transport capability evidence, terminal outcomes and all retained paths. Do not claim host compatibility from mocks, design approval, or prior candidate7 evidence. Coordinator owns network candidate builds, exact public source mapping and publication. Candidate8 must not switch the running candidate7 soak: use isolated candidate channels/qualification directories. This flow does not gate candidate8. Implement it after candidate8 is cut, then obtain implementation review and exact helper/archive qualification for beta3.
