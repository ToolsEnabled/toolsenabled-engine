#!/usr/bin/env node
'use strict';

// Posts a fixed, secret-free FRA lifecycle notice to the canonical chat-only
// relay on the registry-selected peer. The local 8787 listener is not the shared bus.
// The bearer credential is loaded in-process and is never accepted on argv,
// returned, persisted, or included in an error projection.

const http = require('node:http');
const { getSecret } = require('../src/lib/runtime');
const {
  assertSanctionedMachineAddress,
  machineAddressPolicy,
  resolveServiceOrThrow,
  ServiceRegistryError
} = require('../src/lib/service-registry');

const HOSTS = machineAddressPolicy().addresses;
const REASONS = Object.freeze([
  'unhealthy_listener',
  'committed_rotation',
  'rollback_recovery'
]);
const PORT = 8787;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

function fail(code) { throw Object.assign(new Error(code), { code }); }

function request(host, token, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host,
      port: PORT,
      path: '/v1/messages',
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(bytes.length),
        connection: 'close'
      }
    }, response => {
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        chunk.fill(0);
        if (received > MAX_RESPONSE_BYTES) response.destroy();
      });
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'LINK_BUS_NOTICE_TIMEOUT' })));
    req.once('error', reject);
    req.end(bytes, () => bytes.fill(0));
  });
}

async function announce({
  host,
  reason,
  tokenLoader = () => getSecret('custom.link_bus_bridge_token', { prompt: false }),
  requestFn = request,
  now = () => new Date().toISOString(),
  serviceRegistryOptions = {}
} = {}) {
  try { assertSanctionedMachineAddress(host, serviceRegistryOptions); }
  catch (error) {
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'].includes(error.code)) {
      fail('FRA_NOTICE_ARGUMENT_INVALID');
    }
    throw error;
  }
  if (!REASONS.includes(reason)) fail('FRA_NOTICE_ARGUMENT_INVALID');
  const token = tokenLoader();
  if (typeof token !== 'string' || token.length < 1) fail('FRA_NOTICE_TOKEN_UNAVAILABLE');
  const body = Object.freeze({
    channel: 'team',
    sender: `fra-lifecycle-${host}`,
    message: `FRA lifecycle on ${host} will restart only its local encrypted 8790 listener; Tunnel 8787 and Bridge 8788 remain untouched. reason=${reason}`,
    sentAt: now()
  });
  const status = await requestFn(resolveServiceOrThrow('shared-agent-bus', serviceRegistryOptions).host, token, body);
  if (status !== 200 && status !== 201) fail('FRA_NOTICE_REJECTED');
  return Object.freeze({
    ok: true,
    host,
    reason,
    canonicalRelayNotified: true,
    relaysNotified: 1,
    messageBodyEmitted: false,
    secretValuesEmitted: false
  });
}

function parseCli(argv, serviceRegistryOptions = {}) {
  let host = null;
  let reason = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host' && argv[index + 1]) host = argv[++index];
    else if (argv[index] === '--reason' && argv[index + 1]) reason = argv[++index];
    else fail('FRA_NOTICE_ARGUMENT_INVALID');
  }
  const hosts = machineAddressPolicy(serviceRegistryOptions).addresses;
  if (!hosts.includes(host) || !REASONS.includes(reason)) fail('FRA_NOTICE_ARGUMENT_INVALID');
  return { host, reason };
}

if (require.main === module) {
  announce(parseCli(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_.-]{1,100}$/.test(error.code)
      ? error.code : 'FRA_NOTICE_FAILED';
    process.stdout.write(`${JSON.stringify({ ok: false, code, secretValuesEmitted: false })}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ HOSTS, REASONS, PORT, announce, parseCli, request });
