'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../tools/agent-contract');
const registry = require('../src/lib/tool-registry');
function advertisedGuide() {
  const tool = registry.listTools({ allowedToolNames: ['agent.spawn'] }).find(t => t.name === 'agent.spawn');
  assert.ok(tool, 'actual agent.spawn advertisement must exist');
  return tool.inputSchema.properties.contract.description;
}
function example(guide) {
  const match = /```text\n([\s\S]*?)\n```/.exec(guide);
  assert.ok(match, 'advertised guidance must contain a concrete complete form');
  return match[1];
}
test('actual advertised form passes the unchanged contract checker', () => {
  const guide = advertisedGuide(), form = example(guide);
  assert.match(guide, /Illustrative syntax only/);
  assert.match(guide, /never invent a measurement/);
  const fields = registry.validatedAgentContract(form);
  assert.deepEqual(Object.keys(fields), ['role', 'target', 'do', 'because', 'done', 'report']);
  assert.equal(fields.role, 'INVESTIGATOR');
});
test('expanded child brief delivers the same discoverable valid form even without an API sheet', () => {
  const guide = advertisedGuide();
  const fields = registry.validatedAgentContract(example(guide));
  for (const sheet of ['', 'agent.spawn(contract*,tier*) local-write']) {
    const brief = contract.expand(fields, sheet);
    assert.ok(brief.includes(guide));
    assert.match(brief, /only when delegation is authorized/);
    assert.deepEqual(registry.validatedAgentContract(example(brief)), fields);
    assert.ok(brief.length < 12000, 'illustrative complete brief fits the existing tree cap');
  }
  assert.ok(Buffer.byteLength(guide) <= 1500, 'discovery instructions have a deliberate bounded cost');
});
test('guidance does not weaken incomplete, unmeasured or subjective contracts', () => {
  const form = example(advertisedGuide());
  for (const invalid of [
    'ROLE: INVESTIGATOR\nInspect the failure.',
    form.replace('because The parent reports 2 refused spawn attempts.', 'because This is important.'),
    form.replace('done REPORT-child.md names inspected symbols, findings and verification commands.', 'done Everything works correctly.'),
    form.replace('target src/', 'target src/example.js:123'),
  ]) assert.throws(() => registry.validatedAgentContract(invalid), { code: 'AGENT_CONTRACT_INVALID' });
});
test('a because line that quotes the output it rests on is accepted, as the refusal says it is', () => {
  // Found in the real app (1.0.49 video/real-Claude walk, flow A): the refusal
  // says "Name a number, a failing check, or quoted output", and a Controller that
  // quoted the reply it wanted was refused six times running and gave up, because
  // the check accepted a digit or a keyword and never a quotation.
  for (const quoted of [
    'The person asked for a child that answers "KIWI".',
    'The person asked for a child that answers “KIWI”.',
    "The person asked for a child that answers 'KIWI'.",
    'The build log says `index is locked by another run`.',
  ]) assert.equal(contract.statesAMeasurement(quoted), true, quoted);
  for (const unquoted of [
    'This is important.',
    "The person's request is simple, and the child's reply is short.",
    'The person said " and stopped.',
    'It is "" empty.',
  ]) assert.equal(contract.statesAMeasurement(unquoted), false, unquoted);
  // And every other kind the sentence names is still accepted.
  assert.equal(contract.statesAMeasurement('2 workers were requested and 0 have answered.'), true);
  assert.equal(contract.statesAMeasurement('The smoke check reports FAIL.'), true);
});
test('a single lower-case word quoted as the reply counts; a scare-quoted adjective still does not', () => {
  // 1.0.50 release review, release-ops F6: the KIWI fix covered capitals only,
  // so "answers \"hello\"" was refused the way "answers \"KIWI\"" used to be.
  for (const quoted of [
    'The person asked for a child that answers "hello".',
    "The helper replies 'yes' when it is ready.",
    'The probe prints "pong" and exits.',
    'The expected output: "ok".',
    'The child should answer with \u201cready\u201d.',
    'It says back `done`.',
  ]) assert.equal(contract.statesAMeasurement(quoted), true, quoted);
  for (const scare of [
    'It is "slow".',
    "It looks 'off'.",
    'The answer is "fine" today.',
    'The reply was "good".',
  ]) assert.equal(contract.statesAMeasurement(scare), false, scare);
});
