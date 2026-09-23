'use strict';

/* Cut gate R1199, the person's words: "also codex launched astra6. make sure we
 * support that model before you cut".
 *
 * The exact id and its efforts are MEASURED, not assumed: they come from
 * `model/list` on the installed codex-cli 0.153.4, captured in the working
 * folder's CODEX-MODEL-CATALOG-20260907.json
 * (measuredAt 2026-09-07T13:33:58.032Z): id `gpt-6-astra`, displayName
 * `GPT-6-Astra`, efforts low/medium/high/xhigh/max/ultra, catalog default
 * `medium`.
 *
 * Owner K3 reverses the stale HIGH ruling: the product's default effort for
 * this tier is `medium` -- "default should be medium thats what codex does and
 * we are using their model". That product decision is pinned here by value
 * rather than left to drift.
 *
 * WHY THESE ASSERTIONS AND NOT A TABLE COMPARISON: a tier is only "supported"
 * if a real lane can be dispatched on it. Declaring a row in TIERS while the
 * shipped org has no seat, or no reporting line, produces a tier the menu
 * offers and dispatch refuses -- which is the exact failure mode this product
 * has paid for before ("a crippled lane that still looks perfectly alive").
 * So these call the real functions with real values.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-astra-test-'));
require('./lib/isolated-environment').configure(testRoot);
require('./lib/agent-api-mode-fixture').selectAgentApiMode('Enabled');

const actions = require('../src/lib/mission-bridge/actions');
const agentOrg = require('../src/lib/agent-org');
const observer = require('../src/lib/agent-session-observer');
const registry = require('../src/lib/tool-registry');

const ASTRA_ID = 'gpt-6-astra';
const ASTRA_EFFORT = 'medium';
const KEPT_TIERS = ['luna', 'terra', 'sol'];
/* No seat is busy, so allocation cannot fail for a capacity reason and a
   refusal can only mean the declaration itself is wrong. */
const FREE_SEATS = { readRegistry: () => ({ agents: {} }) };
const FULL_SESSION = { origin: 'local', tier: 'full' };

function shippedOrg() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  return agentOrg.normalizeOrg(raw);
}

test('a real lane can be dispatched on astra from the shipped org declaration', () => {
  const lane = actions.declaredLane(shippedOrg(), 'astra', FREE_SEATS);
  assert.equal(lane.provider, 'codex');
  assert.equal(lane.model, ASTRA_ID);
  assert.equal(lane.cliModel, ASTRA_ID);
  assert.equal(lane.effort, ASTRA_EFFORT);
  assert.equal(lane.targetAgentId, 'astra');
  // A codex tier has NO controller fallback in declaredLane, so a seat without
  // an explicit `manages` edge is undispatchable however well-formed the row is.
  assert.ok(lane.reportsTo, 'the astra seat has no manager, so no lane can start on it');
});

test('the argv a real astra child process receives names the model and the effort', () => {
  const args = actions.codexArgs({ root: testRoot, tier: actions.TIERS.astra, permissionSession: FULL_SESSION });
  const modelAt = args.indexOf('--model');
  assert.ok(modelAt >= 0, 'the codex argv carries no --model flag at all');
  assert.equal(args[modelAt + 1], ASTRA_ID);
  assert.ok(args.includes(`model_reasoning_effort=${ASTRA_EFFORT}`),
    `the argv does not set the effort: ${args.join(' ')}`);
});

test('the three existing Codex tiers still dispatch unchanged', () => {
  const org = shippedOrg();
  const expected = { luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol' };
  const expectedEffort = { luna: 'medium', terra: 'high', sol: 'xhigh' };
  for (const name of KEPT_TIERS) {
    const lane = actions.declaredLane(org, name, FREE_SEATS);
    assert.equal(lane.model, expected[name], `tier ${name} no longer resolves to its own model`);
    assert.equal(lane.provider, 'codex');
    assert.equal(lane.effort, expectedEffort[name], `tier ${name}'s explicit effort changed`);
  }
});

test('astra is offered vocabulary when an unknown tier name is refused', () => {
  assert.throws(
    () => actions.declaredLane(shippedOrg(), 'no-such-tier', FREE_SEATS),
    error => error.message.includes('astra'),
    'the refusal lists the valid tiers but does not offer astra');
});

test('an agent can spawn a circle on astra', () => {
  const entry = registry.getTool('agent.spawn');
  const offered = entry.inputSchema.properties.tier.enum;
  assert.ok(offered.includes('astra'), 'agent.spawn refuses astra, so no agent can start one');
  for (const kept of KEPT_TIERS) {
    assert.ok(offered.includes(kept), `spawning lost the ${kept} tier`);
  }
});

/* DELIBERATE, AND PINNED SO NOBODY "FIXES" IT INTO A GUESS.
 *
 * This module's own doctrine is that the cheap/standard/premium COST tier is
 * reported only where the repo holds a recorded rate card for that exact model
 * id, and that "ordering model names by assumed price would be a guess, and a
 * guessed tier is exactly the defect this observer exists to prevent". No rate
 * card for gpt-6-astra has been published or measured, so its cost bucket is
 * unknown WITH a stated reason -- not `premium` because it sounds expensive.
 *
 * The visible consequence, stated in the report: the DEFAULT tier's cost bucket
 * reads unknown until someone records astra's rate card. That is honest and it
 * is the design's intent.
 */
test('astra reports an unknown cost tier with a reason, never a guessed one', () => {
  const resolved = observer.costTierForModel('codex', ASTRA_ID);
  assert.equal(resolved.costTier, 'unknown');
  assert.equal(resolved.costTierSource, null);
  assert.ok(typeof resolved.costTierReason === 'string' && resolved.costTierReason.length > 0,
    'an unknown cost tier must say why it is unknown');
  // the priced tiers are untouched by that decision
  assert.equal(observer.costTierForModel('codex', 'gpt-5.6-luna').costTier, 'cheap');
  assert.equal(observer.costTierForModel('codex', 'gpt-5.6-sol').costTier, 'premium');
});
