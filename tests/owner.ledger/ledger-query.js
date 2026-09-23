// REFUSED-CONTROL
/* testcanfail-tests-owner-ledger-ledger-query-js
 *
 * PRECONDITION-NOT-MET: tests/run-isolated.js declares this file dependent on
 * reports/OWNER-REQUEST-LEDGER.json. That file is absent in this checkout, so
 * the repository's test command skips this entire file before Node loads it:
 *
 *   SKIP (missing required file, NOT counted as a pass):
 *   tests/owner.ledger/ledger-query.js -- needs
 *   reports/OWNER-REQUEST-LEDGER.json, which is not in this checkout
 *
 * Fixing that skip requires changing tests/run-isolated.js, while this
 * contract's fence permits a diff only in this file. Creating or changing the
 * missing production ledger from a test would violate the stronger prohibition
 * against changing what a product check allows, and would risk owner data.
 * Consequently no honest mutation/RED/restoration cycle is possible through
 * the repository test entry point on this platform.
 *
 * Shape census:
 *   (1) NOT-FOUND -- no assertion is inside a possibly-empty loop/forEach.
 *   (2) NOT-FOUND -- rejection checks pin diagnostic text/type and exit code;
 *       no assertion accepts an arbitrary non-zero status.
 *   (3) NOT-FOUND -- ENOENT handlers only classify optional production state;
 *       assertion failures are not swallowed.
 *   (4) NOT-FOUND -- injected presence APIs are inputs to ownership projection,
 *       not mocks of the projection functions under test.
 *   (5) FOUND-BUT-OUTSIDE-FENCE -- the runner-level required-file guard quoted
 *       above turns this whole file into a no-op in this checkout.
 *   (6) NOT-FOUND -- output-to-output conservation relations are accompanied by
 *       independently pinned fixture projections; preview loading is compared
 *       with direct materialization, a separate path.
 */
require('../helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const agentPresence = require('../../src/lib/agent-presence');
const scopeStore = require('../../src/lib/owner-request-scope-store');
const {
  buildScopeProposal,
  materializeProposalRules,
  proposalHash,
  sha256,
  validateScopeProposal
} = require('../../src/lib/owner-request-scope-proposal');

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'tools', 'ledger-query.js');
const {
  readLedger, readLedgerMeta, readArchiveState, processGet, processGates, processOpen, processOpenGates, processReconciliation,
  productionOwnershipObservation, renderOpenGatesDigest, writeOpenGatesDigest, stampLedgerRevision, renderOwnerRequestText, loadScopeProposalPreviewRules,
  clauseKindOf, projectAuthorizations, renderAuthorizationLine,
  NO_VERBATIM_RECORDED, LedgerQueryError
} = require(SCRIPT_PATH);

function scopeRule(ruleId, ruleKey, sourceRequestId, issuedAt, extra = {}) {
  return {
    schemaVersion: 1,
    ruleId,
    ruleKey,
    scopeKind: extra.scopeKind || 'global',
    threadId: extra.threadId || null,
    sourceRequestId,
    issuedAt,
    expiresAt: null,
    decisionSummary: `${sourceRequestId} ${ruleKey}`,
    evidenceRefs: extra.evidenceRefs || [`fixture/scope/${ruleId}`],
    ownerVerbatim: extra.ownerVerbatim || `${sourceRequestId} verbatim`
  };
}

/* A SECTION THAT IS ABSENT SORTS BEFORE EVERYTHING.
 *
 * These ordering claims were written as
 * `assert.ok(text.indexOf(A) < text.indexOf(B), 'A must render first')`. On a miss
 * indexOf returns -1, and -1 is less than every real offset, so DELETING or
 * RENAMING section A satisfies the assertion that A comes first. Measured:
 * renaming the digest's '## Active gates' heading left three of these green and
 * the whole suite at 105 checks, with the digest's primary section gone.
 *
 * Both offsets are established as found BEFORE they are compared -- the positive
 * assertion on the same subject that makes the ordering claim mean anything.
 * Returns its check count so the caller's tally stays honest. */
function assertSectionOrder(text, first, second, label) {
  const firstAt = text.indexOf(first);
  const secondAt = text.indexOf(second);
  assert.notEqual(firstAt, -1, `the digest must render a "${first}" section at all (${label})`);
  assert.notEqual(secondAt, -1, `the digest must render a "${second}" section at all (${label})`);
  assert.ok(firstAt < secondAt, label);
  return 3;
}

