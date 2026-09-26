'use strict';
require('./lib/isolated-environment').activate('approval-prompt-completeness');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const desktop = require('../src/lib/desktop');
const approvals = require('../src/lib/approvals');
const audit = require('../src/lib/audit');

// Run the maintained formatter and grant-request boundary. The native dialog
// is the only substituted effect; a refused preview must never reach a grant.
const source = fs.readFileSync(require.resolve('../src/lib/tool-registry'), 'utf8');
const start = source.indexOf('function approvalPreview('), end = source.indexOf('async function systemAsk(');
assert.ok(start >= 0 && end > start);
function harness() {
  const calls = [];
  const context = vm.createContext({ audit, approvals, desktop: () => ({ MAX_ASK_MESSAGE: desktop.MAX_ASK_MESSAGE,
    ask: async args => { calls.push(args); return { answer: 'no' }; } }),
    getStateStore: () => { throw new Error('A refused dialog must not mint approval'); } });
  vm.runInContext(source.slice(start, end), context);
  return { calls, preview: value => context.approvalPreview(value), request: value => context.requestLegacyApproval(value) };
}

test('a long exact-action preview reaches the prompt intact instead of falling back to only an action name', async () => {
  const h = harness(), args = { command: 'safe fixture context '.repeat(250) + 'LAST ARGUMENT', timeoutMs: 1000 };
  const preview = h.preview(args);
  assert.deepEqual(JSON.parse(preview), args);
  assert.ok(preview.length > 4000);
  const message = 'Approve one execution of host.exec with these exact arguments?\n\n' + preview;
  const result = await h.request({ action: 'host.exec', inputHash: 'a'.repeat(64), message });
  assert.equal(result.approved, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].message, message);
  assert.match(h.calls[0].message, /LAST ARGUMENT/);
});

test('unrenderable, missing and oversized descriptions refuse before a prompt or grant', async () => {
  const h = harness();
  assert.throws(() => h.preview({ command: 'x'.repeat(desktop.MAX_ASK_MESSAGE) }), { code: 'APPROVAL_PROMPT_TOO_LARGE' });
  for (const message of [undefined, '', ' ', 'x'.repeat(desktop.MAX_ASK_MESSAGE + 1)]) {
    await assert.rejects(h.request({ action: 'host.exec', inputHash: 'b'.repeat(64), message }), { code: 'APPROVAL_PROMPT_INVALID' });
  }
  assert.equal(h.calls.length, 0);
});

test('the preview still redacts secret fields without dropping the nonsecret target', () => {
  const h = harness(), preview = h.preview({ target: 'fixture-target', password: 'fixture-secret-value' });
  assert.doesNotMatch(preview, /fixture-secret-value/);
  assert.match(preview, /fixture-target/);
});

test('confirmation refuses omitted fields, list entries and deep structures while ordinary audit limits remain unchanged', () => {
  const h = harness();
  assert.throws(() => h.preview({ targets: Array.from({ length: 101 }, (_, i) => i) }), { code: 'APPROVAL_PROMPT_TOO_LARGE' });
  assert.throws(() => h.preview(Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['field' + i, i]))), { code: 'APPROVAL_PROMPT_TOO_LARGE' });
  let deep = 'last'; for (let i = 0; i < 14; i++) deep = { nested: deep };
  assert.throws(() => h.preview(deep), { code: 'APPROVAL_PROMPT_TOO_LARGE' });
  assert.equal(audit.scrub('x'.repeat(5000)).length, 4000);
  assert.equal(audit.scrub(Array.from({ length: 101 }, (_, i) => i)).length, 100);
  assert.match(JSON.stringify(audit.scrub(deep)), /TRUNCATED_DEPTH/);
});
