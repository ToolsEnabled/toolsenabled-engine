// EXECUTABLE CHANGE — testcanfail-tests-cloud-lane-batch-cli-test-js
// SUSPECT: the bounds-refusal assertion computed its expected rate from
// batchTarget.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT, the same production value
// used to produce the refusal. Mutation: changed that production constant from
// 72 to 73. Before this change the suite stayed GREEN: "cloud-lane batch CLI
// tests passed (118 checks: ...)." The assertion below now pins the independently
// measured contract at 72. Under the same mutation it went RED with:
// "AssertionError [ERR_ASSERTION]: real run: the bounds refusal must report the
// independently measured ceiling of 72 launches per minute per account".
// The production file was then restored byte-for-byte and the final run was
// GREEN: "cloud-lane batch CLI tests passed (119 checks: ...)."
// NOT-FOUND (1): no assertion loop iterates a runtime collection that can be
// empty; all three assertion loops use non-empty literals, while filesystem
// walking is helper behavior and its callers assert the resulting lengths.
// NOT-FOUND (2): no exit-status assertion relies on non-zero/truthiness alone;
// every non-zero subprocess check also verifies the subject's structured error
// code or kill-switch message, and the successful exits verify subject output.
// NOT-FOUND (3): no try/catch or optional chain swallows the failure under test;
// raises() asserts that a caught error exists and has the named code, runCli's
// parse fallback is exposed as null to subsequent assertions, and cleanup/
// directory-read catches do not catch the behavior under test.
// NOT-FOUND (4): no assertion measures a mock of the behavior under test; the
// injected runner and mirror are spies/fences around CLI wiring, and the drift
// and subprocess paths explicitly exercise real implementations.
// NOT-FOUND (5): no skip or silent platform guard exists; policy and git
// preconditions fail loudly. Preconditions met: autonomous policy and git.
// NOT-FOUND (6), beyond the fixed bounds assertion: expected values are fixture
// literals or independently observed state, not recomputed by subject code.

'use strict';

// THE `batch` SUBCOMMAND OF tools/cloud-lane.js.
//
// WHAT THIS FILE IS ACTUALLY DEFENDING. A batch is admitted once and then runs
// unattended at up to seventy-odd launches a minute, and a Codex Cloud task
// cannot be cancelled once the provider accepts it. So the only moment anyone
// gets to say no is admission, and the only way a coordinator can use that
// moment is `--dry-run`: ask whether the declaration would be admitted, get
// every finding back, and decide before committing to it. The three properties
// below are what make that answer worth having.
//
//   1. A dry run DISPATCHES NOTHING -- no journal, no runner, no provider.
//   2. A refusal NAMES ITSELF and carries every finding, and it exits 3, so a
//      caller gating on this command can tell "the lane said no" from "the lane
//      broke". A silent skip or a bare exit 1 is the defect this separation
//      exists to close.
//   3. The mirror gate is REALLY WIRED. batch-target skips that gate entirely
//      when handed no mirrorApi, so a CLI that forgot to pass one would admit
//      every batch and nothing would notice until 250 agents had diffed against
//      stale source. One check below runs main() with NO injection at all
//      precisely so the injection the other checks use cannot hide that.
//
// NOTHING HERE REACHES A PROVIDER. Every refusal used below is raised before
// batch-target's network gate (shape, brief, collision) or by a registry file
// that is not on disk, which fails in-process; the two checks that need an
// ADMITTED batch inject a fake mirror. No codex binary, no git remote, no
// network. All state goes to per-test temp roots and the repo's real
// state/cloud-custody is asserted untouched at the end.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../tools/cloud-lane');
const batchJournal = require('../src/lib/cloud-agent/batch-journal');
const batchTarget = require('../src/lib/cloud-agent/batch-target');
// For REGISTRY_SCHEMA only. The fixture registry the drift checks write is
// keyed on the constant the reader really uses, so a schema rename cannot
// leave this suite passing against a registry nothing else would accept.
const cloudMirror = require('../src/lib/cloud-agent/cloud-mirror');
const policy = require('../src/lib/policy');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'cloud-lane.js');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-lane-batch-cli-'));

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown at all)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

// The kill switch is neutralised for THIS PROCESS ONLY, and pointed at a path
// under the temp root rather than removed: a machine that has tripped its kill
// switch for unrelated reasons must still be able to run the suite, and a test
// must never delete a real one. The gate itself is proved further down by
// pointing this same variable at a file that DOES exist.
const ABSENT_KILLSWITCH = path.join(TEMP_ROOT, 'no-killswitch-here');
process.env.TOOLSENABLED_KILLSWITCH_PATH = ABSENT_KILLSWITCH;

