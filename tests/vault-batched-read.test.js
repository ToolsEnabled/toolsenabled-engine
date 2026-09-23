// EXECUTABLE CHANGE — testcanfail-tests-vault-batched-read-test-js
//
// Discrimination audit (2026-08-26): the beta successful-batch value check
// derived its expected value from runtime.getSecret, another path through the
// code under test. A fixture-literal assertion now supplements the original.
// Intended mutation: make readSecretsFromVault and getSecret return the same
// wrong beta value. The old assertion would remain green; the literal assertion
// below must report `Expected values to be strictly equal`.
// PRECONDITION-NOT-MET: this Linux host has no powershell.exe, so fixture setup
// stops at setSecret with `spawnSync powershell.exe ENOENT`; consequently no
// honest mutation RED or restored GREEN run can be quoted for this platform.
// NOT-FOUND (1): no assertion loop over a runtime-derived possibly-empty list.
// NOT-FOUND (2): no exit-status or truthy process-return assertion.
// NOT-FOUND (3): no optional chain or assertion-swallowing try/catch.
// NOT-FOUND (4): no mock of readSecretsFromVault or its vault implementation.
// NOT-FOUND (5): no skip or platform precondition guard that makes this a no-op.
// NOT-FOUND (6), after the fix: no expected value is computed by the read path
// it checks; the individual read remains independently pinned to its fixture.

'use strict';

// A BATCHED VAULT READ MUST BUY FEWER PROCESSES, NOT MORE AUTHORITY.
//
// Reading a secret costs almost nothing in DPAPI and ~500-650 ms in
// powershell.exe startup. Two secrets -- the audit signing key and the
// protected head anchor -- are read by every short-lived process, ~110 an hour
// on a full install: measured 648 ms + 515 ms = 1,163 ms each time. Once the
// audit ledger is bounded, that is the single largest remaining per-process
// cost, larger than verifying the ledger itself.
//
// The danger in fixing it is obvious in hindsight: R1162 deliberately REMOVED a
// generic secrets oracle, and a batched getter is exactly the shape of one. So
// these cases exist to prove get-many carries the authority of N x 'get' and
// not one drop more -- same key validation, same denylist refusal, same access
// log, same configured/not-configured distinction -- and that when it cannot
// do that, it degrades to the behaviour that shipped before it existed rather
// than to a guess.
//
// Scratch vault only: TOOLSENABLED_VAULT_PATH is redirected before runtime.js
// loads, exactly as tests/audit-lock-scope.test.js does, so the installation's
// own vault is never opened.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-batched-read-'));
process.env.TOOLSENABLED_VAULT_PATH = path.join(scratchDir, 'vault.json');

