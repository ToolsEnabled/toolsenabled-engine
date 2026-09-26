/* Mutation check:
 * Changed releaseQuarantine's `record.quarantined = false` to `true` in policy.js.
 * The edit landed: yes.
 * This isolated test went red with exit code 1: yes.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyQuarantine,
  isQuarantined,
  quarantineDetail,
  releaseQuarantine
} = require('../src/lib/supervision/policy.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-policy-firsttest2-'));
const file = path.join(directory, 'policy.json');
const subsystem = 'firsttest2-fixture';

try {
  const applied = applyQuarantine(subsystem, 'three recent failures', {
    file,
    nowMs: 1_725_000_000_000
  });

  assert.deepEqual(applied, {
    reason: 'three recent failures',
    quarantinedAtMs: 1_725_000_000_000,
    attempts: 0
  });
  assert.equal(isQuarantined(subsystem, { file }), true);

  const release = releaseQuarantine(subsystem, {
    file,
    releasedBy: 'operator@example.test',
    nowMs: 1_725_000_000_500
  });

  assert.deepEqual(release, {
    released: true,
    reason: 'firsttest2-fixture released from quarantine by operator@example.test'
  });
  assert.equal(isQuarantined(subsystem, { file }), false,
    'releaseQuarantine must durably clear the quarantine flag');
  assert.equal(quarantineDetail(subsystem, { file }), null,
    'a released subsystem must no longer expose quarantine details');

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')).subsystems[subsystem];
  assert.equal(persisted.quarantined, false);
  assert.equal(persisted.quarantineReason, null);
  assert.equal(persisted.quarantinedAtMs, null);
  assert.deepEqual(persisted.attempts, []);
  assert.equal(persisted.releasedBy, 'operator@example.test');
  assert.equal(persisted.releasedAtMs, 1_725_000_000_500);

  assert.deepEqual(releaseQuarantine(subsystem, { file }), {
    released: false,
    reason: 'firsttest2-fixture is not quarantined'
  }, 'releasing an already released subsystem must be a no-op');

  process.stdout.write('ok - explicit quarantine release clears durable policy state and records its operator\n');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
