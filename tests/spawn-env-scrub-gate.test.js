/* EXECUTABLE CHANGE
 *
 * Discrimination report (2026-08-26): temporarily mutated the checker to throw
 * instead of returning the SPREADS_AMBIENT finding when ambient state follows
 * a scrub helper.  B5's old exit-status-only assertion stayed green because
 * the checker still exited 1.  With the assertion below, it went red with:
 *   "the gate emitted no SPREADS_AMBIENT finding for process.env restored
 *    after the scrub helper"
 * After tools/check-spawn-env-scrub.js was restored byte-for-byte (matching
 * SHA-256 40e78b10...329d4b), B5 and all other throwaway-tree cases were green.
 *
 * NOT-FOUND: empty assertion collections (both loops use non-empty literals);
 * swallowed test failures (the JSON catch is followed by assertions that fail
 * on null); mocks of the subject; whole-file skips/platform preconditions; and
 * expected values computed by the implementation under test.  The unmet
 * precondition under the default Node 20 was node:sqlite; Node 22.22.2 was used
 * for mutation/restoration.  A full restored run could not be green because
 * pre-existing B8 output exceeds spawnSync's buffer here and is truncated at
 * JSON position 146176 ("Unterminated string").
 */
'use strict';

/*
 * CAN A CHILD PROCESS STILL BE HANDED THE OWNER'S BILLING CREDENTIALS?
 *
 * Two halves, because either alone gives a false sense of safety:
 *
 *   BEHAVIOUR  spawn a REAL child through the production call sites and ask
 *              the child what it can actually read. The environment object is
 *              not the authority -- the OS is -- so a test that inspects the
 *              object and stops has verified our bookkeeping, not the thing
 *              that bills the account.
 *
 *   GATE       the same defect had been found and fixed SIX times by
 *              2026-08-10. Fixing instance seven by hand is not a defence, so
 *              tools/check-spawn-env-scrub.js fails the build on a NEW
 *              unscrubbed spawn. These cases prove it actually goes red --
 *              including on an OMITTED `env`, which is the shape that reads as
 *              "no option here" rather than "wrong option here" and is exactly
 *              how the agent-host.cjs leak survived review.
 *
 * CASE IS LOAD-BEARING. Windows resolves environment names case-INSENSITIVELY;
 * a plain JS object does not. Measured 2026-08-10, 2 of 3 casings of
 * ANTHROPIC_API_KEY reached a real child through the authoritative scrub. So
 * the mis-cased plant below is not decoration: a fix that only handles the
 * exact spelling passes an exact-spelling test and still leaks.
 *
 * No assertion here prints a variable VALUE. Names and set/unset only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'tools', 'check-spawn-env-scrub.js');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

/* A value that would be actively harmful if it were inherited, so a pass means
 * the variable was REMOVED rather than merely absent on this machine. */
const SENTINEL = 'sentinel-would-bill-a-metered-account';
const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID'];

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-env-scrub-'));
process.on('exit', () => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ } });

/* A child that reports which credential NAMES its own process resolves. Node's
 * process.env is case-insensitive on Windows, which is the point: it answers
 * the same way the provider CLI would. */
const PROBE = path.join(workspace, 'probe.js');
fs.writeFileSync(PROBE, `
const fs = require('node:fs');
const names = ${JSON.stringify(CREDENTIAL_NAMES)};
const seen = names.filter(name => process.env[name] !== undefined);
const spellings = Object.keys(process.env).filter(k => /anthropic|openai|aws_access|toolsenabled_tool_allowlist/i.test(k));
fs.writeFileSync(process.env.PROBE_SINK, JSON.stringify({ seen, spellings, canary: process.env.PROBE_CANARY || null }));
`, 'utf8');

function readChildReport(sink) {
  check(fs.existsSync(sink), 'the probe child never wrote its report, so nothing below actually measured a real child');
  return JSON.parse(fs.readFileSync(sink, 'utf8'));
}

