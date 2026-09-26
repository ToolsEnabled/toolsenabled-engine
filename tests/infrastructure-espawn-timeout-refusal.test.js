'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const infrastructure = require('../src/lib/providers/infrastructure');

const alias = 'timeout-account';
const email = 'timeout-account@example.com';
const registry = {
  resolve: selector => {
    assert.equal(selector, alias);
    return alias;
  },
  load: () => ({ accounts: { [alias]: { email } } }),
  list: () => [{ alias, email, authorized: true }]
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'infrastructure-espawn-timeout-'));
try {
  const spawnAttempts = [];
  const auditCalls = [];
  const output = infrastructure.gcloudAccountInspect({ account: alias }, {
    accountRegistry: registry,
    assertActive: () => {},
    gcloudAvailable: () => true,
    now: () => 1_800_000_000_000,
    run: (command, args, options) => {
      spawnAttempts.push({ command, args: [...args], options });
      const error = new Error('injected process launch timeout');
      error.code = 'ESPAWN_TIMEOUT';
      throw error;
    },
    record: (...args) => auditCalls.push(args)
  });

  assert.deepEqual(output.gcloud.identity, { status: 'unknown', reason: 'timeout' },
    'an ESPAWN_TIMEOUT from the driven command boundary must remain an unknown timeout');
  assert.deepEqual(output.projectDiscovery, {
    status: 'unknown', reason: 'gcloud_identity_unavailable', returned: 0, truncated: false
  });
  assert.deepEqual(output.projects, [], 'the refusal must not manufacture project facts');
  assert.equal(output.readOnly, true);
  assert.equal(output.activeConfigChanged, false);

  assert.equal(spawnAttempts.length, 1,
    'after the auth launch refuses, no project, billing, service, or IAM command may be spawned');
  assert.deepEqual(spawnAttempts[0].args, ['auth', 'list', '--format=json']);
  assert.equal(spawnAttempts[0].command, 'gcloud');
  assert.equal(spawnAttempts[0].options.env.CLOUDSDK_CORE_DISABLE_PROMPTS, '1');
  assert.deepEqual(fs.readdirSync(scratch), [], 'the refusal must not write filesystem output');
  assert.equal(auditCalls.length, 1, 'the refusal still emits its metadata-only audit event');
  assert.equal(JSON.stringify(auditCalls).includes(email), false, 'the refusal audit must not write account identity');

  console.log('infrastructure ESPAWN_TIMEOUT refusal test passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
