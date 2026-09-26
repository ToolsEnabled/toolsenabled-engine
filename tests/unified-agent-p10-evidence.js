// EXECUTABLE CHANGE
/*

Can-fail audit report (testcanfail-tests-unified-agent-p10-evidence-js):
- Strengthened the --help process assertions to require the subject's own usage
  banner and verification description, rather than accepting any empty output
  from a process that happened to exit zero. Mutation: made usage() return an
  empty string. RED output could not be collected because this environment's
  Node.js v20.20.2 cannot load node:sqlite, before the mutation is reached.
- Strengthened the invalid-argument process assertions to require the subject's
  own generic diagnostic and usage banner, without allowing the rejected
  argument canary. Mutation: removed the stderr writes in parse-error handling.
  RED output could not be collected for the same node:sqlite precondition.
- Strengthened the tampered-store CLI assertions to parse its JSON output and
  require the expected protected-object hash finding. Mutation: replaced the
  CLI's JSON result with an empty object while preserving exit status 2. RED
  output could not be collected for the same node:sqlite precondition.
- NOT-FOUND: vacuous assertions over possibly empty collections. Both assertion
  loops use non-empty literals; publicRecords.every is preceded by length === 5.
- NOT-FOUND: bare non-zero/truthy process assertions after these strengthenings.
  Successful subprocesses also have their output parsed or otherwise checked.
- NOT-FOUND: try/catch or optional chaining that swallows the tested failure.
  The junction catch only names unsupported symlink permissions and rethrows all
  other errors; cleanup catches do not enclose the assertions under test.
- NOT-FOUND: mocks of the behavior under test.
- NOT-FOUND: a skip or precondition guard that turns the whole file into a no-op.
- NOT-FOUND: expected values computed by the same implementation under test.
  Fixture hashes use node:crypto independently; source-policy comparisons check
  generated artifacts against loaded contract inputs rather than self-results.
- NAMED PRECONDITION: node:sqlite is unavailable in Node.js v20.20.2. The
  baseline and restored-source command both stop at module load with
  ERR_UNKNOWN_BUILTIN_MODULE; npm installation of Node 22 is blocked by E403.
- Source restoration: no product file was edited, so product bytes are unchanged.
*/
'use strict';

// Run the SQLite-heavy body in a child, then remove its disposable store only
// after that process has exited. Node 22's Windows SQLite binding can retain a
// native file handle until process teardown even after every DatabaseSync was
// explicitly closed; deleting from that same process therefore reports EBUSY
// and masks a completed contract run. This wrapper tests the same body and
// gives cleanup the real lifetime boundary production also gets at shutdown.
const P10_WORKER_ENV = 'TOOLSENABLED_TEST_P10_WORKER';
const P10_ROOT_ENV = 'TOOLSENABLED_TEST_P10_ROOT';
if (process.env[P10_WORKER_ENV] !== '1') {
  const wrapperFs = require('node:fs');
  const wrapperOs = require('node:os');
  const wrapperPath = require('node:path');
  const { spawnSync: spawnWorker } = require('node:child_process');
  const workerRoot = wrapperFs.mkdtempSync(wrapperPath.join(wrapperOs.tmpdir(), 'toolsenabled-p10-'));
  let worker;
  try {
    worker = spawnWorker(process.execPath, [__filename], {
      cwd: wrapperPath.resolve(__dirname, '..'),
      env: { ...process.env, [P10_WORKER_ENV]: '1', [P10_ROOT_ENV]: workerRoot },
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 120_000
    });
    if (worker.stdout) process.stdout.write(worker.stdout);
    if (worker.stderr) process.stderr.write(worker.stderr);
  } finally {
    const resolved = wrapperPath.resolve(workerRoot);
    if (resolved.startsWith(wrapperPath.resolve(wrapperOs.tmpdir()) + wrapperPath.sep)
        && wrapperPath.basename(resolved).startsWith('toolsenabled-p10-')) {
      wrapperFs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  if (worker && worker.error) throw worker.error;
  process.exit(worker && Number.isInteger(worker.status) ? worker.status : 1);
}

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  APPLICATION_ID,
  DEFAULT_DB_FILE,
  DEFAULT_ROOT,
  EvidenceStore,
  EvidenceStoreError,
  POLICY,
  SCHEMA_VERSION,
  objectRelativePath,
  recordHashPayload,
  verifyEvidenceStore
} = require('../src/lib/evidence-store');
const identity = require('../schemas/generated/platform.identity');
const redaction = require('../schemas/generated/platform.redaction');
const { OUTPUTS: PLATFORM_OUTPUTS } = require('../tools/generate-platform-contracts');
const { OUTPUTS, loadPackage } = require('../tools/generate-evidence-store');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformContractFixture, machineWidePython } = require('./lib/platform-contract-fixture');

const ROOT = path.resolve(__dirname, '..');
const GENERATED_ROOT = path.join(ROOT, 'schemas', 'generated');
const PYTHON = machineWidePython();
const contractFixture = createPlatformContractFixture();
const suppliedTemporaryRoot = process.env[P10_ROOT_ENV];
const temporaryRoot = suppliedTemporaryRoot
  ? path.resolve(suppliedTemporaryRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-p10-'));
if (suppliedTemporaryRoot) {
  assert.ok(temporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)
    && path.basename(temporaryRoot).startsWith('toolsenabled-p10-')
    && fs.statSync(temporaryRoot).isDirectory(),
  'the P10 worker root must be the disposable directory created by its parent');
}
const dbFile = path.join(temporaryRoot, 'evidence.sqlite3');
let nowMs = Date.parse('2026-07-26T12:00:00.000Z');

function access(taskId, scopeId, options = {}) {
  return Object.freeze({
    principal: options.principal || taskId,
    taskId,
    scopeId,
    protected: options.protected === true,
    delete: options.delete === true,
    maintenance: options.maintenance === true
  });
}

