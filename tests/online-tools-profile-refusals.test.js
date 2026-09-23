'use strict';

const assert = require('node:assert/strict');
const {
  CREDENTIAL_DOMAIN,
  ONLINE_TOOLS,
  TOOLS_TIER,
  authorizeOnlineToolsProfile,
  createOnlineToolsProfile,
  createOnlineToolsProfileEnforcer,
  validateOnlineToolsProfile
} = require('../src/lib/online-tools-profile');

const NOW = 1_700_000_000_000;
const annotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const catalogue = Object.freeze(ONLINE_TOOLS.map(name => Object.freeze({ name, effect: 'local-read', annotations })));

function lease(overrides = {}) {
  return {
    credentialDomain: CREDENTIAL_DOMAIN,
    expiresAtMs: NOW + 60_000,
    generation: 7,
    identityId: 'online-tools-id_abcdefgh',
    issuedAtMs: NOW - 1_000,
    leaseId: 'online-tools-lease_abcdefgh',
    tiers: [TOOLS_TIER],
    ...overrides
  };
}

function authorization(overrides = {}) {
  return {
    catalogue,
    killSwitchActive: false,
    lease: lease(),
    now: NOW,
    profile: createOnlineToolsProfile(catalogue, { identityGeneration: 7 }),
    profileEnabled: true,
    revokedLeaseIds: [],
    tier: TOOLS_TIER,
    ...overrides
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error.code === code);
}

function harness(overrides = {}) {
  const effects = { closes: [], denials: [] };
  let profileEnabled = true;
  let killSwitchActive = false;
  let currentLease = lease();
  const enforcer = createOnlineToolsProfileEnforcer({
    catalogue,
    loadProfile: () => createOnlineToolsProfile(catalogue, { identityGeneration: 7 }),
    isProfileEnabled: () => profileEnabled,
    isKillSwitchActive: () => killSwitchActive,
    getRevokedLeaseIds: () => [],
    clock: () => NOW,
    recordDenial: event => { effects.denials.push(event); },
    closeSession: event => { effects.closes.push(event); },
    ...overrides
  });
  return {
    effects,
    enforcer,
    request: () => ({ lease: currentLease, tier: TOOLS_TIER }),
    setEnabled: value => { profileEnabled = value; },
    setKillSwitch: value => { killSwitchActive = value; },
    setLease: value => { currentLease = value; }
  };
}

