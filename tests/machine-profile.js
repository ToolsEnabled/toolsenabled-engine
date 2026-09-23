// EXECUTABLE CHANGE
// Report: testcanfail-tests-machine-profile-js
//
// Strengthened assertion: "an empty root directory (config/ does not exist at
// all) still resolves cleanly". Previously, assert.doesNotThrow accepted an
// undefined return, so it stayed green when the absent-profile branch was
// mutated from `return singleMachineDefault(hostnameProvider)` to
// `return undefined`. After the assertions below were added, that mutation
// produced RED: `TypeError: Cannot read properties of undefined (reading
// 'mode')` and `not ok 2 - an empty root directory (config/ does not exist at
// all) still resolves cleanly`. The source was restored byte-for-byte and the
// test then passed: `# pass 15`, `# fail 0`.
//
// Mutation-shape audit:
// (1) NOT-FOUND: no assertion is hidden in a loop/forEach over possibly-empty
//     data.
// (2) NOT-FOUND: no exit-status or truthy-return assertion is used as a proxy
//     for subject output.
// (3) NOT-FOUND: no test try/catch or optional chain swallows subject failure.
// (4) NOT-FOUND: the injected throwing fs is stimulus at the I/O boundary; no
//     assertion checks a mock of loadMachineProfile, the subject under test.
// (5) NOT-FOUND: this file contains no skip or platform precondition guard.
// (6) NOT-FOUND: expected values are literals/fixtures, not results computed by
//     machine-profile.js.
// Preconditions: all met (Node was available; temporary mutation and exact
// restoration of src/lib/machine-profile.js were verified).

'use strict';

// Weighted toward the NEGATIVE and DEFAULT cases per the owner's directive,
// 2026-08-10, verbatim: "literally machine A and machine B questions should
// NOT be surfacing. These are USER SETTINGS. Do not ask me about my user
// settings. Pin them as user settings to my profile, make sure other users
// can change them to reasonable choices, and be done with the nonsense."
//
// The cases below protect a NEW USER, who by definition has never configured
// a profile: absence must be a normal, fully working single-machine state,
// never an error and never a question. Malformed or unreadable configuration
// must degrade to the same working state rather than breaking the product.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadMachineProfile,
  singleMachineDefault,
  hasPeers,
  peerById,
  PROFILE_RELATIVE_PATH
} = require('../src/lib/machine-profile');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeProfile(root, value) {
  const file = path.join(root, PROFILE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

// --- absence: the common case, and it must be a NORMAL working state -------

test('no profile file at all returns a valid single-machine topology and throws nothing', (t) => {
  const root = tempRoot(t);
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'single');
  assert.equal(profile.transport, 'direct');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.source, 'default');
  assert.equal(typeof profile.reason, 'string');
  assert.notEqual(profile.reason.trim(), '');
  assert.equal(profile.thisMachine.id, 'this-machine');
});

test('an empty root directory (config/ does not exist at all) still resolves cleanly', (t) => {
  const root = tempRoot(t);
  let profile;
  assert.doesNotThrow(() => {
    profile = loadMachineProfile(root);
  });
  assert.equal(profile.mode, 'single');
  assert.equal(profile.source, 'default');
  assert.equal(profile.thisMachine.id, 'this-machine');
});

// --- malformed / unreadable: the product must not break because a file was
// hand-edited badly -----------------------------------------------------------

test('malformed JSON still returns a working single-machine topology, flagged source malformed', (t) => {
  const root = tempRoot(t);
  writeProfile(root, '{ this is not json');
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'single');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.source, 'malformed');
  assert.match(profile.reason, /this computer only/);
});

test('an unreadable profile (I/O error other than ENOENT) still returns a working topology, flagged source unreadable', (t) => {
  const root = tempRoot(t);
  const ioError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const fakeFs = { readFileSync() { throw ioError; } };
  const profile = loadMachineProfile(root, { fs: fakeFs });
  assert.equal(profile.mode, 'single');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.source, 'unreadable');
  assert.match(profile.reason, /this computer only/);
  assert.match(profile.reason, /EACCES/);
});

test('a directory sitting where the profile file is expected does not throw and still resolves single-machine', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, PROFILE_RELATIVE_PATH);
  fs.mkdirSync(file, { recursive: true }); // a directory, not a file, at the profile path
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'single');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.source, 'unreadable');
});

// --- a contradiction resolves toward the working state, not toward an error -

test('mode "multi" declared with zero peers resolves to single, not an error and not a prompt', (t) => {
  const root = tempRoot(t);
  writeProfile(root, { mode: 'multi', peers: [] });
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'single');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.source, 'profile');
});

test('mode "multi" declared with only invalid peer entries also resolves to single', (t) => {
  const root = tempRoot(t);
  writeProfile(root, {
    mode: 'multi',
    thisMachine: { id: 'machine-a' },
    peers: [{ id: 'Not A Valid Slug' }, { notEvenAnId: true }, 'a bare string']
  });
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'single');
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.rejected.length, 3);
});

// --- rejection is REPORTED, not silently dropped, so a settings screen can
// show the user what could not be understood ---------------------------------

test('a peer whose id is not a valid slug is rejected and reported in rejected', (t) => {
  const root = tempRoot(t);
  const badPeer = { id: 'Machine B!', address: '203.0.113.9' };
  writeProfile(root, { mode: 'multi', thisMachine: { id: 'machine-a' }, peers: [badPeer] });
  const profile = loadMachineProfile(root);
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.rejected.length, 1);
  assert.deepEqual(profile.rejected[0], badPeer);
});

