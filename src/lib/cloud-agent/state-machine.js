'use strict';

// Pure state-transition rules for the provider-neutral cloud-agent session.
// No fs, no network, no adapter knowledge -- every function here takes the
// current state and a reported state and either returns the reported state
// (transition accepted) or throws. src/lib/cloud-agent/session.js is the
// only caller; it decides WHEN to call these, never whether a transition not
// listed below is allowed.

const { CloudAgentError } = require('./errors');
const { isKnownState } = require('./contract');

const BIND_TRANSITIONS = Object.freeze({
  UNBOUND: Object.freeze(['READY'])
});

// A first submit may only land on SUBMITTED (the provider acknowledged
// receipt) or UNKNOWN (the outcome is ambiguous, e.g. a timeout with no
// confirmation). It may never land directly on a terminal state: this
// module has no way to distinguish "the provider is instant" from "a caller
// skipped verifying its own submit response", so it fails closed.
const SUBMIT_TRANSITIONS = Object.freeze({
  READY: Object.freeze(['SUBMITTED', 'UNKNOWN'])
});

// inspect, cancel, and reconcile all resolve to "what does the provider say
// now" and share one table: a terminal state is a fixed point (no further
// transition without a new submission, which this module never issues), and
// UNKNOWN can both be entered from and recovered from any in-flight state.
const OBSERVE_TRANSITIONS = Object.freeze({
  SUBMITTED: Object.freeze(['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']),
  RUNNING: Object.freeze(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']),
  SUCCEEDED: Object.freeze(['SUCCEEDED']),
  FAILED: Object.freeze(['FAILED']),
  CANCELLED: Object.freeze(['CANCELLED']),
  UNKNOWN: Object.freeze(['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'])
});

function assertKnownState(value, label) {
  if (!isKnownState(value)) {
    throw new CloudAgentError('CLOUD_AGENT_STATE_UNKNOWN', `${label} "${value}" is not a recognized cloud-agent state.`);
  }
}

function assertTransition(table, from, to, opLabel) {
  assertKnownState(from, 'current state');
  assertKnownState(to, 'reported state');
  const allowed = table[from];
  if (!allowed || !allowed.includes(to)) {
    throw new CloudAgentError('CLOUD_AGENT_ILLEGAL_TRANSITION', `${opLabel} may not move state from ${from} to ${to}.`);
  }
  return to;
}

function afterBind(from) {
  return assertTransition(BIND_TRANSITIONS, from, 'READY', 'bindEnvironment');
}

function afterSubmit(from, reported) {
  return assertTransition(SUBMIT_TRANSITIONS, from, reported, 'submit');
}

function afterObserve(from, reported, opLabel = 'inspect') {
  return assertTransition(OBSERVE_TRANSITIONS, from, reported, opLabel);
}

// The one place "may this session be treated as done and its artifacts
// used" is decided. Provider-reported SUCCEEDED alone is not enough --
// reconciled must have been independently earned by reconcile().
function canAdvance(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new CloudAgentError('CLOUD_AGENT_SESSION_INVALID', 'canAdvance requires a session snapshot object.');
  }
  assertKnownState(session.state, 'session state');
  if (typeof session.reconciled !== 'boolean') {
    throw new CloudAgentError('CLOUD_AGENT_SESSION_INVALID', 'canAdvance requires a boolean reconciled result.');
  }
  return session.state === 'SUCCEEDED' && session.reconciled;
}

module.exports = Object.freeze({
  afterBind,
  afterSubmit,
  afterObserve,
  canAdvance
});
