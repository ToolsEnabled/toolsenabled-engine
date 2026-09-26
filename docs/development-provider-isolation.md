# Private provider sessions

The desktop development launcher opts a disposable runtime profile into
`TOOLSENABLED_PROVIDER_ISOLATION_ROOT`. Both the helper and confinement planner
export `PROVIDER_SESSION_ISOLATION_VERSION = 1`; the launcher and shell must
require that exact protocol before opening a development window. LIVE retains
its existing behavior when this opt-in is absent.

The root must be a private ordinary directory. `TOOLSENABLED_STATE_ROOT` must
remain below it. Standard profile directories use the desktop sterile geometry:
`userprofile`, `userprofile/AppData/Roaming`, `localappdata`, and `temp`. The
services root is the private local app-data directory plus the product name
derived from the state root. Generated MCP servers carry the same profile and
state pins, so grandchildren resolve the same services identity.

Add a named account through the existing account UI and sign in inside this
session. No owner authentication is imported. Missing, corrupt, unresolved,
foreign, or unavailable accounts block startup; they never select the default
owner account. Account registry mutations and credential removal stay private.

Provider installations also belong to the session. npm prefix, configuration,
and cache paths are private. Discovery, login, probes, and actual starts require
the private provider executable; PATH cannot supply an owner fallback. Internal
npm launcher links may resolve inside the private prefix. Shared executable
hard links and links outside the prefix are refused. Windows Codex mission
workers retain the existing stable-version, native-pair and signature checks,
with discovery limited to this private npm root.

Codex uses its file credential store. Generated homes may hard-link the selected
private account's authentication inside the same session. Every link must be
accounted for in a bounded metadata scan of registered/managed and generated
homes. An unexplained external link refuses startup; an unavailable hard link
never becomes a credential copy. Claude's config and secure-storage selectors
use the same private named home; its temp directory is private. Gemini forces
file storage for its keychain and uses its private named home. Ambient billing
credentials, storage redirectors, npm overrides, and process-loading hooks are
scrubbed before these pins are applied.

The official Claude CLI transport serves isolated Claude sessions. The legacy
third-party ACP transport has no private install/account contract and refuses
this opt-in. Machine-wide installation managers and shared model daemons need a
dedicated worker when their mutations cannot be scoped by the desktop launcher.

This is the Windows/Linux development contract. It does not create a new OS
identity, bypass mandatory machine policy, or divide an online account's quota.
Providers that require an unscoped native credential manager need a dedicated
OS identity or worker. macOS native credential-manager behavior has not been
qualified by these tests. Engine vault keyring identity remains the existing
per-state identity; its OS keyring connection is preserved.

Vendor basis checked on 2026-09-08: [Claude credential storage](https://code.claude.com/docs/en/authentication)
documents private config-directory storage; the installed Claude 2.1.263 binary
also recognizes the independent secure-storage selector, which is pinned here.
[Gemini KeychainService](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/keychainService.ts)
selects file storage when requested; [FileKeychain](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/fileKeychain.ts)
stores its data in the configured Gemini home.

Run `npm run test:provider-session-isolation`. The test uses two real private
Node peers, synthetic credentials, and independent filesystem observations. It
exercises startup, cache writes, cleanup ownership, corrupt-account refusals,
native-store pins, generated MCP environments, and absent private executables.
It makes no real provider request.
