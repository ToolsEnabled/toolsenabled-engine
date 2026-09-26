'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROL_KEY,
  ControlPlaneError,
  DEFAULT_NAMESPACE,
  OWNER_CHANNEL,
  SCHEMA_VERSION,
  createControlPlane
} = require('../../src/lib/agent-comms/control-plane');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryStore() {
  let entry = null;
  return Object.freeze({
    getMemory({ namespace, key }) {
      assert.equal(namespace, DEFAULT_NAMESPACE);
      assert.equal(key, CONTROL_KEY);
      return entry && clone(entry);
    },
    setMemory({ namespace, key, value, tags, expectedRevision }) {
      assert.equal(namespace, DEFAULT_NAMESPACE);
      assert.equal(key, CONTROL_KEY);
      assert.deepEqual(tags, ['agent-comms', 'control']);
      const revision = entry ? entry.revision : 0;
      if (revision !== expectedRevision) {
        const error = new Error('revision conflict');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      entry = { revision: revision + 1, value: clone(value) };
      return { entry: clone(entry) };
    }
  });
}

function expectCode(operation, code) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ControlPlaneError);
    assert.equal(error.code, code);
    return true;
  });
}

function instrumentedStore({ initial = null, getError = null, setBehavior = null } = {}) {
  let entry = initial && clone(initial);
  const calls = { get: 0, set: 0 };
  return {
    calls,
    getMemory() {
      calls.get += 1;
      if (getError) throw getError;
      return entry && clone(entry);
    },
    setMemory(input) {
      calls.set += 1;
      if (setBehavior) return setBehavior(input, calls.set);
      const revision = entry ? entry.revision + 1 : 1;
      entry = { revision, value: clone(input.value) };
      return { entry: clone(entry) };
    }
  };
}

