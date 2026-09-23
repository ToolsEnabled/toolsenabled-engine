'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  applicationImportViolations,
  readMap,
  verifyBoundary
} = require('../tools/check-cross-repo-boundaries');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'check-cross-repo-boundaries.js');
const REFUSALS = Object.freeze({
  global: 'ToolsEnabled global code must not import Portfolio UI, persona, or application code.',
  portfolio: 'Portfolio code must use the typed ToolsEnabled boundary, not internal runtime paths.',
  generated: 'Generated ownership contracts must not import an application runtime.',
  indeterminate: 'The declared root scanned zero source files (missing or empty); nothing was actually checked.'
});

function isolatedMap(overrides = {}) {
  return {
    ...readMap(),
    boundaryCheck: {
      ...readMap().boundaryCheck,
      productionRoots: ['production'],
      fixtureRoots: ['fixtures'],
      ...overrides
    }
  };
}

function write(root, relative, content = "require('node:path');\n") {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-repo-boundaries-test-'));
try {
  write(temporary, 'production/safe.js');

  // Refusal 1: a ToolsEnabled production root reaches into Portfolio code.
  write(temporary, 'production/forbidden.js', "require('portfolio-dashboard/app/persona');\n");
  let result = verifyBoundary({ root: temporary, map: isolatedMap() });
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map(item => item.rule), [REFUSALS.global]);
  fs.unlinkSync(path.join(temporary, 'production/forbidden.js'));

  // The opt-in fixture scan uses the same refusal, and must not silently become
  // an unscanned exception to the production boundary.
  write(temporary, 'fixtures/forbidden.js', "import 'portfolio-dashboard/frontend/app.js';\n");
  assert.equal(verifyBoundary({ root: temporary, map: isolatedMap() }).valid, true);
  result = verifyBoundary({ root: temporary, map: isolatedMap(), includeFixtures: true });
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map(item => item.rule), [REFUSALS.global]);

  // Refusal 2: Portfolio reaches around the typed client into runtime internals.
  const portfolio = path.join(temporary, 'portfolio');
  write(portfolio, 'app/forbidden.py', 'from toolsenabled.src.lib.state_store import StateStore\n');
  result = verifyBoundary({ root: temporary, map: isolatedMap(), portfolioRoot: portfolio });
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map(item => item.rule), [REFUSALS.portfolio]);

  // Refusal 3: generated contracts must remain data-only and runtime-free.
  const generated = applicationImportViolations(new Map([
    [path.join(ROOT, 'schemas', 'generated', 'hostile.ts'), "import state from 'src/lib/state';\n"]
  ]));
  assert.deepEqual(generated.map(item => item.rule), [REFUSALS.generated]);

  // Refusal 4: an absent/empty declared root is indeterminate, never a pass.
  result = verifyBoundary({
    root: temporary,
    map: isolatedMap({ productionRoots: ['missing-production'] })
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.indeterminate.map(item => item.reason), [REFUSALS.indeterminate]);

  // Pin the CLI's sole named non-zero exit code with an actual argument value.
  const cli = spawnSync(process.execPath, [TOOL, '--portfolio-root', portfolio], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 1, cli.stderr || cli.stdout);
  const diagnostic = JSON.parse(cli.stderr);
  assert.deepEqual(diagnostic.violations.map(item => item.rule), [REFUSALS.portfolio]);
  assert.deepEqual(diagnostic.indeterminate, []);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('check-cross-repo-boundaries refusals and exit code are pinned.');
