'use strict';

// WHERE THE RUNNING PRODUCT KEEPS THE THINGS IT WRITES.
//
// THE DEFECT THIS FILE EXISTS TO FIX, measured on a real per-user install at
// %LOCALAPPDATA%\Programs\toolsenabled on 2026-08-11. After one session the
// INSTALL DIRECTORY -- the directory that holds the program -- contained:
//
//     resources/capability/state/mission-bridge-token.json      (a bearer token)
//     resources/capability/state/mission-bridge-bootstrap-proof.json
//     resources/capability/state/mission-bridge-runtime.json
//     resources/capability/state/owner-public-prompts.json
//     resources/capability/state/audit.sqlite3{,-wal,-shm}      (the audit ledger)
//     resources/capability/logs/actions.{jsonl,log}
//     resources/capability/vault/secrets.json{,.access.log,.lock}   (the vault)
//
// None of that belongs there, and each line is a different failure:
//
//   1. AN INSTALL DIRECTORY IS NOT GUARANTEED WRITABLE. This build installs
//      per-user, so the writes happened to succeed. A per-machine install --
//      the same NSIS target with `perMachine: true`, or any managed
//      deployment -- lands under Program Files, where they would fail or
//      demand an elevation the product has no business asking for.
//
//   2. AN UPDATE REPLACES THE INSTALL DIRECTORY. Whatever is in it at the
//      time is gone. The customer's audit ledger and their VAULT -- every
//      credential they ever entered -- were sitting in the blast radius of
//      the next version. That is silent, total, unrecoverable data loss on a
//      routine upgrade.
//
//   3. A PROGRAM DIRECTORY IS THE WRONG ACL FOR A SECRET. It is readable by
//      every account on the machine by default. The per-boot bearer that
//      authorizes the whole action bridge, and the vault file, were written
//      into it. The individual files carry owner-only ACLs, but a credential's
//      location should not depend on remembering to lock each file.
//
// THE RULE, THEN: program resources are read from where the program lives;
// everything the program WRITES goes to a per-user state root. This module is
// the one place that distinction is made, because the alternative -- deciding
// it again at each of the ~60 call sites that join a path onto the repo root --
// is how the first six of them were right and the seventh shipped.
//
// HOW THE ROOT IS CHOSEN, in order:
//
//   1. TOOLSENABLED_STATE_ROOT, if it is set to an absolute path that does not
//      cross into another Windows account. The Electron shell sets this to
//      <userData>/capability so that a relocated profile (--user-data-dir, a
//      portable install, a test harness) carries the capability layer's state
//      with it instead of stranding it. A stale Administrator environment must
//      not turn that configured owner path into a second state tree.
//
//   2. Otherwise, IF THIS IS A CUT PAYLOAD, a per-user directory. "Cut
//      payload" is not a guess and not a build flag: tools/pack-capability-layer.mjs
//      writes PAYLOAD.json at the root of every payload it stages, and a source
//      checkout has no such file. So the question "am I installed?" is answered
//      by looking, which means a payload started by something other than our
//      own shell -- a customer's MCP client launching src/mcp-server.js
//      straight out of the install directory, with no environment set -- still
//      does not write where it must not. An env var alone would have left that
//      path defective and looking fixed.
//
//   3. Otherwise the program root. A developer checkout keeps state/, logs/ and
//      vault/ exactly where every existing tool, test and document expects
//      them. This module changes nothing about running from a checkout, which
//      is why it can be introduced under a live system.
//
// AND THE EXISTING INSTALL IS NOT ABANDONED. A customer upgrading from a build
// with this defect has real state in the old place -- a vault they filled in, a
// signed audit ledger. When the program root is a cut payload,
// adoptLegacyPayloadState() carries it across once, on the first redirected run,
// before anything reads. A configured source checkout is not a legacy install
// and is never inspected for migration. Adoption COPIES and never deletes:
// deleting would be a write to the install directory, which is the thing this
// file exists to stop, and one of the files in question is audit history.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROGRAM_ROOT = path.resolve(__dirname, '..', '..');
const STATE_ROOT_ENV = 'TOOLSENABLED_STATE_ROOT';

// The marker tools/pack-capability-layer.mjs writes at the root of a staged
// payload. Its presence means "this directory is a shipped artifact", and its
// absence means "this is the source tree it was cut from".
const PAYLOAD_RECORD = 'PAYLOAD.json';

