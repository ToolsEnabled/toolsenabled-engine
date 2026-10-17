'use strict';
require('./lib/isolated-environment').activate('host-control-workspace-autorun');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hostRuntime = require('../src/lib/host-runtime');
const hostControl = require('../src/lib/providers/host-control');
const { resolveHostPath } = hostControl;
const home = os.userInfo().homedir;

test('host reads and writes stay in the sealed workspace and avoid executable control paths', async () => {
  const root = fs.mkdtempSync(path.join(home, 'fleet-gw1-'));
  const stateRoot = path.join(root, 'state');
  const workspace = path.join(root, 'work');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const oldSandbox = process.env.OPENSHELL_SANDBOX;
  const oldPath = process.env.PATH;
  try {
    delete process.env.OPENSHELL_SANDBOX;
    hostRuntime.setupHost({ schemaVersion: 1, mode: 'host', workers: false, tier: 'unrestricted',
      stateRoot, workspace, installRoot: hostRuntime.INSTALL_ROOT, nodePath: process.execPath });
    process.env.PATH = `${path.join(workspace, 'bin')}${path.delimiter}${oldPath}`;
    const denied = [
      path.join(root, 'outside.txt'),
      path.join(home, '.bashrc'), path.join(home, '.bash_profile'), path.join(home, '.bash_login'),
      path.join(home, '.profile'), path.join(home, '.zshrc'), path.join(home, '.zshenv'),
      path.join(home, '.zprofile'), path.join(home, '.zlogin'), path.join(home, '.kshrc'),
      path.join(home, '.cshrc'), path.join(home, '.tcshrc'), path.join(home, '.inputrc'),
      path.join(home, '.xprofile'), path.join(home, '.xinitrc'), path.join(home, '.pam_environment'),
      path.join(home, '.local/bin/tool'), path.join(home, '.ssh/config'),
      path.join(home, '.config/autostart/agent.desktop'),
      path.join(workspace, '.git/config'), path.join(workspace, '.git/hooks/pre-commit'),
      path.join(workspace, '.hg/hgrc'), path.join(workspace, '.svn/hooks/pre-commit'),
      path.join(workspace, '.vscode/tasks.json'), path.join(workspace, '.idea/runConfigurations/run.xml'),
      path.join(workspace, '.devcontainer/devcontainer.json'),
      path.join(workspace, '.github/workflows/build.yml'),
      path.join(workspace, '.github/actions/action.yml'), path.join(workspace, '.gitlab-ci.yml'),
      path.join(workspace, '.circleci/config.yml'), path.join(workspace, '.husky/pre-commit'),
      path.join(workspace, '.githooks/pre-commit'), path.join(workspace, 'lefthook.yml'),
      path.join(workspace, 'bare.git/hooks/pre-receive'), path.join(workspace, 'bare.git/config'),
      path.join(workspace, '.cargo/config.toml'), path.join(workspace, '.yarnrc.yml'),
      path.join(workspace, 'mise.toml'), path.join(workspace, 'node_modules/.bin/runner'),
      path.join(workspace, '.venv/bin/python'),
      path.join(workspace, 'venv/bin/python'), path.join(workspace, 'env/bin/python'),
      path.join(workspace, 'lib/python3.11/site-packages/agent.pth'),
      path.join(workspace, '.mcp.json'), path.join(workspace, '.mise.toml'),
      path.join(workspace, '.pnpmfile.cjs'), path.join(workspace, 'sitecustomize.py'),
      path.join(workspace, 'conftest.py'),
      path.join(workspace, '.envrc'), path.join(workspace, 'package.json'),
      path.join(workspace, 'Makefile'), path.join(workspace, 'justfile'),
      path.join(workspace, 'bin/worker'),
    ];
    for (const target of denied) {
      assert.throws(() => resolveHostPath(target, { forWrite: true }),
        error => ['HOST_PATH_WRITE_PROTECTED', 'HOST_PATH_FORBIDDEN', 'HOST_PATH_OUTSIDE_WORKSPACE'].includes(error.code), target);
    }
    assert.equal(resolveHostPath(path.join(workspace, 'docs/notes.md'), { forWrite: true }),
      path.join(workspace, 'docs/notes.md'));
    for (const target of [path.join(root, '.pgpass'), path.join(root, '.vault-token'),
      path.join(root, 'outside.txt'), path.join(home, '.claude.json')]) {
      assert.throws(() => resolveHostPath(target),
        error => ['HOST_PATH_OUTSIDE_WORKSPACE', 'HOST_PATH_FORBIDDEN'].includes(error.code), target);
      assert.throws(() => resolveHostPath(path.dirname(target), { mustExist: true }),
        { code: 'HOST_PATH_OUTSIDE_WORKSPACE' }, `list parent ${target}`);
    }
    assert.equal(resolveHostPath(path.join(workspace, 'docs/notes.md')),
      path.join(workspace, 'docs/notes.md'));
    fs.writeFileSync(path.join(root, 'outside.txt'), 'synthetic outside');
    fs.writeFileSync(path.join(workspace, 'inside.txt'), 'synthetic inside');
    const audit = { requireRecordAsync: async () => {}, recordAsync: async () => {} };
    assert.throws(() => hostControl.readFile({ path: path.join(root, 'outside.txt') }, audit),
      { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    assert.throws(() => hostControl.listDir({ path: root }, audit),
      { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    assert.equal((await hostControl.readFile({ path: path.join(workspace, 'inside.txt') }, audit)).content,
      'synthetic inside');
    // A relative path is relative to the saved workspace root in host mode.
    assert.equal((await hostControl.readFile({ path: 'inside.txt' }, audit)).content, 'synthetic inside');
    assert.equal(resolveHostPath('docs/notes.md', { forWrite: true }), path.join(workspace, 'docs/notes.md'));
    assert.throws(() => resolveHostPath('../outside.txt'), { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    assert.equal((await hostControl.listDir({}, audit)).path, workspace);
    for (const target of ['.my.cnf', 'kaggle.json', '.cargo/credentials', '.gem/credentials',
      '.m2/settings.xml', '.bash_history', 'worker_history', 'key4.db', 'Login Data',
      'login.keyring', '.Xauthority']) {
      assert.throws(() => resolveHostPath(path.join(workspace, target)),
        { code: 'HOST_PATH_FORBIDDEN' }, target);
    }
    for (const target of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv', '.envrc']) {
      assert.throws(() => resolveHostPath(path.join(home, target)), { code: 'HOST_PATH_FORBIDDEN' });
    }
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'alias-out'));
    assert.throws(() => resolveHostPath(path.join(workspace, 'alias-out/new.txt'), { forWrite: true }),
      { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    fs.mkdirSync(path.join(workspace, '.git', 'hooks'), { recursive: true });
    fs.symlinkSync(path.join(workspace, '.git'), path.join(workspace, 'alias-git'));
    assert.throws(() => resolveHostPath(path.join(workspace, 'alias-git/hooks/pre-commit'), { forWrite: true }),
      { code: 'HOST_PATH_WRITE_PROTECTED' });
  } finally {
    if (oldSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = oldSandbox;
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host setup refuses a symlinked workspace and aliases of the passwd home', () => {
  const root = fs.mkdtempSync(path.join(home, 'fleet-work-alias-'));
  const actual = path.join(root, 'actual');
  fs.mkdirSync(actual);
  const alias = path.join(root, 'alias');
  const homeAlias = path.join(root, 'home-alias');
  fs.symlinkSync(actual, alias, 'dir');
  fs.symlinkSync(home, homeAlias, 'dir');
  const oldSandbox = process.env.OPENSHELL_SANDBOX;
  try {
    delete process.env.OPENSHELL_SANDBOX;
    for (const workspace of [alias, homeAlias]) {
      const stateRoot = path.join(root, `state-${path.basename(workspace)}`);
      assert.throws(() => hostRuntime.setupHost({ schemaVersion: 1, mode: 'host', workers: false,
        tier: 'unrestricted', stateRoot, workspace, installRoot: hostRuntime.INSTALL_ROOT,
        nodePath: process.execPath }), { code: 'HOST_WORKSPACE_SYMLINK_REFUSED' }, workspace);
    }
  } finally {
    if (oldSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = oldSandbox;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host setup refuses workspaces beneath top-level home dot folders', () => {
  const root = fs.mkdtempSync(path.join(home, '.fleet-work-dot-'));
  const oldSandbox = process.env.OPENSHELL_SANDBOX;
  try {
    delete process.env.OPENSHELL_SANDBOX;
    assert.throws(() => hostRuntime.setupHost({ schemaVersion: 1, mode: 'host', workers: false,
      tier: 'unrestricted', stateRoot: path.join(root, 'state'), workspace: path.join(root, 'project'),
      installRoot: hostRuntime.INSTALL_ROOT, nodePath: process.execPath }),
    { code: 'HOST_WORKSPACE_PROFILE_DOT_REFUSED' });
  } finally {
    if (oldSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = oldSandbox;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
