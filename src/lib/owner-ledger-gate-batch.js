'use strict';

// Pure pagination over already-redacted open-gate entries.  This module never
// reads the ledger (or any other store), and it never derives an instruction:
// an instruction is copied byte-for-byte only when the supplied entry has one.

const crypto = require('node:crypto');

const MAX_BATCH_COUNT = 25;
const MAX_ENTRIES = 10_000;
const MAX_GATE_ID_BYTES = 256;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_PREFIX = 'olgb1.';
const REQUIRED_REQUEST_FIELDS = Object.freeze(['entries', 'cursor', 'count']);
const REQUIRED_ENTRY_FIELDS = Object.freeze(['gateId', 'requestId', 'requestStatus', 'gateIndex']);
const OPTIONAL_ENTRY_FIELDS = Object.freeze(['instruction']);

function fail(code) {
  throw new TypeError(`OWNER_LEDGER_GATE_BATCH_${code}`);
}

function inspectPlainRecord(value, requiredFields, optionalFields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_NOT_PLAIN_OBJECT`);
  }

  let prototype;
  let symbols;
  let names;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    names = Object.getOwnPropertyNames(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(`${label}_UNSAFE_OBJECT`);
  }

  if (prototype !== Object.prototype) fail(`${label}_PROTOTYPE`);
  if (symbols.length !== 0) fail(`${label}_SYMBOLS`);

  const allowed = new Set([...requiredFields, ...optionalFields]);
  for (const name of names) {
    if (!allowed.has(name)) fail(`${label}_UNKNOWN_FIELD`);
    const descriptor = descriptors[name];
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}_ACCESSOR`);
    }
    if (!descriptor.enumerable) fail(`${label}_NON_ENUMERABLE_FIELD`);
  }
  for (const name of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, name)) {
      fail(`${label}_MISSING_FIELD`);
    }
  }
  return descriptors;
}

function inspectDenseArray(value, label) {
  if (!Array.isArray(value)) fail(`${label}_NOT_ARRAY`);

  let prototype;
  let symbols;
  let names;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    names = Object.getOwnPropertyNames(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(`${label}_UNSAFE_ARRAY`);
  }

  if (prototype !== Array.prototype) fail(`${label}_PROTOTYPE`);
  if (symbols.length !== 0) fail(`${label}_SYMBOLS`);

  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
    fail(`${label}_INVALID_LENGTH`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ENTRIES) {
    fail(`${label}_INVALID_LENGTH`);
  }
  if (names.length !== length + 1 || !Object.prototype.hasOwnProperty.call(descriptors, 'length')) {
    fail(`${label}_EXTRA_OR_SPARSE_FIELDS`);
  }

  const values = [];
  for (let index = 0; index < length; index += 1) {
    const name = String(index);
    const descriptor = descriptors[name];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}_EXTRA_OR_SPARSE_FIELDS`);
    }
    if (!descriptor.enumerable) fail(`${label}_NON_ENUMERABLE_FIELD`);
    values.push(descriptor.value);
  }
  return values;
}

function assertNonBlankString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label}_INVALID_STRING`);
  return value;
}

function isValidGateId(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && Buffer.byteLength(value, 'utf8') <= MAX_GATE_ID_BYTES
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function assertGateId(value, label) {
  if (!isValidGateId(value)) fail(`${label}_INVALID_GATE_ID`);
  return value;
}

function assertGateIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    fail(`${label}_INVALID_GATE_INDEX`);
  }
  return value;
}

function assertCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_COUNT) {
    fail('INVALID_COUNT');
  }
  return value;
}

function canonicalCompare(left, right) {
  if (left.gateId < right.gateId) return -1;
  if (left.gateId > right.gateId) return 1;
  return 0;
}

function snapshotFingerprint(entries) {
  const hash = crypto.createHash('sha256');
  hash.update('owner-ledger-gate-batch:v1\0', 'utf8');
  for (const entry of entries) {
    for (const key of ['gateId', 'requestId', 'requestStatus', 'gateIndex', 'instruction']) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) {
        hash.update(`${key}:<absent>\0`, 'utf8');
        continue;
      }
      const bytes = Buffer.from(String(entry[key]), 'utf8');
      hash.update(`${key}:${bytes.length}:`, 'utf8');
      hash.update(bytes);
      hash.update('\0', 'utf8');
    }
  }
  return hash.digest('hex');
}

