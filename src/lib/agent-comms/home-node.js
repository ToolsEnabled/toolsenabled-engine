'use strict';

// Home-node configuration and local peer-degradation state.
//
// This module is deliberately a pure contract. It neither opens a listener nor
// attempts a connection: a delivery adapter supplies reachability observations
// and home acknowledgements. That separation prevents a peer from "helpfully"
// promoting itself when the configured home is asleep.

const CONFIGURATION_VERSION = 1;
const MAX_NODES = 128;
const MAX_QUEUE_ITEMS = 10_000;
const MAX_QUEUE_PAYLOAD_BYTES = 64 * 1024;
const NODE_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const DELIVERY_STATES = Object.freeze(['DEGRADED', 'RECONCILING', 'HEALTHY']);

const SETTINGS_SURFACE = Object.freeze([
  Object.freeze({
    key: 'agentComms.homeNode.schemaVersion',
    meaning: 'Version of this home-node configuration contract.',
    validation: 'Required and must equal 1; set it to 1 for this contract.'
  }),
  Object.freeze({
    key: 'agentComms.homeNode.nodes',
    meaning: 'Every declared fabric node and whether it owns the home role.',
    validation: 'Required array of 1-128 unique node entries; exactly one entry must set isHome to true.'
  }),
  Object.freeze({
    key: 'agentComms.homeNode.nodes[].nodeId',
    meaning: 'Stable, user-assigned node identity. It identifies a node, not its current network address.',
    validation: 'Required lowercase identifier, 3-64 characters, beginning with a letter and using only letters, digits, hyphens, or underscores; IP addresses and URLs are invalid.'
  }),
  Object.freeze({
    key: 'agentComms.homeNode.nodes[].isHome',
    meaning: 'Explicit declaration that this node hosts the broker.',
    validation: 'Required boolean. Set true on exactly one node and false on every other node.'
  }),
  Object.freeze({
    key: 'agentComms.homeNode.nodes[].brokerEndpoint',
    meaning: 'Credential-free HTTPS or WSS location peers use to reach the one declared home node.',
    validation: 'Required only for the isHome:true entry; must be an https:// or wss:// URL with no username, password, query, or fragment. Do not set it on peer entries.'
  })
]);

const NO_FAILOVER_RATIONALE = 'Automatic failover and leader election are deliberately unsupported. A peer that promotes itself while the configured home is merely asleep can create two brokers and split history. Peers therefore remain PEERs, expose DEGRADED state, retain work locally, and reconcile only with the configured home.';

const MIGRATION_PROCEDURE = Object.freeze([
  'Schedule a maintenance window and keep the current home broker as the only active broker until its durable history and accepted sequence are captured.',
  'Quiesce ingress to the current home: peers retain new work locally in DEGRADED state rather than sending to a second broker.',
  'Copy the current home broker history, queue, and ordering metadata to the new node using the broker/history layer, then verify the copy before changing any role declaration.',
  'Update the shared home-node configuration atomically: set isHome:false on the former home, set isHome:true plus the new brokerEndpoint on the new node, and validate that exactly one home remains.',
  'Start the new home broker from the verified transferred history. Do not start it against an empty or separately initialized history.',
  'Point peers at the validated new configuration, mark the configured home reachable, and acknowledge their retained local queue strictly from its oldest sequence forward.',
  'After reconciliation and history checks succeed, retire the old home broker without deleting its verified source history until the migration is accepted.'
]);

class HomeNodeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HomeNodeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new HomeNodeError(code, message, details);
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertExactKeys(value, expected, code, message) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, message, { expected: wanted, actual });
  }
}

/**
 * Normalize the injected stable identity of the process's node. No hostname,
 * address, MAC, or other discovery mechanism is consulted here.
 */
