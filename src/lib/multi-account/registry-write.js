'use strict';

// ADDING AN ACCOUNT TO THE REGISTRY, WHICH UNTIL NOW WAS A JSON FILE A PERSON
// HAD TO WRITE BY HAND.
//
// THE DEFECT THIS CLOSES, walked rather than inferred. ./registry.js reads a
// list of accounts and refuses when the file is not there; its refusal says
// "No account registry at <path>. Create it before switching accounts." Nothing
// under this directory ever wrote that file, so on a customer's machine that
// sentence was the whole of the on-ramp: a filename, and an instruction to
// author JSON in a directory they have no reason to know exists. The two
// accounts running cloud tasks on this machine were hand-authored, by the
// builder, in an editor.
//
// WHY IT IS A SIBLING OF ./registry.js RATHER THAN PART OF IT. Six modules
// require ./registry.js -- health, rotation, switcher, launch, status-injection
// and the cloud lane -- and every one of them is a READER. Putting an fs write
// into the module all of them load would hand a write path to six call sites
// that want none, and the file's own header states, as a property, that it
// "reads names and directories ONLY". So the writer sits beside it and depends
// on it, in one direction.
//
// AND THE RULES ARE NOT RESTATED HERE. That is the whole reason this file is
// short. A candidate registry is validated by SERIALIZING IT AND HANDING IT TO
// parseRegistry() -- the same function every reader validates with -- so a
// duplicate name is refused with the registry's own ACCOUNTS_NAME_DUPLICATE and
// a shared directory with its own ACCOUNTS_PROFILE_DIR_SHARED, thrown by the
// one implementation of those rules rather than by a second copy that agrees
// with it today. The app's shell/account-registry.cjs is what a second copy
// looks like: it re-derives the same rules by hand, and it is a copy that has
// already drifted (it writes a different file; see the report accompanying this
// change).
//
// CREDENTIALS: addAccount() opens no sign-in file and reads no credential. It
// reads the registry's own JSON, creates an EMPTY directory, and writes the
// registry's own JSON. The directory it creates is where a provider's CLI will
// later put a sign-in; addAccount() never looks inside it.
//
// removeAccount() is narrower still, WITH ONE EXCEPTION added 2026-09-07: when
// the row explicitly records that this writer created the home, it destroys
// exactly the one file the entry's own provider spec names as the sign-in
// (registry.js's signInFilePath), and nothing else in the home. Existing,
// legacy-unknown and native rows preserve their sign-in with an explicit
// disposition. Before
// this, removing a registration left that file behind -- a live, still-usable
// credential for an account the person no longer saw listed as registered
// (owner-reported, confirmed at source: an undeclared claude-1 home carried an
// unexpired refresh token five days after its access token expired). Session
// history and every other file in the home are still never inspected, read,
// or deleted; see REPORT-account-removal-leaves-credentials-20260907.md for
// why whole-home deletion was deliberately NOT built here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { acquireLock, pidAlive: lockPidAlive } = require('../process-claim-lock');
const { MultiAccountError, describeProviders, parseRegistry, providerSpec, resolveProfileDir, signInFilePath } = require('./registry.js');
const { accountHomesRoot, accountRegistryPath } = require('./registry-location.js');

// A name has to survive two jobs: it is the word a person types to select an
// account, and it is the directory that account's sign-in lives in. Anything
// that is a bad directory name on Windows is refused HERE, in a sentence,
// rather than becoming a mkdir failure later or -- worse -- being silently
// rewritten into something the person did not choose, which would make the name
// in the registry and the name of the directory two different strings.
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const MAX_NAME_LENGTH = 64;
/* THE EXPECTED SIGN-IN, CHECKED ONLY AS FAR AS IT IS USED. It is compared,
   never dialled, so the only shapes worth refusing are the ones that cannot be
   an address at all: no @, an @ at either end, whitespace or a NUL inside, or
   longer than an address may be. A stricter pattern here would refuse real
   addresses (quoted local parts, unicode domains) to buy nothing -- the whole
   value of the field is that it EQUALS what the provider reports. */
