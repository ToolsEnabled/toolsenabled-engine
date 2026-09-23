'use strict';

// Egress preflight: the checkpoint that was missing when an internal working
// filename rode an outbound document all the way to its real recipient.
//
// The failure it exists to prevent is NOT "the model lacks common sense." It is
// structural: a value that is harmless in one context (a scratch filename used
// to diff two drafts) crosses a boundary into a context where it is harmful (a
// document going out under the owner's own name), and nothing
// re-evaluates it AT the boundary. Any agent, on any day, will regenerate that
// mistake unless something checks at the crossing. So the check lives here, in
// code, and not in a habit.
//
// Scope: this inspects OUTWARD artifacts -- anything being uploaded, emailed,
// submitted, shared, or published under the owner's identity. It deliberately
// does not touch purely local files; internal working names remain fine on disk.
// The rule is "rename before it leaves," not "never use working names."

const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');

// Tokens that disclose how an artifact was produced, or that it is unfinished.
// Ordered roughly by how damaging each is on an outward document.
const PROVENANCE_PATTERNS = Object.freeze([
  // \b does not sit between "_" and a word character, since _ is itself a word
  // character -- so "agent_written" needs the separator class to be explicit
  // rather than relying on a boundary that is not there. Getting this wrong is
  // how a checker silently passes the exact thing it was written to catch.
  { pattern: /agent[-_ ]?(reviewed|generated|edited|written|assisted|fixed)\b/i, code: 'AGENT_PROVENANCE', severity: 'block' },
  // The same `\b`-next-to-`_` trap described above applies to every pattern
  // below; the separator class was originally applied only to
  // AGENT_PROVENANCE, so `notes_from_claude_session` and `my_gpt_notes`
  // passed MODEL_NAME as CLEAN. The correct boundary is "not adjacent to an
  // alphanumeric": `_` and `(` are separators, a letter or digit is not.
  // That blocks `claude_written` and `(ai-generated)` while still letting
  // `claudette` and `autogeneration` through.
  { pattern: /(?<![a-z0-9])(ai|llm)[-_ ]?(reviewed|generated|edited|written|assisted|draft)(?![a-z0-9])/i, code: 'AI_PROVENANCE', severity: 'block' },
  { pattern: /(?<![a-z0-9])(claude|gpt|chatgpt|gemini|codex|copilot|anthropic|openai)(?![a-z0-9])/i, code: 'MODEL_NAME', severity: 'block' },
  { pattern: /(?<![a-z0-9])auto[-_ ]?(generated|gen)(?![a-z0-9])/i, code: 'AUTOGEN', severity: 'block' },
  { pattern: /(?<![a-z0-9])(scratch|tmp|temp|wip|working|internal|debug|test)(?![a-z0-9])/i, code: 'INTERNAL_STATE', severity: 'warn' },
  { pattern: /(?<![a-z0-9])(fixed|patched|corrected|cleaned|merged|reconciled)(?![a-z0-9])/i, code: 'PROCESS_STATE', severity: 'warn' },
  { pattern: /\bcopy(\s*\(\d+\))?\b|\bfinal[-_ ]?final\b/i, code: 'SLOPPY_NAME', severity: 'warn' }
]);

// Document metadata fields that commonly carry tool provenance. A clean
// filename over a docx whose Author is a tool name is still a leak.
const METADATA_FIELDS = Object.freeze(['title', 'author', 'creator', 'producer', 'lastModifiedBy', 'company', 'comments', 'subject']);