function normalizeNodeIdentity(input) {
  if (!plain(input)) {
    fail('HOME_NODE_IDENTITY_INVALID', 'Set this node identity to an object containing only nodeId; do not use an IP address or URL as identity.');
  }
  assertExactKeys(
    input,
    ['nodeId'],
    'HOME_NODE_IDENTITY_INVALID',
    'Set this node identity to exactly { nodeId: "stable-node-name" }; address-derived fields are not allowed.'
  );
  if (typeof input.nodeId !== 'string' || !NODE_ID.test(input.nodeId)) {
    fail(
      'HOME_NODE_IDENTITY_INVALID',
      'Set nodeId to a stable lowercase name (3-64 characters, starting with a letter; letters, digits, hyphens, and underscores only). Do not use an IP address, hostname, or URL.',
      { field: 'nodeId' }
    );
  }
  return Object.freeze({ nodeId: input.nodeId });
}

const validateNodeIdentity = normalizeNodeIdentity;

function normalizeBrokerEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('HOME_NODE_ENDPOINT_INVALID', 'Set brokerEndpoint on the one home node to a credential-free https:// or wss:// URL.');
  }
  let parsed;
  try { parsed = new URL(value); }
  catch {
    fail('HOME_NODE_ENDPOINT_INVALID', 'Set brokerEndpoint on the one home node to a valid credential-free https:// or wss:// URL.');
  }
  if (!['https:', 'wss:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
    fail('HOME_NODE_ENDPOINT_INVALID', 'Set brokerEndpoint on the one home node to an https:// or wss:// URL with no username, password, query, or fragment. Put credentials in the provider credential store, never this setting.');
  }
  return value;
}

function normalizeConfiguredNode(input) {
  if (!plain(input)) {
    fail('HOME_NODE_CONFIG_INVALID', 'Set every agentComms.homeNode.nodes entry to an object with nodeId and isHome.');
  }
  if (typeof input.isHome !== 'boolean') {
    fail('HOME_NODE_CONFIG_INVALID', 'Set nodes[].isHome explicitly to true or false; it must never be inferred.');
  }
  const expected = input.isHome
    ? ['nodeId', 'isHome', 'brokerEndpoint']
    : ['nodeId', 'isHome'];
  assertExactKeys(
    input,
    expected,
    'HOME_NODE_CONFIG_INVALID',
    input.isHome
      ? 'Set the home entry to exactly nodeId, isHome, and brokerEndpoint. Move connection credentials out of this setting.'
      : 'Set each peer entry to exactly nodeId and isHome:false. Only the one home entry carries brokerEndpoint.'
  );
  const identity = normalizeNodeIdentity({ nodeId: input.nodeId });
  const node = { nodeId: identity.nodeId, isHome: input.isHome };
  if (input.isHome) node.brokerEndpoint = normalizeBrokerEndpoint(input.brokerEndpoint);
  return Object.freeze(node);
}

/**
 * Validate the complete declarative fabric. It refuses both under- and
 * over-declared homes rather than choosing a winner by entry order.
 */
function normalizeHomeNodeConfiguration(input) {
  if (!plain(input)) {
    fail('HOME_NODE_CONFIG_INVALID', 'Set agentComms.homeNode to { schemaVersion: 1, nodes: [...] }; it cannot be inferred from this machine.');
  }
  assertExactKeys(
    input,
    ['schemaVersion', 'nodes'],
    'HOME_NODE_CONFIG_INVALID',
    'Set agentComms.homeNode to exactly schemaVersion and nodes. Put broker routing only in the one home node entry.'
  );
  if (input.schemaVersion !== CONFIGURATION_VERSION) {
    fail('HOME_NODE_CONFIG_VERSION_INVALID', 'Set agentComms.homeNode.schemaVersion to 1 for this version of the home-node contract.');
  }
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_NODES) {
    fail('HOME_NODE_CONFIG_INVALID', `Set agentComms.homeNode.nodes to an array containing 1-${MAX_NODES} declared nodes.`);
  }
  // Count explicit role declarations before rejecting stale endpoint fields on
  // a former home. That makes the two cardinality failures deterministic and
  // actionable during a configuration edit instead of masking them behind a
  // secondary field-shape error.
  for (const entry of input.nodes) {
    if (!plain(entry) || typeof entry.isHome !== 'boolean') {
      fail('HOME_NODE_CONFIG_INVALID', 'Set every agentComms.homeNode.nodes entry to an object with nodeId and explicit isHome:true or isHome:false.');
    }
  }
  const declaredHomes = input.nodes.filter(node => node.isHome);
  if (declaredHomes.length === 0) {
    fail('HOME_NODE_ZERO_HOMES', 'Set nodes[].isHome:true on exactly one declared node and add its brokerEndpoint. No home node is configured.');
  }
  if (declaredHomes.length > 1) {
    fail(
      'HOME_NODE_MULTIPLE_HOMES',
      `Set nodes[].isHome:true on only one node and set it false on the others. Multiple home nodes are configured: ${declaredHomes.map(node => String(node.nodeId ?? '<missing-nodeId>')).join(', ')}.`,
      { nodeIds: declaredHomes.map(node => String(node.nodeId ?? '<missing-nodeId>')) }
    );
  }
  const nodes = input.nodes.map(normalizeConfiguredNode);
  const ids = nodes.map(node => node.nodeId);
  if (new Set(ids).size !== ids.length) {
    fail('HOME_NODE_DUPLICATE_NODE', 'Give each agentComms.homeNode.nodes entry a unique nodeId; duplicate identities make the home role ambiguous.');
  }
  const homes = nodes.filter(node => node.isHome);
  return deepFreeze({
    schemaVersion: CONFIGURATION_VERSION,
    nodes,
    homeNode: homes[0]
  });
}

