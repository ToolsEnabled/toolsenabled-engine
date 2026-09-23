'use strict';

// Q64 persistence tests use only a private temporary directory.  They do not
// touch the production state directory, owner ledger, audit ledger, task
// store, provider, browser, or launch boundary.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/lib/owner-request-scope-store');

const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected,
  `${label || ''}: expected ${expected}`);

const baseRule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_r173',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded controller work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'global or thread rules must be explicit.',
  ...overrides
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q64-scope-'));
const file = path.join(tempRoot, 'scope-rules.json');
try {
  const empty = store.readScopeStore({ file });
  assert.deepEqual(empty, { schemaVersion: 1, revision: 0, rules: [] });
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.rules), true);

  // Name the negative/unknown distinction explicitly: ENOENT establishes that
  // no store exists, while a path that cannot be read as a store must never be
  // rendered as the same definite empty-store answer.
  const unreadableAsStore = path.join(tempRoot, 'not-a-readable-store');
  fs.mkdirSync(unreadableAsStore);
  code(() => store.readScopeStore({ file: unreadableAsStore }),
    'OWNER_SCOPE_STORE_UNAVAILABLE',
    'could not establish store contents is not the definite negative "store did not exist"');

  const first = store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 0 }, { file });
  assert.equal(first.revision, 1);
  assert.equal(first.replayed, false);
  assert.equal(first.durable, true);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock must be released');

  // A fresh read is the restart-survival proof for this isolated store.
  const afterRestart = store.readScopeStore({ file });
  assert.equal(afterRestart.revision, 1);
  assert.equal(afterRestart.rules[0].ruleId, 'rule_global_r173');
  assert.equal(afterRestart.rules[0].sourceRequestId, 'R173');

  const replay = store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 1 }, { file });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 1);
  assert.equal(store.readScopeStore({ file }).rules.length, 1);

  const threadRule = baseRule({
    ruleId: 'rule_thread_r174',
    scopeKind: 'thread',
    threadId: 'thread-a',
    sourceRequestId: 'R174',
    decisionSummary: 'Only thread A receives this narrower rule.',
    ownerVerbatim: 'this rule is only for thread A.'
  });
  const second = store.appendScopeRule({ rule: threadRule, ownerEventRef: 'R174', expectedRevision: 1 }, { file });
  assert.equal(second.revision, 2);
  assert.equal(store.readScopeStore({ file }).rules.length, 2);

  const dottedRule = baseRule({
    ruleId: 'rule_dotted_r133_1',
    sourceRequestId: 'R133.1',
    decisionSummary: 'Preserve the historical dotted request id.'
  });
  const third = store.appendScopeRule({ rule: dottedRule, ownerEventRef: 'R133.1', expectedRevision: 2 }, { file });
  assert.equal(third.revision, 3);
  assert.equal(store.readScopeStore({ file }).rules[2].sourceRequestId, 'R133.1');

  code(() => store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R173', expectedRevision: 0 }, { file }), 'OWNER_SCOPE_STORE_REVISION_CONFLICT', 'stale writer');
  code(() => store.appendScopeRule({ rule: threadRule, ownerEventRef: 'R173', expectedRevision: 3 }, { file }), 'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'wrong owner event');
  code(() => store.appendScopeRule({ rule: baseRule({ decisionSummary: 'different payload' }), ownerEventRef: 'R173', expectedRevision: 3 }, { file }), 'OWNER_SCOPE_STORE_AMBIGUOUS', 'conflicting replay');
  code(() => store.appendScopeRule({ rule: baseRule(), ownerEventRef: 'R174', expectedRevision: 3 }, { file }), 'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'source/event mismatch');
  code(() => store.appendScopeRule({ rule: dottedRule, ownerEventRef: 'R133.0', expectedRevision: 3 }, { file }), 'OWNER_SCOPE_STORE_PROVENANCE_REQUIRED', 'invalid dotted owner event');

  // The store does not guess a schema or migrate legacy ledger-shaped JSON.
  fs.writeFileSync(file, JSON.stringify({ requests: [] }), 'utf8');
  code(() => store.readScopeStore({ file }), 'OWNER_SCOPE_STORE_INVALID', 'legacy shape refusal');
  fs.writeFileSync(file, '{not-json', 'utf8');
  code(() => store.readScopeStore({ file }), 'OWNER_SCOPE_STORE_INVALID', 'tampered JSON refusal');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, rules: [baseRule(), baseRule()] }), 'utf8');
  code(() => store.readScopeStore({ file }), 'OWNER_SCOPE_STORE_AMBIGUOUS', 'duplicate stored rule refusal');

  code(() => store.appendScopeRule({ rule: baseRule({ decisionSummary: 'api_key=not-a-secret' }), ownerEventRef: 'R173' }, { file }), 'OWNER_SCOPE_INVALID', 'secret-shaped rule refusal');
  code(() => store.appendScopeRule({ rule: baseRule() }, { file }), 'OWNER_SCOPE_STORE_INVALID', 'missing provenance');
  code(() => store.readScopeStore({ file: path.join(tempRoot, 'missing', 'scope.json'), extra: true }), 'OWNER_SCOPE_STORE_INVALID', 'option drift');

  // THE REVIEWED-CORPUS WATERMARK.
  //
  // The rules a review produces do not say what the review READ. Without that,
  // a request recorded after the review is indistinguishable from one the
  // reviewers saw and withheld, and gets treated as withheld -- which is how a
  // single classification run became an expiry date on the owner's voice.
  const watermarkFile = path.join(tempRoot, 'watermark-scope-rules.json');
  const sha256 = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const imported = store.replaceScopeRulesFromReviewedProposal({
    rules: [baseRule({ ruleId: 'rule_r10_gate_001', ruleKey: 'request.r10.gate.001', sourceRequestId: 'R10' })],
    expectedRevision: 0,
    expectedStoreSha256: sha256('absent'),
    proposalSha256: 'a'.repeat(64),
    reviewedLedgerRevision: 965,
    reviewedRequestIds: ['R10', 'R11']
  }, { file: watermarkFile });
  assert.equal(imported.reviewedLedgerRevision, 965);
  assert.equal(imported.reviewedRequestCount, 2);
  const watermarked = store.readScopeStore({ file: watermarkFile });
  assert.equal(watermarked.reviewedLedgerRevision, 965);
  assert.deepEqual(watermarked.reviewedRequestIds, ['R10', 'R11']);
  assert.equal(Object.isFrozen(watermarked.reviewedRequestIds), true);

  // An ordinary append adds a rule; it does not widen what anybody read, and it
  // must not silently drop the watermark and re-arm the bug.
  store.appendScopeRule({
    rule: baseRule({ ruleId: 'rule_r11_gate_001', ruleKey: 'request.r11.gate.001', sourceRequestId: 'R11' }),
    ownerEventRef: 'R11'
  }, { file: watermarkFile });
  const afterAppend = store.readScopeStore({ file: watermarkFile });
  assert.equal(afterAppend.revision, 2);
  assert.equal(afterAppend.rules.length, 2);
  assert.equal(afterAppend.reviewedLedgerRevision, 965);
  assert.deepEqual(afterAppend.reviewedRequestIds, ['R10', 'R11']);

  // Widening the corpus is a real change even when the rules are byte-identical,
  // so it must be written rather than reported as an idempotent replay.
  const appendedRaw = fs.readFileSync(watermarkFile, 'utf8');
  const widened = store.replaceScopeRulesFromReviewedProposal({
    rules: afterAppend.rules,
    expectedRevision: 2,
    expectedStoreSha256: sha256(appendedRaw),
    proposalSha256: 'b'.repeat(64),
    reviewedLedgerRevision: 970,
    reviewedRequestIds: ['R10', 'R11', 'R12']
  }, { file: watermarkFile });
  assert.equal(widened.replayed, false, 'a wider corpus over identical rules is not a replay');
  assert.equal(widened.revision, 3);
  assert.equal(store.readScopeStore({ file: watermarkFile }).reviewedLedgerRevision, 970);

  // The reviewed-import path is the only place that can honestly state which
  // corpus was read, so it may not decline to state it, or state half of it.
  const widenedRaw = fs.readFileSync(watermarkFile, 'utf8');
  const importWithout = extra => () => store.replaceScopeRulesFromReviewedProposal({
    rules: [], expectedRevision: 3, expectedStoreSha256: sha256(widenedRaw), proposalSha256: 'c'.repeat(64), ...extra
  }, { file: watermarkFile });
  code(importWithout({}), 'OWNER_SCOPE_STORE_INVALID', 'reviewed import without a watermark');
  code(importWithout({ reviewedLedgerRevision: 971 }), 'OWNER_SCOPE_STORE_INVALID', 'reviewed import with half a watermark');
  code(importWithout({ reviewedLedgerRevision: 971, reviewedRequestIds: ['R10', 'R10'] }), 'OWNER_SCOPE_STORE_AMBIGUOUS', 'duplicate reviewed ids');
  code(importWithout({ reviewedLedgerRevision: 971, reviewedRequestIds: ['not-an-id'] }), 'OWNER_SCOPE_STORE_INVALID', 'non-request reviewed id');

  // Stores written before the watermark existed must keep loading unchanged;
  // the projection treats an absent watermark as absent knowledge.
  fs.writeFileSync(watermarkFile, JSON.stringify({ schemaVersion: 1, revision: 4, rules: [baseRule()] }), 'utf8');
  const legacy = store.readScopeStore({ file: watermarkFile });
  assert.equal(legacy.revision, 4);
  assert.equal(Object.hasOwn(legacy, 'reviewedLedgerRevision'), false);
  assert.deepEqual(store.reviewedWatermarkOf(legacy), {});
  fs.writeFileSync(watermarkFile, JSON.stringify({ schemaVersion: 1, revision: 4, reviewedRequestIds: ['R10'], rules: [] }), 'utf8');
  code(() => store.readScopeStore({ file: watermarkFile }), 'OWNER_SCOPE_STORE_INVALID', 'stored half-watermark refusal');

  console.log('owner-request-scope-store: 49 checks passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
