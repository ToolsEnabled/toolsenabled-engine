'use strict';

// THE OUTBOUND HALF OF THE CLOUD LANE: getting the CURRENT local tree into a
// private cloud mirror, and refusing to dispatch against one that is not.
//
// ---------------------------------------------------------------------------
// THE MEASUREMENT THIS EXISTS FOR (2026-08-24, taken here, not reported).
//
//   app  origin/packaging/capability-layer   467 commits behind local HEAD
//   app  origin/main                         756 commits behind local HEAD
//   engine origin/main                         5 commits behind local HEAD
//
// A Codex Cloud environment is bound to a GitHub repository and clones a BRANCH
// of it. So a cloud agent diffs against whatever that branch holds. The engine's
// branch is 5 commits behind and its cloud harvests came back clean; the app's
// is 467 behind and its harvests produced empty applies, "fixes" already present
// in the tree, and citations pointing at unrelated code. The gap IS the defect.
// Nothing about the prompt, the model, or the harvest was broken.
//
// ---------------------------------------------------------------------------
// WHY A MIRROR AND NOT A PUSH.
//
// tools/repo-sync.js is a protected-main RECEIVER by owner directive
// (R1120/R1122/R1162): "It never publishes work, creates a merge commit,
// rebases, resets, or pushes." The publish direction was never built, on
// purpose. This module does not change that and does not touch any branch of
// any real remote. It writes to the dedicated private GitHub mirror registered
// through the authenticated product setup path, and to nothing else.
//
// IT ALSO NEVER MUTATES THE SOURCE CHECKOUT. The filtered tree is assembled in
// a temporary index inside a fenced bare scratch repository, and write-tree /
// commit-tree write only that scratch object database. Source blobs are exposed
// to it as a read-only object alternate. HEAD, the real index, the working tree,
// every local ref and the source .git/objects set are read and never written.
// That is deliberate and load-bearing -- these checkouts are shared with other
// agents at all times, and even an additive object write changes shared source
// state that a read-only publication path has no authority to change.
//
// ---------------------------------------------------------------------------
// WHAT ENTERS A MIRROR IS A PUBLICATION DECISION. THREE MECHANISMS, ALL CLOSED.
//
//   1. THE UNIT IS THE TRACKED TREE AT A COMMIT, from `git ls-tree -r -l -z`.
//      Never a directory walk and never `git push --mirror`. Untracked files --
//      a builder's live policy copy, a vault, agent scratch, node_modules --
//      are outside the unit entirely and cannot leave by this path even if the
//      boundary were wrong about them.
//
//   2. UNCLASSIFIED REFUSES. Every entry in that tree must match a rule in the
//      mirror boundary manifest. A file that appears tomorrow and matches
//      nothing stops the publish until a person classifies it. This is the same
//      rule tools/check-payload-boundary.mjs holds for the open-source publish,
//      for the same reason: defaulting the unknown to "send it" means the next
//      thing anyone drops in the tree leaves by silence.
//
//   3. A CREDENTIAL-SHAPED VALUE IN A MIRRORED FILE REFUSES. Independent of
//      classification, every mirrored text blob is scanned with the repository's
//      OWN detector (src/lib/secret-patterns.js -- not a fourth copy of the
//      regex). A hit names the path and the SHAPE it matched, never the bytes.
//
// WHERE THIS BOUNDARY DIFFERS FROM config/payload-boundary.json, AND WHY IT IS
// A SECOND DECISION RATHER THAN A SECOND MECHANISM. That manifest answers "may
// this file be published PUBLICLY under the open licence?". This one answers
// "may this file leave this machine into a PRIVATE repository that cloud agents
// clone?". They are different questions with genuinely different answers -- a
// server-side module we withhold from the open half is ours, private, and
// exactly the kind of thing a cloud agent may need to work on. Answering both
// from one file would force one of them to be wrong. The mechanism, the
// vocabulary, the precedence order and the fail-closed rules are deliberately
// identical so the two are read the same way.
//
// ONE ASYMMETRY IS DELIBERATELY REVERSED, AND IT IS ARGUED AT loadBoundary().
// The publish gate forbids prefixes on its permissive class. This one allows
// them, because the failure that rule prevents -- a new server-side module
// becoming public by silence -- does not exist when the destination is private
// and ours. The failure that DOES exist here, a new file carrying a credential
// leaving by silence, is closed by mechanism 3 instead, which the publish gate
// does not have.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT cloud-lane.js's `--allowlist`, WHICH IS THE FIRST THING
// ANYONE WILL ASK. That flag looks like a publication boundary and is not one.
// buildFileManifest() in packages/internal-vcs/src/cloud/file-manifest.js
// enforces it as an all-or-nothing TERRITORY ASSERTION: every entry it is
// handed must be covered, and one that is not fails the whole manifest with
// ALLOWLIST_VIOLATION. It has no way to remove a file and keep the rest, no
// distinction between "deliberately withheld" and "nobody has decided", no
// content check, and it never produces a tree or pushes anything -- cloud-lane
// is custody ACCOUNTING and says so in its own header. What is reused from it
// here is what genuinely is shared: parseLsTreeOutput(), so there is exactly
// one parser for git's tree output in this directory.
//
// THE FRESHNESS REFUSAL IS THE POINT OF THE WHOLE FILE.
//
// Publishing a mirror once fixes tonight. A dispatch that does not CHECK the
// mirror is current brings the same silent decay back with extra steps, which
// is the state the lane is in today. So checkMirrorFreshness() refuses BY NAME
// -- CLOUD_MIRROR_STALE -- when the mirror's head does not correspond to local
// HEAD, and codex-cloud-launch.js calls it before anything is sent.
//
// The comparison is by object id, which is why it is proof rather than a claim:
// `git ls-remote` reports the sha the mirror branch points at; a receipt written
// by publishMirror() records the sha it pushed and the source commit it was
// built from. Git object ids are content addresses, so a matching sha is the
// remote tree, not a report about it.
//
// THE LOCAL RECEIPT IS THE AUTHORITY. Every publication commit also carries
// informational trailers so a human recovery workflow can identify what the
// writer claimed to publish. Those trailers are remote-controlled text, not a
// freshness witness: another machine or a hand push can reproduce them. If the
// exact remote head is absent from this installation's receipt history, the
// check refuses before fetching or adopting anything from the mirror.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { CloudAgentError } = require('./errors');
const { parseLsTreeOutput } = require('./cloud-lane');
const { plaintextCredentialPattern } = require('../secret-patterns');
const { programOrStatePath } = require('../runtime-state-root');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env.js');
const { assertAccountProfilePath, installationProfileRoot } = require('../agent-session-confinement');
const { acquireLock } = require('../process-claim-lock');
const { spawnInJob } = require('../windows-job-control');

const PROGRAM_ROOT = path.resolve(__dirname, '..', '..', '..');

const REGISTRY_SCHEMA = 'toolsenabled.cloud-mirror.registry/v1';
const RECEIPT_SCHEMA = 'toolsenabled.cloud-mirror.publication/v1';
const BOUNDARY_SCHEMA = 1;

// The marker that makes a publication commit self-identifying. It is checked
// for literally: a commit on the mirror branch without it was not written by
// this module, which is exactly the case the check must not wave through.
const TRAILER_MARKER = 'ToolsEnabled-Cloud-Mirror';
const TRAILER_VERSION = 'v1';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const TREE_SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REGULAR_FILE_MODES = Object.freeze(['100644', '100755']);

// History is kept so a check can still recognise a mirror head from before the
// last publish -- an agent branch, a slower harvest. Bounded because this is a
// state file, not a ledger.
const RECEIPT_HISTORY_LIMIT = 20;

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 120_000;
const MAX_GIT_BUFFER_BYTES = 512 * 1024 * 1024;
const MAX_STDERR_EXCERPT_CHARS = 1024;
const MAX_ALTERNATE_OBJECT_DATABASES = 32;
const MAX_ALTERNATE_OBJECT_DEPTH = 8;

// A single detector instance is NOT reused across files: a /g regex carries
// lastIndex, and a shared one silently starts each file where the previous one
// stopped. Measured cost of getting that wrong is a file scanned from byte
// 4000 and reported clean.
function credentialDetector() {
  return plaintextCredentialPattern('gi');
}

function fail(code, message, details) {
  const error = new CloudAgentError(code, message);
  if (details !== undefined) error.details = details;
  throw error;
}

function insidePath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameLocalPath(left, right) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/* Refuse a stale registry that names another Windows account before probing
 * it. Paths that are lexically admissible are then checked component-by-
 * component for reparse points by the shared installation fence. */
function fencedCloudPath(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || !path.isAbsolute(value.trim())) {
    fail('CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
      `The ${field} must be an absolute path whose account boundary can be established. Nothing was read or written.`);
  }
  try {
    return assertAccountProfilePath(value.trim(), {
      field: `Cloud Mirror ${field}`,
      profileRoot: installationProfileRoot()
    });
  } catch (error) {
    fail('CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
      `The ${field} crosses an untrusted Windows account or reparse boundary. Nothing was read or written.`,
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }
}

function cloudMirrorTemporaryRoot() {
  try {
    const profileRoot = installationProfileRoot();
    const candidate = process.platform === 'win32'
      ? path.join(profileRoot, 'AppData', 'Local', 'Temp')
      : os.tmpdir();
    return assertAccountProfilePath(candidate, {
      field: 'Cloud Mirror temporary Git root',
      profileRoot,
      requireOwnedProfile: process.platform === 'win32'
    });
  } catch (error) {
    fail('CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
      'The Cloud Mirror temporary Git root is not inside the installation account boundary. Nothing was read or written.',
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }
}

function portableBoundaryManifest(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('CLOUD_MIRROR_BOUNDARY_PATH_REFUSED', 'The Cloud Mirror boundary manifest must be a relative path inside the selected checkout.');
  }
  const portable = value.trim().replace(/\\/g, '/');
  const segments = portable.split('/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable) || path.isAbsolute(value.trim())
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail('CLOUD_MIRROR_BOUNDARY_PATH_REFUSED',
      'The Cloud Mirror boundary manifest must be a non-traversing relative path inside the selected checkout.');
  }
  return portable;
}

function resolveCloudProjectPaths(sourceRoot, boundaryManifest) {
  const source = fencedCloudPath(sourceRoot, 'source root');
  const boundaryRelative = portableBoundaryManifest(boundaryManifest);
  const candidate = path.resolve(source, ...boundaryRelative.split('/'));
  if (!insidePath(source, candidate)) {
    fail('CLOUD_MIRROR_BOUNDARY_PATH_REFUSED', 'The Cloud Mirror boundary manifest escapes the selected checkout.');
  }
  const boundary = fencedCloudPath(candidate, 'boundary manifest');
  if (!insidePath(source, boundary)) {
    fail('CLOUD_MIRROR_BOUNDARY_PATH_REFUSED',
      'The Cloud Mirror boundary manifest resolves outside the selected checkout. Nothing was read or written.');
  }
  return Object.freeze({ sourceRoot: source, boundaryManifest: boundary, boundaryRelative });
}

function excerpt(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '(no output)';
  return value.length <= MAX_STDERR_EXCERPT_CHARS ? value : `${value.slice(0, MAX_STDERR_EXCERPT_CHARS)}...[truncated]`;
}

/* Turn the one remote URL the person typed into the one GitHub repository the
 * backend is allowed to inspect and publish to. This parser is intentionally
 * narrower than git: Cloud Mirror is a GitHub product path, not a generic git
 * transport, and accepting an arbitrary host would make github.repo_get prove
 * the privacy of one repository while git pushes the tree to another. */
