// EXECUTABLE CHANGE
// testcanfail-tests-ledger-gate-writer-js
//
// Mutation report: replacing both production Buffer.byteLength(..., 'utf8')
// calls with String#length left the original ASCII-only assertion GREEN:
// "ledger gate writer: 12 checks passed".  The strengthened multibyte case
// failed under that mutation with:
// "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n60 !== 64".
// Restoring src/lib/ledger-gate-writer.js byte-for-byte made the final run GREEN:
// "ledger gate writer: 12 checks passed".
//
// Shape census: empty loop/forEach: NOT-FOUND; exit-status/truthy process result:
// NOT-FOUND; swallowed failure via try/catch or optional chain: NOT-FOUND; mock
// of the subject: NOT-FOUND; skip/platform precondition guard: NOT-FOUND;
// expected value computed by the subject's own algorithm: FOUND and fixed below.
// Preconditions not met: NONE.

'use strict';

// Compatibility tests for the retired legacy gate-transition fixture.  The production owner
// ledger is never a test target: every mutation below happens in a fresh
// temporary directory and the original fixture bytes are checked on refusals.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LedgerGateWriterError,
  markGateMet,
  normalizeInput,
  validateGateShape,
  validateRequestGateState,
  verifyPersistedWrite
} = require('./fixtures/legacy-ledger-gate-writer.cjs');
const { acquireLedgerLock } = require('../tools/owner-capture');
const { assertGatesMet } = require('../src/lib/egress-preflight');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

check('the retired fixture requires an explicit path before any ledger access', () => {
  assert.throws(() => normalizeInput({ requestId: 'R90', gateIndex: 0, evidence: 'fixture', actor: 'fixture' }),
    { code: 'LEDGER_GATE_FILE_INVALID' });
});

function fixtureLedger() {
  return {
    $comment: ['TEST FIXTURE -- never the production owner ledger.'],
    schemaVersion: 1,
    revision: 10,
    sessionLabel: 'ledger-gate-writer test fixture',
    updatedAt: '2026-01-01',
    maintainedBy: 'test-harness',
    statusVocabulary: {
      done: 'Delivered and independently verified.',
      partial: 'Substantially delivered with a stated shortfall.',
      'in-progress': 'Actively being worked.',
      open: 'Accepted, not started.',
      'blocked-external': 'Cannot proceed without owner action.',
      'not-possible-as-asked': 'The literal request cannot be satisfied.'
    },
    requests: [
      {
        id: 'R90',
        verbatim: '[quoted owner words] verify the artifact',
        request: '(interpretation) verify the artifact',
        status: 'open',
        gates: [{ instruction: 'verify the file is present', met: false, evidence: '' }],
        captureLog: [{ at: '2026-01-01T00:00:00.000Z', actor: 'fixture', mode: 'new', gatesAdded: 1 }],
        controllerNote: 'preserve this field'
      },
      {
        id: 'R91',
        verbatim: 'keep the service running',
        request: '(interpretation) inspect the service',
        status: 'in-progress',
        gates: [{ instruction: 'the service is running', met: false, evidence: '' }]
      },
      {
        id: 'R92',
        verbatim: 'already independently verified',
        request: '(interpretation) retain the result',
        status: 'done',
        gates: [{ instruction: 'the proof exists', met: true, evidence: 'audit.verify: valid' }]
      },
      {
        id: 'R93',
        verbatim: 'malformed fixture state',
        request: '(interpretation) reject stale evidence',
        status: 'open',
        gates: [{ instruction: 'do not trust stale evidence', met: false, evidence: 'stray evidence' }]
      },
      {
        id: 'R94',
        verbatim: 'no gate request',
        request: '(interpretation) no gate',
        status: 'open'
      }
    ]
  };
}

function freshLedger() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-gate-writer-test-'));
  const ledgerFile = path.join(directory, 'OWNER-REQUEST-LEDGER.json');
  fs.writeFileSync(ledgerFile, JSON.stringify(fixtureLedger(), null, 2), 'utf8');
  return { directory, ledgerFile };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    return true;
  });
}

