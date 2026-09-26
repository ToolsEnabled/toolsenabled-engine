'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fra = require('../src/lib/fra-secure-session');

const registry = {
  schemaVersion: 1,
  machines: {
    server: { address: '203.0.113.1' },
    client: { address: '203.0.113.2' }
  },
  services: {}
};
const serviceRegistryOptions = { registry };

function bytes() {
  let seed = 0;
  return length => Buffer.alloc(length, (seed += 1) & 0xff);
}

function handshake() {
  const randomBytes = bytes();
  const masterKey = fra.deriveMasterKey('refusal-coverage-secret-0123456789');
  const server = new fra.FraServerSessionManager({
    masterKey,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    clock: () => 10_000,
    randomBytes,
    serviceRegistryOptions
  });
  const challenge = server.issueChallenge();
  const client = fra.beginClientHandshake({
    masterKey,
    challenge,
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    clock: () => 10_000,
    randomBytes,
    serviceRegistryOptions
  });
  const accepted = server.acceptResponse(client.response);
  return { server, client, accepted };
}

// A malformed injected entropy source must refuse before a challenge is
// recorded. This exercises bytes() through issueChallenge(), rather than
// merely checking that the refusal name exists in source.
{
  const manager = new fra.FraServerSessionManager({
    masterKey: fra.deriveMasterKey('invalid-random-source-0123456789'),
    serverHost: '203.0.113.1',
    clientHost: '203.0.113.2',
    clock: () => 10_000,
    randomBytes: length => Buffer.alloc(length - 1),
    serviceRegistryOptions
  });
  assert.throws(() => manager.issueChallenge(), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_INTERNAL_INVALID');
  assert.deepEqual(manager.toJSON(), {
    serverHost: '203.0.113.1', clientHost: '203.0.113.2', generation: 0,
    pendingChallenges: 0, activeSessions: 0
  });
}

// Identity mismatch consumes the one-shot client handshake and returns no
// session. In particular, a valid authorization cannot be retried afterward.
{
  const setup = handshake();
  const invalid = { ...setup.accepted.authorization, generation: 99 };
  assert.throws(() => setup.client.complete(invalid), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_SERVER_AUTHORIZATION_INVALID');
  assert.equal(setup.client.toJSON().complete, true);
  assert.throws(() => setup.client.complete(setup.accepted.authorization), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_HANDSHAKE_CONSUMED');
}

// A validly-shaped frame with a changed authentication tag reaches AES-GCM
// authentication. Refusal closes the receiver and produces no plaintext.
{
  const setup = handshake();
  const clientSession = setup.client.complete(setup.accepted.authorization);
  const frame = clientSession.seal('must not be returned');
  const tag = Buffer.from(frame.tag, 'base64url');
  tag[0] ^= 0x80;
  const invalid = { ...frame, tag: tag.toString('base64url') };
  assert.throws(() => setup.accepted.session.open(invalid), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_DECRYPTION_FAILED');
  assert.equal(setup.accepted.session.closed, true);
  assert.throws(() => setup.accepted.session.open(frame), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_SESSION_CLOSED');
}

// createCipheriv is the encryption boundary used by seal(). Injecting a
// boundary failure proves that no frame escapes and that the session fails
// closed. Always restore the process-wide dependency before further work.
{
  const setup = handshake();
  const session = setup.client.complete(setup.accepted.authorization);
  const originalCreateCipheriv = crypto.createCipheriv;
  let result;
  try {
    crypto.createCipheriv = () => { throw new Error('injected cipher failure'); };
    assert.throws(() => { result = session.seal('must not be encrypted'); }, error => error instanceof fra.FraSessionError
      && error.code === 'FRA_ENCRYPTION_FAILED');
  } finally {
    crypto.createCipheriv = originalCreateCipheriv;
  }
  assert.equal(result, undefined);
  assert.equal(session.closed, true);
  assert.throws(() => session.seal('must not be retried'), error => error instanceof fra.FraSessionError
    && error.code === 'FRA_SESSION_CLOSED');
}

console.log('FRA secure-session refusal tests passed (4 driven refusals).');
