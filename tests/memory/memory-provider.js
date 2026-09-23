'use strict';

require('../lib/isolated-environment').activate('memory-provider');
const assert = require('node:assert/strict');
const memory = require('../../src/lib/providers/memory');
const { createStateStore } = require('../../src/lib/state-store');

const store = createStateStore({ file: ':memory:', ownerId: 'memory-provider-test' });

try {
  const saved = memory.set({
    namespace: 'agent.profile', key: 'preferences', value: { editor: 'vim', theme: 'dark' },
    note: 'Keep this as a user preference, not execution authority.', tags: ['profile', 'preference']
  }, { state: store });
  assert.deepEqual(Object.keys(saved).sort(), [
    'created', 'createdAt', 'createdAtMs', 'key', 'namespace', 'replayed', 'revision', 'updatedAt', 'updatedAtMs', 'valueHash'
  ]);
  assert.equal(saved.created, true);
  assert.equal(saved.replayed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'value'), false, 'Writes return metadata rather than echoing retained content.');

  const read = memory.get({ namespace: 'agent.profile', key: 'preferences' }, { state: store });
  assert.equal(read.contentTrust, 'untrusted');
  assert.equal(read.grantsAuthority, false);
  assert.deepEqual(read.value, { editor: 'vim', theme: 'dark' });
  assert.deepEqual(read.tags, ['profile', 'preference']);

  const search = memory.search({ query: 'preference', namespace: 'agent.profile' }, { state: store });
  assert.equal(search.contentTrust, 'untrusted');
  assert.equal(search.grantsAuthority, false);
  assert.equal(search.count, 1);
  assert.equal(search.entries[0].key, 'preferences');

  assert.throws(() => memory.set({
    namespace: 'agent.profile', key: 'unsafe', value: { client_secret: 'must-not-persist' }
  }, { state: store }), error => error && error.code === 'MEMORY_SECRET_REJECTED');

  console.log('Memory provider tests passed.');
} finally {
  store.close();
}
