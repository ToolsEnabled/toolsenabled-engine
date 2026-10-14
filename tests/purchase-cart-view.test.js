// EXECUTABLE CHANGE
// Assertion-discrimination audit report.
//
// FOUND (shape 1): the recurrence assertions iterated over `cart.items` without
// first proving that the projection returned a line. Mutation: changed
// `items: Object.freeze(items)` in purchase-cart-view.js to
// `items: Object.freeze([])`. Before the strengthening the individual loop body
// could not execute; the added cardinality assertion makes the check report:
//   "FAILED   no line reports a recurrence, and every line carries the reason why not"
//   "the fixture has two projected lines, so the per-line assertions must execute"
//   "0 !== 2"
// FOUND (shape 5): this machine has no state/owner-public-prompts.json, so the
// live-data precondition cannot be met. The optional live inspection remains
// honestly optional, but an always-present one-cart probe now makes this check
// executable on every platform. Mutation: changed `deadline:
// humanDeadline(expiry)` to `deadline: ''`. The strengthened check reports:
//   "FAILED   the live owner queue projects without throwing, and every cart in it has a deadline"
//   "the deterministic probe states a deadline sentence"
// NOT-FOUND (shape 2): no exit-status or truthy process-return assertion exists.
// NOT-FOUND (shape 3): no optional chain or test-failure-swallowing try/catch
// exists (the harness catch records failures and sets a non-zero exit status).
// NOT-FOUND (shape 4): injected vault/audio collaborators are boundary fakes,
// not mocks of purchase-cart-view or purchase-cart, the subjects under test.
// NOT-FOUND (shape 6): no expected value is computed by the production code.
// RESTORATION: purchase-cart-view.js was restored byte-for-byte after each
// mutation. `node tests/purchase-cart-view.test.js` then ended:
//   "30 passed, 0 failed"

'use strict';
// The projection both cart surfaces read, tested against the LIVE snapshot shape
// and against the failure it exists to prevent.
//
// The load-bearing properties are not the totals. They are:
//   1. a deadline is stated, because the live carts expire 2026-08-18 and no
//      surface says so today;
//   2. doing nothing is stated as DENIAL, because that is what expiry does;
//   3. no recurring or annual figure is invented, because inventing numbers on
//      the owner's money surface is what four rejected carts did;
//   4. a total that has drifted from its lines is a THROW, not a rendered number.
//
// Fixtures below are the real shapes: the stamps are the literal strings
// owner-prompts.js wireItem() prepends, and the amounts are the live cart's.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const view = require('../src/lib/purchase-cart-view.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok       ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAILED   ${name}\n           ${error && error.message}`); }
}

const OWNER = '[From your words: R1234] ';
const AGENT = view.AGENT_STAMP;
const NOW = Date.parse('2026-08-12T00:00:00.000Z');

function purchasePrompt(overrides = {}) {
  const items = overrides.items || [
    { id: 'domain-toolsenabled-ai', description: `${OWNER}toolsenabled.ai - 2-year registration`, amountCents: 16_540, currency: 'USD', merchant: 'Porkbun', purpose: 'The ending you named first.' },
    { id: 'hosting-backups-weekly', description: `${AGENT}Weekly automated backups`, amountCents: 480, currency: 'USD', merchant: 'Example Hosting', purpose: 'Carried over from the retired cart.' }
  ];
  return {
    id: 'fd5807ed', kind: 'purchase_batch', title: 'ToolsEnabled launch - the whole list, from your words',
    message: 'This is the whole list.', createdAt: '2026-08-11T16:36:57.941Z',
    expiresAt: '2026-08-18T16:36:57.941Z', state: 'pending', defaultDecision: 'deny',
    items, currency: 'USD',
    totalCents: overrides.totalCents !== undefined ? overrides.totalCents : items.reduce((sum, item) => sum + item.amountCents, 0),
    ...('expiresAt' in overrides ? { expiresAt: overrides.expiresAt } : {})
  };
}

function snapshotOf(prompts) {
  return { ok: true, schemaVersion: 1, generatedAt: '2026-08-12T00:00:00.000Z', theme: { defaultTheme: 'black' }, prompts };
}

