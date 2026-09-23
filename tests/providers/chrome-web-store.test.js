// Mutation check (2026-08-27):
// In src/lib/providers/chrome-web-store.js, changed the itemPath item segment
// from encodeURIComponent(itemId) to itemId.
// The edit landed (verified by matching the mutated source).
// This isolated test went red with exit code 1 on its encoded-URL assertion.

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const providerRoot = path.resolve(__dirname, '..', '..', 'src', 'lib', 'providers');
const modulePath = require.resolve('../../src/lib/providers/chrome-web-store');
const originalLoad = Module._load;
const auditRecords = [];

Module._load = function load(request, parent, isMain) {
  if (parent && path.dirname(parent.filename) === providerRoot) {
    if (request === '../policy') return { assertActive() {} };
    if (request === '../audit') {
      return { record: (action, target, details) => auditRecords.push({ action, target, details }) };
    }
    if (request === '../google-oauth') {
      return { authenticatedRequest: async () => { throw new Error('unexpected default transport call'); } };
    }
    if (request === '../configured-project-boundary') {
      return {
        isProtectedStoreItem: () => false,
        isWithinConfiguredRoot: () => false,
        protectedStoreItemId: () => null
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[modulePath];
const chromeWebStore = require('../../src/lib/providers/chrome-web-store');
Module._load = originalLoad;

(async () => {
  try {
    const calls = [];
    const response = { state: 'PUBLISHED', revisionId: 'revision-7' };
    const result = await chromeWebStore.publish({
      publisherId: 'publisher/with space',
      itemId: 'item?with/slash',
      staged: true,
      deployPercentage: '35',
      skipReview: true,
      blockOnWarnings: false
    }, {
      authenticatedRequest: async (url, init, oauthKeys) => {
        calls.push({ url, init, oauthKeys });
        return { body: response };
      }
    });

    assert.equal(result, response, 'publish returns the provider response body unchanged');
    assert.deepEqual(calls, [{
      url: 'https://chromewebstore.googleapis.com/v2/publishers/publisher%2Fwith%20space/items/item%3Fwith%2Fslash:publish',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publishType: 'STAGED_PUBLISH',
          skipReview: true,
          blockOnWarnings: false,
          deployInfos: [{ deployPercentage: 35 }]
        })
      },
      oauthKeys: {
        accessKey: 'cws_access_token',
        refreshKey: 'cws_refresh_token',
        clientIdKey: 'cws_client_id',
        clientSecretKey: 'cws_client_secret'
      }
    }], 'publish encodes identifiers and sends the staged rollout contract');

    assert.deepEqual(auditRecords, [{
      action: 'chromeWebStore.publish',
      target: 'item?with/slash',
      details: {
        publisherId: 'publisher/with space',
        staged: true,
        deployPercentage: '35',
        skipReview: true,
        state: 'PUBLISHED'
      }
    }], 'publish records the completed operation and returned state');

    const defaultCalls = [];
    await chromeWebStore.publish({ publisherId: 'publisher', itemId: 'item' }, {
      authenticatedRequest: async (_url, init) => {
        defaultCalls.push(JSON.parse(init.body));
        return { body: { state: 'PUBLISHED' } };
      }
    });
    assert.equal(defaultCalls[0].publishType, 'DEFAULT_PUBLISH',
      'the caller-reachable default publish mode is sent to the provider');

    const completedAlias = await chromeWebStore.waitForUpload({
      publisherId: 'publisher', itemId: 'item', initial: { uploadState: 'UPLOAD_SUCCEEDED', marker: 1 }
    }, {
      fetchStatus: async () => { throw new Error('completed upload polled'); },
      sleep: async () => { throw new Error('completed upload slept'); }
    });
    assert.deepEqual(completedAlias, { uploadState: 'SUCCEEDED', marker: 1, polls: 0 },
      'UPLOAD_SUCCEEDED completes immediately without polling or sleeping');

    for (const pendingState of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
      let statusCalls = 0;
      let sleepCalls = 0;
      const pendingResult = await chromeWebStore.waitForUpload({
        publisherId: 'publisher', itemId: 'item', initial: { uploadState: pendingState }
      }, {
        now: () => 0,
        sleep: async () => { sleepCalls += 1; },
        fetchStatus: async () => {
          statusCalls += 1;
          return { lastAsyncUploadState: 'UPLOAD_SUCCEEDED' };
        }
      });
      assert.equal(pendingResult.uploadState, 'SUCCEEDED');
      assert.equal(pendingResult.polls, 1);
      assert.equal(statusCalls, 1, `${pendingState} is treated as pending and polls exactly once`);
      assert.equal(sleepCalls, 1, `${pendingState} waits exactly once before polling`);
    }

    const recordsBeforeRefusal = auditRecords.length;
    let refusedStatusCalls = 0;
    let refusedSleepCalls = 0;
    await assert.rejects(
      chromeWebStore.waitForUpload({
        publisherId: 'publisher', itemId: 'item', initial: {}
      }, {
        fetchStatus: async () => { refusedStatusCalls += 1; },
        sleep: async () => { refusedSleepCalls += 1; }
      }),
      error => error.message === "Chrome Web Store upload failed with state 'UNSPECIFIED'."
    );
    assert.equal(refusedStatusCalls, 0, 'an unspecified initial state refuses without a status request');
    assert.equal(refusedSleepCalls, 0, 'an unspecified initial state refuses without scheduling a wait');
    assert.equal(auditRecords.length, recordsBeforeRefusal, 'an unspecified refusal writes no audit record');

    for (const deployPercentage of [-1, 101, 2.5, 'not-a-number']) {
      await assert.rejects(
        chromeWebStore.publish({ publisherId: 'publisher', itemId: 'item', deployPercentage }, {
          authenticatedRequest: async () => { throw new Error('invalid rollout reached transport'); }
        }),
        /deployPercentage must be an integer from 0 through 100/
      );
    }

    console.log('chrome-web-store behavior: PASS (publish modes, upload states, refusal side effects, rollout validation)');
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
