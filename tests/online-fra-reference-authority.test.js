'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDeviceRegistry, createRelayLeaseMinter } = require('./helpers/online-fra-reference-fixture');
const { createBrowserAuthority } = require('../src/lib/online-fra-browser-authority');

test('reference introduction respects signed expiry and cannot revive revoked browser authority', async () => {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const devices = createDeviceRegistry({ clock });
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const a = devices.enrol({ accountId: 'fixture', name: 'a', ed25519PublicKey: publicKey });
  const b = devices.enrol({ accountId: 'fixture', name: 'b', ed25519PublicKey: publicKey });
  const pair = devices.formRelayPair({ accountId: 'fixture', aPairId: a.pairId, bPairId: b.pairId, capabilityDigest: 'e'.repeat(64) });
  const minter = createRelayLeaseMinter({ devices, authority: keys.privateKey, clock });
  const mint = () => minter.mintWeb({ accountId: 'fixture', relayPairId: pair.relayPairId,
    publicKeySpki: publicKey, ephemeralX25519PublicKey: 'fixture-ephemeral' });
  const authority = createBrowserAuthority({ clock, monotonicClock: clock, load: async () => {
    const webPeer = devices.webSessionFor(pair.relayPairId);
    return { status: webPeer ? 200 : 404, json: async () => ({ webPeer }) };
  } });
  try {
    const minted = mint();
    const id = minted.lease.deviceId;
    assert.match(id, /^web-[A-Za-z0-9_-]{1,128}$/);
    const initial = devices.webSessionFor(pair.relayPairId);
    assert.equal(initial.expiresAtMs, minted.lease.expiresAtMs);
    assert.equal(initial.authorizationExpiresAtMs, minted.lease.expiresAtMs);
    assert.equal(initial.authorizationCheckedAtMs, now);
    assert.ok((await authority.resolve(id)).webPeer, 'production parser accepts reference introduction');
    const identity = authority.capture(id);
    now += 31_000;
    assert.equal(await authority.ensure(identity), true, 'live grant can be freshly observed');
    assert.equal(devices.webSessionFor(pair.relayPairId).authorizationExpiresAtMs, initial.authorizationExpiresAtMs,
      'machine observation does not extend browser authority');
    devices.revokeWebSession(pair.relayPairId);
    now += 31_000;
    assert.equal(await authority.ensure(identity), false, 'revoked grant fails at next bounded authority check');
    assert.equal(devices.webSessionFor(pair.relayPairId), null);
    const next = mint();
    now = next.lease.expiresAtMs;
    assert.equal(devices.webSessionFor(pair.relayPairId), null, 'expired transport cannot be reintroduced');
  } finally { authority.close(); devices.close(); }
});
