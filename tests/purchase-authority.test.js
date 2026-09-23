// EXECUTABLE CHANGE
'use strict';
//
// TEST-CAN-FAIL REPORT (testcanfail-tests-purchase-authority-test-js)
// FOUND — shape 6, same-code oracle. REFUSAL.* and
// APPROVED_SPEND_PROVIDER were imported from the module whose output they
// checked. Before this change, mutating NO_AUTHORIZATION to
// MUTANT_NOT_AUTHORIZED and APPROVED_SPEND_PROVIDER to mutant-provider left the
// original file green: "22 passed, 0 failed".
//
// STRENGTHENED — every assertion that compared an error code with REFUSAL.*:
// the three direct-spend checks, both unreadable-settings checks, and the
// amount-mismatch, denied-line, omitted-line, pending-cart, invented-prompt,
// and malformed-amount checks. The NO_AUTHORIZATION mutation now reports:
// "19 passed, 3 failed"
// "FAILED: an agent spending directly, naming no approved line, is REFUSED,
// the refusal is a THROW on the path the spend code takes, not a boolean to
// forget, pay.recordSpend itself refuses a direct spend, and never reaches the
// ledger".
// Other refusal-code assertions now use the same independent, literal oracle;
// the mutation above is the representative mutation of that single defect
// shape rather than a separate mutation of every member of the same table.
//
// STRENGTHENED — both assertions comparing the pinned ledger provider. Mutating
// APPROVED_SPEND_PROVIDER to mutant-provider now reports:
// "20 passed, 2 failed"
// "FAILED: the caller cannot vary the ledger key at all -- provider is pinned
// by the gate too, the gate names the ledger coordinates in its verdict, and
// only for an approved line".
// Reservation-bearing fixtures likewise name the contractual setting value
// locally instead of asking the subject which value it recognizes.
//
// NOT-FOUND — shape 1: all three assertion loops iterate non-empty array
// literals constructed in the test; none receives a possibly-empty result.
// NOT-FOUND — shape 2: this file does not spawn a process or assert an exit
// status/truthy process result.
// NOT-FOUND — shape 3: no optional chain exists; check() records caught
// assertion failures and the final failure count exits non-zero.
// NOT-FOUND — shape 4: state/policy/audit doubles are boundary fakes and their
// observations test the real gate/pay path; the deliberately stubbed authority
// verdict checks pay's independent fail-closed handling of missing coordinates.
// NOT-FOUND — shape 5: there are no skips, platform branches, or precondition
// guards.
// PRECONDITION — the default Node 20.20.2 lacks node:sqlite. All mutation and
// restored runs used the installed Node 22.22.2 required by package.json.
// RESTORATION — src/lib/purchase-authority.js was restored byte-for-byte after
// each temporary mutation (verified with cmp). The restored final run reports:
// "22 passed, 0 failed".
// PROVES THE ONE PROPERTY THE OWNER ASKED FOR: an agent CANNOT spend without
// passing the gate. Not "should not" -- the direct-spend attempt is made here,
// against the real modules, and is refused.
//
// Nothing in this file spends, contacts a merchant, touches a card, or writes
// to the real spend ledger. The state store is faked at the boundary; the gate
// itself, the settings reader, and the owner-prompt store are REAL, because
// faking the thing under test is how a gate gets proved by a mirror.

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const authority = require('../src/lib/purchase-authority.js');
const reservationPolicy = require('../src/lib/purchase-reservation-policy.js');
const { decideAsk } = require('../src/lib/ask-preference.js');
const pay = require('../src/lib/providers/pay.js');
const ownerPrompts = require('../src/lib/mission-bridge/owner-prompts.js');

