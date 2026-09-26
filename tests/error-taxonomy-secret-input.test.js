'use strict';
require('./lib/isolated-environment').activate('error-taxonomy-secret-input');
const test = require('node:test');
const assert = require('node:assert/strict');
const taxonomy = require('../src/lib/error-taxonomy');
for (const code of ['MEMORY_SECRET_REJECTED', 'TASK_SECRET_REJECTED']) {
  test(`${code} reports invalid input without exposing rejected content`, () => {
    const error = Object.assign(new Error('private-rejected-content-canary'), { code });
    const result = taxonomy.publicFailure(error);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(result.retryable, false);
    assert.doesNotMatch(JSON.stringify(result), /private-rejected-content-canary/);
  });
}
test('unrelated secret availability and unknown faults keep their classifications', () => {
  assert.equal(taxonomy.publicFailure({ code: 'VAULT_SECRET_UNAVAILABLE' }).code, 'AUTH_EXPIRED');
  assert.equal(taxonomy.publicFailure({ code: 'UNKNOWN_MEMORY_FAULT' }).code, 'INTERNAL_ERROR');
});
