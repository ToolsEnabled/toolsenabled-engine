'use strict';

// Home-node contract tests. Pure and offline: the delivery transport is
// represented only by explicit unreachable/reachable observations and acks.

const assert = require('node:assert/strict');
const homeNode = require('../../src/lib/agent-comms/home-node');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const throwsCode = (fn, code, label) => {
  assert.throws(fn, error => error && error.code === code, `${label}: expected ${code}`);
};
const refusesWithoutChanging = (fn, code, input, label) => {
  const before = JSON.stringify(input);
  let returned = false;
  assert.throws(
    () => { fn(); returned = true; },
    error => error instanceof homeNode.HomeNodeError && error.code === code,
    `${label}: expected ${code}`
  );
  assert.equal(returned, false, `${label}: refusal must not return a result`);
  assert.equal(JSON.stringify(input), before, `${label}: refusal must not change caller state`);
};

const HOME_IDENTITY = { nodeId: 'desktop-home' };
const PEER_IDENTITY = { nodeId: 'travel-laptop' };
const baseConfig = () => ({
  schemaVersion: 1,
  nodes: [
    { nodeId: 'desktop-home', isHome: true, brokerEndpoint: 'wss://home.example.test/agent-comms' },
    { nodeId: 'travel-laptop', isHome: false }
  ]
});

check('exactly one declared home is accepted and resolves as HOME', () => {
  const resolved = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: HOME_IDENTITY });
  assert.equal(resolved.role, 'HOME');
  assert.equal(resolved.homeNode.nodeId, 'desktop-home');
  assert.equal(resolved.automaticFailover, false);
});

check('zero homes is a distinct actionable configuration error', () => {
  const config = baseConfig();
  config.nodes[0].isHome = false;
  throwsCode(() => homeNode.normalizeHomeNodeConfiguration(config), 'HOME_NODE_ZERO_HOMES', 'zero homes');
  assert.throws(
    () => homeNode.normalizeHomeNodeConfiguration(config),
    /Set nodes\[\]\.isHome:true on exactly one declared node/,
    'zero-home message tells the user what to set'
  );
});

check('two homes is a distinct actionable configuration error', () => {
  const config = baseConfig();
  config.nodes[1] = {
    nodeId: 'travel-laptop',
    isHome: true,
    brokerEndpoint: 'wss://laptop.example.test/agent-comms'
  };
  throwsCode(() => homeNode.normalizeHomeNodeConfiguration(config), 'HOME_NODE_MULTIPLE_HOMES', 'two homes');
  assert.throws(
    () => homeNode.normalizeHomeNodeConfiguration(config),
    /Set nodes\[\]\.isHome:true on only one node/,
    'two-home message tells the user what to change'
  );
});

check('a peer resolves its configured home and location', () => {
  const resolved = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  assert.equal(resolved.role, 'PEER');
  assert.equal(resolved.homeNode.nodeId, 'desktop-home');
  assert.equal(resolved.homeNode.brokerEndpoint, 'wss://home.example.test/agent-comms');
});

check('successful role resolution reports the configured contract code', () => {
  const home = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: HOME_IDENTITY });
  const peer = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  assert.equal(home.code, 'HOME_NODE_CONFIGURED');
  assert.equal(peer.code, 'HOME_NODE_CONFIGURED');
});

check('configuration shape, version, duplicate, and endpoint refusals are driven', () => {
  const malformed = { schemaVersion: 1, nodes: 'not-an-array' };
  refusesWithoutChanging(
    () => homeNode.normalizeHomeNodeConfiguration(malformed),
    'HOME_NODE_CONFIG_INVALID', malformed, 'malformed nodes'
  );

  const wrongVersion = baseConfig();
  wrongVersion.schemaVersion = 2;
  refusesWithoutChanging(
    () => homeNode.normalizeHomeNodeConfiguration(wrongVersion),
    'HOME_NODE_CONFIG_VERSION_INVALID', wrongVersion, 'wrong schema version'
  );

  const duplicate = baseConfig();
  duplicate.nodes[1].nodeId = duplicate.nodes[0].nodeId;
  refusesWithoutChanging(
    () => homeNode.normalizeHomeNodeConfiguration(duplicate),
    'HOME_NODE_DUPLICATE_NODE', duplicate, 'duplicate node identity'
  );

  const insecureEndpoint = baseConfig();
  insecureEndpoint.nodes[0].brokerEndpoint = 'http://home.example.test/agent-comms';
  refusesWithoutChanging(
    () => homeNode.normalizeHomeNodeConfiguration(insecureEndpoint),
    'HOME_NODE_ENDPOINT_INVALID', insecureEndpoint, 'insecure broker endpoint'
  );
});

