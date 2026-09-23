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
