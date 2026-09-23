'use strict';

// Locks in the three false greens measured in tools/invocation-guard.js on
// 2026-08-09. Each one was the defect the guard hunts, occurring inside the
// guard: something that merely MENTIONED a mechanism was counted as RUNNING it.
//
// These are regression tests rather than prose because the failure mode is
// specifically that documentation about a rule does not enforce the rule. That
// is the entire finding this component exists to answer.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const {
  extractReferences, runGuard, formatReport, computeReachable,
  validateDeclaredRoots, validateDeclaredProductionEdges,
  validateReleaseExcludedLibraries, RELEASE_EXCLUDED_PAYMENT_LIBRARIES,
  RELEASE_EXCLUDED_OWNER_DEFERRED_LIBRARIES
} = require(path.join(ROOT, 'tools', 'invocation-guard.js'));
const { executionSpans, findShadowedTests } = require(path.join(ROOT, 'tools', 'invocation-graph.js'));

function testProseInStringsIsNotInvocation() {
  console.log('🧪 A path inside a data list or a sentence is not an invocation...');

  // src/lib/providers/repo-files.js:151 lists tools/register-managed-tasks.js
  // in WRITE_PROTECTED_FILES -- a set of files nothing may modify. Counting
  // that as a call made an elevated registrar nothing runs look wired.
  const dataList = [
    "const WRITE_PROTECTED_FILES = new Set([",
    "  'src/mcp-server.js',",
    "  'tools/register-managed-tasks.js'",
    "].map(p => p.toLowerCase()));"
  ].join('\n');
  const listRefs = extractReferences(path.join(ROOT, 'src', 'lib', 'providers', 'sample.js'), dataList, 'js');
  assert.ok(
    !listRefs.files.includes('tools/register-managed-tasks.js'),
    'a path in a data array must NOT count as an invocation'
  );

  // src/lib/coordinator/duty-registry.js:712 tells a human to run the
  // registrar, inside a decisionReason string.
  const advice = "record.decisionReason = 'Fix with an elevated run (node tools/register-managed-tasks.js prints it).';";
  const adviceRefs = extractReferences(path.join(ROOT, 'src', 'sample.js'), advice, 'js');
  assert.ok(
    !adviceRefs.files.includes('tools/register-managed-tasks.js'),
    'advice to a human in a string must NOT count as an invocation'
  );

  // The guard's own formatReport() said "Produce it with `npm run test:all`".
  // That made test:all reachable and tools/test-run.js look wired, which broke
  // a hand-written manual entry that correctly said nothing invokes it.
  const helpText = "lines.push('  Produce it with `npm run test:all`, after which this guard names them.');";
  const helpRefs = extractReferences(path.join(ROOT, 'tools', 'sample.js'), helpText, 'js');
  assert.ok(
    !helpRefs.npmScripts.includes('test:all'),
    'an npm script named in help text must NOT count as an invocation'
  );

  // The narrowing must not throw away real calls.
  // Assembled from fragments rather than written literally. A fixture that
  // spells out a real spawn call around a real tool path makes THIS FILE look
  // like it invokes that tool: executionSpans() reads text and cannot tell code
  // from a string containing code. Written literally, this line alone made
  // tools/register-managed-tasks.js -- the canonical false green -- score
  // reachable again, from inside the test asserting it must not.
  const realCall = ['spawn', 'Sync(process.execPath, [', "'tools/", "register-managed-tasks.js'", '], { cwd: ROOT });'].join('');
  const realRefs = extractReferences(path.join(ROOT, 'src', 'sample.js'), realCall, 'js');
  assert.ok(
    realRefs.files.includes('tools/register-managed-tasks.js'),
    'a path inside a spawn call MUST count as an invocation'
  );

  console.log('   ✓ mentions rejected, real spawn accepted');
}

function testRequireStillCounts() {
  console.log('🧪 A resolved require is still a real edge...');
  // tools/repo-sync.js:14 requires check-single-copy-work and calls it at :181.
  // Confirmed with code.find_references, not by eye. The narrowing above must
  // not lose this true positive.
  const source = "const { checkSingleCopyWork } = require('./check-single-copy-work');";
  const refs = extractReferences(path.join(ROOT, 'tools', 'sample.js'), source, 'js');
  assert.ok(
    refs.files.includes('tools/check-single-copy-work.js'),
    'a resolved relative require MUST count as an invocation edge'
  );
  console.log('   ✓ require edge preserved');
}

function testExecutedConfigCarriesHookEdges() {
  console.log('An installer-loaded JSON hook template carries only its executable fields...');
  const installer = [
    "& node 'tools/merge-client-hooks.js' --template 'config/client-hooks/codex-hooks.json'"
  ].join('\n');
  const installRefs = extractReferences(path.join(ROOT, 'install.ps1'), installer, 'ps1');
  assert.ok(installRefs.files.includes('config/client-hooks/codex-hooks.json'),
    'an installer-loaded config JSON path must be a real dependency edge');

  const template = JSON.stringify({
    $comment: ['tools/comment-only.js'],
    hooks: {
      SessionStart: [{ hooks: [{
        type: 'command',
        command: 'r="$(git rev-parse --show-toplevel)" && node "$r/tools/agent-onboarding.js" --hook'
      }] }]
    }
  });
  const hookRefs = extractReferences(
    path.join(ROOT, 'config', 'client-hooks', 'codex-hooks.json'), template, 'json'
  );
  assert.ok(hookRefs.files.includes('tools/agent-onboarding.js'),
    'a command handler in loaded JSON must carry its actual tool edge');
  assert.ok(!hookRefs.files.includes('tools/comment-only.js'),
    'a config $comment must not manufacture a tool edge');

  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const production = computeReachable(registry, scripts, { expandTests: false });
  assert.ok(production.reachableFiles.has('config/client-hooks/codex-hooks.json'),
    'the installer must reach the shipped Codex hook template');
  assert.ok(production.reachableFiles.has('tools/agent-onboarding.js'),
    'the installed client hook must reach the onboarding command');
  assert.ok(production.reachableFiles.has('tools/claude-session-autoregister.js'),
    'the installed Claude SessionStart hook must reach autoregistration');
}