const validateHomeNodeConfiguration = normalizeHomeNodeConfiguration;
const normalizeHomeNodeConfig = normalizeHomeNodeConfiguration;

function unconfigured(identity, code, message, homeNode = null) {
  return deepFreeze({
    schemaVersion: CONFIGURATION_VERSION,
    role: 'UNCONFIGURED',
    state: 'UNCONFIGURED',
    code,
    nodeId: identity.nodeId,
    homeNode,
    message,
    automaticFailover: false
  });
}

/**
 * Resolve only from the declared configuration and injected stable identity.
 * A missing or non-member node is conspicuously UNCONFIGURED, never HOME by
 * default. Structural configuration mistakes retain their distinct errors.
 */
function resolveHomeNodeRole({ configuration, config, identity } = {}) {
  const localIdentity = normalizeNodeIdentity(identity);
  const supplied = configuration === undefined ? config : configuration;
  if (supplied === undefined || supplied === null) {
    return unconfigured(
      localIdentity,
      'HOME_NODE_CONFIGURATION_MISSING',
      'Home node is not configured. Set agentComms.homeNode.nodes, add this nodeId, set exactly one nodes[].isHome:true, and set that home node\'s brokerEndpoint.'
    );
  }
  const normalized = normalizeHomeNodeConfiguration(supplied);
  const local = normalized.nodes.find(node => node.nodeId === localIdentity.nodeId);
  if (!local) {
    return unconfigured(
      localIdentity,
      'HOME_NODE_NOT_DECLARED',
      `This node is not declared in agentComms.homeNode.nodes. Add { nodeId: "${localIdentity.nodeId}", isHome: false } to make it a peer, or make it the one isHome:true entry after the migration procedure.`,
      normalized.homeNode
    );
  }
  if (local.isHome) {
    return deepFreeze({
      schemaVersion: CONFIGURATION_VERSION,
      role: 'HOME',
      state: 'HOME',
      code: 'HOME_NODE_CONFIGURED',
      nodeId: localIdentity.nodeId,
      homeNode: normalized.homeNode,
      message: `This node is the configured home node. It hosts the broker at ${normalized.homeNode.brokerEndpoint}.`,
      automaticFailover: false
    });
  }
  return deepFreeze({
    schemaVersion: CONFIGURATION_VERSION,
    role: 'PEER',
    state: 'PEER',
    code: 'HOME_NODE_CONFIGURED',
    nodeId: localIdentity.nodeId,
    homeNode: normalized.homeNode,
    message: `This node is a peer. Its configured home node is "${normalized.homeNode.nodeId}" at ${normalized.homeNode.brokerEndpoint}.`,
    automaticFailover: false
  });
}

const resolveRole = resolveHomeNodeRole;
const resolveHomeRole = resolveHomeNodeRole;

