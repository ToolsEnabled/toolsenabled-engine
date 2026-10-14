'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');

async function session(t) {
  const writes = [], listeners = new Set(), events = [];
  const emit = packet => {
    for (const listener of listeners) listener(JSON.stringify(packet) + '\n');
  };
  const adapter = new CodexAdapter({
    codexVersion: '0.154.0',
    transport: {
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') emit({ id: request.id, result: {
          userAgent: 'codex/0.154.0', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux'
        } });
      }
    }
  });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  const start = async (turnId = 'turn-1') => {
    const pending = adapter.sendTurn({ threadId: 'thread-1', text: 'bounded check' });
    const request = writes.filter(entry => entry.method === 'turn/start').at(-1);
    emit({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    await pending;
  };
  await start();
  const complete = (error, { status = 'failed', threadId = 'thread-1', turnId = 'turn-1' } = {}) =>
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error } } });
  return { adapter, writes, events, start, complete, emit };
}

// Values are from the locally generated Codex 0.154.0 TurnError schema.
// Expected copy is independent of the adapter's mapping; raw provider prose
// and additionalDetails must never become a renderer, relay or audit payload.
for (const [code, expected] of [
  ['usageLimitExceeded', 'This Codex account has reached its usage limit. Wait for its allowance to reset, or use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.'],
  ['contextWindowExceeded', "This Codex conversation has reached the model's context limit."],
  ['sessionBudgetExceeded', 'This Codex session has reached its budget limit.'],
  ['unauthorized', 'Codex could not authenticate this account. Check its sign-in.'],
  ['rateLimitExceeded', 'Codex is temporarily rate limited. Wait before trying again.'],
  ['serverOverloaded', 'Codex is temporarily overloaded. Try again later.']
]) {
  test(`failed Codex turn reports ${code} without private provider details or automatic retry`, async t => {
    const s = await session(t);
    s.complete({ codexErrorInfo: code, message: 'private /\x68ome/customer/key sk-test-secret', additionalDetails: 'Bearer private-token' });
    /* A usage limit also says so as data (T1509). EVERY failure now also says
       its sentence as data (T1552), because the program that writes the saved
       conversation will not persist prose this product has not vouched for --
       the vouching is `payload.failure`, and the sentence in it is the same
       product-owned sentence, never one byte more of the provider. */
    const limit = code === 'usageLimitExceeded' ? { limit: 'usage' } : {};
    const failure = { failure: { provider: 'codex', source: 'turn', code, summary: expected } };
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed', text: expected, payload: { ...limit, ...failure } }]);
    assert.doesNotMatch(JSON.stringify(s.events), /private|sk-test-secret|Bearer/);
    assert.equal(s.writes.filter(entry => entry.method === 'turn/start').length, 1);
    assert.equal(s.adapter.closed, null);
    await s.start('turn-2');
    s.complete(null, { turnId: 'turn-2', status: 'completed' });
    assert.deepEqual(s.events.at(-1), { type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-2', status: 'completed' });
  });
}

/* T1552. THE TURN THAT SAID NOTHING, and this loop is the regression that let
   it happen. Every row below used to end with an event carrying no `text` at
   all -- which the chat draws as "turn failed - session still open" and the
   saved conversation as "Turn did not finish. No safe failure detail was
   recorded". MEASURED 2026-09-25 with a revoked refresh token on a healthy,
   signed-in pro account: codex-cli 0.156.0 answered "workspace routing
   discovery unauthorized (401)" and the person was shown none of it.

   A row is now expected to produce a sentence AND the provider's own code when
   that code is shaped like the enum it is documented to be. `message` is still
   withheld whole: the final assertion in each row is the same credential fence
   as before. */
for (const [name, error, code] of [
  ['missing', undefined, null], ['null', null, null],
  ['unknown code', { message: 'private-provider-output', codexErrorInfo: 'futureProviderCode' }, 'futureProviderCode'],
  ['message alone', { message: 'usage limit exceeded private-provider-output' }, null],
  ['structured diagnostic', { message: 'private-provider-output', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, 'httpConnectionFailed'],
  ['prototype name', { message: 'private-provider-output', codexErrorInfo: 'toString' }, 'toString'],
  /* Shapes that could begin a path, a URL, a query string or a token are not
     enum names and are not quoted at a person: the turn still speaks, without
     naming a code. */
  ['path-shaped code', { message: 'private-provider-output', codexErrorInfo: '/\x68ome/customer/key' }, null],
  ['url-shaped code', { message: 'private-provider-output', codexErrorInfo: 'https://chatgpt.com/codex' }, null],
  ['token-shaped code', { message: 'private-provider-output', codexErrorInfo: 'sk-ant-private-token' }, null],
  ['oversized code', { message: 'private-provider-output', codexErrorInfo: 'a'.repeat(65) }, null],
  ['multi-key diagnostic', { message: 'private-provider-output', codexErrorInfo: { unauthorized: {}, detail: '/\x68ome/customer/key' } }, null]
]) {
  test(`Codex ${name} diagnostic still names the provider failure without inventing a reason`, async t => {
    const s = await session(t);
    s.complete(error);
    const expected = code
      ? `Codex ended this turn with a failure ToolsEnabled has no message for: "${code}". Check its sign-in with "codex login status", and that the Codex CLI is current.`
      : 'Codex ended this turn with a failure and named no reason ToolsEnabled could read. Check its sign-in with "codex login status", and that the Codex CLI is current.';
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
      text: expected,
      payload: { failure: { provider: 'codex', source: 'turn', ...(code ? { code } : {}), summary: expected } } }]);
    assert.match(s.events[0].text, /Codex/, 'a failure a person reads has to name the program that failed');
    assert.doesNotMatch(JSON.stringify(s.events), /private-provider-output|\/home\/|https:|sk-ant/);
  });
}

