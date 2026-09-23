'use strict';

// Guarded worktree creation and removal for fleet lanes.
//
// WHY THIS MODULE EXISTS AT ALL: `tools/gemini-fleet.js` has a `makeWorktree()`
// that FORCE-REMOVES whatever already sits at the target path before creating,
// and a `removeWorktree()` that will `git worktree remove --force` any path it
// is handed. On 2026-07-28 four worktrees holding real unmerged review work
// (ToolsEnabled-lane-s03-pdfinfo, -s05-fleet, -s09-gmail, -s10-ledger) were
// live on this machine. A supervisor that reused those helpers is one bad lane
// id away from destroying them. So the supervisor does NOT call into
// gemini-fleet.js; it uses this module, which refuses to delete anything it
// cannot prove it created.
//
// Four independent checks must ALL pass before a single deletion:
//   1. NAMESPACE  - the directory basename matches `ToolsEnabled-fleet-lane-*`.
//                   The pre-existing protected worktrees are `ToolsEnabled-lane-*`
//                   (no `fleet-`), so they can never match.
//   2. LOCATION   - the directory is an immediate sibling of the repo root, and
//                   is not the repo root itself.
//   3. MARKER     - a marker file written at creation time exists, parses, and
//                   carries this repo root and owner token.
//   4. NO-ESCAPE  - the resolved real path still satisfies 1 and 2 (a symlink
//                   or junction cannot redirect the delete somewhere else).
//
// Refusal throws. Refusal never falls back to "well, remove it anyway".

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LANE_DIR_PREFIX = 'ToolsEnabled-fleet-lane-';
const LANE_DIR_PATTERN = /^ToolsEnabled-fleet-lane-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKER_FILE = '.toolsenabled-fleet-lane.json';
const OWNER_TOKEN = 'toolsenabled-fleet-supervisor-v1';
const LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class WorktreeRefused extends Error {
  constructor(reason, target) {
    super(`Refusing to touch worktree ${target}: ${reason}`);
    this.name = 'WorktreeRefused';
    this.code = 'FLEET_WORKTREE_REFUSED';
    this.reason = reason;
    this.target = target;
  }
}

class WorktreeIndeterminate extends Error {
  constructor(operation, target, cause) {
    const detail = String((cause && (cause.code || cause.message)) || 'unknown failure');
    super(`Could not determine whether worktree ${target} is reapable: ${operation} failed (${detail}); this does NOT claim the worktree or marker is absent`);
    this.name = 'WorktreeIndeterminate';
    this.code = 'FLEET_WORKTREE_INDETERMINATE';
    this.operation = operation;
    this.target = target;
    this.cause = cause;
  }
}

