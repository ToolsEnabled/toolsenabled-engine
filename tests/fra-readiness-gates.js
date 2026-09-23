// EXECUTABLE CHANGE
//
// Discrimination report (2026-08-26): four table-driven assertion groups could
// become vacuous if their case tables were emptied.  Each now asserts its table
// is non-empty before iterating.  In a scratch copy, mutating each table to []
// produced RED respectively:
//   "AssertionError [ERR_ASSERTION]: digest rejection cases must not be empty"
//   "AssertionError [ERR_ASSERTION]: sibling receipt gate cases must not be empty"
//   "AssertionError [ERR_ASSERTION]: listener health gate cases must not be empty"
//   "AssertionError [ERR_ASSERTION]: non-ready listener state cases must not be empty"
// After restoring all four tables byte-for-byte, the fenced Windows run
// executes the real extracted PowerShell gates against disposable receipts.
//
// NOT-FOUND: exit-status/truthy-only process assertions; swallowed target
// failures in try/catch or optional chains; assertions against a mock of the
// subject; platform skips or silent precondition guards; expected values
// computed by the code being checked. Paired topology is supplied by a
// validated TEST-NET fixture; the shipped registry remains untouched.
'use strict';
// Behavioural coverage for the FRA peer-receipt readiness gate.
//
// WHY THIS EXISTS. On 2026-08-02 both machines reported peer_receipt_invalid for
// a full day while the credential, the digests, the anchors and the session were
// all genuinely correct. The cause was operator precedence in
// Get-PeerReceiptReadiness: a pipeline binds looser than -or, so
//
//     (clause -or clause -or @('contextDigest', ...)) | Where-Object { ... }
//
// evaluated the whole boolean chain first, took $true from the non-empty array
// literal, piped THAT into Where-Object, and the block tested $receipt.True --
// a property no receipt has. It returned _invalid for EVERY receipt. There was
// no input that could pass.
//
// It survived because tests/full-remote-access-control-contract.js is ~60
// assertions of assert.match(source, /regex/). Every one checks that the code
// LOOKS right. Nothing in the suite ever CALLED the function. A gate that could
// never say yes passed the entire suite, because the suite only ever read it.
//
// So this file EXECUTES the real function body, lifted from the real script, and
// the load-bearing assertion is the positive one: a receipt whose every field is
// valid must come back ready. A gate that cannot say yes is itself a failure,
// and that is the case no amount of source-reading would have caught.
//
// It deliberately does not modify tools/full-remote-access-control.ps1 to add a
// test hook. That file is one of the 43 anchored runtime inputs, so touching it
// forces a coordinated re-anchor on both machines. The function text is extracted
// and run instead.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registry: pairedRegistry } = require('./helpers/paired-service-registry');

const ROOT = path.resolve(__dirname, '..');
const CONTROL_SCRIPT = path.join(ROOT, 'tools', 'full-remote-access-control.ps1');

// The machine addresses come from the service registry, never from literals here.
// The control script used to compare $HostName against a hardcoded address; it now
// resolves the address from the registry, and a test that kept its own copy of the
// literal would silently stop testing the real comparison the moment an address
// changed -- the exact drift the registry exists to prevent. Reading it here means
// this harness is wrong in the same way the product is wrong, or not at all.
function registryAddress(machineId) {
  const machine = (pairedRegistry.machines || {})[machineId];
  const address = machine && machine.address;
  assert.ok(typeof address === 'string' && address !== '',
    `the validated paired-machine fixture must declare an address for ${machineId}`);
  return address;
}
const MACHINE_A_ADDRESS = registryAddress('machine-a');
const MACHINE_B_ADDRESS = registryAddress('machine-b');
const HOST_NAME = MACHINE_A_ADDRESS;
const PEER_HOST = MACHINE_B_ADDRESS;
const HEX64 = 'a'.repeat(64);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('fra-readiness-gates\n');

// --- lift the real function out of the real script ---------------------------
// Brace-matching cannot be naive here: the body contains '^[a-f0-9]{64}$', so a
// counter would trip on the regex quantifier. The file's style closes top-level
// functions with a '}' in column 0, which is unambiguous.
const controlSource = fs.readFileSync(CONTROL_SCRIPT, 'utf8');
const gateMatch = controlSource.match(
  /^function Get-PeerReceiptReadiness \{$[\s\S]*?^\}$/m
);
assert.ok(gateMatch, 'Get-PeerReceiptReadiness must be extractable from the control script');
const GATE_TEXT = gateMatch[0];

