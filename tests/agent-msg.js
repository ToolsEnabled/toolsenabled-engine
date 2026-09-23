'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'tools', 'agent-msg.js');
const preload = path.join(__dirname, 'helpers', 'agent-msg-runtime-stub.js');

function call(values, { settings = { values: {}, rejected: [] }, refuseRuntime = false } = {}) {
  return spawnSync(process.execPath, ['--require', preload, cli, ...values], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_MSG_TEST_SETTINGS: JSON.stringify(settings),
      AGENT_MSG_TEST_REFUSE_RUNTIME: refuseRuntime ? '1' : '0'
    }
  });
}

function refusal(values, code, message) {
  const result = call(values);
  assert.equal(result.status, 2, `${values.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.deepEqual(failure, { ok: false, error: code, message });
}

test('agent-msg pins every argument, authorization, and command refusal at exit 2', () => {
  const cases = [
    [['send', '--actor', 'a', '--actor', 'b'], 'AGENT_MSG_ARGUMENT_INVALID', 'Duplicate or empty flag: --actor'],
    [['send', '--'], 'AGENT_MSG_ARGUMENT_INVALID', 'Duplicate or empty flag: --'],
    [['send', '--actor'], 'AGENT_MSG_ARGUMENT_INVALID', '--actor requires a value.'],
    [['send', '--actor', 'a', '--bogus', 'x'], 'AGENT_MSG_ARGUMENT_INVALID', 'Unsupported flag(s): --bogus'],
    [['send', '--actor', '', '--to', 'b', '--body', 'hi'], 'AGENT_MSG_ARGUMENT_INVALID', '--actor is required.'],
    [['ack', '--actor', 'a', '--message-id', 'm'], 'AGENT_MSG_ARGUMENT_INVALID', '--sequence is required.'],
    [['ack', '--actor', 'a', '--message-id', 'm', '--sequence', '-1'], 'AGENT_MSG_ARGUMENT_INVALID', '--sequence must be a non-negative integer.'],
    [['read', '--actor', 'a', '--limit', '0'], 'AGENT_MSG_ARGUMENT_INVALID', '--limit is outside its allowed range.'],
    [['send', '--actor', 'a', '--body', 'hi'], 'AGENT_MSG_ARGUMENT_INVALID', 'Specify exactly one of --to or --channel.'],
    [['send', '--actor', 'a', '--to', 'b', '--channel', 'c', '--body', 'hi'], 'AGENT_MSG_ARGUMENT_INVALID', 'Specify exactly one of --to or --channel.'],
    [['send', '--actor', 'a', '--to', 'b', '--body', 'hi', '--kind', 'maybe'], 'AGENT_MSG_ARGUMENT_INVALID', '--kind is invalid.'],
    [['send', '--actor', 'a', '--to', 'b', '--body', 'refuse'], 'AGENT_MSG_SEND_REFUSED', 'The fabric refused the message.'],
    [['read', '--actor', 'owner', '--all', '--channel', 'c'], 'AGENT_MSG_ARGUMENT_INVALID', '--all and --channel are mutually exclusive.'],
    [['read', '--actor', 'a', '--all'], 'OWNER_VISIBILITY_OWNER_REQUIRED', '--all is the owner visibility projection.'],
    [['ack', '--actor', 'a', '--message-id', 'refuse', '--sequence', '1'], 'AGENT_MSG_ACK_REFUSED', 'The fabric refused the acknowledgement.'],
    [['channels', 'rename', '--actor', 'a'], 'AGENT_MSG_ARGUMENT_INVALID', 'channels requires list, create, join, or leave.'],
    [['channels', 'list', 'extra', '--actor', 'a'], 'AGENT_MSG_ARGUMENT_INVALID', 'channels requires list, create, join, or leave.'],
    [['designate', '--actor', 'a', '--agent', 'b'], 'OWNER_ACTOR_REQUIRED', 'Designation changes require --actor owner.'],
    [['invented'], 'AGENT_MSG_COMMAND_UNKNOWN', 'Unknown command: invented'],
    [['read', '--actor', 'explode'], 'AGENT_MSG_FAILED', 'stub explosion']
  ];
  for (const entry of cases) refusal(...entry);
});

test('agent-msg success paths do not use the refusal exit', () => {
  for (const values of [
    ['send', '--actor', 'a', '--to', 'b', '--body', 'hi'],
    ['send', '--actor', 'a', '--channel', 'c', '--body', 'hi'],
    ['ack', '--actor', 'a', '--message-id', 'm', '--sequence', '1'],
    ['read', '--actor', 'owner', '--all'],
    ['channels', 'create', '--actor', 'a', '--channel', 'c'],
    ['designate', '--actor', 'owner', '--agent', 'a'],
    ['watch', '--actor', 'a', '--once']
  ]) {
    const result = call(values);
    assert.equal(result.status, 0, `${values.join(' ')}: ${result.stderr}`);
  }
});

test('agent-msg enforces all delegation setting pairs before runtime preparation', () => {
  for (const taskOnly of [false, true]) {
    for (const commsEnabled of [false, true]) {
      const allowed = !taskOnly && commsEnabled;
      const settings = { values: {
        'agent.task_only_delegation': taskOnly,
        'agent.comms_enabled': commsEnabled
      }, rejected: [] };
      for (const actor of ['a', 'owner']) {
        for (const target of [['--to', 'b'], ['--channel', 'c']]) {
          const args = ['send', '--actor', actor, ...target, '--body', 'assignment'];
          const result = call(args, { settings, refuseRuntime: !allowed });
          assert.equal(result.status, allowed ? 0 : 2, result.stderr);
          if (allowed) {
            assert.equal(JSON.parse(result.stdout).accepted, true);
          } else {
            assert.equal(result.stdout, '');
            const error = JSON.parse(result.stderr);
            assert.equal(error.ok, false);
            assert.equal(error.error, commsEnabled ? 'AGENT_TASK_ONLY_DELEGATION' : 'AGENT_COMMS_DISABLED');
          }
        }
      }
    }
  }
});

test('agent-msg refuses unreadable policy values without preparing the runtime', () => {
  for (const settings of [
    { values: {}, rejected: [{ id: '*' }] },
    { values: { 'agent.comms_enabled': 'true' }, rejected: [] },
    { values: { 'agent.task_only_delegation': null }, rejected: [] }
  ]) {
    const result = call(['send', '--actor', 'a', '--to', 'b', '--body', 'hi'], { settings, refuseRuntime: true });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'AGENT_DELEGATION_POLICY_UNAVAILABLE');
  }
});

test('agent-msg retains existing inbox reads when new sends are disabled', () => {
  const result = call(['read', '--actor', 'a'], { settings: { values: {
    'agent.task_only_delegation': true, 'agent.comms_enabled': false
  }, rejected: [] } });
  assert.equal(result.status, 0, result.stderr);
});

test('agent-msg keeps the refusal exit assignment in its executable boundary', () => {
  const source = require('node:fs').readFileSync(cli, 'utf8');
  assert.match(source, /process\.exitCode = 2;/, 'refusals no longer select the documented exit status');
});