function git(args, cwd, exec = execFileSync) {
  return String(exec('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false })).trim();
}

function assertLaneId(laneId) {
  if (typeof laneId !== 'string' || !LANE_ID_PATTERN.test(laneId)) {
    throw new WorktreeRefused('lane id is not a safe single path segment', String(laneId));
  }
  return laneId;
}

function worktreePathFor(laneId, repoRoot) {
  assertLaneId(laneId);
  return path.join(path.dirname(path.resolve(repoRoot)), `${LANE_DIR_PREFIX}${laneId}`);
}

function markerPath(dir) {
  return path.join(dir, MARKER_FILE);
}

// Structural checks 1, 2 and 4. Deliberately pure: no filesystem writes, and
// the only reads are lstat/realpath, so it is safe to call on anything.
function checkNamespaceAndLocation(target, repoRoot) {
  if (typeof target !== 'string' || !target.trim()) return 'target path is empty';
  const root = path.resolve(repoRoot);
  const parent = path.dirname(root);

  const candidates = [path.resolve(target)];
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(candidates[0]) : fs.realpathSync(candidates[0]);
    if (real && real !== candidates[0]) candidates.push(path.resolve(real));
  } catch (error) {
    // A path that does not exist is valid input while creating a worktree. Any
    // other realpath failure leaves the no-escape check unmeasured, so refuse
    // rather than approving the unresolved spelling of the path.
    if (!error || error.code !== 'ENOENT') return 'target real path could not be established';
  }

  for (const resolved of candidates) {
    if (resolved === root) return 'target is the repository root';
    if (path.dirname(resolved) !== parent) return 'target is not an immediate sibling of the repository root';
    if (!LANE_DIR_PATTERN.test(path.basename(resolved))) {
      return `target basename is not a fleet lane directory (${LANE_DIR_PREFIX}*)`;
    }
  }
  return null;
}

function readMarker(dir, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(markerPath(dir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    // ENOENT establishes absence and malformed JSON establishes that there is
    // no valid marker. Resource and I/O failures establish neither.
    if (error instanceof SyntaxError || (error && error.code === 'ENOENT')) return null;
    throw new WorktreeIndeterminate('ownership marker read', markerPath(dir), error);
  }
}

// Throws WorktreeRefused unless every check passes. This is the ONLY gate any
// deletion path in the supervisor goes through.
function assertReapable(target, { repoRoot, ownerToken = OWNER_TOKEN, fsImpl = fs } = {}) {
  const structural = checkNamespaceAndLocation(target, repoRoot);
  if (structural) throw new WorktreeRefused(structural, String(target));

  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fsImpl.lstatSync(resolved);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new WorktreeIndeterminate('target metadata read', resolved, error);
    }
    throw new WorktreeRefused('target does not exist', resolved);
  }
  if (!stat.isDirectory()) throw new WorktreeRefused('target is not a directory', resolved);

  const marker = readMarker(resolved, fsImpl);
  if (!marker) throw new WorktreeRefused('no fleet lane ownership marker found', resolved);
  if (marker.kind !== 'toolsenabled-fleet-lane') throw new WorktreeRefused('ownership marker has the wrong kind', resolved);
  if (marker.ownerToken !== ownerToken) throw new WorktreeRefused('ownership marker token does not match', resolved);
  if (path.resolve(String(marker.repoRoot || '')) !== path.resolve(repoRoot)) {
    throw new WorktreeRefused('ownership marker was written for a different repository root', resolved);
  }
  return { path: resolved, marker };
}

