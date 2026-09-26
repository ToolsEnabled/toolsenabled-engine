'use strict';

const assert = require('node:assert/strict');
const {
  CompatBridgeError,
  DIRECTION,
  LEGACY_NAMESPACE,
  createCompatBridge
} = require('../../src/lib/agent-comms/compat-bridge');

function createLegacyBoard() {
  const entries = new Map();
  let writes = 0;
  return {
    getMemory({ namespace, key }) {
      return entries.get(`${namespace}\0${key}`) || null;
    },
    setMemory({ namespace, key, value, note, tags, expectedRevision }) {
      const mapKey = `${namespace}\0${key}`;
      const prior = entries.get(mapKey) || null;
      const actualRevision = prior ? prior.revision : 0;
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
        const error = new Error('revision conflict');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      writes += 1;
      const entry = { namespace, key, value, note, tags, revision: actualRevision + 1 };
      entries.set(mapKey, entry);
      return { entry, created: !prior, replayed: false };
    },
    entries,
    get writes() { return writes; }
  };
}

function fabricRecord({
  audience = { type: 'direct', agent: { agentId: 'old-reader', machineId: 'machine-b' } },
  body = 'status is ready',
  id = 'direct:@machine-b/old-reader:1'
} = {}) {
  return {
    sequence: 1,
    appendedAtMs: 50,
    message: {
      id,
      sender: { agentId: 'new-sender', machineId: 'machine-a' },
      audience,
      sequence: 1,
      causalParent: null,
      kind: 'ask',
      body,
      issuedAt: 40
    }
  };
}

function bridgeFor({ records, legacyBoard, sensitiveDetector, channelMembers, now = () => 100, readFabric }) {
  return createCompatBridge({
    readFabric: readFabric || function readFixture({ channelId, afterSequence }) {
      assert.equal(channelId, 'team');
      assert.equal(afterSequence, 0);
      return { channelId, status: 'OK', records };
    },
    legacyBoard,
    ...(sensitiveDetector ? { sensitiveDetector } : {}),
    ...(channelMembers ? { channelMembers } : {}),
    now
  });
}

function expectRefusal(code, action, legacyBoard) {
  assert.throws(action, error => error instanceof CompatBridgeError && error.code === code);
  assert.equal(legacyBoard.writes, 0, `${code} must refuse before writing`);
}

function testFabricMessageVisibleToOldReader() {
  const legacyBoard = createLegacyBoard();
  const bridge = bridgeFor({ records: [fabricRecord()], legacyBoard });

  const result = bridge.carry({ channelId: 'team' });

  assert.equal(result.direction, DIRECTION);
  assert.equal(result.carried.length, 1);
  assert.equal(result.alreadyCarried.length, 0);
  const entry = legacyBoard.getMemory({ namespace: LEGACY_NAMESPACE, key: result.carried[0].key });
  assert.ok(entry);
  assert.match(entry.key, /^message\/old-reader\/compat-[a-f0-9]{64}$/);
  assert.equal(entry.value.body, 'status is ready');
  assert.equal(entry.value.bridge.direction, DIRECTION);
  assert.equal(entry.value.recipient.agentId, 'old-reader');
}

function testOldBoardWriteCannotBecomeFabricMessage() {
  const legacyBoard = createLegacyBoard();
  const fabricRecords = [];
  const bridge = bridgeFor({ records: fabricRecords, legacyBoard });

  legacyBoard.setMemory({
    namespace: LEGACY_NAMESPACE,
    key: 'message/new-sender/old-board-only',
    value: { body: 'old board write' },
    note: 'legacy only',
    tags: ['legacy'],
    expectedRevision: 0
  });
  const result = bridge.carry({ channelId: 'team' });

  assert.equal(result.carried.length, 0);
  assert.equal(fabricRecords.length, 0);
  assert.equal(typeof bridge.send, 'undefined');
  assert.equal(typeof bridge.post, 'undefined');
}

function testCredentialShapedContentIsRefused() {
  const legacyBoard = createLegacyBoard();
  const bridge = bridgeFor({
    records: [fabricRecord({ body: 'api_key=<redacted>' })],
    legacyBoard
  });

  assert.throws(
    () => bridge.carry({ channelId: 'team' }),
    error => error instanceof CompatBridgeError && error.code === 'COMPAT_BRIDGE_CREDENTIAL_SHAPED'
  );
  assert.equal(legacyBoard.writes, 0);
}

function testIndeterminateCredentialCheckIsRefused() {
  const legacyBoard = createLegacyBoard();
  const bridge = bridgeFor({
    records: [fabricRecord()],
    legacyBoard,
    sensitiveDetector: () => undefined
  });

  assert.throws(
    () => bridge.carry({ channelId: 'team' }),
    error => error instanceof CompatBridgeError && error.code === 'COMPAT_BRIDGE_SENSITIVE_DETECTOR_FAILED'
  );
  assert.equal(legacyBoard.writes, 0);
}

function testAlreadyCarriedMessageIsNotDuplicated() {
  const legacyBoard = createLegacyBoard();
  const bridge = bridgeFor({ records: [fabricRecord()], legacyBoard });

  const first = bridge.carry({ channelId: 'team' });
  const second = bridge.carry({ channelId: 'team' });

  assert.equal(first.carried.length, 1);
  assert.equal(second.carried.length, 0);
  assert.equal(second.alreadyCarried.length, 1);
  assert.equal(legacyBoard.writes, 1);
  assert.equal(legacyBoard.entries.size, 1);
}

