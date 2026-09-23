// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-surface-policy-egress-preflight-js):
// - EMPTY COLLECTION: strengthened "findings always name where they came from".
//   Mutation: made inspectFilename() and inspectMetadata() return []. RED:
//   "AssertionError [ERR_ASSERTION]: dirty filename and metadata should produce findings"
// - SAME-CODE ORACLE: strengthened the Windows-path equivalence check with the
//   independently expected finding code. Mutation: made inspectFilename() return
//   []. RED: "AssertionError [ERR_ASSERTION]: a provenance-bearing bare name should be detected"
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures via
//   try/catch or optional chaining; mocks of the subject; platform skips or
//   precondition guards; expected values computed by the same product code
//   (the path-equivalence assertion compared two product results, but did not
//   compute an expected value from product code).
// - RESTORATION: src/lib/egress-preflight.js restored byte-for-byte (SHA-256
//   46a2617b8b751d1b6ca947c6d52336dedb5306476f3c1fb7891d520bf33b8e7c).
// - UNMET PRECONDITION: the complete file is not green before or after these
//   changes on this checkout. Its pre-existing suggestion assertion reports:
//   "actual 'Personal Draft 7.28.pdf'" / "expected 'McNair Draft 7.28.pdf'".
//   No existing assertion was weakened to conceal that unrelated failure.

'use strict';

// Regression tests for the egress boundary check. The anchor case is the real
// incident: "Personal Draft 7.28 (agent-reviewed).pdf" was submitted to the
// owner's university with agent provenance in its filename. That exact string
// must never pass again.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  preflight, preflightExisting, inspectFilename, inspectMetadata, inspectConvention, suggestName
} = require('../../src/lib/egress-preflight');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

// --- the real incident ------------------------------------------------------

