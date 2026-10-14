'use strict';

// WHAT AN AGENT DOES WHEN IT HAS TO ASK.
//
// Owner, 2026-08-10: "An agent that needs to ask a question is a user
// preference - what should the agent do? stop? work on other work? make a
// judgement call? it might even be user preference per node."
//
// The failure this replaces is measured, not hypothetical: `approval_request`
// is a frozen event type in the engine contract that BOTH adapters emit
// (codex-adapter.js:354, claude-adapter.js:614) and NEITHER connection path can
// answer -- there is no IPC channel for it. An agent that asks permission today
// simply stalls forever. So "stop and wait" is not merely the safe default; it
// is a strict improvement on the current behaviour, which is "stop and wait
// with nobody listening".
//
// ============================ THE CEILING RULE ============================
//
// "Make a judgement call" is a SECURITY-RELEVANT setting, not a convenience.
// The rule this module exists to enforce:
//
//   THE PERMISSION TIER IS THE CEILING. THE PREFERENCE ONLY MOVES WITHIN IT.
//
// A preference can never widen what a tier permits. It can only decide what
// happens to a request the tier ALREADY allows. Concretely: if
// permission-tier-policy.js refuses a tool, no preference value -- including
// the most permissive one, including a per-node override -- can turn that
// refusal into an approval. The tier is consulted FIRST and its refusal is
// terminal.
//
// This ordering is the whole security property, so it is asserted directly by
// test rather than left as a comment: a mutant that consults the preference
// before the tier, or that lets `decide` return an approval on a tier refusal,
// must fail the suite.
//
// src/lib/permission-tier-policy.js is owned this session by lane
// `tier-enforcement-build` (agent-coord: tier-enforcement-build-territory),
// which declared itself SOLE WRITER of that file. This module therefore CALLS
// it and does not modify it -- and needs no modification to it, because
// `assertToolAllowed` already throws a PermissionTierRefusal independently of
// any preference.
//
// ============================ FAIL CLOSED ============================
//
// An unreadable, unset, misspelled, or malformed preference resolves to
// `stop-and-wait`. Never to auto-approval. This repository has repeatedly found
// the shape where absence is read as permission; here that shape would hand an
// agent unattended approval rights because a config file had a typo in it.

const DEFAULT_ACTION = 'stop-and-wait';

// The owner's three answers, as a closed set. Kept closed so a renderer and a
// policy engine must both handle every case rather than falling through to a
// default that hides one.
const ACTIONS = Object.freeze(['stop-and-wait', 'work-on-other-work', 'use-judgement']);

// The wording the settings registry shows a person, mapped to the internal
// action. Two vocabularies deliberately: the stored value is prose the owner
// chose, the action is a token the code branches on. Mapping in one place keeps
// a reworded setting from silently changing behaviour.
const ACTION_BY_LABEL = Object.freeze({
  'Stop and wait for me': 'stop-and-wait',
  'Switch to other work': 'work-on-other-work',
  'Decide for itself': 'use-judgement'
});

// Why a decision came out the way it did. `tier-refused` and `no-preference`
// are distinct on purpose: "your rules forbid this" and "you never said" are
// different things to tell a person, and collapsing them would make a tier
// refusal look like a missing setting the user could fix by choosing harder.
const REASONS = Object.freeze([
  'tier-refused',
  // Distinct from 'tier-refused' on purpose: "your level forbids this" and
  // "your level could not be checked" are different facts, and only the first
  // is the tier's decision. Collapsing them would report a missing permission
  // session as though the owner's own rules had said no.
  'tier-unavailable',
  'no-preference',
  'preference-unreadable',
  'preference-honoured',
  'node-override',
  'judgement-declined'
]);

class ApprovalPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalPolicyError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The tier contract uses *REFUSED codes for decisions made by the tier. Other
// throws mean the check itself did not produce a decision (for example EIO,
// EMFILE, or a dependency timeout). Fail closed in both cases, but do not turn
// an unavailable check into the definite claim that the owner's tier refused.
function isTierRefusal(error) {
  return error instanceof Error
    && error.name === 'PermissionTierRefusal'
    && typeof error.code === 'string'
    && error.code.endsWith('_REFUSED');
}

/**
 * Normalize whatever was stored into one of ACTIONS.
 *
 * Accepts either the internal token or the registry's human label, because the
 * value on disk is written by the settings UI and read by the engine, and those
 * two have historically disagreed about which vocabulary they speak.
 *
 * Anything unrecognised -- including undefined, null, a number, a hand-edited
 * typo, or a label from a future version -- becomes `stop-and-wait` with a
 * reason saying which kind of nothing it was.
 */