// A SEPARATE class from provenance, on purpose, and never merged into
// PROVENANCE_PATTERNS. A provenance finding is a claim about the NAME; renaming
// the file is a real fix. A credential-shaped name is a claim about what the
// BYTES ARE -- a bounded credential, session, or environment-secret store --
// and renaming it changes nothing about what would leave the machine. Keeping
// the two lists (and the two refusal sentences) apart is what lets a caller
// tell "rename this" from "do not send this file at all" apart, and it is why
// suggestName() below is never offered for this class: there is no name that
// makes sending the same bytes correct.
//
// Mirrors src/lib/providers/host-control.js's COMMON_CREDENTIAL_STORE_PATTERN /
// isProtectedEnvironmentPath, the same idiom already used to keep this class of
// file out of the broad host-control surface -- applied here to the FILENAME
// ALONE, since this module never resolves or reads the path itself, so the
// same class of file is refused at the egress boundary regardless of which
// provider is sending it, not merely when it happens to sit inside a
// containment-checked root.
// The last four stem groups were ported on 2026-09-07 from the sibling,
// unmerged commit a099930, which fixed this same class independently with a
// non-overlapping rule set. Each closes a name that BOTH lineages' patterns
// let through -- password.json, access_key.json, service_account.json and
// wallet.json all read "Clean: no provenance or internal-state markers
// detected" before this. They are stem additions ONLY: the mandatory
// `\.(extension)$` tail is unchanged, so this stays a targeted refusal and
// not a blanket one. The three "collide" rows from the same delta report
// (extensionless credentials/secrets, the id_rsa family, and stem-agnostic
// .pem/.jks/.kdbx/.ppk) need that tail to change, which widens refusals for
// every caller of preflight(), and are deliberately NOT here.
const CREDENTIAL_NAME_PATTERN = /(?:^|[._-])(?:credentials?|tokens?|secrets?|api[._-]?keys?|auth|cookies?|sessions?|passwords?|passwd|passphrases?|(?:access|refresh|bearer)[._-]?(?:keys?|tokens?)|private[._-]?keys?|service[._-]?accounts?|keystores?|kdbx|wallets?)(?:[._-][^./\\]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|env|pem|key|p12|pfx|db|sqlite3?)$/i;

function isProtectedEnvironmentName(base) {
  const lower = base.toLowerCase();
  if (lower === '.env') return true;
  if (!lower.startsWith('.env.')) return false;
  return !['.env.example', '.env.template', '.env.sample'].includes(lower);
}

/**
 * Inspect the artifact's own name for a CREDENTIAL SHAPE, not a provenance
 * marker. Unlike inspectFilename(), the extension is part of what is matched
 * -- ".json"/".env"/".pem" and similar are exactly the signal, not noise to
 * strip -- so this stays a separate function rather than a shared helper.
 */
function inspectCredentialShape(filePath) {
  const base = path.basename(String(filePath || ''));
  if (!base) return [];
  if (CREDENTIAL_NAME_PATTERN.test(base) || isProtectedEnvironmentName(base)) {
    return [{ code: 'CREDENTIAL_SHAPED_NAME', severity: 'block', where: 'filename', matched: base }];
  }
  return [];
}

function findings(text, where) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const rule of PROVENANCE_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match) out.push({ code: rule.code, severity: rule.severity, where, matched: match[0] });
  }
  return out;
}

/**
 * Inspect the artifact's own name. Extension is excluded from the scan so a
 * legitimate ".ai" file does not trip MODEL_NAME.
 */
function inspectFilename(filePath) {
  const base = path.basename(String(filePath || ''));
  const stem = base.replace(/\.[^.]+$/, '');
  return findings(stem, 'filename');
}

/**
 * Inspect supplied document metadata. Callers pass whatever they can extract;
 * this does not itself parse binary formats, so it stays dependency-free and
 * cannot be blamed for a parser's failure mode.
 */
function inspectMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  const out = [];
  for (const field of METADATA_FIELDS) {
    out.push(...findings(metadata[field], `metadata.${field}`));
  }
  return out;
}

/**
 * Compare against how existing artifacts at the destination are named. A
 * submission that looks nothing like its siblings is suspicious even when it
 * trips no keyword -- this is the check that would have caught the real
 * incident on style alone, since every prior artifact at that destination
 * followed one fixed naming pattern and the leaked name did not.
 */
