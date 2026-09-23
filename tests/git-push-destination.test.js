// EXECUTABLE CHANGE — the uninstalled-checkout precondition now discriminates instead of passing vacuously.
//
// CAN-FAIL AUDIT (2026-08-26)
// MUTATION: in a scratch copy, remove .githooks/pre-push. Before this change the test remained
// green because the governance guard exited before every assertion. After this change it is RED:
//   AssertionError [ERR_ASSERTION]: the checkout must still carry the hook being audited
// RESTORE: the scratch mutation was removed byte-for-byte; the restored run is GREEN:
//   uninstalled checkout precondition: 3 checks passed
// PRECONDITION NOT MET: this checkout has no hooks:install script, so the private-installation
// and live-origin canary assertions cannot run here. The direct branch still invokes the real
// hook directly and proves that a public destination is refused while a private control is allowed.
// NOT-FOUND: empty loop/forEach assertion collections (the sole assertion loop uses a non-empty
// literal); bare non-zero/truthy process assertions without subject output; swallowed target
// failures; mocks of the hook; and expected values computed by the hook code under test.
// The declared private destination is pinned below rather than inferred from the live remote. That
// makes an allowlist change turn this suite red until the expected official destination is reviewed
// and changed with it; existing refusal assertions are not deleted or weakened.
'use strict';

// THE FENCE THAT KEEPS THIS REPOSITORY PRIVATE.
//
// ToolsEnabled/engine is private source and stays private as a property to
// CHECK rather than remember. Measured 2026-08-13: `.githooks/pre-push` asked
// four unrelated questions and ended in an unconditional `exit 0` with no
// destination check of any kind. The private-destination fence below closes
// that gap. The manifest's `open` classification describes customer-
// distributable licensing; it grants no public-repository authority.
//
// What a single wrong push costs, exactly: 94a9d22:src/lib/providers/license.js
// is 12,622 readable bytes containing LICENSE_VAULT_KEY and a self-minting
// keygen path, and that commit is an ancestor of origin/main. A push publishes
// history, not the tip, so one push to a public destination publishes the paid
// licensing module and there is no undo.
//
// HOW THIS SUITE DRIVES THE HOOK. Not by re-implementing its logic and not by
// reading its source for reassuring substrings: it spawns the real
// .githooks/pre-push through a POSIX shell with exactly the two arguments git
// gives a pre-push hook ($1 remote name, $2 remote URL) and a realistic ref line
// on stdin, then reads the exit code off spawnSync's own `status` field -- never
// through a shell pipe, where `$?` would be the last command in the pipeline
// (STANDING-ORDERS.md Class SYNC).
//
// WHY MOST CASES RUN WITH node REMOVED FROM PATH. Measured on this machine: a
// full allow-direction run of this hook takes 52-80 seconds, because section 3
// sweeps every worktree and local branch. With node absent the hook prints "node
// is not on PATH ... Unknown, not safe" and exits 0 in milliseconds -- so every
// case below is fast, AND the scrub doubles as the sharpest test in the file:
// the destination gate sits above the `command -v node` bail-out precisely so
// that a missing node cannot turn "refuse" into "push anywhere you like". Two
// cases deliberately run with the ordinary, unscrubbed PATH so that no verdict
// here is an artifact of the scrub.
//
// EVERY REFUSAL CASE IS PAIRED WITH A GREEN CONTROL in the same run. A harness
// that returned 1 for everything would pass a refusal-only suite silently; that
// exact trap produced three false verifications on 2026-08-09.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-push');

/* WHETHER THIS CHECKOUT INSTALLED THE FENCE, AND WHY THAT MUST BE ASKED.
 *
 * A checkout can contain the hook without having configured core.hooksPath.
 * Installation-specific assertions and a live-origin canary cannot honestly
 * run there. That does not make the checkout a public export: the engine source
 * remains private everywhere. The branch below directly drives the checked-in
 * hook so its private-only destination policy is still executable evidence.
 *
 * A permanent red is not a harmless one. It trains people to read this file's
 * failure as noise, and this is the file that would tell them the private
 * history was about to reach a public destination.
 *
 * THE DISCRIMINATOR IS THE FENCE'S OWN INSTALLER, and that is deliberate. The
 * hook's header states it is installed by the "hooks:install" npm script; a
 * repository that does not declare that script is not one the hook was ever
 * meant to run in. Reading `git remote get-url origin` instead would be
 * circular -- the canary below exists precisely to catch a repointed origin, so
 * it cannot take its own premise from the thing it is checking.
 *
 * NOT SKIPPED SILENTLY. If this ever skips in the private repository, the
 * hooks:install script has gone missing and the fence is not installed --
 * which is a finding, not a pass. The skip prints, and it names the reason.
 */
