'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { services, VCS_ERROR_CODES, VcsError } = require('../src');

for (const [serviceName, service] of Object.entries(services)) {
  for (const [methodName, method] of Object.entries(service)) {
    test(`${serviceName}.${methodName} requires an explicitly bound system`, async () => {
      await assert.rejects(
        method({}),
        (error) => {
          assert.ok(error instanceof VcsError);
          assert.equal(error.code, VCS_ERROR_CODES.ADAPTER_UNAVAILABLE);
          assert.equal(error.details.factory, 'createInternalVcsSystem');
          assert.notEqual(error.code, VCS_ERROR_CODES.NOT_IMPLEMENTED);
          return true;
        },
      );
    });
  }
}