// ---------------------------------------------------------------------------
// 1. THE DEADLINE IS SAID OUT LOUD.
// ---------------------------------------------------------------------------

check('a live cart states its expiry date, its countdown and a plain deadline sentence', () => {
  const result = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW });
  const cart = result.carts[0];
  assert.strictEqual(cart.expiresAt, '2026-08-18T16:36:57.941Z');
  assert.strictEqual(cart.expired, false);
  assert.strictEqual(cart.remainingDays, 6, 'from 2026-08-12T00:00Z to 2026-08-18T16:36Z is 6 whole days');
  assert.strictEqual(cart.deadline, 'Expires in 6 days.');
});

check('a deadline is rounded DOWN, so 23 hours left says today rather than tomorrow', () => {
  const almost = purchasePrompt({ expiresAt: '2026-08-12T23:00:00.000Z' });
  const cart = view.cartView(snapshotOf([almost]), { now: NOW }).carts[0];
  assert.strictEqual(cart.remainingDays, 0);
  assert.strictEqual(cart.deadline, 'Expires today.');
});

check('a cart past its expiry says so and does not report time remaining', () => {
  const gone = purchasePrompt({ expiresAt: '2026-08-11T00:00:00.000Z' });
  const cart = view.cartView(snapshotOf([gone]), { now: NOW }).carts[0];
  assert.strictEqual(cart.expired, true);
  assert.strictEqual(cart.remainingMs, 0);
  assert.strictEqual(cart.deadline, 'This expired. It is no longer waiting for you.');
});

// ---------------------------------------------------------------------------
// 2. DOING NOTHING IS DENIAL, AND SAYS SO.
// ---------------------------------------------------------------------------

check('a purchase batch states that doing nothing DENIES every line', () => {
  const cart = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW }).carts[0];
  assert.match(cart.doNothing, /DENIED/);
  assert.match(cart.doNothing, /every line/i);
});

check('a notice states acknowledgement, never denial -- the two outcomes are not interchangeable', () => {
  const notice = {
    id: '0bbac106', kind: 'notice', title: '7 background tasks are disabled', message: 'Only you can do this.',
    createdAt: '2026-08-10T20:32:18.565Z', expiresAt: '2026-08-17T20:32:18.565Z', state: 'pending', defaultDecision: 'acknowledge'
  };
  const projected = view.viewPrompt(notice, NOW);
  assert.doesNotMatch(projected.doNothing, /DENIED/);
  assert.match(projected.doNothing, /marked read/);
});

// ---------------------------------------------------------------------------
// 3. NO INVENTED RECURRING OR ANNUAL NUMBER. THE REASON IS CARRIED, NOT THE GUESS.
// ---------------------------------------------------------------------------

check('no line reports a recurrence, and every line carries the reason why not', () => {
  const cart = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW }).carts[0];
  assert.strictEqual(cart.items.length, 2, 'the fixture has two projected lines, so the per-line assertions must execute');
  for (const item of cart.items) {
    assert.strictEqual(item.recurrence, null, `${item.id} must not claim a recurrence`);
    assert.match(item.recurrenceUnavailableReason, /no recurrence field/);
  }
});

check('neither the cart nor the whole view reports a first-year figure', () => {
  const result = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW });
  assert.strictEqual(result.firstYearCents, null);
  assert.strictEqual(result.carts[0].firstYearCents, null);
  assert.match(result.firstYearUnavailableReason, /guessed/);
});

// ---------------------------------------------------------------------------
// 4. A DRIFTED TOTAL IS A THROW.
// ---------------------------------------------------------------------------

check('a total that does not equal its lines throws instead of rendering', () => {
  assert.throws(() => view.cartView(snapshotOf([purchasePrompt({ totalCents: 99_999 })]), { now: NOW }),
    /not bound to its line items/);
});