test('a model Codex does not serve is refused with Codex\'s own one-line reason', async t => {
  const s = await session(t);
  const said = 'The model `gate-b/unknown:c3-codex` does not exist or you do not have access to it.';
  s.complete({ message: `${said}\nprivate-provider-output`, codexErrorInfo: 'other' });
  const expected = `Codex refused this model: ${said}`;
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed', text: expected,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: expected } } }]);
  assert.doesNotMatch(JSON.stringify(s.events), /private-provider-output/);
});

for (const [name, message] of [
  ['a link', 'The model is unavailable, see https://chatgpt.com/private-account-page'],
  ['an address', 'The model is not enabled for person@example.test'],
  ['a credential shape', 'The model request failed with token=sk-ant-private-token'],
  ['a path', 'The model config at /\x68ome/customer/private-project/config.toml is invalid'],
  ['a reason too long to save', 'The model ' + 'x'.repeat(240) + ' is not supported'],
]) {
  test(`a model failure carrying ${name} keeps the generic sentence`, async t => {
    const s = await session(t);
    s.complete({ message, codexErrorInfo: 'other' });
    assert.match(s.events[0].text, /^Codex ended this turn with a failure ToolsEnabled has no message for: "other"/);
    assert.doesNotMatch(JSON.stringify(s.events), /https:|@example|sk-ant|\/home\/customer|x{200}/);
  });
}

/* 1.0.50 review CM-3. Codex quotes the model it refuses, and a name the person typed with two slashes, an "@"
   version, a word like "token" or a great length used to trip the privacy filter: the provider's line was withheld
   whole and the person was told to check a sign-in that was fine. The line is the one Gate B measured
   (candidate 4, HP-42), with the typed name in its place. The model reaches the adapter either as this turn's
   override or as the model its thread was started on. */