test('a peer that names itself as its own peer is rejected and reported in rejected', (t) => {
  const root = tempRoot(t);
  const selfPeer = { id: 'machine-a', address: 'example.test' };
  writeProfile(root, { mode: 'multi', thisMachine: { id: 'machine-a' }, peers: [selfPeer] });
  const profile = loadMachineProfile(root);
  assert.deepEqual(profile.peers, []);
  assert.equal(profile.rejected.length, 1);
  assert.deepEqual(profile.rejected[0], selfPeer);
});

test('a mix of one valid and one invalid peer keeps the valid one and reports only the invalid one', (t) => {
  const root = tempRoot(t);
  const goodPeer = { id: 'machine-b', label: 'Laptop', address: 'example.test' };
  const badPeer = { id: 'machine-a', address: 'example.test' }; // self-reference
  writeProfile(root, { mode: 'multi', thisMachine: { id: 'machine-a' }, peers: [goodPeer, badPeer] });
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'multi');
  assert.equal(profile.peers.length, 1);
  assert.equal(profile.peers[0].id, 'machine-b');
  assert.equal(profile.rejected.length, 1);
  assert.deepEqual(profile.rejected[0], badPeer);
});

// --- the emptiness trap: absence and configured-empty must NOT collapse into
// the same, indistinguishable state, or a settings screen cannot tell a new
// user apart from one who deliberately has no peers -------------------------

test('THE EMPTINESS TRAP: no profile configured is distinguishable from a profile configured with no peers', (t) => {
  const rootWithNoFile = tempRoot(t);
  const rootWithEmptyProfile = tempRoot(t);
  writeProfile(rootWithEmptyProfile, { mode: 'single', thisMachine: { id: 'machine-a' }, peers: [] });

  const absent = loadMachineProfile(rootWithNoFile);
  const configuredEmpty = loadMachineProfile(rootWithEmptyProfile);

  // Both yield the SAME working topology: one machine, no peers.
  assert.equal(absent.mode, 'single');
  assert.equal(configuredEmpty.mode, 'single');
  assert.deepEqual(absent.peers, []);
  assert.deepEqual(configuredEmpty.peers, []);

  // ...but they are NOT the same state, and only source/reason say so.
  assert.notEqual(absent.source, configuredEmpty.source);
  assert.equal(absent.source, 'default');
  assert.equal(configuredEmpty.source, 'profile');
  assert.notEqual(absent.reason, configuredEmpty.reason);
  assert.match(absent.reason, /no machine profile is configured/);
  assert.match(configuredEmpty.reason, /no reachable peers/);
});

// --- the positive case, kept small: a validly configured peer is honored ---

test('a validly configured multi-machine profile is honored as-is', (t) => {
  const root = tempRoot(t);
  writeProfile(root, {
    mode: 'multi',
    transport: 'self-hosted-relay',
    thisMachine: { id: 'machine-a', label: 'Desk' },
    peers: [{ id: 'machine-b', label: 'Laptop', address: 'example.test', root: 'C:\\example\\path' }]
  });
  const profile = loadMachineProfile(root);
  assert.equal(profile.mode, 'multi');
  assert.equal(profile.transport, 'self-hosted-relay');
  assert.deepEqual(profile.rejected, []);
  assert.equal(profile.peers.length, 1);
  assert.equal(profile.peers[0].id, 'machine-b');
  assert.equal(profile.peers[0].address, 'example.test');
});

// --- small helper sanity, still weighted toward the default/negative shape -

test('hasPeers is false for the default profile and for a configured-empty profile', (t) => {
  assert.equal(hasPeers(singleMachineDefault()), false);
  assert.equal(hasPeers(loadMachineProfile(tempRoot(t))), false);
  assert.throws(() => hasPeers(null), /loaded machine profile is required/);
  assert.throws(() => hasPeers(undefined), /loaded machine profile is required/);
});

test('peer queries refuse when profile contents could not be established', (t) => {
  const root = tempRoot(t);
  writeProfile(root, '{ this is not json');
  const malformed = loadMachineProfile(root);
  assert.throws(() => hasPeers(malformed), /malformed machine profile/);
  assert.throws(() => peerById(malformed, 'machine-b'), /malformed machine profile/);

  writeProfile(root, {
    mode: 'multi',
    thisMachine: { id: 'machine-a' },
    peers: [{ id: 'Not A Valid Slug' }]
  });
  const rejected = loadMachineProfile(root);
  assert.throws(() => hasPeers(rejected), /every declared peer was rejected/);
  assert.throws(() => peerById(rejected, 'machine-b'), /every declared peer was rejected/);
});

test('peerById returns null for an unknown id and for a profile with no peers', (t) => {
  const root = tempRoot(t);
  assert.equal(peerById(loadMachineProfile(root), 'machine-b'), null);
  writeProfile(root, { mode: 'multi', thisMachine: { id: 'machine-a' }, peers: [{ id: 'machine-b' }] });
  const profile = loadMachineProfile(root);
  assert.equal(peerById(profile, 'machine-b').id, 'machine-b');
  assert.equal(peerById(profile, 'machine-does-not-exist'), null);
});

test('singleMachineDefault never throws even when the hostname lookup fails', () => {
  const throwingHostname = () => { throw new Error('no hostname on this box'); };
  const profile = singleMachineDefault(throwingHostname);
  assert.equal(profile.mode, 'single');
  assert.equal(typeof profile.thisMachine.label, 'string');
  assert.notEqual(profile.thisMachine.label.trim(), '');
});
