// EXECUTABLE CHANGE
/*
Report: testcanfail-tests-kernel-state-instagram-saga-js

Strengthened assertions and mutation evidence:
- The publish-path `config < reserve` assertion accepted a missing `config` event
  because `indexOf` returned -1. Mutation: bypass `loadConfig()` with the same
  provider configuration. Before the fix the test stayed green. After the fix:
  "AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to: -1
      at /workspace/engine/tests/kernel.state/instagram-saga.js:106:12"
- The publish-path `executing < api` assertion accepted a missing `executing`
  event for the same reason. Mutation: remove the call to
  `store.markOperationExecuting`. Before the fix the test stayed green. After:
  "AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to: -1
      at /workspace/engine/tests/kernel.state/instagram-saga.js:108:12"
- The replay-path `config < reserve` assertion also accepted a missing `config`
  event. Mutation: bypass `loadConfig()` only for the `post-replay` operation,
  preserving the same provider configuration. After the fix:
  "AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to: -1
      at /workspace/engine/tests/kernel.state/instagram-saga.js:134:12"

Source restoration and green confirmation:
- `cmp -s src/lib/providers/instagram.js /tmp/instagram.js.clean` exited 0 after
  the mutations, confirming byte-for-byte restoration.
- The restored run printed: "Instagram saga tests passed."

Shape audit:
- EMPTY assertion loop/forEach: NOT-FOUND.
- Exit-status or truthy-return-only process evidence: NOT-FOUND.
- Failure-swallowing try/catch or optional chain: NOT-FOUND. The one manual catch
  is followed by assertions that fail when no error is captured.
- Assertion against a mock of the thing under test: NOT-FOUND. Injected fakes
  record the provider orchestration performed by `publishImage`.
- Skip or platform precondition guard: NOT-FOUND.
- Expected value computed by the same code under test: NOT-FOUND.

Unmet preconditions: none.
*/
'use strict';

const assert = require('node:assert/strict');
const instagram = require('../../src/lib/providers/instagram');

