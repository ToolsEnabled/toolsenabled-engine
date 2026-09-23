'use strict';

const isolated = require('../lib/isolated-environment').activate('browser-owner');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const owner = require('../../src/lib/browser-owner');

const repoRoot = path.resolve(__dirname, '..', '..');
const profile = path.join(isolated.root, 'owned-profile');
const ownerFile = path.join(isolated.root, 'state', 'browser-owner.json');
const executable = fs.realpathSync(process.execPath);
fs.mkdirSync(profile, { recursive: true });

let mode = 'valid';
let inspectSequence = null;
let launches = 0;
let closes = 0;
let opens = 0;
let profileInUse = false;
let profileLockPresent = false;
const processKeys = new Map([[process.pid, '111111111111111111']]);
const calls = [];

function helper(action, payload) {
  calls.push({ action, payload });
  if (action === 'status') {
    return { browser: executable, profile, profileExists: true, profileInUse, profileLockPresent };
  }
  if (action === 'process-start-key') {
    const startKey = processKeys.get(Number(payload.processId));
    return startKey ? { status: 'present', processStartKey: startKey } : { status: 'absent' };
  }
  if (action === 'start-owned') {
    launches += 1;
    processKeys.set(7001, '222222222222222222');
    return { executable, profile: payload.profile, processId: 7001, processStartKey: '222222222222222222', cdpProcessId: 7002, cdpProcessStartKey: '222222222222222223', cdpPort: 24567 };
  }
  if (action === 'inspect-owned') {
    const currentMode = Array.isArray(inspectSequence) && inspectSequence.length ? inspectSequence.shift() : mode;
    if (currentMode !== 'valid') return { status: 'invalid', code: currentMode };
    return {
      status: 'valid', executable, profile: payload.profile, processId: payload.processId,
      processStartKey: payload.processStartKey, cdpProcessId: payload.cdpProcessId, cdpProcessStartKey: payload.cdpProcessStartKey, cdpPort: payload.cdpPort,
      endpoint: `http://127.0.0.1:${payload.cdpPort}`
    };
  }
  if (action === 'recover-owned-launch') return { status: 'absent' };
  if (action === 'open-owned') { opens += 1; return { status: 'opened' }; }
  if (action === 'stop-owned') { closes += 1; return { status: 'closed' }; }
  throw new Error(`unexpected helper action ${action}`);
}

const dependencies = {
  ownerFile, profile, helper,
  processStartKey: pid => processKeys.get(Number(pid)) || null
};

function expectCode(fn, code) {
  let caught;
  assert.throws(fn, error => {
    caught = error;
    return error && error.code === code;
  });
  return caught;
}

