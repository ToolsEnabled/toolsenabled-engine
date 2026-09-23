// EXECUTABLE CHANGE — testcanfail-tests-elevation-surface-test-js
//
// Discrimination report:
// - Strengthened "an unreadable posture reports unknown...": mutating the
//   exported operation catalogue to `NEEDS: Object.freeze([])` previously left
//   this file GREEN (`# pass 22`, `# fail 0`). With the assertion below it is
//   RED: `Expected values to be strictly deep-equal:` followed by
//   `+ []` and `- [ 'elevation-request', 'protected-write' ]`.
// - NOT-FOUND (1), beyond that catalogue loop: the other collection loops use
//   non-empty literals, or the elevation catalogue has an existing length
//   assertion. NOT-FOUND (2): no process exit-status/truthy-return assertions.
//   NOT-FOUND (3): no try/catch or optional-chain swallowing failures.
//   NOT-FOUND (4): no assertion against a mock of its subject. NOT-FOUND (5):
//   no skips or platform precondition guards. NOT-FOUND (6): no expected value
//   computed by the same product code under test.
// - Preconditions: all met. The temporary product mutation was restored
//   byte-for-byte (SHA-256 before/after:
//   ba52051e4ef16801ac77978a5f4e843e3bb8e01ca0cad42cf841917648f756ab).
//   Restored run: `# tests 22`, `# pass 22`, `# fail 0`.

'use strict';

// R1534. The finding this suite exists to make un-repeatable: "no ToolsEnabled
// app setting requires UAC elevation", concluded from the absence of a prompt on
// a machine whose ConsentPromptBehaviorAdmin is 0 -- which means Windows grants
// every elevation request from an administrator's token WITHOUT showing one.
//
// So the assertions below are about SEMANTICS, never about observation. Not one
// of them runs an elevated thing, watches for a dialog, or believes this
// machine. Each states what Windows does at a given posture and checks that the
// product says so.

const assert = require('node:assert/strict');
const test = require('node:test');

const posture = require('../src/lib/uac-posture');
const refusal = require('../src/lib/elevation-refusal');
const registry = require('../src/lib/settings-registry');

/* A posture built from literals, so a test never depends on the machine it runs
   on. `readPosture` is given readers that answer from this table. */
function fakePosture({ values = {}, administrator = true, tokenFiltered = true } = {}) {
  return posture.readPosture({
    platform: 'win32',
    readRegistryValue: (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null),
    readTokenGroups: () => (administrator === null
      ? (() => { throw new Error('unreadable'); })()
      : `"BUILTIN\\Administrators","Alias","S-1-5-32-544","${administrator ? (tokenFiltered ? 'Group used for deny only' : 'Mandatory group, Enabled by default') : 'x'}"`
        .replace(administrator ? '' : 'S-1-5-32-544', 'S-1-1-0')),
  });
}

const STOCK = { EnableLUA: 1, ConsentPromptBehaviorAdmin: 5, ConsentPromptBehaviorUser: 3, PromptOnSecureDesktop: 1, FilterAdministratorToken: 0 };

// --- the specific false negative, named ------------------------------------

test('an administrator on a machine with the consent prompt turned off is told it will run without asking', () => {
  // This is the owner's measured posture on 2026-08-12: UAC on, but
  // ConsentPromptBehaviorAdmin 0 = "elevate without prompting".
  const machine = fakePosture({ values: { ...STOCK, ConsentPromptBehaviorAdmin: 0 } });
  const answer = posture.describeForOperation(machine, 'elevation-request');
  assert.equal(answer.outcome, 'silent');
  assert.equal(answer.tier, 1);
  // It must not read as reassurance. A machine that elevates silently is a
  // machine where changes happen unseen, and the sentence has to say that.
  assert.match(answer.sentence, /without asking/i);
  assert.match(answer.sentence, /not the Windows default/i);
});

test('the same operation on a stock machine is described as asking for approval', () => {
  const answer = posture.describeForOperation(fakePosture({ values: STOCK }), 'elevation-request');
  assert.equal(answer.outcome, 'consent');
  assert.equal(answer.tier, 1);
});

test('a standard account is told it cannot do the step rather than that it is optional-and-fine', () => {
  const answer = posture.describeForOperation(
    fakePosture({ values: STOCK, administrator: false }), 'elevation-request');
  assert.equal(answer.outcome, 'credentials');
  assert.match(answer.sentence, /username and password/i);
});

test('a standard account on a machine that auto-denies is told there will be no prompt at all', () => {
  const answer = posture.describeForOperation(
    fakePosture({ values: { ...STOCK, ConsentPromptBehaviorUser: 0 }, administrator: false }), 'elevation-request');
  assert.equal(answer.outcome, 'refused');
});