function removeScratchDir() {
  const resolved = path.resolve(scratchDir);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`),
    'refusing to clean a batched-vault fixture outside the temporary directory');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Keep an exit fallback for failures during fixture setup, before the checks
// below get a chance to run their normal cleanup.
process.once('exit', removeScratchDir);

const runtime = require('../src/lib/runtime');
const vaultHost = require('../src/lib/vault-host-client');

const ALPHA = 'probe_batch_alpha';
const BETA = 'probe_batch_beta';
const ABSENT = 'probe_batch_absent';
// Awkward on purpose: quotes and backslashes break naive JSON assembly, and
// non-ASCII breaks a wrong-encoding round trip. A secret that comes back
// subtly altered is worse than one that fails to come back at all.
const ALPHA_VALUE = 'alpha-éü-"quoted"-\\backslash-{"json":true}';
const BETA_VALUE = 'beta-value';
const TRANSPORT_VALUE = 'utf8-漢字-🙂-e\u0301-"quoted"-\\backslash';

const checks = [];
function check(name, run) { checks.push([name, run]); }

runtime.setSecret(ALPHA, ALPHA_VALUE);
runtime.setSecret(BETA, BETA_VALUE);

check('a batched read returns exactly what individual reads return', () => {
  const individually = { [ALPHA]: runtime.getSecret(ALPHA), [BETA]: runtime.getSecret(BETA) };
  assert.equal(individually[ALPHA], ALPHA_VALUE, 'precondition: the awkward value survives a normal read');

  const batched = runtime.readSecretsFromVault([ALPHA, BETA]);
  assert.ok(batched instanceof Map, 'a successful batch returns a Map');
  assert.equal(batched.size, 2);
  assert.equal(batched.get(ALPHA), individually[ALPHA],
    'quotes, backslashes and non-ASCII must survive the batch exactly as they survive a single read');
  assert.equal(batched.get(BETA), individually[BETA]);
  assert.equal(batched.get(BETA), BETA_VALUE,
    'the batch must return the beta fixture, independently of the individual read path');
});

function withoutVaultHost(run) {
  const original = vaultHost.callVaultHost;
  const calls = [];
  vaultHost.callVaultHost = (action, params) => { calls.push({ action, params }); return null; };
  runtime.invalidateSecretValueCache();
  try { run(); return calls; }
  finally { vaultHost.callVaultHost = original; runtime.invalidateSecretValueCache(); }
}

check('real hosted and per-call reads both preserve the literal Unicode value', () => {
  const hosted = vaultHost.callVaultHost('get', { key: ALPHA });
  assert.ok(hosted, 'the hosted control must be served, not silently replaced by a per-call read');
  assert.equal(hosted.output.trim(), ALPHA_VALUE);
  const calls = withoutVaultHost(() => {
    assert.equal(runtime.getSecret(ALPHA), ALPHA_VALUE,
      'an unavailable host must fall back to the real UTF-8 PowerShell pipe');
  });
  assert.deepEqual(calls, [{ action: 'get', params: { key: ALPHA } }],
    'the fallback control must miss the value cache and actually try the transport');
});

check('all stdin write shapes and both monotonic transports preserve Unicode', () => {
  const pair = ['probe_utf8_pair_left', 'probe_utf8_pair_right'];
  const triple = ['probe_utf8_triple_left', 'probe_utf8_triple_middle', 'probe_utf8_triple_right'];
  const created = 'probe_utf8_created';
  const head = 'probe_utf8_monotonic';
  runtime.setSecretPair(pair[0], TRANSPORT_VALUE, pair[1], ALPHA_VALUE);
  runtime.setSecretTriple(triple[0], ALPHA_VALUE, triple[1], TRANSPORT_VALUE, triple[2], BETA_VALUE);
  assert.equal(runtime.getOrCreateSecret(created, TRANSPORT_VALUE), TRANSPORT_VALUE);
  assert.equal(runtime.getOrCreateSecret(created, 'unused-synthetic-candidate'), TRANSPORT_VALUE,
    'an existing value must survive the return pipe without replacement');
  const first = JSON.stringify({ sequence: 1, value: TRANSPORT_VALUE });
  const calls = withoutVaultHost(() => {
    assert.match(runtime.setMonotonicSecret(head, first, 1), /^[a-f0-9]{64}$/);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'set-monotonic-stdin');
  assert.equal(vaultHost.callVaultHost('get', { key: head }).output.trim(), first,
    'the fallback write must store the literal, not a compensating encoding error');

  const second = JSON.stringify({ sequence: 2, value: ALPHA_VALUE });
  const original = vaultHost.callVaultHost;
  let hostedWrites = 0;
  vaultHost.callVaultHost = (action, params) => {
    assert.equal(action, 'set-monotonic-stdin');
    const response = original(action, params);
    assert.ok(response, 'the second monotonic write must use the actual host');
    hostedWrites++;
    return response;
  };
  try { assert.match(runtime.setMonotonicSecret(head, second, 2), /^[a-f0-9]{64}$/); }
  finally { vaultHost.callVaultHost = original; }
  assert.equal(hostedWrites, 1);

  const expected = new Map([
    [pair[0], TRANSPORT_VALUE], [pair[1], ALPHA_VALUE],
    [triple[0], ALPHA_VALUE], [triple[1], TRANSPORT_VALUE], [triple[2], BETA_VALUE],
    [created, TRANSPORT_VALUE], [head, second]
  ]);
  assert.deepEqual(runtime.readSecretsFromVault([...expected.keys()]), expected,
    'the independent per-call batch output must return every exact fixture value');
});

check('malformed UTF-8 stdin is refused without mutation or value disclosure', () => {
  const before = fs.readFileSync(process.env.TOOLSENABLED_VAULT_PATH);
  const marker = 'synthetic-invalid-utf8-private-value';
  const input = Buffer.concat([Buffer.from(marker), Buffer.from([0xc3, 0x28])]);
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, '..', 'tools', 'secrets.ps1'), 'set-stdin', 'probe_invalid_utf8'
  ], {
    cwd: path.join(__dirname, '..'), input, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 15_000, env: require('../src/lib/providers/subscription-launch-env').safeLaunchEnvironment(
      process.env, { context: 'vault UTF-8 refusal test' })
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'invalid bytes must not become a replacement-character credential');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Secret stdin must be valid UTF-8\./);
  assert.equal(result.stderr.includes(marker), false, 'decoder errors must not disclose the input');
  assert.deepEqual(fs.readFileSync(process.env.TOOLSENABLED_VAULT_PATH), before,
    'a decode refusal must preserve the complete original encrypted generation');
});

check('a key the vault does not hold is absent, not a failed batch', () => {
  // Collapsing "not configured" into a generic failure would erase the
  // distinction getSecret provides -- and upstream treats not-configured as
  // permission to create a key, so blurring it is not cosmetic.
  const batched = runtime.readSecretsFromVault([ALPHA, ABSENT]);
  assert.ok(batched instanceof Map, 'one missing key must not fail the whole batch');
  assert.equal(batched.get(ALPHA), ALPHA_VALUE, 'the keys that do exist still come back');
  assert.equal(batched.has(ABSENT), false, 'and the missing one is simply absent');
});

check('a denylisted key is refused, never quietly degraded', () => {
  // R1162 removed a generic secrets oracle. If a batched read skipped the
  // denylist -- or swallowed the refusal and fell back to individual reads --
  // it would put that oracle straight back.
  assert.throws(
    () => runtime.readSecretsFromVault([ALPHA, 'payment_card_default']),
    error => error && error.code === 'SECRET_ACCESS_DENIED',
    'a denylisted key must surface as a refusal, not as a null that triggers fallback'
  );
});

check('every batched read is still written to the access log, values never are', () => {
  // The access log exists to remove SILENCE, not to prevent reads. Batching
  // must remove process spawns, never the record of what was read.
  const logFile = `${process.env.TOOLSENABLED_VAULT_PATH}.access.log`;
  assert.ok(fs.existsSync(logFile), 'the vault access log must exist');
  const contents = fs.readFileSync(logFile, 'utf8');
  const batchEntries = contents.split('\n').filter(line => /get-many/.test(line));
  assert.ok(batchEntries.length >= 2,
    `each key in a batch must be logged individually; saw ${batchEntries.length}`);
  assert.doesNotMatch(contents, /alpha-|beta-value/, 'a secret VALUE must never reach the access log');
});

check('an unusable batch returns null so the caller falls back, rather than guessing', () => {
  // The safety property: worst case is exactly today's behaviour.
  assert.equal(runtime.readSecretsFromVault([]), null, 'an empty request is not a batch');
  assert.equal(runtime.readSecretsFromVault(null), null);
  assert.equal(runtime.readSecretsFromVault('not-an-array'), null);
});

check('an invalid key name is rejected before any process is spawned', () => {
  for (const bad of ['has space', 'has,comma', 'has/slash', '']) {
    assert.throws(() => runtime.readSecretsFromVault([ALPHA, bad]),
      'an unusable key name must be refused up front, not passed to the vault');
  }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
removeScratchDir();
process.removeListener('exit', removeScratchDir);
console.log(`\nvault-batched-read: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
