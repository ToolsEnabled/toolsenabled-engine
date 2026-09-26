'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { canonicalJson, sha256 } = require('../audit-store');
const { rootPath } = require('../runtime');
const { record } = require('../audit');
const { getLicenseStore } = require('../license-store');

const LICENSE_VAULT_KEY = 'toolsenabled_license_signing_key_v1';
const LICENSE_DOMAIN = 'toolsenabled.license.v1';
const REVOCATION_DOMAIN = 'toolsenabled.license.revocation.v1';
const TOKEN_PREFIX = 'te1';

// ---------------------------------------------------------------------------
// WHO IS ALLOWED TO SAY A LICENCE IS GENUINE.
//
// A signature check answers "was this signed by key K". It does NOT answer
// "should I trust K". Only a PINNED anchor answers the second question, and
// the second question is the only one that matters on a customer's machine.
//
// The defect this replaces: `verifyKey` defaulted `trustedPublicKeyPem` to `''`,
// and `publicKeyMaterial` read that falsy default as permission to derive the
// trusted key from the LOCAL signing material -- which `signingMaterial()` would
// silently CREATE if the vault had none. A fresh install therefore minted its
// own vendor authority and then believed it: issuing
// `product: 'toolsenabled.team.v1'` and verifying it returned
// `{valid:true, active:true}`, and `entitlement.js` mapped that product to the
// paid `team` tier and opened the `hosted-relay` gate. Measured, not theorised.
//
// This is the "absence read as consent" class: a destructured default turned
// "the caller supplied no trust anchor" into "trust whatever is on this disk".
// The correct reading of absence, for a TRUST decision specifically, is REFUSE.
//
// Refusing here is safe precisely because of the policy in `entitlement.js`: an
// unlicensed install is fully functional, forever. Failing closed on licence
// verification withholds only PAID infrastructure, never local function -- so
// the fail-closed direction and the free-tier promise point the same way. That
// is why this file may refuse without turning absence into a broken product.
// ---------------------------------------------------------------------------

/**
 * The vendor trust anchor, shipped as CONFIGURATION rather than compiled in so
 * the owner can rotate it without a release. A PUBLIC key is safe to ship and
 * safe to read; only the private half is secret and that never leaves the vault.
 *
 * Shape: {"publicKeyPem": "-----BEGIN PUBLIC KEY-----\n..."} (`keyId` optional
 * and, if present, must agree with the key -- a disagreement is a refusal, not
 * a warning).
 */
const TRUST_ANCHOR_RELATIVE_PATH = ['config', 'license-trust.json'];

class LicenseTrustError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LicenseTrustError';
    this.code = code;
    this.details = details;
  }
}

function encoded(value) {
  return Buffer.from(value).toString('base64url');
}

function decoded(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not valid base64url.`);
  const output = Buffer.from(value, 'base64url');
  if (output.toString('base64url') !== value) throw new Error(`${label} is not canonical base64url.`);
  return output;
}

function parseTime(value, label) {
  if (typeof value !== 'string' || !value || value.length > 50) throw new Error(`${label} must be an RFC3339 timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be an RFC3339 timestamp.`);
  return parsed;
}

function field(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be 1-${maximum} characters without control characters.`);
  }
  return value;
}

function licenseId(value) {
  if (value === undefined || value === '') return `lic_${crypto.randomUUID().replace(/-/g, '')}`;
  if (typeof value !== 'string' || !/^lic_[A-Za-z0-9_-]{8,120}$/.test(value)) throw new Error('licenseId is invalid.');
  return value;
}

function splitToken(licenseKey) {
  if (typeof licenseKey !== 'string' || licenseKey.length > 8192) throw new Error('licenseKey is invalid.');
  const parts = licenseKey.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) throw new Error('licenseKey does not use the ToolsEnabled license format.');
  return { protectedPart: `${parts[0]}.${parts[1]}.${parts[2]}`, headerPart: parts[1], claimsPart: parts[2], signaturePart: parts[3] };
}

