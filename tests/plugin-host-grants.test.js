/*
 * Mutations run, one at a time, each landed in src/lib/plugin-host/grants.js and
 * confirmed present before the run. Baseline and restored: green, 13 of 13.
 *   1. WAIVABLE_EFFECTS back to ['local-read', 'external-read'] -- the bug an
 *      end-to-end run found -> red, 2 of 13 ('a waiver holds for a local effect
 *      and never for one that reaches the network', and 'the waiver list is
 *      reachable'). Both halves of the defect are covered: it waived egress, and
 *      it made the mechanism unreachable for any plugin with tools.
 *   2. removed `if (found.record.capabilities.includes('secrets')) return false;`
 *      from approvalWaived() -> red, 1 of 13.
 *   3. `if (!asked.has(capability))` -> `if (false && ...)` in grant() -> red, 1 of 13.
 *   4. `if (value.sha256 !== sha256)` -> `if (false && ...)` in storedRecord() ->
 *      red, 1 of 13.
 *
 * ONE MUTATION SURVIVED, and it is recorded here rather than papered over:
 * dropping `|| found.record.revoked` from capabilitiesFor() stays green, because
 * revoke() writes an empty capability list and storedRecord() refuses a record
 * whose tombstone and list disagree. That branch is redundant with two other
 * invariants, not load-bearing on its own. It is kept as the cheap third check on
 * the same fact, and it is not claimed as tested.
 */
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { PluginGrantStore, MAX_GRANTED_PLUGINS, SEARCH_LIMIT } = require('../src/lib/plugin-host/grants');

// An in-memory stand-in for the three state-store methods this file uses, with
// the same contract: getMemory returns null for absent, setMemory bumps a
// revision and honours expectedRevision, searchMemory matches the note.
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    getMemory({ namespace, key }) {
      const row = rows.get(`${namespace}\u0000${key}`);
      return row ? { value: JSON.parse(JSON.stringify(row.value)), revision: row.revision, key } : null;
    },
    setMemory({ namespace, key, value, note, tags, expectedRevision }) {
      const id = `${namespace}\u0000${key}`;
      const prior = rows.get(id);
      if (expectedRevision !== undefined && (prior ? prior.revision : 0) !== expectedRevision) {
        const error = new Error('The memory entry changed before this write could be applied.');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      const revision = (prior ? prior.revision : 0) + 1;
      rows.set(id, { value: JSON.parse(JSON.stringify(value)), revision, note, tags, key });
      return { entry: { revision }, created: !prior, replayed: false };
    },
    searchMemory({ namespace, query, limit }) {
      const out = [];
      for (const [id, row] of rows) {
        if (!id.startsWith(`${namespace}\u0000`)) continue;
        if (!String(row.note).includes(query)) continue;
        out.push({ key: row.key, value: JSON.parse(JSON.stringify(row.value)), revision: row.revision });
        if (out.length >= limit) break;
      }
      return out;
    }
  };
}

function digest(seed) {
  return String(seed).padStart(2, '0').repeat(32).slice(0, 64);
}

const IDENTITY = Object.freeze({ id: 'plugin-aaaaaaaaaaaaaaaa', sha256: digest('aa') });
const MANIFEST = Object.freeze({
  name: 'notes',
  requires: Object.freeze(['storage', 'subprocess', 'network']),
  provides: Object.freeze({ tools: Object.freeze([{ name: 'reindex' }, { name: 'export_note' }]) })
});

function store(extra = {}) {
  return new PluginGrantStore({ stateStore: fakeStore(), now: () => '2026-09-26T00:00:00Z', ...extra });
}

test('an unknown package holds nothing: absence is denial, not consent', () => {
  const grants = store();
  assert.deepEqual(grants.capabilitiesFor(digest('ff')), []);
  assert.equal(grants.has(digest('ff'), 'subprocess'), false);
  assert.equal(grants.record(digest('ff')), null);
  assert.deepEqual(grants.list(), []);
});

