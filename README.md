# ToolsEnabled

Seedance video tools are documented in [Video generation](docs/video-generation.md):
discover models, submit text/image jobs, recover receipts after restart, check
status, request cancellation, and save MP4 results on Windows and Linux.

ToolsEnabled is a local, API-first capability layer for any MCP-capable AI client:
Codex, Codex CLI, Claude, the Claude CLI, or another compatible host. It exposes one
portable stdio MCP server with authenticated provider adapters, transactional local state,
an encrypted Windows credential vault, audit logs, a dedicated browser profile, and
Windows Task Scheduler integration.

## Quick start

```powershell
.\install.ps1 -Phase 6
node tools/mcsetup.js run
npm test
npm run test:browser
node src/doctor.js
```

ToolsEnabled 1.4.0 requires Node.js 22.19.0 or newer because its transactional
state layer uses the built-in `node:sqlite` module.

Use `./install.ps1 -Phase 6 -InstallDependencies` to non-interactively install
missing Firebase CLI, Google Cloud SDK, and Terraform dependencies on this Windows
machine. Open a new terminal after it completes so updated PATH entries are loaded.

After installation, `node tools/mcsetup.js run` asks for a permission tier and a
workspace, records those choices, and generates that workspace's `.mcp.json` from
paths that exist on the current computer. The file is generated rather than shipped
because runtime and installation paths are machine-specific. The Claude CLI
(`claude`) discovers it when launched in that workspace.

Use `./install.ps1 -Phase 6 -RegisterClients` to register the two local servers with
Codex CLI.

The Claude CLI discovers the tier-appropriate ToolsEnabled servers from the generated
`.mcp.json`; Standard and Unrestricted also include Playwright. Gemini CLI discovers
its configured servers from `.gemini/settings.json`. For Codex, merge
`adapters/codex/config.toml.example` into its MCP configuration, replacing the path
if necessary; for a Gemini install outside this repository, merge
`adapters/gemini/settings.json.example` the same way. Any other MCP client can launch
`node src/mcp-server.js` from this directory.

## Subscription-CLI providers

Codex, Claude, and Gemini are reached through their installed CLIs and the
subscriptions already signed in on this Windows account. The provider gateway
(`src/lib/providers/cli-provider-gateway.js`) removes ambient provider API-key and
Vertex billing variables, invokes each CLI without a shell, and accepts only a
bounded text response. Claude's CLI tools are disabled, while Codex and Gemini run in
an empty temporary workspace under their read-only/plan restrictions and are
explicitly instructed not to invoke tools.

- Gemini requests expose a Gemini-only model selector derived at runtime from
  `config/model-floor.json`. The selector contains only the approved subscription
  models and its approved default; it is not a separately maintained routing list.
- A CLI provider is selectable only after its **On** toggle completes a live,
  text-only connection check. **Off** is immediate and prevents ToolsEnabled from
  starting that provider for new requests. A per-provider revision fence prevents a
  delayed cross-process enable or completion check from defeating a newer Off
  setting. Connection checks and requests obey the ToolsEnabled kill switch and write
  metadata-only audit events; prompt and response text are not written to those
  audit events.

Sign in through each provider's own CLI when needed: `codex login`,
`claude auth login`, or interactive `gemini` Google sign-in. ToolsEnabled does not
ask for, store, or use provider API keys, passwords, MFA codes, passkeys, or CAPTCHA
answers.

Gemini authentication state is verified only through the official Gemini `/about`
identity display, which must show the configured primary Google account. Process or
window titles and generic Google Account browser tabs are not authentication/OAuth
signals and must never be used to decide whether Gemini is ready.

### Durable tasks and the coordinator workflow

Durable work runs on the shared task queue (`task.*`): claim/start one bounded
phase, checkpoint safe progress, then record exactly one terminal outcome. A
truncation or malformed model reply is a continuation, never success; the
action guards refuse a terminal success recorded over a truncation sentinel.
Never place credentials or personal data in a task, checkpoint, or result.

The coordinator workflow library (`src/lib/coordinator-workflow/`) defines the
mission contract, trusted artifact snapshots, verification manifests, review
packets, and broker verification records; the durable state store keeps the
coordinator mission and workflow acceptance tables. The permanent
provider-neutral routing and review method is
`docs/coordinator-efficient-workflow.md`: one primary worker per phase, deterministic
checks before model review, no model-driven status polling, compact evidence
packets, and no architectural dependency on temporary provider credits.

Agent MCP mutations are transport-bound: the caller-supplied `actor` must match the
actor label in that client's generated environment (`codex`, `claude`, or
`gemini`). Each registration supplies only an actor label, never a credential. A
missing/mismatched binding rejects actor-bound mutations.

Codex registrations created by `install.ps1 -RegisterClients` launch the MCP server
directly with Node. Claude uses the workspace configuration generated by `mcsetup`,
and the shipped adapter files are mergeable examples for other clients. Already-running
clients keep the MCP command they loaded at startup, so restart a client after changing
its registration. ToolsEnabled does not kill it. The generated guided configuration
exposes only `toolsenabled-readonly` with no actor binding, so a generic project client
cannot accidentally gain a mutable agent identity.

### Dashboard (Agent Activity Visualizer)

