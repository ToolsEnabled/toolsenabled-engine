'use strict';

require('./lib/isolated-environment').activate('vertex-gemini-refusals');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const vertex = require('../src/lib/providers/vertex-gemini');

const identity = { alias: 'covered-alias', email: 'covered@example.test', projectId: 'covered-project' };
const vertexConfig = {
  version: 2, operatorAuthorized: true, accountAlias: identity.alias,
  accountEmail: identity.email, projectId: identity.projectId,
  location: vertex.LOCATION, model: vertex.MODEL, thinkingBudget: vertex.THINKING_BUDGET,
  trialOnly: true, noFullAccountActivation: true
};
const accountRegistry = {
  resolve: () => identity.alias,
  load: () => ({ accounts: { [identity.alias]: { email: identity.email } } }),
  list: () => [{ alias: identity.alias, email: identity.email }]
};

function base(overrides = {}) {
  const calls = { run: [], request: 0, record: [] };
  const deps = {
    vertexConfig, accountRegistry, assertActive: () => {}, gcloudAvailable: () => true,
    run: (_command, args) => {
      calls.run.push(args);
      if (args[0] === 'auth' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ account: identity.email, status: 'INACTIVE' }]), stderr: '' };
      if (args[0] === 'auth' && args[1] === 'print-access-token') return { status: 0, stdout: 't'.repeat(16), stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    request: async () => { calls.request += 1; throw new Error('provider request was not expected'); },
    record: (...args) => calls.record.push(args),
    usageAttribution: () => 'fixture', state: { recordModelUsage: () => {} }, now: () => 1,
    ...overrides
  };
  return { calls, deps };
}

async function rejectsCode(action, code) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function mockHttp(statusCode) {
  const calls = { writes: 0, ends: 0, destroys: 0 };
  const factory = (_options, receive) => {
    const request = new EventEmitter();
    request.write = () => { calls.writes += 1; };
    request.end = () => {
      calls.ends += 1;
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => { calls.destroys += 1; };
      receive(response);
      process.nextTick(() => response.emit('end'));
    };
    request.destroy = () => { calls.destroys += 1; };
    return request;
  };
  return { calls, factory };
}

