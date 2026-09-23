/*
 * Mutation check: changed DEFAULT_TIMEOUT_MS from 20_000 to 19_999 in the module.
 * The edit landed (the mutated declaration was printed and verified).
 * This isolated test file went red with exit code 1 on its default-timeout assertion.
 */

'use strict';

const assert = require('node:assert/strict');
const approval = require('../../src/lib/providers/duo-desktop-approval');

function hasCode(code) {
  return error => error && error.code === code;
}

(async () => {
  assert.equal(approval.requireTimeout(undefined), 20_000);
  assert.equal(approval.requireTimeout(1_000), 1_000);
  assert.equal(approval.requireTimeout(30_000), 30_000);
  for (const invalid of [999, 30_001, 1_000.5, '1000', NaN]) {
    assert.throws(
      () => approval.requireTimeout(invalid),
      hasCode('DUO_DESKTOP_APPROVAL_TIMEOUT_INVALID'),
      `timeout ${String(invalid)} must be rejected`
    );
  }

  const parsedInvocation = approval.parseResult('{"status":"invoked"}');
  assert.deepEqual(parsedInvocation, { status: 'invoked', invoked: true });
  for (const status of ['not_found', 'ambiguous', 'unavailable', 'invoke_failed']) {
    assert.deepEqual(approval.parseResult(JSON.stringify({ status })), { status, invoked: false });
  }
  for (const invalid of [
    '', 'not JSON', 'null', '[]', '{}', '{"status":"unknown"}',
    '{"status":"invoked","detail":"must not escape"}'
  ]) {
    assert.throws(
      () => approval.parseResult(invalid),
      hasCode('DUO_DESKTOP_APPROVAL_RESULT_INVALID'),
      `helper result ${invalid} must be rejected`
    );
  }
  assert.ok(Object.isFrozen(parsedInvocation));

  const calls = [];
  const result = await approval.approveExactPendingPrompt({ timeoutMs: 1_234 }, {
    runApproval: async input => {
      calls.push({ kind: 'helper', input });
      return { ok: true, stdout: '{"status":"invoked"}' };
    },
    audit: {
      record(action, target, details) {
        calls.push({ kind: 'audit', action, target, details });
      }
    }
  });
  assert.deepEqual(calls, [
    { kind: 'helper', input: { timeoutMs: 1_234 } },
    {
      kind: 'audit',
      action: 'duo.desktop_approval_attempt',
      target: 'local-duo-desktop',
      details: {
        status: 'invoked',
        invoked: true,
        scope: 'exact_live_ucr_duo_desktop_prompt'
      }
    }
  ]);
  assert.deepEqual(result, calls[1].details);
  assert.ok(Object.isFrozen(result));

  await assert.rejects(
    approval.approveExactPendingPrompt({ timeoutMs: 1_000 }, {
      runApproval: async () => ({ ok: false, stdout: '{"status":"invoked"}' })
    }),
    hasCode('DUO_DESKTOP_APPROVAL_UNAVAILABLE')
  );
  await assert.rejects(
    approval.approveExactPendingPrompt({ unexpected: true }, {
      runApproval: async () => { throw new Error('must not execute'); }
    }),
    error => error && /exact approval input/i.test(error.message)
  );

  process.stdout.write('duo-desktop-approval behavior tests passed\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