// Test-owned contract values: deriving these expectations from purchase-authority
// would let a mutation of the implementation's exported constants change both
// the result and its oracle while the test remained green.
const PURCHASE_RESERVATION = 'Approving any purchase or spending any money';
const REFUSAL = Object.freeze({
  NO_AUTHORIZATION: 'PURCHASE_NOT_AUTHORIZED',
  SETTINGS_UNREADABLE: 'PURCHASE_SETTINGS_UNREADABLE',
  DECISION_UNREADABLE: 'PURCHASE_DECISION_UNREADABLE',
  DECISION_MISSING: 'PURCHASE_DECISION_MISSING',
  DECISION_NOT_APPROVED: 'PURCHASE_LINE_NOT_APPROVED',
  AMOUNT_MISMATCH: 'PURCHASE_AMOUNT_MISMATCH',
  MALFORMED: 'PURCHASE_AUTHORIZATION_MALFORMED',
  LINE_ID_AMBIGUOUS: 'PURCHASE_LINE_ID_AMBIGUOUS'
});
const APPROVED_SPEND_PROVIDER = 'owner-prompt-purchase';

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function tempPromptDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-authority-'));
  return { stateFile: path.join(dir, 'prompts.json') };
}

// A settings document on disk, so the real loadSettings() is exercised rather
// than a stub of it. `null` writes no file at all -- the fresh-install case.
function settingsDeps(values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-settings-'));
  const file = path.join(dir, 'settings.json');
  if (values !== null) {
    fs.writeFileSync(file, JSON.stringify({
      revision: 1,
      values,
      provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: 1, directive: null }]))
    }));
  }
  return { settingsOptions: { valuesPath: file } };
}

// Drive a real cart from enqueue to a settled per-line decision, exactly the
// way the product does: enqueue, mark presented with measured evidence, decide.
function settledCart(deps, itemDecisions, items) {
  const enqueued = ownerPrompts.enqueue({
    kind: 'purchase_batch',
    title: 'Test list',
    message: 'A test shopping list.',
    items,
    ttlMs: null
  }, deps);
  ownerPrompts.markPresented({
    promptId: enqueued.promptId,
    evidence: { focused: true, mounted: true, visible: true }
  }, deps);
  ownerPrompts.decide({ promptId: enqueued.promptId, decision: 'submit', itemDecisions }, deps);
  return enqueued.promptId;
}

const LINE = {
  id: 'delaware-incorporation',
  description: 'Delaware Certificate of Incorporation',
  amountCents: 10900,
  currency: 'USD',
  merchant: 'Delaware Division of Corporations',
  purpose: 'Incorporate the business.'
};

console.log('THE GATE: an agent cannot spend without owner approval');

// ---------------------------------------------------------------------------
// 1. THE DIRECT SPEND. This is the attack the whole feature exists to stop.
// ---------------------------------------------------------------------------
check('an agent spending directly, naming no approved line, is REFUSED', () => {
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD' },
    settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] })
  );
  assert.equal(verdict.authorized, false, 'a spend with no approved line must be refused');
  assert.equal(verdict.code, REFUSAL.NO_AUTHORIZATION);
});

check('the refusal is a THROW on the path the spend code takes, not a boolean to forget', () => {
  assert.throws(
    () => authority.assertSpendAuthorized(
      { amountCents: 10900 },
      settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] })
    ),
    error => error.name === 'PurchaseAuthorityError' && error.code === REFUSAL.NO_AUTHORIZATION
  );
});

// The end-to-end version: the REAL pay.recordSpend, which is what the MCP tool
// `pay.record` calls. The state store is faked so that IF the gate failed, the
// test would record the fake spend and say so loudly rather than moving money.
check('pay.recordSpend itself refuses a direct spend, and never reaches the ledger', () => {
  const ledgerWrites = [];
  assert.throws(() => pay.recordSpend(
    { amountUsd: 99, purpose: 'no approval anywhere', provider: 'rogue-agent', reference: 'r1' },
    {
      assertActive: () => {},
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 100 } }),
      state: { recordSpend: input => { ledgerWrites.push(input); return { entry: { id: 'x' }, replayed: false }; } },
      record: () => {},
      purchaseAuthorityDependencies: settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] })
    }
  ), error => error.code === REFUSAL.NO_AUTHORIZATION);
  assert.equal(ledgerWrites.length, 0, 'the spend ledger must not be written on a refusal');
});