function testExplorerLaunchersCarryOnlyExecutableEdges() {
  console.log('Explorer VBS/CMD launchers carry their real sibling edge, not comments...');
  const vbsPath = path.join(ROOT, 'packages', 'servercontrol', 'Launch Control Panel.vbs');
  const vbsSource = [
    "' fileSystem.BuildPath(base, \"Comment-Only.ps1\")",
    'panelPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "Server-Control-Panel.ps1")'
  ].join('\n');
  const vbsRefs = extractReferences(vbsPath, vbsSource);
  assert.deepStrictEqual(
    vbsRefs.files.filter(file => file.startsWith('packages/servercontrol/')),
    ['packages/servercontrol/Server-Control-Panel.ps1'],
    'a VBS BuildPath call must cross to its real sibling while apostrophe comments stay inert'
  );

  const cmdPath = path.join(ROOT, 'tools', 'Launch-Fixture.cmd');
  const cmdSource = [
    'rem "%~dp0Comment-Only.vbs"',
    ':: "%~dp0Also-Comment-Only.vbs"',
    '"%SystemRoot%\\System32\\wscript.exe" "%~dp0Launch-Fixture.vbs"'
  ].join('\n');
  const cmdRefs = extractReferences(cmdPath, cmdSource);
  assert.deepStrictEqual(
    cmdRefs.files.filter(file => file.startsWith('tools/')),
    ['tools/Launch-Fixture.vbs'],
    'a batch %~dp0 launch must cross to its real sibling while REM and :: comments stay inert'
  );
}

function testDeclaredRootsMustExist() {
  console.log('Declared invocation roots are validated before they can grant reachability...');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'invocation-roots-'));
  try {
    fs.mkdirSync(path.join(workspace, 'hooks'));
    fs.writeFileSync(path.join(workspace, 'entry.js'), "'use strict';\n");
    const roots = {
      roots: ['npm:real', 'npm:missing', 'entry.js', 'hooks', 'missing.js', '../outside.js', path.resolve(workspace, 'entry.js')]
    };
    const invalid = validateDeclaredRoots(roots, { real: 'node entry.js' }, workspace);
    assert.deepStrictEqual(
      invalid.map(item => item.root),
      ['npm:missing', 'missing.js', '../outside.js', path.resolve(workspace, 'entry.js')],
      'missing npm scripts, missing paths, traversal, and absolute paths must all fail closed'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  assert.deepStrictEqual(runGuard().invalidRoots, [], 'the checked-in registry must declare only roots that exist');
}

function testDeclaredDynamicEdgesFailClosed() {
  console.log('Reviewed dynamic production edges validate both files and executable source evidence...');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'invocation-edges-'));
  try {
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'tools'));
    fs.writeFileSync(path.join(workspace, 'tools', 'worker.js'), "'use strict';\n");
    fs.writeFileSync(path.join(workspace, 'src', 'comment-only.js'), '// worker.js is mentioned only in prose\n');
    fs.writeFileSync(path.join(workspace, 'src', 'real.js'), "const worker = rootPath('tools', 'worker.js');\nspawn(process.execPath, [worker]);\n");
    const registry = { productionEdges: [
      { from: 'src/comment-only.js', to: 'tools/worker.js', reason: 'A long explanation cannot substitute for executable source evidence.' },
      { from: 'src/real.js', to: 'tools/worker.js', reason: 'The resolved worker is passed as argv zero to the child process spawn.' },
      { from: 'src/missing.js', to: 'tools/worker.js', reason: 'A missing source must never be allowed to manufacture reachability.' }
    ] };
    const checked = validateDeclaredProductionEdges(registry, workspace);
    assert.deepStrictEqual(checked.valid.map(edge => edge.from), ['src/real.js']);
    assert.equal(checked.invalid.length, 2, 'comment-only and missing-source edges must both fail closed');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  assert.deepStrictEqual(runGuard().invalidProductionEdges, [], 'every checked-in dynamic edge must retain live source evidence');
}

