'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const owner = require('../src/lib/browser-owner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-owner-refusals-'));
const profile = path.join(root, 'profile');
const executable = fs.realpathSync(process.execPath);
fs.mkdirSync(profile);

const token = character => character.repeat(43);
const payload = { profile, nonce: token('N'), generation: token('G'), cdpPort: 45678, url: 'https://example.test/' };

function expectCode(code, operation) {
  assert.throws(operation, error => error && error.code === code, `expected ${code}`);
}

function linuxStartDependencies(overrides = {}) {
  return {
    platform: 'linux', browser: executable, tmpdir: () => '/tmp',
    fs: { ...fs, readdirSync: () => [] },
    listenerProbe: () => ({ listeners: [] }),
    spawn: () => { throw new Error('spawn must not be reached'); },
    ...overrides
  };
}

try {
  let spawned = 0;
  expectCode('BROWSER_OWNER_BROWSER_NOT_FOUND', () => owner.helper('start-owned', payload, {
    platform: 'linux', commandPath: () => null,
    spawn: () => { spawned += 1; }
  }));
  assert.equal(spawned, 0, 'a missing browser must not spawn anything');

  {
    // A deep profile must now REACH spawn rather than being refused: Chrome
    // only symlinks <profile>/SingletonSocket to a short real socket under
    // TMPDIR, so profile depth alone was never the sockaddr_un constraint
    // (see shortLinuxTmpdir's own comment for the traced proof). Reusing a
    // synthetic launch failure, exactly like the BROWSER_OWNER_LAUNCH_FAILED
    // case below, to prove this deep path is accepted through to spawn().
    const realRoot = fs.realpathSync(root);
    let deepProfile = path.join(realRoot, 'deep');
    while (Buffer.byteLength(path.join(deepProfile, 'SingletonSocket'), 'utf8') < 108) {
      deepProfile = path.join(deepProfile, 'x'.repeat(20));
    }
    fs.mkdirSync(deepProfile, { recursive: true });
    let deepSpawned = 0;
    expectCode('BROWSER_OWNER_LAUNCH_FAILED', () => owner.helper('start-owned', { ...payload, profile: deepProfile }, linuxStartDependencies({
      spawn: () => { deepSpawned += 1; throw new Error('synthetic launch failure'); }
    })));
    assert.equal(deepSpawned, 1, 'a deep profile path must reach spawn, not be refused at the profile check');
  }

  {
    // shortLinuxTmpdir prefers a verified /run/user/<uid>: private to this
    // exact account, mode 0700, never a symlink -- the same trust shape
    // owner-host-linux.js already requires of its own socket directory.
    let capturedEnv = null;
    expectCode('BROWSER_OWNER_LAUNCH_FAILED', () => owner.helper('start-owned', payload, linuxStartDependencies({
      getuid: () => 918273,
      fs: {
        ...fs, readdirSync: () => [],
        lstatSync: target => {
          if (target === '/run/user/918273') return { isDirectory: () => true, isSymbolicLink: () => false, uid: 918273, mode: 0o40700 };
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      },
      spawn: (_executable, _args, options) => { capturedEnv = options.env; throw new Error('synthetic launch failure'); }
    })));
    assert.equal(capturedEnv.TMPDIR, '/run/user/918273', 'a trusted /run/user/<uid> must be used as the spawned browser TMPDIR');
  }

  {
    // An untrusted /run/user/<uid> -- wrong owning uid here, a stand-in for
    // any of the trust checks failing -- must not be used, and must fall
    // through to a short ambient temp directory instead. Ownership/
    // permission trust is exactly what must never be weakened by this fix.
    let capturedEnv = null;
    expectCode('BROWSER_OWNER_LAUNCH_FAILED', () => owner.helper('start-owned', payload, linuxStartDependencies({
      getuid: () => 918274,
      fs: {
        ...fs, readdirSync: () => [],
        lstatSync: target => {
          if (target === '/run/user/918274') return { isDirectory: () => true, isSymbolicLink: () => false, uid: 1, mode: 0o40700 };
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      },
      tmpdir: () => '/tmp',
      spawn: (_executable, _args, options) => { capturedEnv = options.env; throw new Error('synthetic launch failure'); }
    })));
    assert.equal(capturedEnv.TMPDIR, '/tmp', 'an untrusted /run/user/<uid> (wrong owner) must not be used; short ambient tmpdir instead');
  }

  {
    // Nothing short is available anywhere: refuse, rather than let Chrome
    // hit the same native failure this fix exists to prevent. This is the
    // one case a refusal is still the right answer, per the corrected
    // premise: the operation genuinely cannot be made to work.
    let noTmpdirSpawned = 0;
    expectCode('BROWSER_OWNER_NO_SHORT_TMPDIR', () => owner.helper('start-owned', payload, linuxStartDependencies({
      getuid: () => 918275,
      fs: {
        ...fs, readdirSync: () => [],
        lstatSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      },
      tmpdir: () => `/very/deep/ambient/ci/scratch/root/${'x'.repeat(60)}`,
      spawn: () => { noTmpdirSpawned += 1; }
    })));
    assert.equal(noTmpdirSpawned, 0, 'refusing for a genuinely too-deep TMPDIR must not spawn anything');
  }

  for (const [code, listenerProbe] of [
    ['BROWSER_CDP_PORT_UNCERTAIN', () => { throw new Error('probe unavailable'); }],
    ['BROWSER_CDP_PORT_IN_USE', () => ({ listeners: [{ localAddress: '127.0.0.1', pid: 99 }] })]
  ]) {
    spawned = 0;
    expectCode(code, () => owner.helper('start-owned', payload, linuxStartDependencies({
      listenerProbe,
      spawn: () => { spawned += 1; }
    })));
    assert.equal(spawned, 0, `${code} must refuse before spawning`);
  }

  spawned = 0;
  expectCode('BROWSER_OWNER_LAUNCH_FAILED', () => owner.helper('start-owned', payload, linuxStartDependencies({
    spawn: () => { spawned += 1; throw new Error('synthetic launch failure'); }
  })));
  assert.equal(spawned, 1, 'launch failure must make exactly one spawn attempt');

  expectCode('BROWSER_OWNER_ACTION_UNSUPPORTED', () => owner.helper('not-an-action', {}, {
    platform: 'linux'
  }));

  for (const [code, result] of [
    ['BROWSER_OWNER_HELPER_FAILED', { status: 1, stdout: '', stderr: 'generic failure' }],
    ['BROWSER_OWNER_HELPER_INVALID', { status: 0, stdout: 'not JSON', stderr: '' }]
  ]) {
    let runs = 0;
    expectCode(code, () => owner.helper('status', {}, {
      platform: 'win32', run: () => { runs += 1; return result; }
    }));
    assert.equal(runs, 1, `${code} must arise from the injected helper result`);
  }

  const lockFile = path.join(root, 'lock-owner.json');
  expectCode('BROWSER_OWNER_LOCK_FAILED', () => owner.acquireStartLock({
    ownerFile: lockFile, processStartKey: () => undefined
  }));
  assert.equal(fs.existsSync(`${lockFile}.start.lock`), false, 'identity refusal must not write a lock');

  const release = owner.acquireStartLock({ ownerFile: lockFile, processStartKey: () => '12345' });
  const originalUnlink = fs.unlinkSync;
  try {
    fs.unlinkSync = file => {
      if (file === `${lockFile}.start.lock`) throw Object.assign(new Error('synthetic unlink refusal'), { code: 'EACCES' });
      return originalUnlink(file);
    };
    expectCode('BROWSER_OWNER_LOCK_RELEASE_FAILED', release);
  } finally {
    fs.unlinkSync = originalUnlink;
    originalUnlink(`${lockFile}.start.lock`);
  }

  const ownerFile = path.join(root, 'session-owner.json');
  const record = owner.writeRecord({
    version: 1, executable, profile, processId: 7001, processStartKey: '111',
    cdpProcessId: 7002, cdpProcessStartKey: '112', nonce: token('A'),
    generation: token('B'), cdpPort: 45679, state: 'active', createdAtMs: 1
  }, { ownerFile });
  let mutationCalls = 0;
  const sessionHelper = (action, value) => {
    if (action === 'inspect-owned') return {
      status: 'valid', executable, profile, processId: value.processId,
      processStartKey: value.processStartKey, cdpProcessId: value.cdpProcessId,
      cdpProcessStartKey: value.cdpProcessStartKey, cdpPort: value.cdpPort,
      endpoint: owner.expectedEndpoint(value.cdpPort)
    };
    mutationCalls += 1;
    return { status: action === 'open-owned' ? 'open_failed' : 'close_refused' };
  };
  expectCode('BROWSER_OWNER_OPEN_FAILED', () => owner.start('https://example.test/', {
    ownerFile, profile, helper: sessionHelper, processStartKey: () => '999'
  }));
  assert.equal(mutationCalls, 1, 'open refusal must make one open request and no launch request');
  assert.deepEqual(owner.readRecord({ ownerFile }), record, 'open refusal must retain the owner record');

  mutationCalls = 0;
  expectCode('BROWSER_OWNER_CLOSE_FAILED', () => owner.stop(record.generation, {
    ownerFile, helper: sessionHelper
  }));
  assert.equal(mutationCalls, 1, 'close refusal must make one graceful request and no force-kill request');
  assert.deepEqual(owner.readRecord({ ownerFile }), record, 'close refusal must retain the owner record');

  const invalidStatus = owner.status({
    ownerFile,
    helper: action => {
      if (action === 'status') return {};
      throw new Error('uncoded inspection failure');
    }
  });
  assert.equal(invalidStatus.ownerError, 'BROWSER_OWNER_INVALID');
  assert.equal(invalidStatus.owned, null);

  const originalPayloadUnlink = fs.unlinkSync;
  try {
    fs.unlinkSync = file => {
      if (path.basename(file).startsWith('toolsenabled-browser-owner-')) {
        throw Object.assign(new Error('synthetic payload removal refusal'), { code: 'EACCES' });
      }
      return originalPayloadUnlink(file);
    };
    expectCode('BROWSER_OWNER_HELPER_PAYLOAD_REMOVE_FAILED', () => owner.helper('status', {}, {
      platform: 'win32', run: () => ({ status: 0, stdout: '{}' })
    }));
  } finally {
    fs.unlinkSync = originalPayloadUnlink;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('browser-owner driven refusal tests passed');