function tempDir(name) {
  const dir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function listFilesUnder(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

const REAL_STATE_DIR = path.join(__dirname, '..', 'state', 'cloud-custody');
const realStateBefore = listFilesUnder(REAL_STATE_DIR);

/* A brief that PASSES tools/agent-contract.js, which the shape gate runs: it
   refuses a `because` naming no measurement and a `done` only the agent itself
   could check. Writing a real one out is the test paying the price a
   coordinator pays. */
function task(index, targetPath) {
  const file = targetPath || `src/file-${index}.js`;
  return {
    target: file,
    contract: [
      'CONTRACT/1',
      'role      IMPLEMENTER',
      `target    ${file}`,
      'do        give every empty catch in this file a named reason',
      `because   3 empty catch blocks measured in ${file}, each discarding the refusal it was meant to report`,
      'done      no catch in this file discards an error without reporting it or carrying a written reason',
      `report    REPORT-${index}.md`
    ].join('\n')
  };
}

function declaration(overrides = {}) {
  return {
    schemaVersion: batchTarget.BATCH_SCHEMA,
    batchId: 'cli-wave-1',
    project: 'cli-fixture',
    tasks: [task(0), task(1), task(2)],
    bounds: { launchesPerMinute: 60, accounts: 2 },
    ...overrides
  };
}

function declarationFile(name, value) {
  return writeJson(path.join(TEMP_ROOT, 'declarations', `${name}.json`), value);
}

const freshMirror = () => {
  const asked = [];
  return { asked, checkMirrorFreshness: async (request) => { asked.push(request); return { fresh: true }; } };
};

// A subprocess run of the real CLI. This is the only way to observe the thing
// that actually matters to a gating caller -- the PROCESS exit code -- because
// the 3-or-1 decision lives in the require.main block.
function runCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TOOLSENABLED_KILLSWITCH_PATH: ABSENT_KILLSWITCH, ...extraEnv }
  });
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  let json = null;
  try { json = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null; } catch { json = null; }
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), json };
}

