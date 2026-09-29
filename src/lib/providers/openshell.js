'use strict';

// Tools for an agent running inside a person's own NVIDIA OpenShell sandbox.
//
// They talk only to the sandbox's local policy advisor (policy.local) and
// hold no gateway credential, so they can read the sandbox's own policy and
// recent denials and file a proposal, but never approve or apply anything.
// The person reviews and decides every proposal with the openshell CLI.
//
// Deliberately absent: a ready-to-run command that widens the policy. The
// person is pointed at the pending proposal instead, so a widening is always
// something they reviewed rather than something they pasted.

const {
  describeSandboxDetection,
  PolicyLocalClient,
  PolicyAdvisorError,
  listNetworkPolicyRuleNames
} = require('../openshell-inside');
const { parseDenialLine, explainDenial, buildNarrowestProposal } = require('../openshell-denial-explainer');

const REVIEW_HINT = 'The person reviews pending proposals from outside the sandbox with `openshell rule get <sandbox>` '
  + 'and decides each one with the openshell CLI. An agent cannot approve its own proposals.';
const ENABLE_ADVISOR_HINT = 'The policy advisor is off for this sandbox. The person can turn it on from outside the sandbox with '
  + '`openshell settings set <sandbox> --key agent_policy_proposals_enabled --value true`.';
// How far back denials() and propose() look: the most policy.local returns
// (MAX_DENIALS_LIMIT in OpenShell 0.1.2's openshell-supervisor-network).
const PROPOSE_LOOKBACK = 100;

function openshellError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireSandbox(env) {
  if (!describeSandboxDetection(env).insideSandbox) {
    throw openshellError('OPENSHELL_NOT_IN_SANDBOX',
      'This agent is not running inside an OpenShell sandbox (OPENSHELL_SANDBOX is not 1), so there is no sandbox policy to read.');
  }
}

function clientFor(client) {
  return client || new PolicyLocalClient();
}

function advisorFailure(error) {
  if (error instanceof PolicyAdvisorError && error.code === 'ADVISOR_DISABLED') {
    return openshellError('OPENSHELL_ADVISOR_DISABLED', ENABLE_ADVISOR_HINT);
  }
  return error;
}

async function status({ env = process.env, client } = {}) {
  const detection = describeSandboxDetection(env);
  if (!detection.insideSandbox) {
    return {
      insideSandbox: false,
      advisor: 'not-applicable',
      message: 'Not running inside an OpenShell sandbox. Nothing here is enforced by OpenShell.'
    };
  }
  try {
    const policy = await clientFor(client).getCurrentPolicy();
    return {
      insideSandbox: true,
      advisor: 'on',
      networkRules: listNetworkPolicyRuleNames(policy),
      message: 'Running inside an OpenShell sandbox with the policy advisor on. Files, network and credentials are enforced by OpenShell.'
    };
  } catch (error) {
    if (error instanceof PolicyAdvisorError && error.code === 'ADVISOR_DISABLED') {
      return { insideSandbox: true, advisor: 'off', networkRules: null, message: ENABLE_ADVISOR_HINT };
    }
    return {
      insideSandbox: true,
      advisor: 'unknown',
      networkRules: null,
      message: `policy.local did not answer as documented: ${error && error.message ? error.message : String(error)}`
    };
  }
}

function describeDenial(line) {
  const parsed = parseDenialLine(line);
  if (!parsed) return { line, understood: false };
  const explained = explainDenial(parsed);
  let proposal = null;
  let proposalNeeds = null;
  try {
    proposal = buildNarrowestProposal(parsed);
  } catch (error) {
    proposalNeeds = error.code === 'OPENSHELL_PROPOSAL_NO_BINARY'
      ? 'binary: the absolute path of the program that made the request'
      : error.message;
  }
  return {
    line,
    understood: true,
    kind: parsed.kind,
    risk: parsed.riskLevel,
    binary: parsed.binary,
    host: parsed.host,
    port: parsed.port,
    method: parsed.method,
    path: parsed.path,
    reason: parsed.reason,
    explanation: explained.plainText,
    narrowestProposal: proposal,
    proposalNeeds
  };
}

function denialKey(line) {
  const parsed = parseDenialLine(line);
  if (!parsed) return { parsed, key: line };
  return { parsed, key: [parsed.kind, parsed.binary, parsed.host, parsed.port, parsed.method, parsed.path, parsed.reason].join('\u0000') };
}

async function denials({ last = 10, host, env = process.env, client } = {}) {
  requireSandbox(env);
  let body;
  try {
    body = await clientFor(client).getDenials({ last: PROPOSE_LOOKBACK });
  } catch (error) {
    throw advisorFailure(error);
  }
  const lines = body && Array.isArray(body.denials) ? body.denials.filter((line) => typeof line === 'string') : [];
  // A blocked program retries, and one agent's CLI can fill the log in
  // seconds, so each distinct denial is listed once, newest first, with how
  // many of the lines read were that denial.
  const wanted = typeof host === 'string' && host ? host.toLowerCase() : null;
  const distinct = new Map();
  for (const line of lines) {
    const { parsed, key } = denialKey(line);
    if (wanted && !(parsed && typeof parsed.host === 'string' && parsed.host.toLowerCase() === wanted)) continue;
    const seen = distinct.get(key);
    if (seen) seen.times += 1;
    else distinct.set(key, { line, times: 1 });
  }
  const shown = [...distinct.values()].slice(0, last).map(({ line, times }) => ({ ...describeDenial(line), times }));
  return {
    logAvailable: !(body && body.log_available === false),
    linesRead: lines.length,
    count: shown.length,
    denials: shown,
    reviewHint: REVIEW_HINT
  };
}

async function propose({ denial, intent, binary, env = process.env, client } = {}) {
  requireSandbox(env);
  const parsed = parseDenialLine(denial);
  if (!parsed) {
    throw openshellError('OPENSHELL_DENIAL_UNPARSEABLE', 'That is not a denial line in a shape OpenShell logs. Pass one line exactly as openshell.denials returned it.');
  }
  const advisor = clientFor(client);
  let recent;
  try {
    recent = await advisor.getDenials({ last: PROPOSE_LOOKBACK });
  } catch (error) {
    throw advisorFailure(error);
  }
  const recentLines = recent && Array.isArray(recent.denials) ? recent.denials : [];
  if (!recentLines.some((line) => typeof line === 'string' && line.trim() === denial.trim())) {
    throw openshellError('OPENSHELL_DENIAL_NOT_RECENT',
      `That denial is not among this sandbox's last ${PROPOSE_LOOKBACK} denials. A proposal must answer a request OpenShell actually blocked.`);
  }
  let proposal;
  try {
    proposal = buildNarrowestProposal(parsed, { intentSummary: intent, binary });
  } catch (error) {
    throw openshellError(error.code || 'OPENSHELL_PROPOSAL_INVALID', error.message);
  }
  let response;
  try {
    response = await advisor.submitProposals(proposal);
  } catch (error) {
    throw advisorFailure(error);
  }
  return { submitted: true, proposal, advisorResponse: response, reviewHint: REVIEW_HINT };
}

module.exports = Object.freeze({ status, denials, propose, REVIEW_HINT, PROPOSE_LOOKBACK });