test('caller and configuration refusals happen before durable writes', () => {
  const store = instrumentedStore();
  expectCode(() => createControlPlane({ store: null }), 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID');
  expectCode(() => createControlPlane({ store, maxChannels: 0 }), 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID');
  const control = createControlPlane({ store, now: () => -1 });
  expectCode(() => control.createChannel(null), 'AGENT_COMMS_CONTROL_ARGUMENT_INVALID');
  expectCode(() => control.snapshot(), 'AGENT_COMMS_CONTROL_CLOCK_INVALID');
  assert.equal(store.calls.set, 0);
});

test('read, storage, and corrupt-state refusals do not attempt writes', () => {
  const readStore = instrumentedStore({ getError: new Error('disk unavailable') });
  expectCode(() => createControlPlane({ store: readStore }).snapshot(), 'AGENT_COMMS_CONTROL_READ_FAILED');
  assert.equal(readStore.calls.set, 0);

  const invalidStore = instrumentedStore({ initial: { revision: 0, value: {} } });
  expectCode(() => createControlPlane({ store: invalidStore }).snapshot(), 'AGENT_COMMS_CONTROL_STORAGE_INVALID');
  assert.equal(invalidStore.calls.set, 0);

  const corruptStore = instrumentedStore({ initial: { revision: 1, value: {} } });
  expectCode(() => createControlPlane({ store: corruptStore }).snapshot(), 'AGENT_COMMS_CONTROL_STATE_CORRUPT');
  assert.equal(corruptStore.calls.set, 0);
});

test('channel existence, lookup, and capacity refusals preserve durable state', () => {
  const store = instrumentedStore();
  const control = createControlPlane({ store, maxChannels: 2, maxMemberships: 1, now: () => 10 });
  control.createChannel({ name: 'room', actorId: 'agent-a' });
  const baseline = store.calls.set;
  expectCode(() => control.createChannel({ name: 'room', actorId: 'agent-a' }), 'AGENT_CHANNEL_EXISTS');
  expectCode(() => control.join({ channel: 'missing', agentId: 'agent-a' }), 'AGENT_CHANNEL_UNKNOWN');
  expectCode(() => control.createChannel({ name: 'full', actorId: 'agent-a' }), 'AGENT_COMMS_CONTROL_CAPACITY');
  assert.equal(store.calls.set, baseline);

  control.join({ channel: 'room', agentId: 'agent-a' });
  const membershipBaseline = store.calls.set;
  control.leave({ channel: 'room', agentId: 'agent-a' });
  control.join({ channel: 'room', agentId: 'agent-a' });
  // Capacity is also driven through membership by a second channel facade.
  const roomyStore = instrumentedStore();
  const roomy = createControlPlane({ store: roomyStore, maxChannels: 3, maxMemberships: 1, now: () => 10 });
  roomy.createChannel({ name: 'one', actorId: 'agent-a' });
  roomy.createChannel({ name: 'two', actorId: 'agent-a' });
  roomy.join({ channel: 'one', agentId: 'agent-a' });
  const roomyBaseline = roomyStore.calls.set;
  expectCode(() => roomy.join({ channel: 'two', agentId: 'agent-b' }), 'AGENT_COMMS_CONTROL_CAPACITY');
  assert.equal(roomyStore.calls.set, roomyBaseline);
  assert.ok(store.calls.set > membershipBaseline);
});

test('write acknowledgement and exhausted-conflict refusals expose distinct codes', () => {
  const badAck = instrumentedStore({ setBehavior: () => ({ entry: null }) });
  expectCode(
    () => createControlPlane({ store: badAck, now: () => 1 }).createChannel({ name: 'room', actorId: 'agent-a' }),
    'AGENT_COMMS_CONTROL_WRITE_FAILED'
  );
  assert.equal(badAck.calls.set, 1);

  const conflicts = instrumentedStore({ setBehavior: () => {
    const error = new Error('race');
    error.code = 'MEMORY_REVISION_CONFLICT';
    throw error;
  } });
  expectCode(
    () => createControlPlane({ store: conflicts, maxWriteRetries: 2, now: () => 1 })
      .createChannel({ name: 'room', actorId: 'agent-a' }),
    'AGENT_COMMS_CONTROL_CONCURRENCY_RETRY_EXHAUSTED'
  );
  assert.equal(conflicts.calls.set, 2);
});

test('owner designation refusals are driven and no-op results do not write', () => {
  const store = instrumentedStore();
  const control = createControlPlane({ store, now: () => 20 });
  const actor = { actorKind: 'owner', actorId: 'owner' };
  expectCode(
    () => control.designate({ actor, agentId: 'owner' }),
    'OWNER_CHANNEL_DESIGNATION_INVALID'
  );
  assert.equal(store.calls.set, 0);

  control.designate({ actor, agentId: 'agent-a' });
  let baseline = store.calls.set;
  assert.deepEqual(control.designate({ actor, agentId: 'agent-a' }), {
    changed: false, active: true, agentId: 'agent-a', code: 'OWNER_CHANNEL_ALREADY_DESIGNATED'
  });
  assert.equal(store.calls.set, baseline);
  control.revoke({ actor, agentId: 'agent-a' });
  baseline = store.calls.set;
  assert.deepEqual(control.revoke({ actor, agentId: 'agent-a' }), {
    changed: false, active: false, agentId: 'agent-a', code: 'OWNER_CHANNEL_ALREADY_REVOKED'
  });
  assert.equal(store.calls.set, baseline);
});

test('channel membership controls access and survives a new facade', () => {
  const store = memoryStore();
  let time = 1_000;
  const control = createControlPlane({ store, now: () => time });

  assert.deepEqual(control.createChannel({ name: 'review-room', actorId: 'agent-b' }), {
    created: true,
    channel: {
      name: 'review-room', createdAtMs: 1_000, createdBy: 'agent-b', ownerSpecial: false, members: []
    }
  });
  expectCode(
    () => control.assertAccess({ channel: 'review-room', agentId: 'agent-a' }),
    'AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED'
  );

  time += 1;
  assert.deepEqual(control.join({ channel: 'review-room', agentId: 'agent-a' }), {
    joined: true, channel: 'review-room', agentId: 'agent-a'
  });
  assert.deepEqual(control.assertAccess({ channel: 'review-room', agentId: 'agent-a' }), {
    channel: 'review-room', agentId: 'agent-a', ownerSpecial: false, allowed: true
  });

  const restarted = createControlPlane({ store, now: () => 9_999 });
  assert.equal(restarted.snapshot().channels.find(channel => channel.name === 'review-room').members[0], 'agent-a');
  assert.equal(restarted.leave({ channel: 'review-room', agentId: 'agent-a' }).left, true);
  expectCode(
    () => restarted.assertAccess({ channel: 'review-room', agentId: 'agent-a' }),
    'AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED'
  );
});

test('only owner designation grants special-channel access and revoke removes it', () => {
  const store = memoryStore();
  let time = 2_000;
  const control = createControlPlane({ store, now: () => time });
  const owner = { actorKind: 'owner', actorId: 'owner' };

  expectCode(
    () => control.designate({ actor: { actorKind: 'agent', actorId: 'owner' }, agentId: 'agent-a' }),
    'OWNER_ACTOR_REQUIRED'
  );
  expectCode(
    () => control.assertAccess({ channel: OWNER_CHANNEL, agentId: 'agent-a' }),
    'OWNER_CHANNEL_NOT_DESIGNATED'
  );

  const designated = control.designate({ actor: owner, agentId: 'agent-a' });
  assert.equal(designated.changed, true);
  assert.equal(designated.code, 'OWNER_CHANNEL_DESIGNATED');
  assert.equal(designated.event.sequence, 1);
  assert.equal(control.isDesignated('agent-a'), true);
  assert.equal(control.assertAccess({ channel: OWNER_CHANNEL, agentId: 'agent-a' }).allowed, true);

  time += 1;
  const revoked = control.revoke({ actor: owner, agentId: 'agent-a' });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.code, 'OWNER_CHANNEL_REVOKED');
  assert.equal(revoked.event.sequence, 2);
  assert.equal(control.isDesignated('agent-a'), false);
  expectCode(
    () => control.assertAccess({ channel: OWNER_CHANNEL, agentId: 'agent-a' }),
    'OWNER_CHANNEL_NOT_DESIGNATED'
  );

  const snapshot = control.snapshot();
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(snapshot.designations.activeAgentIds, []);
  assert.deepEqual(snapshot.designations.events.map(event => event.action), ['DESIGNATED', 'REVOKED']);
  assert.deepEqual(snapshot.channels.find(channel => channel.name === OWNER_CHANNEL).members, []);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.designations.events[0]), true);
});
