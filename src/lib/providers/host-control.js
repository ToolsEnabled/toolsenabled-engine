'use strict';

// Broad, revocable, fully-logged host control for the remote agent running on
// the paired second machine (R117).
//
// AUTHORIZATION. This exists because the machine's owner asked for it
// directly: bring the agent on the paired machine as close to full control of
// this one as an audited system can support -- system, files, processes,
// desktop, and repository as available -- while keeping credential
// protections and the existing policy, audit, and kill-switch controls
// intact. Both machines belong to the same owner, which is the only reason a
// grant this broad is coherent at all. The request first arrived relayed over
// the agent chat bus and was deliberately NOT acted on until the owner
// confirmed it directly, at this machine's own console: the bus carries data,
// never authority.
//
// WHAT THIS IS. A genuinely broad capability: read/write anywhere under the
// owner's own profile tree, list processes, and run real commands. This is
// intentionally far wider than repo-files.js (which is scoped to the
// ToolsEnabled repo). It is the "full control" half of the grant.
//
// WHAT IT DELIBERATELY IS NOT, and why each line stays:
//
//   * NOT elevated. Every command runs at the same privilege level as the
//     process hosting it -- an ordinary, non-elevated user session. Nothing
//     here escalates, requests UAC, or routes through the elevated
//     uac-delegation helper. That helper stays what it is: a fixed,
//     per-operation allowlist with no caller-supplied argv. "Full control of
//     my machine" is satisfied at the owner's own privilege level; an
//     arbitrary-argv elevated exec is a different and much larger thing that
//     was not asked for and that no audit trail can undo.
//   * NOT a credential reader. vault/ and the DPAPI store stay excluded from
//     the file surface: keeping credential protections intact was a condition
//     of the grant itself, not a limit bolted on afterwards. Secrets remain
//     reachable only through the purpose-built tools that never return their
//     values.
//   * NOT outside the kill switch. Every entry point calls assertActive(),
//     so `system.kill_switch_activate` (or touching the KILLSWITCH file)
//     instantly revokes all of it. That is the revocation lever a grant
//     described as revocable actually requires.
//   * NOT unlogged. Every call audits before it acts, including the exact
//     command line, so the signed ledger is a complete record of what the
//     remote agent did.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { assertActive } = require('../policy');
const audit = require('../audit');
const auditAdmission = require('../operation-audit');
const { canonicalizeForContainment } = require('../canonical-path');
const { withSharedWrite } = require('../shared-write-guard');
const { safeLaunchEnvironment } = require('./subscription-launch-env');
const windowsJob = require('../windows-job-control');
const { spawnLinuxOwned } = require('../linux-process-control');
const { deleteEnvNames } = require('../env-scrub');

const HOME = process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_LIST_ENTRIES = 5000;

// Excluded from the FILE surface regardless of how the path is spelled --
// READ and WRITE both. This started as a vault/browser-profile list; an
// adversarial review found it missed almost every AI-tool and cloud-CLI
// credential store on an ordinary developer profile (.codex/auth.json,
// .claude/.credentials.json, .gemini/oauth_creds.json and gcloud's
// application_default_credentials.json were all readable in plaintext) and
// missed state/ entirely, which let a caller read the elevated UAC helper's
// per-boot token and the owner-host named-pipe capability -- i.e. escalate
// past this whole module by reading two files. Treat this list as "every
// place a credential, session token, or capability secret is known to live on
// a real machine," not just "the ones this feature happened to touch."
// vault/ and the DPAPI material behind it are the explicit
// credential-protection carve-out. .ssh/.aws/.gnupg/.docker/.kube and the
// browser profiles are the same class of thing: long-lived credentials and
// authenticated session state that no file-read capability should hand over
// wholesale (profiles/chrome additionally carries remembered-device MFA
// state, which can stand for a year or more and cannot be recreated without a
// human physically approving a fresh push).
const EXCLUDED_PATH_PATTERNS = [
  /[\\/]vault([\\/]|$)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]\.docker([\\/]|$)/i,
  /[\\/]\.kube([\\/]|$)/i,
  /[\\/]\.netrc$/i,
  /[\\/]\.git-credentials$/i,
  // Package-manager and infrastructure CLI credential files. Keep these
  // exact/bounded: an ordinary profile file must remain usable even when it
  // lives beside one of these stores.
  /[\\/]\.npmrc$/i,
  /[\\/]\.pypirc$/i,
  /[\\/]NuGet[\\/]NuGet\.Config$/i,
  /[\\/]\.nuget[\\/]NuGet\.Config$/i,
  /[\\/]\.azure[\\/](?:azureProfile\.json|AzureRmContext\.json|accessTokens\.json|msal_token_cache\.bin)$/i,
  /[\\/]\.terraform\.d[\\/]credentials\.tfrc\.json$/i,
  /[\\/]\.config[\\/]gh[\\/]hosts\.ya?ml$/i,
  /[\\/]WindowsPowerShell[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]PowerShell[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]ConsoleHost_history\.txt$/i,
  /[\\/]\.(?:bash_history|zsh_history|fish_history|python_history)$/i,
  /[\\/]profiles[\\/]chrome([\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Google[\\/]Chrome([\\/]|$)/i,
  /[\\/]AppData[\\/]Local[\\/]Microsoft[\\/]Credentials([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Crypto([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Protect([\\/]|$)/i,
  // AI CLI / cloud CLI OAuth and API-key stores -- verified present and
  // readable in that same review; every one carries a live refresh token or
  // API key.
  /[\\/]\.codex([\\/]|$)/i,
  /[\\/]\.claude([\\/]|$)/i,
  /[\\/]\.gemini([\\/]|$)/i,
  /[\\/]\.config([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]gcloud([\\/]|$)/i,
  // state/ holds the elevated UAC helper's per-boot token
  // (uac-delegation-token.json) and the owner-host named-pipe capability
  // (owner-host-capability.json) -- reading either is a direct escalation
  // past this module, confirmed live in the same review. Matches the
  // ToolsEnabled repo AND every ToolsEnabled-fleet-lane-* worktree sibling
  // (see the WRITE_EXCLUDED comment below for why the name must be a
  // prefix match, not an exact segment match).
  /[\\/]ToolsEnabled[^\\/]*[\\/]state([\\/]|$)/i
];

// A small, extension-bounded set of conventional credential/session stores.
// This intentionally does not reject arbitrary files merely because their
// contents might be sensitive; the known stores above and these common data
// basenames are the protection boundary for this broad host surface.
//
// The password / *_key / private_key+service_account / keystore+kdbx+wallet
// stem groups were ported here on 2026-09-07 alongside the matching addition
// to egress-preflight.js's CREDENTIAL_NAME_PATTERN, which that file's own
// comment already says it mirrors. Before this, a file literally named
// password.json, access_key.json, service_account.json or wallet.json sitting
// anywhere inside the owner profile was readable through host.read_file and
// visible in host.list_dir. Stems only: the extension list below is
// UNCHANGED, so this stays the same extension-bounded shape and does not
// become a rule about arbitrary files.
const COMMON_CREDENTIAL_STORE_PATTERN = /[\\/](?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|password|passwords|passwd|passphrase|passphrases|keystore|keystores|kdbx|wallet|wallets)|auth|token|tokens|cookie|cookies|credential|credentials|session|sessions|passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

// A NAME pattern, beside the two above rather than folded into either.
//
// The two patterns above are PATH-shaped: EXCLUDED_PATH_PATTERNS matches
// credential DIRECTORIES, and COMMON_CREDENTIAL_STORE_PATTERN matches a
// conventional basename anchored to a path separator with a narrow extension
// tail that carries no pem/key/p12/pfx. Between them, a file named
// private_key.pem sitting in an ordinary folder inside the profile was READABLE
// through host.read_file -- measured at 80f08ecb, refused by neither this sink
// nor egress.
//
// This is the same four CLEAN stem groups and the same extension tail that
// src/lib/egress-preflight.js's CREDENTIAL_NAME_PATTERN already applies to the
// FILENAME ALONE, kept deliberately in that pattern's shape so the two read as
// the mirrors they are. Egress and read now agree on this class of name, which
// is the whole point: a file that cannot leave should not be readable either.
//
// THREE GROUPS ARE DELIBERATELY NOT PORTED, at either sink:
//   1. extensionless "credentials" / "secrets"
//   2. the id_rsa family
//   3. stem-agnostic .pem / .jks / .kdbx / .ppk
// Each requires removing the mandatory extension tail (1, 2) or refusing on
// extension alone (3), which widens refusals for every caller of this surface.
// That is an owner decision, not one to take quietly inside a gate fix. They
// remain readable and are named here so the gap is visible rather than assumed
// closed.
//
// The stems are bounded on both sides so near-misses stay readable: an ordinary
// walletbuilder.pem, passenger.json, keyboard.pem, accessibility.json or
// service.pem is NOT refused. A rule that refuses ordinary work is not a safer
// rule.
const CREDENTIAL_SHAPED_NAME_PATTERN = /(?:^|[._-])(?:passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^./\\]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|env|pem|key|p12|pfx|db|sqlite3?)$/i;

function isProtectedEnvironmentPath(candidatePath) {
  const basename = path.basename(candidatePath).toLowerCase();
  if (basename === '.env') return true;
  if (!basename.startsWith('.env.')) return false;
  return !['.env.example', '.env.template', '.env.sample'].includes(basename);
}

function isCredentialShapedName(candidatePath) {
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(path.basename(candidatePath));
}

function isCredentialProtectedPath(candidatePath) {
  return EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(candidatePath))
    || COMMON_CREDENTIAL_STORE_PATTERN.test(candidatePath)
    || isCredentialShapedName(candidatePath)
    || isProtectedEnvironmentPath(candidatePath);
}

// WRITE-ONLY exclusions: readable, but never writable through this surface.
// These are the integrity anchors that decide whether this capability is
// itself still constrained -- if the caller can write them, it can rewrite
// its own limits, and every other check here becomes decorative.
//
// Path segments read "ToolsEnabled[^\\/]*" rather than an exact "ToolsEnabled"
// match. The review found live sibling worktrees under HOME named
// ToolsEnabled-<lane-id> (`git worktree list`) whose state/config/etc.
// matched none of the original exact-segment patterns, so a forged
// standing-orders or policy file planted in a lane worktree would have been
// read as authoritative by anything whose rootPath resolved there.
//
// config/ carries the policy, model floor, and the elevated UAC allowlist --
// the review confirmed a caller could flip approvals.enabled, repoint
// killswitchFile, or add an http.vaultKeys binding to exfiltrate a secret to
// an attacker host, all with zero audit trail via the sibling repo.write_file
// tool (which did not exclude config/ at all; fixed alongside this file).
// logs/ and reports/ are the audit-adjacent record; node_modules and the
// global git/npm config files are execution-persistence vectors (a crafted
// diff driver or textconv in ~/.gitconfig runs on the next `git diff`/`git
// log -p`/`git show` ANY local process makes, not just a purpose-built lane).
const WRITE_EXCLUDED_PATH_PATTERNS = [
  /[\\/]ToolsEnabled[^\\/]*[\\/]state([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]config[\\/][^\\/]*\.policy\.json$/i,
  // Generic host writes must not stage replacement code or runtime artifacts
  // in any ToolsEnabled worktree. Dedicated release/capture writers retain
  // their own narrower contracts; this broad surface does not.
  //
  // `bin` and `shell` are here because THE RULE ABOVE NAMED A CONVENTION AND
  // NOT THE PRODUCT'S ACTUAL ENTRY POINTS, which is the same shape of miss the
  // tree-root anchoring below was added for. Each package's own manifest says
  // where its code starts, and neither answer was `src`:
  //   engine/package.json  bin  -> bin/fallback.js, bin/localcode.js
  //                               (also config/invocation-registry.json and
  //                                config/payload-boundary.json)
  //   app/package.json     main -> shell/main.cjs, the Electron main process
  // Both were WRITE-ALLOWED through this surface until this line; `shell` is
  // the whole desktop application's startup code.
  //
  // THE CODE-FOLDER RULE ITSELF NOW LIVES IN WRITE_EXCLUDED_CODE_PATTERNS,
  // directly below: it is the one rule the owner may lift for their own
  // checkouts (agent.product_source_writes), and the anchors in this list are
  // not. See isProductCodeWriteAllowed() for the exact rule.
  /[\\/]ToolsEnabled[^\\/]*[\\/]logs([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]\.git([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]node_modules([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]reports[\\/]OWNER-REQUEST-LEDGER/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]STANDING-ORDERS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]CLAUDE\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]AGENTS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]GEMINI\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]BUILD-QUEUE\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]docs[\\/]ROLE-OPERATIONS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]reports[\\/]TOOLSENABLED-SUGGESTIONS\.md$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]package(-lock)?\.json$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]KILLSWITCH$/i,
  /[\\/]\.gitconfig$/i,
  /[\\/]\.npmrc$/i,
  // BOTH PowerShell editions, because only one of them was here. Windows
  // PowerShell 5.1 reads Documents\WindowsPowerShell; PowerShell 6/7+ reads
  // Documents\PowerShell -- a different folder, the same autorun. That folder
  // exists on this machine and was WRITE-ALLOWED, profile and Modules\ alike
  // (a module dropped in Modules\ is auto-discovered by name, no profile edit
  // needed). Anchored on the segment, so a folder merely starting with
  // "PowerShell" is not swept in.
  /[\\/]Documents[\\/](?:WindowsPowerShell|PowerShell)([\\/]|$)/i,
  // Anything that gets executed on a schedule or at logon is a persistence
  // and privilege-escalation path, not an ordinary file.
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Windows[\\/]Start Menu[\\/]Programs[\\/]Startup([\\/]|$)/i
];

