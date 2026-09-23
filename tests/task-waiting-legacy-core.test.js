'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');
const engine = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const lib = process.env.T850_COMPOSITION_LIB || path.join(engine, 'src/lib');
// Digests produced by the pre-wait store at e883b60a1cc0932790130ef41da137ec1f28dd74.
const fixtures = [
  [
    {
      "id": "T1",
      "kind": "T",
      "scope": "tree",
      "scopeKey": "synthetic-lead",
      "status": "in-progress",
      "verbatim": "Synthetic dependency work",
      "filedBy": "codex",
      "decisions": []
    },
    "743596366e19f0027221f8f16a265b96f0e347ed52b736aaf930caf6a0371dde"
  ],
  [
    {
      "id": "T2",
      "kind": "T",
      "scope": "thread",
      "scopeKey": "synthetic-worker",
      "status": "done",
      "verbatim": "Synthetic completed work",
      "filedBy": "codex",
      "decisions": [
        {
          "decision": "complete"
        }
      ],
      "completedAt": "synthetic-completion"
    },
    "0f8210050ec69af12bc88ede6394078eed336dc403473e11d6395ebe21239832"
  ],
  [
    {
      "id": "T3",
      "kind": "T",
      "scope": "session",
      "scopeKey": "synthetic-session",
      "status": "removed",
      "verbatim": "Synthetic removed work",
      "filedBy": "human",
      "decisions": [
        {
          "decision": "remove"
        }
      ],
      "removedAt": "2026-01-01T00:00:00Z"
    },
    "8f49b5c5dbb4c87a95a0809cf6fc0e8e91e792b907cf9891ca26e2a7d6929b3c"
  ]
];
test('canonical wait sorting and malformed disk markers remain stable through core hashing', () => {
  const { store } = createMapLedgerFixture({ engine, lib });
  const record = fixtures[0][0];
  assert.equal(store.coreSha256({ ...record, waitingFor: ['T10', 'T2'] }),
    store.coreSha256({ ...record, waitingFor: ['T2', 'T10'] }));
  for (const waitingFor of [null, 'T2', ['t2'], Array.from({ length: 17 }, (_, i) => 'T' + (i + 2))]) {
    let digest;
    assert.doesNotThrow(() => { digest = store.coreSha256({ ...record, waitingFor }); });
    assert.equal(digest, store.coreSha256({ ...record, waitingFor }), 'malformed disk input hashes deterministically');
    assert.notEqual(digest, store.coreSha256(record), 'invalid data must not collapse into a legacy no-wait record');
    assert.notEqual(digest, store.coreSha256({ ...record, waitingFor: [] }), 'invalid data must not collapse into a ready empty wait');
  }
});
test('task records without waitingFor retain the pinned pre-wait history digests', () => {
  const { store } = createMapLedgerFixture({ engine, lib });
  for (const [record, expected] of fixtures) {
    assert.equal(Object.hasOwn(record, 'waitingFor'), false);
    assert.equal(store.coreSha256(record), expected, record.id);
    assert.equal(Object.hasOwn(record, 'waitingFor'), false, 'hashing must not migrate legacy records');
  }
});
