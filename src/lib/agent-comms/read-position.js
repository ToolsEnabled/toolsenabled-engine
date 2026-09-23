'use strict';

// Positioned reads make progress (and lack of progress) explicit.  A caller
// supplies the sequence it has already processed; the transport supplies a
// snapshot head and one contiguous page.  `caughtUp` is derived here, never
// accepted from a caller or transport as an assertion.

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_PAGE_SIZE = 100_000;

class ReadPositionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReadPositionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ReadPositionError(code, message, details);
}

function plainObject(value, label, code = 'READ_POSITION_INVALID_ARGUMENT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function exactKeys(value, allowed, label, code = 'READ_POSITION_INVALID_ARGUMENT') {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} fields are invalid.`, { field: label });
  }
}

function requiredKeys(value, required, allowed, label, code = 'READ_POSITION_INVALID_ARGUMENT') {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${label} requires ${key}.`, { field: key });
  }
  const actual = Object.keys(value);
  if (actual.some(key => !allowed.includes(key))) {
    fail(code, `${label} contains an unsupported field.`, { field: label });
  }
}

function nonNegativeInteger(value, label, { maximum = MAX_SEQUENCE, code = 'READ_POSITION_INVALID_ARGUMENT' } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, `${label} must be a non-negative safe integer.`, { field: label, maximum });
  }
  return value;
}

function cloneData(value, label, depth = 0, seen = new Set()) {
  if (depth > 32) fail('READ_POSITION_PAGE_INVALID', `${label} exceeds the maximum nesting depth.`, { field: label });
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('READ_POSITION_PAGE_INVALID', `${label} contains a non-finite number.`, { field: label });
    return value;
  }
  if (!value || typeof value !== 'object' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    fail('READ_POSITION_PAGE_INVALID', `${label} is not plain JSON data.`, { field: label });
  }
  if (seen.has(value)) fail('READ_POSITION_PAGE_INVALID', `${label} contains a cycle.`, { field: label });
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry, index) => cloneData(entry, `${label}[${index}]`, depth + 1, seen)));
    plainObject(value, label, 'READ_POSITION_PAGE_INVALID');
    const clone = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail('READ_POSITION_PAGE_INVALID', `${label} contains an unsafe key.`, { field: label });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('READ_POSITION_PAGE_INVALID', `${label} may not contain accessors.`, { field: label });
      }
      clone[key] = cloneData(descriptor.value, `${label}.${key}`, depth + 1, seen);
    }
    return Object.freeze(clone);
  } finally {
    seen.delete(value);
  }
}

function cloneRecords(value) {
  if (!Array.isArray(value)) fail('READ_POSITION_PAGE_INVALID', 'records must be an array.', { field: 'records' });
  return Object.freeze(value.map((record, index) => {
    const clone = cloneData(record, `records[${index}]`);
    nonNegativeInteger(clone.sequence, `records[${index}].sequence`, { code: 'READ_POSITION_PAGE_INVALID' });
    if (clone.sequence === 0) fail('READ_POSITION_PAGE_INVALID', 'record sequence must be positive.', { field: `records[${index}].sequence` });
    return clone;
  }));
}

function result({ status, cursor, headSequence, backlogCount, caughtUp, nextCursor, records, reason = undefined }) {
  const value = { status, cursor, headSequence, backlogCount, caughtUp, nextCursor, records };
  if (reason !== undefined) value.reason = reason;
  return Object.freeze(value);
}

// This is intentionally the only constructor for the result union.  In
// particular, callers cannot pass `caughtUp`; a caught-up result can only be
// built from an empty page where cursor and head are exactly equal.
function buildReadResult(input) {
  const source = plainObject(input, 'positioned read input');
  exactKeys(source, ['cursor', 'headSequence', 'nextCursor', 'records'], 'positioned read input');
  const cursor = nonNegativeInteger(source.cursor, 'cursor');
  const headSequence = nonNegativeInteger(source.headSequence, 'headSequence');
  const nextCursor = nonNegativeInteger(source.nextCursor, 'nextCursor', { code: 'READ_POSITION_PAGE_INVALID' });
  const records = cloneRecords(source.records);
  const backlogCount = headSequence > cursor ? headSequence - cursor : 0;

  if (cursor > headSequence) {
    if (records.length !== 0 || nextCursor !== cursor) {
      fail('READ_POSITION_PAGE_INVALID', 'A cursor beyond head must not return records or advance.', { cursor, headSequence });
    }
    return result({
      status: 'INCOMPLETE', cursor, headSequence, backlogCount, caughtUp: false,
      nextCursor, records, reason: 'CURSOR_AHEAD'
    });
  }

  if (cursor === headSequence) {
    if (records.length !== 0 || nextCursor !== cursor) {
      fail('READ_POSITION_PAGE_INVALID', 'A caught-up page must be empty and keep its cursor.', { cursor, headSequence });
    }
    return result({
      status: 'CAUGHT_UP', cursor, headSequence, backlogCount: 0, caughtUp: true,
      nextCursor, records
    });
  }

  if (records.length === 0) {
    if (nextCursor !== cursor) {
      fail('READ_POSITION_PAGE_INVALID', 'An empty page behind head must not advance its cursor.', { cursor, headSequence, nextCursor });
    }
    return result({
      status: 'INCOMPLETE', cursor, headSequence, backlogCount, caughtUp: false,
      nextCursor, records, reason: 'EMPTY_PAGE_BEHIND'
    });
  }

  const firstSequence = records[0].sequence;
  const lastSequence = records.at(-1).sequence;
  const contiguous = records.every((record, index) => record.sequence === firstSequence + index);
  if (firstSequence !== cursor + 1 || !contiguous) {
    return result({
      status: 'INCOMPLETE', cursor, headSequence, backlogCount, caughtUp: false,
      nextCursor: cursor, records, reason: 'NONCONTIGUOUS_PAGE'
    });
  }
  if (lastSequence > headSequence || nextCursor !== lastSequence) {
    fail('READ_POSITION_PAGE_INVALID', 'A positioned page has an invalid next cursor.', { cursor, headSequence, nextCursor, lastSequence });
  }
  if (lastSequence < headSequence) {
    return result({
      status: 'INCOMPLETE', cursor, headSequence, backlogCount, caughtUp: false,
      nextCursor, records, reason: 'PAGE_PARTIAL'
    });
  }
  return result({
    status: 'BACKLOG', cursor, headSequence, backlogCount, caughtUp: false,
    nextCursor, records
  });
}

function createPositionedReader({ readPage } = {}) {
  if (typeof readPage !== 'function') {
    fail('READ_POSITION_CONFIGURATION_INVALID', 'readPage must be a function.', { field: 'readPage' });
  }

  async function read(input) {
    const source = plainObject(input, 'read input');
    requiredKeys(source, ['cursor'], ['cursor', 'limit'], 'read input');
    const cursor = nonNegativeInteger(source.cursor, 'cursor');
    const request = { cursor };
    if (Object.hasOwn(source, 'limit')) request.limit = nonNegativeInteger(source.limit, 'limit', {
      maximum: MAX_PAGE_SIZE,
      code: 'READ_POSITION_INVALID_ARGUMENT'
    });
    if (request.limit === 0) fail('READ_POSITION_INVALID_ARGUMENT', 'limit must be positive.', { field: 'limit' });
    const page = await readPage(Object.freeze(request));
    const normalized = plainObject(page, 'readPage result', 'READ_POSITION_PAGE_INVALID');
    exactKeys(normalized, ['headSequence', 'nextCursor', 'records'], 'readPage result', 'READ_POSITION_PAGE_INVALID');
    return buildReadResult({
      cursor,
      headSequence: normalized.headSequence,
      nextCursor: normalized.nextCursor,
      records: normalized.records
    });
  }

  return Object.freeze({ read });
}

function drainResult({ status, startCursor, page, pages, records, recordsRead, reason = undefined }) {
  const value = {
    status,
    startCursor,
    cursor: page.cursor,
    headSequence: page.headSequence,
    backlogCount: page.backlogCount,
    caughtUp: page.caughtUp,
    nextCursor: page.nextCursor,
    records: Object.freeze(records),
    recordsRead,
    pages
  };
  if (reason !== undefined) value.reason = reason;
  return Object.freeze(value);
}

// Drains one stable snapshot and then performs an empty confirmation read.  A
// channel that advances while draining returns INCOMPLETE/HEAD_MOVED instead
// of claiming absence from a stale head.  `collect: false` lets probes verify
// delivery mechanics without retaining or emitting message bodies.
function createSafePagingHelper({ readPage, pageSize = 200 } = {}) {
  const reader = createPositionedReader({ readPage });
  nonNegativeInteger(pageSize, 'pageSize', { maximum: MAX_PAGE_SIZE, code: 'READ_POSITION_CONFIGURATION_INVALID' });
  if (pageSize === 0) fail('READ_POSITION_CONFIGURATION_INVALID', 'pageSize must be positive.', { field: 'pageSize' });

  async function drain(input) {
    const source = plainObject(input, 'drain input');
    requiredKeys(source, ['cursor'], ['collect', 'cursor'], 'drain input');
    const startCursor = nonNegativeInteger(source.cursor, 'cursor');
    const collect = source.collect === undefined ? true : source.collect;
    if (typeof collect !== 'boolean') fail('READ_POSITION_INVALID_ARGUMENT', 'collect must be a boolean.', { field: 'collect' });

    let page = await reader.read({ cursor: startCursor, limit: pageSize });
    let pages = 1;
    let recordsRead = 0;
    const records = [];
    const consume = current => {
      recordsRead += current.records.length;
      if (collect) records.push(...current.records);
    };
    const mayAdvance = current => current.status === 'BACKLOG'
      || (current.status === 'INCOMPLETE' && current.reason === 'PAGE_PARTIAL');
    const stoppedAt = (cursor, headSequence) => buildReadResult({
      cursor, headSequence, nextCursor: cursor, records: []
    });

    if (page.status === 'CAUGHT_UP') {
      return drainResult({ status: 'CAUGHT_UP', startCursor, page, pages, records, recordsRead });
    }
    if (!mayAdvance(page)) {
      return drainResult({ status: 'INCOMPLETE', startCursor, page, pages, records, recordsRead, reason: page.reason });
    }
    consume(page);

    const targetHead = page.headSequence;
    let cursor = page.nextCursor;
    while (cursor < targetHead) {
      page = await reader.read({ cursor, limit: Math.min(pageSize, targetHead - cursor) });
      pages += 1;
      if (page.headSequence !== targetHead) {
        return drainResult({
          status: 'INCOMPLETE', startCursor, page: stoppedAt(cursor, page.headSequence), pages, records, recordsRead,
          reason: 'HEAD_MOVED'
        });
      }
      if (!mayAdvance(page)) {
        return drainResult({ status: 'INCOMPLETE', startCursor, page, pages, records, recordsRead, reason: page.reason });
      }
      if (page.nextCursor <= cursor) {
        return drainResult({ status: 'INCOMPLETE', startCursor, page, pages, records, recordsRead, reason: 'NO_PROGRESS' });
      }
      consume(page);
      cursor = page.nextCursor;
    }

    // A second empty read proves the stored head was still current when the
    // drain ended.  Do not retain this confirmation page's records if the
    // head moved: the next invocation starts at `cursor` and delivers them
    // exactly once.
    const confirmation = await reader.read({ cursor, limit: pageSize });
    pages += 1;
    if (confirmation.status === 'CAUGHT_UP' && confirmation.headSequence === targetHead) {
      return drainResult({ status: 'CAUGHT_UP', startCursor, page: confirmation, pages, records, recordsRead });
    }
    const headMoved = confirmation.headSequence !== targetHead;
    return drainResult({
      status: 'INCOMPLETE', startCursor,
      page: headMoved ? stoppedAt(cursor, confirmation.headSequence) : confirmation,
      pages, records, recordsRead,
      reason: headMoved ? 'HEAD_MOVED' : confirmation.reason
    });
  }

  return Object.freeze({ drain, read: reader.read });
}

module.exports = Object.freeze({
  MAX_PAGE_SIZE,
  ReadPositionError,
  buildReadResult,
  createPositionedReader,
  createSafePagingHelper
});
