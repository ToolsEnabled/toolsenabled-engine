# Gemini personal OAuth quota runtime

This is a quota-only build of the public exports of `@google/gemini-cli-core`
0.58.0. It is not a general SDK/CLI distribution. The two committed lockfiles
pin the public SDK input and esbuild 0.25.12; build scripts remain disabled.
No hashed CLI module name or private SDK import is a runtime entry point.

Install the inputs from this directory with `npm ci --ignore-scripts`, then
run `npm ci --ignore-scripts --prefix build-tools`. From the Engine root run
`npm run build:gemini-quota-runtime -- --out <new-output-directory>`. The
output directory must not already exist. A caller may pass `--out` to build into another empty, owned path before
publishing verified artifacts into `provider-runtimes/gemini-quota`.

The reviewed runtime artifacts are committed with byte-preserving Git
attributes. A fresh detached worktree or normal release source export already
contains every runtime byte; build, install and activation require no npm
operation, network access, ignored overlay or prototype checkout. The commands
above are only the reproducibility and explicitly reviewed SDK-upgrade path.

The build never updates its pins. Every output must match the committed
`config/gemini-quota-runtime.json` byte count and SHA256. Compiler output,
external google-auth-library dependencies, the required public policy asset,
extracted legal comments, and packaged notices are all pinned. An SDK upgrade
requires a separately reviewed lockfile, output and supported-storage review.
The App packer and current-payload verifier validate these same pins, refuse
undeclared files and links, and retain the ordinary project require-closure
and owner-data checks. There is no broad vendor/node_modules shipping rule.

`third-party-notices.json` records the reachable input packages, their locked
versions/integrities, declared license metadata, and root license/notice files
present in the installed public packages. Some upstream packages contain no
root notice file; that absence is recorded rather than fabricating a notice.
The emitted `sdk.mjs.LEGAL.txt` also preserves esbuild's extracted legal
comments. This manifest is provenance, not a public-release legal approval.

The worker admits only a registered personal OAuth home using the supported
plaintext `.gemini/oauth_creds.json` route. ADC/service-account/key/ambient
environment and encrypted storage modes are explicitly unsupported. No
credential is copied, migrated or returned. The public SDK refreshes as
needed, verifies cached tokens online, and supplies the quota request; it
does not force a refresh on every check. A fresh authenticated user-info
request provides identity evidence; a cached account label is not evidence.
An expected email must match before the account can serve or its allowance
can be used. A failed quota check alone does not establish expired sign-in.

The dedicated worker isolates logging before SDK import and disables browser,
interactive input, subprocesses, watchers, hooks, MCP, extensions, tools and
session generation. It calls only cached OAuth acquisition, user-info,
`loadCodeAssist` in `HEALTH_CHECK` mode, and `retrieveUserQuota` for the selected
existing project. It never onboards a project, accepts terms, enrolls an
account, prompts, generates a turn, or uses the CLI working directory.

Core 0.58.0 has no public plaintext OAuth storage injection. Inside this
worker only, a narrowly scoped wrapper fences the exact credential leaf and
the SDK's actual read/write/chmod calls. Reads are bounded and compare path
and opened-file generations. Refresh writes use an exclusive same-directory
temporary, sync/close, a final original-generation comparison, then atomic
rename. Observed replacement and precommit I/O failures preserve the old or
externally replaced file. This is not an OS compare-and-swap or a lock against
an unrelated writer racing between the final comparison and rename. A shared
sign-in mutation should cancel and drain an active checker first; App result
generation fencing separately rejects observations crossing a replacement.

A framed result does not terminate the process. The parent waits for natural
successful exit, including the SDK's asynchronous refresh persistence, then
the shared Windows Job/Linux process-control closure receipt. Timeout,
cancel, output overflow, malformed frames and unproven cleanup cannot yield
an accepted measurement. Retained cleanup custody is propagated unchanged.

The canonical `allowanceBuckets` schema reports each model/token scope and
exact decimal amounts. It does not invent hourly/weekly windows, aggregate
percentages, exhausted-account verdicts, or cross-account ranking from these
buckets. Unknown values remain unknown.

Tests use disposable synthetic homes and a real pinned SDK with intercepted
transport. The preload fixture blocks all real network traffic and records
only synthetic operations. These tests prove parser, storage, protocol and
lifetime behavior; they do not prove availability for a real owner's account.
The native SDK fixture requires the generated runtime and fails if it is
missing. It does not silently skip that prerequisite.
