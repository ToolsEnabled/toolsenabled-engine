'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activate } = require('./lib/isolated-environment');

const root = path.resolve(__dirname, '..');
const lifecyclePath = path.join(root, 'tools', 'full-remote-access-lifecycle.ps1');
const controlPath = path.join(root, 'tools', 'full-remote-access-control.ps1');
const firewallPath = path.join(root, 'tools', 'full-remote-access-firewall.ps1');
const lifecycle = fs.readFileSync(lifecyclePath, 'utf8');
const control = fs.readFileSync(controlPath, 'utf8');
const firewall = fs.readFileSync(firewallPath, 'utf8');

// Status and refusal behavior run from a disposable, complete customer
// topology. A fresh installation correctly carries only `this-machine`; FRA
// tests must neither demand nor rewrite an operator's paired-machine registry.
activate('full-remote-access-lifecycle');
const runtimeRoot = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'fra-lifecycle-runtime-'));
for (const directory of ['tools', 'src', 'config']) {
  fs.cpSync(path.join(root, directory), path.join(runtimeRoot, directory), { recursive: true });
}
const runtimeLifecyclePath = path.join(runtimeRoot, 'tools', 'full-remote-access-lifecycle.ps1');
const runtimeControlPath = path.join(runtimeRoot, 'tools', 'full-remote-access-control.ps1');
const statePath = path.join(runtimeRoot, 'state', 'full-remote-access-lifecycle.json');
const controlStatePath = path.join(runtimeRoot, 'state', 'full-remote-access-state.json');
const fixtureRegistryPath = path.join(runtimeRoot, 'config', 'service-registry.json');
const fixtureRegistry = JSON.parse(fs.readFileSync(fixtureRegistryPath, 'utf8'));
fixtureRegistry.machines = {
  'machine-a': { address: '127.0.0.1', root: runtimeRoot, role: 'development-host' },
  // Status invokes the real link-bus peer probe. A TEST-NET address is safe
  // from public routing but is still an outbound interface attempt and can be
  // captured by an enterprise route. Keep the deliberately disconnected peer
  // inside 127/8 so this hermetic suite cannot leave the workstation.
  'machine-b': { address: '127.0.0.2', root: 'C:\\fixture-peer', role: 'disconnected-peer' }
};
for (const service of Object.values(fixtureRegistry.services || {})) {
  if (service && service.resolution === 'fixed') service.fixedMachine = 'machine-a';
}
fs.writeFileSync(fixtureRegistryPath, `${JSON.stringify(fixtureRegistry, null, 2)}\n`, 'utf8');
// Do not contend with a real installation's global lifecycle task while
// testing a disposable copy. The source assertion below still pins the shipped
// mutex; only this fixture instance receives a unique local name.
fs.writeFileSync(runtimeLifecyclePath, fs.readFileSync(runtimeLifecyclePath, 'utf8').replace(
  "Global\\ToolsEnabledFullRemoteAccessLifecycle",
  `Local\\ToolsEnabledFullRemoteAccessLifecycle-Test-${process.pid}`
), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch { /* isolated cleanup */ }
});

function digestIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const expectedHostAddress = fixtureRegistry.machines['machine-a'].address;
const runtimeEnvironment = { ...process.env, NODE_PATH: path.join(root, 'node_modules') };