function fenceGovernsThisRepository() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
  catch { return { governs: true, reason: null }; }
  const installer = manifest && manifest.scripts && manifest.scripts['hooks:install'];
  if (typeof installer === 'string' && installer.trim()) return { governs: true, reason: null };
  return {
    governs: false,
    reason: 'package.json declares no "hooks:install" script, so this checkout has not installed the pre-push '
      + 'fence through that declared mechanism. Engine source remains private. The checked-in hook is audited '
      + 'directly here; install and verify core.hooksPath before relying on it during a real push.'
  };
}

// The declared private destination, written out here rather than read from
// `git remote get-url origin`. If this suite took its expected answer from the
// live remote, repointing origin at a public repository would repoint the test
// with it and the fence would still look green. The live remote is checked
// against this constant instead -- see the last case in the file.
const PRIVATE_URL = 'https://github.com/ToolsEnabled/engine';
const PRIVATE_ID = 'github.com/toolsenabled/engine';

const governance = fenceGovernsThisRepository();

// A token-shaped string used to prove the hook never echoes credentials that
// arrive inside a push URL. It is not a real credential.
const FAKE_TOKEN = 'ghp_NotARealTokenJustAFixture0000000000';

let checks = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    checks += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error && error.message}\n`);
  }
}

// --- locating a POSIX shell -------------------------------------------------
// git runs hooks through its own bundled sh on Windows, so if git exists sh
// exists. A machine where it cannot be found is a machine where this hook does
// not run at all, which is a failure to report, never a skip to pass over.
function findShell() {
  const candidates = [];
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (execPath.status === 0 && typeof execPath.stdout === 'string' && execPath.stdout.trim()) {
    // .../Git/mingw64/libexec/git-core -> .../Git/usr/bin/sh.exe
    candidates.push(path.resolve(execPath.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\usr\\bin\\sh.exe');
  candidates.push('C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe');
  candidates.push('/bin/sh');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  const bare = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true });
  if (!bare.error && bare.status === 0) return 'sh';
  return null;
}

const SHELL = findShell();
if (!SHELL) {
  process.stdout.write('  FAIL  no POSIX shell found; .githooks/pre-push cannot be executed or verified here\n');
  process.exit(1);
}

// --- environments -----------------------------------------------------------
// Windows env vars are case-insensitive, and `{...process.env}` keeps whatever
// casing the OS used ("Path"). Setting PATH alongside an inherited Path would
// hand the child two entries, so drop every spelling first.
function envWithPath(pathValue, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.PATH = pathValue;
  return Object.assign(env, extra || {});
}

// Remove only the directories that actually contain node.exe/node, by looking
// on disk rather than by matching names -- an nvm or volta shim directory is
// not called "nodejs".  The hook is driven through Git's shell directly in
// this test, rather than by git itself, so retain the shell's own directory
// when it contains `tr`: the destination normalizer needs that POSIX utility
// before it reaches the intentional no-node bailout.
function pathWithoutNode() {
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = String(process.env.PATH || '').split(separator);
  const kept = entries.filter(entry => {
    if (!entry) return false;
    for (const name of ['node.exe', 'node.cmd', 'node']) {
      try {
        if (fs.existsSync(path.join(entry, name))) return false;
      } catch { /* an unreadable PATH entry cannot supply node */ }
    }
    return true;
  });
  if (path.isAbsolute(SHELL)) {
    const shellDirectory = path.dirname(SHELL);
    const trName = process.platform === 'win32' ? 'tr.exe' : 'tr';
    if (fs.existsSync(path.join(shellDirectory, trName)) && !kept.includes(shellDirectory)) {
      kept.push(shellDirectory);
    }
  }
  return kept.join(separator);
}

const PATH_WITHOUT_NODE = pathWithoutNode();
const ENV_NO_NODE = envWithPath(PATH_WITHOUT_NODE);
const ENV_FULL = envWithPath(process.env.PATH || '');

// One realistic pre-push stdin line: <local_ref> <local_sha> <remote_ref>
// <remote_sha>. Small enough to fit the pipe buffer, so the write completes
// even when the hook refuses and exits before reading a byte.
const STDIN_UPDATE =
  'refs/heads/example 1111111111111111111111111111111111111111 ' +
  'refs/heads/example 0000000000000000000000000000000000000000\n';
const STDIN_DELETE =
  'refs/heads/example 0000000000000000000000000000000000000000 ' +
  'refs/heads/example 2222222222222222222222222222222222222222\n';

function runHook(args, options = {}) {
  const result = spawnSync(SHELL, [HOOK, ...args], {
    cwd: ROOT,
    input: options.stdin === undefined ? STDIN_UPDATE : options.stdin,
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || ENV_NO_NODE
  });
  assert.equal(result.error, undefined, `hook failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number',
    'spawnSync must report a real numeric exit code, not a piped one');
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function expectAllowed(label, url, options) {
  const result = runHook(['origin', url], options);
  assert.equal(result.status, 0,
    `${label}: an ordinary push to the private origin must not be refused (exit ${result.status})\n${result.output}`);
  assert.match(result.output, /\[destination\] github\.com\/toolsenabled\/engine -- declared private\. OK\./,
    `${label}: the gate must say out loud that it recognised the destination\n${result.output}`);
  assert.doesNotMatch(result.output, /PUSH REFUSED/, `${label}: must not refuse\n${result.output}`);
  return result;
}