const MAX_EXPECT_EMAIL_LENGTH = 254;
// The providers whose probe reads an identity, and so the ones that could ever
// compare an expectEmail: health.js's classifyProbe for Codex,
// rotation.js's claudeIdentityFault for Claude. Gemini is a file-presence check
// (health.js's probeSignInPresence answers email null by construction), so
// recording one against a Gemini entry would promise a check nothing performs.
const EXPECT_EMAIL_PROVIDERS = Object.freeze(['codex', 'claude']);
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
// Trailing spaces and dots are stripped by Win32 path normalization, so a name
// ending in one names a DIFFERENT directory than it spells.
const NAME_TAIL = /[ .]$/;
const HOME_CREATED_BY_APP_FIELD = 'homeCreatedByApp';
// Reserved device names. CreateFile answers these as devices whatever directory
// they are asked for in, so a home called "aux" is a home that cannot exist.
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

function sleepSync(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function acquireRegistryLock(lockFile, { pid, isAlive, timeoutMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return acquireLock(lockFile, { pid, isAlive });
    } catch (error) {
      if (!error || error.code !== 'AGENT_DIGEST_ALREADY_RUNNING' || Date.now() >= deadline) throw error;
      sleep(25);
    }
  }
}

function refuse(code, message, details = {}) {
  throw new MultiAccountError(code, message, details);
}

function accountName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0) {
    refuse('ACCOUNTS_ENTRY_INVALID', 'An account needs a name.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    refuse('ACCOUNTS_ENTRY_INVALID', `An account name can be at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (!NAME_SHAPE.test(name) || NAME_TAIL.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
    refuse('ACCOUNTS_ENTRY_INVALID',
      'An account name can use letters, numbers, spaces, dots, dashes and underscores, and must start with a letter or a number.');
  }
  return name;
}

/* The expected sign-in for one entry, or null when the caller gave none.
 *
 * ABSENT AND EMPTY BOTH MEAN "DO NOT CHECK", and that is the honest reading of
 * both: nobody said which account this is. A blank string is not a refusal
 * because a person clearing a box has said the same thing as a person who never
 * filled it in.
 *
 * ANYTHING ELSE THAT IS NOT AN ADDRESS IS REFUSED BY NAME rather than dropped.
 * Silently discarding it would record an account with no identity check while
 * the person who typed one believed they had asked for it -- the check they
 * think is on is the whole reason they typed it. */
function expectEmailFor(value, spec) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    refuse('ACCOUNTS_ENTRY_INVALID', 'An expected account address has to be text.');
  }
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length === 0) return null;
  if (!EXPECT_EMAIL_PROVIDERS.includes(spec.id)) {
    refuse('ACCOUNTS_ENTRY_INVALID',
      `A ${spec.id} account cannot record an expected account address: this copy reads no identity for ${spec.id}, so nothing would ever compare it.`,
      { provider: spec.id });
  }
  if (cleaned.length > MAX_EXPECT_EMAIL_LENGTH) {
    refuse('ACCOUNTS_ENTRY_INVALID',
      `An expected account address can be at most ${MAX_EXPECT_EMAIL_LENGTH} characters.`);
  }
  const at = cleaned.indexOf('@');
  if (at <= 0 || at !== cleaned.lastIndexOf('@') || at === cleaned.length - 1
    || /[\s\0]/.test(cleaned)) {
    refuse('ACCOUNTS_ENTRY_INVALID',
      'An expected account address needs to look like an address: something, an @, and something after it.');
  }
  return cleaned;
}

// The registry as it is on disk, WITH every field this module does not
// understand left exactly as it found it -- a $comment, an exhaustedAtPercent, a
// role or an expectEmail on somebody else's entry. An add that reformatted the
// file would be an add that rewrote entries it was told never to touch.
//
// ABSENCE IS THE ONE CONDITION THAT IS NOT A REFUSAL. loadRegistry() is right to
// refuse a missing file -- you cannot launch into an account that is not there
// -- and this is the call that ENDS that state, so for it a missing file is an
// empty list. Every other damage is still a refusal, because each of those means
// something IS there, cannot be trusted, and must not be flattened by a write.
function readForUpdate(configPath, fsImpl, { missingAsEmpty = false } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT' && missingAsEmpty) return { accounts: [] };
    if (error && error.code === 'ENOENT') {
      refuse('ACCOUNTS_REGISTRY_MISSING',
        `No account registry at ${configPath}, so there is no registration to remove.`,
        { source: configPath });
    }
    refuse('ACCOUNTS_REGISTRY_UNREADABLE',
      `The account registry at ${configPath} could not be read, so nothing was changed.`,
      { source: configPath, cause: (error && error.code) || null });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse('ACCOUNTS_REGISTRY_UNPARSABLE',
      `The account registry at ${configPath} is not valid JSON, so nothing was changed.`,
      { source: configPath });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse('ACCOUNTS_REGISTRY_INVALID',
      `The account registry at ${configPath} does not hold a JSON object, so nothing was changed.`,
      { source: configPath });
  }
  if (!Array.isArray(parsed.accounts)) {
    refuse('ACCOUNTS_REGISTRY_INVALID',
      `The account registry at ${configPath} has no "accounts" array, so nothing was changed.`,
      { source: configPath });
  }
  return parsed;
}