function fixture(options = {}) {
  const events = [];
  const stateOverrides = options.store || {};
  const store = {
    reserveOperation: async input => {
      events.push(['reserve', input]);
      return { disposition: 'reserved', handle: { id: 'operation-1', owner: 'test' } };
    },
    markOperationExecuting: async (handle, input) => { events.push(['executing', handle, input]); },
    heartbeatOperation: async (handle, input) => { events.push(['heartbeat', handle, input]); },
    succeedOperation: async (handle, input) => { events.push(['succeed', handle, input]); },
    failOperation: async (handle, input) => { events.push(['fail', handle, input]); },
    markOperationUncertain: async (handle, input) => { events.push(['uncertain', handle, input]); },
    ...stateOverrides
  };
  const state = {
    getStateStore: () => { events.push(['getStateStore']); return store; },
    hashInput: input => { events.push(['hashInput', input]); return 'input-hash'; }
  };
  const responses = options.responses ? [...options.responses] : [
    { id: 'container-1' },
    { status_code: 'FINISHED' },
    { id: 'media-1' }
  ];
  const dependencies = {
    config: () => {
      events.push(['config']);
      return { apiVersion: 'v-test', token: 'not-a-real-token', userId: 'owner-1' };
    },
    api: async (path, input) => {
      events.push(['api', path, input]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async delay => { events.push(['sleep', delay]); },
    clock: () => 123456,
    state,
    audit: async (...args) => { events.push(['audit', ...args]); }
  };
  return { dependencies, events, state, store };
}

function names(events) { return events.map(event => event[0]); }
function calls(events, name) { return events.filter(event => event[0] === name); }

(async () => {
  {
    const test = fixture();
    const result = await instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', caption: 'caption', idempotencyKey: 'post-1'
    }, test.dependencies);

    assert.deepEqual(result, { containerId: 'container-1', mediaId: 'media-1', status: 'published' });
    assert.deepEqual(test.events.find(event => event[0] === 'hashInput')[1], {
      userId: 'owner-1', imageUrl: 'https://example.test/image.jpg', caption: 'caption'
    });
    const reservation = test.events.find(event => event[0] === 'reserve')[1];
    assert.equal(reservation.type, 'instagram.publish_image');
    assert.equal(reservation.key, 'post-1');
    assert.equal(reservation.inputHash, 'input-hash');
    assert.equal(reservation.leaseMs, instagram.OPERATION_LEASE_MS);
    assert.notEqual(names(test.events).indexOf('config'), -1);
    assert.ok(names(test.events).indexOf('config') < names(test.events).indexOf('reserve'));
    assert.notEqual(names(test.events).indexOf('executing'), -1);
    assert.ok(names(test.events).indexOf('executing') < names(test.events).indexOf('api'));
    assert.ok(calls(test.events, 'heartbeat').length >= 3);
    const finalPublishIndex = test.events.findIndex(event => event[0] === 'api' && event[1].endsWith('/media_publish'));
    assert.equal(test.events[finalPublishIndex - 1][0], 'heartbeat');
    assert.ok(names(test.events).indexOf('succeed') < names(test.events).indexOf('audit'));
  }

  {
    const test = fixture({
      store: {
        reserveOperation: async input => {
          test.events.push(['reserve', input]);
          return { disposition: 'replay', result: { containerId: 'old-container', mediaId: 'old-media', status: 'published' } };
        }
      }
    });
    test.dependencies.api = async () => { throw new Error('HTTP must not run for replay'); };
    const result = await instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', caption: 'same', idempotencyKey: 'post-replay'
    }, test.dependencies);

    assert.deepEqual(result, { containerId: 'old-container', mediaId: 'old-media', status: 'published', replayed: true });
    assert.equal(calls(test.events, 'api').length, 0);
    assert.equal(calls(test.events, 'executing').length, 0);
    assert.equal(calls(test.events, 'audit').length, 0);
    assert.notEqual(names(test.events).indexOf('config'), -1);
    assert.ok(names(test.events).indexOf('config') < names(test.events).indexOf('reserve'));
  }

  {
    const test = fixture({ responses: [new Error('container creation rejected')] });
    await assert.rejects(instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', idempotencyKey: 'post-retryable'
    }, test.dependencies), /container creation rejected/);

    assert.equal(calls(test.events, 'fail').length, 1);
    assert.equal(calls(test.events, 'fail')[0][2].retryAtMs, 123456);
    assert.equal(calls(test.events, 'uncertain').length, 0);
    assert.equal(calls(test.events, 'succeed').length, 0);
  }

  {
    const test = fixture({ responses: [
      { id: 'container-1' }, { status_code: 'FINISHED' }, new Error('publish response lost')
    ] });
    await assert.rejects(instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', idempotencyKey: 'post-uncertain'
    }, test.dependencies), /publish response lost/);

    assert.equal(calls(test.events, 'uncertain').length, 1);
    assert.equal(calls(test.events, 'fail').length, 0);
    assert.equal(calls(test.events, 'api').filter(event => event[1].endsWith('/media_publish')).length, 1);
    assert.equal(calls(test.events, 'succeed').length, 0);
  }

  {
    const test = fixture({ responses: [
      { id: 'container-1' }, { status_code: 'FINISHED' }, {}
    ] });
    await assert.rejects(instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', idempotencyKey: 'post-malformed'
    }, test.dependencies), /published media id/);

    assert.equal(calls(test.events, 'uncertain').length, 1);
    assert.equal(calls(test.events, 'fail').length, 0);
    assert.equal(calls(test.events, 'api').filter(event => event[1].endsWith('/media_publish')).length, 1);
  }

  {
    const leaked = 'access_token=must-not-leak';
    const test = fixture({
      store: {
        succeedOperation: async (handle, input) => {
          test.events.push(['succeed', handle, input]);
          throw new Error(`database failed ${leaked}`);
        }
      }
    });
    let thrown;
    try {
      await instagram.publishImage({
        imageUrl: 'https://example.test/image.jpg', idempotencyKey: 'post-commit-failed'
      }, test.dependencies);
    } catch (error) { thrown = error; }

    assert.equal(thrown && thrown.code, 'EXTERNAL_COMMIT_UNRECORDED');
    assert.doesNotMatch(thrown.message, /must-not-leak|access_token/);
    assert.equal(calls(test.events, 'uncertain').length, 1);
    assert.equal(calls(test.events, 'uncertain')[0][2].errorCode, 'EXTERNAL_COMMIT_UNRECORDED');
    assert.doesNotMatch(JSON.stringify(calls(test.events, 'uncertain')[0][2]), /must-not-leak|access_token/);
    assert.equal(calls(test.events, 'audit').length, 0);
  }

  {
    const test = fixture();
    test.dependencies.audit = async (...args) => {
      test.events.push(['audit', ...args]);
      throw new Error('audit unavailable');
    };
    const result = await instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', idempotencyKey: 'post-audit-failed'
    }, test.dependencies);

    assert.equal(result.mediaId, 'media-1');
    assert.ok(names(test.events).indexOf('succeed') < names(test.events).indexOf('audit'));
    assert.equal(calls(test.events, 'uncertain').length, 0);
  }

  {
    const test = fixture();
    test.dependencies.state = {
      getStateStore: () => { throw new Error('state must be bypassed without a key'); },
      hashInput: () => { throw new Error('hashing must be bypassed without a key'); }
    };
    const result = await instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg', caption: 'no key'
    }, test.dependencies);

    assert.deepEqual(result, { containerId: 'container-1', mediaId: 'media-1', status: 'published' });
    assert.equal(calls(test.events, 'getStateStore').length, 0);
    assert.equal(calls(test.events, 'reserve').length, 0);
    assert.equal(calls(test.events, 'fail').length, 0);
    assert.equal(calls(test.events, 'uncertain').length, 0);
    assert.equal(calls(test.events, 'succeed').length, 0);
  }

  console.log('Instagram saga tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