async function main() {

/* =====================================================================
 * A. BEHAVIOUR -- a real child, spawned by the production code path.
 * ===================================================================== */

/* ---------- A1/A2: src/lib/agent-lane.js spawnChild() ---------- */
{
  const lane = require('../src/lib/agent-lane.js');

  for (const spelling of ['ANTHROPIC_API_KEY', 'anthropic_api_key']) {
    // Plant ONE spelling at a time. On Windows process.env stores whichever
    // spelling was written first, so this genuinely reproduces a machine where
    // the owner (or an installer) ran `setx anthropic_api_key ...` -- an
    // entirely ordinary thing to do, because Windows does not care about case.
    for (const name of [...CREDENTIAL_NAMES, 'anthropic_api_key']) delete process.env[name];
    process.env[spelling] = SENTINEL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/redirector';
    process.env.OPENAI_API_KEY = SENTINEL;
    process.env.AWS_ACCESS_KEY_ID = SENTINEL;
    process.env.TOOLSENABLED_LANE_RUN_TEST = '1';

    const sink = path.join(workspace, `lane-${spelling}.json`);
    process.env.PROBE_SINK = sink;
    process.env.PROBE_CANARY = 'must-survive';

    const { started, result } = lane.spawnChild({
      agentId: 'spawn-env-scrub-test',
      role: 'builder',
      tier: 'opus',
      lane: 'env-passthrough-gate',
      territory: 'test',
      worktree: workspace,
      consoleLog: path.join(workspace, `console-${spelling}.log`),
      command: process.execPath,
      childArgs: [PROBE]
    }, 'probe-prompt');

    // The lane's own promises settle when the real child closes.
    // eslint-disable-next-line no-await-in-loop
    await started;
    // eslint-disable-next-line no-await-in-loop
    await result;

    const report = readChildReport(sink);
    check(report.seen.length === 0,
      `agent-lane spawnChild handed a REAL child ${report.seen.join(', ')} when the credential was spelled ${spelling}; a lane child is a Claude or Codex CLI and an ambient API key takes precedence over the subscription login`);
    check(report.spellings.length === 0,
      `agent-lane spawnChild left the raw spelling(s) ${report.spellings.join(', ')} in the real child's environment; removal must match the whole name case-insensitively, because the OS lookup does`);
    check(report.canary === 'must-survive',
      'agent-lane spawnChild dropped a NON-credential variable, so the scrub is filtering the environment rather than removing named credentials');
  }
}

/* ---------- A3: the composition the native agent launcher uses ---------- */
{
  /* native-agent-launcher.js builds its child env as
   *     safeLaunchEnvironment(process.env, ...) then deleteEnvironmentNames(env, [ALLOWLIST])
   * Running the launcher itself needs an MCP registry pinned to another
   * machine, so this exercises that exact COMPOSITION against a real child;
   * the gate (case B below) is what proves the launcher still calls it. */
  const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');
  const { deleteEnvironmentNames } = require('../src/lib/providers/cli-provider-gateway.js');

  const base = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    anthropic_api_key: SENTINEL,          // mis-cased credential
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/redirector',
    toolsenabled_tool_allowlist: 'narrowed', // mis-cased profile restriction
    PROBE_CANARY: 'must-survive'
  };
  const built = deleteEnvironmentNames(
    safeLaunchEnvironment(base, { context: 'native local agent test' }),
    ['TOOLSENABLED_TOOL_ALLOWLIST']
  );
  const sink = path.join(workspace, 'native.json');
  built.PROBE_SINK = sink;

  const run = spawnSync(process.execPath, [PROBE], { env: built, windowsHide: true });
  check(run.error === undefined, `the native-agent composition probe failed to spawn: ${run.error && run.error.message}`);
  const report = readChildReport(sink);
  check(report.seen.length === 0,
    `the native-agent env composition handed a REAL child ${report.seen.join(', ')}; that child runs a Claude CLI at bypassPermissions`);
  check(report.spellings.length === 0,
    `the native-agent env composition left ${report.spellings.join(', ')} readable by a real child; the mis-cased TOOLSENABLED_TOOL_ALLOWLIST must go too, or the agent silently inherits a narrowed tool profile`);
  check(report.canary === 'must-survive',
    'the native-agent env composition dropped a non-credential variable, so it is filtering rather than removing named credentials');
}

