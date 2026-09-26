'use strict';

// Q64 owner-event ingestion tests.  The authenticator is an explicit test
// double; no production identity, owner prompt, ledger, or audit state is
// touched.  The important contract is that omitting or weakening that
// dependency fails closed before the scope store is called.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const eventContract = require('../src/lib/owner-request-scope-event');
const scopeStore = require('../src/lib/owner-request-scope-store');

const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected, `${label || ''}: expected ${expected}`);

const subjectHash = 'a'.repeat(64);
const ownerRequests = new Map([
  ['R173', { id: 'R173', verbatim: 'Owner explicitly chose the bounded global rule.' }],
  ['R174', { id: 'R174', verbatim: 'Owner explicitly chose the thread-A rule.' }]
]);

const rule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_event_r173',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded global work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: ownerRequests.get('R173').verbatim,
  ...overrides
});

const event = (overrides = {}) => ({
  schemaVersion: 1,
  eventId: 'owner_scope_r173_1',
  sourceRequestId: 'R173',
  ownerSubject: { kind: 'owner-authenticated', idHash: subjectHash },
  rule: rule(),
  ...overrides
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q64-scope-event-'));
const file = path.join(tempRoot, 'scope-rules.json');
const readOwnerRequest = id => ownerRequests.get(id);
const authenticateOwnerEvent = candidate => ({ verified: true, subjectHash: candidate.ownerSubject.idHash });
const appendScopeRule = input => scopeStore.appendScopeRule(input, { file });
const dependencies = { readOwnerRequest, authenticateOwnerEvent, appendScopeRule };

const refusingDependencies = (overrides = {}) => {
  const calls = { read: 0, authenticate: 0, append: 0 };
  return {
    calls,
    dependencies: {
      readOwnerRequest: id => {
        calls.read += 1;
        return ownerRequests.get(id);
      },
      authenticateOwnerEvent: candidate => {
        calls.authenticate += 1;
        return { verified: true, subjectHash: candidate.ownerSubject.idHash };
      },
      appendScopeRule: () => {
        calls.append += 1;
        throw new Error('the refusal test must not write');
      },
      ...overrides
    }
  };
};

try {
  // Dependency and version refusals are driven through the public ingestion
  // seam. Besides checking the error codes, call counters prove each refusal
  // happens before any read, authentication/spawn-like work, or store write.
  const missingSource = refusingDependencies({ readOwnerRequest: undefined });
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, missingSource.dependencies),
    'OWNER_SCOPE_EVENT_SOURCE_UNAVAILABLE', 'missing source reader');
  assert.deepEqual(missingSource.calls, { read: 0, authenticate: 0, append: 0 });

  const missingStore = refusingDependencies({ appendScopeRule: undefined });
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, missingStore.dependencies),
    'OWNER_SCOPE_EVENT_STORE_UNAVAILABLE', 'missing store writer');
  assert.deepEqual(missingStore.calls, { read: 0, authenticate: 0, append: 0 });

  const unsupportedVersion = refusingDependencies();
  code(() => eventContract.ingestOwnerScopeEvent({ event: event({ schemaVersion: 2 }) },
    unsupportedVersion.dependencies), 'OWNER_SCOPE_EVENT_VERSION_UNSUPPORTED', 'unsupported event version');
  assert.deepEqual(unsupportedVersion.calls, { read: 0, authenticate: 0, append: 0 });

  const normalized = eventContract.normalizeScopeEvent(event());
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.sourceRequestId, 'R173');
  assert.equal(normalized.ownerSubject.kind, 'owner-authenticated');
  assert.equal(Object.isFrozen(normalized), true);

  // A removed provider cannot remain a selectable authenticator factory. The
  // generic ingestion seam still requires an explicit current verifier.
  assert.equal(Object.hasOwn(eventContract, 'createTelegramOwnerEventAuthenticator'), false);

  const first = eventContract.ingestOwnerScopeEvent({ event: event(), expectedRevision: 0 }, dependencies);
  assert.equal(first.durable, true);
  assert.equal(first.replayed, false);
  assert.equal(first.revision, 1);
  assert.equal(first.grantsAuthority, false);
  assert.equal(scopeStore.readScopeStore({ file }).rules[0].ownerVerbatim, ownerRequests.get('R173').verbatim);

  // A fresh read plus an exact replay proves the event remains idempotent over
  // a process restart and cannot create a second rule.
  const replay = eventContract.ingestOwnerScopeEvent({ event: event() }, dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 1);
  assert.equal(scopeStore.readScopeStore({ file }).rules.length, 1);

  const threadEvent = event({
    eventId: 'owner_scope_r174_1',
    sourceRequestId: 'R174',
    rule: rule({
      ruleId: 'rule_thread_event_r174',
      scopeKind: 'thread',
      threadId: 'thread-a',
      sourceRequestId: 'R174',
      decisionSummary: 'Use the thread-A work mode.',
      evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R174'],
      ownerVerbatim: ownerRequests.get('R174').verbatim
    })
  });
  const second = eventContract.ingestOwnerScopeEvent({ event: threadEvent, expectedRevision: 1 }, dependencies);
  assert.equal(second.revision, 2);
  assert.equal(scopeStore.readScopeStore({ file }).rules.length, 2);

  code(() => eventContract.ingestOwnerScopeEvent({ event: event(), expectedRevision: 0 }, dependencies),
    'OWNER_SCOPE_STORE_REVISION_CONFLICT', 'stale scope event writer');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event({ ownerVerbatim: 'spoofed text' }) }, dependencies),
    'OWNER_SCOPE_EVENT_INVALID', 'event envelope rejects unsupported top-level fields');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event({
    rule: rule({ ownerVerbatim: 'not the owner ledger text' })
  }) }, dependencies), 'OWNER_SCOPE_EVENT_VERBATIM_MISMATCH', 'source verbatim mismatch');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event({
    rule: rule({ sourceRequestId: 'R174' })
  }) }, dependencies), 'OWNER_SCOPE_EVENT_PROVENANCE_REQUIRED', 'event/rule provenance mismatch');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, {
    ...dependencies, authenticateOwnerEvent: () => ({ verified: false, subjectHash })
  }), 'OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'unverified owner event');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, {
    ...dependencies, authenticateOwnerEvent: () => ({ verified: true, subjectHash: 'b'.repeat(64) })
  }), 'OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'wrong owner subject');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, {
    ...dependencies, authenticateOwnerEvent: undefined
  }), 'OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'missing verifier dependency');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event() }, {
    ...dependencies, readOwnerRequest: () => null
  }), 'OWNER_SCOPE_EVENT_SOURCE_INVALID', 'missing source owner request');
  code(() => eventContract.ingestOwnerScopeEvent({ event: event({
    ownerSubject: { kind: 'owner-authenticated', idHash: subjectHash },
    extra: true
  }) }, dependencies), 'OWNER_SCOPE_EVENT_INVALID', 'event shape drift');
  code(() => eventContract.normalizeScopeEvent(event({
    ownerSubject: { kind: 'agent', idHash: subjectHash }
  })), 'OWNER_SCOPE_EVENT_INVALID', 'agent subject cannot authenticate scope event');

  console.log('owner-request-scope-event tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
