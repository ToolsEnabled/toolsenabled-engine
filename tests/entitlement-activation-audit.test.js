// EXECUTABLE CHANGE
//
// CAN-FAIL REPORT: the credential-redaction matrix used an unconditional catch
// around activate(). Mutation: after the success-path audit record, throw
// `Error: MUTATION: post-record activation failure` only for its `lic-3` case.
// Before this change the complete file stayed green (`6 checks passed`), proving
// that the catch swallowed an unexpected failure on the very success path whose
// row it claimed to inspect. The catch now accepts only each refusal case's
// documented error code and rethrows any success-path or wrong-code failure.
// Under the same mutation it is RED:
//
//   Error: MUTATION: post-record activation failure
//       at Object.activate (.../src/lib/entitlement.js:1189:48)
//       at .../tests/entitlement-activation-audit.test.js:171:19
//
// The source mutation was restored byte-for-byte (SHA-256
// 0ec58c38456f0475da5fb352948b6c84bb1f7a8518f6d6d853e24dcfa4748035),
// and the restored run is GREEN: `entitlement-activation-audit: 6 checks passed`.
//
// Shape census: (1) NOT-FOUND -- the only assertion loop traverses a literal
// four-element matrix and every iteration also requires a recorded row;
// (2) NOT-FOUND -- this in-process test makes no exit-status/truthy process
// assertion; (3) FIXED -- the unconditional activation catch described above;
// the cleanup catch is not an assertion or subject failure; (4) NOT-FOUND --
// injected verifier/recorder seams drive the real resolver/activation behavior,
// and recorder outcomes are independently observed; (5) NOT-FOUND -- there are
// no skips or platform guards; (6) NOT-FOUND -- expected action, code, target,
// expiry, storage, warning, and redaction values are independent constants.
// Preconditions: all met; Node and the product module loaded locally.

'use strict';

// THE MOMENT MONEY BECOMES A CAPABILITY HAS TO REACH THE RECORD.
//
// Measured 2026-08-12: the audit ledger held no row for a customer becoming
// entitled. The cause was not a gate and not a failure -- src/lib/entitlement.js
// contained no audit call at all. `activate()` is described in its own docstring
// as "the moment an install becomes entitled ... the one customer-facing
// decision point", and it was the one decision the ledger could not answer a
// question about. A record that holds agent launches but not the instant
// somebody's payment turned into a capability is not a record of the business.
//
// Two properties are pinned here and the second matters more than the first:
//   1. success and BOTH refusal paths write a row
//   2. the licence key never appears in any of them
//
// A `te1.` key is a BEARER credential. The audit chain is append-only,
// tamper-evident and deliberately preserved -- exactly the wrong place to put a
// live credential, because it is the one place it can never be removed from.
//
// WHAT IS INJECTED, AND WHAT DELIBERATELY IS NOT. These drive the REAL
// resolveEntitlement through `dependencies.verifyKey`, a verifier seam, rather
// than handing activate() a ready-made entitlement object. That is not a
// convenience choice: `decide()` refuses any entitlement state this module did
// not mint, and adding a seam that let a caller supply one would reopen exactly
// the forgery hole that brand check exists to close. A test is not a reason to
// widen a security boundary.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const entitlement = require('../src/lib/entitlement');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const SECRET_KEY = 'te1.this-exact-string-must-never-reach-the-ledger';

// Read a real product id off the shipped tier table rather than hardcoding one,
// so renaming a product does not silently turn this suite into a no-op that
// only ever exercises the "unknown product" refusal.
const KNOWN_PRODUCT = Object.keys(entitlement.PRODUCT_TIERS)[0];
assert.ok(KNOWN_PRODUCT, 'the build must declare at least one purchasable product');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-activate-'));

function capture() {
  const rows = [];
  return { rows, record: (action, target, details) => rows.push({ action, target, details }) };
}

function deps(sink, verified) {
  return { record: sink.record, verifyKey: () => verified };
}

