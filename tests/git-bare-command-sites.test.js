'use strict';

/* EVERY GIT STARTED IN A PROJECT OR LANE WORKTREE IS STARTED BY ABSOLUTE PATH
 * (platform review 1.0.50 E3).
 *
 * On Windows a bare `git` handed to spawn is looked up in the child's working
 * directory first, so `spawnSync('git', args, { cwd: project })` runs a
 * git.exe committed at the top of that project, with the person's token,
 * before any approval. Security M4 closed the onboarding and workspace probes
 * (src/lib/git-command.js spawnGitSync). The fleet worktree, review and lane
 * runner, the Luna executor, the Gemini agentic runner, the roster scoreboard
 * and the cloud lane kept a bare `git` with a project or worktree as the
 * working directory.
 *
 * WHAT THIS PROVES, ON ANY PLATFORM. The same planting has a POSIX form: a
 * relative PATH entry (`.`) is resolved against the child's working directory,
 * so a bare `git` with `cwd: project` and PATH=".:..." runs `<project>/git`.
 * The fixed resolver skips relative entries exactly as it skips the Windows
 * current-directory search, so a planted `git` that records being run is the
 * observation, for each reachable site, with the real git still doing the
 * work. Windows cannot be reproduced here; there the planted program would be
 * `git.exe`/`git.com`, which a Linux runner cannot build, so that part reports
 * SKIP on Windows and the wrapper checks still run.
 *
 * The Luna executor's git runners are not exported, so a source fence covers
 * them, together with a repository-wide fence: no bare `git` reaches a
 * child_process call in src/ except the cloud-mirror calls listed below, none
 * of which runs with a project as its working directory. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const gitCommand = require('../src/lib/git-command');

let checks = 0;
function pass(name) { checks += 1; console.log(`PASS git-bare-command-sites: ${name}`); }

/* ---- the drop-in wrappers, with injected spawn functions ---- */
function wrappersStartGitByAbsolutePath() {
  const fixtureGit = path.join(os.tmpdir(), 'git-bare-fixture-bin', 'git');
  const resolveGit = () => fixtureGit;
  const seen = [];
  const record = shape => (command, args, options) => { seen.push({ shape, command, args, options }); return shape; };

  assert.equal(gitCommand.execGitFileSync('git', ['status'], { cwd: '/p', shell: true },
    { exec: record('exec'), resolveGit }), 'exec');
  assert.equal(gitCommand.spawnGitProcessSync('git', ['status'], { cwd: '/p' },
    { spawn: record('spawnSync'), resolveGit }), 'spawnSync');
  assert.equal(gitCommand.spawnGitProcess('git', ['status'], { cwd: '/p' },
    { spawn: record('spawn'), resolveGit }), 'spawn');
  for (const call of seen) {
    assert.equal(call.command, fixtureGit, `${call.shape}: git must be started by its absolute path`);
    assert.deepEqual(call.args, ['status'], `${call.shape}: arguments are unchanged`);
    assert.equal(call.options.cwd, '/p', `${call.shape}: the working directory is unchanged`);
    assert.equal(call.options.shell, false, `${call.shape}: never through a shell`);
    assert.equal(call.options.windowsHide, true, `${call.shape}: never a console window`);
  }
  pass('the three wrappers start git by absolute path and keep cwd and args');

  seen.length = 0;
  gitCommand.execGitFileSync('node', ['-v'], {}, { exec: record('exec'), resolveGit: () => assert.fail('not asked') });
  gitCommand.spawnGitProcess('/usr/bin/git', ['-v'], {}, { spawn: record('spawn'), resolveGit: () => assert.fail('not asked') });
  assert.deepEqual(seen.map(call => call.command), ['node', '/usr/bin/git']);
  pass('a command other than bare git passes through untouched');

  const searched = [];
  gitCommand.execGitFileSync('git', [], { env: { PATH: '/only/here' } },
    { exec: record('exec'), resolveGit: ({ env }) => { searched.push(env.PATH); return fixtureGit; } });
  assert.deepEqual(searched, ['/only/here'], 'the PATH searched is the child environment the caller gave');
  pass('the child environment\'s PATH is the one searched');

  const missing = () => null;
  assert.throws(() => gitCommand.execGitFileSync('git', ['status'], {}, { exec: record('exec'), resolveGit: missing }),
    error => error.code === 'ENOENT');
  assert.throws(() => gitCommand.spawnGitProcess('git', ['status'], {}, { spawn: record('spawn'), resolveGit: missing }),
    error => error.code === 'ENOENT');
  const notStarted = gitCommand.spawnGitProcessSync('git', ['status'], {}, { spawn: record('spawnSync'), resolveGit: missing });
  assert.equal(notStarted.error.code, 'ENOENT');
  assert.equal(notStarted.status, null);
  pass('git that does not resolve fails as a missing program, never as a bare git');
}