function expectRefusalWithoutWrite(ledgerFile, fn, code) {
  const before = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(fn, code);
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
  assert.equal(fs.existsSync(`${ledgerFile}.bak`), false);
  assert.equal(fs.readdirSync(path.dirname(ledgerFile)).some(name => name.endsWith('.tmp')), false);
}

check('public input normalization emits the specific input, file, and request-id refusals', () => {
  expectCode(() => normalizeInput(null), 'LEDGER_GATE_INPUT_INVALID');
  expectCode(() => normalizeInput([]), 'LEDGER_GATE_INPUT_INVALID');
  expectCode(() => normalizeInput({ ledgerFile: '', requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test' }), 'LEDGER_GATE_FILE_INVALID');
  expectCode(() => normalizeInput({ ledgerFile: 'fixture', requestId: 'not-an-R-number', gateIndex: 0, evidence: 'x', actor: 'test' }), 'LEDGER_GATE_REQUEST_ID_INVALID');
  expectCode(() => normalizeInput({ ledgerFile: 'fixture', requestId: 'R3.0', gateIndex: 0, evidence: 'x', actor: 'test' }), 'LEDGER_GATE_REQUEST_ID_INVALID');
  assert.equal(normalizeInput({ ledgerFile: 'fixture', requestId: 'R3.1', gateIndex: 0, evidence: 'x', actor: 'test' }).requestId, 'R3.1',
    'a refinement filed under a request carries gates like any root');
});

check('malformed JSON and ledger read errors refuse before creating write artifacts', () => {
  const invalid = freshLedger();
  fs.writeFileSync(invalid.ledgerFile, '{not json', 'utf8');
  expectRefusalWithoutWrite(invalid.ledgerFile, () => markGateMet({
    ledgerFile: invalid.ledgerFile, requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test'
  }), 'LEDGER_GATE_LEDGER_INVALID_JSON');

  const unreadablePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-gate-writer-directory-'));
  expectCode(() => markGateMet({
    ledgerFile: unreadablePath, requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test'
  }), 'LEDGER_GATE_LEDGER_READ_FAILED');
  assert.deepEqual(fs.readdirSync(unreadablePath), []);
  assert.equal(fs.existsSync(`${unreadablePath}.bak`), false);
});

check('exported gate validators emit their exact structural refusals without I/O', () => {
  expectCode(() => validateGateShape(null, 'R90', 0), 'LEDGER_GATE_SHAPE_INVALID');
  expectCode(() => validateGateShape({ instruction: '', met: false, evidence: '' }, 'R90', 0), 'LEDGER_GATE_SHAPE_INVALID');
  expectCode(() => validateRequestGateState(null, 'R90', 0), 'LEDGER_GATE_REQUEST_SHAPE_INVALID');
  expectCode(() => validateRequestGateState({
    gates: [{ instruction: 'verify artifact', met: false, evidence: '' }],
    captureLog: 'not-an-array'
  }, 'R90', 0), 'LEDGER_GATE_CAPTURE_LOG_INVALID');
});

check('write verification refuses a byte mismatch without performing a write itself', () => {
  const { ledgerFile } = freshLedger();
  const before = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(() => verifyPersistedWrite(
    ledgerFile, `${before}\n`, 'R90', 0, 'evidence that was never persisted'
  ), 'LEDGER_GATE_WRITE_VERIFY_FAILED');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
  assert.equal(fs.existsSync(`${ledgerFile}.bak`), false);
});

check('normalizeInput rejects fields that could rewrite status or verbatim', () => {
  expectCode(() => normalizeInput({
    requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test', status: 'done'
  }), 'LEDGER_GATE_INPUT_UNKNOWN_FIELD');
  expectCode(() => normalizeInput({
    requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test', verbatim: 'replacement'
  }), 'LEDGER_GATE_INPUT_UNKNOWN_FIELD');
});

check('normalizeInput requires a non-empty bounded evidence and actor', () => {
  expectCode(() => normalizeInput({ ledgerFile: 'fixture', requestId: 'R90', gateIndex: 0, evidence: '', actor: 'test' }), 'LEDGER_GATE_EVIDENCE_REQUIRED');
  expectCode(() => normalizeInput({ ledgerFile: 'fixture', requestId: 'R90', gateIndex: 0, evidence: 'x', actor: '' }), 'LEDGER_GATE_ACTOR_REQUIRED');
  expectCode(() => normalizeInput({ ledgerFile: 'fixture', requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'test', gateIndex: -1 }), 'LEDGER_GATE_INDEX_INVALID');
});

check('markGateMet performs one false-to-true transition and records a capture log', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  const before = readJson(ledgerFile);
  const result = markGateMet({
    ledgerFile,
    requestId: 'R90',
    gateIndex: 0,
    evidence: 'post-change: Get-Process -Name fixture -> ProcessName fixture, Id 1234',
    actor: 'independent-verifier',
    timestamp: '2026-08-01T10:00:00.000Z'
  });
  const afterRaw = fs.readFileSync(ledgerFile, 'utf8');
  const after = readJson(ledgerFile);
  const beforeEntry = before.requests.find(entry => entry.id === 'R90');
  const afterEntry = after.requests.find(entry => entry.id === 'R90');

  assert.equal(result.ok, true);
  assert.equal(result.revision, 11);
  assert.equal(after.revision, 11);
  assert.equal(afterEntry.gates[0].met, true);
  assert.equal(afterEntry.gates[0].evidence, 'post-change: Get-Process -Name fixture -> ProcessName fixture, Id 1234');
  assert.equal(afterEntry.gates[0].instruction, beforeEntry.gates[0].instruction);
  assert.equal(afterEntry.verbatim, beforeEntry.verbatim);
  assert.equal(afterEntry.request, beforeEntry.request);
  assert.equal(afterEntry.status, beforeEntry.status);
  assert.equal(afterEntry.controllerNote, beforeEntry.controllerNote);
  assert.deepEqual(afterEntry.captureLog.slice(0, -1), beforeEntry.captureLog);
  assert.deepEqual(afterEntry.captureLog.at(-1), {
    at: '2026-08-01T10:00:00.000Z',
    actor: 'independent-verifier',
    mode: 'gate-met',
    gateIndex: 0,
    evidenceLength: Buffer.byteLength(afterEntry.gates[0].evidence, 'utf8')
  });
  assert.equal(fs.readFileSync(`${ledgerFile}.bak`, 'utf8'), beforeRaw);
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), afterRaw);
  assert.equal(fs.readdirSync(path.dirname(ledgerFile)).filter(name => name.endsWith('.tmp')).length, 0);
  assert.doesNotThrow(() => assertGatesMet('R90', ledgerFile));
});