check('UNCONFIGURED never silently defaults to HOME', () => {
  const missing = homeNode.resolveHomeNodeRole({ identity: PEER_IDENTITY });
  assert.equal(missing.role, 'UNCONFIGURED');
  assert.equal(missing.state, 'UNCONFIGURED');
  assert.equal(missing.code, 'HOME_NODE_CONFIGURATION_MISSING');
  assert.match(missing.message, /Set agentComms\.homeNode\.nodes/);

  const absent = homeNode.resolveHomeNodeRole({
    configuration: baseConfig(),
    identity: { nodeId: 'new-laptop' }
  });
  assert.equal(absent.role, 'UNCONFIGURED');
  assert.equal(absent.code, 'HOME_NODE_NOT_DECLARED');
  assert.equal(absent.homeNode.nodeId, 'desktop-home');
});

check('home unreachable becomes visibly DEGRADED and retains queued work locally', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  let state = homeNode.createPeerDeliveryState(resolution);
  state = homeNode.enterHomeUnreachable(state);
  state = homeNode.queueLocally(state, { messageId: 'm-1' });
  assert.equal(state.role, 'PEER');
  assert.equal(state.deliveryState, 'DEGRADED');
  assert.equal(state.visibleStatus.state, 'DEGRADED');
  assert.equal(state.visibleStatus.code, 'HOME_NODE_UNREACHABLE');
  assert.equal(state.visibleStatus.queuedCount, 1);
  assert.deepEqual(state.localQueue.map(item => item.sequence), [1]);
  assert.match(state.visibleStatus.message, /retained locally/);
});

check('peer state starts with unconfirmed reachability and no queued write', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const state = homeNode.createPeerDeliveryState(resolution);
  assert.equal(state.visibleStatus.code, 'HOME_NODE_REACHABILITY_UNCONFIRMED');
  assert.equal(state.localQueue.length, 0);
  assert.equal(state.nextSequence, 1);
});

check('only peers can create peer delivery state', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: HOME_IDENTITY });
  refusesWithoutChanging(
    () => homeNode.createPeerDeliveryState(resolution),
    'HOME_NODE_PEER_REQUIRED', resolution, 'home queue creation'
  );
});

check('invalid restored peer state is refused without changing the record', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const invalid = { ...homeNode.createPeerDeliveryState(resolution), automaticFailover: true };
  refusesWithoutChanging(
    () => homeNode.normalizePeerDeliveryState(invalid),
    'HOME_NODE_PEER_STATE_INVALID', invalid, 'promotion-enabled peer state'
  );
});

check('healthy peers cannot queue locally', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const healthy = homeNode.beginReconciliation(homeNode.createPeerDeliveryState(resolution));
  refusesWithoutChanging(
    () => homeNode.queueLocally(healthy, { messageId: 'must-not-write' }),
    'HOME_NODE_LOCAL_QUEUE_NOT_ALLOWED', healthy, 'healthy local queue'
  );
  assert.equal(healthy.localQueue.length, 0);
  assert.equal(healthy.nextSequence, 1);
});

check('non-JSON queue payload is refused without appending an item', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const degraded = homeNode.createPeerDeliveryState(resolution);
  const circular = {};
  circular.self = circular;
  refusesWithoutChanging(
    () => homeNode.queueLocally(degraded, circular),
    'HOME_NODE_QUEUE_PAYLOAD_INVALID', degraded, 'circular queue payload'
  );
  assert.equal(degraded.localQueue.length, 0);
  assert.equal(degraded.nextSequence, 1);
});