function runPlatformHelperRegression() {
  if (process.platform === 'linux') {
    let runAttempts = 0;
    const status = owner.helper('status', {}, {
      platform: 'linux', profile, commandPath: () => null,
      run: () => { runAttempts += 1; }
    });
    assert.equal(status.profile, profile, 'Linux status must preserve the exact isolated profile.');
    assert.equal(status.browser, null, 'an injected empty Linux browser inventory must not invent an executable.');
    assert.equal(runAttempts, 0, 'Linux browser status must not fall through to the Windows helper runner.');
    const commandLink = path.join(isolated.root, 'google-chrome-stable');
    fs.symlinkSync(executable, commandLink);
    const linked = owner.helper('status', {}, {
      platform: 'linux', profile,
      commandPath: command => command === 'google-chrome-stable' ? commandLink : null
    });
    assert.equal(linked.browser, executable, 'a normal PATH symlink must resolve to the direct executable identity');
    fs.unlinkSync(commandLink);
    fs.symlinkSync(path.join(isolated.root, 'missing-browser'), commandLink);
    const missing = owner.helper('status', {}, { platform: 'linux', profile, commandPath: () => commandLink });
    assert.equal(missing.browser, null, 'a dangling command link must not advertise an installed browser');
    fs.unlinkSync(commandLink);
    fs.symlinkSync(profile, commandLink);
    const directory = owner.helper('status', {}, { platform: 'linux', profile, commandPath: () => commandLink });
    assert.equal(directory.browser, null, 'resolving a command link must not admit a directory as an executable');
    fs.unlinkSync(commandLink);
    assert.throws(
      () => owner.helper('status', {}, { platform: 'linux', profile, browser: path.join(isolated.root, 'unreadable-browser') }),
      error => error && error.code === 'BROWSER_OWNER_BROWSER_INVALID',
      'a browser that could not be established must not be reported as though no configured browser exists'
    );
    return;
  }
  if (process.platform !== 'win32') return;
  const script = path.join(repoRoot, 'tools', 'browser.ps1');
  const commandLineProfile = path.join(repoRoot, 'profiles', 'chrome');
  const ownerMarker = 'A'.repeat(43);
  const generationMarker = 'B'.repeat(43);
  const wrongOwnerMarker = 'C'.repeat(43);
  const wrongGenerationMarker = 'D'.repeat(43);
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const command = [
    `. ${quote(script)} -Action status | Out-Null`,
    `$profile = ${quote(commandLineProfile)}`,
    `$line = 'chrome.exe --user-data-dir="' + $profile + '" --toolsenabled-owner=${ownerMarker} --toolsenabled-generation=${generationMarker} --remote-debugging-port=45555 --remote-debugging-address=127.0.0.1'`,
    `if (-not (Test-ExactArgument $line ('--user-data-dir=' + $profile))) { exit 11 }`,
    `if (-not (Test-ExactArgument $line '--toolsenabled-owner=${ownerMarker}')) { exit 12 }`,
    `if (-not (Test-ExactArgument $line '--toolsenabled-generation=${generationMarker}')) { exit 13 }`,
    `if (Test-ExactArgument $line '--toolsenabled-owner=${wrongOwnerMarker}') { exit 14 }`,
    `if (Test-ExactArgument $line '--toolsenabled-generation=${wrongGenerationMarker}') { exit 15 }`,
    `if (Test-ExactArgument $line ('--user-data-dir=' + $profile + '-wrong')) { exit 16 }`
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, CONTROLLER_DELEGATED: '1' }
  });
  assert.equal(result.error, undefined, 'PowerShell argument matcher test must start.');
  assert.equal(result.status, 0, 'quoted profile arguments and exact marker matching must be accepted/refused correctly.');
  assert.doesNotMatch(String(result.stdout || ''), /--toolsenabled-(?:owner|generation)=/i,
    'status output must not expose opaque ownership marker flags.');
  assert.doesNotMatch(String(result.stderr || ''), /--toolsenabled-(?:owner|generation)=/i,
    'status errors must not expose opaque ownership marker flags.');
}

runPlatformHelperRegression();

let unsupportedRunAttempts = 0;
expectCode(
  () => owner.helper('status', {}, { platform: 'darwin', run: () => { unsupportedRunAttempts += 1; } }),
  'BROWSER_OWNER_PLATFORM_UNSUPPORTED'
);
assert.equal(unsupportedRunAttempts, 0, 'an unsupported browser platform must refuse before any helper spawn attempt');

// An ordinary Chrome window has no durable owner record, and is never adopted.
expectCode(() => owner.attach(dependencies), 'BROWSER_OWNER_REQUIRED');
assert.equal(calls.some(call => call.action === 'stop-owned'), false);

const started = owner.start('https://example.com/', dependencies);
assert.equal(started.owned, true);
assert.equal(started.reused, false);
assert.equal(started.cdpEndpoint, 'http://127.0.0.1:24567');
assert.equal(Object.hasOwn(started, 'nonce'), false, 'launch nonce must never be returned to an MCP caller');
assert.equal(Object.hasOwn(started, 'generation'), true);
assert.equal(launches, 1);
const stored = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
assert.match(stored.nonce, owner.TOKEN);
assert.match(stored.generation, owner.TOKEN);
assert.equal(stored.state, 'active');

// A correctly revalidated owned process is attachable, while its internal
// nonce and command-line marker spelling never cross the public boundary.
const attached = owner.attach(dependencies);
assert.equal(attached.owned, true);
assert.equal(Object.hasOwn(attached, 'nonce'), false);
assert.doesNotMatch(JSON.stringify(attached), /--toolsenabled-(?:owner|generation)=/i);
assert.equal(JSON.stringify(attached).includes(stored.nonce), false);

