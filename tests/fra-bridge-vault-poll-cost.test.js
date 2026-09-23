// EXECUTABLE CHANGE
// MUTATION EVIDENCE for the five assertions formerly aimed at the local mock:
// * quiet: changed the real skip condition to `if (false) return;`; RED quoted:
//   `FAIL a QUIET vault costs zero reads...` / `500 !== 0`.
// * changed/two reads: changed it to `if (true) return;`; RED quoted:
//   `FAIL a CHANGED vault still rotates...` / `0 !== 1`.
// * pending: removed `&& !rotationCandidate`; RED quoted:
//   `FAIL a pending candidate keeps reading...` / `0 !== 1`.
// * torn: changed the real candidate branch to `if (!rotationCandidate)`; RED quoted:
//   `FAIL a TORN read (differing value)...` / `1 !== 0`.
// * unreadable: removed the real `fingerprint !== null &&` guard; RED quoted:
//   `FAIL an UNREADABLE fingerprint (null)...` / `1 !== 2`.
// Restoring src/full-remote-access-bridge.js byte-for-byte made this file GREEN with:
// `fra-bridge-vault-poll-cost: 10 checks passed`.
// NOT-FOUND: empty dynamic collections; exit-status/truthy-return-only evidence;
// swallowed failures/optional-chain assertions; skips/platform guards; expected values
// computed by product code. FOUND-AND-FIXED: the behavioral assertions measured a
// reimplementation (a mock) of the gate; they now execute the gate body extracted from
// the real bridge. PRECONDITIONS: none unmet.
'use strict';
// THE BRIDGE'S TOKEN POLL MUST NOT SPAWN A PROCESS PER TICK.
//
// Measured 2026-08-09: createFullRemoteAccessBridge()'s reload timer fired
// every 2s and each tick called loadFullRemoteAccessToken() ->
// src/lib/runtime.js readSecretFromVault() -> execFileSync('powershell.exe').
// That is ~43,000 process creations per day on a service that is idle almost
// all of that time, and it ran unnoticed for days as a standing CPU cost.
//
// These checks pin the fix AND the two properties it must not break:
//   * a quiet vault costs ZERO reads, no matter how many ticks elapse;
//   * a changed vault still rotates, and still only after TWO consecutive
//     agreeing reads (the torn-read guard);
//   * an UNREADABLE fingerprint never counts as "unchanged" -- it must fall
//     through to a real read, because "I could not look" is not "nothing
//     changed". That distinction is the whole safety argument for the gate.
//
// The timer is driven directly rather than by waiting on real 2s intervals:
// these assert the gate's decision logic, which is where the defect lived.

const assert = require('node:assert');

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

// Compile the actual poll callback from the bridge rather than testing a
// reimplementation of the thing under test. Its small closure is supplied
// with deterministic fingerprints/tokens so no timer or vault is involved.
function makeGate({ fingerprints, tokens }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'full-remote-access-bridge.js'), 'utf8');
  const initializerMatch = source.match(
    /const vaultFingerprintOf = fingerprintVault \|\| runtimeVaultFingerprint;\s*let lastVaultFingerprint = vaultFingerprintOf\(\);/
  );
  assert.ok(initializerMatch, 'could not locate the real bridge fingerprint-gate initializer');
  const callbackMarker = 'const reloadTimer = reloadToken ? setInterval(() => {';
  const callbackStart = source.indexOf(callbackMarker);
  assert.notStrictEqual(callbackStart, -1, 'could not locate the real bridge reload callback');
  const bodyStart = callbackStart + callbackMarker.length;
  let depth = 1;
  let bodyEnd = bodyStart;
  for (; bodyEnd < source.length && depth > 0; bodyEnd += 1) {
    if (source[bodyEnd] === '{') depth += 1;
    if (source[bodyEnd] === '}') depth -= 1;
  }
  assert.strictEqual(depth, 0, 'could not parse the real bridge reload callback');

  let reads = 0;
  let rotations = 0;
  let lastFingerprint;
  const fingerprintVault = () => {
    const next = fingerprints.length ? fingerprints.shift() : undefined;
    if (next !== undefined) lastFingerprint = next;
    return next === undefined ? lastFingerprint : next;
  };
  const runtimeVaultFingerprint = fingerprintVault;
  const reloadToken = () => {
    reads += 1;
    return tokens.length ? tokens.shift() : 'BASE';
  };
  const harness = Function(
    'fingerprintVault', 'runtimeVaultFingerprint', 'reloadToken', 'onRotate',
    `let baseToken = Buffer.from('BASE');
     let rotationCandidate = null;
     const sameSecret = (left, right) => left.equals(right);
     const clearRotationCandidate = () => { rotationCandidate = null; };
     const rotateBaseToken = candidate => { baseToken = Buffer.from(candidate); onRotate(); };
     const vaultBackedReload = true;
     let consecutiveAbsentReads = 0;
     ${initializerMatch[0]}
     return {
       tick: () => {${source.slice(bodyStart, bodyEnd - 1)}},
       current: () => baseToken.toString('utf8')
     };`
  );
  const compiled = harness(fingerprintVault, runtimeVaultFingerprint, reloadToken, () => { rotations += 1; });
  return { tick: compiled.tick, stats: () => ({ reads, rotations }), current: compiled.current };
}