// THE PRODUCT CODE FOLDERS, kept apart from the anchors above because they are
// the one rule an OWNER may lift (agent.product_source_writes) for checkouts
// that are not the running product. Same name-anchored convention as the list
// above; the tree-anchored twin is PRODUCT_TREE_CODE_PATTERNS below.
const WRITE_EXCLUDED_CODE_PATTERNS = [
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:src|bin|shell|tools|scripts|sidecars|packages|captures|scratch|tmp)([\\/]|$)/i
];

// THE SAME ANCHORS, MEASURED FROM A RESOLVED PRODUCT TREE ROOT.
//
// Every rule in the list above reads `[\/]ToolsEnabled[^\/]*[\/]<protected>`,
// which requires the protected folder to be the IMMEDIATE CHILD of a directory
// literally named ToolsEnabled*. The shipping checkout is one level deeper --
// `.../toolsenabled/engine/config` -- so NOT ONE of those rules matched it, and
// the policy file, src/ and KILLSWITCH were writable through this surface on
// the machine the product is actually developed and installed on. Measured
// 2026-08-25 with resolveHostPath itself, against controls that correctly
// refused, so it was the subjects and not the harness.
//
// A folder name is not an identity. These rules are anchored on a tree root
// discovered by walking UP from the candidate and asking the filesystem, so
// they hold wherever a customer put their checkout and whatever they named it.
// The list above is kept as-is: it still covers sibling-lane layouts
// (ToolsEnabled-lane1/config) and the non-repo anchors (.gitconfig, Startup),
// and deleting rules to replace them would be a wider change than this defect
// warrants.
//
// Root-relative and separator-normalised, so one spelling covers both.
const PRODUCT_TREE_PROTECTED_PATTERNS = [
  /^state(\/|$)/i,
  // The code folders (`bin` and `shell` mirror the same addition in the list
  // above: the entry points each package's own manifest declares) live in
  // PRODUCT_TREE_CODE_PATTERNS below, the owner-liftable rule.
  /^logs(\/|$)/i,
  /^\.git(\/|$)/i,
  /^node_modules(\/|$)/i,
  /^reports\/OWNER-REQUEST-LEDGER/i,
  /^STANDING-ORDERS\.md$/i,
  /^CLAUDE\.md$/i,
  /^AGENTS\.md$/i,
  /^GEMINI\.md$/i,
  /^BUILD-QUEUE\.md$/i,
  /^docs\/ROLE-OPERATIONS\.md$/i,
  /^reports\/TOOLSENABLED-SUGGESTIONS\.md$/i,
  /^config\/[^\/]*\.policy\.json$/i, // a policy file is enforcement, not source: anchored whatever the switch says
  /^KILLSWITCH$/i
];

// The tree-anchored twin of WRITE_EXCLUDED_CODE_PATTERNS: the product's code
// folders, root-relative. Refused by default; lifted for a checkout that is not
// the running product when the owner turned agent.product_source_writes on.
const PRODUCT_TREE_CODE_PATTERNS = [
  /^(?:src|bin|shell|tools|scripts|sidecars|packages|captures|scratch|tmp)(\/|$)/i
];