check('two carts in different currencies produce no combined total and say why', () => {
  const usd = purchasePrompt();
  const eur = { ...purchasePrompt(), id: 'other', currency: 'EUR',
    items: [{ id: 'x', description: `${OWNER}Something`, amountCents: 100, currency: 'EUR', merchant: 'M', purpose: 'P' }], totalCents: 100 };
  const result = view.cartView(snapshotOf([usd, eur]), { now: NOW });
  assert.strictEqual(result.approveEverythingCents, null);
  assert.match(result.approveEverythingUnavailableReason, /exchange rate/);
});

// ---------------------------------------------------------------------------
// 5. PROVENANCE SURVIVES THE WIRE, INCLUDING "WE CANNOT TELL".
// ---------------------------------------------------------------------------

check("an owner line and an agent line are told apart, and the agent line is not called the owner's", () => {
  const cart = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW }).carts[0];
  assert.strictEqual(cart.items[0].provenance, 'owner');
  assert.deepStrictEqual([...cart.items[0].ownerRequestIds], ['R1234']);
  assert.strictEqual(cart.items[1].provenance, 'agent-proposed');
  assert.strictEqual(cart.ownerLineCount, 1);
  assert.strictEqual(cart.agentProposedLineCount, 1);
});

check('an unstamped description reports unknown, not agent-proposed -- those are different claims', () => {
  const bare = view.readProvenance('A line from before stamping existed');
  assert.strictEqual(bare.provenance, 'unknown');
  assert.strictEqual(bare.text, 'A line from before stamping existed');
  assert.strictEqual(bare.ownerRequestIds.length, 0);
});

check('a truncated stamp keeps the label but reports no id list, rather than a half list', () => {
  const many = view.readProvenance('[From your words: 12 owner requests] Something');
  assert.strictEqual(many.provenance, 'owner');
  assert.strictEqual(many.ownerRequestIds.length, 0);
  assert.match(many.label, /12 owner requests/);
});

check('the wire description is preserved byte-for-byte alongside the stripped text', () => {
  const cart = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW }).carts[0];
  assert.strictEqual(cart.items[0].description, `${OWNER}toolsenabled.ai - 2-year registration`);
  assert.strictEqual(cart.items[0].text, 'toolsenabled.ai - 2-year registration');
});

check("reading the STORED record uses the ownerRequestIds field, not a stamp that is not there", () => {
  // The store keeps the field and adds the stamp only on the way out. A reader
  // holding the file must not report the owner's own lines as unrecorded.
  const stored = purchasePrompt({ items: [
    { id: 'uspto-trademark-toolsenabled', description: 'USPTO federal trademark application', amountCents: 35_000, currency: 'USD', merchant: 'USPTO', purpose: 'You asked for this by name.', ownerRequestIds: ['R1234'] },
    { id: 'hosting-backups-weekly', description: 'Weekly automated backups', amountCents: 480, currency: 'USD', merchant: 'Example Hosting', purpose: 'Carried over.' }
  ] });
  const cart = view.cartView(snapshotOf([stored]), { now: NOW, provenanceSource: 'record' }).carts[0];
  assert.strictEqual(cart.items[0].provenance, 'owner');
  assert.deepStrictEqual([...cart.items[0].ownerRequestIds], ['R1234']);
  // Absent ownerRequestIds IS agent-proposed in the store's own rule -- not unknown.
  assert.strictEqual(cart.items[1].provenance, 'agent-proposed');
  assert.strictEqual(cart.unknownProvenanceLineCount, 0);
});

check('the safe default is wire, so a wire consumer never mislabels lines as agent-proposed', () => {
  const stored = purchasePrompt({ items: [
    { id: 'a', description: `${OWNER}A stamped line`, amountCents: 100, currency: 'USD', merchant: 'M', purpose: 'P' }
  ] });
  // No provenanceSource given, and no ownerRequestIds field: it must read the stamp.
  const cart = view.cartView(snapshotOf([stored]), { now: NOW }).carts[0];
  assert.strictEqual(cart.items[0].provenance, 'owner');
  // And an unrecognised value must not silently select 'record'.
  const coerced = view.cartView(snapshotOf([stored]), { now: NOW, provenanceSource: 'RECORD' }).carts[0];
  assert.strictEqual(coerced.items[0].provenance, 'owner');
});