A local browser dashboard at `http://127.0.0.1:3889` (start with
`tools\start-agent-activity-visualizer.ps1`) gives the owner a read/write
operator view over the same durable control plane: usage/cost/waste
metrics, provider toggles, agent launches, the BUILD-QUEUE.md phase list,
and the owner-request ledger, all sourced from the signed audit ledger and
local files rather than a second authority. See `docs/DASHBOARD-GUIDE.md`
for what each tab means, what its "Unavailable" states actually indicate,
and how to launch an agent from it.

### Owner-session host

The installed app owns one local named-pipe MCP host in its main-process
lifecycle. The app, host, and agent children run under the installation's exact
Windows principal; no scheduled task, alternate account, profile switch, or
manual launcher is involved. That principal usually carries an ordinary token,
but the owner may start the app with administrator rights: the app measures the
token, warns once with a "Do not warn me again" checkbox, and then starts either
way. Agent launches still follow their declared permission and process-confinement
contracts. Elevation never changes which installation or tree is selected, and
a different Windows account is still refused by the account fence. Bind/revoke authority stays in app memory, while each named agent
receives only its opaque session credential.
If startup fails, named agents fail closed with an instruction to close and
reopen ToolsEnabled normally. The app removes only its exact pipe generation on
shutdown, so an old instance cannot remove a newer route.

### Overnight local advisory worker

`overnight_advisory.*` is a separate, opt-in durable worker for genuinely useful,
safe local synthesis while the machine is otherwise idle. It accepts only a bounded
untrusted prompt and acceptance checklist; credentials, personal data, vault/profile
references, tools, file/browser work, network work, provider fallback, and external
actions are rejected or structurally unavailable. Model output is untrusted advisory
data and never proves a checklist item or grants authority.

The policy switch is `overnightAdvisory.enabled` in
`config/toolsenabled.policy.json`; stopping remains available even when the switch is
off. The reserved queue cannot be populated through generic `task.submit`, so every
advisory payload passes the dedicated safety and capacity checks first. Generic
`task.*` callers also cannot claim, read, cancel, or transition reserved advisory
tasks; only the marked internal worker state can do so.

Use the actor bound to the client wrapper (for example `codex`) to submit and control
it: `overnight_advisory.submit` → `overnight_advisory.lifecycle` with `action: start`
→ `overnight_advisory.lifecycle_status` / `overnight_advisory.status`. The dedicated
queue is capped at eight non-terminal `local-advisory` tasks, each has at most six
attempts, two inference phases, 1,024 generated tokens total, and provider-enforced
390-second maximum model time per fenced attempt. Start and stop share an
identity-bound cross-process lock. Stop freezes and terminates only the exact
creation-time-verified Windows process tree through kernel handles; it has no
PID-only fallback. An interrupted retry-safe task is reconciled through its normal
lease rather than replayed in place. A lifecycle-process crash leaves a fail-closed
stale lock for intentional local recovery instead of deleting a possibly replaced
lock path automatically.

The worker claims, starts, heartbeats, checkpoints, and completes via `task.*` state,
at below-normal (or normal if Windows refuses) priority. It blocks with exponential
idle backoff when its queue is empty. Before each inference phase it pauses and
requeues on battery, thermal, RAM/VRAM, paging, competing-model residency, or active
foreground-app pressure; unavailable thermal or pressure probes also pause work.
Hermes is always the first fixed local model. If the
submitter sets `allowStrong: true`, the worker checkpoints the Hermes summary, waits
for the existing 15-minute workload residency to end naturally, then runs one fixed
gpt-oss phase only when its existing AC/headroom gates are ready. It never pulls,
restarts, unloads, kills, or evicts a model.

For an agent to view pixels, capture first and then call `screen.read_capture` with the
returned direct `captures/` path. It returns an explicit bounded PNG thumbnail MCP image
attachment (512px by default); ordinary capture tools return metadata and paths only.

## MCP profiles

The checked-in Codex configuration example uses a 98-tool agent profile through
`TOOLSENABLED_TOOL_ALLOWLIST`; Gemini uses the same base without
`gcloud.account_inspect` (97 tools), and the repository's generic project server
is a separate 36-tool read-only profile. The agent base includes `system.*`,
`task.*`, `memory.*`, `search.*`, `code.*` (semantic code intelligence, below),
bounded local research tiers, `overnight_advisory.*`, `sandbox.*`,
`duo.*`, and the narrow audit, desktop, model, HTTP, and web entries needed
for ordinary work. Treat the registrations
as canonical rather than copying this prose; use `context/toolsenabled-tools.md`
for the generated full inventory. The broker defaults to its full surface when
the variable is absent. Omitted tools are absent from `tools/list` and reject
calls with the full-profile switch named explicitly.

For a one-off full-profile server, paste and run:

```powershell
Remove-Item Env:TOOLSENABLED_TOOL_ALLOWLIST -ErrorAction SilentlyContinue
node .\src\mcp-server.js
```

For a saved MCP registration, remove `TOOLSENABLED_TOOL_ALLOWLIST` from its `env`
block and reconnect the client.

### Semantic code intelligence

`code.status`, `code.goto_definition`, `code.find_references`,
`code.document_symbols`, `code.workspace_symbols`, `code.diagnostics`, and
`code.hover` expose a real Language Server Protocol client
(`src/lib/lsp-client.js`, `src/lib/providers/code-intel.js`) as MCP tools, so
Codex, Gemini, and any other stdio-MCP client get the same semantic lookups a
client's own built-in code intelligence would give it — not just the Claude CLI.
Supported languages are TypeScript/JavaScript (`typescript-language-server`)
and Python (`pyright` or `pylsp`/`jedi-language-server`); neither server ships
with this repo, `code.status` reports whether one is installed and how to
install it, and a missing server is a typed `CODE_SERVER_UNAVAILABLE` rather
than a silent fallback to text search. All seven tools are `local-read`,
untrusted-content, and included in the default agent profile above.

