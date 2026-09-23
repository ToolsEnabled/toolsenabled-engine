'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimeStateRoot = require('../src/lib/runtime-state-root');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const scratch = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'runtime-state-root-test-'));
const originalEnvironment = {
  stateRoot: process.env.TOOLSENABLED_STATE_ROOT,
};

function restoreEnvironment() {
  if (originalEnvironment.stateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
  else process.env.TOOLSENABLED_STATE_ROOT = originalEnvironment.stateRoot;
  runtimeStateRoot.resetStateRootForTests();
}

try {
  const configuredRoot = path.join(scratch, 'configured');
  const sourceRoot = path.join(scratch, 'source');
  const configured = runtimeStateRoot.resolveStateRoot({
    environment: { TOOLSENABLED_STATE_ROOT: `  ${configuredRoot}  ` },
    programRoot: sourceRoot,
    fsImpl: { statSync() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } },
  });
  assert.deepEqual(configured, {
    root: configuredRoot,
    programRoot: sourceRoot,
    redirected: true,
    reason: 'configured',
  });
  assert.equal(Object.isFrozen(configured), true, 'resolution records are immutable');
  assert.throws(
    () => runtimeStateRoot.resolveStateRoot({ environment: { TOOLSENABLED_STATE_ROOT: 'relative/state' } }),
    /must be an absolute path/,
  );
  if (process.platform === 'win32') {
    let payloadProbeCalls = 0;
    assert.throws(
      () => runtimeStateRoot.resolveStateRoot({
        environment: { TOOLSENABLED_STATE_ROOT: 'C:\\Users\\fixture-user\\ToolsEnabled\\capability' },
        programRoot: sourceRoot,
        fsImpl: { statSync() { payloadProbeCalls += 1; throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } },
      }),
      error => error && error.code === 'ERR_STATE_ROOT_ACCOUNT_BOUNDARY',
      'a configured state root in another Windows profile must be refused by name',
    );
    assert.equal(payloadProbeCalls, 0,
      'the foreign configured path is refused lexically before even probing the program payload marker');
  }

  const checkout = runtimeStateRoot.resolveStateRoot({
    environment: {},
    programRoot: sourceRoot,
    fsImpl: { statSync() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } },
  });
  assert.deepEqual(checkout, {
    root: sourceRoot,
    programRoot: sourceRoot,
    redirected: false,
    reason: 'source-checkout',
  });

  const payloadRoot = path.join(scratch, 'payload');
  fs.mkdirSync(payloadRoot);
  fs.writeFileSync(path.join(payloadRoot, runtimeStateRoot.PAYLOAD_RECORD), '{}');
  const packaged = runtimeStateRoot.resolveStateRoot({
    environment: { XDG_STATE_HOME: path.join(scratch, 'xdg') },
    programRoot: payloadRoot,
    platform: 'linux',
    homedir: () => path.join(scratch, 'home'),
  });
  assert.equal(packaged.reason, 'packaged-payload');
  assert.equal(packaged.root, path.join(scratch, 'xdg', 'ToolsEnabled', 'capability'));
  assert.equal(runtimeStateRoot.isPackagedPayload(payloadRoot), true);
  assert.equal(runtimeStateRoot.isRuntimeStateSegment('vault'), true);
  assert.equal(runtimeStateRoot.isRuntimeStateSegment('config'), false);

  if (process.platform === 'win32') {
    const { installationProfileRoot } = require('../src/lib/agent-session-confinement');
    let ambientHomeCalls = 0;
    const ownerFallback = runtimeStateRoot.perUserStateRoot({
      environment: { APPDATA: 'C:\\Users\\fixture-user\\AppData\\Roaming' },
      platform: 'win32',
      homedir() {
        ambientHomeCalls += 1;
        return 'C:\\Users\\fixture-user';
      },
    });
    assert.equal(ownerFallback, path.join(
      installationProfileRoot(), 'AppData', 'Roaming', 'ToolsEnabled', 'capability'
    ), 'a packaged fallback is anchored to the installation owner rather than the launcher environment');
    assert.equal(ambientHomeCalls, 0, 'the Windows fallback never asks the launcher token for a home directory');
  }

  process.env.TOOLSENABLED_STATE_ROOT = configuredRoot;
  runtimeStateRoot.resetStateRootForTests();
  assert.equal(
    runtimeStateRoot.programOrStatePath(sourceRoot, ['logs/actions.jsonl']),
    path.join(configuredRoot, 'logs/actions.jsonl'),
    'a mutable directory in a one-part path is routed to the state root',
  );
  assert.equal(
    runtimeStateRoot.programOrStatePath(sourceRoot, ['config', 'actions.json']),
    path.join(sourceRoot, 'config', 'actions.json'),
    'program resources remain under the program root',
  );
  assert.equal(runtimeStateRoot.statePath('vault', 'secrets.json'), path.join(configuredRoot, 'vault', 'secrets.json'));
  assert.deepEqual(runtimeStateRoot.stateRootDiagnostic(), {
    stateRoot: configuredRoot,
    programRoot: runtimeStateRoot.PROGRAM_ROOT,
    redirected: true,
    reason: 'configured',
    adoption: { adopted: false, reason: 'source-checkout', entries: [], pending: [] },
  });
  assert.equal(fs.existsSync(path.join(configuredRoot, runtimeStateRoot.ADOPTION_RECORD)), false,
    'a configured source checkout is not inspected or recorded as a legacy installed payload');

  const hostileConfiguredRoot = path.join(scratch, 'configured-source-with-unreadable-vault');
  process.env.TOOLSENABLED_STATE_ROOT = hostileConfiguredRoot;
  runtimeStateRoot.resetStateRootForTests();
  const originalLstatSync = fs.lstatSync;
  let sourceStateInspections = 0;
  fs.lstatSync = (target, ...args) => {
    const relative = path.relative(runtimeStateRoot.PROGRAM_ROOT, path.resolve(String(target)));
    const first = relative.split(path.sep, 1)[0];
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && runtimeStateRoot.RUNTIME_STATE_DIRECTORIES.includes(first)) {
      sourceStateInspections += 1;
      throw Object.assign(new Error('source state is deliberately unreadable'), { code: 'EPERM' });
    }
    return originalLstatSync(target, ...args);
  };
  try {
    assert.deepEqual(runtimeStateRoot.stateRootDiagnostic().adoption, {
      adopted: false, reason: 'source-checkout', entries: [], pending: [],
    });
  } finally {
    fs.lstatSync = originalLstatSync;
    runtimeStateRoot.resetStateRootForTests();
  }
  assert.equal(sourceStateInspections, 0,
    'configured source state must not be lstat, canonicalized, enumerated, or copied as legacy install data');
  assert.equal(fs.existsSync(path.join(hostileConfiguredRoot, runtimeStateRoot.ADOPTION_RECORD)), false,
    'source state with an unreadable vault must not manufacture a migration record');

  if (process.platform === 'linux') {
    const previousUmask = process.umask(0o002);
    try {
      const first = path.join(scratch, 'private-under-shared-umask');
      const nested = path.join(first, 'new-parent', 'capability');
      process.env.TOOLSENABLED_STATE_ROOT = nested;
      runtimeStateRoot.resetStateRootForTests();
      assert.equal(runtimeStateRoot.stateRoot(), nested);
      for (const directory of [first, path.dirname(nested), nested]) {
        const stat = fs.statSync(directory);
        assert.equal(stat.uid, process.getuid());
        assert.equal(stat.mode & 0o777, 0o700, 'each newly created Linux directory is private despite umask0002');
      }
      const existing = path.join(scratch, 'existing-owner-selected-mode');
      fs.mkdirSync(existing, { mode: 0o775 });
      fs.chmodSync(existing, 0o775); // Disposable fixture, not product repair.
      process.env.TOOLSENABLED_STATE_ROOT = existing;
      runtimeStateRoot.resetStateRootForTests();
      assert.equal(runtimeStateRoot.stateRoot(), existing);
      assert.equal(fs.statSync(existing).mode & 0o777, 0o775,
        'state-root resolution must not silently chmod an existing owner-selected directory');
    } finally {
      process.umask(previousUmask);
      restoreEnvironment();
    }
  }

  const legacyRoot = path.join(scratch, 'legacy-payload');
  const adoptedRoot = path.join(scratch, 'adopted-state');
  fs.mkdirSync(path.join(legacyRoot, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'vault', 'secrets.json'), 'legacy-secret');
  fs.writeFileSync(path.join(legacyRoot, 'vault', 'active.lock'), 'transient');
  fs.mkdirSync(path.join(adoptedRoot, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(adoptedRoot, 'vault', 'secrets.json'), 'current-secret');

  const adoption = runtimeStateRoot.adoptLegacyPayloadState({
    stateRoot: adoptedRoot,
    programRoot: legacyRoot,
    now: () => '2026-08-27T00:00:00.000Z',
  });
  assert.deepEqual(adoption, { adopted: true, reason: 'adopted', entries: ['vault'], pending: [] });
  assert.equal(fs.readFileSync(path.join(adoptedRoot, 'vault', 'secrets.json'), 'utf8'), 'current-secret');
  assert.equal(fs.existsSync(path.join(adoptedRoot, 'vault', 'active.lock')), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(adoptedRoot, runtimeStateRoot.ADOPTION_RECORD), 'utf8')),
    {
      version: runtimeStateRoot.ADOPTION_RECORD_VERSION,
      from: legacyRoot,
      at: '2026-08-27T00:00:00.000Z',
      adopted: ['vault'],
      pending: [],
    },
  );
  assert.deepEqual(
    runtimeStateRoot.adoptLegacyPayloadState({ stateRoot: adoptedRoot, programRoot: legacyRoot }),
    { adopted: false, reason: 'already-decided', entries: [], pending: [] },
  );

  const uncertainRoot = path.join(scratch, 'uncertain-state');
  let recordReads = 0;
  const unreadableOnce = {
    ...fs,
    readFileSync(file, encoding) {
      if (file === path.join(uncertainRoot, runtimeStateRoot.ADOPTION_RECORD) && recordReads++ === 0) {
        throw Object.assign(new Error('machine busy'), { code: 'EIO' });
      }
      return fs.readFileSync(file, encoding);
    },
  };
  const couldNotTell = runtimeStateRoot.adoptLegacyPayloadState({
    stateRoot: uncertainRoot,
    programRoot: legacyRoot,
    fsImpl: unreadableOnce,
  });
  assert.deepEqual(couldNotTell, {
    reason: 'adoption-indeterminate',
    code: runtimeStateRoot.ADOPTION_INDETERMINATE,
    message: 'Could not read the adoption record; this is NOT claiming that legacy state is absent.',
    entries: [],
    pending: ['vault'],
  });
  const retried = runtimeStateRoot.adoptLegacyPayloadState({
    stateRoot: uncertainRoot,
    programRoot: legacyRoot,
    fsImpl: unreadableOnce,
  });
  assert.deepEqual(retried, { adopted: true, reason: 'adopted', entries: ['vault'], pending: [] });
  assert.deepEqual(
    runtimeStateRoot.adoptLegacyPayloadState({ stateRoot: uncertainRoot, programRoot: legacyRoot, fsImpl: unreadableOnce }),
    { adopted: false, reason: 'already-decided', entries: [], pending: [] },
    'the durable successful-adoption record remains the cache and prevents another copy',
  );
  assert.equal(recordReads, 3, 'the EIO result was retried, while the successful record was reused');

  const linkedPayload = path.join(scratch, 'linked-legacy-payload');
  const linkedOutside = path.join(scratch, 'linked-legacy-outside');
  const linkedDestination = path.join(scratch, 'linked-legacy-destination');
  fs.mkdirSync(linkedPayload, { recursive: true });
  fs.mkdirSync(linkedOutside, { recursive: true });
  fs.writeFileSync(path.join(linkedOutside, 'must-not-copy.txt'), 'outside');
  fs.symlinkSync(linkedOutside, path.join(linkedPayload, 'vault'), process.platform === 'win32' ? 'junction' : 'dir');
  let foreignTraversal = 0;
  const noForeignTraversal = {
    ...fs,
    readdirSync(candidate, options) {
      if (path.resolve(String(candidate)).startsWith(path.resolve(linkedOutside))) foreignTraversal += 1;
      return fs.readdirSync(candidate, options);
    },
    readFileSync(candidate, options) {
      if (path.resolve(String(candidate)).startsWith(path.resolve(linkedOutside))) foreignTraversal += 1;
      return fs.readFileSync(candidate, options);
    },
    copyFileSync(candidate, target, flags) {
      if (path.resolve(String(candidate)).startsWith(path.resolve(linkedOutside))) foreignTraversal += 1;
      return fs.copyFileSync(candidate, target, flags);
    },
  };
  const linkedRefusal = runtimeStateRoot.adoptLegacyPayloadState({
    stateRoot: linkedDestination,
    programRoot: linkedPayload,
    fsImpl: noForeignTraversal,
  });
  assert.equal(linkedRefusal.code, runtimeStateRoot.ADOPTION_INDETERMINATE);
  assert.deepEqual(linkedRefusal.pending, ['vault']);
  assert.equal(fs.existsSync(path.join(linkedDestination, 'vault', 'must-not-copy.txt')), false,
    'legacy adoption must inspect a top-level link itself and never traverse its target');
  assert.equal(foreignTraversal, 0, 'the foreign link target is never enumerated, read, or copied');

  console.log('runtime-state-root behaviour: ok');
} finally {
  restoreEnvironment();
  fs.rmSync(scratch, { recursive: true, force: true });
}
