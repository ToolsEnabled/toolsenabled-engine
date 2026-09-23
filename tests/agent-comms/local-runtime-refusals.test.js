'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createLocalAgentCommsRuntime,
  readDeclaredAgentIds,
  registeredPresenceAgentIds
} = require('../../src/lib/agent-comms/local-runtime');

function expectRefusal(code, action) {
  assert.throws(action, error => {
    assert.equal(error.name, 'LocalAgentCommsRuntimeError');
    assert.equal(error.code, code);
    return true;
  });
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runtime-refusals-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function emptyStore(calls) {
  return Object.freeze({
    getMemory() {
      calls.reads += 1;
      return null;
    },
    setMemory() {
      calls.writes += 1;
      throw new Error('a refusal test must not write durable state');
    }
  });
}

function validRuntimeOptions(t) {
  const directory = temporaryDirectory(t);
  const orgFile = path.join(directory, 'agent-org.json');
  fs.writeFileSync(orgFile, '{"agents":[]}\n');
  return {
    directory,
    orgFile,
    presenceFile: path.join(directory, 'absent-presence.json'),
    mailboxDir: path.join(directory, 'mailboxes'),
    brokerFile: path.join(directory, 'broker.json'),
    machineId: 'test-machine'
  };
}

test('an unreadable declared-agent directory refuses without changing its directory', t => {
  const directory = temporaryDirectory(t);
  const missing = path.join(directory, 'missing-agent-org.json');
  const before = fs.readdirSync(directory);

  expectRefusal('AGENT_COMMS_AGENT_DIRECTORY_UNAVAILABLE', () => readDeclaredAgentIds(missing));

  assert.deepEqual(fs.readdirSync(directory), before, 'reading a missing directory must not create fallback state');
});

test('a malformed declared-agent document refuses without changing the document', t => {
  const directory = temporaryDirectory(t);
  const orgFile = path.join(directory, 'agent-org.json');
  fs.writeFileSync(orgFile, '{"notAgents":[]}\n');
  const before = fs.readFileSync(orgFile);

  expectRefusal('AGENT_COMMS_AGENT_DIRECTORY_INVALID', () => readDeclaredAgentIds(orgFile));

  assert.deepEqual(fs.readFileSync(orgFile), before, 'invalid organization data must not be repaired or overwritten');
  assert.deepEqual(fs.readdirSync(directory), ['agent-org.json']);
});

test('an unavailable presence registry refuses and performs no write', () => {
  const calls = { reads: 0, writes: 0 };
  const refusal = Object.assign(new Error('registry device unavailable'), { code: 'EIO' });
  const fsImpl = new Proxy({}, {
    get(_target, property) {
      if (property === 'readFileSync') return () => { calls.reads += 1; throw refusal; };
      return () => { calls.writes += 1; throw new Error(`unexpected filesystem operation: ${String(property)}`); };
    }
  });

  expectRefusal('AGENT_COMMS_PRESENCE_UNAVAILABLE', () => {
    registeredPresenceAgentIds({ presenceFile: '/injected/presence.json', fsImpl });
  });

  assert.equal(calls.reads, 1, 'the injected failing dependency was actually driven');
  assert.equal(calls.writes, 0, 'presence refusal must not attempt recovery writes');
});

test('invalid runtime configuration refuses before reading, writing, or spawning', () => {
  const calls = { reads: 0, writes: 0 };
  const store = emptyStore(calls);

  expectRefusal('AGENT_COMMS_RUNTIME_CONFIGURATION_INVALID', () => {
    createLocalAgentCommsRuntime({ extraAgentIds: 'not-an-array', store, now: Date.now });
  });

  assert.deepEqual(calls, { reads: 0, writes: 0 }, 'configuration validation precedes all runtime collaborators');
});

test('an unknown agent identity refuses without writing or creating files', t => {
  const fixture = validRuntimeOptions(t);
  const calls = { reads: 0, writes: 0 };
  const runtime = createLocalAgentCommsRuntime({ ...fixture, store: emptyStore(calls) });
  const before = fs.readdirSync(fixture.directory);

  expectRefusal('FABRIC_AGENT_UNKNOWN', () => runtime.identity('not-configured'));

  assert.equal(calls.writes, 0, 'identity lookup refusal must not mutate durable state');
  assert.deepEqual(fs.readdirSync(fixture.directory), before, 'identity lookup must not create broker or mailbox files');
});
