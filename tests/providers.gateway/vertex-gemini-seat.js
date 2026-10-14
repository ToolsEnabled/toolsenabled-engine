'use strict';

require('../lib/isolated-environment').activate('vertex-gemini-seat');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

// Production identities are commitments, not shipped literals. Give this
// isolated process fixture preimages while retaining real SHA-256 otherwise.
const fixtureIdentity = { alias: 'seat-test', email: 'seat-test@example.com', projectId: 'seat-test-project' };
const fixtureDigests = new Map([
  [fixtureIdentity.alias, 'cb22ca177814c1fcc43afbe3b37ff7ff875099d6c116169781ca503bdd81be07'],
  [fixtureIdentity.email, 'cdeb46d7d4fa662874dd4e760d8f48440f0314fda733f9d9696f3ad95732e0b8'],
  [fixtureIdentity.projectId, '5747bffb641d35270b5ae4ceda65752a6c9213f315fde02ae7ab691b92b4ff56']
]);
const realCreateHash = crypto.createHash;
crypto.createHash = function createHash(algorithm, options) {
  const hash = realCreateHash.call(this, algorithm, options);
  let input;
  const update = hash.update.bind(hash);
  hash.update = (value, encoding) => { input = String(value); update(value, encoding); return hash; };
  const digest = hash.digest.bind(hash);
  hash.digest = encoding => encoding === 'hex' && fixtureDigests.has(input) ? fixtureDigests.get(input) : digest(encoding);
  return hash;
};

// Importing the provider needs these only as defaults. Every tested call
// injects local state/audit fixtures, so importing must not open live stores.
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../audit' && parent && /[\\/]providers[\\/]/.test(parent.filename)) return { record() {}, scrubText: value => value };
  if (request === '../state-store' && parent && /[\\/]providers[\\/]/.test(parent.filename)) return { getStateStore: () => ({}) };
  return realLoad.call(this, request, parent, isMain);
};
const seat = require('../../src/lib/providers/vertex-gemini-seat');
Module._load = realLoad;

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function throws(operation, expected) {
  assert.throws(operation, error => error && error.code === expected, `expected refusal ${expected}`);
  checks += 1;
}
async function rejects(expected, operation) {
  await assert.rejects(operation, error => error && error.code === expected, `expected refusal ${expected}`);
  checks += 1;
}

function config(overrides = {}) {
  return {
    version: 2, routeKind: 'vertex-seat', execution: 'enabled', ownerDeclaredSeat: true,
    runtimeVerified: true, accountAlias: fixtureIdentity.alias, accountEmail: fixtureIdentity.email,
    projectId: fixtureIdentity.projectId, location: 'global', model: seat.MODEL,
    thinkingLevel: 'HIGH', dailyCostCapUsd: 10,
    authEvidence: {
      gcloudUserCredential: 'observed', accountProjectBinding: 'direct-role-evidence',
      vertexAiServiceEnabled: 'observed', seatOrBillingEntitlement: 'owner-declared'
    }, ...overrides
  };
}

function registry(overrides = {}) {
  return {
    resolve: () => fixtureIdentity.alias,
    load: () => ({ accounts: { [fixtureIdentity.alias]: { email: fixtureIdentity.email } } }),
    list: () => [{ alias: fixtureIdentity.alias, email: fixtureIdentity.email }],
    ...overrides
  };
}

function response(text = 'answer', overrides = {}) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 4, totalTokenCount: 9 },
    ...overrides
  };
}

function fixture(overrides = {}) {
  const calls = { audit: [], spend: [], usage: [], requests: [] };
  const deps = {
    seatConfig: config(), accountRegistry: registry(), assertActive() {}, gcloudAvailable: () => true,
    run(command, args) {
      if (args[0] === 'auth' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ account: fixtureIdentity.email, status: 'ACTIVE' }]), stderr: '' };
      if (args[0] === 'auth' && args[1] === 'print-access-token') return { status: 0, stdout: 'fixture-access-token', stderr: '' };
      throw new Error(`unexpected gcloud call: ${args.join(' ')}`);
    },
    request: async (body, token, options) => { calls.requests.push({ body, token, options }); return response(); },
    state: {
      recordSpend: value => calls.spend.push(value),
      recordModelUsage: value => calls.usage.push(value)
    },
    record: (...args) => calls.audit.push(args), usageAttribution: {}, now: () => 100, randomId: () => 'fixed',
    ...overrides
  };
  return { calls, deps };
}

function fakeRequest(status, body, options = {}) {
  return (_requestOptions, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      if (options.requestError) return request.emit('error', new Error('offline'));
      if (options.timeout) return request.emit('timeout');
      const res = new EventEmitter();
      res.statusCode = status;
      res.destroy = () => {};
      callback(res);
      if (options.responseError) return res.emit('error', new Error('offline'));
      for (const chunk of (Array.isArray(body) ? body : [Buffer.from(body || '')])) res.emit('data', chunk);
      res.emit('end');
    };
    request.destroy = () => {};
    return request;
  };
}

