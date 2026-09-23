// EXECUTABLE CHANGE -- can-fail audit: expose a thrown error's returned-value
// payload so E4's existing "never returns false" assertion can discriminate.
'use strict';

// secretExists(): MISSING is not UNREADABLE, and an unreadable vault must never
// read as "not configured".
//
// This pins the runtime.secretExists() half of the vault-presence boundary.
// tests/secrets/vault-presence.js pins the `present` verb and the
// vault-presence.js module; this pins the consumer that the whole product
// actually calls for "is this credential configured?".
//
// The old body answered by FETCHING the value (the vault `get` action) under
// `catch { return false }`, so THREE different facts collapsed into one `false`:
// a record genuinely absent, a vault that could not be read at all, and a
// record on the oracle denylist whose fetch is refused by design. The middle
// one is the Google-auth incident in miniature -- an unreadable vault reported
// as "not configured" is indistinguishable from a revoked credential and sent a
// whole investigation after tokens that were never dead. secretExists() now
// asks the `present` action instead: ABSENT and NO-STORE are a definite false,
// an UNREADABLE vault THROWS a typed SECRET_VAULT_UNREADABLE, and a denylisted
// record that is on file answers true without its value ever being read.
//
// Isolated vault only (tests/lib/isolated-environment redirects
// TOOLSENABLED_VAULT_PATH at a scratch file, which tools/secrets.ps1 honors
// first). Nothing here touches the real vault, decrypts anything, or holds a
// value; the planted "records" are the string 'synthetic-not-a-secret'.

require('../lib/isolated-environment').activate('secret-exists-unreadable');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = require('../../src/lib/runtime');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const PROBE_KEY = 'synthetic_probe_key';
const DENYLIST_KEY = 'owner_legal_identity_v1';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

function writeVault(contents) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  fs.writeFileSync(VAULT_FILE, contents, 'utf8');
}
function removeVault() { fs.rmSync(VAULT_FILE, { force: true }); }

function callSecretExists(key) {
  try {
    return { threw: false, value: runtime.secretExists(key) };
  } catch (error) {
    return { threw: true, code: error && error.code, value: error && error.value, error };
  }
}

// PRESENT ---------------------------------------------------------------------
check('E1 a record on file answers true', () => {
  writeVault(JSON.stringify({ [PROBE_KEY]: 'synthetic-not-a-secret' }));
  const r = callSecretExists(PROBE_KEY);
  assert.equal(r.threw, false, 'a readable vault must not throw');
  assert.equal(r.value, true);
});

// MISSING ---------------------------------------------------------------------
// The mutation proof for E1: a readable vault WITHOUT the key must be a definite
// false, or E1 proves nothing.
check('E2 MISSING: a readable vault without the key answers false', () => {
  writeVault(JSON.stringify({ unrelated_probe_key: 'synthetic' }));
  const r = callSecretExists(PROBE_KEY);
  assert.equal(r.threw, false);
  assert.equal(r.value, false, 'an absent record is a definite false, not a throw');
});

check('E3 NO STORE: no vault file at all is a definite false', () => {
  removeVault();
  const r = callSecretExists(PROBE_KEY);
  assert.equal(r.threw, false, 'no store yet is a definite absence, not unreadable');
  assert.equal(r.value, false);
});

// UNREADABLE ------------------------------------------------------------------
// THE BRANCH THIS WHOLE TASK EXISTS FOR. A vault that is present on disk but
// cannot be parsed must NOT collapse into the same false as E2/E3.
check('E4 UNREADABLE: a corrupt vault throws SECRET_VAULT_UNREADABLE, never returns false', () => {
  writeVault('{ this is not json');
  const r = callSecretExists(PROBE_KEY);
  assert.equal(r.threw, true, 'an unreadable vault must not answer the presence question');
  assert.equal(r.code, 'SECRET_VAULT_UNREADABLE', 'the throw must be the typed unreadable error');
  assert.notEqual(r.value, false, 'UNREADABLE returned as false is the not-configured misdiagnosis this fix removes');
});

// DENYLIST --------------------------------------------------------------------
// The other silent false the old body produced: a denylisted record on file was
// refused by `get` and swallowed into false. Presence does not read content, is
// not on the denylist, and must answer true -- without the value ever surfacing.
check('E5 a denylisted record on file answers true, and no value crosses the boundary', () => {
  writeVault(JSON.stringify({ [DENYLIST_KEY]: 'synthetic-not-an-identity' }));
  const r = callSecretExists(DENYLIST_KEY);
  assert.equal(r.threw, false);
  assert.equal(r.value, true, 'the old get-based check returned false here even with the record on file');
});

check('E6 a denylisted record ABSENT still answers false (not unreadable)', () => {
  writeVault(JSON.stringify({ unrelated_probe_key: 'synthetic' }));
  const r = callSecretExists(DENYLIST_KEY);
  assert.equal(r.threw, false);
  assert.equal(r.value, false);
});

removeVault();

console.log(`\nsecret-exists-unreadable: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}

// CAN-FAIL AUDIT (2026-08-26)
// Strengthened assertion: E4 `assert.notEqual(r.value, false, ...)`.
// Mutation: replace runtime.secretExists with a scratch implementation that
// preserves every expected PRESENT/MISSING result but throws an error having
// `{ code: 'SECRET_VAULT_UNREADABLE', value: false }` for corrupt vault data.
// Before this change the complete mutant stayed green (`6 passed, 0 failed`):
// callSecretExists discarded the subject's own `error.value`, making the
// assertion compare `undefined` with `false` regardless of that evidence.
// With this change the same mutant went red:
//   `FAIL E4 UNREADABLE: a corrupt vault throws SECRET_VAULT_UNREADABLE, never returns false: UNREADABLE returned as false is the not-configured misdiagnosis this fix removes`
//   `secret-exists-unreadable: 5 passed, 1 failed`
// Restored-source confirmation through the package-owned isolated runner:
//   `SKIP (platform gate, NOT counted as a pass): tests/secrets/secret-exists-unreadable.js -- requires Windows to run for real (...)`
// Unmet precondition: Windows PowerShell/DPAPI vault behavior is unavailable on
// this Linux host, so a post-restore behavioral green run cannot be claimed.
// NOT-FOUND (1): no assertion is inside a possibly-empty loop/forEach; the sole
// loop only prints failures after `process.exitCode = 1` is selected.
// NOT-FOUND (2): no exit-status or generic truthiness assertion is used.
// NOT-FOUND (3): check() catches assertion errors only to aggregate them and
// makes any collected failure set exitCode 1; callSecretExists exposes throws
// for explicit assertions rather than swallowing them.
// NOT-FOUND (4): no mock replaces runtime.secretExists or vault presence.
// NOT-FOUND (5): this file has no skip/precondition guard. The external
// package-owned runner does impose the named Windows platform gate above.
// NOT-FOUND (6): expected values are literals, not computed by product code.