function testCoordinatorBudgetDutyCarriesItsRealDynamicLoad() {
  console.log('The coordinator budget duty really loads the sink behind its computed require...');
  // Observe a real read-only duty in a fresh isolated process. This must not
  // inject a fake sink, send an escalation, or borrow a prior test's cache.
  async function observeBudgetLoad() {
    require('./tests/lib/isolated-environment').activate('invocation-budget');
    const path = require('node:path');
    const Module = require('node:module');
    const dutyFile = path.resolve('src/lib/coordinator/duty-registry.js');
    const sinkFile = path.resolve('src/lib/coordinator/escalation-sink.js');
    const alarmFile = path.resolve('src/lib/coordinator/owner-alarm-channel.js');
    const duties = require(dutyFile);
    const before = [sinkFile, alarmFile].map(file => Boolean(require.cache[file]));
    const observed = [];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const loaded = Reflect.apply(originalLoad, this, arguments);
      if (parent && parent.filename === dutyFile && request === sinkFile) {
        observed.push([dutyFile, sinkFile].map(file => path.relative(process.cwd(), file).split(path.sep).join('/')));
      }
      return loaded;
    };
    try {
      const context = { cycle: {}, deps: {} };
      const result = await duties.getDuty('escalation-budget-report').run(context);
      process.stdout.write(JSON.stringify({
        before,
        after: [sinkFile, alarmFile].map(file => Boolean(require.cache[file])),
        observed,
        outcome: result.outcome,
        suppressed: context.cycle.escalationsSuppressed
      }));
    } finally {
      Module._load = originalLoad;
    }
  }
  const child = spawnSync(process.execPath, ['-e', `(${observeBudgetLoad.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`], {
    cwd: ROOT, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.ifError(child.error);
  assert.strictEqual(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout);
  const source = 'src/lib/coordinator/duty-registry.js';
  const target = 'src/lib/coordinator/escalation-sink.js';
  assert.deepStrictEqual(receipt, {
    before: [false, false], after: [true, true], observed: [[source, target]], outcome: 'OK', suppressed: 0
  }, 'the budget read must establish the actual dynamic load without invoking an escalation');

  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const production = computeReachable(registry, scripts, { expandTests: false });
  assert.strictEqual(production.cameFrom.get(target), source,
    'the production graph must retain the load observed from the managed coordinator duty');
  assert.strictEqual(production.cameFrom.get('src/lib/coordinator/owner-alarm-channel.js'), target,
    'the real sink must carry its downstream alarm dependency');
  const missingEdge = computeReachable({
    ...registry,
    productionEdges: registry.productionEdges.filter(edge => edge.from !== source || edge.to !== target)
  }, scripts, { expandTests: false });
  assert.ok(!missingEdge.reachableFiles.has(target),
    'the test probe itself must never manufacture a production invocation path');
}

function testToolRequiredOnlyByATestIsNotProductionReachable() {
  console.log('A tool imported only from tests is not a production invocation path...');
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const target = 'tools/fra-manifest-repin.js';
  const all = computeReachable(registry, scripts).reachableFiles;
  const production = computeReachable(registry, scripts, { expandTests: false }).reachableFiles;
  assert.ok(all.has(target), 'fixture must remain statically reached through a test');
  assert.ok(!production.has(target), 'test expansion must not grant production reachability');
  assert.ok(runGuard().unreachableTools.includes(target), 'the guard must classify that test-only tool as unreachable');
}

function testDesktopPayloadModulesAreProductionRoots() {
  console.log('Installed desktop payload entrypoints are explicit production roots...');
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const production = computeReachable(registry, scripts, { expandTests: false });
  const appOwnedRoots = [
    'tools/mission-bridge.js',
    'src/lib/agent-engine/claude-cli-process.js',
    'src/lib/agent-ledger-continuation.js',
    'src/lib/audit-identity-maintenance.js',
    'src/lib/ledger-category-reset.js',
    'src/lib/capability-recall/index.js',
    'src/lib/proc/hidden-spawn.js'
  ];
  for (const target of appOwnedRoots) {
    assert.ok(registry.roots.includes(target), `${target} must be declared as an external app-owned production root`);
    assert.ok(production.reachableFiles.has(target), `the installed desktop must make ${target} production-reachable`);
    assert.strictEqual(production.cameFrom.get(target), null, `${target} must be an external app root, not a fabricated child edge`);
  }

  assert.ok(production.reachableFiles.has('tools/agent-onboarding.js'), 'the installed Claude hook must reach the onboarding CLI');
  assert.ok(production.reachableFiles.has('src/lib/agent-onboarding.js'), 'the onboarding CLI must load its source implementation');
  assert.strictEqual(production.cameFrom.get('src/lib/capability-features.js'), 'src/lib/agent-onboarding.js',
    'the computed capability-feature load must remain anchored to the installed onboarding implementation');
}

function testStrictReleaseRootNeedsItsRealExternalDeclaration() {
  console.log('The external release promoter reaches the strict harness without laundering a customer-runtime claim...');
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const root = 'npm:test:strict';
  const target = 'tools/test-strict.js';
  assert.ok(registry.roots.includes(root), 'the actual external promoter entry must be declared');
  const production = computeReachable(registry, scripts, { expandTests: false });
  assert.strictEqual(production.cameFrom.get(target), root, 'the strict harness must have its actual npm invocation chain');
  const undeclared = computeReachable({
    ...registry,
    roots: registry.roots.filter(value => value !== root)
  }, scripts, { expandTests: false });
  assert.ok(!undeclared.reachableFiles.has(target), 'having an uncalled package alias alone must not grant reachability');
}

function testHistoricalFindingsSurviveProgramRetirement() {
  console.log('Retiring a program does not erase the original invocation audit...');
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-production-classification.json'), 'utf8'));
  // Measured from fe640324f6b882aa12b75333c1c5029d3bda7f1e^ before that
  // removal accidentally deleted two historical rows without updating counts.
  const historicalDigest = createHash('sha256').update(JSON.stringify(record.evidence.original242)).digest('hex');
  assert.strictEqual(historicalDigest, '19dd0dbe71bc9071161e68f8c1edc058dd181dc239d2f989fb9bdf343fd2a4bf',
    'the original finding must preserve identities, not merely a 242-row count');
  for (const file of ['tools/Start-ToolsEnabled-Background.ps1', 'tools/coordinator-runs.js']) {
    assert.ok(record.evidence.original242.includes(file), `${file} must remain in the historical finding`);
    assert.ok(record.categories['retired-stale'].files.includes(file), `${file} must be classified retired, not silently discarded`);
    assert.ok(!fs.existsSync(path.join(ROOT, file)), `${file} cannot be retired while its program exists`);
  }
}

function testPersistentVaultHostHasItsActualSpawnEdge() {
  console.log('The persistent vault host is runtime code reached from its real worker spawn, not a development exclusion...');
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const from = 'src/lib/vault-host/worker.js';
  const to = 'tools/vault-host.ps1';
  const matches = edge => edge.from === from && edge.to === to;
  assert.strictEqual(registry.productionEdges.filter(matches).length, 1, 'the dynamic HOST_SCRIPT spawn needs one reviewed edge');
  const production = computeReachable(registry, scripts, { expandTests: false });
  assert.ok(production.reachableFiles.has(from), 'the actual worker must already be reachable');
  assert.strictEqual(production.cameFrom.get(to), from, 'the host must be reached through the actual worker');
  const withoutEdge = computeReachable({
    ...registry,
    productionEdges: registry.productionEdges.filter(edge => !matches(edge))
  }, scripts, { expandTests: false });
  assert.ok(!withoutEdge.reachableFiles.has(to), 'mere program membership must not substitute for the dynamic invocation edge');
  assert.ok(!runGuard().productionExcludedTools.includes(to), 'the runtime vault host must never be classified away');
}

function testCoordinatorEscalationFollowsItsRealDynamicLoad() {
  console.log('Coordinator escalation follows the declared managed host and its actual lazy module load...');
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const from = 'src/lib/coordinator/duty-registry.js';
  const to = 'src/lib/coordinator/escalation-sink.js';
  const matches = edge => edge.from === from && edge.to === to;
  assert.strictEqual(registry.productionEdges.filter(matches).length, 1);
  const production = computeReachable(registry, scripts, { expandTests: false });
  assert.strictEqual(production.cameFrom.get('tools/coordinator-duty-host.js'), 'config/managed-processes.json');
  assert.strictEqual(production.cameFrom.get(from), 'tools/coordinator-duty-host.js');
  assert.strictEqual(production.cameFrom.get(to), from);
  const withoutEdge = computeReachable({
    ...registry, productionEdges: registry.productionEdges.filter(edge => !matches(edge))
  }, scripts, { expandTests: false });
  for (const target of [to, 'src/lib/coordinator/escalation-policy.js', 'src/lib/coordinator/owner-alarm-channel.js']) {
    assert.ok(production.reachableFiles.has(target), `${target} must follow the actual coordinator load`);
    assert.ok(!withoutEdge.reachableFiles.has(target), `${target} cannot be reached through tests or package membership alone`);
    assert.ok(!registry.entries[target], `${target} must not remain recorded as unwired debt`);
  }
}

function testProductionClassesDoNotMasqueradeAsReachability() {
  console.log('Build/developer tools are excluded only by reviewed class; unexplained customer tools remain red...');
  const result = runGuard();
  assert.deepStrictEqual(result.classificationIssues, [], 'the checked classification must be complete and internally consistent');
  assert.ok(result.productionExcludedTools.includes('tools/test-run.js'), 'the test runner must be declared build/release, not customer runtime');
  assert.ok(result.productionExcludedTools.includes('tools/register-mission-bridge-task.ps1'), 'the optional installation-time registrar must be build/release, not portable customer runtime');
  assert.ok(result.productionExcludedTools.includes('tools/bridge-action-smoke.js'), 'the smoke harness must be declared developer-only');
  assert.ok(result.productionExcludedTools.includes('tools/measure-tree-courier-tick.js'), 'the manually invoked scratch timing experiment is developer-only');
  assert.ok(result.unreachableTools.includes('tools/measure-tree-courier-tick.js'), 'the diagnostic classification must not invent an invocation path');
  assert.ok(!result.unresolvedCustomerTools.includes('tools/test-run.js'), 'a build-only tool must not become customer-runtime debt');
  assert.ok(result.productionExcludedTools.includes('tools/fra-manifest-repin.js'),
    'the operator-reviewed FRA digest repin utility is maintenance, not an automatic customer runtime');
  assert.deepStrictEqual(result.unresolvedCustomerTools, [],
    'every current tool finding must have either a real production edge or a reviewed non-runtime classification');
  assert.ok(result.unreachableTools.includes('tools/test-run.js'), 'classification must not falsely claim a production invocation path');
  const classification = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-production-classification.json'), 'utf8'));
  for (const retired of classification.categories['retired-stale'].files) {
    assert.ok(!fs.existsSync(path.join(ROOT, retired)), `${retired} is classified retired and must remain absent`);
  }
}

function testExecutionSpansAreBalanced() {
  console.log('🧪 Execution spans cover a whole multi-line argv...');
  const source = [
    'spawnSync(process.execPath, [',
    "  'tools/a.js',",
    "  'tools/b.js'",
    '], { cwd: ROOT });',
    "const unrelated = 'tools/c.js';"
  ].join('\n');
  const spans = executionSpans(source);
  assert.strictEqual(spans.length, 1, 'exactly one process-starting call');
  const inside = (needle) => {
    const index = source.indexOf(needle);
    return spans.some(([start, end]) => index >= start && index <= end);
  };
  assert.ok(inside("'tools/a.js'"), 'first argv member is inside the span');
  assert.ok(inside("'tools/b.js'"), 'a later line of the same argv is inside the span');
  assert.ok(!inside("'tools/c.js'"), 'a string after the call is outside the span');
  console.log('   ✓ spans balanced across lines');
}

function testSeedingPreservesHandWrittenReasons() {
  console.log('🧪 Seeding merges and never demotes a manual entry...');
  // The generator rebuilt entries from scratch, which erased a builder's
  // reasoned manual entry twice and converted a judged decision into unjudged
  // "baseline" debt automatically. That is a fail-open inside the mechanism
  // built to prevent fail-open.
  const guardSource = fs.readFileSync(path.join(ROOT, 'tools', 'invocation-guard.js'), 'utf8');
  const seedBody = guardSource.slice(guardSource.indexOf('function seedBaseline'));
  assert.ok(
    /entries:\s*\{\s*\.\.\.preserved\s*\}/.test(seedBody),
    'seedBaseline must start from the existing entries, not from an empty object'
  );
  assert.ok(
    !/registry\.entries\s*=\s*\{\s*\}/.test(seedBody.slice(0, seedBody.indexOf('writeRegistry'))),
    'seedBaseline must never reset entries to {} before writing'
  );

  // And the live registry must still carry the reasons somebody wrote.
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  for (const [file, entry] of Object.entries(registry.entries || {})) {
    if (entry && entry.status === 'manual') {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.trim().length >= 25,
        `manual entry ${file} must keep a substantive hand-written reason`
      );
    }
  }
  console.log('   ✓ merge semantics enforced, manual reasons intact');
}

