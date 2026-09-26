'use strict';

// ADDING A SECOND COMPUTER, IN THE PRODUCT'S VOICE.
//
// The pairing PROTOCOL is `src/lib/peer-enrollment.js` and its socket half is
// `tools/peer-enroll.js`. Both are built, correct, and covered by four test
// files. What was missing was the only part a customer ever sees: until now the
// sole instruction anybody was ever given was to open a terminal and type
// `node tools/peer-enroll.js join --address <shown> --code <code>`.
//
// config/invocation-registry.json recorded that in writing, as the reason the
// tool was classed manual: "the guided setup that should eventually call it
// (BUILD-QUEUE T5-T15, first-run setup) is unbuilt, so pairing is currently a
// documented human command. When that setup lands, this entry should be deleted
// and the tool wired to it." This module and `tools/mcsetup.js` are that landing,
// and that entry is deleted in the same change.
//
// THIS FILE HOLDS NO PROTOCOL AND OPENS NO SOCKET. It decides what a person is
// told, and reads the paired-computer list to answer "is anything paired". The
// wording is separated from the mechanism deliberately: the security properties
// of the pairing must not be re-derived by whoever is improving a screen.

const path = require('node:path');

const { loadPeerRegistry, hasEnrolledPeers, PeerEnrollmentError } = require('../peer-enrollment');

// A LIST THAT CANNOT BE READ IS NOT AN EMPTY LIST.
//
// `loadPeerRegistry` REFUSES, by throwing, when the file is there but cannot be
// read or parsed: "a failed read or parse cannot establish that there are no
// enrolled peers, so it must not manufacture an empty registry." That refusal is
// correct, it is shared with every other caller, and it is not softened there.
//
// But a refusal is not an answer a person can be shown, and this module's whole
// job is to say what a person is told. So the two refusals that mean "could not
// look" are turned back into the SAME unknown record an unreadable list already
// produces below -- paired is null, not false. Every other code keeps travelling:
// a failure this screen has no words for is not this screen's to swallow.
const UNKNOWN_SOURCE_FOR_CODE = new Map([
  ['PEER_REGISTRY_UNREADABLE', 'unreadable'],
  ['PEER_REGISTRY_MALFORMED', 'malformed']
]);

function readPeerRegistry(root, dependencies) {
  try {
    return loadPeerRegistry(root, dependencies);
  } catch (error) {
    const source = error instanceof PeerEnrollmentError
      ? UNKNOWN_SOURCE_FOR_CODE.get(error.code)
      : undefined;
    if (source === undefined) throw error;
    return Object.freeze({
      source,
      peers: Object.freeze([]),
      rejected: Object.freeze([]),
      reason: error.message
    });
  }
}

/**
 * What is paired with this computer, phrased so that "nothing" reads as a normal,
 * complete state rather than as an empty table implying breakage.
 */
function pairingStatus(root, dependencies = {}) {
  const registry = readPeerRegistry(root, dependencies);
  if (registry.source === 'unreadable' || registry.source === 'malformed' || registry.rejected.length > 0) {
    const warning = registry.source === 'unreadable'
      ? 'The paired-computer list exists but could not be read, so pairing status is unknown.'
      : registry.source === 'malformed'
        ? 'The paired-computer list is malformed, so pairing status is unknown.'
        : `The paired-computer list has ${registry.rejected.length} record(s) that could not be read, so the number of paired computers is unknown.`;
    return Object.freeze({
      paired: null,
      count: null,
      computers: Object.freeze([]),
      source: registry.source,
      warning,
      summary: warning,
      nextStep: null
    });
  }
  const active = registry.peers.filter(peer => peer.revoked !== true);
  if (!hasEnrolledPeers(registry)) {
    return Object.freeze({
      paired: false,
      count: 0,
      computers: Object.freeze([]),
      summary: 'This computer is working on its own. Nothing needs to be set up.',
      nextStep: 'add-computer'
    });
  }
  return Object.freeze({
    paired: true,
    count: active.length,
    computers: Object.freeze(active.map(peer => Object.freeze({
      label: peer.label,
      id: peer.peerId,
      fingerprint: peer.fingerprint
    }))),
    summary: active.length === 1
      ? `One other computer is paired with this one: ${active[0].label}.`
      : `${active.length} other computers are paired with this one.`,
    nextStep: null
  });
}

/**
 * The lines shown on the computer that already works, while it waits.
 *
 * The command named is the PRODUCT'S OWN setup command, not an internal tool
 * path. That distinction is the whole point of this module: a person following
 * these words is using the thing they installed.
 */
function inviteInstruction({ bind, port, code, minutes, fingerprint, joinCommand = 'mcsetup pair join' }) {
  return [
    '',
    'On the other computer, open ToolsEnabled setup and run:',
    '',
    `  ${joinCommand} --address ${bind}:${port} --code ${code}`,
    '',
    `This code works once and stops working in ${minutes} minute(s).`,
    'Read it off this screen and type it on the other computer. Do not send it anywhere --',
    'not by message, not by email. Nobody ever needs to be told this code except you.',
    '',
    `If the other computer shows a fingerprint, check it matches this one: ${fingerprint}`,
    ''
  ];
}

/**
 * The one line worth saying after pairing succeeds. Kept here so both the command
 * line and any later screen say the same thing.
 */
function pairedConfirmation(label, fingerprint) {
  return `Paired with ${label}. Check that ${fingerprint} is the fingerprint shown on the other computer.`;
}

/**
 * Where the paired-computer list lives for an installation. Named so a setup plan
 * can declare the write before making it.
 */
function peerRegistryPath(root) {
  return path.join(path.resolve(root), 'config', 'peers.profile.json');
}

module.exports = Object.freeze({
  pairingStatus,
  inviteInstruction,
  pairedConfirmation,
  peerRegistryPath
});
