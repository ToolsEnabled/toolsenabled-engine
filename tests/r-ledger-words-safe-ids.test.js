'use strict';

require('./helpers/isolated-state-root'); // Same guard as tests/r-ledger-agent-gate.test.js: never resolve the live state root.

/* THE WORDS DOOR MUST NOT EAT THE RECORD IT EXISTS TO PROTECT.
 *
 * 2026-09-24: `R_LEDGER_WORDS_REFUSED` refused checkpoints and filings on
 * T1812, T1821, T1867, T1888 and T1766 because their text named a commit, a
 * node or a session. Those results were never written and are lost. The cause
 * was `LONG_TOKEN_RUN` in src/lib/r-ledger-agent-gate.js: one unbroken run of
 * forty or more `[A-Za-z0-9_-]` characters holding at least one letter and one
 * digit. `-` is inside that class, so a 40-character git object id, a
 * `node-<uuid>`, a `gen-<uuid>` and a `sess-<40 hex>` are all one such run.
 *
 * What must hold, both halves in one test so neither can be loosened alone:
 *   1. Every shape the five refusals were built from now files.
 *   2. A credential shape is still refused -- provider-issued, `Bearer`, a
 *      bare `token:`/`password:` prefix, a PEM block, and an opaque
 *      high-entropy run that is NOT one of the allowed id shapes.
 *
 * Every fixture below is BUILT FROM A SHAPE. No value here is, or was, a real
 * credential: the hex is counted-out filler and the provider prefixes are
 * followed by repeated characters no scanner reads as live.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = require('../src/lib/r-ledger-agent-gate');
const patterns = require('../src/lib/secret-patterns');
const ledger = require('../src/lib/r-ledger');
const spool = require('../src/lib/owner-capture-spool');
const proposals = require('../src/lib/r-ledger-proposals');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-words-safe-ids-'));
  return { dir, opts: { rootPath: (...parts) => path.join(dir, ...parts) } };
}

function control(opts) {
  return new gate.RLedgerAgentControl({
    gate: () => ({ mode: 'auto', state: 'enabled', why: null, askWhenUnsure: false }),
    auditEnabled: () => true,
    auditRequire: () => ({ durable: true }),
    ledgerOptions: opts
  });
}

function spoolTurn(opts, threadId, text, when) {
  return spool.writeAhead(proposals.anchorFile(opts), {
    mode: 'ingress', id: null, text, interpretation: null, actor: 'owner-ingress-hook',
    source: 'codex/UserPromptSubmit', gates: [], status: null, scope: 'session',
    threadId, provenanceClass: null, proposal: null, now: new Date(when)
  });
}

// ---------------------------------------------------------------------------
// The five refusals, rebuilt from their shapes.
// ---------------------------------------------------------------------------

/* Counted-out filler, not a digest of anything: 40 lower-case hex characters
   is a git SHA-1's shape, 64 is a SHA-256's, and a v4/v7 uuid is 8-4-4-4-12. */
const SHA1 = '4b7c1e92a03f5d68be24c7a01f93d5b6e807c142';
const SHA256 = '9c3a7f01b52e6d84af19c0b73d26e5f80a4c1b937e52d6084fa31c9d7b05e6a2';
const UUID = '2b931454-9a21-4f0e-8c73-1d5e6f7a8b90';

const LEGITIMATE = Object.freeze([
  // T1812-shape: a checkpoint that names the commit it landed on.
  ['a bare 40-character git object id', `Checkpoint: the retry path landed on ${SHA1} and the suite is GREEN.`],
  // T1821-shape: a controller/node id.
  ['a node-<uuid> id', `Checkpoint: controller node-${UUID} drained its queue with nothing lost.`],
  // T1867-shape: a runtime generation id.
  ['a gen-<uuid> id', `Checkpoint: verified against the runtime generation gen-${UUID}.`],
  // T1888-shape: a session id, prefixed hex rather than a uuid.
  ['a sess-<40 hex> session id', `Filed: session sess-${SHA1} recorded the landing contract.`],
  // T1766-shape: a 64-character SHA-256 tree/content digest.
  ['a bare 64-character SHA-256 digest', `Checkpoint: the payload digest is ${SHA256}, unchanged since the cut.`]
]);

/* Shapes the same change must also let through, because the same run of
   characters is what makes them long. */
const ALSO_LEGITIMATE = Object.freeze([
  ['a bare uuid', `Run ${UUID} finished.`],
  ['a range of two object ids', `Compare ${SHA1}/${SHA1} before landing.`],
  ['an absolute file path with a line number', 'See /\x68ome/example-user/projects/integration-engine/src/lib/r-ledger-agent-gate.js:425'],
  ['a circle id (already excused elsewhere)', 'Circle tree-1a2b3c4d5e6f708192a3b4c5 acked the handoff.'],
  ['an agent id', `Agent agent-${UUID} owns the lane.`],
  ['a short commit id', 'Fix landed on commit 8f2a91c4e7b3 of the engine branch.']
]);

/* Credential shapes. None of these is a live credential: each is a known
   prefix plus repeated filler, or filler with the wrong character class to be
   one of the allowed id shapes. */
