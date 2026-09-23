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

module.exports = Object.freeze({
  KNOWN_PROVIDER_CREDENTIAL_SOURCE,
  PLAINTEXT_CREDENTIAL_SOURCE,
  knownProviderCredentialPattern,
  plaintextCredentialPattern
});