const MODEL_ENVELOPE = name => `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '${name}' model is not supported when using Codex with a ChatGPT account."}}`;
const MODEL_NOT_RUN = 'Codex did not run the model this agent is set to use. Check the model name, or choose another model.';
async function modelSession(t, { turnModel = null, threadModel = null } = {}) {
  const writes = [], listeners = new Set(), events = [];
  const emit = packet => { for (const listener of listeners) listener(JSON.stringify(packet) + '\n'); };
  const adapter = new CodexAdapter({
    codexVersion: '0.154.0',
    transport: {
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') emit({ id: request.id, result: {
          userAgent: 'codex/0.154.0', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux'
        } });
      }
    }
  });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  if (threadModel) {
    const started = adapter.startThread({ model: threadModel });
    const request = writes.find(entry => entry.method === 'thread/start');
    assert.equal(request.params.model, threadModel);
    emit({ id: request.id, result: { thread: { id: 'thread-1' }, model: threadModel } });
    await started;
  }
  const pending = adapter.sendTurn({ threadId: 'thread-1', text: 'bounded check', ...(turnModel ? { options: { model: turnModel } } : {}) });
  const request = writes.filter(entry => entry.method === 'turn/start').at(-1);
  if (turnModel) assert.equal(request.params.model, turnModel);
  emit({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  await pending;
  const complete = error => emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error } } });
  return { events, complete };
}

for (const [name, where] of [
  ['accounts/fireworks/models/llama-v3p1-8b', 'turn'],
  ['accounts/fireworks/models/llama-v3p1-8b', 'thread'],
  ['gpt-6.1-sol@2026-10-01', 'turn'],
  ['my-token-model', 'thread'],
  ['vendor/' + 'long-model-name-'.repeat(12) + 'v9', 'turn'],
]) {
  test(`a refusal quoting the ${where} model ${name.slice(0, 40)} shows Codex's own words, never sign-in advice`, async t => {
    const s = await modelSession(t, where === 'turn' ? { turnModel: name } : { threadModel: name });
    const said = MODEL_ENVELOPE(name);
    s.complete({ message: `${said}\nprivate-provider-output`, codexErrorInfo: 'other' });
    // The saved conversation cannot hold this name (two separators, "@", "token", or past 260 characters), so it
    // keeps the product's own sentence; the live chat reads Codex.
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
      text: `Codex refused this model: ${said}`,
      payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: MODEL_NOT_RUN, category: 'model-refused' } } }]);
    assert.doesNotMatch(JSON.stringify(s.events), /private-provider-output|codex login status|sign-in/);
  });
}

test('a refusal quoting a typed name the saved conversation can hold keeps one sentence for both', async t => {
  const name = 'openai/gpt-oss-120b';
  const s = await modelSession(t, { turnModel: name });
  const expected = `Codex refused this model: ${MODEL_ENVELOPE(name)}`;
  s.complete({ message: MODEL_ENVELOPE(name), codexErrorInfo: 'other' });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed', text: expected,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: expected, category: 'model-refused' } } }]);
});

test('a refusal naming the typed model beside a link says the model was not run, and quotes nothing', async t => {
  const name = 'accounts/fireworks/models/llama-v3p1-8b';
  const s = await modelSession(t, { turnModel: name });
  s.complete({ message: `The '${name}' model is unavailable, see https://chatgpt.com/private-account-page`, codexErrorInfo: 'other' });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed', text: MODEL_NOT_RUN,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: MODEL_NOT_RUN, category: 'model-refused' } } }]);
  assert.doesNotMatch(JSON.stringify(s.events), /https:|private-account-page|codex login status/);
});

for (const [model, message, leak] of [
  ['customer', 'The model config at /\x68ome/customer/private-project/config.toml is invalid', /\/home\/customer|private-project/],
  ['password', 'The model request sent password hunter2-private-value', /hunter2|private-value/],
]) {
  test(`a typed model called ${model} is set aside only where Codex quotes it, so the rest is still withheld`, async t => {
    const s = await modelSession(t, { turnModel: model });
    s.complete({ message, codexErrorInfo: 'other' });
    assert.match(s.events[0].text, /^Codex ended this turn with a failure ToolsEnabled has no message for: "other"/);
    assert.doesNotMatch(JSON.stringify(s.events), leak);
  });
}

