'use strict';

// Cross-session process visibility snapshot contract (Q39 foundation).
//
// An eventual elevated reader may collect information that the ordinary health
// observer cannot see.  That reader is deliberately NOT implemented here.
// This module only parses an untrusted, fixed-shape value into a bounded,
// immutable projection.  It has no filesystem, process, privilege, or network
// access, so accepting this contract cannot itself widen the observer's reach.

const SNAPSHOT_SCHEMA_VERSION = 1;
const READER_KIND = 'toolsenabled-uac-process-reader';
const READER_PRIVILEGE = 'elevated-read-only';
const TASK_STATES = new Set(['Ready', 'Running', 'Disabled', 'Queued', 'NotFound', 'Unknown']);
const MAX_TASKS = 256;
const MAX_PROCESSES = 4096;
const MAX_ARGV = 96;
const MAX_STRING = 4096;
// ECMAScript Date's inclusive TimeClip boundary. Values outside it make
// Date#toISOString throw, so timestamps must be refused before consumers
// project them.
const MAX_TIMESTAMP_MS = 8.64e15;
// The reader must redact credentials before it serializes.  Match both a
// secret-shaped field name in nested assignments (`--env=API_KEY=value`) and
// recognizable direct credential formats.  Delimiters intentionally include
// '=' so an environment-value wrapper cannot hide the field name. Credential
// and credentials are assignment-only because those words also occur in
// benign helper and directory labels. This is a bounded fail-closed heuristic,
// not authenticated provenance or a complete redaction boundary.
const SECRET_ARGUMENT = /(?:^|[\s"'`?&;=:/\\_-])(password|passwd|secret|token|api[_-]?key|authorization)(?:$|[\s"'`?&;=:/\\_-])|(?:^|[\s"'`?&;=:/\\])(?:--?)?(?:[A-Za-z0-9]+[_-])*credential(?:s)?=|(?:^|[\s"'=])(?:AIza[\w-]{20,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[\w-]{12,})(?:$|[\s"'`?&;=:/\\_-])/i;

class ProcessVisibilitySnapshotError extends Error {
  constructor(code, message) {
    super(`process-visibility-snapshot: ${message}`);
    this.name = 'ProcessVisibilitySnapshotError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProcessVisibilitySnapshotError(code, message);
}

function isPlainDataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_SHAPE', `${label} must be a plain object`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('PROCESS_VISIBILITY_SNAPSHOT_ACCESSOR_REFUSED', `${label}.${key} must not be an accessor`);
    }
  }
  return value;
}

function exactKeys(value, label, keys) {
  isPlainDataObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_UNKNOWN_FIELD', `${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function string(value, label, { allowNull = false, max = MAX_STRING } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_STRING', `${label} must be a non-empty bounded printable string`);
  }
  return value;
}

function nonNegativeInteger(value, label, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_NUMBER', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function timestampMs(value, label, { allowNull = false } = {}) {
  const timestamp = nonNegativeInteger(value, label, { allowNull });
  if (timestamp !== null && timestamp > MAX_TIMESTAMP_MS) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TIMESTAMP', `${label} must be within the ECMAScript TimeClip range`);
  }
  return timestamp;
}

function argv(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ARGV) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_ARGV', `${label} must be an array of at most ${MAX_ARGV} arguments`);
  }
  return Object.freeze(value.map((item, index) => {
    const safe = string(item, `${label}[${index}]`);
    if (SECRET_ARGUMENT.test(safe)) {
      fail('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', `${label}[${index}] looks credential-bearing and must be redacted before writing a snapshot`);
    }
    return safe;
  }));
}

function parseInput(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_JSON', 'input is not valid JSON');
    }
  }
  return input;
}

function parseReader(value) {
  exactKeys(value, 'reader', ['kind', 'privilege']);
  if (value.kind !== READER_KIND || value.privilege !== READER_PRIVILEGE) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_UNTRUSTED_READER', 'reader identity must be the fixed read-only reader declaration');
  }
  return Object.freeze({ kind: READER_KIND, privilege: READER_PRIVILEGE });
}

