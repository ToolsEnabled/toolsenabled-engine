'use strict';

// A local model has to be read off disk before it can answer. Measured on the
// owner's machine 2026-09-04 against Ollama 0.33.3: the 13.3 GB model
// "Qwen3-Coder-30B-A3B-Instruct q3_k_s" needed 48,875 ms to LOAD, generating
// zero tokens, and the 6.1 GB "qwen3.5:9b" needed 19,361 ms cold and 483 ms
// warm. A 30,000 ms bound covering load, prompt and generation therefore
// refuses models the endpoint is serving perfectly well, and the abort was
// being reported to the person as the provider being unreachable.
//
// These tests assert behaviour by calling complete() with values. None of them
// pins a constant's spelling, so a better implementation of the same behaviour
// keeps them green.

const assert = require('node:assert/strict');
const test = require('node:test');
const provider = require('../src/lib/providers/customer-model');

const settings = (selected, endpoint) => () => ({ values: {
  'model.provider': selected,
  'model.local_gpu_policy': 'Allow CPU fallback',
  'model.endpoint': endpoint || (selected === 'Ollama' ? 'http://127.0.0.1:11434' : 'https://models.example.test/v1'),
  'model.name': 'customer-model'
} });

const jsonResponse = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json' }
});

// What AbortSignal.timeout() rejects a fetch with when the deadline expires.
const deadlineExpired = () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
};

// The measured load time of the largest model actually installed on the
// owner's machine, generating no tokens at all.
const MEASURED_LOAD_MS = 48875;

test('a local model is given long enough to load before the request is abandoned', async () => {
  let observed = null;
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => { throw deadlineExpired(); }
  }), error => {
    observed = error;
    return true;
  });
  assert.ok(
    Number.isFinite(observed.details.timeoutMs),
    'a deadline failure must report the deadline it applied, so the bound can be checked'
  );
  assert.ok(
    observed.details.timeoutMs > MEASURED_LOAD_MS,
    `a local endpoint must allow more than the ${MEASURED_LOAD_MS} ms this machine measured for a model load, got ${observed.details.timeoutMs}`
  );
});

test('an expired deadline is not reported as an unreachable provider', async () => {
  // The provider answered and was still loading the model. Calling that
  // "unreachable" sent the owner looking at the network for a deadline the
  // product had set, so the two must not share a code or a sentence.
  let timedOut = null;
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => { throw deadlineExpired(); }
  }), error => { timedOut = error; return true; });

  let unreachable = null;
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }
  }), error => { unreachable = error; return true; });

  assert.equal(unreachable.code, 'MODEL_PROVIDER_UNREACHABLE',
    'a refused connection is still an unreachable provider');
  assert.notEqual(timedOut.code, unreachable.code,
    'a deadline that expired and a connection that was refused must be told apart');
  assert.notEqual(timedOut.message, unreachable.message,
    'the person must not be told the provider was unreachable when it was answering');
});

test('a cloud endpoint keeps a shorter deadline than a local one', async () => {
  const deadlineOf = async selected => {
    let seen = null;
    await assert.rejects(provider.complete({ prompt: 'ping' }, {
      loadSettings: settings(selected),
      getSecret: () => 'vault-only',
      fetch: async () => { throw deadlineExpired(); }
    }), error => { seen = error; return true; });
    return seen.details.timeoutMs;
  };
  const local = await deadlineOf('Ollama');
  const cloud = await deadlineOf('OpenAI compatible');
  assert.ok(cloud < local,
    `a remote endpoint does not load a model off this disk, so it should wait less than a local one, got cloud ${cloud} and local ${local}`);
});

test('an explicit deadline from the caller still wins', async () => {
  let seen = null;
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    timeoutMs: 1234,
    fetch: async () => { throw deadlineExpired(); }
  }), error => { seen = error; return true; });
  assert.equal(seen.details.timeoutMs, 1234);
});

test('a reasoning model that spends the whole budget thinking is not called an invalid response', async () => {
  // Measured against qwen3.5:9b: at num_predict 16 the reply came back with
  // done_reason "length", an empty content and 56 characters of thinking. The
  // model behaved; the budget ran out. Reporting that as a failed request
  // hides the one thing that would let the person fix it.
  let seen = null;
  await assert.rejects(provider.complete({ prompt: 'ping', maxOutputTokens: 16 }, {
    loadSettings: settings('Ollama'),
    fetch: async () => jsonResponse({
      message: { role: 'assistant', content: '', thinking: 'Okay, the user just said "ping". That\'s a bit vague. Let' },
      done_reason: 'length'
    })
  }), error => { seen = error; return true; });
  assert.notEqual(seen.details && seen.details.reason, 'empty or invalid response',
    'a spent output budget is not an invalid response');
  assert.match(String(seen.message).toLowerCase(), /budget|reasoning|thinking|longer answer/,
    'the sentence must name what ran out, so the person knows to raise the output budget');
});

test('a genuinely empty answer is still refused', async () => {
  // Guarding the existing behaviour: nothing above may be used to let a blank
  // reply through as if it were an answer.
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => jsonResponse({ message: { content: '' } })
  }), error => error.code === 'MODEL_PROVIDER_REQUEST_FAILED');
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => jsonResponse({ message: { content: '', thinking: '   ' }, done_reason: 'length' })
  }), error => error.code === 'MODEL_PROVIDER_REQUEST_FAILED');
});

test('the sentence the person is shown names the deadline, not an outage or an internal error', async () => {
  // The person never sees this module's message. They see the safeSummary the
  // error policy attaches to whatever src/lib/error-taxonomy.js classifies the
  // failure as. Measured against the real taxonomy: MODEL_PROVIDER_UNREACHABLE
  // classifies as UNAVAILABLE, "The required service is temporarily
  // unavailable" - which is what sent this investigation at the network. The
  // policy declares no MODEL_ code, so an unrecognised one lands on
  // INTERNAL_ERROR. This test drives the real taxonomy rather than a copy of
  // its rules, so it fails if either end stops agreeing.
  const taxonomy = require('../src/lib/error-taxonomy');
  let thrown = null;
  await assert.rejects(provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => { throw deadlineExpired(); }
  }), error => { thrown = error; return true; });

  const shown = taxonomy.adaptProviderError(thrown, { operation: 'external-read' });
  // Assert what the person is told, not which classification carries it. An
  // earlier version of this test pinned the classification to TIMEOUT and went
  // red the moment a BETTER implementation gave the failure a name of its own -
  // which is exactly the spelling pin this repository's rules forbid, and the
  // quickest way to green would have been to undo the improvement.
  assert.notEqual(shown.code, 'UNAVAILABLE',
    'the person must not be told the service was unavailable when it was answering');
  assert.notEqual(shown.code, 'INTERNAL_ERROR',
    'a deadline is not an internal error');
  const sentence = String(taxonomy.policyFor(shown.code).safeSummary).toLowerCase();
  assert.match(sentence, /deadline|time/,
    'the sentence the person reads must say the answer ran out of time');
  assert.doesNotMatch(sentence, /temporarily unavailable/,
    'the sentence must not blame an outage for a deadline this product set');
});

test('a normal answer is unaffected by any of this', async () => {
  const answered = await provider.complete({ prompt: 'ping' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => jsonResponse({ message: { content: 'ollama answer', thinking: 'some reasoning' }, done_reason: 'stop' })
  });
  assert.equal(answered.text, 'ollama answer');
  assert.equal(answered.contentTrust, 'untrusted');
  assert.equal(answered.grantsAuthority, false);
});
