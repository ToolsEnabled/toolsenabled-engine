/* Mutation check:
 * Changed the module's `git clean` arguments from `['clean', '-fdq']`
 * to `['clean', '-fq']`, removing recursive directory cleanup.
 * The edit landed, and this test file went red (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workspace = require('../src/lib/setup/workspace');

/* Every stub runner below receives the REAL spawn argv. git is pinned to a
 * fixture path that is never executed, so these tests do not depend on the
 * host having git; the folder reaches git as `-C <folder>` (security review
 * 1.0.50 M4), which the stubs strip before answering. Folders are real
 * directories because a missing one is reported without starting git, exactly
 * as spawnSync with a missing `cwd` used to fail. */
const FIXTURE_GIT = path.join(os.tmpdir(), 'workspace-fixture-bin', process.platform === 'win32' ? 'git.exe' : 'git');
const fixtureGit = () => FIXTURE_GIT;

function realFolder(t, prefix) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function gitSubcommand(args, folder) {
  if (args[0] !== '-C') return args;
  assert.equal(args[1], folder, 'git must be pointed at the workspace with -C');
  return args.slice(2);
}

test('default workspace uses an absolute Documents override and otherwise the profile', () => {
  const profile = path.join(os.tmpdir(), 'workspace-profile');
  const relocatedDocuments = path.join(os.tmpdir(), 'relocated-documents');

  assert.equal(
    workspace.defaultWorkspacePath({ env: { USERPROFILE: profile }, documentsDir: relocatedDocuments }),
    path.join(relocatedDocuments, workspace.DEFAULT_WORKSPACE_LEAF)
  );
  assert.equal(
    workspace.defaultWorkspacePath({ env: { USERPROFILE: profile }, documentsDir: 'relative-documents' }),
    path.join(profile, 'Documents', workspace.DEFAULT_WORKSPACE_LEAF)
  );
});

test('candidate checks refuse dangerous roots but unrestricted may use the install tree', () => {
  const profile = path.join(os.tmpdir(), 'workspace-person');
  const installRoot = path.join(os.tmpdir(), 'workspace-install');

  assert.equal(workspace.checkWorkspaceCandidate('', { installRoot }).code, 'SETUP_WORKSPACE_MISSING');
  assert.equal(
    workspace.checkWorkspaceCandidate(profile, { installRoot, env: { USERPROFILE: profile } }).code,
    'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED'
  );
  assert.equal(
    workspace.checkWorkspaceCandidate(path.join(installRoot, 'source'), { installRoot }).code,
    'SETUP_WORKSPACE_INSIDE_INSTALL_REFUSED'
  );
  assert.deepEqual(
    workspace.checkWorkspaceCandidate(path.join(installRoot, 'source'), { installRoot, tier: 'unrestricted' }),
    { ok: true, resolved: path.resolve(installRoot, 'source') }
  );
  assert.throws(
    () => workspace.assertWorkspaceAllowed(profile, { installRoot, env: { USERPROFILE: profile } }),
    error => error.code === 'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED'
      && error.details.workspace === path.resolve(profile)
  );
});

test('network workspace refusal stops provisioning before filesystem or process effects', () => {
  // workspace.js uses the host path implementation. Substitute the matching
  // Windows implementation so this non-Windows test can drive the UNC branch
  // exactly as a Windows caller does, without reducing the assertion to a
  // source-string check.
  const hostResolve = path.resolve;
  const hostParse = path.parse;
  path.resolve = path.win32.resolve;
  path.parse = path.win32.parse;

  try {
    const candidate = '\\\\fileserver\\shared\\assistant-work';
    const verdict = workspace.checkWorkspaceCandidate(candidate);

    assert.deepEqual(verdict, {
      ok: false,
      code: 'SETUP_WORKSPACE_NETWORK_REFUSED',
      message: 'That folder is on another computer over the network. Choose a folder on this computer.',
      resolved: candidate
    });

    let filesystemCalls = 0;
    let processCalls = 0;
    assert.throws(
      () => workspace.provisionWorkspace(candidate, {
        exists: () => { filesystemCalls += 1; },
        makeDirectory: () => { filesystemCalls += 1; },
        runner: () => { processCalls += 1; }
      }),
      error => error.code === 'SETUP_WORKSPACE_NETWORK_REFUSED'
        && error.details.workspace === candidate
    );
    assert.equal(filesystemCalls, 0, 'refusal must happen before reading or writing the workspace');
    assert.equal(processCalls, 0, 'refusal must happen before spawning git');
  } finally {
    path.resolve = hostResolve;
    path.parse = hostParse;
  }
});

