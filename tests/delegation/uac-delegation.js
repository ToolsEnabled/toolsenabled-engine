'use strict';

// UAC delegation tests. Deterministic and offline; a mock audit ledger records
// events so accept/refuse auditing is observable without touching the
// production ledger (per the project rule that audit-touching tests must not
// use the real ledger). A real named-pipe round trip exercises the helper
// server WITHOUT elevation by injecting a runOperation stub -- the ONLY part
// that genuinely needs an elevated process is the real execution of
// netsh/schtasks, which is explicitly reported as unexecuted TAP coverage.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const uac = require('../../src/lib/uac-delegation');
const helper = require('../../src/uac-delegation-helper');

const code = (fn, expected, label) => assert.throws(fn, error => error && error.code === expected, `${label || ''}: expected ${expected}`);

// A mock audit ledger with the { requireRecord, record } shape the module uses.
function makeMockAudit() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      events.push({ kind: 'require', action, target, details });
      return { durable: true, anchored: true, sequence: events.length, eventHash: crypto.createHash('sha256').update(`${action}:${target}:${events.length}`).digest('hex') };
    },
    record(action, target, details) {
      events.push({ kind: 'record', action, target, details });
      return { ok: true };
    }
  };
}

const killSwitch = active => ({ status: () => ({ active }) });
const OWNER = 'TESTDOMAIN\\owner';

// The helper runs at high integrity while the controller runs at the owner's
// filtered medium-integrity token. The pipe therefore needs explicit transport
// permissions. This is not authority: the full protocol test below proves a
// connection still cannot execute without the per-boot token and allowlist.
test('helper pipe transport explicitly crosses the owner integrity boundary', () => {
  const pipeName = '\\\\.\\pipe\\ToolsEnabledUacPermissionTest';
  assert.deepEqual(helper.pipeListenOptions(pipeName), {
    path: pipeName,
    readableAll: true,
    writableAll: true
  });
  console.log('OK: elevated helper pipe explicitly permits transport across the owner integrity boundary');
});

// A well-formed minimal allowlist, independent of the shipped config file.
const rawAllowlist = () => ({
  schemaVersion: 1,
  operations: [
    { id: 'restart-fleet-supervisor', description: 'restart', steps: [
      { exec: 'schtasks.exe', args: ['/End', '/TN', 'ToolsEnabled Fleet Supervisor'] },
      { exec: 'schtasks.exe', args: ['/Run', '/TN', 'ToolsEnabled Fleet Supervisor'] }
    ] },
    { id: 'urlacl-add-dashboard-3889', description: 'urlacl', steps: [
      { exec: 'netsh.exe', args: ['http', 'add', 'urlacl', 'url=http://127.0.0.1:3889/', 'user=${OWNER_PRINCIPAL}'] }
    ] }
  ]
});

