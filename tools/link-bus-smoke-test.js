#!/usr/bin/env node
'use strict';

// Verifies the chat-only link bus without ever printing message bodies or the
// vault-backed bearer token. The authenticated read is drained through the
// positioned paging helper: it can only report caught-up after an explicit
// cursor/head confirmation, and never emits message bodies.
const http = require('node:http');
const { createSafePagingHelper } = require('../src/lib/agent-comms/read-position');
const { directionalMachinePair, machineAddressPolicy } = require('../src/lib/service-registry');

const ALLOWED_HOSTS = new Set(machineAddressPolicy().addresses);
// Capture the caller-selected peer before the runtime loads repo environment
// defaults. This keeps an explicit smoke target from being silently replaced.
const HOST = String(process.env.LINK_BUS_HOST || (() => {
  try { return directionalMachinePair().coordinatorMachine.address; }
  catch { return ''; }
})()).trim();
const PORT = 8787;
// Page size and the response cap are ONE decision, not two. They were once
// independent literals (pageSize 200 against a 64 KiB cap), so as real traffic
// accumulated a single page outgrew the cap and this probe destroyed its own
// socket: a measured page of 200 messages was 130,636 bytes, so every
// authenticated read failed LINK_BUS_RESPONSE_TOO_LARGE and the smoke test
// could no longer pass on a HEALTHY bus.
//
// b0e07ba fixed that by taking the page size from transport-relay's
// DEFAULT_PAGE_SIZE, which only MOVED the coupling instead of removing it. The
// relay is a different subsystem with different callers and a different
// envelope, so tuning it to 25 silently retuned this probe from 200 to 25 per
// page: 61 round trips where 8 would do, which widens the window in which a
// concurrent write ends the drain with HEAD_MOVED and this probe reports FAIL
// against a completely healthy bus.
//
// The probe's page size is not a free parameter. It is the link bus server's
// own maximum page (sidecars/link-bus/store.js MAX_PAGE_SIZE): asking for more
// is silently truncated to it, and asking for less only buys extra round trips
// and a wider HEAD_MOVED race. tests/link-bus-smoke-test.js asserts that this
// value and the server's maximum still agree, so neither can drift alone.
const READ_PAGE_SIZE = 200;
const MAX_MESSAGE_ENVELOPE_BYTES = 8 * 1024;
// A real derivation, not a nominal one: the cap must hold one whole page at the
// envelope ceiling. The previous Math.max(256 KiB, ...) floor silently won for
// every page size at or below 32, so the "cannot drift again" guarantee did not
// actually apply at the size that was in use.
const MAX_RESPONSE_BYTES = READ_PAGE_SIZE * MAX_MESSAGE_ENVELOPE_BYTES;
const REQUEST_TIMEOUT_MS = 10_000;
const SMOKE_START_CURSOR = 0;
const { getSecret } = require('../src/lib/runtime');

