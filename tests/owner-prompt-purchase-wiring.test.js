'use strict';
// End-to-end: an owner purchase decision, made through the REAL
// createMissionActions() dispatch path (not the recording module in
// isolation), reaches the capped spend ledger with a durable receipt --
// and a denied line never does.
//
// tests/purchase-recording.test.js already proves the recording module's
// internal contract. This file proves the WIRING: that ownerPromptDecision in
// src/lib/mission-bridge/actions.js actually calls it, with the actions
// module's real audit and prompt-store plumbing in the loop, not a
// hand-constructed call.

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createMissionActions } = require('../src/lib/mission-bridge/actions.js');
const ownerPrompts = require('../src/lib/mission-bridge/owner-prompts.js');

let passed = 0;
const failures = [];
// ASYNC, BECAUSE EVERY DISPATCHED ACTION NOW IS. src/lib/mission-bridge/actions.js
// wraps every method createMissionActions() exposes -- ownerPromptDecision
// included -- in `async (...args) => { guard(actionName); return action(...args) }`
// (see its own comment: "Every action is asynchronous to its caller"). A `check`
// that called an unawaited fn() used to report each assertion against a bare
// Promise object rather than the `{ok, recording, ...}` it resolves to --
// `response.ok` read `undefined` on a Promise, not the `true` the real dispatch
// path actually returns, so every check below failed on a symptom two layers
// removed from anything this file was written to prove.
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function auditFixture() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      const sequence = events.length + 1;
      const event = { action, target, details, sequence };
      event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
      events.push(event);
      return { durable: true, anchored: true, sequence, eventHash: event.eventHash };
    }
  };
}

function fakePay({ dailyLimitCents = 1_000_000 } = {}) {
  const ledger = [];
  return {
    check() { return { allowed: true }; },
    recordSpend({ amountUsd, purpose, provider, reference }) {
      const amountCents = Math.round(amountUsd * 100);
      const existing = ledger.find(e => e.provider === provider && e.reference === reference);
      if (existing) return { allowed: true, replayed: true, entry: existing };
      const spent = ledger.reduce((sum, e) => sum + e.amountCents, 0);
      if (spent + amountCents > dailyLimitCents) {
        const error = new Error('cap'); error.code = 'SPEND_LIMIT_EXCEEDED'; throw error;
      }
      const entry = { id: `e${ledger.length + 1}`, amountCents, purpose, provider, reference };
      ledger.push(entry);
      return { allowed: true, replayed: false, entry };
    },
    ledger
  };
}

function tempPromptDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-prompts-'));
  return { stateFile: path.join(dir, 'p.json') };
}

function buildActions({ dailyLimitCents } = {}) {
  const audit = auditFixture();
  const pay = fakePay({ dailyLimitCents });
  const ownerPromptDependencies = tempPromptDeps();
  // createMissionActions requires at least one declared worktree root even
  // though none of these checks dispatch a lane; an empty temp dir satisfies
  // that without pulling in a real repository fixture.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-root-'));
  const actions = createMissionActions({
    roots: { primary: root },
    audit,
    policy: { assertActive() {} },
    ownerPromptDependencies,
    purchaseRecordingDependencies: { pay, payDependencies: {} },
    // THE MISSING PRINCIPAL, AND THE WHOLE REASON THIS FILE STOOD RED.
    //
    // server.js refuses ownerPromptPresented/ownerPromptDecision outright for
    // any principal.kind other than 'owner-ui' (BRIDGE_OWNER_UI_REQUIRED), and
    // its real ownerActions is built exactly once, at server construction,
    // with `principal: Object.freeze({ kind: 'owner-ui' })` -- see
    // createMissionBridgeServer(). Without it here, createMissionActions()
    // took the OTHER branch (options.principal is undefined, so ownerUi is
    // false) and called authorizeMissionAgentInOrg(undefined, ...), which
    // refuses BRIDGE_ACTOR_REFUSED before ownerPromptDecision is ever reached
    // -- for every check in this file, on every run, regardless of the queue,
    // the ledger, or the account-fence path this file exists to prove wired.
    //
    // This is not what a real owner decision does: the owner never carries an
    // agent id an org can declare, and was never meant to need one. Matching
    // the server's own construction is what makes this an end-to-end proof of
    // the WIRING rather than a proof of an owner that cannot exist.
    principal: Object.freeze({ kind: 'owner-ui' })
  });
  return { actions, audit, pay, ownerPromptDependencies };
}