const livenessGateMatch = controlSource.match(
  /^function Get-OutboundLivenessReadiness \{$[\s\S]*?^\}$/m
);
assert.ok(livenessGateMatch, 'Get-OutboundLivenessReadiness must be extractable from the control script');
const LIVENESS_GATE_TEXT = livenessGateMatch[0];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-gate-'));

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 'full-remote-access-peer-session.v4',
    protocolVersion: 2,
    localHost: HOST_NAME,
    peerHost: PEER_HOST,
    secretValuesEmitted: false,
    generation: 9,
    authenticatedAt: new Date().toISOString(),
    registryNameDigest: HEX64,
    allowedToolNamesDigest: HEX64,
    contextDigest: HEX64,
    deviceIdentityDigest: HEX64,
    rootIdentityDigest: HEX64,
    rootAclDigest: HEX64,
    runtimeDigest: HEX64,
    policyDigest: HEX64,
    capabilityProfileDigest: HEX64,
    resultProjectorDigest: HEX64,
    ...overrides
  };
}

let harnessSeq = 0;
// Runs the extracted gate against a receipt and returns its projection.
// `gateText` is a parameter so the same harness can run the historical buggy
// form and prove this test discriminates between them. `ignoreAge` exercises
// the -IgnoreAge switch that lets Get-StatusReport ask "is this a
// structurally valid, correctly bound continuity receipt" without also
// asking "was it written recently" -- the freshness question a stale
// outbound receipt could never answer yes to again, now answered instead by
// Get-OutboundLivenessReadiness.
function runGate(receipt, { gateText = GATE_TEXT, writeFile = true, raw = null, ignoreAge = false } = {}) {
  harnessSeq += 1;
  const receiptPath = path.join(scratch, `receipt-${harnessSeq}.json`);
  if (writeFile) {
    fs.writeFileSync(receiptPath, raw !== null ? raw : JSON.stringify(receipt, null, 2));
  }
  const harnessPath = path.join(scratch, `harness-${harnessSeq}.ps1`);
  fs.writeFileSync(harnessPath, [
    "$ErrorActionPreference = 'Stop'",
    '$ReceiptPath = $args[0]',
    '$HostName = $args[1]',
    '$PeerHost = $args[2]',
    '$PeerReceiptFile = $ReceiptPath',
    '',
    gateText,
    '',
    ignoreAge
      ? '$result = Get-PeerReceiptReadiness -ReceiptPath $ReceiptPath -IgnoreAge'
      : '$result = Get-PeerReceiptReadiness -ReceiptPath $ReceiptPath',
    '[pscustomobject]@{',
    '  ready = [bool]$result.ready',
    '  reason = [string]$result.reason',
    '} | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');

  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
      receiptPath, HOST_NAME, PEER_HOST],
    { windowsHide: true, encoding: 'utf8' }
  );
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

let livenessHarnessSeq = 0;
// Runs the extracted Get-OutboundLivenessReadiness against a liveness
// projection (or raw text) and returns its result.
function runLivenessGate(liveness, { writeFile = true, raw = null } = {}) {
  livenessHarnessSeq += 1;
  const livenessPath = path.join(scratch, `liveness-${livenessHarnessSeq}.json`);
  if (writeFile) {
    fs.writeFileSync(livenessPath, raw !== null ? raw : JSON.stringify(liveness, null, 2));
  }
  const harnessPath = path.join(scratch, `liveness-harness-${livenessHarnessSeq}.ps1`);
  fs.writeFileSync(harnessPath, [
    "$ErrorActionPreference = 'Stop'",
    '$LivenessPath = $args[0]',
    '$HostName = $args[1]',
    '$PeerHost = $args[2]',
    '$PeerLivenessFile = $LivenessPath',
    '',
    LIVENESS_GATE_TEXT,
    '',
    '$result = Get-OutboundLivenessReadiness -LivenessPath $LivenessPath',
    '[pscustomobject]@{',
    '  ready = [bool]$result.ready',
    '  reason = [string]$result.reason',
    '} | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');

  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
      livenessPath, HOST_NAME, PEER_HOST],
    { windowsHide: true, encoding: 'utf8' }
  );
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

function validLiveness(overrides = {}) {
  return {
    schemaVersion: 'full-remote-access-peer-liveness.v1',
    authenticatedAt: new Date().toISOString(),
    localHost: HOST_NAME,
    peerHost: PEER_HOST,
    secretValuesEmitted: false,
    ...overrides
  };
}

// --- THE ASSERTION THAT MATTERS ----------------------------------------------
check('a receipt whose every field is valid is ACCEPTED', () => {
  const result = runGate(validReceipt());
  assert.equal(result.ready, true,
    'a fully valid receipt must be accepted; a gate with no passing input is broken ' +
    'regardless of how correct its source reads');
  assert.equal(result.reason, '', 'an accepted receipt carries no reason');
});

// --- and it still discriminates ----------------------------------------------
const DIGEST_REJECTION_CASES = [
  'contextDigest', 'deviceIdentityDigest', 'rootIdentityDigest', 'rootAclDigest',
  'runtimeDigest', 'policyDigest', 'capabilityProfileDigest', 'resultProjectorDigest'
];
assert.ok(DIGEST_REJECTION_CASES.length > 0, 'digest rejection cases must not be empty');
for (const field of DIGEST_REJECTION_CASES) {
  check(`a non-hex ${field} is refused`, () => {
    const result = runGate(validReceipt({ [field]: 'not-a-digest' }));
    assert.equal(result.ready, false, `${field} must be validated`);
    assert.equal(result.reason, 'peer_receipt_invalid');
  });
}

