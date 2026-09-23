// EXECUTABLE CHANGE — two exit-code-only checks now verify the CLI's own diagnostics.
//
// Mutation evidence:
// - Replaced executorPayloadHash()'s invalid-digest diagnostic with
//   "MUTANT accepted wrong invalid-hash path". Before strengthening, this file
//   stayed green. Afterwards it failed with:
//   "Expected input to match /...lowercase SHA-256 digest.../. Input:\n\n'MUTANT accepted wrong invalid-hash path...".
// - Replaced scopeRules()'s malformed-JSON diagnostic with
//   "MUTANT accepted wrong malformed-rule path". Before strengthening, this
//   file stayed green. Afterwards it failed with:
//   "Expected input to match /...scope-rule #1 must be valid JSON.../. Input:\n\n'MUTANT accepted wrong malformed-rule path...".
// - The product file was restored byte-for-byte (SHA-256
//   3d23a7779a60033e0156d1f03e63c995546835918deff2a962b6f10911f6f8f8),
//   then `node --test tests/spawn-record.js` passed all five tests.
// Census: empty iteration NOT-FOUND; swallowed failure NOT-FOUND; subject mock
// NOT-FOUND; platform skip/precondition guard NOT-FOUND; same-code expected
// value NOT-FOUND. No precondition was unmet.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { main, parseArgs } = require('../tools/spawn-record');

const HASH = 'a'.repeat(64);

test('CLI accepts and forwards a canonical executor payload hash without using the live audit', () => {
  let captured = null;
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const exitCode = main([
      '--actor', 'codex', '--agent', 'luna', '--phase', 'Q66', '--model', 'gpt-5.6-luna',
      '--executor-payload-hash', HASH
    ], {
      createLaunch(request) {
        captured = request;
        return { launchId: 'launch_test', record: {}, auditSequence: 1, auditEventHash: 'b'.repeat(64) };
      }
    });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(captured.executorPayloadHash, HASH);
});

test('CLI rejects unknown, missing, and invalid executor payload hash flags deterministically', () => {
  assert.throws(() => parseArgs(['--unknown', 'value']), /unknown flag "--unknown"/);
  assert.throws(() => parseArgs(['--executor-payload-hash']), /--executor-payload-hash needs a value/);
  let errorOutput = '';
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => { errorOutput += chunk; return true; };
  try {
    assert.equal(main([
      '--actor', 'codex', '--agent', 'luna', '--phase', 'Q66', '--model', 'gpt-5.6-luna',
      '--executor-payload-hash', 'A'.repeat(64)
    ]), 2);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(errorOutput, /^--executor-payload-hash must be a lowercase SHA-256 digest\n\nRecord a spawn/);
});

test('CLI forwards exact thread scope inputs without manufacturing disabled-target authority', () => {
  let captured = null;
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const exitCode = main([
      '--actor', 'codex', '--agent', 'sol', '--phase', 'Q66', '--model', 'gpt-5.6-sol', '--tier', 'premium',
      '--thread-id', 'sol-r1065-thread', '--scope-store-revision', '12'
    ], {
      createLaunch(request) {
        captured = request;
        return { launchId: 'launch_scope_test', record: {}, auditSequence: 1, auditEventHash: 'b'.repeat(64) };
      }
    });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(captured.threadId, 'sol-r1065-thread');
  assert.equal(captured.scopeStoreRevision, 12);
  assert.equal(Object.hasOwn(captured, 'scopeRules'), false);
});

test('CLI accepts repeatable contextual scope rules but rejects malformed rule JSON', () => {
  let captured = null;
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const exitCode = main([
      '--actor', 'codex', '--agent', 'luna', '--phase', 'Q66', '--model', 'gpt-5.6-luna',
      '--thread-id', 'thread-a',
      '--scope-rule', '{"ruleId":"rule_one"}',
      '--scope-rule', '{"ruleId":"rule_two"}'
    ], {
      createLaunch(request) {
        captured = request;
        return { launchId: 'launch_scope_rules', record: {}, auditSequence: 1, auditEventHash: 'b'.repeat(64) };
      }
    });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(captured.scopeRules, [{ ruleId: 'rule_one' }, { ruleId: 'rule_two' }]);

  let errorOutput = '';
  const originalError = process.stderr.write;
  process.stderr.write = chunk => { errorOutput += chunk; return true; };
  try {
    assert.equal(main([
      '--actor', 'codex', '--agent', 'luna', '--phase', 'Q66', '--model', 'gpt-5.6-luna',
      '--scope-rule', '{not-json'
    ]), 2);
  } finally {
    process.stderr.write = originalError;
  }
  assert.match(errorOutput, /^--scope-rule #1 must be valid JSON\n\nRecord a spawn/);
});

test('JSON launch output forwards the non-authorizing dispatch brief', () => {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = chunk => { output += chunk; return true; };
  try {
    const exitCode = main([
      '--actor', 'codex', '--agent', 'luna', '--phase', 'Q64', '--model', 'gpt-5.6-luna', '--json'
    ], {
      createLaunch() {
        return {
          launchId: 'launch_brief_forwarding',
          record: {},
          dispatchBrief: {
            schemaVersion: 1,
            launchId: 'launch_brief_forwarding',
            agentId: 'luna',
            objectiveRef: 'Q64',
            scopePacket: { grantsAuthority: false, appliedRuleIds: ['rule_scope_brief'] },
            informational: true,
            grantsAuthority: false
          },
          auditSequence: 1,
          auditEventHash: 'b'.repeat(64)
        };
      }
    });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  const emitted = JSON.parse(output);
  assert.equal(emitted.dispatchBrief.informational, true);
  assert.equal(emitted.dispatchBrief.grantsAuthority, false);
  assert.equal(emitted.dispatchBrief.scopePacket.grantsAuthority, false);
  assert.deepEqual(emitted.dispatchBrief.scopePacket.appliedRuleIds, ['rule_scope_brief']);
});