function testShadowingIsExpressible() {
  console.log('🧪 Fail-fast position is modelled, not assumed away...');
  // A test can be statically reachable and dynamically never executed, because
  // a batch that opts into --fail-fast stops at the first failure. Since
  // 2026-08-10 tests/run-isolated.js runs everything by default, so this check
  // keys off the explicit opt-out -- and it MUST still fire when one is present,
  // or the hazard becomes undetectable the moment somebody reintroduces it.
  const shadowing = findShadowedTests({
    'test:demo': 'node tests/run-isolated.js --fail-fast tests/one.js tests/two.js tests/three.js'
  }, { scriptsOnly: true });
  assert.ok(shadowing.batches.some((batch) => batch.failFast), 'a batch passing --fail-fast is fail-fast');
  assert.ok(
    Object.keys(shadowing.conditional).length >= 2,
    'members after position 1 of a fail-fast batch are conditionally reachable'
  );
  assert.ok(
    !('tests/one.js' in shadowing.conditional),
    'position 1 runs unconditionally and must not be flagged'
  );

  const continued = findShadowedTests({
    'test:demo': 'node tests/run-isolated.js tests/one.js tests/two.js'
  }, { scriptsOnly: true });
  assert.ok(
    continued.batches.every((batch) => !batch.failFast),
    'the runner default is to keep going, so an unflagged batch is not fail-fast'
  );
  assert.ok(
    Object.keys(continued.conditional).length === 0,
    'a keep-going batch does not shadow its later members'
  );
  console.log('   ✓ fail-fast vs default continuation distinguished');
}

