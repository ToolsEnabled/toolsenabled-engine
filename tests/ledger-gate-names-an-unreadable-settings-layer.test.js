'use strict';

/* AN UNREADABLE SETTINGS FILE WAS REPORTED AS A CHOICE THE PERSON HAD MADE.
 *
 * loadSettings does not throw on a damaged document -- it records the failure in
 * `rejected`, under the id "*" for a document-level problem. This gate never
 * looked. So on a computer whose settings.json is truncated, locked, replaced by
 * a directory, or otherwise unparseable, an agent calling r_ledger.file or
 * r_ledger.propose was handed the SAME sentence as a person who had genuinely
 * switched the feature off, and the same sentence as first run with no file at
 * all. Byte-identical across all four states.
 *
 * OFF IS THE RIGHT ANSWER EITHER WAY and this gate is correct to fail closed.
 * The cost is the SENTENCE. The person is told their switch is off in Settings
 * and invited to turn it on, while their stored `true` has been discarded along
 * with every other value in the file, and the Settings page shows every writable
 * row back at its default with no explanation. Their likeliest reading is that
 * the product forgot their choices, not that a file is damaged -- so they do not
 * go and fix the file, and the state persists.
 *
 * The gate's own docstring already promised the other half: "Fails closed: an
 * unreadable registry or settings layer answers off WITH THE REASON, never a
 * throw." It failed closed. It did not give the reason.
 *
 * ALL FOUR OFF BRANCHES ARE COVERED HERE, deliberately: a damaged file can take
 * any of them depending on what survived the parse, and fixing three of four
 * would leave the defect alive on whichever path a given machine happened to
 * take. That is the same not-generalised-to-the-sibling miss this project has
 * now recorded four times.
 */

const assert = require('node:assert/strict');
const gate = require('../src/lib/r-ledger-agent-gate.js');

const agentFilingMode = gate.agentFilingMode
  || (gate.__test__ && gate.__test__.agentFilingMode);
assert.equal(typeof agentFilingMode, 'function',
  'agentFilingMode is not reachable from this module, so this file is checking air');

const SETTING = 'rules.capture_spoken';
const DAMAGE = 'the settings file is not valid JSON';
let checks = 0;

function settings({ values = {}, provenance = {}, damaged = false } = {}) {
  return {
    values,
    provenance,
    rejected: damaged ? [{ id: '*', reason: DAMAGE }] : [],
    registry: { byId: new Map() },
  };
}

/* The four ways this gate answers OFF. Each is reachable with a damaged file,
   because what survives a partial parse decides which one is taken. */
const OFF_BRANCHES = [
  ['unclassified (no entry at all)', {}],
  ['a value that is neither on nor off', { values: { [SETTING]: 'maybe' } }],
  ['switched off outright', { values: { [SETTING]: false } }],
  ['on, but from a built-in default nobody chose', {
    values: { [SETTING]: true },
    provenance: { [SETTING]: { source: 'default', atMs: 0 } },
  }],
];

for (const [label, shape] of OFF_BRANCHES) {
  const clean = agentFilingMode({ settings: settings(shape) });
  const damaged = agentFilingMode({ settings: settings(Object.assign({}, shape, { damaged: true })) });

  assert.equal(clean.mode, 'off', `${label}: the gate stopped answering off, which is not what this file is about`);
  assert.equal(damaged.mode, 'off',
    `${label}: a damaged settings file stopped failing closed -- that is worse than the sentence this file exists to fix`);
  checks += 2;

  assert.notEqual(damaged.why, clean.why,
    `${label}: an unreadable settings file gives the person the SAME sentence as a choice they made. `
    + 'They are told a switch is off in Settings, and they will go and look at a switch that is already correct.');
  checks += 1;

  assert.match(damaged.why, /could not be read/,
    `${label}: the refusal does not say the settings could not be read`);
  assert.ok(damaged.why.includes(DAMAGE),
    `${label}: what the settings layer actually reported was dropped, so the person cannot tell a locked file from a corrupt one`);
  checks += 2;

  assert.match(damaged.why, /Nobody switched it off/,
    `${label}: the sentence still lets the person believe the state is a choice somebody made`);
  checks += 1;

  /* THE CONTROL. Without it, appending the damage note unconditionally would
     pass every assertion above while telling every ordinary person their
     settings are broken. */
  assert.doesNotMatch(clean.why, /could not be read/,
    `${label}: an ordinary computer is being told its settings could not be read`);
  checks += 1;
}

/* AND THE ON PATH IS UNTOUCHED. A file that reads fine and carries a real,
   person-chosen value must still enable -- otherwise the fix has quietly turned
   the feature off for everyone who uses it. */
const enabled = agentFilingMode({
  settings: settings({
    values: { [SETTING]: true },
    provenance: { [SETTING]: { source: 'user', atMs: 1 } },
  }),
});
assert.equal(enabled.mode, 'auto',
  'a person who switched this on no longer gets it, so this change has disabled the feature rather than explained it');
assert.equal(enabled.why, null, 'an enabled gate is carrying a refusal sentence');
checks += 2;

console.log(`ledger-gate-names-an-unreadable-settings-layer: ${checks} checks passed on ${process.platform}`);
