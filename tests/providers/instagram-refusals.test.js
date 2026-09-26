'use strict';

const assert = require('node:assert/strict');
const instagram = require('../../src/lib/providers/instagram');

function fixture(responses) {
  const calls = [];
  const queue = [...responses];
  const store = {
    reserveOperation: async input => {
      calls.push(['reserve', input]);
      return { disposition: 'reserved', handle: { id: 'operation-1' } };
    },
    markOperationExecuting: async (...args) => { calls.push(['executing', ...args]); },
    heartbeatOperation: async (...args) => { calls.push(['heartbeat', ...args]); },
    failOperation: async (...args) => { calls.push(['fail', ...args]); },
    markOperationUncertain: async (...args) => { calls.push(['uncertain', ...args]); },
    succeedOperation: async (...args) => { calls.push(['succeed', ...args]); }
  };
  const dependencies = {
    config: () => ({ userId: 'owner-1', token: 'token', apiVersion: 'v-test' }),
    api: async (path, options) => {
      calls.push(['api', path, options]);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async delay => { calls.push(['sleep', delay]); },
    audit: async (...args) => { calls.push(['audit', ...args]); },
    clock: () => 4242,
    state: {
      getStateStore: () => store,
      hashInput: () => 'input-hash'
    }
  };
  return { calls, dependencies };
}

function named(calls, name) {
  return calls.filter(call => call[0] === name);
}

async function captureRejection(test) {
  let rejection;
  try {
    await instagram.publishImage({
      imageUrl: 'https://example.test/image.jpg',
      idempotencyKey: 'refusal-test'
    }, test.dependencies);
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection, 'publishImage must reject');
  return rejection;
}

(async () => {
  {
    const test = fixture([new Error('container request refused')]);
    const rejection = await captureRejection(test);

    assert.match(rejection.message, /container request refused/);
    assert.equal(named(test.calls, 'fail').length, 1);
    assert.deepEqual(named(test.calls, 'fail')[0][2], {
      errorCode: 'INSTAGRAM_PRE_PUBLISH_FAILED',
      errorMessage: 'Instagram failed before the final publish request; a fenced retry is safe.',
      retryAtMs: 4242
    });
    assert.equal(named(test.calls, 'uncertain').length, 0);
    assert.equal(named(test.calls, 'succeed').length, 0);
    assert.equal(named(test.calls, 'audit').length, 0);
    assert.equal(named(test.calls, 'api').some(call => call[1].endsWith('/media_publish')), false);
  }

  {
    const test = fixture([
      { id: 'container-expired' },
      { status_code: 'EXPIRED' }
    ]);
    const rejection = await captureRejection(test);

    assert.match(rejection.message, /container container-expired ended as EXPIRED/);
    assert.equal(named(test.calls, 'sleep').length, 0);
    assert.equal(named(test.calls, 'fail').length, 1);
    assert.equal(named(test.calls, 'fail')[0][2].errorCode, 'INSTAGRAM_PRE_PUBLISH_FAILED');
    assert.equal(named(test.calls, 'uncertain').length, 0);
    assert.equal(named(test.calls, 'succeed').length, 0);
    assert.equal(named(test.calls, 'audit').length, 0);
    assert.equal(named(test.calls, 'api').some(call => call[1].endsWith('/media_publish')), false);
  }

  {
    const test = fixture([
      { id: 'container-ready' },
      { status_code: 'FINISHED' },
      new Error('publish response unavailable')
    ]);
    const rejection = await captureRejection(test);

    assert.match(rejection.message, /publish response unavailable/);
    assert.equal(named(test.calls, 'uncertain').length, 1);
    assert.deepEqual(named(test.calls, 'uncertain')[0][2], {
      errorCode: 'INSTAGRAM_EXTERNAL_COMMIT_UNCERTAIN',
      errorMessage: 'Instagram may have accepted the final publish request; automatic retry is disabled.'
    });
    assert.equal(named(test.calls, 'fail').length, 0);
    assert.equal(named(test.calls, 'succeed').length, 0);
    assert.equal(named(test.calls, 'audit').length, 0);
    assert.equal(named(test.calls, 'api').filter(call => call[1].endsWith('/media_publish')).length, 1);
  }

  console.log('Instagram refusal tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