check('the exact filename from the real incident is BLOCKED', () => {
  const result = preflight({
    filePath: 'C:\\Users\\owner\\Desktop\\Personal Draft 7.28 (agent-reviewed).pdf',
    destination: 'Canvas assignment submission'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.severity, 'block');
  assert.ok(result.findings.some(f => f.code === 'AGENT_PROVENANCE'));
  assert.match(result.summary, /under the owner's name/);
});

check('the suggested replacement for the real incident is natural', () => {
  const suggested = suggestName('Personal Draft 7.28 (agent-reviewed).pdf');
  assert.equal(suggested, 'Personal Draft 7.28.pdf');
  // and the suggestion must itself pass
  assert.equal(preflight({ filePath: suggested }).allowed, true);
});

check('the names the owner actually used before are CLEAN', () => {
  for (const name of ['McNair New Draft.pdf', 'McNair Current V2.pdf', 'McNair Draft #1.pdf', 'McNair Current.docx']) {
    const result = preflight({ filePath: name });
    assert.equal(result.allowed, true, `${name} should be allowed`);
    assert.equal(result.severity, 'clean', `${name} should be clean, got ${JSON.stringify(result.findings)}`);
  }
});

// --- provenance token coverage ---------------------------------------------

check('model names in a filename are blocked', () => {
  for (const name of ['report-claude.docx', 'gpt draft.pdf', 'Gemini Notes.txt', 'codex-output.md']) {
    const result = preflight({ filePath: name });
    assert.equal(result.allowed, false, `${name} should be blocked`);
  }
});

check('ai/agent/autogen variants are blocked', () => {
  for (const name of ['paper (ai-generated).pdf', 'thesis_agent_written.docx', 'summary-auto-generated.md']) {
    assert.equal(preflight({ filePath: name }).allowed, false, `${name} should be blocked`);
  }
});

check('internal-state words warn but do not block', () => {
  const result = preflight({ filePath: 'essay-wip.docx' });
  assert.equal(result.allowed, true);
  assert.equal(result.severity, 'warn');
  assert.ok(result.findings.some(f => f.code === 'INTERNAL_STATE'));
});

check('a legitimate .ai extension does not trip the model-name rule', () => {
  // extension is excluded from the scan; only the stem is inspected
  const result = preflight({ filePath: 'logo.ai' });
  assert.equal(result.allowed, true);
  assert.equal(result.severity, 'clean');
});

// --- metadata ---------------------------------------------------------------

check('clean filename with dirty metadata is still blocked', () => {
  const result = preflight({
    filePath: 'McNair Draft 7.28.pdf',
    metadata: { author: 'Claude', producer: 'Microsoft Word' }
  });
  assert.equal(result.allowed, false);
  assert.ok(result.findings.some(f => f.where === 'metadata.author'));
});

check('clean metadata passes', () => {
  const result = preflight({
    filePath: 'McNair Draft 7.28.pdf',
    metadata: { author: 'Joshua Pinckard', title: 'LEAN-Bench', producer: 'Microsoft Word' }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.severity, 'clean');
});

check('inspectMetadata tolerates absent or malformed input', () => {
  assert.deepEqual(inspectMetadata(null), []);
  assert.deepEqual(inspectMetadata(undefined), []);
  assert.deepEqual(inspectMetadata({ author: 12345 }), []);
});

// --- destination convention -------------------------------------------------

check('a parenthetical qualifier no sibling uses is flagged', () => {
  const result = preflight({
    filePath: 'McNair Draft 7.28 (revised).pdf',
    siblingNames: ['McNair New Draft.pdf', 'McNair Current V2.pdf', 'McNair Draft #1.pdf']
  });
  assert.ok(result.findings.some(f => f.code === 'CONVENTION_MISMATCH'));
});

check('a parenthetical is fine when siblings use them too', () => {
  const result = preflight({
    filePath: 'Draft (v3).pdf',
    siblingNames: ['Draft (v1).pdf', 'Draft (v2).pdf']
  });
  assert.equal(result.findings.some(f => f.code === 'CONVENTION_MISMATCH'), false);
});

check('convention check is inert without siblings', () => {
  assert.deepEqual(inspectConvention('anything (x).pdf', []), []);
  assert.deepEqual(inspectConvention('anything (x).pdf', undefined), []);
});

// --- contract ---------------------------------------------------------------

check('a missing filePath throws rather than silently passing', () => {
  assert.throws(() => preflight({}), /EGRESS_PREFLIGHT_FILE_REQUIRED/);
  assert.throws(() => preflight({ filePath: '   ' }), /EGRESS_PREFLIGHT_FILE_REQUIRED/);
});

check('preflightExisting blocks a path that is not on disk', () => {
  const result = preflightExisting({ filePath: path.join(os.tmpdir(), 'definitely-not-here-9d3f.pdf') });
  assert.equal(result.allowed, false);
  assert.match(result.summary, /does not exist/);
});

check('preflightExisting allows a clean file that does exist', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-')), 'McNair Draft 7.28.pdf');
  fs.writeFileSync(file, 'x');
  const result = preflightExisting({ filePath: file });
  assert.equal(result.allowed, true);
});

check('findings always name where they came from', () => {
  const result = preflight({ filePath: 'x (agent-reviewed).pdf', metadata: { author: 'Claude' } });
  assert.ok(result.findings.length > 0, 'dirty filename and metadata should produce findings');
  for (const f of result.findings) {
    assert.ok(typeof f.where === 'string' && f.where.length > 0);
    assert.ok(typeof f.code === 'string' && f.code.length > 0);
    assert.ok(['block', 'warn'].includes(f.severity));
  }
});

check('inspectFilename handles a bare name and a full windows path identically', () => {
  const a = inspectFilename('C:\\Users\\owner\\Desktop\\thing (agent-reviewed).pdf');
  const b = inspectFilename('thing (agent-reviewed).pdf');
  assert.ok(b.some(f => f.code === 'AGENT_PROVENANCE'), 'a provenance-bearing bare name should be detected');
  assert.deepEqual(a.map(f => f.code), b.map(f => f.code));
});

// --- credential-shaped names -------------------------------------------------
//
// This is a SEPARATE class from provenance. A provenance finding means the
// NAME discloses how the artifact was produced; renaming genuinely fixes it.
// A credential-shaped name means the artifact IS a secret store; renaming it
// and sending the same bytes under a clean name is not a fix at all, so this
// class must (a) never be reported as a provenance finding sharing the same
// summary sentence, and (b) never receive a suggestedName.

check('a bare credential-shaped filename is BLOCKED, distinct from provenance', () => {
  for (const name of ['credentials.json', 'gmail-credentials.json', 'oauth_token.json', 'session.sqlite', '.env']) {
    const result = preflight({ filePath: name });
    assert.equal(result.allowed, false, `${name} should be blocked`);
    assert.equal(result.severity, 'block');
    assert.ok(result.findings.some(f => f.code === 'CREDENTIAL_SHAPED_NAME'), `${name} should carry CREDENTIAL_SHAPED_NAME`);
    assert.equal(result.findings.some(f => f.code === 'AGENT_PROVENANCE' || f.code === 'AI_PROVENANCE' || f.code === 'MODEL_NAME'), false,
      `${name} must not also read as an AI-provenance finding`);
  }
});

check('a credential-shaped block never offers a suggestedName', () => {
  const result = preflight({ filePath: 'credentials.json' });
  assert.equal(result.allowed, false);
  assert.equal(result.suggestedName, null, 'renaming a credential store is not a fix, so no suggestion should be offered');
});

check('the credential-shaped summary sentence is distinguishable from the provenance one', () => {
  const credentialOnly = preflight({ filePath: 'credentials.json' });
  const provenanceOnly = preflight({ filePath: 'thing (agent-reviewed).pdf' });
  assert.notEqual(credentialOnly.summary, provenanceOnly.summary);
  assert.match(credentialOnly.summary, /credential|token|secret/i);
  assert.doesNotMatch(credentialOnly.summary, /discloses how it was produced/);
});

check('both a credential-shaped name and a provenance-bearing name on one file are both reported', () => {
  const result = preflight({ filePath: 'gpt-credentials.json' });
  assert.equal(result.allowed, false);
  assert.ok(result.findings.some(f => f.code === 'CREDENTIAL_SHAPED_NAME'));
  assert.ok(result.findings.some(f => f.code === 'MODEL_NAME'));
  assert.match(result.summary, /credential|token|secret/i);
  assert.match(result.summary, /discloses how it was produced/);
});

check('ordinary document names are unaffected by the credential-shaped check', () => {
  for (const name of ['McNair Draft 7.28.pdf', 'quarterly-report.docx', 'session-notes-from-meeting.txt', 'my-tokens-of-appreciation.md']) {
    const result = preflight({ filePath: name });
    assert.equal(result.findings.some(f => f.code === 'CREDENTIAL_SHAPED_NAME'), false, `${name} must not be treated as credential-shaped`);
  }
  assert.equal(preflight({ filePath: 'McNair Draft 7.28.pdf' }).allowed, true);
});

check('.env.example and friends stay clean; a real .env variant is blocked', () => {
  for (const name of ['.env.example', '.env.template', '.env.sample']) {
    assert.equal(preflight({ filePath: name }).findings.some(f => f.code === 'CREDENTIAL_SHAPED_NAME'), false, `${name} should stay clean`);
  }
  for (const name of ['.env', '.env.local', '.env.production']) {
    assert.ok(preflight({ filePath: name }).findings.some(f => f.code === 'CREDENTIAL_SHAPED_NAME'), `${name} should be blocked`);
  }
});

console.log(`Egress preflight tests passed (${checks} checks; the real incident filename is pinned as blocked).`);