/* ---------- A4: the actual persistent-vault worker boundary ---------- */
{
  const vm = require('node:vm');
  const workerFile = path.join(ROOT, 'src', 'lib', 'vault-host', 'worker.js');
  const source = fs.readFileSync(workerFile, 'utf8');
  for (const supplied of [null, {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    anthropic_api_key: SENTINEL, OPENAI_API_KEY: SENTINEL,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/redirector',
    PROBE_CANARY: 'must-survive'
  }]) {
    let receive;
    const captured = [];
    const replies = [];
    /* The worker registers its shutdown handlers with once(), on both the port
       and the process -- src/lib/vault-host/worker.js:212-213, added by
       6e9d973d. A real MessagePort and a real process both have once(); this
       fixture's parentPort had only on(), so loading the module under vm threw
       "parentPort.once is not a function" before a single environment
       assertion ran. The handlers are kept rather than dropped, and the event
       names are still asserted, so a worker that starts listening for
       something else trips this fixture instead of being quietly accepted. */
    const shutdownHandlers = [];
    const workerRequire = name => {
      if (name === 'node:worker_threads') return { parentPort: {
        on(event, fn) { assert.equal(event, 'message'); receive = fn; },
        once(event, fn) { assert.equal(event, 'close'); shutdownHandlers.push({ source: 'parentPort', event, fn }); }
      } };
      if (name === 'node:child_process') return { spawn(command, args, options) {
        captured.push({ command, args, options });
        throw new Error('fixture intercepts the native host after environment construction');
      } };
      if (name === '../runtime-state-root') return { programOrStatePath: (root, parts) => path.join(root, ...parts) };
      if (name === '../supervision/launch-environment') return require('../src/lib/supervision/launch-environment');
      return require(name);
    };
    vm.runInNewContext(source, {
      require: workerRequire, __dirname: path.dirname(workerFile),
      process: { env: {},
        once(event, fn) { assert.equal(event, 'exit'); shutdownHandlers.push({ source: 'process', event, fn }); } },
      Atomics, setTimeout, clearTimeout
    }, { filename: workerFile, timeout: 1000 });
    check(typeof receive === 'function', 'the actual worker must register its request handler');
    const sab = new Int32Array(new SharedArrayBuffer(4));
    // The worker serializes requests on its private queue; its event listener
    // does not return that queue. Await actual port delivery, as the real
    // caller does, rather than one arbitrary microtask after dispatch.
    const { MessageChannel } = require('node:worker_threads');
    const { port1, port2 } = new MessageChannel();
    let replyDeadline;
    try {
      const delivered = new Promise((resolve, reject) => {
        replyDeadline = setTimeout(() => reject(new Error('vault worker did not settle its caller')), 5000);
        port1.once('message', value => { replies.push(value); resolve(); });
      });
      receive({ sab, port: port2, payload: { action: '__diagnostics_pid' }, env: supplied });
      await delivered;
    } finally {
      clearTimeout(replyDeadline);
      port1.close();
      port2.close();
    }
    check(Atomics.load(sab, 0) === 1 && replies.length === 1,
      'an intercepted or refused worker request must still settle the synchronous caller');
    if (supplied === null) {
      check(captured.length === 0, 'a null worker env must refuse before spawning, not inherit process.env');
      check(replies[0].unavailable === true, 'invalid worker input must retain the unavailable/fallback contract');
    } else {
      check(captured.length === 1, 'the actual worker spawn boundary must be observed exactly once');
      const { command, args, options } = captured[0];
      check(command === 'powershell.exe' && args.includes('-NonInteractive') && options.windowsHide === true,
        'persistent vault helper must retain its fixed hidden noninteractive executable');
      const sink = path.join(workspace, 'vault-worker.json');
      const child = spawnSync(process.execPath, [PROBE], {
        env: { ...options.env, PROBE_SINK: sink }, windowsHide: true
      });
      check(!child.error && child.status === 0, 'the vault-worker environment must support a real finite child');
      const report = readChildReport(sink);
      check(report.seen.length === 0 && report.spellings.length === 0,
        'the real child must not inherit credential names through the vault worker');
      check(report.canary === 'must-survive', 'the vault worker scrub must preserve benign environment values');
      check(supplied.anthropic_api_key === SENTINEL, 'the worker must not mutate its caller environment');
    }
  }
}

