// NOTHING FOUND
// testcanfail-tests-secret-store-js
//
// Assertion audit:
// - NOT-FOUND (empty iteration): both sentinel loops are reached only after 16
//   unconditional fixture() calls, and raceNames/raceValues have a fixed length
//   of eight. The remaining every(), some(), includes(), map(), and find()
//   assertions either assert collection membership directly or dereference the
//   selected item, which fails rather than passing when no item is selected.
// - NOT-FOUND (exit status as sole evidence): every expected failure status is
//   paired with parsed product output and an exact product error code/name. The
//   successful statuses precede assertions on parsed product output or durable
//   vault state.
// - NOT-FOUND (swallowed failure): the only try/finally restores desktop.ask and
//   does not catch a failure; the terminal catch reports it and sets exitCode=1.
// - NOT-FOUND (mock of subject): desktop.ask supplies approval input, while the
//   real dispatch and credential-removal path remain the asserted subjects.
// - NOT-FOUND (silent skip/precondition): this file has no skip or platform
//   guard. Its required platform precondition is named below and fails loudly.
// - NOT-FOUND (same-code oracle): expected operations, states, error contracts,
//   names, history, and timestamps are independently specified constants or
//   boundary inputs rather than values computed by the implementation.
//
// Mutation evidence: no suspect assertion remained after the audit, so no
// product mutation or assertion strengthening was warranted and there is no RED
// mutation output to quote. No source file was touched.
//
// Unmet precondition: powershell.exe is unavailable in this Linux environment.
// The exact restoration/baseline command `node tests/secret-store.js` therefore
// cannot reach the assertions and reports:
// "secret-store tests failed: spawnSync powershell.exe ENOENT"

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'tools', 'secrets-manager.ps1');
const DOCTOR = path.join(ROOT, 'tools', 'secret-doctor.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-secret-store-'));
const vaultPath = path.join(tempRoot, 'isolated', 'vault', 'secrets.json');
const defaultVault = path.join(ROOT, 'vault', 'secrets.json');
const sentinels = [];
const captured = [];
let checks = 0;

assert.notEqual(path.resolve(vaultPath).toLowerCase(), path.resolve(defaultVault).toLowerCase());

function fixture() {
  const value = `p3-fixture-${crypto.randomBytes(24).toString('hex')}`;
  sentinels.push(value);
  return value;
}

function environment(target = vaultPath) {
  return { ...process.env, TOOLSENABLED_VAULT_PATH: target };
}

function ps(action, args = [], input, target = vaultPath) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', MANAGER, action, ...args
  ], {
    cwd: ROOT,
    env: environment(target),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  captured.push(result.stdout || '', result.stderr || '');
  return result;
}

function payload(result, stream = 'stdout') {
  return JSON.parse(String(result[stream] || '').trim());
}

function isoAfter(base, milliseconds) {
  return new Date(new Date(base).getTime() + milliseconds).toISOString();
}

async function concurrentAdd(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', MANAGER, 'add', '-Name', name, '-Reason', `concurrent add ${name}`
    ], {
      cwd: ROOT,
      env: environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      captured.push(stdout, stderr);
      resolve({ status: code, stdout, stderr });
    });
    child.stdin.end(value);
  });
}

function checkNoLeaks() {
  const material = captured.join('\n');
  for (const sentinel of sentinels) assert.equal(material.includes(sentinel), false);
  if (fs.existsSync(vaultPath)) {
    const vault = fs.readFileSync(vaultPath, 'utf8');
    for (const sentinel of sentinels) assert.equal(vault.includes(sentinel), false);
  }
  checks += sentinels.length;
}

