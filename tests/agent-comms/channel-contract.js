// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const {
  AUTH_PURPOSE,
  createChannelContract,
  formatDirectAddress
} = require('../../src/lib/agent-comms/channel-contract');

const alice = Object.freeze({ agentId: 'alice', machineId: 'desktop-b' });
const bob = Object.freeze({ agentId: 'bob', machineId: 'laptop-a' });
const charlie = Object.freeze({ agentId: 'charlie', machineId: 'desktop-b' });

let time = 1_700_000_000_000;
const verifier = Object.freeze({
  verify({ purpose, canonicalMessage, authentication }) {
    assert.equal(purpose, AUTH_PURPOSE);
    assert.equal(typeof canonicalMessage, 'string');
    if (!authentication || !authentication.identity) return { authenticated: false, integrityChecked: false };
    return { authenticated: true, integrityChecked: true, sender: authentication.identity };
  }
});

const contract = createChannelContract({
  knownAgents: [alice, bob, charlie],
  verifier,
  now: () => time,
  maxBodyLength: 32
});

function channel(name) { return { type: 'channel', name }; }
function direct(agent) { return { type: 'direct', agent }; }
function submit({ sender = alice, audience, causalParent = null, kind = 'notice', body = 'hello', issuedAt = time } = {}) {
  return {
    sender,
    audience,
    causalParent,
    kind,
    body,
    issuedAt
  };
}

function auth(identity) { return { identity }; }

function actionableRefusal(value, code, mechanism) {
  assert.equal(value.accepted, false);
  assert.equal(value.code, code);
  assert.equal(typeof value.reason, 'string');
  assert.match(value.reason, mechanism);
  assert.match(value.reason, /\b(?:choose|correct|join|refresh|remove|reply|restart|restore|send|start|supply)\b/i,
    `${code} does not say how to get past the refusal: ${value.reason}`);
  assert.notEqual(value.reason, code, `${code} still uses its identifier as visible prose`);
  return value;
}

// Explicit channel lifecycle and membership.
assert.deepEqual(contract.createChannel({ name: 'ops' }), { name: 'ops', members: [] });
assert.equal(contract.joinChannel({ channel: 'ops', agent: alice }).joined, true);
assert.equal(contract.joinChannel({ channel: 'ops', agent: bob }).joined, true);
assert.throws(() => contract.createChannel({ name: formatDirectAddress(alice) }), error => error.code === 'AGENT_CHANNEL_INVALID');

// Authenticated identity must match the claimed sender; unauthenticated and
// forged submissions are refused and recorded, never placed in history.
const forged = contract.post(submit({ audience: channel('ops') }), auth(bob));
actionableRefusal(forged, 'AGENT_MESSAGE_SENDER_FORGED', /verified sender/i);
const unauthenticated = contract.post(submit({ audience: channel('ops') }), null);
actionableRefusal(unauthenticated, 'AGENT_MESSAGE_AUTHENTICATION_FAILED', /sender-verification/i);

// No implicit broadcast: an absent channel or absent direct recipient returns
// an explicit refusal reason.
const unknownChannel = contract.post(submit({ audience: channel('missing') }), auth(alice));
actionableRefusal(unknownChannel, 'AGENT_MESSAGE_CHANNEL_UNKNOWN', /channel.*directory/i);
const unknownAgent = contract.post(submit({ audience: direct({ agentId: 'nobody', machineId: 'laptop-a' }) }), auth(alice));
actionableRefusal(unknownAgent, 'AGENT_MESSAGE_RECIPIENT_UNKNOWN', /recipient.*directory/i);

// A known non-member cannot write to a channel.
const nonMember = contract.post(submit({ sender: charlie, audience: channel('ops') }), auth(charlie));
actionableRefusal(nonMember, 'AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED', /not a member/i);

// Channel sequence is broker-assigned and monotonic.  Kinds stay explicit so
// an unanswered-ask projection can distinguish asks from notices.
const ask = contract.post(submit({ audience: channel('ops'), kind: 'ask', body: 'Can you review?' }), auth(alice));
const notice = contract.post(submit({ audience: channel('ops'), kind: 'notice', body: 'Build started.' }), auth(alice));
assert.equal(ask.accepted, true);
assert.equal(ask.message.sequence, 1);
assert.equal(notice.message.sequence, 2);
assert.equal(ask.message.kind, 'ask');
assert.equal(notice.message.kind, 'notice');
assert.notEqual(ask.message.kind, notice.message.kind);

