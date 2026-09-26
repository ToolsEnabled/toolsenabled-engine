/* Mutation check (2026-08-27):
 * Changed writeFingerprint's JSON.stringify(fingerprint) to JSON.stringify({}).
 * The replacement landed and changed the module's SHA-256.
 * This isolated test went red with exit code 1 on the nested-value assertion.
 * The module was restored and its original SHA-256 was confirmed.
 */

'use strict';

// Behavioural coverage for the public helpers exported by
// src/lib/agent-digest/index.js. The fingerprint is persisted as text, so this
// exercises the complete write/read boundary rather than inspecting its
// implementation or source.

const assert = require('node:assert/strict');

// Loading the index also wires the production delivery adapter, whose durable
// store needs node:sqlite. These helper tests do not exercise delivery; keep
// that unrelated runtime dependency out of this unit boundary (and permit the
// file to run on the repository's lightweight test Node as well as Node 22).
for (const [request, exports] of [
  ['../src/lib/owner-delivery', {}],
  ['../src/lib/agent-digest/collect', {
    collectDigestState: () => {},
    collectFallbackState: () => {},
    digestFingerprint: () => ({})
  }],
  ['../src/lib/agent-digest/render', {
    renderDigest: () => ({}),
    renderFallback: () => ({})
  }]
]) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const {
  FINGERPRINT_KEY,
  readFingerprint,
  resolveRecipient,
  writeFingerprint
} = require('../src/lib/agent-digest');

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

check('fingerprints retain their structured values across the settings-store boundary', () => {
  const settings = new Map();
  const store = {
    getSetting: key => settings.get(key),
    setSetting: (key, value) => settings.set(key, value)
  };
  const fingerprint = {
    agents: [{ id: 'agent-7', state: 'working' }],
    totals: { active: 1, waiting: 0 },
    complete: false
  };

  writeFingerprint(store, fingerprint);

  assert.equal(typeof settings.get(FINGERPRINT_KEY), 'string',
    'the settings store must receive a portable string value');
  assert.deepEqual(readFingerprint(store), fingerprint,
    'reading the stored fingerprint must reproduce nested objects, arrays, numbers, and booleans');
});

check('an absent fingerprint is reported as no previous digest state', () => {
  assert.equal(readFingerprint({ getSetting: () => undefined }), null);
});

check('invalid persisted fingerprint text fails with the public diagnostic code', () => {
  assert.throws(
    () => readFingerprint({ getSetting: () => '{broken json' }),
    error => error.code === 'AGENT_DIGEST_FINGERPRINT_INVALID'
      && /could not be parsed/.test(error.message)
  );
});

check('recipient resolution returns the selected account alias and registered address', () => {
  const accounts = {
    resolve: requested => requested || 'primary',
    load: () => ({
      accounts: {
        primary: { email: 'owner@example.test' },
        reports: { email: 'reports@example.test' }
      }
    })
  };

  assert.deepEqual(resolveRecipient({}, accounts), {
    alias: 'primary',
    email: 'owner@example.test'
  });
  assert.deepEqual(resolveRecipient({ account: 'reports' }, accounts), {
    alias: 'reports',
    email: 'reports@example.test'
  });
});

check('recipient resolution rejects an alias without a deliverable address', () => {
  const accounts = {
    resolve: () => 'unbound',
    load: () => ({ accounts: { unbound: { email: 'not-an-address' } } })
  };

  assert.throws(
    () => resolveRecipient({ account: 'unbound' }, accounts),
    error => error.code === 'AGENT_DIGEST_RECIPIENT_UNRESOLVED'
      && /unbound/.test(error.message)
  );
});

process.stdout.write(`Agent digest index tests passed (${checks} checks).\n`);
