// EXECUTABLE CHANGE
'use strict';

/* Test-can-fail report (testcanfail-tests-queue-from-ledger-js)
 *
 * Strengthened assertions: the phase ordering, declared gate count, criterion
 * count, criterion numbering/text, authority, and heading assertions that
 * iterate over the live projection now also run against an explicitly
 * non-empty, two-phase fixture below.  Mutation: changed the generator's gate
 * rendering temporarily from `${gate.instruction}` to
 * `MUTATED ${gate.instruction}`.  RED output:
 *   AssertionError [ERR_ASSERTION]: generated phase changed fixture gate text
 * The source SHA-256 before and after restoration was identical:
 * ee0678e933d0e74337b490a161e08cfcc0f86755ff71858c4e5a14fb15693872.
 * After restoration the focused fixture assertion printed:
 *   restored fixture assertion: green
 *
 * NOT-FOUND: exit-status/truthy-return assertions; swallowed failures in
 * try/catch or optional chains; mocks of the subject; platform skip guards;
 * expected values computed by the same product code.  The malformed-ledger
 * try/catch preserves its error and asserts it, rather than swallowing it.
 *
 * Unmet precondition: this checkout lacks queue/owner.ledger.md and
 * reports/OWNER-REQUEST-LEDGER.json, so the complete file cannot reach its
 * fixture checks here.  Its observed refusal is quoted in the test report:
 *   AssertionError [ERR_ASSERTION]: queue/owner.ledger.md must exist; run
 *   `node tools/queue-from-ledger.js --write`
 */

// THE GENERATED QUEUE SLICE MUST STAY A PROJECTION, NOT A COPY THAT ROTS.
//
// tools/queue-from-ledger.js exists because BUILD-QUEUE.md and
// reports/OWNER-REQUEST-LEDGER.json were two hand-maintained lists of the same
// facts, and 606 of 669 unfinished directives had fallen out of the queue
// entirely. A generator alone does not fix that: a generated file that nobody
// re-checks is just a slower copy. This suite is the re-check.
//
// It deliberately does NOT trust the generator's own output as the standard.
// The active-gate set is recomputed here straight from the ledger through
// tools/ledger-query.js, and the slice on disk is measured against THAT. A test
// that only regenerated and byte-compared would pass happily while both sides
// were wrong in the same way.
//
// It also pins the regression that killed the first design: an 8-digit phase id
// derived from the R-id (R1548 -> Q9154800) reads fine, and makes
// src/lib/build-queue-writer.js's parseStrictQueue throw QUEUE_PHASE_MALFORMED
// for the ENTIRE corpus -- root and every slice -- so nobody can append or
// claim a phase anywhere. The strict parser is asserted against the live corpus
// here so that can never land again unnoticed.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const generator = require('../tools/queue-from-ledger');
const ledgerQuery = require('../tools/ledger-query');
const scopeStore = require('../src/lib/owner-request-scope-store');
const provenance = require('../src/lib/build-queue-provenance');
const writer = require('../src/lib/build-queue-writer');
const { readQueueCorpus, renderQueueIndex } = require('../src/lib/build-queue-corpus');

const ROOT = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-from-ledger-contract-'));
const QUEUE_ROOT_FILE = path.join(fixtureRoot, 'BUILD-QUEUE.md');
const QUEUE_DIRECTORY = path.join(fixtureRoot, 'queue');
const SLICE_FILE = path.join(QUEUE_DIRECTORY, 'owner.ledger.md');
const MANIFEST_FILE = path.join(QUEUE_DIRECTORY, 'manifest.json');
const LEDGER_FILE = path.join(fixtureRoot, 'OWNER-REQUEST-LEDGER.json');
const ARCHIVE_FILE = path.join(fixtureRoot, 'OWNER-REQUEST-LEDGER-ARCHIVE.json');
const SCOPE_STORE_FILE = path.join(fixtureRoot, 'owner-request-scope-rules.json');
fs.mkdirSync(QUEUE_DIRECTORY, { recursive: true });
fs.writeFileSync(QUEUE_ROOT_FILE,
  `# Disposable build queue contract fixture\n\n${renderQueueIndex(['owner.ledger'])}## Queue body\n\n`, 'utf8');