function expectRefused(label, args, options) {
  const result = runHook(args, options);
  assert.equal(result.status, 1,
    `${label}: this destination must be REFUSED, and refusal is exit 1 (got ${result.status})\n${result.output}`);
  assert.match(result.output, /PUSH REFUSED\. THIS REPOSITORY IS PERMANENTLY PRIVATE\./,
    `${label}: the refusal must be legible, not a bare non-zero exit\n${result.output}`);
  return result;
}

if (!governance.governs) {
  // Installation-specific assertions do not apply to an uninstalled checkout,
  // but the checked-in hook is still executable policy. Drive its
  // destination gate directly with node removed from PATH: the public case
  // must fail before any later advisory check, and the private control must
  // pass that same gate before taking the intentional no-node exit.
  assert.ok(fs.existsSync(HOOK),
    'the checkout must still carry the hook being audited');
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.notEqual(configured.status, 0,
    'this precondition branch requires the private repository hook to be uninstalled');
  assert.match(governance.reason, /no "hooks:install" script/,
    'the unmet precondition must identify the missing private-hook installer');

  const publicResult = expectRefused('direct public destination',
    ['public', 'https://github.com/ToolsEnabled/engine-public'],
    { env: ENV_NO_NODE });
  assert.doesNotMatch(publicResult.output, /node is not on PATH/,
    'the public destination must be refused before the later no-node bailout');
  expectAllowed('direct private control', PRIVATE_URL, { env: ENV_NO_NODE });

  process.stdout.write(`PRECONDITION NOT MET: git-push-destination -- ${governance.reason}
`);
  process.stdout.write('uninstalled checkout: direct refuse/allow hook controls passed\n');
  process.exit(0);
}

// --- probe the probe --------------------------------------------------------

check('harness: the hook file exists and is the one core.hooksPath points at', () => {
  assert.ok(fs.existsSync(HOOK), `${HOOK} must exist`);
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(configured.status, 0, 'core.hooksPath must be configured, or no hook runs at all');
  const resolved = path.resolve(ROOT, configured.stdout.trim());
  assert.equal(path.resolve(path.dirname(HOOK)).toLowerCase(), resolved.toLowerCase(),
    'the file under test must be the file git actually runs');
});

check('harness: the scrubbed PATH really has no node on it', () => {
  // If this is wrong, every "fast" case below silently becomes an 80-second
  // full run and the node-absence property is untested while looking tested.
  const probe = spawnSync(SHELL, ['-c', 'command -v node'],
    { encoding: 'utf8', windowsHide: true, env: ENV_NO_NODE, cwd: ROOT });
  assert.notEqual(probe.status, 0, `node must be unreachable on the scrubbed PATH, found: ${probe.stdout}`);
});

check('harness: the unscrubbed PATH does have node, so the two are genuinely different', () => {
  const probe = spawnSync(SHELL, ['-c', 'command -v node'],
    { encoding: 'utf8', windowsHide: true, env: ENV_FULL, cwd: ROOT });
  assert.equal(probe.status, 0, 'the control environment must be able to find node');
});

// --- the green control: the ordinary push must keep working -----------------
// This runs constantly and is the thing a destination fence is most likely to
// break. It is asserted first so that no refusal below can be credited to a
// hook that refuses everything.

check('GREEN: a normal push to the private origin is allowed', () => {
  expectAllowed('private origin', PRIVATE_URL);
});

