'use strict';

// Real Linux acceptance for the production owner-host, both production clients,
// kernel SO_PEERCRED, Unix socket permissions, and the existing org/tier gates.
// No provider is called. The only collaborator failure injection makes the
// credential reader unavailable; successful authority/dispatch use real code.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn } = childProcess;
const { once } = require('node:events');
const { configure } = require('./lib/isolated-environment');

assert.equal(process.platform, 'linux', 'this acceptance suite requires real Linux kernel sockets');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-owner-linux-'));
// Sockets get their own SHORT root, deliberately not under `scratch`. A unix
// socket path must fit sockaddr_un.sun_path (108 bytes with its terminator),
// and TMPDIR is not always shallow -- this installation sets it to
// /home/j/toolsenabled-port/private/linux-live/temp, 49 bytes, which pushed
// `scratch`/<uuid>.sock to 113 and made every socket case in this file refuse.
// The product itself is not affected: it derives /run/user/<uid>/... at 80
// bytes, independent of install depth. This is a harness bound, so it is
// fixed in the harness. checkedDirectory already sanctions exactly this
// shape -- an owner-private 0700 directory inside a root-owned sticky /tmp.
const socketScratch = fs.mkdtempSync(path.join('/tmp', 'te-owl-'));
configure(scratch);
let refuseHostReader = false;
childProcess.spawn = function (file, ...args) {
  if (refuseHostReader && file === '/usr/bin/python3') {
    throw Object.assign(new Error('credential reader unavailable'), { code: 'ENOENT' });
  }
  return spawn(file, ...args);
};
let linux;
try { linux = require('../src/lib/owner-host-linux'); }
finally { childProcess.spawn = spawn; }
const ownerHost = require('../src/owner-host');
const proxy = require('../tools/mcp-owner-proxy');
const sessionAuthority = require('../src/lib/agent-session-credential');
const { createInstalledAgentOrgStores } = require('../src/lib/agent-org-store');
const ROOT = path.resolve(__dirname, '..');
const PROXY = path.join(ROOT, 'tools', 'mcp-owner-proxy.js');
const children = new Set();
const hosts = new Set();
let checks = 0;

async function check(label, body) {
  await body();
  checks += 1;
  process.stdout.write(`ok ${checks} - ${label}\n`);
}

function code(expected) { return error => error?.code === expected; }

function lines(stream) {
  let buffer = '';
  const queued = [];
  const waiting = [];
  let ended = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (waiting.length) waiting.shift().resolve(line);
      else queued.push(line);
    }
  });
  const close = () => {
    ended = true;
    while (waiting.length) waiting.shift().reject(new Error('transport closed before a response'));
  };
  stream.on('close', close);
  stream.on('error', close);
  return (timeoutMs = 10000) => {
    if (queued.length) return Promise.resolve(queued.shift());
    if (ended) return Promise.reject(new Error('transport is closed'));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('transport response timed out'));
      }, timeoutMs);
      waiting.push(entry);
    });
  };
}