test('provision creates an allowed folder and starts history when git is available', (t) => {
  const candidate = realFolder(t, 'workspace-provision-');
  const calls = [];
  const runner = (command, rawArgs, options) => {
    const args = gitSubcommand(rawArgs, path.resolve(candidate));
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === '--version') return { status: 0, stdout: 'git version fixture' };
    if (args[0] === 'rev-parse') return { status: 128, stdout: '' };
    if (args[0] === 'init') return { status: 0 };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  let madeDirectory;

  const result = workspace.provisionWorkspace(candidate, {
    installRoot: path.join(os.tmpdir(), 'different-install'),
    exists: () => false,
    makeDirectory: (directory, options) => { madeDirectory = { directory, options }; },
    runner,
    resolveGit: fixtureGit
  });

  assert.deepEqual(result, {
    workspace: path.resolve(candidate),
    created: true,
    undoAvailable: true,
    alreadyTracked: false
  });
  assert.deepEqual(madeDirectory, { directory: path.resolve(candidate), options: { recursive: true } });
  assert.deepEqual(calls.map(call => call.args), [
    ['--version'],
    ['rev-parse', '--is-inside-work-tree'],
    ['init', '--quiet']
  ]);
});

test('checkpoint records all content and returns the resulting revision', (t) => {
  const folder = realFolder(t, 'workspace-checkpoint-');
  const calls = [];
  const runner = (command, rawArgs) => {
    const args = gitSubcommand(rawArgs, folder);
    calls.push(args);
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { status: 0, stdout: 'true\n' };
    if (args[0] === 'add' || args.includes('commit')) return { status: 0 };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: 'abc123\n' };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  assert.deepEqual(
    workspace.checkpointWorkspace(folder, { runner, resolveGit: fixtureGit, label: 'before fixture turn' }),
    { ok: true, checkpoint: 'abc123' }
  );
  assert.deepEqual(calls[2], ['add', '--all']);
  assert.deepEqual(calls[3].slice(-3), ['--allow-empty', '-m', 'before fixture turn']);
});

test('undo restores the checkpoint and removes files created after it', (t) => {
  const folder = realFolder(t, 'workspace-undo-');
  const calls = [];
  const runner = (command, rawArgs) => {
    const args = gitSubcommand(rawArgs, folder);
    calls.push(args);
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
    if (args[0] === 'reset' || args[0] === 'clean') return { status: 0 };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  assert.deepEqual(workspace.undoToCheckpoint(folder, 'abc123', { runner, resolveGit: fixtureGit }), { ok: true });
  assert.deepEqual(calls.slice(-2), [
    ['reset', '--hard', '--quiet', 'abc123'],
    ['clean', '-fdq']
  ]);
  assert.deepEqual(workspace.undoToCheckpoint(folder, '   ', { runner, resolveGit: fixtureGit }), {
    ok: false,
    reason: 'there is no earlier state of this folder to go back to'
  });
});

// --- security review 1.0.50 M4: the chosen folder never supplies the git ----

test('every git call names an absolute git and passes the folder as -C, never as the working directory', (t) => {
  const folder = realFolder(t, 'workspace-git-shape-');
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const sub = args[0] === '-C' ? args.slice(2) : args;
    if (sub[0] === '--version') return { status: 0, stdout: 'git version fixture' };
    if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return { status: 0, stdout: 'true\n' };
    if (sub[0] === 'rev-parse') return { status: 0, stdout: 'abc123\n' };
    return { status: 0, stdout: '' };
  };
  const options = { runner, resolveGit: fixtureGit };

  assert.equal(workspace.provisionWorkspace(folder, { ...options, installRoot: path.join(os.tmpdir(), 'different-install') }).undoAvailable, true);
  assert.deepEqual(workspace.checkpointWorkspace(folder, options), { ok: true, checkpoint: 'abc123' });
  assert.deepEqual(workspace.undoToCheckpoint(folder, 'abc123', options), { ok: true });

  // provision 2 (version, rev-parse) + checkpoint 5 + undo 4.
  assert.equal(calls.length, 11);
  for (const call of calls) {
    assert.equal(call.command, FIXTURE_GIT, 'git is started by its resolved absolute path, never as a bare name');
    assert.equal(Object.hasOwn(call.options, 'cwd'), false, 'the chosen folder is never the working directory');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, false);
    if (call.args[0] === '--version') continue;
    assert.deepEqual(call.args.slice(0, 2), ['-C', folder], 'the folder reaches git as -C');
  }
  assert.ok(calls.filter(call => call.args[0] === '-C').length >= 8, 'the folder-scoped calls were all checked');
});

test('with no git on an absolute PATH entry nothing is started and setup says git is absent', (t) => {
  const folder = realFolder(t, 'workspace-no-git-');
  const runner = (command, args) => { throw new Error(`nothing may be started: ${command} ${args.join(' ')}`); };
  assert.deepEqual(workspace.provisionWorkspace(folder, {
    installRoot: path.join(os.tmpdir(), 'different-install'),
    runner,
    resolveGit: () => null
  }), {
    workspace: path.resolve(folder),
    created: false,
    undoAvailable: false,
    undoUnavailableReason: 'this computer has no version history tool installed, so changes here cannot be undone automatically'
  });
  assert.equal(workspace.gitAvailable({ runner, resolveGit: () => null }), false);
});