check('a QUIET vault costs zero reads across many ticks -- the spawn storm is gone', () => {
  const gate = makeGate({ fingerprints: ['fp-1'], tokens: [] });
  for (let i = 0; i < 500; i += 1) gate.tick();
  assert.strictEqual(gate.stats().reads, 0,
    '500 ticks over an unchanged vault must perform ZERO vault reads; each read is a powershell.exe spawn');
});

check('a CHANGED vault still rotates, and only after two consecutive agreeing reads', () => {
  // tick1: fingerprint changes -> real read sees NEW (candidate, no rotation yet)
  // tick2: candidate pending -> reads again, sees NEW again -> rotation commits
  const gate = makeGate({ fingerprints: ['fp-1', 'fp-2'], tokens: ['NEW', 'NEW'] });
  gate.tick();
  assert.strictEqual(gate.stats().rotations, 0, 'one sighting must NOT rotate: that is the torn-read guard');
  gate.tick();
  assert.strictEqual(gate.stats().rotations, 1, 'a second consecutive agreeing read must rotate');
  assert.strictEqual(gate.current(), 'NEW');
  assert.strictEqual(gate.stats().reads, 2, 'exactly two reads were needed');
});

check('a pending candidate keeps reading even while the fingerprint sits still', () => {
  // The gate must not strand a half-confirmed rotation just because the file
  // stopped changing -- the !rotationCandidate term in the skip condition.
  const gate = makeGate({ fingerprints: ['fp-1', 'fp-2'], tokens: ['NEW', 'NEW'] });
  gate.tick();                       // sees change, candidate = NEW
  assert.strictEqual(gate.stats().rotations, 0);
  gate.tick();                       // fingerprint unchanged now, but candidate pending -> still reads
  assert.strictEqual(gate.stats().rotations, 1, 'a pending candidate must still be resolved');
});

check('a TORN read (differing value) abandons the candidate instead of rotating', () => {
  const gate = makeGate({ fingerprints: ['fp-1', 'fp-2', 'fp-3'], tokens: ['NEW', 'TORN'] });
  gate.tick();
  gate.tick();
  assert.strictEqual(gate.stats().rotations, 0,
    'two DIFFERING reads must never rotate live sessions');
});

check('an UNREADABLE fingerprint (null) never counts as unchanged -- it reads for real', () => {
  const gate = makeGate({ fingerprints: ['fp-1', null, null], tokens: ['BASE', 'BASE'] });
  gate.tick();
  gate.tick();
  assert.strictEqual(gate.stats().reads, 2,
    'a null fingerprint must fall through to a real read, never be treated as "nothing changed"');
});

