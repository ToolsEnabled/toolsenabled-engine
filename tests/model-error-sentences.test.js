'use strict';

// The shared error policy declared sixteen codes and no model vocabulary, so
// every model failure reached the person as one of four generic sentences. The
// measured consequence: a request that timed out while Ollama was loading a
// 13.3 GB model off disk was shown as "The required service is temporarily
// unavailable. Try again later.", which is what sent an investigation at the
// network while the provider was answering normally.
//
// These tests drive the real taxonomy and the real provider and assert the
// sentence a person ends up reading. They call with values and assert
// behaviour; none of them pins a constant's spelling.

const assert = require('node:assert/strict');
const test = require('node:test');
const taxonomy = require('../src/lib/error-taxonomy');
const provider = require('../src/lib/providers/customer-model');

const settings = () => ({ values: {
  'model.provider': 'Ollama',
  // This fixture supplies completion/error responses, not GPU probe evidence.
  // Exercise that response path under an explicit permitted CPU-fallback policy.
  'model.local_gpu_policy': 'Allow CPU fallback',
  'model.endpoint': 'http://127.0.0.1:11434',
  'model.name': 'qwen3.5:9b'
} });

const json = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json' }
});

const deadlineExpired = () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
};

// Reproduces the choice src/mcp-server.js toolError makes: a non-retryable
// failure answers in its own words, a retryable one is replaced by the fixed
// per-classification sentence.
async function shownToThePerson(fetchStub, request = { prompt: 'ping', maxOutputTokens: 16 }) {
  let thrown = null;
  await assert.rejects(
    provider.complete(request, { loadSettings: settings, fetch: fetchStub }),
    error => { thrown = error; return true; }
  );
  const typed = taxonomy.publicFailure(taxonomy.adaptToolError(thrown));
  const ownWords = thrown.message;
  const text = typed.retryable === false && typeof ownWords === 'string' && ownWords !== ''
    ? ownWords
    : typed.safeSummary;
  return { thrown, typed, text };
}

const budgetSpentReply = () => json({
  message: { role: 'assistant', content: '', thinking: 'Okay, the user just said "ping". That is a bit vague. Let' },
  done_reason: 'length'
});

test('the two newly named model failures are codes the policy knows, not unnamed ones', () => {
  for (const code of ['MODEL_PROVIDER_TIMED_OUT', 'MODEL_OUTPUT_BUDGET_SPENT']) {
    assert.equal(taxonomy.isCode(code), true, `${code} must be declared in the shared error policy`);
    const entry = taxonomy.policyFor(code);
    assert.equal(entry.code, code, `${code} must resolve to its own row, not to a fallback`);
    assert.ok(entry.safeSummary.trim().length > 0, `${code} must carry a sentence`);
  }
});

test('a model that ran past its deadline says so, and says a local model may still be loading', async () => {
  const { typed, text } = await shownToThePerson(async () => { throw deadlineExpired(); });
  assert.equal(typed.code, 'MODEL_PROVIDER_TIMED_OUT',
    'the deadline case must classify as itself, not as a generic timeout or an outage');
  assert.doesNotMatch(text, /temporarily unavailable/i,
    'the person must not be told the service was unavailable while it was answering');
  assert.doesNotMatch(text, /internal error/i);
  assert.match(text, /load/i, 'the sentence must name the loading model, which is the actual cause');
  assert.match(text, /time|deadline/i, 'the sentence must name the deadline');
});

test('a spent output budget tells the person to ask for a bigger budget, not that something broke', async () => {
  const { typed, text } = await shownToThePerson(budgetSpentReply);
  assert.equal(typed.code, 'MODEL_OUTPUT_BUDGET_SPENT');
  assert.doesNotMatch(text, /internal error/i,
    'a budget that ran out is not an internal error and must not be described as one');
  assert.match(text, /budget/i, 'the sentence must name the output budget, which is the thing to change');
  // And the policy sentence itself must be truthful too, since it is what a
  // caller reads whenever the tool has no message of its own to offer.
  assert.match(taxonomy.policyFor('MODEL_OUTPUT_BUDGET_SPENT').safeSummary, /budget/i);
  assert.doesNotMatch(taxonomy.policyFor('MODEL_OUTPUT_BUDGET_SPENT').safeSummary, /internal error/i);
});

test('a provider that really cannot be reached keeps the answer it already gave', async () => {
  // Deliberately NOT given a code of its own. A refused connection was already
  // being described honestly, and naming it here would pull it out of the
  // sweep fixture in error-taxonomy-refusal-rescue.test.js, which tracks it as
  // a source code. Widening a closed contract costs something, so it is spent
  // only where the sentence was wrong.
  const { typed, text } = await shownToThePerson(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  });
  assert.doesNotMatch(text, /internal error/i,
    'a refused connection is not an internal fault');
  assert.doesNotMatch(text, /deadline|budget/i,
    'a refused connection must not borrow either of the new explanations');
  assert.equal(typed.retryable, true, 'a provider that is not running yet may be running shortly');
});

test('a retryable model failure is offered a retry and a terminal one is not', async () => {
  const timedOut = await shownToThePerson(async () => { throw deadlineExpired(); });
  assert.equal(timedOut.typed.retryable, true,
    'a cold model load succeeds on a second attempt, so this must remain retryable');
  const spent = await shownToThePerson(budgetSpentReply);
  assert.equal(spent.typed.retryable, false,
    'asking again with the same budget spends it the same way, so this is not a retry');
});

test('the sentences the rest of the product already relied on are untouched', () => {
  // Proof that this change added model rows and edited nothing else.
  assert.equal(taxonomy.policyFor('TIMEOUT').safeSummary,
    'The operation did not finish before its safety deadline.');
  assert.equal(taxonomy.policyFor('UNAVAILABLE').safeSummary,
    'The required service is temporarily unavailable. Try again later.');
  assert.equal(taxonomy.policyFor('INTERNAL_ERROR').safeSummary,
    'The operation stopped safely because of an internal error.');
  assert.equal(taxonomy.policyFor('INVALID_REQUEST').safeSummary,
    'The request is invalid. Update it and try again.');
});