check('GREEN: the same repository via .git suffix and trailing slash is allowed', () => {
  expectAllowed('.git suffix', `${PRIVATE_URL}.git`);
  expectAllowed('trailing slash', `${PRIVATE_URL}/`);
  expectAllowed('.git and slash', `${PRIVATE_URL}.git/`);
});

check('GREEN: case variants of the same GitHub repository are allowed', () => {
  // GitHub owner/repo names are case-insensitive, so these are literally the
  // same private repository, not a near-match.
  expectAllowed('mixed case', 'https://GitHub.com/TOOLSENABLED/ENGINE');
});

check('GREEN: ssh and scp-like forms of the same repository are allowed', () => {
  // Transport is not part of a repository's identity. What matters is which
  // repository the objects land in.
  expectAllowed('scp-like', 'git@github.com:ToolsEnabled/engine.git');
  expectAllowed('ssh url', 'ssh://git@github.com/ToolsEnabled/engine.git');
});

check('GREEN: a credential embedded in the private URL is allowed and never echoed', () => {
  const result = expectAllowed('tokenised private url',
    `https://x-access-token:${FAKE_TOKEN}@github.com/ToolsEnabled/engine`);
  assert.ok(!result.output.includes(FAKE_TOKEN),
    'the hook must not print a token that arrived in the push URL');
});

// --- the refusals -----------------------------------------------------------

check('REFUSED: the look-alike public repository', () => {
  // The single most likely accident: the public repo named after this one.
  // Exact whole-name matching, not a prefix or a substring, is what stops it.
  const result = expectRefused('engine-public',
    ['public', 'https://github.com/ToolsEnabled/engine-public']);
  assert.match(result.output, /engine-public/,
    'the refusal must name the destination it refused');
});

check('REFUSED: same repository name under a different owner or organisation', () => {
  expectRefused('other owner', ['upstream', 'https://github.com/SomeOtherOwner/engine']);
});

check('REFUSED: a different host that merely contains the right-looking path', () => {
  expectRefused('other host', ['mirror', 'https://evil.example.com/toolsenabled/engine']);
  expectRefused('host suffix', ['mirror', 'https://github.com.evil.example/toolsenabled/engine']);
  expectRefused('path prefix', ['mirror', 'https://evil.example.com/github.com/toolsenabled/engine']);
  expectRefused('other forge', ['gitlab', 'https://gitlab.com/toolsenabled/engine']);
});

check('REFUSED: an scp-like or ssh URL pointing somewhere else', () => {
  expectRefused('scp elsewhere', ['pub', 'git@github.com:ToolsEnabled/engine-public.git']);
  expectRefused('ssh elsewhere', ['pub', 'ssh://git@gitlab.com/toolsenabled/engine.git']);
});

check('REFUSED: a local path or bundle destination', () => {
  // Fail-closed by construction: anything that does not reduce to the declared
  // host/owner/repo is refused, including destinations that are not a forge.
  expectRefused('dot', ['.', '.']);
  expectRefused('local path', ['backup', 'C:/Users/owner/Desktop/somewhere-else']);
  expectRefused('file url', ['backup', 'file:///C:/Users/owner/Desktop/somewhere-else']);
});

check('REFUSED: silence -- no destination argument at all', () => {
  // The core rule. A destination check that cannot see the destination must
  // refuse, because an unrecognised destination and an unreadable one are the
  // same risk.
  expectRefused('no args', []);
  expectRefused('name only', ['origin']);
  expectRefused('empty url', ['origin', '']);
});

check('REFUSED: a credential-bearing URL to a public destination, with the token withheld', () => {
  const result = expectRefused('tokenised public url',
    ['public', `https://x-access-token:${FAKE_TOKEN}@github.com/ToolsEnabled/engine-public`]);
  assert.ok(!result.output.includes(FAKE_TOKEN),
    'a refusal must not print the token that came in the URL');
});

check('REFUSED: deleting a ref on a public destination is still a push to it', () => {
  expectRefused('delete to public',
    ['public', 'https://github.com/ToolsEnabled/engine-public'],
    { stdin: STDIN_DELETE });
});

check('REFUSED: with no stdin at all (nothing about the refs changes the answer)', () => {
  expectRefused('no stdin', ['public', 'https://github.com/ToolsEnabled/engine-public'],
    { stdin: '' });
});

// --- the fence must not depend on anything that can go missing --------------

