'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {
  VAULT_KEY, BOOTSTRAP_VAULT_KEY, ENROLL_PATH, ENROLL_PORT, ENROLL_TIMEOUT_MS,
  RUNTIME_INTEGRITY_TIMEOUT_MS, TOKEN_RE, CONTROL_SCRIPT, RUNTIME_INTEGRITY_SCRIPT,
  peerForHost, sealEnrollmentToken, openEnrollmentToken,
  startFixedRestart, runFixedRuntimeIntegrity,
  createFullRemoteAccessEnrollServer
} = require('../tools/full-remote-access-enroll-token');

// Every peer resolution below runs against an INJECTED registry, so this test
// no longer depends on the builder's machine-local config/machines.profile.json
// -- the two addresses are RFC 5737 documentation addresses, and the fixture is
// the same shape tests/fra-machine-identity.js injects.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryOptions = { registry: lab };

function request(port, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: ENROLL_PATH,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function run() {
  assert.equal(VAULT_KEY, 'custom.full_remote_access_token');
  assert.equal(BOOTSTRAP_VAULT_KEY, 'custom.remote_agent_bridge_token');
  assert.equal(ENROLL_PORT, 8793);
  assert.equal(ENROLL_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  assert.equal(RUNTIME_INTEGRITY_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  assert.equal(peerForHost('203.0.113.1', serviceRegistryOptions), '203.0.113.2');
  assert.equal(peerForHost('203.0.113.2', serviceRegistryOptions), '203.0.113.1');
  assert.equal(TOKEN_RE.test('A'.repeat(43)), true);
  assert.equal(TOKEN_RE.test('A'.repeat(42)), false);

  let captured = null;
  let settled = 0;
  const bootstrapSecret = 'bridge-bootstrap-secret-for-tests';
  const now = Date.now();
  const server = createFullRemoteAccessEnrollServer({
    host: '203.0.113.1',
    serviceRegistryOptions,
    allowedRemoteRe: /^127\.0\.0\.1$/,
    bootstrapSecret,
    now,
    writeToVault: async token => { captured = token; },
    onSettled: () => { settled += 1; },
    log: () => {}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const invalid = await request(port, { token: 'too-short' });
    assert.equal(invalid.status, 400);
    assert.equal(captured, null);

    const token = 'B'.repeat(43);
    const envelope = sealEnrollmentToken({
      token, bootstrapSecret, sourceHost: '203.0.113.2', targetHost: '203.0.113.1', now,
      serviceRegistryOptions, randomBytes: size => Buffer.alloc(size, size)
    });
    assert.equal(openEnrollmentToken({
      envelope, bootstrapSecret, sourceHost: '203.0.113.2', targetHost: '203.0.113.1', now,
      serviceRegistryOptions
    }), token);
    assert.throws(() => openEnrollmentToken({
      envelope: { ...envelope, tag: 'A'.repeat(22) }, bootstrapSecret,
      sourceHost: '203.0.113.2', targetHost: '203.0.113.1', now, serviceRegistryOptions
    }), /FRA_ENROLLMENT_/);
    const accepted = await request(port, envelope);
    assert.equal(accepted.status, 200);
    assert.equal(captured, token);
    assert.equal(settled, 1);

    const replay = await request(port, envelope);
    assert.equal(replay.status, 410);
    assert.equal(captured, token);
    assert.equal(settled, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  let invocation = null;
  const child = {
    handlers: {}, unrefCalled: false,
    once(name, handler) { this.handlers[name] = handler; return this; },
    unref() { this.unrefCalled = true; }
  };
  const restart = startFixedRestart({
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.handlers.spawn());
      return child;
    }
  });
  assert.equal(await restart, true);
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(-4), ['-File', CONTROL_SCRIPT, '-Action', 'Restart']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.detached, true);
  assert.equal(child.unrefCalled, true);
  assert.doesNotMatch(JSON.stringify(invocation), /BBBB|custom\.remote_agent_bridge_token/);

  const spawnFailure = new Error('restart unavailable');
  await assert.rejects(startFixedRestart({
    spawnImpl() {
      const handlers = {};
      queueMicrotask(() => handlers.error(spawnFailure));
      return { once(name, handler) { handlers[name] = handler; return this; } };
    }
  }), spawnFailure);

  let integrityInvocation = null;
  await runFixedRuntimeIntegrity({
    host: '203.0.113.1',
    // The fixture registry, same as every other call in this file. Without it
    // this resolved against the machine-local registry and only passed on the
    // builder's own machine.
    serviceRegistryOptions,
    spawnImpl(command, args, options) {
      integrityInvocation = { command, args, options };
      const handlers = {};
      queueMicrotask(() => handlers.exit(0));
      return { once(name, handler) { handlers[name] = handler; return this; }, kill() {} };
    }
  });
  assert.equal(integrityInvocation.command, process.execPath);
  assert.deepEqual(integrityInvocation.args, [
    RUNTIME_INTEGRITY_SCRIPT, '--check', '--host', '203.0.113.1'
  ]);
  assert.equal(integrityInvocation.options.stdio, 'ignore');
  assert.doesNotMatch(JSON.stringify(integrityInvocation), /BBBB|full_remote_access_token|remote_agent_bridge_token/);

  console.log('Full Remote Access one-shot credential enrollment tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