function parseTasks(value, expectedTaskNames) {
  if (!Array.isArray(value) || value.length > MAX_TASKS) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TASKS', `tasks must be an array of at most ${MAX_TASKS} entries`);
  }
  const names = new Set();
  const tasks = value.map((item, index) => {
    exactKeys(item, `tasks[${index}]`, ['argv', 'executable', 'state', 'taskName', 'workingDirectory']);
    const taskName = string(item.taskName, `tasks[${index}].taskName`, { max: 256 });
    if (names.has(taskName)) fail('PROCESS_VISIBILITY_SNAPSHOT_DUPLICATE_TASK', `tasks contains duplicate ${JSON.stringify(taskName)}`);
    if (expectedTaskNames && !expectedTaskNames.has(taskName)) {
      fail('PROCESS_VISIBILITY_SNAPSHOT_UNDECLARED_TASK', `tasks contains undeclared task ${JSON.stringify(taskName)}`);
    }
    if (!TASK_STATES.has(item.state)) fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TASK_STATE', `tasks[${index}].state is not a declared Task Scheduler state`);
    names.add(taskName);
    return Object.freeze({
      taskName,
      state: item.state,
      executable: string(item.executable, `tasks[${index}].executable`, { allowNull: true }),
      argv: argv(item.argv, `tasks[${index}].argv`),
      workingDirectory: string(item.workingDirectory, `tasks[${index}].workingDirectory`, { allowNull: true })
    });
  });
  if (expectedTaskNames && (names.size !== expectedTaskNames.size || [...expectedTaskNames].some(name => !names.has(name)))) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_TASK_COVERAGE', 'tasks must contain exactly the declared task names, including NotFound entries');
  }
  return Object.freeze(tasks);
}

function parseProcesses(value) {
  if (!Array.isArray(value) || value.length > MAX_PROCESSES) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_PROCESSES', `processes must be an array of at most ${MAX_PROCESSES} entries`);
  }
  const pids = new Set();
  return Object.freeze(value.map((item, index) => {
    exactKeys(item, `processes[${index}]`, ['argv', 'imageName', 'pid', 'startedAtMs']);
    const pid = nonNegativeInteger(item.pid, `processes[${index}].pid`);
    if (pid === 0) fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_PID', `processes[${index}].pid must be greater than zero`);
    if (pids.has(pid)) fail('PROCESS_VISIBILITY_SNAPSHOT_DUPLICATE_PID', `processes contains duplicate pid ${pid}`);
    pids.add(pid);
    return Object.freeze({
      pid,
      imageName: string(item.imageName, `processes[${index}].imageName`, { max: 256 }),
      startedAtMs: timestampMs(item.startedAtMs, `processes[${index}].startedAtMs`, { allowNull: true }),
      argv: argv(item.argv, `processes[${index}].argv`)
    });
  }));
}

function normalizeExpectedTaskNames(expectedTaskNames) {
  if (expectedTaskNames === undefined || expectedTaskNames === null) return null;
  if (!Array.isArray(expectedTaskNames) && !(expectedTaskNames instanceof Set)) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_EXPECTED_TASKS', 'expectedTaskNames must be an array or Set when provided');
  }
  const names = new Set();
  for (const item of expectedTaskNames) {
    const name = string(item, 'expectedTaskNames item', { max: 256 });
    if (names.has(name)) fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_EXPECTED_TASKS', `expectedTaskNames contains duplicate ${JSON.stringify(name)}`);
    names.add(name);
  }
  if (names.size === 0) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_INVALID_EXPECTED_TASKS', 'expectedTaskNames must declare at least one task');
  }
  return names;
}

function parseProcessVisibilitySnapshot(input, { expectedTaskNames } = {}) {
  const value = parseInput(input);
  exactKeys(value, 'snapshot', ['capturedAtMs', 'processes', 'reader', 'schemaVersion', 'tasks']);
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    fail('PROCESS_VISIBILITY_SNAPSHOT_SCHEMA_VERSION', `schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  const expected = normalizeExpectedTaskNames(expectedTaskNames);
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAtMs: timestampMs(value.capturedAtMs, 'capturedAtMs'),
    reader: parseReader(value.reader),
    tasks: parseTasks(value.tasks, expected),
    processes: parseProcesses(value.processes)
  });
}

module.exports = Object.freeze({
  MAX_ARGV,
  MAX_PROCESSES,
  MAX_TASKS,
  MAX_TIMESTAMP_MS,
  ProcessVisibilitySnapshotError,
  READER_KIND,
  READER_PRIVILEGE,
  SNAPSHOT_SCHEMA_VERSION,
  TASK_STATES,
  parseProcessVisibilitySnapshot
});