// THE DIRECTORY COLLISION THAT COMPARING STRINGS DOES NOT CATCH. parseRegistry()
// refuses two same-provider entries whose declared directories are the same
// TEXT; a relative "codex-homes/school" and an absolute path to that same
// directory are different text and the same directory, and two Codex homes in
// one directory overwrite each other's sign-in. So the resolved paths are
// compared too, and the refusal carries the registry's OWN code because it is
// the registry's own rule.
function refuseResolvedCollision(existing, spec, home, homeDir, configPath) {
  const wanted = home.toLowerCase();
  for (const entry of existing) {
    if (!entry || typeof entry !== 'object' || entry.provider !== spec.id) continue;
    // Handed the entry's OWN directory field. resolveProfileDir() reads
    // `home` or `profileDir`, and a Claude entry on disk carries neither --
    // it carries `configDir` -- so passing the raw entry would have made
    // every Claude collision invisible to this check. Resolution failures
    // propagate: without a common homeDir there is no honest answer to whether
    // this relative directory and the candidate are the same directory.
    const resolved = resolveProfileDir(
      { name: entry.name, home: entry[spec.dirField] },
      { homeDir }
    );
    if (resolved.toLowerCase() === wanted) {
      refuse('ACCOUNTS_PROFILE_DIR_SHARED',
        `More than one ${spec.id} account in ${configPath} uses "${home}".`,
        { source: configPath, provider: spec.id, home });
    }
  }
}

// DURABLE WRITE, AND THE IDIOM IS NOT INVENTED HERE. It is persist() from
// src/lib/durable-memory-file.js, followed step for step: create the directory,
// open a uniquely-named temp with 'wx' so two writers cannot land on one file,
// write, FSYNC BEFORE RENAME, close, rename, and unlink the temp in a finally.
//
// The fsync is the half that is easy to leave out and is the whole point: a
// rename is atomic, so the registry is never half a file, but without the fsync
// the bytes can still be in flight when the rename lands -- and the machine that
// loses power at that moment comes back with a registry that is present, empty
// and legal-looking. That module's own comment says its persistence is proven by
// force-killing the process, which is the test this write is held to below.
function persist(configPath, record, { fsImpl, randomUUID, pid }) {
  const directory = path.dirname(configPath);
  const temporary = path.join(directory, `.${path.basename(configPath)}-${pid}-${randomUUID()}.tmp`);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  let descriptor;
  try {
    fsImpl.mkdirSync(directory, { recursive: true });
    descriptor = fsImpl.openSync(temporary, 'wx');
    fsImpl.writeFileSync(descriptor, text, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, configPath);
  } catch (error) {
    refuse('ACCOUNTS_REGISTRY_WRITE_FAILED',
      `The account registry could not be saved (${(error && error.code) || 'unknown error'}), so nothing was changed.`,
      { source: configPath });
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* closing a failed handle */ }
    }
    try { fsImpl.unlinkSync(temporary); } catch { /* already renamed away */ }
  }
}

// Removing the final registration returns the registry to its documented
// "not registered" state: the file is absent, not an invalid `{accounts:[]}`
// artifact that every reader must refuse.  This deliberately removes only the
// registry entry.  The account home is a provider-owned sign-in directory and
// may contain credentials; this writer never enumerates, reads, or deletes it.
function removeRegistryFile(configPath, fsImpl) {
  try {
    fsImpl.unlinkSync(configPath);
  } catch (error) {
    refuse('ACCOUNTS_REGISTRY_WRITE_FAILED',
      `The account registry could not be removed (${(error && error.code) || 'unknown error'}), so nothing was changed.`,
      { source: configPath });
  }
}