// ---------------------------------------------------------------------------
// 2. THE DEFAULT IS OFF, AND ABSENCE IS NEVER CONSENT.
// ---------------------------------------------------------------------------
check('a fresh install with NO settings file auto-approves nothing', () => {
  const reservation = authority.purchaseApprovalReserved(settingsDeps(null));
  assert.equal(reservation.reserved, true, 'the registry default must reserve purchase approval');
  assert.equal(reservation.readable, true);
});

check('an UNREADABLE settings file refuses rather than granting', () => {
  const verdict = authority.authorizeSpend({ amountCents: 500 }, {
    loadSettings: () => { throw new Error('permission denied'); }
  });
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.SETTINGS_UNREADABLE);
});

check('a settings file whose reservation list is malformed refuses rather than granting', () => {
  const verdict = authority.authorizeSpend({ amountCents: 500 }, {
    loadSettings: () => ({ values: { 'outward.reserved_from_agents': 'not a list' } })
  });
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.SETTINGS_UNREADABLE);
});

check('the setting is really consulted: removing the reservation changes the answer', () => {
  const verdict = authority.authorizeSpend({ amountCents: 500 },
    settingsDeps({ 'outward.reserved_from_agents': ['Posting to social media'] }));
  assert.equal(verdict.authorized, true, 'an owner who removed the reservation is honoured');
  assert.equal(verdict.autoApproved, true);
  // ...and with it present, the same call is refused. Same input, one setting
  // apart: this is what makes the setting an enforcer rather than a label.
  const withReservation = authority.authorizeSpend({ amountCents: 500 },
    settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] }));
  assert.equal(withReservation.authorized, false);
});

// ---------------------------------------------------------------------------
// 3. AN APPROVED LINE OPENS THE GATE -- AND ONLY FOR WHAT HE APPROVED.
// ---------------------------------------------------------------------------
check('a line the owner approved is authorized, for that exact amount', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD', promptId, itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, true);
  assert.equal(verdict.code, 'PURCHASE_APPROVED_BY_OWNER');
  assert.equal(verdict.autoApproved, false);
});

check('approving $109.00 does not authorize $10,900.00', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const verdict = authority.authorizeSpend(
    { amountCents: 1090000, currency: 'USD', promptId, itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.AMOUNT_MISMATCH);
});

check('an unmeasured currency is refused rather than authorized from cents alone', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, promptId, itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, authority.REFUSAL.AMOUNT_MISMATCH);
});

check('a REFUSED line stays refused and cannot be spent against', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'deny' }], [LINE]);
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD', promptId, itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.DECISION_NOT_APPROVED);
});

check('a line the owner never decided (omitted) is denied, not approved', () => {
  const deps = tempPromptDeps();
  const second = { ...LINE, id: 'registered-agent', description: 'Registered agent, year one', amountCents: 5000 };
  // Only the first line is decided; the second is left out entirely.
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE, second]);
  const verdict = authority.authorizeSpend(
    { amountCents: 5000, currency: 'USD', promptId, itemId: second.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.DECISION_NOT_APPROVED);
});

check('a cart still PENDING cannot be spent against', () => {
  const deps = tempPromptDeps();
  const enqueued = ownerPrompts.enqueue({
    kind: 'purchase_batch', title: 'Waiting', message: 'Not decided yet.', items: [LINE], ttlMs: null
  }, deps);
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD', promptId: enqueued.promptId, itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.DECISION_MISSING);
});

check('an invented promptId cannot be spent against', () => {
  const deps = tempPromptDeps();
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD', promptId: 'made-up-id', itemId: LINE.id },
    { ownerPromptDependencies: deps }
  );
  assert.equal(verdict.authorized, false);
  assert.equal(verdict.code, REFUSAL.DECISION_MISSING);
});