// THE LIFTABLE ANCHORS. A checkout's config/ and its package manifest and
// lockfiles are part of the product's source too: a lane that changes a
// setting's registry row or a dependency has to write them. They stay refused
// unless the owner lifted the code-folder rule (the same switch), and never in
// the running product. Owner, 2026-09-20: lanes were still refused on
// config/*.json and package.json after the switch ("protected-config",
// "protected package edits").
const WRITE_EXCLUDED_LIFTABLE_PATTERNS = [
  /[\\/]ToolsEnabled[^\\/]*[\\/]config([\\/]|$)/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/]package(-lock)?\.json$/i,
  /[\\/]ToolsEnabled[^\\/]*[\\/](?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i
];
const PRODUCT_TREE_LIFTABLE_PATTERNS = [
  /^config(\/|$)/i,
  /^package(-lock)?\.json$/i,
  /^(?:npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i
];

// Walking the filesystem on every path check would be a real cost, so the
// per-directory answer is memoised. The cache is keyed on the directory, not
// the file, because that is the unit the answer is a property of.
const PRODUCT_TREE_ROOT_CACHE = new Map();
const PRODUCT_TREE_WALK_LIMIT = 64;

// Is this directory the root of a ToolsEnabled tree? Asked of the FILESYSTEM,
// using markers the product itself ships, so it cannot be defeated by renaming
// a folder and does not need to know where a customer keeps their checkout.
//
// THROWS rather than returning false when it cannot tell. An unreadable
// directory is "could not look", not "not a product tree", and the caller
// turns that into a refusal -- the distinction this codebase keeps relearning.
function looksLikeProductTreeRoot(directory) {
  try {
    // Unique to a ToolsEnabled checkout, and cheaper than parsing JSON.
    fs.accessSync(path.join(directory, 'config', 'payload-boundary.json'));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  let raw;
  try {
    raw = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  // A malformed package.json is not evidence of anything either way, and must
  // not throw: unparseable manifests exist in the wild and refusing every
  // write beneath one would be a denial of service, not a fence.
  try {
    const name = JSON.parse(raw).name;
    return typeof name === 'string' && /^toolsenabled(-|$)/i.test(name);
  } catch { return false; }
}

// The nearest enclosing product tree root, or null when the path is not in
// one. Walks up rather than matching a name.
function productTreeRootFor(candidatePath) {
  let directory = path.dirname(candidatePath);
  const seen = [];
  for (let step = 0; step < PRODUCT_TREE_WALK_LIMIT; step += 1) {
    if (PRODUCT_TREE_ROOT_CACHE.has(directory)) {
      const cached = PRODUCT_TREE_ROOT_CACHE.get(directory);
      for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, cached);
      return cached;
    }
    if (looksLikeProductTreeRoot(directory)) {
      for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, directory);
      PRODUCT_TREE_ROOT_CACHE.set(directory, directory);
      return directory;
    }
    seen.push(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const entry of seen) PRODUCT_TREE_ROOT_CACHE.set(entry, null);
  return null;
}

// AN OWNER MAY LET AGENTS EDIT THE PRODUCT'S OWN SOURCE IN A CHECKOUT.
//
// The code-folder rule exists so a lane cannot stage replacement product code
// through this surface. Measured 2026-09-19 on the owner's machine: with
// "Available tool sets" set to Only, every Codex lane writes through THIS
// surface and nothing else, so the same rule refused every edit to the
// checkouts the owner had cloned for those lanes to develop in
// (HOST_PATH_WRITE_PROTECTED on Temp\te-home-circle-hotload-app-*\src, on
// isolated worktrees' src/views/computers.js and shell/fleet-profile-preload.cjs)
// -- eight lanes blocked in one day, with no switch anywhere. That is the fence
// gating the person, which this product's own rule forbids: at most a warning,
// and the person decides.
//
// So the rule is a SETTING, agent.product_source_writes, off by default and
// read on every call through src/lib/product-source-writes.js (only a true the
// person or the installer chose counts, exactly like outside control). It lifts
// ONLY the code-folder rule, and NEVER for the running product: a candidate
// inside this process's own root, or inside the product tree that contains it
// (the desktop app's own src/ and shell/ around the packed capability layer),
// stays refused whatever the switch says. state/, config/, KILLSWITCH, .git,
// node_modules, the package manifests and the policy documents are anchors,
// not code folders, and stay refused in every checkout.
let productSourceWritesPolicy = null;

function runningProductRoot() {
  try { return path.resolve(require('../runtime').rootPath()); }
  catch { return null; }
}

function containsOrEquals(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'));
}

// Is this candidate part of the product that is RUNNING right now? Either it
// sits inside the process's own root, or the nearest product tree around it
// contains that root (the app tree around the packed capability layer). A root
// that cannot be resolved answers "running": the fence fails closed.
function insideRunningProduct(candidatePath, productRoot) {
  const running = runningProductRoot();
  if (!running) return true;
  if (containsOrEquals(running, candidatePath)) return true;
  return productRoot !== null && productRoot !== undefined && containsOrEquals(productRoot, running);
}

function isProductCodeWriteAllowed(candidatePath, productRoot) {
  if (insideRunningProduct(candidatePath, productRoot)) return false;
  let policy;
  try {
    policy = (productSourceWritesPolicy || require('../product-source-writes').productSourceWritesPolicy)();
  } catch {
    // Could not read the person's choice: the rule stands.
    return false;
  }
  return Boolean(policy && policy.enabled === true);
}

// Test seam: hand in a policy function so the fence can be driven both ways
// without a settings file. `null` restores the real reader.
function setProductSourceWritesPolicyForTests(policy) {
  productSourceWritesPolicy = typeof policy === 'function' ? policy : null;
}

class HostControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostControlError';
    this.code = code;
  }
}

function fail(code, message) { throw new HostControlError(code, message); }

function failCouldNotCheck(subject) {
  fail('HOST_PATH_CHECK_FAILED', `${subject} could not be checked; this does NOT claim that the path or entry is absent.`);
}

// Runs the containment + exclusion checks against ONE candidate path string.
// Called twice by resolveHostPath below: once on the lexical (path.resolve)
// form, once on the canonical (reparse-point-resolved) form. A security
// review found the lexical-only version defeated by the legacy profile
// junctions Windows still creates for compatibility (Local Settings ->
// AppData\Local, Application Data -> AppData\Roaming, My Documents ->
// Documents): a caller spelling an excluded target through its legacy alias
// bypassed every pattern below, even though both spellings open the identical
// file. See src/lib/canonical-path.js.
function checkContainmentAndExclusions(candidatePath, { forWrite }) {
  const relativeToHome = path.relative(HOME, candidatePath);
  if (relativeToHome.startsWith('..') || path.isAbsolute(relativeToHome)) {
    fail('HOST_PATH_OUTSIDE_PROFILE', 'path must be inside the owner profile tree.');
  }
  if (isCredentialProtectedPath(candidatePath)) {
    fail('HOST_PATH_FORBIDDEN', 'path is a bounded credential, session, or environment-secret store and is never exposed.');
  }
  if (forWrite) {
    for (const pattern of WRITE_EXCLUDED_PATH_PATTERNS) {
      if (pattern.test(candidatePath)) {
        fail('HOST_PATH_WRITE_PROTECTED', 'path is an integrity anchor and is never writable through this surface.');
      }
    }
    // The same anchors again, measured from a resolved tree root instead of a
    // folder name. See PRODUCT_TREE_PROTECTED_PATTERNS for why both exist.
    let productRoot;
    try {
      productRoot = productTreeRootFor(candidatePath);
    } catch {
      // COULD NOT LOOK. Refuse: an unreadable ancestor must never read as
      // "not a product tree", which would fail this fence OPEN exactly where
      // the filesystem is least cooperative.
      failCouldNotCheck('path against the product tree');
    }
    let withinTree = null;
    if (productRoot) {
      withinTree = path.relative(productRoot, candidatePath).split(path.sep).join('/');
      for (const pattern of PRODUCT_TREE_PROTECTED_PATTERNS) {
        if (pattern.test(withinTree)) {
          fail('HOST_PATH_WRITE_PROTECTED', 'path is an integrity anchor and is never writable through this surface.');
        }
      }
    }
    // The code folders, last: refused unless the owner lifted the rule for
    // checkouts, and never for the running product. See
    // isProductCodeWriteAllowed above.
    const codeFolder = WRITE_EXCLUDED_CODE_PATTERNS.some(pattern => pattern.test(candidatePath))
      || WRITE_EXCLUDED_LIFTABLE_PATTERNS.some(pattern => pattern.test(candidatePath))
      || (withinTree !== null && (PRODUCT_TREE_CODE_PATTERNS.some(pattern => pattern.test(withinTree))
        || PRODUCT_TREE_LIFTABLE_PATTERNS.some(pattern => pattern.test(withinTree))));
    if (codeFolder && !isProductCodeWriteAllowed(candidatePath, productRoot)) {
      fail('HOST_PATH_WRITE_PROTECTED', 'path is ToolsEnabled product code and is not writable through this surface; the person can allow edits in checkouts with the "Let agents edit ToolsEnabled source in checkouts" setting (the running installation stays protected).');
    }
  }
}

// Resolves a caller path and confirms it is inside the owner's profile tree
// and not in an excluded location. Absolute paths ARE allowed here (unlike
// repo-files.js) -- that breadth is the point of this module -- but the
// containment and exclusion checks are not optional.
function resolveHostPath(value, { mustExist = false, forWrite = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('HOST_PATH_INVALID', 'path must be a non-empty string.');
  // A RELATIVE PATH IS RELATIVE TO THE OWNER PROFILE TREE, WHICH IS WHAT THE
  // TOOLS THAT TAKE ONE ALREADY SAY.
  //
  // host.read_file, host.write_file and host.list_dir all describe this
  // argument as "Absolute or relative path inside the owner profile tree", and
  // host.list_dir adds "omit for the profile root" -- and listDir's own default
  // is HOME. A bare path.resolve() instead anchored on process.cwd(), which is
  // wherever this engine process happens to be running: not the profile root,
  // not the agent's working directory, and not anything an MCP caller can see
  // or name. MEASURED on this machine: with the engine started from a checkout,
  // host.list_dir({path: 'Desktop'}) resolved to
  //   <checkout>\Desktop
  // rather than <profile>\Desktop, and answered HOST_PATH_NOT_FOUND for a
  // directory that plainly exists where the tool said to look. The live action
  // log carries ten such "path does not exist." failures across host.list_dir
  // and host.read_file.
  //
  // WORSE THAN THE REFUSAL IS THE OTHER HALF. When something DOES exist at that
  // accidental location and the checkout is itself inside the profile tree,
  // containment passes and the caller silently reads or lists a different file
  // from the one it named.
  //
  // NOTHING IS RELAXED. The lexical and canonical containment and exclusion
  // checks below are unchanged and still run on the result, so `../` out of the
  // profile is refused exactly as before (measured: HOME + '../Public/x'
  // resolves outside the profile tree and is refused). Anchoring on HOME can
  // only ever produce a path the fence would already admit, while cwd could
  // produce one outside it. It also removes an ambient dependency in the
  // Windows drive-relative spelling: "C:foo" now resolves under the profile
  // root rather than against the process's per-drive current directory.
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(HOME, value);
  checkContainmentAndExclusions(resolved, { forWrite });
  // Canonicalize through the real filesystem (resolving any reparse point
  // anywhere in the ancestor chain -- a legacy Windows alias or one created
  // locally after the fact) and re-run the exact same checks against that
  // form. The lexical pass above is necessary but not sufficient; this is
  // what actually closes the bypass. The canonical form is used ONLY for
  // this verification -- resolveHostPath still RETURNS the lexical path, so
  // the OS's own reparse-point handling stays the source of truth for what
  // the caller's read/write/list actually touches.
  let canonical;
  try { canonical = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'path could not be canonicalized against the real filesystem.'); }
  if (canonical !== resolved) checkContainmentAndExclusions(canonical, { forWrite });
  if (mustExist) {
    try { fs.accessSync(resolved); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('HOST_PATH_NOT_FOUND', 'path does not exist.');
      failCouldNotCheck('path existence');
    }
  }
  return resolved;
}

