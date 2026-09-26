'use strict';

// One definition of provider-issued credential shapes currently accepted by
// vault consumers. Key-name redaction remains the primary control; these
// patterns catch a value that has already been flattened into free text.
const KNOWN_PROVIDER_CREDENTIAL_SOURCE = String.raw`(?:(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{24,}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]{8,}|1\/\/[A-Za-z0-9_-]{20,}|do[op]_v1_[A-Fa-f0-9]{40,}|tvly-[A-Za-z0-9_-]{20,}|pdl_[A-Za-z0-9_-]{20,}|IGQ[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})`;
const PLAINTEXT_CREDENTIAL_SOURCE = String.raw`(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\b${KNOWN_PROVIDER_CREDENTIAL_SOURCE}\b)`;

function knownProviderCredentialPattern(flags = 'i') {
  return new RegExp(String.raw`\b${KNOWN_PROVIDER_CREDENTIAL_SOURCE}\b`, flags);
}

function plaintextCredentialPattern(flags = 'i') {
  return new RegExp(PLAINTEXT_CREDENTIAL_SOURCE, flags);
}

/* IDS THIS PRODUCT MINTS FROM A DIGEST ARE NOT CREDENTIALS.
 *
 * A circle's agent id is `tree-` plus 24 lower-case hex characters of a
 * SHA-256 digest (agent-comms/tree-node-directory.js agentIdForSession), and
 * its inbox is `direct.` plus 64 (agent-comms/fabric.js streamIdForAudience).
 * The patterns above are case-insensitive, and EAA is also hex, so about one
 * inbox in 4,300 and one circle id in 4,100 begin `eaa` and matched the
 * Facebook token shape. The durable message store then refused every message
 * to or from that circle, for good, because its ids never change.
 *
 * A match is excused only when it lies wholly inside one of those two ids,
 * written exactly: lower-case hex of the exact length, with no letter, digit,
 * `_`, `-` or `.` on either side. Nothing a provider issues fits inside that:
 * the only pattern above that lower-case hex can satisfy is the EAA one. Every
 * other match in the same text is judged as before, so a token beside an id,
 * an id with anything added, `Bearer <id>`, and digest-looking text that is
 * not one of these ids are all still refused. */
const GENERATED_IDENTIFIER_SOURCE = String.raw`(?<![A-Za-z0-9_.-])(?:direct\.[0-9a-f]{64}|tree-[0-9a-f]{24})(?![A-Za-z0-9_-])`;

function plaintextCredentialOutsideGeneratedIds(text) {
  if (typeof text !== 'string') return false;
  let ids = null;
  for (const match of text.matchAll(plaintextCredentialPattern('gi'))) {
    if (ids === null) {
      ids = Array.from(text.matchAll(new RegExp(GENERATED_IDENTIFIER_SOURCE, 'g')),
        id => [id.index, id.index + id[0].length]);
    }
    const start = match.index;
    const end = start + match[0].length;
    if (!ids.some(([from, to]) => start >= from && end <= to)) return true;
  }
  return false;
}

module.exports = Object.freeze({
  GENERATED_IDENTIFIER_SOURCE,
  KNOWN_PROVIDER_CREDENTIAL_SOURCE,
  PLAINTEXT_CREDENTIAL_SOURCE,
  knownProviderCredentialPattern,
  plaintextCredentialOutsideGeneratedIds,
  plaintextCredentialPattern
});
