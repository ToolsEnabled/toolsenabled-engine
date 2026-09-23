'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TrustedArtifactResolverError,
  resolveTrustedArtifacts,
  resolveTrustedArtifactSnapshot,
  validateTrustedArtifactSnapshot,
  verifyTrustedArtifactSnapshot
} = require('../src/lib/coordinator-workflow/trusted-artifacts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-artifacts-test-'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectCode(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof TrustedArtifactResolverError);
    assert.equal(error.code, code);
    return true;
  });
}

function run() {
  const runId = 'run-001';
  const workspacePath = `${runId}/worker`;
  const workspace = path.join(root, runId, 'worker');
  fs.mkdirSync(path.join(workspace, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'evidence', 'result.txt'), 'trusted result\n');
  fs.writeFileSync(path.join(workspace, 'evidence', 'tests.log'), 'all checks passed\n');

  const request = {
    trustedRoot: root,
    runId,
    workspacePath,
    artifacts: [
      { artifactId: 'tests', path: 'evidence/tests.log', kind: 'test_log' },
      { artifactId: 'result', path: 'evidence/result.txt', kind: 'text' }
    ]
  };

  const resolved = resolveTrustedArtifacts(request);
  assert.deepEqual(resolved.map(item => item.artifactId), ['result', 'tests']);
  assert.deepEqual(resolved.map(item => item.sha256), [
    sha256('trusted result\n'),
    sha256('all checks passed\n')
  ]);
  assert.deepEqual(resolved.map(item => item.sizeBytes), [15, 18]);

  expectCode(() => resolveTrustedArtifacts({
    ...request,
    artifacts: [{ ...request.artifacts[0], sha256: '0'.repeat(64) }]
  }), 'COORDINATOR_WORKFLOW_UNKNOWN_KEY');

  const captured = resolveTrustedArtifactSnapshot(request);
  assert.deepEqual(captured.artifacts, resolved);
  assert.deepEqual(validateTrustedArtifactSnapshot(captured.snapshot), captured.snapshot);
  assert.deepEqual(verifyTrustedArtifactSnapshot(captured.snapshot), captured);

  fs.writeFileSync(path.join(workspace, 'evidence', 'result.txt'), 'forged result!\n');
  expectCode(
    () => verifyTrustedArtifactSnapshot(captured.snapshot),
    'COORDINATOR_WORKFLOW_ARTIFACT_SNAPSHOT_MISMATCH'
  );
}

try {
  run();
  process.stdout.write('coordinator-workflow-trusted-artifacts: behaviour checks passed\n');
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
