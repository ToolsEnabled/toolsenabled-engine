'use strict';

// WHAT THE OWNER ACTUALLY AGREED TO. ABSENCE IS DENIAL, NOT CONSENT.
//
// A manifest's `requires` list is a request (see manifest.js). This file holds
// the answer, and the answer defaults to no. There is no "installed therefore
// trusted" state, no first-run grant-everything, and no capability a plugin can
// reach because nothing said it could not.
//
// This product has paid for the opposite arrangement often enough to have named
// it: a fence that reads absence as consent is on the wrong side of the thing it
// is fencing. capabilitiesFor() on an unknown package returns an empty list, and
// every refusal downstream of it names the capability that was missing, so a
// plugin that does not work says why in one sentence instead of failing somewhere
// unrelated.
//
// THE GRANT IS BOUND TO THE BYTES, NOT TO THE NAME.
//
// The key is the package's full sha256. A plugin the owner reviewed and granted
// `subprocess` gets that grant for exactly the bytes they reviewed; ship one
// changed character and the digest moves, the lookup misses, and the new version
// starts at no capabilities again. That is the whole benefit of content identity,
// and it is why the name is deliberately not part of the key -- a name is a label
// an author chooses, and two packages are allowed to share one.
//
// The stored record ALSO carries the sha256, and a read that finds a record whose
// sha256 disagrees with its key refuses instead of trusting either. A store that
// disagrees with itself is not a store to make an access-control decision from.
//
// A GRANT CANNOT EXCEED THE REQUEST. grant() refuses a capability the manifest
// did not ask for, even from the owner. Not because the owner may not decide --
// they may -- but because a capability granted to a plugin that never declared it
// is one the plugin's own documentation does not mention, so nobody reviewing the
// package later has a reason to look for its use.
//
// REVOCATION IS A TOMBSTONE, NOT A DELETE.
//
// The durable store this sits on offers get, set and search, and no delete; that
// turns out to be the right shape for an access-control record anyway. Revoking
// writes a record with an empty capability list and a revokedAt, so
// capabilitiesFor() returns nothing (which is exactly denial) while the fact that
// a grant once existed and was withdrawn survives. A deleted row would leave the
// store unable to tell "never granted" from "granted and withdrawn", and those
// are different answers to give an owner asking what this plugin has had access
// to.

const { createStateStore } = require('../state-store');
const { CAPABILITIES, EFFECT_ORDER } = require('./manifest');

const NAMESPACE = 'plugin-grants';
const SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTOR = /^[^\r\n\t\0]{1,80}$/;
const REASON = /^[^\r\n\t\0]{1,200}$/;
// At most this many plugins on this computer may hold something at once. It was
// set below the durable store's search ceiling (searchMemory caps `limit` at 20)
// so that a search could count them; grant() now counts the packages on disk one
// record at a time instead (see liveCount()), because the search also counted
// versions no longer on disk and withdrawn records, which nothing ever removes.
const MAX_GRANTED_PLUGINS = 16;
const SEARCH_LIMIT = 20;
const SEARCH_QUERY = 'plugin-grant';
// A waiver may only ever apply to a tool whose effect is one of these.
//
// THE AXIS IS LOCAL VERSUS EXTERNAL, NOT READ VERSUS WRITE, and getting that
// backwards is a mistake this file made first. `external-read` was on this list
// because "read" sounded like the safe half of the pair. For a plugin it is the
// dangerous half: external-read means the plugin's subprocess reaches the network,
// which is the one boundary the host cannot enforce from outside the child once that
// child is running. Meanwhile local-write
// for a plugin means writing inside the workspace directory the plugin already
// owns -- a blast radius of one directory, and asking about it every time is
// friction that buys nothing.
//
// Putting external-read on the waivable list also made the whole mechanism dead
// code, which is how the error was found: every tool-bearing plugin must hold
// `subprocess`, whose floor is local-write, so no plugin tool could ever be
// waived, and an end-to-end run showed two waived tools still asking. A guard
// that cannot fire and a guard that fires wrongly were the same edit.
const WAIVABLE_EFFECTS = Object.freeze(['local-read', 'local-write']);