// <appdata>/ToolsEnabled is Electron's userData for productName "ToolsEnabled";
// the extra segment keeps the capability layer's directories from colliding
// with the shell's own files in that directory (renderer-prefs.json,
// shell-state.json, workspace/ and the rest), which a different lane owns.
const PRODUCT_DIRECTORY = 'ToolsEnabled';
const PAYLOAD_STATE_DIRECTORY = 'capability';

const ADOPTION_RECORD = '.state-root-adoption.json';
const ADOPTION_RECORD_VERSION = 1;
const ADOPTION_INDETERMINATE = 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE';

function indeterminateAdoption(message, entries, pending) {
  return {
    reason: 'adoption-indeterminate',
    code: ADOPTION_INDETERMINATE,
    message,
    entries,
    pending,
  };
}

// EVERY TOP-LEVEL DIRECTORY THE RUNNING PRODUCT WRITES INTO, and nothing else.
// Derived by sweeping the repo for writes joined onto the repo root, not by
// recollection:
//   state/     mission-bridge tokens, the audit sqlite ledger, per-feature records
//   logs/      the audit jsonl/text sinks, lane consoles, escalation logs
//   vault/     the DPAPI secret file, its lock and its access log
//   captures/  screenshots taken by desktop.js
//   profiles/  the owned browser profile
//   reports/   the owner request ledger
// A directory NOT on this list resolves against the program root, which is the
// safe direction to be wrong in: a read of config/ or tools/ that accidentally
// pointed at the state root would fail loudly on a missing file, whereas a
// write that accidentally pointed at the program root is exactly the silent
// defect above.
const RUNTIME_STATE_DIRECTORIES = Object.freeze([
  'state',
  'logs',
  'vault',
  'captures',
  'profiles',
  'reports',
]);

const RUNTIME_STATE_DIRECTORY_SET = new Set(RUNTIME_STATE_DIRECTORIES);
// This marker is also mutable installation state. Leaving it at the program
// root made a private installation activate the checkout's switch, and a cut
// payload attempt to write into its sealed program directory.
const RUNTIME_STATE_FILES = Object.freeze(['KILLSWITCH']);
const RUNTIME_STATE_FILE_SET = new Set(RUNTIME_STATE_FILES);
const RUNTIME_STATE_ENTRIES = Object.freeze([...RUNTIME_STATE_DIRECTORIES, ...RUNTIME_STATE_FILES]);

function isRuntimeStateSegment(segment) {
  return typeof segment === 'string' && RUNTIME_STATE_DIRECTORY_SET.has(segment);
}

function accountFencedStateRoot(candidate) {
  if (process.platform !== 'win32') return path.resolve(candidate);
  /* The boundary module intentionally depends on Node built-ins only. Runtime
   * state resolution is in the health observer's boot graph and must not pull
   * agent setup, the tool registry, providers, or fleet supervision into it. */
  const accountBoundary = require('./account-profile-boundary');
  try {
    return accountBoundary.assertAccountProfilePath(candidate, {
      field: 'runtime state root',
      profileRoot: accountBoundary.installationProfileRoot()
    });
  } catch (error) {
    const refusal = new Error(
      'TOOLSENABLED_STATE_ROOT crosses an untrusted Windows account or reparse boundary. No runtime state was read or written.'
    );
    refusal.code = 'ERR_STATE_ROOT_ACCOUNT_BOUNDARY';
    refusal.causeCode = error && error.code ? String(error.code) : 'unknown';
    throw refusal;
  }
}

function configuredStateRoot(environment) {
  const raw = environment && typeof environment[STATE_ROOT_ENV] === 'string'
    ? environment[STATE_ROOT_ENV].trim()
    : '';
  if (!raw) return null;
  // A relative value here would resolve against the process cwd, which for a
  // spawned child is not a place anyone chose. Refuse rather than guess.
  if (!path.isAbsolute(raw)) {
    throw new Error(`${STATE_ROOT_ENV} must be an absolute path; received "${raw}".`);
  }
  return accountFencedStateRoot(raw);
}

