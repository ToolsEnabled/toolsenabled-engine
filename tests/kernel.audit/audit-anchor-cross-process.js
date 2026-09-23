'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

for (const name of ['TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_AUDIT_JSONL_PATH', 'TOOLSENABLED_AUDIT_TEXT_PATH', 'TOOLSENABLED_VAULT_PATH']) {
  if (!path.isAbsolute(process.env[name] || '')) throw new Error(`${name} must be isolated before this test runs.`);
}

const audit = require('../../src/lib/audit');
try {
  assert.equal(audit.status().headSequence, 0, 'parent should cache the initial empty protected head');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'audit-anchor-writer.js')], {
    cwd: path.resolve(__dirname, '..', '..'), env: process.env, encoding: 'utf8', windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);

  const db = new DatabaseSync(process.env.TOOLSENABLED_AUDIT_DB);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; DELETE FROM audit_events;');
    db.prepare(`UPDATE audit_sink_state SET last_sequence = 0, last_hash = ?, failure_count = 0,
      retry_at_ms = NULL, last_error = NULL`).run('0'.repeat(64));
    db.exec('COMMIT;');
  } finally { db.close(); }
  fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_JSONL_PATH, '', 'utf8');
  fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_TEXT_PATH, '', 'utf8');

  const verification = audit.verify();
  assert.equal(verification.valid, false,
    'verification must reread the cross-process DPAPI anchor instead of trusting the cached empty head');
  assert.match(verification.error || '', /protected audit head|canonical ledger/i);
  console.log('Cross-process protected-head cache test passed.');
} finally {
  audit.resetForTests();
}
