// EXECUTABLE CHANGE
'use strict';
//
// TEST-CAN-FAIL REPORT (testcanfail-tests-purchase-request-tool-test-js)
//
// 2026-09-03 refusal-sentences update: the missing-merchant predicate below
// used to assert `/\$\.arguments\.items\[0\]\.merchant: is required/`, which
// PASSED against a bug -- tool-registry.js#executeTool validated every tool's
// flat arguments with schema-validator path root '$.arguments', so the
// refusal named a field ("$.arguments.items[0].merchant") that a caller of
// purchase.request, which takes items directly, never sent and has nothing
// shaped like to send. Fixed in src/lib/schema-validator.js (propertyPath's
// empty-base case) and src/lib/tool-registry.js (path: '' at the dispatch
// call site). The predicate now asserts the exact corrected message via
// strict equality, which is RED against the pre-fix code (it still had the
// prefix) and GREEN after -- a substring check for merely "items[0].merchant"
// would have stayed GREEN either way and proven nothing.
//
// Strengthened assertion and falsifier:
// - "missing merchant before any handler runs": removed `merchant` from the
//   purchase.request item's schema-required fields. Before this change, the
//   handler's own validation produced OWNER_PROMPT_MALFORMED and the broad
//   error-message predicate accepted it, leaving the test GREEN. The predicate
//   now requires the registry schema validator's name/code and the precise
//   missing-field path. Under the same mutation it is RED:
//     FAIL the request schema itself refuses a missing merchant before any
//     handler runs: The validation function is expected to return "true".
//     Received false
//     purchase-request-tool: 1 FAILED
//
// Other assertion falsifiers (all RED without test changes):
// - Changed purchase.request effect local-write -> local-read:
//     FAIL both purchase tools are registered with the right effects:
//     + 'local-read'
//     - 'local-write'
// - Bypassed ownerPublicPrompts.enqueue with a resolved sentinel:
//     FAIL a schema-valid batch still reaches the store validation: mixed
//     currencies are refused with the store error: Missing expected rejection.
// - Changed purchase.decision's absent-id state unknown -> pending:
//     FAIL purchase.decision reports unknown for a prompt id that never
//     existed, without throwing:
//     + 'pending'
//     - 'unknown'
//
// Shape census:
// - EMPTY LOOP: NOT-FOUND. `checks` receives four unconditional registrations;
//   its runner records every caught failure and exits non-zero when any fail.
// - EXIT STATUS / TRUTHY RETURN AS SOLE EVIDENCE: NOT-FOUND.
// - SWALLOWED FAILURE VIA TRY/CATCH OR OPTIONAL CHAIN: NOT-FOUND. The runner's
//   catch reports and counts failures; the error optional accesses only format
//   diagnostics and do not govern pass/fail.
// - MOCK OF SUBJECT UNDER TEST: NOT-FOUND.
// - SKIP OR PLATFORM PRECONDITION GUARD: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND; expectations are literals.
//
// Restoration evidence: src/lib/tool-registry.js and its exact backup both had
// SHA-256 29f8cb60e8bf36f3247a0e19599e4b9ab13f142916b644f0eb4a9221f611d86f.
// After restoration the run ended:
//     purchase-request-tool: 4 checks passed
// Preconditions: Node 22+ is required for node:sqlite. The shell-default Node
// 20 could not load it, so all reported mutation and restoration runs used the
// repository-compatible /root/.nvm/versions/node/v22.22.2/bin/node.
// Pins the agent-facing tool surface of the shopping list: purchase.request
// (enqueue a batch for in-app owner approval) and purchase.decision (read the
// settled or pending state). The store's own behavior is pinned by
// tests/owner-public-prompts.test.js and the bridge wiring by
// tests/owner-prompt-purchase-wiring.test.js; this file pins the third leg --
// that an agent can actually reach the store through the MCP registry, with
// the right effect flags and the store's validation intact behind the schema.
//
// The malformed-input probes below are chosen so the store refuses BEFORE its
// withLock state write (mixed currencies and item-shape errors are validated
// first, verified against owner-prompts.js), so this test never dirties the
// real state/owner-public-prompts.json.

const assert = require('node:assert');
const registry = require('./helpers/dispatch');

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

check('both purchase tools are registered with the right effects', () => {
  const request = registry.getTool('purchase.request');
  assert.strictEqual(request.effect, 'local-write');
  const decision = registry.getTool('purchase.decision');
  assert.strictEqual(decision.effect, 'local-read');
});

check('the request schema itself refuses a missing merchant before any handler runs, ' +
  'naming exactly the field this tool\'s own schema calls it and nothing this caller never sent', async () => {
  await assert.rejects(
    registry.executeTool('purchase.request', {
      title: 't', message: 'm',
      items: [{ id: 'a', description: 'd', amountCents: 100, currency: 'USD', purpose: 'p' }]
    }),
    error => error &&
      error.name === 'SchemaValidationError' &&
      error.code === 'INVALID_PARAMS' &&
      // Exact equality, not a substring match: purchase.request's caller sent
      // a flat { items: [...] } and has no field called "$.arguments" or
      // "arguments" to correct. A substring check for just "items[0].merchant"
      // would still pass with that internal envelope prefix left in front of
      // it, which is exactly the defect this pins against
      // (tool-registry.js#executeTool's assertValid call).
      error.message === 'Invalid input: items[0].merchant: is required'
  );
});

check('a schema-valid batch still reaches the store validation: mixed currencies are refused with the store error', async () => {
  await assert.rejects(
    registry.executeTool('purchase.request', {
      title: 'mixed currency probe', message: 'must be refused by the store, not the schema',
      items: [
        { id: 'a', description: 'd', amountCents: 100, currency: 'USD', merchant: 'x', purpose: 'p' },
        { id: 'b', description: 'd', amountCents: 100, currency: 'EUR', merchant: 'x', purpose: 'p' }
      ]
    }),
    error => (error && error.code === 'OWNER_PROMPT_MALFORMED') || /currency/i.test(String(error && error.message))
  );
});

check('purchase.decision reports unknown for a prompt id that never existed, without throwing', async () => {
  const result = await registry.executeTool('purchase.decision', { promptId: 'never-existed-0000' });
  assert.strictEqual(result.state, 'unknown');
  assert.strictEqual(result.settled, null);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      process.stdout.write(`  ok  ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}: ${error && error.message}\n`);
    }
  }
  if (failed > 0) { process.stdout.write(`purchase-request-tool: ${failed} FAILED\n`); process.exit(1); }
  process.stdout.write(`purchase-request-tool: ${checks.length} checks passed\n`);
})();