function authorize({ operation, access: grant, binding }) {
  if (!grant || typeof grant !== 'object') return false;
  if (operation === 'retention' || operation === 'maintenance') return grant.maintenance === true;
  if (grant.taskId !== binding.taskId || grant.scopeId !== binding.scopeId) return false;
  if (operation === 'read-protected') return grant.protected === true;
  if (operation === 'delete') return grant.delete === true;
  return ['write', 'read-public', 'list-public', 'verify'].includes(operation);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicExport(summary, format, content) {
  return redaction.prepareEgress('evidence-export', { summary, format, content });
}

function recordFromDatabaseRow(row) {
  return {
    schemaVersion: POLICY.policyVersion,
    evidenceId: row.evidence_id,
    taskId: row.task_id,
    scopeId: row.scope_id,
    toolRequestId: row.tool_request_id,
    kind: row.kind,
    mediaType: row.media_type,
    summary: row.summary,
    protectedContent: {
      sha256: row.protected_sha256,
      sizeBytes: row.protected_size_bytes,
      format: row.protected_format
    },
    publicContent: {
      sha256: row.public_sha256,
      sizeBytes: row.public_size_bytes,
      format: row.public_format
    },
    provenance: JSON.parse(row.provenance_json),
    sourceVersion: row.source_version,
    locator: JSON.parse(row.locator_json),
    redactionReport: JSON.parse(row.redaction_report_json),
    retentionClass: row.retention_class,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    recordHash: row.record_hash
  };
}

function provenance(labels = ['verified-local-state']) {
  return { schemaVersion: '1.0.0', labels, sources: [] };
}

function write(store, grant, overrides = {}) {
  return store.writeEvidence({
    access: grant,
    evidenceId: overrides.evidenceId,
    taskId: grant.taskId,
    scopeId: grant.scopeId,
    toolRequestId: overrides.toolRequestId || identity.newId('event'),
    kind: overrides.kind || 'fact',
    mediaType: overrides.mediaType || 'text/plain',
    provenance: overrides.provenance || provenance(),
    sourceVersion: overrides.sourceVersion || 'fixture-v1',
    locator: overrides.locator || { kind: 'test', value: 'tests/unified-agent-p10-evidence.js' },
    publicExport: overrides.publicExport || publicExport('Safe fixture summary.', 'text', 'Safe public fixture body.'),
    protectedContent: overrides.protectedContent || { type: 'text', text: 'Protected fixture body.' },
    retentionClass: overrides.retentionClass || 'durable'
  });
}

function waitForFile(filename, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(filename) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10);
  assert.ok(fs.existsSync(filename), `timed out waiting for ${path.basename(filename)}`);
}

function waitForProcessExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  // A synchronous PID poll prevents Node from reaping its POSIX child. Wait
  // for this retained child's exit event so teardown can actually complete.
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      child.removeListener('error', finish);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const timer = setTimeout(() => finish(new Error(`collector process ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', exited);
    child.once('error', finish);
  });
}

async function main() {
try {
  assert.ok(contractFixture.rendered.size > 0, 'the disposable generated-contract fixture must be non-empty');
  const { policy, schema } = loadPackage();
  assert.deepEqual(policy, POLICY);
  assert.equal(policy.database.applicationId, APPLICATION_ID);
  assert.equal(policy.database.schemaVersion, SCHEMA_VERSION);
  assert.equal(policy.storage.hashMeaning, 'raw stored bytes');
  assert.equal(policy.storage.bodiesInDatabase, false);
  assert.equal(policy.authorization.defaultWithoutAuthorizer, 'deny');
  assert.equal(policy.activation.runtimeRouteEnabled, false);
  assert.equal(schema.$id, 'urn:coordinator:platform:evidence-store-record:1.0.0');
  assert.equal(path.basename(OUTPUTS.toolsEnabledPythonEvidence), 'coordinator_platform_evidence.py');
  assert.equal(PLATFORM_OUTPUTS.javascriptValidator.endsWith('platform.validator.js'), true);
  const generatedPackageProgram = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import coordinator_platform_evidence as evidence',
    "print(json.dumps({'policy': evidence.POLICY, 'schema': evidence.RECORD_SCHEMA}, sort_keys=True))"
  ].join('\n');
  const generatedPackage = spawnSync(PYTHON, ['-B', '-c', generatedPackageProgram, GENERATED_ROOT], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.ifError(generatedPackage.error);
  assert.equal(generatedPackage.status, 0, generatedPackage.stderr);
  const generatedSource = JSON.parse(generatedPackage.stdout);
  assert.deepEqual(generatedSource.policy, policy);
  assert.deepEqual(generatedSource.schema, schema);
  assert.equal(generatedSource.schema.properties.expiresAt.oneOf[1].type, 'null');

  const taskA = identity.newId('task');
  const scopeA = identity.newId('context');
  const taskB = identity.newId('task');
  const scopeB = identity.newId('context');
  const grantA = access(taskA, scopeA, { protected: true, delete: true });
  const grantAPublic = access(taskA, scopeA);
  const grantB = access(taskB, scopeB, { protected: true, delete: true });
  const maintenance = access(taskA, scopeA, { maintenance: true });
  const store = new EvidenceStore({
    dbFile,
    objectRoot: temporaryRoot,
    clock: () => nowMs,
    authorize
  });

  assert.deepEqual(store.health(), {
    ok: true,
    schemaVersion: 1,
    applicationId: APPLICATION_ID,
    records: 0,
    activeRecords: 0,
    tombstones: 0,
    runtimeRouteEnabled: false
  });

  const emptyCli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'verify-evidence-store.js'),
    '--db', dbFile,
    '--object-root', temporaryRoot,
    '--json'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(emptyCli.status, 2);
  assert.deepEqual(JSON.parse(emptyCli.stdout), {
    ok: false,
    code: 'EVIDENCE_NOT_MEASURED',
    schemaVersion: 1,
    records: 0,
    activeRecords: 0,
    tombstones: 0,
    objectsVerified: 0,
    failures: [{ part: 'store', reason: 'no-records' }]
  });

  const rawCanary = 'Private raw TOOLSENABLED_CANARY_EVIDENCE_RAW_7429 and accountId fixture-account.';
  const helpCli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'verify-evidence-store.js'),
    '--help'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(helpCli.status, 0, helpCli.stderr);
  assert.match(helpCli.stdout, /^Usage: node tools\/verify-evidence-store\.js /);
  assert.match(helpCli.stdout, /Read-only P10 verification\./);
  assert.equal(helpCli.stdout.includes(DEFAULT_DB_FILE), false);
  assert.equal(helpCli.stdout.includes(DEFAULT_ROOT), false);
  const argumentCanary = 'TOOLSENABLED_CANARY_ARGUMENT_PATH_6138';
  const invalidArgumentCli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'verify-evidence-store.js'),
    `--${argumentCanary}`
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(invalidArgumentCli.status, 64);
  assert.match(invalidArgumentCli.stderr, /^unknown argument\nUsage: node tools\/verify-evidence-store\.js /);
  assert.equal(`${invalidArgumentCli.stdout}${invalidArgumentCli.stderr}`.includes(argumentCanary), false);
  const text = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'fact',
    mediaType: 'text/plain',
    publicExport: publicExport(
      'Sanitized text observation.',
      'text',
      'Public observation: [REDACTED].'
    ),
    protectedContent: { type: 'text', text: rawCanary }
  });
  assert.equal(text.evidenceRef.contentHash, digest(Buffer.from(rawCanary, 'utf8')));
  assert.equal(text.publicContent.sha256, digest(Buffer.from('Public observation: [REDACTED].', 'utf8')));
  assert.notEqual(text.evidenceRef.contentHash, text.publicContent.sha256);
  assert.equal(text.provenance.sourceCount, 0);
  assert.equal(text.tombstoned, false);
  assert.equal(text.replayed, false);
  assert.equal(Object.hasOwn(text, 'locator'), false);
  assert.equal(Object.hasOwn(text, 'redactionReport'), false);
  assert.equal(Object.hasOwn(text, 'sourceVersion'), false);
  assert.equal(Object.hasOwn(text, 'protectedContent'), false);

  const jsonValue = { calculation: { inputs: [2, 3], result: 5 }, verified: true };
  const json = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'calculation',
    mediaType: 'application/json',
    publicExport: publicExport('Safe calculation.', 'json', { result: 5 }),
    protectedContent: { type: 'json', value: jsonValue }
  });
  assert.equal(json.evidenceRef.contentHash, digest(Buffer.from(identity.canonicalString(jsonValue), 'ascii')));
  assert.equal(json.publicContent.format, 'json');

  const fileBytes = Buffer.from('Captured file fixture.\r\nSecond line.\r\n', 'utf8');
  const sourceFile = path.join(temporaryRoot, 'source-fixture.txt');
  fs.writeFileSync(sourceFile, fileBytes);
  const file = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'file',
    mediaType: 'application/octet-stream',
    publicExport: publicExport('File capture summary.', 'text', 'A bounded file capture was recorded.'),
    protectedContent: { type: 'file', path: sourceFile }
  });
  assert.equal(file.evidenceRef.contentHash, digest(fileBytes));

  const screenshotBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('FAKE_SCREENSHOT_PIXELS_7429', 'ascii')
  ]);
  const screenshot = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'browser-trace',
    mediaType: 'image/png',
    provenance: provenance(['untrusted-browser']),
    publicExport: publicExport('Browser screenshot summary.', 'text', 'Screenshot captured; protected pixels omitted.'),
    protectedContent: { type: 'bytes', bytes: screenshotBytes }
  });
  assert.equal(screenshot.evidenceRef.contentHash, digest(screenshotBytes));

  const logBytes = 'PASS fixture one\nPASS fixture two\n';
  const testLog = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'test-log',
    mediaType: 'text/plain',
    publicExport: publicExport('Two fixture tests passed.', 'text', 'PASS count: 2'),
    protectedContent: { type: 'text', text: logBytes }
  });

  const shared = write(store, grantB, {
    evidenceId: identity.newId('evidence'),
    kind: 'tool-output',
    mediaType: 'text/plain',
    publicExport: publicExport('Task B summary.', 'text', 'Task B public body.'),
    protectedContent: { type: 'text', text: rawCanary }
  });
  assert.equal(shared.evidenceRef.contentHash, text.evidenceRef.contentHash, 'CAS must deduplicate equal protected bytes');

  const replay = write(store, grantA, {
    evidenceId: text.evidenceId,
    toolRequestId: text.toolRequestId,
    kind: 'fact',
    mediaType: 'text/plain',
    publicExport: publicExport('Sanitized text observation.', 'text', 'Public observation: [REDACTED].'),
    protectedContent: { type: 'text', text: rawCanary }
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.sequence, text.sequence);
  assert.throws(() => write(store, grantA, {
    evidenceId: text.evidenceId,
    toolRequestId: text.toolRequestId,
    publicExport: publicExport('Changed summary.', 'text', 'Changed public body.'),
    protectedContent: { type: 'text', text: 'Changed protected body.' }
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_CONFLICT');

  assert.throws(() => store.writeEvidence({
    access: grantA,
    evidenceId: identity.newId('evidence'),
    taskId: taskA,
    scopeId: scopeA,
    toolRequestId: identity.newId('event'),
    kind: 'fact',
    mediaType: 'text/plain',
    provenance: provenance(),
    sourceVersion: 'fixture-v1',
    locator: { kind: 'test', value: 'raw-public-rejection' },
    publicExport: { summary: 'not prepared' },
    protectedContent: { type: 'text', text: 'raw' }
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_REDACTION_REQUIRED');

  const publicRecords = store.listPublicRecords({ access: grantAPublic, taskId: taskA, scopeId: scopeA });
  assert.equal(publicRecords.length, 5);
  assert.doesNotMatch(JSON.stringify(publicRecords), /TOOLSENABLED_CANARY_EVIDENCE_RAW_7429|fixture-account/);
  assert.ok(publicRecords.every(record => !Object.hasOwn(record, 'locator') && !Object.hasOwn(record, 'redactionReport')));

  const publicText = Buffer.from('Public observation: [REDACTED].', 'utf8');
  const publicObjectPath = path.resolve(temporaryRoot, objectRelativePath(text.publicContent.sha256));
  const canonicalPublicObjectPath = fs.realpathSync.native(publicObjectPath);
  const comparablePath = filename => {
    const canonical = fs.realpathSync.native(path.resolve(String(filename)));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  const originalOpenSync = fs.openSync;
  let publicObjectOpens = 0;
  fs.openSync = function countedOpenSync(filename, ...args) {
    // resolveObjectForRead deliberately opens the canonical real path. Compare
    // canonical paths too: Windows can return a different case/8.3 spelling
    // after a disposable root crosses the parent/worker process boundary.
    if (comparablePath(filename) === comparablePath(canonicalPublicObjectPath)) publicObjectOpens += 1;
    return originalOpenSync.call(fs, filename, ...args);
  };
  let publicSpan;
  try {
    publicSpan = store.readPublicSpan({
      access: grantAPublic,
      evidenceId: text.evidenceId,
      taskId: taskA,
      scopeId: scopeA,
      offset: 7,
      length: 11
    });
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(publicObjectOpens, 1, 'verification and span must use one open descriptor');
  assert.deepEqual(publicSpan.bytes, publicText.subarray(7, 18));
  assert.doesNotMatch(publicSpan.bytes.toString('utf8'), /TOOLSENABLED_CANARY_/);
  assert.throws(() => store.readPublicSpan({
    access: grantAPublic,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA,
    offset: publicText.length,
    length: 1
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_SPAN_INVALID');

  assert.throws(() => store.readProtectedSpan({
    access: grantAPublic,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA,
    offset: 0,
    length: 7
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_ACCESS_DENIED');
  const protectedSpan = store.readProtectedSpan({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA,
    offset: 12,
    length: 27
  });
  assert.equal(protectedSpan.bytes.toString('utf8'), rawCanary.slice(12, 39));

  assert.throws(() => store.getPublicRecord({
    access: grantA,
    evidenceId: shared.evidenceId,
    taskId: taskB,
    scopeId: scopeB
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_ACCESS_DENIED');
  assert.throws(() => store.getPublicRecord({
    access: grantB,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_ACCESS_DENIED');

  const deniedStore = new EvidenceStore({ dbFile, objectRoot: temporaryRoot, clock: () => nowMs });
  assert.throws(() => deniedStore.getPublicRecord({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_ACCESS_DENIED');
  deniedStore.close();

  for (const record of [text, json, file, screenshot, testLog, shared]) {
    for (const contentHash of [record.publicContent.sha256, record.evidenceRef.contentHash]) {
      const relative = objectRelativePath(contentHash);
      assert.match(relative.replaceAll('\\', '/'), /^objects\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.blob$/);
      assert.ok(fs.statSync(path.join(temporaryRoot, relative)).isFile());
    }
  }
  // Raw open/read/close in this process would release SQLite's POSIX locks
  // for the same file, allowing another connection to remove a live WAL.
  // Scan bytes in a separate process while keeping the writer connection open.
  // https://www.sqlite.org/howtocorrupt.html#posix_advisory_locks_canceled_by_a_separate_thread_doing_close
  const bodyScan = spawnSync(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    "const files = process.argv.slice(1).filter(file => fs.existsSync(file));",
    "const containsCanary = files.some(file => fs.readFileSync(file).includes('TOOLSENABLED_CANARY_EVIDENCE_RAW_7429'));",
    "process.stdout.write(JSON.stringify({ scanned: files.length, containsCanary }));"
  ].join('\n'), dbFile, `${dbFile}-wal`], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000
  });
  assert.ifError(bodyScan.error);
  assert.equal(bodyScan.status, 0, bodyScan.stderr);
  const scannedBodies = JSON.parse(bodyScan.stdout);
  assert.ok(scannedBodies.scanned >= 1, 'the raw database body scan must inspect a real file');
  assert.equal(scannedBodies.containsCanary, false, 'protected body bytes must stay out of the database and WAL');

  assert.deepEqual(store.verifyEvidence({
    access: grantA,
    evidenceId: screenshot.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }).failures, []);
  const verified = verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot });
  assert.equal(verified.ok, true);
  assert.equal(verified.records, 6);
  assert.equal(verified.activeRecords, 6);
  assert.equal(verified.objectsVerified, 12);

  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'verify-evidence-store.js'),
    '--db', dbFile,
    '--object-root', temporaryRoot,
    '--json'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, true);
  assert.doesNotMatch(cli.stdout, /TOOLSENABLED_CANARY_|source-fixture|fixture-account/);

  const pythonProgram = [
    'import json, sys',
    'from pathlib import Path',
    'generated, db, objects, evidence_id, task_id, scope_id = sys.argv[1:]',
    'sys.path.insert(0, generated)',
    'import coordinator_platform_evidence as evidence',
    'checked = evidence.verify_store(db, objects)',
    "grant = {'taskId': task_id, 'scopeId': scope_id}",
    "authorize = lambda request: request['access'] == grant and request['binding']['taskId'] == task_id and request['binding']['scopeId'] == scope_id",
    'record = evidence.get_public_record(db, evidence_id, task_id, scope_id, access=grant, authorize=authorize)',
    'span = evidence.read_public_span(db, objects, evidence_id, task_id, scope_id, 7, 11, access=grant, authorize=authorize)',
    "print(json.dumps({'checked': checked, 'record': record, 'span': span['bytes'].decode('utf-8')}, sort_keys=True))"
  ].join('\n');
  const python = spawnSync(PYTHON, [
    '-B', '-c', pythonProgram, GENERATED_ROOT, dbFile, temporaryRoot,
    text.evidenceId, taskA, scopeA
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(python.error);
  assert.equal(python.status, 0, python.stderr);
  const pythonResult = JSON.parse(python.stdout);
  assert.equal(pythonResult.checked.ok, true);
  assert.equal(pythonResult.record.recordHash, text.recordHash);
  assert.equal(pythonResult.span, publicText.subarray(7, 18).toString('utf8'));
  assert.doesNotMatch(python.stdout, /TOOLSENABLED_CANARY_|fixture-account/);
  assert.equal(Object.hasOwn(pythonResult.record, 'sourceVersion'), false);
  assert.equal(Object.hasOwn(pythonResult.record, 'protectedContent'), false);

  const metadataDb = new DatabaseSync(dbFile);
  const originalPublic = metadataDb.prepare(`SELECT public_sha256, public_size_bytes, public_format
    FROM evidence_records WHERE evidence_id = ?`).get(text.evidenceId);
  metadataDb.prepare(`UPDATE evidence_records SET public_sha256 = ?, public_size_bytes = ?, public_format = 'text'
    WHERE evidence_id = ?`).run(text.evidenceRef.contentHash, Buffer.byteLength(rawCanary), text.evidenceId);
  metadataDb.close();
  for (const operation of [
    () => store.getPublicRecord({ access: grantA, evidenceId: text.evidenceId, taskId: taskA, scopeId: scopeA }),
    () => store.listPublicRecords({ access: grantA, taskId: taskA, scopeId: scopeA }),
    () => store.readPublicSpan({
      access: grantA,
      evidenceId: text.evidenceId,
      taskId: taskA,
      scopeId: scopeA,
      offset: 0,
      length: 8
    })
  ]) {
    assert.throws(operation, error =>
      error instanceof EvidenceStoreError && error.code === 'EVIDENCE_RECORD_TAMPERED');
  }
  const restoreMetadataDb = new DatabaseSync(dbFile);
  restoreMetadataDb.prepare(`UPDATE evidence_records SET public_sha256 = ?, public_size_bytes = ?, public_format = ?
    WHERE evidence_id = ?`).run(
    originalPublic.public_sha256,
    originalPublic.public_size_bytes,
    originalPublic.public_format,
    text.evidenceId
  );
  restoreMetadataDb.close();
  assert.equal(store.getPublicRecord({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }).publicContent.sha256, text.publicContent.sha256);

  const semanticDb = new DatabaseSync(dbFile);
  const semanticRow = semanticDb.prepare('SELECT * FROM evidence_records WHERE evidence_id = ?').get(text.evidenceId);
  const semanticRecord = recordFromDatabaseRow(semanticRow);
  const invalidSemanticRecord = { ...semanticRecord, sourceVersion: 'INVALID SPACE' };
  invalidSemanticRecord.recordHash = identity.canonicalHash(
    POLICY.recordHash.domain,
    recordHashPayload(invalidSemanticRecord)
  );
  semanticDb.prepare('UPDATE evidence_records SET source_version = ?, record_hash = ? WHERE evidence_id = ?')
    .run(invalidSemanticRecord.sourceVersion, invalidSemanticRecord.recordHash, text.evidenceId);
  semanticDb.close();
  assert.deepEqual(store.verifyEvidence({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }).failures, [{ part: 'record', reason: 'invalid' }]);
  assert.throws(() => store.getPublicRecord({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_RECORD_TAMPERED');
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, false);
  const pythonSemanticTamper = spawnSync(PYTHON, [
    '-B', '-c',
    [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import coordinator_platform_evidence as evidence',
      'print(json.dumps(evidence.verify_store(sys.argv[2], sys.argv[3]), sort_keys=True))'
    ].join('\n'),
    GENERATED_ROOT,
    dbFile,
    temporaryRoot
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(pythonSemanticTamper.error);
  assert.equal(pythonSemanticTamper.status, 0, pythonSemanticTamper.stderr);
  const pythonSemanticResult = JSON.parse(pythonSemanticTamper.stdout);
  assert.equal(pythonSemanticResult.ok, false);
  assert.ok(pythonSemanticResult.failures.some(item =>
    item.evidenceId === text.evidenceId && item.part === 'record' && item.reason === 'invalid'));
  const restoreSemanticDb = new DatabaseSync(dbFile);
  restoreSemanticDb.prepare('UPDATE evidence_records SET source_version = ?, record_hash = ? WHERE evidence_id = ?')
    .run(semanticRecord.sourceVersion, semanticRecord.recordHash, text.evidenceId);
  restoreSemanticDb.close();
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, true);

  const invalidFindingReport = {
    ...semanticRecord.redactionReport,
    changed: true,
    findingCount: 1,
    findings: [{
      path: '$.fixture',
      detectorId: 'fixture',
      category: [],
      count: 1
    }]
  };
  const invalidFindingRecord = { ...semanticRecord, redactionReport: invalidFindingReport };
  invalidFindingRecord.recordHash = identity.canonicalHash(
    POLICY.recordHash.domain,
    recordHashPayload(invalidFindingRecord)
  );
  const invalidFindingDb = new DatabaseSync(dbFile);
  invalidFindingDb.prepare('UPDATE evidence_records SET redaction_report_json = ?, record_hash = ? WHERE evidence_id = ?')
    .run(JSON.stringify(invalidFindingReport), invalidFindingRecord.recordHash, text.evidenceId);
  invalidFindingDb.close();
  assert.deepEqual(store.verifyEvidence({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }).failures, [{ part: 'record', reason: 'invalid' }]);
  const pythonInvalidFinding = spawnSync(PYTHON, [
    '-B', '-c',
    [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import coordinator_platform_evidence as evidence',
      'print(json.dumps(evidence.verify_store(sys.argv[2], sys.argv[3]), sort_keys=True))'
    ].join('\n'),
    GENERATED_ROOT,
    dbFile,
    temporaryRoot
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(pythonInvalidFinding.error);
  assert.equal(pythonInvalidFinding.status, 0, pythonInvalidFinding.stderr);
  const pythonInvalidFindingResult = JSON.parse(pythonInvalidFinding.stdout);
  assert.equal(pythonInvalidFindingResult.ok, false);
  assert.ok(pythonInvalidFindingResult.failures.some(item =>
    item.evidenceId === text.evidenceId && item.part === 'record' && item.reason === 'invalid'));
  const restoreFindingDb = new DatabaseSync(dbFile);
  restoreFindingDb.prepare('UPDATE evidence_records SET redaction_report_json = ?, record_hash = ? WHERE evidence_id = ?')
    .run(JSON.stringify(semanticRecord.redactionReport), semanticRecord.recordHash, text.evidenceId);
  restoreFindingDb.close();
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, true);

  const screenshotPath = path.join(temporaryRoot, objectRelativePath(screenshot.evidenceRef.contentHash));
  try { fs.chmodSync(screenshotPath, 0o660); } catch { /* Windows ACLs may ignore POSIX mode. */ }
  const tampered = Buffer.from(screenshotBytes);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(screenshotPath, tampered);
  const tamperResult = verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot });
  assert.equal(tamperResult.ok, false);
  assert.ok(tamperResult.failures.some(item =>
    item.evidenceId === screenshot.evidenceId && item.part === 'protected' && item.reason === 'hash'));
  const tamperCli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'verify-evidence-store.js'),
    '--db', dbFile,
    '--object-root', temporaryRoot,
    '--json'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(tamperCli.status, 2);
  const tamperCliResult = JSON.parse(tamperCli.stdout);
  assert.equal(tamperCliResult.ok, false);
  assert.ok(tamperCliResult.failures.some(item =>
    item.evidenceId === screenshot.evidenceId && item.part === 'protected' && item.reason === 'hash'));
  assert.doesNotMatch(tamperCli.stderr, /TOOLSENABLED_CANARY_|fixture-account/);
  fs.writeFileSync(screenshotPath, screenshotBytes);
  try { fs.chmodSync(screenshotPath, 0o440); } catch { /* best effort */ }
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, true);

  const raceBody = 'Collector/writer interlock fixture body.';
  const raceDigest = digest(Buffer.from(raceBody, 'utf8'));
  const raceTrigger = path.join(temporaryRoot, 'race-trigger');
  const raceReady = path.join(temporaryRoot, 'race-ready');
  const raceDone = path.join(temporaryRoot, 'race-done.json');
  const collectorProgram = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const [modulePath, dbFile, objectRoot, digest, trigger, ready, done] = process.argv.slice(1);",
    "const { EvidenceStore } = require(modulePath);",
    "fs.writeFileSync(ready, 'ready');",
    "const waiter = new Int32Array(new SharedArrayBuffer(4));",
    "while (!fs.existsSync(trigger)) Atomics.wait(waiter, 0, 0, 5);",
    "const store = new EvidenceStore({ dbFile, objectRoot });",
    "let result;",
    "try { result = store._collectDigest(digest); } finally { store.close(); }",
    "fs.writeFileSync(done, JSON.stringify(result));"
  ].join('\n');
  const collector = spawn(process.execPath, [
    '-e', collectorProgram,
    path.join(ROOT, 'src', 'lib', 'evidence-store.js'),
    dbFile,
    temporaryRoot,
    raceDigest,
    raceTrigger,
    raceReady,
    raceDone
  ], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  collector.unref();
  waitForFile(raceReady);
  const originalCommitStaged = store._commitStagedObject.bind(store);
  let triggeredCollector = false;
  store._commitStagedObject = function commitWithCollector(staged) {
    const result = originalCommitStaged(staged);
    if (!triggeredCollector && staged.sha256 === raceDigest) {
      triggeredCollector = true;
      fs.writeFileSync(raceTrigger, 'collect');
    }
    return result;
  };
  let raceRecord;
  try {
    raceRecord = write(store, grantA, {
      evidenceId: identity.newId('evidence'),
      kind: 'tool-output',
      mediaType: 'text/plain',
      publicExport: publicExport('Writer/collector race fixture.', 'text', raceBody),
      protectedContent: { type: 'text', text: raceBody }
    });
  } finally {
    store._commitStagedObject = originalCommitStaged;
  }
  assert.equal(triggeredCollector, true);
  waitForFile(raceDone);
  // raceDone proves the collector closed its EvidenceStore, but on Windows it
  // can still be in process teardown with the SQLite file handle observable.
  // Wait for the actual process boundary before later fixture cleanup.
  await waitForProcessExit(collector);
  assert.equal(collector.exitCode, 0, 'the retained collector exits successfully');
  const collectorResult = JSON.parse(fs.readFileSync(raceDone, 'utf8'));
  assert.equal(collectorResult.collected, false);
  assert.equal(collectorResult.reason, 'live-reference');
  assert.ok(fs.existsSync(path.join(temporaryRoot, objectRelativePath(raceRecord.evidenceRef.contentHash))));
  assert.equal(store.verifyEvidence({
    access: grantA,
    evidenceId: raceRecord.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }).ok, true);

  const textDeletion = store.tombstoneEvidence({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA,
    reason: 'user-request'
  });
  assert.equal(textDeletion.tombstone.recordHash, text.recordHash);
  assert.equal(textDeletion.tombstone.protectedSha256, text.evidenceRef.contentHash);
  assert.equal(textDeletion.collected.find(item => item.sha256 === text.evidenceRef.contentHash).reason, 'live-reference',
    'shared protected objects must remain while another task has a live reference');
  assert.ok(fs.existsSync(path.join(temporaryRoot, objectRelativePath(text.evidenceRef.contentHash))));
  assert.throws(() => store.getPublicRecord({
    access: grantA,
    evidenceId: text.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_TOMBSTONED');

  const transient = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'approval',
    mediaType: 'application/json',
    publicExport: publicExport('Expired approval fixture.', 'json', { status: 'expired' }),
    protectedContent: { type: 'json', value: { approval: 'fixture-only' } },
    retentionClass: 'transient'
  });
  nowMs += POLICY.retention.classes.transient.maxAgeMs + 1;
  const retention = store.applyRetention({ access: maintenance, nowMs, limit: 10 });
  assert.equal(retention.tombstones.length, 1);
  assert.equal(retention.tombstones[0].evidenceId, transient.evidenceId);
  assert.throws(() => store.getPublicRecord({
    access: grantA,
    evidenceId: transient.evidenceId,
    taskId: taskA,
    scopeId: scopeA
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_TOMBSTONED');

  const oldTime = new Date(nowMs - POLICY.maintenance.orphanGraceMs - 1_000);
  const forgedBody = 'forged tombstone liveness fixture body';
  const forgedRecord = write(store, grantA, {
    evidenceId: identity.newId('evidence'),
    kind: 'test-log',
    mediaType: 'text/plain',
    publicExport: publicExport('Forged tombstone liveness fixture.', 'text', forgedBody),
    protectedContent: { type: 'text', text: forgedBody }
  });
  const forgedPath = path.join(temporaryRoot, objectRelativePath(forgedRecord.evidenceRef.contentHash));
  fs.utimesSync(forgedPath, oldTime, oldTime);
  const forgedDb = new DatabaseSync(dbFile);
  const forgedRow = forgedDb.prepare('SELECT * FROM evidence_records WHERE evidence_id = ?').get(forgedRecord.evidenceId);
  forgedDb.prepare(`INSERT INTO evidence_tombstones(
    tombstone_id, evidence_id, task_id, scope_id, record_hash, protected_sha256,
    public_sha256, reason, deleted_at, tombstone_hash
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    identity.newId('event'),
    forgedRow.evidence_id,
    forgedRow.task_id,
    forgedRow.scope_id,
    forgedRow.record_hash,
    forgedRow.protected_sha256,
    forgedRow.public_sha256,
    'user-request',
    new Date(nowMs).toISOString(),
    '0'.repeat(64)
  );
  forgedDb.close();
  assert.throws(
    () => store.sweepOrphans({ access: maintenance, nowMs, limit: 1000 }),
    error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_TOMBSTONE_TAMPERED'
  );
  assert.equal(fs.existsSync(forgedPath), true, 'a forged tombstone must not make live content collectible');
  const repairForgedDb = new DatabaseSync(dbFile);
  repairForgedDb.prepare('DELETE FROM evidence_tombstones WHERE evidence_id = ?').run(forgedRecord.evidenceId);
  repairForgedDb.close();
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, true);
  store.tombstoneEvidence({
    access: grantA,
    evidenceId: forgedRecord.evidenceId,
    taskId: taskA,
    scopeId: scopeA,
    reason: 'user-request'
  });

  const oldTemp = path.join(temporaryRoot, 'tmp', `${process.pid}-${'a'.repeat(36)}.tmp`);
  const oldTrash = path.join(temporaryRoot, 'trash', `${'b'.repeat(64)}.${'c'.repeat(24)}.trash`);
  fs.writeFileSync(oldTemp, 'orphan temp');
  fs.writeFileSync(oldTrash, 'orphan trash');
  fs.utimesSync(oldTemp, oldTime, oldTime);
  fs.utimesSync(oldTrash, oldTime, oldTime);
  const orphanBytes = Buffer.from('unreferenced old CAS object', 'utf8');
  const orphanDigest = digest(orphanBytes);
  const orphanPath = path.join(temporaryRoot, objectRelativePath(orphanDigest));
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
  fs.writeFileSync(orphanPath, orphanBytes);
  fs.utimesSync(orphanPath, oldTime, oldTime);
  const sweep = store.sweepOrphans({ access: maintenance, nowMs, limit: 1000 });
  assert.equal(sweep.removedTemp, 1);
  assert.equal(sweep.removedTrash, 1);
  assert.equal(sweep.collectedObjects, 1);
  assert.equal(fs.existsSync(oldTemp), false);
  assert.equal(fs.existsSync(oldTrash), false);
  assert.equal(fs.existsSync(orphanPath), false);

  let junctionCreated = false;
  let junctionPath;
  let junctionTarget;
  try {
    let junctionBody;
    let junctionDigest;
    for (let index = 0; index < 4096; index += 1) {
      const candidate = `junction-containment-${index}`;
      const candidateDigest = digest(Buffer.from(candidate, 'utf8'));
      const firstShard = path.join(temporaryRoot, 'objects', 'sha256', candidateDigest.slice(0, 2));
      if (!fs.existsSync(firstShard)) {
        junctionBody = candidate;
        junctionDigest = candidateDigest;
        junctionPath = firstShard;
        break;
      }
    }
    assert.ok(junctionDigest, 'a free CAS shard must be available');
    junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-p10-junction-target-'));
    fs.symlinkSync(junctionTarget, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    junctionCreated = true;
    assert.throws(() => write(store, grantA, {
      evidenceId: identity.newId('evidence'),
      kind: 'file',
      mediaType: 'text/plain',
      publicExport: publicExport('Junction fixture.', 'text', junctionBody),
      protectedContent: { type: 'text', text: junctionBody }
    }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_STORAGE_UNSAFE');
    assert.deepEqual(fs.readdirSync(junctionTarget), [], 'a rejected junction must not receive CAS shards');
  } catch (error) {
    if (!error || !['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  } finally {
    if (junctionCreated) {
      if (process.platform === 'win32') fs.rmdirSync(junctionPath);
      else fs.unlinkSync(junctionPath);
    }
    if (junctionTarget && fs.existsSync(junctionTarget)) fs.rmSync(junctionTarget, { recursive: true, force: true });
  }

  const finalVerification = verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot });
  assert.equal(finalVerification.ok, true);
  assert.equal(finalVerification.records, 9);
  assert.equal(finalVerification.activeRecords, 6);
  assert.equal(finalVerification.tombstones, 3);
  assert.equal(store.health().records, 9);
  assert.equal(store.health().activeRecords, 6);
  assert.equal(store.health().tombstones, 3);

  const tombstoneDb = new DatabaseSync(dbFile);
  const originalTombstone = tombstoneDb.prepare('SELECT * FROM evidence_tombstones WHERE evidence_id = ?').get(text.evidenceId);
  const reboundTombstone = {
    schemaVersion: POLICY.policyVersion,
    tombstoneId: originalTombstone.tombstone_id,
    evidenceId: originalTombstone.evidence_id,
    taskId: taskB,
    scopeId: originalTombstone.scope_id,
    recordHash: originalTombstone.record_hash,
    protectedSha256: originalTombstone.protected_sha256,
    publicSha256: originalTombstone.public_sha256,
    reason: originalTombstone.reason,
    deletedAt: originalTombstone.deleted_at
  };
  const reboundHash = identity.canonicalHash(POLICY.tombstoneHash.domain, reboundTombstone);
  tombstoneDb.prepare('UPDATE evidence_tombstones SET task_id = ?, tombstone_hash = ? WHERE evidence_id = ?')
    .run(taskB, reboundHash, text.evidenceId);
  tombstoneDb.close();
  const falseTombstone = verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot });
  assert.equal(falseTombstone.ok, false);
  assert.ok(falseTombstone.failures.some(item =>
    item.evidenceId === text.evidenceId && item.part === 'tombstone' && item.reason === 'invalid'));
  const pythonFalseTombstone = spawnSync(PYTHON, [
    '-B', '-c',
    [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import coordinator_platform_evidence as evidence',
      "print(json.dumps(evidence.verify_store(sys.argv[2], sys.argv[3]), sort_keys=True))"
    ].join('\n'),
    GENERATED_ROOT,
    dbFile,
    temporaryRoot
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(pythonFalseTombstone.error);
  assert.equal(pythonFalseTombstone.status, 0, pythonFalseTombstone.stderr);
  assert.equal(JSON.parse(pythonFalseTombstone.stdout).ok, false);
  assert.ok(JSON.parse(pythonFalseTombstone.stdout).failures.some(item =>
    item.evidenceId === text.evidenceId && item.part === 'tombstone' && item.reason === 'binding'));
  const restoreTombstoneDb = new DatabaseSync(dbFile);
  restoreTombstoneDb.prepare('UPDATE evidence_tombstones SET task_id = ?, tombstone_hash = ? WHERE evidence_id = ?')
    .run(originalTombstone.task_id, originalTombstone.tombstone_hash, text.evidenceId);
  restoreTombstoneDb.close();
  assert.equal(verifyEvidenceStore({ dbFile, objectRoot: temporaryRoot }).ok, true);

  const foreignRoot = path.join(temporaryRoot, 'foreign-object-root');
  const foreignDbFile = path.join(temporaryRoot, 'foreign.sqlite3');
  const foreignDb = new DatabaseSync(foreignDbFile);
  foreignDb.exec('PRAGMA application_id=12345; PRAGMA journal_mode=DELETE; CREATE TABLE foreign_data(value TEXT);');
  foreignDb.close();
  assert.throws(() => new EvidenceStore({
    dbFile: foreignDbFile,
    objectRoot: foreignRoot,
    authorize
  }), error => error instanceof EvidenceStoreError && error.code === 'EVIDENCE_DATABASE_IDENTITY');
  const foreignCheck = new DatabaseSync(foreignDbFile, { readOnly: true });
  assert.equal(foreignCheck.prepare('PRAGMA journal_mode').get().journal_mode, 'delete',
    'foreign database journal mode must not be mutated before identity rejection');
  foreignCheck.close();

  const driftRoot = path.join(temporaryRoot, 'schema-drift');
  const driftDbFile = path.join(driftRoot, 'evidence.sqlite3');
  const driftStore = new EvidenceStore({
    dbFile: driftDbFile,
    objectRoot: driftRoot,
    clock: () => nowMs,
    authorize
  });
  write(driftStore, grantA, { evidenceId: identity.newId('evidence') });
  driftStore.close();
  const driftDb = new DatabaseSync(driftDbFile);
  driftDb.exec('DROP INDEX evidence_records_task_scope_idx;');
  driftDb.close();
  assert.throws(() => verifyEvidenceStore({ dbFile: driftDbFile, objectRoot: driftRoot }), error =>
    error instanceof EvidenceStoreError && error.code === 'EVIDENCE_SCHEMA_INVALID');
  const pythonSchemaDrift = spawnSync(PYTHON, [
    '-B', '-c',
    [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import coordinator_platform_evidence as evidence',
      'try:',
      '    evidence.verify_store(sys.argv[2], sys.argv[3])',
      "    print(json.dumps({'code': 'UNEXPECTED_OK'}))",
      'except evidence.EvidenceVerificationError as error:',
      "    print(json.dumps({'code': error.code}))"
    ].join('\n'),
    GENERATED_ROOT,
    driftDbFile,
    driftRoot
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(pythonSchemaDrift.error);
  assert.equal(pythonSchemaDrift.status, 0, pythonSchemaDrift.stderr);
  assert.equal(JSON.parse(pythonSchemaDrift.stdout).code, 'EVIDENCE_SCHEMA_INVALID');

  const storeSource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'evidence-store.js'), 'utf8');
  const registrySource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'tool-registry.js'), 'utf8');
  const mcpSource = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
  assert.doesNotMatch(registrySource, /require\(['"].*evidence-store/);
  assert.doesNotMatch(mcpSource, /require\(['"].*evidence-store/);
  assert.doesNotMatch(storeSource, /UPDATE\s+evidence_records|DELETE\s+FROM\s+evidence_records/i,
    'records must remain append-oriented');
  assert.match(storeSource, /INSERT INTO evidence_tombstones/);
  assert.doesNotMatch(storeSource, /task_events|task_checkpoints|audit_events/i,
    'P10 must not place bodies in task tables or implement P11 audit wiring');

  store.close();
  console.log('Unified-agent P10 evidence check passed (six content forms, cross-process verification, tamper, scope, retention).');
} finally {
  const resolved = path.resolve(temporaryRoot);
  if (!suppliedTemporaryRoot && resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith('toolsenabled-p10-')) {
    // Node's synchronous SQLite binding can release its final Windows file
    // handle a few scheduler ticks after close(). Retry only this validated
    // disposable directory so a successful contract run is not reported as a
    // product failure because cleanup raced that release.
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