function parseToken(licenseKey) {
  const parts = splitToken(licenseKey);
  let header;
  let claims;
  try {
    const headerText = decoded(parts.headerPart, 'license header').toString('utf8');
    const claimsText = decoded(parts.claimsPart, 'license claims').toString('utf8');
    header = JSON.parse(headerText);
    claims = JSON.parse(claimsText);
    if (canonicalJson(header) !== headerText || canonicalJson(claims) !== claimsText) {
      throw new Error('non-canonical');
    }
  } catch (error) {
    if (/base64url/.test(String(error && error.message))) throw error;
    throw new Error('licenseKey contains invalid or non-canonical JSON.');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      header.alg !== 'EdDSA' || header.typ !== 'TE-LICENSE' || header.v !== 1 ||
      typeof header.kid !== 'string' || !/^license-ed25519-[a-f0-9]{64}$/.test(header.kid)) {
    throw new Error('licenseKey header is invalid.');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
      claims.domain !== LICENSE_DOMAIN || claims.version !== 1 ||
      typeof claims.licenseId !== 'string' || !/^lic_[A-Za-z0-9_-]{8,120}$/.test(claims.licenseId) ||
      typeof claims.product !== 'string' || typeof claims.licensee !== 'string' ||
      !Number.isSafeInteger(claims.issuedAtMs) || !Number.isSafeInteger(claims.expiresAtMs) ||
      claims.issuedAtMs < 0 || claims.expiresAtMs <= claims.issuedAtMs) {
    throw new Error('licenseKey claims are invalid.');
  }
  field(claims.product, 'licenseKey product', 120);
  field(claims.licensee, 'licenseKey licensee', 320);
  return { ...parts, header, claims, signature: decoded(parts.signaturePart, 'license signature') };
}

/** Absolute path of the shipped vendor trust anchor. */
function trustAnchorPath(dependencies = {}) {
  if (typeof dependencies.trustAnchorPath === 'string' && dependencies.trustAnchorPath) {
    return dependencies.trustAnchorPath;
  }
  return rootPath(...TRUST_ANCHOR_RELATIVE_PATH);
}

/**
 * Read the shipped vendor public key, or return null if this build ships none.
 *
 * A file that exists but is unusable is NOT null -- it throws. "There is no
 * anchor" and "the anchor is corrupt" are different facts and collapsing them
 * would let a damaged anchor quietly degrade into some other trust decision.
 */