function inspectConvention(filePath, siblingNames) {
  if (!Array.isArray(siblingNames) || siblingNames.length === 0) return [];
  const stem = path.basename(String(filePath || '')).replace(/\.[^.]+$/, '');
  const hasParenthetical = /\([^)]*\)/.test(stem);
  const siblingsWithParens = siblingNames.filter(n => /\([^)]*\)/.test(String(n))).length;
  if (hasParenthetical && siblingsWithParens === 0) {
    return [{
      code: 'CONVENTION_MISMATCH',
      severity: 'warn',
      where: 'filename',
      matched: stem,
      detail: 'Name carries a parenthetical qualifier that no existing artifact at this destination uses.'
    }];
  }
  return [];
}

/**
 * The boundary check itself.
 *
 * @param {object} input
 * @param {string} input.filePath        artifact about to leave the machine
 * @param {object} [input.metadata]      extracted document metadata, if available
 * @param {string[]} [input.siblingNames] names of artifacts already at the destination
 * @param {string} [input.destination]   human label for where this is going
 * @returns {{allowed: boolean, severity: string, findings: object[], summary: string, suggestedName: string|null}}
 */
function preflight({ filePath, metadata, siblingNames, destination } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('EGRESS_PREFLIGHT_FILE_REQUIRED');
  }
  // Credential shape is checked and reported SEPARATELY from provenance, in
  // its own array, so its refusal sentence never gets folded into the
  // provenance one -- see the comment on CREDENTIAL_NAME_PATTERN for why a
  // shared sentence would be actively wrong here (renaming does not fix it).
  const credentialFindings = inspectCredentialShape(filePath);
  const provenanceFindings = [
    ...inspectFilename(filePath),
    ...inspectMetadata(metadata),
    ...inspectConvention(filePath, siblingNames)
  ];
  const all = [...credentialFindings, ...provenanceFindings];
  const blockingProvenance = provenanceFindings.filter(f => f.severity === 'block');
  const warnings = all.filter(f => f.severity === 'warn');
  const severity = (credentialFindings.length || blockingProvenance.length) ? 'block' : warnings.length ? 'warn' : 'clean';

  const summaryParts = [];
  if (credentialFindings.length) {
    summaryParts.push(`Blocked: the artifact name is shaped like a credential, token, or secret store (${credentialFindings.map(f => f.matched).join(', ')}). Sending it under any name still sends the same bytes; do not attach or upload this file.`);
  }
  if (blockingProvenance.length) {
    summaryParts.push(`Blocked: the artifact name or metadata discloses how it was produced (${blockingProvenance.map(f => f.code).join(', ')}). Rename before sending — this goes out under the owner's name.`);
  }
  const summary = summaryParts.length
    ? summaryParts.join(' ')
    : warnings.length
      ? `Allowed with warnings (${warnings.map(f => f.code).join(', ')}). Confirm the name reads naturally to whoever receives it.`
      : 'Clean: no provenance or internal-state markers detected.';

  return {
    allowed: credentialFindings.length === 0 && blockingProvenance.length === 0,
    severity,
    findings: all,
    destination: destination || null,
    // Deliberately NOT offered for a credential-shaped finding, even when a
    // provenance finding also fired on the same name (see the check above
    // that pins this for a file matching both classes): a caller reading
    // suggestedName as "the fix" must never be handed a new name for a file
    // whose actual bytes are a secret store.
    suggestedName: credentialFindings.length === 0 && (blockingProvenance.length || warnings.length) ? suggestName(filePath) : null,
    summary
  };
}

/**
 * Strip offending tokens and leftover punctuation to propose a natural name.
 * Advisory only -- the caller decides, because a good name is a judgement about
 * the destination, not a regex result.
 */
function suggestName(filePath) {
  const ext = path.extname(filePath);
  let stem = path.basename(filePath, ext);
  stem = stem.replace(/\([^)]*\)/g, ' ');
  for (const rule of PROVENANCE_PATTERNS) stem = stem.replace(new RegExp(rule.pattern.source, 'gi'), ' ');
  stem = stem.replace(/[-_]{2,}/g, ' ').replace(/\s{2,}/g, ' ').replace(/[\s\-_]+$/g, '').trim();
  return stem ? `${stem}${ext}` : null;
}

