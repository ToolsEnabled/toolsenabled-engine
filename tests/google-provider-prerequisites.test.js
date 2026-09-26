'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const taxonomy = require('../src/lib/error-taxonomy');

test('native Firebase doctor cannot claim an authentication observation when its CLI is absent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-doctor-absent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'empty-bin');
  fs.mkdirSync(bin);
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnSync(finder, [finder], { encoding: 'utf8' });
  assert.equal(located.status, 0, located.stderr);
  // Preserve the real native lookup executable, so absence is measured
  // rather than inferred from an unavailable lookup command.
  const target = path.join(bin, finder);
  fs.copyFileSync(fs.realpathSync(located.stdout.trim().split(/\r?\n/)[0]), target);
  fs.chmodSync(target, 0o755);
  const provider = require.resolve('../src/lib/providers/firebase');
  const result = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(provider)}).doctor()));`], {
    env: { ...process.env, PATH: bin, TOOLSENABLED_STATE_ROOT: path.join(root, 'state') }, cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { firebase: false, gcloud: false, terraform: false, authenticatedFirebase: null });
});

test('known Google setup prerequisites require input while real tool approvals and outages retain their behavior', () => {
  for (const code of ['GOOGLE_ACCOUNT_NOT_AUTHORIZED', 'GCLOUD_LOGIN_UNAVAILABLE', 'FIREBASE_UNAVAILABLE']) {
    const failure = taxonomy.publicFailure(taxonomy.adaptProviderError({ code, message: 'source prose cannot set retry policy' }));
    assert.equal(failure.code, 'INPUT_REQUIRED', code);
    assert.equal(failure.retryable, false, code);
    assert.equal(failure.retryAfterMs, undefined, code);
    assert.equal(taxonomy.decideRetry(failure, { attempt: 1, effect: 'local-read' }).disposition, 'blocked');
  }
  for (const [code, expected, retryable] of [
    ['PURCHASE_NOT_AUTHORIZED', 'APPROVAL_REQUIRED', false],
    ['APPROVAL_REQUIRED', 'APPROVAL_REQUIRED', false],
    ['ECONNREFUSED', 'UNAVAILABLE', true],
    ['OWNER_PROMPT_RUNNER_UNAVAILABLE', 'UNAVAILABLE', true]
  ]) {
    const failure = taxonomy.publicFailure(taxonomy.adaptProviderError({ code }));
    assert.equal(failure.code, expected, code);
    assert.equal(failure.retryable, retryable, code);
  }
});