function normalizeAction(value) {
  if (value === undefined || value === null || value === '') {
    return Object.freeze({ action: DEFAULT_ACTION, reason: 'no-preference', recognised: false });
  }
  if (typeof value !== 'string') {
    return Object.freeze({ action: DEFAULT_ACTION, reason: 'preference-unreadable', recognised: false });
  }
  if (ACTIONS.includes(value)) {
    return Object.freeze({ action: value, reason: 'preference-honoured', recognised: true });
  }
  const mapped = ACTION_BY_LABEL[value.trim()];
  if (mapped) {
    return Object.freeze({ action: mapped, reason: 'preference-honoured', recognised: true });
  }
  return Object.freeze({ action: DEFAULT_ACTION, reason: 'preference-unreadable', recognised: false });
}

/**
 * Resolve the effective preference for one node.
 *
 * Per-node beats global, as the owner asked ("it might even be user preference
 * per node" -- a research node and a node touching the filesystem should not
 * share one policy). A per-node value that is unreadable does NOT silently fall
 * back to the global one: falling back would mean a typo in a node's override
 * quietly re-widened it to whatever the global says, which could be the most
 * permissive value. It fails closed instead.
 */
function resolvePreference({ globalPreference, nodePreference, perNodeEnabled = true } = {}) {
  // The catalogue exposes per-node policy as a real switch, not merely as UI
  // decoration.  When it is off, an old value left on a node must have no
  // effect: disabling the switch promises that every node follows the shared
  // answer.  Preserve `true` as the API default for callers which provide raw
  // preferences rather than a resolved settings document.
  if (perNodeEnabled === true
      && nodePreference !== undefined && nodePreference !== null && nodePreference !== '') {
    const node = normalizeAction(nodePreference);
    if (node.recognised) {
      return Object.freeze({ action: node.action, reason: 'node-override', source: 'node' });
    }
    return Object.freeze({ action: DEFAULT_ACTION, reason: 'preference-unreadable', source: 'node' });
  }
  const global = normalizeAction(globalPreference);
  return Object.freeze({ action: global.action, reason: global.reason, source: 'global' });
}

/**
 * Translate loadSettings() output into the policy vocabulary.
 *
 * Keeping this boundary here prevents callers from independently (and
 * differently) interpreting the two settings which this module claims to
 * enforce.  Missing or malformed documents fail closed: they neither enable a
 * node override nor manufacture a permissive global preference.
 */
function optionsFromSettings(settings, { nodePreference } = {}) {
  const values = isPlainObject(settings) && isPlainObject(settings.values)
    ? settings.values
    : null;
  const rejected = Array.isArray(settings?.rejected) ? settings.rejected : [];
  const globalUnknown = rejected.some(row => row.id === '*' || row.id === 'agent.blocked_question');
  return Object.freeze({
    globalPreference: values && !globalUnknown ? values['agent.blocked_question'] : undefined,
    nodePreference,
    perNodeEnabled: values
      ? values['agent.blocked_question_per_node'] === true
      : false
  });
}

/** Decide using the canonical resolved settings document. */
function decideFromSettings(request, settings, options = {}) {
  const preferences = optionsFromSettings(settings, options);
  return decide(request, { ...options, ...preferences });
}

/**
 * Decide what to do with one approval request.
 *
 * ORDER IS THE SECURITY PROPERTY. The tier is consulted first and its refusal
 * is terminal; only then does the preference get a say. Returns a frozen record
 * a UI can render and an audit log can keep, never a bare boolean -- a bare
 * boolean cannot say WHY, and "why" is the whole difference between an approval
 * the owner would stand behind and one he would not.
 *
 * `tierCheck` is injected rather than imported so that this module does not
 * reach into a file another lane owns, and so a test can prove the ordering by
 * asserting the tier was consulted even when the preference would have
 * auto-approved. It must throw to refuse -- the same contract
 * permission-tier-policy.assertToolAllowed already has.
 */
