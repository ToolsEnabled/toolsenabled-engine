'use strict';

// WHICH TOOLS THIS SESSION'S PERMISSION LEVEL ACTUALLY OFFERS.
//
// The recommender must never name a tool the machine would refuse. That is the
// same promise src/lib/agent-tool-summary.js makes for the session-start note,
// pointed the other way: the note exists because a withheld tool read as a
// breakage to the first outside user, and a per-prompt block that recommends
// a withheld tool would manufacture that same experience once per turn.
//
// SO THE SET IS DERIVED FROM THE SAME TWO CALLS THE NOTE DERIVES IT FROM --
// src/lib/setup/machine-record.js tierToolAllowlist(), which is what the
// generated MCP configuration is written from, and the policy's own
// installTierToolNames() for the level that declares no narrowing. `full`
// answers null there, and null has never meant "every registered name works
// here" (the fra-only workspace tools are refused at every level), so the
// null branch goes through the dispatcher's own policy rather than assuming.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A CALL INTO agent-tool-summary.js.
// That module keeps the derivation inside briefToolSummary(), where it is
// entangled with the note's token budget and its refusal codes; pulling it out
// would mean editing a proven, shipped module during an adoption. The cost of
// copying it is drift, so drift is what the test pins:
// tests/capability-recall.test.js asserts this set has exactly the size
// briefToolSummary() reports as allowedCount for the same tier, which is the
// one number that module already publishes. If the two derivations ever part,
// that goes red.
//
// REFUSE WHEN THE ANSWER IS UNKNOWN, ANSWER WHEN IT IS ABSENT. rank() reads a
// missing allowlist as "no narrowing recorded", so converting a failed policy
// or machine-record read to null would let the recommender consider every
// indexed tool -- a silent widening. That failure must reach the caller. A tier
// NAME this installation does not have is the other case: that is a measured
// answer, not a failure, and it returns null.

/* Required lazily. The tool registry pulls in every provider, and a process
 * that only ever calls recommend() with an explicit allowlist has no reason to
 * pay for that. Same reasoning as agent-tool-summary.js. */
function permissionTierPolicy() { return require('../permission-tier-policy'); }
function machineRecordModule() { return require('../setup/machine-record'); }
function toolRegistryModule() { return require('../tool-registry'); }

/**
 * The tool ids offered at `tier`, or null when `tier` is not a tier this
 * installation has.
 *
 * ABSENCE IS DATA; UNREADABILITY IS NOT. The two cases below look alike from
 * the call site and are opposites:
 *   - An UNKNOWN TIER NAME is a definite, measured answer -- this installation
 *     has no such tier -- so it returns null, and rank() correctly applies no
 *     narrowing for a tier that does not exist.
 *   - A FAILED READ of the policy or machine record is NOT an answer, and
 *     returning null for it was measured to be a silent WIDENING: rank() reads
 *     a missing allowlist as "no narrowing recorded" and then considers EVERY
 *     INDEXED TOOL. That is the consequence this throw exists to prevent, and
 *     it is written here because it is invisible from this function and the
 *     next person tidying it will otherwise restore the null.
 * Same split the rest of this program now uses for an absent-vs-unresolvable
 * entry path and for an absent-vs-lost queue record.
 */
function allowedIdsForTier(tier) {
  const policy = permissionTierPolicy();
  let validated;
  try {
    validated = policy.installTier(tier);
  } catch (error) {
    /* Only a REFUSAL of the tier name is an answer. Anything else -- an
     * unreadable policy, a broken require -- is unmeasurable and must reach the
     * caller rather than becoming "no narrowing applies". */
    if (error && error.code === 'PERMISSION_INSTALL_TIER_REFUSED') return null;
    throw error;
  }
  const declared = machineRecordModule().tierToolAllowlist(validated);
  const names = declared === null
    ? policy.installTierToolNames(toolRegistryModule().registeredTools(), validated)
    : declared;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`Could not establish a non-empty tool allowlist for permission tier "${validated}".`);
  }
  return new Set(names);
}

module.exports = Object.freeze({ allowedIdsForTier });
