'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const store = require('../src/lib/owner-request-scope-store');

const rule = (index = 'new') => ({
  schemaVersion: 1,
  ruleId: `rule_refusal_${index}`,
  ruleKey: `refusal.${index}`,
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-27T00:00:00.000Z',
  expiresAt: null,
  decisionSummary: `Refusal fixture ${index}.`,
  evidenceRefs: [],
  ownerVerbatim: 'Keep refusal paths fail closed.'
});

function refusal(work, expected) {
  return assert.throws(work, error => {
    assert.equal(error?.name, 'OwnerRequestScopeStoreError');
    assert.equal(error?.code, expected);
    return true;
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-scope-store-refusals-'));
try {
  // Reading an on-disk store with a future schema must refuse rather than
  // silently treating it as empty, migrating it, or rewriting its bytes.
  const versionFile = path.join(root, 'future.json');
  const futureBytes = '{"schemaVersion":2,"revision":9,"rules":[]}\n';
  fs.writeFileSync(versionFile, futureBytes);
  refusal(() => store.readScopeStore({ file: versionFile }),
    'OWNER_SCOPE_STORE_VERSION_UNSUPPORTED');
  assert.equal(fs.readFileSync(versionFile, 'utf8'), futureBytes);
  assert.equal(fs.existsSync(`${versionFile}.lock`), false);

  // Fill the real persisted representation to its exported limit, then drive
  // append through parsing/normalization and the capacity check. The rejected
  // rule must not change the store and the append lock must still be released.
  const fullFile = path.join(root, 'full.json');
  const fullBytes = `${JSON.stringify({
    schemaVersion: 1,
    revision: store.MAX_RULES,
    rules: Array.from({ length: store.MAX_RULES }, (_, index) => rule(index))
  })}\n`;
  fs.writeFileSync(fullFile, fullBytes);
  refusal(() => store.appendScopeRule({
    rule: rule(), ownerEventRef: 'R173', expectedRevision: store.MAX_RULES
  }, { file: fullFile }), 'OWNER_SCOPE_STORE_FULL');
  assert.equal(fs.readFileSync(fullFile, 'utf8'), fullBytes);
  assert.equal(fs.existsSync(`${fullFile}.lock`), false);

  // Inject a failure at the atomic commit boundary. This exercises writeAtomic
  // through appendScopeRule (rather than calling an internal helper), proving
  // that the old durable file survives and both temporary and lock files are
  // cleaned up. Also guard the process boundary: a persistence refusal must
  // not attempt to spawn recovery work.
  const writeFile = path.join(root, 'write-failure.json');
  const originalBytes = `${JSON.stringify({ schemaVersion: 1, revision: 0, rules: [] })}\n`;
  fs.writeFileSync(writeFile, originalBytes);
  const originalRenameSync = fs.renameSync;
  const originalSpawnSync = childProcess.spawnSync;
  let spawnCalls = 0;
  let commitAttempts = 0;
  fs.renameSync = (source, destination) => {
    // Fail the store commit, after the real process-claim lock has acquired.
    // The lock also publishes records by rename; those are not this boundary.
    if (destination !== writeFile) return originalRenameSync(source, destination);
    commitAttempts += 1;
    const error = new Error('injected atomic rename failure');
    error.code = 'EIO';
    throw error;
  };
  childProcess.spawnSync = () => {
    spawnCalls += 1;
    throw new Error('unexpected spawn');
  };
  try {
    refusal(() => store.appendScopeRule({
      rule: rule(), ownerEventRef: 'R173', expectedRevision: 0
    }, { file: writeFile }), 'OWNER_SCOPE_STORE_WRITE_FAILED');
  } finally {
    fs.renameSync = originalRenameSync;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.equal(commitAttempts, 1);
  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(writeFile, 'utf8'), originalBytes);
  assert.equal(fs.existsSync(`${writeFile}.lock`), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);

  process.stdout.write('owner request scope store refusal tests passed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
