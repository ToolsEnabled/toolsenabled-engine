'use strict';

// Native filesystem and diagnostic child checks. Inert auth-file bytes and an
// explicitly substituted OS-home authority are fixtures, not a signed-in turn.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { activate } = require('./lib/isolated-environment');
const isolated = activate('linux-agent-launch');
const planner = require('../src/lib/agent-session-confinement');

test('Linux paired preflight never prepares default credentials and a named account remains usable', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(isolated.root, 'selection-'));
  const userInfo = os.userInfo;
  const home = path.join(root, 'owner-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  t.mock.method(os, 'userInfo', () => ({ ...userInfo(), homedir: home }));
  const options = { provider: 'codex', sessionId: 'named-start', servicesRoot: path.join(root, 'services'),
    machineRecord: { readMachineRecord: () => null } };
  assert.equal(planner.ACCOUNT_SELECTION_PREFLIGHT_VERSION, 1);
  const preflight = planner.preflightSessionPlan(options);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.prepared, false);
  assert.equal(preflight.preflightVersion, 1);
  assert.equal(preflight.codexHome, null);
  assert.equal(preflight.env.CODEX_HOME, undefined);
  assert.deepEqual(preflight.threadOptions, { sandbox: 'read-only', approvalPolicy: 'never' });
  assert.equal(fs.existsSync(options.servicesRoot), false);
  const missing = planner.confinedSessionPlan(options);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'AGENT_CONFINEMENT_SIGNED_OUT');
  const named = path.join(root, 'named-codex');
  fs.mkdirSync(named, { mode: 0o700 });
  fs.writeFileSync(path.join(named, 'auth.json'), '{}', { mode: 0o600 });
  const complete = planner.confinedSessionPlan({ ...options,
    account: { name: 'work', provider: 'codex', resolvedHome: named } });
  assert.equal(complete.ok, true);
  assert.equal(complete.prepared, undefined);
  assert.equal(complete.preflightVersion, undefined);
  assert.equal(complete.account, 'work');
  assert.equal(fs.existsSync(path.join(home, '.codex/auth.json')), false);
  assert.equal(fs.statSync(path.join(complete.codexHome, 'auth.json')).ino,
    fs.statSync(path.join(named, 'auth.json')).ino);
  const defaultHome = path.join(home, '.codex');
  fs.mkdirSync(defaultHome, { mode: 0o700 });
  fs.writeFileSync(path.join(defaultHome, 'auth.json'), '{}', { mode: 0o600 });
  const normal = planner.confinedSessionPlan({ ...options, sessionId: 'default-start' });
  assert.equal(normal.ok, true);
  assert.equal(normal.account, null);
  assert.notEqual(normal.codexHome, complete.codexHome);
  assert.deepEqual(normal.threadOptions, complete.threadOptions);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Linux preflight retains role, identity and selected-home validation', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(isolated.root, 'negative-'));
  const userInfo = os.userInfo;
  t.mock.method(os, 'userInfo', () => ({ ...userInfo(), homedir: root }));
  const options = { provider: 'codex', servicesRoot: path.join(root, 'services'), machineRecord: { readMachineRecord: () => null } };
  assert.equal(planner.preflightSessionPlan({ ...options, provider: 'unrecognized' }).ok, false);
  assert.equal(planner.preflightSessionPlan({ ...options, roleFunctionsOnly: 'yes' }).ok, false);
  assert.equal(planner.preflightSessionPlan({ ...options, agentId: '../escape' }).ok, false);
  assert.equal(planner.preflightSessionPlan({ ...options, account: { name: 'work' } }).ok, false);
  const claude = planner.preflightSessionPlan({ ...options, provider: 'claude', roleFunctionsOnly: true });
  assert.equal(claude.ok, true);
  assert.equal(claude.roleFunctionsOnly, true);
  assert.equal(claude.prepared, false);
  assert.equal(claude.configDir, null);
  assert.equal(fs.existsSync(options.servicesRoot), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Linux Claude version probes execute in each selected home and do not reuse another launch', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(isolated.root, 'version-'));
  const command = path.join(root, 'claude-fixture');
  // A real, finite native shell child; no account/profile files are opened.
  fs.writeFileSync(command, '#!/bin/sh\n[ "$1" = "--version" ] || exit 4\n[ -z "$ANTHROPIC_API_KEY$OPENAI_API_KEY" ] || exit 5\nprintf "%s|%s\\n" "${HOME##*/}" "${CLAUDE_CONFIG_DIR##*/}"\n', { mode: 0o700 });
  const { claudeCliVersion } = require('../src/lib/agent-engine/claude-cli-process');
  for (const name of ['one', 'two']) {
    const selected = path.join(root, name);
    const result = await claudeCliVersion({ command, env: { HOME: root, CLAUDE_CONFIG_DIR: '/unused-ambient', PATH: '/usr/bin:/bin' }, configDir: selected });
    assert.equal(result, `${path.basename(root)}|${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
