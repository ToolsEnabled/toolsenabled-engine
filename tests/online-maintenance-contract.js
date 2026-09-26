'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const maintenance = require('../src/lib/online-maintenance-contract');

let assertions = 0;
function equal(...args) { assertions += 1; return assert.equal(...args); }
function deepEqual(...args) { assertions += 1; return assert.deepEqual(...args); }
function ok(...args) { assertions += 1; return assert.ok(...args); }
function throws(run, predicate) { assertions += 1; return assert.throws(run, predicate); }

const profile = maintenance.createOnlineMaintenanceProfile({ identityGeneration: 4 });
const identity = {
  identityId: 'online-id_abcdefgh',
  generation: 4,
  credentialDomain: maintenance.CREDENTIAL_DOMAIN,
  serviceAccount: maintenance.SERVICE_ACCOUNT,
  nonAdmin: true
};

function request({ commandId = 'health.snapshot', args = {}, timeout = 5_000, output = 8_192, overrides = {} } = {}) {
  return maintenance.authorizeOnlineMaintenanceCommand({
    profile,
    profileEnabled: true,
    identity,
    commandId,
    args,
    requestedTimeoutMs: timeout,
    requestedOutputBytes: output,
    revokedIdentityIds: [],
    sessionCommandIndex: 0,
    killSwitchActive: false,
    ...overrides
  });
}

function mutableProfile(overrides = {}) {
  return { ...structuredClone(profile), ...overrides };
}

function refusesWithoutEffects(run, code) {
  const originalSpawn = childProcess.spawn;
  const originalWriteFileSync = fs.writeFileSync;
  let spawnCalls = 0;
  let writeCalls = 0;
  childProcess.spawn = (...args) => { spawnCalls += 1; return originalSpawn(...args); };
  fs.writeFileSync = (...args) => { writeCalls += 1; return originalWriteFileSync(...args); };
  try {
    throws(run, error => error instanceof maintenance.OnlineMaintenanceError && error.code === code);
    equal(spawnCalls, 0, `${code} must refuse before spawning`);
    equal(writeCalls, 0, `${code} must refuse without writing`);
  } finally {
    childProcess.spawn = originalSpawn;
    fs.writeFileSync = originalWriteFileSync;
  }
}

