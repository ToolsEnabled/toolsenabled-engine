'use strict';

// The Playwright gateway may only attach to a Chrome instance that this process
// launched and can still prove it owns.  A profile path alone is not ownership:
// another interactive Chrome can use the same profile, and a PID alone can be
// recycled.  The durable record is therefore bound to the executable, canonical
// profile, PID + process creation key, an unpredictable launch nonce, generation,
// and one loopback-only CDP listener.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { run, rootPath, ensureDir, commandPath } = require('./runtime');
const { defaultProbe: defaultListenerProbe } = require('./service-control');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');

const OWNER_VERSION = 1;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROCESS_ID = /^[1-9][0-9]{0,9}$/;
const PROCESS_START_KEY = /^[0-9]{1,19}$/;
const PORT = /^(?:[1-9][0-9]{0,4})$/;
const OWNER_FILE_ENV = 'TOOLSENABLED_BROWSER_OWNER_PATH';
// Chrome can occasionally expose its loopback CDP listener a moment after the
// exact launcher process is visible.  A failed helper invocation has already
// closed that exact nonce-bound launch before this set is consulted; retrying
// here is therefore safe only after recovery proves no such process remains.
const RETRIABLE_CONTAINED_START_ERRORS = new Set([
  'BROWSER_OWNER_START_CONTAINED_CDP_LISTENER_MISMATCH'
]);
const LINUX_BROWSER_COMMANDS = Object.freeze([
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  'microsoft-edge-stable', 'microsoft-edge'
]);
const LINUX_READY_TIMEOUT_MS = 20_000;
const LINUX_CLOSE_TIMEOUT_MS = 8_000;
const LINUX_POLL_MS = 200;
const SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(4));

// THE WINDOWS HELPER IS A SYNCHRONOUS SPAWN, SO ITS CEILING IS THE CALLING
// THREAD'S CEILING. helper() runs tools/browser.ps1 through runtime.run(),
// which is spawnSync. Whatever that call costs, the thread cannot do anything
// else meanwhile -- and this module is required in-process, so on the shell
// that thread is the main one. runtime.run()'s own default ceiling is TEN
// MINUTES, and helper() was passing no timeout at all, so a browser child that
// never answered could hold the main thread for ten minutes. A 1.0.45 crash
// post-mortem records exactly that shape: a main hung on browser cleanup, a
// 23-second stall, browser.start as the last action. MEASURED here: a start
// against a profile path the browser could not use took 25,198 ms, because
// browser.ps1 polls for 20 seconds before giving up, and every millisecond of
// that was spent inside spawnSync.
//
// So each action declares its own bound. The numbers are deliberately ABOVE
// browser.ps1's own internal deadlines -- start-owned polls for 20s, so a 45s
// ceiling cannot pre-empt a slow but healthy launch -- and far below anything a
// person would call a hang. A bound that fires is reported as itself
// (BROWSER_OWNER_HELPER_TIMED_OUT), not as a generic helper failure, because
// "the helper never answered" and "the helper said no" need different responses.
//
// This does not make the call asynchronous. It bounds it. Making the owned
// browser lifecycle async would change start/status/stop from synchronous
// functions across every caller, which is not this change.
const HELPER_TIMEOUT_MS = Object.freeze({
  'start-owned': 45_000,
  'recover-owned-launch': 30_000,
  'stop-owned': 30_000,
  'inspect-owned': 20_000,
  'open-owned': 20_000,
  status: 20_000,
  'process-start-key': 10_000
});
const HELPER_TIMEOUT_DEFAULT_MS = 20_000;

function helperTimeoutMs(action) {
  const configured = HELPER_TIMEOUT_MS[action];
  return Number.isSafeInteger(configured) && configured > 0 ? configured : HELPER_TIMEOUT_DEFAULT_MS;
}

function ownerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleepSync(milliseconds) {
  Atomics.wait(SYNC_SLEEP, 0, 0, milliseconds);
}

function configuredProfile(environment = process.env) {
  const configured = typeof environment.TOOLSENABLED_BROWSER_PROFILE_PATH === 'string'
    ? environment.TOOLSENABLED_BROWSER_PROFILE_PATH.trim() : '';
  return configured ? path.resolve(configured) : rootPath('profiles', 'chrome');
}

function ownerFile(environment = process.env) {
  const configured = typeof environment[OWNER_FILE_ENV] === 'string' ? environment[OWNER_FILE_ENV].trim() : '';
  if (configured && !path.isAbsolute(configured)) {
    throw ownerError('BROWSER_OWNER_PATH_INVALID', `${OWNER_FILE_ENV} must be an absolute path.`);
  }
  return configured ? path.resolve(configured) : rootPath('state', 'browser-owner.json');
}

function startLockFile(dependencies = {}) {
  return `${dependencies.ownerFile || ownerFile(dependencies.environment)}.start.lock`;
}

function pendingFile(dependencies = {}) {
  return `${dependencies.ownerFile || ownerFile(dependencies.environment)}.pending`;
}

function acquireStartLock(dependencies = {}) {
  const file = startLockFile(dependencies);
  ensureDir(path.dirname(file));
  const startKey = processStartKey(process.pid, dependencies);
  if (!PROCESS_START_KEY.test(String(startKey || ''))) {
    throw ownerError('BROWSER_OWNER_LOCK_FAILED', 'The owned-browser start reservation could not identify its process creation key. No browser was launched.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ processId: process.pid, processStartKey: startKey, createdAtMs: Date.now() })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      if (reclaimStartLock(file, dependencies)) return acquireStartLock(dependencies);
      throw ownerError('BROWSER_OWNER_START_IN_PROGRESS', 'Another ToolsEnabled browser start is already reserving the dedicated profile. No second browser was launched.');
    }
    throw ownerError('BROWSER_OWNER_LOCK_FAILED', 'The owned-browser start reservation could not be created. No browser was launched.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return () => {
    try { fs.unlinkSync(file); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw ownerError('BROWSER_OWNER_LOCK_RELEASE_FAILED', 'The owned-browser reservation could not be released.'); }
  };
}

function canonicalDirectory(value) {
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true });
  return canonicalExistingDirectory(directory);
}

function canonicalExistingDirectory(value) {
  const directory = path.resolve(value);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw ownerError('BROWSER_OWNER_PROFILE_INVALID', 'The dedicated browser profile must be a direct directory, not a link.');
  }
  return fs.realpathSync(directory);
}

