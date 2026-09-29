'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');

const { rootPath, getSecret } = require('../runtime');
const { getStateStore } = require('../state-store');
const { ROUTES } = require('../agent-comms/broker');
const { createAgentCommsFabric } = require('../agent-comms/fabric');
const { createRelayTransport } = require('../agent-comms/transport-relay');
const { machineAddressPolicy, resolveService } = require('../service-registry');

const ACTORS = Object.freeze(['claude', 'codex', 'gemini']);
// Machine identities and their sanctioned addresses come from the same
// validated registry policy as every bridge boundary. Loading this provider
// therefore fails closed with SERVICE_REGISTRY_* if that authority is absent,
// malformed, or empty; it never carries a fallback identity table.
const MACHINES = Object.freeze(machineAddressPolicy().entries.map(machine => Object.freeze({
  address: machine.address,
  machineId: machine.machineId
})));
const RELAY_CHANNEL = 'agent_comms_v1';
const RELAY_TOKEN_KEY = 'custom.link_bus_bridge_token';
// THE RELAY ENDPOINT IS RESOLVED, NOT HARDCODED (R1116/R1117). This module
// used to default relayHost to a hardcoded LAN address literal (and RELAY_PORT
// to a bare 8787) -- whichever machine happened to load it -- which is the
// same endpoint-selection defect previously found in a retired transport: a
// link-bus server runs on BOTH paired machines, each bound to its own
// address, as two independent, non-federated logs, and only one of the two is
// the canonical shared bus. Defaulting to the local copy therefore looks
// perfectly healthy while writing into a log the peer never reads. The
// endpoint now comes from src/lib/service-registry.js asking for role
// "shared-agent-bus" -- which names the canonical machine no matter which
// machine this process runs on -- resolved lazily on first use inside build()
// below, never at module load, and it fails closed with a named error
// (AGENT_COMMS_RELAY_ENDPOINT_UNRESOLVED) instead of falling back to any
// literal if that role cannot be resolved.
const RELAY_SERVICE_ID = 'shared-agent-bus';
const AUTH_ENVELOPE_VERSION = 1;
const AUTH_CONTEXT = 'ToolsEnabled/agent-comms/link-bus-envelope/v1\0';
const AUTH_PROOF = Symbol('toolsenabled.agent-comms.authenticated');
const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

class AgentCommsToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentCommsToolError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new AgentCommsToolError(code, message, details);
}

// Resolve the shared bus endpoint BY ROLE instead of a literal (see the
// RELAY_SERVICE_ID comment above). Never called at module load; only from
// build() below, and only when the caller did not already supply an
// explicit relayHost/relayPort pair. Fails closed with a named
// AgentCommsToolError -- never falls back to a default host or port.
function resolveRelayEndpoint(resolveServiceFn = resolveService) {
  const resolved = resolveServiceFn(RELAY_SERVICE_ID);
  if (!resolved.ok) {
    fail('AGENT_COMMS_RELAY_ENDPOINT_UNRESOLVED',
      `The shared agent bus endpoint could not be resolved (${resolved.code}): ${resolved.reason}`,
      { service: RELAY_SERVICE_ID, code: resolved.code });
  }
  return resolved;
}

function safeActor(value) {
  const actor = String(value || '').trim().toLowerCase();
  if (!ACTORS.includes(actor)) {
    fail('AGENT_COMMS_ACTOR_REQUIRED', 'Agent messaging requires a transport-bound codex, claude, or gemini actor.');
  }
  return actor;
}

function machineById(machineId, machines = MACHINES) {
  const machine = machines.find(candidate => candidate.machineId === machineId);
  if (!machine) fail('AGENT_COMMS_MACHINE_UNKNOWN', 'The recipient machine is not configured.');
  return machine;
}

function detectLocalMachine(networkInterfaces = os.networkInterfaces, machines = MACHINES) {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4' && machines.some(machine => machine.address === entry.address)) {
        addresses.push(entry.address);
      }
    }
  }
  const unique = [...new Set(addresses)];
  if (unique.length !== 1) {
    fail(
      'AGENT_COMMS_MACHINE_ID_UNAVAILABLE',
      unique.length === 0
        ? 'No configured direct-Ethernet machine address is visible.'
        : 'More than one configured direct-Ethernet machine address is visible.'
    );
  }
  return machines.find(machine => machine.address === unique[0]);
}