function testAnOptInSkipIsNotABlocker() {
  console.log('🧪 A gated SKIP does not get reported as having stopped the batch...');
  // Measured 2026-08-10: this guard named 139 tests "NOT REACHED", and 115 of
  // them were attributed to tests/scheduler-windows-mutation.js -- an opt-in
  // gated suite that tests/run-isolated.js recognises BEFORE spawning and
  // `continue`s past, explicitly, even under --fail-fast. Nothing was blocked.
  // The guard had inferred "the runner stopped here" from "status !== pass",
  // which is not a measurement of the runner's behaviour but a guess about it.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'invocation-guard-skip-'));
  const recordPath = path.join(workspace, 'record.json');
  const scripts = {
    'test:demo': 'node tests/run-isolated.js --fail-fast tests/one.js tests/two.js tests/three.js'
  };
  try {
    fs.writeFileSync(recordPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      files: [
        { file: 'tests/one.js', status: 'skip', exitCode: null, ms: 0 },
        { file: 'tests/two.js', status: 'pass', exitCode: 0, ms: 1 },
        { file: 'tests/three.js', status: 'pass', exitCode: 0, ms: 1 }
      ]
    }));
    const skipped = findShadowedTests(scripts, { scriptsOnly: true, runRecordPath: recordPath });
    assert.deepStrictEqual(
      Object.keys(skipped.shadowed),
      [],
      'a skipped suite the runner steps past must shadow nothing'
    );

    // The same batch with a real failure in the same position MUST still
    // shadow, or the rule above would have been bought by blinding the check.
    fs.writeFileSync(recordPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      files: [
        { file: 'tests/one.js', status: 'fail', exitCode: 1, ms: 1 },
        { file: 'tests/two.js', status: 'pass', exitCode: 0, ms: 1 },
        { file: 'tests/three.js', status: 'pass', exitCode: 0, ms: 1 }
      ]
    }));
    const failed = findShadowedTests(scripts, { scriptsOnly: true, runRecordPath: recordPath });
    assert.deepStrictEqual(
      Object.keys(failed.shadowed).sort(),
      ['tests/three.js', 'tests/two.js'],
      'a genuine failure in a --fail-fast batch must still shadow every later member'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log('   ✓ skip steps aside, fail still blocks');
}

function testShadowedReportStatesEvidenceAge() {
  console.log('🧪 A "blocked by" attribution names its evidence\'s age, not just the claim...');
  // R1162-era near-miss: state/test-runs/latest.json is local, gitignored, and
  // only refreshed by a full test run -- it does not update itself as commits
  // land. tests/audit-reliability.js was reported blocking 227 tests here while
  // passing both standalone and at its exact batch position, because the
  // recorded run predated the fix by over a day. The report must say so, or a
  // reader spends effort chasing a blocker that is already gone.
  const base = runGuard();
  const shadowedDetail = { batch: 'npm:test', position: 2, blockedBy: 'tests/zzz-blocker-example.js' };

  const staleGeneratedAt = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
  const staleReport = formatReport({
    ...base,
    shadowedTests: ['tests/zzz-shadowed-example.js'],
    shadowing: {
      ...base.shadowing,
      runEvidence: { available: true, generatedAt: staleGeneratedAt },
      shadowed: { 'tests/zzz-shadowed-example.js': shadowedDetail }
    }
  });
  assert.match(
    staleReport,
    /historical snapshot recorded/,
    'the shadowed-test FAIL must call its evidence historical, not assert it live'
  );
  assert.match(
    staleReport,
    /\d+ (hour|day)\(s\) ago/,
    'the shadowed-test FAIL must state the evidence\'s age in the report a reader sees'
  );
  assert.match(
    staleReport,
    /Re-verify the named blocker yourself/,
    'the message must tell the reader to re-verify before trusting the named blocker'
  );

  const noEvidenceReport = formatReport({
    ...base,
    shadowedTests: ['tests/zzz-shadowed-example.js'],
    shadowing: {
      ...base.shadowing,
      runEvidence: { available: false, generatedAt: null },
      shadowed: { 'tests/zzz-shadowed-example.js': shadowedDetail }
    }
  });
  assert.match(
    noEvidenceReport,
    /age is unknown/,
    'a missing generatedAt must be stated, not silently dropped from the FAIL block'
  );

  console.log('   ✓ shadowed-test FAIL states evidence age instead of asserting it live');
}

function testGuardFailsOnAnUnreferencedTool() {
  console.log('🧪 An unreferenced tool makes the guard go red...');
  // The acceptance test for the whole component, run in-process so it leaves
  // nothing behind if it throws.
  const probe = path.join(ROOT, 'tools', `zzz-invocation-guard-selftest-${process.pid}.js`);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    fs.rmSync(probe, { force: true });
    cleanedUp = true;
  };
  // Register before writing. The normal finally remains the primary path;
  // this also covers process exit between the write and that finally.
  process.once('exit', cleanup);
  try {
    fs.writeFileSync(probe, '#!/usr/bin/env node\nconsole.log("unwired");\n');
    const result = runGuard();
    const relative = `tools/${path.basename(probe)}`;
    assert.ok(!result.ok, 'guard must not pass while an unregistered mechanism exists');
    assert.ok(
      result.unregistered.includes(relative),
      'guard must name the specific unreferenced tool'
    );
  } finally {
    cleanup();
  }
  // Scoped to the probe on purpose. Asserting the whole repository is green
  // would make this test fail whenever another builder wires something and
  // leaves a now-stale registry entry -- real maintenance work, but not this
  // test's subject. A test that goes red for unrelated reasons is the kind that
  // gets muted, and muting is how every substitute in this repo got started.
  const after = runGuard();
  const relativeAfter = `tools/${path.basename(probe)}`;
  assert.ok(
    !after.unregistered.includes(relativeAfter),
    'the probe must stop being reported once it is removed'
  );
  console.log('   ✓ red with the probe, green without it');
}

