'use strict';

// End-to-end reader coverage for the provenance audit. The corpus and ledger
// are installation-shaped, but owned by this test so a fresh clone exercises
// the real root/index/slice loaders without importing personal machine state.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const corpus = require('../src/lib/build-queue-corpus');
const provenance = require('../src/lib/build-queue-provenance');
const cli = require('../tools/build-queue-provenance.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-provenance-live-'));
const queueFile = path.join(root, 'BUILD-QUEUE.md');
const ledgerFile = path.join(root, 'OWNER-REQUEST-LEDGER.json');

function assertPhantomSummary(result) {
  const findingRids = [...new Set(result.findings
    .filter(finding => finding.code === 'PHANTOM_RID' || finding.code === 'PHANTOM_DECISION_DOC')
    .map(finding => finding.rid))];
  assert.deepEqual(result.phantomRids, findingRids, 'phantomRids exactly summarizes phantom findings');
}

try {
  fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE',
    '',
    corpus.renderQueueIndex(['fleet']).trimEnd(),
    '## Q1 \u2014 Known directive',
    '',
    '**Status:** OPEN',
    '',
    '**Authority:** R100 (directiveId: known-fixture)',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'queue', 'fleet.md'), [
    '## Q2 \u2014 Phantom directive',
    '',
    '**Status:** BLOCKED fixture',
    '',
    '**Authority:** R999 (directiveId: phantom-fixture)',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(ledgerFile, `${JSON.stringify({
    revision: 7,
    requests: [
      { id: 'R100', status: 'open' },
      { id: 'R101', status: 'done' },
      { id: 'R102', status: 'partial' }
    ]
  }, null, 2)}\n`, 'utf8');

  const sources = cli.loadCorpusSources(queueFile);
  const ledger = cli.loadLedger(ledgerFile);
  const result = provenance.auditQueueProvenance({ sources, ledger, ledgerSource: 'fixture-ledger.json' });

  assert.deepEqual(sources.map(source => source.file), ['BUILD-QUEUE.md', 'queue/fleet.md']);
  assert.equal(result.phaseCount, 2, 'both the root and indexed slice are audited');
  assert.equal(result.pendingPhaseCount, 2, 'both fixture phases remain actionable');
  assert.equal(result.errorCount, 1, 'the phantom citation remains a security error');
  assert.deepEqual(result.phantomRids, ['R999']);
  assertPhantomSummary(result);
  assert.deepEqual(
    result.orphanDirectives.map(entry => entry.rid),
    ['R102'],
    'an actionable ledger request cited by no queue phase remains visible as an orphan'
  );
  assert.equal(result.actionableDirectiveCount, 2);
  assert.equal(result.orphanDirectiveCount, 1);
  assert.equal(result.clean, false, 'a phantom citation can never be reported clean');

  console.log('build-queue-provenance-live: owned root/index/slice and ledger audit passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