test('a grant gives exactly what was granted, in a fixed order', () => {
  const grants = store();
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['network', 'storage'], actor: 'owner' });
  // Sorted by the vocabulary, not by the order the caller passed them, so the
  // owner's screen reads the same way every time.
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), ['storage', 'network']);
  assert.equal(grants.has(IDENTITY.sha256, 'storage'), true);
  assert.equal(grants.has(IDENTITY.sha256, 'subprocess'), false, 'requested but not granted is not granted');
});

test('a grant is bound to the bytes: one changed byte and the plugin starts at nothing', () => {
  const grants = store();
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' });
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), ['subprocess']);
  // The same plugin, one character changed, is a different digest.
  const changed = { ...IDENTITY, sha256: digest('bb') };
  assert.deepEqual(grants.capabilitiesFor(changed.sha256), [],
    'a decision does not carry across code the owner has not seen');
});

test('a capability the manifest never asked for cannot be granted, even by the owner', () => {
  const grants = store();
  assert.throws(
    () => grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['secrets'], actor: 'owner' }),
    (error) => {
      assert.equal(error.code, 'PLUGIN_GRANT_NOT_REQUESTED');
      assert.match(error.message, /did not ask for "secrets"/);
      return true;
    }
  );
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), [], 'a refused grant writes nothing');
});

test('a capability outside the vocabulary is refused', () => {
  const grants = store();
  assert.throws(
    () => grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['rootAccess'], actor: 'owner' }),
    (error) => (assert.equal(error.code, 'PLUGIN_GRANT_INVALID'), true)
  );
});

test('approval can be waived only for a tool the plugin actually defines', () => {
  const grants = store();
  assert.throws(
    () => grants.grant({
      identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'],
      approvalWaivers: ['not_a_tool'], actor: 'owner'
    }),
    (error) => (assert.equal(error.code, 'PLUGIN_GRANT_UNKNOWN_TOOL'), true)
  );
});

test('a waiver holds for a local effect and never for one that reaches the network', () => {
  // The axis is local versus external, not read versus write. external-read means
  // the plugin's subprocess egresses, which is the boundary the host cannot
  // enforce from outside the child; local-write means writing inside the
  // workspace directory the plugin already owns.
  const grants = store();
  grants.grant({
    identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'],
    approvalWaivers: ['reindex'], actor: 'owner'
  });
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'local-read'), true);
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'local-write'), true);
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'external-read'), false,
    'nothing that reaches the network is ever waived');
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'external-write'), false);
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'export_note', 'local-read'), false,
    'a waiver is per tool, by name');
});

test('the waiver list is reachable: a tool-bearing plugin can actually have one', () => {
  // The regression this guards. Every plugin with tools holds `subprocess`, whose
  // effect floor is local-write. With external-read on the waivable list and
  // local-write off it, no plugin tool could ever be waived and the whole
  // mechanism was dead code -- which is exactly what an end-to-end run showed.
  const { effectFloor } = require('../src/lib/plugin-host/manifest');
  const floor = effectFloor(['subprocess']);
  assert.equal(floor, 'local-write');
  const grants = store();
  grants.grant({
    identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'],
    approvalWaivers: ['reindex'], actor: 'owner'
  });
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', floor), true,
    'a waiver granted against the floor every tool-bearing plugin sits at must be honoured');
});

test('approval is never waived for a package that can also read secrets', () => {
  // A read tool inside a package that can read secrets is a read tool that can
  // move them, so the waiver stops applying to every tool in that package.
  const grants = store();
  const manifest = { ...MANIFEST, requires: ['subprocess', 'secrets'] };
  grants.grant({
    identity: IDENTITY, manifest, capabilities: ['subprocess', 'secrets'],
    approvalWaivers: ['reindex'], actor: 'owner'
  });
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'local-read'), false);
});

