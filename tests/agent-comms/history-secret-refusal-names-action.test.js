'use strict';

// THE STORE'S SECRET REFUSAL NAMED A FIELD THE CALLER NEVER SENT, AND NO ACTION.
//
// Evidence, this installation, capability/logs/actions.jsonl: eight
// agent_comms.send_local failures whose entire caller-visible reason was
//
//   "message.message.body contains a credential-like value."
//
// agent_comms.send_local takes `from`, `to` and `body`. Nothing named
// `message.message.body` exists in that request. The doubled path is the
// owner-journal envelope fabric.js builds -- `{ streamId, message }` -- walked
// under history.append's default label `message`.
//
// It is reachable because channel-contract screens the body with
// providers/sensitive-local-input.containsSensitiveMaterial and accepts it,
// and history re-screens the envelope with its own stricter SENSITIVE_TEXT
// and refuses. This suite pins BOTH halves: that the two detectors really do
// disagree on a concrete string (so the path is live, not theoretical), and
// that the sentence the caller then receives names the mechanism and the
// action rather than only a storage-internal location.
//
// The refusal itself is not relaxed anywhere here: every check below still
// requires the append to throw HISTORY_SECRET_REJECTED and to write nothing.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHistory, HistoryError } = require('../../src/lib/agent-comms/history');
const { containsSensitiveMaterial } = require('../../src/lib/providers/sensitive-local-input');

// A body the channel contract admits. It is not a credential: it is an agent
// telling another agent where to grep.
const CONTRACT_CLEAN_BODY = 'grep for token=aaaaaaaaaaaaaaaaaaaa in src/lib/audit.js';

function adapter() {
  const calls = { reads: 0, writes: 0 };
  return {
    calls,
    getMemory() { calls.reads += 1; return null; },
    setMemory() { calls.writes += 1; return { revision: 1 }; }
  };
}

function refusalFor(message) {
  const store = adapter();
  const history = createHistory({ store });
  let thrown = null;
  try { history.append({ channelId: 'channel', message }); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof HistoryError, 'the append must refuse');
  assert.equal(thrown.code, 'HISTORY_SECRET_REJECTED', 'the refusal code is the contract and must not change');
  assert.equal(store.calls.writes, 0, 'a refused append must not write');
  return thrown;
}

test('the live disagreement that produces this refusal still exists', () => {
  // If this ever becomes true, the contract screens the body first and the
  // store's refusal stops reaching send_local callers -- at which point this
  // suite is telling you the shape of the world changed, not that it passed.
  assert.equal(containsSensitiveMaterial(CONTRACT_CLEAN_BODY), false,
    'the channel contract detector must still admit this body');
});

test('the secret refusal names what the caller must change', () => {
  const thrown = refusalFor({ streamId: 'stream', message: { body: CONTRACT_CLEAN_BODY } });

  assert.match(thrown.message, /nothing was sent/i,
    'the caller must be told the message did not go out');
  assert.match(thrown.message, /take the password, key, or token out of the message text/i,
    'the caller must be told the action to take');
  assert.match(thrown.message, /vault/i,
    'the caller must be told where a real credential belongs');
});

test('the storage-internal path is labelled as one, not offered as a request field', () => {
  const thrown = refusalFor({ streamId: 'stream', message: { body: CONTRACT_CLEAN_BODY } });

  // The path is still reported -- it is the only locator there is -- but it
  // must not be the whole sentence, and it must not read as a parameter name.
  assert.notEqual(thrown.message, 'message.message.body contains a credential-like value.',
    'the refusal must no longer be a bare internal path plus a fact');
  assert.match(thrown.message, /inside the stored envelope/i,
    'the path must be described as an envelope location');
  assert.match(thrown.message, /not the name of a request field/i,
    'the caller must be told the path is not something to look for in the request');
  assert.equal(thrown.details.field, 'message.message.body',
    'machine readers still get the exact path in details.field');
});

test('a credential-shaped field name gets its own action, not the text action', () => {
  const thrown = refusalFor({ apiKey: 'not-even-a-real-secret-aaaaaaaaaaaaaaaa' });

  assert.match(thrown.message, /rename or remove that field/i,
    'a bad field name is fixed by renaming it, not by editing prose');
  assert.doesNotMatch(thrown.message, /take the password, key, or token out of the message text/i,
    'the two causes must not share one action');
  assert.equal(thrown.details.field, 'message.apiKey');
});

test('a clean message still stores', () => {
  const store = adapter();
  const history = createHistory({ store, now: () => 1 });
  const record = history.append({ channelId: 'channel', message: { body: 'ship it' } });
  assert.equal(record.sequence, 1);
  assert.equal(store.calls.writes, 1, 'the refusal must not have become universal');
});
