'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const {
  parseArgs,
  targetIdsForPolicy,
  applyLegacyDottedMigration,
  main
} = require('../tools/legacy-dotted-migration');
const {
  TEST_MIGRATION_POLICY,
  buildLegacyDottedLedgerFixture
} = require('./fixtures/legacy-dotted-ledger');

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
};
const expectCode = (fn, expected) => assert.throws(fn, error => error && error.code === expected);

const root = path.resolve(__dirname, '..');
const original = buildLegacyDottedLedgerFixture();
const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
const targetIds = targetIdsForPolicy(TEST_MIGRATION_POLICY);
const tempRoot = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-dotted-policy-'));
const policyFile = path.join(tempRoot, 'migration-policy.json');
fs.writeFileSync(policyFile, JSON.stringify(TEST_MIGRATION_POLICY, null, 2), 'utf8');

function withoutMigrationMetadata(entry) {
  const result = structuredClone(entry);
  delete result.versioningNote;
  delete result.versioningDisposition;
  return result;
}

try {
  check('arguments accept an optional explicit policy and refuse ambiguous modes', () => {
    assert.deepEqual(parseArgs(['--check']).policy, null);
    assert.equal(parseArgs(['--write', '--ledger', path.join(tempRoot, 'ledger.json'), '--policy', policyFile]).policy, policyFile);
    expectCode(() => parseArgs([]), 'LEGACY_DOTTED_USAGE');
    expectCode(() => parseArgs(['--check', '--write']), 'LEGACY_DOTTED_USAGE');
    expectCode(() => parseArgs(['--write', '--other']), 'LEGACY_DOTTED_USAGE');
    expectCode(() => parseArgs(['--check', '--policy', policyFile, '--policy', policyFile]), 'LEGACY_DOTTED_USAGE');
  });

  check('neutral migration is a no-op even when numeric ids resemble another installation', () => {
    const neutral = applyLegacyDottedMigration(original, { updatedAt: '2026-08-07' });
    assert.equal(neutral.changed, false);
    assert.deepEqual(neutral.changedIds, []);
    assert.deepEqual(neutral.targetIds, []);
    assert.equal(neutral.ledger, original);
  });

  const projected = applyLegacyDottedMigration(original, {
    policy: TEST_MIGRATION_POLICY,
    updatedAt: '2026-08-07'
  });

  check('explicit policy changes exactly its declared active targets', () => {
    assert.equal(projected.changed, true);
    assert.deepEqual([...projected.changedIds].sort(), [...targetIds].sort());
    assert.equal(projected.changedIds.length, targetIds.length);
    assert.equal(projected.ledger.revision, original.revision + 1);
    assert.equal(projected.ledger.requests.length, original.requests.length);
  });

  check('all source request fields remain unchanged', () => {
    for (const before of original.requests) {
      const after = projected.ledger.requests.find(entry => entry.id === before.id);
      assert.deepEqual(withoutMigrationMetadata(after), before, before.id);
      assert.equal(after.verbatim, before.verbatim, `${before.id} verbatim`);
      assert.deepEqual(after.gates, before.gates, `${before.id} gates`);
    }
  });

  check('declared continuations carry only neutral policy metadata', () => {
    const continuations = projected.ledger.requests.filter(entry =>
      entry.versioningDisposition?.kind === 'legacy-continuation');
    assert.equal(continuations.length, TEST_MIGRATION_POLICY.continuationIds.length);
    for (const entry of continuations) {
      assert.equal(entry.versioningNote, TEST_MIGRATION_POLICY.continuationNote);
      assert.equal(entry.versioningDisposition.policyDeclared, true);
      assert.equal(entry.versioningDisposition.participatesInVersionLineage, false);
      assert.equal(entry.versioningDisposition.provenanceBasis, TEST_MIGRATION_POLICY.provenanceBasis);
      assert.deepEqual(Reflect.ownKeys(entry.versioningDisposition).sort(),
        ['kind', 'participatesInVersionLineage', 'policyDeclared', 'provenanceBasis', 'schemaVersion'].sort());
    }
  });

  check('declared duplicate versions retain both original gate histories', () => {
    const merges = projected.ledger.requests.filter(entry =>
      entry.versioningDisposition?.kind === 'legacy-duplicate-version-merge');
    assert.equal(merges.length, TEST_MIGRATION_POLICY.duplicatePairs.length);
    for (const entry of merges) {
      const metadata = entry.versioningDisposition;
      assert.equal(metadata.gateHistories.length, 2, `${entry.id} gate history count`);
      assert.equal(entry.id, metadata.activeId);
      assert.deepEqual(metadata.sourceIds, [metadata.rootId, metadata.activeId]);
      assert.deepEqual(metadata.supersededIds, [metadata.rootId]);
      assert.equal(metadata.provenanceBasis, TEST_MIGRATION_POLICY.provenanceBasis);
      for (const history of metadata.gateHistories) {
        assert.deepEqual(history.gates, original.requests.find(source => source.id === history.requestId).gates || []);
      }
    }
  });

  check('the conflicting pair resolves to its policy-declared active source', () => {
    const [, activeId] = TEST_MIGRATION_POLICY.duplicatePairs[1];
    const metadata = projected.ledger.requests.find(entry => entry.id === activeId).versioningDisposition;
    assert.equal(metadata.gateState, 'resolved-to-active-version');
    assert.equal(metadata.conflictingGateCount, 3);
    assert.equal(metadata.mergedGates.length, 3);
    assert.equal(metadata.mergedGates.every(gate => gate.sourceConflict === true && gate.met === true), true);
    assert.equal(metadata.mergedGates.every(gate => gate.effectiveSource.requestId === activeId), true);
  });

  check('the pure migration is idempotent for the same explicit policy', () => {
    const replay = applyLegacyDottedMigration(projected.ledger, {
      policy: TEST_MIGRATION_POLICY,
      updatedAt: '2026-08-08'
    });
    assert.equal(replay.changed, false);
    assert.deepEqual(replay.changedIds, []);
    assert.equal(replay.ledger, projected.ledger);
  });

  check('partial or conflicting policy metadata fails closed', () => {
    const firstTarget = targetIds[0];
    const partial = structuredClone(original);
    const partialTarget = partial.requests.find(entry => entry.id === firstTarget);
    const appliedTarget = projected.ledger.requests.find(entry => entry.id === firstTarget);
    partialTarget.versioningNote = appliedTarget.versioningNote;
    partialTarget.versioningDisposition = appliedTarget.versioningDisposition;
    expectCode(() => applyLegacyDottedMigration(partial, { policy: TEST_MIGRATION_POLICY }), 'LEGACY_DOTTED_PARTIAL_STATE');

    const conflict = structuredClone(projected.ledger);
    conflict.requests.find(entry => entry.id === firstTarget).versioningNote = 'different';
    expectCode(() => applyLegacyDottedMigration(conflict, { policy: TEST_MIGRATION_POLICY }), 'LEGACY_DOTTED_METADATA_CONFLICT');
  });

  check('--write uses a byte-identical backup only with explicit policy', () => {
    const file = path.join(tempRoot, 'ledger.json');
    fs.writeFileSync(file, originalRaw, 'utf8');
    const priorExitCode = process.exitCode;
    const output = main(['--write', '--ledger', file, '--policy', policyFile]);
    process.exitCode = priorExitCode;
    assert.equal(output.changed, true);
    assert.equal(output.targetCount, targetIds.length);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), originalRaw);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.revision, original.revision + 1);
    assert.equal(written.requests.find(entry => entry.id === targetIds[0]).versioningNote, TEST_MIGRATION_POLICY.continuationNote);
    assert.equal(fs.existsSync(`${file}.lock`), false);

    const backupBeforeReplay = fs.readFileSync(`${file}.bak`, 'utf8');
    const replay = main(['--write', '--ledger', file, '--policy', policyFile]);
    process.exitCode = priorExitCode;
    assert.equal(replay.changed, false);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), backupBeforeReplay);
  });

  check('--check is read-only and reports policy-dependent pending state', () => {
    const pendingFile = path.join(tempRoot, 'pending.json');
    const appliedFile = path.join(tempRoot, 'applied.json');
    fs.writeFileSync(pendingFile, originalRaw, 'utf8');
    fs.writeFileSync(appliedFile, JSON.stringify(projected.ledger, null, 2), 'utf8');
    const pendingBefore = fs.readFileSync(pendingFile, 'utf8');
    const tool = path.join(root, 'tools', 'legacy-dotted-migration.js');
    const pending = spawnSync(process.execPath, [tool, '--check', '--ledger', pendingFile, '--policy', policyFile], { encoding: 'utf8', windowsHide: true });
    const applied = spawnSync(process.execPath, [tool, '--check', '--ledger', appliedFile, '--policy', policyFile], { encoding: 'utf8', windowsHide: true });
    const neutral = spawnSync(process.execPath, [tool, '--check', '--ledger', pendingFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(pending.status, 1, pending.stderr);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(neutral.status, 0, neutral.stderr);
    assert.deepEqual(JSON.parse(pending.stdout).changed, true);
    assert.deepEqual(JSON.parse(applied.stdout).changed, false);
    assert.deepEqual({ changed: JSON.parse(neutral.stdout).changed, targetCount: JSON.parse(neutral.stdout).targetCount },
      { changed: false, targetCount: 0 });
    assert.equal(fs.readFileSync(pendingFile, 'utf8'), pendingBefore);
    assert.equal(fs.existsSync(`${pendingFile}.bak`), false);
  });

  console.log(`legacy-dotted-migration: ${checks} checks passed`);
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  if (!resolvedTemp.startsWith(path.resolve(isolatedTemporaryRoot()))) throw new Error('Refusing to remove a non-temporary path.');
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