/**
 * Convenience wrapper that also confirms the file exists, so a caller cannot
 * "pass" preflight on a path that is not there.
 */
function preflightExisting(input) {
  const result = preflight(input);
  try {
    fs.statSync(input.filePath);
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return {
      ...result,
      allowed: false,
      severity: 'block',
      summary: missing
        ? `Blocked: ${input.filePath} does not exist.`
        : `Blocked: could not verify that ${input.filePath} exists${error && error.code ? ` (${error.code})` : ''}.`
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Owner-instruction gates.
//
// Root cause of the second real failure of this kind, in one sentence: the
// owner asked for a prior artifact to be pulled and checked before the next
// one went out, but the tool needed for the check was down at that moment, so
// the instruction was filed as *blocked context* instead of as a *precondition*
// -- and when the blocker later cleared, the goal (upload) executed while the
// deferred verification step never resurfaced. Deadline pressure finished the
// job. The ledger recorded outcomes; it never held the owner's literal words as
// gates that must be satisfied before the outward action.
//
// This section makes that structural. A ledger request may carry a `gates`
// array; each gate is the owner's instruction verbatim plus met/evidence. Any
// outward action tied to a request MUST call assertGatesMet() first and
// refuse while an unmet gate exists. An instruction that is blocked today is
// still a gate tomorrow -- blockers clear, gates do not, until they are met
// with evidence.

// TOOLSENABLED_OWNER_LEDGER_FILE lets an isolated test run point every
// default-parameter caller (readGates/assertGatesMet below, and now
// tool-registry.js's dispatch-time gate check) at a scratch ledger instead of
// the real production ledger, the same isolation shape tests/lib/
// isolated-environment.js already uses for the audit DB and state path. A
// caller that passes an explicit ledgerFile argument is unaffected either way.
// reports/ is written at runtime, so installed it resolves under the user's
// state root rather than into the program directory. See
// src/lib/runtime-state-root.js.
const DEFAULT_LEDGER_FILE = statePath('reports', 'OWNER-REQUEST-LEDGER.json');
const LEDGER_FILE = process.env.TOOLSENABLED_OWNER_LEDGER_FILE
  ? path.resolve(process.env.TOOLSENABLED_OWNER_LEDGER_FILE)
  : DEFAULT_LEDGER_FILE;

function readGates(requestId, ledgerFile = LEDGER_FILE) {
  const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const entry = (parsed.requests || []).find(r => r && r.id === requestId);
  if (!entry) throw new Error(`EGRESS_GATES_UNKNOWN_REQUEST:${requestId}`);
  return Array.isArray(entry.gates) ? entry.gates : [];
}

/**
 * Throws unless every gate on the request is met with non-empty evidence.
 * Returns the gates for logging. No gates at all is allowed -- gates are
 * added when the owner issues instructions, not invented after the fact.
 */
function assertGatesMet(requestId, ledgerFile = LEDGER_FILE) {
  const gates = readGates(requestId, ledgerFile);
  const unmet = gates.filter(g => !(g && g.met === true && typeof g.evidence === 'string' && g.evidence.trim().length > 0));
  if (unmet.length > 0) {
    const listing = unmet.map(g => `- ${g && g.instruction ? g.instruction : '(malformed gate)'}`).join('\n');
    const error = new Error(`EGRESS_GATES_UNMET:${requestId}\nThe owner's instructions below are preconditions of this outward action and are not yet satisfied with evidence:\n${listing}`);
    error.code = 'EGRESS_GATES_UNMET';
    error.unmet = unmet;
    throw error;
  }
  return gates;
}

module.exports = Object.freeze({
  preflight,
  preflightExisting,
  inspectFilename,
  inspectCredentialShape,
  inspectMetadata,
  inspectConvention,
  suggestName,
  readGates,
  assertGatesMet,
  PROVENANCE_PATTERNS,
  CREDENTIAL_NAME_PATTERN,
  METADATA_FIELDS,
  LEDGER_FILE,
  DEFAULT_LEDGER_FILE
});
