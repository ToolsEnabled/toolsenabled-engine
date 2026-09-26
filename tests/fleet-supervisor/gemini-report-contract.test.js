// Mutation check:
// Replaced the module's claim-mismatch guard condition with
// `false && lines[5].slice(CLAIM_PREFIX.length) !== anchor.claim`.
// The edit landed, and this isolated test went red with exit code 1.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const reportContract = require('../../src/lib/fleet-supervisor/gemini-report-contract');

const {
  ANCHOR_LINE,
  CLAIM_PREFIX,
  LEGACY_VERSION,
  ROLE,
  SAFE_SOURCE_PATH,
  SAFE_TEST_COMMAND,
  VERSION,
  canonicalCommands,
  canonicalEvidence,
  canonicalSources,
  loadDefinition,
  normalizeLaneContract,
  sourceLogicalLine,
  validateLaneInputs,
  validateReport
} = reportContract;

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

// Refusals are validation-only: none may acquire the side effects that a
// successful supervisor launch has.  The injected filesystem records writes,
// while the process hooks guard both synchronous and asynchronous launches.
let writes = 0;
let spawns = 0;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };
const writeMethods = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'copyFileSync']);
const observingFs = new Proxy(fs, {
  get(target, property) {
    if (writeMethods.has(property)) return (...args) => { writes += 1; return target[property](...args); };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  }
});
function refusal(operation, code, behavior = {}) {
  const writesBefore = writes;
  const spawnsBefore = spawns;
  const result = operation();
  assert.deepEqual(result, { ok: false, code, ...behavior });
  assert.equal(writes, writesBefore, `${code} must not write`);
  assert.equal(spawns, spawnsBefore, `${code} must not spawn`);
  return result;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-report-contract-'));
try {
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'tests'));
  const claim = 'module.exports = "evidence";';
  fs.writeFileSync(path.join(root, 'src', 'proof.js'), `${claim}\r\nsecond line\r\n`);
  fs.writeFileSync(path.join(root, 'tests', 'proof.test.js'), "'use strict';\n");
  const digest = sha256(claim);

  assert.equal(VERSION, 'GeminiReport/v2');
  assert.equal(LEGACY_VERSION, 'GeminiReport/v1');
  assert.equal(ROLE, 'gemini-report-lane');
  assert.equal(CLAIM_PREFIX, 'CLAIM: ');
  assert.equal(SAFE_SOURCE_PATH.test('src/proof.js'), true);
  assert.equal(SAFE_SOURCE_PATH.test('../proof.js'), false);
  assert.equal(SAFE_TEST_COMMAND.test('node tests/proof.test.js'), true);
  assert.equal(SAFE_TEST_COMMAND.test('npm test'), false);
  assert.deepEqual(ANCHOR_LINE.exec(`EVIDENCE-ANCHOR: source=src/proof.js; line=1; sha256=${digest}`).slice(1),
    ['src/proof.js', '1', digest]);

  assert.deepEqual(canonicalSources([' src/proof.js ']), ['src/proof.js']);
  assert.equal(canonicalSources(['src/proof.js', 'src/proof.js']), null);
  assert.deepEqual(canonicalCommands([' node tests/proof.test.js ']), ['node tests/proof.test.js']);
  assert.equal(canonicalCommands(['node --test tests/proof.test.js']), null);
  assert.deepEqual(canonicalEvidence([{ source: 'src/proof.js', line: 1, sha256: digest }], ['src/proof.js']),
    [{ source: 'src/proof.js', line: 1, sha256: digest }]);
  assert.equal(canonicalEvidence([{ source: 'src/other.js', line: 1, sha256: digest }], ['src/proof.js']), null);

  const declaration = {
    version: VERSION,
    role: ROLE,
    sources: ['src/proof.js'],
    commands: ['node tests/proof.test.js'],
    evidence: [{ source: 'src/proof.js', line: 1, sha256: digest }]
  };
  refusal(() => normalizeLaneContract(null), 'REPORT_CONTRACT_SHAPE_INVALID');
  refusal(() => normalizeLaneContract({ ...declaration, sources: [] }), 'REPORT_CONTRACT_SOURCES_INVALID');
  refusal(() => normalizeLaneContract({ ...declaration, evidence: [] }), 'REPORT_CONTRACT_EVIDENCE_INVALID');
  refusal(() => validateLaneInputs('', declaration, { fsImpl: observingFs }), 'REPORT_CONTRACT_REPO_ROOT_INVALID');
  assert.equal(normalizeLaneContract({ ...declaration, role: 'builder' }).code,
    'REPORT_CONTRACT_ROLE_INVALID');
  assert.deepEqual(sourceLogicalLine(path.join(root, 'src', 'proof.js'), 99),
    { ok: false, code: 'REPORT_CONTRACT_EVIDENCE_LINE_MISMATCH' });
  assert.deepEqual(sourceLogicalLine(path.join(root, 'src', 'proof.js'), 1),
    { ok: true, claim, sha256: digest });

  const unboundText = [
    `REPORT-CONTRACT: ${VERSION}`,
    `ROLE: ${ROLE}`,
    'SOURCES: src/proof.js',
    'EVIDENCE-COMMAND: node tests/proof.test.js',
    `EVIDENCE-ANCHOR: source=src/proof.js; line=1; sha256=${digest}`,
    `CLAIM: ${claim}`
  ].join('\n');
  assert.equal(validateReport(unboundText, declaration).code, 'REPORT_CONTRACT_V2_EVIDENCE_UNBOUND');

  const bound = validateLaneInputs(root, declaration);
  assert.equal(bound.ok, true);
  assert.equal(Object.isFrozen(bound), true);
  fs.writeFileSync(path.join(root, 'src', 'proof.js'), 'changed after binding\n');
  assert.deepEqual(validateReport(unboundText, bound), {
    ok: true,
    version: VERSION,
    role: ROLE,
    sources: ['src/proof.js'],
    command: 'node tests/proof.test.js',
    claimCount: 1,
    semanticVerified: true
  });
  fs.writeFileSync(path.join(root, 'src', 'proof.js'), `${claim}\r\nsecond line\r\n`);

  refusal(() => validateLaneInputs(root, {
    ...declaration,
    commands: ['node tests/missing.test.js']
  }, { fsImpl: observingFs }), 'REPORT_CONTRACT_COMMAND_TARGET_NOT_FOUND', {
    command: 'node tests/missing.test.js'
  });

  const failedReadFs = { ...observingFs, readFileSync() { throw new Error('fixture read failure'); } };
  refusal(() => sourceLogicalLine(path.join(root, 'src', 'proof.js'), 1, { fsImpl: failedReadFs }),
    'REPORT_CONTRACT_EVIDENCE_SOURCE_READ_FAILED', {
      message: 'Could not read the evidence source; this result does NOT claim that the source is absent.'
    });
  const invalidUtf8Fs = { ...observingFs, readFileSync() { return Buffer.from([0xc3, 0x28]); } };
  refusal(() => sourceLogicalLine('/virtual/invalid.js', 1, { fsImpl: invalidUtf8Fs }),
    'REPORT_CONTRACT_EVIDENCE_SOURCE_ENCODING_INVALID');
  const emptyLineFs = { ...observingFs, readFileSync() { return Buffer.from('\nnext'); } };
  refusal(() => sourceLogicalLine('/virtual/empty.js', 1, { fsImpl: emptyLineFs }),
    'REPORT_CONTRACT_EVIDENCE_LINE_INVALID');

  let pathErrorCode = 'EBUSY';
  const retryingFs = {
    ...fs,
    realpathSync(value) {
      if (pathErrorCode && value === path.join(root, 'src', 'proof.js')) {
        const error = new Error('filesystem busy');
        error.code = pathErrorCode;
        throw error;
      }
      return fs.realpathSync(value);
    }
  };
  for (pathErrorCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const indeterminate = validateLaneInputs(root, declaration, { fsImpl: retryingFs });
    assert.equal(indeterminate.code, 'REPORT_CONTRACT_PATH_CHECK_INDETERMINATE');
    assert.match(indeterminate.message, /does NOT claim.*absent/);
  }
  pathErrorCode = null;
  assert.equal(validateLaneInputs(root, declaration, { fsImpl: retryingFs }).ok, true,
    'an indeterminate path check is not cached or latched');
  assert.equal(validateLaneInputs(root, { ...declaration, sources: ['src/missing.js'],
    evidence: [{ source: 'src/missing.js', line: 1, sha256: digest }] }).code,
    'REPORT_CONTRACT_SOURCE_NOT_FOUND', 'ENOENT retains the definite absent result');
  assert.equal(validateReport(unboundText.replace(claim, 'fabricated claim'), bound).code,
    'REPORT_CONTRACT_CLAIM_EVIDENCE_MISMATCH');
  assert.equal(validateLaneInputs(root, { ...declaration, evidence: [{ ...declaration.evidence[0], sha256: '0'.repeat(64) }] }).code,
    'REPORT_CONTRACT_EVIDENCE_HASH_MISMATCH');

  const legacy = validateLaneInputs(root, {
    version: LEGACY_VERSION,
    role: ROLE,
    sources: ['src/proof.js'],
    commands: ['node tests/proof.test.js']
  });
  const legacyText = [
    `REPORT-CONTRACT: ${LEGACY_VERSION}`,
    `ROLE: ${ROLE}`,
    'SOURCES: src/proof.js',
    'EVIDENCE-COMMAND: node tests/proof.test.js',
    'CLAIM: historical statement [source: src/proof.js]'
  ].join('\n');
  assert.equal(validateReport(legacyText, legacy).semanticVerified, false);
  refusal(() => validateReport('REPORT-CONTRACT: GeminiReport/v1', legacy), 'REPORT_CONTRACT_LINES_MISSING');
  refusal(() => validateReport(legacyText.replace('SOURCES: src/proof.js', 'SOURCES: src/other.js'), legacy),
    'REPORT_CONTRACT_SOURCES_MISMATCH');
  refusal(() => validateReport(legacyText.replace('EVIDENCE-COMMAND:', 'COMMAND:'), legacy),
    'REPORT_CONTRACT_COMMAND_MISSING');

  refusal(() => validateReport(unboundText.replace(
    `EVIDENCE-ANCHOR: source=src/proof.js; line=1; sha256=${digest}`,
    'EVIDENCE-ANCHOR: malformed'), bound), 'REPORT_CONTRACT_EVIDENCE_ANCHOR_INVALID');

  const document = '`GeminiReport/v2`\nROLE: gemini-report-lane\nEVIDENCE-ANCHOR: source=path/one.js; line=1; sha256=<sha256-of-logical-source-line>\n';
  assert.deepEqual(loadDefinition({
    documentPath: '/virtual/contract.md',
    approvedSha256: sha256(document),
    fsImpl: { readFileSync: () => document }
  }), {
    version: VERSION,
    role: ROLE,
    documentPath: '/virtual/contract.md',
    sha256: sha256(document)
  });
  assert.throws(() => loadDefinition({
    documentPath: '/virtual/contract.md',
    approvedSha256: '0'.repeat(64),
    fsImpl: { readFileSync: () => document }
  }), error => error.code === 'GEMINI_REPORT_CONTRACT_DOCUMENT_DRIFT');
  const unavailableWrites = writes;
  const unavailableSpawns = spawns;
  assert.throws(() => loadDefinition({
    documentPath: '/virtual/missing.md',
    fsImpl: { readFileSync() { throw new Error('missing fixture'); } }
  }), error => error.message === 'GEMINI_REPORT_CONTRACT_DOCUMENT_UNAVAILABLE');
  assert.equal(writes, unavailableWrites, 'document-unavailable refusal must not write');
  assert.equal(spawns, unavailableSpawns, 'document-unavailable refusal must not spawn');

  const invalidDocument = 'not the report contract';
  const invalidWrites = writes;
  const invalidSpawns = spawns;
  assert.throws(() => loadDefinition({
    documentPath: '/virtual/invalid.md',
    approvedSha256: sha256(invalidDocument),
    fsImpl: { readFileSync: () => invalidDocument }
  }), error => error.message === 'GEMINI_REPORT_CONTRACT_DOCUMENT_INVALID');
  assert.equal(writes, invalidWrites, 'document-invalid refusal must not write');
  assert.equal(spawns, invalidSpawns, 'document-invalid refusal must not spawn');

  console.log('gemini-report-contract behavior tests passed');
} finally {
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  fs.rmSync(root, { recursive: true, force: true });
}
