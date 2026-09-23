'use strict';

// THE TORN-READ TESTS ARE THE POINT OF THIS FILE.
//
// `src/full-remote-access-bridge.js` learned in production that a single
// differing vault read must never be allowed to tear down every live session: a
// concurrent legitimate write, a file lock, or a partial DPAPI decrypt would
// otherwise present to the operator as "the peer accepts TCP then hangs up".
// `src/lib/peer-link-rotation.js` is the fourth implementation of that
// discipline, so the assertions below are deliberately about what must NOT
// happen:
//
//   * one differing read must NOT rotate;
//   * A -> unreadable -> A must NOT rotate, because an error breaks
//     consecutiveness and cannot be counted as two agreeing reads;
//   * an unreadable vault must refuse rather than be read as an empty key;
//   * and an installation with no peers must never read the vault AT ALL --
//     no timer, no process spawn, no prompt.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPeerLinkRotator } = require('../src/lib/peer-link-rotation');
const { createIdentity } = require('../src/lib/peer-enrollment');

const KEY_ONE = createIdentity().privateKey;
const KEY_TWO = createIdentity().privateKey;
const KEY_THREE = createIdentity().privateKey;

function peerRegistry(count = 1) {
  const peers = [];
  for (let index = 0; index < count; index += 1) {
    peers.push({ peerId: `pk-${String(index).repeat(32).slice(0, 32)}`, revoked: false });
  }
  return { schemaVersion: 1, source: 'registry', peers };
}

/**
 * A rotator wired to scripted reads. `reads` is consumed one entry per tick:
 * a string is a successful read, an Error is a failed one.
 */
function harness({ reads, registry = peerRegistry(1), fingerprints = null } = {}) {
  const rotations = [];
  const refusals = [];
  let readIndex = 0;
  let fingerprintIndex = 0;
  const observedReads = [];

  const rotator = createPeerLinkRotator({
    loadRegistry: () => registry,
    readIdentityKey: () => {
      const next = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      observedReads.push(next instanceof Error ? `ERR:${next.message}` : next);
      if (next instanceof Error) throw next;
      return next;
    },
    vaultFingerprint: fingerprints === null
      ? () => null // "could not look" -- must always fall through to a real read
      : () => {
        const value = fingerprints[Math.min(fingerprintIndex, fingerprints.length - 1)];
        fingerprintIndex += 1;
        return value;
      },
    onRotated: event => rotations.push(event),
    onRefused: event => refusals.push(event),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {}
  });

  return { rotator, rotations, refusals, observedReads, readCount: () => readIndex };
}

// --- the torn-read rule ----------------------------------------------------

test('a SINGLE differing read does NOT rotate', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, KEY_TWO] });
  rotator.tick(); // baseline
  rotator.tick(); // one differing read -- a candidate, not a rotation
  assert.deepEqual(rotations, []);
  assert.equal(rotator.status().candidatePending, true);
  assert.equal(rotator.status().generation, 0);
});

test('TWO consecutive agreeing reads DO rotate, exactly once', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, KEY_TWO, KEY_TWO, KEY_TWO] });
  rotator.tick();
  rotator.tick();
  rotator.tick();
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].generation, 1);
  assert.equal(rotator.status().candidatePending, false);

  rotator.tick(); // steady state on the new key: no further rotation
  assert.equal(rotations.length, 1);
});

test('A -> torn read -> A does NOT rotate: an error breaks consecutiveness', () => {
  // The exact sequence the FRA bridge guards against. Without the
  // clear-on-error rule, the second KEY_TWO would look like a confirming read.
  const torn = new Error('EBUSY');
  const { rotator, rotations, refusals } = harness({ reads: [KEY_ONE, KEY_TWO, torn, KEY_TWO] });
  rotator.tick(); // baseline KEY_ONE
  rotator.tick(); // candidate KEY_TWO
  rotator.tick(); // torn -> candidate cleared
  assert.equal(rotator.status().candidatePending, false, 'a failed read must clear the pending candidate');
  rotator.tick(); // KEY_TWO again -- a NEW candidate, still not a rotation
  assert.deepEqual(rotations, [], 'a torn read between two agreeing reads must not rotate');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].code, 'PEER_LINK_IDENTITY_UNAVAILABLE');
  assert.equal(rotator.status().candidatePending, true);
});