(async () => {
  // The fixed seat identity, registry, route, model, generation budget, and
  // input schema all refuse uncertainty or caller-controlled alternatives.
  equal(seat._testing.configuration({ seatConfig: config() }).projectId, fixtureIdentity.projectId);
  for (const invalid of [null, {}, config({ version: 1 }), config({ projectId: 'other' }), config({ extra: true })]) {
    throws(() => seat._testing.configuration({ seatConfig: invalid }), 'VERTEX_SEAT_CONFIGURATION_INVALID');
  }
  throws(() => seat._testing.exactConfiguration({ seatConfig: config(), accountRegistry: registry({ list: () => [] }) }), 'VERTEX_SEAT_ACCOUNT_REGISTRY_MISMATCH');
  throws(() => seat._testing.modelPath('not-approved', fixtureIdentity.projectId), 'VERTEX_SEAT_MODEL_INVALID');
  for (const value of [-1, 8193, 1.5]) throws(() => seat._testing.totalGenerationTokens(value), 'VERTEX_SEAT_OUTPUT_BUDGET_EXCEEDED');
  equal(seat._testing.totalGenerationTokens(256), 256 + seat.THINKING_TOKEN_RESERVE);

  for (const invalid of [{}, { prompt: ' ' }, { prompt: 'x', tool: true }, { prompt: 'x', model: 'caller-model' },
    { prompt: 'x', maxOutputTokens: 255 }, { prompt: 'x', maxOutputTokens: 8193 }, { prompt: 'x', selfReview: 'yes' }]) {
    throws(() => seat._testing.boundedInput(invalid), 'VERTEX_SEAT_INPUT_INVALID');
  }
  throws(() => seat._testing.boundedInput({ prompt: 'Authorization: Bearer fixture-secret-token' }), 'VERTEX_SEAT_SENSITIVE_INPUT');

  // Responses are bounded visible text only. Tool-like parts, ambiguous
  // fields, hidden thoughts, malformed accounting, and unsafe finish reasons fail.
  const invalidResponses = [
    null, {}, { candidates: [] }, response('x', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    response('x', { candidates: [{ content: { parts: [{ functionCall: {} }] }, finishReason: 'STOP' }] }),
    response('x', { candidates: [{ content: { parts: [{ text: 'x', mystery: true }] }, finishReason: 'STOP' }] }),
    response('x', { candidates: [{ content: { parts: [{ text: 2 }] }, finishReason: 'STOP' }] }),
    response(' '), response('x', { usageMetadata: undefined }),
    response('x', { usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1, totalTokenCount: 1 } }),
    response('x', { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 4, totalTokenCount: 8 } }),
    response('x', { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'NEW_REASON' }] })
  ];
  for (const value of invalidResponses) throws(() => seat._testing.completion(value), 'VERTEX_SEAT_RESPONSE_INVALID');
  throws(() => seat._testing.completion(response('x'.repeat(seat.MAX_OUTPUT_CHARS + 1))), 'VERTEX_SEAT_OUTPUT_TOO_LARGE');
  const parsed = seat._testing.completion(response('visible', { candidates: [{ content: { parts: [{ text: 'secret thought', thought: true }, { text: 'visible' }] }, finishReason: 'STOP' }] }));
  equal(parsed.output, 'visible', 'hidden thought text is never emitted');
  deepEqual(parsed.receipt, { finishReason: 'STOP', finishState: 'stop', visibleChars: 7, visibleTokens: 3 });

  // HTTP/network states map to stable typed refusals; no live request occurs.
  const request = (factory, token = 'fixture-access-token', body = {}) => seat.vertexRequest(body, token, { model: seat.MODEL, projectId: fixtureIdentity.projectId, timeoutMs: 5, request: factory });
  await rejects('VERTEX_SEAT_AUTH_FAILED', request(fakeRequest(200, '{}'), 'short'));
  await rejects('VERTEX_SEAT_INPUT_INVALID', request(fakeRequest(200, '{}'), 'fixture-access-token', { data: 'x'.repeat(256 * 1024) }));
  for (const status of [401, 403]) await rejects('VERTEX_SEAT_AUTH_FAILED', request(fakeRequest(status, '{}')));
  await rejects('VERTEX_SEAT_RATE_LIMITED', request(fakeRequest(429, '{}')));
  await rejects('VERTEX_SEAT_MODEL_UNAVAILABLE', request(fakeRequest(404, JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: `${seat.MODEL} model not found` } }))));
  await rejects('VERTEX_SEAT_API_REJECTED', request(fakeRequest(400, '{}')));
  await rejects('VERTEX_SEAT_API_UNAVAILABLE', request(fakeRequest(500, '{}')));
  await rejects('VERTEX_SEAT_API_UNAVAILABLE', request(fakeRequest(200, '', { requestError: true })));
  await rejects('VERTEX_SEAT_API_UNAVAILABLE', request(fakeRequest(200, '', { responseError: true })));
  await rejects('VERTEX_SEAT_TIMEOUT', request(fakeRequest(200, '', { timeout: true })));
  await rejects('VERTEX_SEAT_RESPONSE_INVALID', request(fakeRequest(200, 'not-json')));
  await rejects('VERTEX_SEAT_RESPONSE_TOO_LARGE', request(fakeRequest(200, Buffer.alloc(2 * 1024 * 1024 + 1))));
  deepEqual(await request(fakeRequest(200, '{"ok":true}')), { ok: true });

  // Status never discloses identity before configuration and names both gates.
  const blocked = seat.seatStatus({ seatConfig: null });
  equal(blocked.execution, 'blocked');
  equal(blocked.metering.accountAlias, 'unattributed');
  equal(blocked.missing[0].code, 'VERTEX_SEAT_CONFIGURATION_INVALID');
  equal(blocked.metering.unavailableReason, 'provider-not-configured', 'a genuine absent configuration retains its definite status');
  let configurationReads = 0;
  const busyRead = () => { configurationReads += 1; throw Object.assign(new Error('busy'), { code: 'EMFILE' }); };
  const indeterminate = seat.seatStatus({ readConfig: busyRead });
  equal(indeterminate.missing[0].code, 'VERTEX_SEAT_CONFIGURATION_UNAVAILABLE');
  equal(indeterminate.metering.unavailableReason, 'configuration-check-failed');
  equal(indeterminate.missing[0].action, 'Retry the Vertex-seat configuration check; no absence was established.');
  equal(configurationReads, 1, 'a failed configuration read is attempted rather than cached');
  equal(seat._testing.configuration({ seatConfig: config() }, busyRead).projectId, fixtureIdentity.projectId,
    'a could-not-check result is not latched over the next configuration check');
  equal(configurationReads, 1, 'an injected configuration remains the established no-read fast path');
  const pending = seat.seatStatus({ seatConfig: config({ runtimeVerified: false }), accountRegistry: registry() });
  equal(pending.ready, false);
  equal(pending.canRunBoundedProbe, true);
  equal(pending.missing[0].code, 'VERTEX_SEAT_RUNTIME_VERIFICATION_PENDING');
  const mismatch = seat.seatStatus({ seatConfig: config(), accountRegistry: registry({ list: () => [] }) });
  equal(mismatch.canRunBoundedProbe, false);
  equal(mismatch.missing[0].code, 'VERTEX_SEAT_ACCOUNT_REGISTRY_MISMATCH');

  // End-to-end: fixed route/model, thought reserve, review, metering, audit,
  // no tools, refusal rather than downgrade, and untrusted output.
  const successful = fixture();
  const result = await seat.geminiSeatComplete({ prompt: 'Explain the bounded contract.', maxOutputTokens: 256 }, successful.deps);
  equal(result.output, 'answer');
  equal(result.passes, 2);
  equal(result.selfReviewed, true);
  equal(result.contentTrust, 'untrusted', 'seat output remains explicitly untrusted');
  equal(result.grantsAuthority, false, 'seat output never grants authority');
  equal(successful.calls.requests.length, 2);
  equal(successful.calls.requests[0].body.generationConfig.maxOutputTokens, 256 + seat.THINKING_TOKEN_RESERVE);
  equal(successful.calls.requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  equal(Object.hasOwn(successful.calls.requests[0].body, 'tools'), false);
  deepEqual(successful.calls.usage, [{ model: `vertex-${seat.MODEL}`, promptTokens: 4, evalTokens: 14 }]);
  equal(successful.calls.audit[0][0], 'vertex.gemini.seat_complete');

  const scenarios = [
    ['VERTEX_SEAT_DAILY_COST_CAP', { state: { recordSpend() { throw new Error('full'); }, recordModelUsage() {} } }],
    ['VERTEX_SEAT_LEDGER_UNAVAILABLE', { state: { recordSpend() {}, recordModelUsage() { throw new Error('disk'); } } }],
    ['VERTEX_SEAT_EXECUTION_FAILED', { request: async () => { throw new Error('unknown'); } }],
    ['VERTEX_SEAT_MODEL_DOWNGRADE_REFUSED', { request: async () => { throw new seat.VertexGeminiSeatError('VERTEX_SEAT_MODEL_UNAVAILABLE', 'gone'); } }],
    ['VERTEX_SEAT_INCOMPLETE_FINISH', { request: async () => response('partial', { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }) }],
    ['VERTEX_SEAT_COST_BOUND_EXCEEDED', { request: async () => response('costly', { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 100001, totalTokenCount: 100001 } }) }]
  ];
  for (const [expected, overrides] of scenarios) {
    const test = fixture(overrides);
    await rejects(expected, seat.geminiSeatComplete({ prompt: 'One bounded pass.', maxOutputTokens: 256, selfReview: false }, test.deps));
    equal(test.calls.audit.at(-1)[0], 'vertex.gemini.seat_complete.failed');
    equal(test.calls.audit.at(-1)[2].code, expected);
  }

  console.log(`Vertex Gemini seat provider contract tests passed (${checks} assertions; no provider was invoked).`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