function decide(request = {}, options = {}) {
  if (!isPlainObject(request)) {
    throw new ApprovalPolicyError('APPROVAL_REQUEST_INVALID', 'approval request must be an object');
  }
  const tool = typeof request.tool === 'string' ? request.tool : null;
  const effect = typeof request.effect === 'string' ? request.effect : null;

  // ---- 1. THE CEILING, FIRST AND UNCONDITIONALLY. -----------------------
  // Note there is no `if (preference === ...)` guarding this call. A future
  // edit that adds one is the exact defect this ordering exists to prevent.
  const tierCheck = typeof options.tierCheck === 'function' ? options.tierCheck : null;
  if (tierCheck) {
    try {
      tierCheck({ name: tool, effect });
    } catch (error) {
      const refused = isTierRefusal(error);
      return Object.freeze({
        decision: 'deny',
        action: 'stop-and-wait',
        reason: refused ? 'tier-refused' : 'tier-unavailable',
        // The tier's own code travels with the denial so a surface can explain
        // it in the tier's words rather than inventing its own.
        tierCode: refused ? error.code : 'APPROVAL_TIER_CHECK_UNAVAILABLE',
        askedFor: tool,
        canOverride: false,
        explanation: refused
          ? 'Your permission level does not allow this, so no preference can approve it.'
          : 'Your permission level could not be checked, so this denial is NOT claiming that the tool is absent or that your tier refused it.'
      });
    }
  }

  // ---- 2. ONLY NOW does the preference matter. --------------------------
  const preference = resolvePreference(options);

  if (preference.action === 'stop-and-wait') {
    return Object.freeze({
      decision: 'ask',
      action: 'stop-and-wait',
      reason: preference.reason,
      askedFor: tool,
      canOverride: true,
      explanation: preference.reason === 'no-preference'
        ? 'You have not chosen what agents should do when they need to ask, so this one is waiting for you.'
        : (preference.reason === 'preference-unreadable'
          ? 'Your choice for this could not be read, so this one is waiting for you rather than deciding on its own.'
          : 'You asked to be stopped for, so this one is waiting for you.')
    });
  }

  if (preference.action === 'work-on-other-work') {
    return Object.freeze({
      decision: 'defer',
      action: 'work-on-other-work',
      reason: preference.reason,
      askedFor: tool,
      canOverride: true,
      // Deferral is NOT approval and must never be rendered as progress on the
      // blocked item: the question stays open and still needs an answer.
      explanation: 'This is parked for you and the agent has moved on to other work. It still needs your answer.'
    });
  }

  // use-judgement. Everything below can return `allow`, so everything below
  // requires that a ceiling was ACTUALLY CONSULTED -- not merely that none
  // refused.
  //
  // THE CEILING MUST EXIST, NOT JUST NOT-REFUSE. Passing no tierCheck used to
  // mean the tier block above was skipped entirely and judgement could still
  // approve, so a caller that simply forgot the permission session got
  // auto-approval with no ceiling at all. Absence read as permission -- the
  // exact defect this module warns about elsewhere, sitting in this function.
  //
  // Found by lane `tier-enforcement-build`, which had the same shape in
  // src/lib/setup/machine-record.js and reported a third instance one level up:
  // src/lib/tool-registry.js:2700 runs its tier check only
  // `if (context.permissionSession !== undefined)`, and a locally spawned agent
  // may carry no session, so that check can silently not run. VERIFIED here
  // 2026-08-10 by reading both call sites. That is precisely why this cannot
  // treat "no ceiling was supplied" as "the ceiling said yes".
  //
  // Only `allow` is gated. Stopping and deferring are safe without a tier,
  // because neither grants anything.
  const tierWasConsulted = tierCheck !== null;
  if (!tierWasConsulted) {
    return Object.freeze({
      decision: 'ask',
      action: 'stop-and-wait',
      reason: 'tier-unavailable',
      askedFor: tool,
      canOverride: true,
      explanation: 'This was set to decide for itself, but your permission level could not be checked, so it is waiting for you rather than assuming it was allowed.'
    });
  }

  // The tier already allowed it (step 1), so this is a decision strictly inside
  // what the owner's permission level permits.
  const judge = typeof options.judge === 'function' ? options.judge : null;
  if (!judge) {
    // Configured for judgement with nothing able to judge is an absence, and
    // absence resolves to asking -- never to approving.
    return Object.freeze({
      decision: 'ask',
      action: 'stop-and-wait',
      reason: 'judgement-declined',
      askedFor: tool,
      canOverride: true,
      explanation: 'This was set to decide for itself, but nothing was available to make that call, so it is waiting for you.'
    });
  }

  let verdict;
  try {
    verdict = judge({ tool, effect, request });
  } catch {
    verdict = null;
  }
  const approved = isPlainObject(verdict) && verdict.approve === true;
  return Object.freeze({
    decision: approved ? 'allow' : 'ask',
    action: approved ? 'use-judgement' : 'stop-and-wait',
    reason: approved ? preference.reason : 'judgement-declined',
    askedFor: tool,
    canOverride: true,
    judgeRationale: isPlainObject(verdict) && typeof verdict.rationale === 'string' ? verdict.rationale : null,
    explanation: approved
      ? 'The agent decided this one itself, within the limits your permission level allows.'
      : 'The agent was unable to decide this one confidently, so it is waiting for you.'
  });
}

module.exports = Object.freeze({
  ACTIONS,
  ACTION_BY_LABEL,
  REASONS,
  DEFAULT_ACTION,
  ApprovalPolicyError,
  normalizeAction,
  resolvePreference,
  optionsFromSettings,
  decideFromSettings,
  decide
});