function githubRepositoryFromRemote(remote) {
  const value = typeof remote === 'string' ? remote.trim() : '';
  let parsed;
  try { parsed = new URL(value); } catch {
    fail('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      'Cloud Mirror accepts only a credential-free HTTPS GitHub repository URL in the form https://github.com/owner/repository.git.');
  }
  if (parsed.username || parsed.password) {
    // Never repeat the rejected input here. A URL may contain the very secret
    // this refusal exists to keep out of logs, receipts and renderer errors.
    fail('CLOUD_MIRROR_REMOTE_CREDENTIALS_REFUSED',
      'Cloud Mirror repository URLs must not contain a username, password or token. Enter the credential-free HTTPS repository URL.');
  }
  if (parsed.protocol.toLowerCase() !== 'https:'
    || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.port || parsed.search || parsed.hash) {
    fail('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      'Cloud Mirror accepts only a credential-free HTTPS GitHub repository URL in the form https://github.com/owner/repository.git.');
  }
  const segments = parsed.pathname.split('/');
  if (segments.length !== 3 || segments[0] !== '' || !segments[1] || !segments[2]) {
    fail('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      'The GitHub repository URL must contain exactly one owner and one repository name.');
  }
  let [, owner, repo] = segments;

  repo = String(repo || '').replace(/\.git$/i, '');
  if (!GITHUB_OWNER.test(String(owner || '')) || !GITHUB_REPO.test(repo)) {
    fail('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      'The GitHub repository URL does not contain a valid owner and repository name.');
  }
  return Object.freeze({
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    httpsUrl: `https://github.com/${owner}/${repo}.git`
  });
}

function sameRepository(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function assertPrivateGithubMetadata(metadata, expectedRepository) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('CLOUD_MIRROR_PRIVACY_UNVERIFIED', `github.repo_get returned no repository metadata for ${expectedRepository}.`);
  }
  const fullName = typeof metadata.fullName === 'string' ? metadata.fullName.trim() : '';
  if (!REPOSITORY.test(fullName) || !sameRepository(fullName, expectedRepository)) {
    fail('CLOUD_MIRROR_REPOSITORY_MISMATCH',
      `github.repo_get returned ${JSON.stringify(fullName || null)} while Cloud Mirror is configured for ${expectedRepository}. Refusing because privacy was not checked on the exact push destination.`);
  }
  if (metadata.archived !== false) {
    fail(metadata.archived === true ? 'CLOUD_MIRROR_REPOSITORY_ARCHIVED' : 'CLOUD_MIRROR_REPOSITORY_STATE_UNVERIFIED',
      metadata.archived === true
        ? `github.repo_get reports ${fullName} as archived. Archived repositories cannot accept a current Cloud Mirror publication.`
        : `github.repo_get did not establish that ${fullName} is not archived. Nothing can be published until its active state is verified.`);
  }
  if (metadata.disabled !== false) {
    fail(metadata.disabled === true ? 'CLOUD_MIRROR_REPOSITORY_DISABLED' : 'CLOUD_MIRROR_REPOSITORY_STATE_UNVERIFIED',
      metadata.disabled === true
        ? `github.repo_get reports ${fullName} as disabled. Disabled repositories cannot accept a Cloud Mirror publication.`
        : `github.repo_get did not establish that ${fullName} is not disabled. Nothing can be published until its active state is verified.`);
  }
  if (metadata.private !== true || String(metadata.visibility || '').toLowerCase() !== 'private') {
    fail('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
      `github.repo_get reports ${fullName} as private=${JSON.stringify(metadata.private)} visibility=${JSON.stringify(metadata.visibility)}, not private. Cloud Mirror publishes the selected, boundary-classified tracked snapshot and has no public-repository override.`);
  }
  return fullName;
}

async function defaultGithubRepoGet(repository) {
  // This is the provider implementation behind the registered
  // github.repo_get tool. It obtains the managed GitHub credential and returns
  // the same sanitized metadata; loading lazily avoids adding provider startup
  // cost to read-only registry operations.
  return require('../providers/github').repoGet({ owner: repository.owner, repo: repository.repo });
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// git.
//
// LOCAL PLUMBING IS SYNCHRONOUS AND THE ONE NETWORK CALL IS NOT. ls-tree,
// cat-file, write-tree and commit-tree are local object-database reads that
// finish in milliseconds; running them synchronously is what
// tools/check-payload-boundary.mjs already does and keeps the classification
// path a straight line. `git ls-remote` talks to a server and can block for as
// long as the network allows, and the dispatch gate that calls it runs inside
// the product's event loop, so it gets its own asynchronous runner.
//
// Both scrub the environment before spawning. This repository sets
// core.hooksPath, so a git child runs repository hooks; inheriting ambient
// provider credentials into them is the leak that safeLaunchEnvironment exists
// to close.
// ---------------------------------------------------------------------------

function runGitSync(repoRoot, args, {
  input = null,
  indexFile = null,
  alternateObjects = null,
  encoding = 'utf8'
} = {}) {
  const env = removeGitControlEnvironment(safeLaunchEnvironment(process.env, { context: 'cloud mirror git' }));
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = nullConfig;
  env.GIT_CONFIG_GLOBAL = nullConfig;
  // Local Cloud Mirror commands are object-database reads and temporary-index
  // plumbing. They must neither refresh the customer's real index nor turn a
  // partial clone into an undeclared network operation. `git status` also
  // consults core.fsmonitor; override it at command scope so a checkout-local
  // hook cannot become process authority merely because the owner selected the
  // folder for mirroring.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
  env.GIT_CONFIG_VALUE_0 = 'false';
  env.GIT_CONFIG_KEY_1 = 'commit.gpgSign';
  env.GIT_CONFIG_VALUE_1 = 'false';
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  if (alternateObjects) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternateObjects;
  // A checkout may set core.worktree in config or config.worktree. `-C` does
  // not override that setting, so status could otherwise inspect a different
  // directory (including another profile) after the selected source itself was
  // fenced. The command-line option has higher priority than both files.
  const outcome = childProcess.spawnSync('git', ['-C', repoRoot, '--work-tree', repoRoot, ...args], {
    env,
    input: input === null ? undefined : input,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    windowsHide: true
  });
  if (outcome.error && outcome.error.code === 'ENOENT') {
    fail('CLOUD_MIRROR_GIT_UNAVAILABLE', 'git is not on PATH, so the mirror question cannot be answered at all.');
  }
  if (outcome.error) {
    fail('CLOUD_MIRROR_GIT_FAILED', `git ${args[0]} could not be run in ${repoRoot}: ${excerpt(String(outcome.error.message))}`);
  }
  if (outcome.status !== 0) {
    const stderr = outcome.stderr === undefined || outcome.stderr === null
      ? ''
      : Buffer.isBuffer(outcome.stderr) ? outcome.stderr.toString('utf8') : String(outcome.stderr);
    fail('CLOUD_MIRROR_GIT_FAILED', `git ${args[0]} exited with status ${outcome.status} in ${repoRoot}: ${excerpt(stderr)}`,
      { exitStatus: outcome.status, gitSubcommand: args[0] });
  }
  return outcome.stdout;
}

const SAFE_SYSTEM_CREDENTIAL_HELPERS = new Set([
  'manager', 'manager-core', 'wincred', 'osxkeychain', 'libsecret'
]);
let safeSystemCredentialHelpersCache = null;

function removeGitControlEnvironment(environment) {
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_/i.test(key)
      || /^GIT_TRACE/i.test(key)
      || /^(?:GIT_CONFIG_PARAMETERS|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|SHALLOW_FILE|GRAFT_FILE|OPTIONAL_LOCKS|NO_LAZY_FETCH|SSH|SSH_COMMAND|ASKPASS|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|ALLOW_PROTOCOL|PROTOCOL_FROM_USER|CURL_VERBOSE)|SSH_ASKPASS|GCM_TRACE|GCM_INTERACTIVE)$/i.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function safeSystemCredentialHelpers() {
  if (safeSystemCredentialHelpersCache) return safeSystemCredentialHelpersCache;
  const env = removeGitControlEnvironment(safeLaunchEnvironment(process.env, { context: 'cloud mirror git credential helper discovery' }));
  // --system is read only to recover a known, non-shell credential helper.
  // The system file itself is not loaded by any network operation below, so a
  // system url.* rewrite cannot redirect a Cloud Mirror connection.
  const outcome = childProcess.spawnSync('git', ['config', '--system', '--no-includes', '--get-all', 'credential.helper'], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    windowsHide: true
  });
  const helpers = outcome.status === 0
    ? String(outcome.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter((value) => SAFE_SYSTEM_CREDENTIAL_HELPERS.has(value))
    : [];
  safeSystemCredentialHelpersCache = Object.freeze([...new Set(helpers)]);
  return safeSystemCredentialHelpersCache;
}

function isolatedNetworkGitEnvironment({ alternateObjects = null } = {}) {
  const env = removeGitControlEnvironment(safeLaunchEnvironment(process.env, { context: 'cloud mirror network git' }));
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = nullConfig;
  env.GIT_CONFIG_GLOBAL = nullConfig;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GIT_NO_REPLACE_OBJECTS = '1';

  // Environment-scope configuration has command-line priority. Only the
  // transport needed by the product and the file transport used by hermetic
  // tests are admitted. Redirects are disabled: the exact github.com URL that
  // was privacy-checked is the URL Git must contact.
  const entries = [
    ['credential.interactive', 'never'],
    ...safeSystemCredentialHelpers().map((helper) => ['credential.helper', helper]),
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.file.allow', 'always'],
    ['http.followRedirects', 'false']
  ];
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (alternateObjects) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternateObjects;
  return env;
}

function readGitMetadataFile(file, label, maxBytes = 64 * 1024) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not establish ${label} as a bounded regular local file. Nothing was sent.`);
  }
  return fs.readFileSync(file, 'utf8');
}

function oneGitMetadataLine(raw, label) {
  if (typeof raw !== 'string' || raw.includes('\0')) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', `Cloud Mirror found invalid ${label}. Nothing was sent.`);
  }
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  if (lines.length !== 1 || !lines[0].trim()) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', `Cloud Mirror found ambiguous ${label}. Nothing was sent.`);
  }
  return lines[0].trim();
}

function ordinaryGitDirectory(candidate, field) {
  const fenced = fencedCloudPath(candidate, field);
  let stat;
  try { stat = fs.lstatSync(fenced); }
  catch (error) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not inspect the ${field}: ${excerpt(error && error.message)}. Nothing was sent.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not establish the ${field} as a regular local directory. Nothing was sent.`);
  }
  return fenced;
}

function rejectGitConfigIncludes(directory) {
  for (const name of ['config', 'config.worktree']) {
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', 'Cloud Mirror could not inspect local Git configuration without following it. Nothing was sent.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', 'Cloud Mirror local Git configuration is not a regular file. Nothing was sent.');
    }
    const raw = readGitMetadataFile(file, 'local Git configuration');
    if (/^\s*\[\s*include(?:if)?(?:\s|\])/im.test(raw)) {
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
        'Cloud Mirror refuses local Git include/includeIf directives because their target cannot be allowed to escape the installation account. Nothing was sent.');
    }
  }
}

function collectAlternateObjectDatabases(primaryObjects) {
  const collected = [];
  const visited = new Set();
  const visit = (database, depth) => {
    if (depth > MAX_ALTERNATE_OBJECT_DEPTH) {
      fail('CLOUD_MIRROR_GIT_ALTERNATE_LIMIT',
        `Cloud Mirror refuses an object-alternate chain deeper than ${MAX_ALTERNATE_OBJECT_DEPTH}. Nothing was sent.`);
    }
    const key = process.platform === 'win32' ? database.toLowerCase() : database;
    if (visited.has(key)) return;
    visited.add(key);
    if (visited.size > MAX_ALTERNATE_OBJECT_DATABASES) {
      fail('CLOUD_MIRROR_GIT_ALTERNATE_LIMIT',
        `Cloud Mirror refuses more than ${MAX_ALTERNATE_OBJECT_DATABASES} object databases. Nothing was sent.`);
    }
    const alternatesFile = path.join(database, 'info', 'alternates');
    let raw;
    try { raw = readGitMetadataFile(alternatesFile, 'object alternates file'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
      if (!line.trim()) continue;
      if (line.includes('\0') || /["']/.test(line)) {
        fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', 'Cloud Mirror found an ambiguous object alternate. Nothing was sent.');
      }
      const alternate = ordinaryGitDirectory(
        path.isAbsolute(line.trim()) ? path.resolve(line.trim()) : path.resolve(database, line.trim()),
        'source alternate object database'
      );
      const alternateKey = process.platform === 'win32' ? alternate.toLowerCase() : alternate;
      if (!visited.has(alternateKey)) collected.push(alternate);
      visit(alternate, depth + 1);
    }
  };
  visit(primaryObjects, 0);
  return Object.freeze(collected);
}

function sourceGitMetadata(repoRoot) {
  const source = fencedCloudPath(repoRoot, 'source root');
  const marker = path.join(source, '.git');
  let markerStat;
  try { markerStat = fs.lstatSync(marker); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('CLOUD_MIRROR_SOURCE_ROOT_NOT_A_CHECKOUT', `${source} is not a git checkout (no .git). Nothing was sent.`);
    }
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not inspect the source Git metadata entry without following it: ${excerpt(error && error.message)}. Nothing was sent.`);
  }
  if (markerStat.isSymbolicLink() || (!markerStat.isDirectory() && !markerStat.isFile())) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      'Cloud Mirror requires .git to be a regular directory or a strictly parsed linked-worktree file. Nothing was sent.');
  }

  let gitDirectory;
  if (markerStat.isDirectory()) {
    gitDirectory = ordinaryGitDirectory(marker, 'source Git metadata directory');
  } else {
    const line = oneGitMetadataLine(readGitMetadataFile(marker, 'source .git file', 4096), 'source .git file');
    const match = /^gitdir:\s*(.+)$/i.exec(line);
    if (!match || !match[1].trim()) {
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', 'Cloud Mirror found an invalid linked-worktree .git file. Nothing was sent.');
    }
    const candidate = path.isAbsolute(match[1].trim())
      ? path.resolve(match[1].trim())
      : path.resolve(source, match[1].trim());
    gitDirectory = ordinaryGitDirectory(candidate, 'linked-worktree Git directory');
  }

  let commonDirectory = gitDirectory;
  const commonFile = path.join(gitDirectory, 'commondir');
  try {
    const commonStat = fs.lstatSync(commonFile);
    if (!commonStat.isFile() || commonStat.isSymbolicLink()) {
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', 'Cloud Mirror linked-worktree commondir is not a regular file. Nothing was sent.');
    }
    const value = oneGitMetadataLine(readGitMetadataFile(commonFile, 'linked-worktree commondir', 4096), 'linked-worktree commondir');
    commonDirectory = ordinaryGitDirectory(
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(gitDirectory, value),
      'linked-worktree common Git directory'
    );
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  rejectGitConfigIncludes(commonDirectory);
  if (!sameLocalPath(commonDirectory, gitDirectory)) rejectGitConfigIncludes(gitDirectory);
  const objects = ordinaryGitDirectory(path.join(commonDirectory, 'objects'), 'source object database');
  const alternates = collectAlternateObjectDatabases(objects);
  return Object.freeze({ source, gitDirectory, commonDirectory, objects, alternates });
}

function sourceObjectDirectory(repoRoot) {
  return sourceGitMetadata(repoRoot).objects;
}

function isolatedBareRepository(sourceRoot = null) {
  // Fence source metadata before even the harmless `git init` used to create
  // our scratch repository. A refusal must mean no Git process was started.
  let alternateObjects = null;
  if (sourceRoot) {
    try { alternateObjects = sourceObjectDirectory(sourceRoot); }
    catch (error) {
      if (!error || error.code !== 'CLOUD_MIRROR_SOURCE_ROOT_NOT_A_CHECKOUT') throw error;
      fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
        'Cloud Mirror could not establish the source object database before starting Git. Nothing was sent.');
    }
  }
  let root;
  try {
    root = fs.mkdtempSync(path.join(cloudMirrorTemporaryRoot(), 'toolsenabled-cloud-mirror-git-'));
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('CLOUD_MIRROR_')) throw error;
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not create its owned temporary Git directory: ${excerpt(error && error.message)}. Nothing was sent.`);
  }
  const outcome = childProcess.spawnSync('git', ['init', '--bare', '--quiet', root], {
    env: safeLaunchEnvironment(isolatedNetworkGitEnvironment(), {
      context: 'cloud mirror isolated bare repository'
    }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    windowsHide: true
  });
  if (outcome.error || outcome.status !== 0) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort for our own temp directory */ }
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      `Cloud Mirror could not create an isolated Git network context: ${excerpt(outcome.stderr || (outcome.error && outcome.error.message))}. Nothing was sent.`);
  }
  try {
    const fencedRoot = fencedCloudPath(root, 'owned temporary Git directory');
    return Object.freeze({
      root: fencedRoot,
      alternateObjects
    });
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* preserve the primary isolation failure */ }
    throw error;
  }
}

function removeOwnedTemporaryGitDirectory(root) {
  const fencedRoot = fencedCloudPath(root, 'owned temporary Git directory');
  const temporaryRoot = cloudMirrorTemporaryRoot();
  if (!insidePath(temporaryRoot, fencedRoot) || sameLocalPath(temporaryRoot, fencedRoot)) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      'Cloud Mirror refused to remove a temporary Git directory whose ownership boundary was not exact.');
  }
  fs.rmSync(fencedRoot, { recursive: true, force: true });
}

