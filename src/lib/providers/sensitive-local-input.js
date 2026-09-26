'use strict';

// Conservative data-loss guard shared by bounded local-model adapters. This
// detects recognizable credential/session material and private vault/profile
// paths; it is not claimed to discover every secret. Callers still have no
// vault, session, or tool capability even when a string passes this guard.
const FORMAT_OR_ZERO_WIDTH = /\p{Cf}/gu;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
// MEASURED: the "session" alternative's suffix used to be OPTIONAL
// (`session(?:[ _-]?(?:id|token|cookie))?`), so bare "session" followed by
// ":"/"=" and any word already matched the whole pattern -- the same
// treatment as "password" or "api key". That caught two things that are not
// secrets in this codebase: an ordinary sentence using "session:" as a label,
// and the sessionId this engine already hands between agents as a plain
// routing address (spawnSubagent's parentSessionId in tool-registry.js,
// tree-node-directory.js's stored sessionId field -- never redacted
// elsewhere). The suffix is now REQUIRED and narrowed to "token"/"cookie",
// the two words that actually name a bearer value; "id" is dropped because a
// session id is an address here, not a credential. Nothing that named a real
// secret stops matching: "session cookie: x" is still caught by the bare
// "cookie" alternative two entries earlier in this same pattern.
const SECRET_OR_SESSION = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|set-cookie|password|passphrase|session[ _-]?(?:token|cookie))\s*[:=]\s*\S+/i;
const PRIVATE_PATH = /(?:^|[\s"'])((?:[A-Za-z]:)?[\\/](?:[^\s"']*[\\/])?(?:vault|profiles)[\\/])/im;
const PROFILE_MATERIAL = /\b(?:vault|profiles?)\b/i;
const AUTHORITY_TEXT = /\b(?:apply|tool|account|http)\b|https?:\/\/|www\./i;

// Small, explicit skeleton only for the most common Latin/Cyrillic/Greek
// confusables. It is not used to reinterpret content; it exists solely to
// detect attempts to hide a sensitive or authority-bearing word.
const CONFUSABLE_ASCII = Object.freeze({
  '\u0391': 'a', '\u0410': 'a', '\u0430': 'a', '\u0392': 'b', '\u0412': 'b', '\u0432': 'b',
  '\u0395': 'e', '\u0415': 'e', '\u0435': 'e', '\u0397': 'h', '\u041d': 'h', '\u043d': 'h',
  '\u0399': 'i', '\u0406': 'i', '\u0456': 'i', '\u039a': 'k', '\u041a': 'k', '\u043a': 'k',
  '\u039c': 'm', '\u041c': 'm', '\u043c': 'm', '\u039d': 'n', '\u039f': 'o', '\u041e': 'o',
  '\u043e': 'o', '\u03a1': 'p', '\u0420': 'p', '\u0440': 'p', '\u03a4': 't', '\u0422': 't',
  '\u0442': 't', '\u03a5': 'y', '\u0423': 'y', '\u0443': 'y', '\u03a7': 'x', '\u0425': 'x', '\u0445': 'x'
});

function decodePercentPass(value) {
  // A malformed percent run cannot be inspected reliably. Let URIError reach
  // the caller so the enclosing input check refuses instead of treating the
  // still-encoded text as established non-sensitive content.
  return String(value || '').replace(PERCENT_RUN, encoded => decodeURIComponent(encoded));
}

function decodePercentBounded(value, maxPasses = 3) {
  let current = String(value || '');
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next = decodePercentPass(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizeForDetection(value, maxPasses = 3) {
  let current = String(value || '');
  // Percent decoding and Unicode normalization must alternate: NFKC can turn
  // a full-width percent sign into "%", which then needs one bounded decode
  // pass before path/sensitive matching. Every pass only reduces ambiguity.
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next = decodePercentPass(current).normalize('NFKC').replace(FORMAT_OR_ZERO_WIDTH, '');
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizePathForDetection(value) {
  const pieces = String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').split('/');
  const resolved = [];
  for (const piece of pieces) {
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      if (resolved.length && resolved.at(-1) !== '..') resolved.pop();
      else resolved.push(piece);
      continue;
    }
    resolved.push(piece);
  }
  return resolved.join('/');
}

function skeleton(value) {
  return Array.from(String(value || ''), character => CONFUSABLE_ASCII[character] || character).join('');
}

function inspectLocalInput(value) {
  const normalized = normalizeForDetection(value);
  const canonicalPath = normalizePathForDetection(normalized);
  const canonicalSkeleton = skeleton(normalized);
  const pathSkeleton = normalizePathForDetection(canonicalSkeleton);
  const hasNonAscii = /[^\x00-\x7F]/.test(normalized);
  const sensitive = SECRET_OR_SESSION.test(normalized) || SECRET_OR_SESSION.test(canonicalSkeleton)
    || PRIVATE_PATH.test(normalized) || PRIVATE_PATH.test(canonicalSkeleton);
  const profileMaterial = PROFILE_MATERIAL.test(normalized) || PROFILE_MATERIAL.test(canonicalSkeleton)
    || PROFILE_MATERIAL.test(canonicalPath) || PROFILE_MATERIAL.test(pathSkeleton);
  const authority = AUTHORITY_TEXT.test(normalized) || AUTHORITY_TEXT.test(canonicalSkeleton);
  const pathLike = /(?:^|\/)[^/]*$/.test(canonicalPath) && (/[\\/]/.test(normalized) || /(?:^|\/)\.\.?\//.test(normalized));
  return Object.freeze({ hasNonAscii, sensitive, profileMaterial, authority, pathLike });
}

function containsSensitiveMaterial(value) {
  const inspected = inspectLocalInput(value);
  return inspected.sensitive;
}

function containsQuickEditSensitiveMaterial(value) {
  const inspected = inspectLocalInput(value);
  return inspected.sensitive || inspected.profileMaterial
    || (inspected.hasNonAscii && (inspected.pathLike || inspected.authority));
}

function containsQuickEditAuthorityInstruction(value) {
  const inspected = inspectLocalInput(value);
  // An edit instruction controls a model decision, so it is authority-bearing
  // by definition. Reject non-ASCII here rather than guessing whether a
  // confusable was benign; source data has a narrower rule above.
  return inspected.authority || inspected.hasNonAscii;
}

module.exports = {
  containsQuickEditAuthorityInstruction, containsQuickEditSensitiveMaterial,
  containsSensitiveMaterial, decodePercentBounded, inspectLocalInput, normalizeForDetection, normalizePathForDetection
};
