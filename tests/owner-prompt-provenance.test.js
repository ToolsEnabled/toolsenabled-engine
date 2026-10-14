// EXECUTABLE CHANGE
//
// Discrimination audit (2026-08-26): exported limits/stamps were previously
// used to compute their own expectations. Mutating MAX_ITEM_DESCRIPTION to
// 301, PROVENANCE_STAMP_RESERVE to 65, MAX_OWNER_REQUEST_IDS to 9, and
// UNPROVENANCED_STAMP to a semantically different string left the original
// suite GREEN: "11 passed, 0 failed". Each mutation is now independently RED:
//   MAX_ITEM_DESCRIPTION: "301 !== 300"
//   PROVENANCE_STAMP_RESERVE: "65 !== 64"
//   MAX_OWNER_REQUEST_IDS: "9 !== 8"
//   UNPROVENANCED_STAMP:
//     "+ '[AGENT-PROPOSED - not traceable to your words; MUTANT] '"
//     "- '[AGENT-PROPOSED - not traceable to your words] '"
// Each reports "FAIL the provenance wire constants retain their renderer
// contract" and "11 passed, 1 failed".
// The source was then restored byte-for-byte and this file returned GREEN:
// "12 passed, 0 failed".
//
// NOT-FOUND: empty data-dependent assertion loops; exit-status/truthy-return
// assertions; swallowed failures via try/catch or optional chaining; mocks of
// the subject; file-level skips/platform guards.  The fixed same-code expected
// values were the only measured suspect shape.  Preconditions: all met.
'use strict';
// A PURCHASE LINE MUST SAY WHOSE IDEA IT WAS.
//
// The owner, 2026-08-11 (reports/OWNER-REQUEST-LEDGER.json R1233, verbatim):
//   "Again - i think thats not the correct cart, I think maybe R is not working
//    or something is going wrong because I have said a lot of times what I want"
//
// The live cart 0e33e84f carried four lines whose keys are exactly
// [id,description,amountCents,currency,merchant,purpose]. There was no field in
// which "this line comes from R1233" could have been written, so a cart a lane
// assembled from its own research was indistinguishable, on screen, from a cart
// built out of his words. Three earlier carts were built the same way by three
// lanes that never saw each other.
//
// These checks pin the fix at the only place every cart must pass through: the
// store. They also pin the two things that could quietly undo it -- the wire
// key set (a seventh key blanks wt-installer's popup) and the description cap
// (an overflowing stamp would do the same).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/lib/mission-bridge/owner-prompts.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function tempDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-provenance-'));
  return { stateFile: path.join(dir, 'prompts.json') };
}

const WIRE_ITEM_KEYS = ['amountCents', 'currency', 'description', 'id', 'merchant', 'purpose'];

check('the provenance wire constants retain their renderer contract', () => {
  assert.strictEqual(store.MAX_ITEM_DESCRIPTION, 300);
  assert.strictEqual(store.PROVENANCE_STAMP_RESERVE, 64);
  assert.strictEqual(store.MAX_OWNER_REQUEST_IDS, 8);
  assert.strictEqual(store.UNPROVENANCED_STAMP, '[AGENT-PROPOSED - not traceable to your words] ');
});

function batch(items) {
  return {
    kind: 'purchase_batch',
    title: 'Launch purchases',
    message: 'Each line is decided independently. Undecided lines are denied.',
    ttlMs: null,
    items
  };
}

function line(overrides = {}) {
  return {
    id: 'dom-com',
    description: 'toolsenabled.com domain registration, first year',
    amountCents: 1108,
    currency: 'USD',
    merchant: 'Porkbun',
    purpose: 'The product own address.',
    ...overrides
  };
}

function firstPrompt(deps) {
  return store.snapshot(deps).prompts[0];
}

// --- the stamp ------------------------------------------------------------