for (const status of ['interrupted']) {
  test(`Codex ${status} turn does not acquire failure copy from contradictory diagnostics`, async t => {
    const s = await session(t);
    s.complete({ message: 'private-provider-output', codexErrorInfo: 'usageLimitExceeded' }, { status });
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status }]);
  });
}

test('late Codex quota completion cannot overwrite the next turn', async t => {
  const s = await session(t);
  s.complete(null, { status: 'completed' });
  await s.start('turn-2');
  const before = s.events.length;
  s.complete({ message: 'private-provider-output', codexErrorInfo: 'usageLimitExceeded' });
  assert.equal(s.events.length, before);
  s.complete(null, { status: 'completed', turnId: 'turn-2' });
  assert.equal(s.events.at(-1).turnId, 'turn-2');
  assert.equal(s.events.at(-1).status, 'completed');
});

test('a different thread cannot attach quota copy to an owned Codex turn', async t => {
  const s = await session(t);
  s.complete({ message: 'private-provider-output', codexErrorInfo: 'usageLimitExceeded' }, { threadId: 'foreign-thread' });
  assert.equal(s.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].threadId, 'thread-1');
  assert.equal(s.events[0].status, 'failed');
  assert.doesNotMatch(s.events[0].text, /usage limit|private-provider-output/);
});

/* T1509. The provider's own usage-limit ending, as recorded on 2026-09-22
   12:01Z when 37 Codex turns stopped on a weekly limit (the account's weekly
   window was recorded as resetting at 2026-09-29T09:13:42Z). The reset time is
   the one part of that message a person can act on, and it must reach the
   card and the chat; nothing else of the message may. Codex writes the time in
   this computer's local time, so the recorded owner time zone is fixed here. */
const RECORDED_USAGE_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 29th, 2026 2:13 AM.";
async function clockedSession(t, nowIso) {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });
  const writes = [], listeners = new Set(), events = [];
  const emit = packet => { for (const listener of listeners) listener(JSON.stringify(packet) + '\n'); };
  const adapter = new CodexAdapter({
    codexVersion: '0.154.0',
    now: () => Date.parse(nowIso),
    transport: {
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') emit({ id: request.id, result: {
          userAgent: 'codex/0.154.0', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux'
        } });
      }
    }
  });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  const pending = adapter.sendTurn({ threadId: 'thread-1', text: 'bounded check' });
  const request = writes.filter(entry => entry.method === 'turn/start').at(-1);
  emit({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  await pending;
  const complete = error => emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error } } });
  return { events, complete };
}