const reused = owner.start('https://example.org/', dependencies);
assert.equal(reused.reused, true);
assert.equal(launches, 1, 'a valid owner record must attach/open rather than launch a second profile');
assert.equal(opens, 1);

for (const mismatch of ['PROCESS_START_KEY_MISMATCH', 'EXECUTABLE_MISMATCH', 'PROFILE_MISMATCH', 'NONCE_MISMATCH', 'GENERATION_MISMATCH', 'CDP_PORT_MISMATCH', 'CDP_LISTENER_MISMATCH', 'CDP_ENDPOINT_MISMATCH']) {
  mode = mismatch;
  const before = calls.length;
  const error = expectCode(() => owner.attach(dependencies), `BROWSER_OWNER_${mismatch}`);
  assert.doesNotMatch(error.message, /--toolsenabled-(?:owner|generation)=/i,
    `${mismatch} errors must not expose command-line marker flags`);
  assert.equal(error.message.includes(stored.nonce), false, `${mismatch} errors must not expose the launch nonce`);
  assert.equal(error.message.includes(stored.generation), false, `${mismatch} errors must not expose the marker generation`);
  assert.equal(calls.slice(before).some(call => ['open-owned', 'stop-owned'].includes(call.action)), false,
    `${mismatch} must be a no-op, not a lifecycle action`);
}
mode = 'valid';

expectCode(() => owner.stop('A'.repeat(43), dependencies), 'BROWSER_OWNER_GENERATION_MISMATCH');
assert.equal(closes, 0);
const stopped = owner.stop(started.generation, dependencies);
assert.deepEqual(stopped, {
  status: 'closed', closed: true, forced: false, generation: started.generation, processId: 7001
});
assert.equal(closes, 1, 'a valid owned session may receive only a graceful close helper call');
assert.equal(fs.existsSync(ownerFile), false, 'confirmed graceful close removes only the owner record');

// A live exact lock owner blocks a second launch without starting Chrome.
const lockFile = owner.startLockFile(dependencies);
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(lockFile, JSON.stringify({ processId: process.pid, processStartKey: processKeys.get(process.pid) }));
const launchesBeforeLiveLock = launches;
expectCode(() => owner.start('https://example.net/', dependencies), 'BROWSER_OWNER_START_IN_PROGRESS');
assert.equal(launches, launchesBeforeLiveLock);
fs.unlinkSync(lockFile);

// A crash-created lock becomes recoverable only after the recorded PID+start
// identity is proven gone.  A recycled PID is not considered the old owner.
fs.writeFileSync(lockFile, JSON.stringify({ processId: 7123, processStartKey: '333333333333333333' }));
processKeys.set(7123, '444444444444444444');
const recovered = owner.start('https://example.net/', dependencies);
assert.equal(recovered.reused, false);
assert.equal(fs.existsSync(lockFile), false);
assert.equal(launches, launchesBeforeLiveLock + 1);
owner.stop(recovered.generation, dependencies);
processKeys.delete(7123);

// Probe uncertainty is not absence: retain the reservation and never launch a
// second browser just because process inspection was temporarily unavailable.
fs.writeFileSync(lockFile, JSON.stringify({ processId: 7333, processStartKey: '444444444444444444' }));
const uncertainDependencies = { ...dependencies, processStartKey: pid => Number(pid) === 7333 ? undefined : (processKeys.get(Number(pid)) || null) };
const launchesBeforeUncertainLock = launches;
expectCode(() => owner.start('https://example.net/', uncertainDependencies), 'BROWSER_OWNER_START_IN_PROGRESS');
assert.equal(launches, launchesBeforeUncertainLock);
assert.equal(fs.existsSync(lockFile), true);
fs.unlinkSync(lockFile);