// HOST BYTE MEDIATION (2026-09-11). host.read_file, host.write_file and
// host.patch_file coordinate through a dedicated ByteAuthority instance
// (store <state>/state/byte-coordination-host, never the repo.* store) when
// the call carries the transport's private file scope. The legacy functions
// below are unchanged and still answer when the kill switch is off or when a
// caller supplies no transport scope. See docs/byte-coordination.md.
const HOST_BYTE_MEDIATION_ENV = 'TOOLSENABLED_HOST_BYTE_MEDIATION';
const HOST_BYTE_STORE = 'byte-coordination-host';

function hostByteMediationEnabled(env = process.env) {
  const value = env[HOST_BYTE_MEDIATION_ENV];
  if (value === undefined) return true;
  return !/^\s*(?:off|0|false|no|disabled)\s*$/i.test(String(value));
}

// The registry passes these two private keys only for a mediated dispatch.
function mediatedCall(dependencies) {
  return Boolean(dependencies) && typeof dependencies === 'object'
    && (Object.hasOwn(dependencies, 'fileToolContext') || Object.hasOwn(dependencies, 'fileToolInvocation'))
    && hostByteMediationEnabled();
}

function researchFileGuard(dependencies, toolName, target, requireMediation = false) {
  if (!dependencies?.researchAccess) return () => {};
  if (requireMediation && !mediatedCall(dependencies)) {
    fail('RESEARCH_ACCESS_REFUSED', 'Research file access requires active transport-bound byte mediation.');
  }
  const scope = dependencies.researchAccess;
  const assertResearch = () => require('../research-access').enforceResearchAccess(toolName, { path: target }, scope);
  assertResearch();
  return assertResearch;
}

function readFile(args = {}, dependencies = {}) {
  researchFileGuard(dependencies, 'host.read_file', args.path, true);
  if (mediatedCall(dependencies)) return readFileMediated(args, dependencies);
  if (args && (args.startByte !== undefined || args.endByte !== undefined)) {
    assertActive('host.read_file');
    fail(hostByteMediationEnabled() ? 'HOST_FILE_SCOPE_REQUIRED' : 'HOST_BYTE_MEDIATION_OFF',
      'Byte-window reads require mediated host file access through a transport-bound file scope.');
  }
  return readFileLegacy(args, dependencies);
}

function writeFile(args = {}, dependencies = {}) {
  researchFileGuard(dependencies, 'host.write_file', args.path, true);
  if (mediatedCall(dependencies)) return writeFileMediated(args, dependencies);
  return writeFileLegacy(args, dependencies);
}

function readFileLegacy({ path: target } = {}, dependencies = {}) {
  assertActive('host.read_file');
  const resolved = resolveHostPath(target, { mustExist: true });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  // The file contents are the outward result. Admission must be durable
  // before the read so an unavailable/corrupt audit ledger fails closed.
  // Same pattern as host.exec (32faaf7): validation above still throws
  // synchronously; admission is awaited off this thread before the read.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.read_file.intent', resolved, { bytes: stat.size });
  return admitted.then(() => ({ path: resolved, content: fs.readFileSync(resolved, 'utf8'), bytes: stat.size }));
}

function writeFileLegacy({ path: target, content } = {}, dependencies = {}) {
  assertActive('host.write_file');
  if (typeof content !== 'string') fail('HOST_CONTENT_INVALID', 'content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resolved = resolveHostPath(target, { forWrite: true });
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(resolved).isSymbolicLink(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('write target');
    /* ENOENT/ENOTDIR means there is no existing symlink to follow. */
  }
  if (existingIsSymlink) fail('HOST_PATH_FORBIDDEN', 'refusing to write through a symbolic link.');
  let canonicalTarget;
  try { canonicalTarget = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'write target could not be canonicalized for shared-write ownership.'); }
  // Admission happens BEFORE the shared-write lock is taken, not inside its
  // callback: withSharedWrite (src/lib/shared-write-guard.js) releases the
  // lock in a `finally` around a synchronous `operation()` call, so an
  // awaited operation inside it would have its lock released the instant
  // the promise was created, not when the write actually finished.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.write_file.intent', resolved, { bytes: Buffer.byteLength(content, 'utf8') });
  return admitted.then(() => withSharedWrite(canonicalTarget, () => {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, resolved);
    return { path: resolved, bytes: Buffer.byteLength(content, 'utf8') };
  }));
}

// ---------------------------------------------------------------------------
// Mediated host file access.
// ---------------------------------------------------------------------------
let hostAuthorityInstance;
let hostAuthorityStateRoot;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CREATE_OPERATION_ID = /^operation-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fileToolContexts() { return require('../file-tool-capabilities'); }
function byteAuthorityModule() { return require('../region-holds/byte-authority'); }

// The authority resource is the canonical absolute path. Mediated tools refuse
// a spelling whose canonical form the authority would normalize differently
// (surrounding whitespace), so the resource and the published file never differ.
function hostResource(resolved) {
  let canonical;
  try { canonical = canonicalizeForContainment(resolved); }
  catch { fail('HOST_PATH_INVALID', 'path could not be canonicalized against the real filesystem.'); }
  if (canonical !== canonical.trim() || path.basename(canonical) !== path.basename(canonical).trim()) {
    fail('HOST_PATH_INVALID', 'mediated host file tools refuse paths that begin or end with whitespace.');
  }
  return canonical;
}

// The authority's comparison key is case-folded on Windows (resourceKey);
// filesystem calls use the actual canonical spelling, as repo-files does.
const hostKey = value => process.platform === 'win32' ? String(value).toLowerCase() : String(value);

// Re-runs the host fence on the authority's canonical resource at every
// adapter step (materialization, staging, publication, recovery), so a path
// that became protected or aliased after admission is never touched. Returns
// the canonical spelling to operate on.
function hostAdapterPath(resource, { forWrite = false, publicationPath } = {}) {
  if (publicationPath !== undefined && hostKey(publicationPath) !== hostKey(resource)) {
    fail('HOST_FILE_IDENTITY_CHANGED', 'The publication path is not the coordinated resource.');
  }
  const resolved = resolveHostPath(publicationPath === undefined ? resource : publicationPath, { forWrite });
  const canonical = hostResource(resolved);
  if (hostKey(resolved) !== hostKey(resource) || hostKey(canonical) !== hostKey(resource)) {
    fail('HOST_FILE_IDENTITY_CHANGED', 'The file\'s canonical location changed; read it again.');
  }
  return canonical;
}

function materializeHost(resource) {
  const resolved = hostAdapterPath(resource);
  let descriptor;
  let openedSnapshot = false;
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  try {
    const before = fs.lstatSync(resolved, { bigint: true });
    openedSnapshot = true;
    if (before.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
    if (!before.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
    if (before.size > BigInt(MAX_FILE_BYTES)) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(before, fs.fstatSync(descriptor, { bigint: true }))) fail('HOST_FILE_CHANGED_DURING_READ', 'The file changed while opening it; read it again.');
    // One byte beyond the stat size detects a file that grows during the read.
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    hostAdapterPath(resource);
    if (!same(before, after) || !same(after, fs.lstatSync(resolved, { bigint: true })) || BigInt(length) !== after.size) {
      fail('HOST_FILE_CHANGED_DURING_READ', 'The file changed while its bytes were being observed; read it again.');
    }
    return { bytes: Buffer.from(buffer.subarray(0, length)), identity: `${after.dev}:${after.ino}` };
  } catch (error) {
    if ((error?.code === 'ENOENT' || error?.code === 'ENOTDIR') && !openedSnapshot) return { present: false };
    if (error?.code === 'ENOENT') fail('HOST_FILE_CHANGED_DURING_READ', 'The file disappeared while its bytes were being observed; read it again.');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishHost(publication) {
  // Synchronous by design: withSharedWrite must never release its lock around
  // an unfinished Promise. The key is the canonical target, the same key the
  // legacy writer takes, so legacy and mediated writers exclude each other.
  return withSharedWrite(publication.resource, () => publishHostLocked(publication));
}

function publishHostLocked(publication) {
  const { resource, publicationPath, before, after, beforeSha256, afterSha256, assertCurrent } = publication;
  const resolved = hostAdapterPath(resource, { forWrite: true, publicationPath });
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256) fail('HOST_FILE_PUBLICATION_INVALID', 'The prepared bytes are invalid.');
  if (typeof assertCurrent !== 'function') fail('HOST_FILE_SCOPE_REQUIRED', 'Publication requires a live private transport scope.');
  if (publication.beforePresent === false) return publishHostCreate(publication);
  const current = materializeHost(resource).bytes;
  if (!current || sha256(current) !== beforeSha256 || !current.equals(before)) fail('HOST_FILE_CHANGED_BEFORE_WRITE', 'The file changed outside mediated coordination; no write was published.');
  assertCurrent();
  const mode = fs.lstatSync(resolved).mode;
  const temporary = path.join(path.dirname(resolved), `.te-replace-${process.pid}-${crypto.randomUUID()}.tmp`);
  let descriptor;
  let temporaryOwned = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    temporaryOwned = true;
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    // An unmediated editor is outside the authority lock; observed drift still refuses.
    if (!materializeHost(resource).bytes?.equals(before)) fail('HOST_FILE_CHANGED_BEFORE_WRITE', 'The file changed before publication; no write was published.');
    // No await between this private revocation check and publication.
    assertCurrent();
    fs.renameSync(temporary, resolved);
    temporaryOwned = false;
    return { published: true };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    // Only this call's exact, exclusively-created temporary leaf is removed.
    if (temporaryOwned) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function hostCreationPaths({ resource, publicationPath, operationId, stagingPath, createPreparation }) {
  if (typeof publicationPath !== 'string') fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires the authority publication path.');
  const resolved = hostAdapterPath(resource, { forWrite: true, publicationPath });
  if (typeof operationId !== 'string' || !CREATE_OPERATION_ID.test(operationId)) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires an authority-owned operation identity.');
  }
  // The authority derives the stage from publicationPath; it must be the exact
  // sibling of the canonical target, never an arbitrary cleanup path.
  const expected = path.join(path.dirname(publicationPath), '.te-' + operationId + '.create.tmp');
  if ((stagingPath || createPreparation?.stagingPath) !== expected || path.dirname(expected) !== path.dirname(resolved)) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The staged creation path is not the exact operation-owned sibling.');
  }
  return { resolved, stagingPath: expected };
}

function hostCreationStat(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function verifyHostCreationLeaf(filename, preparation, links) {
  const before = hostCreationStat(filename);
  const matches = stat => stat && stat.isFile() && !stat.isSymbolicLink()
    && stat.dev.toString() === preparation.device && stat.ino.toString() === preparation.inode
    && stat.size === BigInt(preparation.bytes) && stat.nlink === BigInt(links);
  if (!matches(before)) fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf no longer has its prepared identity and exact link count.');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!matches(fs.fstatSync(descriptor, { bigint: true }))) fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while opening.');
    const buffer = Buffer.alloc(preparation.bytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const final = hostCreationStat(filename);
    if (!matches(after) || !matches(final) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.mtimeNs !== final.mtimeNs || after.ctimeNs !== final.ctimeNs
        || count !== preparation.bytes || sha256(buffer.subarray(0, count)) !== preparation.sha256) {
      fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while its prepared bytes were verified.');
    }
  } finally { fs.closeSync(descriptor); }
}

function prepareHostCreate(preparation) {
  const { after, afterSha256, assertCurrent } = preparation;
  const located = hostCreationPaths(preparation);
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256 || typeof assertCurrent !== 'function') {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation requires bounded prepared bytes and a live private scope.');
  }
  assertCurrent();
  // The legacy writer created missing parent directories; so does creation.
  fs.mkdirSync(path.dirname(located.resolved), { recursive: true });
  hostCreationPaths(preparation);
  const descriptor = fs.openSync(located.stagingPath, 'wx');
  // Before PREPARED, a crash can leave an unreferenced exclusive stage. It is
  // never a published target, and recovery must not infer ownership by age.
  try {
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const result = { stagingPath: located.stagingPath, device: stat.dev.toString(), inode: stat.ino.toString(), sha256: afterSha256, bytes: after.length };
    verifyHostCreationLeaf(located.stagingPath, result, 1);
    assertCurrent();
    return result;
  } finally { fs.closeSync(descriptor); }
}