check('a non-hex registryNameDigest is refused', () => {
  const result = runGate(validReceipt({ registryNameDigest: 'zz' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('a wrong schemaVersion is refused', () => {
  const result = runGate(validReceipt({ schemaVersion: 'full-remote-access-peer-session.v3' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('a receipt addressed to another host is refused', () => {
  const result = runGate(validReceipt({ localHost: '203.0.113.9' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('secretValuesEmitted true is refused', () => {
  const result = runGate(validReceipt({ secretValuesEmitted: true }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('a path-disclosing bridgeRoot property is refused', () => {
  const result = runGate(validReceipt({ bridgeRoot: 'C:\\somewhere' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('generation 0 is refused', () => {
  const result = runGate(validReceipt({ generation: 0 }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('an expired receipt is refused as stale, not invalid', () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const result = runGate(validReceipt({ authenticatedAt: old }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_stale',
    'age and shape are different failures and must stay distinguishable');
});

check('a missing receipt file reads as missing, not invalid', () => {
  const result = runGate(null, { writeFile: false });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_missing');
});

check('unparseable JSON reads as unreadable, not invalid', () => {
  const result = runGate(null, { raw: '{ not json' });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_unreadable');
});

// --- proof that this test would have caught the real defect -------------------
// Reconstructs the historical form and runs the SAME valid receipt through it.
// If this ever stops failing, the test has lost its power to detect the bug.
check('the pre-fix form rejected even a valid receipt (this test discriminates)', () => {
  const buggy = GATE_TEXT
    .replace(/\(\$\((\s*'contextDigest')/, '@($1')
    .replace(/\}\)\)(\s*\{)/, '})$1');
  assert.notEqual(buggy, GATE_TEXT,
    'could not reconstruct the pre-fix form; if the gate was restructured, rewrite this case ' +
    'rather than deleting it');

  const result = runGate(validReceipt(), { gateText: buggy });
  assert.equal(result.ready, false,
    'the pre-fix form must reject a valid receipt; if it now accepts one, this case no longer ' +
    'proves the test can detect the precedence bug');
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('the parentheses that fix it are still present in the live script', () => {
  assert.match(controlSource, /\(\$\('contextDigest'/,
    'the array must stay wrapped so the pipeline cannot swallow the -or chain');
});

// --- the sibling gates share this body and must keep distinct reasons ---------
check('all four receipt gates route through one function with distinct prefixes', () => {
  const siblingReceiptGates = [
    ['Get-InboundPeerReceiptReadiness', 'inbound_peer_receipt'],
    ['Get-PeerOldProofReceiptReadiness', 'peer_old_proof_receipt'],
    ['Get-InboundPeerOldProofReceiptReadiness', 'inbound_peer_old_proof_receipt']
  ];
  assert.ok(siblingReceiptGates.length > 0, 'sibling receipt gate cases must not be empty');
  for (const [fn, prefix] of siblingReceiptGates) {
    assert.match(controlSource, new RegExp(`function ${fn} \\{`),
      `${fn} must exist`);
    assert.match(controlSource, new RegExp(`-ReasonPrefix '${prefix}'`),
      `${fn} must pass a distinct reason prefix so its failures stay attributable`);
  }
});

// --- -IgnoreAge: continuity readiness decoupled from freshness ----------------
check('a stale receipt is REFUSED without -IgnoreAge (existing behaviour, unchanged)', () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const result = runGate(validReceipt({ authenticatedAt: old }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'peer_receipt_stale');
});

check('the SAME stale receipt is ACCEPTED with -IgnoreAge', () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const result = runGate(validReceipt({ authenticatedAt: old }), { ignoreAge: true });
  assert.equal(result.ready, true,
    '-IgnoreAge must let a structurally valid receipt read as ready regardless of age; that is the ' +
    'whole point of separating continuity from freshness');
  assert.equal(result.reason, '');
});

check('-IgnoreAge does not weaken any OTHER validation -- a structurally invalid receipt is still refused', () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const result = runGate(validReceipt({ authenticatedAt: old, generation: 0 }), { ignoreAge: true });
  assert.equal(result.ready, false,
    '-IgnoreAge must only bypass the age check, not shape/digest/rotation validation');
  assert.equal(result.reason, 'peer_receipt_invalid');
});

check('a fresh receipt is accepted identically with or without -IgnoreAge', () => {
  const withoutIgnore = runGate(validReceipt());
  const withIgnore = runGate(validReceipt(), { ignoreAge: true });
  assert.equal(withoutIgnore.ready, true);
  assert.equal(withIgnore.ready, true);
});

// --- Get-OutboundLivenessReadiness: the new freshness-only sibling ------------
check('a freshly written liveness projection is ACCEPTED', () => {
  const result = runLivenessGate(validLiveness());
  assert.equal(result.ready, true);
  assert.equal(result.reason, '');
});

check('a stale liveness projection is refused as stale, matching the receipt gate\'s own bound', () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const result = runLivenessGate(validLiveness({ authenticatedAt: old }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_stale');
});

check('a missing liveness file reads as missing, not invalid', () => {
  const result = runLivenessGate(null, { writeFile: false });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_missing');
});

check('unparseable liveness JSON reads as unreadable', () => {
  const result = runLivenessGate(null, { raw: '{ not json' });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_unreadable');
});

check('a liveness projection addressed to another host is refused', () => {
  const result = runLivenessGate(validLiveness({ localHost: '203.0.113.9' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_invalid');
});

check('a wrong liveness schemaVersion is refused', () => {
  const result = runLivenessGate(validLiveness({ schemaVersion: 'full-remote-access-peer-liveness.v0' }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_invalid');
});

check('secretValuesEmitted true is refused for liveness too', () => {
  const result = runLivenessGate(validLiveness({ secretValuesEmitted: true }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'outbound_liveness_invalid');
});

check('the liveness gate carries no continuity/digest/rotation fields -- it validates identity and time only', () => {
  assert.doesNotMatch(LIVENESS_GATE_TEXT, /contextDigest|rootAclDigest|rotationKind/,
    'Get-OutboundLivenessReadiness must stay a thin freshness check, not grow the continuity receipt\'s ' +
    'validation surface');
});

// --- listenerReady: the S4U/elevation unverifiable-listener readiness proof --
//
// WHY THIS EXISTS. B's FRA listener was started elevated during an incident.
// The scheduled reconcile task runs unelevated (deliberately, S4U), so it
// cannot read the elevated listener's command line -- Get-ExactListener
// correctly reports listenerState='unverifiable', NOT 'owned' (see the
// comment at the top of Get-ExactListener: callers must not act on a reading
// this privilege level could not make). But the old $operational computation
// gated on $identity.owned directly, so every reconcile cycle against a
// healthy-but-unverifiable listener attempted a doomed duplicate Start (the
// port was already bound) and heartbeat was never reached that cycle.
//
// listenerReady is the fix: owned OR (state == 'unverifiable' AND the
// loopback health listener on 127.0.0.1:8792 is proven to be the SAME
// process by PID AND every health gate passes). It is deliberately a
// SEPARATE field from owned -- owned keeps meaning "positively identified",
// full stop, and stays visible unchanged. The two are allowed to disagree;
// that is the point, not a bug.
function lift(name) {
  const match = controlSource.match(new RegExp(`^function ${name} \\{$[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(match, `${name} must be extractable from the control script`);
  return match[0];
}

const LISTENER_READY_FUNCS = [
  lift('Test-HealthListenerPidMatch'),
  lift('Test-ListenerReady')
].join('\n\n');

let listenerReadySeq = 0;
// Runs a PowerShell expression against the lifted pure functions and returns
// its JSON-serialised result. `pids` builds a $Listeners array of fake
// OwningProcess rows for Test-HealthListenerPidMatch without ever touching a
// real socket.
function evaluateListenerReady(expression, { pids = null } = {}) {
  listenerReadySeq += 1;
  const harness = path.join(scratch, `listener-ready-${listenerReadySeq}.ps1`);
  const listenersSetup = pids === null
    ? '$Listeners = @()'
    : '$Listeners = @(' + pids.map(p => `[pscustomobject]@{ OwningProcess = ${p} }`).join(', ') + ')';
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    LISTENER_READY_FUNCS,
    '',
    listenersSetup,
    `$result = ${expression}`,
    '[pscustomobject]@{ value = [bool]$result } | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^﻿/, '').trim()).value;
}

// PowerShell parses a bare [Type]@{...} in COMMAND-ARGUMENT position
// differently from expression/assignment position -- unparenthesized, the
// tokenizer splits it at the brace and the command receives the literal
// string "[pscustomobject]@" instead of an object (confirmed by running the
// unparenthesized form directly: $Identity.owned then reads $null, not
// $true). Every constant below is wrapped in its own parentheses so it
// evaluates as an expression wherever it lands as a -Param argument, exactly
// like the rest of this codebase already does (see e.g. fra-lifecycle-guards.js's
// `Test-ExactProperties ([ordered]@{a=1;b=2}) @('a','b')`).
const allGatesReady = "([pscustomobject]@{ localReady=$true; secureTransportReady=$true; runtimeIntegrityReady=$true; rootIdentityReady=$true; rootAccessReady=$true; transportBindingReady=$true; capabilityManifestReady=$true; credentialBoundaryReady=$true; desktopPolicyReady=$true })";

check('owned is ready regardless of state or health (health failures are a SEPARATE gate, not folded in here)', () => {
  const owned = "([pscustomobject]@{ owned=$true; state='owned' })";
  const emptyHealth = "([pscustomobject]@{ localReady=$false; secureTransportReady=$false; runtimeIntegrityReady=$false; rootIdentityReady=$false; rootAccessReady=$false; transportBindingReady=$false; capabilityManifestReady=$false; credentialBoundaryReady=$false; desktopPolicyReady=$false })";
  assert.equal(evaluateListenerReady(`Test-ListenerReady -Identity ${owned} -SameProcessHealthListener $false -Health ${emptyHealth}`), true);
});

check('unverifiable + same-pid health-listener match + every health gate passing -> READY, and owned stays false (the two fields are allowed to disagree)', () => {
  const identity = "([pscustomobject]@{ owned=$false; state='unverifiable'; pid=4242 })";
  const ready = evaluateListenerReady(`Test-ListenerReady -Identity ${identity} -SameProcessHealthListener $true -Health ${allGatesReady}`);
  assert.equal(ready, true,
    'a healthy-but-unverifiable listener, positively proven via the same-pid health-listener match, must be ready; ' +
    'this is the exact case that made every reconcile cycle attempt a doomed duplicate Start');
});

check('unverifiable + same-pid match but ONE health gate failing -> NOT ready (treated as unhealthy, never as owned)', () => {
  const identity = "([pscustomobject]@{ owned=$false; state='unverifiable'; pid=4242 })";
  const listenerHealthGates = [
    'localReady', 'secureTransportReady', 'runtimeIntegrityReady', 'rootIdentityReady', 'rootAccessReady',
    'transportBindingReady', 'capabilityManifestReady', 'credentialBoundaryReady', 'desktopPolicyReady'
  ];
  assert.ok(listenerHealthGates.length > 0, 'listener health gate cases must not be empty');
  for (const gate of listenerHealthGates) {
    const health = allGatesReady.replace(`${gate}=$true`, `${gate}=$false`);
    assert.notEqual(health, allGatesReady, `could not toggle ${gate} off`);
    const ready = evaluateListenerReady(`Test-ListenerReady -Identity ${identity} -SameProcessHealthListener $true -Health ${health}`);
    assert.equal(ready, false, `a failing ${gate} must block readiness even with a proven same-pid match`);
  }
});

check('health-endpoint PID mismatch (8792 owner is not the observed 8790 pid) -> NOT ready, treated as unverifiable-unhealthy, never as owned', () => {
  const identity = "([pscustomobject]@{ owned=$false; state='unverifiable'; pid=4242 })";
  // SameProcessHealthListener=$false is exactly what a PID mismatch yields
  // (see the Test-HealthListenerPidMatch checks below); Health is still
  // fully-ready here to prove the mismatch alone is disqualifying, not a
  // side effect of also failing health.
  const ready = evaluateListenerReady(`Test-ListenerReady -Identity ${identity} -SameProcessHealthListener $false -Health ${allGatesReady}`);
  assert.equal(ready, false,
    'a PID mismatch on the health endpoint must never be treated as proof of the same process, ' +
    'no matter how healthy that OTHER process reports itself to be');
});

check('absent / conflict (not owned, not unverifiable) -> NOT ready', () => {
  const nonReadyListenerStates = ['absent', 'conflict'];
  assert.ok(nonReadyListenerStates.length > 0, 'non-ready listener state cases must not be empty');
  for (const state of nonReadyListenerStates) {
    const identity = `([pscustomobject]@{ owned=$false; state='${state}' })`;
    const ready = evaluateListenerReady(`Test-ListenerReady -Identity ${identity} -SameProcessHealthListener $true -Health ${allGatesReady}`);
    assert.equal(ready, false, `${state} must never be treated as ready`);
  }
});

check('Test-HealthListenerPidMatch: exactly one 8792 listener owned by the observed pid -> match', () => {
  assert.equal(evaluateListenerReady('Test-HealthListenerPidMatch -Listeners $Listeners -ExpectedPid 4242', { pids: [4242] }), true);
});

check('Test-HealthListenerPidMatch: zero 8792 listeners -> no match', () => {
  assert.equal(evaluateListenerReady('Test-HealthListenerPidMatch -Listeners $Listeners -ExpectedPid 4242', { pids: [] }), false);
});

check('Test-HealthListenerPidMatch: more than one 8792 listener -> no match (exactly one is required, not "any")', () => {
  assert.equal(evaluateListenerReady('Test-HealthListenerPidMatch -Listeners $Listeners -ExpectedPid 4242', { pids: [4242, 4242] }), false);
});

check('Test-HealthListenerPidMatch: the single 8792 listener is owned by a DIFFERENT pid -> no match', () => {
  assert.equal(evaluateListenerReady('Test-HealthListenerPidMatch -Listeners $Listeners -ExpectedPid 4242', { pids: [9999] }), false);
});

// --- and the field is really wired into Get-StatusReport, not just defined --
check('Get-StatusReport computes listenerReady from Test-ListenerReady and $operational reads listenerReady, not owned', () => {
  assert.match(controlSource, /\$listenerReady\s*=\s*Test-ListenerReady/,
    'Get-StatusReport must compute $listenerReady via the shared primitive');
  assert.match(controlSource, /\$operational\s*=\s*\[bool\]\(-not \$disabled -and \$listenerReady -and/,
    'operational must read the new listenerReady, not $identity.owned directly -- ' +
    'that is the whole point of this fix reaching Invoke-Reconcile\'s own operational check too');
  assert.match(controlSource, /owned\s*=\s*\[bool\]\$identity\.owned/,
    'owned must stay a direct, unmodified read of the positive identification -- its honesty is load-bearing elsewhere');
  assert.match(controlSource, /listenerReady\s*=\s*\[bool\]\$listenerReady/,
    'the output listenerReady field must be the computed value, not a re-statement of owned');
});

check('Get-ServiceHealthReport is called for an unverifiable listener only once the same-pid proof holds', () => {
  assert.match(controlSource, /\$sameProcessHealthListener\s*=\s*\[bool\]\(\$identity\.state -eq 'unverifiable'/,
    'the same-pid proof must be computed before any health probe is attempted for an unverifiable listener');
  assert.match(controlSource, /\$health\s*=\s*if \(\(\$identity\.owned -or \$sameProcessHealthListener\) -and -not \$disabled\) \{\s*\n\s*Get-ServiceHealthReport/,
    'the health probe must be gated on (owned OR the proven same-pid match), never on "unverifiable" alone');
});

// --- Start-OwnedListener: the primitive itself refuses a duplicate spawn ----
//
// Per Machine A's follow-up review: fixing $operational/listenerReady alone
// only protects Invoke-Reconcile's main branch. Every OTHER caller in the
// lifecycle script that can reach Start (rollback recovery, transaction
// sync, coordinated rotation -- see Invoke-ReviewedRestart/Invoke-Control
// 'Start' call sites in full-remote-access-lifecycle.ps1) would still hit
// the exact same doomed-duplicate-Start bug if it observed 'unverifiable'
// without going through the new Invoke-Reconcile gating. So the guard is
// pushed down into Start-OwnedListener itself -- the one place every caller
// (present and future) actually goes through -- using the SAME
// Test-ListenerReady primitive already proven above, never a second
// re-implementation of the same decision.
const START_OWNED_FUNCS = [
  lift('Get-EmptyServiceHealthReport'),
  lift('Test-HealthListenerPidMatch'),
  lift('Test-ListenerReady'),
  lift('Get-UnverifiableListenerReadiness'),
  lift('Stop-OwnedListener'),
  lift('Start-OwnedListener')
].join('\n\n');

let startOwnedSeq = 0;
function runStartOwnedListener({
  initialState = 'absent', initialOwned = false, initialPid = null,
  sameProcessHealthListener = false, healthGatesReady = true, resolvesOwnedAfterSpawn = true
} = {}) {
  startOwnedSeq += 1;
  const harness = path.join(scratch, `start-owned-${startOwnedSeq}.ps1`);
  const stateDir = path.join(scratch, `start-owned-state-${startOwnedSeq}`);
  const logDir = path.join(scratch, `start-owned-log-${startOwnedSeq}`);
  const node = path.join(scratch, `fake-node-${startOwnedSeq}.exe`);
  const server = path.join(scratch, `fake-server-${startOwnedSeq}.js`);
  const listenerHost = path.join(scratch, `fake-listener-host-${startOwnedSeq}.js`);
  fs.writeFileSync(node, ''); fs.writeFileSync(server, ''); fs.writeFileSync(listenerHost, '');
  const initialIdentity = `[pscustomobject]@{ state='${initialState}'; pid=${initialPid === null ? '$null' : initialPid}; owned=$${initialOwned}; reason=$null }`;
  const health = healthGatesReady
    ? '[pscustomobject]@{ localReady=$true; secureTransportReady=$true; runtimeIntegrityReady=$true; rootIdentityReady=$true; rootAccessReady=$true; transportBindingReady=$true; capabilityManifestReady=$true; credentialBoundaryReady=$true; desktopPolicyReady=$true }'
    : '[pscustomobject]@{ localReady=$false; secureTransportReady=$false; runtimeIntegrityReady=$false; rootIdentityReady=$false; rootAccessReady=$false; transportBindingReady=$false; capabilityManifestReady=$false; credentialBoundaryReady=$false; desktopPolicyReady=$false }';
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `$InitialIdentity = ${initialIdentity}`,
    `$FakeHealth = ${health}`,
    `$SameProcessHealthListener = $${sameProcessHealthListener}`,
    '$script:StartProcessCalled = $false',
    '$script:ServiceHealthReportCalls = 0',
    `$Node = '${node.replace(/\\/g, '\\\\')}'`,
    `$Server = '${server.replace(/\\/g, '\\\\')}'`,
    // Start-OwnedListener's FIRST statement is
    //   Test-Path -LiteralPath $ListenerHost -PathType Leaf
    // so $ListenerHost is a FILE PATH, not a network host, despite the name.
    // The harness never defined it (nor $Root or $Port), so the function was
    // reached with $null and PowerShell refused the bind:
    //   "Cannot bind argument to parameter 'LiteralPath' because it is null."
    // Every case in this group died there, before exercising any of the start
    // logic they exist to test -- a suite that looked like it was testing
    // Start-OwnedListener and was in fact testing nothing past its first line.
    // Fixed 2026-08-10 by supplying the three ambient values the production
    // script defines at its top level (full-remote-access-control.ps1:15,40,56).
    `$ListenerHost = '${listenerHost.replace(/\\/g, '\\\\')}'`,
    `$Root = '${scratch.replace(/\\/g, '\\\\')}'`,
    '$Port = 8790',
    `$StateDir = '${stateDir.replace(/\\/g, '\\\\')}'`,
    `$LogDir = '${logDir.replace(/\\/g, '\\\\')}'`,
    `$StdoutLog = '${path.join(logDir, 'out.log').replace(/\\/g, '\\\\')}'`,
    `$StderrLog = '${path.join(logDir, 'err.log').replace(/\\/g, '\\\\')}'`,
    `$StartMutexName = 'Local\\FraTestStartMutex' + ([guid]::NewGuid().ToString('N'))`,
    '$StartHealthTimeoutMs = 2000',
    'function Write-ControlLog { param($Line) }',
    'function Get-ExactListener {',
    '  if ($script:StartProcessCalled) { return [pscustomobject]@{ state = "owned"; pid = 55555; owned = $true; reason = $null } }',
    '  return $InitialIdentity',
    '}',
    `function Test-ServiceHealth { return [bool]$${resolvesOwnedAfterSpawn} }`,
    'function Get-HealthListenerPidMatch { param([int]$ExpectedPid) return [bool]$SameProcessHealthListener }',
    'function Get-ServiceHealthReport { $script:ServiceHealthReportCalls += 1; return $FakeHealth }',
    'function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)',
    '  $script:StartProcessCalled = $true',
    '  [pscustomobject]@{ Id = 55555; HasExited = $false }',
    '}',
    '',
    START_OWNED_FUNCS,
    '',
    '$outcome = [ordered]@{ ok = $true; startProcessCalled = $false; serviceHealthReportCalls = 0 }',
    'try {',
    '  $result = Start-OwnedListener -PreflightValidated',
    '  $outcome.action = $result.action',
    '  $outcome.pid = $result.pid',
    '} catch {',
    '  $outcome.ok = $false',
    '  $outcome.errorMessage = [string]$_.Exception.Message',
    '}',
    '$outcome.startProcessCalled = $script:StartProcessCalled',
    '$outcome.serviceHealthReportCalls = $script:ServiceHealthReportCalls',
    '[pscustomobject]$outcome | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^﻿/, '').trim());
}

check('absent -> Start is attempted exactly once, and succeeds', () => {
  const outcome = runStartOwnedListener({ initialState: 'absent', initialOwned: false, resolvesOwnedAfterSpawn: true });
  assert.equal(outcome.ok, true, outcome.errorMessage);
  assert.equal(outcome.startProcessCalled, true, 'an absent listener is the ONE case Start-Process must actually run for');
  assert.equal(outcome.action, 'started');
});

check('owned + healthy -> already_healthy, Start-Process is never called', () => {
  const outcome = runStartOwnedListener({ initialState: 'owned', initialOwned: true, initialPid: 4242 });
  assert.equal(outcome.ok, true, outcome.errorMessage);
  assert.equal(outcome.action, 'already_healthy');
  assert.equal(outcome.pid, 4242);
  assert.equal(outcome.startProcessCalled, false);
});

check('unverifiable + same-pid match + every health gate passing -> already_healthy, Start-Process is never called (the fix)', () => {
  const outcome = runStartOwnedListener({
    initialState: 'unverifiable', initialOwned: false, initialPid: 4242,
    sameProcessHealthListener: true, healthGatesReady: true
  });
  assert.equal(outcome.ok, true, outcome.errorMessage);
  assert.equal(outcome.action, 'already_healthy',
    'a healthy-but-unverifiable listener must be recognised as already running, never spawned a second time');
  assert.equal(outcome.pid, 4242);
  assert.equal(outcome.startProcessCalled, false,
    'this is the exact doomed-duplicate-Start bug: Start-Process must never run against an already-bound port here');
});

check('unverifiable + health gates fail -> refused, not started, and Start-Process is never called', () => {
  const outcome = runStartOwnedListener({
    initialState: 'unverifiable', initialOwned: false, initialPid: 4242,
    sameProcessHealthListener: true, healthGatesReady: false
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorMessage, 'FULL_REMOTE_ACCESS_LISTENER_UNVERIFIABLE');
  assert.equal(outcome.startProcessCalled, false,
    'an unproven listener must be refused, never treated as absent and started over');
});

check('unverifiable + health-endpoint PID mismatch -> refused as unverifiable-unhealthy, Get-ServiceHealthReport is never even called', () => {
  const outcome = runStartOwnedListener({
    initialState: 'unverifiable', initialOwned: false, initialPid: 4242,
    sameProcessHealthListener: false, healthGatesReady: true
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorMessage, 'FULL_REMOTE_ACCESS_LISTENER_UNVERIFIABLE');
  assert.equal(outcome.startProcessCalled, false);
  assert.equal(outcome.serviceHealthReportCalls, 0,
    'the health endpoint must only be probed once the same-pid proof already holds, never on a bare PID mismatch');
});

// --- Start-FraEnrollment: same class of gap, same refusal ---------------------
const START_ENROLLMENT_FUNCS = [lift('Start-FraEnrollment')].join('\n\n');

let startEnrollmentSeq = 0;
function runStartFraEnrollment({ initialState = 'absent', initialOwned = false, initialPid = null } = {}) {
  startEnrollmentSeq += 1;
  const harness = path.join(scratch, `start-enrollment-${startEnrollmentSeq}.ps1`);
  const logDir = path.join(scratch, `start-enrollment-log-${startEnrollmentSeq}`);
  const node = path.join(scratch, `fake-enroll-node-${startEnrollmentSeq}.exe`);
  const enrollmentScript = path.join(scratch, `fake-enroll-script-${startEnrollmentSeq}.js`);
  fs.writeFileSync(node, ''); fs.writeFileSync(enrollmentScript, '');
  const initialIdentity = `[pscustomobject]@{ state='${initialState}'; pid=${initialPid === null ? '$null' : initialPid}; owned=$${initialOwned}; reason=$null }`;
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `$InitialIdentity = ${initialIdentity}`,
    '$script:StartProcessCalled = $false',
    // Start-FraEnrollment refuses to run anywhere but machine B. It used to compare
    // $HostName against a hardcoded address; it now compares against $MachineBAddress,
    // which the live script populates from the service registry. The harness has to
    // seed that variable too -- left undefined it is $null, every host mismatches, and
    // the function throws FRA_ENROLLMENT_RECEIVER_B_ONLY before reaching anything the
    // test is actually about.
    `$HostName = '${MACHINE_B_ADDRESS}'`,
    `$PeerHost = '${MACHINE_A_ADDRESS}'`,
    `$MachineBAddress = '${MACHINE_B_ADDRESS}'`,
    `$MachineAAddress = '${MACHINE_A_ADDRESS}'`,
    `$Node = '${node.replace(/\\/g, '\\\\')}'`,
    `$EnrollmentScript = '${enrollmentScript.replace(/\\/g, '\\\\')}'`,
    `$LogDir = '${logDir.replace(/\\/g, '\\\\')}'`,
    `$EnrollmentStdoutLog = '${path.join(logDir, 'enroll-out.log').replace(/\\/g, '\\\\')}'`,
    `$EnrollmentStderrLog = '${path.join(logDir, 'enroll-err.log').replace(/\\/g, '\\\\')}'`,
    '$EnrollmentPort = 8794',
    "$EnrollmentMutexName = 'Local\\FraTestEnrollMutex' + ([guid]::NewGuid().ToString('N'))",
    'function Get-EnrollmentListener {',
    '  if ($script:StartProcessCalled) { return [pscustomobject]@{ state = "owned"; pid = 55556; owned = $true; reason = $null } }',
    '  return $InitialIdentity',
    '}',
    'function Get-EnrollmentFirewallReadiness { return [pscustomobject]@{ ready = $true; reason = $null } }',
    'function Write-ControlLog { param($Line) }',
    'function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)',
    '  $script:StartProcessCalled = $true',
    '  [pscustomobject]@{ Id = 55556; HasExited = $false }',
    '}',
    '',
    START_ENROLLMENT_FUNCS,
    '',
    '$outcome = [ordered]@{ ok = $true; startProcessCalled = $false }',
    'try {',
    '  $result = Start-FraEnrollment',
    '  $outcome.action = $result.action',
    '} catch {',
    '  $outcome.ok = $false',
    '  $outcome.errorMessage = [string]$_.Exception.Message',
    '}',
    '$outcome.startProcessCalled = $script:StartProcessCalled',
    '[pscustomobject]$outcome | ConvertTo-Json -Compress'
  ].join('\n'), 'ascii');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
    { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^﻿/, '').trim());
}

check('enrollment: absent -> the receiver is spawned exactly once', () => {
  const outcome = runStartFraEnrollment({ initialState: 'absent', initialOwned: false });
  assert.equal(outcome.ok, true, outcome.errorMessage);
  assert.equal(outcome.startProcessCalled, true);
  assert.equal(outcome.action, 'enrollment_ready');
});

check('enrollment: unverifiable -> refused, a second receiver is never spawned against a live port', () => {
  const outcome = runStartFraEnrollment({ initialState: 'unverifiable', initialOwned: false, initialPid: 7777 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorMessage, 'FRA_ENROLLMENT_LISTENER_UNVERIFIABLE');
  assert.equal(outcome.startProcessCalled, false,
    'the one-shot enrollment receiver has no sibling health endpoint to prove identity by -- ' +
    'an unverifiable read must always be refused, never spawned over');
});

fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`\nfra-readiness-gates: ${passed} checks passed\n`);
