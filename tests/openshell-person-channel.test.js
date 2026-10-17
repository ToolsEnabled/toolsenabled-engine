'use strict';

// The terminal's stand-in for the desktop's ask and notify windows inside an
// OpenShell sandbox (src/lib/openshell-person-channel.js): a question waits
// only briefly, answers `pending`, and the agent collects the person's one
// answer by asking again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const channel = require('../src/lib/openshell-person-channel');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'person-channel-')), 'state', 'openshell-person-channel.json');
}

// A clock the fake sleep moves forward, so a wait costs no real time and its
// length can be measured.
function clock(startMs = Date.parse('2026-09-29T12:00:00Z')) {
  const c = { nowMs: startMs, slept: 0 };
  c.now = () => c.nowMs;
  c.sleep = async (ms) => { c.nowMs += ms; c.slept += ms; };
  return c;
}

function deps(file, c, extra = {}) {
  return { file, now: c.now, sleep: c.sleep, from: 'claude', ...extra };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function approvalArgs(inputHash = HASH_A) {
  return { title: 'Approve standin.send', message: 'Approve one execution of standin.send?', action: 'standin.send', inputHash, timeoutSeconds: 60 };
}

function answerAtTerminal(file, c, id, decision, words) {
  channel.markShown([id], { file, now: c.now });
  return channel.decide({ id, decision, words }, { file, now: c.now });
}

test('an unanswered question answers pending within the short wait, never the CLI timeout', async () => {
  const file = tempFile();
  for (const timeoutSeconds of [5, 60, 900]) {
    const c = clock();
    const answer = await channel.ask({ message: `Proceed ${timeoutSeconds}?`, timeoutSeconds }, deps(file, c));
    assert.equal(answer.answer, 'pending');
    assert.equal(answer.pending, true);
    assert.equal(answer.approved, false);
    assert.match(answer.askId, /^Q\d+$/);
    assert.match(answer.reason, /toolsenabled approvals/);
    assert.match(answer.reason, /again with the same message/);
    assert.ok(c.slept <= Math.min(timeoutSeconds, channel.MAX_WAIT_SECONDS) * 1000, `waited ${c.slept} ms for timeoutSeconds ${timeoutSeconds}`);
  }
  // Well inside both CLIs' default tool timeouts (measured: Codex 0.158 completed
  // a 119 s call, Claude Code 2.1.284 a 75 s one), and short enough not to hold
  // the agent's other calls for long.
  assert.ok(channel.MAX_WAIT_SECONDS <= 30);
});

test('asking the same thing again files no second question, and collects the answer exactly once', async () => {
  const file = tempFile();
  const c = clock();
  const first = await channel.ask(approvalArgs(), deps(file, c));
  const again = await channel.ask(approvalArgs(), deps(file, c));
  assert.equal(again.askId, first.askId);
  assert.equal(channel.read({ file, now: c.now }).asks.length, 1);
  assert.equal(channel.read({ file, now: c.now }).asks[0].timesAsked, 2);

  answerAtTerminal(file, c, first.askId, 'approve', 'go ahead');
  const collected = await channel.ask(approvalArgs(), deps(file, c));
  assert.deepEqual([collected.answer, collected.approved, collected.askId, collected.note], ['yes', true, first.askId, 'go ahead']);
  assert.equal(channel.read({ file, now: c.now }).asks[0].state, 'collected');

  // Used up: the next identical ask is a new question for the person.
  const next = await channel.ask(approvalArgs(), deps(file, c));
  assert.equal(next.answer, 'pending');
  assert.notEqual(next.askId, first.askId);
});

test('an answer given during the wait comes back in the same call', async () => {
  const file = tempFile();
  const c = clock();
  let answered = false;
  const sleep = async (ms) => {
    await c.sleep(ms);
    if (!answered && c.slept >= 1000) {
      answered = true;
      answerAtTerminal(file, c, 'Q1', 'deny', 'Not before the tests pass.');
    }
  };
  const answer = await channel.ask({ message: 'May I deploy?' }, { ...deps(file, c), sleep });
  assert.deepEqual([answer.answer, answer.approved, answer.reason], ['no', false, 'Not before the tests pass.']);
  assert.ok(c.slept < 5000);
});

test('an approval belongs to its exact arguments and its asker', async () => {
  const file = tempFile();
  const c = clock();
  const a = await channel.ask(approvalArgs(HASH_A), deps(file, c));
  const b = await channel.ask(approvalArgs(HASH_B), deps(file, c));
  const other = await channel.ask(approvalArgs(HASH_A), deps(file, c, { from: 'codex' }));
  assert.equal(new Set([a.askId, b.askId, other.askId]).size, 3);
  answerAtTerminal(file, c, a.askId, 'approve');
  assert.equal((await channel.ask(approvalArgs(HASH_B), deps(file, c))).answer, 'pending');
  assert.equal((await channel.ask(approvalArgs(HASH_A), deps(file, c, { from: 'codex' }))).answer, 'pending');
  assert.equal((await channel.ask(approvalArgs(HASH_A), deps(file, c))).answer, 'yes');
});

test('two identical asks racing for one answer: exactly one collects it', async () => {
  const file = tempFile();
  const c = clock();
  const first = await channel.ask(approvalArgs(), deps(file, c));
  answerAtTerminal(file, c, first.askId, 'approve');
  const results = await Promise.all([channel.ask(approvalArgs(), deps(file, c)), channel.ask(approvalArgs(), deps(file, c))]);
  assert.deepEqual(results.map((r) => r.answer).sort(), ['pending', 'yes']);
});

test('the person must see a question before answering, and a denial needs the reason', async () => {
  const file = tempFile();
  const c = clock();
  const { askId } = await channel.ask({ message: 'Proceed?' }, deps(file, c));
  assert.throws(() => channel.decide({ id: askId, decision: 'approve' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_NOT_SHOWN' });
  channel.markShown([askId], { file, now: c.now });
  assert.throws(() => channel.decide({ id: askId, decision: 'deny', words: '  ' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_REASON_REQUIRED' });
  assert.throws(() => channel.decide({ id: 'P3', decision: 'approve' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_ID_INVALID' });
  assert.throws(() => channel.decide({ id: 'Q99', decision: 'approve' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_ID_UNKNOWN' });
  assert.equal(channel.decide({ id: askId, decision: 'approve' }, { file, now: c.now }).state, 'approved');
  assert.throws(() => channel.decide({ id: askId, decision: 'approve' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_NOT_WAITING' });
});

test('an approval not yet collected can be taken back; a collected one cannot', async () => {
  const file = tempFile();
  const c = clock();
  const { askId } = await channel.ask(approvalArgs(), deps(file, c));
  answerAtTerminal(file, c, askId, 'approve');
  const takenBack = channel.decide({ id: askId, decision: 'deny', words: 'Changed my mind.' }, { file, now: c.now });
  assert.equal(takenBack.takenBack, true);
  const told = await channel.ask(approvalArgs(), deps(file, c));
  assert.deepEqual([told.answer, told.reason], ['no', 'Changed my mind.']);
  assert.throws(() => channel.decide({ id: askId, decision: 'deny', words: 'again' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_NOT_WAITING' });
});

test('an unanswered question closes after a day, and an uncollected answer after an hour', async () => {
  const file = tempFile();
  const c = clock();
  const old = await channel.ask({ message: 'Still there?' }, deps(file, c));
  c.nowMs += channel.OPEN_FOR_MS;
  assert.equal(channel.read({ file, now: c.now }).asks[0].state, 'expired');
  const fresh = await channel.ask({ message: 'Still there?' }, deps(file, c));
  assert.notEqual(fresh.askId, old.askId);
  answerAtTerminal(file, c, fresh.askId, 'approve');
  c.nowMs += channel.COLLECT_WITHIN_MS;
  const late = await channel.ask({ message: 'Still there?' }, deps(file, c));
  assert.equal(late.answer, 'pending');
  assert.notEqual(late.askId, fresh.askId);
  assert.throws(() => channel.decide({ id: fresh.askId, decision: 'deny', words: 'no' }, { file, now: c.now }), { code: 'PERSON_CHANNEL_NOT_WAITING' });
});

test('a full queue, a bad file or bad input refuse with a sentence and change nothing', async () => {
  const file = tempFile();
  const c = clock();
  for (let i = 0; i < 64; i += 1) await channel.ask({ message: `q${i}`, timeoutSeconds: 5 }, deps(file, c));
  await assert.rejects(channel.ask({ message: 'one more' }, deps(file, c)), { code: 'PERSON_CHANNEL_FULL' });
  await assert.rejects(channel.ask({ message: '' }, deps(file, c)), { code: 'PERSON_CHANNEL_TEXT_INVALID' });
  await assert.rejects(channel.ask({ message: 'x', timeoutSeconds: 4 }, deps(file, c)), { code: 'PERSON_CHANNEL_TIMEOUT_INVALID' });
  fs.writeFileSync(file, '{not json');
  await assert.rejects(channel.ask({ message: 'x' }, deps(file, c)), { code: 'PERSON_CHANNEL_UNREADABLE', message: /move it aside/ });
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});

test('a notice is kept for the terminal, which says where the person sees it', () => {
  const file = tempFile();
  const c = clock();
  const result = channel.notify({ title: 'Build', message: 'The docs build finished.', durationSeconds: 99 }, { file, now: c.now, from: 'codex' });
  assert.deepEqual([result.posted, result.shown, result.noticeId, result.durationSeconds], [true, false, 'N1', 30]);
  assert.match(result.where, /toolsenabled watch/);
  assert.deepEqual(channel.read({ file, now: c.now }).notices.map((n) => [n.id, n.from, n.message]), [['N1', 'codex', 'The docs build finished.']]);
  assert.throws(() => channel.notify({ message: '' }, { file }), { code: 'PERSON_CHANNEL_TEXT_INVALID' });
});

test('the file is private to the sandbox user and the asker is named from the server\'s environment', async () => {
  const file = tempFile();
  const c = clock();
  await channel.ask({ message: 'Proceed?' }, deps(file, c));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(channel.askerFrom({ TOOLSENABLED_AGENT_ACTOR: 'codex', TOOLSENABLED_OPENSHELL_NODE: 'w2' }), 'codex (w2)');
  assert.equal(channel.askerFrom({}), 'an agent');
  assert.match(channel.NOT_A_BOUNDARY, /not a boundary/);
});

test('a rotated grant cannot collect an earlier instance answer with the same displayed identity', async () => {
  const file = tempFile(), c = clock();
  const old = deps(file, c, { from: 'gemini (worker)', scope: HASH_A });
  const rotated = deps(file, c, { from: 'gemini (worker)', scope: HASH_B });
  const args = { message: 'Proceed?', timeoutSeconds: 5 };
  const pending = await channel.ask(args, old);
  answerAtTerminal(file, c, pending.askId, 'approve', 'For that instance.');
  const other = await channel.ask(args, rotated);
  assert.equal(other.pending, true);
  assert.notEqual(other.askId, pending.askId);
  const answer = await channel.ask(args, old);
  assert.equal(answer.answer, 'yes');
  assert.equal(answer.note, 'For that instance.');
});