// ---------------------------------------------------------------------------
// 6. NO SPEND. Structural, the same guarantee tests/launch-approvals-cart.js
//    pins on the cart producers: this module is on the owner's money surface and
//    must not be able to reach a payment module even transitively.
// ---------------------------------------------------------------------------

check('the projection module requires nothing at all, so it cannot reach a payment module', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'purchase-cart-view.js'), 'utf8');
  const requires = source.match(/require\(/g) || [];
  assert.strictEqual(requires.length, 0, `expected zero requires, found ${requires.length}`);
});

// ---------------------------------------------------------------------------
// 7. THE LIVE STATE, if it is present. Not a fixture: the owner's real queue.
// ---------------------------------------------------------------------------

check('the live owner queue projects without throwing, and every cart in it has a deadline', () => {
  // Keep this check discriminating when the machine-specific live-state file is
  // absent: the optional inspection below adds evidence, but is not its only
  // evidence. In particular, neither assertion can pass through an empty loop.
  const probe = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW });
  assert.strictEqual(probe.carts.length, 1, 'the deterministic probe must project one cart');
  const probeCart = probe.carts[0];
  assert.ok(probeCart.expiresAt, 'the deterministic probe states an expiry');
  assert.ok(probeCart.deadline.length > 0, 'the deterministic probe states a deadline sentence');
  assert.match(probeCart.doNothing, /DENIED/);

  const stateFile = path.resolve(__dirname, '..', 'state', 'owner-public-prompts.json');
  if (!fs.existsSync(stateFile)) { console.log('           (no live state on this machine; shape-only)'); return; }
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // The stored record is not the wire record: the wire adds defaultDecision and
  // stamps descriptions. Rebuild only what this projection reads, from the store's
  // own rule (notice acknowledges, everything else denies).
  const prompts = (raw.prompts || []).map(prompt => ({
    ...prompt,
    defaultDecision: prompt.kind === 'notice' ? 'acknowledge' : 'deny'
  }));
  // The projection must survive the live record whatever is in it -- including
  // an empty queue. This call is the half that always runs.
  const result = view.cartView(snapshotOf(prompts), { now: NOW, provenanceSource: 'record' });

  // An empty queue used to fail here on `waitingCount > 0`. That is not a
  // product invariant: it asserts the owner currently has unanswered questions,
  // which is a property of one machine at one moment, and the healthy state --
  // he answered everything -- made it fail. The file being ABSENT was already
  // handled above; the file being present and EMPTY is the same epistemic
  // situation and now gets the same honest treatment.
  //
  // It is reported rather than passed silently, because "no live carts existed
  // to check" and "the live carts were checked and were fine" are different
  // answers and a vacuous loop below cannot tell them apart.
  if (result.waitingCount === 0) {
    console.log('           (live state present but the owner queue is EMPTY: 0 waiting. '
      + 'The projection was exercised and did not throw; the per-cart deadline/DENIED '
      + 'assertions below did NOT run against live data. Cart shape is covered by the '
      + 'fixtures above, not by this check.)');
    return;
  }

  for (const cart of result.carts) {
    assert.ok(cart.expiresAt, `${cart.title} states an expiry`);
    assert.ok(cart.deadline.length > 0, `${cart.title} states a deadline sentence`);
    assert.match(cart.doNothing, /DENIED/);
  }
  console.log(`           (live: ${result.waitingCount} waiting, ${result.cartCount} carts, ${result.lineCount} lines, `
    + `${result.carts.reduce((sum, cart) => sum + cart.ownerLineCount, 0)} traceable to his words)`);
});

// ---------------------------------------------------------------------------
// 8. WHAT IS WORTH WAKING HIM FOR. The owner asked (2026-08-12 22:04Z) for a
//    loud sound "whenever you post a question you need me to respond to". An
//    alarm is only as good as its rule, and the two ways this rule can be wrong
//    are opposite: beep at something he cannot answer, or stay silent on
//    something he can. Both are checked.
// ---------------------------------------------------------------------------