test('a folder that no longer exists is still "could not be checked", and git is not pointed at it', (t) => {
  const missing = path.join(realFolder(t, 'workspace-gone-'), 'removed');
  const started = [];
  const runner = (command, args) => {
    started.push(args);
    if (args[0] === '--version') return { status: 0, stdout: 'git version fixture' };
    throw new Error(`git must not be started against a missing folder: ${args.join(' ')}`);
  };
  assert.deepEqual(workspace.checkpointWorkspace(missing, { runner, resolveGit: fixtureGit }), {
    ok: false,
    reason: 'the history of this folder could not be checked'
  });
  assert.deepEqual(workspace.undoToCheckpoint(missing, 'abc123', { runner, resolveGit: fixtureGit }), {
    ok: false,
    reason: 'the history of this folder could not be checked'
  });
  assert.deepEqual(started, [['--version'], ['--version']]);
});

test('a git planted at the top of the chosen folder is never run', {
  skip: process.platform === 'win32'
    && 'POSIX simulation only: a "." PATH entry stands in for Windows searching the working directory first; Windows is covered by the call-shape and resolver tests'
}, (t) => {
  // On Windows the OS looks in the child's working directory before PATH. On
  // POSIX a relative PATH entry does the same thing, so this drives the REAL
  // spawn (no stub runner, no pinned git) through exactly that search.
  const folder = realFolder(t, 'workspace-planted-');
  const marker = path.join(realFolder(t, 'workspace-planted-marker-'), 'planted-git-ran');
  fs.writeFileSync(path.join(folder, 'git'), `#!/bin/sh\necho "$*" >> '${marker}'\necho true\nexit 0\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `.${path.delimiter}${savedPath}`;
  let result;
  try {
    result = workspace.provisionWorkspace(folder, { installRoot: path.join(os.tmpdir(), 'different-install') });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(fs.existsSync(marker), false,
    `the git planted in the chosen folder ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''}`);
  assert.equal(result.workspace, path.resolve(folder));
  assert.equal(typeof result.undoAvailable, 'boolean');
});

test('git is resolved from absolute PATH entries only, in the order the OS search uses', () => {
  const { resolveGitExecutable } = require('../src/lib/git-command');
  const absent = () => { const error = new Error('absent'); error.code = 'ENOENT'; throw error; };
  const fileAt = paths => candidate => (paths.includes(candidate) ? { isFile: () => true } : absent());

  // Windows: relative, drive-relative and root-relative entries are never even
  // looked at; a quoted absolute entry is; .com is tried before .exe; no .cmd.
  const asked = [];
  const windowsFiles = fileAt(['\x43:\\Program Files\\Git\\cmd\\git.exe', '\x44:\\tools\\git.com', '\x44:\\tools\\git.exe', '\x45:\\shim\\git.cmd']);
  const tracking = candidate => { asked.push(candidate); return windowsFiles(candidate); };
  assert.equal(resolveGitExecutable({
    platform: 'win32',
    env: { Path: '.;bin;;\\rooted;C:relative;"\x43:\\Program Files\\Git\\cmd";\x44:\\tools' },
    statSync: tracking
  }), '\x43:\\Program Files\\Git\\cmd\\git.exe');
  assert.deepEqual(asked, ['\x43:\\Program Files\\Git\\cmd\\git.com', '\x43:\\Program Files\\Git\\cmd\\git.exe']);
  assert.equal(resolveGitExecutable({ platform: 'win32', env: { PATH: '\x44:\\tools' }, statSync: windowsFiles }), '\x44:\\tools\\git.com');
  assert.equal(resolveGitExecutable({ platform: 'win32', env: { PATH: '\x45:\\shim' }, statSync: windowsFiles }), null);
  assert.equal(resolveGitExecutable({
    platform: 'win32', env: { PATH: '.;;bin;git-folder' }, statSync: () => ({ isFile: () => true })
  }), null, 'a git that only a relative entry could reach is not resolved at all');
  assert.equal(resolveGitExecutable({ platform: 'win32', env: {}, statSync: () => ({ isFile: () => true }) }), null);

  // POSIX: relative and empty entries are skipped, and a non-executable file is
  // passed over the way execvp passes over it.
  const posixFiles = fileAt(['/usr/local/bin/git', '/usr/bin/git', 'bin/git', 'git']);
  const accessSync = candidate => { if (candidate === '/usr/local/bin/git') absent(); };
  assert.equal(resolveGitExecutable({
    platform: 'linux', env: { PATH: '.:bin::/usr/local/bin:/usr/bin' }, statSync: posixFiles, accessSync
  }), '/usr/bin/git');
  assert.equal(resolveGitExecutable({
    platform: 'linux', env: { PATH: '.:bin:' }, statSync: () => ({ isFile: () => true }), accessSync: () => {}
  }), null);
});