// The per-user location used when a payload is running with nothing configured.
// On Windows the profile is derived from the installed module/executable rather
// than APPDATA or the launch token, then the same Electron productName path is
// appended. Thus an ordinary shell start and a direct MCP payload start cannot
// drift into two account trees.
function perUserStateRoot({ environment = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  if (platform === 'win32') {
    /* Derive the fallback from the profile that owns the installed engine, not
     * APPDATA, USERPROFILE or os.homedir() from whichever token launched it.
     * That is the exact split that made an elevated launch show a different
     * tree. The shared boundary also refuses reparse paths without following
     * them into another profile. */
    const accountBoundary = require('./account-profile-boundary');
    const ownerProfile = accountBoundary.installationProfileRoot();
    return accountFencedStateRoot(path.join(
      ownerProfile, 'AppData', 'Roaming', PRODUCT_DIRECTORY, PAYLOAD_STATE_DIRECTORY
    ));
  }
  const xdg = typeof environment.XDG_STATE_HOME === 'string' ? environment.XDG_STATE_HOME.trim() : '';
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, PRODUCT_DIRECTORY, PAYLOAD_STATE_DIRECTORY);
  return path.join(homedir(), '.local', 'state', PRODUCT_DIRECTORY, PAYLOAD_STATE_DIRECTORY);
}

function isPackagedPayload(root, fsImpl = fs) {
  try {
    fsImpl.statSync(path.join(root, PAYLOAD_RECORD));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    // An unreadable program root does not establish that this is a source
    // checkout. Refuse rather than silently selecting the writable program
    // directory on what may in fact be an installed payload.
    throw error;
  }
}

// Pure, injectable, and the only place the decision is made. Exported so tests
// can ask what a given environment resolves to without setting process-wide
// state, and so the answer can be reported in a diagnostic.
function resolveStateRoot({
  environment = process.env,
  programRoot = PROGRAM_ROOT,
  platform = process.platform,
  fsImpl = fs,
  homedir = os.homedir,
} = {}) {
  const configured = configuredStateRoot(environment);
  if (configured) {
    return Object.freeze({
      root: configured,
      programRoot,
      redirected: path.resolve(configured) !== path.resolve(programRoot),
      reason: 'configured',
    });
  }
  if (isPackagedPayload(programRoot, fsImpl)) {
    const derived = perUserStateRoot({ environment, platform, homedir });
    return Object.freeze({
      root: derived,
      programRoot,
      redirected: path.resolve(derived) !== path.resolve(programRoot),
      reason: 'packaged-payload',
    });
  }
  return Object.freeze({ root: programRoot, programRoot, redirected: false, reason: 'source-checkout' });
}

// Runtime lock and scratch files. A lock belongs to the process that took it
// and a half-written temp file belongs to nobody; carrying either into a fresh
// state root imports a problem instead of the person's data.
const TRANSIENT_FILE = /(?:\.lock|\.tmp)$/i;

// Copy a legacy tree file by file, never overwriting, and REPORT rather than
// throw. Per-file is the point: cpSync of a whole directory abandons the entire
// directory on the first unreadable member, which for state/ would mean one
// locked sqlite sidecar costing the customer their whole audit ledger.
function sameLocalPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function insideLocalPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(fsImpl, target) {
  const impl = fsImpl.realpathSync && (fsImpl.realpathSync.native || fsImpl.realpathSync);
  if (typeof impl !== 'function') throw Object.assign(new Error('realpath unavailable'), { code: 'ENOSYS' });
  return path.resolve(impl.call(fsImpl.realpathSync, target));
}

function verifiedLegacyEntry(target, anchor, fsImpl, expectedKind) {
  const stat = fsImpl.lstatSync(target);
  if (stat.isSymbolicLink()) return false;
  if (expectedKind === 'directory' && !stat.isDirectory()) return false;
  if (expectedKind === 'file' && !stat.isFile()) return false;
  const canonical = canonicalPath(fsImpl, target);
  if (!insideLocalPath(anchor.canonical, canonical)) return false;
  const relative = path.relative(anchor.lexical, path.resolve(target));
  return insideLocalPath(anchor.lexical, target)
    && sameLocalPath(canonical, path.resolve(anchor.canonical, relative));
}

