/* Mutation check:
 * Changed the module's `git clean` arguments from `['clean', '-fdq']`
 * to `['clean', '-fq']`, removing recursive directory cleanup.
 * The edit landed, and this test file went red (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workspace = require('../src/lib/setup/workspace');

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

test('provision creates an allowed folder and starts history when git is available', () => {
  const candidate = path.join(os.tmpdir(), 'workspace-provision', 'project');
  const calls = [];
  const runner = (command, args, options) => {
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
    runner
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

test('checkpoint records all content and returns the resulting revision', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { status: 0, stdout: 'true\n' };
    if (args[0] === 'add' || args.includes('commit')) return { status: 0 };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: 'abc123\n' };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  assert.deepEqual(
    workspace.checkpointWorkspace('/fixture/workspace', { runner, label: 'before fixture turn' }),
    { ok: true, checkpoint: 'abc123' }
  );
  assert.deepEqual(calls[2], ['add', '--all']);
  assert.deepEqual(calls[3].slice(-3), ['--allow-empty', '-m', 'before fixture turn']);
});

test('undo restores the checkpoint and removes files created after it', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
    if (args[0] === 'reset' || args[0] === 'clean') return { status: 0 };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  assert.deepEqual(workspace.undoToCheckpoint('/fixture/workspace', 'abc123', { runner }), { ok: true });
  assert.deepEqual(calls.slice(-2), [
    ['reset', '--hard', '--quiet', 'abc123'],
    ['clean', '-fdq']
  ]);
  assert.deepEqual(workspace.undoToCheckpoint('/fixture/workspace', '   ', { runner }), {
    ok: false,
    reason: 'there is no earlier state of this folder to go back to'
  });
});