function cloneQueuePayload(value) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch {
    fail('HOME_NODE_QUEUE_PAYLOAD_INVALID', 'Queue payload must be finite JSON data so it can be retained and reconciled without loss.');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_QUEUE_PAYLOAD_BYTES) {
    fail('HOME_NODE_QUEUE_PAYLOAD_INVALID', `Queue payload must be finite JSON data no larger than ${MAX_QUEUE_PAYLOAD_BYTES} bytes.`);
  }
  let copied;
  try { copied = JSON.parse(encoded); }
  catch {
    fail('HOME_NODE_QUEUE_PAYLOAD_INVALID', 'Queue payload must be finite JSON data so it can be retained and reconciled without loss.');
  }
  return deepFreeze(copied);
}

function assertPeerResolution(resolution) {
  if (!plain(resolution) || resolution.role !== 'PEER') {
    fail('HOME_NODE_PEER_REQUIRED', 'Create local queue state only from a resolved PEER role; HOME and UNCONFIGURED nodes must not queue as peers.');
  }
  const identity = normalizeNodeIdentity({ nodeId: resolution.nodeId });
  if (!plain(resolution.homeNode)) {
    fail('HOME_NODE_PEER_REQUIRED', 'Resolve a configured home node before creating peer queue state.');
  }
  const homeNode = normalizeConfiguredNode({
    nodeId: resolution.homeNode.nodeId,
    isHome: true,
    brokerEndpoint: resolution.homeNode.brokerEndpoint
  });
  return { nodeId: identity.nodeId, homeNode };
}

function visibleState(deliveryState, homeNode, queueLength, degradedReason = null) {
  if (deliveryState === 'HEALTHY') {
    return Object.freeze({
      state: 'HEALTHY',
      code: 'HOME_NODE_REACHABLE',
      queuedCount: 0,
      message: `Configured home node "${homeNode.nodeId}" is reachable. Delivery is active.`
    });
  }
  if (deliveryState === 'RECONCILING') {
    return Object.freeze({
      state: 'RECONCILING',
      code: 'HOME_NODE_RECONCILING',
      queuedCount: queueLength,
      message: `Configured home node "${homeNode.nodeId}" is reachable. ${queueLength} locally queued item(s) will reconcile in sequence order.`
    });
  }
  const code = degradedReason === 'UNREACHABLE'
    ? 'HOME_NODE_UNREACHABLE'
    : 'HOME_NODE_REACHABILITY_UNCONFIRMED';
  const noun = degradedReason === 'UNREACHABLE' ? 'is unreachable' : 'has unconfirmed reachability';
  return Object.freeze({
    state: 'DEGRADED',
    code,
    queuedCount: queueLength,
    message: `Configured home node "${homeNode.nodeId}" ${noun}. ${queueLength} item(s) are retained locally; nothing is dropped and no peer will promote itself.`
  });
}

function makePeerDeliveryState({ nodeId, homeNode, deliveryState, queue, nextSequence, degradedReason = null }) {
  return deepFreeze({
    schemaVersion: CONFIGURATION_VERSION,
    role: 'PEER',
    nodeId,
    homeNode,
    deliveryState,
    degradedReason: deliveryState === 'DEGRADED' ? degradedReason : null,
    localQueue: queue,
    nextSequence,
    automaticFailover: false,
    visibleStatus: visibleState(deliveryState, homeNode, queue.length, degradedReason)
  });
}

/**
 * Peer state starts fail-closed. A delivery adapter must positively report the
 * home reachable before work is treated as actively deliverable.
 */
function createPeerDeliveryState(resolution) {
  const peer = assertPeerResolution(resolution);
  return makePeerDeliveryState({
    ...peer,
    deliveryState: 'DEGRADED',
    degradedReason: 'UNCONFIRMED',
    queue: Object.freeze([]),
    nextSequence: 1
  });
}

const createPeerQueue = createPeerDeliveryState;