// An interrupted pending-file cleanup beside a matching active record is safe
// to reconcile: it is the same nonce/generation/profile/port, gets inspected,
// and only the redundant pending file is removed.
const coexisting = owner.start('https://example.dev/', dependencies);
const coexistingRecord = owner.readRecord(dependencies);
owner.writePending({
  version: 1, state: 'launching', profile: coexistingRecord.profile, nonce: coexistingRecord.nonce,
  generation: coexistingRecord.generation, cdpPort: coexistingRecord.cdpPort
}, dependencies);
assert.equal(owner.status(dependencies).ownerStatus, 'owned_pending_cleanup');
const coexistingRecovered = owner.start('https://example.dev/again', dependencies);
assert.equal(coexistingRecovered.recoveredPending, true);
assert.equal(fs.existsSync(owner.pendingFile(dependencies)), false);
owner.stop(coexisting.generation, dependencies);

// Read-only status makes a pending/no-owner state visible and never clears it.
const pendingOnlyFile = path.join(isolated.root, 'state', 'browser-owner-pending-only.json');
const pendingOnlyDependencies = { ...dependencies, ownerFile: pendingOnlyFile };
owner.writePending({
  version: 1, state: 'launching', profile: fs.realpathSync(profile), nonce: 'F'.repeat(43),
  generation: 'G'.repeat(43), cdpPort: 24570
}, pendingOnlyDependencies);
const pendingStatus = owner.status(pendingOnlyDependencies);
assert.equal(pendingStatus.ownerStatus, 'launching_or_uncertain');
assert.equal(fs.existsSync(owner.pendingFile(pendingOnlyDependencies)), true, 'status must never auto-clear a pending launch');

// A crashed active record may be removed only when the helper proves its exact
// process is absent.  A recycled/mismatched PID remains fail-closed and blocks
// a new launch.
const staleRecord = {
  version: 1, state: 'active', executable, profile: fs.realpathSync(profile), processId: 8001,
  processStartKey: '666666666666666666', cdpProcessId: 8003, cdpProcessStartKey: '666666666666666667', nonce: 'B'.repeat(43), generation: 'C'.repeat(43), cdpPort: 24569
};
owner.writeRecord(staleRecord, dependencies);
const launchesBeforeStale = launches;
inspectSequence = ['PROCESS_ABSENT', 'valid'];
const afterCrash = owner.start('https://example.gov/', dependencies);
assert.equal(afterCrash.reused, false);
assert.equal(launches, launchesBeforeStale + 1);
owner.stop(afterCrash.generation, dependencies);

owner.writeRecord({ ...staleRecord, processId: 8002, nonce: 'D'.repeat(43), generation: 'E'.repeat(43) }, dependencies);
const launchesBeforeRecycle = launches;
mode = 'PROCESS_START_KEY_MISMATCH';
expectCode(() => owner.start('https://example.gov/', dependencies), 'BROWSER_OWNER_PROCESS_START_KEY_MISMATCH');
assert.equal(launches, launchesBeforeRecycle, 'a recycled/mismatched identity must not clear the record or relaunch');
mode = 'valid';
owner.removeRecord(dependencies);

// A launcher error cannot lose an exact fresh nonce-bearing browser: recovery
// either proves none exists and clears only the pending record, or records the
// exact recovery result before returning.
const failedLaunchFile = path.join(isolated.root, 'state', 'browser-owner-failed-launch.json');
const failedLaunchDependencies = {
  ...dependencies,
  ownerFile: failedLaunchFile,
  helper(action, payload) {
    if (action === 'start-owned') throw new Error('simulated launcher exit');
    if (action === 'recover-owned-launch') return { status: 'absent' };
    return helper(action, payload);
  }
};
assert.throws(() => owner.start('https://example.io/', failedLaunchDependencies), /simulated launcher exit/);
assert.equal(fs.existsSync(owner.pendingFile(failedLaunchDependencies)), false, 'no-process recovery removes only the pending record');