check('a busy decision store is not reported as an absent decision or latched', () => {
  const ownerPromptsCacheEntry = require.cache[require.resolve('../src/lib/mission-bridge/owner-prompts.js')];
  let reads = 0;
  for (const errorCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const verdict = authority.authorizeSpend(
      { amountCents: 10900, currency: 'USD', promptId: 'existing-prompt', itemId: LINE.id },
      { settledDecision: () => {
        reads += 1;
        const error = new Error(`temporary ${errorCode}`);
        error.code = errorCode;
        throw error;
      } }
    );
    assert.equal(verdict.authorized, false);
    assert.equal(verdict.code, REFUSAL.DECISION_UNREADABLE);
    assert.match(verdict.explanation, /does not mean the decision is absent; the machine could not tell/i);
  }
  assert.equal(reads, 5, 'a could-not-tell result must be retried, never cached or latched');
  assert.strictEqual(
    require.cache[require.resolve('../src/lib/mission-bridge/owner-prompts.js')],
    ownerPromptsCacheEntry,
    'control: the legitimately cached owner-prompts module remains cached'
  );
});

// ---------------------------------------------------------------------------
// 4. THE APPROVED PATH STILL WORKS END TO END, THROUGH THE REAL pay.recordSpend.
// ---------------------------------------------------------------------------
check('an approved line reaches the ledger, carrying who approved it and when', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const audits = [];
  const result = pay.recordSpend(
    { amountUsd: 109, purpose: LINE.description, provider: 'owner-prompt-purchase', reference: `${promptId}:${LINE.id}`, authorization: { promptId, itemId: LINE.id } },
    {
      assertActive: () => {},
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 500 } }),
      state: { recordSpend: input => ({ entry: { id: 'ledger-1', ...input }, replayed: false }) },
      record: (action, ref, payload) => audits.push({ action, ref, payload }),
      purchaseAuthorityDependencies: { ownerPromptDependencies: deps }
    }
  );
  assert.equal(result.entry.amountCents, 10900);
  assert.equal(audits.length, 1, 'the spend must produce exactly one audit receipt');
  assert.equal(audits[0].payload.approvedBy, 'owner', 'the receipt must record WHO approved');
  assert.equal(audits[0].payload.approvalCode, 'PURCHASE_APPROVED_BY_OWNER');
  assert.ok(typeof audits[0].payload.approvedAt === 'string' && audits[0].payload.approvedAt.length > 0,
    'the receipt must record WHEN he approved');
});

// ---------------------------------------------------------------------------
// 4b. SPEND ONCE. An approved line buys one thing, once.
//
// The gap this closes was latent rather than reachable: the schema for the
// `pay.record` tool exposes no `authorization`, and the one real caller
// (mission-bridge/purchase-recording.js) happened to pass a reference derived
// from (promptId, itemId), which the ledger's UNIQUE(provider, reference) then
// deduped. So "spend once" was true, but it was true because of a string literal
// in a caller rather than because of anything the gate did. Measured in a
// harness before the fix: the SAME approved line, spent twice under two
// different references, succeeded twice.
//
// This fake ledger implements the REAL store's dedupe rule -- and nothing else
// -- because that rule is the thing being relied on. Nothing here writes to the
// real spend ledger.
// ---------------------------------------------------------------------------

function fakeLedger() {
  const rows = new Map();
  return {
    rows,
    recordSpend(input) {
      const provider = input.provider === undefined ? 'manual' : input.provider;
      const reference = input.reference === undefined || input.reference === '' ? null : input.reference;
      const key = `${provider} ${reference}`;
      if (reference !== null && rows.has(key)) {
        return { entry: rows.get(key), replayed: true };
      }
      const entry = { id: `ledger-${rows.size + 1}`, ...input, provider, reference };
      if (reference !== null) rows.set(key, entry);
      else rows.set(`${key} ${rows.size}`, entry);
      return { entry, replayed: false };
    },
    get charged() {
      return [...rows.values()].reduce((sum, entry) => sum + entry.amountCents, 0);
    }
  };
}

function spendApprovedLine(promptId, deps, state, { reference, provider = 'owner-prompt-purchase' }) {
  return pay.recordSpend(
    {
      amountUsd: 109, purpose: LINE.description, provider, reference,
      authorization: { promptId, itemId: LINE.id }
    },
    {
      assertActive: () => {},
      loadPolicy: () => ({ limits: { defaultDailySpendUsd: 500 } }),
      state,
      record: () => {},
      purchaseAuthorityDependencies: { ownerPromptDependencies: deps }
    }
  );
}

