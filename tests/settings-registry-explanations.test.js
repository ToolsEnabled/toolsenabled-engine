'use strict';

// R1224: settings must be explained in plain language, and every row must be
// identifiable by a human-readable title rather than only its dotted id.
// This test reads the raw JSON directly rather than going through
// src/lib/settings-registry.js's loadRegistry()/validateEntry(), because that
// module's FIELDS allowlist does not (and, per this lane's file territory,
// must not from here) know about a "titles" map. Reading the file directly
// keeps this test honest about what is actually on disk.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'settings-registry.json');
const MINIMUM_TITLE_LENGTH = 8;
const MINIMUM_CONSEQUENCE_LENGTH = 100;

function loadRawRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

// "outward.presend_card" -> "outward presend card". A title that is just
// this is a restatement of the id, not an explanation, per R1224.
function naiveIdRestatement(id) {
  return id.replace(/[._]/g, ' ').trim().toLowerCase();
}

function testEveryEntryHasATitle() {
  console.log('🧪 Testing that every settings-registry entry has a human-readable title...');
  const document = loadRawRegistry();
  assert.ok(document && typeof document === 'object', 'registry document must parse to an object');
  assert.ok(
    document.titles && typeof document.titles === 'object' && !Array.isArray(document.titles),
    'registry document must carry a top-level "titles" map'
  );
  assert.ok(Array.isArray(document.entries) && document.entries.length > 0, 'registry must carry entries');

  for (const entry of document.entries) {
    const title = document.titles[entry.id];
    assert.equal(typeof title, 'string', `${entry.id} has no title in the titles map`);
    const trimmed = title.trim();
    assert.notEqual(trimmed, '', `${entry.id} title is blank`);
    assert.ok(
      trimmed.length >= MINIMUM_TITLE_LENGTH,
      `${entry.id} title "${title}" is too short to be a real explanation (${trimmed.length} chars, need >= ${MINIMUM_TITLE_LENGTH})`
    );
    assert.notEqual(
      trimmed.toLowerCase(),
      naiveIdRestatement(entry.id),
      `${entry.id} title is just its id with separators turned into spaces, not a real title`
    );
  }
  console.log(`  ✅ All ${document.entries.length} entries carry a non-trivial title.`);
}

function testEveryEntryHasAReasonableConsequence() {
  console.log('🧪 Testing that every settings-registry entry has a consequence of reasonable length...');
  const document = loadRawRegistry();

  for (const entry of document.entries) {
    assert.equal(typeof entry.consequence, 'string', `${entry.id} has no consequence string`);
    const trimmed = entry.consequence.trim();
    assert.notEqual(trimmed, '', `${entry.id} consequence is empty`);
    assert.ok(
      trimmed.length >= MINIMUM_CONSEQUENCE_LENGTH,
      `${entry.id} consequence is only ${trimmed.length} chars, below the ${MINIMUM_CONSEQUENCE_LENGTH}-char floor for a real explanation`
    );
  }
  console.log(`  ✅ All ${document.entries.length} entries carry a consequence of reasonable length.`);
}

function testTitlesMapHasNoOrphansOrGaps() {
  console.log('🧪 Testing that the titles map exactly covers the entries, no more, no less...');
  const document = loadRawRegistry();
  const entryIds = new Set(document.entries.map((entry) => entry.id));
  const titleIds = new Set(Object.keys(document.titles));

  const missing = [...entryIds].filter((id) => !titleIds.has(id));
  const orphaned = [...titleIds].filter((id) => !entryIds.has(id));

  assert.deepEqual(missing, [], `entries missing a title: ${missing.join(', ')}`);
  assert.deepEqual(orphaned, [], `titles with no matching entry: ${orphaned.join(', ')}`);
  console.log('  ✅ titles map is exactly 1:1 with entries.');
}

testEveryEntryHasATitle();
testEveryEntryHasAReasonableConsequence();
testTitlesMapHasNoOrphansOrGaps();
console.log('🎉 settings-registry explanation tests passed successfully!');