check('a line with no ownerRequestIds is stamped AGENT-PROPOSED on the wire', () => {
  const deps = tempDeps();
  store.enqueue(batch([line()]), deps);
  const item = firstPrompt(deps).items[0];
  assert.ok(item.description.startsWith(store.UNPROVENANCED_STAMP),
    `expected the agent-proposed stamp, got ${JSON.stringify(item.description)}`);
  assert.ok(/not traceable to your words/.test(item.description));
  assert.ok(item.description.endsWith('toolsenabled.com domain registration, first year'),
    'the original description text must survive the stamp');
});

check('a line WITH ownerRequestIds is stamped with the ids it came from', () => {
  const deps = tempDeps();
  store.enqueue(batch([line({ ownerRequestIds: ['R1233', 'R1230'] })]), deps);
  const item = firstPrompt(deps).items[0];
  assert.ok(item.description.startsWith('[From your words: R1233, R1230] '),
    `expected a traceable stamp, got ${JSON.stringify(item.description)}`);
  assert.ok(!/AGENT-PROPOSED/.test(item.description));
});

check('a mixed cart labels each line independently', () => {
  const deps = tempDeps();
  store.enqueue(batch([
    line({ id: 'his', ownerRequestIds: ['R1233'] }),
    line({ id: 'theirs' })
  ]), deps);
  const items = firstPrompt(deps).items;
  assert.ok(items[0].description.startsWith('[From your words: R1233] '));
  assert.ok(items[1].description.startsWith(store.UNPROVENANCED_STAMP));
});

// --- the wire shape, which a seventh key would break ----------------------

check('ownerRequestIds NEVER reaches the wire item', () => {
  const deps = tempDeps();
  store.enqueue(batch([line({ ownerRequestIds: ['R1233'] })]), deps);
  const item = firstPrompt(deps).items[0];
  assert.deepStrictEqual(Object.keys(item).sort(), WIRE_ITEM_KEYS,
    'wt-installer src/owner-popup.js validates items with exactKeys; an extra key blanks the popup');
});

check('an unprovenanced line keeps the same wire key set', () => {
  const deps = tempDeps();
  store.enqueue(batch([line()]), deps);
  assert.deepStrictEqual(Object.keys(firstPrompt(deps).items[0]).sort(), WIRE_ITEM_KEYS);
});

// --- the length budget, which an overflowing stamp would break ------------

check('enqueue reserves the stamp budget so a stamped description cannot overflow', () => {
  const deps = tempDeps();
  const room = store.MAX_ITEM_DESCRIPTION - store.PROVENANCE_STAMP_RESERVE;
  store.enqueue(batch([line({ description: 'x'.repeat(room) })]), deps);
  const item = firstPrompt(deps).items[0];
  assert.ok(item.description.length <= store.MAX_ITEM_DESCRIPTION,
    `stamped description is ${item.description.length}, over the renderer cap`);
  assert.throws(
    () => store.enqueue(batch([line({ id: 'too-long', description: 'x'.repeat(room + 1) })]), tempDeps()),
    error => error.code === 'OWNER_PROMPT_MALFORMED',
    'a description that leaves no room for the stamp must be refused at enqueue'
  );
});

check('a LEGACY record at the old 300 cap still renders inside the cap, stamp intact', () => {
  // Records written before the reserve existed can sit anywhere up to 300.
  // The stamp must survive; the popup must not.
  const deps = tempDeps();
  const now = Date.now();
  fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true });
  fs.writeFileSync(deps.stateFile, JSON.stringify({
    version: 1,
    prompts: [{
      id: 'legacy-cart', kind: 'purchase_batch', title: 'Legacy', message: 'Legacy cart',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
      state: 'pending', evidence: null, decision: null,
      items: [{ id: 'l1', description: 'y'.repeat(store.MAX_ITEM_DESCRIPTION), amountCents: 100, currency: 'USD', merchant: 'M', purpose: 'P' }],
      currency: 'USD', totalCents: 100
    }],
    settled: [], lockBreaks: []
  }));
  const item = store.snapshot(deps).prompts[0].items[0];
  assert.ok(item.description.length <= store.MAX_ITEM_DESCRIPTION,
    `stamped legacy description is ${item.description.length}, over the renderer cap`);
  assert.ok(item.description.startsWith(store.UNPROVENANCED_STAMP), 'the stamp must survive truncation, not the tail');
  assert.ok(item.description.endsWith('...'), 'the lost tail must be visible as a truncation');
});