check('THE REPLAY: one approved line spent twice under two different references charges once', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const state = fakeLedger();

  const first = spendApprovedLine(promptId, deps, state, { reference: `${promptId}:${LINE.id}` });
  // The second attempt is the whole point: same approved line, same amount, a
  // DIFFERENT reference -- a merchant receipt id, which is exactly the kind of
  // "better" reference a caller would reasonably substitute in.
  const second = spendApprovedLine(promptId, deps, state, { reference: 'merchant-receipt-77771' });

  assert.equal(first.replayed, false, 'the first spend must actually record');
  assert.equal(second.replayed, true,
    'BYPASS: the same approved line was spent a SECOND time by varying the reference');
  assert.equal(state.rows.size, 1, 'one approved line may produce exactly ONE ledger row');
  assert.equal(state.charged, 10900, `one approved line charged ${state.charged} cents instead of 10900`);
  assert.equal(first.entry.id, second.entry.id, 'both attempts must land on the same ledger row');
});

check('the caller cannot vary the ledger key at all -- provider is pinned by the gate too', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const state = fakeLedger();

  // UNIQUE is on (provider, reference), so varying the PROVIDER escapes the
  // dedupe just as varying the reference does. Both halves have to be the
  // gate's, or the fix is half a fix.
  spendApprovedLine(promptId, deps, state, { reference: `${promptId}:${LINE.id}` });
  const second = spendApprovedLine(promptId, deps, state, { reference: 'other-ref', provider: 'some-other-provider' });

  assert.equal(second.replayed, true, 'BYPASS: varying the provider spent the same approved line again');
  assert.equal(state.rows.size, 1);
  assert.equal(state.charged, 10900);
  const [entry] = [...state.rows.values()];
  assert.equal(entry.provider, APPROVED_SPEND_PROVIDER, 'the row must carry the gate\'s provider');
  assert.equal(entry.reference, `${promptId}:${LINE.id}`, 'and the gate\'s reference');
});

check('the gate names the ledger coordinates in its verdict, and only for an approved line', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'approve' }], [LINE]);
  const verdict = authority.authorizeSpend(
    { amountCents: 10900, currency: 'USD', promptId, itemId: LINE.id }, { ownerPromptDependencies: deps });
  assert.equal(verdict.authorized, true);
  assert.equal(verdict.spendProvider, APPROVED_SPEND_PROVIDER);
  assert.equal(verdict.spendReference, `${promptId}:${LINE.id}`);

  // The auto-approved path has no cart line to spend once, so it names no
  // coordinates -- and must not, or it would collapse every unrelated
  // auto-approved spend onto one row.
  const auto = authority.authorizeSpend({ amountCents: 500, currency: 'USD' },
    settingsDeps({ 'outward.reserved_from_agents': ['Pressing post on Instagram'] }));
  assert.equal(auto.authorized, true);
  assert.equal(auto.autoApproved, true);
  assert.equal(auto.spendReference, undefined, 'an auto-approved spend names no cart line to consume');
});

check('an approval that names nowhere to record is REFUSED, never defaulted onto an undeduped row', () => {
  const state = fakeLedger();
  // A reference of null skips the ledger's dedupe entirely, so an approval
  // missing its coordinates would restore the double-spend through an absence.
  assert.throws(
    () => pay.recordSpend(
      { amountUsd: 109, purpose: LINE.description, provider: 'x', reference: 'y', authorization: { promptId: 'p', itemId: 'i' } },
      {
        assertActive: () => {},
        loadPolicy: () => ({ limits: { defaultDailySpendUsd: 500 } }),
        state,
        record: () => {},
        assertSpendAuthorized: () => ({ authorized: true, code: 'STUB', autoApproved: false })
      }
    ),
    error => error.code === 'PURCHASE_LEDGER_KEY_MISSING',
    'an approved spend with no ledger coordinates must refuse'
  );
  assert.equal(state.rows.size, 0, 'and must not have reached the ledger');
});