(async () => {
  // The fixture values are deliberately synthetic; replace only hashing so the
  // real commitment and validation branches remain the code under test.
  const createHash = crypto.createHash;
  crypto.createHash = () => ({
    update(value) { this.value = value; return this; },
    digest() {
      if (this.value === identity.alias) return vertex.ACCOUNT_ALIAS_SHA256;
      if (this.value === identity.email) return vertex.ACCOUNT_EMAIL_SHA256;
      if (this.value === identity.projectId) return vertex.PROJECT_ID_SHA256;
      return createHash('sha256').update(String(this.value), 'utf8').digest('hex');
    }
  });
  try {
    assert.throws(() => vertex._testing.configuration({ vertexConfig: { ...vertexConfig, model: 'not-approved' } }),
      error => error.code === 'VERTEX_CONFIGURATION_INVALID');

    let fixture = base();
    await rejectsCode(() => vertex.geminiComplete({ prompt: 'hello', selfReview: false }, { ...fixture.deps, gcloudAvailable: () => false }), 'GCLOUD_UNAVAILABLE');
    assert.deepEqual(fixture.calls, { run: [], request: 0, record: [] });

    fixture = base();
    await rejectsCode(() => vertex.geminiComplete({ prompt: 'hello', selfReview: false }, { ...fixture.deps,
      accountRegistry: { ...accountRegistry, resolve: () => 'another-alias' }
    }), 'VERTEX_ACCOUNT_MISMATCH');
    assert.deepEqual(fixture.calls, { run: [], request: 0, record: [] });

    for (const [code, run] of [
      ['GCLOUD_TIMEOUT', () => { const error = new Error('late'); error.code = 'ESPAWN_TIMEOUT'; throw error; }],
      ['GCLOUD_COMMAND_FAILED', () => ({ status: 1, stdout: '', stderr: 'failed' })],
      ['GCLOUD_AUTH_UNCERTAIN', () => ({ status: 0, stdout: '{bad json', stderr: '' })],
      ['GCLOUD_ACCOUNT_NOT_AUTHENTICATED', () => ({ status: 0, stdout: '[]', stderr: '' })]
    ]) {
      fixture = base({ run: (_command, args) => { fixture.calls.run.push(args); return run(); } });
      await rejectsCode(() => vertex.geminiComplete({ prompt: 'hello', selfReview: false }, fixture.deps), code);
      assert.equal(fixture.calls.request, 0, `${code} must refuse before a provider request`);
      assert.equal(fixture.calls.record.length, 0, `${code} must not claim an operation was attempted`);
    }

    fixture = base({ run: (_command, args) => {
      fixture.calls.run.push(args);
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ account: identity.email, status: 'INACTIVE' }]), stderr: '' };
      return { status: 0, stdout: 'short', stderr: '' };
    } });
    await rejectsCode(() => vertex.geminiComplete({ prompt: 'hello', selfReview: false }, fixture.deps), 'GCLOUD_TOKEN_UNAVAILABLE');
    assert.equal(fixture.calls.request, 0);
    assert.equal(fixture.calls.record.length, 1, 'a post-preflight failure is audited once');
    assert.equal(fixture.calls.record[0][0], 'vertex.gemini.complete.failed');

    fixture = base({ run: (_command, args) => {
      fixture.calls.run.push(args);
      if (args[0] === 'config') return { status: 0, stdout: '{"core":{"project":"unchanged"}}', stderr: '' };
      if (args[0] === 'services') return { status: 0, stdout: '', stderr: '' };
      const afterService = fixture.calls.run.some(call => call[0] === 'services');
      return { status: 0, stdout: JSON.stringify([{ account: afterService ? 'other@example.test' : identity.email, status: 'ACTIVE' }]), stderr: '' };
    } });
    await rejectsCode(() => vertex.gcloudVertexServiceEnable({ account: identity.alias }, fixture.deps), 'GCLOUD_ACTIVE_ACCOUNT_CHANGED');
    assert.equal(fixture.calls.request, 0, 'account preservation refusal never reaches Vertex');
    assert.equal(fixture.calls.run.filter(args => args[0] === 'services').length, 1, 'service enable is not retried after preservation fails');

    fixture = base({ request: async () => {
      fixture.calls.request += 1;
      return { candidates: [{ content: { parts: [{ text: 'answer' }] } }], usageMetadata: {
        promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 1_000_000
      } };
    } });
    await rejectsCode(() => vertex.geminiComplete({ prompt: 'hello', selfReview: false }, fixture.deps), 'VERTEX_COST_BOUND_EXCEEDED');
    assert.equal(fixture.calls.request, 1, 'measured provider usage is checked after exactly one bounded call');
    assert.equal(fixture.calls.record.length, 1, 'the exceeded measured cost is audited as a failure');

    assert.throws(() => vertex._testing.preservationSnapshot({ run: () => ({ status: 0, stdout: '{bad json', stderr: '' }) }),
      error => error.code === 'GCLOUD_AUTH_UNCERTAIN');
    assert.throws(() => vertex._testing.preservationSnapshot({ run: (_command, args) => args[0] === 'auth'
      ? { status: 0, stdout: '[]', stderr: '' } : { status: 0, stdout: '[]', stderr: '' } }),
      error => error.code === 'GCLOUD_CONFIG_UNCERTAIN');

    for (const [status, code] of [[401, 'VERTEX_AUTH_FAILED'], [400, 'VERTEX_API_REJECTED']]) {
      const http = mockHttp(status);
      await rejectsCode(() => vertex.vertexRequest({ contents: [] }, 't'.repeat(16), {
        vertexConfig, request: http.factory, timeoutMs: 1000
      }), code);
      assert.deepEqual(http.calls, { writes: 1, ends: 1, destroys: 0 }, `${code} completes exactly one mocked request without retrying`);
    }
  } finally {
    crypto.createHash = createHash;
  }
  console.log('vertex-gemini driven refusal tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
