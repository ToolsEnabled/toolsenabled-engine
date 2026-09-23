'use strict';

// LICENCE VERIFICATION -- WHO IS ALLOWED TO SAY A LICENCE IS GENUINE.
//
// THIS FILE HAD NEVER BEEN WRITTEN. tests/providers.billing/run.js has required
// it since the day that runner was created, and `git log --all -- <this path>`
// was EMPTY -- so `npm run test:providers.billing` has never once completed, and
// the billing package's contracts have never been verified in any run, on any
// machine. The runner was not wrong to name it; the file simply did not exist.
//
// WHAT IT GUARDS, in the module's own words: "A signature check answers 'was
// this signed by key K'. It does NOT answer 'should I trust K'. Only a PINNED
// anchor answers the second question, and the second question is the only one
// that matters on a customer's machine."
//
// THE DEFECT THE MODULE RECORDS AS MEASURED, which is the reason this suite
// exists at all: `verifyKey` once defaulted `trustedPublicKeyPem` to `''`, and
// `publicKeyMaterial` read that falsy default as permission to derive the
// trusted key from LOCAL signing material -- which the vault would silently
// CREATE if it had none. A fresh install therefore minted its own vendor
// authority, believed it, issued itself `toolsenabled.team.v1`, and
// entitlement.js mapped that to the paid `team` tier and opened the
// `hosted-relay` gate. That is a free install granting itself paid
// infrastructure, and nothing in the tree would have failed.
//
// So the assertions below are not about arithmetic. Each one pins a place where
// "we could not establish this" must not become "this is fine":
//   * no trust anchor           -> REFUSE, never "trust whatever is on this disk"
//   * an anchor that cannot be READ -> a DIFFERENT refusal from one that is ABSENT
//   * revocation not checked    -> active === null, never true
//   * a revocation signed by anyone else -> refuse
//   * a licence-domain signature replayed as a revocation -> refuse
//
// Refusing is safe here precisely because of the policy in entitlement.js: an
// unlicensed install is fully functional forever, so failing closed withholds
// only paid vendor infrastructure and never local function.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalJson, sha256 } = require('../../src/lib/audit-store');
const license = require('../../src/lib/providers/license');

const {
  LICENSE_DOMAIN,
  REVOCATION_DOMAIN,
  TOKEN_PREFIX,
  LicenseTrustError,
  parseToken,
  publicKeyMaterial,
  readTrustAnchor,
  trustAnchorPath,
  verifyKey,
  verifyRevocation,
} = license;

/* ------------------------------------------------------------------ helpers */

const b64 = value => Buffer.from(value).toString('base64url');

function vendorKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = `license-ed25519-${sha256(publicKey.export({ type: 'spki', format: 'der' }))}`;
  return { publicKey, privateKey, publicKeyPem, keyId };
}

/* A real token, minted the way the vendor would. Built from the module's own
   constants rather than from literals, so a change to the domain or the prefix
   fails here instead of quietly producing a token this suite still accepts. */
function mintToken(vendor, overrides = {}) {
  const now = overrides.now === undefined ? Date.now() : overrides.now;
  const header = {
    alg: 'EdDSA',
    kid: overrides.kid || vendor.keyId,
    typ: 'TE-LICENSE',
    v: 1,
  };
  const claims = {
    domain: overrides.domain || LICENSE_DOMAIN,
    expiresAtMs: overrides.expiresAtMs === undefined ? now + 86400000 : overrides.expiresAtMs,
    issuedAtMs: overrides.issuedAtMs === undefined ? now - 1000 : overrides.issuedAtMs,
    licenseId: overrides.licenseId || 'lic_testfixture0000001',
    licensee: overrides.licensee || 'fixture@example.test',
    product: overrides.product || 'toolsenabled.team.v1',
    version: 1,
  };
  const headerPart = b64(canonicalJson(header));
  const claimsPart = b64(canonicalJson(claims));
  const protectedPart = `${TOKEN_PREFIX}.${headerPart}.${claimsPart}`;
  const signer = overrides.signWith || vendor.privateKey;
  const signature = crypto.sign(null, Buffer.from(protectedPart, 'utf8'), signer);
  return { token: `${protectedPart}.${signature.toString('base64url')}`, header, claims, protectedPart };
}