function defaultNetworkGit(repoRoot, args, {
  timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
  scratchRepository = null
} = {}) {
  /* A network operation must not read the source checkout's .git/config. Git applies
   * url.*.insteadOf and url.*.pushInsteadOf from that file after the caller
   * supplies a URL, which can turn a privacy check on github.com/A into a push
   * somewhere else. Run from a new bare repository and borrow only the source
   * object database. Global and system config are replaced above; a known safe
   * system credential helper is copied back explicitly when one exists. */
  // Read-only calls pass no source root. They still need a repository context:
  // otherwise Git discovers .git/config from process.cwd(), and a local
  // url.*.insteadOf rule can redirect the exact HTTPS URL the caller supplied.
  // A bare repository without alternates is sufficient for ls-remote; pushes
  // additionally borrow the classified source's object database.
  const ownsTemporary = !scratchRepository;
  const temporary = scratchRepository || isolatedBareRepository(repoRoot || null);
  const invocationRoot = fencedCloudPath(temporary.root, 'owned temporary Git directory');
  const temporaryRoot = cloudMirrorTemporaryRoot();
  if (!insidePath(temporaryRoot, invocationRoot) || sameLocalPath(temporaryRoot, invocationRoot)) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      'Cloud Mirror refused a network Git scratch repository outside its owned temporary root. Nothing was sent.');
  }
  ordinaryGitDirectory(invocationRoot, 'owned temporary Git directory');
  const env = isolatedNetworkGitEnvironment({ alternateObjects: temporary && temporary.alternateObjects });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnInJob('git', ['-C', invocationRoot, ...args], {
        cwd: invocationRoot,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }, { safeLaunchEnvironment });
    } catch (error) {
      if (ownsTemporary) {
        try { removeOwnedTemporaryGitDirectory(temporary.root); } catch { /* preserve the spawn failure */ }
      }
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    let settled = false;
    let timedOut = false;
    let termination = null;
    let childError = null;
    const stdout = [];
    const stderr = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ownsTemporary) {
        try { removeOwnedTemporaryGitDirectory(temporary.root); } catch { /* best effort for our own temp directory */ }
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      termination = typeof child.terminateJob === 'function'
        ? child.terminateJob()
        : Promise.resolve().then(() => child.kill());
      termination.catch((error) => { childError = childError || error; });
    }, Math.max(1, timeoutMs));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { childError = childError || error; });
    child.on('close', async (exitCode) => {
      if (termination) {
        try { await termination; }
        catch (error) { childError = childError || error; }
      }
      if (timedOut) {
        finish({
          exitCode: null,
          stdout: '',
          stderr: childError
            ? `timed out after ${timeoutMs}ms; process-tree cleanup failed: ${String(childError.message || childError)}`
            : `timed out after ${timeoutMs}ms`,
          timedOut: true,
          ...(childError ? { error: childError, cleanupUnproven: true } : {})
        });
        return;
      }
      if (childError) {
        finish({ exitCode: null, stdout: '', stderr: String(childError.message || childError), spawnFailed: true, error: childError });
        return;
      }
      finish({ exitCode, stdout: stdout.join(''), stderr: stderr.join('') });
    });
  });
}

// ---------------------------------------------------------------------------
// The mirror boundary manifest.
// ---------------------------------------------------------------------------

function boundaryError(file, message) {
  fail('CLOUD_MIRROR_BOUNDARY_INVALID', `${file}: ${message}`);
}

// Repository-relative POSIX paths, exactly as `git ls-tree` names them. Anything
// else is rejected rather than normalised: an entry that does not match the way
// git spells a path is an entry that classifies nothing, and "unclassified
// refuses" is only load-bearing if entries mean what they look like.
function assertUsablePath(file, value, where, { directory = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) boundaryError(file, `${where} contains an empty or non-string entry.`);
  if (value !== value.trim()) boundaryError(file, `${where} entry ${JSON.stringify(value)} has surrounding whitespace.`);
  if (value.includes('\\')) {
    boundaryError(file, `${where} entry ${JSON.stringify(value)} uses a backslash. git names files with forward slashes on every platform, so a backslash entry would match nothing.`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    boundaryError(file, `${where} entry ${JSON.stringify(value)} is absolute. Entries are repository-relative so one manifest checks any clone.`);
  }
  const segments = value.split('/');
  if (value.startsWith('./') || segments.includes('..') || segments.includes('.')) {
    boundaryError(file, `${where} entry ${JSON.stringify(value)} is not in normal form (no "./", no "..", no bare "." segments).`);
  }
  if (directory && !value.endsWith('/')) {
    boundaryError(file, `${where} entry ${JSON.stringify(value)} must end with "/" so it is unambiguously a directory prefix. Without it, "docs" would also match "docsite.md".`);
  }
  if (!directory && value.endsWith('/')) {
    boundaryError(file, `${where} entry ${JSON.stringify(value)} is a file path and must not end with "/".`);
  }
}

function readRuleSection(file, parsed, name, { allowPrefixes }) {
  const section = parsed[name];
  const rules = { paths: [], prefixes: [] };
  if (section === undefined) return rules;
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    boundaryError(file, `"${name}" must be an object.`);
  }
  const paths = section.paths === undefined ? [] : section.paths;
  if (!Array.isArray(paths)) boundaryError(file, `"${name}.paths" must be an array.`);
  for (const entry of paths) {
    assertUsablePath(file, entry, `${name}.paths`);
    rules.paths.push(entry);
  }
  const prefixes = section.prefixes === undefined ? [] : section.prefixes;
  if (!allowPrefixes && section.prefixes !== undefined) {
    boundaryError(file, `"${name}" may not use prefixes.`);
  }
  if (!Array.isArray(prefixes)) boundaryError(file, `"${name}.prefixes" must be an array.`);
  for (const entry of prefixes) {
    assertUsablePath(file, entry, `${name}.prefixes`, { directory: true });
    rules.prefixes.push(entry);
  }
  return rules;
}

/**
 * Load and validate a mirror boundary manifest.
 *
 * PREFIXES ARE ALLOWED ON BOTH CLASSES HERE, WHICH IS THE ONE PLACE THIS
 * DEPARTS FROM tools/check-payload-boundary.mjs, SO IT IS ARGUED RATHER THAN
 * ASSUMED.
 *
 * That gate forbids prefixes on `open` because an over-broad open prefix
 * classifies files that do not exist yet, so the next server-side module
 * dropped beneath it would become PUBLIC by silence -- irreversible, and
 * visible to anyone. Cloud Mirror instead targets the exact private GitHub
 * repository selected and verified during registration. Its boundary may
 * intentionally describe a complete tracked workspace: requiring every path
 * to be named individually and re-listed after each addition would create an
 * impractical gate that callers would be pressured to bypass.
 *
 * So the risk that rule was standing in for is carried by a different mechanism
 * that the publish gate does not have: scanBlobsForCredentials() refuses on the
 * CONTENT of anything selected, whatever rule selected it. A new file under a
 * mirrored prefix is sent by silence only if it carries nothing the detector
 * recognises -- and if it carries something the detector does not recognise,
 * that is a named limitation of the detector, printed by the tool, not a
 * pretence.
 *
 * Precedence is strictest-first and identical to the publish gate's: withhold
 * beats mirror, and an unmatched path is unclassified and refuses.
 */
function loadBoundary(file, { readFileImpl = fs.readFileSync, existsImpl = fs.existsSync } = {}) {
  if (typeof file !== 'string' || !file.trim()) {
    fail('CLOUD_MIRROR_INPUT_INVALID', 'the boundary manifest path must be a non-empty string.');
  }
  // Re-run the account/reparse fence for every snapshot read. Registration
  // proved this path once, but a same-user process can replace a path component
  // afterwards; a stored absolute name is not continuing authority to follow
  // the replacement.
  file = fencedCloudPath(file, 'boundary manifest');
  if (!existsImpl(file)) {
    fail('CLOUD_MIRROR_BOUNDARY_MISSING',
      `${file} is missing. This holds the decision about what may leave this machine and has been given no decision to hold, so it would pass a tree containing anything at all.`);
  }
  let raw;
  try {
    raw = readFileImpl(file, 'utf8');
  } catch (error) {
    boundaryError(file, `present but unreadable: ${error && error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    boundaryError(file, `is not valid JSON: ${error && error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) boundaryError(file, 'must be a JSON object.');
  if (parsed.schemaVersion !== BOUNDARY_SCHEMA) {
    boundaryError(file, `schemaVersion must be ${BOUNDARY_SCHEMA}, found ${JSON.stringify(parsed.schemaVersion)}.`);
  }

  const withhold = readRuleSection(file, parsed, 'withhold', { allowPrefixes: true });
  const mirror = readRuleSection(file, parsed, 'mirror', { allowPrefixes: true });
  if (mirror.paths.length === 0 && mirror.prefixes.length === 0) {
    boundaryError(file, '"mirror" declares no rules at all, so every tracked path would be unclassified. An empty mirror class is a manifest that has not been written, not a strict one.');
  }

  // A path in two classes is an ambiguous decision in the one file whose whole
  // job is to be unambiguous. Precedence would resolve it safely but silently.
  const claimed = new Map();
  for (const [label, rules] of [['withhold', withhold], ['mirror', mirror]]) {
    for (const group of ['paths', 'prefixes']) {
      for (const entry of rules[group]) {
        const previous = claimed.get(entry);
        if (previous) boundaryError(file, `${JSON.stringify(entry)} is declared in both "${previous}" and "${label}". One path, one class.`);
        claimed.set(entry, label);
      }
    }
  }

  // ACKNOWLEDGED CREDENTIAL SHAPES. Not an exception to the content gate -- a
  // statement, with a reason, that a named region is expected to contain
  // credential-SHAPED text that is not a credential. Test fixtures are the whole
  // of it in both repositories today. A reason is mandatory for the same purpose
  // it is mandatory in the publish gate's `pending`: an unexplained exception is
  // how a temporary list becomes permanent.
  const acknowledged = new Map();
  if (parsed.credentialScanAcknowledged !== undefined) {
    const section = parsed.credentialScanAcknowledged;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      boundaryError(file, '"credentialScanAcknowledged" must be an object of path-or-prefix -> reason.');
    }
    for (const [entry, reason] of Object.entries(section)) {
      // `$`-prefixed keys are this repository's JSON comment convention
      // (config/toolsenabled.policy.json's $comment_standingAuthorizations,
      // config/payload-boundary.json's $comment). Skipping them here is what
      // lets the decision be argued in the file it governs. No real path starts
      // with `$`, and assertUsablePath would otherwise accept "$comment" as an
      // acknowledgement for a path that can never exist.
      if (entry.startsWith('$')) continue;
      assertUsablePath(file, entry, 'credentialScanAcknowledged', { directory: entry.endsWith('/') });
      if (typeof reason !== 'string' || reason.trim().length < 20) {
        boundaryError(file, `credentialScanAcknowledged entry ${JSON.stringify(entry)} needs a reason of at least 20 characters. "Pretending is not allowed" -- a bare exception is indistinguishable from an oversight.`);
      }
      acknowledged.set(entry, reason.trim());
    }
  }

  return Object.freeze({
    file,
    manifestSha256: sha256Hex(Buffer.from(raw, 'utf8')),
    withhold: Object.freeze({ paths: Object.freeze(withhold.paths), prefixes: Object.freeze(withhold.prefixes) }),
    mirror: Object.freeze({ paths: Object.freeze(mirror.paths), prefixes: Object.freeze(mirror.prefixes) }),
    acknowledged
  });
}

function classifyForMirror(relativePath, boundary) {
  const exactWithhold = boundary.withhold.paths.find((entry) => entry === relativePath);
  if (exactWithhold) return { klass: 'withhold', rule: `withhold.paths: ${exactWithhold}` };
  const prefixWithhold = boundary.withhold.prefixes.find((entry) => relativePath.startsWith(entry));
  if (prefixWithhold) return { klass: 'withhold', rule: `withhold.prefixes: ${prefixWithhold}` };
  const exactMirror = boundary.mirror.paths.find((entry) => entry === relativePath);
  if (exactMirror) return { klass: 'mirror', rule: `mirror.paths: ${exactMirror}` };
  const prefixMirror = boundary.mirror.prefixes.find((entry) => relativePath.startsWith(entry));
  if (prefixMirror) return { klass: 'mirror', rule: `mirror.prefixes: ${prefixMirror}` };
  return { klass: 'unclassified', rule: null };
}

function acknowledgementFor(relativePath, boundary) {
  const exact = boundary.acknowledged.get(relativePath);
  if (exact) return { entry: relativePath, reason: exact };
  for (const [entry, reason] of boundary.acknowledged) {
    if (entry.endsWith('/') && relativePath.startsWith(entry)) return { entry, reason };
  }
  return null;
}

/**
 * Split a tree's entries into what is mirrored and what is held back.
 *
 * NON-REGULAR ENTRIES REFUSE RATHER THAN BEING RECORDED. cloud-lane.js excludes
 * gitlinks and symlinks from its manifest and records them, because its unit is
 * a manifest of blobs and a recorded exclusion is honest there. A mirror is a
 * TREE somebody clones and builds, so the two cases are worse than they look: a
 * symlink's classification is taken from its name while its bytes are a path
 * that may point anywhere, and a dropped gitlink hands a cloud agent a tree with
 * a hole in it that nothing in the tree explains.
 *
 * EXCEPT WHEN THE MANIFEST EXPLAINS IT. The sentence above turns on the word
 * "unexplained", and `withhold` is the mechanism by which a path stops being
 * unexplained: it is named, it carries a reason, and the manifest itself
 * travels in the mirror, so the clone can be asked why the hole is there and
 * answer. Refusing a non-regular entry that the manifest has already withheld
 * by name is refusing the case the rule was written to allow.
 *
 * The dangerous directions are untouched. A symlink or gitlink that would be
 * INCLUDED still refuses -- that is the one that publishes bytes chosen by a
 * name -- and so does one that is UNCLASSIFIED, because silence is not an
 * explanation. Only an explicit withhold passes, and it is recorded in
 * `withheld` beside the regular files, so a plan still shows it.
 *
 * This stopped being hypothetical on 2026-08-28: the paid tree is the only
 * mirrored project that is not its own checkout, so its mirror is rooted at
 * the enclosing repository, and that repository tracks a private submodule as
 * a gitlink (mode 160000) to a separate, stale repository. Withholding
 * it is the correct answer and the manifest says so in as many words; before
 * this change the only ways forward were to delete the owner's submodule to
 * appease a gate, or to leave the mirror unpublished, which is what it had
 * been for its whole existence.
 */
function selectMirrorEntries(entries, boundary) {
  const included = [];
  const withheld = [];
  const unclassified = [];
  const nonRegular = [];
  for (const entry of entries) {
    const verdict = classifyForMirror(entry.path, boundary);
    const regular = entry.type === 'blob' && REGULAR_FILE_MODES.includes(entry.mode);
    if (!regular) {
      // Withheld by name: no bytes travel, and the reason is in the manifest.
      if (verdict.klass === 'withhold') {
        withheld.push({ path: entry.path, rule: verdict.rule, mode: entry.mode, type: entry.type });
        continue;
      }
      nonRegular.push({ path: entry.path, mode: entry.mode, type: entry.type });
      continue;
    }
    if (verdict.klass === 'withhold') withheld.push({ path: entry.path, rule: verdict.rule });
    else if (verdict.klass === 'mirror') included.push({ path: entry.path, mode: entry.mode, oid: entry.oid, size: entry.size, rule: verdict.rule });
    else unclassified.push(entry.path);
  }
  return { included, withheld, unclassified, nonRegular };
}

function assertSelectable(selection, boundaryFile) {
  if (selection.nonRegular.length > 0) {
    const named = selection.nonRegular.slice(0, 20).map((item) => `${item.path} (mode ${item.mode}, ${item.type})`);
    fail('CLOUD_MIRROR_NONREGULAR_REFUSED',
      `${selection.nonRegular.length} tree entry/entries are not regular files (symlink, gitlink or subtree) and are not withheld. A symlink is classified by its name and publishes its target; a dropped gitlink hands a cloud agent a tree with an unexplained hole. Name each one under "withhold" in ${boundaryFile} with a reason, which is what stops the hole being unexplained, or remove it from the tree. Refusing: ${named.join(', ')}${selection.nonRegular.length > named.length ? `, and ${selection.nonRegular.length - named.length} more` : ''}.`,
      { paths: selection.nonRegular.map((item) => item.path) });
  }
  if (selection.unclassified.length > 0) {
    const named = selection.unclassified.slice(0, 40);
    fail('CLOUD_MIRROR_UNCLASSIFIED',
      `${selection.unclassified.length} tracked path(s) are named nowhere in ${boundaryFile}. This is a failure by design: an unknown file is not assumed safe to send, so a tree whose sendable set has never been decided cannot leave by silence. Classify each into "mirror" or "withhold": ${named.join(', ')}${selection.unclassified.length > named.length ? `, and ${selection.unclassified.length - named.length} more` : ''}.`,
      { paths: selection.unclassified });
  }
  if (selection.included.length === 0) {
    fail('CLOUD_MIRROR_EMPTY_SELECTION',
      `${boundaryFile} withholds every entry in the tree, so the mirror would be empty. An empty mirror is not a safe publish; it is a cloud lane that silently diffs against nothing.`);
  }
}

// ---------------------------------------------------------------------------
// Mechanism 3: the content refusal.
//
// One `git cat-file --batch` process reads every selected blob. The alternative
// -- one git process per file -- was measured here at over 120 seconds for the
// engine's 2,050 entries and would put a two-minute wall in front of every
// publish, which is how a gate becomes something people skip.
//
// WHAT IT DELIBERATELY DOES NOT DO: it never prints, returns, or persists the
// matched bytes. A refusal that quotes the secret it found writes that secret
// into a log, a terminal buffer and an agent transcript -- three places it was
// not before. It names the path and the SHAPE.
//
// WHAT IT CANNOT SEE, named rather than implied: a credential that does not
// match a known provider shape. A bare 32-character hex string, a password, a
// third-party cloud project id -- none of those have a distinguishing shape, and
// the detector says so by not claiming them. Those are what the `withhold` class
// is for, and why classification is mechanism 2 rather than a formality.
// ---------------------------------------------------------------------------

function scanBlobsForCredentials({ repoRoot, included, boundary, runGitImpl = runGitSync }) {
  if (included.length === 0) return { violations: [], scanned: 0, binarySkipped: 0, acknowledgedHits: [] };
  const stdout = runGitImpl(repoRoot, ['cat-file', '--batch'], {
    input: `${included.map((entry) => entry.oid).join('\n')}\n`,
    encoding: 'buffer'
  });
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'utf8');

  const violations = [];
  const acknowledgedHits = [];
  let offset = 0;
  let index = 0;
  let scanned = 0;
  let binarySkipped = 0;
  while (offset < buffer.length && index < included.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = buffer.slice(offset, newline).toString('utf8');
    const parts = header.split(' ');
    const size = Number.parseInt(parts[2], 10);
    if (parts.length < 3 || !Number.isSafeInteger(size) || size < 0) {
      fail('CLOUD_MIRROR_GIT_FAILED', `git cat-file --batch produced an unparseable header at object ${index + 1}; the content scan cannot be trusted and the publish is refused.`);
    }
    const start = newline + 1;
    const terminator = start + size;
    if (terminator >= buffer.length || buffer[terminator] !== 0x0a) {
      fail('CLOUD_MIRROR_GIT_FAILED', `git cat-file --batch returned a truncated or unterminated body at object ${index + 1}; the content scan cannot be trusted and the publish is refused.`);
    }
    const body = buffer.slice(start, start + size);
    offset = terminator + 1;
    const entry = included[index];
    index += 1;
    if (parts[0] !== entry.oid) {
      fail('CLOUD_MIRROR_GIT_FAILED', `git cat-file --batch returned object ${parts[0]} where ${entry.oid} (${entry.path}) was expected; refusing to pair content with the wrong path.`);
    }
    // A NUL byte is git's own binary heuristic. A binary blob cannot carry a
    // credential the text detector would recognise, and decoding it as UTF-8
    // manufactures replacement characters that match nothing anyway.
    if (body.includes(0)) { binarySkipped += 1; continue; }
    scanned += 1;
    const detector = credentialDetector();
    const match = detector.exec(body.toString('utf8'));
    if (!match) continue;
    const shape = describeShape(match[0]);
    const acknowledgement = acknowledgementFor(entry.path, boundary);
    if (acknowledgement) {
      acknowledgedHits.push({ path: entry.path, shape, rule: acknowledgement.entry });
      continue;
    }
    violations.push({ path: entry.path, shape });
  }
  if (index !== included.length) {
    fail('CLOUD_MIRROR_GIT_FAILED', `git cat-file --batch returned ${index} object(s) for ${included.length} selected file(s); the content scan is incomplete and the publish is refused rather than reported clean.`);
  }
  return { violations, scanned, binarySkipped, acknowledgedHits };
}