function normalizePeerDeliveryState(input) {
  if (!plain(input) || input.role !== 'PEER') {
    fail('HOME_NODE_PEER_STATE_INVALID', 'Restore peer queue state only from a PEER state record.');
  }
  const expected = [
    'schemaVersion', 'role', 'nodeId', 'homeNode', 'deliveryState',
    'degradedReason', 'localQueue', 'nextSequence', 'automaticFailover', 'visibleStatus'
  ];
  assertExactKeys(
    input,
    expected,
    'HOME_NODE_PEER_STATE_INVALID',
    'Restore peer queue state with the complete home-node state record; do not add a promotion or alternate-home field.'
  );
  if (input.schemaVersion !== CONFIGURATION_VERSION
      || !DELIVERY_STATES.includes(input.deliveryState)
      || input.automaticFailover !== false) {
    fail('HOME_NODE_PEER_STATE_INVALID', 'Restore a compatible peer state with automaticFailover:false. Peer promotion is not supported.');
  }
  const nodeId = normalizeNodeIdentity({ nodeId: input.nodeId }).nodeId;
  const homeNode = normalizeConfiguredNode({
    nodeId: input.homeNode?.nodeId,
    isHome: true,
    brokerEndpoint: input.homeNode?.brokerEndpoint
  });
  if (!Array.isArray(input.localQueue) || input.localQueue.length > MAX_QUEUE_ITEMS) {
    fail('HOME_NODE_PEER_STATE_INVALID', `Restore localQueue as an ordered array of at most ${MAX_QUEUE_ITEMS} items.`);
  }
  const queue = input.localQueue.map((entry, index) => {
    if (!plain(entry)) {
      fail('HOME_NODE_PEER_STATE_INVALID', 'Restore every localQueue item as { sequence, payload }.');
    }
    assertExactKeys(entry, ['sequence', 'payload'], 'HOME_NODE_PEER_STATE_INVALID', 'Restore every localQueue item as exactly sequence and payload.');
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
      fail('HOME_NODE_PEER_STATE_INVALID', 'Restore every localQueue sequence as a positive safe integer.');
    }
    if (index > 0 && entry.sequence <= input.localQueue[index - 1].sequence) {
      fail('HOME_NODE_PEER_STATE_INVALID', 'Restore localQueue in strictly increasing sequence order; do not reorder queued work.');
    }
    return Object.freeze({ sequence: entry.sequence, payload: cloneQueuePayload(entry.payload) });
  });
  if (!Number.isSafeInteger(input.nextSequence) || input.nextSequence < 1
      || (queue.length > 0 && input.nextSequence <= queue[queue.length - 1].sequence)) {
    fail('HOME_NODE_PEER_STATE_INVALID', 'Set nextSequence to a positive number greater than every retained localQueue sequence.');
  }
  if (input.deliveryState === 'HEALTHY' && queue.length !== 0) {
    fail('HOME_NODE_PEER_STATE_INVALID', 'Use RECONCILING, not HEALTHY, while locally queued work remains.');
  }
  const degradedReason = input.deliveryState === 'DEGRADED'
    ? (input.degradedReason === 'UNREACHABLE' ? 'UNREACHABLE' : 'UNCONFIRMED')
    : null;
  return makePeerDeliveryState({
    nodeId,
    homeNode,
    deliveryState: input.deliveryState,
    degradedReason,
    queue: Object.freeze(queue),
    nextSequence: input.nextSequence
  });
}

function enterHomeUnreachable(state) {
  const peer = normalizePeerDeliveryState(state);
  return makePeerDeliveryState({
    nodeId: peer.nodeId,
    homeNode: peer.homeNode,
    deliveryState: 'DEGRADED',
    degradedReason: 'UNREACHABLE',
    queue: peer.localQueue,
    nextSequence: peer.nextSequence
  });
}

const markHomeUnreachable = enterHomeUnreachable;

