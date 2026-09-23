'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queueCorpus = require('../src/lib/build-queue-corpus');
const queueReader = require('../src/lib/fleet-supervisor/queue');
const { runPackageCheck } = require('../tools/package-check');

const ROOT = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-authority-'));

function write(relativePath, text) {
  const target = path.join(fixtureRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return target;
}

function phase(id, title, status) {
  return [
    `## ${id} \u2014 ${title}`,
    '',
    `**Status:** ${status}`,
    '',
    `**Authority:** R100 (directiveId: fixture-${id.toLowerCase()})`,
    '',
    '**Build:**',
    `Fixture work for ${id}.`,
    ''
  ].join('\n');
}

try {
  const packageIds = ['desktop.browser', 'owner.ledger', 'repo-protocol'];
  const rootText = [
    '# BUILD-QUEUE',
    '',
    '## Builder protocol (read once per loop)',
    '',
    '**Pick rule:** work the lowest-numbered phase whose Status line does not start with DONE or BLOCKED.',
    '',
    queueCorpus.renderQueueIndex(packageIds).trimEnd(),
    phase('Q12', 'Root work', 'OPEN'),
    '## Completed \u2014 do not rebuild',
    '',
    '- **Q50: Per-package queue slices:** DONE 2026-08-01 (closed and deleted from the live section.)',
    ''
  ].join('\n');
  const rootFile = write('BUILD-QUEUE.md', rootText);
  write('queue/desktop.browser.md', phase('Q74', 'Desktop browser work', 'OPEN'));
  write('queue/owner.ledger.md', phase('Q2', 'Owner ledger work', 'PARTIAL fixture'));
  write('queue/repo-protocol.md', phase('Q52', 'Repository protocol work', 'BLOCKED fixture'));

  const corpus = queueCorpus.readQueueCorpus(rootFile);
  const declaredSlices = corpus.index.map(entry => entry.path);
  assert.deepEqual(corpus.files, ['BUILD-QUEUE.md', ...declaredSlices]);
  for (const required of ['queue/desktop.browser.md', 'queue/repo-protocol.md', 'queue/owner.ledger.md']) {
    assert.ok(declaredSlices.includes(required), `${required} must remain declared by the root index`);
  }
  assert.deepEqual(
    fs.readdirSync(path.join(fixtureRoot, 'queue')).filter(name => name.endsWith('.md')).sort(),
    declaredSlices.map(slicePath => slicePath.slice('queue/'.length)).sort(),
    'every physical Markdown slice must be declared by the root index'
  );

  const phases = queueReader.readBuildQueue(rootFile).phases;
  const phaseIds = phases.map(item => item.id);
  assert.equal(new Set(phaseIds).size, phaseIds.length, 'phase ids are globally unique');
  assert.ok(phaseIds.includes('Q52'), 'repo-protocol slice is part of the corpus');
  assert.ok(phaseIds.includes('Q74'), 'desktop.browser slice is part of the corpus');
  assert.ok(!phaseIds.includes('Q50'), 'completed Q50 body was deleted');
  assert.match(rootText, /^- \*\*Q50: Per-package queue slices:\*\* DONE 2026-08-01/m);

  const open = queueReader.openPhases(phases);
  assert.deepEqual(open.map(item => item.id), ['Q2', 'Q12', 'Q74'], 'pick order is numeric across root and slices');
  for (let index = 1; index < open.length; index += 1) {
    assert.ok(open[index - 1].number <= open[index].number, 'pick order is non-decreasing by phase number');
  }
  for (const item of open) {
    assert.notEqual(item.status, 'DONE', `${item.id} is DONE and must not appear in the pick list`);
    assert.notEqual(item.status, 'BLOCKED', `${item.id} is BLOCKED and must not appear in the pick list`);
  }
  assert.equal(open[0].number, 2, 'the first pick is the independently known lowest open fixture phase');

  const packages = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'packages.json'), 'utf8'));
  assert.deepEqual(packages.packages.find(entry => entry.id === 'repo-protocol'), { id: 'repo-protocol', files: [] });
  const fleet = packages.packages.find(entry => entry.id === 'fleet');
  const q50Files = [
    'src/lib/build-queue-corpus.js',
    'src/lib/build-queue-migration.js',
    'src/lib/build-queue-package-contract.js',
    'src/lib/build-queue-projection.js',
    'src/lib/build-queue-slice.js',
    'src/lib/build-queue-writer.js',
    'tools/build-queue-migrate.js'
  ];
  for (const file of q50Files) assert.ok(fleet.files.includes(file), `${file} must remain fleet-owned`);

  const packageFixture = path.join(fixtureRoot, 'package-check');
  fs.mkdirSync(path.join(packageFixture, 'src'), { recursive: true });
  fs.mkdirSync(path.join(packageFixture, 'config'), { recursive: true });
  fs.mkdirSync(path.join(packageFixture, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(packageFixture, 'sidecars'), { recursive: true });
  fs.writeFileSync(path.join(packageFixture, 'src', 'a.js'), "'use strict';\nmodule.exports = require('./b');\n", 'utf8');
  fs.writeFileSync(path.join(packageFixture, 'src', 'b.js'), "'use strict';\nmodule.exports = 1;\n", 'utf8');
  fs.writeFileSync(path.join(packageFixture, 'tools', 'c.js'), "'use strict';\nmodule.exports = 2;\n", 'utf8');
  fs.writeFileSync(path.join(packageFixture, 'sidecars', 'd.js'), "'use strict';\nmodule.exports = 3;\n", 'utf8');
  fs.writeFileSync(path.join(packageFixture, 'config', 'packages.json'), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: 'fixture.package', files: ['sidecars/d.js', 'src/a.js', 'src/b.js', 'tools/c.js'] }]
  }), 'utf8');
  const packageReport = runPackageCheck({ rootDirectory: packageFixture });
  assert.equal(packageReport.manifestValid, true, `the package checker accepts the owned fixture manifest: ${JSON.stringify(packageReport.invalidClaims)}`);
  assert.deepEqual(packageReport.unmappedFiles, [], 'the fixture has no unmapped JavaScript files');
  assert.deepEqual(packageReport.layeringViolations, [], 'same-package requires satisfy layering');

  const charter = fs.readFileSync(path.join(ROOT, 'packages', 'repo-protocol', 'PACKAGE.md'), 'utf8');
  for (const heading of ['Purpose', 'Public API', 'Allowed dependencies', 'Action classes', 'Must not do', 'Verification']) {
    assert.match(charter, new RegExp(`^## ${heading}$`, 'm'));
  }

  console.log('build-queue-authority: fixture root/index parity, package ownership, and global pick order passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