// The SHAPE, never the value. Enough to act on, and nothing that survives being
// pasted somewhere.
function describeShape(matched) {
  const text = String(matched);
  if (/^-----BEGIN/.test(text)) return 'PEM private key header';
  if (/^Bearer\s/i.test(text)) return 'inline Bearer token';
  const prefix = text.slice(0, 8).replace(/[^A-Za-z0-9_.-]/g, '');
  return `provider credential prefixed "${prefix}" (${text.length} chars)`;
}

// ---------------------------------------------------------------------------
// Building the mirror tree, without touching the source checkout.
// ---------------------------------------------------------------------------

function temporaryIndexFile(scratchRoot) {
  const fencedRoot = fencedCloudPath(scratchRoot, 'owned temporary Git directory');
  const temporaryRoot = cloudMirrorTemporaryRoot();
  if (!insidePath(temporaryRoot, fencedRoot) || sameLocalPath(temporaryRoot, fencedRoot)) {
    fail('CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      'Cloud Mirror refused to create a temporary index outside its owned temporary Git directory.');
  }
  return fencedCloudPath(path.join(fencedRoot, `index-${crypto.randomUUID()}`), 'temporary Git index');
}

/**
 * Assemble the filtered tree and return its object id.
 *
 * GIT_INDEX_FILE POINTS AT A FRESH FILE INSIDE A FENCED BARE SCRATCH
 * REPOSITORY. `git update-index --index-info` and `git write-tree` therefore
 * open neither the source index nor its writable object database. Source blob
 * ids remain the exact entries in the constructed tree, but their bytes are
 * borrowed through the source object directory as a read-only alternate. New
 * tree objects exist only in scratch and are removed after use.
 *
 * -z is not optional. Without it `--index-info` reads newline-terminated
 * records, and git QUOTES a path containing a newline or a non-ASCII byte --
 * a quoted path is a different string, so the entry would either be rejected or
 * silently name a file that does not exist.
 */
function buildMirrorTree({
  repoRoot,
  included,
  runGitImpl = runGitSync,
  indexFileImpl = temporaryIndexFile,
  scratchRepository = null
}) {
  /* update-index and write-tree are writers even with a temporary index:
   * write-tree stores new tree objects in the repository named by -C. Keep
   * that repository inside our fenced scratch root and expose the selected
   * checkout only as a read-only object alternate. This is what makes the
   * source Git object database, not merely its worktree and index, immutable. */
  const ownsScratch = !scratchRepository;
  const scratch = scratchRepository || isolatedBareRepository(repoRoot);
  const indexFile = indexFileImpl(scratch.root);
  try {
    const records = `${included.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}`).join('\0')}\0`;
    const gitOptions = { indexFile, alternateObjects: scratch.alternateObjects };
    runGitImpl(scratch.root, ['update-index', '-z', '--index-info'], { ...gitOptions, input: records });
    const tree = String(runGitImpl(scratch.root, ['write-tree'], gitOptions)).trim();
    if (!TREE_SHA.test(tree)) {
      fail('CLOUD_MIRROR_GIT_FAILED', `git write-tree returned ${JSON.stringify(tree)}, which is not an object id.`);
    }
    return tree;
  } finally {
    try { fs.rmSync(fencedCloudPath(indexFile, 'temporary Git index'), { force: true }); } catch { /* best effort */ }
    if (ownsScratch) {
      try { removeOwnedTemporaryGitDirectory(scratch.root); } catch { /* best effort */ }
    }
  }
}

function buildPublicationMessage({ sourceCommit, sourceBranch, sourceLabel, boundarySha256, mirroredCount, withheldCount, publishedAt }) {
  return [
    `cloud mirror publication of ${sourceLabel} ${sourceCommit.slice(0, 12)}`,
    '',
    'Written by src/lib/cloud-agent/cloud-mirror.js. The trailers below are',
    'informational human provenance; freshness trusts only local receipts.',
    '',
    `${TRAILER_MARKER}: ${TRAILER_VERSION}`,
    `Source-Repository: ${sourceLabel}`,
    `Source-Commit: ${sourceCommit}`,
    `Source-Branch: ${sourceBranch}`,
    `Boundary-Manifest-Sha256: ${boundarySha256}`,
    `Mirrored-Entries: ${mirroredCount}`,
    `Withheld-Entries: ${withheldCount}`,
    `Published-At: ${publishedAt}`,
    ''
  ].join('\n');
}

function parsePublicationTrailers(message) {
  const trailers = new Map();
  for (const line of String(message).split('\n')) {
    const colon = line.indexOf(': ');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) continue;
    trailers.set(key, line.slice(colon + 2).trim());
  }
  if (trailers.get(TRAILER_MARKER) !== TRAILER_VERSION) return null;
  const sourceCommit = trailers.get('Source-Commit');
  if (!COMMIT_SHA.test(String(sourceCommit))) return null;
  return {
    sourceCommit,
    sourceRepository: trailers.get('Source-Repository') || null,
    sourceBranch: trailers.get('Source-Branch') || null,
    boundaryManifestSha256: trailers.get('Boundary-Manifest-Sha256') || null,
    publishedAt: trailers.get('Published-At') || null
  };
}

// ---------------------------------------------------------------------------
// The registry: which local checkout mirrors to which remote, for which cloud
// repository.
//
// It lives under state/, which is gitignored, because it names a private remote
// URL. programOrStatePath() sends `state` to the per-user state root on an
// installed copy and leaves it under the program root in a source checkout --
// the same single answer every other state file in this repository gets, rather
// than a second location invented here.
// ---------------------------------------------------------------------------

function defaultRegistryPath() {
  return programOrStatePath(PROGRAM_ROOT, ['state', 'cloud-mirror', 'registry.json']);
}

function defaultStateRoot() {
  return programOrStatePath(PROGRAM_ROOT, ['state', 'cloud-mirror']);
}

function registryEntryReverified(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let destination;
  try { destination = githubRepositoryFromRemote(value.mirrorRemote); }
  catch { return false; }
  if (!REPOSITORY.test(String(value.githubRepository || ''))
    || !sameRepository(value.githubRepository, value.cloudRepository)
    || !sameRepository(destination.fullName, value.githubRepository)
    || value.mirrorBranch !== workspaceBranchFor(key)) return false;
  if (typeof value.privacyVerifiedAt !== 'string') return false;
  const verifiedAt = new Date(value.privacyVerifiedAt);
  return !Number.isNaN(verifiedAt.getTime()) && verifiedAt.toISOString() === value.privacyVerifiedAt;
}

function loadRegistry({ registryPath = defaultRegistryPath(), readFileImpl = fs.readFileSync, existsImpl = fs.existsSync } = {}) {
  registryPath = fencedCloudPath(registryPath, 'registry path');
  if (!existsImpl(registryPath)) {
    // NAME THE SHAPE, NOT JUST THE GAP. A refusal that says a file is missing
    // and does not say what belongs in it sends the reader to source-read this
    // module, which is how a correct gate becomes the thing people disable.
    fail('CLOUD_MIRROR_NOT_REGISTERED',
      `no cloud mirror registry exists at ${registryPath}. Nothing can be dispatched to the cloud until the mirror it would diff against is declared, because a dispatch against an undeclared mirror is exactly the silent staleness this registry exists to end. Write that file as: `
      + `{"schemaVersion":"${REGISTRY_SCHEMA}","projects":{"<key>":{"sourceRoot":"<absolute path to the local checkout>","mirrorRemote":"<GitHub URL of the PRIVATE mirror repository>","mirrorBranch":"cloud-mirror/<key>","boundaryManifest":"config/cloud-mirror-boundary.json","cloudRepository":"<the same owner/name the Cloud environment reports>","githubRepository":"<owner/name verified with github.repo_get>","privacyVerifiedAt":"<canonical UTC timestamp>"}}}. `
      + `cloudRepository must match what the provider reports for the environment, because that is the key a dispatch is checked under.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(registryPath, 'utf8'));
  } catch (error) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath} is not valid JSON: ${error && error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== REGISTRY_SCHEMA) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: schemaVersion must be ${JSON.stringify(REGISTRY_SCHEMA)}.`);
  }
  const projects = parsed.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: "projects" must be an object keyed by project name.`);
  }
  const resolved = new Map();
  for (const [key, value] of Object.entries(projects)) {
    if (!PROJECT_KEY.test(key)) {
      fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: project key ${JSON.stringify(key)} must be lowercase [a-z0-9_-], 1-64 characters.`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: project ${key} must be an object.`);
    }
    for (const field of ['sourceRoot', 'mirrorRemote', 'mirrorBranch', 'boundaryManifest', 'cloudRepository']) {
      if (typeof value[field] !== 'string' || !value[field].trim()) {
        fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: project ${key} is missing a non-empty "${field}".`);
      }
    }
    if (!BRANCH.test(value.mirrorBranch)) {
      fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: project ${key} has a malformed mirrorBranch.`);
    }
    if (!REPOSITORY.test(value.cloudRepository)) {
      fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: project ${key} cloudRepository must be an "owner/name" binding, which is what a Codex Cloud environment reports and what a launch declares.`);
    }
    const projectPaths = resolveCloudProjectPaths(value.sourceRoot, value.boundaryManifest);
    const enabled = registryEntryReverified(key, value);
    resolved.set(key, Object.freeze({
      key,
      sourceRoot: projectPaths.sourceRoot,
      mirrorRemote: value.mirrorRemote.trim(),
      mirrorBranch: value.mirrorBranch,
      boundaryManifest: projectPaths.boundaryManifest,
      boundaryRelative: projectPaths.boundaryRelative,
      cloudRepository: value.cloudRepository,
      githubRepository: enabled ? value.githubRepository : null,
      privacyVerifiedAt: enabled ? value.privacyVerifiedAt : null,
      enabled,
      disabledReason: enabled ? null : 'This registry entry does not prove an exact HTTPS GitHub destination on its derived workspace branch. Re-register it before publish or dispatch.'
    }));
  }
  if (resolved.size === 0) {
    fail('CLOUD_MIRROR_NOT_REGISTERED', `${registryPath} declares no projects, so no dispatch can be checked against a mirror.`);
  }
  return { registryPath, projects: resolved };
}

/* ONE MIRROR REPOSITORY SERVES MANY PROJECTS, AND THE BRANCH IS WHAT TELLS THEM
 * APART. The branch is DERIVED from the project key, never chosen, precisely so
 * that two projects can share one private mirror without overwriting each other.
 * This function used to resolve a dispatch by repository alone and return the
 * FIRST match, so sharing really would have landed one project's work in another
 * -- and registration was made to refuse a shared repository to stop it.
 * That fixed the symptom at the cost of the design: the owner has one mirror and
 * was being told to create a second repository for the second project.
 * The refusal belonged here instead. A repository serving several projects is
 * fine; resolving one AMBIGUOUSLY is not. With a branch, the answer is exact;
 * without one, this refuses BY NAME and lists the candidates rather than
 * guessing. Never first-match. */
function projectFor({ registry, projectKey = null, cloudRepository = null, mirrorBranch = null }) {
  if (projectKey !== null) {
    const project = registry.projects.get(projectKey);
    if (!project) {
      fail('CLOUD_MIRROR_NOT_REGISTERED',
        `no project named ${JSON.stringify(projectKey)} in ${registry.registryPath}. Declared: ${[...registry.projects.keys()].join(', ')}.`);
    }
    if (project.enabled !== true) {
      fail('CLOUD_MIRROR_REVERIFY_REQUIRED',
        `project ${JSON.stringify(projectKey)} is disabled because its registry entry has no exact github.repo_get privacy proof. Re-register it before publish or dispatch.`);
    }
    return project;
  }
  const wanted = String(cloudRepository || '').toLowerCase();
  const matches = [...registry.projects.values()].filter((project) => project.cloudRepository.toLowerCase() === wanted);
  if (matches.length === 1) {
    if (matches[0].enabled !== true) {
      fail('CLOUD_MIRROR_REVERIFY_REQUIRED',
        `the mirror for ${JSON.stringify(cloudRepository)} is disabled because its registry entry has no exact github.repo_get privacy proof. Re-register it before dispatch.`);
    }
    return matches[0];
  }
  if (matches.length > 1) {
    if (mirrorBranch !== null) {
      const wantedBranch = String(mirrorBranch).toLowerCase();
      const onBranch = matches.filter((project) => String(project.mirrorBranch || '').toLowerCase() === wantedBranch);
      if (onBranch.length === 1) {
        if (onBranch[0].enabled !== true) {
          fail('CLOUD_MIRROR_REVERIFY_REQUIRED',
            `the mirror for ${JSON.stringify(cloudRepository)} on ${JSON.stringify(mirrorBranch)} is disabled until it is reverified with github.repo_get.`);
        }
        return onBranch[0];
      }
    }
    fail('CLOUD_MIRROR_REPOSITORY_AMBIGUOUS',
      `repository ${JSON.stringify(cloudRepository)} serves ${matches.length} projects in ${registry.registryPath} `
      + `(${matches.map((project) => `${project.key} on ${project.mirrorBranch}`).join(', ')}), and ${mirrorBranch === null ? 'no branch was supplied' : `no project is on branch ${JSON.stringify(mirrorBranch)}`}. `
      + 'Refusing rather than picking one: a dispatch resolved to the wrong project sends its work into the tree of another project.');
  }
  fail('CLOUD_MIRROR_NOT_REGISTERED',
    `no cloud mirror is registered for repository ${JSON.stringify(cloudRepository)} in ${registry.registryPath}, so whether a cloud agent would see the current tree cannot be answered. Refusing rather than dispatching against an unknown branch. Declared repositories: ${[...registry.projects.values()].map((entry) => entry.cloudRepository).join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Registration -- the mechanical setup path.
//
// WHY THIS EXISTS AT ALL. Before it, `state/cloud-mirror/registry.json` was a
// hand-authored file with a REPLACE-ME template in it, and every dispatch
// refused CLOUD_MIRROR_NOT_REGISTERED until a person opened an editor and got
// five fields right. That is a person maintaining a config file, not a product.
// Registration belongs behind a product surface that collects the repository
// binding and source folder, then calls this function mechanically.
//
// WHY IT VERIFIES INSTEAD OF STORING. A private repository can answer
// "Repository not found" when the current Git credential does not cover its
// account. Merely storing that URL would create a registry that appears fully
// configured and fails later inside dispatch as an opaque transport error. So
// every registration fact is established while the customer can still correct
// it, and each failure has its own refusal code.
//
// Privacy and lifecycle are API properties, not Git transport properties. The
// core therefore calls the authenticated github.repo_get implementation it was
// handed and checks that response itself. A caller cannot certify its own
// metadata, and an installed caller cannot disable the transport checks.
// ---------------------------------------------------------------------------

const PROBE_REF = 'refs/heads/toolsenabled-cloud-mirror-write-probe';

function registrationRefusal(code, message) {
  return Object.freeze({ ok: false, code, message });
}

async function verifyRegistration({
  sourceRoot,
  mirrorRemote,
  mirrorBranch,
  boundaryManifest,
  cloudRepository,
  networkGitImpl = defaultNetworkGit,
  runGitImpl = runGitSync,
  githubRepoGetImpl = defaultGithubRepoGet,
  githubRemoteParserImpl = githubRepositoryFromRemote,
  existsImpl = fs.existsSync
}) {
  const checks = [];
  const record = (name, state, detail) => { checks.push(Object.freeze({ name, state, detail })); };

  // 1. The folder. The binding is project -> folder, so a folder that is not a
  //    git checkout cannot be mirrored at all: the manifest comes from
  //    `git ls-tree` against a commit in it.
  let projectPaths;
  try { projectPaths = resolveCloudProjectPaths(sourceRoot, boundaryManifest); }
  catch (error) {
    return { ok: false, checks, refusal: registrationRefusal(
      error && error.code ? error.code : 'CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
      error && error.message ? error.message : 'The selected Cloud Mirror paths could not be fenced to this installation account.'
    ) };
  }
  const resolvedSource = projectPaths.sourceRoot;
  if (!existsImpl(resolvedSource)) {
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_SOURCE_ROOT_ABSENT',
      `${resolvedSource} does not exist, so there is no folder to mirror. Pick the local checkout this cloud project should send.`) };
  }
  try { sourceObjectDirectory(resolvedSource); }
  catch (error) {
    return { ok: false, checks, refusal: registrationRefusal(
      error && error.code ? error.code : 'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      error && error.message ? error.message : 'The source Git metadata boundary could not be established before Git access.'
    ) };
  }
  record('source folder is a git checkout', 'OK', resolvedSource);

  // 2. The boundary manifest. publishMirror() loads this and REFUSES on an
  //    unclassified file; if it is absent the registration would look complete
  //    and the first publish would fail on a file nobody had classified.
  const resolvedBoundary = projectPaths.boundaryManifest;
  if (!existsImpl(resolvedBoundary)) {
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_BOUNDARY_ABSENT',
      `${resolvedBoundary} does not exist. Every file entering a mirror is a publication decision, so a project cannot be registered without the manifest that records those decisions.`) };
  }
  record('boundary manifest present', 'OK', resolvedBoundary);

  // 3. The cloud repository binding's SHAPE. A dispatch is resolved by this
  //    exact string, so a value that merely looks right refuses at dispatch.
  if (!REPOSITORY.test(String(cloudRepository || ''))) {
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_REPOSITORY_MALFORMED',
      `${JSON.stringify(cloudRepository)} is not an "owner/name" binding. That is the shape a Codex Cloud environment reports and the key a dispatch is looked up under.`) };
  }
  record('cloud repository binding is owner/name', 'OK', cloudRepository);

  // The typed remote is the destination authority. Derive owner/name from it,
  // then require both the selected Cloud environment and github.repo_get to
  // name that identical repository. Visibility reported by the Cloud
  // environment is deliberately ignored: it is not the authenticated GitHub
  // metadata for the push destination.
  let destination;
  let verifiedRepository;
  let repositoryMetadata;
  try {
    destination = githubRemoteParserImpl(mirrorRemote);
    if (!sameRepository(destination.fullName, cloudRepository)) {
      fail('CLOUD_MIRROR_ENVIRONMENT_REPOSITORY_MISMATCH',
        `the typed mirror remote resolves to ${destination.fullName}, but the selected Cloud environment reports ${cloudRepository}. They must be the identical repository.`);
    }
    if (typeof githubRepoGetImpl !== 'function') {
      fail('CLOUD_MIRROR_PRIVACY_UNVERIFIED',
        `No authenticated github.repo_get implementation was available to verify ${destination.fullName}.`);
    }
    try {
      repositoryMetadata = await githubRepoGetImpl(destination);
    } catch (error) {
      fail('CLOUD_MIRROR_PRIVACY_UNVERIFIED',
        `github.repo_get could not verify ${destination.fullName}: ${excerpt(error && error.message)}. Nothing was registered.`);
    }
    verifiedRepository = assertPrivateGithubMetadata(repositoryMetadata, destination.fullName);
  } catch (error) {
    return { ok: false, checks, refusal: registrationRefusal(error && error.code ? error.code : 'CLOUD_MIRROR_PRIVACY_UNVERIFIED', error && error.message ? error.message : 'The GitHub destination could not be verified as private.') };
  }
  record('typed remote and Cloud environment name the same repository', 'OK', verifiedRepository);
  record('mirror repository is active', 'OK', 'authenticated github.repo_get reports archived=false and disabled=false for the exact push destination');
  record('mirror repository is private', 'OK', 'authenticated github.repo_get reports private=true and visibility=private for the exact push destination');

  if (!BRANCH.test(String(mirrorBranch || ''))) {
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_BRANCH_MALFORMED',
      `${JSON.stringify(mirrorBranch)} is not a usable branch name.`) };
  }
  record('mirror branch name is usable', 'OK', mirrorBranch);

  // 4. REACH. This is the check that catches a private repository under an
  //    owner the local credential does not cover -- the measured case above.
  const reach = await networkGitImpl(null, ['ls-remote', '--heads', mirrorRemote], { timeoutMs: DEFAULT_NETWORK_TIMEOUT_MS });
  if (reach.exitCode !== 0) {
    const why = excerpt(String(reach.stderr || (reach.timedOut ? 'timed out' : 'no error text')));
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_REMOTE_UNREACHABLE',
      `this computer cannot reach ${mirrorRemote}: ${why}. A private repository under an owner your git credential does not cover answers exactly this way even though the repository exists, so check which account holds it before changing the URL.`) };
  }
  record('mirror repository is reachable', 'OK', `${mirrorRemote} answered ls-remote`);

  // 5. WRITE. Reaching a repository is not being able to publish into it, and
  //    the difference only shows up at push time -- which is far too late,
  //    because by then a registry exists that reads as configured. The probe
  //    ref is a CREATE of a name nothing uses, so it can never be rejected as
  //    a non-fast-forward and a refusal here means credentials, not history.
  //    --dry-run still performs the full authenticated ref negotiation, which
  //    is where a read-only credential is turned away.
  let sourceHead;
  try { sourceHead = resolveCommit(resolvedSource, 'HEAD', runGitImpl); }
  catch (error) {
    return { ok: false, checks, refusal: registrationRefusal(error && error.code ? error.code : 'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE', error && error.message ? error.message : 'The source commit could not be resolved for the write probe.') };
  }
  const write = await networkGitImpl(resolvedSource, ['push', '--dry-run', mirrorRemote, `${sourceHead}:${PROBE_REF}`], { timeoutMs: DEFAULT_NETWORK_TIMEOUT_MS });
  if (write.exitCode !== 0) {
    const why = excerpt(String(write.stderr || (write.timedOut ? 'timed out' : 'no error text')));
    return { ok: false, checks, refusal: registrationRefusal('CLOUD_MIRROR_REMOTE_NOT_WRITABLE',
      `this computer can read ${mirrorRemote} but cannot publish to it: ${why}. Registering it anyway would produce a registry that looks complete and fails at the first dispatch.`) };
  }
  record('this machine can push to the mirror', 'OK', 'dry-run create of a probe ref was accepted');

  return {
    ok: true,
    checks,
    sourceRoot: resolvedSource,
    boundaryManifest: resolvedBoundary,
    boundaryRelative: projectPaths.boundaryRelative,
    githubRepository: verifiedRepository,
    mirrorRemote: `https://github.com/${destination.owner}/${destination.repo}.git`
  };
}

