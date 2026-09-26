'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const name of [
  'TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_AUDIT_JSONL_PATH', 'TOOLSENABLED_AUDIT_TEXT_PATH',
  'TOOLSENABLED_AUDIT_EMERGENCY_PATH', 'TOOLSENABLED_VAULT_PATH'
]) {
  if (!path.isAbsolute(process.env[name] || '')) throw new Error(`${name} must be isolated before this test runs.`);
}

const audit = require('../../src/lib/audit');
const records = 1159;
const source = Array.from({ length: records }, (_, index) => JSON.stringify({
  timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
  action: 'legacy.scale', target: `record-${index + 1}`, details: { index }
})).join('\n') + '\n';
fs.mkdirSync(path.dirname(process.env.TOOLSENABLED_AUDIT_JSONL_PATH), { recursive: true });
fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_JSONL_PATH, source, 'utf8');
fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_TEXT_PATH, 'legacy text duplicate\n', 'utf8');

const started = Date.now();
try {
  const status = audit.status();
  const elapsedMs = Date.now() - started;
  assert.equal(status.headSequence, records);
  assert.equal(status.anchor.sequence, records);
  assert.equal(status.anchor.reconciled, true);
  assert.ok(elapsedMs < 30_000, `bulk migration took ${elapsedMs}ms; it likely regressed to per-event vault checkpoints`);
  const verification = audit.verify();
  assert.equal(verification.valid, true);
  assert.equal(verification.entries, records);
  const archive = fs.readdirSync(path.dirname(process.env.TOOLSENABLED_AUDIT_JSONL_PATH))
    .find(name => name.startsWith(`${path.basename(process.env.TOOLSENABLED_AUDIT_JSONL_PATH)}.legacy-`));
  assert.ok(archive);
  assert.equal(fs.readFileSync(path.join(path.dirname(process.env.TOOLSENABLED_AUDIT_JSONL_PATH), archive), 'utf8'), source);
  console.log(`Bulk legacy audit migration test passed (${records} records in ${elapsedMs}ms).`);
} finally {
  audit.resetForTests();
}
