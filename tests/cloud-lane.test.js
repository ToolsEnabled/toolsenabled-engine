'use strict';

// R1177: tests for the FileKeeper <-> Codex Cloud custody loop
// (src/lib/cloud-agent/cloud-lane.js + tools/cloud-lane.js). Plain
// `node tests/cloud-lane.test.js` or via `node --test`. Every git call is an
// injected fake execImpl and every codex call is an injected fake transport:
// no real git ls-tree, no real codex binary, no network. All state writes go
// to per-test temp directories -- the repo's real state/ is snapshotted at
// start and asserted untouched at the end.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lane = require('../src/lib/cloud-agent/cloud-lane');
const cli = require('../tools/cloud-lane');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const { validateOutboundProof } = require('../packages/internal-vcs/src/cloud/outbound-proof');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const asyncCheck = async (label, fn) => { await fn(); checks += 1; void label; };

// The allowlist refusal is raised by the internal-vcs package, so it arrives as
// a VcsError rather than a CloudAgentError. That is deliberate and is NOT
// translated at the boundary: VcsError carries `details.path` naming the file
// that tried to leave, which is the single most useful fact about a refusal to
// export. The CLI's top-level handler duck-types on `error.code` (see
// tools/cloud-lane.js), so it reports this correctly. Any NEW caller that
// branches on `instanceof CloudAgentError` would miss it -- branch on `.code`.
async function rejectsWithCodeFromAnyError(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, expectedCode, `expected code ${expectedCode}, got ${error && error.code}: ${error && error.message}`);
    return true;
  });
}

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}: ${error && error.message}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const OID = (char, length = 40) => char.repeat(length);
const COMMIT = OID('9');
const TASK_ID = 'task_e_abc123DEF456';
const T0 = '2026-08-08T12:00:00.000Z';
const T1 = '2026-08-08T12:05:00.000Z';

const tempRoots = [];
function tempStateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-lane-test-'));
  tempRoots.push(root);
  return root;
}

// Snapshot of the REAL repo state dir: the whole suite must not touch it.
const REAL_STATE_DIR = path.join(__dirname, '..', 'state');
function listFilesUnder(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}
const realStateBefore = listFilesUnder(path.join(REAL_STATE_DIR, 'cloud-custody'));

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeExec(stdout, { exitCode = 0, stderr = '' } = {}) {
  const calls = [];
  const impl = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return { exitCode, stdout, stderr };
  };
  impl.calls = calls;
  return impl;
}

function fakeTransport({ createTaskResult, getTaskResult, diffText } = {}) {
  const calls = { createTask: [], getTask: [], fetchTaskDiff: [] };
  return {
    calls,
    async createTask(payload) { calls.createTask.push(payload); return createTaskResult; },
    async getTask(taskId) { calls.getTask.push(taskId); return getTaskResult; },
    async fetchTaskDiff(taskId, options) { calls.fetchTaskDiff.push({ taskId, options }); return diffText; }
  };
}

// git ls-tree -r -l -z fixture: 4 regular files, 2 gitlinks (the two modes-
// 160000 packages this repo really carries), 1 symlink. Sizes are padded the
// way real git pads them; records are NUL-separated.
const LS_TREE_FIXTURE = [
  `100644 blob ${OID('a')}     123\tREADME.md`,
  `100755 blob ${OID('b')}    4567\ttools/cloud-lane.js`,
  `100644 blob ${OID('c')}      89\tsrc/lib/cloud-agent/cloud-lane.js`,
  `160000 commit ${OID('d')}       -\tpackages/example-standalone`,
  `160000 commit ${OID('e')}       -\tpackages/example-standalone-v2-stage`,
  `100644 blob ${OID('f')}      55\tpackages/internal-vcs/src/index.js`,
  `120000 blob ${OID('0')}       7\tlegacy-symlink`
].join('\0') + '\0';

// The declared outbound territory for the fixture above. It is written out by
// hand ON PURPOSE: deriving it from the fixture is precisely the defect these
// tests now guard against, because a rule set computed from the payload permits
// whatever the payload happens to contain.
const OUTBOUND_ALLOWLIST = ['README.md', 'packages/*', 'src/*', 'tools/*'];

async function seedTaskRecord(stateRoot, expectation) {
  const transport = fakeTransport({ createTaskResult: { id: TASK_ID, status: 'queued' } });
  return lane.runSubmit({
    transport,
    env: 'env-main',
    branch: 'r1177/integration',
    expectPath: expectation.path,
    expectSha256: expectation.sha256,
    outboundProofId: null,
    stateRoot,
    submittedAt: T0
  });
}

