'use strict';

// Local-first production adapter for tools/agent-msg.js. It composes the
// existing fabric, StateStore history/control records, broker durability, and
// the one existing presence mailbox. Cross-machine delivery remains behind
// fabric/transport-relay.js; this adapter never guesses or opens an endpoint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../agent-presence');
const { rootPath } = require('../runtime');
const { ROUTES } = require('./broker');
const { createAgentCommsFabric } = require('./fabric');
const { createControlPlane } = require('./control-plane');

const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class LocalAgentCommsRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalAgentCommsRuntimeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new LocalAgentCommsRuntimeError(code, message, details);
}

function normalizeAgentId(value, label = 'agentId') {
  if (typeof value !== 'string' || !AGENT_RE.test(value)) {
    fail('AGENT_COMMS_AGENT_ID_INVALID', `${label} must be a lowercase durable agent identity.`, { field: label });
  }
  return value;
}

function normalizeMachineId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!normalized) fail('AGENT_COMMS_MACHINE_ID_UNAVAILABLE', 'A stable local machine identity could not be derived.');
  return normalized;
}

/* THE HOSTNAME IS THE PERSON'S, AND IT IS NOT ASCII EVERYWHERE. A Windows
 * computer named "Ноутбук" or "ノートPC" normalizes to nothing here, and this
 * function used to answer that with a hard refusal -- the local agent-comms
 * runtime could not start at all on a machine whose only oddity was its name.
 * Its sibling, src/lib/setup/machine-record.js defaultMachineId(), already
 * answers the same input with the neutral 'this-machine'; two normalizers with
 * two behaviours for one hostname is how one of them bricks a subsystem. An
 * EXPLICITLY configured TOOLSENABLED_MACHINE_ID that normalizes to nothing
 * still refuses, because that is a person's configuration being wrong, which
 * deserves a loud answer, not a silent rename. */
function configuredMachineId({ env = process.env, hostname = os.hostname } = {}) {
  const configured = env.TOOLSENABLED_MACHINE_ID;
  if (typeof configured === 'string' && configured.trim() !== '') return normalizeMachineId(configured);
  let name;
  try { name = String(hostname() || ''); }
  catch (error) {
    fail('AGENT_COMMS_MACHINE_ID_UNAVAILABLE', 'The local hostname could not be read.', {
      causeCode: error && typeof error.code === 'string' ? error.code : null
    });
  }
  const normalized = name.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'this-machine';
}

function configuredBrokerFile({ env = process.env } = {}) {
  const configured = env.TOOLSENABLED_AGENT_COMMS_BROKER_FILE;
  if (typeof configured === 'string' && configured.trim()) {
    if (configured.includes('\u0000')) fail('AGENT_COMMS_STATE_PATH_INVALID', 'Broker file contains a NUL byte.');
    return path.resolve(configured.trim());
  }
  return rootPath('state', 'agent-comms', 'local-broker.json');
}

function readDeclaredAgentIds(file = rootPath('config', 'agent-org.json')) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    fail('AGENT_COMMS_AGENT_DIRECTORY_UNAVAILABLE', 'The declared agent organization could not be read.', {
      causeCode: error && typeof error.code === 'string' ? error.code : null
    });
  }
  if (!parsed || !Array.isArray(parsed.agents)) {
    fail('AGENT_COMMS_AGENT_DIRECTORY_INVALID', 'The declared agent organization has no agent list.');
  }
  return parsed.agents
    .map(agent => agent && agent.id)
    .filter(id => typeof id === 'string' && AGENT_RE.test(id));
}

function registeredPresenceAgentIds({ presenceFile = presence.DEFAULT_STATE_FILE, fsImpl = fs } = {}) {
  let registry;
  try { registry = presence.readRegistry(presenceFile, { fsImpl }); }
  catch (error) {
    fail('AGENT_COMMS_PRESENCE_UNAVAILABLE', 'The presence registry could not be read.', {
      causeCode: error && typeof error.code === 'string' ? error.code : null
    });
  }
  return Object.keys(registry.agents).filter(id => AGENT_RE.test(id));
}

function createPresenceMailboxPort({
  presenceFile = presence.DEFAULT_STATE_FILE,
  mailboxDir = presence.DEFAULT_MAILBOX_DIR,
  fsImpl = fs
} = {}) {
  return Object.freeze({
    isRegistered(agentId) {
      const id = normalizeAgentId(agentId);
      return registeredPresenceAgentIds({ presenceFile, fsImpl }).includes(id);
    },
    append(entry) {
      return presence.appendMailbox(entry.agentId, {
        from: entry.from,
        prompt: entry.prompt,
        requestId: entry.requestId,
        at: entry.at
      }, { fsImpl, mailboxDir });
    }
  });
}

function uniqueAgentIds(values) {
  return [...new Set(values.map(value => normalizeAgentId(value)))].sort((left, right) => left.localeCompare(right));
}

function getDefaultStateStore() {
  // Keep the SQLite-backed default behind the path that actually needs it so
  // callers supplying a store can load and compose this adapter on Node
  // runtimes that do not provide node:sqlite.
  return require('../state-store').getStateStore();
}