function noticePrompt(overrides = {}) {
  return {
    id: 'notice-1', kind: 'notice', title: '7 background tasks are disabled',
    message: 'For information.', createdAt: '2026-08-11T16:36:57.941Z',
    expiresAt: '2026-08-17T16:36:57.941Z', state: 'pending', defaultDecision: 'acknowledge',
    ...overrides
  };
}

function confirmationPrompt(overrides = {}) {
  return {
    id: 'confirm-1', kind: 'confirmation', title: 'Payment path: use Stripe to collect money',
    message: 'Yes or no.', createdAt: '2026-08-11T16:36:57.941Z',
    expiresAt: '2026-08-17T16:36:57.941Z', state: 'pending', defaultDecision: 'deny',
    ...overrides
  };
}

check('a notice never counts as a question, because expiry marks it read rather than denying it', () => {
  const result = view.cartView(snapshotOf([noticePrompt()]), { now: NOW });
  assert.strictEqual(result.prompts[0].needsAnswer, false);
  assert.strictEqual(result.questionCount, 0);
  // But it is still shown. Not counted is not the same as not rendered.
  assert.strictEqual(result.waitingCount, 1);
});

check('an expired question is not counted as waiting -- silence already answered it', () => {
  const dead = confirmationPrompt({ id: 'confirm-dead', expiresAt: '2026-08-01T00:00:00.000Z' });
  const result = view.cartView(snapshotOf([dead]), { now: NOW });
  assert.strictEqual(result.prompts[0].expired, true);
  assert.strictEqual(result.prompts[0].needsAnswer, false);
  assert.strictEqual(result.questionCount, 0);
  assert.strictEqual(result.expiredCount, 1);
});

check('a live cart and a live confirmation are both questions he can still answer', () => {
  const result = view.cartView(snapshotOf([purchasePrompt(), confirmationPrompt(), noticePrompt()]), { now: NOW });
  assert.strictEqual(result.questionCount, 2, 'the cart and the confirmation, not the notice');
  assert.strictEqual(result.expiredCount, 0);
});

check('SOONEST is ordered by the instant, not by how the timestamp happens to be spelled', () => {
  // Same calendar day, three spellings. Lexically '+00:00' sorts before '.500Z'
  // sorts before 'Z', which has nothing to do with which one dies first.
  const later = confirmationPrompt({ id: 'later', expiresAt: '2026-08-17T00:00:00+00:00' });
  const soonest = confirmationPrompt({ id: 'soonest', expiresAt: '2026-08-13T23:59:59.500Z' });
  const middle = confirmationPrompt({ id: 'middle', expiresAt: '2026-08-15T12:00:00Z' });
  const result = view.cartView(snapshotOf([later, soonest, middle]), { now: NOW });
  assert.strictEqual(result.soonestExpiry.promptId, 'soonest');
});

check('SOONEST skips anything already dead, and is null when everything is', () => {
  const dead = confirmationPrompt({ id: 'dead', expiresAt: '2026-08-01T00:00:00.000Z' });
  const alive = confirmationPrompt({ id: 'alive', expiresAt: '2026-08-17T16:36:57.941Z' });
  assert.strictEqual(view.cartView(snapshotOf([dead, alive]), { now: NOW }).soonestExpiry.promptId, 'alive');
  assert.strictEqual(view.cartView(snapshotOf([dead]), { now: NOW }).soonestExpiry, null);
});

// ---------------------------------------------------------------------------
// 9. THE READER THAT NEEDS NO APP BUILD -- tools/purchase-cart.js. Every probe
//    below is INJECTED. This suite never touches the real vault and never
//    reaches the speakers; what is under test is the wiring and the refusals.
// ---------------------------------------------------------------------------

const cart = require('../tools/purchase-cart.js');

check('the alert stays silent on an empty queue, so the sound keeps meaning something', () => {
  let calls = 0;
  const result = view.cartView(snapshotOf([noticePrompt()]), { now: NOW });
  const alert = cart.alertIfNeeded(result, { soundPlay: () => { calls += 1; } });
  assert.strictEqual(alert.played, false);
  assert.strictEqual(calls, 0, 'a notice must not make a noise');
  assert.match(alert.reason, /waiting for an answer/);
});