async function socketPair() {
  const socketFile = path.join(socketScratch, `${crypto.randomUUID()}.sock`);
  linux.prepareSocketDirectory(socketFile);
  const server = net.createServer();
  server.listen(socketFile);
  await once(server, 'listening');
  linux.protectSocket(socketFile);
  const accepted = once(server, 'connection');
  const client = net.connect(socketFile);
  client.on('error', () => {});
  await once(client, 'connect');
  const [peer] = await accepted;
  peer.on('error', () => {});
  return {
    client, peer, socketFile,
    async close() {
      client.destroy();
      peer.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function startProxy(capabilityFile, pipeName, credential, { helperUnavailable = false, resolveOnly = false } = {}) {
  // Patch only the external reader dependency in a separate disposable
  // process. The real proxy must refuse, and the server must receive no byte.
  const clientProgram = [
    ...(helperUnavailable ? [
      'const cp = require("node:child_process");',
      'cp.spawn = () => { throw Object.assign(new Error("unavailable"), { code: "ENOENT" }); };'
    ] : []),
    resolveOnly
      ? 'require("./src/lib/agent-session-credential").resolveAgentSessionCredential('
        + 'process.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, { routeFile: process.env.TOOLSENABLED_TEST_ROUTE_FILE })'
        + '.then(() => { process.exitCode = 2; }, error => { process.stderr.write(error.code); process.exitCode = 1; });'
      : `require(${JSON.stringify(PROXY)}).main();`
  ].join('\n');
  const child = spawn(process.execPath, helperUnavailable || resolveOnly ? ['-e', clientProgram] : [PROXY], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOOLSENABLED_TEST_ISOLATED: '1',
      TOOLSENABLED_TEST_ROOT: path.dirname(capabilityFile),
      TOOLSENABLED_TEST_OWNER_HOST_PIPE: pipeName,
      TOOLSENABLED_TEST_ROUTE_FILE: capabilityFile,
      TOOLSENABLED_AGENT_ACTOR: 'codex',
      TOOLSENABLED_AGENT_SESSION_CREDENTIAL: credential
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, next: lines(child.stdout), stderr: () => stderr, closed: once(child, 'close') };
}

function writeRoute(file, pipeName, generation = crypto.randomUUID()) {
  fs.writeFileSync(file, JSON.stringify({ version: 2, pipeName, generation }), { mode: 0o600 });
}

function defaultProductionStartup(scenario) {
  const directory = path.join(scratch, `default-production-${scenario}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  // No inherited bus, provider credentials, keyring control socket, or owner
  // profile enters this child. The fixed kernel owner endpoint is genuine;
  // state and all home/keyring discovery locations belong to this fixture.
  const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ELECTRON_RUN_AS_NODE: '1' };
  configure(directory, environment);
  Object.assign(environment, {
    HOME: path.join(directory, 'userprofile'),
    USERPROFILE: path.join(directory, 'userprofile'),
    APPDATA: path.join(directory, 'appdata'),
    XDG_DATA_HOME: path.join(directory, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
    XDG_STATE_HOME: path.join(directory, 'xdg-state'),
    XDG_CACHE_HOME: path.join(directory, 'xdg-cache'),
    XDG_RUNTIME_DIR: path.join(directory, 'xdg-runtime'),
    CODEX_HOME: path.join(directory, 'codex-home'),
    TMPDIR: path.join(directory, 'temp'),
    TEMP: path.join(directory, 'temp'),
    TMP: path.join(directory, 'temp'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(directory, 'no-session-bus')}`
  });
  // Exercise the app's normal stateRoot/vault/secrets.json path, not the
  // isolated-environment helper's legacy explicit vault override.
  delete environment.TOOLSENABLED_VAULT_PATH;
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
    'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'TMPDIR', 'TOOLSENABLED_STATE_ROOT']) {
    fs.mkdirSync(environment[key], { recursive: true, mode: 0o700 });
  }
  const vaultDirectory = path.join(environment.TOOLSENABLED_STATE_ROOT, 'vault');
  const vaultFile = path.join(vaultDirectory, 'secrets.json');
  let original;
  if (scenario !== 'absent-directory') fs.mkdirSync(vaultDirectory, { mode: 0o700 });
  if (scenario === 'unsafe-directory') fs.chmodSync(vaultDirectory, 0o755);
  if (scenario === 'legacy-protected-card') {
    original = Buffer.from(JSON.stringify({ payment_card_default: 'fixture-only-not-a-card' }));
    fs.writeFileSync(vaultFile, original, { mode: 0o600 });
  }
  const program = String.raw`
    'use strict';
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const net = require('node:net');
    const path = require('node:path');
    const { once } = require('node:events');
    const owner = require('./src/owner-host');
    const linux = require('./src/lib/owner-host-linux');
    const scenario = process.argv[1];
    const expected = scenario.startsWith('absent-');
    const stateRoot = process.env.TOOLSENABLED_STATE_ROOT;
    (async () => {
      // This exact no-options factory is the Electron-main production call:
      // no allowTestPaths, fake broker, alternate socket or hygiene hook.
      const host = owner.createOwnerHost();
      assert.ok(require.cache[require.resolve('./src/mcp-server')], 'the real broker must load');
      assert.equal(host.capabilityFile, path.join(stateRoot, 'state/owner-host-capability.json'));
      assert.equal(host.pipeName, linux.socketPath(host.generation));
      try {
        if (expected) {
          await host.listen();
          assert.equal(host.isListening(), true);
          assert.equal(host.capabilityPublished(), true);
          assert.deepEqual(linux.readPrivateRecord(host.capabilityFile), {
            version: 2, pipeName: host.pipeName, generation: host.generation
          });
          linux.assertSocket(host.pipeName);
          assert.equal(fs.existsSync(host.controlCapabilityFile), false);
          const socket = net.connect(host.pipeName);
          socket.on('error', () => {});
          try {
            await once(socket, 'connect');
            assert.deepEqual(await linux.assertPeer(socket), {
              pid: process.pid, uid: process.getuid(), gid: process.getgid()
            });
          } finally { socket.destroy(); }
          assert.deepEqual(await require('./src/lib/runtime').scrubPaymentCardSecurityCode(), {
            key: 'payment_card_default', status: 'absent'
          });
        } else {
          await assert.rejects(host.listen(), { code: 'OWNER_HOST_CREDENTIAL_HYGIENE_FAILED' });
          assert.equal(host.isListening(), false);
          assert.equal(host.capabilityPublished(), false);
          assert.equal(fs.existsSync(host.capabilityFile), false);
          assert.equal(fs.existsSync(host.pipeName), false);
        }
      } finally { await host.close(); }
      assert.equal(fs.existsSync(host.capabilityFile), false);
      assert.equal(fs.existsSync(host.controlCapabilityFile), false);
      assert.equal(fs.existsSync(host.pipeName), false);
      process.stdout.write(JSON.stringify({ scenario, passed: true, defaultFactory: true, realBroker: true }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', program, scenario], {
    cwd: ROOT, env: environment, encoding: 'utf8', timeout: 20000,
    maxBuffer: 256 * 1024, windowsHide: true, shell: false
  });
  assert.equal(result.error, undefined, `default production startup child failed: ${result.error?.code}`);
  assert.equal(result.signal, null, `default production startup child was terminated: ${result.signal}`);
  assert.equal(result.status, 0, `default production ${scenario} failed: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true, defaultFactory: true, realBroker: true });
  if (original) assert.deepEqual(fs.readFileSync(vaultFile), original, 'refused legacy card bytes were modified');
  else assert.equal(fs.existsSync(vaultFile), false, 'an absence/refusal must not create a vault');
  if (scenario === 'unsafe-directory') assert.equal(fs.lstatSync(vaultDirectory).mode & 0o777, 0o755);
}

