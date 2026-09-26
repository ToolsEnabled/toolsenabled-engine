// EXECUTABLE CHANGE
//
// Test-can-fail report (testcanfail-tests-tools-misc-run-vertex-report-wave-js):
// - SAME-CODE EXPECTATION: mutating freezeBoundContract() to replace every
//   returned evidence hash with "0" repeated 64 times left this file green:
//   "run-vertex-report-wave tests passed (94 checks)."  The fixture then built
//   its expected report from that corrupted return value.  The independent
//   deep equality below made the same mutation red with:
//   "AssertionError [ERR_ASSERTION]: preflight preserves the independently
//   declared evidence anchor" and an actual all-zero sha256.
// - NOT-FOUND EMPTY-ITERATION: no assertion is hidden in a loop/forEach over a
//   possibly empty collection.
// - NOT-FOUND EXIT-STATUS: this file neither spawns a process nor asserts only
//   a non-zero status/truthy process return.
// - NOT-FOUND SWALLOWED-FAILURE: its only try/finally performs cleanup; there
//   is no catch or optional chain swallowing the behavior under test.
// - NOT-FOUND SUBJECT-MOCK: injected hostile filesystem objects exercise input
//   boundaries; none mocks the function being asserted.
// - NOT-FOUND SKIP/GUARD: there is no platform skip or precondition guard.
// - RESTORE: the mutated product file was restored byte-for-byte (cmp passed),
//   then this file was green: "run-vertex-report-wave tests passed (95 checks)."
// - PRECONDITION: the installed Node 20 lacks node:sqlite. Runs used a preload
//   stub for the otherwise uninstantiated DatabaseSync import; npm access to
//   install Node 22 was forbidden with E403.

'use strict';

// Pure contract checks for the report-only Vertex wave runner.  The fixture
// contains a redaction marker, never a real prompt, provider response, or
// credential.  Nothing in this test calls Gemini or creates a worktree.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_REPORT_BYTES,
  MIN_REPORT_BYTES,
  SAFE_REPORT_NAME,
  acceptanceDecision,
  assertDestinationAbsent,
  adjudicateReportReceipt,
  laneOutcomeFields,
  resolveApprovedPrompt,
  validateWaveSpec,
  safeReportText,
  validateExistingReport,
  waveSucceeded,
  writeResponseReport
} = require('../../tools/run-vertex-report-wave.js');
const {
  DOCUMENT_PATH,
  ROLE,
  VERSION,
  loadDefinition,
  validateLaneInputs
} = require('../../src/lib/fleet-supervisor/gemini-report-contract.js');
const { providerCallEvent } = require('../../src/lib/fleet-supervisor/direct-vertex-receipt.js');

let checks = 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-report-wave-'));
const report = path.join(root, 'reports', 'gemini-fleet', 'fixture.md');
const rawContract = {
  role: ROLE,
  sources: ['config/model-floor.json', 'src/lib/model-floor.js'],
  commands: ['node tests/model-floor.js'],
  evidence: [{
    source: 'config/model-floor.json',
    line: 1,
    sha256: crypto.createHash('sha256').update('{"floor":"gemini-2.5-pro"}', 'utf8').digest('hex')
  }]
};
let contract;
let valid;

