'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const writer = require('../src/lib/coordinator/backup-test-writer.js');

let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixtureArtifacts() {
  return [
    { name: 'repo.bundle', bytes: Buffer.from('bundle fixture') },
    { name: 'vault-state.enc', bytes: Buffer.from('encrypted fixture') }
  ];
}

function input(store, overrides = {}) {
  return {
    store,
    snapshotName: 'snapshot-20260721T010203Z',
    artifacts: fixtureArtifacts(),
    ...overrides
  };
}

function withZeroHostWrites(fn) {
  const names = [
    'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
    'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rename', 'renameSync',
    'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'writeFile', 'writeFileSync'
  ];
  const originals = new Map();
  const calls = [];
  for (const name of names) {
    originals.set(name, fs[name]);
    fs[name] = (...args) => {
      calls.push([name, args.length]);
      throw new Error(`unexpected host write through ${name}`);
    };
  }
  try {
    fn();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
  assert.deepEqual(calls, []);
}

function assertInputRefused(store, request) {
  let result;
  assert.doesNotThrow(() => { result = writer.writeTestOnlyBackup(request); });
  assert.equal(result.status, 'not-committed');
  assert.equal(result.code, 'Q37_TEST_ONLY_INPUT_REFUSED');
  assert.equal(result.productionActivation, 'disabled');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName: 'snapshot-20260721T010203Z' }).status, 'unavailable');
}

