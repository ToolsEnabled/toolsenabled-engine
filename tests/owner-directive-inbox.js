// EXECUTABLE CHANGE
// Assertion-discrimination report (testcanfail-tests-owner-directive-inbox-js):
// - SAME-CODE EXPECTED VALUE: VERSION, MAX_TEXT_LENGTH, and MAX_ITEMS were read
//   from the subject for both fixture/expected construction and the operation
//   being checked. Independent contract literals below make those checks able
//   to detect drift. Mutation evidence and restored-green evidence are recorded
//   beside the strengthened assertions.
//   * Mutation `const VERSION = 1` -> `const VERSION = 2` was GREEN before the
//     fix. After the fix it was RED: "AssertionError [ERR_ASSERTION] ...
//     2 !== 1" (exit 1).
//   * Mutation `const MAX_TEXT_LENGTH = 20000` -> `... = 20001` was GREEN
//     before the fix. After the fix it was RED: "Expected values to be strictly
//     equal: 20001 !== 20000" (exit 1).
//   * Mutation `const MAX_ITEMS = 500` -> `const MAX_ITEMS = 501` was GREEN
//     before the fix. After the fix it was RED: "Expected values to be strictly
//     equal: 501 !== 500" (exit 1).
//   * The subject was restored byte-for-byte (SHA-256
//     6afee9c025f740f5dc5b8134f38c3f0ac52428f565e2260d0049749244a7ca61),
//     then the test was GREEN: "Owner directive inbox tests passed." (exit 0).
// - NOT-FOUND (1): no assertion is executed only by a possibly-empty loop or
//   forEach.
// - NOT-FOUND (2): no exit-status or truthy process-return assertion is used.
// - NOT-FOUND (3): no try/catch or optional chain swallows an expected failure.
// - NOT-FOUND (4): no mock replaces the owner-directive inbox under test.
// - NOT-FOUND (5): no skip or platform precondition can turn this file into a
//   no-op.
// - FOUND-AND-FIXED (6): the three same-code expected values described above.
// - Preconditions: all met; the isolated environment and temporary filesystem
//   were available.

'use strict';

require('./lib/isolated-environment').activate('owner-directive-inbox');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inbox = require('../src/lib/owner-directive-inbox');

// These are public persistence/limit contract values, deliberately independent
// of the implementation exports. Before these assertions were added, changing
// each corresponding declaration in src/lib/owner-directive-inbox.js made the
// entire test stay green because its expected value moved with the subject.
const CONTRACT_VERSION = 1;
const CONTRACT_MAX_TEXT_LENGTH = 20000;
const CONTRACT_MAX_ITEMS = 500;

assert.equal(inbox.VERSION, CONTRACT_VERSION);
assert.equal(inbox.MAX_TEXT_LENGTH, CONTRACT_MAX_TEXT_LENGTH);
assert.equal(inbox.MAX_ITEMS, CONTRACT_MAX_ITEMS);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-directive-inbox-'));
const inboxFile = path.join(root, 'inbox.json');
const overrides = { inboxFile };

// --- append: verbatim preservation, defaults, unread by default ---------

const verbatimText = 'Ship the dashboard bridge.\nExact words matter -- "quotes", unicode: café — keep every one.';
const first = inbox.append({ text: verbatimText }, overrides);
assert.equal(first.status, 'unread');
assert.equal(first.text, verbatimText, 'directive text must be stored byte-for-byte, no trimming or rewriting');
assert.equal(first.source, 'other');
assert.equal(first.submittedBy, 'unknown');
assert.equal(first.replayed, false);
assert.equal(first.counts.unread, 1);
assert.equal(first.counts.total, 1);
assert.match(first.id, /^owner-directive-[a-f0-9-]{36}$/);

const withMeta = inbox.append({ text: 'Second directive.', source: 'dashboard', submittedBy: 'owner' }, overrides);
assert.equal(withMeta.source, 'dashboard');
assert.equal(withMeta.submittedBy, 'owner');
assert.equal(withMeta.counts.total, 2);

// --- list: oldest-first, unreadOnly default true -------------------------

const unread = inbox.list({}, overrides);
assert.equal(unread.items.length, 2);
assert.equal(unread.items[0].id, first.id, 'list() must return directives oldest-first');
assert.equal(unread.items[1].id, withMeta.id);
assert.equal(unread.counts.unread, 2);

// --- idempotencyKey: replay returns the same item, not a duplicate -------

const keyed = inbox.append({ text: 'Idempotent directive.', idempotencyKey: 'phase1-directive-1' }, overrides);
assert.equal(keyed.replayed, false);
const keyedAgain = inbox.append({ text: 'Idempotent directive (retry).', idempotencyKey: 'phase1-directive-1' }, overrides);
assert.equal(keyedAgain.replayed, true);
assert.equal(keyedAgain.id, keyed.id);
assert.equal(keyedAgain.text, 'Idempotent directive.', 'a replayed append must not overwrite the original text');
assert.equal(inbox.list({}, overrides).counts.total, 3, 'a replayed idempotency key must not create a second item');