test('a recorded Codex usage-limit ending carries its reset time and nothing else of the provider message', async t => {
  const s = await clockedSession(t, '2026-09-22T12:01:16Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: RECORDED_USAGE_LIMIT, additionalDetails: 'Bearer private-token' });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
    text: 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.',
    payload: { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z',
      failure: { provider: 'codex', source: 'turn', code: 'usageLimitExceeded',
        summary: 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.' } } }]);
  assert.doesNotMatch(JSON.stringify(s.events), /chatgpt\.com|credits|private-token|hit your|Visit/);
});

test('a same-day Codex usage-limit reset (no date in the message) resolves to today', async t => {
  const s = await clockedSession(t, '2026-09-29T08:00:00Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at 2:13 AM." });
  assert.equal(s.events[0].payload.resetsAt, '2026-09-29T09:13:00.000Z');
  assert.match(s.events[0].text, /resets Sep 29, 2:13 AM\./);
});

test('a reset in the next calendar year names its year', async t => {
  const s = await clockedSession(t, '2026-12-30T20:00:00Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at Jan 5th, 2027 9:05 PM." });
  assert.equal(s.events[0].payload.resetsAt, '2027-01-06T05:05:00.000Z');
  assert.match(s.events[0].text, /resets Jan 5 2027, 9:05 PM\./);
});

for (const [name, message] of [
  ['an impossible date', "You've hit your usage limit. Try again at Feb 31st, 2027 2:13 AM."],
  ['a reset long past', "You've hit your usage limit. Try again at Sep 29th, 2025 2:13 AM."],
  ['a reset years away', "You've hit your usage limit. Try again at Sep 29th, 2031 2:13 AM."],
  ['no reset in the message', "You've hit your usage limit. Try again later."],
  ['a time outside the pattern', 'try again at 25:99 XM sk-private'],
]) {
  test(`a Codex usage-limit ending with ${name} keeps the plain limit sentence and invents no time`, async t => {
    const s = await clockedSession(t, '2026-09-22T12:01:16Z');
    s.complete({ codexErrorInfo: 'usageLimitExceeded', message });
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
      text: 'This Codex account has reached its usage limit. Wait for its allowance to reset, or use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.',
      payload: { limit: 'usage', failure: { provider: 'codex', source: 'turn', code: 'usageLimitExceeded',
        summary: 'This Codex account has reached its usage limit. Wait for its allowance to reset, or use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.' } } }]);
  });
}

test('a reset time in the message of another failure code is not read', async t => {
  const s = await clockedSession(t, '2026-09-22T12:01:16Z');
  s.complete({ codexErrorInfo: 'rateLimitExceeded', message: RECORDED_USAGE_LIMIT });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
    text: 'Codex is temporarily rate limited. Wait before trying again.',
    payload: { failure: { provider: 'codex', source: 'turn', code: 'rateLimitExceeded',
      summary: 'Codex is temporarily rate limited. Wait before trying again.' } } }]);
});


const POLICY_SENTENCE = 'This request was blocked by our safety systems. Reason: Synthetic prohibited action.';
for (const code of ['misalignment_policy_violation', 'misalignmentPolicyViolation']) {
  for (const notification of [false, true]) test(`policy refusal preserves its reason and fails a completed envelope: ${code}, notification=${notification}`, async t => {
    const s = await session(t);
    const error = { codexErrorInfo: code, message: POLICY_SENTENCE + '\nprivate diagnostic', additionalDetails: 'private diagnostic' };
    if (notification) s.emit({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error } });
    s.complete(notification ? null : error, { status: 'completed' });
    const terminal = s.events.at(-1);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.text, POLICY_SENTENCE);
    assert.equal(terminal.payload.failure.category, 'safety-policy');
    assert.equal(terminal.payload.failure.retryable, false);
    assert.equal(terminal.payload.failure.code, 'misalignmentPolicyViolation');
    assert.doesNotMatch(JSON.stringify(terminal), /private diagnostic|login|CLI|temporar/);
    assert.equal(s.writes.filter(row => row.method === 'turn/start').length, 1);
  });
}
test('a completed envelope cannot erase an explicit authentication failure', async t => {
  const s = await session(t);
  s.complete({ codexErrorInfo: 'unauthorized', message: 'private diagnostic' }, { status: 'completed' });
  assert.equal(s.events.at(-1).status, 'failed');
  assert.equal(s.events.at(-1).payload.failure.code, 'unauthorized');
  assert.match(s.events.at(-1).text, /authenticate/);
});
test('a policy refusal marked retrying interrupts once, retains its cause on interruption, and never reconnects', async t => {
  const s = await session(t);
  const error = { codexErrorInfo: 'misalignment_policy_violation', message: POLICY_SENTENCE };
  for (let i=0;i<2;i++) s.emit({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error } });
  assert.equal(s.writes.filter(row => row.method === 'turn/interrupt').length, 1);
  s.complete(null, { status: 'interrupted' });
  assert.equal(s.events.at(-1).status, 'failed');
  assert.equal(s.events.at(-1).text, POLICY_SENTENCE);
  assert.equal(s.writes.filter(row => row.method === 'turn/start').length, 1);
});
test('unsafe diagnostic text cannot leak through a policy refusal', async t => {
  const s = await session(t);
  s.complete({ codexErrorInfo: 'misalignmentPolicyViolation', message: 'This request was blocked by our safety systems. Reason: /private/fixture/path', additionalDetails: 'private diagnostic' });
  assert.equal(s.events.at(-1).status, 'failed');
  assert.match(s.events.at(-1).text, /safety policy/);
  assert.doesNotMatch(JSON.stringify(s.events), /private|login|CLI/);
});