(() => {
  equal(profile.profileId, maintenance.PROFILE_ID);
  equal(profile.credentialDomain, maintenance.CREDENTIAL_DOMAIN);
  equal(profile.serviceAccount, maintenance.SERVICE_ACCOUNT);
  equal(profile.nonAdmin, true);
  equal(profile.defaultOff, true);
  equal(profile.noShell, true);
  equal(profile.noSudo, true);
  equal(profile.noRoot, true);
  equal(profile.noVault, true);
  equal(profile.noOwnerProfile, true);
  equal(profile.noScreen, true);
  equal(profile.noClipboard, true);
  equal(profile.noOcr, true);
  equal(profile.commandAllowlist.length, 4);
  deepEqual(profile.workingRoots, [
    { rootId: 'service-state', mode: 'read-only' },
    { rootId: 'backup-state', mode: 'read-only' }
  ]);
  equal(Object.isFrozen(profile), true);
  equal(Object.isFrozen(profile.commandAllowlist), true);
  equal(Object.isFrozen(profile.commandAllowlist[0]), true);
  throws(() => profile.commandAllowlist.push({ commandId: 'anything.*' }), error => error instanceof TypeError);

  const health = request();
  equal(health.status, 'authorized');
  equal(health.commandId, 'health.snapshot');
  equal(health.rootId, 'service-state');
  equal(health.readOnly, true);
  equal(health.shell, false);
  equal(health.elevated, false);
  equal(health.allowSudo, false);
  equal(health.grantsVault, false);
  equal(health.grantsOwnerProfile, false);
  equal(health.grantsScreen, false);
  equal(health.grantsClipboard, false);
  equal(health.grantsOcr, false);
  equal(health.grantsAuthority, false);
  equal(health.sessionCommandIndex, 0);
  equal(health.remainingSessionCommands, maintenance.MAX_SESSION_COMMANDS - 1);
  ok(!JSON.stringify(health).includes('argv'));
  ok(!JSON.stringify(health).includes('executable'));

  equal(request({ commandId: 'runtime.version' }).rootId, 'service-state');
  equal(request({ commandId: 'service.status', args: { serviceId: 'api' } }).args.serviceId, 'api');
  equal(request({ commandId: 'backup.manifest', args: { relativePath: 'daily/manifest.json' } }).args.relativePath, 'daily/manifest.json');

  throws(() => request({ commandId: 'host.exec' }), error => error.code === 'ONLINE_MAINTENANCE_COMMAND_DENIED');
  throws(() => request({ commandId: 'service.*', args: { serviceId: 'api' } }), error => (
    error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE' || error.code === 'ONLINE_MAINTENANCE_COMMAND_DENIED'
  ));
  throws(() => request({ commandId: 'service.status', args: { serviceId: 'shell' } }), error => error.code === 'ONLINE_MAINTENANCE_ARGUMENT_DENIED');
  throws(() => request({ commandId: 'backup.manifest', args: { relativePath: '../manifest.json' } }), error => (
    error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE' || error.code === 'ONLINE_MAINTENANCE_PATH_DENIED'
  ));
  throws(() => request({ commandId: 'backup.manifest', args: { relativePath: 'daily/manifest.txt' } }), error => error.code === 'ONLINE_MAINTENANCE_PATH_DENIED');
  throws(() => request({ commandId: 'backup.manifest', args: { relativePath: 'C:/manifest.json' } }), error => (
    error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE' || error.code === 'ONLINE_MAINTENANCE_PATH_DENIED'
  ));
  throws(() => request({ commandId: 'health.snapshot', timeout: 10_001 }), error => error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE');
  throws(() => request({ commandId: 'runtime.version', output: 16_385 }), error => error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE');
  throws(() => request({ overrides: { profileEnabled: false } }), error => error.code === 'ONLINE_MAINTENANCE_PROFILE_DISABLED');
  throws(() => request({ overrides: { killSwitchActive: true } }), error => error.code === 'ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE');
  throws(() => request({ overrides: { revokedIdentityIds: [identity.identityId] } }), error => error.code === 'ONLINE_MAINTENANCE_IDENTITY_REVOKED');
  throws(() => request({ overrides: { identity: { ...identity, generation: 3 } } }), error => error.code === 'ONLINE_MAINTENANCE_IDENTITY_STALE');
  throws(() => request({ overrides: { identity: { ...identity, nonAdmin: false } } }), error => error.code === 'ONLINE_MAINTENANCE_IDENTITY_DENIED');
  throws(() => request({ overrides: { sessionCommandIndex: maintenance.MAX_SESSION_COMMANDS } }), error => error.code === 'ONLINE_MAINTENANCE_INVALID_VALUE');

  refusesWithoutEffects(
    () => maintenance.validateProfile(mutableProfile({ profileId: 'online-full-remote.v2' })),
    'ONLINE_MAINTENANCE_PROFILE_UNSUPPORTED'
  );
  refusesWithoutEffects(
    () => maintenance.validateProfile(mutableProfile({ noShell: false })),
    'ONLINE_MAINTENANCE_PROFILE_UNSAFE'
  );
  refusesWithoutEffects(
    () => maintenance.validateProfile(mutableProfile({ commandAllowlist: [] })),
    'ONLINE_MAINTENANCE_ALLOWLIST_INVALID'
  );
  refusesWithoutEffects(
    () => request({ overrides: { killSwitchActive: null } }),
    'ONLINE_MAINTENANCE_KILLSWITCH_UNKNOWN'
  );
  refusesWithoutEffects(
    () => request({ overrides: { revokedIdentityIds: ['not-an-online-identity'] } }),
    'ONLINE_MAINTENANCE_REVOCATION_INVALID'
  );

  const source = fs.readFileSync(require.resolve('../src/lib/online-maintenance-contract'), 'utf8');
  ok(!/require\(['"]node:(?:child_process|net|tls|http|https|fs)['"]\)/.test(source));
  ok(!/getSecret|spawn\s*\(|execFile|\.listen\s*\(|\.connect\s*\(/.test(source));
  ok(!JSON.stringify(profile).includes('DPAPI'));
  console.log(`online maintenance contract tests passed (${assertions} assertions).`);
})();
