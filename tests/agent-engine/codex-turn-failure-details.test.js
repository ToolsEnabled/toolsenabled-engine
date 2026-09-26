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
  return { adapter, writes, events, start, complete };
}

// Values are from the locally generated Codex 0.154.0 TurnError schema.
// Expected copy is independent of the adapter's mapping; raw provider prose
// and additionalDetails must never become a renderer, relay or audit payload.
for (const [code, expected] of [
  ['usageLimitExceeded', 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.'],
  ['contextWindowExceeded', "This Codex conversation has reached the model's context limit."],
  ['sessionBudgetExceeded', 'This Codex session has reached its budget limit.'],
  ['unauthorized', 'Codex could not authenticate this account. Check its sign-in.'],
  ['rateLimitExceeded', 'Codex is temporarily rate limited. Wait before trying again.'],
  ['serverOverloaded', 'Codex is temporarily overloaded. Try again later.']
]) {
  test(`failed Codex turn reports ${code} without private provider details or automatic retry`, async t => {
    const s = await session(t);
    s.complete({ codexErrorInfo: code, message: 'private /home/customer/key sk-test-secret', additionalDetails: 'Bearer private-token' });
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
  ['path-shaped code', { message: 'private-provider-output', codexErrorInfo: '/home/customer/key' }, null],
  ['url-shaped code', { message: 'private-provider-output', codexErrorInfo: 'https://chatgpt.com/codex' }, null],
  ['token-shaped code', { message: 'private-provider-output', codexErrorInfo: 'sk-ant-private-token' }, null],
  ['oversized code', { message: 'private-provider-output', codexErrorInfo: 'a'.repeat(65) }, null],
  ['multi-key diagnostic', { message: 'private-provider-output', codexErrorInfo: { unauthorized: {}, detail: '/home/customer/key' } }, null]
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

for (const status of ['completed', 'interrupted']) {
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

/* T1509. The provider's own usage-limit ending, in the form Codex writes it
   when turns stop on a weekly limit (the times below are synthetic; the
   window resets a week after the failure). The reset time is
   the one part of that message a person can act on, and it must reach the
   card and the chat; nothing else of the message may. Codex writes the time in
   this computer's local time, so a fixed time zone is set here. */
const RECORDED_USAGE_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 8th, 2026 3:00 AM.";
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
  const s = await clockedSession(t, '2026-06-01T12:00:00Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: RECORDED_USAGE_LIMIT, additionalDetails: 'Bearer private-token' });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
    text: 'This Codex account has reached its usage limit. The limit resets Jun 8, 3:00 AM. Until then, choose another account in the Accounts menu.',
    payload: { limit: 'usage', resetsAt: '2026-06-08T10:00:00.000Z',
      failure: { provider: 'codex', source: 'turn', code: 'usageLimitExceeded',
        summary: 'This Codex account has reached its usage limit. The limit resets Jun 8, 3:00 AM. Until then, choose another account in the Accounts menu.' } } }]);
  assert.doesNotMatch(JSON.stringify(s.events), /chatgpt\.com|credits|private-token|hit your|Visit/);
});

test('a same-day Codex usage-limit reset (no date in the message) resolves to today', async t => {
  const s = await clockedSession(t, '2026-06-08T08:00:00Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at 3:00 AM." });
  assert.equal(s.events[0].payload.resetsAt, '2026-06-08T10:00:00.000Z');
  assert.match(s.events[0].text, /resets Jun 8, 3:00 AM\./);
});

test('a reset in the next calendar year names its year', async t => {
  const s = await clockedSession(t, '2026-12-30T20:00:00Z');
  s.complete({ codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at Jan 5th, 2027 9:05 PM." });
  assert.equal(s.events[0].payload.resetsAt, '2027-01-06T05:05:00.000Z');
  assert.match(s.events[0].text, /resets Jan 5 2027, 9:05 PM\./);
});

for (const [name, message] of [
  ['an impossible date', "You've hit your usage limit. Try again at Feb 31st, 2027 3:00 AM."],
  ['a reset long past', "You've hit your usage limit. Try again at Jun 8th, 2025 3:00 AM."],
  ['a reset years away', "You've hit your usage limit. Try again at Jun 8th, 2031 3:00 AM."],
  ['no reset in the message', "You've hit your usage limit. Try again later."],
  ['a time outside the pattern', 'try again at 25:99 XM sk-private'],
]) {
  test(`a Codex usage-limit ending with ${name} keeps the plain limit sentence and invents no time`, async t => {
    const s = await clockedSession(t, '2026-06-01T12:00:00Z');
    s.complete({ codexErrorInfo: 'usageLimitExceeded', message });
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
      text: 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.',
      payload: { limit: 'usage', failure: { provider: 'codex', source: 'turn', code: 'usageLimitExceeded',
        summary: 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.' } } }]);
  });
}

test('a reset time in the message of another failure code is not read', async t => {
  const s = await clockedSession(t, '2026-06-01T12:00:00Z');
  s.complete({ codexErrorInfo: 'rateLimitExceeded', message: RECORDED_USAGE_LIMIT });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
    text: 'Codex is temporarily rate limited. Wait before trying again.',
    payload: { failure: { provider: 'codex', source: 'turn', code: 'rateLimitExceeded',
      summary: 'Codex is temporarily rate limited. Wait before trying again.' } } }]);
});