test('two DISAGREEING candidate reads do not rotate; the newer one replaces the older', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, KEY_TWO, KEY_THREE, KEY_THREE] });
  rotator.tick();
  rotator.tick(); // candidate KEY_TWO
  rotator.tick(); // candidate replaced by KEY_THREE -- not a confirmation
  assert.deepEqual(rotations, []);
  rotator.tick(); // now KEY_THREE agrees with itself
  assert.equal(rotations.length, 1);
});

test('a read that returns to the CURRENT key abandons the candidate without rotating', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, KEY_TWO, KEY_ONE, KEY_ONE] });
  rotator.tick();
  rotator.tick(); // candidate KEY_TWO
  rotator.tick(); // back to KEY_ONE -- the candidate was a transient
  assert.equal(rotator.status().candidatePending, false);
  rotator.tick();
  assert.deepEqual(rotations, [], 'a transient blip must leave the live key untouched');
  assert.equal(rotator.status().generation, 0);
});

// --- an unreadable vault refuses, and is never read as a value -------------

test('an unreadable vault REFUSES and never rotates onto an empty key', () => {
  const { rotator, rotations, refusals } = harness({ reads: [KEY_ONE, '', '', ''] });
  rotator.tick();
  rotator.tick();
  rotator.tick();
  rotator.tick();
  assert.deepEqual(rotations, [], 'an empty read must never become the live key');
  assert.equal(refusals.length, 3);
  assert.ok(refusals.every(entry => entry.code === 'PEER_LINK_IDENTITY_UNAVAILABLE'));
  assert.equal(rotator.status().lastRefusalCode, 'PEER_LINK_IDENTITY_UNAVAILABLE');
});

test('a persistently unreadable vault never rotates, however many times it is polled', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, new Error('EACCES')] });
  rotator.tick();
  for (let index = 0; index < 25; index += 1) rotator.tick();
  assert.deepEqual(rotations, []);
  assert.equal(rotator.status().refusals, 25);
});

test('an unreadable REGISTRY refuses rather than being read as "no peers"', () => {
  const rotator = createPeerLinkRotator({
    loadRegistry: () => { const error = new Error('locked'); error.code = 'EBUSY'; throw error; },
    readIdentityKey: () => { throw new Error('the identity key must not be read after a registry failure'); },
    vaultFingerprint: () => null,
    onRefused: () => {}
  });
  assert.doesNotThrow(() => rotator.tick());
  assert.equal(rotator.status().lastRefusalCode, 'PEER_LINK_REGISTRY_UNREADABLE');
});

// --- the fingerprint gate --------------------------------------------------

test('an UNCHANGED fingerprint skips the expensive read entirely', () => {
  const { rotator, readCount } = harness({
    reads: [KEY_ONE, KEY_ONE, KEY_ONE, KEY_ONE],
    fingerprints: ['a:1', 'a:1', 'a:1', 'a:1']
  });
  rotator.tick(); // first look: fingerprint differs from the null baseline, so it reads
  const afterFirst = readCount();
  rotator.tick();
  rotator.tick();
  rotator.tick();
  assert.equal(readCount(), afterFirst, 'an unchanged vault must not be decrypted again');
  assert.equal(rotator.status().skippedByFingerprint, 3);
});

test('a NULL fingerprint means "I could not look" and NEVER skips the read', () => {
  const { rotator, readCount } = harness({
    reads: [KEY_ONE, KEY_ONE, KEY_ONE],
    fingerprints: [null, null, null]
  });
  rotator.tick();
  rotator.tick();
  rotator.tick();
  assert.equal(readCount(), 3, 'an unreadable stat must never be mistaken for "nothing changed"');
  assert.equal(rotator.status().skippedByFingerprint, 0);
});

test('a fingerprint that throws is treated as null, not as "unchanged"', () => {
  let calls = 0;
  const rotator = createPeerLinkRotator({
    loadRegistry: () => peerRegistry(1),
    readIdentityKey: () => { calls += 1; return KEY_ONE; },
    vaultFingerprint: () => { throw new Error('stat failed'); },
    onRefused: () => {}
  });
  rotator.tick();
  rotator.tick();
  assert.equal(calls, 2);
});

test('the fingerprint gate does NOT suppress the confirming read while a candidate is pending', () => {
  // The bug this guards: if the gate kept skipping once a change was seen, a
  // genuine rotation would hang as a pending candidate forever.
  const { rotator, rotations } = harness({
    reads: [KEY_ONE, KEY_TWO, KEY_TWO],
    fingerprints: ['a:1', 'b:2', 'b:2']
  });
  rotator.tick();
  rotator.tick(); // fingerprint changed -> reads -> candidate
  rotator.tick(); // fingerprint UNCHANGED, but a candidate is pending -> must still read
  assert.equal(rotations.length, 1, 'the confirming read must happen even behind an unchanged fingerprint');
});