function testInvalidConfigurationAndArgumentsRefuseBeforeEffects() {
  const legacyBoard = createLegacyBoard();
  expectRefusal('COMPAT_BRIDGE_CONFIGURATION_INVALID', () => createCompatBridge({
    readFabric: null,
    legacyBoard
  }), legacyBoard);

  const bridge = bridgeFor({ records: [], legacyBoard });
  expectRefusal('COMPAT_BRIDGE_ARGUMENT_INVALID', () => bridge.carry({ channelId: '../team' }), legacyBoard);
  expectRefusal('COMPAT_BRIDGE_ARGUMENT_INVALID', () => bridge.carry({ channelId: 'team', afterSequence: -1 }), legacyBoard);
}

function testReadAndRecordRefusalsHaveNoWrites() {
  for (const [code, readFabric] of [
    ['COMPAT_BRIDGE_FABRIC_READ_FAILED', () => { throw new Error('offline'); }],
    ['COMPAT_BRIDGE_FABRIC_READ_INVALID', () => Promise.resolve({ records: [] })],
    ['COMPAT_BRIDGE_FABRIC_READ_INVALID', () => ({ records: null })],
    ['COMPAT_BRIDGE_FABRIC_RECORD_INVALID', () => ({ records: [{ sequence: 1, message: { nope: true } }] })]
  ]) {
    const legacyBoard = createLegacyBoard();
    const bridge = bridgeFor({ legacyBoard, readFabric });
    expectRefusal(code, () => bridge.carry({ channelId: 'team' }), legacyBoard);
  }
}

function testClockAndChannelRefusalsHaveNoWrites() {
  const channelRecord = fabricRecord({ audience: { type: 'channel', name: 'workers' } });
  for (const [code, options] of [
    ['COMPAT_BRIDGE_CLOCK_INVALID', { now: () => NaN }],
    ['COMPAT_BRIDGE_CHANNEL_RESOLVER_REQUIRED', {}],
    ['COMPAT_BRIDGE_CHANNEL_RESOLUTION_FAILED', { channelMembers: () => { throw new Error('directory down'); } }],
    ['COMPAT_BRIDGE_CHANNEL_RESOLUTION_FAILED', { channelMembers: () => 'not-an-array' }],
    ['COMPAT_BRIDGE_LEGACY_RECIPIENT_AMBIGUOUS', { channelMembers: () => [
      { agentId: 'same-reader', machineId: 'machine-a' },
      { agentId: 'same-reader', machineId: 'machine-b' }
    ] }]
  ]) {
    const legacyBoard = createLegacyBoard();
    const bridge = bridgeFor({ records: [channelRecord], legacyBoard, ...options });
    expectRefusal(code, () => bridge.carry({ channelId: 'team' }), legacyBoard);
  }
}

function testLegacyReadWriteAndCollisionRefusals() {
  {
    const legacyBoard = createLegacyBoard();
    legacyBoard.getMemory = () => { throw new Error('unreadable'); };
    const bridge = bridgeFor({ records: [fabricRecord()], legacyBoard });
    expectRefusal('COMPAT_BRIDGE_LEGACY_READ_FAILED', () => bridge.carry({ channelId: 'team' }), legacyBoard);
  }
  {
    const legacyBoard = createLegacyBoard();
    legacyBoard.setMemory = () => { throw new Error('disk full'); };
    const bridge = bridgeFor({ records: [fabricRecord()], legacyBoard });
    expectRefusal('COMPAT_BRIDGE_LEGACY_WRITE_FAILED', () => bridge.carry({ channelId: 'team' }), legacyBoard);
  }
  {
    const legacyBoard = createLegacyBoard();
    legacyBoard.getMemory = () => ({ value: { bridge: { fingerprint: 'somebody-elses' } } });
    const bridge = bridgeFor({ records: [fabricRecord()], legacyBoard });
    expectRefusal('COMPAT_BRIDGE_LEGACY_KEY_COLLISION', () => bridge.carry({ channelId: 'team' }), legacyBoard);
  }
}

function testConcurrentMatchingWriteIsReportedAlreadyCarried() {
  const legacyBoard = createLegacyBoard();
  let concurrent = null;
  legacyBoard.getMemory = () => concurrent;
  legacyBoard.setMemory = input => {
    concurrent = { value: input.value };
    const error = new Error('lost race');
    error.code = 'MEMORY_REVISION_CONFLICT';
    throw error;
  };
  const result = bridgeFor({ records: [fabricRecord()], legacyBoard }).carry({ channelId: 'team' });
  assert.deepEqual({ carried: result.carried.length, alreadyCarried: result.alreadyCarried.length }, {
    carried: 0,
    alreadyCarried: 1
  });
  assert.equal(legacyBoard.writes, 0);
}

const tests = [
  testFabricMessageVisibleToOldReader,
  testOldBoardWriteCannotBecomeFabricMessage,
  testCredentialShapedContentIsRefused,
  testIndeterminateCredentialCheckIsRefused,
  testAlreadyCarriedMessageIsNotDuplicated,
  testInvalidConfigurationAndArgumentsRefuseBeforeEffects,
  testReadAndRecordRefusalsHaveNoWrites,
  testClockAndChannelRefusalsHaveNoWrites,
  testLegacyReadWriteAndCollisionRefusals,
  testConcurrentMatchingWriteIsReportedAlreadyCarried
];

for (const test of tests) test();
console.log(`compat-bridge tests passed (${tests.length})`);