function publishHostCreate(publication) {
  const { resolved, stagingPath } = hostCreationPaths(publication);
  const { createPreparation, assertCurrent } = publication;
  if (publication.op !== 'write' || publication.publicationMode !== 'create-only') {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation must use atomic no-replace publication.');
  }
  verifyHostCreationLeaf(stagingPath, createPreparation, 1);
  hostCreationPaths(publication);
  assertCurrent();
  // link() is an atomic no-replace publication: EEXIST never erases a file
  // another writer created first.
  try { fs.linkSync(stagingPath, resolved); }
  catch (error) {
    if (error && error.code === 'EEXIST') {
      // Proven unapplied: retire only this operation's own verified stage.
      verifyHostCreationLeaf(stagingPath, createPreparation, 1);
      fs.unlinkSync(stagingPath);
      throw Object.assign(new HostControlError('HOST_FILE_CREATE_CONFLICT',
        'Another writer created this file first; nothing was written. Read it with host.read_file and reconcile.'), { publicationNotApplied: true });
    }
    throw error;
  }
  reconcileHostCreate({ ...publication, afterBytes: publication.after.length });
  return { published: true, publicationMode: 'create-only' };
}

function reconcileHostCreate(publication) {
  const { resolved, stagingPath } = hostCreationPaths(publication);
  const { createPreparation: preparation, afterSha256, afterBytes } = publication;
  if (!preparation || preparation.sha256 !== afterSha256 || preparation.bytes !== afterBytes
      || !Number.isSafeInteger(afterBytes) || afterBytes < 0 || afterBytes > MAX_FILE_BYTES) {
    fail('HOST_FILE_CREATE_IDENTITY_INVALID', 'Creation recovery requires the exact bounded prepared digest.');
  }
  const stage = hostCreationStat(stagingPath);
  const target = hostCreationStat(resolved);
  const links = stage && target ? 2 : 1;
  // Matching bytes alone are not this publication's identity. A replaced
  // target, an unrelated hard link or a changed stage remains UNKNOWN.
  if (target) verifyHostCreationLeaf(resolved, preparation, links);
  if (stage) {
    verifyHostCreationLeaf(stagingPath, preparation, links);
    hostCreationPaths(publication);
    fs.unlinkSync(stagingPath);
  }
  if (target) verifyHostCreationLeaf(resolved, preparation, 1);
  return { reconciled: true };
}

function hostByteAuthority(scope) {
  const stateRoot = require('../runtime-state-root').statePath();
  if (!hostAuthorityInstance || hostAuthorityStateRoot !== stateRoot) {
    hostAuthorityInstance = byteAuthorityModule().createByteAuthority({
      stateRoot, storeName: HOST_BYTE_STORE, maxResourceBytes: MAX_FILE_BYTES,
      readSetScope: 'resource', writeRequiresObservation: true, observeOwnWrites: true, pruneCommittedPayloads: true,
      materialize: materializeHost, publish: publishHost,
      prepareCreate: prepareHostCreate, reconcileCreateStage: reconcileHostCreate
    });
    hostAuthorityStateRoot = stateRoot;
  }
  if (scope) {
    const contexts = fileToolContexts();
    const binding = contexts.requireFileToolContext(scope);
    const authority = hostAuthorityInstance;
    contexts.onFileToolContextRetired(scope, authority, reason => authority.closeLaunch({ binding, reason }));
  }
  return hostAuthorityInstance;
}

function decodeHostWindow(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('HOST_FILE_UTF8_BOUNDARY_INVALID', 'The requested byte window is not complete UTF-8 text; use character-aligned startByte/endByte offsets or read the whole file.'); }
}

function describeRepairs(repairs) {
  if (!Array.isArray(repairs) || repairs.length === 0) return '';
  const reasons = {
    UNMEDIATED_CHANGE: 'changed outside mediated tools (host.exec, a native tool or another process)',
    WHOLE_FILE_WRITE: 'replaced by a whole-file write from another session',
    MEDIATED_WRITE: 'patched by another session',
    OBSERVATION_EXPIRED: 'your observation expired',
    OBSERVED_BYTES_CHANGED: 'its bytes changed',
    DEPENDENCY_ABSENT: 'the file was deleted',
    DEPENDENCY_UNREADABLE: 'the file could not be read'
  };
  const shown = repairs.slice(0, 4).map(item => {
    const range = Number.isSafeInteger(item.startByte) && Number.isSafeInteger(item.endByte) && !item.requiresWholeFileRead
      ? ` (bytes ${item.startByte}-${item.endByte})` : '';
    return (reasons[item.reason] || 'stale') + range;
  });
  return ` Detail: ${[...new Set(shown)].join('; ')}${repairs.length > 4 ? '; ...' : ''}.`;
}

// Authority refusals keep their exact meaning; the two an agent must act on
// get a host code and a sentence that says what to do next.
function hostRefusal(error, displayPath, action) {
  const { ByteCoordinationRefusal } = byteAuthorityModule();
  if (!(error instanceof ByteCoordinationRefusal)) throw error;
  if (error.code === 'BYTE_READ_SET_STALE') {
    throw Object.assign(new HostControlError('HOST_FILE_STALE',
      `${displayPath} changed since this session read it (another agent's write, host.exec, a native tool or an external process). Nothing was ${action}. Re-read it with host.read_file (the whole file, or the changed byte window), reconcile your edit with the current content, then retry.${describeRepairs(error.details.repairs)}`),
    { details: { resource: displayPath, repairs: error.details.repairs }, cause: error });
  }
  if (error.code === 'BYTE_READ_REQUIRED') {
    throw Object.assign(new HostControlError('HOST_FILE_READ_REQUIRED',
      `This session has not read the current content of ${displayPath}${action === 'patched' ? ' where this patch applies' : ''}. Nothing was ${action}. Read it with host.read_file first, then retry; for an edit, prefer host.patch_file.`),
    { details: { resource: displayPath }, cause: error });
  }
  if (error.code === 'BYTE_CREATE_CONFLICT') {
    throw Object.assign(new HostControlError('HOST_FILE_STALE',
      `Another writer created ${displayPath} first. Nothing was ${action}. Read it with host.read_file and reconcile, then retry.`),
    { details: { resource: displayPath, repairs: [] }, cause: error });
  }
  throw error;
}

function committedAfterRevocation(applied, resource, what, error) {
  return Object.assign(new HostControlError('BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED',
    `The ${what} committed before this scope was revoked; inspect before retrying.`), {
    details: { publicationCommitted: true, operationId: applied.receipt.operationId,
      noOp: applied.receipt.noOp, resource, causeCode: error.code || 'SCOPE_REVOKED' }
  });
}

function beginMediated(dependencies, toolName, target) {
  const assertResearch = researchFileGuard(dependencies, toolName, target, true);
  const contexts = fileToolContexts();
  const scope = dependencies.fileToolContext;
  const binding = contexts.requireFileToolContext(scope);
  const invocation = dependencies.fileToolInvocation;
  const currentToolInvocation = contexts.consumeFileToolInvocation(invocation, scope, toolName);
  const assertCurrent = () => {
    assertActive(toolName);
    assertResearch();
    return contexts.assertFileToolInvocationCurrent(invocation, scope, toolName);
  };
  return { scope, binding, currentToolInvocation, assertCurrent };
}

function checkedWindow(value, field) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    fail('HOST_INPUT_INVALID', `${field} must be a non-negative integer byte offset.`);
  }
  return value;
}