function reapable(target, options) {
  try {
    assertReapable(target, options);
    return { ok: true, reason: null };
  } catch (error) {
    if (error instanceof WorktreeRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

// Create a lane worktree. Never force-removes an existing directory -- if
// something is already there the creation FAILS, because "clear the way first"
// is exactly the behaviour that can eat somebody else's work.
function createLaneWorktree(laneId, {
  repoRoot,
  ref = 'HEAD',
  supervisorId = null,
  itemId = null,
  ownerToken = OWNER_TOKEN,
  exec = execFileSync,
  fsImpl = fs,
  now = () => new Date()
} = {}) {
  const root = path.resolve(repoRoot);
  const dir = worktreePathFor(laneId, root);
  const structural = checkNamespaceAndLocation(dir, root);
  if (structural) throw new WorktreeRefused(structural, dir);
  if (fsImpl.existsSync(dir)) throw new WorktreeRefused('target already exists; refusing to clear it', dir);

  git(['worktree', 'add', '--detach', dir, ref], root, exec);
  const marker = {
    kind: 'toolsenabled-fleet-lane',
    ownerToken,
    repoRoot: root,
    laneId,
    itemId,
    supervisorId,
    createdAt: now().toISOString()
  };
  fsImpl.writeFileSync(markerPath(dir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return { path: dir, marker };
}

// ---------------------------------------------------------------------------
// Working-tree materialization
// ---------------------------------------------------------------------------
//
// THE FAILURE THIS FIXES (found in fleet batch 2, 2026-07-28): `git worktree
// add --detach <dir> HEAD` gives the lane the last COMMIT. This repo carries
// ~70 modified tracked files plus source files that exist ONLY as uncommitted
// state (src/lib/owner-directive-inbox.js, tools/owner-capture.js,
// config/standing-orders.json, docs/DASHBOARD-BRIDGE-PLAN.md ...). A lane
// dropped into a HEAD snapshot therefore reads a repo that does not exist:
// lane s14 correctly reported its briefed files "do not exist" and refused,
// and lane s09 read a stale producer and wrote code against fields the current
// code never emits -- which then had to be thrown away in review.
//
// So every lane worktree is brought up to the CURRENT working state:
//   * tracked changes  -> `git diff HEAD --binary` applied inside the worktree
//                         (covers staged, unstaged, modified and deleted)
//   * untracked files  -> `git ls-files --others --exclude-standard` copied in
//                         (--exclude-standard means .gitignore is honoured, so
//                          vault/, state/, logs/, .env and node_modules never
//                          travel into a lane)
//
// If any of that comes up short, the caller must NOT launch the lane. Sending
// an agent into a snapshot we know is wrong is how batch 2 wasted its work.

const MAX_UNTRACKED_FILES = 20_000;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 32 * 1024 * 1024;

// Measured on this repo 2026-07-28: 3231 untracked non-ignored files totalling
// 161.8 MB, of which 151 MB is `scratch/` (109.8), `gptaddon/` (28.1) and
// `tmp/` (13.3) -- transient working residue, not code a lane needs to read.
// Copying it into 15 lanes would move ~2.4 GB and hundreds of thousands of
// files for nothing. These prefixes are therefore skipped BY POLICY, which is
// different from failing to copy something: a policy skip is recorded in the
// report and does NOT mark the snapshot incomplete. If a phase's brief actually
// names a file under one of these, the supervisor copies that specific file in
// on demand (copyRepoFileIntoWorktree) rather than blocking -- and if even that
// fails, the stale-snapshot backstop refuses the lane loudly.
// reports/luna-fleet/ and reports/gemini-fleet/ are the COORDINATOR'S OWN wave
// logs -- raw per-lane `*.stdout.jsonl` transcripts, written continuously while
// it runs. Measured 2026-07-29: reports/luna-fleet alone reached 273 MB, past
// the 256 MB untracked budget, so every dispatch spent the whole budget copying
// another agent's transcripts and then refused the lane with
// `untracked-byte-budget-exhausted`. Machine output, never lane input, and it
// grows without bound while the coordinator is working -- exactly the scratch/
// case, so it gets the same policy skip. `reports/` as a whole stays copyable:
// real owner-facing reports live there, and a brief that names a specific file
// under a skipped prefix can still pull it in via copyRepoFileIntoWorktree().
const DEFAULT_SKIP_UNTRACKED_PREFIXES = [
  'scratch/', 'tmp/', 'gptaddon/', 'node_modules/', 'captures/',
  'reports/luna-fleet/', 'reports/gemini-fleet/'
];

// --no-renames matters: with rename detection on, `--name-only` reports only the
// NEW path, and the old file would be left sitting in the lane worktree. Turning
// detection off makes a rename appear as a delete plus an add, which is what we
// need to reproduce faithfully.
function changedTrackedPaths(cwd, exec = execFileSync) {
  const out = git(['diff', 'HEAD', '--name-only', '--no-renames'], cwd, exec);
  return out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

// `git ls-files --others` can return a DIRECTORY entry (trailing '/') instead of
// individual files. A nested Git repository has its own history and ignored
// dependencies, so Git collapses it and refuses to descend. Do the same here:
// record it, skip it, and never copy its unbounded contents into a lane.
//   * an ordinary all-untracked directory -- expanded by asking git itself,
//     so the repo's ignore rules are applied by the tool that owns them rather
//     than reimplemented here.
//
// Returns { files, nestedRepositories } so the caller can report the skip
// honestly instead of it looking like a materialization failure.
function untrackedPaths(cwd, exec = execFileSync, fsImpl = fs) {
  const listing = entry => {
    const out = entry
      ? git(['ls-files', '--others', '--exclude-standard', '--', entry], cwd, exec)
      : git(['ls-files', '--others', '--exclude-standard'], cwd, exec);
    return out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
  };

  const files = [];
  const nestedRepositories = [];
  for (const entry of listing(null)) {
    if (!entry.endsWith('/')) { files.push(entry); continue; }
    const base = entry.replace(/\/+$/, '');
    if (fsImpl.existsSync(path.resolve(cwd, base, '.git'))) { nestedRepositories.push(base); continue; }
    for (const inner of listing(base)) {
      // A second trailing slash means git still will not descend; do not guess.
      if (inner.endsWith('/')) { nestedRepositories.push(inner.replace(/\/+$/, '')); continue; }
      files.push(inner);
    }
  }
  return { files, nestedRepositories };
}

// Bring `dir` from the HEAD snapshot up to the repo's current working state.
// Returns a report; `complete` is false if anything was left behind, and the
// caller is expected to refuse to dispatch in that case.
function materializeWorkingTree(dir, {
  repoRoot,
  exec = execFileSync,
  fsImpl = fs,
  maxUntrackedFiles = MAX_UNTRACKED_FILES,
  maxUntrackedBytes = MAX_UNTRACKED_BYTES,
  maxSingleFileBytes = MAX_SINGLE_FILE_BYTES,
  skipUntrackedPrefixes = DEFAULT_SKIP_UNTRACKED_PREFIXES
} = {}) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(dir);
  const report = {
    worktree: target,
    patchBytes: 0,
    trackedExpected: [],
    trackedCopied: 0,
    trackedMissing: [],
    untrackedExpected: 0,
    untrackedCopied: 0,
    untrackedBytes: 0,
    // Deliberate policy skips. Recorded, but never a reason to call the
    // snapshot incomplete.
    untrackedSkippedByPolicy: 0,
    skipPrefixes: skipUntrackedPrefixes.slice(),
    nestedRepositoriesSkipped: [],
    // Genuine failures to materialize something we intended to. These DO make
    // the snapshot incomplete.
    untrackedSkipped: [],
    complete: false,
    reason: null
  };

  // --- tracked changes -----------------------------------------------------
  //
  // Deliberately a byte copy, not `git diff HEAD --binary | git apply`. The
  // patch route was tried first and was WRONG on this machine: git's autocrlf
  // meant the applied file came out CRLF where the owner's working copy is LF,
  // so the lane read bytes the repo does not have. A copy is byte-exact by
  // construction, and every result below is verified by reading it back rather
  // than by trusting an exit code.
  report.trackedExpected = changedTrackedPaths(root, exec);
  // Tracked nested repositories found below. Collected separately because the
  // untracked pass further down assigns report.nestedRepositoriesSkipped
  // wholesale; the two lists are merged there.
  const trackedNestedRepositories = [];
  for (const relative of report.trackedExpected) {
    const source = path.resolve(root, relative);
    const destination = path.resolve(target, relative);
    if (!source.startsWith(root + path.sep) || !destination.startsWith(target + path.sep)) {
      report.trackedMissing.push(relative);
      continue;
    }
    let stat = null;
    try {
      stat = fsImpl.lstatSync(source);
    } catch (error) {
      // ENOENT establishes a working-tree deletion. Other failures (notably
      // permissions and I/O errors) do not establish that the source vanished.
      if (!error || error.code !== 'ENOENT') {
        report.trackedMissing.push(relative);
        continue;
      }
    }
    if (stat === null) {
      // Deleted in the working tree but present at HEAD: reproduce the deletion.
      try {
        fsImpl.rmSync(destination, { force: true });
      } catch {
        report.trackedMissing.push(relative);
      }
      continue;
    }
    // A TRACKED path that is a directory is a GITLINK -- a nested repository
    // recorded in this index at mode 160000. `git diff HEAD --name-only` lists
    // it whenever the nested repo's own HEAD has moved, and it can never be
    // byte-copied here because it is not a file.
    //
    // Measured 2026-07-29: `reports/desktop-archive-2026-07-29/AI_Session_Logs`
    // is exactly this -- a nested repo committed as a gitlink with no
    // .gitmodules entry. It landed in trackedMissing on every single dispatch
    // and blocked 75 consecutive lanes with DISPATCH_BLOCKED_STALE_SNAPSHOT,
    // each failing in ~2s before any agent launched.
    //
    // The untracked pass below already records nested repositories and skips
    // them BY POLICY (see untrackedPaths: separate history, never walked by
    // hand). A tracked one is the same situation reached through the index, so
    // it gets the same honest treatment -- recorded, skipped, never copied --
    // rather than being reported as a failure to materialize something this
    // function ever intended to copy. The `.git` probe is the same test used
    // for the untracked case, so both arms agree on what "nested repo" means.
    // A tracked directory WITHOUT a .git still falls through to trackedMissing:
    // that one really is unexplained and must still block.
    if (!stat.isSymbolicLink() && stat.isDirectory()
      && fsImpl.existsSync(path.resolve(source, '.git'))) {
      trackedNestedRepositories.push(relative);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) { report.trackedMissing.push(relative); continue; }
    try {
      fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
      fsImpl.copyFileSync(source, destination);
      report.trackedCopied += 1;
      report.patchBytes += stat.size;
      if (fsImpl.statSync(destination).size !== stat.size) report.trackedMissing.push(relative);
    } catch {
      report.trackedMissing.push(relative);
    }
  }

  // --- untracked, non-ignored files ---------------------------------------
  const { files: untracked, nestedRepositories } = untrackedPaths(root, exec, fsImpl);
  report.nestedRepositoriesSkipped = trackedNestedRepositories.concat(nestedRepositories);
  report.untrackedExpected = untracked.length;
  if (untracked.length > maxUntrackedFiles) {
    report.reason = `too-many-untracked-files: ${untracked.length} > ${maxUntrackedFiles}`;
    return report;
  }
  let bytes = 0;
  for (const relative of untracked) {
    const normalized = relative.replace(/\\/g, '/');
    if (skipUntrackedPrefixes.some(prefix => normalized === prefix.replace(/\/$/, '')
      || normalized.startsWith(prefix))) {
      report.untrackedSkippedByPolicy += 1;
      continue;
    }
    const source = path.resolve(root, relative);
    const destination = path.resolve(target, relative);
    // Containment: a crafted path must not write outside the lane worktree.
    if (!source.startsWith(root + path.sep) || !destination.startsWith(target + path.sep)) {
      report.untrackedSkipped.push({ file: relative, reason: 'path-escapes-worktree' });
      continue;
    }
    let stat;
    try {
      stat = fsImpl.lstatSync(source);
    } catch {
      report.untrackedSkipped.push({ file: relative, reason: 'vanished-during-copy' });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      report.untrackedSkipped.push({ file: relative, reason: 'not-a-regular-file' });
      continue;
    }
    if (stat.size > maxSingleFileBytes) {
      report.untrackedSkipped.push({ file: relative, reason: `larger-than-${maxSingleFileBytes}-bytes` });
      continue;
    }
    if (bytes + stat.size > maxUntrackedBytes) {
      report.untrackedSkipped.push({ file: relative, reason: 'untracked-byte-budget-exhausted' });
      continue;
    }
    try {
      fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
      fsImpl.copyFileSync(source, destination);
      bytes += stat.size;
      report.untrackedBytes = bytes;
      report.untrackedCopied += 1;
    } catch (error) {
      report.untrackedSkipped.push({ file: relative, reason: String(error && error.code || 'copy-failed') });
    }
  }

  if (report.trackedMissing.length > 0) {
    report.reason = `tracked-paths-not-materialized: ${report.trackedMissing.slice(0, 5).join(', ')}`;
    return report;
  }
  if (report.untrackedSkipped.length > 0) {
    report.reason = `untracked-files-not-materialized: ${report.untrackedSkipped.slice(0, 5).map(e => e.file).join(', ')}`;
    return report;
  }
  report.complete = true;
  return report;
}

// ---------------------------------------------------------------------------
// Progress measurement
// ---------------------------------------------------------------------------
//
// Once a lane worktree has been materialized it contains ~700 files that differ
// from HEAD, so `git status --porcelain` there says "700 changes" before the
// lane has done anything at all. Measuring progress against HEAD would make
// every lane look productive and would silently disable the no-progress park
// rule -- requirement 5 defeated by requirement (a).
//
// So progress is measured against the materialized state itself: `git add -A`
// plus `git write-tree` records a baseline tree object right after
// materialization (the worktree has its own index, so this touches nothing
// else), and afterwards a diff against that tree names exactly what the LANE
// changed. No commit and no ref is created.
function captureBaselineTree(worktree, { exec = execFileSync } = {}) {
  const dir = path.resolve(worktree);
  git(['add', '-A'], dir, exec);
  return git(['write-tree'], dir, exec);
}

function changedSinceBaseline(worktree, baselineTree, { exec = execFileSync } = {}) {
  if (!baselineTree) return null;
  const dir = path.resolve(worktree);
  try {
    git(['add', '-A'], dir, exec);
    const out = git(['diff', '--cached', '--name-only', baselineTree], dir, exec);
    const files = out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
    // The lane's own ownership marker is not work product.
    return files.filter(file => !file.endsWith(MARKER_FILE)).length;
  } catch {
    return null; // unknown, and the caller must not pretend otherwise
  }
}

// ---------------------------------------------------------------------------
// Credential-material fence
// ---------------------------------------------------------------------------
//
// THE HOLE THIS CLOSES (measured 2026-08-11): copyRepoFileIntoWorktree used to
// guard only path-escape and regular-file-ness. A phase body that named
// `vault/secrets.json` in backticks therefore got the live credential store
// copied into its lane worktree -- measured, 12,245 bytes of secrets.json and
// 2,960,870 bytes of PLAINTEXT secrets.json.access.log.
//
// That matters because of WHERE lane worktrees live. worktreePathFor() puts
// them next to the repo root, and a worktree INHERITS that parent directory's
// DACL. Measured on a real lane worktree: where the parent grants a sandbox
// service account Modify (an object-inherit, container-inherit grant), the
// worktree inherits it. So a rescued secrets.json lands somewhere the sandbox
// accounts CAN modify -- reopening by a second route the exposure that
// narrowing vault/'s own DACL had just closed.
//
// (The specific paths and account names are deliberately not recorded here.
// This file publishes under MIT, and an operator's directory layout and
// service-account names are not ours to hand out. The RULE is the portable
// part, and it holds on any machine whose parent directory is permissive.)
//
// File permissions cannot stop this: the supervisor runs as the interactive
// user, which keeps FullControl on vault/ by design because DPAPI CurrentUser
// is bound to that identity. The copy succeeds on rights alone, and
// copyFileSync gives the new file the WORKTREE's inherited DACL, not the
// vault's protected one.
//
// WHY THE FENCE LIVES HERE AND NOT AT THE CALL SITE: this function IS the
// documented escape hatch out of DEFAULT_SKIP_UNTRACKED_PREFIXES (see :205 and
// :216 above). A guard at the one caller in supervisor.js would be bypassed by
// the second caller the moment anyone adds one. The refusal has to be where the
// escape happens.
//
// WHY IT IS NOT A FILENAME LIST: a rule that knows only `vault/secrets.json`
// already misses the 2.9 MB access log sitting beside it, and misses whatever
// is added to the vault next month. So the classification is by what a path IS:
//
//   1. PURPOSE-BUILT DIRECTORIES. vault/ is the credential store; state/ holds
//      per-boot bearer material (measured: mission-bridge-token.json,
//      uac-delegation-token.json, full-remote-access-inbound-session.json).
//      Both are gitignored precisely so they never travel into a lane the
//      normal way -- the rescue is the one path that could bypass that, so it
//      honours the same boundary. Everything under them is covered, including
//      files nobody has created yet.
//   2. CREDENTIAL FILES BY NAME, ANYWHERE, plus their derived siblings. `.env`
//      also fences `.env.local`; `secrets.json` also fences
//      `secrets.json.access.log` and `secrets.json.lock`; `id_rsa` also fences
//      `id_rsa.pub`. That is the "the log beside it" case made general.
//   3. KEY MATERIAL BY EXTENSION. .pem/.pfx/.p12/... is key material wherever
//      it sits, whatever it is called.
//
// Deliberately NOT a substring match on "secret"/"token"/"key": that would
// fence src/lib/secret-store.js and tests/kernel.audit/vault-hardening.js,
// which are ordinary source files a lane may legitimately be briefed on. The
// distinction is credential MATERIAL versus code ABOUT credentials.
//
// Arm 2 is NOT reimplemented here. src/lib/fra-workspace-policy.js already
// owns "is this path a credential store or a shell history", for the FRA
// remote-browse fence, and it is documented as dependency-light and free of
// provider/registry/audit/vault/filesystem/process side effects -- so it is
// safe to require from here. Reusing it means .env handling stays in ONE
// place: that module already allows .env.example, .env.template and
// .env.sample, which a phase may legitimately be briefed on and which a
// hand-rolled ".env*" rule here would have wrongly fenced.
const { isCredentialOrHistoryPath } = require('../fra-workspace-policy');

// Narrower ON PURPOSE than fra-workspace-policy's EXCLUDED_DIR_NAMES, which
// also lists logs/, profiles/ and node_modules/. Those are not credential
// material, and node_modules/ is in DEFAULT_SKIP_UNTRACKED_PREFIXES above --
// i.e. it is a legitimate rescue target. Fencing it would break the very use
// case this function exists for. Only directories whose PURPOSE is to hold
// live credential material belong in this list.
const CREDENTIAL_MATERIAL_PREFIXES = ['vault/', 'state/', 'secrets/', '.secrets/'];
// Credential files fra-workspace-policy's patterns do not already cover:
// secrets.json is not matched by its auth/token/cookie/credential/session
// pattern, and neither are SSH private keys.
const CREDENTIAL_BASENAMES = [
  '.netrc', '_netrc', '.pgpass', '.htpasswd',
  'secrets.json', 'service-account.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
];
const CREDENTIAL_EXTENSIONS = [
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.asc', '.gpg', '.ppk', '.kdbx'
];

// Returns a refusal reason, or null when the path carries no credential
// material. Classifies the RESOLVED repo-relative path, not the caller's raw
// string, so `docs/../vault/secrets.json` and `vault\secrets.json` are judged
// as what they actually reach. Lowercased because Windows paths are
// case-insensitive: `VAULT/Secrets.json` opens the very same file.
function credentialMaterialReason(relative, repoRoot) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relative);
  const within = path.relative(root, resolved).replace(/\\/g, '/').toLowerCase();
  if (!within || within.startsWith('../')) return null; // containment is the caller's check
  for (const prefix of CREDENTIAL_MATERIAL_PREFIXES) {
    if (within === prefix.replace(/\/$/, '') || within.startsWith(prefix)) {
      return `credential-material-fenced: ${prefix} is a credential-bearing location`;
    }
  }
  if (isCredentialOrHistoryPath(within)) {
    return 'credential-material-fenced: path is a credential store or shell history';
  }
  const base = within.slice(within.lastIndexOf('/') + 1);
  // `name.` also fences the material derived from it: secrets.json fences
  // secrets.json.access.log and secrets.json.lock; id_rsa fences id_rsa.pub.
  for (const name of CREDENTIAL_BASENAMES) {
    if (base === name || base.startsWith(`${name}.`)) {
      return `credential-material-fenced: ${name} is credential material`;
    }
  }
  for (const extension of CREDENTIAL_EXTENSIONS) {
    if (base.endsWith(extension)) {
      return `credential-material-fenced: ${extension} is key material`;
    }
  }
  return null;
}

// Targeted rescue for a briefed input that a policy skip left behind. Copying
// one named file the phase explicitly cites is not "silently widening the skip
// set" -- the skip set is unchanged and the rescue is recorded per lane.
function copyRepoFileIntoWorktree(relative, { repoRoot, worktree, fsImpl = fs } = {}) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(worktree);
  const source = path.resolve(root, relative);
  const destination = path.resolve(target, relative);
  if (!source.startsWith(root + path.sep) || !destination.startsWith(target + path.sep)) {
    return { copied: false, reason: 'path-escapes-worktree' };
  }
  // Checked BEFORE any stat, so the refusal does not depend on the file
  // existing and cannot be probed for existence through a timing difference.
  // `fenced` lets the caller tell a security refusal apart from a genuine
  // materialization failure without string-matching the reason.
  const fenced = credentialMaterialReason(relative, root);
  if (fenced) return { copied: false, reason: fenced, fenced: true };
  try {
    const stat = fsImpl.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) return { copied: false, reason: 'not-a-regular-file' };
    fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
    fsImpl.copyFileSync(source, destination);
    return { copied: true, reason: null, bytes: stat.size };
  } catch (error) {
    return { copied: false, reason: String((error && error.code) || 'copy-failed') };
  }
}

// Backstop for requirement (b): before dispatching, confirm the specific inputs
// a lane was briefed on actually exist in its worktree. Returns the missing set.
function missingBriefedInputs(dir, relativePaths = [], fsImpl = fs) {
  const target = path.resolve(dir);
  const missing = [];
  for (const relative of relativePaths) {
    const resolved = path.resolve(target, relative);
    if (!resolved.startsWith(target + path.sep)) { missing.push(relative); continue; }
    if (!fsImpl.existsSync(resolved)) missing.push(relative);
  }
  return missing;
}

// Every fleet-lane directory sitting next to the repo root, with its marker
// (or null when unreadable/absent). Read-only; makes no reaping decision.
function listLaneWorktrees(repoRoot, fsImpl = fs) {
  const parent = path.dirname(path.resolve(repoRoot));
  let entries;
  try {
    entries = fsImpl.readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    // An unreadable parent is not an empty parent. Propagate the uncertainty so
    // pruneLaneWorktrees cannot report a successful zero-item scan.
    const detail = String((error && (error.code || error.message)) || 'unknown read failure');
    throw new WorktreeRefused(`worktree parent could not be listed: ${detail}`, parent);
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!LANE_DIR_PATTERN.test(entry.name)) continue;
    const dir = path.join(parent, entry.name);
    found.push({ path: dir, basename: entry.name, marker: readMarker(dir, fsImpl) });
  }
  return found;
}

