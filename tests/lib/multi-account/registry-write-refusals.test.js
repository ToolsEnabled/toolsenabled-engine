'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addAccount } = require('../../../src/lib/multi-account/registry-write.js');
// The registry I/O below is injected; its interprocess mutation lock is real.
// Keep that lock in a writable private fixture on either host OS.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-write-refusals-'));
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function missingRegistryFs(overrides = {}) {
  const calls = [];
  const fsImpl = {
    readFileSync(file) {
      calls.push(['readFileSync', file]);
      const error = new Error('missing fixture registry');
      error.code = 'ENOENT';
      throw error;
    },
    mkdirSync(directory, options) {
      calls.push(['mkdirSync', directory, options]);
    },
    openSync(file, flags) {
      calls.push(['openSync', file, flags]);
      return 41;
    },
    writeFileSync(descriptor, text, encoding) {
      calls.push(['writeFileSync', descriptor, text, encoding]);
    },
    fsyncSync(descriptor) {
      calls.push(['fsyncSync', descriptor]);
    },
    closeSync(descriptor) {
      calls.push(['closeSync', descriptor]);
    },
    renameSync(from, to) {
      calls.push(['renameSync', from, to]);
    },
    unlinkSync(file) {
      calls.push(['unlinkSync', file]);
      const error = new Error('missing temporary file');
      error.code = 'ENOENT';
      throw error;
    },
    ...overrides
  };
  return { calls, fsImpl };
}

function captureRefusal(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected addAccount to throw');
}

{
  const configPath = path.join(fixtureRoot, 'config', 'accounts.json');
  const homesRoot = path.join(fixtureRoot, 'homes');
  const { calls, fsImpl } = missingRegistryFs();
  fsImpl.mkdirSync = (directory, options) => {
    calls.push(['mkdirSync', directory, options]);
    const error = new Error('home parent is read-only');
    error.code = 'EACCES';
    throw error;
  };

  const error = captureRefusal(() => addAccount({
    name: 'blocked-home', configPath, homesRoot, fsImpl,
    // Synthetic pid paired with a non-default isAlive -- the compatibility
    // seam identityContext() documents in agent-digest/lock.js. Left off, the
    // default lockIsAlive (real pidAlive) sends this fake pid through exact
    // identity verification instead, which throws
    // AGENT_DIGEST_PROCESS_IDENTITY_UNVERIFIED before the refusal under test
    // is ever reached.
    randomUUID: () => 'not-used', pid: 101, lockIsAlive: () => false
  }));

  assert.equal(error.code, 'ACCOUNTS_HOME_NOT_CREATED');
  assert.equal(error.details.name, 'blocked-home');
  assert.match(error.message, /could not be created \(EACCES\), so nothing was changed/);
  assert.deepEqual(calls, [
    ['readFileSync', configPath],
    ['mkdirSync', path.join(homesRoot, 'blocked-home'), { recursive: true }]
  ]);
}

{
  const configPath = path.join(fixtureRoot, 'config', 'accounts.json');
  const homesRoot = path.join(fixtureRoot, 'homes');
  const { calls, fsImpl } = missingRegistryFs();
  fsImpl.openSync = (file, flags) => {
    calls.push(['openSync', file, flags]);
    const error = new Error('registry directory is read-only');
    error.code = 'EACCES';
    throw error;
  };

  const error = captureRefusal(() => addAccount({
    name: 'write-blocked', configPath, homesRoot, fsImpl,
    randomUUID: () => 'fixed-id', pid: 202, lockIsAlive: () => false
  }));

  assert.equal(error.code, 'ACCOUNTS_REGISTRY_WRITE_FAILED');
  assert.equal(error.details.source, configPath);
  assert.match(error.message, /could not be saved \(EACCES\), so nothing was changed/);
  assert.deepEqual(calls, [
    ['readFileSync', configPath],
    ['mkdirSync', path.join(homesRoot, 'write-blocked'), { recursive: true }],
    ['mkdirSync', path.dirname(configPath), { recursive: true }],
    ['openSync', path.join(path.dirname(configPath), '.accounts.json-202-fixed-id.tmp'), 'wx'],
    ['unlinkSync', path.join(path.dirname(configPath), '.accounts.json-202-fixed-id.tmp')]
  ]);
  assert.equal(calls.some(([operation]) => operation === 'writeFileSync'), false);
  assert.equal(calls.some(([operation]) => operation === 'renameSync'), false);
}

process.stdout.write('ok - registry writer drives home and durable-write refusals without writing registry bytes\n');
