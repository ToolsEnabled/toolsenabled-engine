'use strict';

// 1.0.50 review L1: THE NEW SERVICE-ACCOUNT KEY IS NOT LEFT IN A SHARED TEMP
// DIRECTORY WHILE THE VAULT IS WRITTEN.
//
// gcloud.service_account_key_to_vault has gcloud write the private key to a
// file, then stores it in the vault. Before this fix that file sat in a fresh
// os.tmpdir() directory for the whole vault write (helper spawn plus up to 30 s
// of lock wait), and a crash left it behind with nothing that ever swept it.
// This drives the real provider with gcloud, the vault and policy replaced, and
// checks where the key file was made, that it is gone before the vault write
// starts, and that crash leftovers are swept.
//
// NO KEY MATERIAL APPEARS HERE: the "key" is a synthetic JSON canary.

require('./lib/isolated-environment').activate('gcp-key-staging-private');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtime = require('../src/lib/runtime');
const policy = require('../src/lib/policy');
const audit = require('../src/lib/audit');
const { statePath } = require('../src/lib/runtime-state-root');

const CANARY = JSON.stringify({ type: 'service_account', private_key: 'synthetic-canary-not-a-key' });
const calls = [];
let gcloudFails = false;

/* Replaced BEFORE the provider is loaded: it destructures these at require time. */
runtime.commandExists = () => true;
runtime.run = (command, args, options) => {
  const keyFile = args[4];
  const staging = path.dirname(keyFile);
  const mode = process.platform === 'win32' ? null : fs.statSync(staging).mode & 0o777;
  calls.push({ kind: 'run', command, args: [...args], keyFile, stagingMode: mode, timeout: options && options.timeout });
  if (gcloudFails) return { command: 'gcloud keys create', status: 1, stdout: '', stderr: 'synthetic gcloud failure' };
  fs.writeFileSync(keyFile, CANARY, { mode: 0o600 });
  return { command: 'gcloud keys create', status: 0, stdout: '', stderr: '' };
};
runtime.setSecret = (key, value) => {
  const keyFile = calls.filter(call => call.kind === 'run').at(-1).keyFile;
  calls.push({ kind: 'setSecret', key, value, keyFileStillOnDisk: fs.existsSync(keyFile) });
};
policy.assertActive = () => {};
audit.record = () => {};

const infrastructure = require('../src/lib/providers/infrastructure');

const ARGS = Object.freeze({ projectId: 'synthetic-project', serviceAccountId: 'synthetic-account' });
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

test('the key file is made under the private state root and is gone before the vault write', () => {
  calls.length = 0;
  gcloudFails = false;
  const answer = infrastructure.gcloudServiceAccountKeyToVault(ARGS);
  assert.equal(answer.stored, true);
  assert.equal(JSON.stringify(answer).includes('synthetic-canary'), false, 'the key must never be returned');

  const run = calls.find(call => call.kind === 'run');
  const store = calls.find(call => call.kind === 'setSecret');
  assert.ok(run && store, 'gcloud ran and the vault was written');
  assert.equal(store.value, CANARY, 'the vault received exactly what gcloud wrote');
  assert.ok(within(statePath('state'), run.keyFile),
    `the key file must be made under the private state root, not ${run.keyFile}`);
  assert.equal(within(os.tmpdir(), run.keyFile) && !within(statePath(), run.keyFile), false,
    'the key file must not be made in the shared temp directory');
  if (run.stagingMode !== null) assert.equal(run.stagingMode, 0o700, 'the staging directory is private to this user');
  assert.equal(store.keyFileStillOnDisk, false,
    'the key file must be removed before the vault write starts, not after it');
  assert.equal(fs.existsSync(path.dirname(run.keyFile)), false, 'no staging directory is left behind');
});

test('a failed gcloud call leaves no staging directory and writes nothing', () => {
  calls.length = 0;
  gcloudFails = true;
  assert.throws(() => infrastructure.gcloudServiceAccountKeyToVault(ARGS), /synthetic gcloud failure/);
  const run = calls.find(call => call.kind === 'run');
  assert.equal(calls.some(call => call.kind === 'setSecret'), false);
  assert.equal(fs.existsSync(path.dirname(run.keyFile)), false);
});

test('leftovers a crash left behind are swept; a call still in progress elsewhere is not', () => {
  calls.length = 0;
  gcloudFails = false;
  const parent = statePath('state', 'gcp-key-staging');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stale = fs.mkdtempSync(path.join(parent, 'gcp-key-'));
  fs.writeFileSync(path.join(stale, 'key.json'), CANARY);
  fs.utimesSync(stale, longAgo, longAgo);
  const inProgress = fs.mkdtempSync(path.join(parent, 'gcp-key-'));
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-gcp-key-'));
  fs.writeFileSync(path.join(legacy, 'key.json'), CANARY);
  fs.utimesSync(legacy, longAgo, longAgo);
  const unrelated = fs.mkdtempSync(path.join(parent, 'other-'));
  fs.utimesSync(unrelated, longAgo, longAgo);
  try {
    infrastructure.gcloudServiceAccountKeyToVault(ARGS);
    assert.equal(fs.existsSync(stale), false, 'a stale staging directory under the state root is swept');
    assert.equal(fs.existsSync(legacy), false, 'a stale staging directory at the old temp location is swept');
    assert.equal(fs.existsSync(inProgress), true, 'a fresh staging directory may belong to a call in another process');
    assert.equal(fs.existsSync(unrelated), true, 'only staging directories are swept');
  } finally {
    for (const directory of [stale, inProgress, legacy, unrelated]) fs.rmSync(directory, { recursive: true, force: true });
  }
});