// Retention: keep the NEWEST worktree per queue item (by marker createdAt)
// plus every worktree whose lane id the caller names as active; remove the
// rest -- but only ever through assertReapable, so a directory without this
// repo's ownership marker (including the protected ToolsEnabled-lane-*
// namespace, which cannot even match the pattern) is structurally untouchable
// and is reported as `refused`, never deleted.
function pruneLaneWorktrees({ repoRoot, activeLaneIds = [], ownerToken = OWNER_TOKEN, exec = execFileSync, fsImpl = fs } = {}) {
  const active = new Set(activeLaneIds);
  const report = { kept: [], removed: [], refused: [] };
  const byItem = new Map();
  for (const entry of listLaneWorktrees(repoRoot, fsImpl)) {
    const check = reapable(entry.path, { repoRoot, ownerToken, fsImpl });
    if (!check.ok) {
      report.refused.push({ path: entry.path, reason: check.reason });
      continue;
    }
    const itemId = String(entry.marker.itemId || '(no-item)');
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(entry);
  }
  for (const [itemId, entries] of byItem) {
    entries.sort((a, b) => String(b.marker.createdAt || '').localeCompare(String(a.marker.createdAt || '')));
    entries.forEach((entry, index) => {
      const isActive = active.has(String(entry.marker.laneId || ''));
      if (index === 0 || isActive) {
        report.kept.push({ path: entry.path, itemId, laneId: entry.marker.laneId, active: isActive, newest: index === 0 });
        return;
      }
      try {
        const removed = removeLaneWorktree(entry.path, { repoRoot, ownerToken, exec, fsImpl });
        report.removed.push({ path: entry.path, itemId, laneId: entry.marker.laneId, viaGit: removed.viaGit });
      } catch (error) {
        report.refused.push({ path: entry.path, reason: (error && error.reason) || String(error && error.message).slice(0, 200) });
      }
    });
  }
  return report;
}