const CREDENTIAL_SHAPES = Object.freeze([
  ['a bare token: prefix', 'token: 0123456789abcdefghijklmnopqrstuvwxyz'],
  ['a bare password: prefix', 'password: hunter2 from now on'],
  ['a named token assignment', 'use apiToken=abc123def456 for the api'],
  ['a Bearer value', `Authorization: Bearer ${'ab12'.repeat(8)}`],
  ['a PEM private key block', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'],
  ['an Anthropic-prefixed key shape', `the key is sk-ant-${'A1'.repeat(20)}`],
  ['a GitHub-prefixed key shape', `the key is ghp_${'B2'.repeat(15)}`],
  /* The pre-existing fixture from tests/r-ledger-agent-gate.test.js: 48
     lower-case hex characters. It is NOT 40 and NOT 64, so it is not an object
     id's shape and must stay refused. This is the guard that keeps the
     allowlist from becoming "any lower-case hex". */
  ['lower-case hex of no id length', `the key is ${'a1'.repeat(24)}`],
  ['mixed-case high-entropy run', `the key is ${'aB3dEf9hIjKlMnOpQrStUvWxYz012345aB3dEf9h'}`],
  ['a base64 blob', `the value is ${'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbg'}`],
  /* An id with anything added is not the id. */
  ['a uuid with a credential glued to it', `node-${UUID}-${'Qx7'.repeat(14)}`],
  /* A credential beside an excused id is still a credential. */
  ['a credential standing next to a real id', `node-${UUID} used sk-ant-${'A1'.repeat(20)}`]
]);

test('the words door files engineering text that names a commit, node or session', () => {
  for (const [what, words] of [...LEGITIMATE, ...ALSO_LEGITIMATE]) {
    assert.equal(gate.looksSecretShaped(words), false, `${what} must not read as a secret: ${words}`);
  }
});

test('the words door still refuses a credential shape', () => {
  for (const [what, words] of CREDENTIAL_SHAPES) {
    assert.equal(gate.looksSecretShaped(words), true, `${what} must still be refused: ${words}`);
  }
});

test('the five refusals of 2026-09-24 now reach the ledger, and a credential shape still does not', () => {
  const { dir, opts } = sandbox();
  try {
    const control_ = control(opts);
    // The door's third judgement is verbatim against the person's turns, so
    // each fixture is spooled as a turn first: this test is about the secret
    // judgement, not about verbatim.
    let when = 0;
    for (const [, words] of LEGITIMATE) {
      spoolTurn(opts, 'sess-A', words, new Date(Date.UTC(2026, 8, 24, 20, 0, when++)).toISOString());
    }
    for (const [, words] of CREDENTIAL_SHAPES) {
      spoolTurn(opts, 'sess-A', words, new Date(Date.UTC(2026, 8, 24, 20, 0, when++)).toISOString());
    }

    const filed = [];
    for (const [what, words] of LEGITIMATE) {
      const record = control_.file({ actor: 'codex', scope: 'session', key: 'sess-A', sessionId: 'sess-A', words });
      assert.equal(record.filed, true, `${what} must file, not be refused: ${words}`);
      assert.equal(typeof record.id, 'string', `${what} must be given a ledger id`);
      filed.push(record);
    }
    assert.equal(filed.length, 5, 'all five of the lost results file');

    const standing = ledger.readLedger('session', 'sess-A', { ...opts, includeProposed: true }).entries;
    for (const [what, words] of LEGITIMATE) {
      assert.ok(standing.some(entry => entry.words === words), `${what} must be readable back out of the ledger, byte for byte`);
    }
    assert.equal(standing.length, 5, 'five rows stand, one per lost result');

    for (const [what, words] of CREDENTIAL_SHAPES) {
      assert.throws(
        () => control_.file({ actor: 'codex', scope: 'session', key: 'sess-A', sessionId: 'sess-A', words }),
        { code: 'R_LEDGER_WORDS_REFUSED', message: /password, key or token/ },
        `${what} must still be refused at the door`
      );
    }
    const after = ledger.readLedger('session', 'sess-A', { ...opts, includeProposed: true }).entries;
    assert.equal(after.length, standing.length, 'nothing refused was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the allowlist is a bounded set of shapes, excusing only a run that lies wholly inside one', () => {
  const safe = new RegExp(patterns.SAFE_IDENTIFIER_SOURCE, 'g');
  // Exactly the id, and nothing that merely looks long.
  assert.deepEqual(`node-${UUID}`.match(safe), [`node-${UUID}`]);
  assert.deepEqual(SHA1.match(safe), [SHA1]);
  assert.deepEqual(SHA256.match(safe), [SHA256]);
  assert.deepEqual(UUID.match(safe), [UUID]);
  assert.equal(`${'a1'.repeat(24)}`.match(safe), null, '48 hex characters are no id shape');
  assert.equal(`${SHA1}extra`.match(safe), null, 'an object id with anything glued on is not the id');
  assert.equal(`prefix${SHA1}`.match(safe), null);
  assert.equal(SHA1.toUpperCase().match(safe), null, 'upper-case hex is not this product\'s id shape');
  // The helper judges containment, not mere presence.
  assert.equal(patterns.matchedOutsideSafeIdentifiers(`ran ${SHA1} ok`, /[0-9a-f]{40}/g), false);
  assert.equal(patterns.matchedOutsideSafeIdentifiers(`ran ${SHA1}a ok`, /[0-9a-f]{40}/g), true);
  assert.equal(patterns.matchedOutsideSafeIdentifiers('nothing long here', /[0-9a-f]{40}/g), false);
});

test('an injected scrubber still decides, and the bare-prefix shape holds under a lenient one', () => {
  assert.equal(gate.looksSecretShaped('harmless', { scrub: () => 'changed' }), true);
  assert.equal(gate.looksSecretShaped('harmless', { scrub: value => value }), false);
  assert.equal(gate.looksSecretShaped('password: x', { scrub: value => value }), true);
  // The allowlist is not a way past an injected scrubber's judgement.
  assert.equal(gate.looksSecretShaped(`ran ${SHA1}`, { scrub: () => 'changed' }), true);
});