check('runtime-word gates reject evidence without post-change destination output', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(() => markGateMet({
    ledgerFile, requestId: 'R91', gateIndex: 0,
    evidence: 'the service is running because the edit succeeded', actor: 'verifier'
  }), 'OWNER_CAPTURE_RUNTIME_EVIDENCE_REQUIRED');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw);
  assert.equal(fs.existsSync(`${ledgerFile}.bak`), false);
});

check('runtime-word gates accept captured destination-query output', () => {
  const { ledgerFile } = freshLedger();
  markGateMet({
    ledgerFile, requestId: 'R91', gateIndex: 0,
    evidence: 'post-change: Get-Process -Name fixture -> ProcessName fixture, Id 1234, CPU 0.1',
    actor: 'verifier'
  });
  const entry = readJson(ledgerFile).requests.find(candidate => candidate.id === 'R91');
  assert.equal(entry.gates[0].met, true);
  assert.doesNotThrow(() => assertGatesMet('R91', ledgerFile));
});

check('already-met gates are first-write-wins and cannot be overwritten', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(() => markGateMet({
    ledgerFile, requestId: 'R92', gateIndex: 0, evidence: 'replacement', actor: 'verifier'
  }), 'LEDGER_GATE_ALREADY_MET');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw);
});

check('unmet gates with pre-existing evidence are rejected instead of silently certified', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(() => markGateMet({
    ledgerFile, requestId: 'R93', gateIndex: 0, evidence: 'new evidence', actor: 'verifier'
  }), 'LEDGER_GATE_STATE_INVALID');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw);
});

