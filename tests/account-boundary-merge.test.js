'use strict';
/* AGENT-SESSION-CONFINEMENT.JS AND ACCOUNT-PROFILE-BOUNDARY.JS SHARE ONE
 * IMPLEMENTATION OF THE ACCOUNT-BOUNDARY PRIMITIVES NOW, NOT TWO.
 *
 * They used to be two hand-maintained copies. assertAccountProfilePath was
 * kept in sync by tests/account-fence-short-names.test.js's "the two copies
 * of this rule agree" -- but installationProfileRoot(), the function that
 * supplies assertAccountProfilePath's own DEFAULT trust anchor, was never
 * covered by that discipline and silently drifted.
 *
 * MEASURED 2026-09-03, on the tree before this fix: account-profile-boundary
 * .js's installationProfileRoot() cross-checks the installed module's and
 * executable's own on-disk profile against os.userInfo().homedir and REFUSES
 * with AGENT_CONFINEMENT_WRONG_PRINCIPAL when they disagree. The copy that
 * used to live in agent-session-confinement.js instead returned
 * windowsProfileRootOf(__dirname) || windowsProfileRootOf(process.execPath)
 * outright -- whichever C:\Users\<name> this module or its host executable
 * happened to sit under -- with NO cross-check against the OS-reported
 * account at all, and no way to even exercise the check: its signature took
 * zero parameters, where account-profile-boundary.js's has always accepted
 * { platform, moduleDirectory, executablePath, userInfo } precisely so this
 * defense could be tested without touching a real foreign profile.
 *
 * That copy was reachable: src/lib/mission-bridge/actions.js
 * accountConfinedDispatchEnvironment -- which builds the environment for
 * EVERY dispatched Codex and Claude worker -- computed its trust anchor by
 * calling installationProfileRoot() on the agent-session-confinement.js
 * import, then handed the result to account-profile-boundary.js's own
 * accountConfinedEnvironment() as an already-decided, unquestioned anchor.
 * So the weaker of the two checks, not the stronger one, was the one actually
 * gating dispatch.
 *
 * Fixed by having agent-session-confinement.js require the boundary module
 * instead of re-implementing it (see the comment at the top of that file).
 * This test pins the merge two ways: the exported functions must now be the
 * SAME function object (so no future edit can quietly re-fork them), and the
 * wrong-principal defense must actually fire through both entry points.
 *
 *   node --test tests/account-boundary-merge.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const boundary = require('../src/lib/account-profile-boundary.js');
const confinement = require('../src/lib/agent-session-confinement.js');

const onWindows = process.platform === 'win32';

/* ---- the copies are now literally one implementation --------------------- */

test('installationProfileRoot is the SAME function in both modules, not two copies', () => {
  assert.equal(
    confinement.installationProfileRoot,
    boundary.installationProfileRoot,
    'agent-session-confinement.js must no longer carry its own copy of installationProfileRoot'
  );
});

test('assertAccountProfilePath is the SAME function in both modules', () => {
  assert.equal(
    confinement.assertAccountProfilePath,
    boundary.assertAccountProfilePath,
    'agent-session-confinement.js must no longer carry its own copy of assertAccountProfilePath'
  );
});

test('AgentConfinementRefusal is the SAME class in both modules', () => {
  /* Two classes with the same name are not the same class: `instanceof`
     across the two would silently fail for a caller that imported one module
     but received a refusal thrown through the other (src/lib/mission-bridge/
     actions.js requires both in accountConfinedDispatchEnvironment). */
  assert.equal(
    confinement.AgentConfinementRefusal,
    boundary.AgentConfinementRefusal,
    'a refusal thrown through one module must be `instanceof` the class a caller imported from the other'
  );
});

/* ---- the actual security gap this merge closes ---------------------------
 *
 * Fabricated, self-consistent inputs only, passed as function parameters.
 * No other-profile directory is ever listed, opened, stat'd, or created. */

test('a module/executable installed under a Windows profile that is NOT the running account is refused, not trusted',
  { skip: !onWindows }, () => {
    const runningAccountHome = 'C:\\Users\\real-owner-3f9c1b';
    const foreignProfile = 'C:\\Users\\foreign-copy-3f9c1b';
    const fakeUserInfo = () => ({ homedir: runningAccountHome });

    const cases = [
      ['a foreign module directory', {
        moduleDirectory: `${foreignProfile}\\AppData\\Local\\Programs\\toolsenabled\\resources\\src\\lib`,
        executablePath: `${runningAccountHome}\\node.exe`,
        userInfo: fakeUserInfo
      }],
      ['a foreign executable path', {
        moduleDirectory: `${runningAccountHome}\\AppData\\Local\\Programs\\toolsenabled\\resources\\src\\lib`,
        executablePath: `${foreignProfile}\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe`,
        userInfo: fakeUserInfo
      }]
    ];

    for (const [label, options] of cases) {
      for (const [copyName, copy] of [['account-profile-boundary', boundary], ['agent-session-confinement', confinement]]) {
        assert.throws(
          () => copy.installationProfileRoot(options),
          error => error.code === 'AGENT_CONFINEMENT_WRONG_PRINCIPAL',
          `${label}: ${copyName}.installationProfileRoot must refuse rather than trust the on-disk location`
        );
      }
    }
  });

test('a module/executable installed under the SAME account the OS reports is accepted',
  { skip: !onWindows }, () => {
    const ownedHome = 'C:\\Users\\real-owner-3f9c1b';
    const options = {
      moduleDirectory: `${ownedHome}\\AppData\\Local\\Programs\\toolsenabled\\resources\\src\\lib`,
      executablePath: `${ownedHome}\\AppData\\Local\\Programs\\toolsenabled\\ToolsEnabled.exe`,
      userInfo: () => ({ homedir: ownedHome })
    };
    for (const copy of [boundary, confinement]) {
      assert.equal(copy.installationProfileRoot(options), ownedHome);
    }
  });

test('CONTROL: an installation with no module/executable profile falls back to the OS-reported home, on both copies',
  { skip: !onWindows }, () => {
    const ownedHome = 'C:\\Users\\real-owner-3f9c1b';
    const options = {
      // Neither path is installed-shaped (no \AppData\Local\Programs\ marker),
      // so neither is checked against the OS account; only the source/scratch
      // fallback applies, which requires the module directory to be owned.
      moduleDirectory: `${ownedHome}\\dev\\toolsenabled\\src\\lib`,
      executablePath: 'C:\\Windows\\System32\\node.exe',
      userInfo: () => ({ homedir: ownedHome })
    };
    for (const copy of [boundary, confinement]) {
      assert.equal(copy.installationProfileRoot(options), ownedHome);
    }
  });