// --- acknowledge: transitions status, is idempotent ----------------------

const acked = inbox.acknowledge({ id: first.id, by: 'controller' }, overrides);
assert.equal(acked.status, 'acknowledged');
assert.equal(acked.acknowledgedBy, 'controller');
assert.ok(Number.isSafeInteger(acked.acknowledgedAtMs));

const ackedAgain = inbox.acknowledge({ id: first.id, by: 'someone-else' }, overrides);
assert.equal(ackedAgain.acknowledgedBy, 'controller', 'acknowledging twice must not overwrite the original acker');
assert.equal(ackedAgain.acknowledgedAtMs, acked.acknowledgedAtMs);

const afterAck = inbox.list({}, overrides);
assert.equal(afterAck.items.length, 2, 'unreadOnly list must exclude the acknowledged directive');
assert.ok(!afterAck.items.some(item => item.id === first.id));

const everything = inbox.list({ unreadOnly: false }, overrides);
assert.equal(everything.items.length, 3);
assert.ok(everything.items.some(item => item.id === first.id && item.status === 'acknowledged'));

// --- acknowledge on unknown id --------------------------------------------

assert.throws(
  () => inbox.acknowledge({ id: 'owner-directive-00000000-0000-0000-0000-000000000000', by: 'controller' }, overrides),
  error => error.code === 'OWNER_DIRECTIVE_NOT_FOUND'
);

// --- status() convenience --------------------------------------------------

const statusView = inbox.status(overrides);
assert.equal(statusView.counts.unread, 2);
assert.equal(statusView.counts.acknowledged, 1);
assert.equal(statusView.counts.total, 3);

// --- validation: empty text, oversized text, bad ids, unknown fields ------

