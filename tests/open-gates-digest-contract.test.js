/* Mutation check (2026-08-27):
 * Changed the module heading `## Authorizations on file` to
 * `## Authorizations MUTATED on file`.
 * The edit landed, and this isolated test went red (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');

const contract = require('../src/lib/open-gates-digest-contract');

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

function completeDigest() {
  return [
    contract.heading('title'),
    'Open gates: 2',
    'Authorizations in force: 1',
    'Ledger revision: 42',
    ...contract.OPEN_GATES_SECTIONS.slice(1).map(section => section.heading)
  ].join('\n');
}

check('exports the immutable section and header-line contract', () => {
  assert.deepEqual(contract.OPEN_GATES_SECTIONS.map(section => section.id), [
    'title', 'authority', 'authorizations', 'active', 'unresolved',
    'superseded-clauses', 'superseded', 'retired-clauses', 'retired', 'unmapped'
  ]);
  assert.deepEqual(contract.OPEN_GATES_REQUIRED_LINES, [
    'Open gates:', 'Authorizations in force:', 'Ledger revision:'
  ]);
  assert.ok(Object.isFrozen(contract.OPEN_GATES_SECTIONS));
  assert.ok(contract.OPEN_GATES_SECTIONS.every(Object.isFrozen));
});

check('looks up exact headings and rejects unknown section ids', () => {
  assert.equal(contract.heading('authorizations'), '## Authorizations on file');
  assert.throws(() => contract.heading('typo'), {
    name: 'TypeError', message: 'OPEN_GATES_UNKNOWN_SECTION:typo'
  });
});

check('accepts a complete digest and stable headings with trailing prose', () => {
  const text = completeDigest().replace(
    '## Authorizations on file',
    '## Authorizations on file — already permitted or forbidden'
  );
  assert.deepEqual(contract.checkDigestSections(text), {
    complete: true, missing: [], outOfOrder: [], missingLines: []
  });
});

check('reports missing sections, required lines, and section order by id', () => {
  const lines = completeDigest().split('\n');
  lines.splice(lines.indexOf(contract.heading('unmapped')), 1);
  lines.splice(lines.indexOf('Authorizations in force: 1'), 1);
  const active = lines.indexOf(contract.heading('active'));
  const authorizations = lines.indexOf(contract.heading('authorizations'));
  [lines[active], lines[authorizations]] = [lines[authorizations], lines[active]];

  assert.deepEqual(contract.checkDigestSections(lines.join('\r\n')), {
    complete: false,
    missing: ['unmapped'],
    outOfOrder: ['active must render after authorizations'],
    missingLines: ['Authorizations in force:']
  });
  assert.throws(() => contract.checkDigestSections(Buffer.from('digest')), {
    name: 'TypeError', message: 'OPEN_GATES_DIGEST_TEXT_INVALID'
  });
});

check('describes a shortfall, including whether revision verification was possible', () => {
  const result = {
    complete: false,
    missing: ['active'],
    outOfOrder: ['retired must render after retired-clauses'],
    missingLines: ['Ledger revision:']
  };
  const ordinary = contract.describeDigestShortfall(result);
  assert.match(ordinary, /missing section\(s\): "## Active gates"/);
  assert.match(ordinary, /missing header line\(s\): "Ledger revision:"/);
  assert.match(ordinary, /out of order: retired must render after retired-clauses/);
  assert.match(ordinary, /revision stamp is current/);
  assert.match(ordinary, /node tools\/ledger-query\.js open --gates --write/);

  const unverified = contract.describeDigestShortfall(result, { revisionUnverified: 'ledger unreadable' });
  assert.match(unverified, /could NOT be verified \(ledger unreadable\)/);
  assert.match(unverified, /shape axis alone/);
  assert.doesNotMatch(unverified, /revision stamp is current/);
});

check('returns no shortfall for complete results and validates result shape', () => {
  assert.equal(contract.describeDigestShortfall(contract.checkDigestSections(completeDigest())), null);
  assert.throws(() => contract.describeDigestShortfall({ complete: false }), {
    name: 'TypeError', message: 'OPEN_GATES_DIGEST_RESULT_INVALID'
  });
});

process.stdout.write(`Open-gates digest contract tests passed (${checks} checks).\n`);
