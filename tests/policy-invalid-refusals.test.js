'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

let writes = 0;
let spawns = 0;
const restore = [];

function observe(object, names, increment) {
  for (const name of names) {
    const original = object[name];
    object[name] = function observedSideEffect(...args) {
      increment();
      return original.apply(this, args);
    };
    restore.push(() => { object[name] = original; });
  }
}

observe(fs, ['appendFileSync', 'createWriteStream', 'writeFileSync'], () => { writes += 1; });
observe(childProcess, ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'], () => { spawns += 1; });

try {
  const policy = require('../src/lib/policy');

  const invalidHttpPolicy = {
    http: {
      allowedHosts: ['valid.example'],
      vaultKeys: {
        SERVICE_TOKEN: { hosts: ['api.example'], authStyle: 'query:bad param' }
      }
    }
  };
  const httpSnapshot = structuredClone(invalidHttpPolicy);
  assert.throws(
    () => policy.httpConfiguration(invalidHttpPolicy),
    error => {
      assert.equal(error.code, 'HTTP_POLICY_INVALID');
      assert.equal(error.message, 'http.vaultKeys.SERVICE_TOKEN.authStyle has an invalid query parameter name.');
      return true;
    }
  );
  assert.deepEqual(invalidHttpPolicy, httpSnapshot, 'HTTP refusal must not mutate its injected policy');

  const invalidStandingPolicy = {
    approvals: {
      standingAuthorizations: [{
        id: 'nightly-sync',
        mission: 'mirror-refresh',
        action: 'browser.stop',
        arguments: {}
      }]
    }
  };
  const standingSnapshot = structuredClone(invalidStandingPolicy);
  assert.throws(
    () => policy.standingAuthorizationConfiguration(invalidStandingPolicy),
    error => {
      assert.equal(error.code, 'STANDING_AUTHORIZATION_POLICY_INVALID');
      assert.equal(error.message, 'approvals.standingAuthorizations[0].action is never eligible for standing authorization.');
      return true;
    }
  );
  assert.deepEqual(invalidStandingPolicy, standingSnapshot, 'standing-authorization refusal must not mutate its injected policy');

  const httpArguments = {
    method: 'POST', url: 'https://api.example/echo',
    headers: { 'content-type': 'application/json', 'x-audit-marker': 'exact' },
    body: '{\n  "message": "hello"\n}'
  };
  const httpGrant = { approvals: { standingAuthorizations: [{
    id: 'exact-http-request', mission: 'manual-api-check', action: 'http.request', arguments: httpArguments
  }] } };
  const beforeGrant = structuredClone(httpGrant);
  const grants = policy.standingAuthorizationConfiguration(httpGrant);
  assert.deepEqual(grants[0].arguments, httpArguments, 'nested HTTP header names are values, not top-level tool parameter names');
  assert.ok(Object.isFrozen(grants[0].arguments.headers));
  assert.equal(policy.standingAuthorizationFor('http.request', httpArguments, httpGrant, { effect: 'external-write' }).id, 'exact-http-request');
  assert.equal(policy.standingAuthorizationFor('http.request', { ...httpArguments, method: 'PUT' }, httpGrant, { effect: 'external-write' }), null);
  assert.equal(policy.standingAuthorizationFor('http.request', {
    ...httpArguments, headers: { ...httpArguments.headers, 'x-audit-marker': 'changed' }
  }, httpGrant, { effect: 'external-write' }), null, 'nested values still require an exact match');
  assert.deepEqual(httpGrant, beforeGrant);
  for (const argumentsValue of [
    { ...httpArguments, 'unknown-parameter': true },
    { ...httpArguments, headers: JSON.parse('{"__proto__":{"polluted":true}}') }
  ]) {
    const unsafe = structuredClone(httpGrant);
    unsafe.approvals.standingAuthorizations[0].arguments = argumentsValue;
    assert.throws(() => policy.standingAuthorizationConfiguration(unsafe), { code: 'STANDING_AUTHORIZATION_POLICY_INVALID' });
  }

  assert.equal(writes, 0, 'policy refusals must not write files');
  assert.equal(spawns, 0, 'policy refusals must not spawn processes');
} finally {
  for (const restoreOne of restore.reverse()) restoreOne();
}

console.log('policy invalid refusals and exact nested HTTP authorizations passed');
