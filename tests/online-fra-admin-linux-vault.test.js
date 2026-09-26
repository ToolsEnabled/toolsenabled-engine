'use strict';
// Run through linux-vault.test.js --components: a disposable real GNOME keyring,
// encrypted file and cross-process kernel lock, never the desktop keyring.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { fixture } = require('./lib/admin-enrollment-fixture');
const { createAdministrativeEnrollment, hash, IDENTITY_KEY } = require('../src/lib/online-fra-admin-enrollment');
const linux = require('../src/lib/vault-linux');
const location = require('../src/lib/vault-location');
const ADMIN = 'custom.online_fra_admin_operation_v1', DEVICE = 'custom.online_fra_device_credential_v1';
const vault = { getIdentity: key => linux.get(key), operation: input => linux.adminDeviceOperation(input) };
function worker(input) {
  const child = spawn(process.execPath, [__filename, '--worker'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let raw = '', errors = ''; child.stdout.on('data', v => { raw += v; }); child.stderr.on('data', v => { errors += v; });
  child.stdin.end(JSON.stringify(input));
  return once(child, 'close').then(([code]) => { assert.equal(code, 0, errors.slice(0, 200)); return JSON.parse(raw); });
}
async function main() {
  if (process.argv[2] === '--worker') {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input); let result;
    try {
      if (value.kind === 'transaction') { const r = linux.adminDeviceOperation(value.request); result = { ok: true, mutationOutcome: r.mutationOutcome }; }
      else result = createAdministrativeEnrollment({ context: value.context, stateRoot: value.stateRoot, vault }).resume();
    } catch (error) { result = { ok: false, code: error.code, mutationOutcome: error.mutationOutcome }; }
    await require('../src/lib/linux-vault-host-client').close();
    process.stdout.write(JSON.stringify(result)); return;
  }
  if (!/^toolsenabled-component-libsecret-/.test(path.basename(path.dirname(process.env.XDG_DATA_HOME || '')))) {
    assert.equal(process.platform, 'linux', 'administrative custody qualification requires real Linux');
    const nestedStarted = process.hrtime.bigint();
    const child = spawnSync(process.execPath, [path.join(__dirname, 'linux-vault.test.js'), '--components',
      'tests/online-fra-admin-linux-vault.test.js'], { env: { ...process.env }, stdio: 'inherit', timeout: 60000 });
    const nested = { status: child.status, signal: child.signal || null,
      errorCode: child.error && child.error.code || null, elapsedMs: Math.round(Number(process.hrtime.bigint() - nestedStarted) / 1e6) };
    assert.ok(child.error == null && child.status === 0, JSON.stringify(nested)); return;
  }
  assert.ok(process.env.TOOLSENABLED_TEST_ROOT, 'requires explicit isolated test root');
  assert.match(path.basename(path.dirname(process.env.XDG_DATA_HOME || '')), /^toolsenabled-component-libsecret-/,
    'requires the private component keyring, separate from the per-test vault root');
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'requires private D-Bus fixture');
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'vault', 'secrets.json'); location.resetVaultLocationForTests();
  const file = location.vaultPath();
  const f = fixture(stateRoot), admin = () => createAdministrativeEnrollment({ context: f.context, stateRoot, vault });
  assert.throws(() => admin().prepare(), error => ['ADMIN_IDENTITY_ABSENT', 'SECRET_NOT_CONFIGURED'].includes(error.code));
  linux.setMany([{ key: IDENTITY_KEY, value: f.identity }, { key: 'custom.unrelated', value: 'keep-disposable-record' }]);
  const identityBefore = linux.get(IDENTITY_KEY);
  const identityVaultBefore = fs.readFileSync(file);
  const cliDiag = result => JSON.stringify({ status: result.status, signal: result.signal || null,
    errorCode: result.error && result.error.code || null, elapsedMs: result.elapsedMs });
  const cli = input => {
    const started = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/online-fra-admin-cli.js')], {
      input: JSON.stringify(input), env: { ...process.env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
    });
    result.elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return result;
  };
  const readIdentity = cli({ version: 1, action: 'identity', context: { ...f.context, publicKey: null } });
  assert.ok(readIdentity.error == null && readIdentity.status === 0, cliDiag(readIdentity));
  assert.deepEqual(JSON.parse(readIdentity.stdout), { ok: true, stage: 'identity', publicKey: f.context.publicKey });
  assert.ok(fs.readFileSync(file).equals(identityVaultBefore), 'identity-only CLI cannot create an administrative operation');
  const refusedIdentity = cli({ version: 1, action: 'identity', context: f.context });
  assert.ok(refusedIdentity.error == null && refusedIdentity.status === 1, cliDiag(refusedIdentity));
  assert.equal(JSON.parse(refusedIdentity.stdout).code, 'ADMIN_INPUT_INVALID');
  assert.ok(fs.readFileSync(file).equals(identityVaultBefore));
  const preparedCli = cli({ version: 1, action: 'prepare', context: f.context });
  assert.ok(preparedCli.error == null && preparedCli.status === 0, cliDiag(preparedCli));
  const prepared = JSON.parse(preparedCli.stdout);
  assert.deepEqual(admin().prepare(), prepared, 'prepared operation survives a fresh controller');
  assert.equal(fs.readFileSync(file).includes(Buffer.from('PRIVATE KEY')), false);
  const sealed = f.enroll(prepared.signedRequest), imported = admin().importGrant(sealed);
  assert.equal(imported.receipt.durable, true); assert.equal(imported.receipt.serverCollected, false);
  assert.equal(linux.get(DEVICE), JSON.stringify(f.credential));
  assert.equal(linux.get(ADMIN).includes('PRIVATE KEY'), false, 'private transport removed in same vault commit');
  const initialBytes = fs.readFileSync(file);
  assert.throws(() => admin().finalize(f.collect(imported.signedRequest, { credentialHash: 'a'.repeat(64) })), { code: 'ADMIN_REPLY_INVALID' });
  assert.ok(fs.readFileSync(file).equals(initialBytes));
  const finalized = admin().finalize(f.collect(imported.signedRequest)); assert.equal(finalized.receipt.serverCollected, true);
  const restarted = await worker({ kind: 'resume', context: f.context, stateRoot });
  assert.equal(restarted.stage, 'stored'); assert.equal(restarted.receipt.serverCollected, false);
  admin().finalize(f.collect(restarted.signedRequest));
  assert.equal(linux.get(IDENTITY_KEY), identityBefore);
  assert.equal(linux.get('custom.unrelated'), 'keep-disposable-record');
  for (const candidate of [file, file + '.access.log']) {
    const bytes = fs.readFileSync(candidate);
    assert.equal(bytes.includes(Buffer.from(f.credential.deviceToken)), false);
    assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
  }
  assert.equal(JSON.stringify([prepared, imported, finalized, restarted]).includes(f.credential.deviceToken), false);
  console.log('PASS real Linux encrypted administrative import, readback, fresh attestation, restart and identity preservation');
  linux.clearDeviceCredential();
  assert.throws(() => admin().resume(), { code: 'ADMIN_CREDENTIAL_CHANGED' });
  assert.throws(() => admin().importGrant(sealed), { code: 'ADMIN_CREDENTIAL_CHANGED' });
  assert.equal(admin().cancel().stage, 'cancelled');
  assert.throws(() => admin().importGrant(sealed), { code: 'ADMIN_OPERATION_ABSENT' });
  assert.equal(linux.get(IDENTITY_KEY), identityBefore);
  console.log('PASS removed administrative grant cannot be resurrected by old envelope or receipt');

  // Independent disposable file, same real private keyring. Two actual Python
  // writers contend for one prepared record; neither may clobber the winner.
  await require('../src/lib/linux-vault-host-client').close();
  process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'race', 'vault', 'secrets.json'); location.resetVaultLocationForTests();
  const raceRoot = path.dirname(path.dirname(location.vaultPath())), r = fixture(raceRoot);
  linux.setMany([{ key: IDENTITY_KEY, value: r.identity }]);
  const a = createAdministrativeEnrollment({ context: r.context, stateRoot: raceRoot, vault }); a.prepare();
  const raw = linux.get(ADMIN), pending = JSON.parse(raw);
  const requests = [0, 1].map(index => {
    const credential = { ...r.credential, deviceToken: 'dt_' + String(index).repeat(43) };
    const record = { version: 1, state: 'stored', operationId: r.context.operationId, context: r.context,
      enrollmentRequest: pending.enrollmentRequest, envelopeHash: 'a'.repeat(64), credentialHash: hash(JSON.stringify(credential)),
      pairId: credential.pairId, deviceId: credential.deviceId, claimedAtMs: credential.claimedAtMs, storedAtMs: Date.now() };
    return { operationId: r.context.operationId, publicKey: r.context.publicKey, transition: 'store', expectedHash: hash(raw),
      record: JSON.stringify(record), credential: JSON.stringify(credential) };
  });
  const results = await Promise.all(requests.map(request => worker({ kind: 'transaction', request })));
  assert.equal(results.filter(v => v.ok).length, 1); assert.equal(results.filter(v => v.code === 'ADMIN_OPERATION_CONFLICT').length, 1);
  const winner = results.findIndex(v => v.ok); assert.equal(linux.get(DEVICE), requests[winner].credential);
  assert.equal(linux.get(IDENTITY_KEY), r.identity);
  const wrong = fixture(raceRoot); linux.setMany([{ key: IDENTITY_KEY, value: wrong.identity }]);
  assert.throws(() => linux.adminDeviceOperation({ ...requests[winner], transition: 'inspect', expectedHash: null, record: null, credential: null }), { code: 'ADMIN_IDENTITY_MISMATCH' });
  console.log('PASS real concurrent no-clobber transaction and identity-change refusal under Linux vault lock');
  await require('../src/lib/linux-vault-host-client').close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
