'use strict';

const assert = require('node:assert/strict');
const {
  ReadPositionError,
  buildReadResult,
  createPositionedReader,
  createSafePagingHelper
} = require('../../src/lib/agent-comms/read-position');

function recordsThrough(head) {
  return Array.from({ length: head }, (_, index) => ({ sequence: index + 1, body: `message-${index + 1}` }));
}

function pageReader(records, calls) {
  return ({ cursor, limit }) => {
    calls.push({ cursor, limit });
    const headSequence = records.length;
    const page = cursor > headSequence ? [] : records.filter(record => record.sequence > cursor).slice(0, limit);
    return {
      headSequence,
      nextCursor: page.length ? page.at(-1).sequence : cursor,
      records: page
    };
  };
}

async function testBehindReadCarriesBacklog() {
  const result = buildReadResult({
    cursor: 2,
    headSequence: 6,
    nextCursor: 4,
    records: recordsThrough(6).slice(2, 4)
  });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'PAGE_PARTIAL');
  assert.equal(result.cursor, 2);
  assert.equal(result.headSequence, 6);
  assert.equal(result.backlogCount, 4);
  assert.equal(result.caughtUp, false);
}

async function testCaughtUpReadIsEvidenced() {
  const result = buildReadResult({ cursor: 6, headSequence: 6, nextCursor: 6, records: [] });

  assert.equal(result.status, 'CAUGHT_UP');
  assert.equal(result.backlogCount, 0);
  assert.equal(result.caughtUp, true);
  assert.deepEqual(result.records, []);
}

async function testEmptyPartialCannotBeCaughtUp() {
  const result = buildReadResult({ cursor: 2, headSequence: 6, nextCursor: 2, records: [] });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'EMPTY_PAGE_BEHIND');
  assert.equal(result.backlogCount, 4);
  assert.equal(result.caughtUp, false);
  assert.throws(
    () => buildReadResult({ cursor: 2, headSequence: 6, nextCursor: 2, records: [], caughtUp: true }),
    error => error instanceof ReadPositionError && error.code === 'READ_POSITION_INVALID_ARGUMENT'
  );
}

async function testNoCursorCannotReadTheOldestPage() {
  const calls = [];
  const helper = createSafePagingHelper({ readPage: pageReader(recordsThrough(4), calls), pageSize: 2 });

  await assert.rejects(
    () => helper.read({}),
    error => error instanceof ReadPositionError && error.code === 'READ_POSITION_INVALID_ARGUMENT'
  );
  assert.equal(calls.length, 0, 'the transport must not be called with an implicit oldest-page cursor');
}

async function testPagingDrainsWithoutGapsOrDuplicates() {
  const calls = [];
  const helper = createSafePagingHelper({ readPage: pageReader(recordsThrough(7), calls), pageSize: 3 });
  const result = await helper.drain({ cursor: 0 });

  assert.equal(result.status, 'CAUGHT_UP');
  assert.equal(result.caughtUp, true);
  assert.equal(result.cursor, 7);
  assert.equal(result.headSequence, 7);
  assert.equal(result.backlogCount, 0);
  assert.equal(result.recordsRead, 7);
  assert.deepEqual(result.records.map(record => record.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(result.records.map(record => record.sequence)).size, 7);
  assert.deepEqual(calls.map(call => call.cursor), [0, 3, 6, 7]);
}

async function testCursorAheadStopsExplicitly() {
  const calls = [];
  const helper = createSafePagingHelper({ readPage: pageReader(recordsThrough(3), calls), pageSize: 2 });
  const result = await helper.drain({ cursor: 4 });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'CURSOR_AHEAD');
  assert.equal(result.caughtUp, false);
  assert.equal(result.backlogCount, 0);
  assert.equal(calls.length, 1, 'a cursor ahead of head must not trigger a paging loop');
}

async function testHeadMovementDoesNotSkipAnUndeliveredRecord() {
  const calls = [];
  const helper = createSafePagingHelper({
    pageSize: 1,
    readPage({ cursor, limit }) {
      calls.push({ cursor, limit });
      if (cursor === 0) return { headSequence: 2, nextCursor: 1, records: [{ sequence: 1, body: 'one' }] };
      if (cursor === 1) return { headSequence: 2, nextCursor: 2, records: [{ sequence: 2, body: 'two' }] };
      if (cursor === 2) return { headSequence: 3, nextCursor: 3, records: [{ sequence: 3, body: 'three' }] };
      throw new Error('UNEXPECTED_CURSOR');
    }
  });
  const result = await helper.drain({ cursor: 0 });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'HEAD_MOVED');
  assert.equal(result.cursor, 2);
  assert.equal(result.nextCursor, 2, 'the helper must not advance over a confirmation record it did not deliver');
  assert.equal(result.backlogCount, 1);
  assert.equal(result.caughtUp, false);
  assert.deepEqual(result.records.map(record => record.sequence), [1, 2]);
  assert.deepEqual(calls.map(call => call.cursor), [0, 1, 2]);
}

async function testNoncontiguousPageRefusesAdvancement() {
  const result = buildReadResult({
    cursor: 1,
    headSequence: 4,
    nextCursor: 4,
    records: [{ sequence: 2 }, { sequence: 4 }]
  });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'NONCONTIGUOUS_PAGE');
  assert.equal(result.nextCursor, 1, 'a gapped page must not advance the caller cursor');
  assert.equal(result.caughtUp, false);
}

async function testMissingReaderDependencyRefusesBeforeReading() {
  let reads = 0;
  const notAReader = () => { reads += 1; };

  assert.throws(
    () => createPositionedReader({ readPage: { call: notAReader } }),
    error => error instanceof ReadPositionError
      && error.code === 'READ_POSITION_CONFIGURATION_INVALID'
      && error.details.field === 'readPage'
  );
  assert.equal(reads, 0, 'invalid configuration must not invoke the supplied value');
}

async function testInvalidTransportPageRejectsWithoutAnotherRead() {
  const calls = [];
  const reader = createPositionedReader({
    readPage(request) {
      calls.push(request);
      return { headSequence: 2, nextCursor: 2, records: [{ sequence: 1 }] };
    }
  });

  await assert.rejects(
    reader.read({ cursor: 0 }),
    error => error instanceof ReadPositionError
      && error.code === 'READ_POSITION_PAGE_INVALID'
      && error.details.lastSequence === 1
  );
  assert.deepEqual(calls, [{ cursor: 0 }], 'an invalid page must be rejected without a follow-up read');
}

const tests = [
  testBehindReadCarriesBacklog,
  testCaughtUpReadIsEvidenced,
  testEmptyPartialCannotBeCaughtUp,
  testNoCursorCannotReadTheOldestPage,
  testPagingDrainsWithoutGapsOrDuplicates,
  testCursorAheadStopsExplicitly,
  testHeadMovementDoesNotSkipAnUndeliveredRecord,
  testNoncontiguousPageRefusesAdvancement,
  testMissingReaderDependencyRefusesBeforeReading,
  testInvalidTransportPageRejectsWithoutAnotherRead
];

Promise.all(tests.map(test => test())).then(() => {
  console.log(`read-position tests passed (${tests.length})`);
}).catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