(async () => {
  // -------------------------------------------------------------------
  // PRECONDITION. assertActive refuses every subcommand unless the repo policy
  // is autonomous. If it is not, the subprocess checks below cannot run, and a
  // check that could not run must never be reported as one that passed.
  // -------------------------------------------------------------------
  {
    const loaded = policy.loadPolicy();
    assert.equal(loaded && loaded.mode, 'autonomous',
      `PRECONDITION NOT MET, CHECKS NOT RUN: config/toolsenabled.policy.json declares mode ${JSON.stringify(loaded && loaded.mode)}, and tools/cloud-lane.js calls assertActive on every subcommand. Nothing below was exercised.`);
    checks += 1;
  }

  // -------------------------------------------------------------------
  // 1. Argument parsing, driven with values.
  // -------------------------------------------------------------------
  {
    const minimal = cli.parseCliArgs(['batch', '--declaration', 'target.json']);
    check(minimal.command === 'batch' && minimal.options.declaration === 'target.json',
      'parse: batch takes a declaration path and needs nothing else');
    check(!('dry-run' in minimal.options),
      'parse: --dry-run absent must stay ABSENT, not default to a value -- a dry run that was never asked for would dispatch nothing and report success');

    const full = cli.parseCliArgs(['batch', '--declaration', 'a.json', '--state-root', 'S', '--registry', 'R', '--dry-run']);
    assert.deepEqual(full.options, { declaration: 'a.json', 'state-root': 'S', registry: 'R', 'dry-run': true });
    checks += 1;

    const leading = cli.parseCliArgs(['batch', '--dry-run', '--declaration', 'a.json']);
    check(leading.options['dry-run'] === true && leading.options.declaration === 'a.json',
      'parse: a value-less flag before a value flag must not swallow the next token');

    for (const [bad, why] of [
      [['batch'], 'no --declaration'],
      [['batch', '--declaration'], '--declaration with no value'],
      [['batch', '--declaration', 'a.json', '--tasks', '4'], 'an unknown flag'],
      [['batch', '--declaration', 'a.json', '--declaration', 'b.json'], 'a duplicated value flag'],
      [['batch', '--declaration', 'a.json', '--dry-run', '--dry-run'], 'a duplicated boolean flag'],
      [['batch', '--declaration', 'a.json', '--dry-run', 'true'], 'a stray value after a boolean flag']
    ]) {
      assert.throws(() => cli.parseCliArgs(bad), (error) => {
        assert.equal(error.code, 'CLOUD_LANE_USAGE', `expected a usage refusal for ${why}: ${JSON.stringify(bad)}`);
        return true;
      }, `parse: ${why} must be refused, not guessed at`);
      checks += 1;
    }

    // The loop that reads flags had to learn value-less flags for --dry-run.
    // These four prove the subcommands that existed before it still parse
    // exactly as they did, including the failures.
    const outbound = cli.parseCliArgs(['outbound', '--commit', 'a'.repeat(40), '--branch', 'b/1', '--allowlist', 'src/*,tools/*', '--state-root', 'S']);
    assert.deepEqual(outbound.options, { commit: 'a'.repeat(40), branch: 'b/1', allowlist: 'src/*,tools/*', 'state-root': 'S' });
    checks += 1;
    const submit = cli.parseCliArgs(['submit', '--env', 'e', '--branch', 'b', '--query-file', 'q', '--expect-path', 'p', '--expect-sha256', 'f'.repeat(64)]);
    check(submit.options.env === 'e' && submit.options['expect-sha256'] === 'f'.repeat(64),
      'parse: submit still reads five value flags in order');
    for (const bad of [['verify', '--task', 't', '--task', 't'], ['status', '--task', 't', 'junk'], ['conquer']]) {
      assert.throws(() => cli.parseCliArgs(bad), (error) => {
        assert.equal(error.code, 'CLOUD_LANE_USAGE', `expected a usage refusal for ${JSON.stringify(bad)}`);
        return true;
      });
      checks += 1;
    }
  }

  // -------------------------------------------------------------------
  // 2. A DRY RUN ON AN ADMITTED BATCH: exit 0, and nothing happened.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'dry-admitted-state'); // deliberately not created
    const registry = path.join(TEMP_ROOT, 'some-registry.json');
    const file = declarationFile('admitted', declaration());
    const mirror = freshMirror();
    let runnerCalls = 0;

    const { exitCode, out } = await cli.main(
      ['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registry, '--dry-run'],
      { mirrorApi: mirror, runBatchImpl: async () => { runnerCalls += 1; return {}; } }
    );

    // The harm first: whatever the verdict says, a dry run that reached the
    // runner or wrote a journal has already done the thing it promised not to.
    check(runnerCalls === 0, 'DRY RUN DISPATCHED SOMETHING: the runner was called');
    check(listFilesUnder(stateRoot).length === 0,
      `dry run: NO journal may be written -- a journal is a record of dispatches, and a dry run makes none (found ${listFilesUnder(stateRoot).join(', ')})`);

    check(exitCode === 0, `dry run: an admitted declaration must exit 0 so a coordinator can gate on it (got ${exitCode})`);
    check(out.dryRun === true && out.admitted === true, 'dry run: the verdict must SAY it was a dry run and that the batch was admitted');
    assert.deepEqual(out.findings, []);
    checks += 1;
    check(out.batchId === 'cli-wave-1' && out.taskCount === 3, 'dry run: the verdict names the batch and how much work it admitted');
    check(typeof out.admissionSha256 === 'string' && out.admissionSha256.length === 64,
      'dry run: the verdict carries the seal, so the coordinator can tell the batch it later runs is the one it checked');

    check(mirror.asked.length === 1, 'dry run: admission must still consult the mirror, or the dry run answers a different question than the real run');
    check(mirror.asked[0].projectKey === 'cli-fixture' && mirror.asked[0].registryPath === path.resolve(registry),
      'dry run: --registry must reach the mirror check, or the gate is run against a registry nobody named');
  }

  // -------------------------------------------------------------------
  // 3. A DRY RUN ON A REFUSED BATCH: exit 3, every finding, still nothing done.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'dry-refused-state');
    const file = declarationFile('refused', declaration({
      tasks: [task(0), { ...task(1), target: 'src/file-0.js' }, { target: 'src/file-2.js', contract: 'do the thing' }]
    }));
    let runnerCalls = 0;

    const error = await raises('CLOUD_BATCH_REFUSED',
      () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot, '--dry-run'],
        { mirrorApi: freshMirror(), runBatchImpl: async () => { runnerCalls += 1; return {}; } }),
      'dry run: a declaration the gates refuse must refuse BY NAME');

    const findings = error.details && error.details.findings;
    check(Array.isArray(findings) && findings.length >= 2,
      `dry run: EVERY finding must come back, not the first -- a coordinator about to stop steering has to fix them all in one pass (got ${findings && findings.length})`);
    check(findings.some((f) => f.gate === 'collision') && findings.some((f) => f.gate === 'brief'),
      'dry run: both the collision and the unbriefed task must be reported, not whichever gate ran first');
    check(error.message.includes('src/file-0.js'),
      'dry run: the refusal text must name the file two tasks collided on, or it cannot be acted on without a second investigation');
    check(runnerCalls === 0 && listFilesUnder(stateRoot).length === 0,
      'dry run: a refused declaration must leave no journal and call no runner');
  }

  // -------------------------------------------------------------------
  // 4. THE MIRROR GATE IS REALLY WIRED. No injection at all here: batch-target
  //    SKIPS its mirror gate when handed no mirrorApi, so a CLI that passed
  //    none would admit every batch and every check above would still be green.
  //    Deleting the mirrorApi argument in tools/cloud-lane.js turns this red.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'mirror-wired-state');
    const file = declarationFile('mirror-wired', declaration({ batchId: 'cli-wave-mirror' }));
    const absentRegistry = path.join(TEMP_ROOT, 'registry-that-is-not-there.json');

    const error = await raises('CLOUD_BATCH_REFUSED',
      () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot, '--registry', absentRegistry, '--dry-run']),
      'mirror: with NO injected mirror the real check must still run -- an unconfirmable mirror is a refusal, not an admission');
    const findings = (error.details && error.details.findings) || [];
    check(findings.some((f) => f.gate === 'mirror'),
      'mirror: the refusal must be attributed to the mirror gate, not folded into a generic failure');
    check(findings.some((f) => String(f.refused).includes('could not be confirmed current')),
      'mirror: "I could not look" must read as its own answer and never as "the mirror is fine"');
    check(listFilesUnder(stateRoot).length === 0, 'mirror: a batch refused at the mirror gate writes no journal');
  }

  // -------------------------------------------------------------------
  // 4b. THE OTHER SOURCE MODE, DRIVEN AGAINST A REAL GIT REPOSITORY.
  //
  //     A declaration carrying `against.publishedCommit` is checked by
  //     batch-target's drift gate, which asks a `changedSince` function which
  //     files moved since that commit. This CLI supplies one; these checks are
  //     what make that a fact rather than a claim, and they inject NOTHING for
  //     it -- an injected drift answer would prove only the injection. A real
  //     repository is built below, commits are really made, and the same
  //     `batch --dry-run` a coordinator runs is what asks the question.
  //
  //     The four properties, each driven with values:
  //       - a target that MOVED is refused by name, and a target that did not
  //         is not swept in with it;
  //       - a declaration whose targets all held still is ADMITTED;
  //       - "could not look" (a commit this checkout does not have, a project
  //         the registry does not name) refuses in its own words and never
  //         reads as "nothing moved";
  //       - a fresh mirror cannot mask any of it, because exactly one source
  //         gate runs and in this mode it is not the mirror's.
  // -------------------------------------------------------------------
  {
    // The fixture repository. Real git, because the wiring under test is a git
    // invocation: a fake would agree with whatever this file believed.
    const repoDir = tempDir('drift-repo');
    const hooksDir = path.join(TEMP_ROOT, 'no-hooks-for-fixtures');

    // A machine with no git cannot run these checks, and a check that could not
    // run must never be counted as one that passed -- so this fails loudly
    // rather than skipping. It is also the honest verdict: with no git the
    // wiring these checks cover cannot work at all.
    const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(gitVersion.status, 0,
      `DRIFT CHECKS NOT RUN: git could not be executed (${gitVersion.error && gitVersion.error.code}), and tools/cloud-lane.js answers the drift gate with git. Nothing below this point was exercised.`);
    checks += 1;

    // Identity and hook path are pinned PER INVOCATION rather than written into
    // any config: the fixture must not depend on how this machine's global git
    // is set up, and a global hooksPath must not run somebody's real hooks
    // against a throwaway repository. Nothing here touches a real checkout.
    const gitArgs = (args) => [
      '-C', repoDir,
      '-c', 'user.name=cloud-lane fixture',
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${hooksDir}`,
      ...args
    ];
    const git = (args) => {
      // ARGUMENT ARRAY, never a shell string -- the same rule the CLI's own git
      // calls follow, and for the same reason: a quoted path in a shell string
      // comes back ENOENT on Windows.
      const outcome = spawnSync('git', gitArgs(args), { encoding: 'utf8', windowsHide: true });
      assert.equal(outcome.status, 0,
        `FIXTURE NOT BUILT, CHECKS NOT RUN: git ${args.join(' ')} exited ${outcome.status} in ${repoDir}: ${outcome.stderr || (outcome.error && outcome.error.message)}`);
      return String(outcome.stdout || '');
    };
    const writeSource = (relative, text) => {
      const full = path.join(repoDir, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };

    git(['init', '--quiet']);
    writeSource('src/moved.js', 'module.exports = () => 1;\n');
    writeSource('src/still.js', 'module.exports = () => 2;\n');
    git(['add', '--', 'src/moved.js', 'src/still.js']);
    git(['commit', '--quiet', '-m', 'the commit the cloud agents would see']);
    const publishedCommit = git(['rev-parse', 'HEAD']).trim();
    check(/^[0-9a-f]{40}$/.test(publishedCommit),
      `drift fixture: the published commit must be a full sha for parseBatchTarget to accept it (got ${JSON.stringify(publishedCommit)})`);

    writeSource('src/moved.js', 'module.exports = () => 1; // moved after publication\n');
    git(['commit', '--quiet', '-m', 'src/moved.js moves after publication', '--', 'src/moved.js']);

    // The registry is what binds a project key to a checkout, and it is the
    // only thing that tells the drift gate WHERE to look. Written here so the
    // check runs against a registry it names rather than the machine's.
    const registryFile = writeJson(path.join(TEMP_ROOT, 'drift-registry.json'), {
      schemaVersion: cloudMirror.REGISTRY_SCHEMA,
      projects: {
        'cli-fixture': {
          sourceRoot: repoDir,
          // This is registry metadata only: --dry-run never performs a network
          // operation.  Keep the fixture structurally identical to a project
          // that registration has already privacy-verified, so the drift test
          // reaches the local Git question it exists to exercise.
          mirrorRemote: 'https://github.com/fixture/cli-drift-repo.git',
          mirrorBranch: 'cloud-mirror/cli-fixture',
          // Never read in this mode -- the drift gate asks git about the
          // sourceRoot and nothing else -- but the registry requires it.
          boundaryManifest: 'config/cloud-mirror-boundary.json',
          cloudRepository: 'fixture/cli-drift-repo',
          githubRepository: 'fixture/cli-drift-repo',
          privacyVerifiedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    });

    const driftRun = (name, tasks, overrides = {}) => {
      const stateRoot = path.join(TEMP_ROOT, `drift-state-${name}`);
      const file = declarationFile(`drift-${name}`, declaration({
        batchId: `cli-wave-${name}`,
        tasks,
        against: { publishedCommit },
        ...overrides
      }));
      return {
        stateRoot,
        args: ['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registryFile, '--dry-run']
      };
    };

    // ---- a target that MOVED is refused, and only that target ----
    {
      const mirror = freshMirror();
      const { stateRoot, args } = driftRun('moved', [task(0, 'src/moved.js'), task(1, 'src/still.js')]);
      const error = await raises('CLOUD_BATCH_REFUSED', () => cli.main(args, { mirrorApi: mirror }),
        'drift: a task whose own target moved since the published commit must refuse the batch');
      const findings = (error.details && error.details.findings) || [];
      check(findings.length === 1 && findings[0].gate === 'drift',
        `drift: exactly the moved target may be refused, by the drift gate (got ${JSON.stringify(findings)})`);
      check(String(findings[0].refused).includes('src/moved.js'),
        `drift: the refusal must NAME the file that moved, or nobody can act on it without a second investigation (got ${JSON.stringify(findings)})`);
      check(!findings.some((f) => String(f.refused).includes('src/still.js')),
        'drift: a target that did not move must not be swept in with the one that did -- refusing the whole corpus wholesale is what the per-task gate exists to avoid');
      check(mirror.asked.length === 0,
        'drift: exactly one source gate may run, and in published-commit mode it is not the mirror -- a fresh mirror must not be able to answer for a commit it was never asked about');
      check(listFilesUnder(stateRoot).length === 0, 'drift: a batch refused at the drift gate writes no journal');
    }

    // ---- a declaration whose targets held still is ADMITTED ----
    // The pair to the check above: identical wiring, a target that did not
    // move. Without this, a drift gate that refused everything would look just
    // as green as one that works.
    {
      const mirror = freshMirror();
      const { stateRoot, args } = driftRun('still', [task(1, 'src/still.js')]);
      const { exitCode, out } = await cli.main(args, { mirrorApi: mirror, runBatchImpl: async () => { throw new Error('a dry run must not reach the runner'); } });
      check(exitCode === 0, `drift: a declaration whose targets did not move must be ADMITTED (got exit ${exitCode})`);
      check(out.admitted === true && out.taskCount === 1, 'drift: the admitted verdict must say what it admitted');
      assert.deepEqual(out.findings, []);
      checks += 1;
      check(mirror.asked.length === 0, 'drift: admission in published-commit mode must not consult the mirror either');
      check(listFilesUnder(stateRoot).length === 0, 'drift: a dry run writes no journal whether it admits or refuses');
    }

    // ---- an UNCOMMITTED edit to that same target refuses it ----
    // Proved as a pair with the admission above: the same command, the same
    // commit, and only the working tree moves. A cloud agent cannot see an
    // edit that was never committed, so a target carrying one is not what the
    // coordinator planned against either.
    {
      writeSource('src/still.js', 'module.exports = () => 2; // edited, never committed\n');
      const { stateRoot, args } = driftRun('still-dirty', [task(1, 'src/still.js')], { batchId: 'cli-wave-still-dirty' });
      const error = await raises('CLOUD_BATCH_REFUSED', () => cli.main(args, { mirrorApi: freshMirror() }),
        'drift: the SAME declaration that was admitted must be refused once its target carries an uncommitted edit');
      const findings = (error.details && error.details.findings) || [];
      check(findings.length === 1 && findings[0].gate === 'drift' && String(findings[0].refused).includes('src/still.js'),
        `drift: the working-tree difference must be reported as drift on the named file (got ${JSON.stringify(findings)})`);
      check(listFilesUnder(stateRoot).length === 0, 'drift: nothing is journalled for it either');
    }

    // ---- a target that is tracked at NO commit refuses ----
    // At the published commit there is no such file, so the agent opens
    // nothing. Counting it as "did not move" is the merge this project forbids.
    {
      writeSource('src/brand-new.js', 'module.exports = () => 3;\n');
      const { stateRoot, args } = driftRun('untracked', [task(2, 'src/brand-new.js')]);
      const error = await raises('CLOUD_BATCH_REFUSED', () => cli.main(args, { mirrorApi: freshMirror() }),
        'drift: a target that exists here and at no commit must not be admitted as unchanged');
      const findings = (error.details && error.details.findings) || [];
      check(findings.length === 1 && String(findings[0].refused).includes('src/brand-new.js'),
        `drift: the untracked target must be named (got ${JSON.stringify(findings)})`);
      check(listFilesUnder(stateRoot).length === 0, 'drift: nothing is journalled for it either');
    }

    // ---- A 40-HEX ID THAT IS NOT A COMMIT MUST NOT BE DIFFED ----
    // parseBatchTarget only checks the SHAPE of against.publishedCommit, and a
    // tree id is the same shape as a commit id. `git diff <tree> HEAD` is a
    // legal command: handed HEAD's own tree it succeeds and reports nothing
    // moved, so without a check that the id names a commit this declaration
    // would be ADMITTED WHOLE on an answer to a question nobody asked. Measured
    // here rather than reasoned about: the id below is produced by git.
    {
      const treeId = git(['rev-parse', 'HEAD^{tree}']).trim();
      check(/^[0-9a-f]{40}$/.test(treeId) && treeId !== publishedCommit,
        `drift fixture: HEAD's tree id must be a 40-hex id distinct from the published commit (got ${treeId})`);
      const stateRoot = path.join(TEMP_ROOT, 'drift-state-tree-id');
      const file = declarationFile('drift-tree-id', declaration({
        batchId: 'cli-wave-tree-id',
        tasks: [task(0, 'src/moved.js')],
        against: { publishedCommit: treeId }
      }));
      const error = await raises('CLOUD_BATCH_REFUSED',
        () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registryFile, '--dry-run'], { mirrorApi: freshMirror() }),
        'drift: an id that is not a commit must refuse -- no cloud agent can be sitting at a tree, so a diff against one answers nothing');
      const refused = String(((error.details && error.details.findings) || [{}])[0].refused || '');
      check(/could not be established/.test(refused) && refused.includes(treeId),
        `drift: the refusal must say the question went unanswered and name the id it could not resolve to a commit (got ${refused})`);
      check(listFilesUnder(stateRoot).length === 0, 'drift: nothing is journalled for it either');
    }

    // ---- "COULD NOT LOOK" IS ITS OWN ANSWER ----
    // Two ways the question cannot be answered at all. Both must refuse, both
    // must say why, and neither may borrow the sentence that means a file
    // moved -- a coordinator reading these has to know whether to fetch a
    // commit, register a project, or fix a brief.
    {
      const stateRoot = path.join(TEMP_ROOT, 'drift-state-unknown-commit');
      const file = declarationFile('drift-unknown-commit', declaration({
        batchId: 'cli-wave-unknown-commit',
        tasks: [task(1, 'src/still.js')],
        against: { publishedCommit: 'd'.repeat(40) }
      }));
      const error = await raises('CLOUD_BATCH_REFUSED',
        () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registryFile, '--dry-run'], { mirrorApi: freshMirror() }),
        'drift: a published commit this checkout does not have must refuse');
      const refused = String(((error.details && error.details.findings) || [{}])[0].refused || '');
      check(/could not be established/.test(refused),
        `drift: an unresolvable commit must read as unanswered, not as an answer (got ${refused})`);
      check(refused.includes('d'.repeat(40)) && refused.includes(repoDir),
        'drift: it must name the commit it could not resolve AND the checkout it looked in, or the reader cannot tell which of the two is wrong');
      check(!/has changed since the published commit/.test(refused),
        'drift: "could not look" must never borrow the sentence that means a file moved');
      check(listFilesUnder(stateRoot).length === 0, 'drift: nothing is journalled for a question nobody could answer');
    }
    {
      const stateRoot = path.join(TEMP_ROOT, 'drift-state-unregistered');
      const file = declarationFile('drift-unregistered', declaration({
        batchId: 'cli-wave-unregistered',
        project: 'not-in-the-registry',
        tasks: [task(1, 'src/still.js')],
        against: { publishedCommit }
      }));
      const error = await raises('CLOUD_BATCH_REFUSED',
        () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registryFile, '--dry-run'], { mirrorApi: freshMirror() }),
        'drift: a project no registry binds to a checkout must refuse rather than be measured against some default tree');
      const refused = String(((error.details && error.details.findings) || [{}])[0].refused || '');
      check(refused.includes('not-in-the-registry') && refused.includes(registryFile),
        `drift: the refusal must name the project and the registry that does not carry it (got ${refused})`);
      check(listFilesUnder(stateRoot).length === 0, 'drift: nothing is journalled for it either');
    }

    // ---- AND THE PROCESS SAYS SO. The exit code is the only thing a gating
    //      caller sees, and it lives in the require.main block, so this runs
    //      the real CLI as a child process with no injection whatsoever.
    {
      const stateRoot = path.join(TEMP_ROOT, 'drift-state-subprocess');
      const file = declarationFile('drift-subprocess', declaration({
        batchId: 'cli-wave-drift-subprocess',
        tasks: [task(0, 'src/moved.js'), task(1, 'src/still.js')],
        against: { publishedCommit }
      }));
      const run = runCli(['batch', '--declaration', file, '--state-root', stateRoot, '--registry', registryFile, '--dry-run']);
      check(run.status === 3 && run.json && run.json.error.code === 'CLOUD_BATCH_REFUSED',
        `drift: through the shipped path a drift refusal is the lane saying no (3), not the lane breaking (got ${run.status} ${run.json && run.json.error.code})`);
      check(String(run.json.error.message).includes('src/moved.js'),
        'drift: the printed refusal must name the moved target');
      check(listFilesUnder(stateRoot).length === 0, 'drift: the subprocess run journalled nothing');
    }
  }

  // -------------------------------------------------------------------
  // 5. THE REAL RUN: admit, open the journal, THEN hand off.
  //    The ordering is the whole recovery story -- the runner writes its first
  //    intent into a file that already carries the admission it runs under.
  // -------------------------------------------------------------------
  {
    const stateRoot = tempDir('real-run-state');
    const file = declarationFile('real-run', declaration({ batchId: 'cli-wave-2' }));
    const handoff = [];

    const { exitCode, out } = await cli.main(
      ['batch', '--declaration', file, '--state-root', stateRoot],
      {
        mirrorApi: freshMirror(),
        runBatchImpl: async (request) => {
          // Read the journal AT THE MOMENT OF HANDOFF: if it were opened after
          // the runner returned, a crash during dispatch would leave nothing.
          handoff.push({ request, journalAtHandoff: batchJournal.readJournal(request.journalFile) });
          return { launched: 0, refused: 0, unresolved: 0 };
        }
      }
    );

    check(exitCode === 0, `real run: a batch that ran must exit 0 (got ${exitCode})`);
    check(handoff.length === 1, 'real run: the CLI must hand off exactly once');
    const { request, journalAtHandoff } = handoff[0];
    check(journalAtHandoff.header && journalAtHandoff.header.kind === 'admitted',
      'real run: THE JOURNAL MUST ALREADY BE OPEN when the runner is called, or a dispatch could happen with nothing recording it');
    check(journalAtHandoff.header.admissionSha256 === request.admission.admissionSha256,
      'real run: the journal header must carry the seal of the admission being run, so a recovered journal says WHAT ran');
    check(journalAtHandoff.launched.length === 0 && journalAtHandoff.unresolved.length === 0,
      'real run: the CLI itself must record no dispatch -- dispatching is the runner\'s job');
    check(request.declaration && request.admission && request.stateRoot === path.resolve(stateRoot),
      'real run: the runner is handed the admission AND the declaration, which is what assertSealIntact needs before every dispatch');
    check(out.journalFile === request.journalFile && fs.existsSync(out.journalFile),
      'real run: the output must name the journal, because that path is the only way to recover a batch that died');
    check(out.dryRun === false && out.launched === 0,
      'real run: the runner\'s own result must reach the caller rather than being replaced by a bare ok');
  }

  // -------------------------------------------------------------------
  // 6. A refused declaration on a REAL run leaves no journal either. Admission
  //    precedes the journal, so a refusal costs nothing to clean up.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'real-refused-state');
    const file = declarationFile('real-refused', declaration({
      batchId: 'cli-wave-3',
      bounds: { launchesPerMinute: 5000, accounts: 1 }
    }));
    let runnerCalls = 0;
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot],
        { mirrorApi: freshMirror(), runBatchImpl: async () => { runnerCalls += 1; return {}; } }),
      'real run: bounds above the measured ceiling must refuse rather than be quietly clamped');
    check(String(error.message).includes(String(batchTarget.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT)),
      'real run: the bounds refusal must state the ceiling it measured against');
    check(error.message.includes('measured ceiling of 72 (72 per account)'),
      'real run: the bounds refusal must report the independently measured ceiling of 72 launches per minute per account');
    check(runnerCalls === 0 && listFilesUnder(stateRoot).length === 0,
      'real run: a refusal at admission must reach neither the journal nor the runner');
  }

  // -------------------------------------------------------------------
  // 7. THE UNINJECTED REAL RUN, against the runner that actually exists.
  //
  //    src/lib/cloud-agent/batch-runner.js takes `dispatch` and `accounts` as
  //    well, and tools/cloud-lane.js cannot honestly supply dispatch: the
  //    provider coordinates it would need are not in the sealed declaration, and
  //    passing them beside it would put the batch's destination outside the
  //    seal. So the real run refuses BY NAME rather than dispatching, and this
  //    check holds that line: whatever wiring lands later, a `batch` run must
  //    never reach a provider through arguments nobody admitted.
  //
  //    WHEN DISPATCH IS WIRED THIS CHECK GOES RED, AND THAT IS ITS JOB. Replace
  //    it then with one that proves the wiring -- do not delete it.
  // -------------------------------------------------------------------
  {
    const stateRoot = tempDir('unwired-runner-state');
    const file = declarationFile('unwired', declaration({ batchId: 'cli-wave-4' }));
    const error = await raises('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      () => cli.main(['batch', '--declaration', file, '--state-root', stateRoot], { mirrorApi: freshMirror() }),
      'runner: a real run with no dispatch wired must refuse by name, never dispatch on a guess and never exit quietly having done nothing');
    check(/dispatch/.test(String(error.message)),
      'runner: the refusal must name the argument that is missing, or the reader has to source-read two modules to find out');
    check(!cli.REFUSAL_CODES.has('CLOUD_BATCH_RUNNER_MISCONFIGURED'),
      'runner: an incompletely wired lane is "the lane broke" (exit 1), not "the lane said no" (exit 3)');

    // The journal the CLI opened before the handoff survives the refusal, and it
    // records NO dispatch. That is the recoverable state: a later run reads it,
    // finds nothing attempted, and owes the whole batch.
    const opened = batchJournal.readJournal(batchJournal.journalPath(stateRoot, 'cli-wave-4'));
    check(opened.header && opened.header.kind === 'admitted',
      'runner: the journal opened before the handoff must carry its admitted header');
    check(opened.launched.length === 0 && opened.refused.length === 0 && opened.unresolved.length === 0,
      'runner: a refused handoff must leave a journal recording no dispatch at all -- not one intent, since an intent means the provider may already have the task');
    check(opened.notAttempted(3).length === 3,
      'runner: every task must still read as never attempted, so a later run owes the whole batch rather than skipping work it never did');
  }

  // -------------------------------------------------------------------
  // 8. THE PROCESS EXIT CODES. This is the only observation that matters to a
  //    gating caller, and it lives in the require.main block, so these run the
  //    real CLI as a child process. Every case below refuses before the network.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'subprocess-state');

    const malformed = path.join(TEMP_ROOT, 'declarations', 'not-json.json');
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, '{ "batchId": "x", ', 'utf8');
    const notJson = runCli(['batch', '--declaration', malformed, '--state-root', stateRoot, '--dry-run']);
    check(notJson.status === 3 && notJson.json && notJson.json.error.code === 'CLOUD_BATCH_MALFORMED',
      `exit: a declaration that does not parse is the lane saying no (3), not the lane breaking (1) -- got ${notJson.status} ${notJson.json && notJson.json.error.code}`);

    const noTasks = declarationFile('no-tasks', declaration({ tasks: [] }));
    const empty = runCli(['batch', '--declaration', noTasks, '--state-root', stateRoot, '--dry-run']);
    check(empty.status === 3 && empty.json.error.code === 'CLOUD_BATCH_MALFORMED',
      `exit: a batch declaring no work must refuse by name (got ${empty.status} ${empty.json && empty.json.error.code})`);

    const collided = declarationFile('collided', declaration({
      batchId: 'cli-wave-5',
      tasks: [task(0), { ...task(1), target: 'src/file-0.js' }]
    }));
    const refused = runCli(['batch', '--declaration', collided, '--state-root', stateRoot, '--dry-run']);
    check(refused.status === 3 && refused.json.error.code === 'CLOUD_BATCH_REFUSED',
      `exit: a gate refusal exits 3 (got ${refused.status} ${refused.json && refused.json.error.code})`);
    check(refused.json.error.details && refused.json.error.details.findings.length >= 1,
      'exit: the printed refusal must carry the findings as STRUCTURE, so a caller does not have to parse the sentence to act on them');
    check(refused.json.error.message.includes('src/file-0.js'),
      'exit: the printed refusal must name the colliding file');

    const unknown = runCli(['batch', '--declaration', collided, '--state-root', stateRoot, '--wave', '2']);
    check(unknown.status === 1 && unknown.json.error.code === 'CLOUD_LANE_USAGE',
      `exit: a mistyped invocation is not a refusal of the batch and must not exit 3 (got ${unknown.status} ${unknown.json && unknown.json.error.code})`);

    const missing = runCli(['batch', '--declaration', path.join(TEMP_ROOT, 'declarations', 'nope.json'), '--state-root', stateRoot, '--dry-run']);
    check(missing.status === 1 && missing.json.error.code === 'CLOUD_LANE_USAGE',
      `exit: a declaration path that is not there is an invocation problem (got ${missing.status})`);
    check(/no batch declaration file at/.test(missing.json.error.message),
      'exit: "there is no file there" must be its own sentence, distinct from "that file does not parse"');

    check(listFilesUnder(stateRoot).length === 0,
      'exit: not one of the refused subprocess runs may have written a journal');
  }

  // -------------------------------------------------------------------
  // 9. THE KILL SWITCH STILL STOPS THIS SUBCOMMAND -- proved as a pair, since a
  //    gate that only ever says no is indistinguishable from a broken one. The
  //    identical invocation is run twice; only the kill switch moves.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP_ROOT, 'killswitch-state');
    const file = declarationFile('killswitch', declaration({ batchId: 'cli-wave-6' }));
    const args = ['batch', '--declaration', file, '--state-root', stateRoot, '--registry', path.join(TEMP_ROOT, 'registry-that-is-not-there.json'), '--dry-run'];

    const tripped = path.join(TEMP_ROOT, 'KILLSWITCH-FIXTURE');
    fs.writeFileSync(tripped, 'tripped by tests/cloud-lane-batch-cli.test.js\n', 'utf8');
    const stopped = runCli(args, { TOOLSENABLED_KILLSWITCH_PATH: tripped });
    check(stopped.status === 1 && /KILLSWITCH/.test(stopped.json.error.message),
      `killswitch: an active kill switch must stop batch admission and say so (got ${stopped.status}: ${stopped.json && stopped.json.error.message})`);
    check(/cloud_lane\.batch/.test(stopped.json.error.message),
      'killswitch: the refusal must name the action it stopped, or the operator cannot tell which lane was blocked');

    const allowed = runCli(args);
    check(allowed.status === 3 && allowed.json.error.code === 'CLOUD_BATCH_REFUSED',
      `killswitch: with the kill switch absent the SAME command must get past the gate and be refused by the mirror instead (got ${allowed.status} ${allowed.json && allowed.json.error.code})`);
    check(listFilesUnder(stateRoot).length === 0, 'killswitch: neither run may have dispatched or journalled anything');
  }

  // -------------------------------------------------------------------
  // 10. The refusal codes a caller branches on. Seven codes, and every one of
  //     them means the lane said no.
  // -------------------------------------------------------------------
  {
    for (const code of [
      'CLOUD_BATCH_REFUSED', 'CLOUD_BATCH_MALFORMED', 'CLOUD_BATCH_SEAL_BROKEN',
      'CLOUD_BATCH_UNRECONCILED', 'CLOUD_BATCH_JOURNAL_ABSENT',
      'CLOUD_BATCH_JOURNAL_CORRUPT', 'CLOUD_BATCH_JOURNAL_UNWRITABLE'
    ]) {
      check(cli.REFUSAL_CODES.has(code),
        `refusal codes: ${code} is raised by the batch library and must exit 3, or a caller cannot tell it from a crash`);
    }
    check(!cli.REFUSAL_CODES.has('CLOUD_LANE_USAGE'),
      'refusal codes: a usage mistake is not the lane refusing the batch');
    check(!cli.REFUSAL_CODES.has('CLOUD_LANE_UNEXPECTED'),
      'refusal codes: an unexpected failure must never be reported as a considered refusal');
  }

  // -------------------------------------------------------------------
  // 11. The real state directory was never touched.
  // -------------------------------------------------------------------
  assert.deepEqual(listFilesUnder(REAL_STATE_DIR), realStateBefore,
    'the suite must write only under its temp roots; the repo state/cloud-custody is untouched');
  checks += 1;

  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best effort on Windows handles */ }

  console.log(`cloud-lane batch CLI tests passed (${checks} checks: batch argument parsing incl. value-less --dry-run and the pre-existing subcommands still parsing unchanged, a dry run exiting 0 having written no journal and called no runner, a refused dry run returning EVERY finding, the mirror gate proved wired with no injection at all, the drift gate driven against a REAL git repository -- a committed move, an uncommitted edit and an untracked target each refused by name while a target that held still was admitted, a tree id refused rather than diffed, an unresolvable commit and an unregistered project answered as "could not look" rather than "did not move", and the mirror proved not to be consulted in that mode -- the journal proved open BEFORE the handoff, a refusal reaching neither journal nor runner, an unwired real run refusing by name with a journal recording no dispatch, process exit 3 for named refusals and 1 for usage, an absent declaration file kept distinct from an unparseable one, the kill switch proved as a pair, and the repo state directory untouched).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