/** Retain an opaque payload locally, in monotonically increasing order. */
function queueLocally(state, payload) {
  const peer = normalizePeerDeliveryState(state);
  if (!['DEGRADED', 'RECONCILING'].includes(peer.deliveryState)) {
    fail('HOME_NODE_LOCAL_QUEUE_NOT_ALLOWED', 'Local queueing is for a degraded or reconciling peer. Have the delivery layer report the home unreachable before retaining work locally.');
  }
  if (peer.localQueue.length >= MAX_QUEUE_ITEMS) {
    fail('HOME_NODE_LOCAL_QUEUE_FULL', `Local queue has reached ${MAX_QUEUE_ITEMS} retained items. Keep the visible DEGRADED state and free verified capacity before accepting more work.`);
  }
  const queued = Object.freeze({ sequence: peer.nextSequence, payload: cloneQueuePayload(payload) });
  return makePeerDeliveryState({
    nodeId: peer.nodeId,
    homeNode: peer.homeNode,
    deliveryState: peer.deliveryState,
    degradedReason: peer.degradedReason,
    queue: Object.freeze([...peer.localQueue, queued]),
    nextSequence: peer.nextSequence + 1
  });
}

const enqueueLocally = queueLocally;

/**
 * Called only after an injected delivery adapter has observed the configured
 * home again. This function plans reconciliation; it performs no I/O.
 */
function beginReconciliation(state) {
  const peer = normalizePeerDeliveryState(state);
  return makePeerDeliveryState({
    nodeId: peer.nodeId,
    homeNode: peer.homeNode,
    deliveryState: peer.localQueue.length === 0 ? 'HEALTHY' : 'RECONCILING',
    queue: peer.localQueue,
    nextSequence: peer.nextSequence
  });
}

const markHomeReachable = beginReconciliation;

/** Return the single oldest retained item as a declarative delivery action. */
function nextReconciliationItem(state) {
  const peer = normalizePeerDeliveryState(state);
  if (peer.deliveryState !== 'RECONCILING' || peer.localQueue.length === 0) return null;
  const entry = peer.localQueue[0];
  return deepFreeze({
    action: 'DELIVER_TO_CONFIGURED_HOME',
    homeNode: peer.homeNode,
    sequence: entry.sequence,
    payload: entry.payload
  });
}

/**
 * Accept an acknowledgement only for the head of the local queue. This is the
 * ordering fence: an acknowledgement for a newer item cannot discard it or
 * allow a peer to skip older history.
 */
function acknowledgeReconciled(state, sequence) {
  const peer = normalizePeerDeliveryState(state);
  if (peer.deliveryState !== 'RECONCILING') {
    fail('HOME_NODE_RECONCILIATION_NOT_ACTIVE', 'Mark the configured home reachable before acknowledging local queue reconciliation.');
  }
  const head = peer.localQueue[0];
  if (!head) {
    fail('HOME_NODE_RECONCILIATION_EMPTY', 'There is no queued item to acknowledge. Keep the peer HEALTHY until new degradation is observed.');
  }
  if (!Number.isSafeInteger(sequence) || sequence !== head.sequence) {
    fail('HOME_NODE_RECONCILIATION_OUT_OF_ORDER', `Acknowledge local queue sequence ${head.sequence} next; newer items cannot be reconciled ahead of it.`);
  }
  const queue = Object.freeze(peer.localQueue.slice(1));
  return makePeerDeliveryState({
    nodeId: peer.nodeId,
    homeNode: peer.homeNode,
    deliveryState: queue.length === 0 ? 'HEALTHY' : 'RECONCILING',
    queue,
    nextSequence: peer.nextSequence
  });
}

const acknowledgeReconciliation = acknowledgeReconciled;

module.exports = Object.freeze({
  CONFIGURATION_VERSION,
  DELIVERY_STATES,
  SETTINGS_SURFACE,
  NO_FAILOVER_RATIONALE,
  MIGRATION_PROCEDURE,
  HomeNodeError,
  normalizeNodeIdentity,
  validateNodeIdentity,
  normalizeHomeNodeConfiguration,
  normalizeHomeNodeConfig,
  validateHomeNodeConfiguration,
  resolveHomeNodeRole,
  resolveHomeRole,
  resolveRole,
  createPeerDeliveryState,
  createPeerQueue,
  normalizePeerDeliveryState,
  enterHomeUnreachable,
  markHomeUnreachable,
  queueLocally,
  enqueueLocally,
  beginReconciliation,
  markHomeReachable,
  nextReconciliationItem,
  acknowledgeReconciled,
  acknowledgeReconciliation
});