async function main() {
  await check('the account comes from kernel process credentials and rejects elevation or missing IDs', () => {
    const identity = linux.currentIdentity();
    assert.equal(identity.uid, process.getuid());
    assert.equal(identity.gid, process.getgid());
    assert.deepEqual(ownerHost.validatedPrincipals(), {
      ownerPrincipal: `uid:${process.getuid()}`, clientPrincipal: `uid:${process.getuid()}`
    });
    const processInfo = (uid, euid = uid, gid = 1000, egid = gid) => ({
      getuid: () => uid, geteuid: () => euid, getgid: () => gid, getegid: () => egid
    });
    assert.throws(() => linux.currentIdentity(processInfo(0)), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => linux.currentIdentity(processInfo(1000, 0)), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => linux.currentIdentity(processInfo(1000, 1000, 0)), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => linux.currentIdentity(processInfo(1000, 1000, 1000, 1001)), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => linux.currentIdentity({}), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => ownerHost.validatedPrincipals({ platform: 'darwin' }), code('OWNER_HOST_PRINCIPAL_INVALID'));
    assert.throws(() => ownerHost.createOwnerHost({ platform: 'win32' }), code('OWNER_HOST_PRINCIPAL_OVERRIDE_REFUSED'));
    const generation = crypto.randomUUID();
    assert.equal(linux.socketPath(generation), `/run/user/${process.getuid()}/toolsenabled-owner-host/${generation}.sock`);
    assert.equal(linux.validEndpoint(`\0abstract-${generation}`, generation), false);
    assert.equal(linux.validEndpoint(`/tmp/${generation}.sock`, generation), false);
    assert.equal(linux.validSocketPath(`/${'a'.repeat(108)}`), false);
  });

  await check('Windows SID resolution and protected system-binary selection remain intact', () => {
    let invocation;
    const principal = ownerHost.validatedPrincipals({
      platform: 'win32',
      execFileSyncImpl(file, args, options) {
        invocation = { file, args, options };
        return '"TESTHOST\\owner","S-1-5-21-1000"';
      }
    });
    assert.deepEqual(principal, { ownerPrincipal: '*S-1-5-21-1000', clientPrincipal: '*S-1-5-21-1000' });
    assert.equal(invocation.file, '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\whoami.exe');
    assert.deepEqual(invocation.args, ['/user', '/fo', 'csv', '/nh']);
    assert.deepEqual(invocation.options.env, {});
    assert.equal(ownerHost.systemIcacls(), '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe');
  });

  await check('both ends obtain the real peer PID/UID/GID without consuming transport bytes', async () => {
    await linux.checkPrerequisite();
    const pair = await socketPair();
    try {
      let invocation;
      const options = { spawnImpl(file, args, settings) {
        invocation = { file, args, settings };
        return spawn(file, args, settings);
      } };
      const peers = await Promise.all([
        linux.assertPeer(pair.client, process.getuid(), options),
        linux.assertPeer(pair.peer)
      ]);
      assert.deepEqual(peers, [
        { pid: process.pid, uid: process.getuid(), gid: process.getgid() },
        { pid: process.pid, uid: process.getuid(), gid: process.getgid() }
      ]);
      assert.equal(invocation.file, '/usr/bin/python3');
      assert.deepEqual(invocation.args.slice(0, 3), ['-I', '-S', '-c']);
      assert.deepEqual(invocation.settings.env, {});
      assert.equal(invocation.settings.shell, false);
      assert.equal(invocation.settings.cwd, '/');
      assert.equal(typeof invocation.settings.stdio[3], 'number');
      const next = lines(pair.peer);
      pair.client.write('transport-preserved\n');
      assert.equal(await next(), 'transport-preserved');
      await assert.rejects(linux.assertPeer(pair.client, process.getuid() + 1), code('OWNER_HOST_LINUX_PEER_REFUSED'));
      await assert.rejects(linux.readPeerCredentials(pair.client, {
        spawnImpl() { throw Object.assign(new Error('helper missing'), { code: 'ENOENT' }); }
      }), code('OWNER_HOST_LINUX_PEER_UNAVAILABLE'));
    } finally { await pair.close(); }
  });

  await check('a real TCP socket cannot satisfy the Unix peer-credential boundary', async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const accepted = once(server, 'connection');
    const client = net.connect(server.address().port, '127.0.0.1');
    await once(client, 'connect');
    const [peer] = await accepted;
    try {
      await assert.rejects(linux.assertPeer(client), code('OWNER_HOST_LINUX_PEER_UNAVAILABLE'));
    } finally {
      client.destroy();
      peer.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('foreign-owned records, symlinks, broad modes, hard links, and occupied sockets are refused', async () => {
    const directory = path.join(scratch, 'private-socket');
    const socketFile = path.join(directory, 'mcp.sock');
    linux.prepareSocketDirectory(socketFile);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    fs.chmodSync(directory, 0o755);
    assert.throws(() => linux.prepareSocketDirectory(socketFile), code('OWNER_HOST_LINUX_PATH_REFUSED'));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(socketFile, 'occupied');
    assert.throws(() => linux.prepareSocketDirectory(socketFile), code('OWNER_HOST_LINUX_PATH_REFUSED'));
    assert.equal(fs.readFileSync(socketFile, 'utf8'), 'occupied');
    const alias = path.join(scratch, 'alias');
    fs.symlinkSync(directory, alias, 'dir');
    assert.throws(() => linux.prepareSocketDirectory(path.join(alias, 'new.sock')), code('OWNER_HOST_LINUX_PATH_REFUSED'));
    assert.equal(fs.existsSync(path.join(directory, 'new.sock')), false);
    assert.throws(() => linux.readPrivateRecord('/etc/passwd'), code('OWNER_HOST_LINUX_PATH_REFUSED'));
    const routeFile = path.join(scratch, 'private-route.json');
    writeRoute(routeFile, '/tmp/untrusted.sock');
    fs.chmodSync(routeFile, 0o644);
    assert.throws(() => proxy.readCapability(routeFile), code('OWNER_PROXY_CAPABILITY_INVALID'));
    fs.chmodSync(routeFile, 0o600);
    fs.symlinkSync(routeFile, path.join(scratch, 'linked-route.json'));
    assert.throws(() => linux.readPrivateRecord(path.join(scratch, 'linked-route.json')));
    fs.linkSync(routeFile, path.join(scratch, 'hard-route.json'));
    assert.throws(() => linux.readPrivateRecord(routeFile), code('OWNER_HOST_LINUX_PATH_REFUSED'));
  });

  await check('unavailable peer verification and unsafe socket modes send no client credential', async () => {
    const routeDirectory = path.join(scratch, 'refusal-route');
    fs.mkdirSync(routeDirectory, { mode: 0o700 });
    const routeFile = path.join(routeDirectory, 'owner-host-capability.json');
    let bytes = 0;
    let connections = 0;
    const server = net.createServer(socket => {
      connections += 1;
      socket.on('data', chunk => { bytes += chunk.length; });
      socket.on('error', () => {});
    });
    const refusalSocket = path.join(scratch, 'refusal.sock');
    linux.prepareSocketDirectory(refusalSocket);
    server.listen(refusalSocket);
    await once(server, 'listening');
    linux.protectSocket(refusalSocket);
    writeRoute(routeFile, refusalSocket);
    try {
      const absent = startProxy(routeFile, refusalSocket, crypto.randomBytes(32).toString('base64url'), { helperUnavailable: true });
      const [absentExit] = await absent.closed;
      assert.equal(absentExit, 1);
      assert.match(absent.stderr(), /REFUSING TO SERVE/);
      assert.equal(connections, 1);
      assert.equal(bytes, 0, 'the proxy leaked a session credential before peer verification');
      const resolver = startProxy(routeFile, refusalSocket, crypto.randomBytes(32).toString('base64url'), {
        helperUnavailable: true, resolveOnly: true
      });
      const [resolverExit] = await resolver.closed;
      assert.equal(resolverExit, 1);
      assert.equal(resolver.stderr(), 'AGENT_SESSION_CREDENTIAL_UNAVAILABLE');
      assert.equal(connections, 2);
      assert.equal(bytes, 0, 'the session resolver leaked its credential before peer verification');
      fs.chmodSync(refusalSocket, 0o666);
      const unsafe = startProxy(routeFile, refusalSocket, crypto.randomBytes(32).toString('base64url'));
      const [unsafeExit] = await unsafe.closed;
      assert.equal(unsafeExit, 1);
      await assert.rejects(sessionAuthority.resolveAgentSessionCredential(
        crypto.randomBytes(32).toString('base64url'), { routeFile }
      ), code('AGENT_SESSION_CREDENTIAL_UNAVAILABLE'));
      assert.equal(connections, 2, 'an unsafe endpoint was connected despite failed permission checks');
      assert.equal(bytes, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('an unavailable credential reader prevents the host from listening or publishing', async () => {
    const capabilityFile = path.join(scratch, 'unavailable-host.json');
    const host = ownerHost.createOwnerHost({
      allowTestPaths: true,
      pipeName: path.join(scratch, 'unavailable-host.sock'),
      capabilityFile
    });
    hosts.add(host);
    refuseHostReader = true;
    try {
      await assert.rejects(host.listen(), code('OWNER_HOST_LINUX_PEER_UNAVAILABLE'));
      assert.equal(host.server.listening, false);
      assert.equal(fs.existsSync(capabilityFile), false);
      assert.equal(fs.existsSync(host.pipeName), false);
    } finally {
      refuseHostReader = false;
      await host.close();
      hosts.delete(host);
    }
  });

  await check('default production startup uses real hygiene and broker for a genuinely absent private vault', () => {
    defaultProductionStartup('absent-directory');
    defaultProductionStartup('absent-file');
  });

  await check('default production hygiene refuses an unsafe or legacy protected-card vault before publication', () => {
    defaultProductionStartup('unsafe-directory');
    defaultProductionStartup('legacy-protected-card');
  });

  await check('the real host and both clients bind, resolve, enumerate the guarded broker, and revoke', async () => {
    const stores = createInstalledAgentOrgStores({ baselineFile: path.join(ROOT, 'config', 'agent-org.json') });
    const snapshot = stores.read();
    const agent = snapshot.org.agents.find(candidate => candidate.enabled && candidate.role !== 'controller'
      && ['codex', 'claude'].includes(candidate.provider));
    assert.ok(agent, 'the shipped org must provide a non-root seat for the isolated authority test');
    const role = stores.roleStore.getRoleRecord(agent.role);
    const binding = {
      sessionId: `linux-session-${crypto.randomUUID()}`, agentId: agent.id,
      provider: agent.provider, roleId: agent.role,
      expectedOrgRevision: snapshot.org.revision, expectedRoleRevision: role.revision
    };
    const routeDirectory = path.join(scratch, 'real-host');
    fs.mkdirSync(routeDirectory, { mode: 0o700 });
    const capabilityFile = path.join(routeDirectory, 'owner-host-capability.json');
    const host = ownerHost.createOwnerHost({
      allowTestPaths: true,
      pipeName: path.join(scratch, 'real-host.sock'),
      capabilityFile,
      sessionRetirementLogFile: path.join(scratch, 'retirements.jsonl')
    });
    hosts.add(host);
    await host.listen();
    const route = proxy.readCapability(capabilityFile, {
      TOOLSENABLED_TEST_ISOLATED: '1', TOOLSENABLED_TEST_OWNER_HOST_PIPE: host.pipeName
    });
    assert.equal(route.pipeName, host.pipeName);
    assert.equal(fs.statSync(capabilityFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(host.pipeName).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(host.controlCapabilityFile), false, 'production authority must remain in app memory');
    assert.throws(() => proxy.readCapability(capabilityFile, {}), code('OWNER_PROXY_CAPABILITY_INVALID'),
      'a production client accepted an endpoint outside its fixed login-session directory');
    const bound = await host.bindSession(binding);
    assert.equal(bound.bound, true);
    // A valid credential is insufficient when the accepting host cannot read
    // the kernel peer identity. Only the external reader fails here; the
    // listener, session binding, and credential are real.
    refuseHostReader = true;
    const rejected = net.connect(host.pipeName);
    let received = 0;
    rejected.on('data', chunk => { received += chunk.length; });
    rejected.on('error', () => {});
    rejected.once('connect', () => rejected.write(`${JSON.stringify({
      type: 'authorize-session', credential: bound.credential
    })}\n${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })}\n`));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('host accepted a credential without peer verification')), 3000);
        rejected.once('close', () => { clearTimeout(timer); resolve(); });
      });
      assert.equal(received, 0, 'the host dispatched or authorized before checking its kernel peer');
      assert.equal(host.sessionBindings.has(bound.credential), true, 'a failed transport check retired an unrelated valid binding');
    } finally { refuseHostReader = false; rejected.destroy(); }
    const resolved = await sessionAuthority.resolveAgentSessionCredential(bound.credential, { routeFile: capabilityFile });
    assert.deepEqual(resolved, binding);
    const client = startProxy(capabilityFile, host.pipeName, bound.credential);
    const request = async (id, method, params = {}) => {
      client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const answer = JSON.parse(await client.next());
      assert.equal(answer.id, id);
      assert.equal(answer.error, undefined);
      return answer.result;
    };
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.serverInfo.name, 'toolsenabled');
    const listed = await request(2, 'tools/list');
    assert.ok(listed.tools.length > 0, 'the authenticated production broker returned no tools');
    assert.equal(listed.tools.some(tool => tool.name === 'host.exec'), false,
      'Linux transport widened the no-machine-record permission tier');
    assert.deepEqual(host.sessionBindings.get(bound.credential).permissionSession, {
      origin: 'local', tier: 'confined', profile: 'read-only'
    });
    await host.revokeSession({ ...binding, credential: bound.credential });
    // The maintained proxy keeps a bounded, named refusal surface alive so
    // the provider can read why access ended. Prove revocation on the wire
    // before ending the client input, rather than waiting out that linger.
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' })}\n`);
    const revoked = JSON.parse(await client.next(30_000)); // Production backoff totals 12.5s before its named refusal.
    assert.equal(revoked.id, 20);
    assert.equal(revoked.error.data.code, proxy.TRANSPORT_LOST_CODES.SESSION_ENDED);
    client.child.stdin.end();
    const [exitCode] = await client.closed;
    assert.equal(exitCode, 1);
    assert.match(client.stderr(), /ended this session's tool access/);
    await assert.rejects(sessionAuthority.resolveAgentSessionCredential(bound.credential, { routeFile: capabilityFile }),
      code('AGENT_SESSION_CREDENTIAL_REFUSED'));

    // A real org edit must invalidate the next line on Linux as on Windows.
    const nextBinding = { ...binding, sessionId: `${binding.sessionId}-next` };
    const second = await host.bindSession(nextBinding);
    const nextClient = startProxy(capabilityFile, host.pipeName, second.credential);
    nextClient.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`);
    assert.deepEqual(JSON.parse(await nextClient.next()).result, {});
    stores.orgStore.releaseSeat({ id: agent.id });
    nextClient.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n`);
    const orgRevoked = JSON.parse(await nextClient.next(30_000));
    assert.equal(orgRevoked.id, 4);
    assert.equal(orgRevoked.error.data.code, proxy.TRANSPORT_LOST_CODES.SESSION_ENDED);
    nextClient.child.stdin.end();
    const [revokedExit] = await nextClient.closed;
    assert.equal(revokedExit, 1);
    assert.equal(host.sessionBindings.has(second.credential), false);
    assert.match(nextClient.stderr(), /ended this session's tool access/);
    await host.close();
    assert.equal(fs.existsSync(capabilityFile), false);
    assert.equal(fs.existsSync(host.pipeName), false);
    hosts.delete(host);
  });
}

main().then(() => process.stdout.write(`Linux owner-host acceptance passed (${checks} checks).\n`))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    for (const child of children) child.kill();
    for (const host of hosts) await host.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