function readRegistryForWrite(registryPath, { readFileImpl = fs.readFileSync, existsImpl = fs.existsSync } = {}) {
  registryPath = fencedCloudPath(registryPath, 'registry path');
  // DELIBERATELY NOT loadRegistry(). That one refuses an empty or absent
  // registry by design, which is correct for a dispatch and wrong for the path
  // whose whole job is to create the first entry.
  if (!existsImpl(registryPath)) return { schemaVersion: REGISTRY_SCHEMA, projects: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(registryPath, 'utf8'));
  } catch (error) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID',
      `${registryPath} is not valid JSON and would be overwritten by registering into it: ${error && error.message}. Fix or remove that file by hand first -- refusing rather than discarding whatever it holds.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath} is not a JSON object.`);
  }
  if (parsed.schemaVersion !== REGISTRY_SCHEMA) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID',
      `${registryPath}: schemaVersion is ${JSON.stringify(parsed.schemaVersion)}, expected ${JSON.stringify(REGISTRY_SCHEMA)}. Refusing to rewrite a registry written to a different schema.`);
  }
  if (!parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
    fail('CLOUD_MIRROR_REGISTRY_INVALID', `${registryPath}: "projects" must be an object keyed by project name.`);
  }
  return parsed;
}

function assertRegistrationSlot(existing, { projectKey, mirrorRemote, mirrorBranch, cloudRepository, replace }) {
  const hasExistingProject = Object.hasOwn(existing.projects, projectKey);
  const existingProject = hasExistingProject ? existing.projects[projectKey] : null;
  if (hasExistingProject && replace !== true) {
    fail('CLOUD_MIRROR_ALREADY_REGISTERED',
      `The registry already declares a project named ${JSON.stringify(projectKey)}. Registering over it would silently repoint an existing mirror. Disable that local binding explicitly before re-registering it.`);
  }
  if (hasExistingProject && registryEntryReverified(projectKey, existingProject)) {
    fail('CLOUD_MIRROR_ACTIVE_REPLACEMENT_REFUSED',
      `The registry already has an enabled, reverified registration for project ${JSON.stringify(projectKey)}. An active Cloud Mirror binding cannot be replaced in place, so no repository was contacted and nothing was published. Keep this binding, or disable it explicitly before registering a different one.`);
  }

  for (const [otherKey, other] of Object.entries(existing.projects)) {
    if (otherKey === projectKey) continue;
    if (other && other.mirrorRemote === mirrorRemote && other.mirrorBranch === mirrorBranch) {
      fail('CLOUD_MIRROR_BRANCH_COLLISION',
        `Project ${JSON.stringify(otherKey)} already publishes to ${mirrorBranch} on ${mirrorRemote}. Two projects sharing one workspace branch overwrite each other's tree on every publish.`);
    }
  }

  const wanted = String(cloudRepository).toLowerCase();
  const wantedBranch = String(mirrorBranch || '').toLowerCase();
  for (const [key, value] of Object.entries(existing.projects)) {
    if (key === projectKey) continue;
    const sameDestination = String(value && value.cloudRepository || '').toLowerCase() === wanted;
    const sameBranch = String(value && value.mirrorBranch || '').toLowerCase() === wantedBranch;
    if (sameDestination && sameBranch) {
      fail('CLOUD_MIRROR_REPOSITORY_ALREADY_BOUND',
        `Project ${JSON.stringify(key)} is already bound to ${cloudRepository} on branch ${value.mirrorBranch}. A dispatch resolves on the repository and branch together, so the pair must be unique.`);
    }
  }
  return { hasExistingProject };
}