async function main() {
  const first = fixture();
  let result = ps('add', ['-Name', 'alpha_key', '-Reason', 'initial isolated add', '-StaleAfterDays', '1'], first);
  assert.equal(result.status, 0);
  let body = payload(result);
  assert.equal(body.operation, 'add');
  assert.equal(body.name, 'alpha_key');
  checks += 3;

  result = ps('add', ['-Name', 'alpha_key', '-Reason', 'duplicate isolated add'], fixture());
  assert.equal(result.status, 1);
  assert.equal(payload(result, 'stderr').error.code, 'SECRET_ALREADY_CONFIGURED');
  checks += 2;

  result = ps('inventory');
  assert.equal(result.status, 0);
  body = payload(result);
  let alpha = body.secrets.find(item => item.name === 'alpha_key');
  assert.equal(alpha.managed, true);
  assert.equal(alpha.state, 'ready');
  assert.equal(Object.prototype.hasOwnProperty.call(alpha, 'value'), false);
  checks += 4;

  result = ps('history', ['-Name', 'alpha_key']);
  body = payload(result);
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0].reason, 'initial isolated add');
  checks += 2;

  const replaced = fixture();
  result = ps('replace', ['-Name', 'alpha_key', '-Reason', 'replace isolated value'], replaced);
  assert.equal(result.status, 0);
  assert.equal(payload(result).operation, 'replace');
  checks += 2;

  const rotated = fixture();
  result = ps('rotate', ['-Name', 'alpha_key', '-Reason', 'rotate isolated value'], rotated);
  assert.equal(result.status, 0);
  body = payload(result);
  assert.equal(body.operation, 'rotate');
  const rotatedAt = body.at;
  checks += 2;

  result = ps('inventory', ['-AsOf', isoAfter(rotatedAt, 2 * 24 * 60 * 60 * 1000)]);
  alpha = payload(result).secrets.find(item => item.name === 'alpha_key');
  assert.equal(alpha.state, 'stale');
  assert.equal(alpha.warnings.some(item => item.code === 'SECRET_STALE'), true);
  checks += 2;

  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  result = ps('add', ['-Name', 'expiry_key', '-Reason', 'expiry isolated add', '-ExpiresAt', expiry], fixture());
  assert.equal(result.status, 0);
  const expiryCreatedAt = payload(result).at;
  result = ps('inventory', ['-AsOf', isoAfter(expiryCreatedAt, 30 * 60 * 1000), '-ExpiringWithinDays', '1']);
  let expiryItem = payload(result).secrets.find(item => item.name === 'expiry_key');
  assert.equal(expiryItem.state, 'expiring');
  result = ps('inventory', ['-AsOf', isoAfter(expiry, 1000)]);
  expiryItem = payload(result).secrets.find(item => item.name === 'expiry_key');
  assert.equal(expiryItem.state, 'expired');
  assert.equal(expiryItem.error.code, 'SECRET_EXPIRED');
  checks += 4;

  result = ps('remove', ['-Name', 'alpha_key', '-Reason', 'remove isolated value']);
  assert.equal(result.status, 0);
  assert.deepEqual(
    fs.readdirSync(path.dirname(vaultPath)).filter(name => /\.bak$/i.test(name)),
    [],
    'successful removal left a complete pre-removal vault backup'
  );
  result = ps('inventory');
  alpha = payload(result).secrets.find(item => item.name === 'alpha_key');
  assert.equal(alpha.present, false);
  assert.equal(alpha.state, 'removed');
  result = ps('history', ['-Name', 'alpha_key']);
  body = payload(result);
  assert.equal(body.history.at(-1).operation, 'remove');
  assert.equal(body.history.at(-1).reason, 'remove isolated value');
  checks += 6;

  // The product-facing path: one exact key, a bounded non-secret reason, and
  // the real one-time approval/dispatch path. Public descriptors deliberately
  // expose no handler beside executeTool().
  const ordinaryValue = fixture();
  result = ps('add', ['-Name', 'ordinary_remove_key', '-Reason', 'ordinary path setup'], ordinaryValue);
  assert.equal(result.status, 0);
  process.env.TOOLSENABLED_VAULT_PATH = vaultPath;
  const desktop = require('../src/lib/desktop');
  const { getTool, executeTool } = require('./helpers/dispatch');
  const removalTool = getTool('system.credential_remove');
  assert.ok(removalTool);
  assert.equal(removalTool.approvalEligible, true);
  assert.equal(removalTool.annotations.destructiveHint, true);
  assert.equal(typeof removalTool.handler, 'undefined');
  async function approvedRemoval(argumentsValue) {
    const originalAsk = desktop.ask;
    desktop.ask = async () => ({ answer: 'yes' });
    try {
      const grant = await executeTool('system.ask', { action: 'system.credential_remove', arguments: argumentsValue });
      return executeTool('system.credential_remove', { ...argumentsValue, approvalToken: grant.approvalToken });
    } finally {
      desktop.ask = originalAsk;
    }
  }
  const removal = await approvedRemoval({ vaultKey: 'ordinary_remove_key', reason: 'legacy_cleanup' });
  assert.equal(removal.operation, 'remove');
  assert.equal(removal.name, 'ordinary_remove_key');
  result = ps('inventory');
  const ordinary = payload(result).secrets.find(item => item.name === 'ordinary_remove_key');
  assert.equal(ordinary.present, false);
  assert.equal(ordinary.state, 'removed');
  await assert.rejects(
    approvedRemoval({ vaultKey: 'custom.online_fra_device_credential_v1', reason: 'account_changed' }),
    error => error && error.code === 'SECRET_REMOVAL_DEDICATED_PATH'
  );
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'toolsenabled.policy.json'), 'utf8'));
  assert.ok(policy.approvals.actions.includes('system.credential_remove'));
  checks += 11;

  result = ps('remove', ['-Name', 'missing_key', '-Reason', 'missing isolated remove']);
  assert.equal(result.status, 1);
  assert.equal(payload(result, 'stderr').error.code, 'SECRET_NOT_CONFIGURED');
  assert.equal(payload(result, 'stderr').error.name, 'missing_key');
  checks += 3;

  const raceNames = Array.from({ length: 8 }, (_, index) => `race_${index}`);
  const raceValues = raceNames.map(() => fixture());
  const raceResults = await Promise.all(raceNames.map((name, index) => concurrentAdd(name, raceValues[index])));
  assert.equal(raceResults.every(item => item.status === 0), true);
  result = ps('inventory');
  body = payload(result);
  assert.equal(raceNames.every(name => body.secrets.some(item => item.name === name && item.present)), true);
  checks += 2;

  const sameValues = [fixture(), fixture()];
  const sameResults = await Promise.all(sameValues.map(value => concurrentAdd('race_same', value)));
  assert.deepEqual(sameResults.map(item => item.status).sort(), [0, 1]);
  const refused = sameResults.find(item => item.status === 1);
  assert.equal(payload(refused, 'stderr').error.code, 'SECRET_ALREADY_CONFIGURED');
  checks += 2;

  const emptyRoot = path.join(tempRoot, 'empty-doctor', 'vault', 'secrets.json');
  result = spawnSync(process.execPath, [DOCTOR, '--compact'], {
    cwd: ROOT,
    env: environment(emptyRoot),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024
  });
  captured.push(result.stdout || '', result.stderr || '');
  // EXIT 0, NOT 2. src/lib/secret-store/doctor.js ("An integration nobody set
  // up is not a broken installation") stopped treating a required integration
  // with NOTHING present anywhere as a failure of this installation: `state`
  // is 'not-configured' and `ok` stays true, because an empty vault that has
  // never held Instagram credentials is not evidence this install is broken.
  // MEASURED against this exact fixture (a fresh path, nothing on disk):
  // doctor().ok === true, instagram.state === 'not-configured'. The error
  // code and names below are unaffected -- 'not-configured' is still not
  // 'ready', so blockingCode() and the blocked-name list are still computed
  // the same way; only the exit status and the state label moved.
  assert.equal(result.status, 0);
  body = payload(result);
  assert.deepEqual(body.contract.errors, []);
  const instagram = body.integrations.find(item => item.id === 'instagram');
  assert.equal(instagram.state, 'not-configured');
  assert.equal(instagram.error.code, 'SECRET_NOT_CONFIGURED');
  assert.deepEqual(instagram.error.names, ['ig_access_token', 'ig_user_id']);
  assert.equal(fs.existsSync(path.dirname(emptyRoot)), false);
  checks += 6;

  checkNoLeaks();
  process.stdout.write(`secret-store tests passed checks=${checks} fixtureCount=${sentinels.length} leakCount=0\n`);
}

main().finally(() => {
  const resolved = path.resolve(tempRoot);
  const systemTemp = path.resolve(os.tmpdir());
  if (resolved === systemTemp || !resolved.startsWith(`${systemTemp}${path.sep}`)) {
    throw new Error('Refusing unsafe secret-store test cleanup.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}).catch(error => {
  process.stderr.write(`secret-store tests failed: ${error && error.message ? error.message : 'unknown failure'}\n`);
  process.exitCode = 1;
});
