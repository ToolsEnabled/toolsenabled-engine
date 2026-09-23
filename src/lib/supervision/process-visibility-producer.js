'use strict';

// Pure producer-side boundary for the Q39 elevated-reader seam.
//
// A future privileged collector may pass only already-minimized observations
// to this module.  It cannot choose a reader identity, carry a raw
// command-line field, or smuggle an accessor / unknown property through to
// the consumer contract.  This module deliberately has no I/O or runtime
// control capability: the later collector and its fixed state-file writer are
// separate, reviewable components.

const snapshot = require('./process-visibility-snapshot.js');

const CREDENTIAL_FIELD = /(?:password|passwd|secret|token|api[_-]?key|authorization)/i;
const RAW_COMMAND_LINE_FIELD = /^(?:raw[_-]?)?command[_-]?line$/i;

class ProcessVisibilityProducerError extends Error {
  constructor(code, message) {
    super(`process-visibility-producer: ${message}`);
    this.name = 'ProcessVisibilityProducerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProcessVisibilityProducerError(code, message);
}

function exactDataObject(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PROCESS_VISIBILITY_PRODUCER_INVALID_SHAPE', `${label} must be a plain object`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    fail('PROCESS_VISIBILITY_PRODUCER_UNKNOWN_FIELD', `${label} must not contain symbol fields`);
  }
  for (const key of ownKeys) {
    if (RAW_COMMAND_LINE_FIELD.test(key)) {
      fail('PROCESS_VISIBILITY_PRODUCER_RAW_COMMAND_LINE_REFUSED', `${label}.${key} is not an allowed minimized observation`);
    }
    if (CREDENTIAL_FIELD.test(key)) {
      fail('PROCESS_VISIBILITY_PRODUCER_CREDENTIAL_FIELD_REFUSED', `${label}.${key} is not an allowed minimized observation`);
    }
  }

  const actual = [...ownKeys].sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('PROCESS_VISIBILITY_PRODUCER_UNKNOWN_FIELD', `${label} must contain exactly: ${expected.join(', ')}`);
  }

  const values = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('PROCESS_VISIBILITY_PRODUCER_ACCESSOR_REFUSED', `${label}.${key} must not be an accessor`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('PROCESS_VISIBILITY_PRODUCER_INVALID_ARRAY', `${label} must be a plain array`);
  }
  if (value.length > max) {
    fail('PROCESS_VISIBILITY_PRODUCER_OVERSIZE', `${label} must have at most ${max} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('PROCESS_VISIBILITY_PRODUCER_UNKNOWN_FIELD', `${label} must not contain symbol fields`);
  }

  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes('length')) {
    fail('PROCESS_VISIBILITY_PRODUCER_INVALID_ARRAY', `${label} must be dense and contain no extra fields`);
  }
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('PROCESS_VISIBILITY_PRODUCER_ACCESSOR_REFUSED', `${label}[${index}] must not be an accessor`);
    }
    items.push(descriptor.value);
  }
  return items;
}

function normalizeArgv(value, label) {
  return denseDataArray(value, label, snapshot.MAX_ARGV);
}

function normalizeTasks(value) {
  return denseDataArray(value, 'tasks', snapshot.MAX_TASKS).map((item, index) => {
    const fields = exactDataObject(item, `tasks[${index}]`, ['argv', 'executable', 'state', 'taskName', 'workingDirectory']);
    return {
      taskName: fields.taskName,
      state: fields.state,
      executable: fields.executable,
      argv: normalizeArgv(fields.argv, `tasks[${index}].argv`),
      workingDirectory: fields.workingDirectory
    };
  });
}

function normalizeProcesses(value) {
  return denseDataArray(value, 'processes', snapshot.MAX_PROCESSES).map((item, index) => {
    const fields = exactDataObject(item, `processes[${index}]`, ['argv', 'imageName', 'pid', 'startedAtMs']);
    return {
      pid: fields.pid,
      imageName: fields.imageName,
      startedAtMs: fields.startedAtMs,
      argv: normalizeArgv(fields.argv, `processes[${index}].argv`)
    };
  });
}

/**
 * Return the parser's immutable, closed snapshot projection from injected
 * minimized observations.  The reader declaration is fixed here rather than
 * supplied by the caller so a future collector cannot impersonate another
 * producer type.
 */
function normalizeProcessVisibilityObservation(input, { expectedTaskNames } = {}) {
  const fields = exactDataObject(input, 'observation', ['capturedAtMs', 'processes', 'tasks']);
  return snapshot.parseProcessVisibilitySnapshot({
    schemaVersion: snapshot.SNAPSHOT_SCHEMA_VERSION,
    capturedAtMs: fields.capturedAtMs,
    reader: {
      kind: snapshot.READER_KIND,
      privilege: snapshot.READER_PRIVILEGE
    },
    tasks: normalizeTasks(fields.tasks),
    processes: normalizeProcesses(fields.processes)
  }, { expectedTaskNames });
}

/**
 * Produce the exact JSON payload a future fixed-path writer may persist.
 * Persistence remains outside this pure module.
 */
function serializeProcessVisibilitySnapshot(input, options) {
  return JSON.stringify(normalizeProcessVisibilityObservation(input, options));
}

module.exports = Object.freeze({
  ProcessVisibilityProducerError,
  normalizeProcessVisibilityObservation,
  serializeProcessVisibilitySnapshot
});