function run() {
  process.stdout.write('coordinator-backup-test-writer-adversarial\n');

  check('legacy reparse-shaped requests cause zero host writes rather than path handling', () => {
    const store = writer.createTestOnlyStore();
    withZeroHostWrites(() => {
      const result = writer.writeTestOnlyBackup({
        ...input(store),
        backupRoot: 'C:\\untrusted\\backup-root',
        fsImpl: fs,
        stageToken: 'not accepted'
      });
      assert.equal(result.status, 'not-committed');
      assert.equal(result.code, 'Q37_TEST_ONLY_INPUT_REFUSED');
    });
  });

  check('does not touch top-level or nested Proxy traps and refuses them without committing', () => {
    const topStore = writer.createTestOnlyStore();
    let topTraps = 0;
    const topLevel = new Proxy(input(topStore), {
      ownKeys() { topTraps += 1; throw new Error('ownKeys must not run'); },
      get() { topTraps += 1; throw new Error('get must not run'); }
    });
    withZeroHostWrites(() => assertInputRefused(topStore, topLevel));
    assert.equal(topTraps, 0);

    const nestedStore = writer.createTestOnlyStore();
    let nestedTraps = 0;
    const hostileArtifact = new Proxy({ name: 'repo.bundle', bytes: Buffer.from('x') }, {
      ownKeys() { nestedTraps += 1; throw new Error('nested ownKeys must not run'); },
      get() { nestedTraps += 1; throw new Error('nested get must not run'); }
    });
    withZeroHostWrites(() => assertInputRefused(nestedStore, input(nestedStore, { artifacts: [hostileArtifact, fixtureArtifacts()[1]] })));
    assert.equal(nestedTraps, 0);
  });

  check('closes arrays and data descriptors once, refusing stateful Proxy, sparse, symbol, accessor, and prototype input', () => {
    const statefulStore = writer.createTestOnlyStore();
    let statefulTraps = 0;
    const statefulArray = new Proxy(fixtureArtifacts(), {
      ownKeys() { statefulTraps += 1; return ['0', '1', 'length']; },
      getOwnPropertyDescriptor() { statefulTraps += 1; return undefined; }
    });
    withZeroHostWrites(() => assertInputRefused(statefulStore, input(statefulStore, { artifacts: statefulArray })));
    assert.equal(statefulTraps, 0);

    const sparseStore = writer.createTestOnlyStore();
    const sparse = [];
    sparse.length = 2;
    sparse[0] = fixtureArtifacts()[0];
    withZeroHostWrites(() => assertInputRefused(sparseStore, input(sparseStore, { artifacts: sparse })));

    const symbolStore = writer.createTestOnlyStore();
    const symbolRequest = input(symbolStore);
    symbolRequest[Symbol('extra')] = true;
    withZeroHostWrites(() => assertInputRefused(symbolStore, symbolRequest));

    const accessorStore = writer.createTestOnlyStore();
    let getterReads = 0;
    const accessorRequest = { store: accessorStore, artifacts: fixtureArtifacts() };
    Object.defineProperty(accessorRequest, 'snapshotName', {
      enumerable: true,
      get() { getterReads += 1; return 'snapshot-20260721T010203Z'; }
    });
    withZeroHostWrites(() => assertInputRefused(accessorStore, accessorRequest));
    assert.equal(getterReads, 0);

    const prototypeStore = writer.createTestOnlyStore();
    const prototypeRequest = Object.create({ inherited: true });
    Object.assign(prototypeRequest, input(prototypeStore));
    withZeroHostWrites(() => assertInputRefused(prototypeStore, prototypeRequest));
  });

  check('refuses Buffer-like or proxied byte values, and hostile verification input stays unavailable', () => {
    const fakeStore = writer.createTestOnlyStore();
    const fake = { byteLength: 3, 0: 1, 1: 2, 2: 3 };
    withZeroHostWrites(() => assertInputRefused(fakeStore, input(fakeStore, {
      artifacts: [{ name: 'repo.bundle', bytes: fake }, fixtureArtifacts()[1]]
    })));

    const proxyBytesStore = writer.createTestOnlyStore();
    const proxyBytes = new Proxy(Buffer.from('bytes'), {
      get() { throw new Error('byte getter must not run'); }
    });
    withZeroHostWrites(() => assertInputRefused(proxyBytesStore, input(proxyBytesStore, {
      artifacts: [{ name: 'repo.bundle', bytes: proxyBytes }, fixtureArtifacts()[1]]
    })));

    const verifyStore = writer.createTestOnlyStore();
    assert.equal(writer.writeTestOnlyBackup(input(verifyStore)).status, 'committed');
    let verifyTraps = 0;
    const hostileVerify = new Proxy({ store: verifyStore, snapshotName: 'snapshot-20260721T010203Z' }, {
      ownKeys() { verifyTraps += 1; throw new Error('verify ownKeys must not run'); }
    });
    let verification;
    withZeroHostWrites(() => assert.doesNotThrow(() => { verification = writer.verifyTestOnlyRestoreContract(hostileVerify); }));
    assert.equal(verification.status, 'unavailable');
    assert.equal(verifyTraps, 0);
  });

  check('successful in-memory writes also perform zero host writes', () => {
    const store = writer.createTestOnlyStore();
    withZeroHostWrites(() => {
      assert.equal(writer.writeTestOnlyBackup(input(store)).status, 'committed');
      assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName: 'snapshot-20260721T010203Z' }).status, 'verified');
    });
  });

  check('reports transient inspection failures as indeterminate without discarding cached records', () => {
    const store = writer.createTestOnlyStore();
    assert.equal(writer.writeTestOnlyBackup(input(store)).status, 'committed');

    const originalOwnKeys = Reflect.ownKeys;
    try {
      Reflect.ownKeys = () => { const error = new Error('machine busy'); error.code = 'EIO'; throw error; };
      const write = writer.writeTestOnlyBackup(input(store, { snapshotName: 'snapshot-20260722T010203Z' }));
      assert.equal(write.status, 'indeterminate');
      assert.equal(write.code, 'Q37_TEST_ONLY_COULD_NOT_TELL');
      assert.match(write.message, /not claiming.*absent/i);

      Reflect.ownKeys = () => { const error = new Error('inspection timed out'); error.code = 'ETIMEDOUT'; throw error; };
      const verification = writer.verifyTestOnlyRestoreContract({ store, snapshotName: 'snapshot-20260721T010203Z' });
      assert.equal(verification.status, 'indeterminate');
      assert.equal(verification.code, 'Q37_TEST_ONLY_COULD_NOT_TELL');
      assert.match(verification.message, /not claiming.*absent/i);
    } finally {
      Reflect.ownKeys = originalOwnKeys;
    }

    // Control: the successful record remains cached, and the failed attempt was not latched.
    assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName: 'snapshot-20260721T010203Z' }).status, 'verified');
    assert.equal(writer.writeTestOnlyBackup(input(store, { snapshotName: 'snapshot-20260722T010203Z' })).status, 'committed');
  });

  process.stdout.write(`\ncoordinator-backup-test-writer-adversarial: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}