check('a key that fails verification writes a refusal row and stores nothing', () => {
  const sink = capture();
  assert.throws(
    () => entitlement.activate({ root, licenseKey: SECRET_KEY },
      deps(sink, { valid: false })),
    error => error.code === 'ENTITLEMENT_ACTIVATION_REFUSED'
  );
  assert.equal(sink.rows.length, 1, 'a refusal must be recorded, not swallowed');
  assert.equal(sink.rows[0].action, 'entitlement.activation_refused');
  assert.equal(sink.rows[0].details.stored, false);
  assert.equal(fs.existsSync(entitlement.profilePath(root)), false, 'a refused key must store nothing');
});

check('a revoked licence records the revocation, distinctly from a bad key', () => {
  const sink = capture();
  assert.throws(
    () => entitlement.activate({ root, licenseKey: SECRET_KEY }, deps(sink, {
      valid: true, product: KNOWN_PRODUCT, active: false, reason: 'revoked',
      licenseId: 'lic-42', licensee: 'someone', issuedAt: null, expiresAt: null, keyId: 'k1'
    })),
    error => error.code === 'ENTITLEMENT_REVOKED'
  );
  assert.equal(sink.rows.length, 1);
  assert.equal(sink.rows[0].details.code, 'ENTITLEMENT_REVOKED');
  assert.equal(sink.rows[0].target, 'lic-42', 'the row must name the licence it refused');
});

check('an expired licence is recorded as expired, not as revoked', () => {
  // Collapsing these two makes "was this cancelled, or did it just lapse"
  // unanswerable from the record, and they call for different responses.
  const sink = capture();
  assert.throws(
    () => entitlement.activate({ root, licenseKey: SECRET_KEY }, deps(sink, {
      valid: true, product: KNOWN_PRODUCT, active: false, reason: 'expired',
      licenseId: 'lic-7', licensee: 'someone', issuedAt: null, expiresAt: null, keyId: 'k1'
    })),
    error => error.code === 'ENTITLEMENT_EXPIRED'
  );
  assert.equal(sink.rows[0].details.code, 'ENTITLEMENT_EXPIRED');
});

