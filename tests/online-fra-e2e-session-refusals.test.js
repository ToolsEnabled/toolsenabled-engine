// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const online = require('../src/lib/online-fra-e2e-session');

const DIGEST = 'a'.repeat(64);
let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function throwsCode(run, code) {
  assertions += 1;
  return assert.throws(run, error => error instanceof online.OnlineFraSessionError && error.code === code,
    `operation must refuse with ${code}`);
}

function identities() {
  return [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
}

function endpointOptions(identity, peer, overrides = {}) {
  return {
    identityPrivateKey: identity.privateKey,
    peerPublicKey: peer.publicKey,
    pairId: 'pair-one',
    localDeviceId: 'device-a',
    peerDeviceId: 'device-b',
    role: 'A',
    generation: 1,
    capabilityDigest: DIGEST,
    clock: () => 5_000_000,
    eventSink: () => {},
    ...overrides
  };
}

function pair(overridesA = {}, overridesB = {}) {
  const [identityA, identityB] = identities();
  const eventsA = [];
  const eventsB = [];
  const A = online.createEndpoint(endpointOptions(identityA, identityB, {
    eventSink: event => eventsA.push(event),
    ...overridesA
  }));
  const B = online.createEndpoint(endpointOptions(identityB, identityA, {
    localDeviceId: 'device-b', peerDeviceId: 'device-a', role: 'B',
    eventSink: event => eventsB.push(event),
    ...overridesB
  }));
  return { A, B, eventsA, eventsB };
}

function establish(overridesA = {}, overridesB = {}) {
  const setup = pair(overridesA, overridesB);
  const helloA = setup.A.createHello();
  const helloB = setup.B.createHello();
  return { ...setup, sessionA: setup.A.acceptPeerHello(helloB), sessionB: setup.B.acceptPeerHello(helloA) };
}

// Constructor input is rejected before any hook can run.
{
  throwsCode(() => online.createEndpoint(null), 'ONLINE_FRA_INPUT_INVALID');
  const [identityA, identityB] = identities();
  let writes = 0;
  throwsCode(() => online.createEndpoint(endpointOptions(identityA, identityB, {
    clock: 42, eventSink: () => { writes += 1; }
  })), 'ONLINE_FRA_INPUT_INVALID');
  equal(writes, 0, 'invalid endpoint hooks must not emit metadata');
}

// The digest validator is driven through the public factory, before any event write.
{
  const [identityA, identityB] = identities();
  let writes = 0;
  throwsCode(() => online.createEndpoint(endpointOptions(identityA, identityB, {
    capabilityDigest: 'A'.repeat(64), eventSink: () => { writes += 1; }
  })), 'ONLINE_FRA_DIGEST_INVALID');
  equal(writes, 0, 'an invalid digest must not emit metadata');
}

// A second hello neither generates another keypair nor consumes randomness.
{
  let generated = 0;
  let randomCalls = 0;
  let writes = 0;
  const [identityA, identityB] = identities();
  const endpoint = online.createEndpoint(endpointOptions(identityA, identityB, {
    keyPairGenerator: () => { generated += 1; return crypto.generateKeyPairSync('x25519'); },
    randomBytes: length => { randomCalls += 1; return Buffer.alloc(length, randomCalls); },
    eventSink: () => { writes += 1; }
  }));
  endpoint.createHello();
  equal(generated, 1);
  equal(randomCalls, 2);
  throwsCode(() => endpoint.createHello(), 'ONLINE_FRA_HANDSHAKE_CONSUMED');
  equal(generated, 1, 'refused second hello must not generate an ephemeral key');
  equal(randomCalls, 2, 'refused second hello must not draw randomness');
  equal(writes, 0, 'creating/refusing hellos must not emit session metadata');
}

// Invalid clock output stops before ephemeral generation, randomness, or events.
{
  const [identityA, identityB] = identities();
  let generated = 0;
  let randomCalls = 0;
  let writes = 0;
  const endpoint = online.createEndpoint(endpointOptions(identityA, identityB, {
    clock: () => NaN,
    keyPairGenerator: () => { generated += 1; return crypto.generateKeyPairSync('x25519'); },
    randomBytes: length => { randomCalls += 1; return Buffer.alloc(length); },
    eventSink: () => { writes += 1; }
  }));
  throwsCode(() => endpoint.createHello(), 'ONLINE_FRA_INTERNAL_INVALID');
  equal(generated, 0, 'invalid clock must not spawn ephemeral generation');
  equal(randomCalls, 0, 'invalid clock must not draw randomness');
  equal(writes, 0, 'invalid clock must not emit metadata');
}

// An unexpected verifier implementation failure is collapsed to HANDSHAKE_INVALID.
{
  const setup = pair();
  setup.A.createHello();
  const helloB = setup.B.createHello();
  const original = crypto.verify;
  crypto.verify = () => { throw new Error('injected verifier failure'); };
  try {
    throwsCode(() => setup.A.acceptPeerHello(helloB), 'ONLINE_FRA_HANDSHAKE_INVALID');
  } finally {
    crypto.verify = original;
  }
  equal(setup.A.toJSON().handshakeConsumed, true, 'indeterminate implementation failure must consume this handshake');
  equal(setup.eventsA.length, 1, 'failed handshake emits exactly its rejection metadata');
  equal(setup.eventsA[0].kind, 'online_fra_handshake_rejected');
  equal(setup.eventsB.length, 0, 'peer must not be made to create a session');
}

// A throwing sink prevents acceptPeerHello from returning a session.
{
  let sinkCalls = 0;
  const setup = pair({ eventSink: () => { sinkCalls += 1; throw new Error('sink unavailable'); } });
  setup.A.createHello();
  const helloB = setup.B.createHello();
  throwsCode(() => setup.A.acceptPeerHello(helloB), 'ONLINE_FRA_EVENT_SINK_FAILED');
  equal(setup.A.toJSON().handshakeConsumed, true, 'sink failure remains fail-closed and consumes the handshake');
  equal(sinkCalls, 2, 'session-created write and subsequent rejection write both fail rather than returning a session');
  equal(setup.eventsB.length, 0, 'the peer was not asked to establish or emit anything');
}

// Authentication failure closes the receiver, emits rejection, and returns no plaintext.
{
  const setup = establish();
  const frame = setup.sessionA.seal('secret');
  const ciphertext = Buffer.from(frame.ciphertext, 'base64url');
  ciphertext[0] ^= 1;
  throwsCode(() => setup.sessionB.open({ ...frame, ciphertext: ciphertext.toString('base64url') }), 'ONLINE_FRA_DECRYPTION_FAILED');
  equal(setup.sessionB.closed, true, 'decryption refusal drops receive state');
  equal(setup.eventsB.at(-1).kind, 'online_fra_frame_rejected');
  equal(setup.eventsB.length, 2, 'receiver emits creation then one rejection only');
}

// Inject a cipher-construction failure through Node crypto and prove no frame escapes.
{
  const setup = establish();
  const original = crypto.createCipheriv;
  let result = 'not-called';
  crypto.createCipheriv = () => { throw new Error('injected cipher failure'); };
  try {
    throwsCode(() => { result = setup.sessionA.seal('secret'); }, 'ONLINE_FRA_ENCRYPTION_FAILED');
  } finally {
    crypto.createCipheriv = original;
  }
  equal(result, 'not-called', 'encryption refusal must not return a frame');
  equal(setup.sessionA.closed, true, 'encryption refusal drops send state');
  equal(setup.eventsA.at(-1).kind, 'online_fra_frame_rejected');
  equal(setup.eventsA.length, 2, 'sender emits creation then one rejection only');
}

console.log(`online-fra-e2e-session refusals: ${assertions} assertions passed`);