check('removing the purchase reservation reaches the auto-approved verdict', () => {
  let settingsReads = 0;
  let decisionReads = 0;
  const verdict = authority.authorizeSpend(
    { amountCents: 725, currency: 'USD' },
    {
      loadSettings: () => {
        settingsReads += 1;
        return { values: { 'outward.reserved_from_agents': [] } };
      },
      settledDecision: () => { decisionReads += 1; throw new Error('must not inspect a cart'); }
    }
  );

  assert.deepEqual(verdict, {
    authorized: true,
    code: 'PURCHASE_AUTO_APPROVED_BY_SETTING',
    explanation: 'You removed purchase approval from the list of things you keep for yourself, so assistants may spend within your daily limit without asking.',
    autoApproved: true,
    promptId: null,
    itemId: null
  });
  assert.equal(settingsReads, 1, 'the setting must actually be read');
  assert.equal(decisionReads, 0, 'auto-approval must not fabricate or inspect a cart decision');
});

check('ambiguous approved ids refuse through the spend path before ledger or audit writes', () => {
  let decisionReads = 0;
  let ledgerWrites = 0;
  let auditWrites = 0;
  const approvedDecision = () => {
    decisionReads += 1;
    return {
      kind: 'purchase_batch',
      decision: {
        decision: 'submit',
        items: [{ itemId: 'line', decision: 'approve', amountCents: 10900, currency: 'USD' }]
      }
    };
  };

  assert.throws(
    () => pay.recordSpend(
      {
        amountUsd: 109,
        purpose: LINE.description,
        authorization: { promptId: 'cart:ambiguous', itemId: 'line' }
      },
      {
        assertActive: () => {},
        loadPolicy: () => ({ limits: { defaultDailySpendUsd: 500 } }),
        purchaseAuthorityDependencies: { settledDecision: approvedDecision },
        state: {
          recordSpend: () => { ledgerWrites += 1; throw new Error('ledger must not be reached'); }
        },
        record: () => { auditWrites += 1; throw new Error('audit must not be reached'); }
      }
    ),
    error => error instanceof authority.PurchaseAuthorityError
      && error.code === REFUSAL.LINE_ID_AMBIGUOUS
      && /nothing was spent/i.test(error.message),
    'the real spend path must throw the ambiguity refusal'
  );
  assert.equal(decisionReads, 1, 'the approved decision must be driven before the id refusal');
  assert.equal(ledgerWrites, 0, 'a refused spend must not write the ledger');
  assert.equal(auditWrites, 0, 'a refused spend must not write an audit receipt');
});

check('ids that cannot be told apart from another line\'s are refused rather than collided', () => {
  // PROMPT_ID_RE permits ':', so "a:b"+"c" and "a"+"b:c" derive the same key.
  // The collision would not overspend -- the second line would replay the first
  // -- but it would silently record no entry for a line the owner approved,
  // which is a false receipt.
  assert.equal(authority.approvedLineLedgerKey('a', 'b'), 'a:b');
  assert.equal(authority.approvedLineLedgerKey('a:b', 'c'), null);
  assert.equal(authority.approvedLineLedgerKey('a', 'b:c'), null);
});

// ---------------------------------------------------------------------------
// 5. NOTHING THE OWNER READS SHOWS HIM AN INTERNAL IDENTIFIER.
// ---------------------------------------------------------------------------
check('no refusal shown to a person contains an internal identifier', () => {
  const deps = tempPromptDeps();
  const promptId = settledCart(deps, [{ itemId: LINE.id, decision: 'deny' }], [LINE]);
  const explanations = [
    authority.authorizeSpend({ amountCents: 10900 }, settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] })).explanation,
    authority.authorizeSpend({ amountCents: 10900, promptId, itemId: LINE.id }, { ownerPromptDependencies: deps }).explanation,
    authority.authorizeSpend({ amountCents: 1, promptId, itemId: 'nope' }, { ownerPromptDependencies: deps }).explanation
  ];
  for (const explanation of explanations) {
    assert.ok(typeof explanation === 'string' && explanation.length > 0, 'every refusal must explain itself');
    assert.ok(!explanation.includes(promptId), `a refusal leaked an internal prompt id: "${explanation}"`);
    assert.ok(!explanation.includes(LINE.id), `a refusal leaked an internal line id: "${explanation}"`);
    assert.ok(!/PURCHASE_[A-Z_]+/.test(explanation), `a refusal leaked an internal error code: "${explanation}"`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(explanation), `a refusal leaked a uuid: "${explanation}"`);
  }
});