function canonicalFile(value, label) {
  if (typeof value !== 'string' || !value) throw ownerError('BROWSER_OWNER_RECORD_INVALID', `The ${label} path is invalid.`);
  let stat;
  try { stat = fs.lstatSync(value); } catch { throw ownerError('BROWSER_OWNER_RECORD_INVALID', `The ${label} path no longer exists.`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw ownerError('BROWSER_OWNER_RECORD_INVALID', `The ${label} path is not a direct executable file.`);
  return fs.realpathSync(value);
}

// True only when the path is simply absent (ENOENT). Any other outcome --
// present, a permissions failure, a bad type -- is not this predicate's
// business; the caller's own canonicalization keeps deciding those. This
// exists to let assertRecord/assertPending tell "an old install/cut location
// is gone" apart from "this value is malformed", because only the former is
// safe to treat as recoverable staleness instead of a hard corruption throw.
function pathMissing(value) {
  if (typeof value !== 'string' || !value) return false;
  try { fs.lstatSync(value); return false; }
  catch (error) { return Boolean(error && error.code === 'ENOENT'); }
}

function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function randomCdpPort() { return 42000 + crypto.randomInt(16000); }

function validPort(value) {
  const string = String(value || '');
  const number = Number(string);
  return PORT.test(string) && Number.isInteger(number) && number >= 1024 && number <= 65535;
}

function expectedEndpoint(port) { return `http://127.0.0.1:${port}`; }

function assertRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== OWNER_VERSION) {
    throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The durable browser owner record is invalid. No browser was changed.');
  }
  for (const key of ['executable', 'profile', 'processStartKey', 'cdpProcessStartKey', 'nonce', 'generation']) {
    if (typeof record[key] !== 'string' || !record[key]) {
      throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The durable browser owner record is incomplete. No browser was changed.');
    }
  }
  const state = record.state === undefined ? 'active' : record.state;
  if (!['active', 'orphan_uncertain'].includes(state) || !PROCESS_ID.test(String(record.processId)) || !PROCESS_ID.test(String(record.cdpProcessId)) || !PROCESS_START_KEY.test(record.processStartKey) || !PROCESS_START_KEY.test(record.cdpProcessStartKey)
      || !TOKEN.test(record.nonce) || !TOKEN.test(record.generation) || !validPort(record.cdpPort)) {
    throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The durable browser owner record has invalid identity fields. No browser was changed.');
  }
  // A record naming an executable/profile path that no longer exists AT ALL is
  // not evidence of corruption -- an old install/cut location (an old
  // AppData\Roaming state root, a moved Chrome install) can go away while the
  // durable record that named it survives untouched. That is the one failure
  // this function must not swallow into a hard, unrecoverable throw: it is the
  // ordering defect that used to fire here, before readRecord()'s caller ever
  // got a chance to run its own dead-process/orphan recovery. readRecord()
  // below treats this specific code as "no usable record", which lets
  // start()'s existing fresh-launch path run against the CURRENTLY configured
  // profile instead of dying on a path that merely used to be real. A path
  // that exists but fails the stricter checks below (a symlink, not a
  // directory/file) is a different, security-relevant condition and must keep
  // failing hard -- that branch is unchanged.
  if (pathMissing(record.executable) || pathMissing(record.profile)) {
    throw ownerError('BROWSER_OWNER_RECORD_STALE', 'The durable browser owner record names a path that no longer exists. The record is stale and may be recovered.');
  }
  const executable = canonicalFile(record.executable, 'browser executable');
  let profile;
  try { profile = canonicalExistingDirectory(record.profile); }
  catch { throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The browser profile in the durable owner record is invalid. No browser was changed.'); }
  const executableMatches = process.platform === 'win32'
    ? path.resolve(record.executable).toLowerCase() === executable.toLowerCase()
    : path.resolve(record.executable) === executable;
  const profileMatches = process.platform === 'win32'
    ? path.resolve(record.profile).toLowerCase() === profile.toLowerCase()
    : path.resolve(record.profile) === profile;
  if (!executableMatches || !profileMatches) {
    throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The durable browser owner record is not canonical. No browser was changed.');
  }
  return Object.freeze({
    version: OWNER_VERSION,
    executable,
    profile,
    processId: Number(record.processId),
    processStartKey: record.processStartKey,
    cdpProcessId: Number(record.cdpProcessId),
    cdpProcessStartKey: record.cdpProcessStartKey,
    nonce: record.nonce,
    generation: record.generation,
    cdpPort: Number(record.cdpPort),
    state,
    createdAtMs: Number.isSafeInteger(record.createdAtMs) ? record.createdAtMs : 0
  });
}

function readRecord(dependencies = {}) {
  const file = dependencies.ownerFile || ownerFile(dependencies.environment);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw ownerError('BROWSER_OWNER_RECORD_UNREADABLE', 'The durable browser owner record could not be read. No browser was changed.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw ownerError('BROWSER_OWNER_RECORD_INVALID', 'The durable browser owner record is not JSON. No browser was changed.'); }
  try {
    return assertRecord(parsed);
  } catch (error) {
    // Every caller (start, attach, status, stop) already treats a null record
    // as "no owned browser recorded" and proceeds accordingly -- start()
    // specifically then opens the currently configured profile fresh. That is
    // exactly the self-heal a stale path needs, so no call site has to change.
    if (error && error.code === 'BROWSER_OWNER_RECORD_STALE') return null;
    throw error;
  }
}

function writeRecord(record, dependencies = {}) {
  const file = dependencies.ownerFile || ownerFile(dependencies.environment);
  const value = assertRecord(record);
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomToken().slice(0, 12)}.tmp`;
  let descriptor;
  let writeError;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    writeError = error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (writeError) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw writeError;
  }
  try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACLs remain the authority. */ }
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw ownerError('BROWSER_OWNER_RECORD_WRITE_FAILED', 'The durable browser owner record could not be written. No browser was changed.');
  }
  return value;
}

function removeRecord(dependencies = {}) {
  const file = dependencies.ownerFile || ownerFile(dependencies.environment);
  try { fs.unlinkSync(file); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw ownerError('BROWSER_OWNER_RECORD_REMOVE_FAILED', 'The stale browser owner record could not be removed.'); }
}

function assertPending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== OWNER_VERSION || value.state !== 'launching'
      || !TOKEN.test(String(value.nonce || '')) || !TOKEN.test(String(value.generation || '')) || !validPort(value.cdpPort)) {
    throw ownerError('BROWSER_OWNER_PENDING_INVALID', 'The durable pending browser launch record is invalid. No browser was changed.');
  }
  // Same stale-path allowance as assertRecord, and for the same reason: a
  // pending marker whose profile directory has since vanished (moved state
  // root) is leftover residue from a launch attempt against a place that no
  // longer exists, not malformed data. readPending() turns this one code into
  // "no pending launch" rather than a hard failure.
  if (pathMissing(value.profile)) {
    throw ownerError('BROWSER_OWNER_PENDING_STALE', 'The durable pending browser launch profile no longer exists. The pending record is stale.');
  }
  let profile;
  try { profile = canonicalExistingDirectory(value.profile); }
  catch { throw ownerError('BROWSER_OWNER_PENDING_INVALID', 'The durable pending browser launch profile is invalid. No browser was changed.'); }
  if (!samePath(value.profile, profile)) throw ownerError('BROWSER_OWNER_PENDING_INVALID', 'The durable pending browser launch profile is not canonical. No browser was changed.');
  return Object.freeze({ version: OWNER_VERSION, state: 'launching', profile, nonce: value.nonce, generation: value.generation, cdpPort: Number(value.cdpPort) });
}

function writePending(value, dependencies = {}) {
  const file = pendingFile(dependencies);
  const pending = assertPending(value);
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomToken().slice(0, 12)}.tmp`;
  let descriptor;
  let writeError;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(pending)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    writeError = error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (writeError) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw writeError;
  }
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw ownerError('BROWSER_OWNER_PENDING_WRITE_FAILED', 'The pending browser launch record could not be written. No browser was launched.');
  }
  return pending;
}

function readPending(dependencies = {}) {
  const file = pendingFile(dependencies);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw ownerError('BROWSER_OWNER_PENDING_UNREADABLE', 'The pending browser launch record could not be read. No browser was changed.');
  }
  try { return assertPending(JSON.parse(raw)); }
  catch (error) {
    if (error && error.code === 'BROWSER_OWNER_PENDING_STALE') return null;
    if (error && error.code) throw error;
    throw ownerError('BROWSER_OWNER_PENDING_INVALID', 'The pending browser launch record is invalid. No browser was changed.');
  }
}

function removePending(dependencies = {}) {
  const file = pendingFile(dependencies);
  try { fs.unlinkSync(file); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw ownerError('BROWSER_OWNER_PENDING_REMOVE_FAILED', 'The pending browser launch record could not be removed.'); }
}