// --- the ids themselves ---------------------------------------------------

check('ownerRequestIds is validated as owner-request ids, dotted ids included', () => {
  const deps = () => tempDeps();
  store.enqueue(batch([line({ ownerRequestIds: ['R52.1'] })]), deps());   // R52.1 is a real ledger id
  for (const bad of [[], 'R1233', ['R'], ['X1'], ['r1233'], [1233], ['R1233', 'R1233'], ['R12345']]) {
    assert.throws(
      () => store.enqueue(batch([line({ ownerRequestIds: bad })]), deps()),
      error => error.code === 'OWNER_PROMPT_MALFORMED',
      `ownerRequestIds ${JSON.stringify(bad)} must be refused`
    );
  }
  assert.throws(
    () => store.enqueue(batch([line({ ownerRequestIds: Array.from({ length: store.MAX_OWNER_REQUEST_IDS + 1 }, (_, i) => `R${i + 1}`) })]), deps()),
    error => error.code === 'OWNER_PROMPT_MALFORMED'
  );
});

check('too many ids degrade to a bounded stamp instead of overflowing', () => {
  const stamp = store.provenanceStamp(['R1000', 'R1001', 'R1002', 'R1003', 'R1004', 'R1005', 'R1006', 'R1007']);
  assert.ok(stamp.length <= store.PROVENANCE_STAMP_RESERVE, `stamp is ${stamp.length}, over the reserve`);
  assert.ok(/more\] $/.test(stamp), `expected an elided stamp, got ${JSON.stringify(stamp)}`);
});

// --- the recorded decision ------------------------------------------------

check('the settled decision records what each approved line was traceable to', () => {
  const deps = tempDeps();
  const { promptId } = store.enqueue(batch([
    line({ id: 'his', ownerRequestIds: ['R1233'] }),
    line({ id: 'theirs' })
  ]), deps);
  store.markPresented({ promptId, evidence: { mounted: true, visible: true, focused: true } }, deps);
  const outcome = store.decide({ promptId, decision: 'submit', itemDecisions: [{ itemId: 'his', decision: 'approve' }] }, deps);
  const his = outcome.items.find(i => i.itemId === 'his');
  const theirs = outcome.items.find(i => i.itemId === 'theirs');
  assert.deepStrictEqual(his.ownerRequestIds, ['R1233']);
  assert.strictEqual(theirs.ownerRequestIds, null, 'an agent-proposed line records null, not a guess');
  assert.strictEqual(theirs.decision, 'deny', 'deny-by-default still holds');
});

// --- the actual incident --------------------------------------------------

check('REGRESSION R1233: a cart shaped exactly like the live 0e33e84f one cannot present as his list', () => {
  const deps = tempDeps();
  // The four real lines of the live cart, by id and shape (six keys, no provenance).
  store.enqueue(batch([
    line({ id: 'toolsenabled-com-domain', merchant: 'Porkbun', amountCents: 1108 }),
    line({ id: 'azure-artifact-signing-basic', merchant: 'Microsoft Azure', amountCents: 999 }),
    line({ id: 'relay-hosting-monthly', merchant: 'Example Hosting', amountCents: 1200 }),
    line({ id: 'hosting-backups-weekly', merchant: 'Example Hosting', amountCents: 480 })
  ]), deps);
  const items = firstPrompt(deps).items;
  assert.strictEqual(items.length, 4);
  for (const item of items) {
    assert.ok(item.description.startsWith(store.UNPROVENANCED_STAMP),
      `${item.id} presented without the agent-proposed stamp`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