function copyTreeWithoutOverwriting(from, to, fsImpl, failures, anchor) {
  try {
    // Repeat the no-link/canonical binding immediately before every descent;
    // the earlier discovery check is not treated as authority for the copy.
    if (!verifiedLegacyEntry(from, anchor, fsImpl, 'directory')) { failures.push(from); return; }
  } catch { failures.push(from); return; }
  let entries;
  try { entries = fsImpl.readdirSync(from, { withFileTypes: true }); }
  catch { failures.push(from); return; }
  try { fsImpl.mkdirSync(to, { recursive: true }); }
  catch { failures.push(to); return; }
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) { copyTreeWithoutOverwriting(source, target, fsImpl, failures, anchor); continue; }
    if (!entry.isFile()) continue;
    if (TRANSIENT_FILE.test(entry.name)) continue;
    try {
      if (!verifiedLegacyEntry(source, anchor, fsImpl, 'file')) { failures.push(source); continue; }
      // COPYFILE_EXCL: never overwrite. A destination that already holds this
      // file is the person's current data and outranks anything in the old
      // install directory.
      fsImpl.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      failures.push(source);
    }
  }
}

function copyRuntimeFileWithoutOverwriting(from, to, fsImpl, failures, anchor) {
  try {
    if (!verifiedLegacyEntry(from, anchor, fsImpl, 'file')) { failures.push(from); return; }
    fsImpl.mkdirSync(path.dirname(to), { recursive: true });
    try { fsImpl.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // In particular, a dangling destination link must not count as a copied
      // active marker: stat would report it absent and silently enable work.
      const current = fsImpl.lstatSync(to);
      if (!current.isFile() || current.isSymbolicLink()) throw error;
    }
  } catch { failures.push(from); }
}

