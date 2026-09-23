'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const policyPath = require.resolve('../src/lib/policy-authorizations');
const originalLoad = Module._load;
let authorizeCalls = 0;
let createAttempts = 0;
let durableWrites = 0;
let catalog = [];
let savedResult = { replayed: false };

Module._load = function loadPolicyDependencies(request, parent, isMain) {
  if (parent && parent.filename === policyPath && request === './state-store') {
    return {
      getStateStore() { throw new Error('test must inject state'); },
      hashInput() { return 'c'.repeat(64); }
    };
  }
  if (parent && parent.filename === policyPath && request === './scoped-approvals') {
    return { consumeForDispatch() { throw new Error('unexpected scoped dispatch'); } };
  }
  if (parent && parent.filename === policyPath && request === './providers/capability-manifests') {
    return {
      authorizeBoundRequest(input) {
        authorizeCalls += 1;
        return {
          boundRequest: input.request,
          requestHash: 'a'.repeat(64),
          manifestHash: 'b'.repeat(64)
        };
      }
    };
  }
  if (parent && parent.filename === policyPath && request === './tool-registry') {
    return { p13PolicyActionCatalog: () => catalog };
  }
  return originalLoad(request, parent, isMain);
};

delete require.cache[policyPath];
const policy = require(policyPath);

function expectRefusal(callback, code) {
  assert.throws(callback, value => {
    assert.equal(value.name, 'PolicyAuthorizationError');
    assert.equal(value.code, code);
    return true;
  });
}

function input(overrides = {}) {
  return {
    authorizationId: 'authorization-test-0001',
    profileId: 'profile.test',
    version: 1,
    requestId: 'request-test-0001',
    request: { taskId: 'task-test-0001', tool: 'task.get' },
    arguments: {},
    risk: 'low',
    delegationDepth: 0,
    userKind: 'owner',
    ...overrides
  };
}

function state() {
  return {
    createPolicyDispatchAuthorization() {
      createAttempts += 1;
      // This seam deliberately simulates the store response without persisting.
      return savedResult;
    }
  };
}

// Shape refusal happens before capability resolution or any state operation.
expectRefusal(() => policy.prepare({ ...input(), unsupported: true }, { state: state() }),
  'POLICY_AUTHORIZATION_INVALID');
assert.equal(authorizeCalls, 0);
assert.equal(createAttempts, 0);
assert.equal(durableWrites, 0);

// A P12-authorized request still refuses when the code-owned catalog cannot
// provide target authority; it must not ask the state store to create anything.
catalog = [];
expectRefusal(() => policy.prepare(input(), { state: state() }),
  'POLICY_TARGET_AUTHORITY_UNAVAILABLE');
assert.equal(authorizeCalls, 1);
assert.equal(createAttempts, 0);
assert.equal(durableWrites, 0);

// A malformed state response is rejected rather than being reported as a new
// authorization. The fake store records the attempted call but performs no
// durable write, and prepare never returns an authorization result.
catalog = [{ name: 'task.get', policyKind: 'local-read', targetKind: 'task' }];
savedResult = {};
let returned = false;
expectRefusal(() => {
  const result = policy.prepare(input(), { state: state() });
  returned = true;
  return result;
}, 'POLICY_AUTHORIZATION_STATE_INVALID');
assert.equal(returned, false);
assert.equal(authorizeCalls, 2);
assert.equal(createAttempts, 1);
assert.equal(durableWrites, 0);

Module._load = originalLoad;
console.log('policy authorization refusal tests passed');
