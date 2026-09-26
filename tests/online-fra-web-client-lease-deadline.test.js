'use strict';

/* T1609: the lease request is not complete when its headers arrive. These
 * cases control the deadline and defer fetch/body promises, so they prove the
 * boundary without a wall-clock or thermal claim. */
const assert = require('node:assert/strict');
const test = require('node:test');

const clientModule = import('../src/lib/online-fra-web-client.mjs');
const BASE = {
  accountOrigin: 'https://toolsenabled.ai',
  relayUrl: 'wss://toolsenabled.ai/v1/rendezvous',
  relayPairId: 'pair-t1609',
};

function validLeaseResponse() {
  return {
    status: 201,
    json: async () => ({
      lease: { endpointRole: 'web-client', peerDeviceId: 'device-t1609' },
      machine: { deviceId: 'device-t1609', ed25519PublicKey: 'not-used-after-timeout' },
    }),
  };
}

async function controlledDeadline(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let deadline = null;
  globalThis.setTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, 8000, 'the focused fixture uses a deterministic eight-second lease budget');
    deadline = callback;
    return 1609;
  };
  globalThis.clearTimeout = () => {};
  try {
    await run(() => deadline);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

test('one lease deadline owns fetch, response body, and late resolution', { concurrency: false }, async () => {
  const { createWebClient, OnlineFraWebClientError } = await clientModule;

  await controlledDeadline(async getDeadline => {
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
    let bodyStartedResolve;
    const bodyStarted = new Promise(resolve => { bodyStartedResolve = resolve; });
    let rejectBody = null;
    let fetchCalls = 0;
    let seenSignal = null;
    let socketOpened = false;
    const client = createWebClient({
      ...BASE,
      leaseTimeoutMs: 8000,
      WebSocketImpl: class { constructor() { socketOpened = true; } },
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        assert.equal(options.method, 'POST');
        seenSignal = options && options.signal;
        fetchStartedResolve();
        return {
          status: 201,
          json: () => {
            bodyStartedResolve();
            return new Promise((_resolve, reject) => {
              rejectBody = reject;
              if (seenSignal) seenSignal.addEventListener('abort', () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })), { once: true });
            });
          },
        };
      },
    });
    const pending = client.connect();
    pending.catch(() => {});
    try {
      await fetchStarted;
      await bodyStarted;
      assert.ok(seenSignal, 'the lease fetch must receive an AbortSignal');
      const deadline = getDeadline();
      assert.equal(typeof deadline, 'function', 'the deadline must be scheduled before response.json()');
      deadline();
      await assert.rejects(pending, error => {
        assert.ok(error instanceof OnlineFraWebClientError);
        assert.equal(error.code, 'WEB_CLIENT_LEASE_UNKNOWN');
        assert.match(error.message, /was not confirmed|unknown/i);
        return true;
      });
      assert.ok(seenSignal.aborted, 'the same signal must abort the stalled body');
      assert.equal(socketOpened, false, 'a timed-out body must never open a relay socket');
      assert.equal(fetchCalls, 1, 'a timed-out lease is never blindly retried');
    } finally {
      if (rejectBody) rejectBody(new Error('fixture cleanup'));
      await pending.catch(() => {});
    }
  });

  await controlledDeadline(async getDeadline => {
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
    let resolveFetch = null;
    let fetchCalls = 0;
    let bodyStartedResolve;
    const bodyStarted = new Promise(resolve => { bodyStartedResolve = resolve; });
    let resolveBody = null;
    let bodySettledResolve;
    const bodySettled = new Promise(resolve => { bodySettledResolve = resolve; });
    let seenSignal = null;
    let socketOpened = false;
    const client = createWebClient({
      ...BASE,
      leaseTimeoutMs: 8000,
      WebSocketImpl: class { constructor() { socketOpened = true; } },
      /* This fetch ignores abort and resolves only after the deadline. The
       * local race, not the transport's cooperation, must settle connect(). */
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        assert.equal(options.method, 'POST');
        seenSignal = options && options.signal;
        fetchStartedResolve();
        return new Promise(resolve => {
          resolveFetch = () => resolve({
            status: 201,
            json: () => {
              bodyStartedResolve();
              return new Promise(bodyResolve => {
                resolveBody = () => {
                  bodyResolve({
                    lease: { endpointRole: 'web-client', peerDeviceId: 'device-t1609' },
                    machine: { deviceId: 'device-t1609', ed25519PublicKey: 'late-success' },
                  });
                  bodySettledResolve();
                };
              });
            },
          });
        });
      },
    });
    const pending = client.connect();
    pending.catch(() => {});
    try {
      await fetchStarted;
      assert.ok(seenSignal);
      const deadline = getDeadline();
      assert.equal(typeof deadline, 'function', 'the deadline must enclose fetchImpl itself');
      deadline();
      await assert.rejects(pending, error => error && error.code === 'WEB_CLIENT_LEASE_UNKNOWN');
      assert.equal(fetchCalls, 1, 'a timed-out lease is never blindly retried');
      resolveFetch();
      await bodyStarted;
      resolveBody();
      await bodySettled;
      assert.equal(socketOpened, false, 'a late successful body must not continue into relay setup');
    } finally {
      if (resolveFetch) resolveFetch();
      if (resolveBody) resolveBody();
      await pending.catch(() => {});
    }
  });

  await controlledDeadline(async () => {
    let fetchCalls = 0;
    let bodyStartedResolve;
    const bodyStarted = new Promise(resolve => { bodyStartedResolve = resolve; });
    let seenSignal = null;
    let socketOpened = false;
    const client = createWebClient({
      ...BASE,
      leaseTimeoutMs: 8000,
      WebSocketImpl: class { constructor() { socketOpened = true; } },
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        assert.equal(options.method, 'POST');
        seenSignal = options.signal;
        return {
          status: 201,
          json: async () => {
            bodyStartedResolve();
            assert.equal(seenSignal.aborted, false, 'this parser failure is not caused by our local abort');
            throw Object.assign(new Error('body parser aborted'), { name: 'AbortError' });
          },
        };
      },
    });
    const pending = client.connect();
    pending.catch(() => {});
    try {
      await bodyStarted;
      await assert.rejects(pending, error => error && error.code === 'WEB_CLIENT_LEASE_UNKNOWN',
        'a body AbortError without our local signal is still an unknown lease outcome');
      assert.equal(fetchCalls, 1, 'an uncertain body outcome is never retried');
      assert.equal(socketOpened, false);
    } finally {
      await pending.catch(() => {});
    }
  });

  let socketOpened = false;
  let refusalFetchCalls = 0;
  const refusal = createWebClient({
    ...BASE,
    WebSocketImpl: class { constructor() { socketOpened = true; } },
    fetchImpl: async (_url, options) => {
      refusalFetchCalls += 1;
      assert.equal(options.method, 'POST');
      return { status: 403, json: async () => ({ error: { code: 'PASSKEY_REQUIRED' } }) };
    },
  });
  await assert.rejects(refusal.connect(), error => error && error.code === 'WEB_CLIENT_LEASE_REFUSED',
    'a complete explicit HTTP refusal remains a refusal, not an unknown timeout');
  assert.equal(socketOpened, false);
  assert.equal(refusalFetchCalls, 1, 'an explicit refusal is not retried');
});