// ADOPTING AN EXISTING INSTALL'S STATE.
//
// A customer upgrading from a build with the defect has real data in the old
// place: a vault they filled in, a signed audit ledger, their owner request
// ledger. The next update DELETES that directory, so this is the only window in
// which it can be carried across, and it has to be right the first time.
//
// IT NEVER OVERWRITES. Only files missing from the destination are copied, so a
// run interrupted mid-copy resumes correctly, a state root that already holds
// real data is left alone, and two processes starting at once cannot corrupt
// each other -- every copy is a create-or-skip.
//
// IT NEVER DELETES. Removing the legacy copy would be a write to the install
// directory, which is the thing this file exists to stop, and one of the files
// in question is audit history.
//
// A FAILURE IS REMEMBERED AS A FAILURE. The record marks each directory done or
// pending; a directory that could not be fully copied stays pending and is
// retried on the next start. The earlier shape of this function -- write the
// record first, treat the attempt as the decision -- meant a single locked file
// silently converted "your ledger did not migrate" into "already decided",
// which is precisely the absence-taken-as-consent mistake this product keeps
// paying for. A record that cannot be parsed or read does not establish which
// directories were adopted, so that uncertainty is reported as pending.
function adoptLegacyPayloadState({
  stateRoot: destination,
  programRoot = PROGRAM_ROOT,
  fsImpl = fs,
  environment = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (!destination || path.resolve(destination) === path.resolve(programRoot)) {
    return { adopted: false, reason: 'not-redirected', entries: [], pending: [] };
  }

  const recordFile = path.join(destination, ADOPTION_RECORD);
  let previous = null;
  let recordPresent = false;
  let recordReadError = null;
  try {
    previous = JSON.parse(fsImpl.readFileSync(recordFile, 'utf8'));
    recordPresent = true;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      recordReadError = error;
    }
  }
  const done = new Set(
    recordPresent && previous && Array.isArray(previous.adopted) ? previous.adopted.filter((v) => typeof v === 'string') : [],
  );
  // An explicit kill-switch path has always selected an independent marker.
  // Do not inspect or adopt an unused default marker in that configuration.
  const explicitKillSwitch = typeof environment.TOOLSENABLED_KILLSWITCH_PATH === 'string'
    && environment.TOOLSENABLED_KILLSWITCH_PATH.trim();
  const entries = explicitKillSwitch ? RUNTIME_STATE_DIRECTORIES : RUNTIME_STATE_ENTRIES;
  const undecidedEntries = entries.filter((entry) => !done.has(entry));
  // A completed owned record is the durable decision. Re-opening legacy
  // directories after that point is both unnecessary and unsafe: an old
  // payload can become unreadable or reparsed after a successful migration.
  if (undecidedEntries.length === 0) {
    return { adopted: false, reason: 'already-decided', entries: [], pending: [] };
  }

  let canonicalProgram;
  try {
    if (process.platform === 'win32') {
      const accountBoundary = require('./account-profile-boundary');
      programRoot = accountBoundary.assertAccountProfilePath(programRoot, {
        field: 'legacy installed payload root',
        profileRoot: accountBoundary.installationProfileRoot()
      });
    } else {
      programRoot = path.resolve(programRoot);
    }
    canonicalProgram = canonicalPath(fsImpl, programRoot);
  } catch {
    return indeterminateAdoption(
      'The legacy installed payload root could not be fenced and canonicalized before inspection; no legacy path was traversed.',
      [],
      [...undecidedEntries],
    );
  }

  const legacy = [];
  const unsafe = [];
  for (const directory of undecidedEntries) {
    const candidate = path.join(programRoot, directory);
    try {
      // statSync follows a directory junction before the account boundary can
      // be established. Inspect the legacy directory entry itself first and
      // refuse anything except the declared real file/directory kind. Nested
      // links are independently skipped by the directory copy's Dirent walk.
      const stat = fsImpl.lstatSync(candidate);
      const correctKind = RUNTIME_STATE_FILE_SET.has(directory) ? stat.isFile() : stat.isDirectory();
      if (!correctKind || stat.isSymbolicLink()) {
        unsafe.push(directory);
        continue;
      }

      const realpathImpl = fsImpl.realpathSync && (fsImpl.realpathSync.native || fsImpl.realpathSync);
      if (typeof realpathImpl !== 'function') {
        unsafe.push(directory);
        continue;
      }
      const canonicalCandidate = path.resolve(realpathImpl.call(fsImpl.realpathSync, candidate));
      if (!sameLocalPath(canonicalCandidate, path.join(canonicalProgram, directory))) {
        unsafe.push(directory);
        continue;
      }
      legacy.push(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      // Failure to inspect a legacy directory is not evidence that it has no
      // state to adopt. Carry the failure to the caller instead.
      unsafe.push(directory);
    }
  }
  if (unsafe.length > 0) {
    return indeterminateAdoption(
      'A legacy state entry could not be proven to have its declared file or directory type inside the installed payload; it was not traversed.',
      [],
      [...new Set([...legacy, ...unsafe])].sort(),
    );
  }
  if (legacy.length === 0) {
    return { adopted: false, reason: recordPresent ? 'already-decided' : 'nothing-to-adopt', entries: [], pending: [] };
  }
  if (recordReadError) {
    return indeterminateAdoption(
      'Could not read the adoption record; this is NOT claiming that legacy state is absent.',
      [],
      legacy,
    );
  }

  const outstanding = legacy.filter((directory) => !done.has(directory));
  if (outstanding.length === 0) return { adopted: false, reason: 'already-decided', entries: [], pending: [] };

  const copied = [];
  const pending = [];
  for (const directory of outstanding) {
    const failures = [];
    const copy = RUNTIME_STATE_FILE_SET.has(directory)
      ? copyRuntimeFileWithoutOverwriting : copyTreeWithoutOverwriting;
    copy(
      path.join(programRoot, directory),
      path.join(destination, directory),
      fsImpl,
      failures,
      { lexical: path.resolve(programRoot), canonical: canonicalProgram },
    );
    if (failures.length === 0) copied.push(directory);
    else pending.push(directory);
  }

  const adopted = [...done, ...copied].sort();
  let recordWritten = true;
  try {
    fsImpl.mkdirSync(destination, { recursive: true });
    fsImpl.writeFileSync(
      recordFile,
      `${JSON.stringify({ version: ADOPTION_RECORD_VERSION, from: programRoot, at: now(), adopted, pending }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    recordWritten = false;
  }
  if (!recordWritten) {
    return indeterminateAdoption(
      'Could not write the adoption record; this is NOT claiming that legacy state is absent or fully adopted.',
      copied,
      pending,
    );
  }
  if (pending.length > 0) {
    return indeterminateAdoption(
      'Could not inspect or copy all legacy state; this is NOT claiming that the pending state is absent.',
      copied,
      pending,
    );
  }
  return { adopted: copied.length > 0, reason: 'adopted', entries: copied, pending };
}

let resolved = null;
let adoption = null;

function stateRootRecord() {
  if (resolved) return resolved;
  const candidate = resolveStateRoot();
  if (candidate.redirected) {
    // Root creation is part of establishing that the redirected state root is
    // usable. Legacy inspection belongs only to a shipped payload. A developer
    // or MCP client may deliberately point a SOURCE checkout at shared app
    // state; treating that checkout's state/, logs/, or vault/ as an old install
    // both copies development data and can refuse startup on ordinary source
    // locks. PAYLOAD.json is the product's existing source-of-truth boundary.
    // Linux callers outside Electron also create their own redirected state
    // root. A permissive umask must not make a newly created root public, nor
    // create a group-writable Linux ancestor that the private vault correctly
    // refuses. mode applies ONLY to directories created here: an existing or
    // user-selected state root is never chmodded, and none of this is treated
    // as a confinement proof.
    fs.mkdirSync(candidate.root, { recursive: true, ...(process.platform === 'linux' ? { mode: 0o700 } : {}) });
    if (isPackagedPayload(candidate.programRoot)) {
      const attemptedAdoption = adoptLegacyPayloadState({ stateRoot: candidate.root, programRoot: candidate.programRoot });
      if (attemptedAdoption.code === ADOPTION_INDETERMINATE) {
        const error = new Error(attemptedAdoption.message);
        error.code = attemptedAdoption.code;
        error.pending = attemptedAdoption.pending;
        throw error;
      }
      adoption = attemptedAdoption;
    } else {
      adoption = { adopted: false, reason: 'source-checkout', entries: [], pending: [] };
    }
  } else {
    adoption = { adopted: false, reason: 'not-redirected', entries: [] };
  }
  resolved = candidate;
  return resolved;
}

function stateRoot() {
  return stateRootRecord().root;
}

function statePath(...parts) {
  return path.join(stateRoot(), ...parts);
}

// THE FIRST SEGMENT, WHICHEVER WAY THE CALLER SPELT IT.
//
// Callers write rootPath('logs', 'actions.jsonl') AND rootPath('logs/actions.jsonl')
// -- src/lib/audit.js does the latter, because its default comes from
// config/toolsenabled.policy.json as one relative string. An earlier version of
// this function compared parts[0] to the directory list directly, so the
// one-argument spelling matched nothing and the audit sinks kept resolving into
// the install directory while everything else moved. That was caught by running
// the packaged app and hashing its directory, and by nothing else: the code
// called the right helper, and the helper returned the wrong answer.
function leadingSegment(part) {
  if (typeof part !== 'string') return null;
  const [first] = part.split(/[\\/]/);
  return first || null;
}

// Resolve a repo-root-relative path, sending the mutable directories to the
// state root and everything else to the program root. This is what rootPath()
// in src/lib/runtime.js delegates to, so a single call covers every existing
// caller without any of them changing.
function programOrStatePath(programRoot, parts) {
  const runtimeFile = parts.length === 1 && RUNTIME_STATE_FILE_SET.has(parts[0]);
  if (runtimeFile || (parts.length > 0 && isRuntimeStateSegment(leadingSegment(parts[0])))) {
    const record = stateRootRecord();
    if (record.redirected) return path.join(record.root, ...parts);
  }
  return path.join(programRoot, ...parts);
}

// Diagnostic only. Names directories, never contents, and never a secret.
function stateRootDiagnostic() {
  const record = stateRootRecord();
  return Object.freeze({
    stateRoot: record.root,
    programRoot: record.programRoot,
    redirected: record.redirected,
    reason: record.reason,
    adoption: adoption ? Object.freeze({ ...adoption }) : null,
  });
}

// Tests only: forget the memoized decision so a new environment can be resolved.
function resetStateRootForTests() {
  resolved = null;
  adoption = null;
}

module.exports = {
  ADOPTION_INDETERMINATE,
  ADOPTION_RECORD,
  ADOPTION_RECORD_VERSION,
  PAYLOAD_RECORD,
  PROGRAM_ROOT,
  RUNTIME_STATE_DIRECTORIES,
  RUNTIME_STATE_FILES,
  STATE_ROOT_ENV,
  accountFencedStateRoot,
  adoptLegacyPayloadState,
  configuredStateRoot,
  isPackagedPayload,
  isRuntimeStateSegment,
  perUserStateRoot,
  programOrStatePath,
  resetStateRootForTests,
  resolveStateRoot,
  stateRoot,
  stateRootDiagnostic,
  statePath,
};
