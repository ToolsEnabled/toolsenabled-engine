'use strict';

// The terminal Approvals page (src/lib/openshell-approvals-page.js): what the
// person reads, what they can answer, and the rules it states.

require('./lib/isolated-environment').activate('openshell-approvals-page');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const page = require('../src/lib/openshell-approvals-page');
const channel = require('../src/lib/openshell-person-channel');

const RULES = () => [['One-time approvals', 'off: outward actions run without asking you', 'turn on: toolsenabled settings set agent.tool_approvals true']];

function withChannel() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-page-')), 'channel.json');
  const channelDependencies = { file, sleep: async () => {}, from: 'codex' };
  return { file, channelDependencies, dependencies: { channelDependencies, rules: RULES } };
}

function collect(argv, dependencies) {
  const lines = [];
  return page.command(argv, { out: (line) => lines.push(line) }, dependencies).then((code) => ({ code, lines, text: lines.join('\n') }));
}

test('the page shows a waiting question in full, marks it shown, and ends with the boundary sentence', async () => {
  const { channelDependencies, dependencies } = withChannel();
  await channel.ask({ title: 'Approve standin.send', message: 'Approve one execution?\n\n{"to": "team"}', action: 'standin.send', inputHash: 'c'.repeat(64), timeoutSeconds: 5 }, channelDependencies);
  const { text, lines } = await collect(['approvals'], dependencies);
  assert.match(text, /Q1 {2}one-time approval for standin\.send {2}from codex {2}asked \d+ s ago/);
  assert.match(text, /\{"to": "team"\}/);
  assert.match(text, /turn on: toolsenabled settings set agent\.tool_approvals true/);
  assert.equal(lines.at(-1), page.NOT_A_BOUNDARY);
  assert.ok(channel.read(channelDependencies).asks[0].shownAt);
});

test('approve and deny answer through the channel and say what the agent gets', async () => {
  const { channelDependencies, dependencies } = withChannel();
  await channel.ask({ message: 'May I deploy?', timeoutSeconds: 5 }, channelDependencies);
  await channel.ask({ message: 'May I post?', timeoutSeconds: 5 }, channelDependencies);
  await collect(['approvals'], dependencies);
  assert.match((await collect(['approvals', 'approve', 'Q1', 'after', 'lunch'], dependencies)).text, /^Q1 answered yes, with your words: after lunch\. codex gets the answer when it asks again\.$/);
  assert.match((await collect(['approvals', 'deny', 'Q2', 'Not', 'this', 'week.'], dependencies)).text, /^Q2 denied\. codex is told, when it asks again: Not this week\.$/);
  const listed = (await collect(['approvals'], dependencies)).text;
  assert.match(listed, /Nothing is waiting for you\./);
  assert.match(listed, /Q1 {2}approved {2}question {2}from codex: after lunch/);
  assert.match(listed, /Q2 {2}denied {2}question {2}from codex: Not this week\./);
});

test('bad ids, missing reasons and unknown words are refused before anything changes', async () => {
  const { dependencies } = withChannel();
  await assert.rejects(collect(['approvals', 'approve'], dependencies), { code: 'APPROVALS_PAGE_USAGE' });
  await assert.rejects(collect(['approvals', 'approve', 'P2'], dependencies), { code: 'APPROVALS_PAGE_ID_INVALID' });
  await assert.rejects(collect(['approvals', 'deny', 'Q1'], dependencies), { code: 'PERSON_CHANNEL_REASON_REQUIRED' });
  await assert.rejects(collect(['approvals', 'maybe', 'Q1'], dependencies), { code: 'APPROVALS_PAGE_USAGE' });
  await assert.rejects(collect(['approvals', '--everything'], dependencies), { code: 'APPROVALS_PAGE_USAGE' });
  await assert.rejects(collect(['watch', 'now'], dependencies), { code: 'APPROVALS_PAGE_USAGE' });
  assert.equal((await collect(['approvals', 'help'], dependencies)).lines.length, page.USAGE.length);
});

test('watch prints each new question and notice once, marks questions shown, and reports answers', async () => {
  const { channelDependencies, dependencies } = withChannel();
  await channel.ask({ message: 'May I deploy?', timeoutSeconds: 5 }, channelDependencies);
  channel.notify({ title: 'Build', message: 'Finished.' }, channelDependencies);
  const lines = [];
  let passes = 0;
  const controller = new AbortController();
  const sleep = async () => {
    passes += 1;
    if (passes === 1) {
      channel.decide({ id: 'Q1', decision: 'approve' }, channelDependencies);
      await channel.ask({ message: 'May I post?', timeoutSeconds: 5 }, channelDependencies);
    } else controller.abort();
  };
  await page.watch({ out: (line) => lines.push(line), signal: controller.signal }, { ...dependencies, sleep });
  const text = lines.join('\n');
  assert.equal(text.match(/May I deploy\?/g).length, 1);
  assert.equal(text.match(/notice N1 .* Build: Finished\./g).length, 1);
  assert.match(text, /Q1 {2}approved {2}question/);
  assert.match(text, /May I post\?/);
  assert.equal(lines[1], page.NOT_A_BOUNDARY);
  assert.ok(channel.read(channelDependencies).asks.every((ask) => ask.shownAt));
});

test('setup names the question pages and no spend cap or permission grant', () => {
  assert.match(page.setupLines().join(' '), /toolsenabled approvals.*toolsenabled watch/);
  const rules = JSON.stringify(page.rulesInForce());
  assert.match(rules, /do not change tool or agent permissions/);
  assert.doesNotMatch(rules, /spend|purchase/i);
});

test('question and notice controls are displayed literally without executing terminal sequences', async () => {
  const { channelDependencies, dependencies } = withChannel();
  let now = Date.now();
  Object.assign(channelDependencies, { now: () => now, sleep: async () => { now += 1000; } });
  await channel.ask({ message: 'Question\u001b[2J', timeoutSeconds: 5 }, channelDependencies);
  channel.notify({ title: 'Build', message: 'Notice\u001b]0;spoof\u0007' }, channelDependencies);
  const listed = await collect(['approvals'], dependencies);
  assert.doesNotMatch(listed.text, /\u001b|\u0007/);
  assert.match(listed.text, /Question\\u001b\[2J/);
  const watched = await collect(['watch', '--once'], dependencies);
  assert.doesNotMatch(watched.text, /\u001b|\u0007/);
  assert.match(watched.text, /Notice\\u001b/);
});