function testGuardFailsOnATestOnlyLibrary() {
  console.log('🧪 A library whose only caller is its own test makes the guard go red...');
  // The acceptance test for the src/lib population, written against the exact
  // shape that slipped through: src/lib/audit-checkpoint.js was correct, had a
  // passing suite, and was "reachable" solely via
  // npm test -> its own test -> require(). It never ran in production, and the
  // cost landed on 2026-08-10 when a poisoned audit anchor left "fork or
  // truncation?" answerable only by a scratch copy that happened to survive.
  const libraryName = `zzz-invocation-guard-selftest-${process.pid}.js`;
  const library = path.join(ROOT, 'src', 'lib', libraryName);
  const relative = `src/lib/${libraryName}`;
  // A test that npm test already reaches, so the ONLY thing under examination
  // is whether a test-only edge counts as an invocation path.
  const suite = path.join(ROOT, 'tests', 'invocation-guard.test.js');
  const suiteSource = fs.readFileSync(suite, 'utf8');
  fs.writeFileSync(library, "'use strict';\nmodule.exports = { correct: () => true };\n");
  // THE PROBE LINE IS DEAD AT RUNTIME AND LIVE TO THE SCANNER, and that is the
  // whole point. Measured 2026-08-12: pretest step 4 was red because a bare
  // `require('../src/lib/zzz-invocation-guard-selftest-32164')` was sitting at
  // the end of THIS committed file. A previous run appended it, died before its
  // finally, and left a require of a file it had already deleted -- so every
  // later run printed "all checks passed" and then crashed with MODULE_NOT_FOUND
  // on exit. This probe edits a tracked source file in place; interrupted and
  // overlapping runs are a fact of a six-agent tree, so the debris must be
  // survivable rather than merely unlikely. Two changes make it so:
  //   * the appended require sits behind a condition no run ever satisfies, so
  //     leftover debris cannot execute. tools/invocation-guard.js reads source
  //     STATICALLY, so the edge it is asked to see is unchanged -- the three
  //     assertions below are what prove that, and they are what fail if the
  //     scanner ever stops counting a guarded require.
  //   * restoreSuite() is idempotent and also runs from a process-exit handler,
  //     so a throw, an assertion failure, or a plain crash restores the file.
  const probeLine = `if (process.env.ZZZ_INVOCATION_GUARD_PROBE === '${libraryName}') require('../src/lib/${libraryName.replace(/\.js$/, '')}');`;
  let restored = false;
  const restoreSuite = () => {
    if (restored) return;
    restored = true;
    try {
      fs.writeFileSync(suite, suiteSource);
      fs.rmSync(library, { force: true });
    } catch { /* a restore that cannot run must not mask the real failure */ }
  };
  process.once('exit', restoreSuite);
  fs.writeFileSync(suite, `${suiteSource}\n${probeLine}\n`);
  try {
    const result = runGuard();
    assert.ok(!result.ok, 'guard must not pass while a test-only library is unregistered');
    assert.ok(
      result.testOnlyLibraries.includes(relative),
      'guard must classify a library reached only through tests/ as test-only'
    );
    assert.ok(
      result.unregistered.includes(relative),
      'a test-only library must be gated, not merely reported'
    );
  } finally {
    restoreSuite();
  }
  const after = runGuard();
  assert.ok(!after.unregistered.includes(relative), 'the probe must stop being reported once it is removed');
  console.log('   ✓ red while only a test requires it, green once it is gone');
}

function testCallbackBodyIsNotAnArgument() {
  console.log('🧪 A path named inside a callback body is not an argument to the call...');
  // The fourth false green, measured 2026-08-11. src/lib/providers/web.js runs
  // execFile(pythonEnv, [extractScript, ...], opts, (error, out, err) => {...}),
  // and the ENOENT branch of that callback tells the reader
  //   'Run `pwsh tools/provision-research.ps1 -Python` to provision it. '
  // The whole call is one balanced paren span, so the advice printed BECAUSE the
  // tool has not been run scored as running it. The guard then called that
  // tool's registry entry stale and asked for it to be deleted -- and since the
  // registry may only shrink, deleting it erases the only record of an unrun
  // tool. Prose about a failure is the last place a real invocation lives.
  //
  // Assembled from fragments for the reason the file documents at the spawn
  // fixture above: written literally, a test naming a real tool inside a real
  // call makes THIS FILE wire that tool. The names below are deliberately not
  // real files, so a regression cannot launder anything through this suite.
  const source = [
    'exec', "File(interpreter, ['", 'tools/zzz-argv-position.js', "', dbPath], { windowsHide: true }, (error) => {",
    "  if (error.code === 'ENOENT') reject(fail('UNPROVISIONED', 'Run `pwsh ",
    'tools/zzz-advice-only.ps1', " -Python` to provision it.'));",
    '});'
  ].join('');
  const refs = extractReferences(path.join(ROOT, 'src', 'lib', 'providers', 'sample.js'), source, 'js');
  assert.ok(
    refs.files.includes('tools/zzz-argv-position.js'),
    'a path in the argv array before the callback MUST still count as an invocation'
  );
  assert.ok(
    !refs.files.includes('tools/zzz-advice-only.ps1'),
    'a path named in the callback body must NOT count as an invocation'
  );

  // The narrowing must not cut a call short: everything before the callback,
  // across lines, stays inside the span.
  const multiline = [`${'spawn'}Sync(process.execPath, [`, "  'tools/zzz-a.js',", "  'tools/zzz-b.js'", '], { cwd: ROOT }, () => {', "  'tools/zzz-c.js';", '});'].join('\n');
  const spans = executionSpans(multiline);
  const inside = (needle) => {
    const index = multiline.indexOf(needle);
    return spans.some(([start, end]) => index >= start && index <= end);
  };
  assert.ok(inside("'tools/zzz-a.js'"), 'first argv member is inside the span');
  assert.ok(inside("'tools/zzz-b.js'"), 'a later line of the same argv is inside the span');
  assert.ok(!inside("'tools/zzz-c.js'"), 'a path inside the callback body is outside the span');
  console.log('   ✓ argv counted, callback body excluded');
}

function testStalenessIsMeasuredStrictly() {
  console.log('🧪 An entry is never called stale on the loose definition...');
  // Staleness DELETES, and the registry may only shrink, so the stale test is
  // the one place the census's looser definition of "reachable" must not be
  // used. Measured 2026-08-11: tests/bridge-status.js is named by exactly one
  // npm script, test:bridge-status, which nothing in the repository invokes.
  // The guard's own --why printed NO INVOCATION PATH for it and its own
  // launderedTests list contained it, while the stale check -- reading the
  // census -- reported "registered as unreachable but it is now reachable --
  // delete this entry". Obeying that makes a real orphan permanently invisible.
  //
  // Stated as an invariant over the live repository rather than a probe: it
  // cannot be built from a probe without editing the shared package.json, and
  // an invariant stays true no matter who wires what next, so it goes red for
  // this defect and for nothing else.
  const result = runGuard();
  const staleFiles = result.stale.map((entry) => entry.file);
  const launderedAndStale = staleFiles.filter((file) => result.launderedTests.includes(file));
  assert.deepStrictEqual(
    launderedAndStale,
    [],
    'a test reachable only because an uninvoked npm script names it must not be reported stale'
  );
  const unreferencedAndStale = staleFiles.filter((file) => result.unreferencedLibraries.includes(file));
  assert.deepStrictEqual(
    unreferencedAndStale,
    [],
    'a library reached by nothing at all must not be reported "now reachable"'
  );
  console.log(`   ✓ ${staleFiles.length} stale entr(ies), none of them laundered`);
}

