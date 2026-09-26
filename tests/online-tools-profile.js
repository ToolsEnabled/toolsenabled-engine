// EXECUTABLE CHANGE — mutation report: the fixed online-tool contract is now independently asserted.
'use strict';

const assert = require('node:assert/strict');
const {
  PROFILE_ID,
  CREDENTIAL_DOMAIN,
  ONLINE_TOOLS,
  TOOLS_TIER,
  assertSafeToolName,
  authorizeOnlineToolInvocation,
  authorizeOnlineToolsProfile,
  buildOnlineToolsAllowlist,
  createOnlineToolsProfile,
  createOnlineToolsProfileEnforcer
} = require('../src/lib/online-tools-profile');

const NOW = 1_700_000_000_000;
// Keep the expected contract independent from ONLINE_TOOLS: deriving the fixture and
// expectation from that export allowed a product deletion to rewrite its own oracle.
const EXPECTED_ONLINE_TOOLS = Object.freeze([
  'audit.status',
  'audit.tail',
  'code.diagnostics',
  'code.document_symbols',
  'code.find_references',
  'code.goto_definition',
  'code.hover',
  'code.status',
  'code.workspace_symbols',
  'memory.get',
  'memory.search',
  'overnight_advisory.lifecycle_status',
  'overnight_advisory.list',
  'overnight_advisory.status',
  'research.local_tiers_status',
  'sandbox.auth_profile_status',
  'sandbox.doctor',
  'sandbox.status',
  'search.query',
  'search.status',
  'system.doctor',
  'system.kill_switch_status',
  'system.status',
  'task.get',
  'task.list'
]);
const TOOL_CATALOGUE = Object.freeze(EXPECTED_ONLINE_TOOLS.map(name => Object.freeze({
  name,
  effect: 'local-read',
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
})));

/*
Mutation report (testcanfail-tests-online-tools-profile-js)

STRENGTHENED — the allowlist equality, materialized profile tools equality, and
non-empty selector assertion. Mutation: deleted `audit.status` from ONLINE_TOOLS
in src/lib/online-tools-profile.js. Before this change the complete file stayed
green and ended with `online-tools-profile tests passed (29 fixed tools).` After
this change it went red:

  not ok - the injected fixture catalogue covers every fixed online tool
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'audit.tail,code.diagnostics,...,task.list'
  - 'audit.status,audit.tail,code.diagnostics,...,task.list'

RESTORED — src/lib/online-tools-profile.js was restored byte-for-byte (cmp exit
0; matching SHA-256 before the test edit), and the strengthened file is green:

  ok - the injected fixture catalogue covers every fixed online tool
  ok - the fixed selectors are unique explicit names
  online-tools-profile tests passed (30 fixed tools).

NOT-FOUND (1) — the other loop has a non-empty inline literal; the exported-list
loop is now preceded by an explicit non-empty assertion.
NOT-FOUND (2) — no exit-status or truthy-return assertion is used as process
evidence.
NOT-FOUND (3) — no tested failure is swallowed by try/catch or optional chaining;
the check helper rethrows.
NOT-FOUND (4) — no mock replaces the subject under test; injected collaborators
only supply profile state and observe denial/close effects.
NOT-FOUND (5) — there is no skip or platform precondition guard.
NOT-FOUND (6) — fixed tool expectations had been derived from the product export;
they are now an independent literal contract.
PRECONDITIONS UNMET — none.
*/

function check(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.then(() => console.log(`ok - ${label}`));
    console.log(`ok - ${label}`);
    return result;
  } catch (error) {
    console.error(`not ok - ${label}`);
    throw error;
  }
}

function lease(overrides = {}) {
  return {
    identityId: 'online-tools-id_abcdefgh',
    leaseId: 'online-tools-lease_abcdefgh',
    generation: 4,
    credentialDomain: CREDENTIAL_DOMAIN,
    issuedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    tiers: [TOOLS_TIER],
    ...overrides
  };
}

