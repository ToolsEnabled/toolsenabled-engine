'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const { score } = require('../src/lib/capability-recall/score');

const constants = Object.freeze({
  stemDiscount: 0.7,
  priorMass: 0.1,
  absentWeight: 0.2,
  focusTerms: 3,
  maxAbsentMass: 2,
  b: { identity: 0, title: 0, body: 0, alias: 0 },
  weights: { identity: 1, title: 1, body: 1, alias: 1 },
  k1: 1.2,
  commonFraction: 0.5,
  strongTermFraction: 0,
  phraseBoost: 0.1,
  actionBoost: 0.1,
  tieBand: 0,
});

function artifactFor(term, posting) {
  return {
    constants,
    docs: [{
      id: 'catalogue.widget',
      action: null,
      len: { identity: 1, title: 1, body: 1, alias: 1 },
    }],
    postings: term ? { [term]: [posting] } : {},
    df: term ? { [term]: 1 } : {},
    avgLen: { identity: 1, title: 1, body: 1, alias: 1 },
    N: 1,
    actionByWord: null,
    phrases: [],
  };
}

function withoutWritesOrSpawns(fn) {
  const calls = [];
  const replacements = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [fs, 'createWriteStream'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'execFile'],
    [childProcess, 'execFileSync'],
  ];
  const originals = replacements.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of replacements) {
    owner[name] = (...args) => {
      calls.push({ name, args });
      throw new Error(`unexpected side effect: ${name}`);
    };
  }
  try {
    const value = fn();
    assert.deepEqual(calls, [], 'score must not write or spawn while answering');
    return value;
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
}

const noSearchable = withoutWritesOrSpawns(() => score(artifactFor(), 'the and how'));
assert.equal(noSearchable.reason, 'NO_SEARCHABLE_TERMS');
assert.deepEqual(noSearchable.candidates, []);
assert.equal(noSearchable.evidence, 0);

const absent = withoutWritesOrSpawns(() => score(artifactFor(), 'quasar'));
assert.equal(absent.reason, 'NO_QUERY_TERM_IS_IN_THE_CATALOGUE');
assert.deepEqual(absent.candidates, []);
assert.ok(absent.evidence > 0, 'the refusal retains the denominator evidence');

// The term occurs only in prose. A one-word query must name a tool in its
// identity/alias (or be exceptionally strong), so this reachable candidate is
// deliberately rejected by the precision rules.
const imprecise = withoutWritesOrSpawns(() => score(
  artifactFor('mention', [0, 0, 0, 1, 0]),
  'mention',
));
assert.equal(imprecise.reason, 'NO_CANDIDATE_PASSED_THE_PRECISION_RULES');
assert.deepEqual(imprecise.candidates, []);
assert.ok(imprecise.evidence > 0);

const scored = withoutWritesOrSpawns(() => score(
  artifactFor('widget', [0, 1, 0, 0, 0]),
  'widget',
));
assert.equal(scored.reason, 'SCORED');
assert.equal(scored.candidates.length, 1);
assert.equal(scored.candidates[0].id, 'catalogue.widget');
assert.ok(scored.candidates[0].confidence > 0);

process.stdout.write('capability-recall score refusal paths: ok\n');
