'use strict';

// model.js's local Ollama transport, driven over a real socket. The injected
// `http` only redirects the fixed Ollama port to an ephemeral loopback server
// owned by this file; the request, its idle deadline and its teardown are the
// real node:http ones.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const model = require('../src/lib/providers/model');
const machineProfile = require('../src/lib/machine-profile');

const profile = {
  ...machineProfile.singleMachineDefault(() => 'timeout-test-host'),
  source: 'profile', rejected: [], peers: [{ id: 'gpu-box', address: '127.0.0.1' }]
};

async function server(handler) {
  const sockets = new Set();
  const listening = http.createServer(handler);
  listening.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => listening.listen(0, '127.0.0.1', resolve));
  const port = listening.address().port;
  return {
    dependencies: {
      loadMachineProfile: () => profile,
      http: { request: (options, callback) => http.request({ ...options, port }, callback) }
    },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); listening.close(resolve); })
  };
}

test('a local model that is still generating when the deadline expires is reported as a timeout', async t => {
  const silent = await server(() => { /* accepted; the answer never comes */ });
  t.after(silent.close);
  let thrown = null;
  await assert.rejects(model.localJsonRequest('/api/chat', { model: 'm', messages: [], stream: false },
    { timeoutMs: 250, dependencies: silent.dependencies }), error => { thrown = error; return true; });
  // research-hermes maps this code to HERMES_TIMEOUT and model.js's tier
  // fallback names it too (tests/providers.research/research-hermes.js drives
  // that mapping); before this transport produced it, neither was reachable.
  assert.equal(thrown.code, 'MODEL_OLLAMA_TIMEOUT',
    'a deadline that expired is not a service that is unavailable');
  assert.match(thrown.message, /timed out/);
});

test('a refused connection is still reported as unavailable', async () => {
  const closed = await server(() => {});
  const { dependencies } = closed;
  await closed.close();
  await assert.rejects(model.localJsonRequest('/api/tags', undefined, { timeoutMs: 2000, dependencies }),
    error => error.code === 'MODEL_OLLAMA_UNAVAILABLE');
});

test('an answered request is unaffected', async t => {
  const answering = await server((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'hermes3:8b' }] }));
  });
  t.after(answering.close);
  const value = await model.localJsonRequest('/api/tags', undefined, { timeoutMs: 2000, dependencies: answering.dependencies });
  assert.deepEqual(value, { models: [{ name: 'hermes3:8b' }] });
});