check('the fence holds with the ordinary, unscrubbed PATH too', () => {
  // Proves no verdict above is an artifact of removing node. This one pays the
  // real cost only on the refusal side, which exits before the slow sections.
  expectRefused('full PATH refusal',
    ['public', 'https://github.com/ToolsEnabled/engine-public'],
    { env: ENV_FULL });
});

check('the fence holds when node is missing -- the old exit-0 bail-out is above it no longer', () => {
  // Before this gate existed, "node is not on PATH" printed a warning and
  // exited 0. Anything placed below that line would have been unreachable
  // exactly when the toolchain was broken.
  const result = expectRefused('no node',
    ['public', 'https://github.com/ToolsEnabled/engine-public'], { env: ENV_NO_NODE });
  assert.doesNotMatch(result.output, /node is not on PATH/,
    'the destination gate must run and refuse BEFORE the node probe is reached');
});

check('no environment variable turns the fence off', () => {
  // Not a proof over all possible names -- a proof over the names somebody in a
  // hurry would reach for, plus the standing rule stated in the hook itself:
  // widening the destination list is a file edit in a reviewable commit.
  const hostile = {
    SKIP_HOOKS: '1',
    HUSKY: '0',
    HUSKY_SKIP_HOOKS: '1',
    NO_VERIFY: '1',
    GIT_PUSH_OPTION_COUNT: '1',
    ALLOW_PUBLIC_PUSH: '1',
    ALLOW_PUBLISH: '1',
    TOOLSENABLED_ALLOW_PUBLIC_PUSH: '1',
    TOOLSENABLED_ALLOW_PUBLISH: '1',
    TOOLSENABLED_PUBLISH: '1',
    TOOLSENABLED_SKIP_HOOKS: '1',
    PUBLISH_PUBLIC: '1',
    CI: 'true',
    FORCE: '1'
  };
  expectRefused('hostile env',
    ['public', 'https://github.com/ToolsEnabled/engine-public'],
    { env: envWithPath(PATH_WITHOUT_NODE, hostile) });
});

// --- the refusal has to be usable -------------------------------------------

check('the refusal explains WHY, in words, and points at the supported path', () => {
  const result = expectRefused('message content',
    ['public', 'https://github.com/ToolsEnabled/engine-public']);
  const required = [
    // why it is unrecoverable
    [/publishes HISTORY/i, 'a push publishes history, not the tip'],
    [/94a9d22/, 'the commit that carries the paid module'],
    [/license\.js/, 'the file that carries it'],
    [/LICENSE_VAULT_KEY/, 'what is inside it'],
    [/cannot be taken back|no undo/i, 'that it is unrecoverable'],
    // the current private-source policy
    [/no supported public-source export/i, 'that no public-source route exists'],
    [/engine[\s\S]{0,80}app repositories remain private/i, 'that both source repositories remain private'],
    [/manifest[\s\S]{0,120}does not authorize/i, 'that open licensing is not public-repository authority'],
    // how to widen it legitimately
    [/\.githooks\/pre-push/, 'where the declared list lives']
  ];
  for (const [pattern, why] of required) {
    assert.match(result.output, pattern, `the refusal must state ${why}`);
  }
});

// --- the declared list is declared, and still describes reality -------------

check('the allowlist is a readable, diffable declaration with exactly the private repo in it', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  const block = source.match(
    /# >>> DECLARED PRIVATE DESTINATIONS[\s\S]*?private_push_destinations='([^']*)'/);
  assert.ok(block, 'the declared destination list must be present under its named marker');
  const declared = block[1].split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(declared, [PRIVATE_ID],
    'the private repository is the only declared destination; adding one is a reviewable edit');
});

check('CANARY: the remote this repository actually pushes to is still the declared private one', () => {
  // The fence is only worth anything while origin still points where everyone
  // believes it points. If origin is ever repointed, this goes red here rather
  // than being discovered by a push.
  const url = spawnSync('git', ['remote', 'get-url', '--push', 'origin'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(url.status, 0, 'origin must exist and have a push URL');
  assert.equal(url.stdout.trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase(),
    PRIVATE_URL.toLowerCase(),
    'origin no longer points at the declared private repository -- do not push until this is explained');
});

if (failures.length) {
  process.stdout.write(`\nFAILED ${failures.length} of ${checks + failures.length} checks\n`);
  for (const failure of failures) {
    process.stdout.write(`\n--- ${failure.name}\n${failure.error && failure.error.stack}\n`);
  }
  process.exit(1);
}

process.stdout.write(`\ngit-push-destination: ${checks} checks passed\n`);
