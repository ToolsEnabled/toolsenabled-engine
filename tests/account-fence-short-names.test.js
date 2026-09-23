'use strict';
/* AN 8.3 SHORT NAME IS THE SAME ACCOUNT, SPELLED SHORTER.
 *
 * Windows hands out a short spelling of a profile folder for the very same
 * directory it also calls by its full name -- notably for everything under
 * %TEMP%. The account fence compared the path AS WRITTEN, the short form
 * matched no owned profile name, and the owner's own files were refused as
 * another account's.
 *
 * MEASURED 2026-09-03: this failed all 24 assertions in
 * tests/multi-account-rotation.test.js, which hands the resolver a state root
 * under %TEMP%. Every one reported ACCOUNTS_REGISTRY_UNREADABLE or
 * AGENT_CONFINEMENT_FOREIGN_PROFILE for a directory the owner owns.
 *
 * THE HALF THAT MATTERS MORE, and most of this file: the fence must still
 * refuse a profile that is genuinely another account's, must still refuse when
 * it cannot bind an alias to the OS owner, and must never treat an
 * unanswerable question as permission. Owner-only short-name metadata may
 * establish the spelling before any candidate filesystem access.
 *
 * This file never enumerates or touches another profile. The foreign paths
 * below are fabricated strings passed only to an injected tripwire filesystem.
 * Whether such a name exists is irrelevant: the fence refuses before access.
 *
 *   node --test tests/account-fence-short-names.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const boundary = require('../src/lib/account-profile-boundary.js');

const onWindows = process.platform === 'win32';
const owned = onWindows ? boundary.installationProfileRoot() : null;

/* A fabricated sibling. Never queried, listed, or opened. */
const FOREIGN = 'C:\\Users\\NoSuchAccount-3f9c1b\\AppData\\Local\\Temp\\thing';

function expectForeignWithoutProbes(assertPath, value, options) {
  const probes = [];
  const fileSystem = {
    lstatSync(candidate) { probes.push(['lstat', candidate]); throw new Error('forbidden probe'); },
    realpathSync(candidate) { probes.push(['realpath', candidate]); throw new Error('forbidden probe'); }
  };
  assert.throws(() => assertPath(value, { ...options, fileSystem }),
    error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE');
  assert.deepEqual(probes, [], 'refusal must precede candidate filesystem access');
}

function scratchUnderTemp(...segments) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-'));
  const full = path.join(root, ...segments);
  return { root, full };
}

test('a path under %TEMP% is accepted and comes back expanded', { skip: !onWindows }, () => {
  const { full } = scratchUnderTemp('identity', 'capability');
  fs.mkdirSync(full, { recursive: true });

  /* The precondition this whole fix rests on: the harness really is handed an
     8.3 spelling. If a future Windows stops doing that, this test is not
     wrong -- it is simply no longer exercising the bug. */
  const written = path.win32.normalize(full);
  const expanded = fs.realpathSync.native(full);

  const answer = boundary.assertAccountProfilePath(full, { field: 'state root', profileRoot: owned });
  assert.equal(answer, path.win32.normalize(expanded), 'the fence returns the real location');
  if (written !== expanded) {
    assert.notEqual(answer, written, 'and not the alias it was handed');
  }
});

test('a path that does not exist YET is accepted through its existing ancestor',
  { skip: !onWindows }, () => {
    /* A confined home is created on first use, so realpath cannot answer for
       it. The deepest existing ancestor decides, and the unmade segments ride
       along. */
    const { root, full } = scratchUnderTemp('home', 'not-made-yet', 'deeper');
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    const answer = boundary.assertAccountProfilePath(full, { field: 'home', profileRoot: owned });
    assert.match(answer, /not-made-yet[\\/]deeper$/);
    assert.ok(boundary.windowsPathInside(answer, owned), 'and it lands inside the owned profile');
  });

/* ---- WHAT MUST STILL BE REFUSED --------------------------------------- */

test('another account\'s profile is still refused, BY THE EARLY CHECK',
  { skip: !onWindows }, () => {
    // A final refusal code or the words "before access" cannot prove ordering.
    // Measure the forbidden side effect itself, including failed probes.
    expectForeignWithoutProbes(boundary.assertAccountProfilePath, FOREIGN,
      { field: 'state root', profileRoot: owned });
  });

test('and a real owned path still passes BOTH layers', { skip: !onWindows }, () => {
  const { full } = scratchUnderTemp('canonical-layer');
  fs.mkdirSync(full, { recursive: true });
  const answer = boundary.assertAccountProfilePath(full, { field: 'x', profileRoot: owned });
  assert.equal(answer, path.win32.normalize(fs.realpathSync.native(full)));
});

test('a foreign path that cannot be expanded is refused, not permitted',
  { skip: !onWindows }, () => {
    expectForeignWithoutProbes(boundary.assertAccountProfilePath, `${FOREIGN}\\deeper\\still`,
      { field: 'x', profileRoot: owned });
  });

test('requireOwnedProfile still means what it says', { skip: !onWindows }, () => {
  /* Outside the profile tree entirely: admissible when the caller does not
     require ownership, refused when it does. Expansion changes neither. */
  const outside = 'C:\\Windows\\System32';
  assert.ok(boundary.assertAccountProfilePath(outside, { field: 'x', profileRoot: owned }));
  expectForeignWithoutProbes(boundary.assertAccountProfilePath, outside,
    { field: 'x', profileRoot: owned, requireOwnedProfile: true });
});

test('state roots and agent confinement share the same boundary', { skip: !onWindows }, () => {
  const confinement = require('../src/lib/agent-session-confinement.js');
  assert.equal(confinement.assertAccountProfilePath, boundary.assertAccountProfilePath);

  const { full } = scratchUnderTemp('agreed');
  fs.mkdirSync(full, { recursive: true });
  assert.equal(
    confinement.assertAccountProfilePath(full, { field: 'x', profileRoot: owned }),
    boundary.assertAccountProfilePath(full, { field: 'x', profileRoot: owned }),
    'the copies accept the same path and return the same location',
  );
  for (const copy of [confinement, boundary]) {
    expectForeignWithoutProbes(copy.assertAccountProfilePath, FOREIGN, { field: 'x', profileRoot: owned });
  }
});