// The parent is recursive, but the final account directory is exclusive. An
// existing directory (including one another writer created after the parent
// check) is an external home and is recorded as false. A file or symlink at the
// target is refused rather than treated as a usable home.
function createAccountHome(home, fsImpl, cleanName) {
  try {
    fsImpl.mkdirSync(path.dirname(home), { recursive: true });
    fsImpl.mkdirSync(home);
    return true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      refuse('ACCOUNTS_HOME_NOT_CREATED',
        `The folder for "${cleanName}" could not be created (${(error && error.code) || 'unknown error'}), so nothing was changed.`,
        { name: cleanName });
    }
    let stat;
    try {
      stat = typeof fsImpl.lstatSync === 'function' ? fsImpl.lstatSync(home) : fsImpl.statSync(home);
    } catch (statError) {
      refuse('ACCOUNTS_HOME_NOT_CREATED',
        `The folder for "${cleanName}" could not be verified (${(statError && statError.code) || 'unknown error'}), so nothing was changed.`,
        { name: cleanName });
    }
    if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()
        || typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
      refuse('ACCOUNTS_HOME_NOT_CREATED',
        `The folder for "${cleanName}" is not a directory, so nothing was changed.`,
        { name: cleanName });
    }
    return false;
  }
}

/* The registration-origin guard is deliberately before path resolution. A
 * legacy row may carry a relative or otherwise unresolvable home, but that
 * uncertainty is not authority to inspect or destroy its sign-in. Only an
 * explicit boolean true, recorded by this writer's exclusive final mkdir, may
 * authorize destruction. Native client sign-in is preserved independently of
 * folder origin. */
function destroyCredential(entry, spec, { fsImpl, homeDir }) {
  if (entry && entry.client === 'antigravity') {
    return {
      credentialDestroyed: false,
      credentialDisposition: 'preserved-native-sign-in'
    };
  }
  if (!entry || entry[HOME_CREATED_BY_APP_FIELD] !== true) {
    return {
      credentialDestroyed: false,
      credentialDisposition: entry && entry[HOME_CREATED_BY_APP_FIELD] === false
        ? 'preserved-existing-home'
        : 'preserved-legacy-unknown-home'
    };
  }

  let resolvedHome;
  try {
    resolvedHome = resolveProfileDir({ home: entry[spec.dirField] }, { homeDir });
  } catch (error) {
    refuse('ACCOUNTS_HOME_NOT_RESOLVED',
      `The credential for "${entry.name}" could not be located (${(error && error.code) || 'unknown error'}), so nothing was changed.`,
      { name: entry.name });
  }
  const isolation = require('../provider-session-isolation');
  const credentialPath = isolation.assertIsolatedCredential(signInFilePath(resolvedHome, spec), isolation.isolationContext());
  try {
    fsImpl.unlinkSync(credentialPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { credentialDestroyed: true };
    }
    refuse('ACCOUNTS_CREDENTIAL_NOT_REMOVED',
      `The credential for "${entry.name}" could not be removed (${(error && error.code) || 'unknown error'}), so nothing was changed.`,
      { name: entry.name });
  }
  return { credentialDestroyed: true };
}

function withRegistryMutation(configPath, operation, {
  fsImpl,
  pid,
  lockIsAlive,
  lockTimeoutMs,
  lockSleep
}) {
  const isolation = require('../provider-session-isolation');
  isolation.assertIsolatedPath(configPath, isolation.isolationContext(), { field: 'account registry' });
  const lockFile = `${path.resolve(configPath)}.lock`;
  isolation.assertIsolatedPath(lockFile, isolation.isolationContext(), { field: 'account registry lock' });
  let lock;
  try {
    lock = acquireRegistryLock(lockFile, {
      pid, isAlive: lockIsAlive, timeoutMs: lockTimeoutMs, sleep: lockSleep
    });
  } catch (error) {
    refuse(
      error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING'
        ? 'ACCOUNTS_REGISTRY_BUSY'
        : 'ACCOUNTS_REGISTRY_LOCK_UNAVAILABLE',
      error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING'
        ? 'Another ToolsEnabled process is updating the account registry; this change was not applied.'
        : 'The account registry mutation lock could not be acquired, so nothing was changed.',
      { source: configPath, cause: error && typeof error.code === 'string' ? error.code : null }
    );
  }
  try {
    return operation();
  } finally {
    lock.release();
  }
}