// --- absence costs nothing --------------------------------------------------

test('an installation with NO peers starts no timer, reads no vault, and reports no error', () => {
  let identityReads = 0;
  let fingerprintReads = 0;
  let timersCreated = 0;
  const rotator = createPeerLinkRotator({
    loadRegistry: () => ({ schemaVersion: 1, source: 'default', peers: [] }),
    readIdentityKey: () => { identityReads += 1; return KEY_ONE; },
    vaultFingerprint: () => { fingerprintReads += 1; return 'a:1'; },
    setInterval: () => { timersCreated += 1; return { unref() {} }; },
    clearInterval: () => {}
  });

  assert.doesNotThrow(() => rotator.start());
  assert.equal(rotator.status().watching, false, 'one computer is a normal state, not a degraded one');
  assert.equal(timersCreated, 0, 'a single-machine install must not start a poll');
  assert.equal(identityReads, 0, 'a single-machine install must never decrypt the vault');
  assert.equal(fingerprintReads, 0);
  assert.equal(rotator.status().peerCount, 0);

  // And ticking directly is still silent and harmless.
  assert.doesNotThrow(() => rotator.tick());
  assert.equal(identityReads, 0);
  assert.equal(rotator.status().refusals, 0, 'having one computer must never be reported as a problem');
});

test('an installation whose only peer is REVOKED stops reading the vault but stays alive for a future pairing', () => {
  let identityReads = 0;
  const registry = { schemaVersion: 1, source: 'registry', peers: [{ peerId: `pk-${'c'.repeat(32)}`, revoked: true }] };
  const rotator = createPeerLinkRotator({
    loadRegistry: () => registry,
    readIdentityKey: () => { identityReads += 1; return KEY_ONE; },
    vaultFingerprint: () => null,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {}
  });
  rotator.tick();
  assert.equal(identityReads, 0, 'nothing to protect means nothing to read');
  assert.equal(rotator.status().peerCount, 0);

  // A later enrollment resumes without a restart.
  registry.peers = [{ peerId: `pk-${'d'.repeat(32)}`, revoked: false }];
  rotator.tick();
  assert.equal(identityReads, 1);
});

test('an installation WITH peers does start a poll', () => {
  let timersCreated = 0;
  const rotator = createPeerLinkRotator({
    loadRegistry: () => peerRegistry(2),
    readIdentityKey: () => KEY_ONE,
    vaultFingerprint: () => null,
    setInterval: () => { timersCreated += 1; return { unref() {} }; },
    clearInterval: () => {}
  });
  rotator.start();
  assert.equal(timersCreated, 1);
  assert.equal(rotator.status().watching, true);
  assert.equal(rotator.status().peerCount, 2);
  rotator.stop();
  assert.equal(rotator.status().watching, false);
});

test('start() is idempotent and does not stack timers', () => {
  let timersCreated = 0;
  const rotator = createPeerLinkRotator({
    loadRegistry: () => peerRegistry(1),
    readIdentityKey: () => KEY_ONE,
    vaultFingerprint: () => null,
    setInterval: () => { timersCreated += 1; return { unref() {} }; },
    clearInterval: () => {}
  });
  rotator.start();
  rotator.start();
  rotator.start();
  assert.equal(timersCreated, 1);
});

// --- the rotation event leaks nothing --------------------------------------

test('a rotation event never carries key material', () => {
  const { rotator, rotations } = harness({ reads: [KEY_ONE, KEY_TWO, KEY_TWO] });
  rotator.tick();
  rotator.tick();
  rotator.tick();
  assert.equal(rotations.length, 1);
  const serialized = JSON.stringify(rotations[0]);
  assert.ok(!serialized.includes(KEY_ONE), 'the previous key must never be emitted');
  assert.ok(!serialized.includes(KEY_TWO), 'the new key must never be emitted');
  assert.deepEqual(Object.keys(rotations[0]).sort(), ['atMs', 'changed', 'generation', 'peerCount']);
});

test('the rotator refuses to be constructed without its readers, rather than silently doing nothing', () => {
  assert.throws(() => createPeerLinkRotator({}), /loadRegistry and readIdentityKey/);
  assert.throws(() => createPeerLinkRotator({ loadRegistry: () => ({}) }), /loadRegistry and readIdentityKey/);
});