function makeCursor(snapshot, gateId) {
  return `${CURSOR_PREFIX}${snapshot}.${Buffer.from(gateId, 'utf8').toString('base64url')}`;
}

function parseCursor(cursor) {
  if (cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    fail('MALFORMED_CURSOR');
  }

  const match = /^olgb1\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) fail('MALFORMED_CURSOR');

  let gateId;
  try {
    gateId = Buffer.from(match[2], 'base64url').toString('utf8');
  } catch {
    fail('MALFORMED_CURSOR');
  }
  if (!isValidGateId(gateId) || Buffer.from(gateId, 'utf8').toString('base64url') !== match[2]) {
    fail('MALFORMED_CURSOR');
  }
  return Object.freeze({ snapshot: match[1], gateId });
}

function copyAndValidateEntries(entriesValue) {
  const values = inspectDenseArray(entriesValue, 'ENTRIES');
  const entries = [];
  const seenGateIds = new Set();

  for (let index = 0; index < values.length; index += 1) {
    const descriptors = inspectPlainRecord(
      values[index],
      REQUIRED_ENTRY_FIELDS,
      OPTIONAL_ENTRY_FIELDS,
      `ENTRY_${index}`
    );
    const gateId = assertGateId(descriptors.gateId.value, `ENTRY_${index}`);
    if (seenGateIds.has(gateId)) fail('DUPLICATE_GATE_ID');
    seenGateIds.add(gateId);

    const entry = {
      gateId,
      requestId: assertNonBlankString(descriptors.requestId.value, `ENTRY_${index}_REQUEST_ID`),
      requestStatus: assertNonBlankString(descriptors.requestStatus.value, `ENTRY_${index}_REQUEST_STATUS`),
      gateIndex: assertGateIndex(descriptors.gateIndex.value, `ENTRY_${index}`)
    };
    if (Object.prototype.hasOwnProperty.call(descriptors, 'instruction')) {
      entry.instruction = assertNonBlankString(descriptors.instruction.value, `ENTRY_${index}_INSTRUCTION`);
    }
    entries.push(Object.freeze(entry));
  }

  entries.sort(canonicalCompare);
  return entries;
}

/**
 * Select one immutable, deterministic batch from already-redacted open gates.
 *
 * The input is a closed schema:
 * `{ entries, cursor, count }`, where `cursor` is explicitly `null` for the
 * first page and `count` is an integer from 1 through 25.  Each entry has
 * `{ gateId, requestId, requestStatus, gateIndex }` and may carry an already
 * redacted `instruction`; no instruction is looked up or synthesized.
 *
 * @param {{entries: object[], cursor: string|null, count: number}} request
 * @returns {{entries: readonly object[], nextCursor: string|null, total: number}}
 */
function selectGateBatch(request) {
  const requestDescriptors = inspectPlainRecord(request, REQUIRED_REQUEST_FIELDS, [], 'REQUEST');
  const entries = copyAndValidateEntries(requestDescriptors.entries.value);
  const count = assertCount(requestDescriptors.count.value);
  const cursor = parseCursor(requestDescriptors.cursor.value);
  const snapshot = snapshotFingerprint(entries);

  let start = 0;
  if (cursor !== null) {
    if (cursor.snapshot !== snapshot) fail('CURSOR_SNAPSHOT_MISMATCH');
    const previousIndex = entries.findIndex(entry => entry.gateId === cursor.gateId);
    if (previousIndex === -1) fail('CURSOR_GATE_NOT_FOUND');
    start = previousIndex + 1;
  }

  const selected = entries.slice(start, start + count);
  const hasNext = start + selected.length < entries.length;
  const nextCursor = hasNext ? makeCursor(snapshot, selected[selected.length - 1].gateId) : null;

  return Object.freeze({
    entries: Object.freeze(selected),
    nextCursor,
    total: entries.length
  });
}

module.exports = { MAX_BATCH_COUNT, MAX_ENTRIES, MAX_GATE_ID_BYTES, selectGateBatch };