fs.writeFileSync(LEDGER_FILE, `${JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  requests: [
    { id: 'R701', status: 'open', verbatim: 'still to do',
      provenance: { class: 'owner-stated', recordedBy: 'fixture-recorder', source: 'fixture owner turn 2026-01-01' },
      gates: [{ instruction: 'still to do', met: false, evidence: '' }] },
    { id: 'R702', status: 'open', verbatim: 'finish both numbered gates',
      provenance: { class: 'owner-stated', recordedBy: 'fixture-recorder', source: 'fixture owner turn 2026-01-01' },
      gates: [
        { instruction: 'first numbered gate', met: false, evidence: '' },
        { instruction: 'second numbered gate', met: false, evidence: '' }
      ] }
  ]
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(ARCHIVE_FILE, `${JSON.stringify({ schemaVersion: 1, requests: [], retirements: [] }, null, 2)}\n`, 'utf8');
fs.writeFileSync(SCOPE_STORE_FILE, `${JSON.stringify(scopeStore.normalizeStore({
  schemaVersion: 1, revision: 1, rules: []
}), null, 2)}\n`, 'utf8');
process.once('exit', () => { try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {} });

const sourceOptions = extra => ({
  ledgerFile: LEDGER_FILE,
  archiveFile: ARCHIVE_FILE,
  scopeStoreFile: SCOPE_STORE_FILE,
  rootFile: QUEUE_ROOT_FILE,
  highWaterMark: 1,
  ...extra
});

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('check() is synchronous; await before calling it.');
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

/** The independent standard: what the ledger says is active, computed here. */
async function activeGatesFromLedger() {
  const ledger = await ledgerQuery.readLedger(LEDGER_FILE);
  const archive = await ledgerQuery.readArchiveState(ARCHIVE_FILE);
  const rules = scopeStore.readScopeStore({ file: SCOPE_STORE_FILE }).rules;
  const projection = ledgerQuery.processOpenGates(ledger, {
    scopeRules: rules,
    classifiedMode: rules.length > 0,
    retiredRequests: archive.requests,
    retirements: archive.retirements
  });
  const byRequest = new Map();
  for (const gate of projection.active) {
    if (!byRequest.has(gate.requestId)) byRequest.set(gate.requestId, []);
    byRequest.get(gate.requestId).push(gate);
  }
  for (const gates of byRequest.values()) gates.sort((a, b) => a.gateIndex - b.gateIndex);
  return { ledger, byRequest, projection };
}

/** Parse the generated slice back into phases, using only its own grammar. */
function parseGeneratedSlice(markdown) {
  const phases = [];
  let current = null;
  for (const line of markdown.split(/\r\n|\n/)) {
    const marker = /^<!-- queue-from-ledger:v1 phase=(Q[1-9]\d{0,2}) request=(R\d{1,4}(?:\.\d{1,2})?) activeGates=(\d+) -->$/.exec(line);
    if (marker) {
      current = {
        phaseId: marker[1],
        requestId: marker[2],
        declaredGateCount: Number(marker[3]),
        heading: null,
        authority: null,
        criteria: []
      };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    const heading = /^##\s+(Q[1-9]\d{0,2})\s+—\s+(.+)$/.exec(line);
    if (heading) { current.heading = heading; continue; }
    const authority = /^\*\*Authority:\*\*\s+(.+)$/.exec(line);
    if (authority) { current.authority = authority[1]; continue; }
    const criterion = /^(\d+)\.\s(.*)$/.exec(line);
    if (criterion) current.criteria.push({ index: Number(criterion[1]), text: criterion[2] });
  }
  return phases;
}

async function run() {
  const seeded = await generator.buildSlice(sourceOptions({ sliceMarkdown: null }));
  fs.writeFileSync(SLICE_FILE, seeded.markdown, 'utf8');
  const rootText = fs.readFileSync(QUEUE_ROOT_FILE, 'utf8');
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify({
    schemaVersion: 1,
    sourceSha256: crypto.createHash('sha256').update(rootText, 'utf8').digest('hex'),
    sourceBytes: Buffer.byteLength(rootText, 'utf8'),
    phaseOrder: seeded.projection.entries.map(entry => entry.phaseId),
    rootPhaseIds: [],
    slices: [{
      packageId: generator.PACKAGE_ID,
      path: generator.SLICE_RELATIVE_PATH,
      sha256: seeded.sha256,
      bytes: seeded.bytes
    }]
  }, null, 2)}\n`, 'utf8');
  const sliceFile = SLICE_FILE;
  assert.ok(fs.existsSync(sliceFile), `${generator.SLICE_RELATIVE_PATH} must exist; run \`node tools/queue-from-ledger.js --write\``);
  const onDisk = fs.readFileSync(sliceFile, 'utf8');
  const { ledger, byRequest } = await activeGatesFromLedger();
  const ledgerIds = new Set(ledger.map(request => request.id));
  const parsed = parseGeneratedSlice(onDisk);
  const built = await generator.buildSlice(sourceOptions({ sliceMarkdown: onDisk }));

  check('the slice announces itself as generated, in its first bytes', () => {
    assert.match(onDisk.slice(0, 400), /GENERATED FILE — DO NOT HAND-EDIT/);
    assert.match(onDisk, /^# Owner-directive queue slice .* GENERATED FILE, DO NOT HAND-EDIT$/m);
    assert.match(onDisk, /node tools\/queue-from-ledger\.js --write/);
  });

  // The drift test proper. Regeneration is byte-for-byte, so a hand edit, a new
  // owner directive, a met gate, or a scope reclassification all fail here.
  check('the slice on disk is byte-identical to what the ledger projects today', () => {
    assert.equal(built.markdown, onDisk,
      'queue/owner.ledger.md has drifted from reports/OWNER-REQUEST-LEDGER.json. '
      + 'Re-run `node tools/queue-from-ledger.js --write`; do not hand-edit the slice.');
  });

  check('every owner request with an active gate has exactly one phase, and nothing else does', () => {
    const projected = parsed.map(phase => phase.requestId).sort();
    const expected = [...byRequest.keys()].sort();
    assert.deepEqual(projected, expected,
      'the slice\'s request set is not the ledger\'s active-gate request set');
    assert.equal(new Set(projected).size, projected.length, 'a request appears in more than one phase');
  });

  check('phases are ordered by R-id', () => {
    const key = id => {
      const match = /^R(\d{1,4})(?:\.(\d{1,2}))?$/.exec(id);
      return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
    };
    for (let i = 1; i < parsed.length; i += 1) {
      const a = key(parsed[i - 1].requestId);
      const b = key(parsed[i].requestId);
      assert.ok(a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]),
        `${parsed[i - 1].requestId} must sort before ${parsed[i].requestId}`);
    }
  });

  check('each phase carries its request\'s active gates verbatim, as acceptance criteria', () => {
    for (const phase of parsed) {
      const gates = byRequest.get(phase.requestId);
      assert.ok(gates, `${phase.requestId} has no active gates but has a phase`);
      assert.equal(phase.declaredGateCount, gates.length, `${phase.phaseId} declares the wrong active-gate count`);
      assert.equal(phase.criteria.length, gates.length, `${phase.phaseId} lists ${phase.criteria.length} criteria for ${gates.length} active gates`);
      gates.forEach((gate, offset) => {
        assert.equal(phase.criteria[offset].index, gate.gateIndex + 1, `${phase.phaseId} criterion ${offset + 1} is numbered off its gate index`);
        assert.equal(phase.criteria[offset].text, gate.instruction,
          `${phase.phaseId} altered the ledger's stored gate text; gate text is quoted, never paraphrased`);
      });
    }
  });

  check('every phase cites its own R-id as authority, and that R-id exists in the ledger', () => {
    for (const phase of parsed) {
      assert.ok(phase.authority, `${phase.phaseId} has no Authority line`);
      assert.equal(phase.authority, `${phase.requestId}; directiveId: owner-request-ledger:${phase.requestId}`);
      assert.ok(ledgerIds.has(phase.requestId), `${phase.phaseId} cites ${phase.requestId}, which is not in the ledger`);
      // Same shape src/lib/build-queue-writer.js demands of a hand-written phase.
      assert.match(`**Authority:** ${phase.authority}`, /^\*\*Authority:\*\*\s+R\d+\b.*\bdirectiveId:\s*[^\s)]+/);
    }
  });

  check('the slice introduces no phantom citation of any kind', () => {
    const liveLedger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    const audit = () => provenance.auditQueueProvenance({
      sources: [{ file: generator.SLICE_RELATIVE_PATH, markdown: onDisk }],
      ledger: liveLedger
    });

    // 2026-08-12: the owner reset the ledger to zero, and auditQueueProvenance
    // REFUSES to judge provenance against an empty corpus rather than returning
    // a clean report. That refusal is the correct behaviour and this check must
    // assert it, not route around it -- "no findings" computed from no requests
    // is a false green, and a false green here is exactly how a phantom R-id
    // got cited in the first place.
    if (!(liveLedger.requests || []).length) {
      assert.throws(audit, /empty|refusing/i,
        'an empty ledger must make provenance judgment refuse, never silently pass');
      assert.equal(parsed.length, 0,
        'an empty ledger must project an empty slice; phases here would cite requests that do not exist');
      return;
    }

    const result = audit();
    assert.deepEqual(result.findings.filter(finding => finding.severity === 'error'), [],
      'a generated phase asserts authority the ledger cannot back');
    assert.equal(result.phaseCount, parsed.length);
  });

  check('a heading never promotes ledger prose into a citation position', () => {
    for (const phase of parsed) {
      assert.ok(phase.heading, `${phase.phaseId} has no canonical heading`);
      assert.equal(phase.heading[1], phase.phaseId, 'the marker and the heading disagree about the phase id');
      const afterOwnId = phase.heading[2].replace(new RegExp(`^${phase.requestId}\\b`), '');
      assert.ok(!/\bR\d{2,}(?:\.\d+)?\b/.test(afterOwnId),
        `${phase.phaseId}'s heading carries an R-number other than its own: ${phase.heading[2]}`);
      assert.ok(!/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-R\d{2,}(?:\.\d+)?\.md\b/.test(phase.heading[2]),
        `${phase.phaseId}'s heading names an R-numbered decision document`);
    }
    // The rule, exercised directly rather than only observed.
    const gate = [{ instruction: 'do the thing described in RELAY-DECISION-R1228.md', gateIndex: 0 }];
    assert.match(generator.titleFor('R1', gate), /^R1 — 1 active gate in the owner request ledger$/);
    assert.match(generator.titleFor('R1', [{ instruction: 'plain words', gateIndex: 0 }]), /^R1: plain words$/);
  });

  check('an id belongs to one request permanently: live and retired ids never overlap or repeat', () => {
    const assignments = generator.readAssignments(onDisk);
    assert.equal(assignments.assigned.size, parsed.length);
    const live = new Set([...assignments.assigned.values()]);
    for (const phaseId of assignments.retired.values()) {
      assert.ok(!live.has(phaseId), `${phaseId} is both live and retired`);
    }
    assert.equal(assignments.usedNumbers.size, assignments.assigned.size + assignments.retired.size);
  });

  check('the slice is declared by BUILD-QUEUE.md\'s package index and read through build-queue-corpus', () => {
    const declaration = generator.rootIndexDeclaration(QUEUE_ROOT_FILE);
    assert.equal(declaration.declared, true, declaration.reason || 'undeclared');
    const corpus = readQueueCorpus(QUEUE_ROOT_FILE);
    assert.ok(corpus.files.includes(generator.SLICE_RELATIVE_PATH), 'the corpus reader does not see the slice');
    const slice = corpus.slices.find(entry => entry.path === generator.SLICE_RELATIVE_PATH);
    assert.equal(slice.sha256, built.sha256);
  });

  check('queue/manifest.json declares the slice with a current receipt', () => {
    const manifest = generator.readManifest(MANIFEST_FILE);
    const receipt = generator.manifestReceipt(manifest);
    assert.ok(receipt, 'queue/manifest.json does not declare this slice');
    assert.equal(receipt.path, generator.SLICE_RELATIVE_PATH);
    assert.equal(receipt.sha256, built.sha256, 'the manifest receipt is stale');
    assert.equal(receipt.bytes, built.bytes);
  });

  // The regression that killed the derived-id design. If this fails, nobody can
  // append or claim a phase anywhere in the queue.
  check('build-queue-writer can still parse and allocate against the whole corpus', () => {
    const corpus = readQueueCorpus(QUEUE_ROOT_FILE);
    const phases = writer.parseStrictQueue(corpus.text);
    assert.ok(phases.length >= parsed.length, 'the strict parser lost generated phases');
    const ids = phases.map(phase => phase.id);
    assert.equal(new Set(ids).size, ids.length, 'phase ids collide across the corpus');
    const next = writer.nextPhaseId(corpus.text);
    assert.match(next, /^Q[1-9]\d{0,2}$/, 'the allocator can no longer produce a legal next id');
    for (const phase of parsed) {
      assert.ok(Number(phase.phaseId.slice(1)) < Number(next.slice(1)),
        `${phase.phaseId} is at or beyond the next allocatable id ${next}`);
    }
  });

  check('a hand edit to the slice is reported as drift, not absorbed', () => {
    // The property under test belongs to the PARSER, not to whatever the live
    // ledger happens to hold. Reading the tamper subject off disk made this
    // check silently untestable the moment the ledger was reset to zero: an
    // empty slice has no numbered criterion to edit, so the fixture stopped
    // changing anything and the check failed on its own guard rather than on
    // the behaviour. Drive it from a slice this test builds, so it holds on an
    // empty ledger, a full one, and any machine.
    const subject = parsed.length ? onDisk : [
      '<!-- queue-from-ledger:v1 phase=Q7 request=R700 activeGates=1 -->',
      '## Q7 — R700: a synthetic phase, so drift detection is testable at any ledger size',
      '**Authority:** R700; directiveId: owner-request-ledger:R700',
      '1. the criterion a hand edit will alter',
      '2. a second criterion that must stay untouched',
      ''
    ].join('\n');
    const subjectPhases = parseGeneratedSlice(subject);
    assert.equal(subjectPhases.length, Math.max(parsed.length, 1), 'the tamper subject must parse into phases');

    const tampered = subject.replace(/^(\d+)\. /m, '$1. HAND EDITED ');
    assert.notEqual(tampered, subject, 'the tamper fixture did not change anything');
    const tamperedPhases = parseGeneratedSlice(tampered);
    const differing = tamperedPhases.filter((phase, offset) =>
      JSON.stringify(phase.criteria) !== JSON.stringify(subjectPhases[offset].criteria));
    assert.equal(differing.length, 1, 'a single hand edit must show up as exactly one differing phase');
    // And the generator must never regard the edited text as its own output.
    assert.notEqual(tampered, built.markdown, 'the generator would have to regard the hand edit as correct');
  });

  check('an unmapped ledger status is never guessed into OPEN', () => {
    assert.equal(generator.queueStatusFor('open'), 'OPEN');
    assert.equal(generator.queueStatusFor('in-progress'), 'IN-PROGRESS');
    assert.equal(generator.queueStatusFor('partial'), 'PARTIAL');
    assert.match(generator.queueStatusFor('blocked-external'), /^BLOCKED/);
    assert.match(generator.queueStatusFor('something-new'), /^BLOCKED/);
    assert.match(generator.queueStatusFor(undefined), /^BLOCKED/);
  });

  check('a malformed marker or receipt fails closed instead of under-reading reservations', () => {
    // Under-reading the reservations is how one id gets handed to two requests.
    assert.throws(() => generator.readAssignments('<!-- queue-from-ledger:v1 phase=Q9 -->\n'), /Unrecognized generated phase marker/);
    assert.throws(() => generator.readAssignments('- **Q9 broken receipt\n'), /Unrecognized retired-id receipt/);
    assert.throws(
      () => generator.readAssignments('<!-- queue-from-ledger:v1 phase=Q9 request=R5 activeGates=1 -->\n<!-- queue-from-ledger:v1 phase=Q10 request=R5 activeGates=1 -->\n'),
      /appears twice/
    );
  });

  check('the index declaration is idempotent and changes nothing outside the index block', () => {
    const declaration = generator.declareInRootIndex({ rootFile: QUEUE_ROOT_FILE, apply: false });
    assert.equal(declaration.changed, false, 'the package is already declared; a second declaration must be a no-op');
    assert.equal(declaration.applied, false);
  });

  /* ==========================================================================
   * AN EMPTY RECORD IS THE NORMAL STATE OF A NEW INSTALL.
   *
   * MEASURED 2026-08-12, on the ledger the owner had just reset to zero:
   *   node tools/queue-from-ledger.js --check  ->  exit 4, 72 ms
   *   "contains no requests; refusing to project an empty queue from it."
   * The first command a new user could ever give this tool refused to run.
   *
   * Everything below runs against isolated fixture files, never this repo's
   * queue, so it holds on any machine and writes nothing.
   * ======================================================================== */
  const emptyLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfl-empty-'));
  const fixtureLedgerFile = path.join(emptyLedgerDir, 'ledger.json');
  const fixtureArchiveFile = path.join(emptyLedgerDir, 'archive.json');
  const fixtureStoreFile = path.join(emptyLedgerDir, 'scope-store.json');
  const writeFixtureLedger = requests => fs.writeFileSync(fixtureLedgerFile,
    JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2026-08-12', requests }, null, 2), 'utf8');
  const fixtureOptions = extra => ({
    ledgerFile: fixtureLedgerFile,
    archiveFile: fixtureArchiveFile,
    scopeStoreFile: fixtureStoreFile,
    highWaterMark: 1,
    ...extra
  });

  let emptyBuild;
  let retiringBuild;
  let reinstatedBuild;
  let authorizedBuild;
  let malformedError = null;
  try {
    writeFixtureLedger([]);
    emptyBuild = await generator.buildSlice(fixtureOptions({ sliceMarkdown: null }));
    // A slice that already carried a phase, now projected from an empty ledger.
    const priorSlice = '<!-- queue-from-ledger:v1 phase=Q7 request=R700 activeGates=1 -->\n';
    retiringBuild = await generator.buildSlice(fixtureOptions({ sliceMarkdown: priorSlice }));
    writeFixtureLedger([{ id: 'R700', status: 'open',
      gates: [{ instruction: 'the request came back', met: false, evidence: '' }] }]);
    reinstatedBuild = await generator.buildSlice(fixtureOptions({
      sliceMarkdown: retiringBuild.markdown
    }));
    writeFixtureLedger([
      { id: 'R700', status: 'done', provenance: {
        class: 'owner-stated', recordedBy: 'fixture-recorder', source: 'fixture owner turn 2026-01-01'
      }, verbatim: 'go ahead',
        gates: [
          { instruction: 'rewrite the launch copy', met: true, evidence: 'commit 0000000' },
          { instruction: 'a lane may rewrite the launch copy without a further approval round',
            met: true, evidence: 'owner turn', clauseKind: 'grant',
            authorization: { permits: 'rewriting the launch copy without a further approval round' } }
        ] },
      { id: 'R701', status: 'open', gates: [{ instruction: 'still to do', met: false, evidence: '' }] },
      { id: 'R702', status: 'open', gates: [
        { instruction: 'first numbered gate', met: false, evidence: '' },
        { instruction: 'second numbered gate', met: false, evidence: '' }
      ] }
    ]);
    authorizedBuild = await generator.buildSlice(fixtureOptions({ sliceMarkdown: null }));
    fs.writeFileSync(fixtureLedgerFile, '{"requests": [', 'utf8');
    try { await generator.buildSlice(fixtureOptions({ sliceMarkdown: null })); }
    catch (error) { malformedError = error; }
  } finally {
    fs.rmSync(emptyLedgerDir, { recursive: true, force: true });
  }

  check('a ledger with no requests projects an empty slice instead of refusing', () => {
    assert.equal(emptyBuild.projection.entries.length, 0);
    assert.equal(emptyBuild.projection.gateCount, 0);
    assert.match(emptyBuild.markdown, /## No queued owner-directive work/,
      'the empty slice must say in words that it is empty, not just stop after the header');
    assert.match(emptyBuild.markdown, /the normal state of a new install/);
  });

  check('an unreadable ledger is still a hard failure: absent and malformed are different facts', () => {
    assert.ok(malformedError, 'a truncated ledger must not project an empty queue');
    assert.equal(malformedError.exitCode, 4);
  });

  check('emptying the ledger retires phase ids into receipts; it never silently drops them', () => {
    assert.equal(retiringBuild.projection.entries.length, 0);
    assert.deepEqual([...retiringBuild.projection.retired.entries()], [['R700', 'Q7']]);
    assert.match(retiringBuild.markdown, /- \*\*Q7 — R700:\*\* retired/);
  });

  check('a request that becomes active again gets its own id back, never a second one', () => {
    assert.deepEqual(reinstatedBuild.projection.entries.map(entry => [entry.requestId, entry.phaseId]),
      [['R700', 'Q7']]);
    assert.equal(reinstatedBuild.projection.retired.size, 0);
  });

  /* A PERMISSION IS NOT QUEUED WORK, AND MUST NOT VANISH WITH IT.
   * From the 2026-08-12 incident: two lanes stopped work over a change the
   * owner had approved. R700 below is `done` with every gate met, so it has no
   * phase at all -- and its grant must still be on the page a builder reads. */
  check('the slice publishes authorizations even for requests that have no phase', () => {
    assert.equal(authorizedBuild.projection.entries.length, 2, 'only R701 and R702 have active gates');
    assert.equal(authorizedBuild.projection.entries[0].requestId, 'R701');
    assert.match(authorizedBuild.markdown, /## Authorizations on file/);
    assert.match(authorizedBuild.markdown,
      /R700#2 AUTHORIZED: rewriting the launch copy without a further approval round \[owner-stated\]/);
  });

  check('a non-empty fixture exercises every per-phase projection assertion', () => {
    const fixturePhases = parseGeneratedSlice(authorizedBuild.markdown);
    assert.equal(fixturePhases.length, 2,
      'the fixture must stay non-empty so the per-phase assertions cannot pass vacuously');
    assert.deepEqual(fixturePhases.map(phase => phase.requestId), ['R701', 'R702'],
      'generated phases must be ordered by R-id');

    const expectedGates = new Map([
      ['R701', ['still to do']],
      ['R702', ['first numbered gate', 'second numbered gate']]
    ]);
    for (const phase of fixturePhases) {
      const instructions = expectedGates.get(phase.requestId);
      assert.ok(instructions, `${phase.requestId} is not an active request in the fixture`);
      assert.equal(phase.declaredGateCount, instructions.length,
        `${phase.phaseId} declares the wrong fixture gate count`);
      assert.equal(phase.criteria.length, instructions.length,
        `${phase.phaseId} omits a fixture acceptance criterion`);
      phase.criteria.forEach((criterion, offset) => {
        assert.equal(criterion.index, offset + 1,
          `${phase.phaseId} criterion ${offset + 1} is misnumbered`);
        assert.equal(criterion.text, instructions[offset],
          `${phase.phaseId} changed fixture gate text`);
      });
      assert.equal(phase.authority,
        `${phase.requestId}; directiveId: owner-request-ledger:${phase.requestId}`,
        `${phase.phaseId} does not cite its own fixture request`);
      assert.ok(phase.heading, `${phase.phaseId} has no fixture heading`);
      assert.equal(phase.heading[1], phase.phaseId,
        `${phase.phaseId}'s fixture marker and heading disagree`);
    }
  });

  check('an empty ledger still publishes the authorizations section, saying none are declared', () => {
    assert.match(emptyBuild.markdown, /## Authorizations on file/);
    assert.match(emptyBuild.markdown, /None on file\. Every clause in the ledger is declared work\./);
  });

  check('a generated authorization line never becomes a phantom citation', () => {
    const result = provenance.auditQueueProvenance({
      sources: [{ file: generator.SLICE_RELATIVE_PATH, markdown: authorizedBuild.markdown }],
      ledger: { requests: [{ id: 'R700' }, { id: 'R701' }, { id: 'R702' }] }
    });
    assert.deepEqual(result.findings.filter(finding => finding.severity === 'error'), [],
      'the authorizations block asserts authority the ledger cannot back');
  });

  console.log(`\nqueue-from-ledger: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failing: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error(`queue-from-ledger: suite could not run: ${error.stack || error.message}`);
  process.exitCode = 1;
});