check('a successful activation writes one row naming tier and expiry', () => {
  const sink = capture();
  const result = entitlement.activate({ root, licenseKey: SECRET_KEY }, deps(sink, {
    valid: true, product: KNOWN_PRODUCT, active: true, reason: null,
    licenseId: 'lic-99', licensee: 'someone',
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', keyId: 'k1'
  }));
  assert.ok(result.entitlement.active, 'the activation must report the entitlement it stored');
  assert.equal(sink.rows.length, 1);
  assert.equal(sink.rows[0].action, 'entitlement.activated');
  assert.equal(sink.rows[0].target, 'lic-99');
  assert.equal(sink.rows[0].details.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.equal(sink.rows[0].details.stored, true);
  assert.ok(sink.rows[0].details.tier, 'the row must name which tier was activated');
});

check('THE LICENCE KEY NEVER APPEARS IN ANY RECORDED ROW', () => {
  // Worth more than the other checks combined. Serialises the WHOLE row rather
  // than the fields this test happens to know about, so a future field carrying
  // the key cannot slip past a field-by-field assertion.
  const cases = [
    { verified: { valid: false }, errorCode: 'ENTITLEMENT_ACTIVATION_REFUSED' },
    {
      verified: { valid: true, product: KNOWN_PRODUCT, active: false, reason: 'revoked', licenseId: 'lic-1' },
      errorCode: 'ENTITLEMENT_REVOKED'
    },
    {
      verified: { valid: true, product: KNOWN_PRODUCT, active: false, reason: 'expired', licenseId: 'lic-2' },
      errorCode: 'ENTITLEMENT_EXPIRED'
    },
    {
      verified: { valid: true, product: KNOWN_PRODUCT, active: true, reason: null, licenseId: 'lic-3' },
      errorCode: null
    }
  ];
  for (const { verified, errorCode } of cases) {
    const sink = capture();
    try {
      entitlement.activate({ root, licenseKey: SECRET_KEY }, deps(sink, verified));
    } catch (error) {
      // Refusals are expected to throw, but success must return. An unconditional
      // catch here would let a post-record activation failure pass this matrix.
      if (verified.active) throw error;
      assert.equal(error.code, errorCode,
        `the ${verified.reason || 'invalid'} refusal threw the wrong failure`);
    }
    assert.ok(sink.rows.length > 0, `case ${verified.reason || verified.valid} recorded nothing`);
    const serialized = JSON.stringify(sink.rows);
    assert.ok(!serialized.includes(SECRET_KEY),
      `the licence key reached the ledger on the ${verified.reason || 'success'} path`);
    assert.ok(!serialized.includes('te1.'),
      `something key-shaped reached the ledger on the ${verified.reason || 'success'} path`);
  }
});

check('a ledger that cannot be written warns loudly and still serves the customer', () => {
  // Fail-open here is deliberate and is NOT the general rule. The entitlement
  // that gates the paid surface is checked SERVER-SIDE by pairId and never
  // reads this machine, so this row is a record rather than the gate -- and a
  // record that can refuse service is a worse failure than a record with a
  // hole in it.
  //
  // Both halves are asserted, because either alone is a bug: serving without
  // warning hides the hole, and warning by throwing would take the whole
  // Electron main process down one tick after a successful activation --
  // denying the customer more violently than the refusal this design exists to
  // avoid. The first draft of this code did exactly that.
  // THE SHAPE PRODUCTION ACTUALLY PRODUCES. An adversarial review found the
  // first version of this test injected a THROWING recorder -- and audit.record
  // does not throw on a failed write, it returns a status object and expects the
  // caller to read it. So the handler was unreachable and this test proved
  // nothing except that the stub it wrote behaved like the stub it wrote. That
  // is the canonical way a fail-open path rots: present, tested, and wired to a
  // condition that never occurs.
  //
  // Both shapes are now exercised, because an injected recorder may still throw.
  const runWith = recorder => {
    const warnings = [];
    const realEmitWarning = process.emitWarning;
    process.emitWarning = (message, name) => warnings.push({ message: String(message), name });
    let result;
    try {
      result = entitlement.activate({ root, licenseKey: SECRET_KEY }, {
        record: recorder,
        verifyKey: () => ({
          valid: true, product: KNOWN_PRODUCT, active: true, reason: null,
          licenseId: 'lic-5', licensee: 'someone', issuedAt: null, expiresAt: null, keyId: 'k1'
        })
      });
    } finally {
      process.emitWarning = realEmitWarning;
    }
    return { result, named: warnings.filter(warning => warning.name === 'EntitlementAuditWriteFailed') };
  };

  // 1. The REAL failure contract: ok:false with an errors array.
  const statusFailure = runWith(() => ({
    ok: false, durable: false, disabled: false,
    errors: [{ code: 'AUDIT_SINK_UNWRITABLE', message: 'audit database is locked' }]
  }));
  assert.ok(statusFailure.result.entitlement.active, 'a paid customer must still be activated');
  assert.equal(statusFailure.named.length, 1,
    'ok:false is how a failed write is actually reported, and it must warn');
  assert.match(statusFailure.named[0].message, /AUDIT_SINK_UNWRITABLE/,
    'the warning must carry the cause, or it sends the reader nowhere');
  assert.ok(!statusFailure.named[0].message.includes(SECRET_KEY), 'not even the warning may carry the key');

  // 2. A throwing recorder still warns.
  const throwing = runWith(() => { throw new Error('audit database is locked'); });
  assert.ok(throwing.result.entitlement.active);
  assert.equal(throwing.named.length, 1);

  // 3. AUDITING SWITCHED OFF IS NOT A FAILURE. Warning on every activation for a
  // deliberate configuration would train the reader to ignore this warning,
  // which costs the one case it exists for.
  const disabled = runWith(() => ({ ok: false, disabled: true, errors: [] }));
  assert.ok(disabled.result.entitlement.active);
  assert.equal(disabled.named.length, 0, 'a disabled ledger is a choice, not a fault');

  // 4. The success path must stay silent.
  const success = runWith(() => ({ ok: true, durable: true, sequence: 1 }));
  assert.equal(success.named.length, 0, 'a successful write must not warn');
});

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }

process.stdout.write(`entitlement-activation-audit: ${checks} checks passed\n`);