test('with UAC switched off entirely, an administrator elevates silently and a standard user cannot elevate at all', () => {
  const off = { ...STOCK, EnableLUA: 0 };
  assert.equal(posture.describeForOperation(fakePosture({ values: off }), 'elevation-request').outcome, 'silent');
  const standard = posture.describeForOperation(fakePosture({ values: off, administrator: false }), 'elevation-request');
  assert.equal(standard.outcome, 'refused');
  // The reason matters: with UAC off there is no prompt to approve, so there is
  // no walkthrough that helps this person. Saying "approve the prompt" here
  // would send them looking for something that cannot appear.
  assert.match(standard.sentence, /no way to allow|no prompt/i);
});

test('a protected write is refused for an administrator whose token is filtered, and that is the ordinary case', () => {
  const answer = posture.describeForOperation(fakePosture({ values: STOCK, tokenFiltered: true }), 'protected-write');
  assert.equal(answer.outcome, 'refused');
  assert.match(answer.sentence, /Windows will refuse/i);
});

// --- tier 2: what we say when we cannot read -------------------------------

test('an unreadable posture reports unknown and never guesses the convenient side', () => {
  const unreadable = posture.readPosture({
    platform: 'win32',
    readRegistryValue: () => { throw new Error('denied'); },
    readTokenGroups: () => { throw new Error('denied'); },
  });
  assert.equal(unreadable.readable, false);
  assert.deepEqual(posture.NEEDS, ['elevation-request', 'protected-write'],
    'the operation catalogue must not disappear and make the coverage loop vacuous');
  for (const need of posture.NEEDS) {
    const answer = posture.describeForOperation(unreadable, need);
    assert.equal(answer.outcome, 'unknown');
    assert.equal(answer.tier, 2, 'an unread machine must land in tier 2, not be answered anyway');
  }
});

test('a value that is absent is listed as unreadable rather than silently defaulted', () => {
  const partial = fakePosture({ values: { EnableLUA: 1, ConsentPromptBehaviorAdmin: 5 } });
  assert.ok(partial.unreadable.includes('FilterAdministratorToken'));
  assert.equal(partial.values.filterAdministratorToken, null);
});

test('a non-Windows machine is not described as though it had UAC', () => {
  const other = posture.readPosture({ platform: 'linux' });
  assert.equal(other.windows, false);
  assert.equal(posture.describeForOperation(other, 'elevation-request').outcome, 'unknown');
});

// --- tier 3: the frequency label, and its deference to a real reading -------

test('a measured reading overrules the general frequency label', () => {
  const answer = posture.describeForOperation(fakePosture({ values: STOCK }), 'elevation-request');
  const label = posture.frequencyLabel('rarely', answer);
  assert.equal(label.tier, 1);
  assert.equal(label.source, 'measured');
  assert.match(label.label, /On your computer/);
  // The general claim is kept, not discarded: a reader can still see what was
  // claimed about machines in general and challenge it.
  assert.equal(label.declared, 'rarely');
});

test('without a reading the general label is used and says so', () => {
  const unreadable = posture.readPosture({ platform: 'win32', readRegistryValue: () => { throw new Error('x'); }, readTokenGroups: () => { throw new Error('x'); } });
  const label = posture.frequencyLabel('typically', posture.describeForOperation(unreadable, 'elevation-request'));
  assert.equal(label.tier, 2);
  assert.equal(label.source, 'general');
  assert.match(label.label, /Typically needs a step from you/);
});

// --- the wrong diagnosis this lane exists to remove ------------------------

test('a refused elevation with no desktop to prompt on does NOT blame the person', () => {
  const classified = refusal.classify({
    exitCode: 1, stderr: 'The operation was canceled by the user.', interactive: false,
  });
  assert.equal(classified.code, refusal.CODES.UNAVAILABLE);
  assert.match(classified.whatHappened, /You were not asked/);
  assert.match(classified.whatHappened, /misleading/i);
});

test('the same words from an interactive session are reported as a genuine decline', () => {
  const classified = refusal.classify({
    exitCode: 1, stderr: 'The operation was canceled by the user.', interactive: true,
  });
  assert.equal(classified.code, refusal.CODES.DECLINED);
});

test('when we do not know whether a prompt could have been shown, we say we do not know', () => {
  const classified = refusal.classify({ exitCode: 1223, interactive: null });
  assert.equal(classified.code, refusal.CODES.UNKNOWN);
  assert.equal(classified.outcomeUnknown, true);
  assert.match(classified.whatHappened, /cannot tell/i);
});