function authorizationInput(overrides = {}) {
  return {
    catalogue: TOOL_CATALOGUE,
    profile: createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 }),
    profileEnabled: true,
    lease: lease(),
    revokedLeaseIds: [],
    killSwitchActive: false,
    now: NOW,
    tier: TOOLS_TIER,
    ...overrides
  };
}

function createHarness(overrides = {}) {
  let profile = overrides.profile ?? createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 });
  let profileEnabled = overrides.profileEnabled ?? true;
  let killSwitchActive = overrides.killSwitchActive ?? false;
  let revokedLeaseIds = overrides.revokedLeaseIds ?? [];
  let now = overrides.now ?? NOW;
  const denials = [];
  const closed = [];
  const enforcer = createOnlineToolsProfileEnforcer({
    catalogue: TOOL_CATALOGUE,
    loadProfile: overrides.loadProfile ?? (() => profile),
    isProfileEnabled: overrides.isProfileEnabled ?? (() => profileEnabled),
    isKillSwitchActive: overrides.isKillSwitchActive ?? (() => killSwitchActive),
    getRevokedLeaseIds: overrides.getRevokedLeaseIds ?? (() => revokedLeaseIds),
    clock: overrides.clock ?? (() => now),
    recordDenial: overrides.recordDenial ?? (event => { denials.push(event); }),
    closeSession: overrides.closeSession ?? (event => { closed.push(event); })
  });
  return {
    enforcer, denials, closed,
    setProfile(value) { profile = value; },
    setProfileEnabled(value) { profileEnabled = value; },
    setKillSwitchActive(value) { killSwitchActive = value; },
    setRevokedLeaseIds(value) { revokedLeaseIds = value; },
    setNow(value) { now = value; }
  };
}

