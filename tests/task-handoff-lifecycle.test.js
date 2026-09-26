'use strict';

require('./helpers/isolated-state-root');

/* T1630 failing-first fixture. This is an inert store contract test: it does
 * not remove a live node, call a provider, mutate a profile, or exercise the
 * native saved-tree writer. The native producer and topology serializer are
 * separate dependencies and remain uninstalled here. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const killSwitch = require('../src/lib/kill-switch');
const fixture = require('./fixtures/task-handoff-lifecycle.fixture.json');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'task-handoff-lifecycle-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  const opts = {
    rootPath,
    needsApproval: false,
    loadSettings: () => ({ values: {} })
  };
  return {
    dir,
    opts,
    ledgerFile: rootPath('reports', 'OWNER-REQUEST-LEDGER.json'),
    historyFile: rootPath('state', 'owner-request-record-events.jsonl'),
    read: () => store.readAll({ ...opts, kinds: ['T'], includeRemoved: true, includeProposed: true }),
    raw: () => JSON.parse(fs.readFileSync(rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'))
  };
}

function seed(f) {
  const first = store.fileTask({
    scope: 'tree', key: fixture.source.nodeId,
    words: fixture.tasks[0].words, filedBy: 'builder-6'
  }, f.opts);
  store.progressTask({ id: first.id, status: 'in-progress', reason: 'The removal fixture is active.' }, f.opts);
  const second = store.fileTask({
    scope: 'tree', key: fixture.source.nodeId,
    words: fixture.tasks[1].words, filedBy: 'builder-6'
  }, f.opts);
  store.progressTask({ id: second.id, status: 'blocked-external', reason: 'The removal fixture is externally blocked.' }, f.opts);
  store.fileTask({
    scope: 'tree', key: fixture.tasks[2].scopeKey,
    words: fixture.tasks[2].words, filedBy: 'builder-6'
  }, f.opts);
  const terminal = store.fileTask({
    scope: 'tree', key: fixture.source.nodeId,
    words: fixture.tasks[3].words, filedBy: 'builder-6'
  }, f.opts);
  store.completeTask({ id: terminal.id, actor: 'builder-6' }, f.opts);
  return { first, second, terminal };
}

function registeredWriter(f, authority, calls = [], resolve = null, identityOverrides = {}, storeModule = store) {
  const engine = storeModule;
  const sourceNodeId = authority.sourceNodeId || fixture.source.nodeId;
  const sourcePreimage = authority.sourcePreimage || fixture.source.preimage;
  const topologyToken = authority.topologyToken || 'a'.repeat(64);
  const coordinatorIdentity = {
    actor: identityOverrides.actor || 'agent',
    nodeId: identityOverrides.nodeId === undefined
      ? (identityOverrides.actor === 'human' ? null : sourceNodeId)
      : identityOverrides.nodeId,
    hostSessionId: 'test-host-session',
    orgRevision: 1,
    ...identityOverrides,
  };
  const registration = engine.registerTaskLedgerWriter({
    options: { ...f.opts, taskLedgerOptions: { coordinatorIdentity } },
    principal: 'native-removal-service',
    resolveAuthority(input) {
      calls.push({ type: 'authority', input: structuredClone(input) });
      const resolved = typeof resolve === 'function' ? resolve(input) : authority;
      return {
        ...resolved,
        sourcePreimage: resolved.sourcePreimage || sourcePreimage,
        topologyToken: resolved.topologyToken || topologyToken,
      };
    },
    verifyTopologyReceipt(input) {
      calls.push({ type: 'topology', input: structuredClone(input) });
      const receipt = input.topologyReceipt;
      return receipt && receipt.durable === true
        ? { durable: true, operationId: input.operationId, sourceNodeId: input.sourceNodeId,
            ...(receipt.topologyRevision !== undefined ? { topologyRevision: receipt.topologyRevision } : {}) }
        : { durable: false };
    }
  });
  const rawWriter = engine.taskLedgerWriter(registration);
  const optionsByOperation = new Map();
  function optionsFor(input = {}) {
    const operationId = input.operationId;
    if (optionsByOperation.has(operationId)) return optionsByOperation.get(operationId);
    const reservation = Object.freeze({
      token: `test-reservation-${crypto.randomUUID()}`,
      operationId,
      sourceNodeId: input.sourceNodeId || sourceNodeId,
      parentNodeId: authority.parentNodeId ?? null,
      parentTreeId: authority.parentTreeId ?? null,
      sourcePreimageSha256: sha256(canonical(sourcePreimage)),
      topologyToken,
      orgRevision: coordinatorIdentity.orgRevision,
    });
    const options = Object.freeze({ coordinatorIdentity, reservation });
    optionsByOperation.set(operationId, options);
    return options;
  }
  const writer = Object.freeze({
    status: () => rawWriter.status(),
    prepareTaskHandoff: (input, options) => rawWriter.prepareTaskHandoff(input, options || optionsFor(input)),
    commitTaskHandoff: (input, options) => rawWriter.commitTaskHandoff(input, options || optionsFor(input)),
    finalizeTaskHandoff: (input, options) => rawWriter.finalizeTaskHandoff(input, options || optionsFor(input)),
    consumeTaskLedgerReservation: (input, options) => rawWriter.consumeTaskLedgerReservation(input, options || optionsFor(input)),
    readTaskHandoff: (operationId, options) => rawWriter.readTaskHandoff(operationId, options || { coordinatorIdentity }),
    prepareTaskOwnerGoneCleanup: (input, options) => rawWriter.prepareTaskOwnerGoneCleanup(input, options),
    commitTaskOwnerGoneCleanup: (input, options) => rawWriter.commitTaskOwnerGoneCleanup(input, options),
    finalizeTaskOwnerGoneCleanup: (input, options) => rawWriter.finalizeTaskOwnerGoneCleanup(input, options),
    readTaskOwnerGoneCleanup: (operationId, options) => rawWriter.readTaskOwnerGoneCleanup(operationId, options || { coordinatorIdentity }),
  });
  return { calls, writer, rawWriter, registration, optionsFor, coordinatorIdentity };
}

function freshOwnerRequestStore() {
  const modulePath = require.resolve('../src/lib/owner-request-store');
  delete require.cache[modulePath];
  return require(modulePath);
}

function cleanupLedgerOptions(operationId = 'owner-gone-cleanup-race-1') {
  return {
    coordinatorIdentity: { actor: 'agent', nodeId: fixture.source.nodeId, hostSessionId: 'test-host-session', orgRevision: 1 },
    reservation: {
      token: `test-cleanup-reservation-${crypto.randomUUID()}`,
      operationId,
      sourceNodeId: null,
      parentNodeId: null,
      parentTreeId: null,
      sourcePreimageSha256: null,
      topologyToken: 'a'.repeat(64),
      orgRevision: 1,
    },
  };
}

function handoffInput(overrides = {}) {
  return {
    operationId: 'remove-node-operation-1',
    sourceNodeId: fixture.source.nodeId,
    actor: 'native-removal-service',
    reason: fixture.cases[0].reason,
    ...overrides
  };
}

const POSTIMAGE_SHA256 = 'f'.repeat(64);
function commitInput(overrides = {}) {
  return handoffInput({ ...overrides, postimageSha256: overrides.postimageSha256 || POSTIMAGE_SHA256 });
}

test('registered handoff writers require host options and revoke on an inert kill marker', () => {
  const f = sandbox();
  assert.throws(() => store.registerTaskLedgerWriter({
    options: f.opts,
    principal: 'native-removal-service',
    resolveAuthority: () => ({ kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId, principal: 'native-removal-service' }),
  }), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
  assert.throws(() => store.registerTaskLedgerWriter({
    options: {
      ...f.opts,
      taskLedgerOptions: {
        coordinatorIdentity: { actor: 'agent', nodeId: fixture.source.nodeId, hostSessionId: 'test-host-session', orgRevision: 1 },
        reservation: {
          token: `unbound-registration-${crypto.randomUUID()}`,
          sourceNodeId: fixture.source.nodeId, parentNodeId: null, parentTreeId: null,
          sourcePreimageSha256: sha256(canonical(fixture.source.preimage)),
          orgRevision: 1,
        },
      },
    },
    principal: 'native-removal-service',
    resolveAuthority: () => ({ kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId, principal: 'native-removal-service' }),
  }), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
  const bundle = registeredWriter(f, {
    kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: null, topologyRevision: 'kill-switch-test',
    principal: 'native-removal-service'
  });
  assert.throws(() => bundle.rawWriter.prepareTaskHandoff(handoffInput()), {
    code: 'T_LEDGER_WRITER_POLICY_DENIED'
  });
  const prior = process.env.TOOLSENABLED_KILLSWITCH_PATH;
  process.env.TOOLSENABLED_KILLSWITCH_PATH = path.join(f.dir, 'inert-killswitch-marker');
  try {
    assert.equal(killSwitch.status().active, false);
    killSwitch.activate();
    assert.throws(() => bundle.writer.readTaskHandoff('missing-operation'), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
  } finally {
    if (prior === undefined) delete process.env.TOOLSENABLED_KILLSWITCH_PATH;
    else process.env.TOOLSENABLED_KILLSWITCH_PATH = prior;
  }
});

test('a marker written outside this process latches the writer and does not revive after the scoped path changes', () => {
  const f = sandbox();
  const bundle = registeredWriter(f, {
    kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: null, topologyRevision: 'foreign-kill-switch-test',
    principal: 'native-removal-service'
  });
  const prior = process.env.TOOLSENABLED_KILLSWITCH_PATH;
  const foreignMarker = path.join(f.dir, 'foreign-killswitch-marker');
  const clearedPath = path.join(f.dir, 'scoped-cleared-marker');
  fs.writeFileSync(foreignMarker, 'foreign process marker\n', 'utf8');
  process.env.TOOLSENABLED_KILLSWITCH_PATH = foreignMarker;
  try {
    assert.deepEqual(bundle.writer.status(), { revoked: true, reason: 'KILLSWITCH_ACTIVE' });
    // The marker remains retained; changing the test path only simulates a
    // later status read after another process cleared its own marker.
    process.env.TOOLSENABLED_KILLSWITCH_PATH = clearedPath;
    assert.deepEqual(bundle.writer.status(), { revoked: true, reason: 'KILLSWITCH_ACTIVE' });
    assert.throws(() => bundle.writer.readTaskHandoff('foreign-kill-switch-read'), {
      code: 'T_LEDGER_WRITER_POLICY_DENIED'
    });
    const replacement = registeredWriter(f, {
      kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
      parentNodeId: null, topologyRevision: 'foreign-kill-switch-replacement',
      principal: 'native-removal-service'
    });
    assert.deepEqual(replacement.writer.status(), { revoked: false, reason: null });
  } finally {
    if (prior === undefined) delete process.env.TOOLSENABLED_KILLSWITCH_PATH;
    else process.env.TOOLSENABLED_KILLSWITCH_PATH = prior;
  }
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function chainHash(previous, event) {
  const { eventSha256: _eventSha256, ...core } = event;
  return sha256(`${previous}\n${canonical(core)}`);
}

function rewriteHistory(f, mutate) {
  const genesis = sha256('owner-request-record-events:genesis');
  const events = fs.readFileSync(f.historyFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  mutate(events);
  let previous = genesis;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    event.seq = index + 1;
    event.prevSha256 = previous;
    event.eventSha256 = chainHash(previous, event);
    previous = event.eventSha256;
  }
  fs.writeFileSync(f.historyFile, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  return events;
}

function writeRaw(f, raw) {
  fs.writeFileSync(f.ledgerFile, `${JSON.stringify(raw, null, 2)}\n`);
}

test('T1630 fixture has active source tasks, a terminal source task, and an unrelated task', () => {
  const f = sandbox();
  const ids = seed(f);
  const records = f.read().records;
  assert.deepEqual(records.map(row => [row.id, row.scopeKey, row.status]), [
    [ids.first.id, fixture.source.nodeId, 'in-progress'],
    [ids.second.id, fixture.source.nodeId, 'blocked-external'],
    ['T3', 'other-node', 'open'],
    [ids.terminal.id, fixture.source.nodeId, 'done']
  ]);
});

test('verified parent handoff enumerates all active source tasks and journals one operation-wide decision', () => {
  const f = sandbox();
  const ids = seed(f);
  const calls = [];
  const { writer, rawWriter, optionsFor } = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-7', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  }, calls);

  const prepared = writer.prepareTaskHandoff(handoffInput());
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.operationId, 'remove-node-operation-1');
  assert.deepEqual(prepared.taskIds, [ids.first.id, ids.second.id]);
  assert.equal(prepared.taskCount, 2);
  assert.equal(prepared.sourceNodeId, fixture.source.nodeId);

  const committed = writer.commitTaskHandoff(commitInput({
    parentNodeId: 'node-parent', parentTreeId: 'tree-source'
  }));
  assert.equal(committed.phase, 'committed');
  assert.equal(committed.taskSetDigest, prepared.taskSetDigest);
  assert.equal(committed.taskCount, 2);
  assert.equal(committed.sourcePreimageRetained, true);
  assert.equal(committed.durable, true);
  assert.equal(committed.postimageSha256, POSTIMAGE_SHA256);
  const consumedInput = commitInput({
    parentNodeId: 'node-parent', parentTreeId: 'tree-source'
  });
  const consumedOptions = optionsFor(consumedInput);
  const consumed = writer.consumeTaskLedgerReservation(consumedInput, consumedOptions);
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.operationId, 'remove-node-operation-1');
  assert.equal(consumed.postimageSha256, POSTIMAGE_SHA256);
  assert.throws(() => writer.consumeTaskLedgerReservation(consumedInput, consumedOptions), {
    code: 'T_LEDGER_WRITER_POLICY_DENIED'
  });
  assert.throws(() => rawWriter.prepareTaskHandoff({
    ...handoffInput(), operationId: 'remove-node-reuse-consumed-token'
  }, consumedOptions), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
  const moved = f.read().records.filter(row => row.id === ids.first.id || row.id === ids.second.id);
  assert.deepEqual(moved.map(row => [row.id, row.scopeKey, row.status]), [
    [ids.first.id, 'node-parent', 'in-progress'],
    [ids.second.id, 'node-parent', 'blocked-external']
  ]);
  assert.ok(moved.every(row => row.history.some(entry => entry.kind === 'handoff')));
  assert.ok(moved.every(row => row.ownerState === 'reassigned' && row.ownerNodeId === 'node-parent'));
  assert.ok(moved.every(row => row.handoff && row.handoff.operationId === 'remove-node-operation-1'
    && row.handoff.phase === 'committed'
    && row.handoff.sourceBarrier === 'retained'
    && row.handoff.publicationState === 'uncertain'
    && row.handoff.publicationReasonCode === 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED'
    && row.handoff.destination.kind === 'verified-parent'
    && row.handoff.destination.parentNodeId === 'node-parent'
    && row.handoff.destination.parentTreeId === 'tree-source'
    && row.handoff.reason === fixture.cases[0].reason
    && row.decisions.at(-1).decision === 'handoff'
    && row.decisions.at(-1).reason === fixture.cases[0].reason));
  assert.equal(f.read().records.find(row => row.id === 'T3').scopeKey, 'other-node');

  const finalized = writer.finalizeTaskHandoff(handoffInput({
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyReceipt: { operationId: 'remove-node-operation-1', topologyRevision: 'topology-7', durable: true }
  }));
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.durable, true);
  assert.equal(finalized.sourcePreimageRetained, false);
  assert.equal(finalized.sourceTombstone, true);
  assert.equal(typeof finalized.history.eventSha256, 'string');
  assert.equal(calls.filter(row => row.type === 'authority').length, 2);
  assert.equal(calls.filter(row => row.type === 'topology').length, 1);
  const replayed = writer.finalizeTaskHandoff(handoffInput({
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyReceipt: { operationId: 'remove-node-operation-1', topologyRevision: 'topology-7', durable: true }
  }));
  assert.equal(replayed.phase, 'finalized');
  assert.equal(replayed.replayed, true);
  assert.equal(calls.filter(row => row.type === 'topology').length, 1);
  const readback = writer.readTaskHandoff('remove-node-operation-1', consumedOptions);
  assert.equal(readback.phase, 'finalized');
  assert.equal(readback.history.eventSha256, finalized.history.eventSha256);
  const confirmed = f.read().records.filter(row => row.id === ids.first.id || row.id === ids.second.id);
  assert.ok(confirmed.every(row => row.handoff && row.handoff.phase === 'finalized'
    && row.handoff.sourceBarrier === 'released'
    && row.handoff.sourceTombstone === true
    && row.handoff.publicationState === 'confirmed'
    && row.handoff.publicationReasonCode === null));
  assert.throws(() => store.fileTask({
    scope: 'tree', key: fixture.source.nodeId,
    words: 'removed sources stay fenced after finalization', filedBy: 'builder-6'
  }, f.opts), { code: 'T_LEDGER_HANDOFF_SOURCE_REMOVED' });
});

test('human coordinator completes a consumed-token finalize and replay read without an agent node', () => {
  const f = sandbox();
  seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-human-consumed',
    principal: 'native-removal-service'
  };
  const bundle = registeredWriter(f, authority, [], null, {
    actor: 'human', nodeId: null, hostSessionId: 'human-host-session'
  });
  const input = handoffInput({ operationId: 'remove-node-human-consumed' });
  bundle.writer.prepareTaskHandoff(input);
  const committed = bundle.writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const options = bundle.optionsFor(commitInput({ operationId: input.operationId }));
  const consumed = bundle.writer.consumeTaskLedgerReservation(commitInput({ operationId: input.operationId }), options);
  assert.equal(consumed.consumed, true);
  const finalized = bundle.writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }, options);
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.postimageSha256, committed.postimageSha256);
  const replay = bundle.writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }, options);
  assert.equal(replay.phase, 'finalized');
  assert.equal(replay.replayed, true);
  assert.equal(bundle.writer.readTaskHandoff(input.operationId, options).phase, 'finalized');
});

test('a same-operation reservation token swap is refused even when all topology fields match', () => {
  const f = sandbox();
  seed(f);
  const bundle = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'token-swap-causal-binding',
    principal: 'native-removal-service'
  });
  const input = handoffInput({ operationId: 'remove-node-token-swap' });
  bundle.writer.prepareTaskHandoff(input);
  const original = bundle.optionsFor(input);
  const swapped = Object.freeze({
    coordinatorIdentity: original.coordinatorIdentity,
    reservation: Object.freeze({
      ...original.reservation,
      token: `test-reservation-swap-${crypto.randomUUID()}`,
    }),
  });
  assert.throws(() => bundle.writer.commitTaskHandoff(commitInput({ operationId: input.operationId }), swapped), {
    code: 'T_LEDGER_WRITER_POLICY_DENIED'
  });
});

test('a consumed reservation stays refused after same-identity writer replacement while replay remains usable', () => {
  const f = sandbox();
  seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-cross-registration-consume',
    principal: 'native-removal-service'
  };
  const first = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-cross-registration-consume' });
  first.writer.prepareTaskHandoff(input);
  first.writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const consumedInput = commitInput({ operationId: input.operationId });
  const consumedOptions = first.optionsFor(consumedInput);
  const consumed = first.writer.consumeTaskLedgerReservation(consumedInput, consumedOptions);
  assert.equal(consumed.consumed, true);
  store.revokeTaskLedgerWriter(first.registration, 'LIFECYCLE');

  const replacement = registeredWriter(f, authority, [], null, {}, freshOwnerRequestStore());
  assert.deepEqual(replacement.coordinatorIdentity, first.coordinatorIdentity);
  assert.throws(() => replacement.writer.consumeTaskLedgerReservation(consumedInput, consumedOptions), {
    code: 'T_LEDGER_WRITER_POLICY_DENIED'
  });
  const persisted = f.raw().handoffOperations.find(operation => operation.operationId === input.operationId);
  assert.equal(persisted.consumedReservation.postimageSha256, POSTIMAGE_SHA256);
  assert.equal(persisted.consumedReservation.reservationBinding.tokenSha256,
    sha256(consumedOptions.reservation.token));
  const readback = replacement.writer.readTaskHandoff(input.operationId, consumedOptions);
  assert.equal(readback.phase, 'committed');
  const finalized = replacement.writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }, consumedOptions);
  assert.equal(finalized.phase, 'finalized');
});

test('writer revocation preserves durable unconfirmed handoff evidence', () => {
  const f = sandbox();
  const ids = seed(f);
  const bundle = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-revocation-evidence',
    principal: 'native-removal-service'
  });
  const input = handoffInput({ operationId: 'remove-node-revocation-evidence' });
  bundle.writer.prepareTaskHandoff(input);
  bundle.writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  store.revokeTaskLedgerWriter(bundle.registration, 'LIFECYCLE');
  const operation = f.raw().handoffOperations.find(row => row.operationId === input.operationId);
  assert.equal(operation.phase, 'committed');
  assert.equal(operation.sourceBarrier, 'retained');
  assert.equal(operation.sourcePreimageRetained, true);
  assert.equal(f.read().records.find(row => row.id === ids.first.id).handoff.publicationState, 'uncertain');
  assert.throws(() => bundle.writer.readTaskHandoff(input.operationId), {
    code: 'T_LEDGER_WRITER_POLICY_DENIED'
  });
});

test('verified no-parent handoff marks active tasks owner-gone without requiring target configuration', () => {
  const f = sandbox();
  const ids = seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: null, topologyRevision: 'topology-8',
    principal: 'native-removal-service'
  });
  const input = handoffInput({ reason: fixture.cases[1].reason });
  const prepared = writer.prepareTaskHandoff(input);
  assert.equal(prepared.destination.kind, 'verified-no-parent');
  assert.equal(prepared.destination.parentNodeId, null);
  const committed = writer.commitTaskHandoff(commitInput({ reason: fixture.cases[1].reason }));
  assert.equal(committed.destination.kind, 'verified-no-parent');
  assert.equal(committed.targetConfiguration, undefined);
  const rows = f.read().records.filter(row => [ids.first.id, ids.second.id].includes(row.id));
  assert.deepEqual(rows.map(row => [row.id, row.status]), [
    [ids.first.id, 'in-progress'],
    [ids.second.id, 'blocked-external']
  ]);
  assert.ok(rows.every(row => row.scopeKey === fixture.source.nodeId));
  assert.ok(rows.every(row => row.ownerState === 'owner-gone' && row.ownerNodeId === null));
  assert.ok(rows.every(row => row.decisions.some(decision => decision.ownerState === 'owner-gone')));
  assert.ok(rows.every(row => row.handoff && row.handoff.ownerState === 'owner-gone'
    && row.handoff.ownerNodeId === null
    && row.handoff.destination.kind === 'verified-no-parent'
    && row.handoff.publicationState === 'uncertain'));
});

test('unknown or unreadable authority refuses before changing the source set and retains no fake success', () => {
  const f = sandbox();
  seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'unknown', sourceNodeId: fixture.source.nodeId,
    reason: 'topology unavailable', principal: 'native-removal-service'
  });
  assert.throws(() => writer.prepareTaskHandoff(handoffInput()), { code: 'T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN' });
  assert.deepEqual(f.read().records.map(row => [row.scopeKey, row.status]), [
    [fixture.source.nodeId, 'in-progress'],
    [fixture.source.nodeId, 'blocked-external'],
    ['other-node', 'open'],
    [fixture.source.nodeId, 'done']
  ]);
  assert.equal(f.raw().handoffOperations, undefined);
});

test('same operation replays its current phase, while changed actor, destination, or task set conflicts', () => {
  const f = sandbox();
  seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-9', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  });
  const input = handoffInput();
  const prepared = writer.prepareTaskHandoff(input);
  const preparedReplay = writer.prepareTaskHandoff(input);
  assert.equal(preparedReplay.operationId, prepared.operationId);
  assert.equal(preparedReplay.phase, 'prepared');
  assert.equal(preparedReplay.durable, true);
  assert.equal(preparedReplay.replayed, true);
  assert.equal(preparedReplay.sourceNodeId, prepared.sourceNodeId);
  assert.equal(preparedReplay.taskSetDigest, prepared.taskSetDigest);
  assert.equal(preparedReplay.taskCount, prepared.taskCount);
  assert.deepEqual(preparedReplay.taskIds, prepared.taskIds);
  assert.equal(preparedReplay.sourceBarrier, 'pending');
  assert.equal(preparedReplay.sourcePreimageRetained, true);
  assert.throws(() => writer.prepareTaskHandoff({ ...input, operationId: 'remove-node-operation-2' }), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
  assert.throws(() => writer.prepareTaskHandoff({ ...input, actor: 'other-principal' }), { code: 'T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN' });
  assert.throws(() => writer.prepareTaskHandoff({ ...input, parentNodeId: 'other-parent' }), { code: 'T_LEDGER_HANDOFF_OPERATION_CONFLICT' });
  assert.throws(() => writer.commitTaskHandoff({ ...input, taskSetDigest: 'f'.repeat(64) }), { code: 'T_LEDGER_HANDOFF_OPERATION_CONFLICT' });
  const committed = writer.commitTaskHandoff(commitInput());
  const committedReplay = writer.commitTaskHandoff(commitInput());
  assert.equal(committedReplay.operationId, committed.operationId);
  assert.equal(committedReplay.phase, 'committed');
  assert.equal(committedReplay.durable, true);
  assert.equal(committedReplay.replayed, true);
  assert.equal(committedReplay.sourceNodeId, committed.sourceNodeId);
  assert.equal(committedReplay.taskSetDigest, committed.taskSetDigest);
  assert.equal(committedReplay.taskCount, committed.taskCount);
  assert.deepEqual(committedReplay.taskIds, committed.taskIds);
  assert.equal(committedReplay.sourceBarrier, 'retained');
  assert.equal(committedReplay.sourcePreimageRetained, true);
  assert.equal(committedReplay.sourceTombstone, false);
  assert.equal(committed.sourceBarrier, 'retained');
});

test('changed parent tree identity conflicts on commit and finalize replay', () => {
  const f = sandbox();
  seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-tree-replay', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-tree-replay' });
  writer.prepareTaskHandoff(input);
  const committed = writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  assert.equal(committed.phase, 'committed');
  assert.throws(() => writer.commitTaskHandoff(commitInput({
    operationId: input.operationId, parentTreeId: 'tree-other'
  })), { code: 'T_LEDGER_HANDOFF_OPERATION_CONFLICT' });
  const finalized = writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  });
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.replayed, false);
  assert.equal(writer.commitTaskHandoff(commitInput({ operationId: input.operationId })).replayed, true);
  assert.throws(() => writer.finalizeTaskHandoff({
    ...input,
    parentTreeId: 'tree-other',
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }), { code: 'T_LEDGER_HANDOFF_OPERATION_CONFLICT' });
});

test('a valid later task progress keeps the handoff projection and replay bound', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-later-progress', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-later-progress' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
    store.progressTask({ id: ids.first.id, status: 'blocked-external', reason: 'A valid progress event follows the handoff.' }, f.opts);
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.operationId, input.operationId);
  assert.equal(row.handoff.publicationState, 'uncertain');
  const replay = writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.phase, 'committed');
});

test('a restored task row cannot roll back past a later valid chain event', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-rollback-binding', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-rollback-binding' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const committedRaw = f.raw();
    store.progressTask({ id: ids.first.id, status: 'blocked-external', reason: 'The later progress is valid and chained.' }, f.opts);
  const laterRaw = f.raw();
  const restored = laterRaw.requests.findIndex(record => record.id === ids.first.id);
  laterRaw.requests[restored] = committedRaw.requests.find(record => record.id === ids.first.id);
  writeRaw(f, laterRaw);
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.operationId, null);
  assert.equal(row.handoff.publicationState, 'unknown');
  assert.throws(() => writer.commitTaskHandoff(commitInput({ operationId: input.operationId })), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  assert.throws(() => writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  assert.equal(f.raw().handoffOperations.find(operation => operation.operationId === input.operationId).phase, 'committed');
});

test('readAll and committed/finalize replay refuse an unjournalled current task core', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-core-binding', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-core-binding' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const raw = f.raw();
  const task = raw.requests.find(record => record.id === ids.first.id);
  task.verbatim = `${task.verbatim} (unjournalled mutation)`;
  writeRaw(f, raw);
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.operationId, null);
  assert.equal(row.handoff.publicationState, 'unknown');
  assert.throws(() => writer.commitTaskHandoff(commitInput({ operationId: input.operationId })), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  assert.throws(() => writer.finalizeTaskHandoff({
    ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  }), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  assert.equal(f.raw().handoffOperations.find(operation => operation.operationId === input.operationId).phase, 'committed');
});

test('readAll and receipt refuse a missing per-task handoff history binding', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-history-binding', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-history-binding' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const raw = f.raw();
  const task = raw.requests.find(record => record.id === ids.first.id);
  task.history = task.history.filter(row => row.operationId !== input.operationId);
  writeRaw(f, raw);
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.operationId, null);
  assert.equal(row.handoff.publicationState, 'unknown');
  assert.throws(() => writer.readTaskHandoff(input.operationId), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  assert.equal(f.raw().handoffOperations.find(operation => operation.operationId === input.operationId).phase, 'committed');
});

test('chain-consistent invalid verified-parent node or tree destinations project unknown', () => {
  const cases = [
    ['invalid-node', { kind: 'verified-parent', parentNodeId: 'not a safe id', parentTreeId: 'tree-source' }],
    ['empty-tree', { kind: 'verified-parent', parentNodeId: 'node-parent', parentTreeId: '' }],
    ['invalid-tree', { kind: 'verified-parent', parentNodeId: 'node-parent', parentTreeId: 'not a safe id' }]
  ];
  for (const [suffix, invalidDestination] of cases) {
    const f = sandbox();
    const ids = seed(f);
    const authority = {
      kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
      parentNodeId: 'node-parent', parentTreeId: 'tree-source',
      topologyRevision: `topology-invalid-destination-${suffix}`, targetConfiguration: { tier: 'trusted' },
      principal: 'native-removal-service'
    };
    const { writer } = registeredWriter(f, authority);
    const input = handoffInput({ operationId: `remove-node-invalid-destination-${suffix}` });
    writer.prepareTaskHandoff(input);
    writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
    const raw = f.raw();
    const operation = raw.handoffOperations.find(candidate => candidate.operationId === input.operationId);
    operation.destination = invalidDestination;
    const events = rewriteHistory(f, history => {
      const event = history.find(candidate => candidate.requestId === `handoff:${input.operationId}`
        && candidate.statusAfter === 'committed');
      event.operation.destination = invalidDestination;
      event.coreSha256 = sha256(canonical(event.operation));
    });
    const event = events.find(candidate => candidate.requestId === `handoff:${input.operationId}`
      && candidate.statusAfter === 'committed');
    operation.journal.eventSha256 = event.eventSha256;
    operation.journal.operationSha256 = event.coreSha256;
    writeRaw(f, raw);
    const row = f.read().records.find(record => record.id === ids.first.id);
    assert.equal(row.handoff.operationId, null);
    assert.equal(row.handoff.publicationState, 'unknown');
    assert.throws(() => writer.readTaskHandoff(input.operationId), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
  }
});

test('replay refuses a changed persisted source preimage or topology token', () => {
  const f = sandbox();
  seed(f);
  const sourcePreimage = { ...fixture.source.preimage };
  const authority = {
    kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: null, topologyToken: 'd'.repeat(64), sourcePreimage,
    principal: 'native-removal-service'
  };
  const first = registeredWriter(f, authority);
  const input = handoffInput({ reason: 'persist the source authority tuple before topology removal' });
  first.writer.prepareTaskHandoff(input);
  const changed = registeredWriter(f, {
    ...authority,
    topologyToken: 'e'.repeat(64),
    sourcePreimage: { ...sourcePreimage, status: 'changed' }
  });
  assert.throws(() => changed.writer.prepareTaskHandoff(input), { code: 'T_LEDGER_WRITER_POLICY_DENIED' });
});

test('query projection selects the latest journal-bound handoff for a rehomed task', () => {
  const f = sandbox();
  const ids = seed(f);
  const firstAuthority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-repeat-1', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const first = registeredWriter(f, firstAuthority);
  const firstInput = handoffInput({ operationId: 'remove-node-operation-first' });
  first.writer.prepareTaskHandoff(firstInput);
  first.writer.commitTaskHandoff(commitInput({ operationId: firstInput.operationId }));
  first.writer.finalizeTaskHandoff({ ...firstInput,
    topologyReceipt: { operationId: firstInput.operationId, durable: true, topologyRevision: 'topology-repeat-1' }
  });

  const secondAuthority = {
    kind: 'verified-parent', sourceNodeId: 'node-parent',
    parentNodeId: 'node-grandparent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-repeat-2', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const second = registeredWriter(f, secondAuthority, [], input => input.sourceNodeId === 'node-parent'
    ? secondAuthority : firstAuthority);
  const secondInput = handoffInput({
    operationId: 'remove-node-operation-second',
    sourceNodeId: 'node-parent',
    reason: 'the rehomed parent is now being removed'
  });
  second.writer.prepareTaskHandoff(secondInput);
  const preparedRows = f.read().records.filter(row => [ids.first.id, ids.second.id].includes(row.id));
  assert.ok(preparedRows.every(row => row.handoff && row.handoff.operationId === secondInput.operationId
    && row.handoff.phase === 'prepared'
    && row.handoff.publicationState === 'pending'));

  second.writer.commitTaskHandoff(commitInput({ operationId: secondInput.operationId,
    sourceNodeId: secondInput.sourceNodeId, reason: secondInput.reason }));
  const committedRows = f.read().records.filter(row => [ids.first.id, ids.second.id].includes(row.id));
  assert.ok(committedRows.every(row => row.handoff && row.handoff.operationId === secondInput.operationId
    && row.handoff.sourceNodeId === 'node-parent'
    && row.handoff.destination.parentNodeId === 'node-grandparent'
    && row.handoff.destination.parentTreeId === 'tree-source'
    && row.handoff.publicationState === 'uncertain'));
});

test('query projection refuses a finalized postimage whose journal append is missing', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-missing-journal', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-missing-journal' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  writer.finalizeTaskHandoff({ ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  });
  const finalizedDocument = f.raw();
  const historyBefore = fs.readFileSync(f.historyFile, 'utf8');
  const historyLines = historyBefore.trimEnd().split('\n');
  assert.equal(JSON.parse(historyLines.at(-1)).requestId, `handoff:${input.operationId}`);
  fs.writeFileSync(f.historyFile, historyLines.slice(0, -1).join('\n') + '\n');
  /* The actual scenario is a document published before its final chain append
     completed. Restore the intact finalized document while leaving the
     truncated chain as the only damaged artifact. */
  fs.writeFileSync(f.ledgerFile, JSON.stringify(finalizedDocument));
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.publicationState, 'unknown');
  assert.equal(row.handoff.publicationReasonCode, 'T_LEDGER_HANDOFF_PROJECTION_AMBIGUOUS');
  assert.equal(row.handoff.operationId, null);
  assert.throws(() => writer.readTaskHandoff(input.operationId), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
});

