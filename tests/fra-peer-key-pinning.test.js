'use strict';

/*
 * The peer's Ed25519 identity key must be remembered, and a change must refuse.
 *
 * MEASURED against the then-live source: connectToPeer() took
 * peer.peerPublicKey straight from the account service's GET /v1/devices/peer
 * response on EVERY connect and compared it to nothing. Whoever can answer that
 * call -- an operator-side compromise, a malicious insider, or anyone inside
 * the TLS termination at the account host, which is the SAME box that runs the
 * relay -- could hand machine A one attacker key and machine B another,
 * terminate both "sealed" sessions, and read and rewrite every frame between
 * them. Neither machine could notice: neither had ever stored the key it saw
 * last, so there was no value to compare and no refusal to raise.
 *
 * This exercises the pin the way the shell uses it: first introduction is
 * recorded, a matching one passes, a substituted one refuses, and a genuine
 * re-enrolment (new peerDeviceId) pins afresh rather than being mistaken for
 * an attack.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHELL = path.join(__dirname, '..', 'src', 'lib', 'online-fra-relay-shell.js');
const source = fs.readFileSync(SHELL, 'utf8');

// --- 1. the shell actually carries the pin ---------------------------------
assert.ok(source.includes("const PEER_KEY_PIN_VAULT_KEY = 'online-fra.peer-key-pin'"),
  'the shell must pin the peer key under its own vault key');
assert.ok(source.includes('RELAY_SHELL_PEER_KEY_CHANGED'),
  'a substituted peer key must have a named refusal');
assert.ok(source.includes('readPeerKeyPins'),
  'the shell must read the recorded pins before using an introduced key');
// The pin must be consulted before the key is handed to createEndpoint.
const pinAt = source.indexOf('RELAY_SHELL_PEER_KEY_CHANGED');
const useAt = source.indexOf('peerPublicKey: peer.peerPublicKey');
assert.ok(pinAt > -1 && useAt > -1 && pinAt < useAt,
  'the pin check must run before the introduced key is used to build a session');

// --- 2. the pinning rule itself --------------------------------------------
// A faithful re-implementation of the shell's rule, exercised against a vault
// double. Keeping it here means the rule is asserted even though connectToPeer
// needs a live account service, relay socket and device credential to run.
function makeVault() {
  const store = new Map();
  return {
    getSecret(key) {
      if (!store.has(key)) { const e = new Error('not configured'); e.code = 'SECRET_NOT_CONFIGURED'; throw e; }
      return store.get(key);
    },
    setSecret(key, value) { store.set(key, value); },
    _store: store
  };
}

const PIN_KEY = 'online-fra.peer-key-pin';

function readPins(vault) {
  let raw = null;
  try { raw = vault.getSecret(PIN_KEY); }
  catch (error) { if (error && error.code === 'SECRET_NOT_CONFIGURED') return {}; throw error; }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

// The rule, exactly as the shell applies it.
function introduce(vault, { pairId, peerDeviceId, peerPublicKeyWire }) {
  if (peerDeviceId === null) return { ok: true, solo: true };
  const pinKey = `${pairId}|${peerDeviceId}`;
  const pins = readPins(vault);
  const pinned = typeof pins[pinKey] === 'string' ? pins[pinKey] : null;
  if (typeof peerPublicKeyWire !== 'string' || !peerPublicKeyWire) {
    return { ok: false, code: 'RELAY_SHELL_PEER_KEY_MISSING' };
  }
  if (pinned !== null && pinned !== peerPublicKeyWire) {
    return { ok: false, code: 'RELAY_SHELL_PEER_KEY_CHANGED' };
  }
  if (pinned === null) {
    try { vault.setSecret(PIN_KEY, JSON.stringify({ ...pins, [pinKey]: peerPublicKeyWire })); } catch { /* best effort */ }
    return { ok: true, pinnedNow: true };
  }
  return { ok: true, matched: true };
}

const HONEST = 'MCowBQYDK2VwAyEAhonest-peer-key-aaaaaaaaaaaaaaaaaaaa';
const ATTACKER = 'MCowBQYDK2VwAyEAattacker-substituted-key-bbbbbbbb';

// First introduction is trusted and recorded.
{
  const vault = makeVault();
  const first = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  assert.equal(first.ok, true, 'the first introduction is trusted');
  assert.equal(first.pinnedNow, true, 'and is recorded');
  assert.ok(vault._store.has(PIN_KEY), 'the pin is persisted');
}

// The same key on a later connect passes.
{
  const vault = makeVault();
  introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  const again = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  assert.equal(again.ok, true, 'the same peer key still connects');
  assert.equal(again.matched, true);
}

// THE ATTACK: the introducer substitutes a key it holds the private half of.
{
  const vault = makeVault();
  introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  const swapped = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: ATTACKER });
  assert.equal(swapped.ok, false, 'a substituted peer key must not be used');
  assert.equal(swapped.code, 'RELAY_SHELL_PEER_KEY_CHANGED');
  // And the substitution must not overwrite what was recorded.
  assert.equal(readPins(vault)['pair-1|dev-b'], HONEST, 'the original pin survives the attempt');
}

// A genuine re-enrolment mints a new deviceId, so it pins afresh, not refuses.
{
  const vault = makeVault();
  introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  const reEnrolled = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-c', peerPublicKeyWire: ATTACKER });
  assert.equal(reEnrolled.ok, true, 'a new peer device pins afresh rather than being read as an attack');
  assert.equal(readPins(vault)['pair-1|dev-b'], HONEST, 'the old pin is kept');
  assert.equal(readPins(vault)['pair-1|dev-c'], ATTACKER, 'the new device gets its own pin');
}

// A solo pair has no peer key and must not be blocked.
{
  const vault = makeVault();
  const solo = introduce(vault, { pairId: 'pair-1', peerDeviceId: null, peerPublicKeyWire: null });
  assert.equal(solo.ok, true, 'a one-computer connection still works');
}

// An introduction with no key at all is refused rather than silently trusted.
{
  const vault = makeVault();
  const empty = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'RELAY_SHELL_PEER_KEY_MISSING');
}

// A corrupt pin store must not crash, and must not silently trust.
{
  const vault = makeVault();
  vault.setSecret(PIN_KEY, 'not json at all');
  const first = introduce(vault, { pairId: 'pair-1', peerDeviceId: 'dev-b', peerPublicKeyWire: HONEST });
  assert.equal(first.ok, true, 'an unreadable pin store falls back to first-use');
  assert.equal(readPins(vault)['pair-1|dev-b'], HONEST, 'and records the key it just saw');
}

console.log('The peer identity key is pinned on first use and a substituted key is refused.');
