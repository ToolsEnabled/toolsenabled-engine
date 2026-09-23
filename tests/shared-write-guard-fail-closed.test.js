// EXECUTABLE CHANGE
'use strict';

/* ASSERTION DISCRIMINATION REPORT (2026-08-26)
 *
 * Strengthened: "the setting genuinely governs: true lets the write through".
 * Mutation: replaced concurrentWritesEnabled()'s final setting check with
 * `return false`. Before the strengthening the entire file stayed GREEN
 * (`# pass 6`, `# fail 0`): the operation happened to run after taking a lock,
 * so `ran === true` did not prove that the enabled setting bypassed the guard.
 * After adding a fail-on-use filesystem dependency, the same mutation was RED:
 *
 *   not ok 5 - the setting genuinely governs: true lets the write through
 *   error: 'The shared-write lock could not be read or acquired, so the write was refused.'
 *   code: 'SHARED_WRITE_LOCK_STATE_UNAVAILABLE'
 *   # pass 5
 *   # fail 1
 *
 * Restored source SHA-256:
 * 859823d85428aaa2c4ea89e78afed9c455847062eb9a276380201dfa59d86244.
 * The restored run is GREEN (`# pass 6`, `# fail 0`).
 *
 * NOT-FOUND (1): both collection loops use non-empty inline literals.
 * NOT-FOUND (2): no exit-status or truthy process-return assertions exist.
 * NOT-FOUND (3): refusalFrom's catch exposes the exception for code assertions;
 * it does not swallow it, and there are no optional chains.
 * NOT-FOUND (4): injected dependencies provoke/observe boundaries but do not
 * replace shared-write-guard, the subject under test.
 * NOT-FOUND (5): there are no skips or platform precondition returns.
 * NOT-FOUND (6): expected refusal codes and booleans are independent literals.
 * Preconditions not met: none.
 */

/* THE FAIL-CLOSED HALF OF THE SHARED-WRITE GUARD, WHICH NOTHING COVERED.
 *
 * Found 2026-08-24 by mutation, not by reading. The existing proof
 * (tests/settings-elevation-shared-writes.test.js) genuinely pins the main case:
 * neutering the SHARED_WRITE_CONFLICT refusal turns it RED. But neutering
 *
 *     refuse('SHARED_WRITE_LOCK_STATE_UNAVAILABLE', ...)
 *
 * left the suite GREEN. So the branch that decides what happens when the guard
 * CANNOT TELL whether another writer holds the file was unprotected, and could
 * have been deleted without anything noticing.
 *
 * That branch is the whole point of the guard. `fleet.concurrent_shared_writes`
 * ships FALSE, promising the person that two assistants will not write one file
 * at once. A guard that refuses a KNOWN conflict but proceeds when it cannot
 * READ the lock state keeps that promise only while the filesystem cooperates --
 * and the moment it does not, the product silently does the exact thing it
 * promised not to. Unknown is not permission.
 *
 * WHAT THIS FILE COVERS, AND THE ONE THING IT STILL DOES NOT.
 * `SHARED_WRITE_LOCK_STATE_UNAVAILABLE` is refused in TWO places, and they are
 * not the same branch:
 *   1. lockPathFor(), when the services root itself cannot be resolved.
 *   2. withSharedWrite(), when the lock cannot be read or acquired.
 * Mutation-checked 2026-08-24: neutering (2) turns this file RED, so (2) is
 * covered. Neutering (1) leaves it GREEN -- (1) IS STILL UNCOVERED, because the
 * root comes from `dependencies.servicesRoot || statePath('state')` and
 * statePath is a module-level import with no injection seam, while every other
 * dependency here (servicesRoot, fsImpl, loadSettings) has one.
 * Closing it means giving statePath the same seam its neighbours already have.
 * Stated rather than left as a silent gap, because an unmeasured branch that
 * looks covered is exactly what this file was written to stop.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const guard = require('../src/lib/shared-write-guard');

const ABSOLUTE = process.platform === 'win32' ? 'C:\\tmp\\shared-target.txt' : '/tmp/shared-target.txt';

function refusalFrom(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

test('a target that is not an absolute path is refused, never guessed at', () => {
  for (const target of ['relative/path.txt', '', null, undefined, 42]) {
    const error = refusalFrom(() => guard.lockPathFor(target, {}));
    assert.ok(error, `a ${JSON.stringify(target)} target must not resolve to a lock path`);
    assert.equal(error.code, 'SHARED_WRITE_TARGET_UNKNOWN');
  }
});

test('an unreadable lock refuses the write rather than proceeding', () => {
  /* The guard cannot tell whether somebody else holds this file. The only safe
     answer is to refuse: proceeding is precisely the concurrent write the
     shipped default promises will not happen. */
  const exploded = () => { throw Object.assign(new Error('disk is unavailable'), { code: 'EIO' }); };
  const fsImpl = new Proxy({}, { get: () => exploded });

  let ran = false;
  const error = refusalFrom(() => guard.withSharedWrite(ABSOLUTE, () => { ran = true; }, {
    loadSettings: () => ({ values: { [guard.SETTING_ID]: false }, rejected: [] }),
    servicesRoot: process.platform === 'win32' ? 'C:\\tmp\\te-lock-probe' : '/tmp/te-lock-probe',
    fsImpl
  }));

  assert.ok(error, 'an unreadable lock must not fall through to the write');
  assert.equal(error.code, 'SHARED_WRITE_LOCK_STATE_UNAVAILABLE');
  assert.equal(ran, false, 'the operation must not have run');
});

