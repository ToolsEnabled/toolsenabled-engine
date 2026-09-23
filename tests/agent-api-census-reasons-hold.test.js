'use strict';

// A REMOVAL ARGUED FROM A SETTING THAT DECIDES NOTHING RESTS ON AIR.
//
// src/lib/agent-api-policy.js already says this about itself. Its `Task` entry
// carries a note recording that the entry's last clause once claimed the
// product drew a spawned child on the tree, that nothing did, and that "this
// `why` is the JUSTIFICATION for removing the harness tool: a removal argued
// partly from something the product does not do is a removal resting on air."
//
// THE SAME SHAPE, MEASURED AGAIN ON THIS TREE. The `PushNotification` entry
// read: "owner delivery owns reaching the person, and the ask.primary_channel
// setting decides where." `ask.primary_channel` decides nothing:
//   * config/settings-registry.json gives it `enforcedBy: ""`, and it is listed
//     in UNENFORCED_BASELINE in tests/settings-enforcement-honesty.test.js --
//     the recorded set of rows nothing in the product reads;
//   * it is a `select` whose `options` array holds exactly one answer, so there
//     is nothing for a person to pick even if something read it.
// The destination is decided by config/owner-delivery.json (`channel`), which
// src/lib/owner-delivery.js reads and which its own header calls "THE SINGLE
// SWITCH for owner-facing delivery ... there is no second place to set it."
//
// This file holds the census to the standard the census states: a `why` may
// name a settings row only if the shipped catalogue says something reads it,
// and only if the row offers the person more than one answer.

const assert = require('node:assert/strict');
const test = require('node:test');

const policy = require('../src/lib/agent-api-policy');
const registryModule = require('../src/lib/settings-registry');

// Dotted lowercase ids, the shape src/lib/settings-registry.js ID_PATTERN
// accepts. Matched against the real catalogue below, so an ordinary English
// phrase that happens to contain a dot cannot become a false accusation.
const ID_SHAPE = /\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/g;

function namedSettings(entry, byId) {
  return [...new Set(String(entry.why || '').match(ID_SHAPE) || [])].filter(id => byId.has(id));
}

test('every settings row a census reason argues from is one something reads', () => {
  const { byId } = registryModule.loadRegistry();
  const offences = [];

  for (const entry of policy.BUILT_IN_CENSUS) {
    for (const id of namedSettings(entry, byId)) {
      const row = byId.get(id);
      if (!registryModule.enforcementDeclared(row)) {
        offences.push(`${entry.name} argues from ${id}, which the catalogue says nothing reads`);
      }
    }
  }

  assert.deepEqual(offences, [],
    `these census decisions rest on a settings row nothing enforces: ${offences.join('; ')}`);
});

test('every settings row a census reason argues from offers the person a choice', () => {
  const { byId } = registryModule.loadRegistry();
  const offences = [];

  for (const entry of policy.BUILT_IN_CENSUS) {
    for (const id of namedSettings(entry, byId)) {
      const row = byId.get(id);
      const chooseable = row.control !== 'seg' && row.control !== 'select'
        ? true
        : Array.isArray(row.options) && row.options.length > 1;
      if (!chooseable) {
        offences.push(`${entry.name} argues from ${id}, a ${row.control} offering ${(row.options || []).length} answer(s)`);
      }
    }
  }

  assert.deepEqual(offences, [],
    `these census decisions rest on a settings row that decides nothing: ${offences.join('; ')}`);
});

// The guard has to be able to fire, or it is the guard this file exists to
// replace. A synthetic census entry naming a row the shipped catalogue records
// as unread must be caught by exactly the rule above.
test('the rule catches a reason that argues from a row nothing reads', () => {
  const { byId } = registryModule.loadRegistry();
  const unread = [...byId.values()].find(row => !registryModule.enforcementDeclared(row));
  assert.ok(unread, 'the catalogue still records rows nothing reads, so this rule still has work to do');

  const invented = { name: 'SomeBuiltIn', keep: false, why: `replaced, and the ${unread.id} setting decides where.` };
  assert.deepEqual(namedSettings(invented, byId), [unread.id],
    'a settings id inside a reason must be recognised as one');
  assert.equal(registryModule.enforcementDeclared(byId.get(unread.id)), false);
});

test('an ordinary sentence with a dot in it is not read as a settings row', () => {
  const { byId } = registryModule.loadRegistry();
  assert.deepEqual(
    namedSettings({ name: 'X', keep: true, why: 'web.fetch and web.expand are the fetch this product knows about.' }, byId),
    [],
    'tool names and prose must not be mistaken for catalogue ids');
});
