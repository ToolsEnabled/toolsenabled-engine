'use strict';

// WHAT THIS INSTALLATION IS ENTITLED TO, ASKED WITHOUT LOADING ANY LICENSING CODE.
//
// WHY THIS FILE HAS NO require() AT ALL, AND MUST NEVER GAIN ONE.
//
// AND WHY THIS COMMENT NEVER WRITES A QUOTED MODULE PATH INSIDE require(...).
// Not style -- the packer resolves a quoted relative specifier and stages the
// file WITHOUT ever asking whether it sat in a comment. Its insideComment()
// check is consulted only for specifiers that already failed to resolve. So a
// commented-out example naming one of the three licensing modules would stage
// that module and silently undo this entire seam, while every test still
// passed. The first draft of this very file did exactly that. Name a module in
// prose, or as a bare quoted path; never inside the call parentheses.
//
// tools/pack-capability-layer.mjs builds the shipped payload by walking literal
// require() calls as TEXT, from the installer entrypoints outward. It is not a
// runtime trace. A require() inside a function stages its target exactly like a
// top-level one, and so does a require() that has been commented out: the
// packer's insideComment() check can only ever suppress an ERROR about a
// specifier that already failed to resolve on disk, so a resolvable relative
// literal is staged no matter where it sits. The only thing that removes a
// module from the payload is the disappearance of its SPECIFIER TEXT from every
// staged file. src/lib/tool-pack-registry.js makes the same point for tool
// definitions: the only honest fix is to change the GRAPH.
//
// Until this file existed, src/lib/system-status.js named './entitlement' in a
// literal require, inside a lazy fail-soft helper. That laziness was correct and
// did its runtime job: a diagnostic never dragged licensing code into a process
// that had no licence to check, and tests/shipped-registry-boundary.test.js
// still proves that at runtime. But laziness is invisible to the packer, and that
// one line of text staged three modules the owner ruled must not ship 2026-08-11:
//   src/lib/entitlement.js          the commercial tier table and prices
//   src/lib/providers/license.js    the mechanism a paid tier is enforced with
//   src/lib/license-store.js        its signed revocation store
//
// This module is the seam that breaks that text edge. system-status.js requires
// THIS file, which names no licensing module anywhere, and asks it a question.
//
// WHO SUPPLIES THE REAL ANSWER. src/lib/tool-packs/vendor-license-issuance.js --
// the same vendor pack that already holds the three license.* tools, reached
// only through src/lib/tool-packs/index.js, which no payload entrypoint requires.
// It is deliberately the SAME pack and the SAME load point rather than a second
// mechanism. Two switches that can disagree about whether licensing is present
// is a defect class this codebase has already paid for repeatedly; one switch
// that is either on or off cannot drift from itself.
//
// WHAT THE DEFAULT MEANS, AND WHY IT IS NOT A GUESS. With no reporter
// registered, this reports tier community, full-function, ok:true. That is not a
// degraded reading, a fallback, or an assumption made in ignorance. It is the
// literal and complete truth about a build that ships no licensing code: it
// checks nothing, it gates nothing, and it never will. The free product must
// never report itself as unlicensed-and-degraded -- having bought nothing is its
// normal, supported, permanent state, and painting it red would be this repo's
// absence-as-emptiness defect wearing a billing hat.

/**
 * The unlicensed-behaviour constant, restated here because a build that ships no
 * licensing code cannot read it from the module that owns it.
 *
 * THIS IS A DELIBERATE SECOND COPY OF src/lib/entitlement.js UNLICENSED_INSTALL,
 * and a second copy of a policy value is exactly the thing that drifts. So it is
 * not left to good intentions: tests/entitlement-report.js asserts these two
 * literals are equal, vendor-side, where both files exist. If anyone ever
 * changes one, that test fails and names the other. A duplicated constant a test
 * forces to agree is a different thing from a duplicated constant.
 */
const UNLICENSED_INSTALL = 'full-function';

/** Schema version of the block below. Matches src/lib/entitlement.js SCHEMA_VERSION. */
const SCHEMA_VERSION = 1;

/**
 * Why the reporter could not be consulted. These stay DISTINCT on purpose.
 *
 * `no-licensing-in-this-build` is the normal state of the free product and means
 * everything is working. `entitlement-unreadable` means licensing IS present and
 * is BROKEN, and somebody should look at it. Collapsing the two would reproduce
 * the indistinguishability defect this project keeps finding -- "no alerts"
 * reading identically to "the alert channel is dead" -- with the free product's
 * healthy steady state as the thing being disguised.
 */