function testPowerShellDotSourceCrossesADirectory() {
  console.log('🧪 A PowerShell dot-source into a subdirectory is an invocation...');
  // Measured 2026-08-13. tools/secrets.ps1 and tools/secrets-manager.ps1 both
  // carry, verbatim:
  //     . (Join-Path $PSScriptRoot 'lib/vault-acl.ps1')
  // Dot-sourcing executes the file in the CALLER's own scope -- the strongest
  // invocation PowerShell has. The sibling rule captured `[\w.-]+\.ps1`, which
  // cannot cross a slash, so neither spelling matched and the guard reported
  // tools/lib/vault-acl.ps1 -- the ACL the product puts on a paying customer's
  // credential store -- as having NO INVOCATION PATH. A false RED on live code.
  //
  // Assembled from fragments for the reason the fixtures above document: written
  // literally, this file would itself become an invocation of the real tool.
  const source = [
    '. (Join-Path $PSScriptRoot ', "'lib/", 'vault-acl-zzz.ps1', "')\n",
    '& "$PSScriptRoot\\', 'lib\\', 'nested-zzz.ps1', '"\n'
  ].join('');
  const refs = extractReferences(path.join(ROOT, 'tools', 'sample.ps1'), source);
  assert.ok(
    refs.files.includes('tools/lib/vault-acl-zzz.ps1'),
    'Join-Path $PSScriptRoot with a subdirectory segment MUST count as an invocation'
  );
  assert.ok(
    refs.files.includes('tools/lib/nested-zzz.ps1'),
    '& "$PSScriptRoot\\sub\\file.ps1" MUST count as an invocation'
  );
  // The single-segment spelling that already worked must keep working.
  const flat = extractReferences(path.join(ROOT, 'tools', 'sample.ps1'), ['& "$PSScriptRoot\\', 'flat-zzz.ps1', '"'].join(''));
  assert.ok(flat.files.includes('tools/flat-zzz.ps1'), 'the flat sibling spelling must not regress');
  console.log('   ✓ dot-source and call operator both cross a directory');
}

function testManualEntriesCarryTheirDependencies() {
  console.log('🧪 What a human runs by hand runs everything it requires...');
  // A `manual` entry is a typed statement that a person genuinely invokes this
  // by hand. Whatever it requires therefore REALLY EXECUTES when they do.
  //
  // Before this, the guard had a corner with no honest exit. tools/purchase-cart.js
  // is a hand-run CLI whose whole purpose is answering "what is in my cart" with
  // no app build, no bridge port and no browser; it projects through
  // src/lib/purchase-cart-view.js. Registering the CLI honestly still left the
  // library reported as debt, and a library can never be "manual" -- nobody runs
  // a module by hand -- so the only move left was a `baseline` entry, i.e.
  // recording a mechanism that demonstrably runs as one that does not. Fourteen
  // src/lib modules sat behind exactly one hand-run CLI each on 2026-08-13.
  //
  // Driven through computeReachable with an IN-MEMORY registry on purpose: a
  // test that wrote config/invocation-registry.json would be a test that mutates
  // a tracked config file, which tests/run-isolated.js answers with
  // `git checkout --` on that path -- destroying whatever uncommitted registry
  // work a peer had in flight.
  const stamp = `zzz-invocation-guard-manual-${process.pid}`;
  const cli = path.join(ROOT, 'tools', `${stamp}.js`);
  const library = path.join(ROOT, 'src', 'lib', `${stamp}.js`);
  const cliRelative = `tools/${stamp}.js`;
  const libraryRelative = `src/lib/${stamp}.js`;
  let restored = false;
  const cleanup = () => {
    if (restored) return;
    restored = true;
    try {
      fs.rmSync(cli, { force: true });
      fs.rmSync(library, { force: true });
    } catch { /* a cleanup that cannot run must not mask the real failure */ }
  };
  process.once('exit', cleanup);
  try {
    fs.writeFileSync(library, "'use strict';\nmodule.exports = { correct: () => true };\n");
    fs.writeFileSync(cli, `'use strict';\nrequire('../src/lib/${stamp}');\n`);
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};

    const asManual = computeReachable(
      { roots: [], entries: { [cliRelative]: { status: 'manual', reason: 'a person runs this by hand, which is the whole point of the status' } } },
      scripts,
      { expandTests: false }
    );
    assert.ok(
      asManual.reachableFiles.has(libraryRelative),
      'a library required by a hand-run CLI must be production-reachable through it'
    );
    // Load-bearing: a registered entry whose subject becomes reachable is
    // reported STALE with "delete this entry". If the manual file seeded itself
    // as reachable, every manual entry would demand its own deletion, and the
    // deletion would make the subtree unreachable again.
    assert.ok(
      !asManual.reachableFiles.has(cliRelative),
      'the manual entry\'s own file must NOT be marked reachable, or its entry would go stale forever'
    );

    const asBaseline = computeReachable(
      { roots: [], entries: { [cliRelative]: { status: 'baseline', seededAt: '2026-08-13' } } },
      scripts,
      { expandTests: false }
    );
    assert.ok(
      !asBaseline.reachableFiles.has(libraryRelative),
      'baseline means NOTHING runs it, so it must never carry reachability -- that would make every recorded orphan an umbrella'
    );
  } finally {
    cleanup();
  }
  console.log('   ✓ manual propagates, baseline does not, and the entry does not delete itself');
}

function testStalenessNamesAPrintableChain() {
  console.log('🧪 "It is now reachable" must be a measurement, not an inference...');
  // Staleness DELETES and the registry may only shrink, so "it is now reachable"
  // has to be something the guard computed. Until 2026-08-13 it was inferred
  // from a file's ABSENCE from three filtered populations -- tools/ by
  // extension, tests/ by the census's isCandidate, src/lib by directory. A
  // registered file in none of them was declared reachable without its
  // reachability ever being computed. Measured the same day: 54 files under
  // tests/ are unreachable AND outside every population (package run.js
  // runners, fixtures, worker helpers, all excluded by isCandidate), so
  // registering any one of them would have produced an immediate demand for its
  // own deletion while nothing on earth ran it.
  //
  // The invariant below is the measurement itself: `cameFrom` is the map the
  // guard prints chains from, so if an entry is called stale, --why must be able
  // to show the chain that reaches it. An inference cannot satisfy this.
  const result = runGuard();
  const claimedReachable = result.stale.filter((entry) => entry.why.includes('now reachable'));
  const withoutAChain = claimedReachable.filter((entry) => !result.cameFrom.has(entry.file));
  assert.deepStrictEqual(
    withoutAChain.map((entry) => entry.file),
    [],
    'no entry may be called "now reachable" unless the guard can print the chain that reaches it'
  );
  console.log(`   ✓ ${claimedReachable.length} "now reachable" verdict(s), every one with a printable chain`);
}