/**
 * Add one account: its own home directory, and its entry in the registry.
 *
 * The caller supplies a NAME. Everything else -- where the home goes, what the
 * provider calls that field, what priority the entry takes -- is worked out
 * here, because every one of those is a thing a person had to know before this
 * function existed.
 *
 * IT IS SYNCHRONOUS FROM LOCKED READ TO RENAME, deliberately. This is a
 * read-modify-write over a shared file, and the one thing that must never
 * happen is two processes reading the same predecessor and silently dropping
 * one another's add. The PID lock is shared by add and remove, and a lock left
 * by a dead process is reclaimed from positive liveness evidence.
 *
 * THE DIRECTORY IS CREATED BEFORE THE ENTRY IS WRITTEN. An entry naming a
 * directory that could not be created is a registry that lies; an empty
 * directory with no entry is inert and is reused by the retry.
 *
 * `expectEmail` IS OPTIONAL AND IT IS THE ONLY THING THAT MAKES A WRONG SIGN-IN
 * VISIBLE. Nothing in the sign-in flow can tell which account was chosen in the
 * browser: the person presses Sign in beside a row called "work", picks
 * whichever account the browser was already holding, and every start afterwards
 * uses that one under the label "work". Recording the address the entry is FOR
 * gives the probe something to compare -- health.js does it for Codex and
 * rotation.js's claudeIdentityFault now does it for Claude. Left out, nothing
 * is promised and nothing is checked, which is what every registry written
 * before this said.
 *
 * Returns the account as recorded. Never a credential: this call creates an
 * EMPTY directory and never opens anything inside it. An address is an
 * identity, not a credential -- it is the thing being compared, and it opens
 * nothing.
 */
function addAccount({
  name,
  provider = 'codex',
  expectEmail = null,
  configPath = null,
  homesRoot = null,
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  fsImpl = fs,
  randomUUID = crypto.randomUUID,
  pid = process.pid,
  lockIsAlive = lockPidAlive,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockSleep = sleepSync
} = {}) {
  const spec = providerSpec(provider);
  if (!spec) {
    refuse('ACCOUNTS_PROVIDER_UNSUPPORTED',
      `This registry has no accounts of kind "${provider}". It supports ${describeProviders()}.`, { provider });
  }
  const cleanName = accountName(name);
  const expected = expectEmailFor(expectEmail, spec);
  const target = configPath || accountRegistryPath();
  const home = path.join(homesRoot || accountHomesRoot(spec.id), cleanName);
  const isolation = require('../provider-session-isolation');
  isolation.assertIsolatedPath(home, isolation.isolationContext(), { field: 'new provider account home' });

  return withRegistryMutation(target, () => {
    const previous = readForUpdate(target, fsImpl, { missingAsEmpty: true });

    const priority = previous.accounts.reduce(
      (highest, entry) => (entry && Number.isSafeInteger(entry.priority) && entry.priority > highest ? entry.priority : highest),
      0
    ) + 1;

    /* THE FIELD IS OMITTED WHEN THERE IS NONE, not written as null. An entry
       carrying `"expectEmail": null` and an entry carrying nothing read the
       same to registry.js, but only one of them looks, to a person opening the
       file, like a check somebody turned off. */
    const record = {
      ...previous,
      accounts: [
        ...previous.accounts,
        {
          name: cleanName,
          provider: spec.id,
          [spec.dirField]: home,
          ...(expected ? { expectEmail: expected } : {}),
          priority
        }
      ]
    };

  // THE CANDIDATE IS VALIDATED BEFORE ANYTHING IS CREATED, by the readers' own
  // parser. A duplicate name and a shared directory are refused here, with the
  // registry's own codes, from the registry's own implementation.
  //
  // IT RUNS BEFORE THE RESOLVED-PATH CHECK BELOW, AND THAT ORDER IS A FIX. The
  // other way round, adding an account whose NAME was already taken was refused
  // as "more than one codex account uses this folder" -- true, and the wrong
  // half of the truth: the folder is only shared because the name is, and the
  // person is looking at a name they typed. The parser checks names before
  // directories, so putting it first makes the refusal name the thing the
  // person can change.
    parseRegistry(JSON.stringify(record), { source: target });
    refuseResolvedCollision(previous.accounts, spec, home, homeDir, target);

    const homeCreatedByApp = createAccountHome(home, fsImpl, cleanName);
    record.accounts[record.accounts.length - 1][HOME_CREATED_BY_APP_FIELD] = homeCreatedByApp;

    persist(target, record, { fsImpl, randomUUID, pid });

    return Object.freeze({
      name: cleanName,
      provider: spec.id,
      home,
      homeEnv: spec.homeEnv,
      /* Said back so a caller can show whether the identity check is on for
         this entry, without re-reading the file to find out. Null is "no check
         was asked for", never "the check failed to record". */
      expectEmail: expected,
      priority,
      homeCreatedByApp,
      registryPath: target
    });
  }, {
    fsImpl, pid, lockIsAlive, lockTimeoutMs, lockSleep
  });
}