test('continuation classifies safety refusals as a nonretry cause even beside a transient hint', () => {
  const { classifyFailure } = require('../../src/lib/agent-continuation-state');
  for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation']) {
    assert.deepEqual(classifyFailure({ code }, { retrySafe: true }), { retry: false, reason: 'safety_policy_refusal' });
    assert.deepEqual(classifyFailure({ code: 'ECONNRESET', payload: { failure: { code } } }, { retrySafe: true }), { retry: false, reason: 'safety_policy_refusal' });
  }
});

test('persisted safety refusal never becomes a due continuation or a recovery claim', () => {
  const { createContinuationState } = require('../../src/lib/agent-continuation-state');
  let now = 1;
  const store = createContinuationState({ file: ':memory:', now: () => now });
  try {
    const started = store.begin(store.track({ sessionId: 'synthetic-policy-session' }), { observed: true });
    const blocked = store.failed(started, { code: 'ECONNRESET', payload: { failure: { code: 'misalignmentPolicyViolation' } } }, { retrySafe: true });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'safety_policy_refusal');
    for (const advance of [15000, 60000, 3600000]) {
      now += advance;
      assert.deepEqual(store.dueRecoveries({ includeUncertain: true }), []);
      assert.equal(store.claim(blocked), null);
    }
  } finally { store.close(); }
});


/* 1.0.50 review CM-2. A failure is a model refusal, which the host holds queued and helper sends on, only when Codex
   names the model this turn asked for. A line that only mentions "model" (above, with no requested model known) or
   a failure that names no model stays an ordinary failure. */
test('a refusal naming the requested model is marked as a model refusal; other failures are not', async t => {
  const name = 'my-typed-model';
  const refused = await modelSession(t, { turnModel: name });
  refused.complete({ message: MODEL_ENVELOPE(name), codexErrorInfo: 'other' });
  assert.equal(refused.events[0].payload.failure.category, 'model-refused');
  const other = await modelSession(t, { turnModel: name });
  other.complete({ message: 'The server had an error while processing your request.', codexErrorInfo: 'other' });
  assert.equal(other.events[0].payload.failure.category, undefined);
  const safety = await modelSession(t, { turnModel: name });
  safety.complete({ message: `The '${name}' model request was blocked by our safety systems.`, codexErrorInfo: 'misalignmentPolicyViolation' });
  assert.equal(safety.events[0].payload.failure.category, 'safety-policy');
});

/* 1.0.50 review #14. The usage-limit sentence is shown live in a New agent tab too (agent-session.js
   sessionTurnFailureText), where Switch and continue is disabled until the agent is added to a tree. Both forms of
   the sentence therefore say what a tab must do first, as the saved transcript line already does. */
test('both Codex usage-limit sentences tell a New agent tab to use Add to tree first', async t => {
  for (const message of [RECORDED_USAGE_LIMIT, "You've hit your usage limit. Try again later."]) {
    const s = await clockedSession(t, '2026-09-22T12:01:16Z');
    s.complete({ codexErrorInfo: 'usageLimitExceeded', message });
    assert.match(s.events[0].text, /use Switch and continue to move this agent to another account\. In a New agent tab, use Add to tree first\.$/);
    assert.equal(s.events[0].payload.failure.summary, s.events[0].text);
  }
});