(async () => {
  // --- outbound ----------------------------------------------------------------

  await asyncCheck('outbound builds a deterministic manifest, records gitlink/symlink exclusions honestly, and persists under the state root', async () => {
    const stateRoot = tempStateRoot();
    const execImpl = fakeExec(LS_TREE_FIXTURE);
    const { record, recordPath } = await lane.runOutbound({
      commit: COMMIT,
      branch: 'r1177/integration',
      remote: 'origin',
      repoRoot: 'C:/fake/repo',
      stateRoot,
      execImpl,
      createdAt: T0,
      allowlist: OUTBOUND_ALLOWLIST
    });

    assert.equal(execImpl.calls.length, 1, 'outbound runs exactly one git command');
    assert.equal(execImpl.calls[0].command, 'git');
    assert.deepEqual(execImpl.calls[0].args, ['ls-tree', '-r', '-l', '-z', COMMIT]);
    assert.equal(execImpl.calls[0].options.cwd, 'C:/fake/repo');

    assert.equal(record.entryCount, 4);
    assert.equal(record.totalBytes, 123 + 4567 + 89 + 55);
    assert.equal(record.allowlistSize, 4, 'README.md, packages/*, src/*, tools/*');
    assert.deepEqual(record.excluded, [
      { path: 'legacy-symlink', mode: '120000' },
      { path: 'packages/example-standalone', mode: '160000' },
      { path: 'packages/example-standalone-v2-stage', mode: '160000' }
    ], 'non-regular entries are excluded from the manifest but recorded, never silently dropped');

    const proof = validateOutboundProof(record.proof);
    assert.equal(proof.manifestId, record.manifestId);
    assert.equal(proof.sourceCommit, `git-sha1:${COMMIT}`);
    assert.equal(proof.branch, 'r1177/integration');
    assert.equal(proof.remoteLabel, 'origin');
    assert.equal(proof.createdAt, T0);

    assert.ok(recordPath.startsWith(path.join(stateRoot, 'outbound')), 'record lands under the injected state root');
    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual(persisted, JSON.parse(JSON.stringify(record)), 'the persisted record is the full record');

    // Determinism: identical tree + identical createdAt => identical ids.
    const again = await lane.runOutbound({
      commit: COMMIT, branch: 'r1177/integration', remote: 'origin',
      repoRoot: 'C:/fake/repo', stateRoot, execImpl: fakeExec(LS_TREE_FIXTURE), createdAt: T0,
      allowlist: OUTBOUND_ALLOWLIST
    });
    assert.equal(again.record.manifestId, record.manifestId);
    assert.equal(again.record.proof.proofId, record.proof.proofId);
    assert.equal(again.recordPath, recordPath);
  });

  check('deriveAllowlist still computes topdir/* per top-level directory, and that is exactly why it cannot police an outbound tree', () => {
    assert.deepEqual(
      lane.deriveAllowlist(['README.md', 'tools/cloud-lane.js', 'src/lib/a.js', 'src/lib/b.js', 'packages/x/y.js']),
      ['README.md', 'packages/*', 'src/*', 'tools/*']
    );
    // The tautology, asserted rather than described: a payload carrying a
    // secret manufactures the very rule that would permit the secret. This is
    // why the outbound path no longer calls it -- see the next two checks.
    assert.deepEqual(
      lane.deriveAllowlist(['src/app.js', 'secrets/deploy-key.pem']),
      ['secrets/*', 'src/*']
    );
  });

  await asyncCheck('outbound REFUSES a path outside the declared allowlist, and persists nothing when it does', async () => {
    const stateRoot = tempStateRoot();
    // The fixture contains tools/, src/, packages/ and README.md. Declaring
    // only src/* must reject the rest. Under the derived-allowlist design this
    // case was unreachable: every path generated its own permission.
    await rejectsWithCodeFromAnyError(lane.runOutbound({
      commit: COMMIT, branch: 'main', remote: 'origin', repoRoot: 'C:/fake/repo', stateRoot,
      execImpl: fakeExec(LS_TREE_FIXTURE), createdAt: T0, allowlist: ['src/*']
    }), 'CLOUD_ALLOWLIST_VIOLATION');
    assert.deepEqual(listFilesUnder(stateRoot), [], 'a refused outbound leaves no record behind');
  });

  await asyncCheck('outbound fails closed when no allowlist is declared, before it runs git at all', async () => {
    const stateRoot = tempStateRoot();
    for (const allowlist of [undefined, null, [], ['src/*', ''], 'src/*', [123]]) {
      const execImpl = fakeExec(LS_TREE_FIXTURE);
      await rejectsWithCode(lane.runOutbound({
        commit: COMMIT, branch: 'main', remote: 'origin', repoRoot: 'C:/fake/repo', stateRoot,
        execImpl, createdAt: T0, allowlist
      }), 'CLOUD_LANE_ALLOWLIST_REQUIRED');
      assert.equal(execImpl.calls.length, 0, `no git command runs for allowlist ${JSON.stringify(allowlist)}`);
    }
    assert.deepEqual(listFilesUnder(stateRoot), [], 'no record is persisted on any refusal');
  });

  await asyncCheck('outbound fails closed on a nonzero git exit and on unparseable ls-tree output', async () => {
    const stateRoot = tempStateRoot();
    await rejectsWithCode(lane.runOutbound({
      commit: COMMIT, branch: 'main', repoRoot: 'C:/fake/repo', stateRoot,
      execImpl: fakeExec('', { exitCode: 128, stderr: 'fatal: not a tree object' }), createdAt: T0,
      allowlist: OUTBOUND_ALLOWLIST
    }), 'CLOUD_LANE_GIT_FAILED');
    await rejectsWithCode(lane.runOutbound({
      commit: COMMIT, branch: 'main', repoRoot: 'C:/fake/repo', stateRoot,
      execImpl: fakeExec('not ls-tree output at all\0'), createdAt: T0,
      allowlist: OUTBOUND_ALLOWLIST
    }), 'CLOUD_LANE_LSTREE_UNPARSEABLE');
    await rejectsWithCode(lane.runOutbound({
      commit: 'HEAD', branch: 'main', repoRoot: 'C:/fake/repo', stateRoot,
      execImpl: fakeExec(LS_TREE_FIXTURE), createdAt: T0,
      allowlist: OUTBOUND_ALLOWLIST
    }), 'CLOUD_LANE_INPUT_INVALID');
    assert.deepEqual(listFilesUnder(stateRoot), [], 'no record is persisted on any failure');
  });

  // --- submit ------------------------------------------------------------------

  await asyncCheck('submit persists the full task record on an acknowledged task id', async () => {
    const stateRoot = tempStateRoot();
    const transport = fakeTransport({ createTaskResult: { id: TASK_ID, status: 'queued' } });
    const expectation = { path: 'docs/proofs/hello.txt', sha256: sha256Hex('hello custody loop\n') };
    const { record, recordPath } = await lane.runSubmit({
      transport,
      env: 'env-main',
      branch: 'r1177/integration',
      expectPath: expectation.path,
      expectSha256: expectation.sha256,
      outboundProofId: `sha256:${'1'.repeat(64)}`,
      stateRoot,
      submittedAt: T0
    });
    assert.deepEqual(transport.calls.createTask, [{ environment: 'env-main' }]);
    assert.equal(recordPath, path.join(stateRoot, 'tasks', `${TASK_ID}.json`));
    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual(persisted, {
      schemaVersion: lane.TASK_RECORD_SCHEMA,
      taskId: TASK_ID,
      env: 'env-main',
      branch: 'r1177/integration',
      expectation,
      outboundProofId: `sha256:${'1'.repeat(64)}`,
      submittedAt: T0,
      lastStatus: 'SUBMITTED',
      lastRawStatus: 'queued',
      checkedAt: T0
    });
    assert.deepEqual(persisted, JSON.parse(JSON.stringify(record)));
  });

  await asyncCheck('an unacknowledged submission fails closed and records nothing', async () => {
    const stateRoot = tempStateRoot();
    const transport = fakeTransport({ createTaskResult: null });
    await rejectsWithCode(lane.runSubmit({
      transport, env: 'env-main', branch: 'main',
      expectPath: 'docs/x.txt', expectSha256: sha256Hex('x'), stateRoot, submittedAt: T0
    }), 'CLOUD_LANE_SUBMIT_UNCONFIRMED');
    assert.deepEqual(listFilesUnder(stateRoot), [], 'an unknown submission outcome must never become a task record');
  });

  // --- status ------------------------------------------------------------------

  await asyncCheck('status maps provider statuses through STATUS_MAP semantics and unknown strings stay UNKNOWN, never success', async () => {
    const stateRoot = tempStateRoot();
    const { recordPath } = await seedTaskRecord(stateRoot, { path: 'docs/x.txt', sha256: sha256Hex('x') });

    const ready = await lane.runStatus({
      transport: fakeTransport({ getTaskResult: { id: TASK_ID, status: 'ready' } }),
      taskId: TASK_ID, stateRoot, checkedAt: T1
    });
    assert.deepEqual(ready, { taskId: TASK_ID, status: 'SUCCEEDED', rawStatus: 'ready', checkedAt: T1 });

    const weird = await lane.runStatus({
      transport: fakeTransport({ getTaskResult: { id: TASK_ID, status: 'somehow-finished-great' } }),
      taskId: TASK_ID, stateRoot, checkedAt: T1
    });
    assert.equal(weird.status, 'UNKNOWN');

    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(persisted.lastStatus, 'UNKNOWN');
    assert.equal(persisted.lastRawStatus, 'somehow-finished-great');
    assert.equal(persisted.checkedAt, T1);
  });

  await asyncCheck('status on an unknown task fails closed instead of inventing a record', async () => {
    await rejectsWithCode(lane.runStatus({
      transport: fakeTransport({ getTaskResult: { id: TASK_ID, status: 'ready' } }),
      taskId: 'task_e_neverSubmitted1', stateRoot: tempStateRoot(), checkedAt: T1
    }), 'CLOUD_LANE_TASK_RECORD_NOT_FOUND');
  });

  await asyncCheck('an unreadable task-record path is a read failure, not definite absence', async () => {
    const stateRoot = tempStateRoot();
    fs.mkdirSync(lane.taskRecordPath(stateRoot, TASK_ID), { recursive: true });
    await rejectsWithCode(lane.runStatus({
      transport: fakeTransport({ getTaskResult: { id: TASK_ID, status: 'ready' } }),
      taskId: TASK_ID, stateRoot, checkedAt: T1
    }), 'CLOUD_LANE_TASK_RECORD_READ_FAILED');
  });

  // --- verify: PASS paths ------------------------------------------------------

  const HELLO_CONTENT = 'hello custody loop\n';
  const HELLO_EXPECTATION = { path: 'docs/proofs/hello.txt', sha256: sha256Hex(HELLO_CONTENT) };
  const HELLO_DIFF = [
    'diff --git a/docs/proofs/hello.txt b/docs/proofs/hello.txt',
    'new file mode 100644',
    'index 0000000..2ef2f79',
    '--- /dev/null',
    '+++ b/docs/proofs/hello.txt',
    '@@ -0,0 +1 @@',
    '+hello custody loop',
    ''
  ].join('\n');

  await asyncCheck('verify PASS: exactly one pure-addition path matching the expectation byte-for-byte', async () => {
    const stateRoot = tempStateRoot();
    const { recordPath } = await seedTaskRecord(stateRoot, HELLO_EXPECTATION);
    const transport = fakeTransport({ diffText: HELLO_DIFF });
    const result = await lane.runVerify({ transport, taskId: TASK_ID, stateRoot, verifiedAt: T1 });
    assert.deepEqual(result, {
      taskId: TASK_ID,
      verdict: 'PASS',
      reasons: [],
      diffSha256: sha256Hex(HELLO_DIFF),
      changedPaths: ['docs/proofs/hello.txt']
    });
    assert.deepEqual(transport.calls.fetchTaskDiff, [{ taskId: TASK_ID, options: undefined }]);

    // Only metadata may be persisted: verdict, reasons, diffSha256,
    // changedPaths, verifiedAt on the task record -- never diff content.
    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(persisted.verdict, 'PASS');
    assert.equal(persisted.diffSha256, sha256Hex(HELLO_DIFF));
    assert.deepEqual(persisted.changedPaths, ['docs/proofs/hello.txt']);
    assert.equal(persisted.verifiedAt, T1);
    assert.ok(!JSON.stringify(persisted).includes('hello custody loop'), 'diff content must never reach the state record');
    assert.deepEqual(
      listFilesUnder(stateRoot),
      [recordPath],
      'verify writes nothing anywhere except the task record under the state root'
    );
  });

  await asyncCheck('verify PASS honors the no-trailing-newline marker exactly', async () => {
    const stateRoot = tempStateRoot();
    const content = 'alpha\nbeta'; // no trailing newline
    await seedTaskRecord(stateRoot, { path: 'notes/pair.txt', sha256: sha256Hex(content) });
    const diff = [
      'diff --git a/notes/pair.txt b/notes/pair.txt',
      'new file mode 100644',
      'index 0000000..53350c4',
      '--- /dev/null',
      '+++ b/notes/pair.txt',
      '@@ -0,0 +1,2 @@',
      '+alpha',
      '+beta',
      '\\ No newline at end of file',
      ''
    ].join('\n');
    const result = await lane.runVerify({
      transport: fakeTransport({ diffText: diff }), taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(result.reasons, []);
  });

  // --- verify: FAIL paths ------------------------------------------------------

  await asyncCheck('verify FAIL on an extra changed file', async () => {
    const stateRoot = tempStateRoot();
    await seedTaskRecord(stateRoot, HELLO_EXPECTATION);
    const diff = HELLO_DIFF + [
      'diff --git a/src/sneaky.js b/src/sneaky.js',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/src/sneaky.js',
      '@@ -0,0 +1 @@',
      "+module.exports = 'sneaky';",
      ''
    ].join('\n');
    const result = await lane.runVerify({
      transport: fakeTransport({ diffText: diff }), taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.changedPaths, ['docs/proofs/hello.txt', 'src/sneaky.js']);
    assert.ok(result.reasons.some((reason) => reason.startsWith('EXTRA_PATHS:')), `expected EXTRA_PATHS in ${result.reasons}`);
  });

  await asyncCheck('verify FAIL on content mismatch, with both hashes named', async () => {
    const stateRoot = tempStateRoot();
    const tampered = sha256Hex('what the owner actually expected\n');
    await seedTaskRecord(stateRoot, { path: 'docs/proofs/hello.txt', sha256: tampered });
    const result = await lane.runVerify({
      transport: fakeTransport({ diffText: HELLO_DIFF }), taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(result.verdict, 'FAIL');
    const mismatch = result.reasons.find((reason) => reason.startsWith('CONTENT_SHA256_MISMATCH:'));
    assert.ok(mismatch, `expected CONTENT_SHA256_MISMATCH in ${result.reasons}`);
    assert.ok(mismatch.includes(tampered) && mismatch.includes(sha256Hex(HELLO_CONTENT)), 'the reason names expected and reconstructed hashes');
  });

  await asyncCheck('verify FAIL on a deletion', async () => {
    const stateRoot = tempStateRoot();
    await seedTaskRecord(stateRoot, HELLO_EXPECTATION);
    const diff = [
      'diff --git a/docs/proofs/hello.txt b/docs/proofs/hello.txt',
      'deleted file mode 100644',
      'index 2ef2f79..0000000',
      '--- a/docs/proofs/hello.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-hello custody loop',
      ''
    ].join('\n');
    const result = await lane.runVerify({
      transport: fakeTransport({ diffText: diff }), taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.reasons.some((reason) => reason.startsWith('DELETION:')), `expected DELETION in ${result.reasons}`);
  });

  await asyncCheck('verify FAIL on an unparseable diff and on an empty diff', async () => {
    const stateRoot = tempStateRoot();
    await seedTaskRecord(stateRoot, HELLO_EXPECTATION);
    const garbage = await lane.runVerify({
      transport: fakeTransport({ diffText: 'a TUI progress table, not a diff at all\n' }),
      taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(garbage.verdict, 'FAIL');
    assert.ok(garbage.reasons.some((reason) => reason.startsWith('DIFF_UNPARSEABLE:')), `expected DIFF_UNPARSEABLE in ${garbage.reasons}`);
    assert.deepEqual(garbage.changedPaths, []);

    const empty = await lane.runVerify({
      transport: fakeTransport({ diffText: '' }), taskId: TASK_ID, stateRoot, verifiedAt: T1
    });
    assert.equal(empty.verdict, 'FAIL');
    assert.ok(empty.reasons.some((reason) => reason.startsWith('DIFF_EMPTY:')), `expected DIFF_EMPTY in ${empty.reasons}`);
  });

  check('verify FAIL on modification, rename, and mode change (unit level)', () => {
    const modification = [
      'diff --git a/docs/proofs/hello.txt b/docs/proofs/hello.txt',
      'index 2ef2f79..7f8a9b0 100644',
      '--- a/docs/proofs/hello.txt',
      '+++ b/docs/proofs/hello.txt',
      '@@ -1 +1 @@',
      '-hello custody loop',
      '+hello tampered loop',
      ''
    ].join('\n');
    const modResult = lane.verifyDiffAgainstExpectation(modification, HELLO_EXPECTATION);
    assert.equal(modResult.verdict, 'FAIL');
    assert.ok(modResult.reasons.some((reason) => reason.startsWith('NOT_A_NEW_FILE:')));
    assert.ok(modResult.reasons.some((reason) => reason.startsWith('NOT_PURE_ADDITION:')));

    const rename = [
      'diff --git a/docs/proofs/hello.txt b/docs/proofs/hello2.txt',
      'similarity index 100%',
      'rename from docs/proofs/hello.txt',
      'rename to docs/proofs/hello2.txt',
      ''
    ].join('\n');
    const renameResult = lane.verifyDiffAgainstExpectation(rename, HELLO_EXPECTATION);
    assert.equal(renameResult.verdict, 'FAIL');
    assert.ok(renameResult.reasons.some((reason) => reason.startsWith('RENAME_OR_COPY:')));

    const modeChange = [
      'diff --git a/docs/proofs/hello.txt b/docs/proofs/hello.txt',
      'old mode 100644',
      'new mode 100755',
      ''
    ].join('\n');
    const modeResult = lane.verifyDiffAgainstExpectation(modeChange, HELLO_EXPECTATION);
    assert.equal(modeResult.verdict, 'FAIL');
    assert.ok(modeResult.reasons.some((reason) => reason.startsWith('MODE_CHANGE:')));
  });

  // --- CLI arg parser ----------------------------------------------------------

  check('the CLI arg parser accepts exactly the documented flags and fails closed otherwise', () => {
    const parsed = cli.parseCliArgs(['outbound', '--commit', COMMIT, '--branch', 'r1177/integration', '--allowlist', 'src/*,tools/*', '--state-root', 'C:/tmp/x']);
    assert.equal(parsed.command, 'outbound');
    assert.deepEqual(parsed.options, { commit: COMMIT, branch: 'r1177/integration', allowlist: 'src/*,tools/*', 'state-root': 'C:/tmp/x' });

    for (const bad of [
      [],
      ['conquer'],
      ['outbound', '--commit', COMMIT],                                  // missing --branch
      ['outbound', '--commit', COMMIT, '--branch', 'main'],              // missing --allowlist: territory must be declared, never defaulted
      ['outbound', '--commit', COMMIT, '--branch', 'main', '--push', 'x'], // unknown flag
      ['outbound', '--commit', COMMIT, '--branch'],                      // missing value
      ['status'],                                                        // missing --task
      ['verify', '--task', TASK_ID, '--task', TASK_ID]                   // duplicate flag
    ]) {
      assert.throws(() => cli.parseCliArgs(bad), (error) => {
        assert.equal(error.code, 'CLOUD_LANE_USAGE', `expected usage rejection for ${JSON.stringify(bad)}`);
        return true;
      });
    }
  });

  // --- state isolation ---------------------------------------------------------

  check('the whole suite wrote only under temp state roots; the repo state/ is untouched', () => {
    assert.deepEqual(listFilesUnder(path.join(REAL_STATE_DIR, 'cloud-custody')), realStateBefore);
  });

  // resolveCodexBinary: the launch module returns { command, prefixArgs }, not
  // a bare path. Both dispatch and harvest hand a STRING to a spawn that
  // self-detects a .js entry, so the object must be unpacked -- passing it
  // straight through spawned `[object Object]` as a module path and errored
  // every fetch of a 144-task harvest. These pin the unpack and the refusal.
  check('resolveCodexBinary passes a string binary through untouched', () => {
    assert.equal(cli.resolveCodexBinary('C:/x/codex.exe'), 'C:/x/codex.exe');
  });
  check('resolveCodexBinary unpacks the launch bundle to its command string', () => {
    assert.equal(cli.resolveCodexBinary({ command: 'C:/y/codex.exe', prefixArgs: [] }), 'C:/y/codex.exe');
  });
  check('resolveCodexBinary refuses a bundle needing prefix args rather than dropping them', () => {
    assert.throws(() => cli.resolveCodexBinary({ command: 'node', prefixArgs: ['--flag'] }),
      (error) => error && error.code === 'CLOUD_DISPATCH_PREFIXED_BINARY');
  });

  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`cloud-lane tests passed (${checks} checks: deterministic outbound manifest with honest gitlink/symlink exclusion, mechanical allowlist, git/ls-tree fail-closed paths, submit record persistence, unconfirmed-submit refusal, STATUS_MAP semantics with unknown->UNKNOWN, verify PASS incl. no-newline marker, verify FAIL on extra path/content mismatch/deletion/unparseable/empty/modification/rename/mode-change, CLI arg parsing, and real-state isolation).`);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