class PluginGrantError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginGrantError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginGrantError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('PLUGIN_GRANT_INVALID', `${field} must be a 64-character lowercase sha256.`, { field });
  }
  return value;
}

// The record is stored under its own digest, so there is no separate key
// derivation to get wrong -- nothing is concatenated, truncated or sanitised on
// the way in. The digest is already a fixed-width value over a closed alphabet,
// which is the only kind of value that is safe to use as a key unchanged.
function grantKey(sha256) {
  return assertSha256(sha256, 'sha256');
}

function storedRecord(value, sha256) {
  if (!plain(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.name !== 'string'
    || !Array.isArray(value.capabilities) || !Array.isArray(value.approvalWaivers)
    || typeof value.grantedAt !== 'string' || typeof value.grantedBy !== 'string') {
    fail('PLUGIN_GRANT_CORRUPT', 'A stored plugin grant is malformed.', { sha256 });
  }
  if (value.sha256 !== sha256) {
    fail('PLUGIN_GRANT_CORRUPT',
      'A stored plugin grant names a different package than the key it is filed under. Nothing is granted '
      + 'from a store that disagrees with itself; revoke the grant and grant it again.',
      { sha256, stored: value.sha256 });
  }
  if (value.revoked !== null && !(plain(value.revoked)
    && typeof value.revoked.at === 'string' && typeof value.revoked.by === 'string')) {
    fail('PLUGIN_GRANT_CORRUPT', 'A stored plugin grant has a malformed revocation.', { sha256 });
  }
  // A revoked record must carry no capabilities. If one does, the tombstone and
  // the capability list disagree about the same question, and the honest answer
  // is to refuse rather than to pick the reading that happens to be safer today.
  if (value.revoked && value.capabilities.length) {
    fail('PLUGIN_GRANT_CORRUPT',
      'A revoked plugin grant still lists capabilities. Revoke it again to write a clean record.', { sha256 });
  }
  for (const capability of value.capabilities) {
    if (!CAPABILITIES.includes(capability)) {
      fail('PLUGIN_GRANT_CORRUPT',
        `A stored plugin grant names "${capability}", which this build does not offer. A grant is not `
        + 'partially honoured: revoke it and grant again against this build\'s vocabulary.',
        { sha256, capability });
    }
  }
  return value;
}

class PluginGrantStore {
  constructor({ stateStore = createStateStore(), audit = null, now = () => new Date().toISOString() } = {}) {
    if (!stateStore || typeof stateStore.getMemory !== 'function' || typeof stateStore.setMemory !== 'function'
      || typeof stateStore.searchMemory !== 'function') {
      fail('PLUGIN_GRANT_INVALID', 'stateStore must expose getMemory, setMemory and searchMemory.');
    }
    this.stateStore = stateStore;
    this.audit = audit;
    this.now = now;
  }

  _read(sha256) {
    const entry = this.stateStore.getMemory({ namespace: NAMESPACE, key: grantKey(sha256) });
    // getMemory's only definite "not found" is null. An injected or unavailable
    // store returning some other falsy value must not be collapsed into absence:
    // "not measured" would become "not granted", which reads as a safe default
    // and is actually a store outage silently revoking every grant -- including
    // the ones an owner is about to be told are still in force.
    if (entry === null) return null;
    if (!plain(entry)) {
      fail('PLUGIN_GRANT_CORRUPT', 'The plugin grant store returned something that is not a grant record.', { sha256 });
    }
    return Object.freeze({ record: storedRecord(entry.value, sha256), revision: entry.revision });
  }

  // THE ONLY QUESTION THE REST OF THE HOST ASKS. Unknown package, no record,
  // revoked record, store empty: an empty list, every time.
  //
  // The `revoked` half of the test below is redundant with two other invariants --
  // revoke() writes an empty capability list, and storedRecord() refuses a record
  // whose tombstone and list disagree -- and a mutation that removes it does not
  // turn the suite red. It is kept as the third cheap check on the same fact, and
  // tests/plugin-host-grants.test.js says so rather than claiming coverage it
  // does not have.
  capabilitiesFor(sha256) {
    const found = this._read(assertSha256(sha256, 'sha256'));
    if (!found || found.record.revoked) return Object.freeze([]);
    const granted = new Set(found.record.capabilities);
    return Object.freeze(CAPABILITIES.filter(capability => granted.has(capability)));
  }

  has(sha256, capability) {
    if (!CAPABILITIES.includes(capability)) {
      fail('PLUGIN_GRANT_INVALID', `"${capability}" is not a capability this build offers.`, { capability });
    }
    return this.capabilitiesFor(sha256).includes(capability);
  }

  record(sha256) {
    const found = this._read(assertSha256(sha256, 'sha256'));
    return found ? Object.freeze(JSON.parse(JSON.stringify(found.record))) : null;
  }

  // Whether a given tool runs without asking each time. Four conditions, all
  // required, and the plugin's own request is the weakest of them:
  //   - there is a live grant at all, and
  //   - the owner waived approval for this tool by name, and
  //   - the tool's effect (already raised to the capability floor by the caller)
  //     is a LOCAL class -- nothing that reaches the network is ever waived, and
  //   - the plugin holds no `secrets` grant, because a read tool in a package
  //     that can also read secrets is a read tool that can move them.
  approvalWaived(sha256, toolName, effect) {
    if (!EFFECT_ORDER.includes(effect)) {
      fail('PLUGIN_GRANT_INVALID', `effect must be one of ${EFFECT_ORDER.join(', ')}.`, { field: 'effect' });
    }
    if (!WAIVABLE_EFFECTS.includes(effect)) return false;
    const found = this._read(assertSha256(sha256, 'sha256'));
    if (!found || found.record.revoked) return false;
    if (found.record.capabilities.includes('secrets')) return false;
    return found.record.approvalWaivers.includes(String(toolName));
  }

  // All grant records, live and revoked, for the owner's screen. Refuses rather
  // than truncating if the store holds more than one page: see SEARCH_LIMIT.
  list() {
    const entries = this.stateStore.searchMemory({ namespace: NAMESPACE, query: SEARCH_QUERY, limit: SEARCH_LIMIT });
    const rows = Array.isArray(entries) ? entries : [];
    if (rows.length >= SEARCH_LIMIT) {
      // No advice to revoke: a withdrawal is a record too (see the tombstone note
      // at the top), so withdrawing never shortens this list. grant() does not
      // depend on it any more; see liveCount().
      fail('PLUGIN_GRANT_LIST_TRUNCATED',
        `The grant store holds at least ${SEARCH_LIMIT} records, which is more than one page. This listing `
        + 'would be incomplete, and an incomplete list of what has been granted is worse than none. Withdrawn '
        + 'grants are kept as records, so withdrawing does not shorten it.',
        { limit: SEARCH_LIMIT });
    }
    const out = rows.map((entry) => {
      const value = storedRecord(entry.value, entry.key);
      return Object.freeze({
        sha256: value.sha256,
        name: value.name,
        capabilities: Object.freeze(value.capabilities.slice()),
        approvalWaivers: Object.freeze(value.approvalWaivers.slice()),
        grantedAt: value.grantedAt,
        grantedBy: value.grantedBy,
        revoked: value.revoked ? Object.freeze({ ...value.revoked }) : null
      });
    });
    out.sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
    return Object.freeze(out);
  }

  /* HOW MANY PLUGINS HOLD AT LEAST ONE CAPABILITY, which is what the limit in
     grant() is about.

     WITH `present` -- the digests of the packages on this computer now, from the
     caller's listing -- only those are read, one record each, and no search is
     involved. This is the count grant() uses, and it is the fix for a lockout
     (1.0.50 release review F5): every changed version of a plugin is a new digest
     with its own record, records are never removed, and the count used to be taken
     over all of them through a search capped at one page of 20. So after roughly
     sixteen updates no plugin at all could be allowed anything -- the old versions'
     grants still counted though nothing could run them and the page could not show
     them, and past 20 records, withdrawn ones included, the search refused
     outright with advice (revoke) that could not help. A version that is not on
     disk cannot run, a withdrawn record holds nothing, and a record with nothing
     ticked holds nothing: none of them counts.

     Without `present` the old search-based count is kept for callers that have no
     listing, with the same rule about what holds something. */
  liveCount({ present = null } = {}) {
    if (Array.isArray(present)) {
      let count = 0;
      for (const sha256 of new Set(present)) {
        const found = this._read(assertSha256(sha256, 'present'));
        if (found && !found.record.revoked && found.record.capabilities.length) count += 1;
      }
      return count;
    }
    return this.list().filter(row => !row.revoked && row.capabilities.length).length;
  }

  // The owner's decision, written down. `manifest` is passed so the request can
  // be checked against the grant here, at the one moment both are in hand.
  grant({ identity, manifest, capabilities, approvalWaivers = [], actor, now = this.now(), present = null } = {}) {
    if (!plain(identity) || typeof identity.sha256 !== 'string') {
      fail('PLUGIN_GRANT_INVALID', 'grant() needs the package identity from identity.js.', { field: 'identity' });
    }
    if (!plain(manifest) || !Array.isArray(manifest.requires) || !plain(manifest.provides)) {
      fail('PLUGIN_GRANT_INVALID', 'grant() needs the parsed manifest.', { field: 'manifest' });
    }
    const sha256 = assertSha256(identity.sha256, 'identity.sha256');
    if (typeof actor !== 'string' || !ACTOR.test(actor)) {
      fail('PLUGIN_GRANT_INVALID', 'grant() needs the actor who decided, as trimmed single-line text.', { field: 'actor' });
    }
    if (typeof now !== 'string' || !now) {
      fail('PLUGIN_GRANT_INVALID', 'grant() needs a timestamp.', { field: 'now' });
    }
    if (!Array.isArray(capabilities)) {
      fail('PLUGIN_GRANT_INVALID', 'capabilities must be an array.', { field: 'capabilities' });
    }
    const asked = new Set(manifest.requires);
    const wanted = new Set();
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) {
        fail('PLUGIN_GRANT_INVALID',
          `"${capability}" is not a capability this build offers. The whole vocabulary is: ${CAPABILITIES.join(', ')}.`,
          { capability });
      }
      if (!asked.has(capability)) {
        fail('PLUGIN_GRANT_NOT_REQUESTED',
          `This plugin did not ask for "${capability}", so it cannot be granted it. Its own documentation does `
          + 'not mention the capability, which means nobody reviewing the package later has a reason to look '
          + 'for where it is used.',
          { capability });
      }
      wanted.add(capability);
    }
    const toolNames = new Set((manifest.provides.tools || []).map(tool => tool.name));
    const waivers = new Set();
    for (const name of approvalWaivers) {
      if (!toolNames.has(name)) {
        fail('PLUGIN_GRANT_UNKNOWN_TOOL',
          `Approval cannot be waived for "${name}": this plugin does not define a tool by that name.`,
          { tool: name });
      }
      waivers.add(name);
    }

    if (present !== null && !Array.isArray(present)) {
      fail('PLUGIN_GRANT_INVALID', 'present must be the list of package digests on this computer.', { field: 'present' });
    }
    const existing = this._read(sha256);
    // AN EMPTY ANSWER FOR A PLUGIN THAT NEVER HELD ANYTHING WRITES NOTHING. With no
    // record, capabilitiesFor() already answers "nothing", so a record saying the
    // same would only be one more row that is never removed (F5). An empty answer
    // for a plugin that DID hold something is still written: it is a decision that
    // changed something, and it is audited.
    if (!existing && !wanted.size && !waivers.size) {
      return Object.freeze({
        record: Object.freeze({
          schemaVersion: SCHEMA_VERSION, sha256, name: manifest.name, capabilities: Object.freeze([]),
          approvalWaivers: Object.freeze([]), grantedAt: null, grantedBy: null, revoked: null
        }),
        revision: 0,
        created: false,
        written: false,
        audited: Object.freeze({ recorded: false, reason: 'nothing-granted' })
      });
    }
    // The limit is checked whenever this decision makes a plugin hold something it
    // did not hold before -- a new digest, a withdrawn one allowed again, or one
    // whose last answer was nothing -- and it counts the OTHER plugins on this
    // computer that hold something (liveCount() says why only those).
    const heldBefore = Boolean(existing && !existing.record.revoked && existing.record.capabilities.length);
    if (wanted.size && !heldBefore) {
      const held = present === null
        ? this.liveCount()
        : this.liveCount({ present: present.filter(entry => entry !== sha256) });
      if (held >= MAX_GRANTED_PLUGINS) {
        fail('PLUGIN_GRANT_LIMIT',
          `At most ${MAX_GRANTED_PLUGINS} plugins on this computer may be allowed anything at once. Withdraw `
          + 'everything from one you no longer use, then try again.',
          { limit: MAX_GRANTED_PLUGINS });
      }
    }

    const record = {
      schemaVersion: SCHEMA_VERSION,
      sha256,
      name: manifest.name,
      capabilities: CAPABILITIES.filter(capability => wanted.has(capability)),
      approvalWaivers: [...waivers].sort(),
      grantedAt: now,
      grantedBy: actor,
      revoked: null
    };
    const saved = this.stateStore.setMemory({
      namespace: NAMESPACE,
      key: grantKey(sha256),
      value: record,
      note: `${SEARCH_QUERY}:${manifest.name}:${sha256.slice(0, 16)}`,
      tags: [SEARCH_QUERY, manifest.name],
      ...(existing === null ? {} : { expectedRevision: existing.revision })
    });
    const audited = this._note('plugin.grant', sha256, {
      name: manifest.name,
      capabilities: record.capabilities,
      approvalWaivers: record.approvalWaivers,
      requested: manifest.requires,
      actor
    });
    return Object.freeze({
      record: Object.freeze(JSON.parse(JSON.stringify(record))),
      revision: saved.entry.revision,
      created: saved.created,
      written: true,
      audited
    });
  }

  revoke(sha256, { actor, reason = null, now = this.now() } = {}) {
    const key = grantKey(sha256);
    if (typeof actor !== 'string' || !ACTOR.test(actor)) {
      fail('PLUGIN_GRANT_INVALID', 'revoke() needs the actor who decided.', { field: 'actor' });
    }
    if (reason !== null && (typeof reason !== 'string' || !REASON.test(reason))) {
      fail('PLUGIN_GRANT_INVALID', 'revoke() reason must be trimmed single-line text when given.', { field: 'reason' });
    }
    const existing = this._read(key);
    if (!existing) return Object.freeze({ removed: false, alreadyRevoked: false });
    if (existing.record.revoked) return Object.freeze({ removed: false, alreadyRevoked: true, name: existing.record.name });
    const had = existing.record.capabilities.slice();
    const record = {
      ...existing.record,
      capabilities: [],
      approvalWaivers: [],
      revoked: { at: now, by: actor, reason }
    };
    this.stateStore.setMemory({
      namespace: NAMESPACE,
      key,
      value: record,
      note: `${SEARCH_QUERY}:${record.name}:${key.slice(0, 16)}:revoked`,
      tags: [SEARCH_QUERY, record.name, 'revoked'],
      expectedRevision: existing.revision
    });
    const audited = this._note('plugin.revoke', key, { name: record.name, withdrawn: had, actor, reason });
    return Object.freeze({ removed: true, alreadyRevoked: false, name: record.name, withdrawn: Object.freeze(had), audited });
  }

  // Auditing a grant is not optional in spirit, but a missing audit dependency
  // must not be the reason an owner cannot WITHDRAW a capability. So a failure
  // here is reported rather than thrown, and the caller surfaces the audit status
  // instead of the host pretending the write happened.
  _note(action, target, details) {
    if (!this.audit || typeof this.audit.record !== 'function') {
      return Object.freeze({ recorded: false, reason: 'no-audit-dependency' });
    }
    try {
      const status = this.audit.record(action, target, details);
      return Object.freeze({ recorded: Boolean(status && status.ok !== false) });
    } catch (error) {
      return Object.freeze({ recorded: false, reason: error && error.code ? error.code : 'audit-failed' });
    }
  }
}

module.exports = Object.freeze({
  PluginGrantError,
  PluginGrantStore,
  NAMESPACE,
  SCHEMA_VERSION,
  MAX_GRANTED_PLUGINS,
  SEARCH_LIMIT,
  WAIVABLE_EFFECTS
});