function acquireRegistryLock(registryPath, acquireLockImpl = acquireLock) {
  try { return acquireLockImpl(`${registryPath}.lock`); }
  catch (error) {
    fail('CLOUD_MIRROR_REGISTRY_BUSY',
      'Another process owns the Cloud Mirror registry mutation lock, or its ownership cannot be established. Nothing was overwritten.',
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }
}

function writeRegistryAtomic(registryPath, next, {
  writeFileImpl = fs.writeFileSync,
  renameImpl = fs.renameSync,
  mkdirImpl = fs.mkdirSync,
  rmImpl = fs.rmSync
} = {}) {
  mkdirImpl(path.dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileImpl(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameImpl(temporary, registryPath);
  } catch (error) {
    try { rmImpl(temporary, { force: true }); } catch { /* preserve the primary write failure */ }
    throw error;
  }
}

/* THE WORKSPACE NAMESPACE, DERIVED FROM THE PROJECT AND NOT TYPED BY ANYONE.
 *
 * The mirror is a SHARED CLOUD LAUNCH WORKSPACE: the customer supplies the
 * environment, we set up the folder, and several projects may be live in it at
 * once. Those projects have to be kept apart MECHANICALLY, because the
 * alternative -- a branch name a person types at registration -- has already
 * failed twice in one night. `mirrorBranch` defaulted to 'main', so a
 * registration that simply did not mention a branch pointed the workspace at
 * the PUBLICATION branch, and a publish replaced a public repository's entire
 * history with an orphan snapshot. Two projects could equally have been given
 * the same branch and silently overwritten each other.
 *
 * So the branch is now COMPUTED from the project key. Nobody names it, nobody
 * can collide, and no workspace can land on a publication branch. A caller may
 * still pass one, but only inside this namespace -- anything else is refused by
 * name rather than accepted and regretted. */
const WORKSPACE_PREFIX = 'cloud-mirror/';

function workspaceBranchFor(projectKey) {
  return `${WORKSPACE_PREFIX}${projectKey}`;
}

async function registerMirrorProject({
  projectKey,
  sourceRoot,
  mirrorRemote,
  mirrorBranch = null,
  boundaryManifest = 'config/cloud-mirror-boundary.json',
  cloudRepository,
  registryPath = defaultRegistryPath(),
  stateRoot = defaultStateRoot(),
  replace = false,
  networkGitImpl = defaultNetworkGit,
  runGitImpl = runGitSync,
  githubRepoGetImpl = defaultGithubRepoGet,
  githubRemoteParserImpl = githubRepositoryFromRemote,
  // Former escape/caller-certification fields are named only so a stale
  // caller gets a typed refusal instead of having a dangerous option ignored.
  repositoryMetadata,
  providerVisibility,
  acknowledgePublic,
  checkNetwork,
  existsImpl = fs.existsSync,
  readFileImpl = fs.readFileSync,
  writeFileImpl = fs.writeFileSync,
  renameImpl = fs.renameSync,
  mkdirImpl = fs.mkdirSync,
  rmImpl = fs.rmSync,
  unlinkImpl = fs.unlinkSync,
  acquireLockImpl = acquireLock
} = {}) {
  if (repositoryMetadata !== undefined || providerVisibility !== undefined) {
    fail('CLOUD_MIRROR_CALLER_METADATA_REFUSED',
      'Cloud Mirror registration does not accept caller-supplied repository metadata or visibility. The core must fetch the exact destination through authenticated github.repo_get.');
  }
  if (acknowledgePublic !== undefined) {
    fail('CLOUD_MIRROR_PUBLIC_OVERRIDE_REFUSED',
      'Cloud Mirror has no public-repository override. Remove the legacy acknowledgePublic option and select a private GitHub repository.');
  }
  if (checkNetwork !== undefined) {
    fail('CLOUD_MIRROR_NETWORK_CHECK_REQUIRED',
      'Cloud Mirror reachability and write verification cannot be disabled. Remove the legacy no-network option and retry while the private repository is reachable.');
  }
  if (!PROJECT_KEY.test(String(projectKey || ''))) {
    fail('CLOUD_MIRROR_PROJECT_KEY_MALFORMED',
      `project key ${JSON.stringify(projectKey)} must be lowercase [a-z0-9_-], 1-64 characters. It is the name a dispatch refers to, so it is chosen once and typed often.`);
  }
  for (const [field, value] of [['sourceRoot', sourceRoot], ['mirrorRemote', mirrorRemote], ['cloudRepository', cloudRepository]]) {
    if (typeof value !== 'string' || !value.trim()) {
      fail('CLOUD_MIRROR_REGISTRATION_INCOMPLETE', `${field} is required to register a cloud mirror project.`);
    }
  }

  /* Derived when absent; checked when supplied. A workspace branch that is not
   * inside the namespace is refused rather than corrected silently, because the
   * caller who typed 'main' believed something about where their tree was going
   * and deserves to be told it was wrong. */
  const derivedBranch = workspaceBranchFor(projectKey);
  if (mirrorBranch === null || mirrorBranch === undefined) {
    mirrorBranch = derivedBranch;
  } else if (String(mirrorBranch) !== derivedBranch) {
    fail('CLOUD_MIRROR_BRANCH_NOT_A_WORKSPACE',
      `mirrorBranch ${JSON.stringify(mirrorBranch)} is not this project's workspace branch, which is ${JSON.stringify(derivedBranch)}. `
      + 'The mirror is a shared launch workspace and several projects may live in one repository, so each project\'s branch is COMPUTED from its key rather than chosen: that is what keeps two projects from overwriting each other, and what stops a workspace from being pointed at a publication branch. '
      + 'Omit mirrorBranch and it will be derived. If a mirror really must live somewhere else, that is a change to this rule, not an argument at one call site.');
  }

  registryPath = fencedCloudPath(registryPath, 'registry path');
  stateRoot = fencedCloudPath(stateRoot, 'publication receipt root');
  boundaryManifest = portableBoundaryManifest(boundaryManifest);
  const existing = readRegistryForWrite(registryPath, { readFileImpl, existsImpl });
  assertRegistrationSlot(existing, { projectKey, mirrorRemote, mirrorBranch, cloudRepository, replace });

  const verification = await verifyRegistration({
    sourceRoot, mirrorRemote, mirrorBranch, boundaryManifest, cloudRepository,
    networkGitImpl, runGitImpl, githubRepoGetImpl, githubRemoteParserImpl, existsImpl
  });
  if (!verification.ok) {
    fail(verification.refusal.code, verification.refusal.message);
  }

  /* Registration performs long Git reach/write probes. Serialize the final
   * registry read, then re-read GitHub privacy while that mutation lock is
   * held and write immediately afterwards. This closes both gaps: a
   * repository made public during verification never becomes an enabled row,
   * and a sibling process' registration is never lost to a stale whole-file
   * rewrite. */
  const destination = githubRemoteParserImpl(verification.mirrorRemote);
  const lock = acquireRegistryLock(registryPath, acquireLockImpl);
  let entry;
  let hasExistingProject;
  try {
    const current = readRegistryForWrite(registryPath, { readFileImpl, existsImpl });
    ({ hasExistingProject } = assertRegistrationSlot(current,
      { projectKey, mirrorRemote, mirrorBranch, cloudRepository, replace }));

    let finalMetadata;
    try { finalMetadata = await githubRepoGetImpl(destination); }
    catch (error) {
      fail('CLOUD_MIRROR_PRIVACY_UNVERIFIED',
        `github.repo_get could not recheck ${destination.fullName} immediately before registration: ${excerpt(error && error.message)}. Nothing was registered.`);
    }
    const finalRepository = assertPrivateGithubMetadata(finalMetadata, destination.fullName);
    if (!sameRepository(finalRepository, verification.githubRepository)) {
      fail('CLOUD_MIRROR_REPOSITORY_MISMATCH', 'The GitHub destination identity changed during registration. Nothing was registered.');
    }
    const privacyVerifiedAt = new Date().toISOString();

    if (hasExistingProject) {
      const staleReceipt = receiptPath(stateRoot, projectKey);
      if (existsImpl(staleReceipt)) {
        try { unlinkImpl(staleReceipt); }
        catch (error) {
          fail('CLOUD_MIRROR_LOCAL_RESET_FAILED',
            `The disabled binding's prior publication receipt could not be removed: ${excerpt(error && error.message)}. Nothing was re-registered and the remote was not contacted again.`);
        }
      }
    }
    entry = {
      sourceRoot: verification.sourceRoot,
      mirrorRemote: verification.mirrorRemote,
      mirrorBranch,
      boundaryManifest: verification.boundaryRelative,
      cloudRepository: finalRepository,
      githubRepository: finalRepository,
      privacyVerifiedAt
    };
    writeRegistryAtomic(registryPath, {
      schemaVersion: REGISTRY_SCHEMA,
      projects: { ...current.projects, [projectKey]: entry }
    }, { writeFileImpl, renameImpl, mkdirImpl, rmImpl });
  } finally {
    lock.release();
  }

  return Object.freeze({
    ok: true,
    registryPath,
    projectKey,
    project: Object.freeze(entry),
    replaced: hasExistingProject,
    checks: Object.freeze(verification.checks)
  });
}

function listRegisteredProjects({ registryPath = defaultRegistryPath(), readFileImpl = fs.readFileSync, existsImpl = fs.existsSync } = {}) {
  registryPath = fencedCloudPath(registryPath, 'registry path');
  const parsed = readRegistryForWrite(registryPath, { readFileImpl, existsImpl });
  return Object.freeze({
    registryPath,
    projects: Object.freeze(Object.entries(parsed.projects).map(([key, value]) => {
      const enabled = registryEntryReverified(key, value);
      return Object.freeze({
        key,
        ...value,
        enabled,
        disabledReason: enabled
          ? null
          : (typeof value.locallyDisabledAt === 'string'
            ? 'Disabled locally. The GitHub repository and workspace branch were not changed. Re-register this project to use the same or a different private destination.'
            : 'Re-register this entry so its exact HTTPS GitHub destination, derived workspace branch and current private state can be verified.')
      });
    }))
  });
}

/* Disable one binding without contacting or changing its remote.
 *
 * Keeping the destination fields is deliberate: they are the person's record
 * of the repository and branch that still exist on GitHub, and the existing
 * disabled-entry registration path can then revalidate or repoint the project.
 * Removing the verification fields makes registryEntryReverified() false, so
 * publish and dispatch refuse immediately. Publication receipts are local
 * authority for chaining remote heads; they must not survive a reset and later
 * make a re-registered project inherit the prior binding's provenance. */
function disableMirrorProject({
  projectKey,
  registryPath = defaultRegistryPath(),
  stateRoot = defaultStateRoot(),
  disabledAt,
  readFileImpl = fs.readFileSync,
  existsImpl = fs.existsSync,
  writeFileImpl = fs.writeFileSync,
  renameImpl = fs.renameSync,
  mkdirImpl = fs.mkdirSync,
  unlinkImpl = fs.unlinkSync,
  rmImpl = fs.rmSync,
  acquireLockImpl = acquireLock
} = {}) {
  if (!PROJECT_KEY.test(String(projectKey || ''))) {
    fail('CLOUD_MIRROR_PROJECT_KEY_MALFORMED',
      `project key ${JSON.stringify(projectKey)} must be lowercase [a-z0-9_-], 1-64 characters.`);
  }
  if (typeof disabledAt !== 'string' || Number.isNaN(new Date(disabledAt).getTime()) || new Date(disabledAt).toISOString() !== disabledAt) {
    fail('CLOUD_MIRROR_INPUT_INVALID', 'disabledAt must be a canonical UTC ISO-8601 timestamp (Date#toISOString form).');
  }

  registryPath = fencedCloudPath(registryPath, 'registry path');
  stateRoot = fencedCloudPath(stateRoot, 'publication receipt root');
  const receiptFile = receiptPath(stateRoot, projectKey);
  const lock = acquireRegistryLock(registryPath, acquireLockImpl);
  let disabledEntry;
  try {
    const current = readRegistryForWrite(registryPath, { readFileImpl, existsImpl });
    if (!Object.hasOwn(current.projects, projectKey)) {
      fail('CLOUD_MIRROR_NOT_REGISTERED',
        `No cloud mirror project named ${JSON.stringify(projectKey)} is registered. Nothing was changed locally or remotely.`);
    }
    const existing = current.projects[projectKey];
    const alreadyDisabledHere = !registryEntryReverified(projectKey, existing)
      && typeof existing.locallyDisabledAt === 'string';
    if (!registryEntryReverified(projectKey, existing) && !alreadyDisabledHere) {
      fail('CLOUD_MIRROR_ALREADY_DISABLED',
        `Cloud mirror project ${JSON.stringify(projectKey)} is already disabled. Re-register it to verify the same or a different private destination.`);
    }

    if (alreadyDisabledHere) {
      disabledEntry = existing;
    } else {
      const { githubRepository: _githubRepository, privacyVerifiedAt: _privacyVerifiedAt, locallyDisabledAt: _priorDisabledAt, ...retained } = existing;
      disabledEntry = { ...retained, locallyDisabledAt: disabledAt };
      writeRegistryAtomic(registryPath, {
        schemaVersion: REGISTRY_SCHEMA,
        projects: { ...current.projects, [projectKey]: disabledEntry }
      }, { writeFileImpl, renameImpl, mkdirImpl, rmImpl });
    }

    /* The registry is disabled BEFORE receipt cleanup. A cleanup failure can
     * therefore never leave an enabled publisher with its provenance missing;
     * retrying Disable is idempotent and completes the cleanup under the same
     * lock. The remote repository and branch are never contacted. */
    if (existsImpl(receiptFile)) {
      try { unlinkImpl(receiptFile); }
      catch (error) {
        fail('CLOUD_MIRROR_LOCAL_RESET_FAILED',
          `The local binding is disabled, but its publication receipt could not be removed: ${excerpt(error && error.message)}. Retry Disable before re-registering; the remote was not contacted.`);
      }
    }
  } finally {
    lock.release();
  }

  return Object.freeze({
    ok: true,
    registryPath,
    projectKey,
    receiptFile,
    project: Object.freeze({
      key: projectKey,
      ...disabledEntry,
      enabled: false,
      disabledReason: 'Disabled locally. The GitHub repository and workspace branch were not changed. Re-register this project to use the same or a different private destination.'
    })
  });
}

// ---------------------------------------------------------------------------
// Receipts.
// ---------------------------------------------------------------------------

function receiptPath(stateRoot, projectKey) {
  return path.join(stateRoot, `${projectKey}.json`);
}

function writeJsonRecord(filePath, record) {
  filePath = fencedCloudPath(filePath, 'publication receipt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = fencedCloudPath(
    `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`,
    'temporary publication receipt'
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    // Flush the received name as well as the temporary file's bytes. On
    // Windows this is the strongest file-level durability primitive Node
    // exposes for the rename result; the record remains atomic on every path.
    descriptor = fs.openSync(filePath, 'r+');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary write failure */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the primary write failure */ }
    throw error;
  }
}

function readReceipts(stateRoot, projectKey, { readFileImpl = fs.readFileSync, existsImpl = fs.existsSync } = {}) {
  stateRoot = fencedCloudPath(stateRoot, 'publication receipt root');
  const file = receiptPath(stateRoot, projectKey);
  if (!existsImpl(file)) return { file, latest: null, history: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(file, 'utf8'));
  } catch {
    // A corrupt receipt file must not read as "no publication has been made":
    // that is the difference between a slow check and a wrong one.
    fail('CLOUD_MIRROR_RECEIPT_INVALID', `${file} is not valid JSON. Delete it and republish, or run the check with a deep read; it must never be treated as an absent receipt.`);
  }
  if (!parsed || parsed.schemaVersion !== RECEIPT_SCHEMA) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID', `${file}: schemaVersion must be ${JSON.stringify(RECEIPT_SCHEMA)}.`);
  }
  if (parsed.latest !== null && (typeof parsed.latest !== 'object' || Array.isArray(parsed.latest))) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID', `${file}: "latest" must be a publication object or null; an unreadable latest receipt cannot be treated as no publication.`);
  }
  if (!Array.isArray(parsed.history)) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID', `${file}: "history" must be an array; an unreadable receipt history cannot be treated as empty.`);
  }
  return { file, latest: parsed.latest, history: parsed.history };
}

