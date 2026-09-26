'use strict';

// A HARNESS THAT STANDS AGENT COMMS UP AND PASSES A REAL MESSAGE THROUGH IT.
//
// WHY IT EXISTS. Coverage for this subsystem is module-shaped: broker.js,
// history.js, read-position.js and transport-relay.js each prove their own
// contract against an injected double. Nothing stood the whole thing up and
// watched one message travel from a sender to a recipient through the real
// composition -- the tree directory, the local runtime, the fabric, the broker,
// the durable history and the positioned read -- so a defect in delivery,
// ordering, durability or the read position had no test to fail and reached a
// person instead.
//
// AND WHY IT REFUSES TO DEPEND ON THIS MACHINE. The one existing end-to-end
// suite, tests/agent-comms/provider.js, historically depended on a service
// registry declaring two machines. That suite now uses this same fixture at
// module load, while the full-stack harness also injects config/agent-org.json
// and a test relay credential. A harness that only runs where the builder's own
// machine-local files happen to sit is a harness nobody runs, so every one of
// those inputs is injected here from a temporary directory this file creates:
//
//   the agent organization  -> a temp agent-org.json written by the caller
//   the presence registry   -> a temp path (absent = an empty registry)
//   durable state           -> memoryStateStore(), the same StateStore memory
//                              API tests/agent-comms/history.js already pins
//   the broker spool        -> a temp broker.json
//   the tree directory      -> a temp tree-nodes.json
//   the service registry    -> a two-machine fixture, seeded the way
//                              tests/link-bus-smoke-test.js already seeds one
//   the relay credential    -> a literal test token handed to an injected
//                              tokenLoader and to the link-bus server, so no
//                              vault is read and no real credential is spent
//
// WHAT IS STILL REAL, because that is the whole point: every module under test
// is the shipped one. The relay half runs the actual sidecars/link-bus HTTP
// server over an actual loopback socket, driven by the actual
// src/lib/providers/agent-comms.js client -- real bearer auth, real HMAC
// sealing, real bytes -- rather than an injected requestPort that skips them.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// RFC 5737 documentation addresses plus loopback. Loopback is machine-a's
// declared address ON PURPOSE: src/lib/providers/agent-comms.js only dials a
// host the registry sanctions, so the relay half can reach a server this
// process actually started only if that server's address is a declared machine.
const FIXTURE_MACHINES = Object.freeze({
  'machine-a': Object.freeze({ address: '127.0.0.1', role: 'development-host' }),
  'machine-b': Object.freeze({ address: '203.0.113.1', role: 'disconnected-peer' })
});

// Long enough to satisfy the client's own minimum length check, and obviously
// not a credential to anyone reading a failure message.
const TEST_RELAY_TOKEN = 'harness-link-bus-token-not-a-real-credential';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* THE DURABLE STORE, IN MEMORY, WITH THE PRODUCTION SEMANTICS.
 *
 * Same shape as the double in tests/agent-comms/history.js and
 * tests/agent-comms/provider.js -- revisioned compare-and-set that THROWS
 * MEMORY_REVISION_CONFLICT on a stale expectedRevision -- because the history
 * module's loss-under-contention behaviour depends on that conflict actually
 * being raised. A store that quietly accepted a stale write would make the
 * concurrency test below pass for the wrong reason.
 *
 * dump() exists so a test can ask "does this string appear anywhere in durable
 * state?" -- the only honest way to prove a refused message was never written,
 * when the read path that would show it is (correctly) refusing. */
