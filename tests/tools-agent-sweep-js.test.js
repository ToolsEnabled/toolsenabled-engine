'use strict';

require('./lib/isolated-environment').activate('tools-agent-sweep-js');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const agentOrg = require('../src/lib/agent-org');
const wake = require('../src/lib/agent-wake');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'agent-sweep.js');

function invoke(args, environment = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, TOOLSENABLED_AGENT_ID: '', ...environment }
  });
}

function refusal(args, message, code = 'AGENT_WAKE_ARGUMENT_INVALID') {
  const result = invoke(args);
  assert.equal(result.status, 1, `${message}: named failure exit code`);
  assert.equal(result.signal, null, `${message}: must exit normally`);
  assert.equal(result.stdout, '', `${message}: refusals do not resemble successful output`);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code, message: JSON.parse(result.stderr).message });
  assert.ok(JSON.parse(result.stderr).message.length > 0, `${message}: refusal explains itself`);
}

test('pins every command-line refusal behind exit code 1', () => {
  const cases = [
    [['positional'], 'positional argument'],
    [['--from', 'manager-a', '--from', 'manager-b'], 'duplicate option'],
    [['--from'], 'missing option value'],
    [['--not-an-option', 'x'], 'unknown option'],
    [['--auto-wake', 'always'], 'unknown auto-wake policy'],
    [['--from', 'not an agent'], 'invalid actor', 'AGENT_PRESENCE_INVALID'],
    [['--max-respawns', '0'], 'max respawns below range', 'AGENT_WAKE_INVALID'],
    [['--max-auto-respawns', '21'], 'per-pass respawns above range', 'AGENT_WAKE_INVALID'],
    [['--stale-ms', '999'], 'staleness below range', 'AGENT_WAKE_INVALID'],
    [['--useful-progress-stale-ms', '86400001'], 'useful-progress staleness above range', 'AGENT_WAKE_INVALID'],
    [['--startup-timeout-ms', '99'], 'startup timeout below range', 'AGENT_WAKE_INVALID']
  ];
  for (const [args, label, code] of cases) refusal(args, label, code);
});

function fixtureOrg(rootEnabled = true) {
  return agentOrg.normalizeOrg({ schemaVersion: 1, revision: 1,
    agents: [
      { id: 'fixture-root', displayName: 'Fixture Root', role: 'controller', provider: 'codex', enabled: rootEnabled, assignedPhase: null, phasePriority: [] },
      { id: 'fixture-observer', displayName: 'Fixture Observer', role: 'observer', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
      { id: 'fixture-worker', displayName: 'Fixture Worker', role: 'worker', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
    ],
    relationships: [
      { from: 'fixture-root', to: 'fixture-observer', type: 'manages' },
      { from: 'fixture-observer', to: 'fixture-worker', type: 'manages' }
    ]
  });
}

test('automatic recovery can derive the enabled declared root, never a missing or disabled fallback', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sweep-root-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const orgFile = path.join(directory, 'org.json');
  const registryFile = path.join(directory, 'absent-registry.json');
  fs.writeFileSync(orgFile, JSON.stringify(fixtureOrg()), 'utf8');
  const args = ['--auto-wake', 'dead', '--org-file', orgFile, '--state-file', registryFile,
    '--launch-dir', path.join(directory, 'launch'), '--mailbox-dir', path.join(directory, 'mailbox')];
  const parsed = wake.parseSweepArgs(args, { TOOLSENABLED_AGENT_ID: '' });
  assert.equal(parsed.input.from, undefined, 'parsing does not invent an actor before reading authoritative org data');
  const ready = invoke(args);
  assert.equal(ready.error, undefined);
  assert.equal(ready.signal, null);
  assert.equal(ready.status, 0, ready.stderr);
  const report = JSON.parse(ready.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.policy, 'dead');
  assert.equal(report.counts.scanned, 0);
  assert.deepEqual(report.respawns, [], 'the empty owned registry cannot launch any provider');
  assert.equal(fs.existsSync(registryFile), false, 'an empty sweep does not manufacture a presence binding');

  fs.writeFileSync(orgFile, JSON.stringify(fixtureOrg(false)), 'utf8');
  refusal(args, 'disabled declared recovery root', 'AGENT_SWEEP_ROOT_UNAVAILABLE');
  fs.writeFileSync(orgFile, '{}', 'utf8');
  refusal(args, 'malformed declared org cannot fall back to a startup actor', 'AGENT_WAKE_ORG_INVALID');
});

test('automatic actor resolution does not relax the actual per-target wake authority gate', () => {
  const org = fixtureOrg();
  const registry = { agents: { 'fixture-worker': { agentId: 'fixture-worker', role: 'worker' } } };
  const request = { from: 'fixture-root', target: 'fixture-worker', org, registry };
  assert.equal(wake.assertWakeAuthorized(request).authorized, true, 'the enabled root can supervise a transitive report');
  assert.throws(() => wake.assertWakeAuthorized({ ...request, from: 'fixture-observer' }),
    error => error?.code === 'AGENT_WAKE_ROLE_READ_ONLY', 'a declared supervisory edge cannot grant a read-only role wake permission');
  assert.throws(() => wake.assertWakeAuthorized({ ...request, from: 'unbound-caller' }),
    error => error?.code === 'AGENT_WAKE_ACTOR_UNKNOWN');
  assert.throws(() => wake.assertWakeAuthorized({ ...request, org: fixtureOrg(false) }),
    error => error?.code === 'AGENT_WAKE_ACTOR_DISABLED');
});

test('pins the successful and refused sweep-state exit codes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sweep-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const empty = invoke(['--state-file', path.join(directory, 'absent.json')]);
  assert.equal(empty.status, 0, 'an absent registry is the supported empty-registry case');
  assert.equal(JSON.parse(empty.stdout).ok, true);

  const malformed = path.join(directory, 'malformed.json');
  fs.writeFileSync(malformed, '{', 'utf8');
  refusal(['--state-file', malformed], 'malformed state', 'AGENT_PRESENCE_STATE_INVALID');

  const invalid = path.join(directory, 'invalid.json');
  fs.writeFileSync(invalid, '{}', 'utf8');
  refusal(['--state-file', invalid], 'invalid state shape', 'AGENT_PRESENCE_STATE_INVALID');
});