// A helper that safely closed an exact fresh launch after a transient CDP
// listener race may be retried only once recovery has proven that exact
// nonce-bound process absent.  The retry must receive a fresh launch fence.
const containedRetryFile = path.join(isolated.root, 'state', 'browser-owner-contained-retry.json');
let containedRetryStarts = 0;
let firstContainedFence;
const containedRetryDependencies = {
  ...dependencies,
  ownerFile: containedRetryFile,
  helper(action, payload) {
    if (action === 'start-owned') {
      containedRetryStarts += 1;
      if (containedRetryStarts === 1) {
        firstContainedFence = { nonce: payload.nonce, generation: payload.generation, cdpPort: payload.cdpPort };
        const error = new Error('contained listener race');
        error.code = 'BROWSER_OWNER_START_CONTAINED_CDP_LISTENER_MISMATCH';
        throw error;
      }
      assert.notEqual(payload.nonce, firstContainedFence.nonce, 'a clean retry must use a fresh nonce');
      assert.notEqual(payload.generation, firstContainedFence.generation, 'a clean retry must use a fresh generation');
    }
    if (action === 'recover-owned-launch') return { status: 'absent' };
    return helper(action, payload);
  }
};
const containedRetried = owner.start('https://example.dev/contained-retry', containedRetryDependencies);
assert.equal(containedRetryStarts, 2, 'only the safely contained listener race is retried');
assert.equal(containedRetried.owned, true);
assert.equal(fs.existsSync(owner.pendingFile(containedRetryDependencies)), false, 'the recovered absent launch fence is removed before retry');
owner.stop(containedRetried.generation, containedRetryDependencies);

// The retry budget is deliberately finite.  Repeated safely-contained races
// must not turn startup into an unbounded launch loop or retain a pending fence.
const containedLimitFile = path.join(isolated.root, 'state', 'browser-owner-contained-limit.json');
const containedFences = [];
const containedLimitDependencies = {
  ...dependencies,
  ownerFile: containedLimitFile,
  helper(action, payload) {
    if (action === 'start-owned') {
      containedFences.push(`${payload.nonce}/${payload.generation}`);
      const error = new Error('contained listener race');
      error.code = 'BROWSER_OWNER_START_CONTAINED_CDP_LISTENER_MISMATCH';
      throw error;
    }
    if (action === 'recover-owned-launch') return { status: 'absent' };
    return helper(action, payload);
  }
};
expectCode(() => owner.start('https://example.dev/contained-limit', containedLimitDependencies),
  'BROWSER_OWNER_START_CONTAINED_CDP_LISTENER_MISMATCH');
assert.equal(containedFences.length, 3, 'the launcher permits exactly two clean retries');
assert.equal(new Set(containedFences).size, 3, 'every bounded retry gets a fresh launch fence');
assert.equal(fs.existsSync(owner.pendingFile(containedLimitDependencies)), false, 'the final absent recovery removes its pending fence');
assert.equal(fs.existsSync(containedLimitFile), false, 'a failed bounded retry does not create an owner record');

// A transient/permission failure while enumerating the exact nonce-bearing
// process is never absence. Retain the pending launch fence and do not create
// a weaker owner record or attempt a second launch.
const uncertainProbeFile = path.join(isolated.root, 'state', 'browser-owner-uncertain-probe.json');
const uncertainProbeDependencies = {
  ...dependencies,
  ownerFile: uncertainProbeFile,
  helper(action, payload) {
    if (action === 'start-owned') throw new Error('simulated helper uncertainty');
    if (action === 'recover-owned-launch') return { status: 'orphan_uncertain', reason: 'PROCESS_PROBE_UNCERTAIN' };
    return helper(action, payload);
  }
};
expectCode(() => owner.start('https://example.info/', uncertainProbeDependencies), 'BROWSER_OWNER_ORPHAN_UNCERTAIN');
assert.equal(fs.existsSync(owner.pendingFile(uncertainProbeDependencies)), true, 'uncertain recovery must retain the exact pending nonce/generation');
assert.equal(fs.existsSync(uncertainProbeFile), false, 'incomplete uncertain metadata must not become an owner record');
assert.equal(owner.status(uncertainProbeDependencies).ownerStatus, 'launching_or_uncertain');

// If a just-launched exact browser cannot be gracefully contained, retain a
// durable uncertainty record rather than silently leaving an unrecorded CDP
// process.  It is not attachable or closable by subsequent callers.
const orphanFile = path.join(isolated.root, 'state', 'browser-owner-orphan.json');
const orphanDependencies = {
  ...dependencies,
  ownerFile: orphanFile,
  helper(action, payload) {
    if (action === 'start-owned') {
      return { status: 'orphan_uncertain', executable, profile: payload.profile, processId: 7999, processStartKey: '555555555555555555', cdpProcessId: 8000, cdpProcessStartKey: '555555555555555556', cdpPort: 24568 };
    }
    return helper(action, payload);
  }
};
expectCode(() => owner.start('https://example.edu/', orphanDependencies), 'BROWSER_OWNER_ORPHAN_UNCERTAIN');
assert.equal(JSON.parse(fs.readFileSync(orphanFile, 'utf8')).state, 'orphan_uncertain');
expectCode(() => owner.attach(orphanDependencies), 'BROWSER_OWNER_ORPHAN_UNCERTAIN');