function recordPublication(stateRoot, projectKey, publication) {
  const existing = fs.existsSync(receiptPath(stateRoot, projectKey))
    ? readReceipts(stateRoot, projectKey)
    : { latest: null, history: [] };
  const history = [existing.latest, ...existing.history]
    .filter(Boolean)
    .filter((entry) => entry.publicationCommit !== publication.publicationCommit)
    .slice(0, RECEIPT_HISTORY_LIMIT);
  const file = receiptPath(stateRoot, projectKey);
  writeJsonRecord(file, { schemaVersion: RECEIPT_SCHEMA, projectKey, latest: publication, history });
  return file;
}

function findPublication(receipts, publicationCommit) {
  for (const entry of [receipts.latest, ...receipts.history]) {
    if (entry && entry.publicationCommit === publicationCommit) return entry;
  }
  return null;
}

function restorePublicationCommitObject(scratch, publication, runGitImpl = runGitSync) {
  const encoded = publication && publication.publicationCommitObjectBase64;
  if (typeof encoded !== 'string' || encoded.length === 0) return false;
  if (encoded.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID',
      'A recorded Cloud Mirror publication commit object is not bounded canonical base64. Refusing to use it as local write provenance.');
  }
  const body = Buffer.from(encoded, 'base64');
  if (body.toString('base64') !== encoded) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID',
      'A recorded Cloud Mirror publication commit object is not canonical base64. Refusing to use it as local write provenance.');
  }
  const restored = String(runGitImpl(scratch.root, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: body,
    alternateObjects: scratch.alternateObjects
  })).trim();
  if (restored !== publication.publicationCommit) {
    fail('CLOUD_MIRROR_RECEIPT_INVALID',
      'A recorded Cloud Mirror publication commit object does not hash to its recorded publication commit. Refusing to use it as local write provenance.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// publish.
// ---------------------------------------------------------------------------

function resolveCommit(repoRoot, revision, runGitImpl) {
  const resolved = String(runGitImpl(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`])).trim();
  if (!COMMIT_SHA.test(resolved)) {
    fail('CLOUD_MIRROR_INPUT_INVALID', `${revision} does not resolve to a commit in ${repoRoot}.`);
  }
  return resolved;
}

function readTreeEntries(repoRoot, commit, runGitImpl) {
  return parseLsTreeOutput(String(runGitImpl(repoRoot, ['ls-tree', '-r', '-l', '-z', commit])));
}

function assertBoundarySnapshotUnchanged(project, expected, loadBoundaryImpl) {
  const current = loadBoundaryImpl(project.boundaryManifest);
  if (!current || current.manifestSha256 !== expected.manifestSha256) {
    fail('CLOUD_MIRROR_BOUNDARY_CHANGED',
      'The Cloud Mirror boundary manifest changed after this tree was classified. Nothing was pushed; run Publish again against the current decision.',
      { expectedManifestSha256: expected.manifestSha256, currentManifestSha256: current && current.manifestSha256 });
  }
  return current;
}

// The count of paths whose working-tree content differs from the commit being
// published. REPORTED, NEVER REFUSED: a mirror mirrors HEAD, which is the only
// thing a remote can be handed, and both checkouts carry uncommitted work at
// essentially all times (measured tonight: engine 42 paths, app 5). Refusing
// would make the lane unusable; staying silent would let a person believe a
// cloud agent can see work that was never committed. So it is counted and
// printed.
function countUncommittedPaths(repoRoot, runGitImpl) {
  const status = String(runGitImpl(repoRoot, ['status', '--porcelain', '-z']));
  return status.split('\0').filter((record) => record.length > 0).length;
}

async function publishMirror({
  projectKey,
  registryPath,
  stateRoot = defaultStateRoot(),
  revision = 'HEAD',
  publishedAt,
  runGitImpl = runGitSync,
  networkGitImpl = defaultNetworkGit,
  loadRegistryImpl = loadRegistry,
  loadBoundaryImpl = loadBoundary,
  githubRepoGetImpl = defaultGithubRepoGet,
  githubRemoteParserImpl = githubRepositoryFromRemote,
  acquireLockImpl = acquireLock
}) {
  if (typeof publishedAt !== 'string' || Number.isNaN(new Date(publishedAt).getTime()) || new Date(publishedAt).toISOString() !== publishedAt) {
    fail('CLOUD_MIRROR_INPUT_INVALID', 'publishedAt must be a canonical UTC ISO-8601 timestamp (Date#toISOString form).');
  }
  const registry = loadRegistryImpl(registryPath ? { registryPath } : {});
  const project = projectFor({ registry, projectKey });

  // PRIVACY IS A PUBLISH-TIME FACT, not a registration-time promise. First
  // re-derive the exact destination from the stored remote; the authenticated
  // github.repo_get recheck itself is placed beside the push below so a long
  // scan cannot create a check-to-publish gap. There is deliberately no
  // override.
  const destination = githubRemoteParserImpl(project.mirrorRemote);
  if (!sameRepository(destination.fullName, project.githubRepository)
    || !sameRepository(destination.fullName, project.cloudRepository)) {
    fail('CLOUD_MIRROR_REPOSITORY_MISMATCH',
      `the push remote resolves to ${destination.fullName}, while the verified registry binding names ${project.githubRepository || project.cloudRepository}. Re-register before publish.`);
  }
  // Establish the local Git metadata boundary before loadBoundary or any Git
  // command. Stored registry data is not authority to follow a changed .git.
  sourceObjectDirectory(project.sourceRoot);
  const boundary = loadBoundaryImpl(project.boundaryManifest);

  const sourceCommit = resolveCommit(project.sourceRoot, revision, runGitImpl);
  const sourceBranch = String(runGitImpl(project.sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const entries = readTreeEntries(project.sourceRoot, sourceCommit, runGitImpl);
  const selection = selectMirrorEntries(entries, boundary);
  assertSelectable(selection, project.boundaryManifest);

  const scan = scanBlobsForCredentials({ repoRoot: project.sourceRoot, included: selection.included, boundary, runGitImpl });
  if (scan.violations.length > 0) {
    const named = scan.violations.slice(0, 20).map((hit) => `${hit.path} [${hit.shape}]`);
    fail('CLOUD_MIRROR_CREDENTIAL_IN_PAYLOAD',
      `${scan.violations.length} file(s) selected for the mirror contain a credential-shaped value. Nothing was sent. Withhold the file, remove the value, or -- if it is a fixture -- acknowledge it by name in ${project.boundaryManifest} with a stated reason: ${named.join(', ')}${scan.violations.length > named.length ? `, and ${scan.violations.length - named.length} more` : ''}.`,
      { paths: scan.violations.map((hit) => hit.path) });
  }

  // WHAT IS ON THE MIRROR NOW, BEFORE ANYTHING IS PUSHED. A mirror branch that
  // carries commits this module did not write is a cloud agent's work that has
  // not been harvested, and republishing over it would make it unreachable. That
  // is somebody else's half of the loop, so the refusal names it and stops
  // rather than deciding for them.
  //
  // Publication provenance is intentionally stricter than the read-only
  // freshness witness. A remote head is chained only when this installation's
  // receipt history names that exact commit. Trailer text from another machine
  // is untrusted input; importing it here would make remote work a parent of
  // the locally authoritative publication. A receipt-authenticated prior
  // commit body can be rehydrated and hash-checked in the ephemeral scratch
  // object database; an unknown head still refuses without fetch, adoption,
  // force or supersede behavior.
  const registryFile = fencedCloudPath(registry.registryPath || registryPath || defaultRegistryPath(), 'registry path');
  stateRoot = fencedCloudPath(stateRoot, 'publication receipt root');
  const mutationLock = acquireRegistryLock(registryFile, acquireLockImpl);
  let publicationScratch = null;
  try {
    const lockedRegistry = loadRegistryImpl({ registryPath: registryFile });
    const lockedProject = projectFor({ registry: lockedRegistry, projectKey });
    if (!sameLocalPath(lockedProject.sourceRoot, project.sourceRoot)
        || !sameLocalPath(lockedProject.boundaryManifest, project.boundaryManifest)
        || lockedProject.mirrorRemote !== project.mirrorRemote
        || lockedProject.mirrorBranch !== project.mirrorBranch
        || !sameRepository(lockedProject.cloudRepository, project.cloudRepository)
        || !sameRepository(lockedProject.githubRepository, project.githubRepository)) {
      fail('CLOUD_MIRROR_BINDING_CHANGED',
        'The Cloud Mirror binding changed after its tree was classified. Nothing was pushed; run Publish again against the current binding.');
    }
    assertBoundarySnapshotUnchanged(lockedProject, boundary, loadBoundaryImpl);

  const remoteHeadBefore = await readMirrorRef({ remote: project.mirrorRemote, branch: project.mirrorBranch, networkGitImpl });
  const receipts = readReceipts(stateRoot, project.key);
  const chainPublication = remoteHeadBefore ? findPublication(receipts, remoteHeadBefore) : null;
  const chainParent = chainPublication ? remoteHeadBefore : null;
  if (remoteHeadBefore && !chainParent) {
    fail('CLOUD_MIRROR_UNHARVESTED_WORK',
      `${project.mirrorRemote} branch ${project.mirrorBranch} is at ${remoteHeadBefore.slice(0, 12)}, which no local publication receipt for project ${project.key} accounts for. Remote trailers are not trusted as write provenance, so nothing was fetched, adopted, force-pushed or overwritten. Reconcile or reset that private mirror branch through an explicit recovery workflow, then publish again.`,
      { mirrorHead: remoteHeadBefore });
  }

  publicationScratch = isolatedBareRepository(project.sourceRoot);
  if (chainPublication) restorePublicationCommitObject(publicationScratch, chainPublication, runGitImpl);
  const tree = buildMirrorTree({
    repoRoot: project.sourceRoot,
    included: selection.included,
    runGitImpl,
    scratchRepository: publicationScratch
  });
  const message = buildPublicationMessage({
    sourceCommit,
    sourceBranch,
    sourceLabel: project.cloudRepository,
    boundarySha256: boundary.manifestSha256,
    mirroredCount: selection.included.length,
    withheldCount: selection.withheld.length,
    publishedAt
  });
  const commitArgs = ['commit-tree', tree, '-m', message];
  if (chainParent) commitArgs.splice(2, 0, '-p', chainParent);
  const publicationCommit = String(runGitImpl(publicationScratch.root, [
    '-c', 'user.name=ToolsEnabled cloud mirror',
    '-c', 'user.email=cloud-mirror@toolsenabled.ai',
    ...commitArgs
  ], { alternateObjects: publicationScratch.alternateObjects })).trim();
  if (!COMMIT_SHA.test(publicationCommit)) {
    fail('CLOUD_MIRROR_GIT_FAILED', `git commit-tree returned ${JSON.stringify(publicationCommit)}, which is not a commit id.`);
  }
  const publicationCommitObject = runGitImpl(publicationScratch.root,
    ['cat-file', 'commit', publicationCommit],
    { alternateObjects: publicationScratch.alternateObjects, encoding: 'buffer' });
  const publicationCommitObjectBuffer = Buffer.isBuffer(publicationCommitObject)
    ? publicationCommitObject
    : Buffer.from(String(publicationCommitObject), 'utf8');

  // The refspec is the RESOLVED COMMIT ID, never a local ref name. Pushing
  // `HEAD:refs/heads/x` would publish whatever HEAD happens to be at the moment
  // the push runs; pushing the id publishes the thing that was just classified
  // and scanned. There is no force/supersede path: an unaccounted remote head
  // already refused above, while an accounted head is chained as the parent.
  let repositoryMetadata;
  try {
    repositoryMetadata = await githubRepoGetImpl(destination);
  } catch (error) {
    fail('CLOUD_MIRROR_PRIVACY_UNVERIFIED',
      `github.repo_get could not recheck ${destination.fullName} immediately before publish: ${excerpt(error && error.message)}. Nothing was sent.`);
  }
  assertPrivateGithubMetadata(repositoryMetadata, destination.fullName);

  // Privacy is checked immediately before the write, and the customer's exact
  // publication decision is too. A manifest edited while the remote was being
  // inspected cannot authorize a tree classified from its previous bytes.
  assertBoundarySnapshotUnchanged(lockedProject, boundary, loadBoundaryImpl);

  const refspec = `${publicationCommit}:refs/heads/${project.mirrorBranch}`;
  const pushArgs = ['push', project.mirrorRemote, refspec];
  const push = await networkGitImpl(project.sourceRoot, pushArgs, { scratchRepository: publicationScratch });
  if (!push || push.exitCode !== 0) {
    fail('CLOUD_MIRROR_PUSH_FAILED',
      `pushing ${publicationCommit.slice(0, 12)} to ${project.mirrorRemote} ${project.mirrorBranch} failed (exit ${push ? push.exitCode : '(none)'}): ${excerpt(push && (push.stderr || push.stdout))}`);
  }

  // CONFIRM FROM THE REMOTE, NOT FROM THE PUSH'S EXIT CODE. A zero exit says
  // the client believes it succeeded. Reading the ref back says the branch is
  // where we think it is, which is the fact the freshness check will later rely
  // on.
  const remoteHeadAfter = await readMirrorRef({ remote: project.mirrorRemote, branch: project.mirrorBranch, networkGitImpl });
  if (remoteHeadAfter !== publicationCommit) {
    fail('CLOUD_MIRROR_PUSH_UNCONFIRMED',
      `git push reported success but ${project.mirrorRemote} branch ${project.mirrorBranch} reads back as ${remoteHeadAfter || '(absent)'} rather than ${publicationCommit}. No receipt is written: an unconfirmed publication must never make a later freshness check pass.`);
  }

  const publication = {
    publicationCommit,
    publicationTree: tree,
    sourceCommit,
    sourceBranch,
    cloudRepository: project.cloudRepository,
    mirrorRemote: project.mirrorRemote,
    mirrorBranch: project.mirrorBranch,
    boundaryManifest: project.boundaryManifest,
    boundaryManifestSha256: boundary.manifestSha256,
    mirroredEntries: selection.included.length,
    withheldEntries: selection.withheld.length,
    publishedAt,
    // The next publication may need this exact locally-authored parent after
    // the ephemeral scratch repository is gone. Persisting the bounded commit
    // body (provenance only, no mirrored blob bytes) lets a later scratch ODB
    // restore and hash-check that object without fetching or trusting remote
    // content and without ever storing it in the source repository.
    publicationCommitObjectBase64: publicationCommitObjectBuffer.toString('base64')
  };
  const receiptFile = recordPublication(stateRoot, project.key, publication);
  return {
    project: project.key,
    publication,
    receiptFile,
    withheld: selection.withheld,
    scan: { scanned: scan.scanned, binarySkipped: scan.binarySkipped, acknowledgedHits: scan.acknowledgedHits },
    uncommittedPaths: countUncommittedPaths(project.sourceRoot, runGitImpl)
  };
  } finally {
    if (publicationScratch) {
      try { removeOwnedTemporaryGitDirectory(publicationScratch.root); } catch { /* best effort for owned scratch */ }
    }
    mutationLock.release();
  }
}

// ---------------------------------------------------------------------------
// check: the dispatch gate.
// ---------------------------------------------------------------------------

async function readMirrorRef({ remote, branch, networkGitImpl = defaultNetworkGit }) {
  const outcome = await networkGitImpl(null, ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`]);
  if (outcome && outcome.exitCode === 2) return null; // --exit-code: 2 means the ref is absent
  if (!outcome || outcome.exitCode !== 0) {
    fail('CLOUD_MIRROR_REMOTE_UNREADABLE',
      `the mirror ${remote} could not be read (exit ${outcome ? outcome.exitCode : '(none)'}): ${excerpt(outcome && (outcome.stderr || outcome.stdout))}. "Could not look" is not "it is current", so nothing is dispatched.`);
  }
  const line = String(outcome.stdout).split('\n').map((value) => value.trim()).find((value) => value.length > 0);
  if (!line) return null;
  const sha = line.split(/\s+/)[0];
  if (!COMMIT_SHA.test(sha)) {
    fail('CLOUD_MIRROR_REMOTE_UNREADABLE',
      `the mirror ${remote} returned an unparseable ref for ${branch}: ${excerpt(line)}. An unreadable answer is not an absent branch, so nothing is dispatched.`);
  }
  return sha;
}

/**
 * REFUSE UNLESS THE MIRROR IS AT LOCAL HEAD.
 *
 * Returns a fresh verdict or throws a named refusal. There is no "warn" and no
 * flag that turns any of these into one: a gate that can be downgraded is
 * downgraded on the day it finally catches something.
 *
 * The comparison is three-part, and each part closes a way the mirror can be
 * wrong while the other two look right:
 *   1. the mirror branch's exact head is a publication this installation
 *      recorded locally -- otherwise CLOUD_MIRROR_PUBLICATION_UNKNOWN before
 *      any fetch or adoption. Remote commit trailers are informational only;
 *   2. the source commit it was built from is the checkout's HEAD right now --
 *      otherwise CLOUD_MIRROR_STALE, with the exact distance;
 *   3. re-selecting the tree from that HEAD under the CURRENT boundary manifest
 *      produces the tree that was published -- otherwise
 *      CLOUD_MIRROR_BOUNDARY_DRIFTED, which is the case where HEAD matches and
 *      the mirror still holds different files because the boundary changed
 *      underneath it.
 */
async function checkMirrorFreshness({
  cloudRepository = null,
  projectKey = null,
  /* Supplied by the single-task launch, which knows the branch it is dispatching
     to. One mirror repository serves several projects, so the branch is what says
     WHICH -- without it projectFor refuses by name rather than guessing. */
  mirrorBranch = null,
  registryPath,
  stateRoot = defaultStateRoot(),
  runGitImpl = runGitSync,
  networkGitImpl = defaultNetworkGit,
  loadRegistryImpl = loadRegistry,
  loadBoundaryImpl = loadBoundary
} = {}) {
  stateRoot = fencedCloudPath(stateRoot, 'publication receipt root');
  const registry = loadRegistryImpl(registryPath ? { registryPath } : {});
  const project = projectFor({ registry, projectKey, cloudRepository, mirrorBranch });
  sourceObjectDirectory(project.sourceRoot);
  const localHead = resolveCommit(project.sourceRoot, 'HEAD', runGitImpl);

  const mirrorHead = await readMirrorRef({ remote: project.mirrorRemote, branch: project.mirrorBranch, networkGitImpl });
  if (!mirrorHead) {
    fail('CLOUD_MIRROR_BRANCH_ABSENT',
      `${project.mirrorRemote} has no branch ${project.mirrorBranch}, so a cloud task bound to ${project.cloudRepository} would diff against nothing. Publish the mirror first.`,
      { project: project.key });
  }

  const receipts = readReceipts(stateRoot, project.key);
  const publication = findPublication(receipts, mirrorHead);
  if (!publication) {
    fail('CLOUD_MIRROR_PUBLICATION_UNKNOWN',
      `${project.mirrorRemote} branch ${project.mirrorBranch} is at ${mirrorHead.slice(0, 12)}, which no local publication receipt for project ${project.key} covers. Remote commit trailers are informational human provenance and are not trusted as freshness authority, so nothing was fetched, adopted or dispatched. Reconcile or reset that private mirror branch through an explicit recovery workflow, then publish again from this installation.`,
      { project: project.key, mirrorHead });
  }

  if (publication.sourceCommit !== localHead) {
    let distance = null;
    try {
      distance = Number.parseInt(String(runGitImpl(project.sourceRoot, ['rev-list', '--count', `${publication.sourceCommit}..${localHead}`])).trim(), 10);
    } catch { distance = null; }
    fail('CLOUD_MIRROR_STALE',
      `the cloud mirror for ${project.cloudRepository} was built from ${publication.sourceCommit.slice(0, 12)} and this checkout is at ${localHead.slice(0, 12)}${Number.isSafeInteger(distance) ? `, ${distance} commit(s) ahead` : ''}. A cloud agent would diff against a tree that is not the one here, which is how a task comes back with an empty apply or a citation pointing at unrelated code. Nothing was sent. Publish the mirror, then dispatch.`,
      { project: project.key, mirrorSourceCommit: publication.sourceCommit, localHead, commitsBehind: distance });
  }

  // The boundary can move without HEAD moving. Re-select from the same commit
  // under the manifest as it reads NOW and compare object ids: a tree id is a
  // content address, so equality is proof rather than a claim.
  const boundary = loadBoundaryImpl(project.boundaryManifest);
  const selection = selectMirrorEntries(readTreeEntries(project.sourceRoot, localHead, runGitImpl), boundary);
  assertSelectable(selection, project.boundaryManifest);
  const expectedTree = buildMirrorTree({ repoRoot: project.sourceRoot, included: selection.included, runGitImpl });
  // The locally written receipt carries the published tree id. Reading a tree
  // or claimed source binding from the remote would turn untrusted mirror bytes
  // into freshness authority, so there is deliberately no remote fallback.
  const publishedTree = publication.publicationTree;
  if (!TREE_SHA.test(String(publishedTree))) {
    fail('CLOUD_MIRROR_PUBLICATION_UNKNOWN',
      `no tree id is recorded for mirror head ${mirrorHead.slice(0, 12)}, so what the mirror actually holds cannot be compared with what the boundary selects today. Republish before dispatching.`,
      { project: project.key, mirrorHead });
  }
  if (publishedTree !== expectedTree) {
    fail('CLOUD_MIRROR_BOUNDARY_DRIFTED',
      `the mirror for ${project.cloudRepository} is built from this checkout's HEAD, but the tree it holds (${publishedTree.slice(0, 12)}) is not the tree ${project.boundaryManifest} selects today (${expectedTree.slice(0, 12)}). The boundary decision changed after the last publish, so the mirror holds a different set of files than the one now approved. Republish before dispatching.`,
      { project: project.key, publishedTree, expectedTree });
  }

  return Object.freeze({
    fresh: true,
    project: project.key,
    cloudRepository: project.cloudRepository,
    mirrorRemote: project.mirrorRemote,
    mirrorBranch: project.mirrorBranch,
    mirrorHead,
    localHead,
    mirroredEntries: selection.included.length,
    withheldEntries: selection.withheld.length,
    witness: 'receipt'
  });
}

module.exports = Object.freeze({
  BOUNDARY_SCHEMA,
  RECEIPT_SCHEMA,
  REGISTRY_SCHEMA,
  TRAILER_MARKER,
  acknowledgementFor,
  buildMirrorTree,
  buildPublicationMessage,
  checkMirrorFreshness,
  classifyForMirror,
  defaultNetworkGit,
  defaultRegistryPath,
  defaultStateRoot,
  disableMirrorProject,
  githubRepositoryFromRemote,
  assertPrivateGithubMetadata,
  loadBoundary,
  loadRegistry,
  listRegisteredProjects,
  registerMirrorProject,
  verifyRegistration,
  parsePublicationTrailers,
  projectFor,
  publishMirror,
  readMirrorRef,
  readReceipts,
  runGitSync,
  sourceGitMetadata,
  scanBlobsForCredentials,
  selectMirrorEntries,
  assertSelectable
});