test('revocation is a tombstone: the capabilities stop and the history survives', () => {
  const grants = store();
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess', 'network'], actor: 'owner' });
  const result = grants.revoke(IDENTITY.sha256, { actor: 'owner', reason: 'no longer used' });
  assert.equal(result.removed, true);
  assert.deepEqual([...result.withdrawn], ['subprocess', 'network']);
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), [], 'revoked means nothing is granted');
  assert.equal(grants.approvalWaived(IDENTITY.sha256, 'reindex', 'local-read'), false);
  // The fact that a grant existed and was withdrawn is still answerable, which a
  // deleted row could not do.
  const [row] = grants.list();
  assert.equal(row.revoked.by, 'owner');
  assert.equal(row.revoked.reason, 'no longer used');
  assert.equal(row.grantedBy, 'owner');
  assert.equal(grants.liveCount(), 0);
  // Revoking twice is not an error and does not rewrite the first revocation.
  const again = grants.revoke(IDENTITY.sha256, { actor: 'owner' });
  assert.deepEqual({ removed: again.removed, alreadyRevoked: again.alreadyRevoked }, { removed: false, alreadyRevoked: true });
});

test('a store that disagrees with itself grants nothing', () => {
  const backing = fakeStore();
  const grants = new PluginGrantStore({ stateStore: backing, now: () => '2026-09-26T00:00:00Z' });
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' });
  // Tamper: the record now names a different package than the key it is under.
  const id = `plugin-grants\u0000${IDENTITY.sha256}`;
  backing.rows.get(id).value.sha256 = digest('cc');
  assert.throws(() => grants.capabilitiesFor(IDENTITY.sha256), (error) => {
    assert.equal(error.code, 'PLUGIN_GRANT_CORRUPT');
    assert.match(error.message, /disagrees with itself/);
    return true;
  });
});

test('a revoked record that still lists capabilities is refused, not reconciled', () => {
  const backing = fakeStore();
  const grants = new PluginGrantStore({ stateStore: backing, now: () => '2026-09-26T00:00:00Z' });
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' });
  const row = backing.rows.get(`plugin-grants\u0000${IDENTITY.sha256}`);
  row.value.revoked = { at: '2026-09-26T01:00:00Z', by: 'owner', reason: null };
  // capabilities left in place: the tombstone and the list now disagree.
  assert.throws(() => grants.capabilitiesFor(IDENTITY.sha256), (error) => {
    assert.equal(error.code, 'PLUGIN_GRANT_CORRUPT');
    assert.match(error.message, /still lists capabilities/);
    return true;
  });
});