These calls answer targeted questions (where is X defined, who references X,
what does X's signature say, is this file clean) far more cheaply and
precisely than grepping or reading a whole file — but `code.document_symbols`
specifically is not guaranteed cheaper than a full read: it lists every
nested symbol the server reports (including deeply nested object-literal
entries and closures), and on a symbol-dense file its JSON overhead can
exceed the source file's own size. `code.find_references` is also a known
undercount for a symbol reached only through an inline
`require('./mod').method()` call with no local binding (two real call sites
in this repo), since the language server cannot trace that pattern back to
the declaration even with `jsconfig.json` present. Both are per-file/per-call
judgment calls, not reasons to avoid the tools outright — see BUILD-QUEUE.md
Q29 and Q59 for the full evidence and measurements.

### Fresh one-shot Codex MCP call

If a client reports a closed/deferred MCP transport, use `tools/mcp-call.js` rather
than launching the broker directly. It launches `mcp-owner-proxy.js` directly with
Node (without a transient cmd.exe wrapper), initializes MCP, and makes one tool call;
policy, approval, audit, allowlist, and the transport-bound Codex actor are therefore
unchanged. Put the tool name and arguments
in a JSON file under this repository (not on the command line):

```json
{ "tool": "system.status", "arguments": {} }
```

```powershell
node .\tools\mcp-call.js --input .\scratch\mcp-status-request.json
```

The normal result is metadata only and never echoes request arguments or response
text. To save a raw response for a deliberately reviewed local diagnostic, add
`--output-name status.json`; it is created once under the ignored
`scratch\mcp-call-output\` directory and is never printed by the helper. The helper
rejects input outside the repository, symbolic-link input, oversized/non-object input,
duplicate/unknown options, and unsafe output names.

For an approval-gated tool, add `--approve`. The helper asks `system.ask` for
that exact tool and argument object, keeps the one-time input-bound approval
token only in the live MCP client process, and immediately consumes it on the
requested call. The token is never added to the request file, command line,
saved response, or helper summary. A denied or timed-out prompt stops the call.

## Store credentials locally

```powershell
.\tools\secrets.ps1 set ig_access_token
.\tools\secrets.ps1 set ig_user_id
.\tools\secrets.ps1 set google_access_token
.\tools\secrets.ps1 set github_pat
.\tools\secrets.ps1 set vercel_token
.\tools\secrets.ps1 set cloudflare_api_token
.\tools\secrets.ps1 set cloudflare_account_id
.\tools\secrets.ps1 set paddle_sandbox_api_key
.\tools\secrets.ps1 set paddle_sandbox_webhook_secret
.\tools\secrets.ps1 set gcp_service_account_key
```

`set` reads through an interactive hidden prompt; secret values are never command-line
arguments. Programmatic callers use the stdin-only `set-stdin` action. The vault file
is encrypted for the current Windows user by DPAPI and ignored by git. Vault mutations
use an exclusive filesystem handle beside the vault, so interactive agents and same-user
Task Scheduler workers in session 0 cannot overwrite each other's keys.
Run `node src/doctor.js` to see which optional credentials and executables are ready;
it never reveals secret values.

### On-demand credential prompts

Call `system.credential_request` to add or update a supported provider credential
through a masked local Windows dialog. The dialog writes directly into the DPAPI vault
and returns only `created`, `updated`, or a safe cancellation/error result—never the
credential value. While a registered MCP tool is running, a missing supported provider
credential can open the same dialog and then resume that exact tool call. Google OAuth
keys may be scoped to an account alias; explicitly named custom credentials are stored
under the `custom.` namespace for a separately policy-bound integration.

Only one credential dialog can be open across all ToolsEnabled processes. A concurrent
request fails fast with `CREDENTIAL_CAPTURE_IN_PROGRESS` and can be retried after the
existing dialog is saved or cancelled; it never opens a duplicate window.

This requires the current interactive Windows desktop. Scheduled/session-0 work fails
closed with `CREDENTIAL_INTERACTION_REQUIRED`; it never creates an invisible prompt.
The flow does not read from `.env` files, scrape browser or OS password dialogs, or
bypass provider sign-in, CAPTCHA, passkey, hardware-key, or MFA requirements.

For unattended renewal of Google or Chrome Web Store access tokens, store the
corresponding `*_refresh_token`, `*_client_id`, and `*_client_secret` keys (prefixed
`google_` or `cws_`). The adapter refreshes a rejected or absent access token and
saves the replacement only in the encrypted vault.

## Included MCP tools

The non-exhaustive namespace summary includes `system.*`, `browser.*`,
`sandbox.*`, `clipboard.*`, `screen.*`, `sound.*`, `tts.*`, `search.*`,
`memory.*`, `task.*`, `code.*`, `model.*`, `research.*`, `http.*`, `web.*`,
`google.*`, `drive.*`, `vertex.*`, `gcloud.*`, `github.*`, `instagram.*`,
`firebase.*`, `paddle.*`, `extension.*`, `chrome_web_store.*`, `launch.*`, `deployment.*`,
`terraform.*`, `scheduler.*`, `gmail.*`,
`calendar.*`, `pay.*`, `stripe.*`, `billing.*`, `license.*`, and `audit.*`.
`tools/list` provides the canonical input schemas and
`context/toolsenabled-tools.md` provides the generated human digest. Each
outward call writes an audit record under `logs/`. The current canonical
registry contains 193 tools.

The MCP registry validates those schemas before a credential lookup, subprocess, or
network request. It also publishes read-only/destructive/idempotent/open-world hints,
so clients such as Codex can distinguish diagnostics from mutations. Provider policy,
kill-switch enforcement, sanitized invocation outcomes, and dispatch all derive from
the same registry instead of parallel name maps.

Twelve local desktop tools cover operator notifications and explicit prompts, bounded
clipboard read/write, full/region/window PNG capture under `captures/`, visible-window
listing/focus, local Windows OCR, text-to-speech, and built-in notification sounds.
They require an interactive Windows session and are audited local operations; window
titles and OCR output are untrusted data, and these tools do not bypass website or
provider security checks.

The local approval policy gates registry-marked high-consequence external writes and
scheduler mutations. Ordinary reversible setup, navigation, provider configuration,
provider-owned OAuth consent, and broker-attested upload proceed after deterministic
preflight without a redundant ToolsEnabled approval.
Call `system.ask` with the exact target `action` and `arguments`; a local Yes creates
an opaque, one-time `approvalToken` bound to that canonical input for at most 15
minutes. The token is consumed before the handler starts, never reaches a provider or
the audit payload, and cannot authorize changed arguments. A scheduled job is approved
when its create/update mutation is approved; durable job arguments cannot contain a
token, and the runner uses its narrowly marked internal scheduled context only when
`approvals.allowScheduledActions` is enabled in local policy.

### Firebase CLI account reauthorization

`firebase.account_login` is the owner-visible, approval-gated path for restoring
Firebase CLI access. It accepts only an optional 60–900 second timeout and is
permanently fenced to the configured primary Google alias; callers
cannot choose a different account. Firebase CLI owns the visible browser/sign-in
window. Select that account there and finish any MFA or passkey prompt yourself.
ToolsEnabled privately verifies the resulting Firebase identity, returns only typed
status, and never exposes or copies tokens, cookies, URLs, codes, or account email.
It never signs out, deletes, or changes another account. A closed/cancelled window,
timeout, wrong identity, unavailable CLI, policy denial, or active kill switch fails
closed without treating login as successful.

`system.ask_remote` was the unattended counterpart to `system.ask`. It was removed on
2026-08-23 with the Telegram connector: it was implemented entirely by the Telegram
provider module and had no other transport. `system.ask` -- the local, attended prompt
-- is unaffected.

`http.request` is a default-deny, vault-sealed HTTPS broker for a narrow generic
API call. Its policy maps each approved vault-key name to host suffixes and one
authentication style (`bearer`, `header:<name>`, or `query:<param>`); callers
never supply credential values. It rejects private/link-local/metadata addresses,
pins each connection to a vetted DNS answer, re-vets same-host redirects, returns
cross-host redirects without following them, and returns only bounded UTF-8
text/JSON marked untrusted. Literal, base64, and URL-encoded echoes of the injected
secret are redacted; JSON Unicode escapes and custom transforms remain residual risk.
The checked-in policy has no HTTP hosts or bindings, so it permits no request until
an operator deliberately configures one. `system.status.http` exposes configured
host suffixes and vault-key names, never their values.

`web.search` is the lean-profile research entry point. It uses the configured
free provider only—Tavily by default—and returns at most ten untrusted
title/snippet records, never page bodies. Its `tavily_api_key` is DPAPI-vault-only:
the first call can open the same masked Windows credential dialog used by other
providers. There is no paid-provider fallback. `web.fetch` is intentionally full-
profile-only because it writes a durable local evidence record. It checks RFC 9309
robots permissions, DNS-pinned public-address SSRF rules on every redirect, 5-second
per-host pacing, a 10 MiB decoded/wire cap, and the outward kill switch; it returns
only metadata plus a SHA-256 hash, never stored page text.

Run `tools\provision-research.ps1 -Searxng -Python` to start the loopback-only,
engine-allowlisted SearXNG instance and build the pinned extraction environment.
The checked-in SearXNG config keeps only Wikipedia, PubMed, OpenAlex, and Crossref;
Google and Bing are not configured. After using the official Ollama Windows updater,
run `tools\provision-research.ps1 -Models` to pull the exact tags in
`research\model-tags.json`.

`model.complete` is a bounded, local-only Ollama completion broker. It selects only
the installed `gpt-oss:20b`, `qwen3.5:9b`, or `qwen3.5:4b` tag using the shared
resource-aware picker; it never pulls a model, selects a `-cloud` tag, streams, uses
tools, or retains a conversation. The optional schema is sent to Ollama's `format`
field, validated again locally against the documented ToolsEnabled subset, and retried
once if invalid. Every attempt records aggregate per-day prompt/eval token counts in
state and protected audit metadata without storing the prompt or output. Results are
untrusted data. If Ollama, an approved installed tag, or safe hardware headroom is
absent, it returns `MODEL_UNAVAILABLE` rather than falling back to cloud.

`research.hermes_complete` is a separate, narrow local advisory-synthesis tool
for the exact installed `hermes3:8b` Ollama tag. It has a fixed 8K-character
prompt cap, 512-token generation cap, 90-second local timeout, no caller model
or URL selection, no tools, no session/vault access, and rejects obvious
credential/session material and vault/profile paths before local inference.
The local-inference policy switch `localInference.hermesAdvisoryEnabled` can
disable it. It refuses to compete with a different resident model and keeps
itself warm for 15 minutes on AC; on battery, each bounded call unloads it
immediately. The global kill switch governs outward operations; this strictly
loopback-only inference does not leave the machine. Intent/completion audit
records contain aggregate accounting only—never the prompt or response. Its
output is explicitly untrusted advisory data and cannot authorize an action.

`research.strong_complete` is the distinct deep local tier. It hard-pins the
already-installed `gpt-oss:20b` MXFP4 model, uses Ollama's documented low
reasoning effort, fixes the request to an eight-layer GPU offload and 4096-token
context, and keeps it warm for 15 minutes only after real work. Fresh loads
require AC power, 24 GiB free RAM, 7 GiB free VRAM, no other resident model,
and a GPU at or below 75°C; warm reuse still requires 12 GiB free RAM and
2 GiB free VRAM. The measured capped profile was 65%/35% CPU/GPU, retained
at least 2.3 GiB free VRAM and 16 GiB free RAM, and never exceeded 62°C. It
pauses on battery and never evicts another local model.
The prompt/output/time, secret rejection, local-only transport, untrusted output,
and metadata-only audit boundaries match the fast tier. Set
`localInference.strongAdvisoryEnabled` false to disable it.
`research.local_tiers_status` reports both tiers' current power, residency,
headroom, and readiness without loading a model.

The permanent routing rule is provider-neutral: choose one primary worker that
meets the phase's measured quality floor, run deterministic checks first, and add
at most one independent reviewer when consequence, uncertainty, or weak
verification warrants it. Local models and temporary provider credits are
capacity, never architecture. Normal Codex, Claude, and Gemini providers use
subscription CLIs only; no local model receives tools or execution authority.

`vertex.gemini_strong_complete` is a separate, explicitly owner-authorized build
workhorse rather than a chat provider. It is fixed to the registered
account alias and Google Cloud project recorded in
`config/vertex-gemini-strong.json` (operator-local configuration, not shipped),
and to Google's documented Vertex GenAI `global` location at
`aiplatform.googleapis.com`.
It derives its sole permitted model and default from the `vertex` backend in
`config/model-floor.json`; it has no flash-tier fallback. Callers cannot choose
identity, project, endpoint, model, tools, sampling, or thinking level. Prompts and
outputs are bounded and credential/private-material screened;
thought and signature parts never leave the provider adapter. A conservative
$0.50 per-call estimate and $10 daily reservation cap apply before provider
inference, usage is stored as aggregate token counts only, and every output is
untrusted. The original fixed Gemini 2.5 Flash tool remains available unchanged.

`sandbox.*` provides optional per-agent Docker Playwright workspaces for
public/untrusted/test material. Each disposable browser is non-root, capability-free,
no-new-privileges, resource-bounded, read-only except for bounded tmpfs and its one
empty workspace, and has either no network or an internal fixture-only network. It
never receives the Docker socket, vault, host browser profile, an Ollama port, a
published port, or general egress. Docker compatibility and every resulting
container/network boundary are inspected fail-closed; host workspace access shares
the exec lock, rejects link escapes, and a failed post-exec reset quarantines and
removes the exact browser generation for explicit reap.
Agents stage public evidence through audited read tools, keep durable progress in
`task.*`, and independently verify all sandbox/local-model output. Encrypted
per-account/purpose auth-profile leases and exact revocation exist, but host sessions
are never cloned and first container sign-in remains intentionally owner-gated. See
`docs/agent-sandboxes.md` for the workflow, exact limits, image build, and remaining
authentication gate.

`search.index`, `search.query`, and `search.status` provide a rebuildable local semantic
index for text and source trees. They use a local Ollama embedding model when available
and otherwise fall back to deterministic lexical vectors. Indexing skips vault/state/log
directories, credential-like filenames, private-key formats, and recognizable plaintext
tokens; files that disappear or become sensitive are removed from the index. The index
is a local cache under `state/`, not durable authority or a credential store.

`memory.set`, `memory.get`, and `memory.search` provide cross-session, namespaced
memory for bounded JSON values, notes, and tags. Writes can use an optimistic revision
to prevent an accidental overwrite; reads and search results are explicitly marked as
untrusted data. Memory rejects plaintext credentials and is never recorded as audit
payload content.

`github.repo_get`, issue/PR/release reads and creates, and `github.repository_dispatch`
use a least-privilege fine-grained PAT stored as `github_pat`. GitHub text is bounded,
credential-redacted, and marked untrusted. Every GitHub mutation requires a stable
idempotency key; after a request begins, an ambiguous outcome is preserved as
`uncertain` instead of being retried automatically.

Firebase provisioning supports creating a project, adding Firebase to an existing GCP
project, creating a Firestore database with explicit location/protection settings,
registering applications, and deploying configured targets.

`gcloud.account_inspect` is the read-only selected-account diagnostic surface. Its
required `account` is resolved to one exact registered, authorized alias/email before
the fixed gcloud command set runs. It never activates an account, changes gcloud
configuration, enables a service, creates a project, changes billing, or invokes a
model. It returns at most 25 sanitized projects with lifecycle state, billing
linkage/enabled state, Vertex API enabled state, and direct project-role evidence.
Direct IAM bindings are evidence only, not an effective-permission claim. Credit
balance, trial eligibility/expiry, and Gemini Commerce license assignment remain
explicitly unknown because the read-only gcloud surface does not expose those facts.
All subprocesses use JSON formats, fixed 15-second per-command and 90-second total
bounds, and redacted reason codes rather than raw stderr.

The GCP adapter can also create a service account and place a newly created service-
account key directly into the DPAPI vault with `gcloud.service_account_key_to_vault`.
It returns only the service-account address and vault key name, never the private key.

`payment_method.card_register` queues one visible, masked Windows form for the
owner to store a default card as a single DPAPI-encrypted local vault record.
The persistent **Start user prompts** dialog waits until the owner chooses to
release queued forms, so background work never interrupts the desktop.
The number, expiration, CVC, postal code, and cardholder name never appear in an
agent context, MCP response, audit entry, report, or source file.
`payment_method.card_status` reports only whether that record exists. The record
is inert: it cannot initiate a charge on its own and may be used only by a future
provider-specific, owner-authorized checkout bridge that returns a sanitized receipt
reference rather than card material.

For Stripe Issuing accounts, `stripe.cardholder_create` and
`stripe.virtual_card_create` create provider-authorized virtual cards with a Stripe-
enforced daily spending limit bounded by the local policy. They never return a card
number or CVC. Store a least-privileged Issuing key as `stripe_restricted_key` (or
`stripe_secret_key` when appropriate) in the vault.

The reusable billing surface adds `billing.product_create`, `billing.price_create`,
`billing.checkout_create`, `billing.checkout_status`, and `billing.portal_create`.
Mutations accept an optional Stripe idempotency key, return sanitized object summaries,
and use the same least-privileged `stripe_restricted_key` vault entry. The local
`billing.webhook_verify` helper accepts the exact raw UTF-8 request body, verifies every
accepted event against a vault-sourced Stripe signing secret and bounded timestamp
tolerance, and parses JSON only after the constant-time HMAC check succeeds. It is a
helper for an internet-reachable function, not a webhook listener.

The Paddle provider surface adds sandbox catalog/status/cancellation and local
webhook verification. Provider requests use fixed credential keys and refuse every
HTTP redirect. Every provider mutation is one-time approval-gated and durably
replay-protected; an ambiguous post-request outcome remains uncertain instead of
being retried automatically.

`license.key_issue`, `license.key_verify`, and `license.key_revoke` implement portable
offline licenses with a dedicated DPAPI-vault-held Ed25519 issuer key. Issuance returns
the public key that a licensed application can pin; verification can run with only that
public key and the license string, with no provider call or private key. Revocations are
transactional local SQLite records with their own Ed25519 signatures and are checked by
default. Firebase entitlement reads and manual custom-claim grant/revoke are intentionally
not exposed yet: the repository has a safe convention for putting a service-account key
in the vault, but no coherent Firebase Admin execution/rollback convention.

The Chrome Web Store adapter operates on an existing developer account and existing
store item through the official API. Instagram, Firebase, Google, GitHub,
and Chrome Web Store require the relevant accounts, OAuth/API tokens, and provider
authorization first. ToolsEnabled automates supported operations after that state is
available; it does not circumvent provider identity, MFA, payment, or anti-abuse
controls.

`chrome_web_store.oauth_authorize` is the owner-interactive Desktop OAuth bridge
for the fixed primary account, publisher, and item. It uses PKCE and a bounded
loopback callback, verifies Store capability before persistence, and then writes
the CWS refresh/access token pair in one atomic vault generation. It never
returns OAuth material.

When `instagram.publish_image` receives an idempotency key, it reserves a durable
operation before the first Graph API mutation. A completed operation is replayed
without publishing again. A key reused with different input is rejected, concurrent
use is leased, and a crash or ambiguous result after the final publish request is
recorded as uncertain and fails closed instead of risking a duplicate post. Calls
without an idempotency key retain the original non-journaled behavior.

The `task.*` tools provide durable, AI-agnostic handoff between separate Claude,
Codex, CLI, or other MCP processes. Submission requires a stable idempotency key.
A claim only reserves work; the worker calls `task.start` immediately before work or
I/O, renews its fenced lease with `task.heartbeat`, and can save revision-checked,
hash-chained checkpoints. A worker that disappears before start is safely reclaimable
without consuming an attempt. After start, only work explicitly declared retry-safe
may be retried; all other expired outcomes become `uncertain` and cannot be claimed.
The original fenced worker may still report a late definitive outcome.

This is a fenced, at-least-once coordination protocol for work declared retry-safe,
not an exactly-once guarantee for external effects. Provider idempotency must use the
durable task ID whenever a repeated external mutation is possible.

### Telegram owner-command bridge (REMOVED 2026-08-23)

The Telegram bridge is no longer part of ToolsEnabled. `telegram.worker_run`,
`telegram.send`, `telegram.poll`, `telegram.command.read` and
`telegram.command.reply` were removed with it, along with `system.ask_remote`,
which was implemented by the same provider module. The product ships its own
mobile app instead.

This heading is kept rather than deleted because the tool ids above appear in
older schedules and notes; if you have a scheduled job with
`action: "telegram.worker_run"`, it now names a tool that does not exist and
should be removed. Nothing else replaces it through this API.

The durable task queue itself is unchanged and is described below: it was never
Telegram-specific, and the bridge was only one of its ingresses.

Task payloads, checkpoints, and results are bounded, reject recognizable plaintext
credentials, and are always labeled untrusted. Queueing text never executes it,
grants tool/provider authority, bypasses policy, or disables the outward-operation
kill switch. Claim tokens are returned only to the claimant; only their SHA-256 hashes
are persisted.

Chrome Web Store uploads are streamed and, when Google reports an asynchronous upload,
polled to `SUCCEEDED` before publish can begin. The adapter validates the ZIP signature,
2 GB limit, and rollout percentage. Creating the developer account and initial store
item, completing listing/privacy declarations, 2-Step Verification, review, and other
provider-controlled eligibility remain external prerequisites.

## Operations

### True-blocker-only operator escalation

Run deterministic identity, configuration, policy, and reversible-operation
preflight before considering an owner prompt. A preflight failure returns safe typed
evidence and never triggers a prompt; never ask the owner to perform an action that
an existing audited capability can perform.

After preflight, ordinary reversible setup, navigation, provider configuration,
provider-owned OAuth consent, and fixed broker-attested upload continue
autonomously. Interrupt only for a password, MFA, passkey, CAPTCHA, personal legal
attestation, ambiguous payment or charge, destructive action, truly inaccessible
external state, or the explicitly reserved final Chrome Web Store publish/submit
action. OAuth consent is completed in the provider-owned browser, not by a separate
broker approval. Missing fixed Chrome Web Store configuration returns the safe,
actionable `CWS_OAUTH_CONFIGURATION_MISSING` result before a browser opens; add the
fixed credentials through the local DPAPI vault flow and retry. The final publish
gate remains owner-approved.

- `system.kill_switch_activate` lets any client stop outward operations immediately.
  Reactivation is intentionally outside the agent-facing MCP surface: use
  `tools/kill.ps1 deactivate` from a local terminal so an ordinary MCP plan cannot
  undo the emergency stop. A process with direct workspace write access can still
  remove the file; this is an operational brake, not an OS security boundary.
- `audit.tail`, `audit.status`, `audit.verify`, and `audit.flush` expose the signed
  canonical audit ledger through MCP; `tools/audit.ps1` provides the same local access.
  External-effect intents are hash-chained, Ed25519-signed, and protected by a
  DPAPI-backed monotonic head before execution. JSONL/text files are exact derived
  projections and can be rebuilt from `state/audit.sqlite3`; malformed emergency
  input is retained in a digest-named quarantine with a signed diagnostic.
- `tools/browser.ps1 start https://example.com` opens the isolated persistent browser
  profile. Its logins are separate from the default browser profile.
- Versioned SQLite schema 11 lives under `state/`. Spend-cap checking and recording are
  one atomic transaction, so concurrent broker processes cannot both spend against
  the same remaining allowance. Durable task handoff uses monotonic fences, token-hash capabilities,
  explicit start, and checkpoint compare-and-swap across independent broker processes.
  Scheduler intent, immutable registrations, reconciliation work, and run admission
  are durable in the same state database. Durable memory entries add namespaced,
  revision-aware values, notes, and tags without storing plaintext credentials. Schema
  6 added hashed, action-and-input-bound approval grants with durable single-use and
  expiry enforcement. Schema 8 adds
  the aggregate-only per-day local-model token ledger; it stores model names and token
  counts, never prompts or outputs.
- On first use, the state layer validates and imports the version-1 spend ledger,
  Instagram idempotency records, and version-1
  untracked `config/jobs.json` (see `config/jobs.example.json`). Each import is recorded
  once; malformed, changed, or conflicting legacy state fails closed. A successfully
  imported scheduler file is preserved as a digest-named `jobs.json.legacy-*` archive
  instead of remaining live authority. Reconciliation removes a pre-saga
  `ToolsEnabled-<name>` Windows task only when its archive, creation time, current
  account/SID, trigger, settings, and exact historical command all match; conflicts stay
  untouched and are returned in `legacyCleanup`.
- `scheduler.create`, `scheduler.list`, `scheduler.remove`, and
  `scheduler.reconcile` manage daily, hourly, or fixed-minute (1 through 1439) local
  jobs on Windows. Other platforms return `SCHEDULER_PLATFORM_UNSUPPORTED` before
  changing scheduler state. Only the external-write actions exposed by `system.status` are accepted; the
  runner reuses the canonical base tool schema, policy, kill switch, and audit path.
  The three scheduler mutations use the one-time approval tier; scheduled arguments
  never retain approval tokens.
  Updates use immutable blue/green Windows Task Scheduler generations: a replacement
  becomes active only after its exact owned registration is observed, after which older
  owned generations are removed. Removal disables execution in SQLite before cleanup,
  and both Task Scheduler's `IgnoreNew` setting and transactional runner admission
  suppress overlapping runs. Same-job OS work is serialized across every generation;
  hourly/minute cadence uses unified-engine-compatible time-trigger repetition, and the
  23-hour OS execution limit ends before the 24-hour abandoned-run recovery boundary.

## Architecture

`host.exec` supports PowerShell/cmd on Windows and sh/bash on Linux. Linux
defaults to sh, keeps commands inside the OS user's profile, and uses the native
process supervisor to stop descendants on timeout or excessive output.
`host.list_processes` reads Linux kernel metadata without reading command lines
or environments; unavailable start times are returned as null.

The MCP server uses Node.js built-ins, including `node:sqlite` for transactional state,
and does not require an application dependency install. A transparent local gateway launches the
exact pinned Playwright MCP version with the isolated persistent Chrome profile; it
checks the kill switch for every browser tool call and audits success, failure, or
policy denial without recording browser arguments. Provider modules are deliberately narrow:
one adapter owns one external API, policy and audit happen centrally, and secrets are
read only at call time. That differs from a general long-running autonomous agent
gateway: ToolsEnabled does not own conversations, routing, memory, or channels. It
is the least-privileged execution layer that any agent can call.

ToolsEnabled is not a general agent gateway such as OpenClaw. OpenClaw-style systems
own conversation channels, long-running memory, routing, and broad agent execution.
ToolsEnabled owns none of those: an AI client retains planning and conversation while
this project supplies narrow, auditable provider execution tools and a bounded durable
handoff queue over MCP. The queue stores work records; it does not interpret or execute
them, choose a model, or run a conversation channel.
That separation lets the same authorization and reliability layer work with Codex,
Claude, and other clients without duplicating an autonomous agent runtime.

## Verified limits

The complete local contract (including advanced desktop capabilities, approval grants, and search) and browser suites are `npm test` and
`npm run test:browser`. They do not mutate Firebase/GCP accounts or publish real social,
store, email, calendar, messaging, or Stripe objects. Regression processes receive
separate disposable audit, vault, state, kill-switch, and browser paths; the desktop
test briefly exercises the interactive clipboard, bounded screen capture, and toast.
`node src/doctor.js` distinguishes
local software readiness from provider credentials.

The focused `npm run test:license-trust` alias executes the pinned Ed25519 anchor,
signature and revocation checks in `tests/providers.billing/license-provider.js`
and the durable revocation-store checks in `tests/license-store.test.js`. It uses
synthetic keys and a disposable database, not a customer license or vendor service.
`npm run test:unified-agent-p14` executes `tests/scoped-approvals.test.js` and
`tests/scoped-approvals-refusals.test.js`: the current scoped-approval API's token,
prompt-contract and refusal behavior. These focused aliases do not prove a provider
release, installed lifecycle or every approval integration.

`npm run test:key-custody` is reached once by the ordinary test lifecycle. Its
fixed dispatcher selects the real Linux private D-Bus/GNOME-keyring proof in
`tests/linux-vault.test.js` on Linux, or the Windows DPAPI/DACL/reparse-point proof
in `tests/vault-native.test.js` on Windows. The local result follows that leaf's
actual exit, signal, input hashes and owned-process cleanup. Its receipt records
the companion platform as unexecuted; both exact-source native receipts remain
required by paired release acceptance. The strict recipe hashes both leaf inputs
without claiming that dispatch executed both. The Windows suite is no longer
duplicated in the root suite list. `test:provider-release` remains an unimplemented bare alias:
there is no reviewed advertised-provider matrix and executor to assign to it, and
its usage refusal must not be reported as release coverage.

On Linux, component tests that exercise real vault or audit custody can use a
disposable D-Bus session and encrypted GNOME keyring:

```sh
node tests/linux-vault.test.js --components --continue tests/audit-verify-cached-health-read.test.js tests/code.intel/code-intel.js
```

This entry accepts the `tests/run-isolated.js` arguments and removes its private
keyring after the run. `node tests/linux-native.js` remains the native acceptance
entry. Platform-specific suites report a named skip on the other operating system;
a skip remains unexecuted coverage and produces a nonzero runner result.

The durable task queue has no background agent launcher: a Claude, Codex, or other MCP
client must claim and execute work. Fences make local state writes linearizable, but
cannot make arbitrary external provider actions exactly once; retry-safe tasks still
need provider idempotency tied to the durable task ID. Scheduling is not a general cron or arbitrary-process engine: it
supports daily, hourly, and 1-through-1439-minute cadences for a bounded external-write
allowlist, and it does not accept a custom start time or shell command.
The SQLite outbox makes Windows registration recoverable and reconcilable, but the
database and Task Scheduler still cannot share one atomic transaction; an interrupted
  OS operation can remain retryable or uncertain until reconciliation. Jobs run with the
  current interactive Windows identity, so the user session and provider prerequisites
  still apply. Pre-saga tasks had no ownership nonce, so their full archive/time/account/
  XML match proves strong generator equivalence against accidental collision, not
  cryptographic provenance against a malicious process running as the same user. The
  transactional spend ledger and
Stripe Issuing adapters are not a webhook-reconciled accounting system. Instagram
cannot automatically determine whether an ambiguous final publish request committed;
such an operation remains uncertain rather than being retried. Audit verification
detects chain, signature, protected-head, cursor, and exact-projection tampering.
External-effect intents are synchronously checkpointed; ordinary local audit events
are checkpointed in bounded batches. This is local tamper evidence, not remote WORM
storage: a process running as the same Windows account that can roll back both the
ledger and DPAPI vault is outside the guarantee. See `COMPLETION_AUDIT.md` for the
reviewed status and next reliability work.

The offline-license revocation database is local authority rather than a remote
revocation service. A deployed offline app needs an updated signed revocation list (or
an online entitlement check) to learn about later revocations, and a same-account
attacker who can roll back the local revocation database remains outside this local
boundary.
