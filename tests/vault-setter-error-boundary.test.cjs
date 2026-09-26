'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const runtimePath = process.env.T999_RUNTIME_SOURCE || path.resolve(__dirname, '../src/lib/runtime.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');

// Only source bytes are read. Both platform branches and the subprocess/storage
// boundaries below are synthetic; no credential store or native helper is used.
function loadRuntime(thrown) {
  const observations = { childCalls: 0, storageCalls: 0, platformChecks: 0 };
  const deniedStorage = new Proxy({}, {
    get() { observations.storageCalls += 1; throw new Error('Unexpected storage access in isolated test'); }
  });
  const exports = {};
  const module = { exports };
  const dependencies = {
    'node:crypto': require('node:crypto'),
    'node:util': require('node:util'),
    'node:fs': deniedStorage,
    'node:path': require('node:path'),
    'node:async_hooks': require('node:async_hooks'),
    'node:child_process': {
      execFileSync() { observations.childCalls += 1; throw thrown; },
      spawnSync() { throw new Error('Unexpected process path in isolated test'); }
    },
    './vault-platform': {
      assertVaultPlatform() { observations.platformChecks += 1; },
      assertWindowsVaultPlatform() { observations.platformChecks += 1; },
      vaultPlatformRefusal() { throw new Error('Unexpected platform refusal path'); },
      VAULT_PLATFORM_UNSUPPORTED: 'SYNTHETIC_PLATFORM_UNSUPPORTED'
    },
    './credential-metadata': { credentialDefinitionForKey() { return null; } },
    './runtime-state-root': {
      programOrStatePath(root, parts) { return path.join(root, ...parts); },
      statePath(...parts) { return path.join(...parts); }
    },
    './providers/subscription-launch-env.js': { safeLaunchEnvironment() { return {}; } }
  };
  function scopedRequire(id) {
    if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
    throw new Error('Unexpected dependency in isolated runtime test: ' + id);
  }
  const context = vm.createContext({
    Buffer, URL, console,
    process: { platform: 'win32', env: {}, pid: 1, execPath: process.execPath }
  });
  const run = new vm.Script('(function(exports, require, module, __filename, __dirname) {\n' + runtimeSource + '\n})', { filename: runtimePath }).runInContext(context);
  run(exports, scopedRequire, module, runtimePath, path.dirname(runtimePath));
  return { runtime: module.exports, observations };
}

const operations = [
  ['single', runtime => runtime.setSecret('fixture_a', 'inert-value-a')],
  ['pair', runtime => runtime.setSecretPair('fixture_a', 'inert-value-a', 'fixture_b', 'inert-value-b')],
  ['triple', runtime => runtime.setSecretTriple('fixture_a', 'inert-value-a', 'fixture_b', 'inert-value-b', 'fixture_c', 'inert-value-c')]
];

function failureFrom(operation, thrown) {
  const { runtime, observations } = loadRuntime(thrown);
  let caught;
  try { operation(runtime); } catch (error) { caught = error; }
  assert.equal(observations.childCalls, 1, 'the public setter must reach the stubbed subprocess exactly once');
  assert.equal(observations.storageCalls, 0, 'the test must never access protected storage');
  assert.equal(observations.platformChecks, 1);
  assert.equal(typeof caught?.message, 'string', 'the caller receives a contained Error message');
  assert.match(caught.message, /^Unable to store refreshed /, 'the setter must retain its operation refusal');
  return caught.message;
}

