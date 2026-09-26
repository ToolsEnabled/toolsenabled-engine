'use strict';

const assert = require('node:assert/strict');
const {
  REQUEST_TIMEOUT_MS,
  main,
  sendEnvelope
} = require('../tools/full-remote-access-enroll-peer');

async function run() {
  assert.equal(REQUEST_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  let requestOptions = null;
  let requestPayload = null;
  const envelope = {
    schemaVersion: 'test', createdAtMs: 1, sourceHost: '203.0.113.1',
    targetHost: '203.0.113.2', nonce: 'n', iv: 'i', ciphertext: 'c', tag: 't'
  };
  const requestImpl = (options, callback) => {
    requestOptions = options;
    const handlers = {};
    const request = {
      on(name, handler) { handlers[name] = handler; return request; },
      end(payload) {
        requestPayload = Buffer.from(payload);
        const responseHandlers = {};
        const response = {
          statusCode: 200,
          on(name, handler) { responseHandlers[name] = handler; return response; }
        };
        callback(response);
        responseHandlers.data(Buffer.from('{"ok":true}', 'utf8'));
        responseHandlers.end();
      },
      destroy(error) { if (handlers.error) handlers.error(error); }
    };
    return request;
  };
  assert.equal(await sendEnvelope({ host: '203.0.113.2', envelope, requestImpl }), true);
  assert.equal(requestOptions.host, '203.0.113.2');
  assert.equal(requestOptions.port, 8793);
  assert.equal(requestOptions.path, '/v1/enroll-token');
  assert.equal(requestOptions.timeout, REQUEST_TIMEOUT_MS);
  assert.deepEqual(JSON.parse(requestPayload.toString('utf8')), envelope);
  assert.doesNotMatch(JSON.stringify(requestOptions), /full_remote_access_token|remote_agent_bridge_token/);

  const invalidResponseRequestImpl = (options, callback) => ({
    on() { return this; },
    end() {
      const responseHandlers = {};
      callback({
        statusCode: 200,
        on(name, handler) { responseHandlers[name] = handler; return this; }
      });
      responseHandlers.data(Buffer.from('not-json', 'utf8'));
      responseHandlers.end();
    }
  });
  await assert.rejects(
    () => sendEnvelope({ host: '203.0.113.2', envelope, requestImpl: invalidResponseRequestImpl }),
    error => error && error.code === 'FRA_ENROLLMENT_PEER_RESPONSE_INVALID'
  );

  let vaultReads = 0;
  let sends = 0;
  await assert.rejects(() => main({
    resolveHostFn: () => '203.0.113.1',
    peerForHostFn: () => '203.0.113.2',
    runIntegrityFn: async () => {
      throw Object.assign(new Error('drift'), { code: 'FRA_RUNTIME_FILE_HASH_MISMATCH' });
    },
    getSecretFn: () => { vaultReads += 1; return 'must-not-be-read'; },
    sendEnvelopeFn: async () => { sends += 1; },
    writeOutputFn: () => {}
  }), error => error && error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');
  assert.equal(vaultReads, 0, 'runtime drift must fail before vault access');
  assert.equal(sends, 0, 'runtime drift must fail before network output');
  console.log('Full Remote Access encrypted peer-enrollment client tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