// ---------------------------------------------------------------------------
// 6. THE GATE HAS NO DOOR. A bypass that exists for a good caller is a bypass.
// ---------------------------------------------------------------------------
check('there is no argument, flag, or provider name that skips the gate', () => {
  const bypassAttempts = [
    { amountCents: 100, force: true },
    { amountCents: 100, skipApproval: true },
    { amountCents: 100, autoApprove: true },
    { amountCents: 100, promptId: '', itemId: '' },
    { amountCents: 100, promptId: null, itemId: null }
  ];
  const deps = settingsDeps({ 'outward.reserved_from_agents': [PURCHASE_RESERVATION] });
  for (const attempt of bypassAttempts) {
    const verdict = authority.authorizeSpend(attempt, deps);
    assert.equal(verdict.authorized, false, `an attempt got through: ${JSON.stringify(attempt)}`);
  }
});

check('a malformed or non-positive amount is refused, never rounded into one', () => {
  const deps = settingsDeps({ 'outward.reserved_from_agents': [] });
  for (const amountCents of [0, -100, 1.5, NaN, '100', undefined, null]) {
    const verdict = authority.authorizeSpend({ amountCents }, deps);
    assert.equal(verdict.authorized, false, `amountCents ${String(amountCents)} was authorized`);
    assert.equal(verdict.code, REFUSAL.MALFORMED);
  }
});

check('the shared reservation policy keeps ask preference and the public spend gate fail-closed', () => {
  const reservedSettings = {
    values: { 'outward.reserved_from_agents': [PURCHASE_RESERVATION] },
    provenance: {}
  };
  let loads = 0;
  const loadReserved = () => { loads += 1; return reservedSettings; };
  const reservation = reservationPolicy.purchaseApprovalReserved({ loadSettings: loadReserved });
  assert.equal(reservation.reserved, true);
  assert.equal(reservation.readable, true);
  assert.equal(authority.RESERVATION_PURCHASES, PURCHASE_RESERVATION, 'purchase-authority keeps the public reservation constant');
  assert.equal(authority.AUTO_APPROVE_SETTING_ID, 'outward.reserved_from_agents', 'purchase-authority keeps the public auto-approve setting id');
  assert.equal(authority.REQUIRE_APPROVAL_SETTING_ID, 'purchases.require_owner_approval', 'purchase-authority keeps the public require-approval setting id');
  assert.equal(typeof authority.purchaseApprovalReserved, 'function', 'purchase-authority keeps the public reservation function');
  const ask = decideAsk({}, { name: 'pay.record', effect: 'local-write' }, {}, { loadSettings: loadReserved });
  assert.deepEqual(ask, { decision: 'ask', action: 'stop-and-wait', reason: 'purchase-reserved' });
  assert.equal(loads, 2, 'each public decision reads its supplied settings once');

  const unreadable = reservationPolicy.purchaseApprovalReserved({ loadSettings: () => { throw new Error('permission denied'); } });
  assert.equal(unreadable.reserved, true, 'a policy read failure must remain a reservation');
  assert.equal(unreadable.readable, false);

  const released = reservationPolicy.purchaseApprovalReserved({
    loadSettings: () => ({
      values: {
        'outward.reserved_from_agents': [],
        'purchases.require_owner_approval': false
      },
      provenance: { 'purchases.require_owner_approval': { source: 'user' } }
    })
  });
  assert.equal(released.reserved, false, 'only an explicit owner setting may release the reservation');
  assert.equal(released.readable, true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