/**
 * Remove one account REGISTRATION, destroy its CREDENTIAL, and preserve
 * everything else in its provider home (session history, cached config).
 *
 * An account name may exist once per provider -- once for Codex, once for
 * Claude and once for Gemini -- so the provider remains part of the selection
 * even though the product's cloud surface currently binds only Codex.  The
 * existing registry is parsed before
 * any write: a damaged registry is not "repaired" by dropping an arbitrary
 * row, and a missing name is not treated as a successful idempotent removal.
 */
function removeAccount({
  name,
  provider = 'codex',
  configPath = null,
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  fsImpl = fs,
  randomUUID = crypto.randomUUID,
  pid = process.pid,
  lockIsAlive = lockPidAlive,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockSleep = sleepSync
} = {}) {
  const spec = providerSpec(provider);
  if (!spec) {
    refuse('ACCOUNTS_PROVIDER_UNSUPPORTED',
      `This registry has no accounts of kind "${provider}". It supports ${describeProviders()}.`, { provider });
  }
  const cleanName = accountName(name);
  const target = configPath || accountRegistryPath();
  return withRegistryMutation(target, () => {
    const previous = readForUpdate(target, fsImpl);
  // Validate the exact record we read, before selecting a raw entry to
  // preserve.  A duplicate or malformed entry is uncertainty, not authority
  // to make a destructive choice on the caller's behalf.
    const parsed = parseRegistry(JSON.stringify(previous), { source: target });
    const selected = parsed.accounts.find(entry => entry.provider === spec.id
      && entry.name.toLowerCase() === cleanName.toLowerCase());
    if (!selected) {
      refuse('ACCOUNTS_ACCOUNT_NOT_REGISTERED',
        `No ${spec.id} account named "${cleanName}" is registered, so nothing was changed.`,
        { source: target, name: cleanName, provider: spec.id });
    }
    const index = previous.accounts.findIndex(entry => entry && entry.provider === spec.id
      && typeof entry.name === 'string' && entry.name.trim().toLowerCase() === cleanName.toLowerCase());
    if (index < 0) {
    // The parsed and raw forms came from the same object.  Reaching this means
    // a nonstandard filesystem collaborator changed it during the read, so do
    // not turn that uncertainty into a write.
      refuse('ACCOUNTS_REGISTRY_INVALID',
        `The account registry at ${target} changed while the registration was being selected, so nothing was changed.`,
        { source: target });
    }
    // Destroyed BEFORE the registry entry is dropped, deliberately: if this
    // throws, the account stays registered and visible rather than the
    // registry silently reporting "removed" while its credential survives.
    // Use the raw row here: parseRegistry() intentionally normalizes reader
    // fields and leaves this writer-owned origin marker out of its public view.
    const credentialDisposition = destroyCredential(previous.accounts[index], spec, { fsImpl, homeDir });
    const accounts = previous.accounts.filter((_, entryIndex) => entryIndex !== index);
    if (accounts.length === 0) {
      removeRegistryFile(target, fsImpl);
    } else {
      const record = { ...previous, accounts };
    // The same reader owns the schema.  This catches a corrupted record before
    // its durable replacement is staged, just as addAccount() does.
      parseRegistry(JSON.stringify(record), { source: target });
      persist(target, record, { fsImpl, randomUUID, pid });
    }
    return Object.freeze({
      name: selected.name,
      provider: selected.provider,
      registryPath: target,
      remainingAccountCount: accounts.length,
      homePreserved: true,
      ...credentialDisposition
    });
  }, {
    fsImpl, pid, lockIsAlive, lockTimeoutMs, lockSleep
  });
}

module.exports = Object.freeze({
  MAX_NAME_LENGTH,
  addAccount,
  removeAccount
});