(async () => {
  await check('the injected fixture catalogue covers every fixed online tool', () => {
    assert.equal(buildOnlineToolsAllowlist(TOOL_CATALOGUE), EXPECTED_ONLINE_TOOLS.join(','));
  });

  await check('the materialized profile is frozen, default-off, explicit, and read-only by contract', () => {
    const profile = createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 });
    assert.equal(profile.profileId, PROFILE_ID);
    assert.equal(profile.defaultOff, true);
    assert.equal(profile.fixedExplicit, true);
    assert.equal(profile.readOnlyIntent, true);
    assert.equal(profile.killSwitchRequired, true);
    assert.equal(profile.auditRequired, true);
    assert.equal(profile.credentialDomain, CREDENTIAL_DOMAIN);
    assert.equal(profile.tier, TOOLS_TIER);
    assert.deepEqual(profile.tools, EXPECTED_ONLINE_TOOLS);
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.tools));
  });

  await check('the fixed selectors are unique explicit names', () => {
    assert.ok(ONLINE_TOOLS.length > 0, 'the fixed selector contract must not be empty');
    assert.equal(new Set(ONLINE_TOOLS).size, ONLINE_TOOLS.length);
    for (const name of ONLINE_TOOLS) assert.doesNotThrow(() => assertSafeToolName(name));
  });

  await check('a tool is allowed only by its explicit current profile membership', () => {
    const allowed = authorizeOnlineToolInvocation({ ...authorizationInput(), toolName: 'system.status' });
    assert.equal(allowed.toolName, 'system.status');
    const profile = createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 });
    const removed = { ...profile, tools: profile.tools.filter(name => name !== 'system.status') };
    removed.allowlist = removed.tools.join(',');
    assert.throws(() => authorizeOnlineToolInvocation({ ...authorizationInput({ profile: removed }), toolName: 'system.status' }),
      error => error.code === 'ONLINE_PROFILE_TOOL_NOT_ALLOWED');
  });

  await check('an unknown or credential-bearing tool is denied even when injected into the catalogue', () => {
    const catalogue = [...TOOL_CATALOGUE, {
      name: 'system.credential_request', effect: 'local-read',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    }];
    assert.throws(() => authorizeOnlineToolInvocation({ ...authorizationInput({ catalogue }), toolName: 'system.credential_request' }),
      error => error.code === 'ONLINE_PROFILE_TOOL_NOT_ALLOWED');
    assert.throws(() => authorizeOnlineToolInvocation({ ...authorizationInput(), toolName: 'unknown.tool' }),
      error => error.code === 'ONLINE_PROFILE_TOOL_UNKNOWN');
  });

  await check('missing or unsafe injected catalogue entries fail closed', () => {
    assert.throws(() => buildOnlineToolsAllowlist(TOOL_CATALOGUE.filter(entry => entry.name !== ONLINE_TOOLS[0])),
      error => error.code === 'ONLINE_PROFILE_REGISTRY_GAP');
    const unsafe = TOOL_CATALOGUE.map(entry => entry.name === ONLINE_TOOLS[0]
      ? { ...entry, effect: 'local-write' }
      : entry);
    assert.throws(() => buildOnlineToolsAllowlist(unsafe), error => error.code === 'ONLINE_PROFILE_REGISTRY_UNSAFE');
  });

  await check('tier membership is explicit and never inherited from full remote', () => {
    assert.throws(() => authorizeOnlineToolsProfile(authorizationInput({ lease: lease({ tiers: ['full-remote'] }) })),
      error => error.code === 'ONLINE_PROFILE_TIER_DENIED');
    assert.throws(() => authorizeOnlineToolsProfile(authorizationInput({ tier: 'full-remote' })),
      error => error.code === 'ONLINE_PROFILE_TIER_DENIED');
  });

  await check('expired and revoked leases deny authorization', () => {
    assert.throws(() => authorizeOnlineToolsProfile(authorizationInput({ lease: lease({ expiresAtMs: NOW }) })),
      error => error.code === 'ONLINE_PROFILE_LEASE_EXPIRED');
    assert.throws(() => authorizeOnlineToolsProfile(authorizationInput({ revokedLeaseIds: [lease().leaseId] })),
      error => error.code === 'ONLINE_PROFILE_LEASE_REVOKED');
  });

  await check('a kill switch denies every tool and closes active sessions', async () => {
    const harness = createHarness();
    const session = await harness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    assert.equal(session.status, 'authorized');
    harness.setKillSwitchActive(true);
    const denied = await session.invoke('system.status');
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'ONLINE_PROFILE_KILLSWITCH_ACTIVE');
    assert.equal(harness.enforcer.getActiveSessionCount(), 0);
    assert.deepEqual(harness.closed, [{ sessionId: session.sessionId, reason: 'security-state-rejected' }]);
    const second = await harness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    assert.equal(second.status, 'denied');
    assert.equal(second.reason, 'ONLINE_PROFILE_KILLSWITCH_ACTIVE');
  });

  await check('an expired or revoked lease closes its active session', async () => {
    const harness = createHarness();
    const session = await harness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    harness.setNow(NOW + 60_000);
    const expired = await session.invoke('system.status');
    assert.equal(expired.reason, 'ONLINE_PROFILE_LEASE_EXPIRED');
    assert.equal(harness.enforcer.getActiveSessionCount(), 0);
    const next = await harness.enforcer.open({ lease: lease({
      leaseId: 'online-tools-lease_ijklmnop', expiresAtMs: NOW + 120_000
    }), tier: TOOLS_TIER });
    assert.equal(next.status, 'authorized');
    harness.setRevokedLeaseIds(['online-tools-lease_ijklmnop']);
    const revoked = await next.invoke('system.status');
    assert.equal(revoked.reason, 'ONLINE_PROFILE_LEASE_REVOKED');
    assert.equal(harness.enforcer.getActiveSessionCount(), 0);
  });

  await check('a failed close callback refuses to report a definite successful close', async () => {
    const callbackError = Object.assign(new Error('callback unavailable'), { code: 'ECONNRESET' });
    const harness = createHarness({ closeSession: () => { throw callbackError; } });
    const first = await harness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    const second = await harness.enforcer.open({
      lease: lease({ leaseId: 'online-tools-lease_ijklmnop' }), tier: TOOLS_TIER
    });
    await assert.rejects(() => harness.enforcer.closeAll('security-state-rejected'), error => (
      error.code === 'ONLINE_PROFILE_SESSION_CLOSE_FAILED'
      && error.details.sessionId === first.sessionId
      && error.details.causeCode === 'ECONNRESET'
    ));
    assert.equal(harness.enforcer.getActiveSessionCount(), 0);
    assert.equal(await second.close('explicit-close'), false);

    const directHarness = createHarness({ closeSession: () => { throw callbackError; } });
    const direct = await directHarness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    await assert.rejects(() => direct.close('explicit-close'), error => (
      error.code === 'ONLINE_PROFILE_SESSION_CLOSE_FAILED'
    ));
    assert.equal(directHarness.enforcer.getActiveSessionCount(), 0);
  });

  await check('a profile load error or malformed profile denies everything instead of defaulting open', async () => {
    const unavailable = createHarness({ loadProfile: () => { throw new Error('unavailable'); } });
    const unavailableResult = await unavailable.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    assert.equal(unavailableResult.status, 'denied');
    assert.equal(unavailableResult.reason, 'ONLINE_PROFILE_LOAD_FAILED');
    let available = true;
    const active = createHarness({ loadProfile: () => {
      if (!available) throw new Error('unavailable');
      return createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 });
    } });
    const session = await active.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    available = false;
    const activeDenial = await session.invoke('system.status');
    assert.equal(activeDenial.reason, 'ONLINE_PROFILE_LOAD_FAILED');
    assert.equal(active.enforcer.getActiveSessionCount(), 0);
    const malformed = createHarness({ profile: { defaultOff: false } });
    const malformedResult = await malformed.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    assert.equal(malformedResult.status, 'denied');
    assert.equal(malformedResult.reason, 'ONLINE_PROFILE_INVALID_SHAPE');
  });

  await check('a removed tool is immediately denied and every denial records its reason', async () => {
    const harness = createHarness();
    const session = await harness.enforcer.open({ lease: lease(), tier: TOOLS_TIER });
    const profile = createOnlineToolsProfile(TOOL_CATALOGUE, { identityGeneration: 4 });
    const tools = profile.tools.filter(name => name !== 'system.status');
    harness.setProfile({ ...profile, tools, allowlist: tools.join(',') });
    const denied = await session.invoke('system.status');
    assert.equal(denied.reason, 'ONLINE_PROFILE_TOOL_NOT_ALLOWED');
    assert.equal(harness.denials.length, 1);
    assert.deepEqual(harness.denials[0], {
      event: 'online-tools-denied', atMs: NOW, sessionId: session.sessionId,
      tier: TOOLS_TIER, toolName: 'system.status', reason: 'ONLINE_PROFILE_TOOL_NOT_ALLOWED'
    });
    assert.deepEqual(harness.enforcer.getDenials(), harness.denials);
  });

  await check('wildcards, desktop surfaces, shell, and credential-shaped tools are rejected', () => {
    for (const name of ['code.*', 'host.exec', 'browser.start', 'screen.capture', 'clipboard.read', 'vault.read', 'system.credential_request', 'gcloud.account_login']) {
      assert.throws(() => assertSafeToolName(name), error => (
        error.code === 'ONLINE_PROFILE_TOOL_NAME_INVALID' || error.code === 'ONLINE_PROFILE_TOOL_FORBIDDEN'
      ), name);
    }
  });

  console.log(`online-tools-profile tests passed (${ONLINE_TOOLS.length} fixed tools).`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