function request(host, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port: PORT,
      path,
      method,
      headers,
      timeout: REQUEST_TIMEOUT_MS
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy(new Error('LINK_BUS_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('LINK_BUS_REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
}

function positionedPage(json, cursor) {
  const nextCursor = Number(json.cursor);
  if (!Array.isArray(json.messages)
    || !Number.isSafeInteger(json.requestedCursor)
    || !Number.isSafeInteger(json.headSequence)
    || !Number.isSafeInteger(json.backlogCount)
    || typeof json.caughtUp !== 'boolean'
    || typeof json.status !== 'string'
    || !Number.isSafeInteger(nextCursor)
    || json.requestedCursor !== cursor
    || json.headSequence < 0
    || json.backlogCount !== Math.max(0, json.headSequence - cursor)
    || json.caughtUp !== (cursor === json.headSequence)) {
    throw new Error('LINK_BUS_POSITION_INVALID');
  }
  return { headSequence: json.headSequence, nextCursor, records: json.messages };
}

async function runSmoke({
  host = HOST,
  tokenLoader = () => getSecret('custom.link_bus_bridge_token', { prompt: false }),
  requestFn = (path, options) => request(host, path, options),
  write = value => console.log(value)
} = {}) {
  if (!host) throw new Error('LINK_BUS_TWO_MACHINE_SETUP_REQUIRED');
  if (!ALLOWED_HOSTS.has(host)) throw new Error('LINK_BUS_HOST_NOT_ALLOWED');
  const token = tokenLoader();
  if (typeof token !== 'string' || token.length < 1) throw new Error('LINK_BUS_TOKEN_UNAVAILABLE');

  const health = await requestFn('/health');
  const healthJson = parseJson(health, 'HEALTH');

  const authenticatedReadStatuses = [];
  const safePaging = createSafePagingHelper({
    pageSize: READ_PAGE_SIZE,
    async readPage({ cursor, limit }) {
      const messages = await requestFn(`/v1/messages?channel=team&cursor=${cursor}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      authenticatedReadStatuses.push(messages.status);
      const messagesJson = parseJson(messages, 'MESSAGES');
      return positionedPage(messagesJson, cursor);
    }
  });
  const drained = await safePaging.drain({ cursor: SMOKE_START_CURSOR, collect: false });
  // An empty status list means no authenticated read was measured. Do not let
  // Array#every's vacuous truth turn that into a synthetic HTTP 200. Likewise,
  // if any page failed, retain that page's status rather than reporting the
  // final page (which may itself have been 200) as the result of the drain.
  const authenticatedReadStatus = authenticatedReadStatuses.length === 0
    ? null
    : authenticatedReadStatuses.find(status => status !== 200) ?? 200;
  const messageShapeValid = authenticatedReadStatuses.length > 0
    && drained.status === 'CAUGHT_UP'
    && drained.caughtUp === true
    && drained.backlogCount === 0
    && drained.recordsRead >= 0;

  const noAuth = await requestFn('/v1/messages?channel=team');
  const wrongAuth = await requestFn('/v1/messages?channel=team', {
    headers: { Authorization: 'Bearer link-bus-smoke-intentionally-invalid' }
  });
  const unauthenticatedPostBody = JSON.stringify({
    channel: 'team',
    sender: 'link-bus-smoke',
    message: 'must-not-be-written',
    sentAt: '1970-01-01T00:00:00.000Z'
  });
  const noAuthPost = await requestFn('/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(unauthenticatedPostBody)
    },
    body: unauthenticatedPostBody
  });
  const toolsBoundary = await requestFn('/tools/list');
  const fraBoundary = await requestFn('/v1/full-remote-access');

  const checks = {
    host,
    healthStatus: health.status,
    healthShapeValid: healthJson.ok === true
      && Number.isSafeInteger(healthJson.messages)
      && healthJson.messages >= 0,
    authenticatedReadStatus,
    authenticatedReadPages: authenticatedReadStatuses.length,
    authenticatedReadShapeValid: messageShapeValid,
    unauthenticatedReadStatus: noAuth.status,
    invalidTokenReadStatus: wrongAuth.status,
    unauthenticatedWriteStatus: noAuthPost.status,
    toolsBoundaryStatus: toolsBoundary.status,
    fullRemoteBoundaryStatus: fraBoundary.status,
    responseBodiesEmitted: false,
    secretValuesEmitted: false
  };
  const ok = checks.healthStatus === 200
    && checks.healthShapeValid
    && checks.authenticatedReadStatus === 200
    && checks.authenticatedReadShapeValid
    && checks.unauthenticatedReadStatus === 401
    && checks.invalidTokenReadStatus === 401
    && checks.unauthenticatedWriteStatus === 401
    && checks.toolsBoundaryStatus === 404
    && checks.fullRemoteBoundaryStatus === 404;
  write(JSON.stringify({ ...checks, result: ok ? 'PASS' : 'FAIL' }, null, 2));
  return Object.freeze({ ok, checks: Object.freeze({ ...checks }) });
}

function safeErrorCode(error) {
  const value = error && typeof error.message === 'string' ? error.message : '';
  return /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'LINK_BUS_SMOKE_FAILED';
}

async function main() {
  try {
    const result = await runSmoke();
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`SMOKE TEST: ERROR ${safeErrorCode(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  ALLOWED_HOSTS,
  SMOKE_START_CURSOR,
  READ_PAGE_SIZE,
  MAX_MESSAGE_ENVELOPE_BYTES,
  MAX_RESPONSE_BYTES,
  runSmoke,
  safeErrorCode
});