function agentIdentity(actor, machineId, machines = MACHINES) {
  safeActor(actor);
  machineById(machineId, machines);
  return Object.freeze({ agentId: `${actor}-${machineId}`, machineId });
}

function configuredAgents(localMachineId, machines = MACHINES) {
  machineById(localMachineId, machines);
  return Object.freeze(machines.flatMap(machine => ACTORS.map(actor => Object.freeze({
    ...agentIdentity(actor, machine.machineId, machines),
    route: machine.machineId === localMachineId ? ROUTES.LOCAL : ROUTES.PEER,
    sessionId: `${actor}-${machine.machineId}-mcp`
  }))));
}

function macFor(token, payload) {
  return crypto.createHmac('sha256', token).update(AUTH_CONTEXT, 'utf8').update(payload, 'utf8').digest('hex');
}

function timingSafeHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sealMessage(token, payload) {
  return JSON.stringify({ version: AUTH_ENVELOPE_VERSION, payload, mac: macFor(token, payload) });
}

function openMessage(token, encoded) {
  let envelope;
  try { envelope = JSON.parse(encoded); }
  catch { fail('AGENT_COMMS_RELAY_ENVELOPE_INVALID', 'Relay message envelope is not valid JSON.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || envelope.version !== AUTH_ENVELOPE_VERSION
    || typeof envelope.payload !== 'string'
    || !timingSafeHex(envelope.mac, macFor(token, envelope.payload))) {
    fail('AGENT_COMMS_RELAY_AUTHENTICATION_FAILED', 'Relay message authentication failed.');
  }
  return Object.freeze({
    message: envelope.payload,
    authentication: Object.freeze({ version: AUTH_ENVELOPE_VERSION, mac: envelope.mac })
  });
}

function boundedHttpRequest({ host, port, token, requestImpl = http.request, machines = MACHINES }) {
  if (!machines.some(machine => machine.address === host)) {
    fail('AGENT_COMMS_RELAY_HOST_REFUSED', 'Relay host must be a registry-sanctioned machine address.');
  }
  return function requestPort(descriptor) {
    return new Promise((resolve, reject) => {
      let requestBody = descriptor.body;
      if (descriptor.method === 'POST' && descriptor.path === '/v1/messages') {
        let parsed;
        try { parsed = JSON.parse(requestBody); }
        catch { reject(Object.assign(new Error('request body is invalid'), { code: 'AGENT_COMMS_RELAY_REQUEST_INVALID' })); return; }
        parsed.message = sealMessage(token, parsed.message);
        requestBody = JSON.stringify(parsed);
      }
      const headers = {
        ...descriptor.headers,
        authorization: `Bearer ${token.toString('utf8')}`,
        ...(requestBody === null ? {} : { 'content-length': String(Buffer.byteLength(requestBody, 'utf8')) })
      };
      const request = requestImpl({
        host,
        port,
        path: descriptor.path,
        method: descriptor.method,
        headers,
        signal: descriptor.signal
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          const maximum = Math.min(descriptor.maxResponseBytes || MAX_HTTP_RESPONSE_BYTES, MAX_HTTP_RESPONSE_BYTES);
          if (bytes > maximum) {
            response.destroy(Object.assign(new Error('relay response too large'), { code: 'AGENT_COMMS_RELAY_RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          if (descriptor.method === 'GET' && response.statusCode === 200) {
            let page;
            try { page = JSON.parse(body); }
            catch { reject(Object.assign(new Error('relay response is invalid'), { code: 'AGENT_COMMS_RELAY_RESPONSE_INVALID' })); return; }
            if (!page || !Array.isArray(page.messages)) {
              reject(Object.assign(new Error('relay response is invalid'), { code: 'AGENT_COMMS_RELAY_RESPONSE_INVALID' }));
              return;
            }
            try {
              page.messages = page.messages.map(record => ({ ...record, ...openMessage(token, record.message) }));
              body = JSON.stringify(page);
            } catch (error) {
              reject(error);
              return;
            }
          }
          resolve({ statusCode: response.statusCode, body });
        });
      });
      request.on('finish', descriptor.onRequestSent);
      request.on('error', reject);
      if (requestBody !== null) request.write(requestBody);
      request.end();
    });
  };
}

function stateValue(store, key) {
  const entry = store.getMemory({ namespace: 'agent-comms-relay-state', key });
  return entry === null ? null : entry.value;
}

function replaceStateValue(store, key, value) {
  const prior = store.getMemory({ namespace: 'agent-comms-relay-state', key });
  store.setMemory({
    namespace: 'agent-comms-relay-state',
    key,
    value,
    expectedRevision: prior === null ? 0 : prior.revision
  });
}

function deliveryStateKey(messageId) {
  return `delivery/${crypto.createHash('sha256').update(messageId, 'utf8').digest('hex')}`;
}

function createDurableRelayState(store) {
  return Object.freeze({
    getDelivery(messageId) { return stateValue(store, deliveryStateKey(messageId)); },
    setDelivery(messageId, value) { replaceStateValue(store, deliveryStateKey(messageId), value); },
    getCursor(channel) { return stateValue(store, `cursor/${channel}`); },
    setCursor(channel, value) { replaceStateValue(store, `cursor/${channel}`, value); }
  });
}

function verifier() {
  return Object.freeze({
    verify({ authentication }) {
      if (!authentication || authentication.proof !== AUTH_PROOF || !authentication.identity) {
        return Object.freeze({ authenticated: false, integrityChecked: false });
      }
      return Object.freeze({ authenticated: true, integrityChecked: true, sender: authentication.identity });
    }
  });
}

function createAgentCommsProvider({
  localMachine = null,
  networkInterfaces,
  relayHost = null,
  relayPort = null,
  serviceRegistryOptions = {},
  resolveServiceFn = null,
  tokenLoader = () => getSecret(RELAY_TOKEN_KEY, { prompt: false }),
  stateStore = null,
  stateFile = null,
  requestPort = null,
  requestImpl = http.request,
  now = Date.now,
  readDelegationPolicy = require('../agent-delegation-policy').readAgentDelegationPolicy
} = {}) {
  let active = null;
  // Endpoint ownership and address admission must come from the same registry
  // view. Previously an injected/custom resolver could return a valid peer,
  // while the module-level shipped one-machine roster rejected that peer
  // before transport. A customer-configured topology was therefore impossible
  // to exercise without replacing source config. Derive one immutable roster
  // for this provider instance and use it at every identity/host boundary.
  const providerMachines = Object.freeze(machineAddressPolicy(serviceRegistryOptions).entries.map(machine => Object.freeze({
    address: machine.address,
    machineId: machine.machineId
  })));
  const providerResolveService = typeof resolveServiceFn === 'function'
    ? resolveServiceFn
    : serviceId => resolveService(serviceId, serviceRegistryOptions);

  function currentLocalMachine() {
    if (!localMachine) {
      return detectLocalMachine(networkInterfaces || os.networkInterfaces, providerMachines);
    }
    const declared = machineById(localMachine.machineId, providerMachines);
    if (typeof localMachine.address !== 'string' || localMachine.address !== declared.address) {
      fail('AGENT_COMMS_LOCAL_MACHINE_MISMATCH',
        'The injected local machine identity does not match the provider service registry.');
    }
    return declared;
  }

  function assertCrossMachineTopology() {
    if (providerMachines.length !== 2) {
      fail('AGENT_COMMS_TWO_MACHINE_TOPOLOGY_REQUIRED',
        'Cross-computer messaging requires exactly two machines in one validated service registry snapshot.');
    }
  }

  // An explicit relayHost+relayPort pair is an override for a caller that
  // legitimately needs one (a test double); short of that, ask the service
  // registry for role RELAY_SERVICE_ID. Only evaluated when a transport is
  // actually built (build() below), and short-circuited entirely when the
  // caller supplies requestPort directly, so it never runs at module load
  // and never runs at all for tests that inject their own transport.
  function resolveEndpoint() {
    if (relayHost && relayPort) return { host: relayHost, port: relayPort };
    const resolved = resolveRelayEndpoint(providerResolveService);
    return { host: relayHost || resolved.host, port: relayPort || resolved.port };
  }

  function build() {
    if (active) return active;
    assertCrossMachineTopology();
    const machine = currentLocalMachine();
    const store = stateStore || getStateStore();
    /* AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE COULD NOT FIRE, AND A NAMED
     * FAIL-CLOSED CODE THAT CANNOT FIRE IS A LIE THE NEXT READER TRUSTS.
     *
     * MEASURED, not deduced. The default loader is getSecret(RELAY_TOKEN_KEY),
     * and src/lib/runtime.js#getSecret never RETURNS a missing secret: it throws
     * SECRET_NOT_CONFIGURED, or -- when a prompt definition and an attributed
     * request context exist -- CREDENTIAL_PROMPT_CONTEXT_REQUIRED or
     * OWNER_PROMPT_QUEUED. Against the shipped payload with no relay credential
     * configured, this line was reached with the exception already in flight and
     * the check below never saw a value at all; every caller got
     * `SECRET_NOT_CONFIGURED | Secret 'custom.link_bus_bridge_token' is not
     * configured.` while the code that names this failure sat unreachable.
     *
     * So the throw is CAUGHT and turned into the named code it was always meant
     * to be. The length check stays, because it is the only guard for a caller
     * that injects its own loader and it is genuinely reachable for one; what
     * changes is that the default path can now reach the same named answer. The
     * original cause travels as a detail rather than being swallowed. */
    let loaded;
    try { loaded = tokenLoader(); }
    catch (error) {
      fail('AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE', 'The link-bus relay credential is unavailable.', {
        causeCode: error && typeof error.code === 'string' ? error.code : null
      });
    }
    if (typeof loaded !== 'string' || loaded.length < 16) {
      fail('AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE', 'The link-bus relay credential is unavailable.');
    }
    const token = Buffer.from(loaded, 'utf8');
    const relay = createRelayTransport({
      channel: RELAY_CHANNEL,
      sender: `agent-comms-${machine.machineId}`,
      requestPort: requestPort || boundedHttpRequest({
        ...resolveEndpoint(), token, requestImpl, machines: providerMachines
      }),
      state: createDurableRelayState(store),
      initialCursor: 0,
      now
    });
    const fabric = createAgentCommsFabric({
      agents: configuredAgents(machine.machineId, providerMachines),
      verifier: verifier(),
      store,
      now,
      inboundTransport: relay,
      inboundAuthentication({ record, submission }) {
        const authentication = record.authentication;
        if (!authentication || authentication.version !== AUTH_ENVELOPE_VERSION
          || !timingSafeHex(authentication.mac, macFor(token, record.message))) return null;
        return Object.freeze({ proof: AUTH_PROOF, identity: submission.sender });
      },
      brokerOptions: {
        stateFile: stateFile || rootPath('state', 'agent-comms', 'broker.json'),
        transport: relay,
        livenessReceiver: Object.freeze({
          getAgent(agentId, sessionId) {
            return Object.freeze({ agentId, sessionId, state: 'RUNNING', freshness: 'FRESH' });
          }
        })
      }
    });
    active = Object.freeze({ fabric, machine });
    return active;
  }

  function localIdentity(context) {
    const { machine } = build();
    return agentIdentity(safeActor(context && context.agentActor), machine.machineId, providerMachines);
  }

  async function send(input, context = {}) {
    require('../agent-delegation-policy').assertAgentCommunicationAllowed(readDelegationPolicy());
    /* THE REGISTRY ANSWERS BEFORE THE RELAY IS TOUCHED. Who the caller is, and
     * whether the recipient machine exists and is not this one, are questions
     * the registry and the transport binding answer on their own. Building the
     * relay first meant a stock one-machine install -- where no relay
     * credential is ever provisioned -- answered every send with
     * AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE, and the honest refusal below,
     * the only one that names what to do instead, could not fire on exactly
     * the installations that needed it. Measured against the sealed payload,
     * 2026-08-19. */
    const actor = safeActor(context && context.agentActor);
    const machine = currentLocalMachine();
    const recipientMachine = machineById(input.recipientMachine, providerMachines);
    if (recipientMachine.machineId === machine.machineId) {
      /* THE REFUSAL STANDS -- this messenger is cross-machine and always was --
       * BUT IT USED TO BE A DEAD END. On an installation whose registry declares
       * one machine (the shipped default), the recipientMachine enum contains
       * exactly one value and this is the answer for it, so the tool could not
       * be invoked by any caller and the code said nothing about what to do
       * instead. There is now a local sibling, so the refusal names it. */
      return Object.freeze({
        accepted: false,
        code: 'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED',
        useInstead: 'agent_comms.send_local',
        reason: 'This messenger only reaches another computer. To reach an agent on THIS computer, use agent_comms.send_local and address both ends by the name on the tree.'
      });
    }
    /* Only a genuinely cross-machine send needs the relay, so only here does
     * the credential get loaded and the transport built. */
    const { fabric } = build();
    const sender = agentIdentity(actor, machine.machineId, providerMachines);
    const recipient = agentIdentity(safeActor(input.recipientActor), recipientMachine.machineId, providerMachines);
    return fabric.send({ sender, recipient, kind: 'notice', body: input.body }, {
      proof: AUTH_PROOF,
      identity: sender
    });
  }

  /* REFUSED AND UNREACHABLE ARE DIFFERENT FACTS, and the drains below may only
   * absorb one of them. If the relay ANSWERED -- a rejected credential, a record
   * whose authentication does not verify -- the person has a repair to make and
   * must be told; swallowing that produces a successful read of an EMPTY INBOX,
   * and a person told their inbox is empty stops looking while the message is
   * still waiting for them. If nobody was there to answer at all, the far side
   * being away is no reason to withhold what is already on this machine.
   *
   * THE TRANSPORT CODE ALONE CANNOT TELL THEM APART, which is the trap here and
   * the reason this is two lists rather than one. Measured on the relay-edge
   * suite, all three of these arrive at this guard:
   *
   *   unreachable relay   TRANSPORT_RELAY_REQUEST_FAILED  relayCode ECONNREFUSED
   *   forged envelope     TRANSPORT_RELAY_REQUEST_FAILED  relayCode AGENT_COMMS_RELAY_AUTHENTICATION_FAILED
   *   stale credential    TRANSPORT_RELAY_READ_REJECTED   relayCode unauthorized
   *
   * The first two share a transport code and mean opposite things, because
   * REQUEST_FAILED covers both a dead socket and a response the client could not
   * verify. So the cause decides: absorb only when the transport says the request
   * did not complete AND the cause is a socket-level errno. Anything the relay or
   * its payload actually said propagates.
   *
   * BOTH LISTS ARE ALLOWLISTS, NOT TESTS FOR BADNESS. An earlier version asked
   * whether an error looked like a refusal and absorbed what did not -- that
   * turned a failed authentication into a quiet empty inbox, which is exactly
   * the defect this drain was added to remove.
   *
   * TRANSPORT_RELAY_DEADLINE is deliberately absent, and it is the one that
   * looks like it belongs: a deadline is the whole operation's budget running
   * out, which happens when nobody answered AND when the reader spent that
   * budget failing on a record it cannot open. Absorbing it would turn a
   * poisoned inbox into a quiet empty one. */
  const RELAY_INCOMPLETE_CODES = Object.freeze([
    'TRANSPORT_RELAY_REQUEST_FAILED',
    'TRANSPORT_RELAY_REQUEST_TIMEOUT'
  ]);
  const SOCKET_ERRNOS = Object.freeze([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EHOSTUNREACH',
    'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'
  ]);

  function relayNeverAnswered(error) {
    if (!error || !RELAY_INCOMPLETE_CODES.includes(error.code)) return false;
    const cause = error.details && error.details.relayCode;
    return typeof cause === 'string' && SOCKET_ERRNOS.includes(cause);
  }

  async function read(input, context = {}) {
    const { fabric } = build();
    const agent = localIdentity(context);
    /* THE INBOUND DRAIN USED TO BE UNGUARDED, AND THAT COST A READER THEIR WHOLE
     * INBOX. When the relay is unreachable this throws, and it runs before the
     * local read -- so an agent whose relay was down could not read the messages
     * already sitting on this machine either. The relay being away is a fact
     * about the far side; it is not a reason to withhold what is already here. */
    let inbound;
    try {
      inbound = await fabric.drainInbound();
    } catch (error) {
      if (!relayNeverAnswered(error)) throw error;
      inbound = Object.freeze({
        drained: false,
        reason: error && error.code ? error.code : 'AGENT_COMMS_INBOUND_DRAIN_FAILED'
      });
    }
    /* THE OUTBOUND SPOOL HAD NO DRAINER, AND THAT LOST MESSAGES SILENTLY.
     * When the relay cannot take a send, the broker spools it and send()
     * returns with the message queued rather than delivered. Nothing in the
     * product ever called fabric.drain(), so that spooled message was never
     * delivered by anything, ever -- while the field a caller reads first still
     * said accepted. Measured: relay down, send, relay back, read; the bus
     * still held zero.
     *
     * This is the drain, and it is here rather than in send() because this is
     * the path an agent polls -- so the spool clears within one poll of the
     * relay coming back, instead of only when the sender happens to send again.
     *
     * IT DRAINS THE WHOLE SPOOL, NOT THE READER'S SHARE OF IT, and that is not
     * a shortcut. broker.drain(agentId) filters on the RECIPIENT of a spooled
     * message, so scoping it to the polling agent drains messages addressed TO
     * them -- never the ones they sent. The spool is this machine's outbound
     * queue; the sender polling is the event, and everything queued behind it
     * should go. Scoping this call is how the first version of the fix passed
     * review and delivered nothing.
     *
     * WHAT IT REPORTS IS A COUNT, NOT THE MESSAGES. Draining all of it means
     * touching other agents' queued mail, and the poller is not entitled to
     * read who those messages were for.
     *
     * IT IS FAIL-OPEN ON PURPOSE. If the relay is still down the drain fails,
     * and a reader whose inbox is fine must still get their inbox. The outcome
     * is reported rather than thrown, because a drain that quietly does nothing
     * is the defect this comment exists to describe. */
    let outbound;
    try {
      const drained = await fabric.drain();
      outbound = Object.freeze({
        drained: true,
        attempted: drained.attempted,
        delivered: drained.delivered
      });
    } catch (error) {
      if (!relayNeverAnswered(error)) throw error;
      outbound = Object.freeze({
        drained: false,
        reason: error && error.code ? error.code : 'AGENT_COMMS_OUTBOUND_DRAIN_FAILED'
      });
    }
    const page = await fabric.read({
      agent,
      audience: { type: 'direct', agent },
      cursor: input.cursor,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    });
    return Object.freeze({ inbound, outbound, page });
  }

  function acknowledge(input, context = {}) {
    const { fabric } = build();
    const agent = localIdentity(context);
    return fabric.markRead({
      agent,
      audience: { type: 'direct', agent },
      messageId: input.messageId,
      sequence: input.sequence,
      evidence: { source: 'agent_comms.acknowledge', note: input.evidence }
    });
  }

  return Object.freeze({ acknowledge, read, send });
}

const provider = createAgentCommsProvider();

module.exports = Object.freeze({
  ACTORS,
  MACHINES,
  RELAY_CHANNEL,
  RELAY_SERVICE_ID,
  AgentCommsToolError,
  acknowledge: provider.acknowledge,
  read: provider.read,
  send: provider.send,
  createAgentCommsProvider,
  createDurableRelayState,
  detectLocalMachine,
  resolveRelayEndpoint,
  sealMessage,
  openMessage
});
