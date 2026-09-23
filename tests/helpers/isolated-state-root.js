'use strict';

/* THE FIX FOR REPORT-ledger-kinds-tools-20260907.md's FINDING 1, standing per
 * Controller 3 (2026-09-07): every test run must set TOOLSENABLED_STATE_ROOT
 * to a fresh scratch directory before node resolves anything against it, and
 * never run node --test with the live root in the environment.
 *
 * MEASURED: this machine's ambient shell already carries
 * TOOLSENABLED_STATE_ROOT pointed at the live, real owner-request ledger
 * (C:\...\AppData\Roaming\ToolsEnabled-Live\capability). Two calls in this
 * lane's own new tests silently read it, because owner-request-store.js's
 * readAll() takes ONE merged options argument while every write function on
 * the same module takes (data, options) -- a call written in the write
 * shape drops its rootPath override with no error and falls through to
 * whatever the environment already holds.
 *
 * DISTINCT FROM tests/helpers/scratch-state-root.js, on purpose. That helper
 * ONLY sets TOOLSENABLED_STATE_ROOT when it is ABSENT, and its own docstring
 * says so: "IT DOES NOT OVERRIDE AN EXPLICIT ROOT ... that value stands and
 * nothing is created or removed." Read literally, that means it would leave
 * today's ambient live root exactly where it is -- it solves a different
 * problem (a bare `node` run with NOTHING published) and must not be
 * mistaken for a fix to this one. This module's override is UNCONDITIONAL:
 * whatever TOOLSENABLED_STATE_ROOT already held, right or wrong, is replaced
 * the moment this module is required, and the replacement is verified
 * against production's own resolution function before this module returns.
 *
 * USAGE: require this as the FIRST require in any test file that, directly
 * or transitively (owner-request-store.js, r-ledger.js, purchase-authority.js,
 * mission-bridge/*), resolves TOOLSENABLED_STATE_ROOT -- before anything else
 * requires one of those. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeStateRoot = require('../../src/lib/runtime-state-root');

/** This product's own Electron userData directory name for the live,
 * packaged build (LEDGER-KINDS-INTERFACE-20260907.md: "Live data (read-only,
 * never write): ...\capability\reports\OWNER-REQUEST-LEDGER.json"). Derived
 * from APPDATA, never from a literal account or machine path -- nothing here
 * names one, so this same check is correct on any account this product is
 * installed under. */
function liveCapabilityRoot({ environment = process.env, homedir = os.homedir } = {}) {
  const appData = typeof environment.APPDATA === 'string' && environment.APPDATA
    ? environment.APPDATA
    : path.join(homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'ToolsEnabled-Live', 'capability');
}

/** Case- and separator-insensitive: a live path spelled with a different
 * case, a trailing slash, or a trailing backslash is still the live path.
 * path.resolve() alone is not enough here: it only treats "\" as a
 * separator on win32, so under the posix path module this test harness
 * loads on Linux/macOS a trailing "\" survives resolve() as a literal
 * character and a same-path comparison spuriously fails (measured
 * 2026-09-08: isLiveRoot(`${live}\\`) returned false on Linux while the
 * identical call returns true on win32). Strip trailing slashes of either
 * spelling and fold internal backslashes to forward slashes before
 * resolving, so the comparison is the same on every platform this suite
 * runs on, not just the one it was authored on. */
function normalizeForLiveComparison(value) {
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, '');
  return path.resolve(withoutTrailingSeparators.replace(/\\/g, '/')).toLowerCase();
}

function isLiveRoot(root, options = {}) {
  if (typeof root !== 'string' || !root) return false;
  return normalizeForLiveComparison(root) === normalizeForLiveComparison(liveCapabilityRoot(options));
}

/** Pure: throws, naming the path, if `root` is the live capability root.
 * Never touches the filesystem or the environment -- this is the part a
 * test exercises directly, with no require-cache gymnastics needed. */
function assertNotLive(root, options = {}) {
  if (isLiveRoot(root, options)) {
    throw new Error(
      `tests/helpers/isolated-state-root.js refuses to continue: "${root}" is `
      + 'the LIVE owner-request ledger\'s capability root. A test must never read or write real owner data.'
    );
  }
  return root;
}

// THE SIDE EFFECT: runs once, the moment this module is first required.
// Unconditional -- the fix does not wait to notice the live path before
// acting, it always redirects first.
// Canonical (long-name, link-resolved) from the start: under a cmd.exe-launched
// runner %TEMP% is the 8.3 form (C:\Users\TOOLSE~2\...), and production's
// account-fenced resolution canonicalises whatever it is handed, so a raw
// mkdtemp path would compare unequal to resolveStateRoot().root below and the
// self-check would fail on spelling alone (measured 2026-09-07: exit 1 under a
// short TEMP, exit 0 under the long one, identical code). realpathSync.native
// gives the same spelling production will derive.
const scratchRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-state-root-')));
process.env.TOOLSENABLED_STATE_ROOT = scratchRoot;

// THE DEFENSIVE SELF-CHECK the requirement names: prove the override actually
// took, using the SAME resolution function production code calls
// (runtime-state-root.js resolveStateRoot -- pure, and does not touch that
// module's own memoized stateRoot()/stateRootRecord() decision).
assertNotLive(runtimeStateRoot.resolveStateRoot().root);

module.exports = Object.freeze({ scratchRoot, liveCapabilityRoot, isLiveRoot, assertNotLive });
