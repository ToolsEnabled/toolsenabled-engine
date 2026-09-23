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
    // A usage limit also says so as data (T1509); no other code carries a payload.
    const payload = code === 'usageLimitExceeded' ? { payload: { limit: 'usage' } } : {};
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed', text: expected, ...payload }]);
    assert.equal(s.writes.filter(entry => entry.method === 'turn/start').length, 1);
    assert.equal(s.adapter.closed, null);
    await s.start('turn-2');
    s.complete(null, { turnId: 'turn-2', status: 'completed' });
    assert.deepEqual(s.events.at(-1), { type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-2', status: 'completed' });
  });
}

for (const [name, error] of [
  ['missing', undefined], ['null', null],
  ['unknown code', { message: 'private-provider-output', codexErrorInfo: 'futureProviderCode' }],
  ['message alone', { message: 'usage limit exceeded private-provider-output' }],
  ['structured diagnostic', { message: 'private-provider-output', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }],
  ['prototype name', { message: 'private-provider-output', codexErrorInfo: 'toString' }]
]) {
  test(`Codex ${name} diagnostic retains failure without inventing a reason`, async t => {
    const s = await session(t);
    s.complete(error);
    assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed' }]);
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
    text: 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, choose another account in the Accounts menu.',
    payload: { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z' } }]);
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
      text: 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.',
      payload: { limit: 'usage' } }]);
  });
}

test('a reset time in the message of another failure code is not read', async t => {
  const s = await clockedSession(t, '2026-09-22T12:01:16Z');
  s.complete({ codexErrorInfo: 'rateLimitExceeded', message: RECORDED_USAGE_LIMIT });
  assert.deepEqual(s.events, [{ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', status: 'failed',
    text: 'Codex is temporarily rate limited. Wait before trying again.' }]);
});