function withTempJson(prefix, value, callback) {
  const file = path.join(os.tmpdir(), `toolsenabled-${prefix}-${process.pid}-${Date.now()}-${randomToken().slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let completed = false;
  try {
    const result = callback(file);
    completed = true;
    return result;
  } finally {
    try { fs.unlinkSync(file); }
    catch (error) {
      // Preserve an action error, but never report a successful helper action
      // when disposal of its nonce-bearing payload could not be established.
      if (completed) throw ownerError('BROWSER_OWNER_HELPER_PAYLOAD_REMOVE_FAILED', 'The owned-browser helper completed, but its temporary identity payload could not be removed.');
    }
  }
}

function parseHelperResult(result, action, timeoutMs) {
  // A child that was killed for running past its bound is not a child that
  // refused: runtime.run() reports that case as timedOut rather than throwing,
  // and it used to fall through to the generic helper-failed refusal below,
  // which names neither the cause nor the bound.
  if (result && result.timedOut === true) {
    throw ownerError(
      'BROWSER_OWNER_HELPER_TIMED_OUT',
      `The owned-browser ${action} helper did not answer within ${timeoutMs} ms and was stopped. No browser was adopted, and any record it would have written was not written.`
    );
  }
  if (!result || result.status !== 0) {
    const detail = String(result && (result.stderr || result.stdout) || '');
    if (/BROWSER_PROFILE_IN_USE/i.test(detail)) {
      throw ownerError('BROWSER_PROFILE_IN_USE', 'The exact dedicated browser profile is already in use. ToolsEnabled did not attach to, close, or alter that browser.');
    }
    if (/BROWSER_CDP_PORT_IN_USE/i.test(detail)) {
      throw ownerError('BROWSER_CDP_PORT_IN_USE', 'The selected loopback CDP port was already in use. No browser was launched.');
    }
    if (/BROWSER_CDP_PORT_UNCERTAIN/i.test(detail)) {
      throw ownerError('BROWSER_CDP_PORT_UNCERTAIN', 'The selected loopback CDP port could not be inspected reliably. No browser was launched.');
    }
    const contained = /BROWSER_OWNER_START_CONTAINED_([A-Z_]+)/.exec(detail);
    if (contained) {
      throw ownerError(`BROWSER_OWNER_START_CONTAINED_${contained[1]}`, `The just-launched exact nonce-bound browser failed readiness (${contained[1]}) and was gracefully closed.`);
    }
    throw ownerError('BROWSER_OWNER_HELPER_FAILED', `The owned-browser ${action} helper failed without changing an unowned browser.`);
  }
  try {
    const value = JSON.parse(String(result.stdout || '').trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid JSON');
    return value;
  } catch {
    throw ownerError('BROWSER_OWNER_HELPER_INVALID', `The owned-browser ${action} helper returned invalid metadata.`);
  }
}

function linuxProcessProbe(processId, dependencies = {}) {
  if (!PROCESS_ID.test(String(processId))) return { status: 'uncertain', facts: null };
  const filesystem = dependencies.fs || fs;
  const procRoot = dependencies.procRoot || '/proc';
  const processRoot = path.join(procRoot, String(processId));
  let stat;
  try { stat = String(filesystem.readFileSync(path.join(processRoot, 'stat'), 'utf8')); }
  catch (error) { return { status: error && error.code === 'ENOENT' ? 'absent' : 'uncertain', facts: null }; }
  const end = stat.lastIndexOf(')');
  if (end < 0) return { status: 'uncertain', facts: null };
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const processStartKey = fields[19];
  const parentProcessId = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  if (!PROCESS_START_KEY.test(String(processStartKey || '')) || !Number.isSafeInteger(parentProcessId) || parentProcessId < 0
      || !PROCESS_ID.test(String(processGroupId))) {
    return { status: 'uncertain', facts: null };
  }
  try {
    const executable = filesystem.realpathSync(path.join(processRoot, 'exe'));
    const args = filesystem.readFileSync(path.join(processRoot, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
    if (!args.length) return { status: 'uncertain', facts: null };
    // Re-read field 22 after the other facts. A disappearing/recycled PID is
    // uncertainty, never evidence about the process sampled above.
    const after = String(filesystem.readFileSync(path.join(processRoot, 'stat'), 'utf8'));
    const afterEnd = after.lastIndexOf(')');
    const afterFields = afterEnd < 0 ? [] : after.slice(afterEnd + 2).trim().split(/\s+/);
    if (afterFields[19] !== processStartKey) return { status: 'uncertain', facts: null };
    return { status: 'present', facts: { processId: Number(processId), processStartKey, executable, args, parentProcessId, processGroupId } };
  } catch (error) {
    return { status: error && error.code === 'ENOENT' ? 'absent' : 'uncertain', facts: null };
  }
}

function linuxProcesses(dependencies = {}) {
  const filesystem = dependencies.fs || fs;
  const procRoot = dependencies.procRoot || '/proc';
  let entries;
  try { entries = filesystem.readdirSync(procRoot, { withFileTypes: true }); }
  catch { return { status: 'uncertain', processes: [] }; }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROCESS_ID.test(entry.name)) continue;
    try {
      const args = filesystem.readFileSync(path.join(procRoot, entry.name, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
      if (args.length) processes.push({ processId: Number(entry.name), args });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return { status: 'uncertain', processes: [] };
    }
  }
  return { status: 'known', processes };
}

function hasExactArgument(facts, argument) {
  return Boolean(facts && Array.isArray(facts.args) && facts.args.includes(argument));
}

function linuxFreshCandidates(payload, profile, dependencies = {}) {
  const inventory = linuxProcesses(dependencies);
  if (inventory.status !== 'known') return { status: 'uncertain', candidates: [] };
  const expected = [
    `--user-data-dir=${profile}`,
    `--toolsenabled-owner=${payload.nonce}`,
    `--toolsenabled-generation=${payload.generation}`,
    `--remote-debugging-port=${Number(payload.cdpPort)}`,
    '--remote-debugging-address=127.0.0.1'
  ];
  const matches = inventory.processes.filter(facts => expected.every(argument => hasExactArgument(facts, argument)));
  const candidates = [];
  for (const match of matches) {
    const probe = linuxProcessProbe(match.processId, dependencies);
    if (probe.status === 'uncertain') return { status: 'uncertain', candidates: [] };
    if (probe.status === 'present') candidates.push(probe.facts);
  }
  return { status: 'known', candidates };
}

function linuxListenerProbe(port, dependencies = {}) {
  const probe = dependencies.listenerProbe || defaultListenerProbe;
  try {
    return { status: 'known', listeners: probe(Number(port), {
      platform: 'linux', fs: dependencies.fs || fs, procRoot: dependencies.procRoot || '/proc'
    }).listeners };
  } catch {
    return { status: 'uncertain', listeners: [] };
  }
}

function linuxDescendantProbe(childProcessId, ancestorProcessId, dependencies = {}) {
  if (childProcessId === ancestorProcessId) return { status: 'known', isDescendant: true };
  let current = childProcessId;
  for (let depth = 0; depth < 32; depth += 1) {
    const probe = linuxProcessProbe(current, dependencies);
    if (probe.status === 'uncertain') return { status: 'uncertain', isDescendant: false };
    if (probe.status === 'absent' || probe.facts.parentProcessId <= 0) return { status: 'known', isDescendant: false };
    current = probe.facts.parentProcessId;
    if (current === ancestorProcessId) return { status: 'known', isDescendant: true };
  }
  return { status: 'known', isDescendant: false };
}

function linuxCdpRequest(method, url, dependencies = {}) {
  if (typeof dependencies.cdpRequest === 'function') return dependencies.cdpRequest(method, url);
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const source = [
    "'use strict';",
    'const method = process.argv[1];',
    'const url = process.argv[2];',
    'fetch(url, { method, signal: AbortSignal.timeout(5000) })',
    "  .then(async response => { if (!response.ok) throw new Error('HTTP_' + response.status); process.stdout.write(await response.text()); })",
    '  .catch(error => { process.stderr.write(String(error && error.message || error)); process.exitCode = 1; });'
  ].join('\n');
  const result = spawnSyncImpl(process.execPath, ['-e', source, method, url], {
    encoding: 'utf8', timeout: 6_000, windowsHide: true, shell: false,
    env: safeLaunchEnvironment(
      { PATH: process.env.PATH || '', NODE_NO_WARNINGS: '1' },
      { context: 'owned browser Linux CDP probe' }
    )
  });
  if (!result || result.error || result.status !== 0) throw new Error('CDP request failed');
  return String(result.stdout || '');
}

function linuxInspectOwned(record, dependencies = {}) {
  if (!record || record.version !== OWNER_VERSION || !PROCESS_ID.test(String(record.processId))
      || !PROCESS_START_KEY.test(String(record.processStartKey || '')) || !TOKEN.test(String(record.nonce || ''))
      || !TOKEN.test(String(record.generation || '')) || !validPort(record.cdpPort)) {
    return { status: 'invalid', code: 'RECORD_INVALID' };
  }
  let executable;
  let profile;
  try { executable = canonicalFile(record.executable, 'browser executable'); profile = canonicalExistingDirectory(record.profile); }
  catch { return { status: 'invalid', code: 'PATH_INVALID' }; }
  const processProbe = linuxProcessProbe(Number(record.processId), dependencies);
  if (processProbe.status === 'absent') return { status: 'invalid', code: 'PROCESS_ABSENT' };
  if (processProbe.status !== 'present') return { status: 'invalid', code: 'PROCESS_PROBE_UNCERTAIN' };
  const facts = processProbe.facts;
  if (facts.processStartKey !== String(record.processStartKey)) return { status: 'invalid', code: 'PROCESS_START_KEY_MISMATCH' };
  if (facts.processGroupId !== Number(record.processId)) return { status: 'invalid', code: 'PROCESS_GROUP_MISMATCH' };
  if (facts.executable !== executable) return { status: 'invalid', code: 'EXECUTABLE_MISMATCH' };
  if (!hasExactArgument(facts, `--user-data-dir=${profile}`)) return { status: 'invalid', code: 'PROFILE_MISMATCH' };
  if (!hasExactArgument(facts, `--toolsenabled-owner=${record.nonce}`)) return { status: 'invalid', code: 'NONCE_MISMATCH' };
  if (!hasExactArgument(facts, `--toolsenabled-generation=${record.generation}`)) return { status: 'invalid', code: 'GENERATION_MISMATCH' };
  if (!hasExactArgument(facts, `--remote-debugging-port=${Number(record.cdpPort)}`)) return { status: 'invalid', code: 'CDP_PORT_MISMATCH' };
  if (!hasExactArgument(facts, '--remote-debugging-address=127.0.0.1')) return { status: 'invalid', code: 'CDP_ADDRESS_MISMATCH' };
  const listenerProbe = linuxListenerProbe(Number(record.cdpPort), dependencies);
  if (listenerProbe.status !== 'known') return { status: 'invalid', code: 'CDP_LISTENER_UNCERTAIN' };
  const listeners = [...listenerProbe.listeners];
  if (listeners.length !== 1 || listeners[0].localAddress !== '127.0.0.1') return { status: 'invalid', code: 'CDP_LISTENER_MISMATCH' };
  const cdpProcessId = Number(listeners[0].pid);
  const cdpProbe = linuxProcessProbe(cdpProcessId, dependencies);
  if (cdpProbe.status !== 'present') return { status: 'invalid', code: cdpProbe.status === 'absent' ? 'CDP_OWNER_ABSENT' : 'CDP_OWNER_UNCERTAIN' };
  const ancestry = linuxDescendantProbe(cdpProcessId, Number(record.processId), dependencies);
  if (ancestry.status !== 'known') return { status: 'invalid', code: 'CDP_OWNER_UNCERTAIN' };
  if (cdpProbe.facts.executable !== executable || !ancestry.isDescendant
      || (record.cdpProcessId != null && Number(record.cdpProcessId) !== cdpProcessId)
      || (record.cdpProcessStartKey != null && String(record.cdpProcessStartKey) !== cdpProbe.facts.processStartKey)) {
    return { status: 'invalid', code: 'CDP_OWNER_MISMATCH' };
  }
  try {
    const version = JSON.parse(linuxCdpRequest('GET', `${expectedEndpoint(record.cdpPort)}/json/version`, dependencies));
    const endpoint = new URL(String(version.webSocketDebuggerUrl || ''));
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== Number(record.cdpPort)) {
      return { status: 'invalid', code: 'CDP_ENDPOINT_MISMATCH' };
    }
  } catch { return { status: 'invalid', code: 'CDP_ENDPOINT_UNAVAILABLE' }; }
  return {
    status: 'valid', processId: Number(record.processId), processStartKey: String(record.processStartKey),
    executable, profile, cdpPort: Number(record.cdpPort), endpoint: expectedEndpoint(record.cdpPort),
    cdpProcessId, cdpProcessStartKey: cdpProbe.facts.processStartKey
  };
}

function linuxProcessGroupExists(processId, dependencies = {}) {
  const kill = dependencies.kill || process.kill.bind(process);
  try { kill(-Number(processId), 0); return true; }
  catch (error) { if (error && error.code === 'ESRCH') return false; throw error; }
}

function linuxCloseExactLaunch(record, dependencies = {}) {
  let executable;
  let profile;
  try { executable = canonicalFile(record.executable, 'browser executable'); profile = canonicalExistingDirectory(record.profile); }
  catch { return { status: 'identity_uncertain' }; }
  const before = linuxProcessProbe(Number(record.processId), dependencies);
  if (before.status === 'absent') return { status: 'closed' };
  if (before.status !== 'present') return { status: 'identity_uncertain' };
  const facts = before.facts;
  if (facts.processStartKey !== String(record.processStartKey) || facts.processGroupId !== Number(record.processId) || facts.executable !== executable
      || !hasExactArgument(facts, `--user-data-dir=${profile}`)
      || !hasExactArgument(facts, `--toolsenabled-owner=${record.nonce}`)
      || !hasExactArgument(facts, `--toolsenabled-generation=${record.generation}`)
      || !hasExactArgument(facts, `--remote-debugging-port=${Number(record.cdpPort)}`)
      || !hasExactArgument(facts, '--remote-debugging-address=127.0.0.1')) return { status: 'identity_uncertain' };
  const kill = dependencies.kill || process.kill.bind(process);
  try { kill(-Number(record.processId), 'SIGTERM'); }
  catch (error) { if (!error || error.code !== 'ESRCH') return { status: 'close_refused' }; }
  const deadline = Date.now() + LINUX_CLOSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { if (!linuxProcessGroupExists(record.processId, dependencies)) return { status: 'closed' }; }
    catch { return { status: 'identity_uncertain' }; }
    const after = linuxProcessProbe(Number(record.processId), dependencies);
    if (after.status === 'present' && after.facts.processStartKey !== String(record.processStartKey)) return { status: 'identity_uncertain' };
    if (after.status === 'uncertain') return { status: 'identity_uncertain' };
    sleepSync(LINUX_POLL_MS);
  }
  return { status: 'close_requested' };
}

function linuxFindBrowser(dependencies = {}) {
  if (typeof dependencies.browser === 'string' && dependencies.browser) {
    try { return canonicalFile(dependencies.browser, 'browser executable'); }
    catch { throw ownerError('BROWSER_OWNER_BROWSER_INVALID', 'The configured browser executable could not be established as a direct executable file.'); }
  }
  const resolveCommand = dependencies.commandPath || commandPath;
  for (const command of LINUX_BROWSER_COMMANDS) {
    const found = resolveCommand(command);
    if (!found) continue;
    // Linux packages normally expose their launcher through a PATH symlink.
    // Resolve that discovery alias, then keep the existing direct-file check
    // and canonical executable identity used by every ownership revalidation.
    try { return canonicalFile(fs.realpathSync(found), 'browser executable'); } catch { /* try the next installed browser */ }
  }
  return null;
}

function linuxProfileInUse(profile, dependencies = {}) {
  try { fs.lstatSync(path.join(profile, 'SingletonLock')); return { inUse: true, lockPresent: true }; }
  catch (error) { if (!error || error.code !== 'ENOENT') return { inUse: true, lockPresent: false }; }
  const inventory = linuxProcesses(dependencies);
  if (inventory.status !== 'known') return { inUse: true, lockPresent: false };
  return { inUse: inventory.processes.some(facts => hasExactArgument(facts, `--user-data-dir=${profile}`)), lockPresent: false };
}

// CORRECTED 2026-09-12: the guard this replaced assumed Chrome binds its
// process-singleton socket directly under --user-data-dir. Traced with
// strace against this exact Electron/Chromium build and it does not.
// ProcessSingleton::Create makes a SHORT scoped_dir under TMPDIR, binds the
// real AF_UNIX socket there --
//   bind(sun_path="$TMPDIR/scoped_dirXXXXXX/SingletonSocket")
// -- and only SYMLINKS <profile>/SingletonSocket to that short real path.
// symlink() targets are plain filesystem paths (PATH_MAX, thousands of
// bytes), not sockaddr_un.sun_path (108 bytes including its NUL terminator,
// unix(7)), so profile depth was never the constraint. Measured directly:
// a DEEP TMPDIR with a SHORT profile still crashed loud at
// chrome/browser/process_singleton_posix.cc:315, "Socket path too long",
// naming exactly $TMPDIR/scoped_dirXXXXXX/SingletonSocket; the SAME deep
// profile with TMPDIR pointed at /run/user/<uid> instead acquired the
// singleton lock and bound the socket successfully. TMPDIR is the only
// thing that matters. The removed guard would have refused a profile that
// works fine, and would have missed a deep ambient TMPDIR entirely.
//
// Fixed instead: give the spawned browser a short, private TMPDIR of its
// own, so the launch works regardless of how deep the profile or the
// ambient TMPDIR is -- the outcome asked for, not a new refusal. /run/user/
// <uid> is systemd-logind-managed, private to this exact account, mode
// 0700, and short by construction; it is the same trust shape
// owner-host-linux.js already requires of its own socket directory. A
// refusal fires only if that is unavailable AND the ambient temp directory
// is also too deep to leave Chrome the ~33 bytes its own scoped_dir and
// socket name need -- i.e. only when the operation genuinely cannot be
// made to work, not as a default answer.
function shortLinuxTmpdir(dependencies = {}) {
  const filesystem = dependencies.fs || fs;
  const getuid = dependencies.getuid || (typeof process.getuid === 'function' ? process.getuid.bind(process) : null);
  const tmpdir = dependencies.tmpdir || os.tmpdir;
  const uid = getuid ? getuid() : null;
  if (uid !== null) {
    const runUserDir = `/run/user/${uid}`;
    try {
      const stat = filesystem.lstatSync(runUserDir);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === 0o700) {
        return runUserDir;
      }
    } catch { /* not present on this host; fall through to the ambient check */ }
  }
  const ambient = tmpdir();
  if (Buffer.byteLength(ambient, 'utf8') <= 60) return ambient;
  throw ownerError('BROWSER_OWNER_NO_SHORT_TMPDIR',
    `Neither /run/user/${uid ?? '<uid>'} nor the system temp directory (${ambient}, `
    + `${Buffer.byteLength(ambient, 'utf8')} bytes) is short enough for Chrome's process-singleton socket `
    + "(sockaddr_un.sun_path allows 107 usable bytes, and Chrome's own scoped directory and socket name need "
    + 'about 33 of them). No browser was launched.');
}

