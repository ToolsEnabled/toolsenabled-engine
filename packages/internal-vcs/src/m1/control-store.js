'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  canonicalDecode,
  deepFreeze,
  hashBytes,
  immutableClone,
  parseQualifiedId,
} = require('./canonical');

const EVENT_SCHEMA = 'internal-vcs.control-event/v1';
const SNAPSHOT_SCHEMA = 'internal-vcs.control-snapshot/v1';
const PROJECTION_SCHEMA = 'internal-vcs.projection/v1';
const EVENT_NAME_RE = /^(\d{20})--([0-9a-f]{64})\.event\.json$/;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function fail(code, message, details = {}) {
  throw new VcsError(code, message, details);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function sequenceName(sequence, dedupeKey) {
  const keyDigest = hashBytes(Buffer.from(dedupeKey, 'utf8')).slice('sha256:'.length);
  return `${String(sequence).padStart(20, '0')}--${keyDigest}.event.json`;
}

function snapshotIdentity(sequence, headEventId) {
  return hashBytes(canonicalEncode({ schemaVersion: SNAPSHOT_SCHEMA, sequence, headEventId }));
}

function eventBody({ sequence, previousEventId, eventType, payload, dedupeKey, occurredAt }) {
  return {
    schemaVersion: EVENT_SCHEMA,
    sequence,
    previousEventId,
    eventType,
    payload: immutableClone(payload),
    dedupeKey,
    occurredAt,
  };
}

function buildEvent(input) {
  const body = eventBody(input);
  return deepFreeze({ ...body, eventId: hashBytes(canonicalEncode(body)) });
}

function validateEvent(record, expectedSequence, expectedPreviousEventId) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'dedupeKey',
    'eventId',
    'eventType',
    'occurredAt',
    'payload',
    'previousEventId',
    'schemaVersion',
    'sequence',
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event has an unexpected shape', { sequence: expectedSequence });
  }
  if (record.schemaVersion !== EVENT_SCHEMA || record.sequence !== expectedSequence) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event sequence or schema is invalid', {
      expectedSequence,
      actualSequence: record.sequence,
      schemaVersion: record.schemaVersion,
    });
  }
  if (record.previousEventId !== expectedPreviousEventId) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event hash link is broken', {
      sequence: expectedSequence,
      expectedPreviousEventId,
      actualPreviousEventId: record.previousEventId,
    });
  }
  parseQualifiedId(record.eventId);
  const actualId = hashBytes(canonicalEncode(eventBody(record)));
  if (actualId !== record.eventId) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event digest does not match its content', {
      sequence: expectedSequence,
      expected: record.eventId,
      actual: actualId,
    });
  }
  requireNonEmptyString(record.dedupeKey, 'dedupeKey');
  requireNonEmptyString(record.eventType, 'eventType');
  requireNonEmptyString(record.occurredAt, 'occurredAt');
  return deepFreeze(record);
}

class FileControlStore {
  constructor({
    root,
    projectionReducers = {},
    clock = () => new Date().toISOString(),
    lockAttempts = 200,
    lockWaitMs = 5,
    staleLockMs = 30_000,
    faultInjector = null,
  }) {
    requireNonEmptyString(root, 'root');
    this.root = path.resolve(root);
    this.eventsRoot = path.join(this.root, 'events');
    this.temporaryRoot = path.join(this.root, 'temporary');
    this.staleLocksRoot = path.join(this.root, 'stale-locks');
    this.lockPath = path.join(this.root, 'append.lock');
    this.clock = clock;
    this.lockAttempts = lockAttempts;
    this.lockWaitMs = lockWaitMs;
    this.staleLockMs = staleLockMs;
    this.faultInjector = faultInjector;
    this.projectionReducers = Object.freeze({ ...projectionReducers });
    fs.mkdirSync(this.eventsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.temporaryRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.staleLocksRoot, { recursive: true, mode: 0o700 });
  }

