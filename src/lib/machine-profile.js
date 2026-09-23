'use strict';

// Machine topology is a USER SETTING, not a product fact and not a question.
//
// Machine names, network addresses, and filesystem roots belong in an
// installation-specific profile, never in tracked product configuration. When
// topology data becomes stale, consumers must treat it as customer-controlled
// configuration rather than as a fixed product fact.
//
// THE DEFAULT IS ONE COMPUTER, AND IT WORKS.
//
// A new user has a single machine and should never see a peer, an address, or a
// transport choice unless they go looking for one. Absence of a profile is a NORMAL,
// FULLY FUNCTIONAL state -- not an error, not an empty list, not a prompt. This
// codebase has found the absence-as-emptiness defect repeatedly; here the dangerous
// version would be a missing profile rendering as "no machines", which would make the
// local product look broken to someone who has done nothing wrong.
//
// So `loadMachineProfile()` on a machine with no profile at all returns a complete,
// valid, single-machine topology describing THIS computer. There is no failure path for
// "the user has not configured anything", because that is not a failure.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;

// The profile is per-installation and MUST NOT be committed: it holds one person's
// machine names, addresses, and paths. `config/machines.example.json` is the shipped
// template; this is the live file.
const PROFILE_RELATIVE_PATH = path.join('config', 'machines.profile.json');

const TRANSPORTS = Object.freeze(['direct', 'self-hosted-relay', 'hosted-relay']);
const MODES = Object.freeze(['single', 'multi']);

// A machine id is a stable opaque label chosen by the user. It is deliberately NOT an
// IP address and NOT a filesystem path, so identity survives a DHCP lease change or
// a moved checkout.
const MACHINE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function profilePath(root) {
  return path.join(root, PROFILE_RELATIVE_PATH);
}

/**
 * The topology of someone who has configured nothing: this computer, alone, working.
 *
 * `hostname` is used only as a human-readable label. It never becomes an identity or a
 * routing target, so a machine that is renamed or shares a name with another does not
 * break anything.
 */
function singleMachineDefault(hostnameProvider = os.hostname) {
  let label = 'This computer';
  try {
    const name = hostnameProvider();
    if (typeof name === 'string' && name.trim() !== '') label = name.trim();
  } catch {
    // A hostname lookup failing is not a reason to have no profile.
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'default',
    mode: 'single',
    transport: 'direct',
    thisMachine: Object.freeze({ id: 'this-machine', label }),
    peers: Object.freeze([]),
    reason: 'no machine profile is configured, so this installation describes one computer'
  });
}

function normalizePeer(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && MACHINE_ID_RE.test(raw.id) ? raw.id : null;
  if (id === null) return null;
  return Object.freeze({
    id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
    // `address` is how to REACH a peer, deliberately separate from `id`, which is who it
    // IS. An address may change freely without changing identity.
    address: typeof raw.address === 'string' && raw.address.trim() !== '' ? raw.address.trim() : null,
    root: typeof raw.root === 'string' && raw.root.trim() !== '' ? raw.root.trim() : null,
    order: index
  });
}

/**
 * Load the user's machine profile.
 *
 * Absent  -> the single-machine default. Normal, working, not an error.
 * Present -> validated. Entries that cannot be understood are dropped rather than
 *            guessed at, and reported in `rejected` so a settings screen can show them.
 * Broken  -> reported as broken AND still usable: the caller gets a working
 *            single-machine topology so the product does not stop working because a
 *            config file was hand-edited badly.
 */
function loadMachineProfile(root, dependencies = {}) {
  const io = dependencies.fs || fs;
  const hostnameProvider = dependencies.hostname || os.hostname;
  const file = profilePath(root);

  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return singleMachineDefault(hostnameProvider);
    return Object.freeze({
      ...singleMachineDefault(hostnameProvider),
      source: 'unreadable',
      reason: `machine profile exists but could not be read (${error && error.code}); using this computer only`
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return Object.freeze({
      ...singleMachineDefault(hostnameProvider),
      source: 'malformed',
      reason: `machine profile is not valid JSON (${error && error.message}); using this computer only`
    });
  }

  const mode = MODES.includes(parsed.mode) ? parsed.mode : 'single';
  const transport = TRANSPORTS.includes(parsed.transport) ? parsed.transport : 'direct';

  const declaredThis = parsed.thisMachine && typeof parsed.thisMachine === 'object' ? parsed.thisMachine : {};
  const thisId = typeof declaredThis.id === 'string' && MACHINE_ID_RE.test(declaredThis.id)
    ? declaredThis.id
    : 'this-machine';
  const fallbackLabel = singleMachineDefault(hostnameProvider).thisMachine.label;

  const rejected = [];
  const peers = [];
  const declaredPeers = Array.isArray(parsed.peers) ? parsed.peers : [];
  declaredPeers.forEach((entry, index) => {
    const peer = normalizePeer(entry, index);
    if (peer === null) rejected.push(entry);
    else if (peer.id === thisId) rejected.push(entry); // a machine is not its own peer
    else peers.push(peer);
  });

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'profile',
    // Declaring "multi" while listing no reachable peer is a contradiction. Resolve it
    // toward the working state rather than toward a prompt: one computer, no error.
    mode: mode === 'multi' && peers.length > 0 ? 'multi' : 'single',
    transport,
    thisMachine: Object.freeze({
      id: thisId,
      label: typeof declaredThis.label === 'string' && declaredThis.label.trim() !== ''
        ? declaredThis.label.trim()
        : fallbackLabel
    }),
    peers: Object.freeze(peers),
    rejected: Object.freeze(rejected),
    reason: peers.length === 0
      ? 'machine profile is configured with no reachable peers, so this installation describes one computer'
      : `machine profile declares ${peers.length} peer machine(s)`
  });
}

/**
 * Is cross-machine work configured at all?
 *
 * Callers ask this INSTEAD of asking a human. A false answer means "this user has one
 * computer", which is the common case and needs no explanation, no prompt, and no
 * escalation.
 */
function hasPeers(profile) {
  if (!profile || !Array.isArray(profile.peers)) {
    throw new TypeError('A loaded machine profile is required to determine whether peers are configured');
  }
  if (profile.source === 'unreadable' || profile.source === 'malformed') {
    throw new Error(`Cannot determine whether peers are configured from a ${profile.source} machine profile`);
  }
  if (profile.peers.length === 0 && Array.isArray(profile.rejected) && profile.rejected.length > 0) {
    throw new Error('Cannot determine whether peers are configured because every declared peer was rejected');
  }
  return profile.peers.length > 0;
}

function peerById(profile, id) {
  if (!profile || !Array.isArray(profile.peers)) {
    throw new TypeError('A loaded machine profile is required to look up a peer');
  }
  if (profile.source === 'unreadable' || profile.source === 'malformed') {
    throw new Error(`Cannot look up a peer in a ${profile.source} machine profile`);
  }
  if (profile.peers.length === 0 && Array.isArray(profile.rejected) && profile.rejected.length > 0) {
    throw new Error('Cannot look up a peer because every declared peer was rejected');
  }
  return profile.peers.find(peer => peer.id === id) || null;
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PROFILE_RELATIVE_PATH,
  TRANSPORTS,
  MODES,
  MACHINE_ID_RE,
  profilePath,
  singleMachineDefault,
  loadMachineProfile,
  hasPeers,
  peerById
});