// Remove a lane worktree, but only after assertReapable passes.
function removeLaneWorktree(target, { repoRoot, ownerToken = OWNER_TOKEN, exec = execFileSync, fsImpl = fs } = {}) {
  const { path: dir } = assertReapable(target, { repoRoot, ownerToken, fsImpl });
  try {
    git(['worktree', 'remove', dir, '--force'], path.resolve(repoRoot), exec);
  } catch (error) {
    // The worktree registration may already be gone (manual cleanup, crash).
    // Fall back to removing the directory -- still only after the gate passed.
    try {
      fsImpl.rmSync(dir, { recursive: true, force: true });
    } catch (removeError) {
      const detail = String((removeError && (removeError.code || removeError.message)) || 'unknown removal failure');
      throw new WorktreeRefused(`fallback directory removal could not be completed: ${detail}`, dir);
    }
    return { removed: true, viaGit: false, detail: String(error && error.message || '').slice(0, 200) };
  }
  return { removed: true, viaGit: true, detail: null };
}

module.exports = {
  CREDENTIAL_BASENAMES,
  CREDENTIAL_EXTENSIONS,
  CREDENTIAL_MATERIAL_PREFIXES,
  DEFAULT_SKIP_UNTRACKED_PREFIXES,
  LANE_DIR_PATTERN,
  LANE_DIR_PREFIX,
  MARKER_FILE,
  MAX_SINGLE_FILE_BYTES,
  MAX_UNTRACKED_BYTES,
  MAX_UNTRACKED_FILES,
  OWNER_TOKEN,
  WorktreeIndeterminate,
  WorktreeRefused,
  assertLaneId,
  assertReapable,
  captureBaselineTree,
  changedSinceBaseline,
  changedTrackedPaths,
  checkNamespaceAndLocation,
  copyRepoFileIntoWorktree,
  createLaneWorktree,
  credentialMaterialReason,
  listLaneWorktrees,
  materializeWorkingTree,
  missingBriefedInputs,
  pruneLaneWorktrees,
  readMarker,
  reapable,
  removeLaneWorktree,
  untrackedPaths,
  worktreePathFor
};