try {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'model-floor.json'), '{"floor":"gemini-2.5-pro"}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'lib', 'model-floor.js'), "'use strict';\n", 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'model-floor.js'), "'use strict';\n", 'utf8');
  contract = validateLaneInputs(root, rawContract);
  assert.equal(contract.ok, true,
    'the wave preflight confirms every allowed source and deterministic command target exists');
  assert.deepEqual(contract.evidence, rawContract.evidence,
    'preflight preserves the independently declared evidence anchor');
  const anchor = contract.evidence[0];
  valid = [
    `REPORT-CONTRACT: ${VERSION}`,
    `ROLE: ${ROLE}`,
    'SOURCES: config/model-floor.json, src/lib/model-floor.js',
    'EVIDENCE-COMMAND: node tests/model-floor.js',
    `EVIDENCE-ANCHOR: source=${anchor.source}; line=${anchor.line}; sha256=${anchor.sha256}`,
    'CLAIM: {"floor":"gemini-2.5-pro"}'
  ].join('\n');
  assert.equal(validateLaneInputs(root, { ...rawContract, sources: ['docs/imagined.md'], evidence: [{ ...rawContract.evidence[0], source: 'docs/imagined.md' }] }).code,
    'REPORT_CONTRACT_SOURCE_NOT_FOUND', 'fictional source citations refuse before a provider run');
  assert.equal(validateLaneInputs(root, { ...rawContract, commands: ['node tests/../escape.js'] }).code,
    'REPORT_CONTRACT_COMMANDS_INVALID', 'dot-segment command grammar is refused before filesystem resolution');
  assert.equal(validateLaneInputs(root, { ...rawContract, evidence: [{ ...rawContract.evidence[0], sha256: '0'.repeat(64) }] }).code,
    'REPORT_CONTRACT_EVIDENCE_HASH_MISMATCH', 'a wrong anchored source hash fails before provider work');
  assert.equal(validateLaneInputs(root, { ...rawContract, evidence: [{ ...rawContract.evidence[0], line: 3 }] }).code,
    'REPORT_CONTRACT_EVIDENCE_LINE_MISMATCH', 'a nonexistent anchored source line fails before provider work');
  fs.writeFileSync(path.join(root, 'config', 'model-floor.json'), '{"floor":"drifted"}\n', 'utf8');
  assert.equal(validateLaneInputs(root, rawContract).code, 'REPORT_CONTRACT_EVIDENCE_HASH_MISMATCH',
    'source-byte drift fails closed before a provider can be launched');
  fs.writeFileSync(path.join(root, 'config', 'model-floor.json'), '{"floor":"gemini-2.5-pro"}\n', 'utf8');
  const sourceLinkFs = Object.create(fs);
  sourceLinkFs.lstatSync = candidate => candidate.endsWith(`${path.sep}model-floor.json`)
    ? { isSymbolicLink: () => true } : fs.lstatSync(candidate);
  assert.equal(validateLaneInputs(root, rawContract, { fsImpl: sourceLinkFs }).code,
    'REPORT_CONTRACT_SOURCE_REPARSE_REFUSED', 'a symlink or junction source component is refused before reading its evidence');
  checks += 8;

  const waveDir = path.join(root, 'reports', 'gemini-fleet', 'wave');
  const promptDir = path.join(waveDir, 'prompts');
  const specFile = path.join(waveDir, 'spec.json');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, 'a.prompt.txt'), 'Bounded report-only fixture prompt.\n', 'utf8');
  const validLane = { laneId: 'lane-a', itemId: 'Q72-A', report: 'fixture.md', prompt: 'a.prompt.txt', contract: rawContract };
  fs.writeFileSync(specFile, JSON.stringify({ lanes: [validLane] }), 'utf8');
  const prepared = validateWaveSpec(JSON.parse(fs.readFileSync(specFile, 'utf8')), { root, specFile });
  assert.equal(prepared.lanes[0].promptText, 'Bounded report-only fixture prompt.\n',
    'prompt text is pre-read from the dedicated approved prompt directory');
  const directPrepared = validateWaveSpec({ lanes: [{
    ...validLane, laneId: 'lane-direct', itemId: 'Q72-DIRECT', report: 'direct.md', transport: 'direct-vertex-report'
  }] }, { root, specFile });
  assert.equal(directPrepared.lanes[0].transport, 'direct-vertex-report',
    'only an explicit transport selector enables the fixed direct-Vertex report route');
  assert.throws(() => validateWaveSpec({ lanes: [{
    ...validLane, laneId: 'lane-direct-override', itemId: 'Q72-DIRECT-OVERRIDE', report: 'direct-override.md',
    transport: 'direct-vertex-report', model: 'gemini-2.5-pro'
  }] }, { root, specFile }), /DIRECT_VERTEX_REPORT_PROFILE_OVERRIDE_REFUSED/,
  'the direct report route refuses caller model/backend/project profile overrides');
  checks += 2;
  assert.throws(() => validateWaveSpec({ lanes: [validLane, { ...validLane, report: 'other.md' }] }, { root, specFile }),
    /REPORT_WAVE_DUPLICATE_LANE_ID/, 'duplicate lane identity is refused before parallel execution');
  assert.throws(() => validateWaveSpec({ lanes: [validLane, { ...validLane, laneId: 'lane-b', report: 'other.md' }] }, { root, specFile }),
    /REPORT_WAVE_DUPLICATE_ITEM_ID/, 'duplicate item attribution is refused before parallel execution');
  assert.throws(() => validateWaveSpec({ lanes: [validLane, { ...validLane, laneId: 'lane-b', itemId: 'Q72-B' }] }, { root, specFile }),
    /REPORT_WAVE_DUPLICATE_REPORT/, 'duplicate destination report attribution is refused before parallel execution');
  assert.throws(() => validateWaveSpec({ lanes: [{ ...validLane, prompt: '../escape.prompt.txt' }] }, { root, specFile }),
    /REPORT_WAVE_PROMPT_NAME_INVALID/, 'dot-segment prompt escapes are refused lexically');
  const fakeFs = Object.create(fs);
  fakeFs.lstatSync = candidate => candidate.endsWith('a.prompt.txt')
    ? { isFile: () => true, isSymbolicLink: () => true }
    : fs.lstatSync(candidate);
  assert.throws(() => resolveApprovedPrompt(specFile, 'a.prompt.txt', { root, fsImpl: fakeFs }),
    /REPORT_WAVE_PROMPT_ESCAPE/, 'a symlink prompt is refused even when it has a safe-looking filename');
  const rootAliasFs = Object.create(fs);
  rootAliasFs.lstatSync = candidate => candidate.endsWith(`${path.sep}prompts`)
    ? { isDirectory: () => true, isSymbolicLink: () => true }
    : fs.lstatSync(candidate);
  assert.throws(() => resolveApprovedPrompt(specFile, 'a.prompt.txt', { root, fsImpl: rootAliasFs }),
    /REPORT_WAVE_PATH_REPARSE_REFUSED/, 'a prompt-directory junction/symlink alias is refused before file resolution');
  let specGetterTouched = false;
  const hostileSpec = {};
  Object.defineProperty(hostileSpec, 'lanes', {
    enumerable: true,
    get() { specGetterTouched = true; throw new Error('must not execute'); }
  });
  assert.throws(() => validateWaveSpec(hostileSpec, { root, specFile }), /wave spec must contain/,
    'getter-shaped wave specs are refused as non-data envelopes');
  assert.equal(specGetterTouched, false, 'the hostile spec getter was never executed');
  const inheritedLane = Object.create(validLane);
  assert.throws(() => validateWaveSpec({ lanes: [inheritedLane] }, { root, specFile }),
    /REPORT_WAVE_LANE_SCHEMA_INVALID/, 'inherited lane fields are refused before any prompt or provider access');
  checks += 10;

  const copiedDocument = path.join(root, 'contract-copy.md');
  fs.copyFileSync(DOCUMENT_PATH, copiedDocument);
  assert.equal(loadDefinition({ documentPath: copiedDocument }).version, VERSION,
    'the exact approved document hash is accepted');
  fs.appendFileSync(copiedDocument, '\nTampered.\n', 'utf8');
  assert.throws(() => loadDefinition({ documentPath: copiedDocument }),
    error => error && error.code === 'GEMINI_REPORT_CONTRACT_DOCUMENT_DRIFT',
    'a contract-document change fails closed instead of silently becoming the new baseline');
  checks += 2;

  assert.equal(Buffer.byteLength(valid, 'utf8') >= MIN_REPORT_BYTES, true, 'fixture is a real report-sized artifact');
  assert.equal(SAFE_REPORT_NAME.test('fixture.md'), true, 'safe Markdown report filename is admitted');
  assert.equal(SAFE_REPORT_NAME.test('../escape.md'), false, 'path traversal is refused before a lane starts');
  assert.equal(SAFE_REPORT_NAME.test('not-markdown.txt'), false, 'only the report artifact type is admitted');
  checks += 3;

  const written = writeResponseReport(report, valid, contract);
  assert.equal(written.ok, true, 'a bounded source-bound fixture is materialized from the JSON response');
  assert.equal(written.source, 'response');
  assert.equal(written.bytes, Buffer.byteLength(valid, 'utf8'));
  assert.equal(written.contract.version, VERSION, 'receipt records the contract version, never raw report prose');
  assert.equal(fs.readFileSync(report, 'utf8'), valid, 'the exact bounded response becomes the review artifact');
  assert.equal(validateExistingReport(report, contract).source, 'artifact', 'an existing report is revalidated through the same boundary');
  checks += 5;

  assert.throws(() => assertDestinationAbsent(report), /REPORT_WAVE_DESTINATION_PREEXISTING_ARTIFACT/,
    'a pre-existing shared destination refuses before any direct report can be produced');
  assert.doesNotThrow(() => assertDestinationAbsent(path.join(root, 'reports', 'gemini-fleet', 'fresh-canary.md')),
    'a fresh uniquely named destination remains eligible for a one-shot canary');
  checks += 2;

  const tiny = safeReportText('too short');
  assert.equal(tiny.ok, false, 'empty or tiny responses remain failed, never accepted as reports');
  assert.equal(tiny.code, 'REPORT_TOO_SMALL');
  checks += 2;

  const secretLike = `# Unsafe\n\nBearer ${'a'.repeat(32)}\n${'filler '.repeat(20)}`;
  const unsafePath = path.join(root, 'unsafe.md');
  const unsafe = writeResponseReport(unsafePath, secretLike);
  assert.equal(unsafe.ok, false, 'secret-like response text fails closed');
  assert.equal(unsafe.code, 'REPORT_SECRET_LIKE_TEXT');
  assert.equal(fs.existsSync(unsafePath), false, 'unsafe fixture is never materialized');
  checks += 3;

  const oversized = safeReportText('x'.repeat(MAX_REPORT_BYTES + 1));
  assert.equal(oversized.ok, false, 'oversized output is refused instead of retained');
  assert.equal(oversized.code, 'REPORT_TOO_LARGE');
  checks += 2;

  const unsupportedAnchor = valid.replace('source=config/model-floor.json', 'source=docs/imagined.md');
  assert.equal(safeReportText(unsupportedAnchor, contract).code, 'REPORT_CONTRACT_EVIDENCE_ANCHOR_UNAUTHORIZED',
    'an anchor cannot cite a source outside the preflight-bound contract');
  const mismatchedClaim = valid.replace('CLAIM: {"floor":"gemini-2.5-pro"}', 'CLAIM: The model floor passed every test.');
  assert.equal(safeReportText(mismatchedClaim, contract).code, 'REPORT_CONTRACT_CLAIM_EVIDENCE_MISMATCH',
    'a source-labelled paraphrase or false conclusion cannot become a v2 claim');
  const substitutedCommand = valid.replace('node tests/model-floor.js', 'npm test');
  assert.equal(safeReportText(substitutedCommand, contract).code, 'REPORT_CONTRACT_COMMAND_UNSUPPORTED',
    'the model cannot substitute an arbitrary command for deterministic evidence');
  const confusedRole = valid.replace(`ROLE: ${ROLE}`, 'ROLE: coordinator');
  assert.equal(safeReportText(confusedRole, contract).code, 'REPORT_CONTRACT_ROLE_CONFUSION',
    'a report-only lane cannot claim coordinator authority');
  const proseInjection = `${valid}\nThis looks persuasive but has no cited source.`;
  assert.equal(safeReportText(proseInjection, contract).code, 'REPORT_CONTRACT_LINES_EXCESS',
    'an additional nonblank narrative line cannot make an otherwise valid report count');
  const sixthClaim = `${valid}\nCLAIM: The JSON authority is read before validation. [source: config/model-floor.json]`;
  assert.equal(safeReportText(sixthClaim, contract).code, 'REPORT_CONTRACT_LINES_EXCESS',
    'a sixth nonblank claim is rejected rather than silently expanding the record');
  checks += 6;

  const legacyContract = validateLaneInputs(root, {
    version: 'GeminiReport/v1', role: ROLE, sources: rawContract.sources, commands: rawContract.commands
  });
  const legacyText = [
    'REPORT-CONTRACT: GeminiReport/v1', `ROLE: ${ROLE}`,
    'SOURCES: config/model-floor.json, src/lib/model-floor.js',
    'EVIDENCE-COMMAND: node tests/model-floor.js',
    'CLAIM: The model floor is loaded from checked-in configuration. [source: config/model-floor.json]'
  ].join('\n');
  const legacyWritten = writeResponseReport(path.join(root, 'legacy.md'), legacyText, legacyContract);
  assert.equal(legacyWritten.ok, true, 'a historic v1 transport record remains materializable');
  assert.equal(legacyWritten.contract.semanticVerified, false, 'v1 has no source-byte semantic binding');

  assert.equal(adjudicateReportReceipt({ reportedModels: ['gemini-2.5-pro'] }, {
    laneId: 'report-a', expectedModel: 'gemini-2.5-pro', changed: 1
  }).code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'aggregate CLI stats.models stays in Q57 quarantine and cannot impersonate a per-call receipt');
  const quarantined = acceptanceDecision({
    result: { ok: true, reportedModels: ['gemini-2.5-pro'] },
    laneId: 'report-a',
    report: written,
    reportBytes: written.bytes,
    changed: 1,
    expectedModel: 'gemini-2.5-pro',
    definition: loadDefinition()
  });
  assert.equal(quarantined.accepted, false, 'materialized valid prose remains quarantined without Q57 receipt evidence');
  assert.ok(quarantined.rejectionCodes.includes('AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE'));
  const forgedReceipt = acceptanceDecision({
    result: { ok: true, modelReceipt: { verdict: 'accepted', observed: true, servedModel: 'gemini-2.5-pro' } },
    laneId: 'report-a', report: written, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(forgedReceipt.accepted, false, 'a caller-supplied receipt-shaped object is ignored, not accepted');
  const rawResponse = { modelVersion: 'gemini-2.5-pro', responseId: 'report-direct-vertex-response' };
  const binding = { callId: 'lane:report-a:attempt:1', attemptNumber: 1, artifactProduced: true };
  const directVertexEvidence = {
    providerCallEvent: providerCallEvent({ binding, rawResponse }),
    rawResponse
  };
  const received = acceptanceDecision({
    result: { ok: true, code: null, directVertexEvidence, reportedModels: null, reportedTokens: null, billing: null },
    laneId: 'report-a',
    report: written,
    reportBytes: written.bytes,
    changed: 1,
    expectedModel: 'gemini-2.5-pro',
    definition: loadDefinition()
  });
  assert.equal(received.accepted, true, 'a Q57-bound direct-Vertex producing-call receipt is the only acceptance path');
  const legacyDecision = acceptanceDecision({
    result: { ok: true, code: null, directVertexEvidence, reportedModels: null, reportedTokens: null, billing: null },
    laneId: 'report-a', report: legacyWritten, reportBytes: legacyWritten.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(legacyDecision.accepted, false, 'an otherwise honest v1 record is never new semantic acceptance');
  assert.ok(legacyDecision.rejectionCodes.includes('R125_REPORT_EVIDENCE_UNVERIFIED'),
    'R125 marks the exact historical false-grounding condition without discarding its transport record');
  checks += 4;
  let getterTouched = false;
  const hostileGetter = { ok: true };
  Object.defineProperty(hostileGetter, 'directVertexEvidence', {
    enumerable: true,
    get() { getterTouched = true; throw new Error('must not execute'); }
  });
  const hostileDecision = acceptanceDecision({
    result: hostileGetter, laneId: 'report-a', report: written, reportBytes: written.bytes,
    changed: 1, expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(getterTouched, false, 'getter receipt input is rejected without execution');
  assert.equal(hostileDecision.accepted, false);
  assert.ok(hostileDecision.rejectionCodes.includes('DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID'));
  const inheritedReceipt = Object.create({ directVertexEvidence });
  inheritedReceipt.ok = true;
  const inheritedDecision = acceptanceDecision({
    result: inheritedReceipt, laneId: 'report-a', report: written, reportBytes: written.bytes,
    changed: 1, expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(inheritedDecision.accepted, false, 'inherited receipt input is rejected before Q57 evidence binding');
  let proxyTrapTouched = false;
  const transparentProxyResult = new Proxy({ ok: true, directVertexEvidence }, {
    get(target, key, receiver) { proxyTrapTouched = true; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { proxyTrapTouched = true; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { proxyTrapTouched = true; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { proxyTrapTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
  });
  const proxyDecision = acceptanceDecision({
    result: transparentProxyResult, laneId: 'report-a', report: written, reportBytes: written.bytes,
    changed: 1, expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(proxyTrapTouched, false, 'transparent proxy runner results are rejected before reflection or trap execution');
  assert.equal(proxyDecision.accepted, false, 'a transparent proxy runner result cannot produce an accepted report');
  assert.ok(proxyDecision.rejectionCodes.includes('DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID'),
    'a transparent proxy runner result produces the typed Q57 evidence refusal');
  checks += 11;

  // The receipt writer receives values from adapters.  A malformed envelope
  // must become a typed non-acceptance record without touching getters or
  // proxy traps, and JSON serialization must never re-enter that adapter
  // object through a copied nested value.
  const validResult = { ok: true, code: null, directVertexEvidence, reportedModels: null, reportedTokens: null, billing: null };
  const forgedSemanticReport = {
    ok: true,
    source: 'response',
    bytes: written.bytes,
    // This is deliberately a complete, apparently-valid copied report
    // envelope.  It has the caller-controlled semantic flag but no private
    // materialized-artifact/preflight-contract witness.
    contract: { ...written.contract, semanticVerified: true }
  };
  const forgedSemanticDecision = acceptanceDecision({
    result: validResult, laneId: 'report-a', report: forgedSemanticReport, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(forgedSemanticDecision.accepted, false,
    'a forged v2 metadata object with semanticVerified:true cannot replace an anchored artifact');
  assert.ok(forgedSemanticDecision.rejectionCodes.includes('R125_REPORT_EVIDENCE_UNBOUND'),
    'the forged metadata object is refused for lacking the private preflight artifact witness');
  const tamperedArtifactPath = path.join(root, 'tampered-after-materialization.md');
  const tamperedArtifact = writeResponseReport(tamperedArtifactPath, valid, contract);
  fs.writeFileSync(tamperedArtifactPath, valid.replace('gemini-2.5-pro', 'gemini-9.9-pro'), 'utf8');
  const tamperedArtifactDecision = acceptanceDecision({
    result: validResult, laneId: 'report-a', report: tamperedArtifact, reportBytes: tamperedArtifact.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(tamperedArtifactDecision.accepted, false,
    'final acceptance revalidates the actual artifact bytes, not its original metadata');
  assert.ok(tamperedArtifactDecision.rejectionCodes.includes('REPORT_CONTRACT_CLAIM_EVIDENCE_MISMATCH'),
    'tampering a bound v2 artifact fails its preflight-bound source-byte contract at final acceptance');
  checks += 4;
  const validDecision = acceptanceDecision({
    result: validResult, laneId: 'report-a', report: written, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(validDecision.accepted, true, 'the honest fixed direct result remains accepted after envelope hardening');
  const honestOutcome = laneOutcomeFields({
    result: validResult, report: written, decision: validDecision, changed: 1, reportBytes: written.bytes, definition: loadDefinition()
  });
  assert.equal(honestOutcome.accepted, true, 'the honest direct receipt remains serializable as accepted');
  assert.equal(honestOutcome.code, null, 'an accepted direct lane preserves its null success code');
  assert.equal(Object.hasOwn(honestOutcome.billing || {}, 'account'), false, 'receipt serialization never exposes billing account data');
  checks += 3;
  const forgedQuarantinedDecision = {
    ...validDecision,
    modelReceipt: { verdict: 'quarantined', code: 'R122_MODEL_RECEIPT_QUARANTINED', observed: false, servedModel: null }
  };
  assert.equal(laneOutcomeFields({
    result: validResult, report: written, decision: forgedQuarantinedDecision, changed: 1, reportBytes: written.bytes, definition: loadDefinition()
  }).accepted, false, 'a plain forged quarantined receipt cannot serialize as accepted');
  const forgedMismatchDecision = {
    ...validDecision,
    expectedModel: 'gemini-9.9-pro',
    modelReceipt: { ...validDecision.modelReceipt, servedModel: 'gemini-9.9-pro' }
  };
  assert.equal(laneOutcomeFields({
    result: validResult, report: written, decision: forgedMismatchDecision, changed: 1, reportBytes: written.bytes, definition: loadDefinition()
  }).accepted, false, 'a decision whose bound model differs from the producing-call receipt is refused');
  const extraResult = { ...validResult, forgedAcceptance: true };
  assert.equal(laneOutcomeFields({
    result: extraResult, report: written, decision: validDecision, changed: 1, reportBytes: written.bytes, definition: loadDefinition()
  }).accepted, false, 'extra result own-data cannot become an acceptance input');
  const extraDecision = { ...validDecision, forgedAcceptance: true };
  assert.equal(laneOutcomeFields({
    result: validResult, report: written, decision: extraDecision, changed: 1, reportBytes: written.bytes, definition: loadDefinition()
  }).accepted, false, 'extra decision own-data cannot serialize as accepted');
  checks += 4;
  const assertTypedRejection = (name, input) => {
    let outcome;
    assert.doesNotThrow(() => { outcome = laneOutcomeFields(input); }, `${name} is handled without a runner throw`);
    assert.equal(outcome.accepted, false, `${name} can never serialize as accepted`);
    assert.doesNotThrow(() => JSON.stringify(outcome), `${name} serializes without re-entering hostile values`);
    assert.equal(typeof outcome.r122.rejectionCodes[0], 'string', `${name} preserves a typed refusal code`);
    checks += 4;
  };
  assertTypedRejection('null report', {
    result: validResult, report: null, decision: validDecision, changed: 1, reportBytes: written.bytes
  });
  let reportGetterTouched = false;
  const getterReport = {};
  Object.defineProperty(getterReport, 'ok', {
    enumerable: true,
    get() { reportGetterTouched = true; throw new Error('must not execute'); }
  });
  const getterReportDecision = acceptanceDecision({
    result: validResult, laneId: 'report-a', report: getterReport, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(reportGetterTouched, false, 'a forged report getter is never executed during acceptance');
  assert.equal(getterReportDecision.accepted, false, 'a forged report getter cannot be accepted');
  assertTypedRejection('getter report', {
    result: validResult, report: getterReport, decision: getterReportDecision, changed: 1, reportBytes: written.bytes
  });
  let reportProxyTouched = false;
  const proxyReport = new Proxy(written, {
    get(target, key, receiver) { reportProxyTouched = true; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { reportProxyTouched = true; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { reportProxyTouched = true; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { reportProxyTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
  });
  const proxyReportDecision = acceptanceDecision({
    result: validResult, laneId: 'report-a', report: proxyReport, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(reportProxyTouched, false, 'a forged report proxy is rejected before trap execution');
  assert.equal(proxyReportDecision.accepted, false, 'a forged report proxy cannot be accepted');
  assertTypedRejection('proxy report', {
    result: validResult, report: proxyReport, decision: proxyReportDecision, changed: 1, reportBytes: written.bytes
  });
  let decisionGetterTouched = false;
  const getterDecision = {};
  Object.defineProperty(getterDecision, 'accepted', {
    enumerable: true,
    get() { decisionGetterTouched = true; throw new Error('must not execute'); }
  });
  assertTypedRejection('getter decision', {
    result: validResult, report: written, decision: getterDecision, changed: 1, reportBytes: written.bytes
  });
  assert.equal(decisionGetterTouched, false, 'a forged decision getter is never executed');
  let decisionProxyTouched = false;
  const proxyDecisionValue = new Proxy(validDecision, {
    get(target, key, receiver) { decisionProxyTouched = true; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { decisionProxyTouched = true; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { decisionProxyTouched = true; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { decisionProxyTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
  });
  assertTypedRejection('proxy decision', {
    result: validResult, report: written, decision: proxyDecisionValue, changed: 1, reportBytes: written.bytes
  });
  assert.equal(decisionProxyTouched, false, 'a forged decision proxy is rejected before trap execution');
  let billingProxyTouched = false;
  const hostileBilling = new Proxy({ backend: 'vertex', account: null, project: null }, {
    get(target, key, receiver) { billingProxyTouched = true; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { billingProxyTouched = true; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { billingProxyTouched = true; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { billingProxyTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
  });
  const hostileBillingResult = { ...validResult, billing: hostileBilling };
  const hostileBillingDecision = acceptanceDecision({
    result: hostileBillingResult, laneId: 'report-a', report: written, reportBytes: written.bytes, changed: 1,
    expectedModel: 'gemini-2.5-pro', definition: loadDefinition()
  });
  assert.equal(billingProxyTouched, false, 'a nested billing proxy is rejected without executing a trap');
  assert.equal(hostileBillingDecision.accepted, false, 'a nested billing proxy invalidates the result receipt');
  assertTypedRejection('nested billing proxy', {
    result: hostileBillingResult, report: written, decision: hostileBillingDecision, changed: 1, reportBytes: written.bytes
  });
  assert.equal(billingProxyTouched, false, 'the serializer never copies or probes a nested billing proxy');

  assert.equal(waveSucceeded([{ accepted: true }]), true,
    'a wave succeeds only when its requested lane has an accepted artifact');
  assert.equal(waveSucceeded([{ accepted: false }]), false,
    'a rejected lane makes the wave process refuse success');
  assert.equal(waveSucceeded([{ error: 'provider unavailable' }]), false,
    'a caught lane failure cannot collapse into a successful wave process');
  assert.equal(waveSucceeded([{ accepted: true, cleanupError: 'worktree remained' }]), false,
    'a cleanup failure keeps an otherwise accepted lane from producing process success');
  assert.equal(waveSucceeded([]), false,
    'a zero-lane result cannot vacuously satisfy the wave process gate');
  checks += 5;

  console.log(`run-vertex-report-wave tests passed (${checks} checks).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