// Direct replies must bind a known ask and route back to that ask's sender.
const directAsk = contract.post(submit({ audience: direct(bob), kind: 'ask', body: 'Are you online?' }), auth(alice));
const answer = contract.post(submit({
  sender: bob,
  audience: direct(alice),
  causalParent: directAsk.message.id,
  kind: 'answer',
  body: 'Yes.'
}), auth(bob));
assert.equal(answer.accepted, true);
assert.equal(answer.message.causalParent, directAsk.message.id);
assert.equal(contract.getMessage(answer.message.id).causalParent, directAsk.message.id);
const orphan = contract.post(submit({
  sender: bob,
  audience: direct(alice),
  causalParent: 'channel:ops:999',
  kind: 'answer',
  body: 'No parent.'
}), auth(bob));
actionableRefusal(orphan, 'AGENT_MESSAGE_CAUSAL_PARENT_UNKNOWN', /original question/i);

// Credential-like and oversized content is rejected before it reaches the
// verifier or message history.
const credentialShaped = contract.post(submit({ audience: channel('ops'), body: 'api_key=not-a-real-value' }), auth(alice));
actionableRefusal(credentialShaped, 'AGENT_MESSAGE_BODY_SENSITIVE', /sensitive-content check/i);
const oversized = contract.post(submit({ audience: channel('ops'), body: 'x'.repeat(33) }), auth(alice));
actionableRefusal(oversized, 'AGENT_MESSAGE_BODY_INVALID', /empty, malformed, or overlong body/i);

// The remaining refusal mechanisms are driven too: a table lookup tested only
// by reading its keys would stay green if post() stopped using it.
actionableRefusal(
  contract.post(null, auth(alice)),
  'AGENT_MESSAGE_INVALID', /message fields/i
);
actionableRefusal(
  contract.post(submit({ audience: channel('ops'), kind: 'unexpected' }), auth(alice)),
  'AGENT_MESSAGE_KIND_INVALID', /message kind/i
);
actionableRefusal(
  contract.post(submit({ audience: channel('ops'), kind: 'answer' }), auth(alice)),
  'AGENT_MESSAGE_CAUSAL_PARENT_REQUIRED', /answer with no original question/i
);

const detectorFailure = createChannelContract({
  knownAgents: [alice, bob], verifier, now: () => time,
  sensitiveDetector() { throw new Error('detector unavailable'); }
});
actionableRefusal(
  detectorFailure.post(submit({ audience: direct(bob) }), auth(alice)),
  'AGENT_MESSAGE_SENSITIVE_DETECTOR_FAILED', /sensitive-content check/i
);

const noVerifier = createChannelContract({ knownAgents: [alice, bob], now: () => time });
actionableRefusal(
  noVerifier.post(submit({ audience: direct(bob) }), auth(alice)),
  'AGENT_MESSAGE_VERIFIER_UNAVAILABLE', /sender-verification service/i
);

const throwingVerifier = createChannelContract({
  knownAgents: [alice, bob], now: () => time,
  verifier: { verify() { throw new Error('verifier unreachable'); } }
});
actionableRefusal(
  throwingVerifier.post(submit({ audience: direct(bob) }), auth(alice)),
  'AGENT_MESSAGE_VERIFIER_UNAVAILABLE', /sender-verification service/i
);

const invalidVerifier = createChannelContract({
  knownAgents: [alice, bob], now: () => time,
  verifier: { verify() { return Promise.resolve({ authenticated: true }); } }
});
actionableRefusal(
  invalidVerifier.post(submit({ audience: direct(bob) }), auth(alice)),
  'AGENT_MESSAGE_VERIFIER_INVALID', /sender-verification service/i
);

const unknownSenderVerifier = Object.freeze({
  verify() { return { authenticated: true, integrityChecked: true, sender: charlie }; }
});
const unknownSender = createChannelContract({ knownAgents: [alice, bob], verifier: unknownSenderVerifier, now: () => time });
actionableRefusal(
  unknownSender.post(submit({ sender: charlie, audience: direct(bob) }), auth(charlie)),
  'AGENT_MESSAGE_SENDER_UNKNOWN', /sender.*directory/i
);

const wrongReply = contract.post(submit({
  sender: charlie,
  audience: direct(alice),
  causalParent: directAsk.message.id,
  kind: 'answer',
  body: 'Wrong recipient.'
}), auth(charlie));
actionableRefusal(wrongReply, 'AGENT_MESSAGE_CAUSAL_PARENT_INVALID', /does not belong to that question/i);

/* BOTH SIDES KEPT. The w20 sweep added the case below -- a message history that
 * cannot be READ must refuse rather than be scored as "no such parent" -- and a
 * later wave added the census-count guard, which stops the reason check passing
 * vacuously over an empty or truncated refusal list. They are independent and
 * both wanted. The census count stays 12: the new case builds its OWN contract
 * instance (`unavailableHistory`), so its refusal is recorded there and never
 * enters `contract.getRefusals()`. Verified by running, not assumed -- the
 * count is exactly the kind of number that looks like it should move and does
 * not. */
