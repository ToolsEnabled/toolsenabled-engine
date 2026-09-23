'use strict';

// Test-only preload: the real CLI, claim client and HTTP stack run in a child
// process. Only runtime's vault is replaced, with a fresh file-backed fixture.
// Nothing in the product imports this file or enables this seam.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { within } = require('../lib/isolated-environment');

assert.equal(process.env.TOOLSENABLED_TEST_ISOLATED, '1');
const root = process.env.TOOLSENABLED_CLAIM_FIXTURE_ROOT;
assert.ok(root && path.isAbsolute(root));
assert.ok(within(process.env.TOOLSENABLED_TEST_ROOT, root));
assert.equal(fs.realpathSync(root), path.resolve(root));
const origin = new URL(process.env.TOOLSENABLED_ACCOUNT_ORIGIN);
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1');
assert.ok(origin.port);

const vaultPath = path.join(root, 'fixture-vault.json');
const tracePath = path.join(root, 'fixture-vault-operations.jsonl');
const DEVICE_KEY = 'custom.online_fra_device_credential_v1';
const IDENTITY_KEY = 'custom.online_fra_device_identity_v1';
const note = operation => fs.appendFileSync(tracePath, JSON.stringify(operation) + '\n');
const read = () => JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
const write = state => fs.writeFileSync(vaultPath, JSON.stringify(state) + '\n');
function validKey(key) { assert.ok(key === DEVICE_KEY || key === IDENTITY_KEY); }
const vault = {
  getSecret(key) {
    validKey(key);
    note({ operation: 'get', key });
    const state = read();
    if (Object.prototype.hasOwnProperty.call(state, key)) return state[key];
    const error = new Error('The fixture has no value for this key.');
    error.code = 'SECRET_NOT_CONFIGURED';
    throw error;
  },
  setSecret(key, value) {
    validKey(key);
    note({ operation: 'set', key });
    if (fs.existsSync(path.join(root, 'refuse-write'))) {
      const error = new Error('The isolated fixture refused the write.');
      error.code = 'FIXTURE_WRITE_REFUSED';
      throw error;
    }
    const state = read();
    state[key] = value;
    write(state);
  },
  clearDeviceCredential() {
    note({ operation: 'clear', key: DEVICE_KEY });
    const state = read();
    const present = Object.prototype.hasOwnProperty.call(state, DEVICE_KEY);
    delete state[DEVICE_KEY];
    write(state);
    return { key: DEVICE_KEY, status: present ? 'cleared' : 'absent' };
  }
};

const runtimePath = require.resolve('../../src/lib/runtime');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (Module._resolveFilename(request, parent) === runtimePath) {
    note({ operation: 'load' });
    return vault;
  }
  return originalLoad.call(this, request, parent, isMain);
};
