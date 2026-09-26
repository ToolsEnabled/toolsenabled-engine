// Mutation check:
// Changed the module's ECONNREFUSED/ECONNRESET classification from 'DOWN' to 'UNKNOWN'.
// The edit landed: yes (the replacement was found in service-registry-probe.js).
// This test file went red: yes (exit 1 at the ECONNREFUSED assertion).

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

const {
  classifyProbeError,
  defaultHttpProbe,
  resolveAndProbe
} = require('../src/lib/service-registry-probe');

function registryWith(service) {
  return {
    schemaVersion: 1,
    machines: { target: { address: '127.0.0.1' } },
    services: { checked: { resolution: 'fixed', fixedMachine: 'target', ...service } }
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function main() {
  assert.equal(classifyProbeError({ code: 'ECONNREFUSED' }), 'DOWN');
  assert.equal(classifyProbeError({ name: 'ECONNRESET' }), 'DOWN');
  assert.equal(classifyProbeError({ code: 'ETIMEDOUT' }), 'UNKNOWN');
  assert.equal(classifyProbeError(null), 'UNKNOWN');

  const server = await listen((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/ready');
    response.writeHead(204).end();
  });
  try {
    const address = server.address();
    const result = await defaultHttpProbe({
      host: address.address,
      port: address.port,
      pathName: '/ready',
      timeoutMs: 1_000
    });
    assert.deepEqual(result, { reachability: 'UP', status: 204 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const calls = [];
  const probed = await resolveAndProbe('checked', {
    registry: registryWith({ port: 4321, healthPath: '/healthz' }),
    timeoutMs: 73,
    httpProbe: async value => {
      calls.push(value);
      return { reachability: 'UP', status: 299 };
    }
  });
  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 4321, pathName: '/healthz', timeoutMs: 73 }]);
  assert.equal(probed.reachability, 'UP');
  assert.equal(probed.probeStatus, 299);
  assert.equal(Object.isFrozen(probed), true);

  let unsupportedProbeCalled = false;
  const unsupported = await resolveAndProbe('checked', {
    registry: registryWith({ port: 4321 }),
    httpProbe: async () => { unsupportedProbeCalled = true; return { reachability: 'UP' }; }
  });
  assert.equal(unsupportedProbeCalled, false);
  assert.equal(unsupported.reachability, 'UNKNOWN');
  assert.match(unsupported.probeError, /no healthPath declared/);

  let unknownProbeCalled = false;
  const unknown = await resolveAndProbe('missing', {
    registry: registryWith({ port: 4321, healthPath: '/healthz' }),
    httpProbe: async () => { unknownProbeCalled = true; return { reachability: 'UP' }; }
  });
  assert.equal(unknownProbeCalled, false);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'SERVICE_UNKNOWN');

  process.stdout.write('service-registry-probe behaviour passed\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
