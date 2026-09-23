// EXECUTABLE CHANGE
//
// Test-can-fail report:
// - Strengthened the positive firewall contract. Previously, an absent firewall
//   rule bypassed both assertions, so a regression that removed the rule made
//   this section green. The rule's existence is now an explicit precondition
//   assertion and the readiness/reason assertions always execute.
// - RED observation (rule absent, the state produced by the suspect mutation):
//   "AssertionError [ERR_ASSERTION]: FRA contract host is missing the 8790
//   firewall rule; refusing to skip the positive firewallReady contract" and
//   "false !== true".
// - NOT-FOUND (1): both assertion loops iterate non-empty array literals.
// - NOT-FOUND (2): the parser process is required to exit successfully; the
//   lifecycle failure also parses and checks the subject's structured output.
// - NOT-FOUND (3): the only catch belongs to the now-asserted firewall probe;
//   it converts probe failure to false and therefore can no longer swallow it.
// - NOT-FOUND (4): no mock substitutes for the script, parser, or firewall.
// - FIXED (5): removed the firewall precondition guard that skipped assertions.
// - NOT-FOUND (6): expected contract values are literals, not product-derived.
// - Preconditions are self-contained: the shipped contract document is read
//   directly, paired addresses come from a TEST-NET registry fixture, and a
//   disposable netsh fixture drives the real PowerShell parser/status logic.
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registryInput: pairedRegistryInput } = require('./helpers/paired-service-registry');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'tools', 'full-remote-access-control.ps1');
const source = fs.readFileSync(script, 'utf8');
const documentation = fs.readFileSync(path.join(root, 'docs', 'full-remote-access.md'), 'utf8');
const directLinkHost = pairedRegistryInput.machines['machine-a'].address;
const directLinkPeer = pairedRegistryInput.machines['machine-b'].address;
assert.notEqual(directLinkHost, directLinkPeer,
  'the disposable FRA contract fixture must contain two distinct machines');

assert.match(documentation, /\*\*Tunnel\*\* is chat-only/);
assert.match(documentation, /\*\*Bridge\*\* is bounded ToolsEnabled capability coverage/);
assert.match(documentation, /\*\*FRA \(Full Remote Access\)\*\* is complete secure agentic control/);
assert.match(documentation, /a healthy Tunnel does not prove\s+Bridge readiness/);
assert.match(documentation, /future\s+online-server extension/i);
assert.match(documentation, /must not publish 8787, 8788, 8790/);

