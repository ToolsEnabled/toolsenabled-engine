'use strict';
// Proves that the cross-implementation drift check inside
// tests/provider-launch-scrub.test.js can actually fail.
//
// WHY THIS IS A SEPARATE FILE. The drift block compares this repo's shared
// scrub against src/lib/multi-account/launch.js. While that module is present
// and healthy, the block passes -- and it would ALSO pass if the block were
// quietly reverted to swallowing load errors. A test cannot detect its own
// regression to a silent skip using only the healthy case, so the failure
// modes are exercised here against fixtures instead.
//
// The hole this closes was found by multi-account-build, who reproduced it
// rather than asserting it: with launch.js moved out of the tree entirely, the
// original block still exited 0 and printed "passed", the only difference in
// the world being one unasserted line of stdout. A syntax error, a rename or a
// broken transitive require all landed in that same silent green.
//
// This deliberately does NOT touch src/lib/multi-account/launch.js. That file
// belongs to a live lane; mutating it to test my own code would risk their
// work. The real test is copied with its launchPath redirected at fixtures
// owned by this file, and the original is sha256-verified unchanged at the end.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const REAL_TEST = path.join(__dirname, 'provider-launch-scrub.test.js');
// Generated beside the real test so __dirname-relative paths still resolve.
const TEMP_TEST = path.join(__dirname, `.drift-selfcheck.${process.pid}.generated.js`);
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-selfcheck-'));