const PURCHASE = () => ({
  kind: 'purchase_batch', title: 'Review this shopping list', message: 'm', ttlMs: null,
  items: [
    { id: 'dom-ai', description: 'toolsenabled.ai domain', amountCents: 7999, currency: 'USD', merchant: 'Namecheap', purpose: 'Primary domain' },
    { id: 'dom-io', description: 'toolsenabled.io domain', amountCents: 3499, currency: 'USD', merchant: 'Namecheap', purpose: 'Redirect domain' }
  ]
});

// TOP-LEVEL AWAIT, RUN THROUGH AN IIFE: this file is CommonJS (`require`, not
// `import`), which has no top-level await, and the checks must still run in
// their written order with the summary printed only once every one of them has
// actually settled -- not after each has merely been started.
(async () => {

console.log('owner prompt purchase wiring');

await check('a decision made through the real actions.ownerPromptDecision reaches the ledger', async () => {
  const { actions, pay, ownerPromptDependencies } = buildActions();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), ownerPromptDependencies);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, ownerPromptDependencies);
  const response = await actions.ownerPromptDecision({
    promptId, decision: 'submit', itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }]
  });
  assert.strictEqual(response.ok, true);
  assert.ok(response.recording, 'a purchase_batch decision must carry a recording outcome');
  assert.strictEqual(response.recording.recordedCount, 1);
  assert.strictEqual(response.recording.deniedCount, 1);
  assert.strictEqual(pay.ledger.length, 1, 'exactly the approved line must reach the real ledger');
  assert.strictEqual(pay.ledger[0].amountCents, 7999);
});

await check('a non-purchase decision (confirmation) carries no recording field at all', async () => {
  const { actions, pay, ownerPromptDependencies } = buildActions();
  const { promptId } = ownerPrompts.enqueue({ kind: 'confirmation', title: 't', message: 'm', ttlMs: null }, ownerPromptDependencies);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, ownerPromptDependencies);
  const response = await actions.ownerPromptDecision({ promptId, decision: 'approve' });
  assert.strictEqual(response.ok, true);
  assert.strictEqual('recording' in response, false, 'a non-purchase decision must never touch the spend ledger');
  assert.strictEqual(pay.ledger.length, 0);
});

await check('the owner decision is durably recorded even if the spend ledger then refuses it', async () => {
  // Set the cap below the first item so recording refuses -- the decision
  // itself (what the owner actually chose) must still be truthfully returned
  // and durably committed; a ledger failure must not look like a lost vote.
  const { actions, ownerPromptDependencies } = buildActions({ dailyLimitCents: 100 });
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), ownerPromptDependencies);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, ownerPromptDependencies);
  const response = await actions.ownerPromptDecision({
    promptId, decision: 'submit', itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }]
  });
  assert.strictEqual(response.ok, true, 'the decision endpoint itself must still report success -- the VOTE was recorded');
  assert.strictEqual(response.recording.recordedCount, 0);
  assert.strictEqual(response.recording.refusedCount, 1);
  assert.strictEqual(response.recording.items[0].refusalCode, 'SPEND_LIMIT_EXCEEDED');
  // And the decision is durably readable back, independent of the ledger outcome.
  const settled = ownerPrompts.settledDecision(promptId, ownerPromptDependencies);
  assert.strictEqual(settled.decision.approvedCount, 1, 'the owner decision itself is unaffected by a ledger refusal');
});

await check('a durable audit receipt is written for the decision', async () => {
  const { actions, audit, ownerPromptDependencies } = buildActions();
  const { promptId } = ownerPrompts.enqueue(PURCHASE(), ownerPromptDependencies);
  ownerPrompts.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, ownerPromptDependencies);
  await actions.ownerPromptDecision({ promptId, decision: 'submit', itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }] });
  assert.ok(audit.events.some(e => e.action === 'owner-prompt.decision.intent'), 'an intent receipt must be written before the mutation');
  assert.ok(audit.events.some(e => e.action === 'owner-prompt.decision'), 'an outcome receipt must be written for the decision');
});

console.log('');
if (failures.length) {
  console.log(`owner-prompt-purchase-wiring: ${failures.length} FAILED, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`owner-prompt-purchase-wiring: ${passed} checks passed`);
}

})();