/* ---- the reachable call sites, against a planted git ---- */
async function plantedGitIsNeverRun() {
  if (process.platform === 'win32') {
    console.log('SKIP git-bare-command-sites: planted git (POSIX relative-PATH form; Windows needs a git.exe fixture)');
    return;
  }
  const realGit = gitCommand.resolveGitExecutable();
  if (!realGit) {
    console.log('SKIP git-bare-command-sites: planted git (no git on PATH on this runner)');
    return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bare-sites-'));
  const repo = path.join(scratch, 'project');
  fs.mkdirSync(repo);
  const realRun = args => childProcess.execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  realRun(['init', '-q']);
  realRun(['config', 'user.email', 'fixture@example.invalid']);
  realRun(['config', 'user.name', 'Fixture']);
  realRun(['config', 'commit.gpgSign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  realRun(['add', 'README.md']);
  realRun(['commit', '-q', '-m', 'fixture']);
  const marker = path.join(scratch, 'PLANTED-GIT-RAN');
  // Committed-in-the-project git: records that it ran and fails.
  fs.writeFileSync(path.join(repo, 'git'), `#!/bin/sh\necho "$*" >> '${marker}'\nexit 3\n`, { mode: 0o755 });
  const eventsPath = path.join(scratch, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');

  const originalPath = process.env.PATH;
  process.env.PATH = `.${path.delimiter}${originalPath}`;
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null);
  const sites = [];
  const site = async (name, call) => {
    if (fs.existsSync(marker)) fs.rmSync(marker);
    let outcome;
    try { outcome = { value: await call() }; } catch (error) { outcome = { error }; }
    assert.equal(ran(), null, `${name}: the git committed in the project ran (args: ${ran()})`);
    sites.push(name);
    return outcome;
  };
  try {
    // The precondition: this runner really does start the planted file for a bare git.
    const bare = childProcess.spawnSync('git', ['status'], { cwd: repo, encoding: 'utf8' });
    assert.equal(bare.status, 3, 'PRECONDITION: a bare git with cwd set to the project must reach the planted file here');
    assert.notEqual(ran(), null, 'PRECONDITION: the planted git records its run');
    fs.rmSync(marker);

    const worktree = require('../src/lib/fleet-supervisor/worktree');
    const review = require('../src/lib/fleet-supervisor/review');
    const laneRunner = require('../src/lib/fleet-supervisor/lane-runner');
    const scoreboard = require('../src/lib/fleet-supervisor/roster/scoreboard');
    const cloudLane = require('../src/lib/cloud-agent/cloud-lane');
    const geminiAgentic = require('../src/lib/providers/gemini-agentic');

    const tracked = await site('fleet worktree changedTrackedPaths', () => worktree.changedTrackedPaths(repo));
    assert.ok(Array.isArray(tracked.value), 'the real git answered for the worktree');
    const baseline = await site('fleet worktree captureBaselineTree', () => worktree.captureBaselineTree(repo));
    assert.match(String(baseline.value), /^[0-9a-f]{40}$/, 'the real git produced the baseline tree');
    await site('fleet review laneChangedPaths', () => review.laneChangedPaths(repo, baseline.value));
    const count = await site('fleet lane-runner changedFileCount', () => laneRunner.changedFileCount(repo));
    assert.equal(typeof count.value, 'number', 'the real git measured the lane');
    const rebuilt = await site('roster scoreboard rebuild', () => scoreboard.rebuild({ repoRoot: repo, eventsPath, write: false }));
    if (rebuilt.error) throw rebuilt.error;
    const head = await site('cloud lane defaultExecImpl', () => cloudLane.defaultExecImpl('git', ['rev-parse', 'HEAD'], { cwd: repo }));
    assert.equal(head.value && head.value.exitCode, 0, 'the real git answered for the cloud lane');
    const status = await site('gemini agentic gitRun', () => geminiAgentic._testing.dependencies().gitRun(['rev-parse', 'HEAD'], repo));
    assert.equal(status.value && status.value.status, 0, 'the real git answered for the Gemini agentic runner');
    assert.equal(sites.length, 7);
    pass(`a git committed in the project is never run (${sites.length} sites: ${sites.join(', ')})`);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ---- source fences ---- */
function lunaRunnersUseTheWrappers() {
  const code = fs.readFileSync(path.join(ROOT, 'src/lib/fleet-supervisor/luna-executor.js'), 'utf8');
  assert.match(code, /function defaultGitRun\(args, cwd\) \{\s*const result = spawnGitProcessSync\('git', args,/,
    'luna-executor defaultGitRun must start git through spawnGitProcessSync');
  assert.match(code, /function defaultGitExec\(command, args, options\) \{\s*return execGitFileSync\(command, args,/,
    'luna-executor defaultGitExec must start git through execGitFileSync');
  pass('the Luna executor\'s git runners use the absolute-path wrappers');
}

/* Not a project working directory, each one (kept as they are):
 *  - cloud-mirror's status/diff runner passes `-C <repo>` with no cwd, so the
 *    child starts in this process's own directory, not the project;
 *  - its credential-helper probe and bare-repository init have no cwd either;
 *  - its network runner's cwd is the owned temporary bare repository it just
 *    created under ToolsEnabled's own temporary root.
 * Their tests intercept child_process by the bare name, so moving them is a
 * separate change. */
const ALLOWED_BARE_GIT = Object.freeze({
  'src/lib/cloud-agent/cloud-mirror.js': 4
});

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

function noOtherBareGitInSource() {
  // A bare git handed straight to a child_process-shaped call.
  const direct = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|spawnInJob)\(\s*['"]git['"]/g;
  // A bare git handed to an injectable runner whose default is child_process itself.
  const injected = /\b(?:exec|execImpl)\(\s*['"]git['"]/;
  const childDefault = /\b(?:exec|execImpl)\s*=\s*(?:execFileSync|spawnSync|spawn|childProcess\.\w+)\b/;
  const found = {};
  const injectedDefaults = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (relative === 'src/lib/git-command.js') continue;
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hits = code.match(direct);
    if (hits) found[relative] = hits.length;
    if (injected.test(code) && childDefault.test(code)) injectedDefaults.push(relative);
  }
  assert.deepEqual(found, ALLOWED_BARE_GIT,
    'a bare git reached a child_process call outside the listed cloud-mirror calls');
  assert.deepEqual(injectedDefaults, [],
    'a bare git reached an injectable runner that defaults to child_process itself');
  pass('no other bare git reaches a child_process call in src/');
}

async function main() {
  wrappersStartGitByAbsolutePath();
  await plantedGitIsNeverRun();
  lunaRunnersUseTheWrappers();
  noOtherBareGitInSource();
  assert.ok(checks >= 6, `expected at least 6 checks, ran ${checks}`);
  console.log(`git bare-command sites: ${checks} checks passed`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