test('no classification ever reports the elevation as granted', () => {
  const cases = [
    { exitCode: 1, stderr: 'Access is denied.' },
    { exitCode: 1, stderr: 'The operation was canceled by the user.', interactive: true },
    { exitCode: 1, stderr: 'The operation was canceled by the user.', interactive: false },
    { errorCode: 'ETIMEDOUT' },
    { timedOut: true },
    { errorCode: 'EPERM' },
  ];
  for (const signals of cases) {
    const classified = refusal.classify(signals);
    assert.ok(classified, `expected an elevation classification for ${JSON.stringify(signals)}`);
    assert.equal(classified.granted, false, 'absence is never consent: no path may report a granted elevation');
  }
});

test('a timeout is unknown rather than failed, and is never recorded as done', () => {
  const classified = refusal.classify({ timedOut: true });
  assert.equal(classified.code, refusal.CODES.UNKNOWN);
  assert.equal(classified.outcomeUnknown, true);
  assert.match(classified.whatItCosts, /not recording it as done/i);
});

test('an ordinary failure is not dressed up as an elevation problem', () => {
  assert.equal(refusal.classify({ exitCode: 1, stderr: 'SyntaxError: unexpected token' }), null);
  // and the message a caller gets keeps the child's own words in that case
  assert.equal(
    refusal.describeFailure('Building the project', { exitCode: 1, stderr: 'SyntaxError: unexpected token' }),
    'SyntaxError: unexpected token');
});

test('an elevation failure message leads with what happened, not with the misleading sentence', () => {
  const message = refusal.describeFailure('Installing dependencies', {
    exitCode: 1, stderr: 'The operation was canceled by the user.', interactive: false,
  });
  assert.ok(message.indexOf('needed administrator rights') < message.indexOf('canceled by the user'),
    'the honest explanation has to come before the raw text, or the first line still misleads');
  assert.match(message, /What the step itself reported/);
});

test('every refusal answers all three questions', () => {
  for (const signals of [{ stderr: 'Access is denied.' }, { exitCode: 1223, interactive: true }, { timedOut: true }]) {
    const classified = refusal.classify(signals);
    for (const field of ['whatHappened', 'whatWouldEnable', 'whatItCosts']) {
      assert.ok(typeof classified[field] === 'string' && classified[field].trim() !== '', `${field} missing`);
    }
  }
});

test('an absent SESSIONNAME is not read as proof of anything', () => {
  assert.equal(refusal.interactiveSession({}, 'win32'), null);
  assert.equal(refusal.interactiveSession({ SESSIONNAME: 'Services' }, 'win32'), false);
  assert.equal(refusal.interactiveSession({ SESSIONNAME: 'Console' }, 'win32'), true);
  assert.equal(refusal.interactiveSession({ SESSIONNAME: 'RDP-Tcp#3' }, 'win32'), true);
});

// --- the catalogue --------------------------------------------------------

test('every settings step that can need an administrator carries a frequency label and its reasoning', () => {
  const { entries, byId } = registry.loadRegistry();
  const elevated = registry.elevationStepIds(entries);
  assert.ok(elevated.length > 0, 'the catalogue must declare the elevation-capable settings');
  for (const id of elevated) {
    const step = byId.get(id).externalStep;
    assert.ok(registry.FREQUENCIES.has(step.frequency), `${id}: frequency must be from the closed set`);
    assert.ok(step.frequencyBecause.trim() !== '', `${id}: must record how the label was derived`);
    // The trap that produced the wrong finding: a label reasoned from "nothing
    // prompted on the machine I was looking at".
    assert.match(step.frequencyBecause, /Derived from|on every Windows machine|by default/i,
      `${id}: the reasoning must rest on what Windows requires, not on what was observed somewhere`);
    assert.equal(step.required, false, `${id}: an outside step may never be required`);
    assert.equal(step.neverPerformedForYou, true, `${id}: this product never performs the step`);
  }
});

test('a frequency outside the closed set, or one with no reasoning, is rejected', () => {
  const base = {
    whatItDoes: 'x', capabilitiesGained: ['x'], risks: ['x'], required: false,
    neverPerformedForYou: true, steps: [{ do: 'x' }], verify: 'x', withoutIt: 'x',
  };
  assert.ok(registry.validateExternalStep({ ...base, frequency: 'occasionally', frequencyBecause: 'x' })
    .some((error) => /frequency must be one of/.test(error)));
  assert.ok(registry.validateExternalStep({ ...base, frequency: 'rarely' })
    .some((error) => /requires frequencyBecause/.test(error)));
  assert.ok(registry.validateExternalStep({ ...base, elevation: true })
    .some((error) => /frequency is required when elevation is true/.test(error)));
  assert.deepEqual(registry.validateExternalStep({ ...base, elevation: true, frequency: 'rarely', frequencyBecause: 'x' }), []);
});
