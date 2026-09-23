'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const elevationRefusal = require('../src/lib/elevation-refusal.js');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function observeSideEffects(fn) {
  const calls = [];
  const replacements = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'exec'],
    [childProcess, 'execSync'],
  ];
  const originals = replacements.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of replacements) {
    owner[name] = (...args) => {
      calls.push({ name, args });
      throw new Error(`unexpected side effect: ${name}`);
    };
  }
  try {
    return { result: fn(), calls };
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
}

function assertRefusal(signals, expectedCode, expectedUnknown = false) {
  const observed = observeSideEffects(() => elevationRefusal.classify(signals));
  assert.deepEqual(observed.calls, [], 'classifying a refusal must neither write nor spawn');
  assert.ok(observed.result, 'the supplied failure signals must reach a refusal');
  assert.equal(observed.result.code, expectedCode);
  assert.equal(observed.result.elevation, true);
  assert.equal(observed.result.granted, false, 'absence of elevation is never consent');
  assert.equal(observed.result.outcomeUnknown, expectedUnknown);
  assert.ok(Object.isFrozen(observed.result), 'callers must not be able to mutate the refusal');
  return observed.result;
}

process.stdout.write('elevation-refusal\n');

check('access denied reaches ELEVATION_DENIED without effects', () => {
  const refusal = assertRefusal({ errorCode: 'EACCES' }, 'ELEVATION_DENIED');
  assert.match(refusal.whatHappened, /Windows refused/);
});

check('a visible cancelled prompt reaches ELEVATION_PROMPT_DECLINED without effects', () => {
  const refusal = assertRefusal({ exitCode: 1223, interactive: true }, 'ELEVATION_PROMPT_DECLINED');
  assert.match(refusal.whatHappened, /asked for permission/);
});

check('a noninteractive cancelled prompt reaches ELEVATION_PROMPT_UNAVAILABLE without effects', () => {
  const refusal = assertRefusal({
    stderr: 'The operation was canceled by the user.',
    interactive: false,
  }, 'ELEVATION_PROMPT_UNAVAILABLE');
  assert.match(refusal.whatHappened, /You were not asked/);
});

check('an indeterminate timeout reaches ELEVATION_OUTCOME_UNKNOWN without effects', () => {
  const refusal = assertRefusal({ timedOut: true }, 'ELEVATION_OUTCOME_UNKNOWN', true);
  assert.match(refusal.whatItCosts, /does not know whether the step finished/);
});

check('unrelated failures are not mislabeled as elevation refusals', () => {
  const observed = observeSideEffects(() => elevationRefusal.classify({ errorCode: 'ENOENT' }));
  assert.equal(observed.result, null);
  assert.deepEqual(observed.calls, []);
});

check('refusal prose is preserved for single-line and diagnostic surfaces', () => {
  const declined = elevationRefusal.classify({ exitCode: 1223, interactive: true });
  assert.equal(
    elevationRefusal.sentence(declined),
    `${declined.whatHappened} ${declined.whatWouldEnable} ${declined.whatItCosts}`,
  );
  const described = elevationRefusal.describeFailure('Dependency install', {
    stderr: 'The operation was cancelled by the user',
    interactive: false,
  });
  assert.match(described, /^Dependency install could not finish because it needed administrator rights\./);
  assert.match(described, /You were not asked, and you did not decline it/);
  assert.match(described, /What the step itself reported: The operation was cancelled by the user$/);
  assert.equal(elevationRefusal.describeFailure('Compile', { stderr: 'syntax error' }), 'syntax error');
  assert.equal(elevationRefusal.describeFailure('Compile'), 'Compile failed.');
});

check('Windows session detection preserves unknown rather than guessing', () => {
  assert.equal(elevationRefusal.interactiveSession({ SESSIONNAME: 'Services' }, 'win32'), false);
  assert.equal(elevationRefusal.interactiveSession({ SESSIONNAME: ' console ' }, 'win32'), true);
  assert.equal(elevationRefusal.interactiveSession({ SESSIONNAME: 'RDP-Tcp#12' }, 'win32'), true);
  assert.equal(elevationRefusal.interactiveSession({ SESSIONNAME: 'UnknownStation' }, 'win32'), null);
  assert.equal(elevationRefusal.interactiveSession({}, 'win32'), null);
  assert.equal(elevationRefusal.interactiveSession({ SESSIONNAME: 'Console' }, 'linux'), null);
});

check('the public refusal vocabulary and module exports are immutable', () => {
  assert.ok(Object.isFrozen(elevationRefusal.CODES));
  assert.ok(Object.isFrozen(elevationRefusal));
});

process.stdout.write(`elevation-refusal: ${checks} checks passed\n`);