function readTrustAnchor(dependencies = {}) {
  if (typeof dependencies.trustedPublicKeyPem === 'string' && dependencies.trustedPublicKeyPem.trim()) {
    return { pem: dependencies.trustedPublicKeyPem.trim(), source: 'dependency', path: null };
  }
  const io = dependencies.fs || fs;
  const file = trustAnchorPath(dependencies);
  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new LicenseTrustError(
      'LICENSE_TRUST_ANCHOR_UNREADABLE',
      `The licence trust anchor at ${file} exists but could not be read (${error && error.code}).`,
      { path: file }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LicenseTrustError(
      'LICENSE_TRUST_ANCHOR_MALFORMED',
      `The licence trust anchor at ${file} is not valid JSON (${error && error.message}).`,
      { path: file }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LicenseTrustError('LICENSE_TRUST_ANCHOR_MALFORMED',
      `The licence trust anchor at ${file} must be a JSON object.`, { path: file });
  }
  const pem = typeof parsed.publicKeyPem === 'string' ? parsed.publicKeyPem.trim() : '';
  // An anchor file present but carrying no key is ABSENCE, not corruption: it is
  // how a build says "this release ships no vendor key". Treated as no anchor,
  // which refuses -- it must never read as "then trust anything".
  if (!pem) return null;
  return { pem, source: 'vendor-config', path: file, declaredKeyId: typeof parsed.keyId === 'string' ? parsed.keyId : null };
}

/**
 * Resolve the key this verification will TRUST.
 *
 * Order: an explicitly supplied PEM, then a dependency-injected one, then the
 * shipped vendor anchor. There is deliberately no fourth source. In particular
 * the local signing material is NOT a source -- deriving trust from a key this
 * machine holds the private half of is precisely the defect being removed, and
 * there is no environment-variable source either, because anything an attacker
 * on the box can set is not an anchor.
 *
 * No anchor => THROW. Never "trust the local key", never "valid: true".
 */
function publicKeyMaterial(publicKeyPem, dependencies = {}) {
  let pem;
  let source;
  let declaredKeyId = null;
  if (typeof publicKeyPem === 'string' && publicKeyPem.trim()) {
    pem = publicKeyPem.trim();
    source = 'explicit';
  } else {
    const anchor = readTrustAnchor(dependencies);
    if (!anchor) {
      throw new LicenseTrustError(
        'LICENSE_TRUST_ANCHOR_MISSING',
        'No licence trust anchor is configured, so no licence can be verified. '
        + `Ship the vendor public key at ${trustAnchorPath(dependencies)} as `
        + '{"publicKeyPem": "-----BEGIN PUBLIC KEY-----..."}, or pass trustedPublicKeyPem '
        + 'explicitly. This install keeps working fully without a licence; only paid, '
        + 'vendor-operated infrastructure is withheld.',
        { path: trustAnchorPath(dependencies) }
      );
    }
    pem = anchor.pem;
    source = anchor.source;
    declaredKeyId = anchor.declaredKeyId || null;
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch {
    throw new LicenseTrustError('LICENSE_TRUST_ANCHOR_INVALID',
      `The trusted licence public key (${source}) is not a readable public key.`, { source });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new LicenseTrustError('LICENSE_TRUST_ANCHOR_INVALID',
      `The trusted licence public key (${source}) must be Ed25519.`, { source });
  }
  const keyId = `license-ed25519-${sha256(publicKey.export({ type: 'spki', format: 'der' }))}`;
  if (declaredKeyId && declaredKeyId !== keyId) {
    throw new LicenseTrustError('LICENSE_TRUST_ANCHOR_INVALID',
      'The licence trust anchor declares a keyId that does not match its own public key.',
      { source, declaredKeyId, actualKeyId: keyId });
  }
  return { publicKey, keyId, source };
}

function verifyRevocation(revocation, trusted) {
  if (!revocation) return null;
  const payload = {
    domain: REVOCATION_DOMAIN,
    version: 1,
    licenseId: revocation.licenseId,
    revokedAtMs: revocation.revokedAtMs,
    reason: revocation.reason,
    keyId: revocation.keyId
  };
  let signature;
  try { signature = decoded(revocation.signature, 'revocation signature'); }
  catch { throw new Error('The local license revocation record is malformed.'); }
  if (revocation.keyId !== trusted.keyId ||
      !crypto.verify(null, Buffer.from(canonicalJson(payload), 'utf8'), trusted.publicKey, signature)) {
    throw new Error('The local license revocation record has an invalid signature.');
  }
  return payload;
}

// NOTE: `trustedPublicKeyPem` deliberately has NO default value. It previously
// defaulted to `''`, and that empty string was the whole vulnerability: it made
// "the caller named no trusted key" indistinguishable from "the caller named the
// local one". Absent now means absent, and `publicKeyMaterial` refuses it.
function verifyKey({
  licenseKey,
  trustedPublicKeyPem,
  checkRevocation = true
}, dependencies = {}) {
  const parsed = parseToken(licenseKey);
  const trusted = publicKeyMaterial(trustedPublicKeyPem, dependencies);
  if (parsed.header.kid !== trusted.keyId) throw new Error('licenseKey was not signed by the trusted key.');
  if (!crypto.verify(null, Buffer.from(parsed.protectedPart, 'utf8'), trusted.publicKey, parsed.signature)) {
    throw new Error('licenseKey signature verification failed.');
  }
  const now = (dependencies.now || (() => Date.now()))();
  const revocation = checkRevocation
    ? verifyRevocation((dependencies.store || getLicenseStore()).get(parsed.claims.licenseId), trusted)
    : null;
  const revocationChecked = Boolean(checkRevocation);
  const expired = now >= parsed.claims.expiresAtMs;
  const output = {
    valid: true,
    // Skipping the revocation read establishes only that the signed token is
    // unexpired, not that the licence is active. Preserve that uncertainty
    // rather than collapsing the unmeasured revocation state into `active`.
    active: revocationChecked ? !expired && !revocation : null,
    reason: revocationChecked
      ? (revocation ? 'revoked' : (expired ? 'expired' : null))
      : 'revocation-not-checked',
    licenseId: parsed.claims.licenseId,
    product: parsed.claims.product,
    licensee: parsed.claims.licensee,
    issuedAt: new Date(parsed.claims.issuedAtMs).toISOString(),
    expiresAt: new Date(parsed.claims.expiresAtMs).toISOString(),
    keyId: parsed.header.kid
  };
  if (revocation) {
    output.revokedAt = new Date(revocation.revokedAtMs).toISOString();
    output.revocationReason = revocation.reason;
  }
  (dependencies.record || record)('license.key_verify', output.licenseId, {
    active: output.active, reason: output.reason, product: output.product, keyId: output.keyId,
    revocationChecked
  });
  return output;
}

module.exports = {
  LICENSE_DOMAIN,
  LICENSE_VAULT_KEY,
  LicenseTrustError,
  REVOCATION_DOMAIN,
  TOKEN_PREFIX,
  TRUST_ANCHOR_RELATIVE_PATH,
  parseToken,
  publicKeyMaterial,
  readTrustAnchor,
  trustAnchorPath,
  verifyKey,
  verifyRevocation,
  // Shared with ./license-issuance, which is withheld from publication. These
  // are parsing and validation helpers, not signing: exporting them keeps ONE
  // definition of the token grammar rather than a second copy in the vendor
  // half that could drift from what verification actually accepts.
  encoded,
  decoded,
  field,
  licenseId,
  parseTime,
  splitToken
};
