'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const provenance = require('../src/lib/build-queue-provenance');

const effects = [];
const restores = [];

function rejectEffect(target, method) {
  const original = target[method];
  target[method] = (...args) => {
    effects.push({ method, args });
    throw new Error(`unexpected side effect: ${method}`);
  };
  restores.push(() => { target[method] = original; });
}

for (const method of ['writeFileSync', 'appendFileSync', 'createWriteStream']) {
  rejectEffect(fs, method);
}
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']) {
  rejectEffect(childProcess, method);
}

try {
  const invalidMarkdown = { lines: ['## Q1 — not actually markdown text'] };
  assert.throws(
    () => provenance.auditQueueProvenance({
      sources: [{ file: 'BUILD-QUEUE.md', markdown: invalidMarkdown }],
      ledger: { requests: [{ id: 'R100', status: 'done' }] }
    }),
    error => {
      assert.equal(error.name, 'BuildQueueProvenanceError');
      assert.equal(error.code, 'QUEUE_PROVENANCE_TEXT_INVALID');
      assert.equal(error.message, 'BUILD-QUEUE.md: queue markdown must be text.');
      return true;
    },
    'non-text queue input must refuse rather than be interpreted or coerced'
  );
  assert.deepEqual(effects, [], 'invalid queue text must not write or spawn');

  const result = provenance.auditQueueProvenance({
    sources: [{
      file: 'BUILD-QUEUE.md',
      markdown: [
        '## Q7 — A phase owned by another directive',
        '',
        '**Status:** OPEN',
        '',
        '**Authority:** Owner request R101; directiveId: build-other-thing',
        ''
      ].join('\n')
    }],
    ledgerSource: 'fixture-ledger.json',
    ledger: {
      revision: 19,
      requests: [
        { id: 'R100', status: 'open' },
        { id: 'R101', status: 'done' }
      ]
    }
  });

  assert.deepEqual(result.orphanDirectives, [{
    code: 'DIRECTIVE_QUEUED_NOWHERE',
    severity: 'warn',
    rid: 'R100',
    status: 'open',
    message: 'R100 is open in fixture-ledger.json but no queue phase names it.'
  }]);
  assert.equal(result.orphanDirectiveCount, 1);
  assert.equal(result.actionableDirectiveCount, 1);
  assert.deepEqual(result.findings, [], 'the reverse-link refusal is separate from phase findings');
  assert.equal(result.clean, true, 'warnings do not make the error-only clean field false');
  assert.deepEqual(effects, [], 'an orphan-directive refusal must not write or spawn');
} finally {
  while (restores.length) restores.pop()();
}

console.log('ok - driven build queue provenance refusals preserve side-effect freedom');