check('the alert plays the ramping alert -- the loud one -- when a question is waiting', () => {
  const played = [];
  const result = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW });
  const alert = cart.alertIfNeeded(result, { soundPlay: args => played.push(args.sound) });
  assert.strictEqual(alert.played, true);
  assert.strictEqual(alert.questionCount, 1);
  assert.deepStrictEqual(played, ['generic-ramp'], 'the progressively louder alert, not the default chime');
});

check('a speaker that fails does not take down the reading of his cart', () => {
  const result = view.cartView(snapshotOf([purchasePrompt()]), { now: NOW });
  const alert = cart.alertIfNeeded(result, { soundPlay: () => { throw new Error('no audio device'); } });
  assert.strictEqual(alert.played, false);
  assert.match(alert.reason, /still waiting/);
});

check('an unreadable vault never renders as "no card on file"', () => {
  const unknown = cart.cardStanding({ vaultRecordPresence: () => ({ present: null, readable: false, code: 'VAULT_UNREADABLE', detail: 'x' }) });
  assert.strictEqual(unknown.present, null, 'null, never false');
  assert.match(cart.cardSentence(unknown), /could not be determined/);
  const absent = cart.cardStanding({ vaultRecordPresence: () => ({ present: false, readable: true, code: 'VAULT_RECORD_ABSENT', detail: 'x' }) });
  assert.match(cart.cardSentence(absent), /No card is on file/);
  const present = cart.cardStanding({ vaultRecordPresence: () => ({ present: true, readable: true, code: 'VAULT_RECORD_PRESENT', detail: 'x' }) });
  assert.match(cart.cardSentence(present), /Nothing about it was read/);
});

check('the card probe asks about one key and is handed nothing back but a standing', () => {
  const asked = [];
  const answer = cart.cardStanding({ vaultRecordPresence: key => { asked.push(key); return { present: true, readable: true, code: 'VAULT_RECORD_PRESENT', detail: 'x' }; } });
  assert.deepStrictEqual(asked, ['payment_card_default']);
  assert.deepStrictEqual(Object.keys(answer).sort(), ['code', 'detail', 'key', 'present', 'readable']);
});

check('a vault probe that throws is unknown, not absent', () => {
  const answer = cart.cardStanding({ vaultRecordPresence: () => { throw new Error('no powershell'); } });
  assert.strictEqual(answer.present, null);
  assert.strictEqual(answer.readable, false);
});

check('an unreadable negative vault answer is unknown, not absent', () => {
  const answer = cart.cardStanding({ vaultRecordPresence: () => ({
    present: false, readable: false, code: 'VAULT_UNREADABLE', detail: 'permission denied'
  }) });
  assert.strictEqual(answer.present, null);
  assert.strictEqual(answer.readable, false);
  assert.match(cart.cardSentence(answer), /could not be determined/);
});

check('a state document without a prompts array refuses instead of projecting an empty queue', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-cart-invalid-'));
  const stateFile = path.join(directory, 'owner-public-prompts.json');
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1 }));
  try {
    assert.throws(() => cart.readQueue(stateFile), /no prompts array/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('the signed-in account is reported as unknown, never asserted', () => {
  assert.strictEqual(cart.ACCOUNT_UNKNOWN.signedIn, null, 'null, never a guessed true or false');
  assert.strictEqual(cart.ACCOUNT_UNKNOWN.readable, false);
  assert.match(cart.ACCOUNT_UNKNOWN.where, /Account/, 'it names the screen that does hold the answer');
});

check('the reader stays a pure reader: the vault and the speakers are required lazily', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'tools', 'purchase-cart.js'), 'utf8');
  // Everything before the first function declaration is module load time.
  const head = source.slice(0, source.indexOf('function '));
  assert.doesNotMatch(head, /require\(['"]\.\.\/src\/lib\/(desktop|vault-presence|runtime|audit)/,
    'a top-level require here would drag runtime + audit into every importer of readQueue');
  assert.match(source, /require\('\.\.\/src\/lib\/vault-presence\.js'\)/);
  assert.match(source, /require\('\.\.\/src\/lib\/desktop\.js'\)/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