test('query projection refuses a stale postimage whose journal points at an older phase', () => {
  const f = sandbox();
  const ids = seed(f);
  const authority = {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-stale-postimage', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  };
  const { writer } = registeredWriter(f, authority);
  const input = handoffInput({ operationId: 'remove-node-stale-postimage' });
  writer.prepareTaskHandoff(input);
  writer.commitTaskHandoff(commitInput({ operationId: input.operationId }));
  const committedOperation = structuredClone(f.raw().handoffOperations.find(row => row.operationId === input.operationId));
  writer.finalizeTaskHandoff({ ...input,
    topologyReceipt: { operationId: input.operationId, durable: true, topologyRevision: authority.topologyRevision }
  });
  const raw = f.raw();
  /* A stale document postimage can survive after a later finalized event was
     already chained. Keep the committed operation's real journal intact and
     restore only that older postimage; the latest chain identity must make the
     projection unknown rather than replaying the old phase. */
  raw.handoffOperations = raw.handoffOperations.map(row => row.operationId === input.operationId ? committedOperation : row);
  fs.writeFileSync(f.ledgerFile, JSON.stringify(raw));
  const row = f.read().records.find(record => record.id === ids.first.id);
  assert.equal(row.handoff.publicationState, 'unknown');
  assert.equal(row.handoff.publicationReasonCode, 'T_LEDGER_HANDOFF_PROJECTION_AMBIGUOUS');
  assert.equal(row.handoff.operationId, null);
  assert.throws(() => writer.readTaskHandoff(input.operationId), { code: 'T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE' });
});

test('source stays admitted but blocked after a prepared handoff, so a new active task cannot appear before commit', () => {
  const f = sandbox();
  seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-10', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  });
  writer.prepareTaskHandoff(handoffInput());
  assert.throws(() => store.fileTask({
    scope: 'tree', key: fixture.source.nodeId,
    words: 'must be refused by the pending-source barrier', filedBy: 'builder-6'
  }, f.opts), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
  assert.throws(() => store.fileTask({
    scope: 'tree', key: fixture.source.nodeId, supersedes: 'T1',
    words: 'a superseding task must not bypass the barrier', filedBy: 'builder-6'
  }, f.opts), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
});

test('all-node cleanup holds even a newly enumerated source, then releases only after durable confirmation', () => {
  const f = sandbox();
  const ids = seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'verified-no-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: null, topologyRevision: 'cleanup-topology',
    principal: 'native-removal-service'
  });
  const input = {
    operationId: 'owner-gone-cleanup-race-1',
    mode: 'privacy-exit',
    reason: 'privacy cleanup on exit',
    actor: 'native-removal-service'
  };
  const taskLedgerOptions = cleanupLedgerOptions();
  const prepared = writer.prepareTaskOwnerGoneCleanup(input, taskLedgerOptions);
  assert.equal(prepared.phase, 'prepared');
  assert.throws(() => store.fileTask({
    scope: 'tree', key: 'new-source-between-enumeration-and-delete',
    words: 'new sources are held by the global cleanup barrier', filedBy: 'builder-6'
  }, f.opts), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
  const committed = writer.commitTaskOwnerGoneCleanup(input, taskLedgerOptions);
  assert.equal(committed.phase, 'committed');
  const rows = f.read().records.filter(row => [ids.first.id, ids.second.id, 'T3'].includes(row.id));
  assert.ok(rows.every(row => row.ownerState === 'owner-gone' && row.ownerNodeId === null));
  assert.deepEqual(rows.map(row => row.status), ['in-progress', 'blocked-external', 'open']);
  assert.ok(rows.every(row => row.handoff && row.handoff.destination.kind === 'owner-gone'
    && row.handoff.reason === input.reason && row.handoff.publicationState === 'uncertain'));
  assert.throws(() => store.fileTask({
    scope: 'thread', key: 'another-new-source-while-committed',
    words: 'the committed barrier still blocks unenumerated sources', filedBy: 'builder-6'
  }, f.opts), { code: 'T_LEDGER_HANDOFF_SOURCE_PENDING' });
  const sourceNodeIdsDigest = require('node:crypto').createHash('sha256')
    .update(JSON.stringify([...committed.sourceNodeIds].sort())).digest('hex');
  const finalized = writer.finalizeTaskOwnerGoneCleanup({ ...input,
    cleanupReceipt: {
      durable: true, operationId: input.operationId, mode: input.mode,
      sourceBytesAbsent: true, sourceNodeIdsDigest,
      taskSetDigest: committed.taskSetDigest, taskCount: committed.taskCount
    }
  }, taskLedgerOptions);
  assert.equal(finalized.phase, 'finalized');
  const after = store.fileTask({
    scope: 'tree', key: 'new-source-after-confirmation',
    words: 'a new source can only appear after the cleanup barrier is released', filedBy: 'builder-6'
  }, f.opts);
  assert.equal(after.id, 'T5');
});

test('uncertain topology receipt leaves the committed source barrier and tasks intact', () => {
  const f = sandbox();
  const ids = seed(f);
  const { writer } = registeredWriter(f, {
    kind: 'verified-parent', sourceNodeId: fixture.source.nodeId,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyRevision: 'topology-11', targetConfiguration: { tier: 'trusted' },
    principal: 'native-removal-service'
  });
  const input = handoffInput({ reason: 'retain source when topology publication is uncertain' });
  writer.prepareTaskHandoff(input);
  const committed = writer.commitTaskHandoff(commitInput({ reason: input.reason }));
  assert.equal(committed.phase, 'committed');
  assert.equal(committed.postimageSha256, POSTIMAGE_SHA256);
  assert.throws(() => writer.finalizeTaskHandoff({ ...input,
    parentNodeId: 'node-parent', parentTreeId: 'tree-source',
    topologyReceipt: { operationId: input.operationId, sourceNodeId: input.sourceNodeId, durable: false }
  }), { code: 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED' });
  const operation = f.raw().handoffOperations.find(row => row.operationId === input.operationId);
  assert.equal(operation.phase, 'committed');
  assert.equal(operation.sourceBarrier, 'retained');
  assert.equal(operation.sourcePreimageRetained, true);
  assert.deepEqual(f.read().records.filter(row => [ids.first.id, ids.second.id].includes(row.id))
    .map(row => [row.scopeKey, row.ownerState, row.handoff && row.handoff.publicationState]),
    [['node-parent', 'reassigned', 'uncertain'], ['node-parent', 'reassigned', 'uncertain']]);
});

test('an absent Ledger with a retained nonempty backup refuses recovery instead of creating an empty owner set', () => {
  const f = sandbox();
  seed(f);
  fs.renameSync(f.ledgerFile, path.join(f.dir, 'retained-ledger-before-missing-path.json'));
  assert.throws(() => store.readAll({ ...f.opts, kinds: ['T'], includeRemoved: true, includeProposed: true }), { code: 'R_LEDGER_RESET_PARTIAL' });
  assert.throws(() => store.ensureLedger(f.opts), { code: 'R_LEDGER_RESET_PARTIAL' });
});