function testReleaseExclusionsAreExactAndFailClosed() {
  console.log('Desktop release scope keeps exact exclusions visible and fail-closed...');
  const payments = [
    'src/lib/entitlement.js',
    'src/lib/license-store.js',
    'src/lib/providers/license.js'
  ];
  assert.deepStrictEqual([...RELEASE_EXCLUDED_PAYMENT_LIBRARIES], payments,
    'the payment exclusion must remain the same inspectable exact set');
  // Emptied 2026-09-06 with the constant it pins. The four iPhone prototype
  // paths this listed were deleted by ebd6447, which made every one of these
  // exclusions stale and exited the guard 1. The set stays pinned, and pinned
  // as EXACT, so that an empty owner-deferred scope cannot quietly grow into a
  // mobile-prefix blanket exclusion later.
  const ownerDeferred = [];
  assert.deepStrictEqual([...RELEASE_EXCLUDED_OWNER_DEFERRED_LIBRARIES], ownerDeferred,
    'owner-deferred desktop scope must not become a mobile-prefix blanket exclusion');
  const exact = [...payments, ...ownerDeferred];

  const unrelated = [
    'src/lib/unrelated-dead-customer-mechanism.js',
    'src/lib/iphone-handoff-unreviewed-new-mechanism.js'
  ];
  const result = validateReleaseExcludedLibraries({
    libraries: [...exact, ...unrelated],
    testOnlyLibraries: [...exact, ...unrelated],
    unreferencedLibraries: [],
    productionReachable: new Set()
  });
  assert.deepStrictEqual(result.excluded, exact);
  assert.deepStrictEqual(result.gated, unrelated,
    'unrelated and mobile-looking test-only libraries must remain gated');
  assert.deepStrictEqual(result.issues, []);

  for (const changed of exact) {
    const others = exact.filter(file => file !== changed);
    const withRuntimeEdge = validateReleaseExcludedLibraries({
      libraries: exact,
      testOnlyLibraries: others,
      unreferencedLibraries: [],
      productionReachable: new Set([changed])
    });
    assert.ok(withRuntimeEdge.issues.some(({ file, why }) => file === changed && /production-reachable/.test(why)),
      `a new runtime edge into ${changed} must fail the release`);
    assert.ok(!withRuntimeEdge.excluded.includes(changed),
      'a production-reachable library cannot retain its scope exclusion');
    const withStalePath = validateReleaseExcludedLibraries({
      libraries: others,
      testOnlyLibraries: others,
      unreferencedLibraries: [],
      productionReachable: new Set()
    });
    assert.ok(withStalePath.issues.some(({ file, why }) => file === changed && /no longer exists/.test(why)),
      `a removed exact exclusion for ${changed} must fail until updated`);
  }
  const measured = runGuard();
  // The loop below went vacuous when ownerDeferred emptied, so the four retired
  // paths would otherwise leave the measured tree unchecked entirely. Assert the
  // retirement directly instead: they must be gone, and their exclusion must not
  // reappear to re-create the stale entry this commit removed.
  const retiredByEbd6447 = [
    'src/lib/iphone-handoff-contract.js',
    'src/lib/iphone-handoff-controller-adapter.js',
    'src/lib/iphone-handoff-controller-route.js',
    'src/lib/iphone-handoff-observation.js'
  ];
  for (const file of retiredByEbd6447) {
    assert.ok(!measured.releaseExcludedLibraries.includes(file),
      `${file} was retired; a re-added exclusion for it would be stale on arrival`);
    assert.ok(!measured.testOnlyLibraries.includes(file),
      `${file} no longer exists, so nothing may still report it as a library`);
  }
  for (const file of ownerDeferred) {
    assert.ok(measured.testOnlyLibraries.includes(file),
      `${file} must still be reported honestly as test-only, not production-wired`);
    assert.ok(measured.releaseExcludedLibraries.includes(file));
    assert.ok(!measured.productionCameFrom.has(file));
  }
  console.log('   exact scope visible; unrelated, stale-path and runtime-edge mutations stay red');
}

function main() {
  console.log('Invocation guard regression suite');
  console.log(`  node ${process.version} on ${os.platform()}`);
  testProseInStringsIsNotInvocation();
  testRequireStillCounts();
  testExecutedConfigCarriesHookEdges();
  testExplorerLaunchersCarryOnlyExecutableEdges();
  testDeclaredRootsMustExist();
  testDeclaredDynamicEdgesFailClosed();
  testCoordinatorBudgetDutyCarriesItsRealDynamicLoad();
  testToolRequiredOnlyByATestIsNotProductionReachable();
  testDesktopPayloadModulesAreProductionRoots();
  testStrictReleaseRootNeedsItsRealExternalDeclaration();
  testHistoricalFindingsSurviveProgramRetirement();
  testPersistentVaultHostHasItsActualSpawnEdge();
  testCoordinatorEscalationFollowsItsRealDynamicLoad();
  testProductionClassesDoNotMasqueradeAsReachability();
  testExecutionSpansAreBalanced();
  testCallbackBodyIsNotAnArgument();
  testPowerShellDotSourceCrossesADirectory();
  testStalenessIsMeasuredStrictly();
  testStalenessNamesAPrintableChain();
  testReleaseExclusionsAreExactAndFailClosed();
  testManualEntriesCarryTheirDependencies();
  testSeedingPreservesHandWrittenReasons();
  testShadowingIsExpressible();
  testAnOptInSkipIsNotABlocker();
  testShadowedReportStatesEvidenceAge();
  testGuardFailsOnAnUnreferencedTool();
  testGuardFailsOnATestOnlyLibrary();
  console.log('✅ invocation-guard: all checks passed');
}

main();