function linuxStartOwned(payload, dependencies = {}) {
  if (!TOKEN.test(String(payload.nonce || '')) || !TOKEN.test(String(payload.generation || ''))) throw new Error('owned-browser launch nonce is invalid.');
  let url;
  try { url = new URL(String(payload.url)); } catch { throw new Error('owned-browser launch requires HTTPS.'); }
  if (url.protocol !== 'https:' || !validPort(payload.cdpPort)) throw new Error('owned-browser launch metadata is invalid.');
  const executable = linuxFindBrowser(dependencies);
  if (!executable) throw ownerError('BROWSER_OWNER_BROWSER_NOT_FOUND', 'Owned-browser start requires Google Chrome, Chromium, or Microsoft Edge on Linux. No browser was launched.');
  const profile = canonicalDirectory(payload.profile);
  if (linuxProfileInUse(profile, dependencies).inUse) throw ownerError('BROWSER_PROFILE_IN_USE', 'The exact dedicated browser profile is already in use. ToolsEnabled did not attach to, close, or alter that browser.');
  const portProbe = linuxListenerProbe(Number(payload.cdpPort), dependencies);
  if (portProbe.status !== 'known') throw ownerError('BROWSER_CDP_PORT_UNCERTAIN', 'The selected loopback CDP port could not be inspected reliably. No browser was launched.');
  if (portProbe.listeners.length) throw ownerError('BROWSER_CDP_PORT_IN_USE', 'The selected loopback CDP port was already in use. No browser was launched.');
  const args = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${Number(payload.cdpPort)}`, '--remote-debugging-address=127.0.0.1',
    `--toolsenabled-owner=${payload.nonce}`, `--toolsenabled-generation=${payload.generation}`,
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', url.href
  ];
  const spawnImpl = dependencies.spawn || spawn;
  const shortTmpdir = shortLinuxTmpdir(dependencies);
  let child;
  try {
    child = spawnImpl(executable, args, {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
      env: { ...safeLaunchEnvironment(process.env, { context: 'owned browser Linux launch' }), TMPDIR: shortTmpdir }
    });
    if (child && typeof child.once === 'function') child.once('error', () => { /* readiness/recovery remains the durable result */ });
    if (!child || !PROCESS_ID.test(String(child.pid))) throw new Error('browser process did not return a PID');
    if (typeof child.unref === 'function') child.unref();
  } catch { throw ownerError('BROWSER_OWNER_LAUNCH_FAILED', 'The Linux owned-browser process could not be launched. No existing browser was changed.'); }
  const deadline = Date.now() + LINUX_READY_TIMEOUT_MS;
  let record = null;
  let verified = { status: 'invalid', code: 'FRESH_PROCESS_NOT_FOUND' };
  while (Date.now() < deadline) {
    const candidates = linuxFreshCandidates(payload, profile, dependencies);
    if (candidates.status !== 'known') verified = { status: 'invalid', code: 'FRESH_PROCESS_PROBE_UNCERTAIN' };
    else if (candidates.candidates.length === 1) {
      const facts = candidates.candidates[0];
      record = {
        version: OWNER_VERSION, executable: facts.executable, profile, processId: facts.processId,
        processStartKey: facts.processStartKey, nonce: payload.nonce, generation: payload.generation, cdpPort: Number(payload.cdpPort)
      };
      verified = linuxInspectOwned(record, dependencies);
      if (verified.status === 'valid') return {
        executable: verified.executable, profile: verified.profile, processId: verified.processId,
        processStartKey: verified.processStartKey, cdpPort: verified.cdpPort,
        cdpProcessId: verified.cdpProcessId, cdpProcessStartKey: verified.cdpProcessStartKey
      };
    } else verified = { status: 'invalid', code: candidates.candidates.length ? 'FRESH_PROCESS_AMBIGUOUS' : 'FRESH_PROCESS_NOT_FOUND' };
    sleepSync(LINUX_POLL_MS);
  }
  if (record) {
    const contained = linuxCloseExactLaunch(record, dependencies);
    if (contained.status === 'closed') {
      throw ownerError(`BROWSER_OWNER_START_CONTAINED_${verified.code}`, `The just-launched exact nonce-bound browser failed readiness (${verified.code}) and was gracefully closed.`);
    }
    return { status: 'orphan_uncertain', executable: record.executable, profile, processId: record.processId, processStartKey: record.processStartKey, cdpPort: Number(payload.cdpPort) };
  }
  return { status: 'orphan_uncertain', reason: verified.code };
}

function linuxHelper(action, payload, dependencies = {}) {
  if (action === 'process-start-key') {
    const probe = linuxProcessProbe(Number(payload.processId), dependencies);
    return probe.status === 'present' ? { status: 'present', processStartKey: probe.facts.processStartKey } : { status: probe.status };
  }
  if (action === 'status') {
    const filesystem = dependencies.fs || fs;
    const configured = dependencies.profile || configuredProfile(dependencies.environment);
    let profileExists;
    try { filesystem.lstatSync(configured); profileExists = true; }
    catch (error) {
      if (error && error.code === 'ENOENT') profileExists = false;
      else profileExists = null;
    }
    let profile;
    let profileCanonical = profileExists !== true;
    try {
      profile = profileExists === true ? canonicalExistingDirectory(configured) : path.resolve(configured);
      profileCanonical = true;
    }
    catch { profile = path.resolve(configured); }
    const usage = profileExists === true && profileCanonical
      ? linuxProfileInUse(profile, dependencies)
      : profileExists === false
        ? { inUse: false, lockPresent: false }
        : { inUse: null, lockPresent: null };
    return { browser: linuxFindBrowser(dependencies), profile, profileExists, profileInUse: usage.inUse, profileLockPresent: usage.lockPresent };
  }
  if (action === 'inspect-owned') return linuxInspectOwned(payload, dependencies);
  if (action === 'start-owned') return linuxStartOwned(payload, dependencies);
  if (action === 'recover-owned-launch') {
    if (!TOKEN.test(String(payload.nonce || '')) || !TOKEN.test(String(payload.generation || '')) || !validPort(payload.cdpPort)) {
      throw ownerError('BROWSER_OWNER_PENDING_INVALID', 'The pending owned-browser launch identity is invalid. No browser was changed.');
    }
    const profile = canonicalExistingDirectory(payload.profile);
    const candidates = linuxFreshCandidates(payload, profile, dependencies);
    if (candidates.status !== 'known') return { status: 'orphan_uncertain', reason: 'PROCESS_PROBE_UNCERTAIN' };
    if (!candidates.candidates.length) return { status: 'absent' };
    if (candidates.candidates.length !== 1) return { status: 'orphan_uncertain' };
    const facts = candidates.candidates[0];
    const record = { version: OWNER_VERSION, executable: facts.executable, profile, processId: facts.processId, processStartKey: facts.processStartKey, nonce: payload.nonce, generation: payload.generation, cdpPort: Number(payload.cdpPort) };
    const verified = linuxInspectOwned(record, dependencies);
    if (verified.status === 'valid') return { ...verified, status: 'active' };
    if (['PROCESS_PROBE_UNCERTAIN', 'CDP_LISTENER_UNCERTAIN', 'CDP_OWNER_UNCERTAIN'].includes(verified.code)) return { status: 'orphan_uncertain', reason: verified.code };
    const contained = linuxCloseExactLaunch(record, dependencies);
    return contained.status === 'closed' ? { status: 'absent' } : { status: 'orphan_uncertain', executable: facts.executable, processId: facts.processId, processStartKey: facts.processStartKey };
  }
  if (action === 'open-owned') {
    const verified = linuxInspectOwned(payload, dependencies);
    if (verified.status !== 'valid') return verified;
    let url;
    try { url = new URL(String(payload.url)); } catch { return { status: 'open_failed' }; }
    if (url.protocol !== 'https:') return { status: 'open_failed' };
    try { linuxCdpRequest('PUT', `${verified.endpoint}/json/new?${encodeURIComponent(url.href)}`, dependencies); return { status: 'opened' }; }
    catch { return { status: 'open_failed' }; }
  }
  if (action === 'stop-owned') {
    const verified = linuxInspectOwned(payload, dependencies);
    if (verified.status !== 'valid') return verified;
    return linuxCloseExactLaunch(payload, dependencies);
  }
  throw ownerError('BROWSER_OWNER_ACTION_UNSUPPORTED', `Owned-browser action "${String(action)}" is not implemented on Linux. No browser process was changed.`);
}

function helper(action, payload, dependencies = {}) {
  if (typeof dependencies.helper === 'function') return dependencies.helper(action, payload);
  const platform = dependencies.platform || process.platform;
  if (platform === 'linux') return linuxHelper(action, payload, dependencies);
  if (platform !== 'win32') {
    throw ownerError(
      'BROWSER_OWNER_PLATFORM_UNSUPPORTED',
      `Owned-browser lifecycle is not available on platform "${platform}" because no process-identity and containment implementation exists for it. No browser process was started, attached, or closed.`
    );
  }
  const script = dependencies.script || rootPath('tools', 'browser.ps1');
  const runner = dependencies.run || run;
  const timeout = Number.isSafeInteger(dependencies.helperTimeoutMs) && dependencies.helperTimeoutMs > 0
    ? dependencies.helperTimeoutMs
    : helperTimeoutMs(action);
  return withTempJson('browser-owner', payload, file => {
    let result;
    try {
      result = runner('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, action, file], { timeout });
    } catch (error) {
      // spawnSync reports a cut-off child either by throwing ETIMEDOUT or by
      // returning a killed result; both mean the same thing here and both must
      // say so by name rather than arriving as a nameless failure.
      if (error && (error.code === 'ETIMEDOUT' || error.timedOut === true)) {
        throw ownerError(
          'BROWSER_OWNER_HELPER_TIMED_OUT',
          `The owned-browser ${action} helper did not answer within ${timeout} ms and was stopped. No browser was adopted, and any record it would have written was not written.`
        );
      }
      throw error;
    }
    return parseHelperResult(result, action, timeout);
  });
}

function processStartKey(processId, dependencies = {}) {
  if (typeof dependencies.processStartKey === 'function') return dependencies.processStartKey(processId);
  const platform = dependencies.platform || process.platform;
  if (platform !== 'win32' && platform !== 'linux' && typeof dependencies.helper !== 'function') {
    throw ownerError('BROWSER_OWNER_PROCESS_IDENTITY_UNSUPPORTED', `Process start identity is not available on platform "${platform}". No PID was trusted or signaled.`);
  }
  const output = helper('process-start-key', { processId }, dependencies);
  if (!output || output.status === 'uncertain') return undefined;
  if (output.status === 'absent') return null;
  if (output.status !== 'present' || !PROCESS_START_KEY.test(String(output.processStartKey || ''))) return undefined;
  return String(output.processStartKey);
}

function readStartLock(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (!parsed || !PROCESS_ID.test(String(parsed.processId)) || !PROCESS_START_KEY.test(String(parsed.processStartKey || ''))) return null;
  return { processId: Number(parsed.processId), processStartKey: String(parsed.processStartKey) };
}

function reclaimStartLock(file, dependencies = {}) {
  const reclaimFile = `${file}.reclaim`;
  let descriptor;
  try { descriptor = fs.openSync(reclaimFile, 'wx', 0o600); }
  catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw ownerError('BROWSER_OWNER_LOCK_FAILED', 'The owned-browser start reservation could not be checked. No browser was launched.');
  }
  try {
    const lock = readStartLock(file);
    if (!lock) return false; // A malformed lock is never safe to reclaim automatically.
    const observed = processStartKey(lock.processId, dependencies);
    // The lock is live only when its exact PID *and* creation key still match.
    // A missing process or a different creation key proves that the old owner is
    // gone; PID reuse alone can never be mistaken for the live owner.
    if (observed === undefined) return false; // Access/CIM ambiguity is never absence.
    if (observed !== null && observed === lock.processStartKey) return false;
    try { fs.unlinkSync(file); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw ownerError('BROWSER_OWNER_LOCK_FAILED', 'The stale owned-browser start reservation could not be released.'); }
    return true;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* descriptor may be already closed */ }
    try { fs.unlinkSync(reclaimFile); } catch { /* best effort */ }
  }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32' ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

function inspect(record, dependencies = {}) {
  const checked = assertRecord(record);
  if (checked.state !== 'active') {
    throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'A prior owned-browser launch could not be gracefully contained. Its exact process record is retained and no browser lifecycle action will be taken automatically.');
  }
  const output = helper('inspect-owned', checked, dependencies);
  const status = String(output.status || '');
  if (status !== 'valid') {
    const code = /^[A-Z0-9_]{3,80}$/.test(String(output.code || '')) ? String(output.code) : 'REVALIDATION_FAILED';
    throw ownerError(`BROWSER_OWNER_${code}`, 'The ToolsEnabled-owned browser could not be revalidated. No browser lifecycle action was taken.');
  }
  if (Number(output.processId) !== checked.processId || String(output.processStartKey || '') !== checked.processStartKey
      || !samePath(output.executable, checked.executable) || !samePath(output.profile, checked.profile)
      || Number(output.cdpPort) !== checked.cdpPort || Number(output.cdpProcessId) !== checked.cdpProcessId
      || String(output.cdpProcessStartKey || '') !== checked.cdpProcessStartKey
      || String(output.endpoint || '') !== expectedEndpoint(checked.cdpPort)) {
    throw ownerError('BROWSER_OWNER_REVALIDATION_MISMATCH', 'The ToolsEnabled-owned browser identity changed during revalidation. No browser lifecycle action was taken.');
  }
  return { record: checked, endpoint: expectedEndpoint(checked.cdpPort) };
}

function recoveredRecord(value, pending) {
  return {
    version: OWNER_VERSION, state: value.status === 'orphan_uncertain' ? 'orphan_uncertain' : 'active',
    executable: canonicalFile(value.executable, 'browser executable'), profile: pending.profile,
    processId: Number(value.processId), processStartKey: String(value.processStartKey || ''),
    cdpProcessId: Number(value.cdpProcessId), cdpProcessStartKey: String(value.cdpProcessStartKey || ''),
    nonce: pending.nonce, generation: pending.generation, cdpPort: pending.cdpPort, createdAtMs: Date.now()
  };
}

function pendingMatchesRecord(pending, record) {
  return Boolean(pending && record && pending.nonce === record.nonce && pending.generation === record.generation
    && pending.cdpPort === record.cdpPort && samePath(pending.profile, record.profile));
}

function recoverPending(pending, dependencies = {}) {
  const found = helper('recover-owned-launch', pending, dependencies);
  if (found.status === 'absent') { removePending(dependencies); return null; }
  if (!['active', 'orphan_uncertain'].includes(String(found.status || ''))) {
    throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'A previous pending browser launch could not be uniquely recovered. No ordinary browser was adopted.');
  }
  if (typeof found.executable !== 'string' || !PROCESS_ID.test(String(found.processId)) || !PROCESS_START_KEY.test(String(found.processStartKey || '')) || !PROCESS_ID.test(String(found.cdpProcessId)) || !PROCESS_START_KEY.test(String(found.cdpProcessStartKey || ''))) {
    throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'A previous pending browser launch is ambiguous. Its pending nonce-bound record is retained and no ordinary browser was adopted.');
  }
  const record = writeRecord(recoveredRecord(found, pending), dependencies);
  removePending(dependencies);
  if (record.state !== 'active') {
    throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'A previous owned-browser launch could not be gracefully contained. Its exact process record is retained.');
  }
  return record;
}

function publicSession(session, extra = {}) {
  return {
    status: 'owned', owned: true, generation: session.record.generation,
    processId: session.record.processId, processStartKey: session.record.processStartKey,
    cdpProcessId: session.record.cdpProcessId, cdpProcessStartKey: session.record.cdpProcessStartKey,
    executable: session.record.executable, profile: session.record.profile,
    cdpEndpoint: session.endpoint, cdpPort: session.record.cdpPort, ownerState: session.record.state,
    ...extra
  };
}

function attach(dependencies = {}) {
  const record = readRecord(dependencies);
  if (!record) {
    throw ownerError('BROWSER_OWNER_REQUIRED', 'No ToolsEnabled-owned browser is running. Run browser.start through ToolsEnabled first; ordinary Chrome windows are never attached or closed automatically.');
  }
  return publicSession(inspect(record, dependencies));
}

function start(url, dependencies = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw ownerError('BROWSER_OWNER_URL_INVALID', 'Browser start requires a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:') throw ownerError('BROWSER_OWNER_URL_INVALID', 'Browser start requires an HTTPS URL.');

  const release = acquireStartLock(dependencies);
  try {
    const pending = readPending(dependencies);
    const recordBeforePending = readRecord(dependencies);
    if (pending && recordBeforePending) {
      if (!pendingMatchesRecord(pending, recordBeforePending)) {
        throw ownerError('BROWSER_OWNER_PENDING_CONFLICT', 'The pending browser launch and owner records do not describe the same exact nonce-bound browser. No browser was changed.');
      }
      let session;
      try { session = inspect(recordBeforePending, dependencies); }
      catch (error) {
        if (!error || error.code !== 'BROWSER_OWNER_PROCESS_ABSENT') throw error;
        removeRecord(dependencies);
        const recovered = recoverPending(pending, dependencies);
        if (recovered) session = inspect(recovered, dependencies);
      }
      if (session) {
        removePending(dependencies); // Only the confirmed matching launch residue.
        const opened = helper('open-owned', { ...session.record, url: parsed.href }, dependencies);
        if (opened.status !== 'opened') throw ownerError('BROWSER_OWNER_OPEN_FAILED', 'The owned browser could not open the requested HTTPS URL.');
        return publicSession(session, { reused: true, opened: true, recoveredPending: true });
      }
    } else if (pending) recoverPending(pending, dependencies);
    // Read after acquiring the exclusive reservation.  Two no-record callers
    // can therefore never both launch against the one persistent profile.
    const previous = readRecord(dependencies);
    if (previous) {
      if (previous.state === 'orphan_uncertain') {
        const probe = helper('inspect-owned', previous, dependencies);
        if (probe.status === 'invalid' && probe.code === 'PROCESS_ABSENT') removeRecord(dependencies);
        else throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'A prior owned-browser launch is uncertain. Its exact process record is retained; resolve it locally before starting another browser.');
      }
    }
    let activePrevious = readRecord(dependencies);
    if (activePrevious) {
      let session;
      try { session = inspect(activePrevious, dependencies); }
      catch (error) {
        // A confirmed missing exact PID has no process to affect, so removing
        // only the stale local record is safe.  Any PID/start-key mismatch is
        // deliberately retained and blocks a new profile launch.
        if (error && error.code === 'BROWSER_OWNER_PROCESS_ABSENT') {
          removeRecord(dependencies);
          activePrevious = null;
        } else throw error;
      }
      if (activePrevious) {
      const opened = helper('open-owned', { ...session.record, url: parsed.href }, dependencies);
      if (opened.status !== 'opened') throw ownerError('BROWSER_OWNER_OPEN_FAILED', 'The owned browser could not open the requested HTTPS URL.');
      return publicSession(session, { reused: true, opened: true });
      }
    }

    const profile = canonicalDirectory(dependencies.profile || configuredProfile(dependencies.environment));
    let nonce;
    let generation;
    let cdpPort;
    let launchPending;
    let launched;
    let launchError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Give every clean retry a new nonce/generation pair.  This keeps the
      // durable recovery fence one-to-one with a single exact Chrome launch.
      nonce = randomToken();
      generation = randomToken();
      cdpPort = randomCdpPort();
      launchPending = writePending({ version: OWNER_VERSION, state: 'launching', profile, nonce, generation, cdpPort }, dependencies);
      try { launched = helper('start-owned', { profile, nonce, generation, cdpPort, url: parsed.href }, dependencies); break; }
      catch (error) {
        launchError = error;
        if (error && error.code === 'BROWSER_CDP_PORT_IN_USE') { removePending(dependencies); continue; }
        const recovered = recoverPending(launchPending, dependencies);
        if (recovered) return publicSession(inspect(recovered, dependencies), { reused: false, opened: true, recovered: true });
        // The helper has gracefully contained the exact fresh process and
        // recovery has now proven it absent.  Retry only the known transient
        // listener race; every other launch failure remains terminal.
        if (error && RETRIABLE_CONTAINED_START_ERRORS.has(error.code) && attempt < 2) continue;
        throw error;
      }
    }
    if (!launched) throw launchError || ownerError('BROWSER_CDP_PORT_UNAVAILABLE', 'No unused loopback CDP port could be selected. No browser was launched.');
    if (launched.status === 'orphan_uncertain' &&
        (typeof launched.executable !== 'string' || !PROCESS_ID.test(String(launched.processId)) || !PROCESS_START_KEY.test(String(launched.processStartKey || '')) || !PROCESS_ID.test(String(launched.cdpProcessId)) || !PROCESS_START_KEY.test(String(launched.cdpProcessStartKey || '')))) {
      throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'The fresh nonce-bound browser launch could not be uniquely revalidated. Its pending record is retained; no ordinary browser was adopted.');
    }
    const candidate = {
      version: OWNER_VERSION,
      executable: canonicalFile(launched.executable, 'browser executable'),
      profile,
      processId: Number(launched.processId),
      processStartKey: String(launched.processStartKey || ''),
      cdpProcessId: Number(launched.cdpProcessId),
      cdpProcessStartKey: String(launched.cdpProcessStartKey || ''),
      nonce,
      generation,
      cdpPort: Number(launched.cdpPort),
      state: launched.status === 'orphan_uncertain' ? 'orphan_uncertain' : 'active',
      createdAtMs: Date.now()
    };
    const record = writeRecord(candidate, dependencies);
    removePending(dependencies);
    if (record.state === 'orphan_uncertain') {
      throw ownerError('BROWSER_OWNER_ORPHAN_UNCERTAIN', 'The just-launched owned browser could not be gracefully contained. Its exact process record was retained; no unrecorded CDP browser was left behind.');
    }
    const session = inspect(record, dependencies);
    return publicSession(session, { reused: false, opened: true });
  } finally { release(); }
}

function stop(generation, dependencies = {}) {
  const record = readRecord(dependencies);
  if (!record) throw ownerError('BROWSER_OWNER_REQUIRED', 'No ToolsEnabled-owned browser is running. Ordinary Chrome windows are never closed automatically.');
  if (typeof generation !== 'string' || generation !== record.generation) {
    throw ownerError('BROWSER_OWNER_GENERATION_MISMATCH', 'The approved browser generation is no longer current. No browser was closed.');
  }
  const session = inspect(record, dependencies);
  const output = helper('stop-owned', session.record, dependencies);
  if (!['closed', 'close_requested'].includes(String(output.status || ''))) {
    throw ownerError('BROWSER_OWNER_CLOSE_FAILED', 'The owned browser did not accept a graceful close request. No process was force-terminated.');
  }
  if (output.status === 'closed') removeRecord(dependencies);
  return {
    status: output.status, closed: output.status === 'closed', forced: false,
    generation: session.record.generation, processId: session.record.processId
  };
}

function status(dependencies = {}) {
  const launcher = helper('status', {}, dependencies);
  const base = {
    browser: launcher.browser || null,
    profile: launcher.profile || null,
    profileExists: launcher.profileExists == null ? null : launcher.profileExists === true,
    profileInUse: launcher.profileInUse == null ? null : launcher.profileInUse === true,
    profileLockPresent: launcher.profileLockPresent == null ? null : launcher.profileLockPresent === true
  };
  let pending;
  try { pending = readPending(dependencies); }
  catch (error) { return { ...base, owned: null, ownerStatus: 'pending_invalid', ownerError: error.code || 'BROWSER_OWNER_PENDING_INVALID' }; }
  let record;
  try { record = readRecord(dependencies); }
  catch (error) { return { ...base, owned: null, ownerStatus: 'invalid', ownerError: error.code || 'BROWSER_OWNER_INVALID' }; }
  if (!record && pending) {
    return { ...base, owned: null, ownerStatus: 'launching_or_uncertain', pending: true, pendingProfile: pending.profile, pendingCdpPort: pending.cdpPort };
  }
  if (!record) return { ...base, owned: false, ownerStatus: 'not_started' };
  if (pending && !pendingMatchesRecord(pending, record)) {
    return { ...base, owned: null, ownerStatus: 'pending_conflict', ownerError: 'BROWSER_OWNER_PENDING_CONFLICT' };
  }
  try {
    const session = publicSession(inspect(record, dependencies));
    return pending ? { ...base, ...session, ownerStatus: 'owned_pending_cleanup', pending: true } : { ...base, ...session };
  }
  catch (error) {
    return {
      ...base,
      owned: error && error.code === 'BROWSER_OWNER_PROCESS_ABSENT' ? false : null,
      ownerStatus: pending ? 'pending_or_invalid' : 'invalid',
      ownerError: error.code || 'BROWSER_OWNER_INVALID'
    };
  }
}

module.exports = {
  OWNER_FILE_ENV, OWNER_VERSION, TOKEN, acquireStartLock, assertPending, assertRecord, attach, canonicalDirectory, canonicalExistingDirectory, configuredProfile,
  expectedEndpoint, helper, inspect, ownerError, ownerFile, publicSession, readRecord, removeRecord,
  pendingFile, pendingMatchesRecord, processStartKey, readPending, readStartLock, reclaimStartLock, recoverPending, removePending, start, startLockFile, status, stop, writePending, writeRecord
};