function readFileMediated({ path: target, startByte, endByte } = {}, dependencies = {}) {
  assertActive('host.read_file');
  checkedWindow(startByte, 'startByte');
  checkedWindow(endByte, 'endByte');
  const resolved = resolveHostPath(target);
  // Existence is asked exactly as the legacy reader asked it (accessSync
  // follows links), so a missing file or dangling link refuses identically.
  let exists = true;
  try { fs.accessSync(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('path existence');
    exists = false;
  }
  if (!exists) {
    let dangling = false;
    try { dangling = fs.lstatSync(resolved).isSymbolicLink(); } catch { /* absent */ }
    if (dangling) fail('HOST_PATH_NOT_FOUND', 'path does not exist.');
    // Observing absence retires this scope's stale observations of a vanished
    // file (so it may create it again); it releases no content.
    const mediated = beginMediated(dependencies, 'host.read_file', resolved);
    const resource = hostResource(resolved);
    return hostByteAuthority(mediated.scope).observeAbsence({ binding: mediated.binding, resource, assertCurrent: mediated.assertCurrent })
      .then(() => fail('HOST_PATH_NOT_FOUND', 'path does not exist.'));
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resource = hostResource(resolved);
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.read_file', resolved);
  const windowed = startByte !== undefined || endByte !== undefined;
  // Admission is durable before any byte is read, exactly as in the legacy path.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.read_file.intent', resolved, windowed
    ? { bytes: stat.size, startByte: startByte ?? 0, endByte: endByte ?? null } : { bytes: stat.size });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).observeRead({
      binding, resource, startByte, endByte, assertCurrent,
      // A window must be character-aligned UTF-8; a whole file decodes as the
      // legacy reader did (invalid sequences become U+FFFD), never refused.
      validateRead: windowed ? ({ bytes }) => decodeHostWindow(bytes) : undefined
      });
  }).then(observed => {
    assertCurrent();
    const receipt = observed.receipt;
    return {
      path: resolved,
      content: windowed ? decodeHostWindow(observed.bytes) : observed.bytes.toString('utf8'),
      bytes: observed.bytes.length,
      ...(windowed ? { startByte: receipt.startByte, endByte: receipt.endByte, totalBytes: receipt.totalBytes } : {}),
      version: receipt.resourceVersion,
      receipt,
      invalidations: observed.invalidations,
      currentToolInvocation
    };
  }, error => hostRefusal(error, resolved, 'read'));
}

function writeFileMediated({ path: target, content } = {}, dependencies = {}) {
  assertActive('host.write_file');
  if (typeof content !== 'string') fail('HOST_CONTENT_INVALID', 'content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  const resolved = resolveHostPath(target, { forWrite: true });
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(resolved).isSymbolicLink(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('write target');
  }
  if (existingIsSymlink) fail('HOST_PATH_FORBIDDEN', 'refusing to write through a symbolic link.');
  const resource = hostResource(resolved);
  const bytes = Buffer.from(content, 'utf8');
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.write_file', resolved);
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.write_file.intent', resolved, { bytes: bytes.length });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).applyWrite({ binding, resource, bytes, assertCurrent });
  })
    .then(applied => {
      try { assertCurrent(); }
      catch (error) { throw committedAfterRevocation(applied, resolved, 'whole-file write', error); }
      return {
        path: resolved, bytes: bytes.length, created: applied.created,
        version: applied.receipt.resourceVersion, receipt: applied.receipt,
        ...(applied.observation ? { observation: applied.observation } : {}),
        currentToolInvocation
      };
    }, error => hostRefusal(error, resolved, 'written'));
}

function patchFile({ path: target, oldText, newText } = {}, dependencies = {}) {
  assertActive('host.patch_file');
  researchFileGuard(dependencies, 'host.patch_file', target, true);
  if (!hostByteMediationEnabled()) {
    fail('HOST_BYTE_MEDIATION_OFF', `host.patch_file requires host byte mediation, which is turned off on this machine (${HOST_BYTE_MEDIATION_ENV}=off). Use host.read_file and host.write_file instead.`);
  }
  if (typeof oldText !== 'string' || oldText.length === 0) fail('HOST_INPUT_INVALID', 'oldText must be a non-empty string.');
  if (typeof newText !== 'string') fail('HOST_INPUT_INVALID', 'newText must be a string.');
  const resolved = resolveHostPath(target, { forWrite: true, mustExist: true });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail('HOST_PATH_FORBIDDEN', 'refusing to patch through a symbolic link.');
  if (!stat.isFile()) fail('HOST_PATH_INVALID', 'path is not a regular file.');
  if (stat.size > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  if (!mediatedCall(dependencies)) {
    fail('HOST_FILE_SCOPE_REQUIRED', 'host.patch_file requires the transport-bound file scope of an MCP session; it has no unmediated form.');
  }
  const resource = hostResource(resolved);
  const expected = Buffer.from(oldText, 'utf8');
  const replacement = Buffer.from(newText, 'utf8');
  const { scope, binding, currentToolInvocation, assertCurrent } = beginMediated(dependencies, 'host.patch_file', resolved);
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.patch_file.intent', resolved, {
    replacedBytes: expected.length, replacementBytes: replacement.length
  });
  return admitted.then(() => {
    assertCurrent();
    return hostByteAuthority(scope).applyPatch({
      binding, resource, assertCurrent,
      derivePatch: ({ bytes }) => {
        const first = bytes.indexOf(expected);
        if (first === -1) fail('HOST_FILE_PATCH_MISMATCH', 'oldText was not found in the current file; read it again and retry with an exact span.');
        if (bytes.indexOf(expected, first + 1) !== -1) fail('HOST_FILE_PATCH_AMBIGUOUS', 'oldText occurs more than once; include more surrounding text so the match is unique.');
        if (bytes.length - expected.length + replacement.length > MAX_FILE_BYTES) fail('HOST_FILE_TOO_LARGE', `the patched file would exceed the ${MAX_FILE_BYTES}-byte limit.`);
        return { startByte: first, endByte: first + expected.length, replacement };
      }
      });
  }).then(applied => {
    try { assertCurrent(); }
    catch (error) { throw committedAfterRevocation(applied, resolved, 'patch', error); }
    return { path: resolved, bytes: applied.bytes, replacements: 1, startByte: applied.startByte, endByte: applied.endByte,
      version: applied.receipt.resourceVersion, receipt: applied.receipt, currentToolInvocation };
  }, error => hostRefusal(error, resolved, 'patched'));
}

// Research listings retain and check the real directory identity across audit
// admission and use a bounded directory handle for the synchronous snapshot.
function researchDirectorySnapshot(resolved, assertResearch) {
  const before = fs.lstatSync(resolved, { bigint: true });
  // Windows security maintenance can update directory ctime during audit.
  // Stable identity and entry modification time describe this listing.
  const same = value => ['dev', 'ino', 'mtimeNs'].every(key => value[key] === before[key]);
  const assertDirectory = () => {
    assertResearch();
    const current = fs.lstatSync(resolved, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current)) {
      fail('RESEARCH_ACCESS_REFUSED', 'The research directory changed while it was being listed.');
    }
  };
  assertDirectory();
  return { assertDirectory, read() {
    assertDirectory();
    let descriptor;
    let directory;
    try {
      descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!same(fs.fstatSync(descriptor, { bigint: true }))) {
        fail('RESEARCH_ACCESS_REFUSED', 'The research directory changed while opening it.');
      }
      directory = fs.opendirSync(resolved);
      assertDirectory();
      const entries = [];
      let entry;
      while (entries.length < MAX_LIST_ENTRIES && (entry = directory.readSync()) !== null) entries.push(entry);
      const rows = listDirEntries(resolved, entries);
      assertDirectory();
      if (!same(fs.fstatSync(descriptor, { bigint: true }))) {
        fail('RESEARCH_ACCESS_REFUSED', 'The research directory changed while reading it.');
      }
      return rows;
    } finally {
      try { if (directory) directory.closeSync(); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
  } };
}

function listDir({ path: target = HOME } = {}, dependencies = {}) {
  assertActive('host.list_dir');
  const resolved = resolveHostPath(target, { mustExist: true });
  if (!fs.lstatSync(resolved).isDirectory()) fail('HOST_PATH_INVALID', 'path is not a directory.');
  const assertResearch = researchFileGuard(dependencies, 'host.list_dir', resolved);
  const researchListing = dependencies.researchAccess ? researchDirectorySnapshot(resolved, assertResearch) : null;
  // Admission precedes readdirSync and the per-entry metadata reads below.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const recordAsync = dependencies.recordAsync || auditAdmission.recordAsync;
  const admitted = requireRecordAsync('host.list_dir.intent', resolved, {});
  return admitted.then(() => {
    const entries = researchListing ? researchListing.read() : listDirEntries(resolved);
    // The result record rides the same off-thread admission as the intent,
    // same shape as host.exec's result record (32faaf7): a failed record
    // write is reported on stderr, redacted, and never turns a completed
    // listing into a lost answer.
    return Promise.resolve()
      .then(() => recordAsync('host.list_dir', resolved, { entries: entries.length }))
      .catch(auditError => {
        process.stderr.write(`ToolsEnabled host.list_dir audit write failed: ${audit.redact(auditError && auditError.message || String(auditError))}\n`);
      })
      .then(() => {
        researchListing?.assertDirectory();
        return { path: resolved, entries };
      });
  });
}