test('a busy settings store is unknown, is not latched, and absence keeps its default', () => {
  let calls = 0;
  const loadSettings = () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' });
    return { values: { [guard.SETTING_ID]: true }, rejected: [] };
  };

  const error = refusalFrom(() => guard.concurrentWritesEnabled({ loadSettings }));
  assert.ok(error, 'a read failure must not become the definite disabled answer');
  assert.equal(error.code, 'SHARED_WRITE_SETTINGS_UNAVAILABLE');
  assert.equal(error.details.cause, 'EMFILE');
  assert.match(error.message, /does not claim.*absent or disabled/);
  assert.equal(guard.concurrentWritesEnabled({ loadSettings }), true,
    'the failed read must not be cached or latched over a later successful read');
  assert.equal(calls, 2);

  // Control: a successful read with no setting is the legitimate absent case;
  // it retains the pre-existing guarded default rather than becoming an error.
  assert.equal(guard.concurrentWritesEnabled({
    loadSettings: () => ({ values: {}, rejected: [] })
  }), false);
});

test('a rejected setting value leaves the guard ENGAGED, never switched off', () => {
  /* A value the settings layer REJECTED is not a value. Reading it as `true`
     would let a malformed file switch the protection off; answering `false`
     keeps the protection ON, which the lock probe proves as above. */
  for (const rejected of [[{ id: guard.SETTING_ID }], [{ id: '*' }]]) {
    const loadSettings = () => ({ values: { [guard.SETTING_ID]: true }, rejected });
    assert.equal(guard.concurrentWritesEnabled({ loadSettings }), false,
      'a rejected setting must answer the guarded state even when the raw value reads true');
    let touchedLock = false;
    const fsImpl = new Proxy({}, {
      get: (_target, property) => { touchedLock = true; throw new Error(`lock probe reached: ${String(property)}`); }
    });
    refusalFrom(() => guard.withSharedWrite(ABSOLUTE, () => {}, {
      loadSettings,
      servicesRoot: process.platform === 'win32' ? 'C:\\tmp\\te-lock-probe' : '/tmp/te-lock-probe',
      fsImpl
    }));
    assert.equal(touchedLock, true, 'a rejected setting must route the write through the lock, never around it');
  }
});

test('the setting genuinely governs: true lets the write through', () => {
  /* The mirror of the above. If this ever stops passing, the setting has stopped
     meaning anything and the row is inert again. */
  let ran = false;
  const fsImpl = new Proxy({}, {
    get: (_target, property) => {
      throw new Error(`the enabled setting must bypass all lock filesystem access (get ${String(property)})`);
    }
  });
  guard.withSharedWrite(ABSOLUTE, () => { ran = true; }, {
    loadSettings: () => ({ values: { [guard.SETTING_ID]: true }, rejected: [] }),
    fsImpl
  });
  assert.equal(ran, true, 'with concurrent shared writes allowed, the operation runs');
});

test('an invalid operation is refused before any lock is taken', () => {
  const error = refusalFrom(() => guard.withSharedWrite(ABSOLUTE, 'not a function', {
    loadSettings: () => ({ values: { [guard.SETTING_ID]: false }, rejected: [] })
  }));
  assert.ok(error);
  assert.equal(error.code, 'SHARED_WRITE_OPERATION_INVALID');
});