for (const [name, operation] of operations) {
  for (const primitive of ['INERT_PRIMITIVE_MARKER', 17, true, null, undefined]) {
    test(name + ': contains a thrown ' + (primitive === null ? 'null' : typeof primitive), () => {
      const message = failureFrom(operation, primitive);
      assert.equal(message.endsWith(': ' + String(primitive)), false, 'raw thrown values are not a diagnostic');
      if (typeof primitive === 'string') assert.equal(message.includes(primitive), false);
    });
  }

  test(name + ': contains a thrown Buffer without relaying its bytes', () => {
    const message = failureFrom(operation, Buffer.from('INERT_BUFFER_MARKER'));
    assert.equal(message.includes('INERT_BUFFER_MARKER'), false);
  });

  test(name + ': does not coerce an arbitrary thrown object', () => {
    let coercions = 0;
    const thrown = { toString() { coercions += 1; throw new Error('INERT_COERCION_MARKER'); } };
    const message = failureFrom(operation, thrown);
    assert.equal(coercions, 0);
    assert.equal(message.includes('INERT_COERCION_MARKER'), false);
  });

  test(name + ': contains a throwing message getter and retains safe stderr', () => {
    let reads = 0;
    const thrown = {
      get message() { reads += 1; throw new Error('INERT_GETTER_MARKER'); },
      stderr: 'helper lock unavailable'
    };
    const message = failureFrom(operation, thrown);
    assert.ok(reads <= 1);
    assert.equal(message.includes('INERT_GETTER_MARKER'), false);
    assert.ok(message.includes('helper lock unavailable'));
  });

  test(name + ': does not reread a changing message getter', () => {
    let reads = 0;
    const thrown = { get message() { reads += 1; return reads === 1 ? 'helper lock unavailable' : 'INERT_SECOND_READ_MARKER'; } };
    const message = failureFrom(operation, thrown);
    assert.ok(reads <= 1);
    assert.equal(message.includes('INERT_SECOND_READ_MARKER'), false);
  });

  test(name + ': contains a throwing stderr getter and retains safe message', () => {
    let reads = 0;
    const thrown = {
      message: 'helper lock unavailable',
      get stderr() { reads += 1; throw new Error('INERT_STDERR_GETTER_MARKER'); }
    };
    const message = failureFrom(operation, thrown);
    assert.ok(reads <= 1);
    assert.equal(message.includes('INERT_STDERR_GETTER_MARKER'), false);
    assert.ok(message.includes('helper lock unavailable'));
  });

  test(name + ': does not coerce a message object or a stderr object', () => {
    let coercions = 0;
    const opaque = { toString() { coercions += 1; return 'INERT_OPAQUE_MARKER'; } };
    const message = failureFrom(operation, { message: opaque, stderr: opaque });
    assert.equal(coercions, 0);
    assert.equal(message.includes('INERT_OPAQUE_MARKER'), false);
  });

  test(name + ': Buffer diagnostic conversion ignores a supplied toString method', () => {
    let coercions = 0;
    const detail = Buffer.from('helper lock unavailable');
    detail.toString = () => { coercions += 1; return 'INERT_BUFFER_COERCION_MARKER'; };
    detail.valueOf = detail.toString;
    detail.utf8Slice = detail.toString;
    const message = failureFrom(operation, { message: 'helper failed', stderr: detail });
    assert.equal(coercions, 0);
    assert.equal(message.includes('INERT_BUFFER_COERCION_MARKER'), false);
    assert.ok(message.includes('helper lock unavailable'));
  });

  test(name + ': preserves a safe Error and distinct string diagnostic', () => {
    const thrown = new Error('helper failed');
    thrown.stderr = 'helper lock unavailable';
    const message = failureFrom(operation, thrown);
    assert.ok(message.includes('helper failed'));
    assert.ok(message.includes('helper lock unavailable'));
  });

  test(name + ': does not duplicate a diagnostic already in the Error message', () => {
    const thrown = new Error('helper failed: helper lock unavailable');
    thrown.stderr = Buffer.from('helper lock unavailable');
    const message = failureFrom(operation, thrown);
    assert.equal(message.split('helper lock unavailable').length - 1, 1);
  });

  test(name + ': never reads stdout', () => {
    let reads = 0;
    const thrown = {
      message: 'helper failed',
      get stdout() { reads += 1; throw new Error('INERT_STDOUT_MARKER'); }
    };
    const message = failureFrom(operation, thrown);
    assert.equal(reads, 0);
    assert.equal(message.includes('INERT_STDOUT_MARKER'), false);
    assert.ok(message.includes('helper failed'));
  });
}