function listDirEntries(resolved, snapshot) {
  return (snapshot || fs.readdirSync(resolved, { withFileTypes: true }))
    // Listing a parent must not disclose the names of protected stores (or a
    // harmlessly-named reparse point whose target is one). Fail closed for a
    // child that disappears while the directory is being inspected.
    .filter(entry => {
      const lexicalChild = path.join(resolved, entry.name);
      if (isCredentialProtectedPath(lexicalChild)) return false;
      try {
        const canonicalChild = canonicalizeForContainment(lexicalChild);
        return !isCredentialProtectedPath(canonicalChild);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        failCouldNotCheck('directory entry');
      }
    })
    .slice(0, MAX_LIST_ENTRIES)
    .map(entry => {
      const row = { name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' };
      if (row.type === 'file') {
        try { row.bytes = fs.lstatSync(path.join(resolved, entry.name)).size; }
        catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failCouldNotCheck('directory entry metadata');
          row.bytes = null;
        }
      }
      return row;
    });
}

async function linuxProcesses(nameFilter) {
  let names;
  try { names = (await fs.promises.readdir('/proc')).filter(name => /^[1-9]\d*$/.test(name)); }
  catch { throw new HostControlError('HOST_PROCESS_LIST_FAILED', 'the process list could not be read.'); }
  const processes = [];
  // Read kernel metadata, never command lines or environment blocks. Bound
  // simultaneous reads so a host with many processes does not exhaust FDs.
  for (let offset = 0; offset < names.length; offset += 16) {
    const rows = await Promise.all(names.slice(offset, offset + 16).map(async name => {
      let handle;
      try {
        handle = await fs.promises.open(`/proc/${name}/status`, 'r');
        const buffer = Buffer.alloc(32 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const status = buffer.subarray(0, bytesRead).toString('utf8');
        const processName = /^Name:\s*([^\r\n]+)/m.exec(status)?.[1];
        const pid = Number(/^Pid:\s*(\d+)$/m.exec(status)?.[1]);
        if (!processName || pid !== Number(name)) return null;
        if (nameFilter && !processName.toLowerCase().includes(nameFilter.toLowerCase())) return null;
        const rss = /^VmRSS:\s*(\d+) kB$/m.exec(status);
        const bytes = rss ? Number(rss[1]) * 1024 : null;
        return { pid, name: processName, workingSetBytes: Number.isSafeInteger(bytes) ? bytes : null, startTime: null };
      } catch (error) {
        // Processes may exit during the snapshot; hidepid may restrict rows.
        if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return null;
        throw new HostControlError('HOST_PROCESS_LIST_FAILED', 'the process list could not be read.');
      } finally { if (handle) await handle.close(); }
    }));
    processes.push(...rows.filter(Boolean));
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { count: processes.length, processes };
}

function listProcesses({ nameFilter } = {}, dependencies = {}) {
  assertActive('host.list_processes');
  if (nameFilter !== undefined && (typeof nameFilter !== 'string' || nameFilter.length > 100)) {
    fail('HOST_INPUT_INVALID', 'nameFilter must be a string of at most 100 characters.');
  }
  // Do not start the process inspection until the intent is durably audited.
  const requireRecordAsync = dependencies.requireRecordAsync || auditAdmission.requireRecordAsync;
  const admitted = requireRecordAsync('host.list_processes.intent', 'local', { filtered: Boolean(nameFilter) });
  if (process.platform === 'linux') return admitted.then(() => linuxProcesses(nameFilter));
  return admitted.then(() => new Promise((resolve, reject) => {
    // Fixed argv, no shell: the filter is applied in JS below, never
    // interpolated into a command string.
    execFile('\\\\.\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      'Get-Process | Select-Object Id,ProcessName,WorkingSet,StartTime | ConvertTo-Json -Compress -Depth 2'
    ], { windowsHide: true, timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES, env: safeLaunchEnvironment() }, (error, stdout) => {
      if (error) return reject(new HostControlError('HOST_PROCESS_LIST_FAILED', 'the process list could not be read.'));
      let rows;
      try { rows = JSON.parse(String(stdout || '[]')); } catch { return reject(new HostControlError('HOST_PROCESS_LIST_INVALID', 'the process list was not valid JSON.')); }
      const list = (Array.isArray(rows) ? rows : [rows])
        .filter(row => row && typeof row.ProcessName === 'string')
        .filter(row => !nameFilter || row.ProcessName.toLowerCase().includes(nameFilter.toLowerCase()))
        .map(row => ({ pid: row.Id, name: row.ProcessName, workingSetBytes: row.WorkingSet ?? null, startTime: row.StartTime ?? null }));
      resolve({ count: list.length, processes: list });
    });
  }));
}

// A timeout that only ends the shell is not a timeout on Windows.  PowerShell
// (and cmd.exe) can leave a child process running after their own handle has
// gone away, so `execFile({ timeout })` is not sufficient here: Node kills the
// direct child and reports a timeout while the work it started can continue.
//
// Windows retains a Job Object; Linux retains the subreaper/pidfd supervisor.
// Both cancellation paths wait for their own descendant scope to become empty.
function killExecTree(child, { platform = process.platform } = {}) {
  if (!child) return null;
  if (['win32', 'linux'].includes(platform) && typeof child.terminateJob === 'function') {
    return child.terminateJob();
  }
  if (typeof child.kill !== 'function') return null;
  try { return child.kill('SIGTERM'); }
  catch { return false; }
}

function appendBoundedOutput(chunks, bytes, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  if (bytes >= MAX_OUTPUT_BYTES) return { bytes, capped: true };
  const remaining = MAX_OUTPUT_BYTES - bytes;
  if (value.length <= remaining) {
    chunks.push(value);
    return { bytes: bytes + value.length, capped: false };
  }
  if (remaining > 0) chunks.push(value.subarray(0, remaining));
  return { bytes: MAX_OUTPUT_BYTES, capped: true };
}

// Real command execution at the owner's own (non-elevated) privilege level.
// The command string is passed to a shell deliberately -- pipelines and
// redirection are part of what "run commands on my machine" means, and
// pretending otherwise while still handing over arbitrary argv would be
// security theater, not a boundary. The genuine boundaries are: no
// elevation, kill-switch gated, wall-clock bounded, output bounded, cwd
// containment-checked, and the exact command line written to the signed
// audit ledger BEFORE it runs (so a command that hangs or kills the process
// is still on the record).
function exec({ command, cwd, timeoutMs, shell } = {}, dependencies = {}) {
  assertActive('host.exec');
  const platform = dependencies.platform || process.platform;
  if (!['win32', 'linux'].includes(platform)) fail('HOST_PLATFORM_UNSUPPORTED', 'Host commands require Windows or Linux.');
  if (shell === undefined) shell = platform === 'linux' ? 'sh' : 'powershell';
  if (typeof command !== 'string' || !command.trim()) fail('HOST_INPUT_INVALID', 'command must be a non-empty string.');
  if (command.length > 8192 || command.includes('\0')) fail('HOST_INPUT_INVALID', 'command must be at most 8192 characters without NUL bytes.');
  const shells = platform === 'linux' ? ['sh', 'bash'] : ['powershell', 'cmd'];
  if (!shells.includes(shell)) fail('HOST_INPUT_INVALID', `shell must be ${shells.join(' or ')} on this platform.`);
  const resolvedCwd = cwd === undefined ? HOME : resolveHostPath(cwd, { mustExist: true });
  const limit = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (!Number.isSafeInteger(limit) || limit < 1000 || limit > MAX_TIMEOUT_MS) {
    fail('HOST_INPUT_INVALID', `timeoutMs must be an integer from 1000 through ${MAX_TIMEOUT_MS}.`);
  }
  // Cancellation authority comes from the transport, never from tool arguments.
  const signal = dependencies.signal;
  const cancelledError = () => Object.assign(new Error('The operation was cancelled.'), {
    name: 'AbortError', code: 'ABORT_ERR'
  });
  const assertLaunchPolicyCurrent = () => {
    try { assertActive('host.exec'); }
    catch (error) {
      // Native wrappers report a bounded code in their terminal receipt. Keep
      // policy refusal distinguishable from an unexplained non-start.
      if (!error.code) error.code = 'HOST_EXEC_POLICY_REFUSED';
      throw error;
    }
  };
  if (signal?.aborted) return Promise.reject(cancelledError());

  // requireRecord semantics (not record): if the durable audit write fails,
  // the command does not run. An unlogged arbitrary command is exactly what
  // this capability must never produce.
  //
  // ADMITTED OFF THIS THREAD, AWAITED BEFORE THE LAUNCH. This line used to
  // be a synchronous audit.requireRecord(), and a required record forces the
  // vault anchor write, which is two PowerShell starts (secrets.ps1 get, then
  // set-monotonic-stdin): 1.2 s idle on this machine and 2 to 4 s under load.
  // The owner host runs inside the desktop app's main process, so every
  // agent's shell command parked the thread the person's window is drawn on
  // for that long. MEASURED 2026-09-04 on the owner's Live process with four
  // circles: 46 of 53 main-thread stalls in fifteen minutes contained this
  // record. The guarantee is unchanged -- nothing is spawned until the
  // admission has answered durable, and a refusal is thrown to the caller as
  // before -- only the thread that does the waiting has changed. The
  // validation above still throws synchronously; only the audit wait and the
  // launch are behind the promise, which the dispatcher already awaits.
  const admitted = dependencies.requireRecordAsync
    ? dependencies.requireRecordAsync('host.exec.intent', resolvedCwd, { shell, timeoutMs: limit, command })
    : auditAdmission.requireRecordAsync('host.exec.intent', resolvedCwd, { shell, timeoutMs: limit, command });
  const recordResult = dependencies.recordAsync || auditAdmission.recordAsync;

  const file = platform === 'linux' ? `/bin/${shell}` : shell === 'cmd'
    ? '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\cmd.exe'
    : '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const args = platform === 'linux' ? (shell === 'bash' ? ['--noprofile', '--norc', '-c', command] : ['-c', command]) : shell === 'cmd'
    ? ['/d', '/s', '/c', command]
    : ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', command];

  const launchImpl = dependencies.spawnInJobImpl || (platform === 'linux' ? spawnLinuxOwned : windowsJob.spawnInJob);
  const setTimeoutImpl = dependencies.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl || clearTimeout;
  const nowImpl = dependencies.nowImpl || Date.now;
  const killTree = dependencies.killTree || killExecTree;

  return admitted.then(() => new Promise((resolve, reject) => {
    // Admission may have been waiting on the audit writer when Stop arrived.
    if (signal?.aborted) throw cancelledError();
    // The person can activate the kill switch or suspend policy while the
    // intent waits for durable admission. Entry-time authority is stale then.
    // Recheck immediately before any command process can be created.
    assertLaunchPolicyCurrent();
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputCapped = false;
    let timedOut = false;
    let cancelled = false;
    let terminationRequested = false;
    let terminationPending = false;
    let terminationReceipt = null;
    let terminationFailure = null;
    let terminalEvent = null;
    let settled = false;
    let timer = null;
    let cleanupTimer = null;
    let child;
    let executionError = null;

    const finish = (error, exitCode, force = false) => {
      if (settled) return;
      if (cancelled && terminationPending && !force) {
        terminalEvent = { error, exitCode };
        return;
      }
      if (cancelled && platform === 'win32' && !terminationFailure && terminationReceipt?.activeProcesses !== 0) {
        terminationFailure = Object.assign(new Error('Command cancellation has no empty Job receipt.'), {
          code: 'HOST_EXEC_CLEANUP_UNPROVED'
        });
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (timer !== null) clearTimeoutImpl(timer);
      if (cleanupTimer !== null) clearTimeoutImpl(cleanupTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const result = {
        command, cwd: resolvedCwd, shell,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        timedOut,
        cancelled,
        outputTruncated: outputCapped,
        stdout,
        stderr,
        terminationFailure: terminationFailure ? {
          code: typeof terminationFailure.code === 'string' ? terminationFailure.code : 'HOST_EXEC_TERMINATION_FAILED',
          message: String(terminationFailure.message || 'Command cleanup failed.').slice(0, 300)
        } : null,
        ...(error ? { error: {
          code: typeof error.code === 'string' ? error.code : 'HOST_EXEC_FAILED',
          message: audit.redact(String(error.message || 'Command execution failed.')).slice(0, 300)
        } } : {}),
        // A timeout or output cap is not success even if a race reports exit
        // zero as the tree is being stopped.  That is the same honesty rule as
        // the audit outcome: no completed result without a completed command.
        ok: !error && !terminationFailure && !timedOut && !cancelled && !outputCapped && exitCode === 0
      };
      // The result record rides the same off-thread admission as the intent,
      // and the answer still waits for it, so the ledger carries the outcome
      // before the caller reads it -- the ordering the synchronous record
      // gave, without the writer-lock spin on this thread. A failed result
      // record is reported on stderr, as the dispatcher's own record failure
      // is, and never turns a completed command into a lost answer.
      Promise.resolve()
        .then(() => recordResult('host.exec.result', resolvedCwd, {
          exitCode: result.exitCode,
          timedOut,
          cancelled,
          outputTruncated: outputCapped,
          ok: result.ok,
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          terminationFailureCode: result.terminationFailure && result.terminationFailure.code
        }))
        .catch(auditError => {
          process.stderr.write(`ToolsEnabled host.exec.result audit write failed: ${audit.redact(auditError && auditError.message || String(auditError))}\n`);
        })
        .then(() => {
          if (!cancelled) { resolve(result); return; }
          if (terminationFailure || error) {
            reject(Object.assign(new Error('Command cancellation could not prove cleanup.'), {
              code: 'HOST_EXEC_TERMINATION_FAILED',
              details: { cleanupCode: terminationFailure?.code || error?.code || 'HOST_EXEC_CLEANUP_UNPROVED' }
            }));
            return;
          }
          reject(cancelledError());
        });
    };

    const terminate = reason => {
      if (terminationRequested || !child) return;
      terminationRequested = true;
      terminationPending = true;
      if (reason === 'timeout') timedOut = true;
      const cleanupDeadlineMs = Number.isSafeInteger(dependencies.terminationDeadlineMs)
        ? dependencies.terminationDeadlineMs : 15_000;
      cleanupTimer = setTimeoutImpl(() => {
        if (!terminationFailure) {
          terminationFailure = Object.assign(new Error('Command cleanup did not settle within the bounded deadline.'), {
            code: 'HOST_EXEC_TERMINATION_DEADLINE'
          });
        }
        finish(terminationFailure, null, true);
      }, cleanupDeadlineMs);
      cleanupTimer?.unref?.();
      let requested;
      try { requested = killTree(child, { ...dependencies, platform }); }
      catch (error) { requested = Promise.reject(error); }
      Promise.resolve(requested).then(async receipt => {
        terminationReceipt = receipt;
        if (cancelled && platform === 'win32') {
          if (!receipt || receipt.activeProcesses !== 0) {
            throw Object.assign(new Error('Command cancellation has no empty Job receipt.'), {
              code: 'HOST_EXEC_CLEANUP_UNPROVED'
            });
          }
          // An empty Job and the retained wrapper closing are separate proofs.
          if (child.jobClosed) {
            const closed = await child.jobClosed;
            if (closed?.failure) throw closed.failure;
          }
        } else if (cancelled && receipt === false) {
          throw Object.assign(new Error('Command cancellation was refused.'), { code: 'HOST_EXEC_CLEANUP_UNPROVED' });
        }
      }).catch(async error => {
        terminationFailure = error;
        // Preserve the original refusal even when the retained-handle fallback
        // succeeds. Neither a broken control pipe nor a deadline is "cancelled".
        if (platform === 'win32' && typeof child.terminateRetainedWrapper === 'function') {
          try { await child.terminateRetainedWrapper(); }
          catch { /* the original cleanup refusal remains authoritative */ }
        } else {
          try { child.kill('SIGTERM'); } catch { /* bounded deadline remains */ }
        }
      }).finally(() => {
        terminationPending = false;
        if (terminalEvent) finish(terminationFailure || terminalEvent.error, terminalEvent.exitCode);
      });
    };

    function onAbort() {
      if (settled) return;
      cancelled = true;
      terminate('cancel');
    }

    const append = (which, chunk) => {
      const target = which === 'stdout' ? stdoutChunks : stderrChunks;
      const before = which === 'stdout' ? stdoutBytes : stderrBytes;
      const result = appendBoundedOutput(target, before, chunk);
      if (which === 'stdout') stdoutBytes = result.bytes;
      else stderrBytes = result.bytes;
      if (result.capped) {
        outputCapped = true;
        terminate('output-cap');
      }
    };

    const startedAt = nowImpl();
    try {
      child = launchImpl(file, args, {
        cwd: resolvedCwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: deleteEnvNames(safeLaunchEnvironment(process.env, { context: 'host control command' }),
          ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH'])
      }, {
        ...(dependencies.windowsJobDependencies || {}),
        platform,
        spawnImpl: dependencies.spawnImpl,
        safeLaunchEnvironment,
        beforeRootSpawn() {
          const priorCheck = dependencies.windowsJobDependencies?.beforeRootSpawn?.();
          if (priorCheck && typeof priorCheck.then === 'function') {
            Promise.resolve(priorCheck).catch(() => {});
            fail('HOST_EXEC_ADMISSION_ASYNC', 'The command launch check must be synchronous.');
          }
          // Both retained native wrappers yield before authorizing their root.
          // Refresh after that handshake, immediately before START/OWNER.
          if (signal?.aborted) throw cancelledError();
          assertLaunchPolicyCurrent();
        }
      });
    } catch (error) {
      finish(error, null);
      return;
    }
    if (!child || typeof child.once !== 'function') {
      finish(new Error('host.exec child process did not expose lifecycle events'), null);
      return;
    }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', chunk => append('stdout', chunk));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', chunk => append('stderr', chunk));
    child.once('error', error => {
      executionError = error;
      if (!child.jobOutcome) finish(error, null);
    });
    child.once('close', code => {
      if (!child.jobOutcome) { finish(executionError || terminationFailure, code); return; }
      Promise.resolve(child.jobOutcome).then(outcome => {
        if (!outcome || outcome.activeProcesses !== 0) {
          terminationFailure = terminationFailure || Object.assign(new Error('Command descendant cleanup could not be verified.'),
            { code: outcome?.reasonCode || 'HOST_EXEC_CLEANUP_UNPROVEN' });
        } else if (outcome.reasonCode) {
          executionError = executionError || Object.assign(new Error('The command could not complete.'), { code: outcome.reasonCode });
        }
        finish(executionError || terminationFailure, code);
      }, error => { terminationFailure = error; finish(error, null); });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Start from the wall-clock instant immediately before spawn(), rather
    // than handing Node an opaque per-child timeout.  This bounds the entire
    // command lifetime and lets timeout cleanup reach descendants first.
    const elapsed = Math.max(0, nowImpl() - startedAt);
    if (!settled) {
      timer = setTimeoutImpl(() => terminate('timeout'), Math.max(0, limit - elapsed));
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }));
}

module.exports = {
  HostControlError, HOME, MAX_FILE_BYTES, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, EXCLUDED_PATH_PATTERNS,
  HOST_BYTE_MEDIATION_ENV, HOST_BYTE_STORE, hostByteMediationEnabled,
  resolveHostPath, readFile, writeFile, patchFile, listDir, listProcesses, killExecTree, appendBoundedOutput, exec,
  // Test seam for the owner's product-source switch; never a registered tool.
  setProductSourceWritesPolicyForTests,
  // Internal adapter seam for tests, never a registered tool or serialized capability.
  hostCoordination: Object.freeze({
    authority: hostByteAuthority, materialize: materializeHost, publish: publishHost,
    prepareCreate: prepareHostCreate, reconcileCreateStage: reconcileHostCreate
  })
};