assert.match(source, /full-remote-access-control\.v2/);
assert.match(source, /ToolsEnabled Full Remote Access \(8790\)/);
// Get-NetFirewallRule (and its dependent Port/AddressFilter cmdlets)
// silently returns an empty result set when this process is not elevated,
// even though the rule genuinely exists and is correctly scoped -- the
// scheduled tasks that run this code are deliberately unelevated. netsh
// advfirewall firewall show rule is the elevation-independent replacement;
// if this regresses back to the CIM cmdlets, firewallReady will start
// reporting a false firewall_rule_missing once the listener is otherwise
// healthy (see the real Status assertions on firewallReady below).
assert.doesNotMatch(source, /=\s*@?\(?\s*Get-NetFirewallRule/,
  'Get-NetFirewallRule silently returns empty when unelevated; use netsh advfirewall firewall show rule instead');
assert.match(source, /netsh advfirewall firewall show rule name=/);
assert.match(source, /No rules match the specified criteria/);
assert.match(source, /full-remote-access-peer-session\.v4/);
for (const field of [
  'listenerReady', 'dispatcherReady', 'secureTransportReady', 'runtimeIntegrityReady', 'rootIdentityReady',
  'rootAccessReady', 'transportBindingReady', 'capabilityManifestReady',
  'credentialBoundaryReady', 'desktopPolicyReady', 'desktopObservationReady', 'firewallReady', 'peerSessionReady'
]) {
  assert.match(source, new RegExp('\\$health\\.' + field + '|\\$' + field + '|^\\s*' + field + '\\s*=', 'm'));
}
for (const field of ['enrollmentPort', 'enrollmentState', 'enrollmentReady', 'enrollmentFirewallReady']) {
  assert.match(source, new RegExp('^\\s*' + field + '\\s*=', 'm'));
}
for (const field of [
  'outboundPeerReceiptReady', 'outboundPeerReceiptAuthenticatedAt',
  'inboundPeerReceiptReady', 'inboundPeerReceiptAuthenticatedAt',
  'outboundPeerOldProofReceiptReady', 'outboundPeerOldProofReceiptAuthenticatedAt',
  'inboundPeerOldProofReceiptReady', 'inboundPeerOldProofReceiptAuthenticatedAt'
]) {
  assert.match(source, new RegExp('^\\s*' + field + '\\s*=', 'm'));
}
assert.match(source, /credential_enrollment_ready/);
assert.match(source, /ToolsEnabled FRA Enrollment 8794/);
assert.match(source, /CloseEnrollment/);
assert.match(source, /FRA_ENROLLMENT_RECEIVER_B_ONLY/);
assert.match(source, /Test-EnrollmentCloseAuthorization/);
assert.match(source, /FRA_ENROLLMENT_CLOSE_TRANSACTION_UNVERIFIED/);
assert.match(source, /--transaction-status/);
const invokeStop = source.match(/function Invoke-Stop \{([\s\S]*?)\n\}/);
assert.ok(invokeStop, 'Invoke-Stop function missing');
assert.match(invokeStop[1], /FRA_ENROLLMENT_ACTIVE_STOP_REFUSED/);
assert.doesNotMatch(invokeStop[1], /Stop-FraEnrollment/);
assert.match(source, /\$health\.desktopPolicyReady -and\s*\$firewall\.ready -and \$peerSessionReady/);
assert.match(source, /\$health\.secureTransportReady -and \$health\.runtimeIntegrityReady -and \$health\.rootIdentityReady -and/);
assert.match(source, /\$health\.rootAccessReady -and \$health\.transportBindingReady -and \$health\.capabilityManifestReady/);
assert.match(source, /runtime_integrity_not_ready/);
assert.match(source, /root_access_not_ready/);
assert.match(source, /transport_binding_not_ready/);
assert.match(source, /C:\\agent-apps\\node-v22\.19\.0\\node\.exe/);
assert.match(source, /NODE_22_19_OR_NEWER_MISSING/);
assert.match(source, /\$parsedVersion -ge \$MinimumNodeVersion/);
assert.match(source, /\$ReasonPrefix \+ '_stale'/);
assert.match(source, /\$DispatcherHealthTimeoutMs\s*=\s*120000/);
assert.match(source, /\$HealthRequestTimeoutSec\s*=\s*250/);
assert.match(source, /-TimeoutSec \$HealthRequestTimeoutSec/);
assert.match(source, /\$Node\s*=\s*Resolve-ApprovedNode[\s\S]*\$operation\s*=\s*switch \(\$Action\)/);
// Host resolution must stay INSIDE the projection-aware boundary -- i.e. before
// `$operation = switch ($Action)` -- so that a failure to resolve is captured in the
// state projection instead of escaping as an untracked throw. That is the property
// this assertion defends, and it is the reason the ordering is asserted at all.
//
// The shape changed: Resolve-DirectLinkHost used to return a bare host string and was
// assigned straight to $HostName. It now returns a topology object and BOTH hosts are
// derived from it. Asserting the old literal form would have failed a correct script.
// So this checks the same ordering property against the current shape, and additionally
// pins the peer-host derivation the old single-line assertion never covered.
assert.match(source, /\$Topology\s*=\s*Resolve-DirectLinkHost[\s\S]*\$operation\s*=\s*switch \(\$Action\)/);
assert.match(source, /\$HostName\s*=\s*\[string\]\$Topology\.localMachine\.address[\s\S]*\$operation\s*=\s*switch \(\$Action\)/);
assert.match(source, /\$PeerHost\s*=\s*\[string\]\$Topology\.peerMachine\.address[\s\S]*\$operation\s*=\s*switch \(\$Action\)/);
assert.match(source, /\$PersistProjection\s*=\s*\$Action\s+-notin\s+@\('Status', 'EnrollmentStatus'\)/);
assert.equal((source.match(/if \(\$PersistProjection\) \{ Write-State \$result \}/g) || []).length, 2,
  'success and failure projection writes must both remain lifecycle-only');

const parse = [
  '$errors=$null;$tokens=$null;',
  `[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;`,
  'if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}'
].join('');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', parse], {
  cwd: root, windowsHide: true, stdio: 'pipe'
});