  _eventFiles() {
    const entries = fs.readdirSync(this.eventsRoot, { withFileTypes: true });
    const unexpected = entries.filter(entry => !EVENT_NAME_RE.test(entry.name));
    if (unexpected.length > 0) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event directory contains an unclassified entry', {
        names: unexpected.map(entry => entry.name).sort(),
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    let expectedSequence = 1;
    for (const entry of entries) {
      if (!entry.isFile()) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event path is not a regular file', { name: entry.name });
      const sequence = Number(EVENT_NAME_RE.exec(entry.name)[1]);
      if (sequence !== expectedSequence) {
        fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event sequence contains a gap or duplicate', {
          expectedSequence,
          actualSequence: sequence,
        });
      }
      expectedSequence += 1;
    }
    return entries.map(entry => entry.name);
  }

  _readEventFile(name, expectedPreviousEventId) {
    const match = EVENT_NAME_RE.exec(name);
    if (!match) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'invalid control event filename', { name });
    const target = path.join(this.eventsRoot, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event must be a non-symlink regular file', { name });
    }
    const record = canonicalDecode(fs.readFileSync(target));
    const expectedDedupeDigest = hashBytes(Buffer.from(record.dedupeKey, 'utf8')).slice('sha256:'.length);
    if (match[2] !== expectedDedupeDigest) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control event filename does not match its dedupe key', { name });
    }
    return validateEvent(record, Number(match[1]), expectedPreviousEventId);
  }

  _readAllEvents() {
    const events = [];
    let previousEventId = null;
    for (const name of this._eventFiles()) {
      const event = this._readEventFile(name, previousEventId);
      events.push(event);
      previousEventId = event.eventId;
    }
    return events;
  }

  _tail() {
    const files = this._eventFiles();
    const events = this._readAllEvents();
    if (events.length === 0) return { sequence: 0, headEventId: null, files };
    const event = events[events.length - 1];
    return { sequence: event.sequence, headEventId: event.eventId, files };
  }

  _lockIsReclaimable() {
    let metadata;
    try {
      metadata = canonicalDecode(fs.readFileSync(this.lockPath));
    } catch {
      try {
        return Date.now() - fs.statSync(this.lockPath).mtimeMs > this.staleLockMs;
      } catch {
        return false;
      }
    }
    if (!Number.isInteger(metadata.pid) || typeof metadata.acquiredAtMs !== 'number') return false;
    if (Date.now() - metadata.acquiredAtMs <= this.staleLockMs) return false;
    try {
      process.kill(metadata.pid, 0);
      return false;
    } catch (error) {
      return error && error.code === 'ESRCH';
    }
  }

  _acquireLock() {
    for (let attempt = 0; attempt < this.lockAttempts; attempt += 1) {
      try {
        const handle = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(handle, canonicalEncode({ pid: process.pid, acquiredAtMs: Date.now() }));
          fs.fsyncSync(handle);
        } catch (error) {
          try { fs.unlinkSync(this.lockPath); } catch {}
          throw error;
        } finally {
          fs.closeSync(handle);
        }
        return () => {
          try { fs.unlinkSync(this.lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (this._lockIsReclaimable()) {
          const preserved = path.join(this.staleLocksRoot, `append-${Date.now()}-${crypto.randomUUID()}.lock`);
          try { fs.renameSync(this.lockPath, preserved); } catch (renameError) {
            if (!['ENOENT', 'EEXIST', 'EPERM'].includes(renameError.code)) throw renameError;
          }
          continue;
        }
        Atomics.wait(WAIT_BUFFER, 0, 0, this.lockWaitMs);
      }
    }
    fail(VCS_ERROR_CODES.TRANSACTION_IN_DOUBT, 'control-store append lock could not be acquired', {
      attempts: this.lockAttempts,
    });
  }

  _appendResultFor(event) {
    return deepFreeze({
      eventId: event.eventId,
      sequence: event.sequence,
      authoritySnapshotId: snapshotIdentity(event.sequence, event.eventId),
    });
  }

  appendEvent({ eventType, payload, dedupeKey, occurredAt = this.clock(), expectedSnapshotId } = {}) {
    requireNonEmptyString(eventType, 'eventType');
    requireNonEmptyString(dedupeKey, 'dedupeKey');
    requireNonEmptyString(occurredAt, 'occurredAt');
    canonicalEncode(payload);

    const release = this._acquireLock();
    try {
      const tail = this._tail();
      const currentSnapshotId = snapshotIdentity(tail.sequence, tail.headEventId);
      if (expectedSnapshotId !== undefined && expectedSnapshotId !== currentSnapshotId) {
        fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'control-store compare-and-swap precondition failed', {
          expectedSnapshotId,
          actualSnapshotId: currentSnapshotId,
        });
      }

      const expectedName = sequenceName(tail.sequence + 1, dedupeKey);
      const dedupeSuffix = expectedName.slice(20);
      const existingName = tail.files.find(name => name.slice(20) === dedupeSuffix);
      if (existingName) {
        const existingEvents = this._readAllEvents();
        const existing = existingEvents.find(event => event.dedupeKey === dedupeKey);
        if (!existing || existing.eventType !== eventType || !canonicalEncode(existing.payload).equals(canonicalEncode(payload))) {
          fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'dedupe key was reused for different event content', { dedupeKey });
        }
        return this._appendResultFor(existing);
      }

      const event = buildEvent({
        sequence: tail.sequence + 1,
        previousEventId: tail.headEventId,
        eventType,
        payload,
        dedupeKey,
        occurredAt,
      });
      const temporaryPath = path.join(this.temporaryRoot, `${expectedName}.${crypto.randomUUID()}.tmp`);
      const finalPath = path.join(this.eventsRoot, expectedName);
      const handle = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, canonicalEncode(event));
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      if (this.faultInjector) this.faultInjector('beforePublish', immutableClone(event));
      fs.renameSync(temporaryPath, finalPath);
      if (this.faultInjector) this.faultInjector('afterPublish', immutableClone(event));
      return this._appendResultFor(event);
    } finally {
      release();
    }
  }

  compareAndSwap({ expectedSnapshotId, event, dedupeKey, occurredAt } = {}) {
    if (!event || typeof event !== 'object') {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'compareAndSwap requires an event object');
    }
    return this.appendEvent({
      eventType: requireNonEmptyString(event.type, 'event.type'),
      payload: event.payload,
      dedupeKey,
      occurredAt,
      expectedSnapshotId,
    });
  }

  readSnapshot({ snapshotId = null } = {}) {
    const events = this._readAllEvents();
    let selected = events;
    if (snapshotId !== null) {
      parseQualifiedId(snapshotId);
      let matched = false;
      for (let sequence = 0; sequence <= events.length; sequence += 1) {
        const headEventId = sequence === 0 ? null : events[sequence - 1].eventId;
        if (snapshotIdentity(sequence, headEventId) === snapshotId) {
          selected = events.slice(0, sequence);
          matched = true;
          break;
        }
      }
      if (!matched) fail(VCS_ERROR_CODES.SNAPSHOT_STALE, 'requested control snapshot does not exist', { snapshotId });
    }
    const sequence = selected.length;
    const headEventId = sequence === 0 ? null : selected[sequence - 1].eventId;
    return deepFreeze({
      snapshotId: snapshotIdentity(sequence, headEventId),
      sequence,
      headEventId,
      events: selected.map(immutableClone),
    });
  }

  rebuildProjection({ projectionId, snapshotId = null } = {}) {
    requireNonEmptyString(projectionId, 'projectionId');
    const descriptor = this.projectionReducers[projectionId];
    if (!descriptor || typeof descriptor.initialState !== 'function' || typeof descriptor.reduce !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'projection reducer is not registered', { projectionId });
    }
    const snapshot = this.readSnapshot({ snapshotId });
    let state = descriptor.initialState();
    for (const event of snapshot.events) state = descriptor.reduce(state, immutableClone(event));
    const immutableState = immutableClone(state);
    const body = {
      schemaVersion: PROJECTION_SCHEMA,
      projectionId,
      sourceSnapshotId: snapshot.snapshotId,
      sourceEventCount: snapshot.sequence,
      state: immutableState,
    };
    return deepFreeze({
      ...body,
      projectionDigest: hashBytes(canonicalEncode(body)),
      freshness: 'FRESH',
    });
  }

  verifyIntegrity() {
    const events = this._readAllEvents();
    const bytes = this._eventFiles().reduce((total, name) => total + fs.statSync(path.join(this.eventsRoot, name)).size, 0);
    const headEventId = events.length === 0 ? null : events[events.length - 1].eventId;
    return deepFreeze({
      state: 'SAFE',
      eventCount: events.length,
      bytes,
      authoritySnapshotId: snapshotIdentity(events.length, headEventId),
      orphanTemporaryFiles: fs.readdirSync(this.temporaryRoot).length,
    });
  }
}

function createFileControlStore(options) {
  return new FileControlStore(options);
}

module.exports = Object.freeze({
  EVENT_SCHEMA,
  SNAPSHOT_SCHEMA,
  PROJECTION_SCHEMA,
  FileControlStore,
  createFileControlStore,
  snapshotIdentity,
});