// A plain finally handles assertions and ordinary failures, but it does not
// cover every way a test runner can terminate this process. Register the same
// idempotent cleanup on exit before the first generated file is written, so an
// interrupted self-check cannot leave a PID-named test in the repository.
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  fs.rmSync(TEMP_TEST, { force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  cleanedUp = true;
}
process.once('exit', cleanup);

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const realBefore = sha(REAL_TEST);

const ORIGINAL_LINE = "    const launchPath = path.resolve(__dirname, '..', 'src', 'lib', 'multi-account', 'launch.js');";
const source = fs.readFileSync(REAL_TEST, 'utf8');
assert.ok(source.includes(ORIGINAL_LINE),
  'provider-launch-scrub.test.js no longer resolves launchPath the way this self-check expects; update this file rather than deleting the check');

const scrubModule = path.join(root, 'src', 'lib', 'providers', 'subscription-launch-env.js').replace(/\\/g, '/');

const AGREES = `'use strict';
const { subscriptionLaunchEnvironment } = require(${JSON.stringify(scrubModule)});
module.exports = { scrubbedEnvironment: base => { const e = subscriptionLaunchEnvironment(base); delete e.CODEX_HOME; return e; } };
`;
const DISAGREES = `'use strict';
const { subscriptionLaunchEnvironment } = require(${JSON.stringify(scrubModule)});
module.exports = { scrubbedEnvironment: base => { const e = subscriptionLaunchEnvironment(base); e.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY; return e; } };
`;
const NO_EXPORT = "'use strict';\nmodule.exports = { somethingElse: () => ({}) };\n";
const BROKEN = "'use strict';\nthis is not valid javascript at all (((\n";

const CASES = [
  // The only benign case: the sibling lane has not landed its module yet.
  { label: 'sibling module absent', fixture: null, expect: 0 },
  { label: 'sibling module present and agreeing', fixture: AGREES, expect: 0 },
  // Each of these was a silent green before the fix.
  { label: 'sibling module disagrees on the scrub', fixture: DISAGREES, expect: 1 },
  { label: 'sibling module exposes no scrubbedEnvironment', fixture: NO_EXPORT, expect: 1 },
  { label: 'sibling module fails to load', fixture: BROKEN, expect: 1 }
];

// The independent rule-table pin, exercised the same way. The provider
// gateway now imports the dependency-light launch policy, so the real test
// reads ENVIRONMENT_RULES from launch-environment.js instead of re-parsing a
// hand-maintained gateway body. Redirect that exact path expression to a
// disposable fixture; the real policy source is read and hash-checked only.
const POLICY_PATH_EXPRESSION = "path.join(root, 'src', 'lib', 'supervision', 'launch-environment.js')";
const REAL_POLICY = path.join(root, 'src', 'lib', 'supervision', 'launch-environment.js');

function policyCases() {
  const realSource = fs.readFileSync(REAL_POLICY, 'utf8');
  // Drop exactly the three AWS credentials that a size floor cannot catch:
  // 23 declared minus 3 is 20, which still clears a `>= 20` floor, and none of
  // the three is in BILLING_TRIPWIRE either. Before the names were pinned this
  // was a silent green.
  const weakened = realSource
    .replace(/'AWS_ACCESS_KEY_ID',\s*\n?\s*/, '')
    .replace(/'AWS_SECRET_ACCESS_KEY', /, '')
    .replace(/'AWS_SESSION_TOKEN', /, '');
  assert.notEqual(weakened, realSource, 'the gateway-weakening fixture did not apply; this self-check would prove nothing');
  return [
    { label: 'launch policy source intact', source: realSource, expect: 0 },
    { label: 'launch policy silently stops scrubbing 3 AWS credentials', source: weakened, expect: 1 }
  ];
}

const failures = [];
try {
  for (const testCase of CASES) {
    const fixturePath = path.join(FIXTURES, 'launch.js');
    if (testCase.fixture === null) { if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath); }
    else fs.writeFileSync(fixturePath, testCase.fixture, 'utf8');

    const redirected = source.replace(ORIGINAL_LINE, `    const launchPath = ${JSON.stringify(fixturePath)};`);
    assert.notEqual(redirected, source, 'the launchPath redirect did not apply');
    fs.writeFileSync(TEMP_TEST, redirected, 'utf8');

    const run = spawnSync(process.execPath, [TEMP_TEST], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 180000
    });
    const observed = run.status === 0 ? 0 : 1;
    if (observed !== testCase.expect) {
      failures.push(`${testCase.label}: expected exit ${testCase.expect}, got ${run.status}`);
    }
  }
  // -- the shared launch-policy rule-table pin ----------------------------
  const policyBefore = crypto.createHash('sha256').update(fs.readFileSync(REAL_POLICY)).digest('hex');
  assert.ok(source.includes(POLICY_PATH_EXPRESSION),
    'provider-launch-scrub.test.js no longer reads the launch policy source the way this self-check expects');

  // Keep the sibling fixture agreeing so only the gateway pin is under test.
  fs.writeFileSync(path.join(FIXTURES, 'launch.js'), AGREES, 'utf8');

  for (const testCase of policyCases()) {
    const policyFixture = path.join(FIXTURES, 'launch-environment-source.js.txt');
    fs.writeFileSync(policyFixture, testCase.source, 'utf8');

    const redirected = source
      .replace(ORIGINAL_LINE, `    const launchPath = ${JSON.stringify(path.join(FIXTURES, 'launch.js'))};`)
      .replace(POLICY_PATH_EXPRESSION, JSON.stringify(policyFixture));
    assert.notEqual(redirected, source, 'the gateway redirect did not apply');
    fs.writeFileSync(TEMP_TEST, redirected, 'utf8');

    const run = spawnSync(process.execPath, [TEMP_TEST], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 180000
    });
    const observed = run.status === 0 ? 0 : 1;
    if (observed !== testCase.expect) {
      failures.push(`${testCase.label}: expected exit ${testCase.expect}, got ${run.status}`);
    }
  }

  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(REAL_POLICY)).digest('hex'), policyBefore,
    'this self-check must never modify launch-environment.js');
} finally {
  cleanup();
}

assert.deepEqual(failures, [],
  `the drift check in provider-launch-scrub.test.js must fail for a broken or disagreeing sibling module:\n${failures.join('\n')}`);

assert.equal(sha(REAL_TEST), realBefore,
  'this self-check must leave provider-launch-scrub.test.js byte-identical');

console.log(`Drift-check self-check: ${CASES.length} drift cases + 2 gateway-pin cases behaved correctly; provider-launch-scrub.test.js unchanged.`);
console.log('Provider launch scrub self-check passed.');