// ---------------------------------------------------------------------------
// 1. Allowlist parse strictness: unknown keys rejected at every level.
// ---------------------------------------------------------------------------
test('allowlist rejects unknown keys, executables and placeholders', () => {
  const ok = uac.parseAllowlist(rawAllowlist(), { ownerPrincipal: OWNER });
  assert.equal(ok.operations.size, 2);
  const resolved = uac.resolveOperation(ok, 'urlacl-add-dashboard-3889');
  // The ${OWNER_PRINCIPAL} placeholder is resolved from the injected principal,
  // never from a caller, and the executable is resolved to an absolute path.
  assert.ok(resolved.steps[0].args.includes(`user=${OWNER}`), 'owner principal substituted');
  assert.ok(/[\\/]System32[\\/]netsh\.exe$/i.test(resolved.steps[0].executable), 'exec resolved to System32');
  assert.ok(path.win32.isAbsolute(resolved.steps[0].executable));

  code(() => uac.parseAllowlist({ ...rawAllowlist(), bogus: true }, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'unknown top-level key');
  const opBadKey = rawAllowlist(); opBadKey.operations[0].shell = 'x';
  code(() => uac.parseAllowlist(opBadKey, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'unknown per-operation key');
  const stepBadKey = rawAllowlist(); stepBadKey.operations[0].steps[0].cwd = 'x';
  code(() => uac.parseAllowlist(stepBadKey, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'unknown per-step key');
  const badExec = rawAllowlist(); badExec.operations[0].steps[0].exec = 'cmd.exe';
  code(() => uac.parseAllowlist(badExec, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'unknown executable rejected');
  const badPlaceholder = rawAllowlist(); badPlaceholder.operations[1].steps[0].args = ['http', 'add', 'urlacl', 'url=${EVIL}'];
  code(() => uac.parseAllowlist(badPlaceholder, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'unsupported placeholder rejected');
  const badVersion = { ...rawAllowlist(), schemaVersion: 2 };
  code(() => uac.parseAllowlist(badVersion, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'wrong schemaVersion');
  const dup = rawAllowlist(); dup.operations.push(rawAllowlist().operations[0]);
  code(() => uac.parseAllowlist(dup, { ownerPrincipal: OWNER }), 'UAC_ALLOWLIST_INVALID', 'duplicate operation id');
  const empty = uac.parseAllowlist({ schemaVersion: 1, operations: [] }, {
    ownerPrincipal: ''
  });
  assert.equal(empty.operations.size, 0, 'an empty shipped allowlist is valid and requires no owner principal');
  for (const operationId of ['restart-fleet-supervisor', 'register-coordinator-duty-host-task', 'anything-else']) {
    code(() => uac.resolveOperation(empty, operationId), 'UAC_NOT_ALLOWED', `empty allowlist refuses ${operationId}`);
  }
  console.log('OK: allowlist parse rejects unknown keys, unknown executables, and stray placeholders');
});

// ---------------------------------------------------------------------------
// 1b. The SHIPPED config file grants no standing elevated authority.
// ---------------------------------------------------------------------------
test('shipped allowlist grants no standing elevated authority', () => {
  const allowlist = uac.loadAllowlist({ ownerPrincipal: '' });
  const ids = [...allowlist.operations.keys()].sort();
  assert.deepEqual(ids, [], 'the shipped default grants no standing elevated operation');
  for (const operationId of ['restart-fleet-supervisor', 'register-coordinator-duty-host-task', 'anything-else']) {
    code(() => uac.resolveOperation(allowlist, operationId), 'UAC_NOT_ALLOWED', `shipped empty allowlist refuses ${operationId}`);
  }
  console.log('OK: shipped config/uac-delegation-allowlist.json is an empty fail-closed authority set');
});

// ---------------------------------------------------------------------------
// 2-5. handleRequest decisions: accept, token refusal, non-allowlisted
//      refusal, kill-switch refusal -- each writes a signed audit event.
// ---------------------------------------------------------------------------
test('requests require a valid token, allowlist, kill switch and durable audit', () => {
  const expectedToken = crypto.randomBytes(32);
  const allowlist = uac.parseAllowlist(rawAllowlist(), { ownerPrincipal: OWNER });

  // 2. Accept: correct token, allowlisted op, kill switch off. runOperation is
  //    stubbed (no real elevated execution). Audit gets a decision event
  //    (requireRecord) and an outcome event (record).
  const acceptAudit = makeMockAudit();
  const ran = [];
  const acceptResult = uac.handleRequest(
    { suppliedToken: expectedToken, operationId: 'restart-fleet-supervisor' },
    { expectedToken, allowlist, audit: acceptAudit, killSwitch: killSwitch(false), runOperation: (resolved) => { ran.push(resolved); return { ok: true, steps: [{ ok: true }] }; } }
  );
  assert.equal(acceptResult.decision, 'accept');
  assert.equal(ran.length, 1, 'the allowlisted operation was executed exactly once');
  const acceptDecision = acceptAudit.events.find(e => e.kind === 'require' && e.action === uac.DECISION_ACTION);
  assert.ok(acceptDecision, 'accept writes a signed (requireRecord) decision event');
  assert.equal(acceptDecision.details.decision, 'accept');
  assert.equal(acceptDecision.target, 'restart-fleet-supervisor');
  assert.ok(acceptAudit.events.find(e => e.action === uac.OUTCOME_ACTION), 'accept writes an outcome event');
  assert.deepEqual(acceptResult.outcomeAudit, { recorded: true });
  console.log('OK: accept executes the allowlisted op and writes a signed decision + outcome audit');

  // 3. Token refusal: wrong token, never runs, still audits the refusal.
  const tokenAudit = makeMockAudit();
  const tokenRan = [];
  const tokenResult = uac.handleRequest(
    { suppliedToken: crypto.randomBytes(32), operationId: 'restart-fleet-supervisor' },
    { expectedToken, allowlist, audit: tokenAudit, killSwitch: killSwitch(false), runOperation: () => { tokenRan.push(1); } }
  );
  assert.equal(tokenResult.decision, 'refuse');
  assert.equal(tokenResult.reason, 'token');
  assert.equal(tokenRan.length, 0, 'a bad token never reaches execution');
  const tokenDecision = tokenAudit.events.find(e => e.kind === 'require' && e.action === uac.DECISION_ACTION);
  assert.ok(tokenDecision && tokenDecision.details.reason === 'token', 'token refusal is audited');
  assert.ok(!tokenAudit.events.find(e => e.action === uac.OUTCOME_ACTION), 'a refusal writes no outcome event');
  console.log('OK: wrong token is refused, never executes, and is audited');

  // 4. Non-allowlisted refusal: valid token but an unknown operation id.
  const denyAudit = makeMockAudit();
  const denyRan = [];
  const denyResult = uac.handleRequest(
    { suppliedToken: expectedToken, operationId: 'delete-everything' },
    { expectedToken, allowlist, audit: denyAudit, killSwitch: killSwitch(false), runOperation: () => { denyRan.push(1); } }
  );
  assert.equal(denyResult.decision, 'refuse');
  assert.equal(denyResult.reason, 'not-allowlisted');
  assert.equal(denyRan.length, 0);
  assert.ok(denyAudit.events.find(e => e.kind === 'require' && e.details.reason === 'not-allowlisted'), 'non-allowlisted refusal is audited');
  console.log('OK: a valid token with a non-allowlisted operation is refused and audited');

  // 5. Kill-switch refusal: valid token, allowlisted op, but kill switch on.
  const killAudit = makeMockAudit();
  const killRan = [];
  const killResult = uac.handleRequest(
    { suppliedToken: expectedToken, operationId: 'restart-fleet-supervisor' },
    { expectedToken, allowlist, audit: killAudit, killSwitch: killSwitch(true), runOperation: () => { killRan.push(1); } }
  );
  assert.equal(killResult.decision, 'refuse');
  assert.equal(killResult.reason, 'killswitch');
  assert.equal(killRan.length, 0, 'the kill switch blocks execution');
  assert.ok(killAudit.events.find(e => e.kind === 'require' && e.details.reason === 'killswitch'), 'kill-switch refusal is audited');
  console.log('OK: the kill switch blocks an otherwise-valid operation and is audited');

  // 5b. Fail-closed: if the required decision audit throws, handleRequest throws
  //     and nothing executes.
  const throwingAudit = { requireRecord() { const e = new Error('audit down'); throw e; }, record() {} };
  const failRan = [];
  assert.throws(() => uac.handleRequest(
    { suppliedToken: expectedToken, operationId: 'restart-fleet-supervisor' },
    { expectedToken, allowlist, audit: throwingAudit, killSwitch: killSwitch(false), runOperation: () => { failRan.push(1); } }
  ), /audit down/);
  assert.equal(failRan.length, 0, 'a failed decision audit means the op never runs');
  console.log('OK: fail-closed when the decision audit cannot be written');
});

// ---------------------------------------------------------------------------
// 6. Per-boot token: mint, owner-only ACL, boot binding, and stale rejection.
// ---------------------------------------------------------------------------
test('per-boot token has owner-only ACLs and refuses stale or unreadable tokens', () => {
  const now = 1_700_000_000_000;
  const uptime = 3600; // one hour up
  const bootId = uac.currentBootId({ clock: () => now, uptime: () => uptime });
  assert.equal(uac.currentBootId({ clock: () => now + 4000, uptime: () => uptime + 4 }), bootId, 'boot id is stable across small uptime drift');
  assert.notEqual(uac.currentBootId({ clock: () => now, uptime: () => 60 }), bootId, 'a different boot yields a different id');

  // writeTokenFile requires a repo-internal path (inside() containment check),
  // so mint into a throwaway file under the repo state/ dir and clean it up.
  // This exercises the real owner-only ACL write (icacls) as the same,
  // non-elevated user. spawnSyncImpl is left real to cover that path.
  const tokenFile = path.join(uac.TOKEN_FILE, '..', `uac-delegation-token.test-${process.pid}-${crypto.randomUUID()}.json`);
  const tokenDeps = { clock: () => now, uptime: () => uptime, tokenFile };
  try {
    const token = uac.loadOrCreateToken(tokenDeps);
    const readBack = uac.readToken(tokenDeps);
    assert.ok(token.equals(readBack), 'the freshly minted token reads back for the same boot');
    // A second load for the same boot returns the identical token (idempotent).
    assert.ok(token.equals(uac.loadOrCreateToken(tokenDeps)), 'load is idempotent within a boot');
    // A read under a different boot id must refuse the now-stale token.
    code(() => uac.readToken({ ...tokenDeps, uptime: () => 60 }), 'UAC_TOKEN_UNAVAILABLE', 'stale (previous-boot) token');
  } finally {
    fs.rmSync(tokenFile, { force: true });
  }
  console.log('OK: per-boot token mints (owner-only ACL), reads back for the same boot, and refuses a stale one');

  const unreadableToken = {
    readFileSync() {
      const error = new Error('access denied');
      error.code = 'EACCES';
      throw error;
    },
    mkdirSync() { assert.fail('an unreadable token must not be treated as absent and replaced'); }
  };
  code(() => uac.loadOrCreateToken({
    clock: () => now, uptime: () => uptime, tokenFile, fs: unreadableToken
  }), 'UAC_TOKEN_UNAVAILABLE', 'unreadable token');
  code(() => uac.readToken({
    clock: () => now, uptime: () => uptime, tokenFile, fs: unreadableToken
  }), 'UAC_TOKEN_UNAVAILABLE', 'unreadable token');
  console.log('OK: a token read failure is refused rather than collapsed into an absent token');
});

// ---------------------------------------------------------------------------
// 7. Listener failures fail loudly without leaking the pipe name or OS detail.
// ---------------------------------------------------------------------------
async function listenerCollisionFailsLoudly() {
  const pipe = `\\\\.\\pipe\\ToolsEnabledUacCollision-${process.pid}-${crypto.randomUUID()}`;
  const blocker = net.createServer();
  blocker.listen(pipe);
  await once(blocker, 'listening');

  let observed;
  const candidate = helper.startHelper({
    pipeName: pipe, expectedToken: crypto.randomBytes(32), idleMs: false,
    onListenError: error => { observed = error; }
  });
  try {
    await once(candidate, 'error');
    assert.equal(observed && observed.code, 'EADDRINUSE', 'the collision is surfaced to the executable entry point');

    const writes = [];
    let exitCode;
    helper.reportListenFailure({
      write: value => writes.push(value),
      setExitCode: value => { exitCode = value; }
    });
    assert.deepEqual(writes, [`${helper.LISTEN_FAILURE_CODE}\n`], 'scheduled-task diagnostic is one stable sanitized code');
    assert.equal(exitCode, 1, 'scheduled-task result is nonzero on listener failure');
    assert.ok(!writes.join('').includes(pipe), 'listener diagnostic does not leak the pipe name');
    assert.ok(!writes.join('').includes('EADDRINUSE'), 'listener diagnostic does not leak OS error detail');
  } finally {
    try { candidate.close(); } catch {}
    await new Promise(resolve => blocker.close(resolve));
  }
  console.log('OK: named-pipe listener collision reports a sanitized code and nonzero task result');
}

// ---------------------------------------------------------------------------
// 8. Real named-pipe round trip through the helper server (NON-ELEVATED).
//    Exercises the transport + parse + decision + audit path end to end with a
//    runOperation stub. Real elevated execution is NOT performed here.
// ---------------------------------------------------------------------------
async function pipeRoundTrip() {
  const expectedToken = crypto.randomBytes(32);
  const allowlist = uac.parseAllowlist(rawAllowlist(), { ownerPrincipal: OWNER });
  const audit = makeMockAudit();
  const ran = [];
  const pipe = `\\\\.\\pipe\\ToolsEnabledUacTest-${process.pid}-${crypto.randomUUID()}`;
  const server = helper.startHelper({
    pipeName: pipe, expectedToken, allowlist, audit, killSwitch: killSwitch(false),
    idleMs: false, runOperation: (resolved) => { ran.push(resolved.id || 'op'); return { ok: true, steps: [{ ok: true }] }; }
  });
  await once(server, 'listening');

  const call = request => new Promise((resolve, reject) => {
    const client = net.createConnection(pipe);
    client.setEncoding('utf8');
    let buffer = '';
    client.on('connect', () => client.write(`${JSON.stringify(request)}\n`));
    client.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) { client.end(); resolve(JSON.parse(buffer.slice(0, end))); }
    });
    client.on('error', reject);
  });

  const accepted = await call({ type: 'operation', token: expectedToken.toString('base64url'), operation: 'restart-fleet-supervisor' });
  assert.equal(accepted.decision, 'accept', 'valid token + allowlisted op accepted over the pipe');
  assert.equal(accepted.protocolVersion, helper.PROTOCOL_VERSION);

  const refused = await call({ type: 'operation', token: crypto.randomBytes(32).toString('base64url'), operation: 'restart-fleet-supervisor' });
  assert.equal(refused.decision, 'refuse');
  assert.equal(refused.reason, 'token', 'bad token refused over the pipe');

  const denied = await call({ type: 'operation', token: expectedToken.toString('base64url'), operation: 'not-a-real-op' });
  assert.equal(denied.reason, 'not-allowlisted', 'unknown op refused over the pipe');

  assert.equal(ran.length, 1, 'only the accepted request executed');
  assert.ok(audit.events.filter(e => e.action === uac.DECISION_ACTION).length >= 3, 'every pipe request wrote a decision audit event');
  await new Promise(resolve => server.close(resolve));
  console.log('OK: named-pipe round trip accepts/refuses correctly and audits every request');
}

// ---------------------------------------------------------------------------
// 9. Explicitly unexecuted: real elevated execution of netsh/schtasks.
// ---------------------------------------------------------------------------
// Elevation alone is not permission to mutate machine configuration in an
// unattended suite. Preserve the missing coverage in the reconciled result;
// neither the offline operation stub nor a successful pipe round trip proves
// that privileged system commands were executed.
test('real elevated netsh/schtasks execution via a RunLevel-Highest task', {
  skip: 'requires a separately authorized machine-mutation integration run'
}, () => {
  assert.fail('this deterministic suite must not execute privileged system mutations');
});

// ---------------------------------------------------------------------------
// 10. Full UAC Bypass integration point (Q96): kill switch gate plus
//     decision/outcome audit, using the SAME mock audit ledger/kill switch
//     shape as the rest of this file -- never the production ledger.
// ---------------------------------------------------------------------------
test('full-bypass decisions preserve kill-switch and audit boundaries', () => {
  // Kill switch off: allowed.
  uac.checkFullBypassAllowed({ killSwitch: killSwitch(false) });
  // Kill switch on: refused with the specific code, not a generic throw.
  code(() => uac.checkFullBypassAllowed({ killSwitch: killSwitch(true) }), 'UAC_FULL_BYPASS_BLOCKED', 'kill switch engaged blocks Full UAC Bypass');

  // Decision audit: required (fail-closed) and carries the fixed schema; an
  // invalid requestedState is rejected before anything is recorded.
  const audit = makeMockAudit();
  code(() => uac.auditFullBypassDecision({ requestedState: 'sideways', decision: 'accept', reason: 'allowed' }, { audit }),
    'UAC_FULL_BYPASS_INVALID', 'unknown requestedState rejected');
  assert.equal(audit.events.length, 0, 'the rejected call recorded nothing');

  uac.auditFullBypassDecision({ requestedState: 'on', decision: 'accept', reason: 'allowed', principal: OWNER }, { audit });
  uac.auditFullBypassDecision({ requestedState: 'off', decision: 'refuse', reason: 'killswitch' }, { audit });
  assert.equal(audit.events.length, 2, 'both decisions recorded');
  assert.equal(audit.events[0].action, uac.FULL_BYPASS_DECISION_ACTION);
  assert.equal(audit.events[0].target, uac.FULL_BYPASS_TARGET);
  assert.equal(audit.events[0].details.principal, OWNER, 'decision audit carries the resolved principal, not a caller-asserted identity used for anything but logging');
  assert.equal(audit.events[1].details.decision, 'refuse');
  assert.equal(audit.events[1].details.principal, null, 'principal is optional and defaults to null, never fabricated');

  // A failing audit store must abort the caller BEFORE any effect -- same
  // fail-closed contract as DECISION_ACTION above (requireRecord throws).
  const brokenAudit = { requireRecord() { throw new Error('ledger unavailable'); } };
  assert.throws(() => uac.auditFullBypassDecision({ requestedState: 'on', decision: 'accept', reason: 'allowed' }, { audit: brokenAudit }),
    /ledger unavailable/, 'a broken audit store is NOT swallowed for the decision record');

  // Outcome audit: best-effort. A throwing audit store must not propagate --
  // the registry effect it is describing has already happened.
  uac.auditFullBypassOutcome({ requestedState: 'on', ok: true, appliedEnableLua: 0 }, { audit });
  uac.auditFullBypassOutcome({ requestedState: 'off', ok: false, error: new Error('access denied') }, { audit });
  assert.equal(audit.events.length, 4, 'both outcomes recorded');
  assert.equal(audit.events[2].action, uac.FULL_BYPASS_OUTCOME_ACTION);
  assert.equal(audit.events[2].details.appliedEnableLua, 0);
  assert.equal(audit.events[3].details.ok, false);
  assert.ok(audit.events[3].details.error.includes('access denied'));
  assert.doesNotThrow(() => uac.auditFullBypassOutcome({ requestedState: 'on', ok: true }, { audit: brokenAudit }),
    'a broken audit store must not throw back over an outcome that already happened');

  // A best-effort write may not undo an effect, but "the outcome was not
  // recorded" and "whether the outcome was recorded could not be established"
  // are observably distinct from a successful record.
  /* A LEDGER THAT FAILS ON THE PATH THIS ACTUALLY TAKES. `brokenAudit` above
     stubs only requireRecord, which is the DECISION path; the outcome path
     calls audit.record, so reusing it here tested a missing stub method
     (TypeError) rather than a failing ledger, and asserted a message the
     fixture could never produce. */
  const brokenOutcomeAudit = { record() { throw new Error('ledger unavailable'); } };
  const unestablished = uac.auditFullBypassOutcome({ requestedState: 'on', ok: true }, { audit: brokenOutcomeAudit });
  assert.deepEqual(unestablished, { recorded: false, error: 'ledger unavailable' },
    'caller can distinguish an established outcome audit from one that could not be established');

  /* And the ORIGINAL reuse still must not throw: a fixture missing the method
     entirely is one more way the audit is unestablished, not a crash. */
  assert.deepEqual(uac.auditFullBypassOutcome({ requestedState: 'on', ok: true }, { audit: brokenAudit }),
    { recorded: false, error: 'audit.record is not a function' },
    'an audit store missing the method is unestablished, not an exception');

  // This posture is never reachable through the fixed allowlist: no
  // operation id in the shipped config exposes it, and the state file lives
  // outside the token/allowlist path entirely.
  const shipped = uac.loadAllowlist({ ownerPrincipal: OWNER });
  assert.equal(shipped.operations.has('full-uac-bypass'), false, 'Full UAC Bypass has no allowlist operation id');
  assert.ok(path.win32.isAbsolute(uac.FULL_BYPASS_STATE_FILE));
  assert.ok(uac.FULL_BYPASS_STATE_FILE.endsWith('uac-full-bypass-state.json'));

  console.log('OK: Full UAC Bypass integration point -- kill switch gate, fail-closed decision audit, best-effort outcome audit, not on the standing allowlist');
});

// The owner principal is a Windows account name, and Windows account names are
// not ASCII. Measured 2026-08-19 in a sealed-build foreign run: USERNAME
// "Ana María López" made ownerPrincipal() throw UAC_OWNER_PRINCIPAL_INVALID,
// which mission-bridge writeRuntimeDiscovery() treats as fatal at boot -- the
// whole capability layer exited 1 on a machine whose only oddity was an accent
// in the person's name. The pattern must accept any letter or digit while still
// refusing every character that could break an icacls/schtasks argv value.
test('owner principals accept Unicode and refuse argv-breaking characters', () => {
  const accepted = [
    { USERDOMAIN: 'EQUIPO-DE-ANA', USERNAME: 'Ana María López' },
    { USERDOMAIN: '', USERNAME: 'José' },
    { USERDOMAIN: 'BÜRO', USERNAME: 'Müller' },
    { USERDOMAIN: '', USERNAME: 'Пётр' },
    { USERDOMAIN: '', USERNAME: '田中太郎' },
    { USERDOMAIN: 'TESTDOMAIN', USERNAME: 'owner' }
  ];
  for (const env of accepted) {
    const principal = uac.ownerPrincipal({ env });
    assert.ok(principal.includes(env.USERNAME), `accepts the account name ${env.USERNAME}`);
  }
  // The characters that would change the meaning of `${principal}:(F)` in the
  // icacls argument, or of a substituted allowlist step, stay refused.
  for (const bad of ['owner:(F)', 'owner"quoted', 'owner\nnewline', 'owner|pipe', 'owner$(cmd)', '']) {
    code(() => uac.ownerPrincipal({ env: { USERDOMAIN: '', USERNAME: bad } }),
      'UAC_OWNER_PRINCIPAL_INVALID', `refuses ${JSON.stringify(bad)}`);
  }
  console.log('OK: owner principal accepts real Windows account names (non-ASCII) and still refuses argv-breaking characters');
});

test('real named-pipe collision and request round trip preserve refusal and audit behavior', async () => {
  await listenerCollisionFailsLoudly();
  await pipeRoundTrip();
});


/* T454: A SLOW IDENTITY PROBE IS A WAIT, NOT A BROKEN MACHINE.
 *
 * ownerPrincipal() read the current Windows identity by spawning Windows
 * PowerShell with `timeout: 5000`, and one slow answer was a permanent
 * refusal. MEASURED on the build machine under full CPU load: that command
 * took 8876 ms, so the probe was killed, mission-bridge's
 * writeRuntimeDiscovery() threw, and the app logged
 * `[capability-layer] not started: CAPABILITY_EXITED`. No capability layer
 * means no agent session at all, and nothing retried.
 *
 * These drive ownerPrincipal() WITH VALUES through an injected
 * execFileSyncImpl, so they say what the probe must DO rather than which
 * program it happens to run: it must survive a probe that answers late, it
 * must not pay for a CLR when a cheaper tool can answer, and it must tell a
 * caller apart -- "nothing answered yet, retry" from "something answered and
 * it was invalid". The wait between attempts is injected too, so the suite
 * never actually sleeps. */

function identityProbes({ whoami = null, powershell = null } = {}) {
  const calls = [];
  const run = (file, args) => {
    const tool = /whoami/i.test(file) ? 'whoami' : /powershell/i.test(file) ? 'powershell' : 'other';
    calls.push({ tool, args });
    const answer = tool === 'whoami' ? whoami : powershell;
    if (typeof answer === 'function') return answer(calls.filter(entry => entry.tool === tool).length);
    if (answer === null || answer === undefined) {
      throw Object.assign(new Error(`${tool} is not available here`), { code: 'ENOENT' });
    }
    return answer;
  };
  return { calls, run, tools: () => calls.map(entry => entry.tool) };
}

// What whoami /user /fo csv /nh really prints, measured on this machine.
const WHOAMI_ROW = '"desktop-us8r1lb\\toolsenabled-dev","S-1-5-21-3785318353-1649235538-2134364065-1027"\r\n';
const TIMED_OUT = () => { throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }); };

test('an identity probe that answers late still yields the principal instead of refusing', () => {
  const probes = identityProbes({
    // Slower than any timeout on the first two attempts, then it answers --
    // exactly the loaded-machine shape that used to kill the capability layer.
    whoami: attempt => (attempt < 3 ? TIMED_OUT() : WHOAMI_ROW),
    powershell: TIMED_OUT,
  });
  const waits = [];
  const principal = uac.ownerPrincipal({
    platform: 'win32', execFileSyncImpl: probes.run, sleepSyncImpl: ms => waits.push(ms),
  });
  assert.equal(principal, 'desktop-us8r1lb\\toolsenabled-dev',
    'a probe that answered on a later attempt was still treated as a failure');
  assert.ok(waits.length >= 2, 'the retries did not back off at all');
  assert.ok(waits.some(ms => ms > 0), 'every backoff was zero, so a busy machine gets no room to answer');
});

test('the cheap identity probe is asked first and a CLR is not started when it answers', () => {
  const probes = identityProbes({ whoami: () => WHOAMI_ROW, powershell: () => { assert.fail('PowerShell was started even though whoami answered'); } });
  assert.equal(uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: probes.run, sleepSyncImpl: () => {} }),
    'desktop-us8r1lb\\toolsenabled-dev');
  assert.deepEqual(probes.tools(), ['whoami'],
    'the identity was read with more than the one tool that could answer it');
});