/* =====================================================================
 * B. THE GATE -- does it actually go red?
 *
 * Each case builds a throwaway tree and runs the real checker against it with
 * --root, so these prove the shipped tool's behaviour rather than a copy of
 * its logic.
 * ===================================================================== */

function runGate(tree, extraArgs = []) {
  const run = spawnSync(process.execPath, [CHECKER, '--root', tree, '--json', ...extraArgs], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { /* non-JSON on hard failure */ }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, parsed };
}

function makeTree(name, sourceText, { allowlist, baseline } = {}) {
  const tree = path.join(workspace, name);
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'src', 'subject.js'), sourceText, 'utf8');
  if (allowlist) fs.writeFileSync(path.join(tree, 'tools', 'spawn-env-scrub-allowlist.json'), JSON.stringify(allowlist, null, 2), 'utf8');
  fs.writeFileSync(path.join(tree, 'tools', 'spawn-env-scrub-baseline.json'), JSON.stringify({ version: 1, debt: baseline || {} }, null, 2), 'utf8');
  return tree;
}

const verdictsIn = result => (result.parsed && result.parsed.failures || []).map(f => f.verdict);

/* ---------- B1: a spread of process.env ---------- */
{
  const tree = makeTree('b1', "const { spawn } = require('node:child_process');\nspawn('claude', ['--print'], { env: { ...process.env, X: '1' } });\n");
  const result = runGate(tree);
  check(result.status === 1, 'the gate exited 0 on a spawn that spreads process.env into the child');
  check(verdictsIn(result).includes('SPREADS_AMBIENT'), 'the gate did not classify a `{ ...process.env }` child environment as SPREADS_AMBIENT');
  check((result.parsed.failures[0].line | 0) === 2, 'the gate reported the wrong line for the offending spawn; a count without a location is not actionable');
}

/* ---------- B2: an OMITTED env -- the agent-host.cjs shape ---------- */
{
  const tree = makeTree('b2', "const { spawn } = require('node:child_process');\nspawn('claude', ['--print'], { windowsHide: true });\n");
  const result = runGate(tree);
  check(result.status === 1, 'the gate exited 0 on a spawn with NO env option, which inherits the FULL process.env');
  check(verdictsIn(result).includes('INHERITS_AMBIENT'), 'the gate did not classify an omitted `env` as INHERITS_AMBIENT; node falls back to process.env and that fallback was the real agent-host.cjs leak');
}