check('a peer never promotes itself when its configured home is unavailable', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const degraded = homeNode.enterHomeUnreachable(homeNode.createPeerDeliveryState(resolution));
  assert.equal(degraded.role, 'PEER');
  assert.equal(degraded.homeNode.nodeId, 'desktop-home');
  assert.equal(degraded.automaticFailover, false);
  assert.match(homeNode.NO_FAILOVER_RATIONALE, /two brokers and split history/);
});

check('reconciliation after the home returns exposes and acknowledges work in original order', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  let state = homeNode.enterHomeUnreachable(homeNode.createPeerDeliveryState(resolution));
  state = homeNode.queueLocally(state, { messageId: 'first' });
  state = homeNode.queueLocally(state, { messageId: 'second' });
  state = homeNode.queueLocally(state, { messageId: 'third' });
  state = homeNode.beginReconciliation(state);

  assert.equal(state.deliveryState, 'RECONCILING');
  assert.equal(state.visibleStatus.code, 'HOME_NODE_RECONCILING');
  assert.deepEqual(homeNode.nextReconciliationItem(state), {
    action: 'DELIVER_TO_CONFIGURED_HOME',
    homeNode: { nodeId: 'desktop-home', isHome: true, brokerEndpoint: 'wss://home.example.test/agent-comms' },
    sequence: 1,
    payload: { messageId: 'first' }
  });
  throwsCode(() => homeNode.acknowledgeReconciled(state, 2), 'HOME_NODE_RECONCILIATION_OUT_OF_ORDER', 'out-of-order ack');

  state = homeNode.acknowledgeReconciled(state, 1);
  assert.equal(homeNode.nextReconciliationItem(state).sequence, 2);
  state = homeNode.acknowledgeReconciled(state, 2);
  assert.equal(homeNode.nextReconciliationItem(state).sequence, 3);
  state = homeNode.acknowledgeReconciled(state, 3);
  assert.equal(state.deliveryState, 'HEALTHY');
  assert.equal(state.visibleStatus.code, 'HOME_NODE_REACHABLE');
  assert.equal(state.localQueue.length, 0);
  assert.equal(homeNode.nextReconciliationItem(state), null);
});

check('acknowledgement is refused before reconciliation is active', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const degraded = homeNode.queueLocally(homeNode.createPeerDeliveryState(resolution), { messageId: 'held' });
  refusesWithoutChanging(
    () => homeNode.acknowledgeReconciled(degraded, 1),
    'HOME_NODE_RECONCILIATION_NOT_ACTIVE', degraded, 'inactive reconciliation ack'
  );
  assert.equal(degraded.localQueue.length, 1);
});

check('empty reconciling records cannot acknowledge phantom work', () => {
  const resolution = homeNode.resolveHomeNodeRole({ configuration: baseConfig(), identity: PEER_IDENTITY });
  const healthy = homeNode.beginReconciliation(homeNode.createPeerDeliveryState(resolution));
  // Restored records may legitimately say RECONCILING before normalization;
  // drive that public restore path rather than calling an internal helper.
  const emptyReconciling = { ...healthy, deliveryState: 'RECONCILING' };
  refusesWithoutChanging(
    () => homeNode.acknowledgeReconciled(emptyReconciling, 1),
    'HOME_NODE_RECONCILIATION_EMPTY', emptyReconciling, 'empty reconciliation ack'
  );
  assert.equal(emptyReconciling.localQueue.length, 0);
});

check('identity validation rejects malformed and address-dependent identity input', () => {
  throwsCode(
    () => homeNode.normalizeNodeIdentity({ nodeId: '203.0.113.1' }),
    'HOME_NODE_IDENTITY_INVALID',
    'IP-address identity'
  );
  throwsCode(
    () => homeNode.normalizeNodeIdentity({ nodeId: 'desktop-home', address: '203.0.113.1' }),
    'HOME_NODE_IDENTITY_INVALID',
    'address field'
  );
  throwsCode(
    () => homeNode.normalizeNodeIdentity({ nodeId: 'Home Node' }),
    'HOME_NODE_IDENTITY_INVALID',
    'malformed identity'
  );
});

console.log(`home-node tests passed (${checks} checks).`);