const unavailableHistory = createChannelContract({
  knownAgents: [alice, bob], verifier, now: () => time,
  messageResolver() { throw new Error('message history unreachable'); }
});
actionableRefusal(unavailableHistory.post(submit({
  sender: bob,
  audience: direct(alice),
  causalParent: 'remote-ask',
  kind: 'answer',
  body: 'Could not bind.'
}), auth(bob)), 'AGENT_MESSAGE_CAUSAL_PARENT_RESOLVER_FAILED', /could not read the original question/i);

const recordedRefusals = contract.getRefusals();
assert.equal(recordedRefusals.length, 12,
  'the refusal-reason census must not pass vacuously when history is empty or incomplete');
const refusalCodes = new Set(recordedRefusals.map(refusal => refusal.code));
assert.ok(recordedRefusals.every(refusal => typeof refusal.reason === 'string' && refusal.reason !== refusal.code),
  'every recorded refusal must retain an English reason rather than repeat its code');
for (const code of [
  'AGENT_MESSAGE_SENDER_FORGED',
  'AGENT_MESSAGE_AUTHENTICATION_FAILED',
  'AGENT_MESSAGE_CHANNEL_UNKNOWN',
  'AGENT_MESSAGE_RECIPIENT_UNKNOWN',
  'AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED',
  'AGENT_MESSAGE_CAUSAL_PARENT_UNKNOWN',
  'AGENT_MESSAGE_BODY_SENSITIVE',
  'AGENT_MESSAGE_BODY_INVALID'
]) assert.ok(refusalCodes.has(code), `missing recorded refusal ${code}`);

/* TEST-CAN-FAIL REPORT (testcanfail-tests-agent-comms-channel-contract-js)
 *
 * Strengthened assertion: the recorded-refusal `every` assertion now has an
 * explicit cardinality assertion before it. Mutation: changed getRefusals()
 * in src/lib/agent-comms/channel-contract.js temporarily to return an empty
 * frozen array. Before this change the `every` assertion stayed green and the
 * later code-presence loop was the first failure, proving that `every` itself
 * admitted the empty collection. With this change, the relevant RED output is:
 *
 *   AssertionError [ERR_ASSERTION]: the refusal-reason census must not pass
 *   vacuously when history is empty or incomplete
 *   0 !== 12
 *
 * Restoration: the product file was restored byte-for-byte (SHA-256
 * df1354b3fbcfbae2ca1b82bfceebe6bb0ebae3f29d083730174ec259e041c936),
 * after which `node tests/agent-comms/channel-contract.js` was GREEN with:
 *
 *   Agent comms channel-contract tests passed.
 *
 * Shape census:
 * (1) FOUND AND FIXED: `every` admitted an empty refusal history. The later
 *     fixed, non-empty expected-code loop was not vacuous.
 * (2) NOT-FOUND: no exit-status or truthy process-return assertion exists.
 * (3) NOT-FOUND: no try/catch or optional-chain swallows a tested failure.
 * (4) NOT-FOUND: verifier doubles model an external collaborator; no assertion
 *     checks a mock implementation of ChannelContract itself.
 * (5) NOT-FOUND: the file has no skip or platform precondition guard.
 * (6) NOT-FOUND: expected literals and submitted inputs are independent test
 *     oracles; references to returned message IDs test cross-record binding,
 *     not a reimplementation of the subject's ID computation.
 *
 * Preconditions not met: none.
 */

/* DURABLE-ORDER COLLATION IS PINNED, NOT INHERITED. localeCompare with no
 * locale argument collates in the HOST's locale, so channel state written on
 * one machine could be declared AGENT_COMMS_CONTROL_STATE_CORRUPT on another
 * whose locale or ICU orders the id charset differently. The property cannot
 * be exercised in-process (a test cannot change the host locale under itself),
 * so it is pinned the way this repository pins other absences: by reading the
 * source. Every localeCompare in the control plane must state its locale. */
{
  const fs = require('node:fs');
  const path = require('node:path');
  const controlPlaneSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'lib', 'agent-comms', 'control-plane.js'), 'utf8');
  const bare = controlPlaneSource.match(/\.localeCompare\((?![^)]*['"]en['"])[^)]*\)/g) || [];
  assert.deepEqual(bare, [], `control-plane.js collates durable order without a pinned locale: ${bare.join(' | ')}`);
}

process.stdout.write('Agent comms channel-contract tests passed.\n');