function memoryStateStore() {
  const entries = new Map();
  return Object.freeze({
    getMemory({ namespace, key }) {
      const entry = entries.get(`${namespace}\u0000${key}`);
      return entry ? clone(entry) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      const lookup = `${namespace}\u0000${key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      if (revision !== expectedRevision) {
        const error = new Error('revision conflict');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      const entry = { namespace, key, value: clone(value), revision: revision + 1 };
      entries.set(lookup, entry);
      return { entry: clone(entry), created: !prior, replayed: false };
    },
    dump() {
      return JSON.stringify([...entries.values()]);
    }
  });
}

/** A temp directory that cleans itself up when the test finishes. */
function workspace(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/* THE TWO-MACHINE REGISTRY, SEEDED THE WAY THIS REPOSITORY ALREADY SEEDS ONE.
 *
 * src/lib/providers/agent-comms.js builds its machine table ONCE, at module
 * load, from machineAddressPolicy(); createAgentCommsProvider() takes
 * resolveServiceFn, tokenLoader, stateStore and requestPort as injectable
 * options but takes no machine list, so there is no per-caller way to give it
 * a peer. The shipped config/service-registry.json declares exactly one
 * machine, which is why the cross-machine half is untestable here without
 * this.
 *
 * The stand-in DELEGATES to the real resolver with { registry } filled in --
 * copied deliberately from tests/link-bus-smoke-test.js -- so the fixture
 * still goes through the production validateRegistry() and
 * buildMachineAddressPolicy(). Nothing about the policy under test is
 * hand-written here. An explicit registry from a caller still wins.
 *
 * Call this BEFORE requiring anything that reads the registry at load time,
 * and call the returned restore() immediately after; by then the reader has
 * frozen what it needed and leaving the real resolver shadowed would hide a
 * later, unrelated registry read. */
function installFixtureRegistry({ machines = FIXTURE_MACHINES } = {}) {
  const fixture = { schemaVersion: 1, machines: clone(machines), services: {} };
  const modulePath = require.resolve(path.join(ROOT, 'src', 'lib', 'service-registry.js'));
  const real = require(modulePath);
  const withFixture = (options = {}) => (
    Object.hasOwn(options, 'registry') || Object.hasOwn(options, 'registryPath')
      ? options
      : { ...options, registry: fixture }
  );
  const saved = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: Object.freeze({
      ...real,
      loadRegistry: (options = {}) => real.loadRegistry(withFixture(options)),
      machineAddressPolicy: (options = {}) => real.machineAddressPolicy(withFixture(options)),
      machineForId: (machineId, options = {}) => real.machineForId(machineId, withFixture(options)),
      peerMachineForAddress: (address, options = {}) => real.peerMachineForAddress(address, withFixture(options)),
      assertSanctionedMachineAddress: (address, options = {}) => real.assertSanctionedMachineAddress(address, withFixture(options)),
      resolveService: (serviceId, options = {}) => real.resolveService(serviceId, withFixture(options))
    })
  };
  return function restore() {
    if (saved === undefined) delete require.cache[modulePath];
    else require.cache[modulePath] = saved;
  };
}

/* A PORT NOTHING IS LISTENING ON, obtained by binding one and letting it go.
 * The only honest way to test "the relay was unreachable when the message was
 * sent" without inventing a transport error the real client would never see. */
function reservePort() {
  return new Promise((resolve, reject) => {
    const idle = http.createServer();
    idle.once('error', reject);
    idle.listen(0, '127.0.0.1', () => {
      const { port } = idle.address();
      idle.close(() => resolve(port));
    });
  });
}

/* THE REAL LINK-BUS SERVER, ON A REAL SOCKET, WITH AN INJECTED CREDENTIAL.
 *
 * Everything the shipped sidecar would take from the machine is supplied:
 * the bearer token (so no vault read), the durable store's directory, the log
 * file, and the remote-address policy. reloadToken is a local function rather
 * than the default loadTokenAsync, which matters twice: the server's own
 * vaultBackedReload gate then stays false, and the two-second timer never
 * spawns powershell.exe to read a vault this test has no business touching. */
function startLinkBus({ linkBus, createStore, directory, token = TEST_RELAY_TOKEN, port = 0 }) {
  const server = linkBus.createServer({
    token: Buffer.from(token, 'utf8'),
    store: createStore({ stateDir: path.join(directory, 'bus') }),
    logFile: path.join(directory, 'link-bus.log'),
    reloadToken: () => Buffer.from(token, 'utf8'),
    reloadIntervalMs: 60_000,
    // The shipped policy admits exactly the peer machine's address. This
    // server is answering a client on this same host, so loopback is the
    // sanctioned remote here; Node reports it either bare or v4-mapped.
    allowedRemoteRe: /^(?:::ffff:)?127\.0\.0\.1$/
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(Object.freeze({
        server,
        port: server.address().port,
        close: () => new Promise(done => server.close(done))
      }));
    });
  });
}

/* ONE COMPUTER'S AGENT TREE, STOOD UP FROM NOTHING BUT A TEMP DIRECTORY.
 *
 * Returns the real tree directory, the real local message provider composed on
 * top of it, and a factory for the real local runtime -- so a test can also
 * reach the fabric surfaces (markRead, position) that the tool-facing provider
 * deliberately does not expose.
 *
 * Every collaborator is the shipped one. What is replaced is only WHERE each
 * of them reads and writes. */
function localTree({
  createTreeNodeDirectory,
  createLocalAgentCommsRuntime,
  createLocalAgentMessageProvider,
  directory,
  now,
  machineId = 'harness-machine',
  declaredAgents = []
}) {
  const orgFile = path.join(directory, 'agent-org.json');
  fs.writeFileSync(orgFile, `${JSON.stringify({ agents: declaredAgents }, null, 2)}\n`, 'utf8');
  const presenceFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const brokerFile = path.join(directory, 'local-broker.json');
  const store = memoryStateStore();

  const runtimeFor = (options = {}) => createLocalAgentCommsRuntime({
    extraAgentIds: [],
    brokerFile,
    now,
    ...options,
    store,
    orgFile,
    presenceFile,
    mailboxDir,
    machineId
  });

  const tree = createTreeNodeDirectory({ file: path.join(directory, 'tree-nodes.json'), now });
  const provider = createLocalAgentMessageProvider({
    directory: tree,
    brokerFile,
    now,
    runtimeFactory: runtimeFor
  });
  return Object.freeze({ brokerFile, orgFile, provider, runtimeFor, store, tree });
}

module.exports = Object.freeze({
  FIXTURE_MACHINES,
  ROOT,
  TEST_RELAY_TOKEN,
  installFixtureRegistry,
  localTree,
  memoryStateStore,
  reservePort,
  startLinkBus,
  workspace
});