(async () => {
  // Constructor refusals happen before an enforcer exists, so none of the
  // supplied effect callbacks can be called.
  for (const [badCatalogue, code] of [
    [null, 'ONLINE_PROFILE_REGISTRY_INVALID'],
    [[...catalogue, catalogue[0]], 'ONLINE_PROFILE_REGISTRY_DUPLICATE']
  ]) {
    let effects = 0;
    expectCode(() => createOnlineToolsProfileEnforcer({
      catalogue: badCatalogue,
      loadProfile: () => { effects += 1; },
      isProfileEnabled: () => { effects += 1; },
      isKillSwitchActive: () => { effects += 1; },
      getRevokedLeaseIds: () => { effects += 1; },
      clock: () => { effects += 1; },
      recordDenial: () => { effects += 1; },
      closeSession: () => { effects += 1; }
    }), code);
    assert.equal(effects, 0);
  }

  let dependencyEffects = 0;
  expectCode(() => createOnlineToolsProfileEnforcer({
    catalogue,
    loadProfile: null,
    isProfileEnabled: () => { dependencyEffects += 1; },
    isKillSwitchActive: () => { dependencyEffects += 1; },
    getRevokedLeaseIds: () => { dependencyEffects += 1; },
    clock: () => { dependencyEffects += 1; },
    recordDenial: () => { dependencyEffects += 1; },
    closeSession: () => { dependencyEffects += 1; }
  }), 'ONLINE_PROFILE_DEPENDENCY_INVALID');
  assert.equal(dependencyEffects, 0);

  expectCode(() => createOnlineToolsProfile(catalogue, { identityGeneration: -1 }),
    'ONLINE_PROFILE_INVALID_VALUE');

  const profile = createOnlineToolsProfile(catalogue, { identityGeneration: 7 });
  expectCode(() => validateOnlineToolsProfile({
    ...profile, tools: profile.tools.slice(1), allowlist: profile.allowlist
  }, catalogue), 'ONLINE_PROFILE_NOT_EXPLICIT');

  expectCode(() => authorizeOnlineToolsProfile(authorization({
    lease: lease({ credentialDomain: 'wrong-domain' })
  })), 'ONLINE_PROFILE_LEASE_DENIED');
  expectCode(() => authorizeOnlineToolsProfile(authorization({
    lease: lease({ expiresAtMs: NOW - 1_000 })
  })), 'ONLINE_PROFILE_LEASE_INVALID');
  expectCode(() => authorizeOnlineToolsProfile(authorization({
    lease: lease({ generation: 6 })
  })), 'ONLINE_PROFILE_LEASE_STALE');

  const disabled = harness();
  disabled.setEnabled(false);
  const disabledResult = await disabled.enforcer.open(disabled.request());
  assert.equal(disabledResult.reason, 'ONLINE_PROFILE_DISABLED');
  assert.equal(disabledResult.allowed, false);
  assert.equal(disabled.enforcer.getActiveSessionCount(), 0);
  assert.deepEqual(disabled.effects.closes, []);
  assert.equal(disabled.effects.denials.length, 1);

  const unknownKillSwitch = harness();
  unknownKillSwitch.setKillSwitch(undefined);
  const unknownResult = await unknownKillSwitch.enforcer.open(unknownKillSwitch.request());
  assert.equal(unknownResult.reason, 'ONLINE_PROFILE_KILLSWITCH_UNKNOWN');
  assert.equal(unknownResult.allowed, false);
  assert.equal(unknownKillSwitch.enforcer.getActiveSessionCount(), 0);
  assert.deepEqual(unknownKillSwitch.effects.closes, []);
  assert.equal(unknownKillSwitch.effects.denials.length, 1);

  const stale = harness();
  const mutableLease = lease();
  const session = await stale.enforcer.open({ lease: mutableLease, tier: TOOLS_TIER });
  assert.equal(session.status, 'authorized');
  mutableLease.generation = 6;
  const staleResult = await session.invoke('system.status');
  assert.equal(staleResult.reason, 'ONLINE_PROFILE_LEASE_STALE');
  assert.equal(staleResult.allowed, false);
  assert.equal(stale.enforcer.getActiveSessionCount(), 0);
  assert.deepEqual(stale.effects.closes,
    [{ sessionId: session.sessionId, reason: 'lease-rejected' }]);

  const invalidClose = harness();
  const closable = await invalidClose.enforcer.open(invalidClose.request());
  await assert.rejects(() => closable.close('INVALID REASON'),
    error => error.code === 'ONLINE_PROFILE_CLOSE_REASON_INVALID');
  assert.equal(invalidClose.enforcer.getActiveSessionCount(), 1);
  assert.deepEqual(invalidClose.effects.closes, []);

  const auditFailure = harness({ recordDenial: () => { throw new Error('audit offline'); } });
  auditFailure.setEnabled(false);
  const unaudited = await auditFailure.enforcer.open(auditFailure.request());
  assert.equal(unaudited.status, 'denied');
  assert.equal(unaudited.allowed, false);
  assert.equal(unaudited.reason, 'ONLINE_PROFILE_DENIAL_AUDIT_FAILED');
  assert.equal(unaudited.originalReason, 'ONLINE_PROFILE_DISABLED');
  assert.equal(auditFailure.enforcer.getActiveSessionCount(), 0);
  assert.deepEqual(auditFailure.effects.closes, []);

  console.log('online-tools-profile refusal tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