check('missing requests, gates, and malformed indexes fail closed', () => {
  const { ledgerFile } = freshLedger();
  expectCode(() => markGateMet({ ledgerFile, requestId: 'R99', gateIndex: 0, evidence: 'x', actor: 'verifier' }), 'LEDGER_GATE_REQUEST_NOT_FOUND');
  expectCode(() => markGateMet({ ledgerFile, requestId: 'R94', gateIndex: 0, evidence: 'x', actor: 'verifier' }), 'LEDGER_GATE_REQUEST_HAS_NO_GATES');
  expectCode(() => markGateMet({ ledgerFile, requestId: 'R90', gateIndex: 2, evidence: 'x', actor: 'verifier' }), 'LEDGER_GATE_INDEX_NOT_FOUND');
});

check('a held ledger lock produces a typed refusal and leaves bytes untouched', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  const held = acquireLedgerLock(ledgerFile);
  try {
    expectCode(() => markGateMet({ ledgerFile, requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'verifier' }), 'LEDGER_GATE_LOCKED');
  } finally {
    held.release();
  }
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw);
});

check('the writer can verify a gate on a done request without changing its status', () => {
  const { ledgerFile } = freshLedger();
  markGateMet({
    ledgerFile, requestId: 'R90', gateIndex: 0,
    evidence: 'audit.verify: valid sequence 123 signaturesValid true', actor: 'verifier'
  });
  const entry = readJson(ledgerFile).requests.find(candidate => candidate.id === 'R90');
  assert.equal(entry.status, 'open');

  const doneFixture = freshLedger();
  const done = readJson(doneFixture.ledgerFile);
  const doneEntry = done.requests.find(candidate => candidate.id === 'R90');
  doneEntry.status = 'done';
  fs.writeFileSync(doneFixture.ledgerFile, JSON.stringify(done, null, 2), 'utf8');
  markGateMet({
    ledgerFile: doneFixture.ledgerFile, requestId: 'R90', gateIndex: 0,
    evidence: 'audit.verify: valid sequence 124 signaturesValid true', actor: 'verifier'
  });
  assert.equal(readJson(doneFixture.ledgerFile).requests.find(candidate => candidate.id === 'R90').status, 'done');
});

check('bad timestamps and missing ledger files fail before any write', () => {
  const { ledgerFile } = freshLedger();
  const beforeRaw = fs.readFileSync(ledgerFile, 'utf8');
  expectCode(() => markGateMet({
    ledgerFile, requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'verifier', timestamp: 'tomorrow'
  }), 'LEDGER_GATE_TIMESTAMP_INVALID');
  expectCode(() => markGateMet({
    ledgerFile: `${ledgerFile}.missing`, requestId: 'R90', gateIndex: 0, evidence: 'x', actor: 'verifier'
  }), 'LEDGER_GATE_LEDGER_NOT_FOUND');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), beforeRaw);
});

check('the writer exports a stable typed error and does not expose evidence in its result', () => {
  assert.equal(typeof LedgerGateWriterError, 'function');
  const { ledgerFile } = freshLedger();
  // Multibyte text discriminates byte length from JavaScript string length.
  const evidence = 'post-change: Get-Process -> ProcessName fixture, Id 4321 — ✓';
  const result = markGateMet({ ledgerFile, requestId: 'R90', gateIndex: 0, evidence, actor: 'verifier' });
  assert.equal(result.evidenceLength, 64);
  const entry = readJson(ledgerFile).requests.find(candidate => candidate.id === 'R90');
  assert.equal(entry.captureLog.at(-1).evidenceLength, 64);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'evidence'), false);
});

process.stdout.write(`ledger gate writer: ${checks} checks passed\n`);
