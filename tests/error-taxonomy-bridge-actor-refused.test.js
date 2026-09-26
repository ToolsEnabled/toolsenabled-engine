'use strict';

const { activate } = require('./lib/isolated-environment');
activate('error-taxonomy-bridge-actor-refused');

const assert = require('node:assert/strict');
const taxonomy = require('../src/lib/error-taxonomy');

const mapped = taxonomy.publicFailure({ code: 'BRIDGE_ACTOR_REFUSED', status: 403 });
assert.deepEqual(mapped, {
  schemaVersion: '1.0.0',
  code: 'POLICY_DENIED',
  classification: 'terminal',
  retryable: false,
  safeSummary: 'This action is not permitted by the active policy.'
});

for (const code of ['BRIDGE_ACTOR_REFUSED_EXTRA', 'PREFIX_BRIDGE_ACTOR_REFUSED', 'UNKNOWN_HTTP_FAILURE']) {
  assert.equal(taxonomy.publicFailure({ code, status: 403 }).code, 'AUTH_EXPIRED',
    `${code} was captured by an actor-refusal rule that should be exact`);
}
assert.equal(taxonomy.publicFailure({ code: 'BRIDGE_ACTOR_REFUSED' }).code, 'POLICY_DENIED',
  'the mapping must consume the structured source code rather than depend on HTTP status');

process.stdout.write('error taxonomy bridge actor refusal: exact policy mapping passed; adjacent and unrelated 403 controls unchanged\n');