test('the shipped PowerShell probe still answers when the cheap one cannot', () => {
  const probes = identityProbes({ whoami: null, powershell: () => 'DESKTOP-US8R1LB\\ToolsEnabled-Dev\r\n' });
  assert.equal(uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: probes.run, sleepSyncImpl: () => {} }),
    'DESKTOP-US8R1LB\\ToolsEnabled-Dev',
    'removing the PowerShell fallback would leave a machine without whoami unable to start at all');
});

test('a probe that never answers is recoverable, and one that answers wrongly is not', () => {
  const silent = identityProbes({ whoami: TIMED_OUT, powershell: TIMED_OUT });
  code(() => uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: silent.run, sleepSyncImpl: () => {} }),
    'UAC_OWNER_PRINCIPAL_UNAVAILABLE',
    'a busy machine that never answered was reported as an invalid identity, which is what made it fatal');

  // "answered, but not a principal": a real answer, and permanently wrong.
  const wrong = identityProbes({ whoami: () => 'not-a-csv-row', powershell: () => 'nodomainhere' });
  code(() => uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: wrong.run, sleepSyncImpl: () => {} }),
    'UAC_OWNER_PRINCIPAL_INVALID',
    'an answered-but-invalid identity must stay permanent; retrying it forever would hide a real misconfiguration');
});

test('a probe answer that would break an icacls argument is still refused', () => {
  for (const hostile of ['"desktop\\owner:(F) everyone","S-1-5-21-1-2-3-4"', '"a|b\\c","S-1-5-21-1-2-3-4"']) {
    const probes = identityProbes({ whoami: () => hostile, powershell: () => 'DOMAIN\\ow|ner' });
    code(() => uac.ownerPrincipal({ platform: 'win32', execFileSyncImpl: probes.run, sleepSyncImpl: () => {} }),
      'UAC_OWNER_PRINCIPAL_INVALID',
      'the argv boundary check was lost when the probe changed');
  }
});