test('the grant list refuses to be silently incomplete', () => {
  const grants = store();
  for (let index = 0; index < SEARCH_LIMIT; index += 1) {
    const sha256 = digest(String(index).padStart(2, '0'));
    if (grants.liveCount() >= MAX_GRANTED_PLUGINS) {
      // Past the live ceiling, grant() refuses by design; revoke one and continue
      // so this test ends up with SEARCH_LIMIT rows in the store either way.
      assert.throws(
        () => grants.grant({ identity: { id: 'x', sha256 }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' }),
        (error) => (assert.equal(error.code, 'PLUGIN_GRANT_LIMIT'), true)
      );
      grants.revoke(digest(String(index - 1).padStart(2, '0')), { actor: 'owner' });
    }
    grants.grant({ identity: { id: 'x', sha256 }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' });
  }
  assert.throws(() => grants.list(), (error) => {
    assert.equal(error.code, 'PLUGIN_GRANT_LIST_TRUNCATED');
    assert.match(error.message, /incomplete list of what has been granted is worse than none/);
    return true;
  });
});

/* GRANT RECORDS NEVER GO AWAY, SO THE LIMIT MUST NOT COUNT THE ONES THAT HOLD
 * NOTHING (1.0.50 release review F5). Every changed version of a plugin is a new
 * digest with a record of its own, and nothing removes records. The limit used to
 * count every live record through a search of one page: after about sixteen
 * versions no plugin could be allowed anything, and past twenty records, withdrawn
 * ones included, the search refused with advice to revoke that could not help. The
 * first three below were red before the fix and are green after. */
function manyDigests(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const value = (index + offset).toString(16).padStart(4, '0');
    return value.repeat(16);
  });
}

test('versions that are no longer on this computer do not count toward the limit', () => {
  const grants = store();
  const old = manyDigests(MAX_GRANTED_PLUGINS);
  for (const sha256 of old) {
    grants.grant({ identity: { id: 'x', sha256 }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner' });
  }
  const [current] = manyDigests(1, 100);
  // Only the current version is on disk; the sixteen old versions' grants remain.
  const result = grants.grant({
    identity: { id: 'x', sha256: current }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: [current]
  });
  assert.deepEqual(result.record.capabilities, ['subprocess']);
  assert.deepEqual(grants.capabilitiesFor(current), ['subprocess']);
});

test('withdrawn records do not block a new grant, however many there are', () => {
  const grants = store();
  for (const sha256 of manyDigests(SEARCH_LIMIT)) {
    grants.grant({ identity: { id: 'x', sha256 }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: [sha256] });
    grants.revoke(sha256, { actor: 'owner' });
  }
  const [next] = manyDigests(1, 200);
  assert.doesNotThrow(() => grants.grant({
    identity: { id: 'x', sha256: next }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: [next]
  }));
  assert.deepEqual(grants.capabilitiesFor(next), ['subprocess']);
});

test('saving nothing for a plugin that never held anything writes no record', () => {
  const backing = fakeStore();
  const grants = new PluginGrantStore({ stateStore: backing, now: () => '2026-09-26T00:00:00Z' });
  const result = grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: [], actor: 'owner', present: [IDENTITY.sha256] });
  assert.equal(result.written, false);
  assert.deepEqual(result.record.capabilities, []);
  assert.equal(backing.rows.size, 0, 'no row that nothing will ever remove');
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), []);
  // An empty answer for a plugin that DID hold something is a decision that changed
  // something, and it is still written.
  grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: ['storage'], actor: 'owner', present: [IDENTITY.sha256] });
  const emptied = grants.grant({ identity: IDENTITY, manifest: MANIFEST, capabilities: [], actor: 'owner', present: [IDENTITY.sha256] });
  assert.equal(emptied.written, true);
  assert.deepEqual(grants.capabilitiesFor(IDENTITY.sha256), []);
});

test('the limit still holds for the plugins on this computer, and says what to do', () => {
  const grants = store();
  const onDisk = manyDigests(MAX_GRANTED_PLUGINS + 1, 300);
  for (const sha256 of onDisk.slice(0, MAX_GRANTED_PLUGINS)) {
    grants.grant({ identity: { id: 'x', sha256 }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: onDisk });
  }
  const last = onDisk[MAX_GRANTED_PLUGINS];
  assert.throws(() => grants.grant({
    identity: { id: 'x', sha256: last }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: onDisk
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_GRANT_LIMIT');
    assert.match(error.message, /Withdraw everything from one you no longer use/);
    return true;
  });
  // A plugin whose answer was nothing, allowed something now, is checked too.
  const emptied = onDisk[0];
  grants.grant({ identity: { id: 'x', sha256: emptied }, manifest: MANIFEST, capabilities: [], actor: 'owner', present: onDisk });
  grants.grant({ identity: { id: 'x', sha256: last }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: onDisk });
  assert.throws(() => grants.grant({
    identity: { id: 'x', sha256: emptied }, manifest: MANIFEST, capabilities: ['subprocess'], actor: 'owner', present: onDisk
  }), (error) => (assert.equal(error.code, 'PLUGIN_GRANT_LIMIT'), true));
  // Changing what an allowed plugin holds is never refused by the limit.
  assert.doesNotThrow(() => grants.grant({
    identity: { id: 'x', sha256: last }, manifest: MANIFEST, capabilities: ['subprocess', 'storage'], actor: 'owner', present: onDisk
  }));
});
