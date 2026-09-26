'use strict';
/* THE CAUSE CHAIN RENDERER MUST NOT PRINT A THROWN VALUE'S CONTENT.
 *
 * This is one level below the signing-key refusal, and it is about every
 * producer at once. `causeChain()` walks `error.cause` and renders each link
 * with `safeError()`, which fell back to `String(cursor)` when a link had no
 * string message. `String()` is the identity function for a primitive, so ANY
 * error anywhere in this product whose chain carries a raw primitive wrote that
 * primitive's content into the audit error entry. The signing-key path is only
 * where it was found.
 *
 * Fixing the RENDERER fixes every producer. Fixing producers one at a time is
 * the "leaving the twin behind" mistake at scale.
 *
 * MEASURED before the fix, at these bytes, through the returned status of
 * `audit.record`:
 *
 *   "cause":[{"message":"vault refused"},{"message":"<the stand-in>"}]
 *
 * `redact()` does not save it: its patterns match PEM blocks, bearer tokens and
 * `key = value` shapes, so an opaque value with none of that framing passes
 * through unchanged.
 *
 * SECRETS: the value used here is a STAND-IN. It is not a key, is not derived
 * from one, and resembles no real credential. It exists only so that a leak is
 * visible; asserting on it is the only reason this file names a "value" at all.
 *
 * ASSERTS BY CALLING, PINS NO SPELLING: the expected type word is computed as
 * `typeof` in the test rather than written down, and nothing here requires a
 * particular sentence, separator or bound.
 *
 *   node --test tests/audit-cause-chain-rendering.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const STANDIN = 'W65STANDIN-ROUTE3-NOT-A-REAL-SECRET-9vt4b';

function harness(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-chain-${label}-`));
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), clock: () => 1000 });
  let nextId = 0;
  const reports = [];
  const dependencies = {
    store,
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `chain-${String(++nextId).padStart(8, '0')}`,
    clock: () => 1000 + nextId,
    reportError: message => reports.push(message),
    anchorStore: (() => { let value = null; return { get: () => value, set(next) { value = next; } }; })(),
    signer: undefined
  };
  return {
    dependencies, reports, dir,
    close() { try { store.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  };
}

// A real product surface, reached by calling with values: record() catches the
// failure and returns a status whose errors[] were built by errorEntry(), which
// is exactly where causeChain() renders.
function recordWith(label, thrownByVault) {
  audit.resetForTests();
  const harnessed = harness(label);
  try {
    const status = audit.record('chain.event', 'safe-target', {}, {
      ...harnessed.dependencies,
      getSecret: () => { const error = new Error('not configured'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; },
      getOrCreateSecret: () => { throw thrownByVault; }
    });
    return { rendered: JSON.stringify(status.errors), errors: status.errors, reports: harnessed.reports.join('\n') };
  } finally { harnessed.close(); }
}

test('a raw primitive carried one link down a cause chain is rendered by type, never by content', () => {
  const carrier = new Error('vault refused', { cause: STANDIN });
  const { rendered } = recordWith('primitive', carrier);

  assert.ok(!rendered.includes(STANDIN),
    `a cause link's content must never be rendered into the audit error entry; got: ${rendered}`);
  // The other half: something content-free must still be said, or a mutation
  // that removed the chain entirely would satisfy the assertion above.
  assert.ok(rendered.includes(typeof STANDIN),
    `the unrenderable link must be named by its type (expected the word ${typeof STANDIN}); got: ${rendered}`);
  // The describable link above it is still relayed -- this must not turn into
  // "render nothing", which would undo the diagnosability the chain exists for.
  assert.ok(rendered.includes('vault refused'),
    `a link that HAS a string message must still be relayed; got: ${rendered}`);
});

test('a link whose toString returns content is rendered by type, never by content', () => {
  const hostile = { toString() { return STANDIN; } };
  const { rendered } = recordWith('hostile', new Error('vault refused', { cause: hostile }));

  assert.ok(!rendered.includes(STANDIN),
    `a link's toString must never decide what is rendered; got: ${rendered}`);
  assert.ok(rendered.includes(typeof hostile),
    `the unrenderable link must be named by its type (expected the word ${typeof hostile}); got: ${rendered}`);
});

test('a cyclic cause chain terminates and still leaks nothing', () => {
  const first = new Error('first link');
  const second = new Error('second link', { cause: STANDIN });
  first.cause = second;
  second.cause = first;
  const { rendered } = recordWith('cycle', new Error('vault refused', { cause: first }));

  // Reaching this line at all is half the assertion: a renderer that did not
  // bound its walk would not return.
  assert.ok(rendered.length > 0, 'a cyclic chain must still produce an entry');
  assert.ok(!rendered.includes(STANDIN),
    `a cycle must not smuggle a link's content through; got: ${rendered}`);
});

// A primitive can only ever be the LAST link, because a primitive has no
// `.cause` to continue from. So "deep" and "leaks" are two different questions
// and this case asks both separately rather than pretending one construction
// answers both. Putting the stand-in at depth three also stops the leak half
// passing merely because the walk's bound cut before reaching it.
test('a primitive below the first link is still typed, and a long chain stays bounded', () => {
  const deepPrimitive = new Error('first link', { cause: new Error('second link', { cause: STANDIN }) });
  const typed = recordWith('deep-primitive', new Error('vault refused', { cause: deepPrimitive }));
  assert.ok(!typed.rendered.includes(STANDIN),
    `depth is not a defence: a primitive below the first link must still be typed; got: ${typed.rendered}`);
  assert.ok(typed.rendered.includes(typeof STANDIN),
    `the unrenderable link must be named by its type; got: ${typed.rendered}`);

  let chain = new Error('deepest link');
  for (let index = 0; index < 40; index += 1) chain = new Error(`link ${index}`, { cause: chain });
  const bounded = recordWith('deep-chain', new Error('vault refused', { cause: chain }));
  assert.ok(bounded.rendered.length < 20000,
    `the rendered chain must stay bounded; it was ${bounded.rendered.length} characters`);
});

// A LIVE REFERENCE IS NOT A SNAPSHOT.
//
// "The message is read exactly once" is a property of the DECISION, not a
// guarantee about what a later reader sees. If the thrown object is attached as
// a live reference, every consumer that walks `.cause` re-reads it -- and the
// renderer is one of those consumers, so its own read is the later read. No
// change to the renderer can fix that; only freezing the value where the
// foreign object is attached can.
//
// MEASURED before the attach-time snapshot: the refusal message carried the
// first read's ordinary prose while the rendered chain carried the second
// read's content, with the getter's counter reaching three through record().
//
// Both halves are asserted. "The later content is absent" alone would be
// satisfied by a change that dropped the chain entirely, which would undo the
// diagnosability this whole file exists for.
test('a cause whose message changes between reads cannot put a later read into the chain', () => {
  const FIRST_READ = 'the vault refused for an ordinary reason';
  let reads = 0;
  const changing = {};
  Object.defineProperty(changing, 'message', {
    get() { reads += 1; return reads === 1 ? FIRST_READ : STANDIN; },
    enumerable: true
  });

  const { rendered, errors } = recordWith('changing-getter', changing);

  assert.ok(!rendered.includes(STANDIN),
    `a later read of a cause's message must not reach the rendered chain; got: ${rendered}`);
  // Asserted on the chain entry itself, not on the rendered JSON as a whole:
  // the outer refusal message also carries the first read's text (it is built
  // from the same `reason`), so checking `rendered.includes(FIRST_READ)` alone
  // is satisfied by that outer text even if the chain below it is dropped
  // entirely. Reading `cause[0].message` directly is the only way this half
  // can fail when the attach-time snapshot is removed.
  assert.strictEqual(errors[0].cause && errors[0].cause[0] && errors[0].cause[0].message, FIRST_READ,
    `the chain's own first entry -- not just the outer message -- must carry the first read; got: ${JSON.stringify(errors[0])}`);
});