function mintRevocation(vendor, overrides = {}) {
  const payload = {
    domain: REVOCATION_DOMAIN,
    keyId: overrides.keyId || vendor.keyId,
    licenseId: overrides.licenseId || 'lic_testfixture0000001',
    reason: overrides.reason || 'refunded',
    revokedAtMs: overrides.revokedAtMs === undefined ? Date.now() - 5000 : overrides.revokedAtMs,
    version: 1,
  };
  const signer = overrides.signWith || vendor.privateKey;
  const signature = overrides.signature !== undefined
    ? overrides.signature
    : crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), signer).toString('base64url');
  return { ...payload, signature };
}

/* A store the module will read for revocations. `get` is the only verb used. */
const storeReturning = record => ({ get: () => record });

function scratchRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `license-provider-${label}-`));
}

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

/* --------------------------------------------------- the trust anchor itself */

check('T1 no trust anchor refuses by name rather than trusting anything on disk', () => {
  const root = scratchRoot('no-anchor');
  try {
    const missing = { code: 'ENOENT' };
    const io = { readFileSync: () => { const error = new Error('nope'); error.code = missing.code; throw error; } };
    assert.equal(readTrustAnchor({ fs: io, root }), null,
      'an absent anchor file is ABSENCE and must read as null');
    assert.throws(
      () => publicKeyMaterial(undefined, { fs: io, root }),
      error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_MISSING',
      'with no anchor, resolving a trusted key must REFUSE -- never fall back to a key this machine holds',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('T2 an anchor that cannot be READ is a different answer from one that is ABSENT', () => {
  /* THE DISTINCTION THIS WHOLE CODEBASE KEEPS RELEARNING. A permissions error is
     not "there is no vendor key"; collapsing the two would let a machine that
     merely cannot open the file behave exactly like one shipped without a key. */
  const io = {
    readFileSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
  };
  assert.throws(
    () => readTrustAnchor({ fs: io }),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_UNREADABLE',
    'an unreadable anchor must raise UNREADABLE, not return null like an absent one',
  );
});

check('T3 a malformed anchor refuses instead of being partly believed', () => {
  const notJson = { readFileSync: () => '{ this is not json' };
  assert.throws(
    () => readTrustAnchor({ fs: notJson }),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_MALFORMED',
  );
  const notObject = { readFileSync: () => '["an array is not an anchor"]' };
  assert.throws(
    () => readTrustAnchor({ fs: notObject }),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_MALFORMED',
  );
});

check('T4 an anchor carrying no key is absence, and absence still refuses', () => {
  const empty = { readFileSync: () => JSON.stringify({ publicKeyPem: '   ' }) };
  assert.equal(readTrustAnchor({ fs: empty }), null,
    'an anchor present but keyless is how a build says it ships no vendor key');
  assert.throws(
    () => publicKeyMaterial(undefined, { fs: empty }),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_MISSING',
    'and that must still refuse, never read as "then trust anything"',
  );
});

check('T5 a non-Ed25519 anchor is refused', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(
    () => publicKeyMaterial(pem, {}),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_INVALID',
    'only Ed25519 may anchor a licence; another algorithm is a refusal, not a warning',
  );
});

check('T6 an anchor whose declared keyId disagrees with its own key is refused', () => {
  const vendor = vendorKeyPair();
  const lying = {
    readFileSync: () => JSON.stringify({
      publicKeyPem: vendor.publicKeyPem,
      keyId: 'license-ed25519-' + 'a'.repeat(64),
    }),
  };
  assert.throws(
    () => publicKeyMaterial(undefined, { fs: lying }),
    error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_INVALID',
    'a keyId that does not match the key beside it is a disagreement, and a disagreement is a refusal',
  );
});

check('T7 the keyId is derived from the key, so two anchors cannot collide', () => {
  const first = vendorKeyPair();
  const second = vendorKeyPair();
  const a = publicKeyMaterial(first.publicKeyPem, {});
  const b = publicKeyMaterial(second.publicKeyPem, {});
  assert.equal(a.keyId, first.keyId);
  assert.notEqual(a.keyId, b.keyId, 'distinct vendor keys must produce distinct key ids');
  assert.match(a.keyId, /^license-ed25519-[a-f0-9]{64}$/);
});

check('T8 there is no fourth source: the environment cannot supply an anchor', () => {
  /* "Anything an attacker on the box can set is not an anchor" -- the module says
     so, and this pins it. Every plausible environment spelling is set to a REAL,
     well-formed vendor key; resolution must still refuse, because the only legal
     sources are an explicit argument, an injected dependency, and the shipped
     anchor file. */
  const vendor = vendorKeyPair();
  const names = [
    'TOOLSENABLED_LICENSE_PUBLIC_KEY',
    'TOOLSENABLED_LICENSE_TRUST_ANCHOR',
    'TOOLSENABLED_TRUSTED_PUBLIC_KEY_PEM',
    'LICENSE_PUBLIC_KEY_PEM',
  ];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = vendor.publicKeyPem;
    const io = { readFileSync: () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; } };
    assert.throws(
      () => publicKeyMaterial(undefined, { fs: io }),
      error => error instanceof LicenseTrustError && error.code === 'LICENSE_TRUST_ANCHOR_MISSING',
      'an environment variable must never become a trust anchor',
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

check('T9 the anchor path is inside the install, and is stated rather than guessed', () => {
  const where = trustAnchorPath({});
  assert.equal(typeof where, 'string');
  assert.ok(where.length > 0);
  assert.ok(/license-trust\.json$/.test(where),
    'the anchor is config/license-trust.json so it can be rotated without a release');
});

/* ----------------------------------------------------------- token integrity */

check('P1 a genuine token from the trusted key verifies', () => {
  const vendor = vendorKeyPair();
  const { token } = mintToken(vendor);
  const result = verifyKey(
    { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: false },
    { store: storeReturning(null) },
  );
  assert.equal(result.valid, true);
  assert.equal(result.product, 'toolsenabled.team.v1');
  assert.equal(result.keyId, vendor.keyId);
});

check('P2 a token signed by ANY other key is refused', () => {
  /* The whole point of an anchor: a perfectly well-formed, correctly self-signed
     token from a key nobody pinned must not verify. This is the shape the old
     defect produced -- a locally minted key signing a locally minted licence. */
  const vendor = vendorKeyPair();
  const impostor = vendorKeyPair();
  const { token } = mintToken(impostor);
  assert.throws(
    () => verifyKey(
      { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: false },
      { store: storeReturning(null) },
    ),
    /not signed by the trusted key|signature verification failed/,
  );
});

check('P3 a tampered signature is refused', () => {
  const vendor = vendorKeyPair();
  const minted = mintToken(vendor);
  const other = mintToken(vendor, { licenseId: 'lic_testfixture0000002' });
  const spliced = `${minted.protectedPart}.${other.token.split('.')[3]}`;
  assert.throws(
    () => verifyKey(
      { licenseKey: spliced, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: false },
      { store: storeReturning(null) },
    ),
    /signature verification failed/,
  );
});

check('P4 a token claiming the trusted keyId but signed by another key is refused', () => {
  /* The kid is a HINT, not evidence. Asserting the trusted kid must not get an
     impostor past the cryptographic check. */
  const vendor = vendorKeyPair();
  const impostor = vendorKeyPair();
  const { token } = mintToken(impostor, { kid: vendor.keyId });
  assert.throws(
    () => verifyKey(
      { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: false },
      { store: storeReturning(null) },
    ),
    /signature verification failed/,
    'a matching kid must not substitute for a matching signature',
  );
});

check('P5 a token from another DOMAIN is refused', () => {
  const vendor = vendorKeyPair();
  const { token } = mintToken(vendor, { domain: REVOCATION_DOMAIN });
  assert.throws(() => parseToken(token), /claims are invalid/,
    'domain separation: a revocation-domain payload is not a licence');
});

check('P6 a token that is not the ToolsEnabled format is refused', () => {
  const vendor = vendorKeyPair();
  const { token } = mintToken(vendor);
  const wrongPrefix = token.replace(new RegExp(`^${TOKEN_PREFIX}\\.`), 'xx1.');
  assert.throws(() => parseToken(wrongPrefix), /does not use the ToolsEnabled license format/);
  assert.throws(() => parseToken('not-a-token'), /does not use the ToolsEnabled license format/);
});

check('P7 non-canonical encoding is refused, so one licence has one representation', () => {
  const vendor = vendorKeyPair();
  const minted = mintToken(vendor);
  const parts = minted.token.split('.');
  const padded = `${parts[0]}.${parts[1]}=.${parts[2]}.${parts[3]}`;
  assert.throws(() => parseToken(padded), /base64url/,
    'a second spelling of the same bytes must not be a second valid token');
});

/* -------------------------------------------------------------- revocation */

check('R1 revocation NOT CHECKED reports active:null, never true', () => {
  /* THE COULD-NOT-COLLAPSE RULE, WHERE IT COSTS MONEY. Skipping the revocation
     read establishes only that a signed token is unexpired. Reporting that as
     `active: true` would let a refunded, revoked licence read as live merely
     because nobody looked. */
  const vendor = vendorKeyPair();
  const { token } = mintToken(vendor);
  const result = verifyKey(
    { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: false },
    { store: storeReturning(null) },
  );
  assert.equal(result.valid, true, 'the signature was still verified');
  assert.equal(result.active, null, 'an unchecked revocation state must stay unknown');
  assert.notEqual(result.active, true, 'and must never be reported as active');
  assert.equal(result.reason, 'revocation-not-checked');
});

check('R2 a revoked licence is not active, and says why', () => {
  const vendor = vendorKeyPair();
  const { token } = mintToken(vendor);
  const revocation = mintRevocation(vendor);
  const result = verifyKey(
    { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: true },
    { store: storeReturning(revocation) },
  );
  assert.equal(result.valid, true);
  assert.equal(result.active, false);
  assert.equal(result.reason, 'revoked');
});

check('R3 an expired licence is not active, and says why', () => {
  const vendor = vendorKeyPair();
  const past = Date.now() - 10000;
  const { token } = mintToken(vendor, { issuedAtMs: past - 1000, expiresAtMs: past });
  const result = verifyKey(
    { licenseKey: token, trustedPublicKeyPem: vendor.publicKeyPem, checkRevocation: true },
    { store: storeReturning(null) },
  );
  assert.equal(result.active, false);
  assert.equal(result.reason, 'expired');
});

check('R4 a revocation signed by anyone but the trusted key is refused', () => {
  /* Otherwise anybody who can write the local store could revoke a licence they
     did not issue -- a denial of service against a paying customer. */
  const vendor = vendorKeyPair();
  const impostor = vendorKeyPair();
  const trusted = publicKeyMaterial(vendor.publicKeyPem, {});
  const forged = mintRevocation(vendor, { keyId: vendor.keyId, signWith: impostor.privateKey });
  assert.throws(() => verifyRevocation(forged, trusted), /invalid signature/);
});

check('R5 a revocation naming another keyId is refused', () => {
  const vendor = vendorKeyPair();
  const impostor = vendorKeyPair();
  const trusted = publicKeyMaterial(vendor.publicKeyPem, {});
  const otherKey = mintRevocation(impostor);
  assert.throws(() => verifyRevocation(otherKey, trusted), /invalid signature/);
});

check('R6 a malformed revocation signature is refused, not ignored', () => {
  const vendor = vendorKeyPair();
  const trusted = publicKeyMaterial(vendor.publicKeyPem, {});
  const malformed = mintRevocation(vendor, { signature: 'not base64url!!' });
  assert.throws(() => verifyRevocation(malformed, trusted), /malformed/);
});

check('R7 a LICENCE signature replayed as a revocation is refused', () => {
  /* Domain separation, from the attacking side. The vendor genuinely signed the
     licence payload; that signature must not also authorise a revocation. */
  const vendor = vendorKeyPair();
  const trusted = publicKeyMaterial(vendor.publicKeyPem, {});
  const minted = mintToken(vendor);
  const licenceSignature = minted.token.split('.')[3];
  const replayed = mintRevocation(vendor, { signature: licenceSignature });
  assert.throws(() => verifyRevocation(replayed, trusted), /invalid signature/,
    'a signature made in the licence domain must not validate in the revocation domain');
});

check('R8 no revocation record means no revocation, and that is a measured answer', () => {
  const vendor = vendorKeyPair();
  const trusted = publicKeyMaterial(vendor.publicKeyPem, {});
  assert.equal(verifyRevocation(null, trusted), null,
    'an absent record is a definite "not revoked" -- unlike an unread one, which R1 covers');
});

/* ------------------------------------------------------------------- close */

console.log(`\nlicense-provider: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
