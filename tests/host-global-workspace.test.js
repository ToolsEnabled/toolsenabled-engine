'use strict';
/* Global host mode: the account home may be the sealed workspace, but its
 * hidden top-level entries (agent settings, sign-ins, keys, shell startup
 * files) are never inside it, and workers start where the lead works. */
require('./lib/isolated-environment').activate('host-global-workspace');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const boundary = require('../src/lib/workspace-boundary');
const { workerFolder } = require('../src/lib/host-agent-mode');
const { checkWorkspaceCandidate } = require('../src/lib/setup/workspace');

const home = fs.realpathSync(os.userInfo().homedir);

test('a home workspace excludes the home\'s hidden entries and nothing else', () => {
  assert.equal(boundary.hiddenUnderHome(home, path.join(home, '.ssh', 'id_ed25519')), true);
  assert.equal(boundary.hiddenUnderHome(home, path.join(home, '.claude.json')), true);
  assert.equal(boundary.hiddenUnderHome(home, path.join(home, '.config', 'opencode', 'opencode.json')), true);
  assert.equal(boundary.hiddenUnderHome(home, path.join(home, 'project', '.git', 'config')), false, 'hidden entries inside a project stay project files');
  assert.equal(boundary.hiddenUnderHome(home, path.join(home, 'project')), false);
  assert.equal(boundary.hiddenUnderHome(path.join(home, 'project'), path.join(home, 'project', '.env')), false, 'only a home root is affected');
  assert.equal(boundary.isInsideRoots(path.join(home, '.bashrc'), [home]), false);
  assert.equal(boundary.isInsideRoots(home, [home]), true);
});

test('host setup may name the account home; other setups still refuse it', () => {
  assert.equal(checkWorkspaceCandidate(home, { allowHome: true, homedir: () => home }).ok, true);
  assert.equal(checkWorkspaceCandidate(home, { homedir: () => home }).code, 'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED');
});

test('workers start in the lead\'s folder only for a global workspace, never in a hidden entry', t => {
  const project = fs.mkdtempSync(path.join(home, 'fleet-global-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const real = fs.realpathSync(project);
  assert.equal(workerFolder({ workspace: home }, project), real);
  assert.equal(workerFolder({ workspace: home }, home), home);
  assert.equal(workerFolder({ workspace: home }, os.tmpdir()), home, 'outside the home falls back to the workspace');
  assert.equal(workerFolder({ workspace: real }, home), real, 'a project workspace is unchanged');
  const hidden = path.join(home, '.config');
  if (fs.existsSync(hidden)) assert.equal(workerFolder({ workspace: home }, hidden), home);
});