async function runTests() {
  let checkCount = 0;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-query-test-'));
  const fixturePath = path.join(tempDir, 'test-ledger.json');
  const fixtureData = { revision: 42, updatedAt: '2026-08-07', requests: [
    { id: 'R1', status: 'open', request: 'sensitive details 1', verbatim: 'user prompt 1', instruction: 'internal instruction 1', gates: [{ instruction: 'gate one', met: true, evidence: 'some data' }, { instruction: 'Keep **exactly** \"these\" words.', met: false, evidence: '' }], credentials: 'hidden' },
    { id: 'R2', status: 'approved', request: 'sensitive details 2', gates: [{ instruction: 'gate two', met: true, evidence: 'more data' }] },
    { id: 'R3', status: 'partial', request: 'sensitive details 3', instruction: 'instruction 3', gates: [] }
  ] };
  const originalContent = JSON.stringify(fixtureData, null, 2);
  await fs.writeFile(fixturePath, originalContent, 'utf8');

  try {
    const ledger = await readLedger(fixturePath);
    const archiveStatePath = path.join(tempDir, 'archive-state.json');
    await fs.writeFile(archiveStatePath, JSON.stringify({ requests: [{ id: 'R30', status: 'done' }], retirements: [{
      targetKind: 'request', requestId: 'R30', retiredAt: '2026-08-07T00:00:00.000Z', retiredBy: 'owner',
      reason: { code: 'completed', detail: 'Verified.', supersedingRequestIds: [] }
    }] }), 'utf8');
    const archiveState = await readArchiveState(archiveStatePath);
    assert.equal(archiveState.requests.length, 1); checkCount++;
    assert.equal(archiveState.retirements[0].reason.code, 'completed'); checkCount++;
    assert.deepStrictEqual(
      await readArchiveState(path.join(tempDir, 'missing-archive-state.json')),
      { requests: [], retirements: [] },
      'the optional legacy archive is empty on a new install rather than a required owner fixture'
    ); checkCount++;
    // R family only: owner-request-store.js now writes T/A/P rows into the
    // same ledger file. Every reader below this line was built for R rows
    // alone, so readRequestFile (reached through readLedger) must withhold
    // T/A/P before anything else here ever sees them.
    const mixedKindsPath = path.join(tempDir, 'mixed-kinds-ledger.json');
    await fs.writeFile(mixedKindsPath, JSON.stringify({ revision: 1, updatedAt: '2026-09-06', requests: [
      { id: 'R1', kind: 'R', status: 'open', gates: [] },
      { id: 'T1', kind: 'T', status: 'open', recurrence: null },
      { id: 'A1', kind: 'A', status: 'open', answer: null },
      { id: 'P1', kind: 'P', status: 'proposed', purchase: {} },
      { id: 'R2', kind: 'R', status: 'open', gates: [] }
    ] }), 'utf8');
    const mixedKindsLedger = await readLedger(mixedKindsPath);
    assert.deepStrictEqual(mixedKindsLedger.map(request => request.id), ['R1', 'R2'],
      'a T, A and P row in the same ledger file must never reach a caller of readLedger'); checkCount++;

    const getResult = processGet('R1', ledger);
    // `ownerAuthority` joined this projection deliberately: ownerText alone
    // cannot say whether the words in it are the OWNER'S, and any writer can put
    // a string in `verbatim`. This fixture records no provenance, so the honest
    // answer is UNSOURCED and not citable -- pinned here in full rather than
    // waved through by key, because the whole value of the field is its content.
    const UNSOURCED_AUTHORITY = {
      class: 'unclassified',
      label: "UNSOURCED — provenance not recorded; not the owner's requirement",
      citableAsOwnerRequirement: false
    };
    assert.deepStrictEqual(Object.keys(getResult), ['id', 'status', 'derivedLabel', 'ownerText', 'ownerAuthority', 'gateCount', 'unmetGateCount', 'authorizations']); checkCount++;
    assert.deepStrictEqual(getResult, {
      id: 'R1', status: 'open', derivedLabel: null, ownerText: 'user prompt 1',
      ownerAuthority: UNSOURCED_AUTHORITY, gateCount: 2, unmetGateCount: 1,
      authorizations: { declaredHere: [], revokedByThis: [] }
    }); checkCount++;
    assert.equal(renderOwnerRequestText(fixtureData.requests[1]), NO_VERBATIM_RECORDED); checkCount++;
    assert.equal(processGet('R2', ledger).ownerText, 'controller interpretation — no verbatim recorded'); checkCount++;
    assert.notEqual(processGet('R2', ledger).ownerText, fixtureData.requests[1].request, 'request text must never be rendered as owner speech'); checkCount++;

    const gatesResult = processGates('R1', ledger);
    assert.deepStrictEqual(Object.keys(gatesResult), ['id', 'gates']); checkCount++;
    assert.deepStrictEqual(gatesResult.gates[0], { index: 0, met: true, hasEvidence: true }); checkCount++;
    /* This pinned `hasEvidence: true` for a gate whose evidence is the empty string,
     * so correcting the tool turned this suite red -- a test that punishes its own
     * fix. The fixture gate really does carry `evidence: ''` (see R1 above); the
     * honest expectation is false. */
    assert.deepStrictEqual(gatesResult.gates[1], { index: 1, met: false, hasEvidence: false }); checkCount++;

    /* EVIDENCE IS CONTENT, NOT A KEY THAT EXISTS.
     *
     * The two pins above are both `met`-distinct, so between them they never showed
     * whether hasEvidence tracks the evidence TEXT or merely the presence of the
     * field. It tracked presence: measured against the live ledger, hasEvidence was
     * true for 1099 of 1099 gates, a field that could not report false and therefore
     * carried no information. Every shape is asserted here in one deepStrictEqual so
     * that a regression in any single shape is named rather than averaged away, and
     * so the true and false cases sit side by side -- a false-only expectation is
     * indistinguishable from a field that is always false. */
    const evidenceShapes = [{
      id: 'RE', gates: [
        { instruction: 'real evidence', met: true, evidence: 'a link and a hash' },
        { instruction: 'empty string', met: false, evidence: '' },
        { instruction: 'whitespace only', met: false, evidence: '   \t\n ' },
        { instruction: 'field absent', met: false },
        { instruction: 'explicit null', met: false, evidence: null }
      ]
    }];
    assert.deepStrictEqual(processGates('RE', evidenceShapes).gates, [
      { index: 0, met: true, hasEvidence: true },
      { index: 1, met: false, hasEvidence: false },
      { index: 2, met: false, hasEvidence: false },
      { index: 3, met: false, hasEvidence: false },
      { index: 4, met: false, hasEvidence: false }
    ], 'hasEvidence must report evidence CONTENT, not whether the field is present'); checkCount++;

    const openResult = processOpen(ledger);
    assert.strictEqual(openResult.length, 2); checkCount++;
    assert.ok(openResult.some(item => item.id === 'R1')); checkCount++;
    assert.ok(openResult.some(item => item.id === 'R3')); checkCount++;
    assert.strictEqual(openResult.find(item => item.id === 'R1').derivedLabel, null); checkCount++;
    assert.strictEqual(openResult.find(item => item.id === 'R1').unmetGateCount, 1); checkCount++;
    assert.strictEqual(openResult.find(item => item.id === 'R3').unmetGateCount, 0); checkCount++;
    assert.deepStrictEqual(processReconciliation([{ id: 'R4', status: 'open', gates: [{ met: true }] }]), [{ id: 'R4', status: 'open', gateCount: 1 }]); checkCount++;

    const observedAt = Date.parse('2026-08-20T00:00:00.000Z');
    const completeOwnership = productionOwnershipObservation({
      nowMs: observedAt,
      presenceApi: {
        readRegistry() {
          return { schemaVersion: agentPresence.SCHEMA_VERSION, revision: 0, updatedAt: null, agents: {} };
        }
      }
    });
    assert.equal(completeOwnership.coverage, 'complete'); checkCount++;
    const stalled = processOpen([{
      id: 'R9', status: 'open',
      captureLog: [{ at: '2026-08-01T00:00:00.000Z', gatesAdded: 1 }],
      gates: [{ instruction: 'old open gate', met: false, evidence: '' }]
    }], completeOwnership);
    assert.match(stalled[0].derivedLabel, /^stalled/); checkCount++;
    const unavailableOwnership = productionOwnershipObservation({
      nowMs: observedAt,
      presenceApi: {
        readRegistry() {
          const error = new Error('malformed registry');
          error.code = 'AGENT_PRESENCE_STATE_INVALID';
          throw error;
        }
      }
    });
    assert.deepStrictEqual(unavailableOwnership, {
      nowMs: observedAt,
      ownershipObservedAtMs: null,
      liveOwnerRequestIds: [],
      coverage: 'unavailable',
      errorCode: 'AGENT_PRESENCE_STATE_INVALID'
    }); checkCount++;
    assert.equal(processOpen([{
      id: 'R9', status: 'open',
      captureLog: [{ at: '2026-08-01T00:00:00.000Z', gatesAdded: 1 }],
      gates: [{ instruction: 'old open gate', met: false, evidence: '' }]
    }], unavailableOwnership)[0].derivedLabel, null, 'unavailable ownership must fail closed'); checkCount++;

    const openGates = processOpenGates(ledger, { nowMs: Date.parse('2026-08-08T00:00:00.000Z') });
    // Same field, one level down: every projected gate carries the authority of
    // the REQUEST it decomposes, because a gate cannot be more the owner's word
    // than the request it came from. Pinned with its value for the same reason
    // as above.
    assert.deepStrictEqual(openGates.active, [{ requestId: 'R1', requestStatus: 'open', gateIndex: 1, instruction: 'Keep **exactly** "these" words.', state: 'active', ownerAuthority: UNSOURCED_AUTHORITY }]); checkCount++;
    assert.deepStrictEqual(openGates.counts, { active: 1, activePendingClassification: 0, unresolved: 0, supersededClauses: 0, superseded: 0, retiredClauses: 0, retired: 0, unmappedRuleRetirements: 0, unmappedRuleSupersessions: 0 }); checkCount++;
    const digest = renderOpenGatesDigest(openGates);
    assert.equal(renderOpenGatesDigest(openGates), digest); checkCount++;
    assert.ok(digest.includes('Keep **exactly** "these" words.')); checkCount++;
    assert.ok(digest.includes('Ledger revision: unknown'), 'digest without meta must render an explicit unknown stamp, never silently omit it'); checkCount++;
    checkCount += assertSectionOrder(digest, '## Active gates', '## Superseded gates', 'active section must render first');
    const digestPath = path.join(tempDir, 'OPEN-GATES.md');
    await writeOpenGatesDigest(openGates, digestPath);
    assert.equal(await fs.readFile(digestPath, 'utf8'), digest); checkCount++;

    const classifiedLedger = [
      { id: 'R10', status: 'open', gates: [
        { instruction: 'superseded clause', met: false, evidence: '' },
        { instruction: 'retired clause', met: false, evidence: '' },
        { instruction: 'still active', met: false, evidence: '' }
      ] },
      { id: 'R11', status: 'open', gates: [{ instruction: 'winning clause', met: false, evidence: '' }] },
      { id: 'R20', status: 'open', gates: [{ instruction: 'whole old request', met: false, evidence: '' }] },
      { id: 'R20.1', status: 'open', gates: [], versioningDisposition: {
        kind: 'legacy-duplicate-version-merge', activeId: 'R20.1', supersededIds: ['R20']
      } },
      { id: 'R40', status: 'open', gates: [{ instruction: 'unmatched gate stays active', met: false, evidence: '' }] },
      { id: 'R41', status: 'open', gates: [] }
    ];
    const classifiedRules = [
      scopeRule('rule_r10_gate_001', 'request.r10.gate.001', 'R10', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r10_gate_002', 'request.r10.gate.002', 'R10', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r10_gate_003', 'request.r10.gate.003', 'R10', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r10_body', 'request.r10.body', 'R10', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r11_gate_001', 'request.r10.gate.001', 'R11', '2026-08-02T00:00:00.000Z'),
      scopeRule('rule_r40_gate_001', 'request.r40.gate.001', 'R40', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r40_body', 'policy.body', 'R40', '2026-08-01T00:00:00.000Z'),
      scopeRule('rule_r41_body', 'policy.body', 'R41', '2026-08-02T00:00:00.000Z')
    ];
    const classifiedRetired = [{ id: 'R30', status: 'open', gates: [{ instruction: 'retired request gate', met: false, evidence: '' }] }];
    const classifiedRetirements = [
      { targetKind: 'rule', requestId: 'R10', ruleKey: 'request.r10.gate.002', retiredAt: '2026-08-07T00:00:00.000Z', retiredBy: 'owner', reason: { code: 'owner-confirmed', detail: 'Clause retired.', supersedingRequestIds: [] } },
      { targetKind: 'rule', requestId: 'R10', ruleKey: 'request.r10.body', retiredAt: '2026-08-07T00:00:01.000Z', retiredBy: 'owner', reason: { code: 'owner-confirmed', detail: 'Body rule retired.', supersedingRequestIds: [] } },
      { targetKind: 'request', requestId: 'R30', retiredAt: '2026-08-07T00:00:02.000Z', retiredBy: 'owner', reason: { code: 'completed', detail: 'Request completed.', supersedingRequestIds: [] } }
    ];
    const classified = processOpenGates(classifiedLedger, {
      scopeRules: classifiedRules,
      classifiedMode: true,
      retiredRequests: classifiedRetired,
      retirements: classifiedRetirements,
      nowMs: Date.parse('2026-08-08T00:00:00.000Z')
    });
    assert.deepStrictEqual(classified.counts, { active: 2, activePendingClassification: 0, unresolved: 1, supersededClauses: 1, superseded: 1, retiredClauses: 1, retired: 1, unmappedRuleRetirements: 1, unmappedRuleSupersessions: 1 }); checkCount++;
    assert.deepStrictEqual(classified.openGateCoverage, { expected: 7, projected: 7 }); checkCount++;
    assert.equal(classified.active.some(gate => gate.requestId === 'R10' && gate.gateIndex === 0), false); checkCount++;
    assert.equal(classified.active.some(gate => gate.requestId === 'R10' && gate.gateIndex === 1), false); checkCount++;
    assert.equal(classified.active.some(gate => gate.requestId === 'R10' && gate.gateIndex === 2), true); checkCount++;
    assert.equal(classified.supersededClauses[0].ruleKey, 'request.r10.gate.001'); checkCount++;
    assert.deepStrictEqual(classified.supersededClauses[0].supersededBy, ['R11']); checkCount++;
    assert.equal(classified.retiredClauses[0].ruleKey, 'request.r10.gate.002'); checkCount++;
    assert.equal(classified.superseded[0].requestId, 'R20'); checkCount++;
    assert.equal(classified.retired[0].requestId, 'R30'); checkCount++;
    assert.equal(classified.active.some(gate => gate.requestId === 'R40'), true, 'unmatched supersession must fail open'); checkCount++;
    assert.equal(classified.active.some(gate => gate.requestId === 'R11'), false, 'a winner targeting another request key must not activate its own same-index gate'); checkCount++;
    assert.equal(classified.unresolved.some(gate => gate.requestId === 'R11' && gate.gateIndex === 0), true); checkCount++;
    assert.equal(classified.unmappedRuleRetirements[0].retirement.ruleKey, 'request.r10.body'); checkCount++;
    assert.equal(classified.unmappedRuleSupersessions[0].ruleSupersession.ruleKey, 'policy.body'); checkCount++;
    const classifiedDigest = renderOpenGatesDigest(classified, { revision: 42, updatedAt: '2026-08-07' });
    checkCount += assertSectionOrder(classifiedDigest, '## Active gates', '## Superseded clause gates', 'classified: active before superseded clause');
    checkCount += assertSectionOrder(classifiedDigest, '## Active gates', '## Unresolved / unclassified gates', 'classified: active before unclassified');
    checkCount += assertSectionOrder(classifiedDigest, '## Superseded clause gates', '## Superseded gates', 'classified: superseded clause before superseded');
    assert.match(classifiedDigest, /does not identify a gate; no gate was hidden/); checkCount++;

    const foreignWinnerOnly = processOpenGates([
      { id: 'R80', status: 'open', gates: [{ instruction: 'own gate without an own-key rule', met: false, evidence: '' }] },
      { id: 'R81', status: 'open', gates: [{ instruction: 'own gate without an own-key rule', met: false, evidence: '' }] }
    ], {
      classifiedMode: true,
      scopeRules: [
        scopeRule('rule_r80_foreign_gate', 'request.r90.gate.001', 'R80', '2026-08-01T00:00:00.000Z'),
        scopeRule('rule_r81_foreign_gate', 'request.r91.gate.001', 'R81', '2026-08-01T00:00:00.000Z')
      ],
      nowMs: Date.parse('2026-08-08T00:00:00.000Z')
    });
    assert.equal(foreignWinnerOnly.active.length, 0, 'winner rules targeting old ruleKeys must not activate same-index winner gates'); checkCount++;
    assert.deepStrictEqual(foreignWinnerOnly.unresolved.map(gate => gate.requestId), ['R80', 'R81']); checkCount++;
    assert.deepStrictEqual(foreignWinnerOnly.openGateCoverage, { expected: 2, projected: 2 }); checkCount++;

    // THE RECORDED REVIEW WATERMARK.
    //
    // Before this existed, one classification run quietly became an expiry date
    // on the owner's voice: a request recorded the next day had no reviewed rule
    // (nobody had read it yet), which looked exactly like a request the
    // reviewers had considered and held back, so it was filed as unresolved and
    // stopped being acted on. 244 directives went silent that way.
    //
    // The two cases must now be distinguishable, and the distinction has to cut
    // BOTH ways -- the fix is worthless if it also waves through the gates that
    // were genuinely reviewed and withheld.
    const watermarkLedger = [
      { id: 'R10', status: 'open', gates: [
        { instruction: 'reviewed, and a rule matched it', met: false, evidence: '' },
        { instruction: 'reviewed, and deliberately left unmatched', met: false, evidence: '' }
      ] },
      { id: 'R99', status: 'open', gates: [{ instruction: 'recorded after the reviewers finished', met: false, evidence: '' }] }
    ];
    const watermarkRules = [scopeRule('rule_r10_gate_001', 'request.r10.gate.001', 'R10', '2026-08-01T00:00:00.000Z')];
    const watermarkOptions = { scopeRules: watermarkRules, classifiedMode: true, nowMs: Date.parse('2026-08-08T00:00:00.000Z') };
    // Without a recorded corpus nothing may change: a store written before the
    // watermark existed cannot say what was read, and guessing would reclassify
    // the withheld gates as active -- louder, but no longer true.
    const unwatermarked = processOpenGates(watermarkLedger, watermarkOptions);
    assert.equal(unwatermarked.counts.active, 1); checkCount++;
    assert.equal(unwatermarked.counts.activePendingClassification, 0); checkCount++;
    assert.deepStrictEqual(unwatermarked.unresolved.map(gate => `${gate.requestId}#${gate.gateIndex + 1}`),
      ['R10#2', 'R99#1'], 'without a watermark every unmatched gate keeps failing closed'); checkCount++;
    assert.equal(unwatermarked.reviewedLedgerRevision, null); checkCount++;
    const watermarked = processOpenGates(watermarkLedger, {
      ...watermarkOptions, reviewedLedgerRevision: 965, reviewedRequestIds: ['R10']
    });
    assert.equal(watermarked.counts.activePendingClassification, 1); checkCount++;
    assert.deepStrictEqual(watermarked.active.map(gate => `${gate.requestId}#${gate.gateIndex + 1}:${gate.state}`),
      ['R10#1:active', 'R99#1:active-pending-classification'],
      'a request outside the recorded review watermark is active and says why'); checkCount++;
    assert.deepStrictEqual(watermarked.unresolved.map(gate => `${gate.requestId}#${gate.gateIndex + 1}`),
      ['R10#2'], 'a gate the reviewers DID see and left unmatched must still fail closed'); checkCount++;
    assert.equal(watermarked.active[1].reviewedLedgerRevision, 965); checkCount++;
    assert.equal(watermarked.reviewedLedgerRevision, 965); checkCount++;
    // Conservation still holds once a gate can reach the new bucket.
    assert.deepStrictEqual(watermarked.openGateCoverage, { expected: 3, projected: 3 }); checkCount++;
    const watermarkedDigest = renderOpenGatesDigest(watermarked, { revision: 965, updatedAt: '2026-08-12' });
    assert.match(watermarkedDigest, /Open gates awaiting classification \(not covered by the recorded review watermark\): 1/); checkCount++;
    assert.match(watermarkedDigest, /Classification: PENDING — not covered by the recorded review watermark \(ledger revision 965\)/); checkCount++;
    assert.ok(watermarkedDigest.includes('recorded after the reviewers finished'),
      'a pending gate must be rendered in full, not summarized away'); checkCount++;
    // Half a watermark would let a reader believe membership had been checked
    // when it could not have been, so it is refused rather than half-applied.
    assert.throws(() => processOpenGates(watermarkLedger, { ...watermarkOptions, reviewedLedgerRevision: 965 }),
      error => error instanceof TypeError && error.message === 'OPEN_GATES_PROJECTION_INVALID_OPTIONS'); checkCount++;
    assert.throws(() => processOpenGates(watermarkLedger, { ...watermarkOptions, reviewedRequestIds: ['R10'] }),
      error => error instanceof TypeError && error.message === 'OPEN_GATES_PROJECTION_INVALID_OPTIONS'); checkCount++;

    /* The proposal preview is tested only against current, supplied data. No
     * request number or external review artifact participates
     * in classification. */
    const assertLiveProjectionIsConserved = (projection, label) => {
      assert.equal(projection.openGateCoverage.expected, projection.openGateCoverage.projected,
        `${label}: every open gate must be projected into exactly one bucket`); checkCount++;
    };

    const fixtureRequestOne = {
      id: 'R700',
      status: 'open',
      verbatim: 'Use the currently reviewed queue policy.',
      provenance: {
        class: 'owner-stated',
        source: 'fixture-message/queue-one',
        recordedBy: 'ledger-query-test',
        recordedAt: '2026-01-01T00:00:00.000Z'
      },
      gates: [
        { instruction: 'the queue is generated from current data', met: false, evidence: '' },
        { instruction: 'manual drift remains visible', met: false, evidence: '' }
      ]
    };
    const fixtureRequestTwo = {
      id: 'R701',
      status: 'open',
      verbatim: 'Use the second currently reviewed queue policy.',
      provenance: {
        class: 'owner-stated',
        source: 'fixture-message/queue-two',
        recordedBy: 'ledger-query-test',
        recordedAt: '2026-01-01T00:00:00.000Z'
      },
      gates: [{ instruction: 'the second queue policy is current', met: false, evidence: '' }]
    };
    const fixtureLedger = {
      schemaVersion: 1,
      revision: 7,
      updatedAt: '2026-01-09',
      requests: [
        fixtureRequestOne,
        fixtureRequestTwo,
        {
          id: 'R702',
          status: 'open',
          gates: [{ instruction: 'a gate without current owner provenance', met: false, evidence: '' }]
        }
      ]
    };
    const fixtureScopeRules = [
      scopeRule('rule_fixture_one_a', 'request.r700.gate.001', 'R700', '2026-01-02T00:00:00.000Z',
        { ownerVerbatim: fixtureRequestOne.verbatim }),
      scopeRule('rule_fixture_one_b', 'request.r700.gate.002', 'R700', '2026-01-02T00:00:01.000Z',
        { ownerVerbatim: fixtureRequestOne.verbatim }),
      scopeRule('rule_fixture_two_a', 'request.r701.gate.001', 'R701', '2026-01-02T00:00:02.000Z',
        { ownerVerbatim: fixtureRequestTwo.verbatim })
    ];
    const proposalLedgerPath = path.join(tempDir, 'proposal-ledger.json');
    const proposalLedgerRaw = JSON.stringify(fixtureLedger);
    await fs.writeFile(proposalLedgerPath, proposalLedgerRaw, 'utf8');
    const proposalScopeStorePath = path.join(tempDir, 'proposal-scope-store.json');
    const proposalScopeStoreRaw = JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      rules: fixtureScopeRules
    });
    await fs.writeFile(proposalScopeStorePath, proposalScopeStoreRaw, 'utf8');
    const fixtureProposal = buildScopeProposal({
      ledger: fixtureLedger,
      ledgerRaw: proposalLedgerRaw,
      scopeRules: fixtureScopeRules,
      scopeStoreSnapshot: { exists: true, revision: 2, sha256: sha256(proposalScopeStoreRaw) },
      evaluatedAt: '2026-01-10T00:00:00.000Z'
    });
    const currentProposal = fixtureProposal;
    validateScopeProposal(fixtureProposal); checkCount++;
    assert.deepStrictEqual(fixtureProposal.entries.map(entry => entry.classification), [
      'classified-from-current-scope',
      'classified-from-current-scope',
      'unresolved-no-current-verbatim'
    ]); checkCount++;
    const fixtureRules = materializeProposalRules(fixtureProposal);
    assert.deepStrictEqual(fixtureRules.map(rule => rule.ruleKey), [
      'request.r700.gate.001',
      'request.r700.gate.002',
      'request.r701.gate.001'
    ]); checkCount++;
    const fixtureProjection = processOpenGates(fixtureLedger.requests, {
      scopeRules: fixtureRules,
      classifiedMode: true,
      retiredRequests: [],
      retirements: [],
      nowMs: Date.parse(fixtureProposal.resolution.evaluatedAt)
    });
    assert.deepStrictEqual(fixtureProjection.active.map(gate => `${gate.requestId}#${gate.gateIndex + 1}`), [
      'R700#1', 'R700#2', 'R701#1'
    ]); checkCount++;
    assert.deepStrictEqual(fixtureProjection.unresolved.map(gate => `${gate.requestId}#${gate.gateIndex + 1}`), [
      'R702#1'
    ]); checkCount++;
    assert.deepStrictEqual(fixtureProjection.openGateCoverage, { expected: 4, projected: 4 }); checkCount++;

    const emptyLedger = { schemaVersion: 1, revision: 1, updatedAt: '2026-01-09', requests: [] };
    const emptyProposal = buildScopeProposal({
      ledger: emptyLedger,
      ledgerRaw: JSON.stringify(emptyLedger),
      scopeRules: [],
      scopeStoreSnapshot: { exists: false, revision: 0, sha256: sha256('absent') },
      evaluatedAt: '2026-01-10T00:00:00.000Z'
    });
    assert.equal(emptyProposal.counts.entryCount, 0); checkCount++;
    assert.equal(materializeProposalRules(emptyProposal).length, 0); checkCount++;

    // The freshness stamp's exact format is a small contract with
    const meta = await readLedgerMeta(fixturePath);
    assert.deepStrictEqual(meta, { revision: 42, updatedAt: '2026-08-07' }); checkCount++;
    const stampedDigest = renderOpenGatesDigest(openGates, meta);
    assert.ok(stampedDigest.includes('Ledger revision: 42 (updated 2026-08-07)')); checkCount++;
    assert.equal(stampLedgerRevision(meta), 'Ledger revision: 42 (updated 2026-08-07)'); checkCount++;
    assert.equal(stampLedgerRevision(null), null); checkCount++;
    assert.equal(stampLedgerRevision({ revision: 42 }), null, 'missing updatedAt must not produce a half-formed stamp'); checkCount++;
    assert.equal(stampLedgerRevision({ updatedAt: '2026-08-07' }), null, 'missing revision must not produce a half-formed stamp'); checkCount++;
    const noMetaPath = path.join(tempDir, 'no-meta.json');
    await fs.writeFile(noMetaPath, JSON.stringify({ requests: [] }), 'utf8');
    const emptyMeta = await readLedgerMeta(noMetaPath);
    assert.deepStrictEqual(emptyMeta, { revision: null, updatedAt: null }); checkCount++;
    const stampedPath = path.join(tempDir, 'OPEN-GATES-stamped.md');
    await writeOpenGatesDigest(openGates, stampedPath, meta);
    assert.ok((await fs.readFile(stampedPath, 'utf8')).includes('Ledger revision: 42 (updated 2026-08-07)')); checkCount++;
    // Deliberately no CLI-level `open --gates --write` invocation here: LEDGER_PATH and
    // OPEN_GATES_REPORT_PATH are module-level constants derived from __dirname, not
    // overridable per-call, so exec'ing the real CLI from this test would write to this
    // repo's actual reports/OPEN-GATES.md as a side effect. main()'s wiring (readLedgerMeta
    // -> writeOpenGatesDigest) is exercised at the unit level above instead.

    await assert.rejects(async () => processGet('req-999', ledger), error => error instanceof LedgerQueryError && error.exitCode === 5); checkCount++;

    const malformedPath = path.join(tempDir, 'bad.json');
    await fs.writeFile(malformedPath, '{"key": "value",}', 'utf8');
    await assert.rejects(async () => readLedger(malformedPath), error => error instanceof LedgerQueryError && error.exitCode === 3); checkCount++;
    const bareArrayPath = path.join(tempDir, 'bare-array.json');
    await fs.writeFile(bareArrayPath, '[]', 'utf8');
    await assert.rejects(async () => readLedger(bareArrayPath), error => error instanceof LedgerQueryError && error.exitCode === 3); checkCount++;

    await assert.rejects(execFileAsync('node', [SCRIPT_PATH, '--file', fixturePath]), error => error.message.includes('CLI flags are not permitted') && error.code === 6); checkCount++;
    await assert.rejects(execFileAsync('node', [SCRIPT_PATH, 'open', '--write']), error => error.message.includes('open" command accepts') && error.code === 6); checkCount++;
    await assert.rejects(execFileAsync('node', [SCRIPT_PATH, 'open', '--gates', '--proposal-preview', '--write']), error => error.message.includes('read-only') && error.code === 6); checkCount++;
    const cliProjection = JSON.parse((await execFileAsync(process.execPath, [SCRIPT_PATH, 'open', '--gates'], {
      env: { ...process.env, TOOLSENABLED_OWNER_LEDGER_FILE: fixturePath },
      maxBuffer: 8 * 1024 * 1024
    })).stdout);
    assert.equal(cliProjection.classifiedMode, false,
      'the disposable ledger has no applied production scope rules'); checkCount++;
    assertLiveProjectionIsConserved(cliProjection, 'disposable CLI projection');

    const previewProposalPath = path.join(tempDir, 'proposal-preview.json');
    const writePreviewMutation = async mutate => {
      const candidate = structuredClone(currentProposal);
      mutate(candidate);
      candidate.proposalSha256 = proposalHash(candidate);
      await fs.writeFile(previewProposalPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    };
    await fs.writeFile(previewProposalPath, `${JSON.stringify(currentProposal, null, 2)}\n`, 'utf8');
    // The preview loader must materialize the same source-bound rule set as the
    // direct path, dropping none on the way through the fence checks.
    const previewRules = await loadScopeProposalPreviewRules({
      proposal: previewProposalPath,
      ledger: proposalLedgerPath,
      scopeStore: proposalScopeStorePath
    });
    assert.equal(previewRules.length, materializeProposalRules(currentProposal).length,
      'the preview loader must not drop rules the proposal materializes directly'); checkCount++;
    await writePreviewMutation(candidate => { candidate.sourceLedger.sha256 = '0'.repeat(64); });
    await assert.rejects(loadScopeProposalPreviewRules({ proposal: previewProposalPath, ledger: proposalLedgerPath, scopeStore: proposalScopeStorePath }), error => error instanceof LedgerQueryError
      && error.exitCode === 11 && error.message.includes('OWNER_SCOPE_PROPOSAL_LEDGER_CHANGED')); checkCount++;
    await writePreviewMutation(candidate => { candidate.sourceScopeStore.sha256 = '0'.repeat(64); });
    await assert.rejects(loadScopeProposalPreviewRules({ proposal: previewProposalPath, ledger: proposalLedgerPath, scopeStore: proposalScopeStorePath }), error => error instanceof LedgerQueryError
      && error.exitCode === 11 && error.message.includes('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_CHANGED')); checkCount++;
    await assert.rejects(execFileAsync('node', [SCRIPT_PATH, 'set-gate', 'req-001']), error => error.message.includes('Unknown command "set-gate"') && error.code === 9); checkCount++;

    /* ========================================================================
     * AUTHORIZATION: SEEING THAT SOMETHING WAS PERMITTED, NOT MERELY ASKED FOR.
     *
     * From a real incident on 2026-08-12: two lanes stopped work over a change
     * the owner had already approved, because nothing recorded the approval
     * anywhere they would look. Every surface answered "what was asked for".
     * A permission is not a task -- it never becomes an unmet gate, so it was
     * invisible to the open-gate digest, to the build queue, and to every list
     * these tools publish, and marking the authorized work `done` erased its
     * last trace.
     * ====================================================================== */
    const authorizationLedger = [
      { id: 'R700', status: 'done', provenance: {
        class: 'owner-stated',
        source: 'fixture-message/authorization',
        recordedBy: 'ledger-query-test',
        recordedAt: '2026-01-01T00:00:00.000Z'
      }, verbatim: 'go ahead',
        gates: [
          { instruction: 'rewrite the launch copy', met: true, evidence: 'commit 0000000' },
          { instruction: 'a lane may rewrite the launch copy without a further approval round',
            met: true, evidence: 'owner turn', clauseKind: 'grant',
            authorization: { permits: 'rewriting the launch copy without a further approval round', scope: 'any lane' } }
        ] },
      { id: 'R701', status: 'open',
        gates: [{ instruction: 'no visible shell without the allowlist token', met: false, evidence: '',
          clauseKind: 'prohibition', authorization: { forbids: 'a visible shell without an allowlist token' } }] },
      { id: 'R702', status: 'open',
        gates: [{ instruction: 'undeclared clause', met: false, evidence: '' }] }
    ];
    const authorizations = projectAuthorizations(authorizationLedger);
    // 1. THE GRANT SURVIVES ITS OWN WORK BEING FINISHED. R700 is `done` and both
    //    its gates are met, so it appears in no open-gate bucket at all -- which
    //    is exactly the state in which the permission used to disappear.
    assert.deepStrictEqual(processOpenGates(authorizationLedger, { nowMs: Date.parse('2026-08-12T00:00:00.000Z') })
      .active.map(gate => `${gate.requestId}#${gate.gateIndex + 1}`), ['R701#1', 'R702#1'],
    'the fixture must actually put the granting entry outside the open-gate set'); checkCount++;
    assert.deepStrictEqual(authorizations.grants.map(record => record.ref), ['R700#2'],
      'a grant on a completed entry is still in force'); checkCount++;
    assert.deepStrictEqual(authorizations.prohibitions.map(record => record.ref), ['R701#1']); checkCount++;
    // 2. AN UNDECLARED CLAUSE IS WORK, AND SAYS SO OUT LOUD. "0 grants" must be
    //    distinguishable from "nothing has ever been classified".
    assert.equal(authorizations.counts.undeclaredClauses, 2,
      'R700 gate 1 and R702 gate 1 declare no kind; the two authorization clauses do'); checkCount++;
    assert.equal(authorizations.counts.declaredWorkClauses, 0); checkCount++;
    // 3. IT REACHES THE SURFACE AGENTS ACTUALLY READ, above the gate list.
    const authorizedProjection = processOpenGates(authorizationLedger, { nowMs: Date.parse('2026-08-12T00:00:00.000Z') });
    const authorizedDigest = renderOpenGatesDigest(authorizedProjection);
    checkCount += assertSectionOrder(authorizedDigest,
      '## Authorizations on file', '## Active gates', 'permission must be rendered before the task list');
    assert.ok(authorizedDigest.includes('R700#2 AUTHORIZED: rewriting the launch copy without a further approval round'),
      'the digest must name the grant, its id and what it permits'); checkCount++;
    assert.ok(authorizedDigest.includes('R701#1 FORBIDDEN: a visible shell without an allowlist token')); checkCount++;
    // 4. AUTHORITY LABELLING IS THE SAME AS EVERYWHERE ELSE. A grant recorded on
    //    an entry with no provenance is shown, and shown as a claim.
    assert.match(renderAuthorizationLine(authorizations.grants[0]), /\[owner-stated\]$/); checkCount++;
    assert.match(renderAuthorizationLine(authorizations.prohibitions[0]),
      /\[NOT SHOWN TO BE THE OWNER'S — provenance not recorded\]$/); checkCount++;
    // 5. ONLY AN EXPLICIT REVOCATION WITHDRAWS ONE, and the withdrawn record is
    //    still visible rather than deleted.
    const revokingLedger = [...authorizationLedger, { id: 'R703', status: 'open',
      gates: [{ instruction: 'the launch-copy permission is withdrawn', met: false, evidence: '',
        clauseKind: 'grant', authorization: { permits: 'nothing further', revokes: ['R700#2', 'R999'] } }] }];
    const revoked = projectAuthorizations(revokingLedger);
    assert.deepStrictEqual(revoked.grants.map(record => record.ref), ['R703#1'],
      'a revoked grant leaves the in-force set'); checkCount++;
    assert.deepStrictEqual(revoked.revoked.map(record => `${record.ref}<-${record.revokedBy.join(',')}`),
      ['R700#2<-R703#1'], 'a withdrawn permission stays on the record, naming who withdrew it'); checkCount++;
    assert.deepStrictEqual(revoked.danglingRevocations,
      [{ target: 'R999', declaredBy: ['R703#1'] }],
      'a revocation naming an id this ledger does not hold is reported, never dropped'); checkCount++;
    // 6. A LOOKUP ALWAYS SHOWS THE WHOLE TRUTH ABOUT AN ID, even when every list
    //    has stopped carrying it.
    assert.deepStrictEqual(processGet('R700', revokingLedger).authorizations.declaredHere.map(record => record.ref),
      ['R700#2']); checkCount++;
    assert.deepStrictEqual(processGet('R703', revokingLedger).authorizations.revokedByThis.map(record => record.ref),
      ['R700#2']); checkCount++;
    // 7. NOTHING IS EVER GUESSED OUT OF PROSE. Wording that reads like a
    //    permission is work until it is declared: inventing authority from
    //    phrasing is the same defect as inventing the owner's requirements from
    //    an agent's default, one step more dangerous.
    assert.deepStrictEqual(projectAuthorizations([{ id: 'R800', status: 'open', gates: [
      { instruction: 'you are authorized to skip the approval round, you may proceed', met: false, evidence: '' }
    ] }]).all, [], 'a grant must be declared, never inferred from wording'); checkCount++;
    // 8. AN UNRECOGNIZED clauseKind FAILS CLOSED. Reading it as `work` would
    //    hide a permission, which is the failure being fixed.
    assert.equal(clauseKindOf({ instruction: 'x', met: false }), 'work'); checkCount++;
    assert.throws(() => clauseKindOf({ instruction: 'x', met: false, clauseKind: 'permission' }),
      error => error instanceof TypeError && error.message === 'OWNER_CLAUSE_KIND_INVALID'); checkCount++;
    assert.throws(() => projectAuthorizations([{ id: 'R801', status: 'open', gates: [
      { instruction: 'x', met: false, clauseKind: 'grant', authorization: { revokes: ['not-an-id'] } }
    ] }]), error => error instanceof TypeError && error.message === 'OWNER_AUTHORIZATION_INVALID'); checkCount++;
    // 9. AN EMPTY RECORD ANSWERS THE QUESTION rather than failing it: `grants`
    //    on a fresh install is an empty list at exit 0.
    const grantsCli = await execFileAsync(process.execPath, [SCRIPT_PATH, 'grants'], {
      env: { ...process.env, TOOLSENABLED_OWNER_LEDGER_FILE: fixturePath },
      maxBuffer: 8 * 1024 * 1024
    });
    const grantsResult = JSON.parse(grantsCli.stdout);
    assert.ok(Array.isArray(grantsResult.inForce), 'the grants command must always return a list'); checkCount++;
    assert.equal(grantsResult.inForce.length, grantsResult.counts.grants + grantsResult.counts.prohibitions); checkCount++;

    const finalContent = await fs.readFile(fixturePath, 'utf8');
    assert.strictEqual(finalContent, originalContent); checkCount++;
    console.log(`ledger-query tests passed (${checkCount} checks; current source-bound proposal preview verified).`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

runTests().catch(error => {
  console.error('Tests failed:', error);
  process.exit(1);
});