/* ---------- B3: a hand-rolled delete list is NOT a scrub ---------- */
{
  const tree = makeTree('b3', [
    "const { spawn } = require('node:child_process');",
    'const env = { ...process.env };',
    'delete env.ANTHROPIC_API_KEY;',
    "spawn('claude', ['--print'], { env });"
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate accepted a hand-rolled `delete env.ANTHROPIC_API_KEY` as a scrub; that removes ONE SPELLING and leaves anthropic_api_key for the child');
  // Search rather than index [0]: since 2026-08-11 the same source also raises a
  // HAND_ROLLED_CREDENTIAL_DELETE finding, and asserting on the first element
  // silently tests whichever scanner happens to run first.
  const failures = result.parsed.failures || [];
  check(failures.some(f => (f.handRolledDeletes || []).includes('ANTHROPIC_API_KEY')),
    'the gate did not surface the hand-rolled delete list, so a reviewer cannot see the case-sensitivity defect it carries');
  check(failures.some(f => f.verdict === 'HAND_ROLLED_CREDENTIAL_DELETE'),
    'the gate reported the hand-rolled delete only as an advisory note on the spawn; an exact-case credential delete is now a failure in its own right');
}

/* ---------- B4: the sanctioned helper passes ---------- */
{
  const tree = makeTree('b4', [
    "const { spawn } = require('node:child_process');",
    "const { safeLaunchEnvironment } = require('./env.js');",
    "spawn('claude', ['--print'], { env: { ...safeLaunchEnvironment(process.env, { context: 'x' }), TAG: '1' } });"
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 0, `the gate failed a spawn whose env is built by safeLaunchEnvironment(): ${result.stderr}`);
}

/* ---------- B5: process.env alongside a helper is still a leak ---------- */
{
  const tree = makeTree('b5', [
    "const { spawn } = require('node:child_process');",
    "const { safeLaunchEnvironment } = require('./env.js');",
    "spawn('claude', ['--print'], { env: { ...safeLaunchEnvironment(process.env), ...process.env } });"
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate passed an env that calls the scrub helper and THEN spreads process.env back over it; the helper being mentioned is not the same as the helper being effective');
  check(verdictsIn(result).includes('SPREADS_AMBIENT'),
    'the gate emitted no SPREADS_AMBIENT finding for process.env restored after the scrub helper');
}

/* ---------- B6: a reasonless allowlist entry is refused ---------- */
{
  const source = "const { spawn } = require('node:child_process');\nspawn('taskkill', ['/F'], { windowsHide: true });\n";
  const withReason = makeTree('b6-ok', source, {
    allowlist: { version: 1, entries: [{ file: 'src/subject.js', symbol: 'spawn', command: 'taskkill', reason: 'taskkill with fixed argv cannot reach a provider account or spend anything.', reviewedBy: 'test' }] }
  });
  check(runGate(withReason).status === 0, 'the gate rejected a properly reasoned allowlist entry');

  const withoutReason = makeTree('b6-bad', source, {
    allowlist: { version: 1, entries: [{ file: 'src/subject.js', symbol: 'spawn', command: 'taskkill', reason: 'ok', reviewedBy: 'test' }] }
  });
  const bad = runGate(withoutReason);
  check(bad.status === 1, 'the gate accepted an allowlist entry whose reason is a shrug; an allowlist without reasons rots into a bypass');
  check(/reason/i.test(bad.stderr), 'the gate rejected the reasonless entry without saying that the reason was the problem');

  const noReviewer = makeTree('b6-noreviewer', source, {
    allowlist: { version: 1, entries: [{ file: 'src/subject.js', symbol: 'spawn', command: 'taskkill', reason: 'taskkill with fixed argv cannot reach a provider account or spend anything.' }] }
  });
  const noReviewerResult = runGate(noReviewer);
  check(noReviewerResult.status === 1, 'the gate accepted an allowlist entry with no reviewer, so nobody is accountable for the exemption');
  check((noReviewerResult.parsed.allowlistProblems || []).some(problem => /reviewer/i.test(problem)),
    'the gate failed the no-reviewer case without evidence that the missing reviewer caused the failure');

  /* An entry that outlives its call site is a standing permission attached to
   * nothing. The next spawn to match its file and command inherits an
   * exemption a human granted to different code. */
  const orphaned = makeTree('b6-stale', "const { spawn } = require('node:child_process');\nspawn('claude', ['--print'], { env: { FIXED: '1' } });\n", {
    allowlist: { version: 1, entries: [{ file: 'src/gone.js', symbol: 'spawn', command: 'taskkill', reason: 'this call site was deleted and the entry outlived it, which is how an allowlist becomes a bypass', reviewedBy: 'test' }] }
  });
  const orphanResult = runGate(orphaned);
  check(orphanResult.status === 1, 'the gate kept an allowlist entry whose call site no longer exists; a standing exemption attached to nothing is inherited by whatever matches it next');
  check(/stale/i.test(orphanResult.stderr), 'the gate rejected the orphaned allowlist entry without naming staleness as the reason');
}

/* ---------- B7: the baseline is a ratchet, not a silencer ---------- */
{
  const twoSpawns = [
    "const { spawn } = require('node:child_process');",
    "spawn('claude', ['a'], { windowsHide: true });",
    "spawn('claude', ['b'], { windowsHide: true });"
  ].join('\n') + '\n';

  // One recorded, two present: the SECOND one is new and must fail.
  const key = "src/subject.js|spawn|INHERITS_AMBIENT|'claude'";
  const tree = makeTree('b7', twoSpawns, { baseline: { [key]: 1 } });
  const result = runGate(tree);
  check(result.status === 1, 'the gate let a NEW unscrubbed spawn hide inside the recorded pre-existing debt, which is the one thing the baseline must never allow');
  check((result.parsed.failures || []).length === 1, 'the gate blamed the wrong number of call sites when debt was already recorded for that file');

  // Both recorded: no new debt, so green.
  const covered = makeTree('b7-covered', twoSpawns, { baseline: { [key]: 2 } });
  check(runGate(covered).status === 0, 'the gate failed on pre-existing debt that the baseline already records');

  // Debt paid down but still recorded: the slack is where the next leak hides.
  const paid = makeTree('b7-stale', "const { spawn } = require('node:child_process');\nspawn('claude', ['a'], { windowsHide: true });\n", { baseline: { [key]: 2 } });
  const stale = runGate(paid);
  check(stale.status === 1, 'the gate accepted a baseline claiming more debt than exists, leaving unearned slack for the next unscrubbed spawn to hide in');
  check(/stale/i.test(stale.stderr), 'the gate failed on a stale baseline without telling the reader the baseline was the problem');
}

/* ---------- B9: the ways a spawn hides from a naive reader ----------
 *
 * Each of these was a real bypass or nearly one. The inline-require case was
 * found by planting a new unscrubbed spawn and watching the gate stay GREEN,
 * which is the only way that class of hole ever shows itself. */
{
  const hiders = [
    {
      name: 'an inline require at the call site, binding nothing',
      verdict: 'INHERITS_AMBIENT',
      source: "const childProcess = require('node:child_process');\nfunction go() { return require('node:child_process').spawn('claude', ['--print'], { cwd: __dirname }); }\n"
    },
    {
      name: 'the injectable `deps.spawnImpl || spawn` idiom used by nine call sites here',
      verdict: 'INHERITS_AMBIENT',
      source: "const { spawn } = require('node:child_process');\nfunction go(deps = {}) { const spawnImpl = deps.spawnImpl || spawn; return spawnImpl('claude', ['--print'], { cwd: __dirname }); }\n"
    },
    {
      name: 'a destructuring alias',
      verdict: 'INHERITS_AMBIENT',
      source: "const { spawn: launch } = require('node:child_process');\nlaunch('claude', ['--print'], { cwd: __dirname });\n"
    },
    {
      name: 'a namespace import',
      verdict: 'INHERITS_AMBIENT',
      source: "const cp = require('node:child_process');\ncp.spawn('claude', ['--print'], { cwd: __dirname });\n"
    },
    {
      name: 'the `env` property SHORTHAND, which the native agent launcher uses',
      verdict: 'SPREADS_AMBIENT',
      source: "const { spawn } = require('node:child_process');\nconst env = { ...process.env };\nspawn('claude', ['--print'], { cwd: __dirname, env, shell: false });\n"
    }
  ];
  for (const hider of hiders) {
    const tree = makeTree(`b9-${hider.name.slice(0, 12).replace(/\W/g, '')}`, hider.source);
    const result = runGate(tree);
    check(result.status === 1, `the gate stayed GREEN on an unscrubbed spawn hidden as: ${hider.name}`);
    check(verdictsIn(result).includes(hider.verdict),
      `the gate failed without a ${hider.verdict} finding for the spawn hidden as: ${hider.name}`);
  }
}

/* ---------- B10: a literal in a comment or string is not a spawn ---------- */
{
  const tree = makeTree('b10', [
    "const { safeLaunchEnvironment } = require('./env.js');",
    "// spawn('claude', ['--print'], { env: process.env });   <- a comment",
    "const doc = \"spawn('claude', [], { env: process.env })\";",
    "const re = /spawn\\(['\\\"]/g;",
    'module.exports = { doc, re, safeLaunchEnvironment };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 0, `the gate flagged a spawn that exists only inside a comment, a string, or a regex: ${result.stderr}`);
}

/* =====================================================================
 * B11-B16: THE THREE SHAPES THE GATE COULD NOT SEE (round 2, 2026-08-11).
 *
 * Every one of these is correct AT THE SPAWN SITE and wrong somewhere else,
 * which is why the original gate reported a confident all-clear over fifteen
 * real defects. Each case below is a real defect from that review, reduced.
 * ===================================================================== */

/* ---------- B11: an exact-case delete of a credential, anywhere ---------- */
{
  // No spawn in this file at all -- which is the point. Five of the six real
  // instances lived in files that BUILD an environment and hand it to someone
  // else to spawn, so a reader gated on "does this file call child_process"
  // could not see any of them.
  const tree = makeTree('b11', [
    'function harnessEnvironment(baseEnv) {',
    '  const env = { ...baseEnv };',
    '  delete env.OPENAI_API_KEY;',
    '  return env;',
    '}',
    'module.exports = { harnessEnvironment };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate stayed GREEN on `delete env.OPENAI_API_KEY` in a file that never spawns; five of six real instances had exactly that shape');
  check(verdictsIn(result).includes('HAND_ROLLED_CREDENTIAL_DELETE'),
    'the gate did not classify an exact-case credential delete as HAND_ROLLED_CREDENTIAL_DELETE');
}

/* ---------- B12: the list form, which is the shape all six used ---------- */
{
  const tree = makeTree('b12', [
    'function laneEnvironment(base) {',
    '  const env = { ...base };',
    "  for (const name of ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[name];",
    '  return env;',
    '}',
    'module.exports = { laneEnvironment };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate stayed GREEN on a `for (... of [...]) delete env[name]` credential list; a delete list is exact-case however long it is');
  check(verdictsIn(result).includes('HAND_ROLLED_CREDENTIAL_DELETE'),
    'the gate did not flag the list form of a hand-rolled credential delete');
}

/* ---------- B12b: the list held in a NAMED CONSTANT ---------- */
{
  /* Found by mutation, not by review: the first version of the rule read only
   * quoted names out of the for-header, so reverting fleet-supervisor/evidence.js
   * to its defective form left the gate GREEN. A named constant is not a safer
   * list, it is the same list one hop away. */
  const tree = makeTree('b12b', [
    "const STRIPPED_ENV = Object.freeze(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']);",
    'function harnessEnvironment(baseEnv) {',
    '  const env = { ...baseEnv };',
    '  for (const name of STRIPPED_ENV) delete env[name];',
    '  return env;',
    '}',
    'module.exports = { harnessEnvironment };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate stayed GREEN on a delete list held in a named constant; that is the exact shape of fleet-supervisor/evidence.js');
  check(verdictsIn(result).includes('HAND_ROLLED_CREDENTIAL_DELETE'),
    'the gate did not resolve `for (const name of STRIPPED_ENV) delete env[name]` to the credential names the constant holds');
}

/* ---------- B13: post-scrub restoration from ambient state ---------- */
{
  // The real defect: the scrub ran, and then the caller's own default parameter
  // read the key back out of process.env and re-set it.
  const tree = makeTree('b13', [
    "const { safeLaunchEnvironment } = require('./env.js');",
    'function start({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {',
    '  const env = safeLaunchEnvironment(process.env);',
    '  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;',
    '  return env;',
    '}',
    'module.exports = { start };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate stayed GREEN on a scrub that is undone by its own caller reading process.env.ANTHROPIC_API_KEY back');
  check(verdictsIn(result).includes('AMBIENT_CREDENTIAL_READ'),
    'the gate did not classify a `process.env.ANTHROPIC_API_KEY` read as AMBIENT_CREDENTIAL_READ');
}

/* ---------- B14: a detector that fails open ---------- */
{
  const tree = makeTree('b14', [
    'function presentEnvironmentNames(environment, names) {',
    "  if (!environment || typeof environment !== 'object') return [];",
    '  return names;',
    '}',
    'module.exports = { presentEnvironmentNames };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 1, 'the gate stayed GREEN on a detector that answers "nothing is present" for a null environment, which node reads as inherit-everything');
  check(verdictsIn(result).includes('FAIL_OPEN_ENV_DETECTOR'),
    'the gate did not classify a fail-open environment detector as FAIL_OPEN_ENV_DETECTOR');
}

/* ---------- B15: none of the three fires on a COMMENT ---------- */
{
  /* This is not a nicety. The fix for each of these defects added a comment
   * quoting the broken line it replaced, so a raw-text scanner reports every
   * fixed file as still broken -- measured on this repo while writing the rule.
   * A gate that fires on its own changelog gets switched off. */
  const tree = makeTree('b15', [
    "const { deleteEnvNames } = require('./env-scrub.js');",
    '// `delete env.ANTHROPIC_API_KEY` until 2026-08-11: exact-case, so a',
    '// lowercase spelling survived. Callers must not read process.env.OPENAI_API_KEY.',
    '/* The old shape was: for (const n of [\'GEMINI_API_KEY\']) delete env[n]; */',
    'const doc = "delete env.CODEX_API_KEY";',
    'function build(base) { return deleteEnvNames({ ...base }, [\'ANTHROPIC_API_KEY\']); }',
    'module.exports = { build, doc };'
  ].join('\n') + '\n');
  const result = runGate(tree);
  check(result.status === 0,
    `the gate flagged credential handling that exists only in comments and strings: ${result.stderr}`);
}

/* ---------- B16: the gate's name list may not fall behind the tripwire ---------- */
{
  /* A gate that guards fewer names than the tripwire trusts is the same silent
   * gap one level up -- and CLAUDE_CODE_OAUTH_TOKEN was missing from the
   * tripwire for exactly as long as nobody compared the two lists. */
  const { CREDENTIAL_NAMES } = require(CHECKER);
  const { BILLING_TRIPWIRE } = require(path.join(ROOT, 'src', 'lib', 'providers', 'subscription-launch-env.js'));
  const guarded = new Set(CREDENTIAL_NAMES.map(n => n.toLowerCase()));
  const missing = BILLING_TRIPWIRE.filter(n => !guarded.has(n.toLowerCase()));
  check(missing.length === 0,
    `the gate does not guard ${missing.join(', ')}, which BILLING_TRIPWIRE refuses a launch over; the gate's list must be a superset`);
}

/* ---------- B8: the real repository, and the two sites fixed with it ---------- */
{
  const result = spawnSync(process.execPath, [CHECKER, '--json', '--all'], {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024
  });
  assert.ifError(result.error);
  const parsed = JSON.parse(result.stdout);
  const findings = parsed.findings || [];
  check(findings.length > 0, 'the checker found no spawn at all in this repository, so every assertion about it would pass vacuously');

  const laneSpawn = findings.find(f => f.file === 'src/lib/agent-lane.js' && f.symbol === 'spawn');
  check(laneSpawn && laneSpawn.verdict === 'SCRUBBED',
    'src/lib/agent-lane.js spawnChild() is no longer reported as SCRUBBED; the lane child is a Claude or Codex CLI and must not receive an ambient API key');

  /* agent-wake is the FIRST hop of agent-wake -> lane-run -> agent-lane, and it
   * spawns through `const spawnImpl = options.spawnImpl || spawn`. A checker
   * that only recognises a literal `spawn(` call cannot see it at all, which is
   * how it stayed unfixed while the second hop was being fixed. */
  const wakeSpawn = findings.find(f => f.file === 'src/lib/agent-wake.js' && f.symbol === 'spawn');
  check(wakeSpawn && wakeSpawn.verdict === 'SCRUBBED',
    'src/lib/agent-wake.js spawnLaneWrapper() is no longer reported as SCRUBBED; it starts lane-run.js, which goes on to launch provider CLIs');

  // The native launcher now delegates lifetime to the owned hidden-spawn
  // boundary. A raw spawn or numeric taskkill here would bypass that custody.
  // Its native lifetime suite separately verifies the real child's scrubbed
  // environment, including mixed-case credential names and a positive canary.
  const rawNativeLaunches = findings.filter(f => f.file === 'sidecars/native-agent/src/native-agent-launcher.js'
    && ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].includes(f.symbol));
  check(rawNativeLaunches.length === 0, 'the native launcher must not bypass owned containment with a raw subprocess API');
  for (const boundary of ['src/lib/proc/hidden-spawn.js', 'src/lib/windows-job-control.js']) {
    const launches = findings.filter(f => f.file === boundary && f.symbol === 'spawn');
    check(launches.length > 0 && launches.every(f => f.verdict === 'SCRUBBED'),
      `${boundary} must keep its actual subprocess environments scrubbed`);
  }

  check(result.status === 0, `the repository gate is red: ${result.stderr}`);
}

console.log(`spawn-env-scrub-gate: ${checks} checks passed on ${process.platform}`);

}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
