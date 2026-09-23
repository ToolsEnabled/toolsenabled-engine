'use strict';

/*
 * Containment for src/lib/providers/code-intel.js#resolveFilePath (see
 * src/lib/code-file-containment.js). MEASURED: at engine commit b7149aeb,
 * resolveFilePath ran path.resolve(rootPath(), value) then
 * fs.statSync(resolved) with zero containment checks and zero audit calls,
 * so an absolute `file` argument read any file the process could open. The
 * same shape was confirmed live at c621171c, 74ea0b23 and 147251a (memory
 * key code-intel-abs-path-escape-20260906).
 *
 * Run directly: node tests/code-intel-containment.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Isolation and audit-admission wiring, matching tests/code.intel/code-intel.js:
// resolveFilePath now requires DURABLE audit admission
// (src/lib/audit-admission.js#requireRecordAsync) before a successful, in-bounds
// resolution returns, mirroring host.read_file's own "admission before the
// read" ordering, so an in-root case cannot pass without this setup.
const isolated = require('./lib/isolated-environment').activate('code-intel-containment');
const admission = require('../src/lib/audit-admission');
require('../src/lib/throughput-mode').setThroughputModeForTests('fast');
process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER = '1';
admission.resetAdmissionQueueForTests();
const audit = require('../src/lib/audit');
audit.resetForTests();

const codeIntel = require('../src/lib/providers/code-intel');
const containment = require('../src/lib/code-file-containment');

const REPO_ROOT = path.resolve(__dirname, '..');
// Use an explicit recorded-workspace grant at the dependency seam. The real
// containment and filesystem checks still execute, and no fixture is written
// into a shipped or read-only checkout.
const IN_ROOT_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'te-code-intel-workspace-'));
const registry = require('../src/lib/tool-registry');
const originalWorkspaceRoots = registry.confinedWorkspaceRoots;
registry.confinedWorkspaceRoots = () => [IN_ROOT_SCRATCH];
test.after(() => { registry.confinedWorkspaceRoots = originalWorkspaceRoots; });

test('a removed recorded-workspace grant is refused on the next decision', () => {
  const admitted = registry.confinedWorkspaceRoots;
  assert.equal(containment.isInsideAllowedRoots(IN_ROOT_SCRATCH), true);
  try {
    registry.confinedWorkspaceRoots = () => [];
    assert.equal(containment.isInsideAllowedRoots(IN_ROOT_SCRATCH), false);
  } finally { registry.confinedWorkspaceRoots = admitted; }
});

const temporary = [];
function inRootDir(label) {
  const directory = fs.mkdtempSync(path.join(IN_ROOT_SCRATCH, `${label}-`));
  temporary.push(directory);
  return directory;
}

function outsideRootDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `te-c3-outside-${label}-`));
  temporary.push(directory);
  return directory;
}

async function refusal(run, expected) {
  try {
    await run();
  } catch (error) {
    assert.equal(error.code, expected, `expected ${expected}, received ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${expected}, but the call resolved`);
}

test.afterEach(() => {
  // Every test above and below this line runs at the default mode unless it
  // sets otherwise; a mode change in one test must never leak into the next.
  containment.setReadAuditModeForTests(null);
});

test.after(async () => {
  codeIntel.setServerResolverForTests(null);
  await codeIntel.stopAllSessionsForTests();
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(IN_ROOT_SCRATCH, { recursive: true, force: true });
});

test('an absolute file outside every allowed root is refused CODE_FILE_OUTSIDE_ROOT before discovery', async () => {
  const outsideRoot = outsideRootDir('escape');
  const outsideFile = path.join(outsideRoot, 'escape.ts');
  fs.writeFileSync(outsideFile, 'export const escaped = 1;\n');
  let discoveryCalls = 0;
  codeIntel.setServerResolverForTests(() => {
    discoveryCalls += 1;
    throw new Error('discovery must not run for a file outside every allowed root');
  });

  const escaped = await refusal(
    () => codeIntel.documentSymbols({ file: outsideFile, root: outsideRoot }),
    'CODE_FILE_OUTSIDE_ROOT'
  );
  assert.equal(escaped.details.file, outsideFile);
  assert.equal(discoveryCalls, 0, 'an outside-root file must not reach language-server discovery');
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0, 'an outside-root refusal creates no session');

  const recent = audit.tail(50);
  const auditedRefusal = recent.find(event => event.action === 'code.file_outside_root_refused'
    && event.target === outsideFile);
  assert.ok(auditedRefusal, 'the refusal must land a durable audit entry naming the refused file');
});

test('a directory junction inside root pointing outside root is refused CODE_FILE_OUTSIDE_ROOT', async () => {
  const inRoot = inRootDir('junction-root');
  const outsideRoot = outsideRootDir('junction-target');
  fs.writeFileSync(path.join(outsideRoot, 'secret.ts'), 'export const secret = 1;\n');
  const junctionPath = path.join(inRoot, 'linked');
  fs.symlinkSync(outsideRoot, junctionPath, 'junction');
  const fileThroughJunction = path.join(junctionPath, 'secret.ts');
  assert.equal(fs.readFileSync(fileThroughJunction, 'utf8'), 'export const secret = 1;\n',
    'fixture sanity: the junction must actually resolve to the outside file');

  let discoveryCalls = 0;
  codeIntel.setServerResolverForTests(() => {
    discoveryCalls += 1;
    throw new Error('discovery must not run for a realpath outside every allowed root');
  });

  const escaped = await refusal(
    () => codeIntel.documentSymbols({ file: fileThroughJunction, root: inRoot }),
    'CODE_FILE_OUTSIDE_ROOT'
  );
  assert.equal(escaped.details.file, fileThroughJunction,
    'the refusal reports the lexical (pre-realpath) path the caller supplied');
  assert.equal(discoveryCalls, 0, 'a junction escape must not reach language-server discovery');
});

test('an in-root absolute file still resolves past containment', async () => {
  const inRoot = inRootDir('in-root-absolute');
  fs.writeFileSync(path.join(inRoot, 'tsconfig.json'), '{}');
  const inRootFile = path.join(inRoot, 'sample.ts');
  fs.writeFileSync(inRootFile, 'export const inRootValue = 2;\n');
  codeIntel.setServerResolverForTests(() => ({
    resolved: true,
    serverId: 'containment-test-server',
    command: path.join(inRoot, 'definitely-not-an-executable'),
    args: [],
    attempts: []
  }));

  const started = await refusal(
    () => codeIntel.documentSymbols({ file: inRootFile, root: inRoot }),
    'CODE_SERVER_START_FAILED'
  );
  assert.equal(started.details.lspCode, 'LSP_SERVER_START_FAILED');
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0);

  const recent = audit.tail(50);
  const auditedRead = recent.find(event => event.action === 'code.intel.read_file.intent'
    && event.target === inRootFile);
  assert.ok(auditedRead, 'a successful in-root resolution must land a durable admitted audit entry');
});

test('a file value relative to the ToolsEnabled root still resolves past containment', async () => {
  const relFixtureDir = inRootDir('relative');
  fs.writeFileSync(path.join(relFixtureDir, 'tsconfig.json'), '{}');
  const relFixtureFile = path.join(relFixtureDir, 'rel.ts');
  fs.writeFileSync(relFixtureFile, 'export const relativeValue = 3;\n');
  const relativeValue = path.relative(REPO_ROOT, relFixtureFile);
  assert.ok(!path.isAbsolute(relativeValue), 'fixture must actually exercise the relative-path branch');
  codeIntel.setServerResolverForTests(() => ({
    resolved: true,
    serverId: 'containment-test-server-relative',
    command: path.join(relFixtureDir, 'definitely-not-an-executable'),
    args: [],
    attempts: []
  }));

  const relStarted = await refusal(
    () => codeIntel.documentSymbols({ file: relativeValue, root: relFixtureDir }),
    'CODE_SERVER_START_FAILED'
  );
  assert.equal(relStarted.details.lspCode, 'LSP_SERVER_START_FAILED');
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0);
});

// C3-B3: the success-path read audit is one named, switchable mode
// (src/lib/code-file-containment.js's READ_AUDIT_MODES / setReadAuditModeForTests),
// default 'durable' unchanged. These two tests are the direct proof the mode
// actually changes behaviour, not just a label: 'record' must not wait on
// the same durable admission 'durable' waits on, and 'none' must not call
// the read-audit at all. Proved by substituting a broken requireRecordAsync
// (below) rather than by a wall-clock threshold, since a broken dependency
// either gets called or it does not -- a fact, not a timing guess.

test('read audit mode "record" does not await durable admission; "durable" (the default) does', () => {
  // src/lib/audit-admission.js's exports are Object.freeze()'d, so its
  // requireRecordAsync cannot be reassigned on the live module object (this
  // was tried first and throws "Cannot assign to read only property").
  // Module-cache substitution -- seeding require.cache with a fake module
  // before a fresh require -- is the same technique already used in this
  // codebase's own tests (see tests/vault-unreadable-is-not-absent.test.js's
  // doctorWithSecretKeys: "drop... from the cache" before re-requiring).
  const admissionPath = require.resolve('../src/lib/audit-admission');
  const containmentPath = require.resolve('../src/lib/code-file-containment');
  const realAdmissionModule = require.cache[admissionPath];
  const brokenRequireRecordAsync = async () => {
    throw new Error('durable admission must not be called when the mode is not "durable"');
  };
  require.cache[admissionPath] = {
    id: admissionPath, filename: admissionPath, loaded: true,
    exports: Object.freeze({ ...realAdmissionModule.exports, requireRecordAsync: brokenRequireRecordAsync })
  };
  delete require.cache[containmentPath];
  try {
    // eslint-disable-next-line global-require
    const freshContainment = require('../src/lib/code-file-containment');
    freshContainment.setReadAuditModeForTests('record');
    return freshContainment.auditSuccessfulRead('test.read_audit_mode', 'fixture-target', {})
      .then(() => {
        freshContainment.setReadAuditModeForTests('durable');
        return assert.rejects(
          () => freshContainment.auditSuccessfulRead('test.read_audit_mode', 'fixture-target', {}),
          error => error.message === 'durable admission must not be called when the mode is not "durable"',
          '"durable" (the default) mode DOES call durable admission, and fails when it is broken'
        );
      });
  } finally {
    require.cache[admissionPath] = realAdmissionModule;
    delete require.cache[containmentPath];
    require('../src/lib/code-file-containment'); // restore the module the rest of this file's `containment` binding still points at
  }
});

test('read audit mode "none" adds no read-audit entry; "record" still adds one, non-durably', async () => {
  const inRoot = inRootDir('read-audit-mode-none');
  const inRootFile = path.join(inRoot, 'sample.ts');
  fs.writeFileSync(inRootFile, 'export const modeValue = 2;\n');

  containment.setReadAuditModeForTests('none');
  await codeIntel.resolveFilePathForTests(inRootFile);
  const afterNone = audit.tail(50);
  assert.equal(afterNone.find(event => event.action === 'code.intel.read_file.intent' && event.target === inRootFile), undefined,
    '"none" must not add a read-audit entry for this resolution');

  containment.setReadAuditModeForTests('record');
  await codeIntel.resolveFilePathForTests(inRootFile);
  const afterRecord = audit.tail(50);
  assert.ok(afterRecord.find(event => event.action === 'code.intel.read_file.intent' && event.target === inRootFile),
    '"record" must still add a read-audit entry, even though it does not gate on durability');
});