/* WHO A BUILD WOULD PUT ON THE ROSTER, WITHOUT PAYING FOR THE BUILD.
 *
 * WHY THIS IS SPLIT OUT. Everything else createLocalAgentCommsRuntime()
 * composes is derived from these two values, and everything EXPENSIVE about a
 * build happens after them: createAgentCommsFabric() constructs a broker, which
 * takes the machine-wide spool lock, reads the spool, reconciles every claim in
 * it and writes it back. MEASURED 2026-09-03 on this checkout, one tree of
 * three circles with forty messages already on the wire and a 12,608-byte
 * spool: a whole build costs 16.7-49.9 ms (median 22.8), while reading the
 * three inputs below costs 0.34 ms (control-plane snapshot 0.08, agent-org.json
 * 0.17, presence 0.09). A caller holding a built runtime can therefore ask "is
 * the roster I built still the roster a build would produce?" for about 1.5% of
 * the price of finding out by building one.
 *
 * IT IS THE SAME COMPOSITION, NOT A COPY OF IT. createLocalAgentCommsRuntime()
 * below calls this function for its own roster, so there is exactly one place
 * that decides who is on it. A second implementation kept in step by hand is
 * how a cache starts answering a question its subject stopped asking. */
function composeRuntimeRoster({
  extraAgentIds = [],
  store = null,
  now = Date.now,
  machineId = null,
  orgFile,
  presenceFile = presence.DEFAULT_STATE_FILE,
  fsImpl = fs
} = {}) {
  if (!Array.isArray(extraAgentIds) || typeof now !== 'function') {
    fail('AGENT_COMMS_RUNTIME_CONFIGURATION_INVALID', 'extraAgentIds and now are invalid.');
  }
  const activeStore = store || getDefaultStateStore();
  const control = createControlPlane({ store: activeStore, now });
  const durableMembers = control.snapshot().channels.flatMap(channel => channel.members);
  return Object.freeze({
    agentIds: Object.freeze(uniqueAgentIds([
      'owner',
      ...readDeclaredAgentIds(orgFile),
      ...registeredPresenceAgentIds({ presenceFile, fsImpl }),
      ...durableMembers,
      ...extraAgentIds
    ])),
    machineId: machineId === null ? configuredMachineId() : normalizeMachineId(machineId)
  });
}

function createLocalAgentCommsRuntime({
  extraAgentIds = [],
  store = null,
  now = Date.now,
  machineId = null,
  brokerFile = null,
  orgFile,
  presenceFile = presence.DEFAULT_STATE_FILE,
  mailboxDir = presence.DEFAULT_MAILBOX_DIR,
  fsImpl = fs,
  mailboxPort = null,
  retainModelHandoffs = false,
  /* HOW LONG THIS BUILD MAY BLOCK WAITING FOR THE MACHINE-WIDE SPOOL LOCK.
     null keeps broker.js's own DEFAULT_LOCK_TIMEOUT_MS, so every existing
     caller is unchanged. A latency-sensitive caller can ask for a smaller
     budget and be refused quickly instead of blocking: the wait is
     Atomics.wait inside withStateLock, which stops the whole thread. */
  lockTimeoutMs = null
} = {}) {
  if (!Array.isArray(extraAgentIds) || typeof now !== 'function') {
    fail('AGENT_COMMS_RUNTIME_CONFIGURATION_INVALID', 'extraAgentIds and now are invalid.');
  }
  const activeStore = store || getDefaultStateStore();
  const { agentIds, machineId: localMachineId } = composeRuntimeRoster({
    extraAgentIds, store: activeStore, now, machineId, orgFile, presenceFile, fsImpl
  });
  const agents = agentIds.map(id => Object.freeze({
    agentId: id,
    machineId: localMachineId,
    route: ROUTES.LOCAL,
    sessionId: `session-${crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32)}`
  }));
  const byAgentId = new Map(agents.map(agent => [agent.agentId, agent]));
  const verifier = Object.freeze({
    verify({ authentication }) {
      const identity = authentication && authentication.identity;
      if (!identity || byAgentId.get(identity.agentId)?.machineId !== identity.machineId) {
        return Object.freeze({ authenticated: false, integrityChecked: false });
      }
      return Object.freeze({ authenticated: true, integrityChecked: true, sender: identity });
    }
  });
  const fabric = createAgentCommsFabric({
    agents,
    verifier,
    store: activeStore,
    now,
    mailboxPort: mailboxPort || createPresenceMailboxPort({ presenceFile, mailboxDir, fsImpl }),
    channelContractOptions: {
      messageIdFactory() { return `message-${crypto.randomUUID()}`; }
    },
    brokerOptions: {
      retainModelHandoffs,
      ...(Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0 ? { lockTimeoutMs } : {}),
      stateFile: brokerFile || configuredBrokerFile(),
      livenessReceiver: Object.freeze({
        getAgent(agentId, sessionId) {
          return byAgentId.has(agentId)
            ? Object.freeze({ agentId, sessionId, state: 'RUNNING', freshness: 'FRESH' })
            : null;
        }
      }),
      transport: Object.freeze({
        async deliver(attempt) {
          return Object.freeze({
            delivered: true,
            messageId: attempt.messageId,
            evidence: Object.freeze({ source: 'local-durable-fabric' })
          });
        }
      })
    }
  });

  function identity(value) {
    const id = normalizeAgentId(value);
    const agent = byAgentId.get(id);
    if (!agent) fail('FABRIC_AGENT_UNKNOWN', 'Agent is not configured.', { agentId: id });
    return Object.freeze({ agentId: agent.agentId, machineId: agent.machineId });
  }

  return Object.freeze({
    fabric,
    identity,
    machineId: localMachineId,
    ownerActor: Object.freeze({ actorId: 'owner', actorKind: 'owner' })
  });
}

module.exports = Object.freeze({
  LocalAgentCommsRuntimeError,
  composeRuntimeRoster,
  configuredMachineId,
  createLocalAgentCommsRuntime,
  createPresenceMailboxPort,
  normalizeAgentId,
  readDeclaredAgentIds,
  registeredPresenceAgentIds
});