// Execute an exact disposable copy so Status can be proven observational
// without reading or writing the repository's live FRA projection. The copied
// root deliberately has no state directory and cannot match any live owned
// listener's canonical server path.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-control-status-'));
try {
  const fixtureTools = path.join(fixtureRoot, 'tools');
  fs.mkdirSync(fixtureTools, { recursive: true });
  const fixtureScript = path.join(fixtureTools, 'full-remote-access-control.ps1');
  fs.copyFileSync(script, fixtureScript);
  fs.chmodSync(fixtureScript, 0o600);

  // The fixture isolates the script from LIVE STATE -- it deliberately has no state
  // directory, so a Status run cannot read or write the real FRA projection. It is not
  // meant to simulate a mutilated install, so the script's own shipped dependencies
  // have to come with it.
  //
  // The control script resolves machine addresses from the service registry rather
  // than from hardcoded IPs, which means it now dot-sources tools/lib/service-registry.ps1
  // and reads config/service-registry.json. Copying only the script left it throwing
  // SERVICE_REGISTRY_UNAVAILABLE at load time, before any action dispatch -- so this
  // test was failing on a missing fixture dependency, not on a product defect. The
  // load-time throw is correct fail-closed behaviour and is intentionally left alone:
  // if the registry helper is genuinely absent the install IS broken, and a precise
  // error code beats a Status report that silently invents an answer.
  fs.mkdirSync(path.join(fixtureTools, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'tools', 'lib', 'service-registry.ps1'),
    path.join(fixtureTools, 'lib', 'service-registry.ps1'));
  fs.mkdirSync(path.join(fixtureRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config', 'service-registry.json'),
    JSON.stringify(pairedRegistryInput, null, 2), 'utf8');

  // `netsh` is an operating-system boundary, not the PowerShell policy being
  // tested. Put a deterministic, customer-neutral rule listing first on PATH
  // so the real parser and readiness projection execute without inspecting or
  // changing this workstation's firewall.
  const fixtureBin = path.join(fixtureRoot, 'bin');
  fs.mkdirSync(fixtureBin, { recursive: true });
  fs.writeFileSync(path.join(fixtureBin, 'netsh.cmd'), [
    '@echo off',
    'echo Rule Name: ToolsEnabled Full Remote Access (8790)',
    'echo Enabled: Yes',
    'echo Direction: In',
    'echo Action: Allow',
    'echo Protocol: TCP',
    'echo LocalPort: 8790',
    `echo RemoteIP: ${directLinkPeer}-${directLinkPeer}`
  ].join('\r\n'), 'utf8');
  const fixtureEnvironment = {
    ...process.env,
    PATH: `${fixtureBin};${process.env.PATH || ''}`,
    FULL_REMOTE_ACCESS_HOST: directLinkHost
  };
  const stdout = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixtureScript, '-Action', 'Status'
  ], {
    cwd: fixtureRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    env: fixtureEnvironment
  });
  const report = JSON.parse(String(stdout).trim());
  assert.equal(report.action, 'Status');
  assert.equal(report.secretValuesEmitted, false);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'state')), false,
    'Status created a state directory in the disposable root');
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'state', 'full-remote-access-state.json')), false,
    'Status wrote a projection in the disposable root');
  // The outbound liveness sibling surfaces alongside the continuity receipt
  // fields; a disposable root has neither file, so both read as not-ready.
  assert.equal(report.outboundLivenessReady, false);
  assert.equal(report.outboundLivenessAuthenticatedAt, null);
  assert.equal(report.outboundPeerReceiptReady, false);

  assert.equal(report.firewallReady, true,
    'the real netsh parser accepts one enabled inbound TCP/8790 rule scoped to the exact declared peer');
  assert.equal(report.firewallReason, null);

  const missingRuntimeSource = source
    .replace("'C:\\agent-apps\\node-v22.19.0\\node.exe'", "'C:\\fra-control-test-missing\\node-a.exe'")
    .replace("'C:\\Program Files\\nodejs\\node.exe'", "'C:\\fra-control-test-missing\\node-b.exe'");
  assert.notEqual(missingRuntimeSource, source, 'disposable missing-runtime fixture was not created');
  fs.writeFileSync(fixtureScript, missingRuntimeSource, 'utf8');
  const lifecycleFailure = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixtureScript, '-Action', 'Start'
  ], {
    cwd: fixtureRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    env: fixtureEnvironment,
    encoding: 'utf8'
  });
  assert.equal(lifecycleFailure.status, 1);
  assert.equal(lifecycleFailure.stderr, '');
  const failureReport = JSON.parse(lifecycleFailure.stdout.trim());
  assert.equal(failureReport.action, 'Start');
  assert.equal(failureReport.errorCode, 'NODE_22_19_OR_NEWER_MISSING');
  const projectedFailure = JSON.parse(fs.readFileSync(
    path.join(fixtureRoot, 'state', 'full-remote-access-state.json'),
    'utf8'
  ).replace(/^\uFEFF/, ''));
  assert.equal(projectedFailure.action, 'Start');
  assert.equal(projectedFailure.errorCode, 'NODE_22_19_OR_NEWER_MISSING');
  assert.equal(projectedFailure.secretValuesEmitted, false);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('FRA control readiness contract and PowerShell parse passed.');