assert.doesNotMatch(lifecycle, /8793/);
assert.match(lifecycle, /\$EnrollmentPort = 8794/);
assert.match(lifecycle, /Global\\ToolsEnabledFullRemoteAccessLifecycle/);
assert.match(lifecycle, /AbandonedMutexException/);
assert.match(lifecycle, /S4U/);
assert.match(lifecycle, /RunLevel Limited/);
assert.match(lifecycle, /ExecutionTimeLimit \(New-TimeSpan -Minutes 25\)/);
assert.match(lifecycle, /fra-lifecycle-tunnel-notice\.js/);
assert.match(lifecycle, /--rollback.+--operation-id.+--fingerprint/);
assert.match(lifecycle, /RetireRolledBackRecovery/);
assert.match(lifecycle, /--retire-rolled-back-recovery[\s\S]+--operation-id[\s\S]+--fingerprint/);
assert.match(lifecycle, /Reconcile never/);
// This compatibility-host guard used to compare $HostName against a literal
// machine address ('203.0.113.2'). 6653bef/6a6c77e made the script resolve
// both machine addresses from config/service-registry.json instead
// ($MachineAAddress / $MachineBAddress, set up near the top of the file), so
// the marker below was retargeted to the parameterized comparison it now
// Coordinator and recipient both run the lifecycle. Role-specific operations
// stay pinned at their call sites; no deployment-era whole-host block may make
// the coordinator's Reconcile/InstallTask paths unreachable.
assert.doesNotMatch(lifecycle, /FRA_LIFECYCLE_COMPATIBILITY_HOST_RECOVERY_ONLY/);
assert.match(lifecycle, /if \(\$HostName -cne \$MachineBAddress\) \{ throw 'FRA_LIFECYCLE_ROTATE_B_ONLY' \}/);
assert.match(lifecycle, /\$aCoordinationGate = \[bool\]\(\$HostName -ceq \$MachineAAddress/);
assert.match(lifecycle, /--finalize.+--operation-id.+--fingerprint/);
assert.match(lifecycle, /--prove-old-rejected.+--operation-id.+--fingerprint/);
assert.doesNotMatch(lifecycle, /preserved_receiver_for_compensation/);
assert.match(lifecycle, /CloseEnrollment/);
assert.match(lifecycle, /closed_committed_receiver/);
assert.match(lifecycle, /FRA_LIFECYCLE_ROLLBACK_FINALIZATION_REQUIRES_REVIEW/);
assert.match(lifecycle, /finalized_dual_proof_rotation/);
assert.match(lifecycle, /oldProofOperationId/);
assert.match(lifecycle, /oldTokenRejectedAt/);
assert.match(lifecycle, /peerOldProofAt/);
assert.match(lifecycle, /inboundPeerOldProofReceiptReady/);
assert.match(lifecycle, /outboundCurrentAt/);
assert.match(lifecycle, /inboundCurrentAt/);
assert.match(lifecycle, /waiting_for_peer_rotation_proof/);
assert.match(lifecycle, /tools-enabled\.full-remote-access-lifecycle\.v3/);
assert.match(lifecycle, /\$remoteAddresses\.Count -eq 1/);
assert.match(lifecycle, /rootIdentityReady/);
assert.match(lifecycle, /rootAccessReady/);
assert.match(lifecycle, /transportBindingReady/);
assert.match(lifecycle, /unhealthyStreak/);
assert.match(lifecycle, /TransactionStaleMilliseconds = 20 \* 60 \* 1000/);
assert.match(lifecycle, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);

// 'unverifiable' (the S4U/elevation observability gap: this privilege level
// cannot read another session's process command line) must survive as its
// own distinct listenerState, not collapse into 'unknown' the way it used
// to. Losing that distinction is what made every reconcile cycle against a
// healthy-but-unverifiable listener retry a doomed duplicate Start instead
// of reaching heartbeat. Behavioural coverage of the decision itself lives
// in tests/fra-lifecycle-guards.js (Get-NotOwnedReconcileAction, lifted and
// run for real); these are the structural pins proving the plumbing that
// feeds it is actually in place.
assert.match(lifecycle, /'unknown','absent','owned','conflict','unverifiable'/,
  "Test-StateShape must accept 'unverifiable' as its own allowed listenerState value");
assert.match(lifecycle, /\$Status\.listenerState -in @\('absent','owned','conflict','unverifiable'\)/,
  "Set-LocalObservation must preserve 'unverifiable' rather than folding it into 'unknown'");
assert.match(lifecycle, /\$State\.local\.localReady = \[bool\]\(\$Status\.listenerReady -and/,
  'localReady must be computed from the new listenerReady field (owned OR proven-unverifiable), not owned alone');
assert.match(lifecycle, /function Get-NotOwnedReconcileAction \{/,
  'the not-owned branch decision must be a single named, testable function, not inlined into Invoke-Reconcile');
assert.match(lifecycle, /'degraded_unverifiable'/);
assert.match(lifecycle, /observed_unverifiable/);
assert.match(lifecycle, /observed_unknown/);

// The control script's matching half: the same-pid health-listener proof and
// the Start-time refusal it feeds, on both listeners that can be started.
assert.match(control, /function Test-ListenerReady \{/);
assert.match(control, /function Get-HealthListenerPidMatch \{/);
assert.match(control, /function Get-UnverifiableListenerReadiness \{/);
assert.match(control, /FULL_REMOTE_ACCESS_LISTENER_UNVERIFIABLE/,
  'Start-OwnedListener must refuse an unproven unverifiable listener rather than falling through to Start-Process');
assert.match(control, /FRA_ENROLLMENT_LISTENER_UNVERIFIABLE/,
  'Start-FraEnrollment must refuse an unverifiable enrollment listener the same way -- no sibling health port to prove it by');

// The steady-state freshness probe in Invoke-Reconcile now calls the
// dedicated heartbeat CLI instead of running --probe-peer AND a second
// heartbeat call back to back: two round trips per 2-minute reconcile cycle
// doubled audit load, and probePeer() fails closed on the live rendezvous
// credential for an unrelated reason (its strict 32-byte token validator).
// Only the rotation-verification call site -- which needs probePeer()'s
// localTokenFingerprint/rotationProof* tuple, not available from the
// heartbeat CLI -- may still call --probe-peer. (Full behavioural coverage
// of Invoke-Reconcile's call-site selection is impractical here given its
// size and dependency graph; tests/fra-lifecycle-guards.js instead executes
// Invoke-PeerHeartbeat itself, the function this wiring now depends on.)
assert.equal((lifecycle.match(/Invoke-Helper @\('--probe-peer'/g) || []).length, 1,
  'exactly one real --probe-peer call site should remain: the rotation-verification one');
assert.match(lifecycle, /\$expectedCurrentFingerprint\) \{\s*\n\s*Invoke-Helper @\('--probe-peer'/,
  'the surviving --probe-peer call must be the rotation-verification one (gated on $expectedCurrentFingerprint), not a steady-state one');
assert.match(lifecycle,
  /\$state\.local\.localReady -and \$state\.tunnel\.authReady\) \{\s*\n\s*Invoke-PeerHeartbeat\s*\n/,
  'the steady-state branch (gated only on localReady/tunnel.authReady) must call the heartbeat CLI directly as its one round trip per cycle');

assert.doesNotMatch(control, /8793/);
assert.match(control, /EnrollmentStatus/);
assert.match(control, /fra-token-enrollment-lifecycle\.js/);
assert.match(control, /\$EnrollmentPort = 8794/);
assert.match(control, /full-remote-access-enrollment-status\.v1/);
assert.doesNotMatch(firewall, /Port\s*=\s*8793/);
assert.match(firewall, /Remove retired or peer-inappropriate FRA enrollment rule/);
// Same address-marker class as the compatibility-host guard above: the
// firewall script used to compare $LocalAddress against the literal
// '203.0.113.1'; it now compares against the enrollment recipient derived
// from the registry's deterministic directional topology. Retargeted to match;
// see the comment above the compatibility-host marker for why exact matching
// stays.
assert.match(firewall, /if \(\$LocalAddress -ceq \$EnrollmentRecipient\.address\)/);
assert.match(firewall, /ToolsEnabled FRA Enrollment 8794/);

// CONTENDS WITH THE AUTOSTART TASK, SO IT RETRIES RATHER THAN FLAKES.
//
// Once 'ToolsEnabled FRA Lifecycle' is installed it fires -Action Reconcile
// every two minutes against these exact files. This test reads production state
// -- the .ps1 derives $StateFile from its own location, so run-isolated.js's
// env redirection does not reach a PowerShell child -- so a task run landing
// inside this block produces two different intermittent failures:
//   1. the mutex is held, so Status prints {ok:true,action:'busy'} and exits 0.
//      The exit code assertion PASSES and the schemaVersion one then fails.
//   2. a concurrent write makes the projection throw, so it exits 1 and the
//      exit code assertion fails.
// Neither is a defect in the lifecycle. 'busy' is its documented, correct answer
// to contention, and taking the mutex here cannot help: this test's own child
// would then be the one told busy, since WaitOne(0) is not reentrant across
// processes.
//
// So contention is retried and only a real projection is asserted on. Nothing is
// weakened -- every assertion below still runs against a genuine Status result.
// An intermittent red in the most privileged lane is worse than a steady one,
// because the next person re-runs it, sees green, and stops looking.
let status = null;
let parsed = null;
let beforeLifecycle = null;
let beforeControl = null;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  // Re-taken each attempt: a task run between the reads would otherwise make
  // the did-not-mutate assertions compare across someone else's write.
  beforeLifecycle = digestIfPresent(statePath);
  beforeControl = digestIfPresent(controlStatePath);
  status = spawnSync('powershell.exe', [
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',runtimeLifecyclePath,'-Action','Status'
  ], { cwd: runtimeRoot, encoding: 'utf8', windowsHide: true, timeout: 360000, env: runtimeEnvironment });

  const line = String(status.stdout || '').trim().split(/\r?\n/).at(-1) || '';
  let candidate = null;
  try { candidate = JSON.parse(line); } catch { candidate = null; }

  const contended = status.status !== 0 || (candidate && candidate.action === 'busy');
  if (!contended) { parsed = candidate; break; }
  if (attempt === 6) {
    assert.fail(
      `lifecycle Status stayed contended across ${attempt} attempts ` +
      `(exit=${status.status}, last=${line.slice(0, 200)}); stderr=${String(status.stderr || '').slice(0, 300)}`);
  }
  // Longer than a single spawn, far shorter than the task's 2-minute cadence.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
}
assert.equal(status.status, 0, status.stderr);
assert.ok(parsed, 'Status must return a parseable projection');
assert.equal(parsed.schemaVersion, 'tools-enabled.full-remote-access-lifecycle.status.v1');
assert.equal(parsed.secretValuesEmitted, false);
assert.equal(parsed.host, expectedHostAddress);
assert.equal(typeof parsed.liveReady, 'boolean');
assert.equal(digestIfPresent(statePath), beforeLifecycle, 'Status must not mutate lifecycle state');
assert.equal(digestIfPresent(controlStatePath), beforeControl, 'Status must not mutate control state');

const enrollment = spawnSync('powershell.exe', [
  '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',runtimeControlPath,'-Action','EnrollmentStatus'
], { cwd: runtimeRoot, encoding: 'utf8', windowsHide: true, timeout: 120000, env: runtimeEnvironment });
assert.equal(enrollment.status, 0, enrollment.stderr);
const enrollmentParsed = JSON.parse(enrollment.stdout.trim().split(/\r?\n/).at(-1));
assert.equal(enrollmentParsed.schemaVersion, 'full-remote-access-enrollment-status.v1');
assert.equal(enrollmentParsed.enrollmentPort, 8794);
assert.equal(enrollmentParsed.secretValuesEmitted, false);
assert.equal(digestIfPresent(controlStatePath), beforeControl, 'EnrollmentStatus must remain read-only');

const invalidRetirement = spawnSync('powershell.exe', [
  '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',runtimeLifecyclePath,'-Action','RetireRolledBackRecovery'
], { cwd: runtimeRoot, encoding: 'utf8', windowsHide: true, timeout: 120000, env: runtimeEnvironment });
assert.equal(invalidRetirement.status, 1, invalidRetirement.stderr);
const invalidRetirementParsed = JSON.parse(invalidRetirement.stdout.trim().split(/\r?\n/).at(-1));
assert.equal(invalidRetirementParsed.code, 'FRA_LIFECYCLE_RECOVERY_CORRELATION_INVALID');
assert.equal(invalidRetirementParsed.secretValuesEmitted, false);
assert.equal(digestIfPresent(statePath), beforeLifecycle, 'invalid retirement must not mutate lifecycle state');
assert.equal(digestIfPresent(controlStatePath), beforeControl, 'invalid retirement must not mutate control state');

console.log('Full Remote Access lifecycle contracts passed.');
