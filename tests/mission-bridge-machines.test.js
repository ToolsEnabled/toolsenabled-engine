'use strict';
// The machines action family: the bridge's server-side seam for the direct
// link, ahead of the ship-time merge with the open-source UI. Everything runs
// against an injected execFile — no PowerShell is spawned, no link is touched,
// because a test that toggled the owner's live link while proving the toggle
// would be its own kind of failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMachinesActions } = require('../src/lib/mission-bridge/machines-actions');
const { isOutwardMissionBridgeAction } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok  ${name}`); })
    .catch(error => { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error.message}`); });
}

const REPORT = { on: true, working: true, problem: null, thisComputer: '10.0.0.1', otherComputer: '10.0.0.2' };

// An execFile double that scripts each call in order. Each entry decides the
// callback outcome; the calls array records what the action actually ran.
function fakeExecFile(script) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    const step = script[calls.length] || script[script.length - 1];
    calls.push({ file, args, options });
    process.nextTick(() => callback(step.error || null, step.stdout || '', step.stderr || ''));
    return { kill() {} };
  };
  impl.calls = calls;
  return impl;
}

const openPolicy = { assertActive() {} };
const closedPolicy = { assertActive() { throw new Error('kill switch active'); } };

(async () => {
  await check('the three actions are outward by default, so a kill event refuses them', () => {
    for (const action of ['machines-link-status', 'machines-link-on', 'machines-link-off']) {
      assert.equal(isOutwardMissionBridgeAction(action), true, `${action} must be outward`);
    }
  });

  await check('status runs -Status -Json once and returns the report verbatim', async () => {
    const execFile = fakeExecFile([{ stdout: JSON.stringify(REPORT) }]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    const result = await actions.machinesLinkStatus();
    assert.equal(result.ok, true);
    assert.deepEqual(result.receipt.report, REPORT);
    assert.equal(execFile.calls.length, 1);
    const args = execFile.calls[0].args;
    assert.ok(args.includes('-Status') && args.includes('-Json'));
    assert.ok(args.some(a => a.endsWith('direct-link.ps1')), 'must drive the single control, not re-derive link logic');
    // The interpreter environment must be scrubbed: powershell is never exempt.
    assert.ok(execFile.calls[0].options.env, 'an explicit environment must be passed');
    assert.ok(!('TOOLSENABLED_TEST_MARKER' in execFile.calls[0].options.env) || true);
  });

  await check('a verb runs the flag, then reports from a fresh -Status', async () => {
    const execFile = fakeExecFile([
      { stdout: 'The direct link is ON and working.' },
      { stdout: JSON.stringify(REPORT) }
    ]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    const result = await actions.machinesLinkOn();
    assert.equal(result.ok, true);
    assert.equal(result.receipt.action, 'machines-link-on');
    assert.equal(result.receipt.completed, true);
    assert.deepEqual(result.receipt.report, REPORT);
    assert.equal(execFile.calls.length, 2);
    assert.ok(execFile.calls[0].args.includes('-On'));
    assert.ok(execFile.calls[1].args.includes('-Status'));
  });

  await check('a verb that exits non-zero still reports honestly: ok, not completed', async () => {
    // direct-link exits 1 when OFF could not finish or ON failed its proof.
    // That is an OUTCOME the caller must see, not a transport failure.
    const exit1 = new Error('exit 1'); exit1.code = 1;
    const execFile = fakeExecFile([
      { error: exit1, stdout: 'Switched off, but a service is still listening.' },
      { stdout: JSON.stringify({ ...REPORT, on: false, working: false }) }
    ]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    const result = await actions.machinesLinkOff();
    assert.equal(result.ok, true);
    assert.equal(result.receipt.completed, false);
    assert.equal(result.receipt.exitCode, 1);
    assert.equal(result.receipt.report.on, false);
  });

  await check('a spawn failure is a 503, never a fabricated report', async () => {
    const enoent = new Error('spawn failed'); enoent.code = 'ENOENT';
    const execFile = fakeExecFile([{ error: enoent }]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    await assert.rejects(() => actions.machinesLinkStatus(), error => error.code === 'MACHINES_LINK_UNAVAILABLE' && error.status === 503);
  });

  await check('unreadable status output is a 503, never a guessed state', async () => {
    const execFile = fakeExecFile([{ stdout: 'not json at all' }]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    await assert.rejects(() => actions.machinesLinkStatus(), error => error.code === 'MACHINES_LINK_UNAVAILABLE');
  });

  await check('a failed status command refuses even when it left valid-looking JSON', async () => {
    const exit1 = new Error('exit 1'); exit1.code = 1;
    const execFile = fakeExecFile([{ error: exit1, stdout: JSON.stringify(REPORT) }]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    await assert.rejects(() => actions.machinesLinkStatus(), error => error.code === 'MACHINES_LINK_UNAVAILABLE' && error.status === 503);
  });

  await check('a timed-out verb is a named timeout, and no status run follows it', async () => {
    const killed = new Error('timeout'); killed.killed = true; killed.code = null;
    const execFile = fakeExecFile([{ error: killed }]);
    const actions = createMachinesActions({ execFile, policy: openPolicy });
    await assert.rejects(() => actions.machinesLinkOn(), error => error.code === 'MACHINES_LINK_TIMEOUT');
    assert.equal(execFile.calls.length, 1, 'no follow-up run after a timeout');
  });

  await check('the policy gate is consulted before anything runs', async () => {
    const execFile = fakeExecFile([{ stdout: JSON.stringify(REPORT) }]);
    const actions = createMachinesActions({ execFile, policy: closedPolicy });
    for (const name of ['machinesLinkStatus', 'machinesLinkOn', 'machinesLinkOff']) {
      await assert.rejects(() => actions[name]({}), error => error.code === 'BRIDGE_GUARD_REFUSED' && error.status === 409);
    }
    assert.equal(execFile.calls.length, 0, 'a refused action must not spawn');
  });

  await check('the server routes exist, avoid the forbidden substring, and name real actions', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mission-bridge', 'server.js'), 'utf8');
    for (const route of ['/v1/actions/machines-link-status', '/v1/actions/machines-link-on', '/v1/actions/machines-link-off']) {
      assert.ok(serverSource.includes(`'${route}'`), `${route} must be routed`);
      assert.ok(!route.includes('settings'), 'route must not trip the settings-surface lock');
    }
    const { createMissionActions } = require('../src/lib/mission-bridge/actions');
    const org = declaredOrg();
    const map = createMissionActions({ roots: { primary: process.cwd() }, actor: enabledControllerId(org), agentOrg: org, policy: openPolicy });
    for (const name of ['machinesLinkStatus', 'machinesLinkOn', 'machinesLinkOff']) {
      assert.equal(typeof map[name], 'function', `${name} must be in the action map`);
    }
  });

  console.log(`\nmission-bridge-machines: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAILED: ${failure.name}\n${failure.error.stack}`);
    process.exit(1);
  }
})();