// Status exposes conservative profile-lock facts for a one-time owner-approved
// transition, without changing the profile or any Chrome process.
profileInUse = true;
profileLockPresent = false;
const unlockedStatus = owner.status(dependencies);
assert.equal(unlockedStatus.profileInUse, true);
assert.equal(unlockedStatus.profileLockPresent, false);
assert.equal(unlockedStatus.owned, false);
assert.equal(unlockedStatus.ownerStatus, 'not_started');
assert.equal(Object.hasOwn(unlockedStatus, 'generation'), false);
profileLockPresent = true;
const lockedStatus = owner.status(dependencies);
assert.equal(lockedStatus.profileInUse, true);
assert.equal(lockedStatus.profileLockPresent, true);
assert.equal(lockedStatus.owned, false);
assert.equal(lockedStatus.ownerStatus, 'not_started');
assert.equal(Object.hasOwn(lockedStatus, 'generation'), false);
assert.doesNotMatch(JSON.stringify(lockedStatus), /--toolsenabled-(?:owner|generation)=/i);

console.log('Owned browser/CDP lifecycle tests passed.');

test('the tool registry reaches the owned browser lifecycle in both throughput modes', async t => {
  await t.test('registry startup leaves the browser owner unloaded', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const registry = require('./src/lib/tool-registry');
      assert.equal(typeof registry.executeTool, 'function');
      assert.equal(require.cache[require.resolve('./src/lib/browser-owner')], undefined,
        'browser-owner must remain deferred until a browser tool needs it');
    `], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
  const { executeTool } = require('../helpers/dispatch');
  const { setThroughputModeForTests } = require('../../src/lib/throughput-mode');
  const admission = require('../../src/lib/audit-admission');
  const original = { start: owner.start, status: owner.status };
  let routedDependencies;
  // Keep the registry and browser-owner implementation real. Only the
  // platform boundary uses this file's disposable process/port fixture.
  owner.start = url => original.start(url, routedDependencies);
  owner.status = () => original.status(routedDependencies);
  mode = 'valid';
  inspectSequence = null;
  profileInUse = false;
  profileLockPresent = false;
  try {
    for (const throughput of ['fast', 'strict']) {
      setThroughputModeForTests(throughput);
      routedDependencies = {
        ...dependencies,
        ownerFile: path.join(isolated.root, 'state', `browser-dispatch-${throughput}.json`)
      };
      await t.test(`browser.status reaches the owner implementation in ${throughput} mode`, async () => {
        const before = calls.length;
        const result = await executeTool('browser.status', {});
        assert.equal(result.ownerStatus, 'not_started');
        assert.equal(result.owned, false);
        assert.ok(calls.slice(before).some(call => call.action === 'status'),
          'status must reach the real browser-owner platform boundary');
      });
      await t.test(`browser.start reaches the owner implementation in ${throughput} mode`, async () => {
        const before = launches;
        const result = await executeTool('browser.start', { url: 'https://example.test/dispatch' });
        assert.equal(result.owned, true);
        assert.equal(result.account, null);
        assert.match(result.generation, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(launches, before + 1, 'dispatch must perform the fixture-owned launch once');
        const status = await executeTool('browser.status', {});
        assert.equal(status.generation, result.generation);
        assert.equal(status.owned, true);
        assert.equal(owner.readRecord(routedDependencies).generation, result.generation,
          'the dispatched result must refer to the actual durable owner record');
      });
      const record = owner.readRecord(routedDependencies);
      if (record) owner.stop(record.generation, routedDependencies);
    }
  } finally {
    Object.assign(owner, original);
    setThroughputModeForTests(null);
    admission.resetAdmissionQueueForTests();
  }
});