assert.throws(() => inbox.append({ text: '' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.append({ text: '   ' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.append({ text: 'x'.repeat(CONTRACT_MAX_TEXT_LENGTH + 1) }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.append({ text: 'ok', source: 'Not-Lowercase' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.append({ text: 'ok', extraField: 1 }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.acknowledge({ id: 'not-a-valid-id', by: 'controller' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INVALID');
assert.throws(() => inbox.list({ unreadOnly: 'yes' }, overrides), error => error.code === 'OWNER_DIRECTIVE_LIST_INVALID');
assert.throws(() => inbox.list({ limit: 0 }, overrides), error => error.code === 'OWNER_DIRECTIVE_LIST_INVALID');
assert.throws(() => inbox.list({ limit: 9999 }, overrides), error => error.code === 'OWNER_DIRECTIVE_LIST_INVALID');

// --- SENSITIVE heuristic backstop -----------------------------------------

assert.throws(
  () => inbox.append({ text: 'here is my token: sk-ABCDEFGHIJKLMNOPQRSTUVWX' }, overrides),
  error => error.code === 'OWNER_DIRECTIVE_LOOKS_SENSITIVE'
);
assert.throws(
  () => inbox.append({ text: '-----BEGIN PRIVATE KEY-----\nMIIBogIBAA...' }, overrides),
  error => error.code === 'OWNER_DIRECTIVE_LOOKS_SENSITIVE'
);
assert.equal(inbox.list({ unreadOnly: false }, overrides).counts.total, 3, 'a rejected sensitive-looking directive must not be stored');

// --- lock contention: a held lock refuses rather than corrupting state ----

const lockPath = `${path.resolve(inboxFile)}.lock`;
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
fs.writeFileSync(lockPath, '');
assert.throws(() => inbox.append({ text: 'blocked by lock' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INBOX_BUSY');
fs.unlinkSync(lockPath);
// The inbox must be unchanged and still readable after a refused, lock-contended attempt.
assert.equal(inbox.list({ unreadOnly: false }, overrides).counts.total, 3);

// --- lock state: contention is different from an unreadable lock ----------

fs.writeFileSync(lockPath, '');
const realStatSync = fs.statSync;
fs.statSync = function unreadableLock(candidate, ...args) {
  if (candidate === lockPath) {
    const error = new Error('simulated lock metadata read failure');
    error.code = 'EACCES';
    throw error;
  }
  return realStatSync.call(this, candidate, ...args);
};
assert.throws(
  () => inbox.append({ text: 'lock state cannot be established' }, overrides),
  error => error.code === 'OWNER_DIRECTIVE_INBOX_UNAVAILABLE',
  'an unreadable lock is unavailable, not definite lock contention'
);
fs.statSync = realStatSync;
fs.unlinkSync(lockPath);

// --- capacity: never evict an unread directive; evict oldest acknowledged -

function seedInbox(items) {
  const seeded = {
    version: CONTRACT_VERSION,
    nextSequence: items.length + 1,
    items,
    events: []
  };
  fs.writeFileSync(inboxFile, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');
}

function fabricated(index, status) {
  const atMs = 1700000000000 + index;
  return {
    id: `owner-directive-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    text: `seeded directive ${index}`,
    status,
    source: 'other',
    submittedBy: 'seed',
    idempotencyKey: null,
    createdAtMs: atMs,
    updatedAtMs: atMs,
    acknowledgedAtMs: status === 'acknowledged' ? atMs : null,
    acknowledgedBy: status === 'acknowledged' ? 'seed' : null
  };
}

// Full of unread directives only: must refuse rather than silently drop one.
seedInbox(Array.from({ length: CONTRACT_MAX_ITEMS }, (_, index) => fabricated(index, 'unread')));
assert.throws(() => inbox.append({ text: 'one more' }, overrides), error => error.code === 'OWNER_DIRECTIVE_INBOX_FULL');
assert.equal(inbox.readInbox(inboxFile).items.length, CONTRACT_MAX_ITEMS, 'a refused append must not change stored item count');

// Full with the oldest item acknowledged: must evict exactly that one to make room.
// list() bounds a single read to MAX_LIST_LIMIT (200) even though the inbox
// itself holds up to MAX_ITEMS (500), so membership checks below read the
// raw durable state directly via readInbox() rather than list()'s bounded view.
const seeded = Array.from({ length: CONTRACT_MAX_ITEMS }, (_, index) => fabricated(index, index === 0 ? 'acknowledged' : 'unread'));
seedInbox(seeded);
const afterCapacityAppend = inbox.append({ text: 'room was made' }, overrides);
assert.equal(afterCapacityAppend.replayed, false);
const postCapacityCounts = inbox.status(overrides).counts;
assert.equal(postCapacityCounts.total, CONTRACT_MAX_ITEMS, 'total count must stay bounded at MAX_ITEMS after an eviction');
assert.equal(postCapacityCounts.acknowledged, 0, 'the only acknowledged directive must have been evicted to make room');
assert.equal(postCapacityCounts.unread, CONTRACT_MAX_ITEMS, 'every unread directive from the seed plus the new one must still be present');
const postCapacityRaw = inbox.readInbox(inboxFile);
assert.ok(!postCapacityRaw.items.some(item => item.id === seeded[0].id), 'the evicted item must be the one that was acknowledged');
assert.ok(postCapacityRaw.items.some(item => item.id === afterCapacityAppend.id), 'the newly appended item must be present after eviction made room');
assert.ok(postCapacityRaw.events.some(event => event.type === 'evicted'), 'an eviction must be recorded in the durable events log');

// --- readInbox() exposes raw durable state for introspection -------------

const raw = inbox.readInbox(inboxFile);
assert.equal(raw.version, CONTRACT_VERSION);
assert.ok(Array.isArray(raw.items));

// --- malformed durable state: each validation layer refuses ---------------

// Drive readInbox through each OWNER_DIRECTIVE_INBOX_INVALID site with an
// independently malformed on-disk document.  Besides checking the typed
// exception, preserve and compare the exact bytes to prove a refused read does
// not "repair" (and thereby overwrite) evidence of durable-state corruption.
function assertInvalidDurableState(value, expectedMessage) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(inboxFile, bytes, 'utf8');
  assert.throws(
    () => inbox.readInbox(inboxFile),
    error => {
      assert.equal(error.name, 'OwnerDirectiveInboxError');
      assert.equal(error.code, 'OWNER_DIRECTIVE_INBOX_INVALID');
      assert.equal(error.message, expectedMessage);
      return true;
    }
  );
  assert.equal(fs.readFileSync(inboxFile, 'utf8'), bytes, 'a refused read must not rewrite malformed durable state');
  assert.equal(fs.existsSync(`${inboxFile}.lock`), false, 'a refused read must not leave or spawn lock-side effects');
}

const invalidMessage = 'The durable owner directive inbox is invalid.';
assertInvalidDurableState(
  { version: CONTRACT_VERSION, nextSequence: 0, items: [], events: [] },
  invalidMessage
);
assertInvalidDurableState(
  { version: CONTRACT_VERSION, nextSequence: 1, items: [{ ...fabricated(900, 'unread'), status: 'invented' }], events: [] },
  invalidMessage
);
assertInvalidDurableState(
  {
    version: CONTRACT_VERSION,
    nextSequence: 2,
    items: [],
    events: [{
      sequence: 1,
      id: fabricated(901, 'unread').id,
      type: 'invented',
      status: 'unread',
      atMs: 1700000000901
    }]
  },
  invalidMessage
);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write('Owner directive inbox tests passed.\n');
