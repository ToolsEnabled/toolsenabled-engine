'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../src/lib/runtime');
const { OUTPUTS, generate } = require('../tools/generate-ownership-types');
const { readMap, verifyBoundary } = require('../tools/check-cross-repo-boundaries');

const map = readMap();
assert.equal(map.schemaVersion, 1);
assert.equal(map.contractVersion, 'coordinator-cross-repo-v1');
assert.deepEqual(map.owners.map(item => item.domain).sort(), [
  'context', 'evidence', 'finance', 'model-runtime', 'provider', 'task', 'tool-forge', 'ui'
]);
assert.equal(new Set(map.owners.map(item => item.domain)).size, map.owners.length);
assert.equal(map.owners.find(item => item.domain === 'finance').owner, 'portfolio-dashboard');
assert.deepEqual(map.financeDomainInterface.operations.map(operation => operation.effect), ['read-only', 'read-only', 'read-only']);
assert.match(map.financeDomainInterface.forbidden.join(','), /shared_database/);

generate({ check: true });
for (const output of Object.values(OUTPUTS)) {
  const content = fs.readFileSync(output, 'utf8');
  assert.doesNotMatch(content, /portfolio dashboard|src\/lib|sidecars\/|require\(|^import\s/m);
}

const actual = verifyBoundary();
assert.equal(actual.valid, true, JSON.stringify(actual.violations));

const fixtureRoot = path.join(ROOT, 'tests', 'fixtures', 'cross-repo-boundary');
fs.mkdirSync(fixtureRoot, { recursive: true });
const fixture = path.join(fixtureRoot, 'forbidden-import.js');
// A COMMENT THAT QUOTES A FORBIDDEN IMPORT IS PROSE, NOT AN EDGE.
//
// This check reported tools/check-payload-boundary.mjs as a boundary breach for
// the text of a comment that EXPLAINS the fixture written just above, and
// printed the specifier "../../../Portfolio Dashboard/\n        // frontend/app.js"
// -- a line break and a `//` inside a "module path". The file it accused states
// the rule it was being judged by: quoted require() text is a fixture, not an
// edge, and a finding list that is mostly noise is one nobody reads.
//
// So both spellings of the mistake are pinned here, in both languages the
// scanner reads, and they sort BEFORE the real violation on purpose: if comment
// bodies are ever scanned again, violations[0] stops being the genuine one and
// this fails on the next line rather than on a count nobody reads.
const commented = path.join(fixtureRoot, 'commented-import.js');
const commentedPython = path.join(fixtureRoot, 'commented-import.py');
try {
  fs.writeFileSync(fixture, "require('../../../Portfolio Dashboard/frontend/app.js');\n", 'utf8');
  fs.writeFileSync(commented, [
    "// require('../../../Portfolio Dashboard/frontend/app.js') is what this",
    '// paragraph is ABOUT, which is not the same thing as importing it.',
    "/* import('../../../Portfolio Dashboard/frontend/app.js') */",
    "const stillScanned = require('node:path');",
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(commentedPython, '# from portfolio-dashboard.frontend import app\nimport os\n', 'utf8');
  assert.equal(verifyBoundary().valid, true, 'fixture-only forbidden imports must not affect production scanning');
  const negative = verifyBoundary({ includeFixtures: true });
  assert.equal(negative.valid, false, 'explicit fixture scanning must detect a forbidden global-to-Portfolio import');
  assert.equal(negative.violations[0].file, 'tests/fixtures/cross-repo-boundary/forbidden-import.js');
  assert.deepEqual(negative.violations.map(violation => violation.file), ['tests/fixtures/cross-repo-boundary/forbidden-import.js'],
    'a require()/import quoted inside a comment is prose and must never be reported as an edge');
} finally {
  for (const written of [fixture, commented, commentedPython]) {
    if (fs.existsSync(written)) fs.unlinkSync(written);
  }
  try { fs.rmdirSync(fixtureRoot); } catch { /* A concurrent fixture must not be removed. */ }
}

const temporaryPortfolio = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-boundary-'));
try {
  const app = path.join(temporaryPortfolio, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'forbidden.py'), 'from toolsenabled.src.lib.state_store import StateStore\n', 'utf8');
  const negative = verifyBoundary({ portfolioRoot: temporaryPortfolio });
  assert.equal(negative.valid, false, 'Portfolio imports of ToolsEnabled internals must be rejected');
  assert.equal(negative.violations.at(-1).direction, 'portfolio-to-toolsenabled');
} finally {
  fs.rmSync(temporaryPortfolio, { recursive: true, force: true });
}

console.log(`Unified-agent P04 boundary check passed (${map.contractVersion}).`);