check('the REAL bridge source still gates the poll and still fails open to a read', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'full-remote-access-bridge.js'), 'utf8');
  assert.ok(/lastVaultFingerprint/.test(source),
    'the bridge no longer tracks a vault fingerprint -- the gate was removed and the spawn storm is back');
  assert.ok(/fingerprint !== null && fingerprint === lastVaultFingerprint && !rotationCandidate/.test(source),
    'the gate condition changed shape; it must skip ONLY when the fingerprint is readable, equal, and no candidate is pending');
});

// REGRESSION: the first version of this gate broke tests/full-remote-access-bridge.js.
// It consulted the real vault FILE even when the caller had injected its own
// reloadToken -- a source the vault file does not govern at all. The injected
// token changed, the file did not, so the poll skipped forever and a rotation
// that WAS happening was never observed. The gate must apply only when the
// vault actually backs the reader.
check('an INJECTED reloadToken disables the gate entirely -- never gate on a signal that does not govern the source', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'full-remote-access-bridge.js'), 'utf8');
  assert.ok(/vaultBackedReload/.test(source),
    'the vaultBackedReload guard is gone; an injected reloadToken would be silently gated on an unrelated file mtime');
  assert.ok(/options\.reloadToken === undefined \|\| fingerprintVault !== null/.test(source),
    'the guard must treat ONLY the default vault-backed reader (or an explicitly supplied fingerprint fn) as gateable');
  assert.ok(/if \(vaultBackedReload\) \{/.test(source),
    'the fingerprint check must sit INSIDE the vaultBackedReload guard');
});

// The same defect existed in all THREE token-polling listeners. An audit found
// the other two after the first was fixed: src/remote-agent-bridge.js (8788,
// and synchronous, so it blocked its own event loop) and
// sidecars/link-bus/server.js (8787). Each was ~43,200 spawns/day. Pin all
// three so a future edit cannot quietly reintroduce the class in any of them.
check('ALL THREE token-polling listeners gate their vault read', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  for (const relative of [
    'src/full-remote-access-bridge.js',
    'src/remote-agent-bridge.js',
    'sidecars/link-bus/server.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(/lastVaultFingerprint/.test(source),
      `${relative} no longer gates its token poll -- a ~43,000/day powershell.exe spawn storm is back`);
    assert.ok(/vaultBackedReload/.test(source),
      `${relative} lost the vault-backed guard; an injected reader would be gated on an unrelated file`);
    assert.ok(/fingerprint !== null/.test(source),
      `${relative} must treat a null fingerprint as "read for real", never as "unchanged"`);
  }
});

check('the two bridges keep reading while a rotation candidate is pending; link-bus correctly does not', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  for (const relative of ['src/full-remote-access-bridge.js', 'src/remote-agent-bridge.js']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(/=== lastVaultFingerprint && !rotationCandidate/.test(source),
      `${relative} has a two-consecutive-reads rotation rule, so its gate MUST also read while a candidate is pending`);
  }
  // link-bus rotates on a single differing read and has no candidate to strand.
  // Match a DECLARATION, not the identifier anywhere: this file's own comment
  // explains the asymmetry and names rotationCandidate in prose. A bare
  // substring test here failed on that comment -- the same trap as asserting
  // on text that describes the thing rather than the thing itself.
  const linkBus = fs.readFileSync(path.join(root, 'sidecars/link-bus/server.js'), 'utf8');
  assert.ok(!/(?:let|const|var)\s+rotationCandidate\b/.test(linkBus),
    'link-bus declared a rotationCandidate; if it now has a two-read rule its gate must keep reading while one is pending');
});

check('runtime.vaultFingerprint returns a stable value and never throws', () => {
  const runtime = require('../src/lib/runtime.js');
  assert.strictEqual(typeof runtime.vaultFingerprint, 'function');
  const first = runtime.vaultFingerprint();
  const second = runtime.vaultFingerprint();
  assert.strictEqual(first, second, 'two back-to-back fingerprints of an unchanged vault must agree');
  assert.ok(first === null || typeof first === 'string');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}: ${error && error.message}\n`); }
}
if (failed > 0) { process.stdout.write(`fra-bridge-vault-poll-cost: ${failed} FAILED\n`); process.exit(1); }
process.stdout.write(`fra-bridge-vault-poll-cost: ${checks.length} checks passed\n`);
