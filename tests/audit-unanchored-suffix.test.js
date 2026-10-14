'use strict';

// THE UNANCHORED SUFFIX MUST BE SLICED BY POSITION, NOT BY ABSOLUTE SEQUENCE.
//
// reconcileAnchor() takes the events past the protected head and refuses the
// write if any of them was signed by a key other than the vault-trusted one:
//
//   const suffix = unanchoredSuffix(events, anchoredSequence, boundary)
//   if (suffix.some(event => event.keyId !== signer.keyId)) throw alarm
//
// `events` is the LIVE window -- events[i] is sequence (boundary + i + 1) --
// while `anchoredSequence` is absolute. Slicing by the raw sequence was correct
// only while nothing had ever been archived. Measured on the owner's install
// (boundary 981, anchor near 11069, 10,088 live rows) the old expression sliced
// past the end and produced [], so `.some()` examined nothing and that alarm
// could not fire on any install that had ever rolled. With the shipped default
// retention of 10,000 events, every install rolls eventually.
//
// These cases pin the arithmetic in both regimes -- before any roll (where the
// old code happened to agree) and after one (where it did not) -- so a future
// edit cannot quietly reintroduce the off-by-a-boundary.

const assert = require('node:assert/strict');
const { unanchoredSuffix } = require('../src/lib/audit');

// events[i].sequence === boundary + i + 1, which is what the live window is.
function window(boundary, count, keyId = 'trusted') {
  return Array.from({ length: count }, (_, i) => ({ sequence: boundary + i + 1, keyId }));
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('with nothing archived, the suffix is everything past the anchor', () => {
  const events = window(0, 10);
  const suffix = unanchoredSuffix(events, 7, null);
  assert.deepEqual(suffix.map(e => e.sequence), [8, 9, 10],
    'an anchor at sequence 7 leaves 8,9,10 unanchored');
});

check('after a roll, the suffix is still everything past the anchor', () => {
  // 981 archived, live window holds 982..1000, anchor at 997.
  const events = window(981, 19);
  assert.equal(events[0].sequence, 982);
  assert.equal(events[events.length - 1].sequence, 1000);
  const suffix = unanchoredSuffix(events, 997, { archivedThroughSequence: 981 });
  assert.deepEqual(suffix.map(e => e.sequence), [998, 999, 1000],
    'the boundary must be subtracted; slicing by the raw sequence would fall off the end');
});

check('the shape that silently disabled the check returns events, not nothing', () => {
  // The owner's install: boundary 981, 10,088 live rows, anchor near the head.
  const boundary = { archivedThroughSequence: 981 };
  const events = window(981, 10088);
  const anchoredSequence = 981 + 10088 - 3;          // three events past the anchor
  const suffix = unanchoredSuffix(events, anchoredSequence, boundary);
  assert.equal(suffix.length, 3,
    `the real-world shape must yield the three unanchored events; the old arithmetic yielded ${events.slice(anchoredSequence).length}`);
  assert.equal(events.slice(anchoredSequence).length, 0,
    'control: slicing by the absolute sequence really does yield nothing here, which is the bug');
});

check('an anchor at the head leaves nothing unanchored', () => {
  const events = window(981, 19);
  assert.deepEqual(unanchoredSuffix(events, 1000, { archivedThroughSequence: 981 }), [],
    'an anchor that already names the head has no suffix to check');
});

check('an anchor at or below the boundary leaves the whole window unanchored', () => {
  const events = window(981, 4);
  assert.equal(unanchoredSuffix(events, 981, { archivedThroughSequence: 981 }).length, 4,
    'an anchor exactly at the boundary protects none of the live window');
  assert.equal(unanchoredSuffix(events, 0, { archivedThroughSequence: 981 }).length, 4,
    'a negative offset must clamp to the start rather than slicing from the end');
});

check('an absent anchor leaves the whole window unanchored', () => {
  const events = window(0, 5);
  assert.equal(unanchoredSuffix(events, 0, null).length, 5,
    'with no protected head, every live event is unanchored and must be checked');
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-unanchored-suffix: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
