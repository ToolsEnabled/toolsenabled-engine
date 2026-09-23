'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('../src/lib/schema-validator');
const {
  BRIDGE_API_CONTRACT_SCHEMA, createBridgeApiContract,
  validateBridgeApiContract, assessBridgeApiCompatibility,
} = require('../src/lib/mission-bridge/api-contract');

const routes = { '/v1/actions/task-get': 'taskGet', '/v1/actions/dispatch': 'dispatch' };
const fresh = () => JSON.parse(JSON.stringify(createBridgeApiContract(routes)));

test('the action contract is deterministic, derived from routes and deeply immutable', () => {
  const value = createBridgeApiContract(routes);
  assert.deepEqual(value.actions, ['dispatch', 'task-get']);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.actions), true);
  assert.equal(Object.isFrozen(value.api), true);
  assert.equal(validateBridgeApiContract(value), true);
  assert.deepEqual(validate(BRIDGE_API_CONTRACT_SCHEMA, value), []);
  assert.equal(value.capabilityMeaning, 'registered-not-authorized-or-ready');
  assert.equal(value.automaticWriteRetry, 'never');
  for (const invalid of [null, [], {}, { '/v2/actions/task-get': 'taskGet' }, { '/v1/actions/bad?query': 'bad' }]) {
    assert.throws(() => createBridgeApiContract(invalid));
  }
});

test('compatibility admits additive minor versions, refuses unknown majors and missing required actions', () => {
  const value = fresh();
  assert.deepEqual(assessBridgeApiCompatibility(value, { requiredActions: ['dispatch'] }), { ok: true, apiMajor: 1, apiMinor: 0 });
  value.api.minor = 12;
  value.actions.push('new-action');
  assert.equal(assessBridgeApiCompatibility(value).ok, true);
  value.api.major = 2;
  assert.deepEqual(assessBridgeApiCompatibility(value), { ok: false, code: 'BRIDGE_API_MAJOR_UNSUPPORTED' });
  assert.deepEqual(assessBridgeApiCompatibility(fresh(), { requiredActions: ['missing', 'missing'] }), {
    ok: false, code: 'BRIDGE_API_ACTION_UNAVAILABLE', missingActions: ['missing'],
  });
  assert.throws(() => assessBridgeApiCompatibility(fresh(), { requiredActions: 'dispatch' }));
  assert.throws(() => assessBridgeApiCompatibility(fresh(), { requiredActions: ['/v1/actions/dispatch'] }));
});

test('wire validation agrees with the registry schema validator on valid and malformed JSON', () => {
  const mutations = [
    value => { delete value.api; }, value => { value.schemaVersion = 2; },
    value => { value.api.name = 'another-product'; }, value => { value.api.major = 0; },
    value => { value.api.major = 1.5; }, value => { value.api.minor = -1; },
    value => { value.api.extra = true; }, value => { value.extra = 'not-in-the-contract'; },
    value => { value.actions = []; }, value => { value.actions = ['dispatch', 'dispatch']; },
    value => { value.actions = ['../dispatch']; }, value => { value.actions = Array(257).fill('dispatch'); },
    value => { value.actions = ['x'.repeat(81)]; }, value => { value.automaticWriteRetry = 'always'; },
    value => { value.capabilityMeaning = 'authorized'; }, value => { value.api.major = 1000001; },
  ];
  for (const mutate of mutations) {
    const value = fresh(); mutate(value);
    assert.equal(validateBridgeApiContract(value), false);
    assert.ok(validate(BRIDGE_API_CONTRACT_SCHEMA, value).length > 0);
    assert.deepEqual(assessBridgeApiCompatibility(value), { ok: false, code: 'BRIDGE_API_CONTRACT_INVALID' });
  }
  for (const value of [null, undefined, [], true, 'contract']) assert.equal(validateBridgeApiContract(value), false);
});

test('contract validation never invokes accessors or accepts sparse/prototype-bearing objects', () => {
  let touched = false;
  const value = fresh();
  Object.defineProperty(value, 'actions', { get() { touched = true; throw new Error('do not call'); } });
  assert.equal(validateBridgeApiContract(value), false);
  assert.equal(touched, false);
  const sparse = fresh(); sparse.actions = new Array(2);
  assert.equal(validateBridgeApiContract(sparse), false);
  const inherited = Object.assign(Object.create({ extra: true }), fresh());
  assert.equal(validateBridgeApiContract(inherited), false);
});

test('the real HTTP contract endpoint is authenticated, origin-bound, read-only and derived from the actual routes', async t => {
  const { createMissionBridgeServer, ROUTES, API_CONTRACT } = require('../src/lib/mission-bridge/server');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-contract-'));
  const token = crypto.randomBytes(32);
  const proof = crypto.randomBytes(32);
  const allowedOrigin = 'http://127.0.0.1:4600';
  let actionCalls = 0;
  const bridge = createMissionBridgeServer({
    token, bootstrapProof: proof, allowedOrigins: [allowedOrigin],
    actions: new Proxy({}, { get() { actionCalls += 1; throw new Error('contract discovery must not touch an action'); } }),
    runtimeFile: path.join(scratch, 'runtime.json'), allowTestRuntimeFile: true,
    allowTestPortZero: true, runtimeDependencies: { platform: 'test' },
  });
  t.after(async () => { await bridge.close(); await fs.rm(scratch, { recursive: true, force: true }); });
  const address = await bridge.listen(0);
  const endpoint = `${address.baseUrl}/v1/contract`;
  const headers = { origin: allowedOrigin, authorization: `Bearer ${token.toString('base64url')}` };
  const request = options => fetch(endpoint, options);
  assert.equal((await request()).status, 401, 'no credential stays unauthorized');
  assert.equal((await request({ headers: { origin: allowedOrigin } })).status, 401, 'origin alone is not authorization');
  assert.equal((await request({ headers: { ...headers, authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await request({ headers: { ...headers, origin: 'http://evil.invalid' } })).status, 403);
  const response = await request({ headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, contract: API_CONTRACT });
  assert.deepEqual(body.contract.actions, Object.keys(ROUTES).map(route => route.slice('/v1/actions/'.length)).sort());
  assert.equal(validateBridgeApiContract(body.contract), true);
  assert.equal(JSON.stringify(body).includes(token.toString('base64url')), false);
  assert.equal(JSON.stringify(body).includes(proof.toString('base64url')), false);
  assert.equal(JSON.stringify(body).includes(scratch), false);
  assert.equal((await request({ headers: { authorization: headers.authorization } })).status, 200, 'a credentialed non-browser client remains supported');
  assert.equal((await request({ method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal(actionCalls, 0, 'contract observation never invokes a tool/action');
});
