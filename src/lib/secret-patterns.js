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

/* THE SAME EXCUSE, FOR THE IDS ENGINEERING TEXT IS ACTUALLY MADE OF.
 *
 * 2026-09-24: the one Ledger's words door refused checkpoints and filings on
 * T1812, T1821, T1867, T1888 and T1766 -- five real results, lost -- because
 * its `LONG_TOKEN_RUN` reads any unbroken run of forty or more
 * `[A-Za-z0-9_-]` characters holding a letter and a digit as a key's shape.
 * `-` is in that class, so a 40-character git object id (exactly 40), a
 * `node-<uuid>` (41), a `gen-<uuid>` (40) and a `sess-<40 hex>` (45) are each
 * one such run. Refusing them is refusing the only precise way to say WHICH
 * commit, WHICH node or WHICH session a result belongs to.
 *
 * So this is the wider allowlist: the shapes this product and git MINT, which
 * a person writes down on purpose. It is deliberately narrow, and narrowness
 * is the whole safety argument:
 *   - lower-case hex only, at EXACTLY the two object-id lengths (40 for
 *     SHA-1, 64 for SHA-256) -- any other length of hex is not an id's shape
 *     and stays refused, which is why 48 hex characters still read as a key;
 *   - a uuid only in its exact 8-4-4-4-12 lower-case form;
 *   - a prefixed id only from a closed list of the prefixes this product
 *     mints, and only with a uuid or an object id after it;
 *   - written exactly, with no letter, digit, `_`, `-` or `.` on either side,
 *     so an id with anything glued to it is not the id.
 * Nothing a provider issues fits inside that: every pattern above needs either
 * a prefix (`sk-`, `ghp_`, `AIza`, ...) or a character class wider than
 * lower-case hex. A match anywhere OUTSIDE one of these ids is judged exactly
 * as before, so a credential beside an id, `Bearer <id>`, and a high-entropy
 * run that is not one of these shapes are all still refused.
 *
 * This allowlist excuses ONLY the long-run heuristic at its one call site
 * (src/lib/r-ledger-agent-gate.js looksSecretShaped). It never excuses the
 * audit scrubber's judgement and never excuses a named `token:`/`password:`
 * prefix; those still refuse on their own. */
const OBJECT_ID_SOURCE = String.raw`(?:[0-9a-f]{40}|[0-9a-f]{64})`;
const UUID_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
// The prefixes this product mints an id under. A closed list on purpose: an
// unknown prefix is not excused.
const MINTED_ID_PREFIX_SOURCE = String.raw`(?:node|gen|sess|session|thread|agent|worker|controller|lane|run|job|task|build|repair|req|msg|tree|checkpoint)`;
const SAFE_IDENTIFIER_SOURCE = String.raw`(?<![A-Za-z0-9_.-])(?:direct\.[0-9a-f]{64}|tree-[0-9a-f]{24}|${MINTED_ID_PREFIX_SOURCE}-(?:${UUID_SOURCE}|${OBJECT_ID_SOURCE})|${UUID_SOURCE}|${OBJECT_ID_SOURCE})(?![A-Za-z0-9_-])`;

/* True when `pattern` matches `text` anywhere that is NOT wholly inside one of
   `allowlistSource`'s ids. One definition of "wholly inside", shared by both
   callers below, so neither can drift into a looser test than the other. */
function matchedOutside(text, pattern, allowlistSource) {
  if (typeof text !== 'string' || text === '') return false;
  const scan = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  let ids = null;
  for (const match of text.matchAll(scan)) {
    if (ids === null) {
      ids = Array.from(text.matchAll(new RegExp(allowlistSource, 'g')),
        id => [id.index, id.index + id[0].length]);
    }
    const start = match.index;
    const end = start + match[0].length;
    if (!ids.some(([from, to]) => start >= from && end <= to)) return true;
  }
  return false;
}

function plaintextCredentialOutsideGeneratedIds(text) {
  return matchedOutside(text, plaintextCredentialPattern('gi'), GENERATED_IDENTIFIER_SOURCE);
}

function matchedOutsideSafeIdentifiers(text, pattern) {
  return matchedOutside(text, pattern, SAFE_IDENTIFIER_SOURCE);
}

module.exports = Object.freeze({
  GENERATED_IDENTIFIER_SOURCE,
  KNOWN_PROVIDER_CREDENTIAL_SOURCE,
  MINTED_ID_PREFIX_SOURCE,
  OBJECT_ID_SOURCE,
  PLAINTEXT_CREDENTIAL_SOURCE,
  SAFE_IDENTIFIER_SOURCE,
  UUID_SOURCE,
  knownProviderCredentialPattern,
  matchedOutsideSafeIdentifiers,
  plaintextCredentialOutsideGeneratedIds,
  plaintextCredentialPattern
});