const REASON_NO_LICENSING = 'no-licensing-in-this-build';
const REASON_UNREADABLE = 'entitlement-unreadable';
const REASON_UNRECOGNIZED = 'entitlement-unrecognized';

let reporter = null;
let reporterName = null;

/**
 * Vendor-side only. Supplies the function that really resolves a licence.
 *
 * Registering twice with the same name is allowed and is what a test clearing
 * the require cache does. Registering a second, DIFFERENT reporter throws: which
 * of two answers about what a customer paid for is authoritative is not a
 * question this file is willing to answer by picking the last one to load.
 */
function registerEntitlementReporter(name, fn) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new TypeError(`An entitlement reporter needs a lowercase-dashed name; got ${JSON.stringify(name)}.`);
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`Entitlement reporter '${name}' must be a function taking ({ root }).`);
  }
  if (reporter && reporterName !== name) {
    throw new Error(
      `An entitlement reporter '${reporterName}' is already registered, so '${name}' would silently replace it. `
      + 'Exactly one component may answer what this installation is entitled to.'
    );
  }
  reporter = fn;
  reporterName = name;
}

/** True when licensing code is present in this build. Reported, never inferred. */
function hasEntitlementReporter() { return reporter !== null; }

/**
 * The complete, honest entitlement block for a build that ships no licensing.
 *
 * `gatedCapabilities: []` is a TRUE empty list, not a list that failed to load,
 * and `licensing: 'not-in-this-build'` is here so a reader never has to guess
 * which of those two an empty array means. That distinction is the whole reason
 * this field exists; without it, "nothing is gated" and "the gate list is
 * missing" would render identically.
 */
function freeBuildEntitlement(reason, extra) {
  return Object.freeze({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    licensing: 'not-in-this-build',
    tier: 'community',
    tierLabel: 'Community',
    licensed: false,
    active: false,
    licenseChecked: false,
    licenseId: null,
    expiresAt: null,
    unlicensedInstall: UNLICENSED_INSTALL,
    unlicensedInstallStatement:
      'This installation is fully functional, permanently. It performs no licence '
      + 'checks of any kind, because this build ships no licensing code at all. '
      + 'Nothing here is reserved for a paying customer and nothing here expires.',
    gatedCapabilities: Object.freeze([]),
    reason,
    ...(extra || {})
  });
}

/**
 * A reporter was registered, but it did not produce an entitlement reading.
 *
 * None of the entitlement fields may borrow the free build's answers here. A
 * thrown reporter or an unrecognized response establishes neither a community
 * tier nor an unlicensed, inactive installation; those values remain unknown.
 */
function unreadableEntitlement(reason, detail) {
  return Object.freeze({
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    licensing: 'present-but-unreadable',
    tier: null,
    tierLabel: null,
    licensed: null,
    active: null,
    licenseChecked: false,
    licenseId: null,
    expiresAt: null,
    unlicensedInstall: null,
    unlicensedInstallStatement: null,
    gatedCapabilities: null,
    reason,
    detail
  });
}

/**
 * Ask what this installation is entitled to. NEVER THROWS, on any path.
 *
 * This is the load-bearing property, not a nicety: the only caller is a
 * diagnostic (src/lib/system-status.js doctor()), and a diagnostic must never be
 * the thing that blocks an install. An operator whose licensing is broken needs
 * the health report MORE than usual, not less, so a failure here is reported
 * inside the block and never raised out of it.
 */
function describeEntitlement(options) {
  if (!reporter) return freeBuildEntitlement(REASON_NO_LICENSING);
  let described;
  try {
    described = reporter(options || {});
  } catch (error) {
    return unreadableEntitlement(
      REASON_UNREADABLE,
      String((error && error.message) || error).slice(0, 1000)
    );
  }
  if (!described || typeof described !== 'object' || Array.isArray(described)) {
    return unreadableEntitlement(
      REASON_UNRECOGNIZED,
      `the registered entitlement reporter returned ${Array.isArray(described) ? 'an array' : typeof described}`
    );
  }
  return described;
}

/**
 * Test seam only, mirroring src/lib/tool-pack-registry.js resetForTests(). A
 * suite proving the shipped (no-licensing) shape must be able to get back to it
 * without spawning a second process.
 */
function resetForTests() { reporter = null; reporterName = null; }

module.exports = Object.freeze({
  registerEntitlementReporter,
  hasEntitlementReporter,
  describeEntitlement,
  freeBuildEntitlement,
  resetForTests,
  UNLICENSED_INSTALL,
  SCHEMA_VERSION,
  REASON_NO_LICENSING,
  REASON_UNREADABLE,
  REASON_UNRECOGNIZED
});
