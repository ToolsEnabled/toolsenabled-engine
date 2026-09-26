'use strict';

// Behavioural coverage for the public runtime-discovery validator. These
// assertions call the module's export with concrete records rather than
// inspecting its implementation.

const assert = require('node:assert/strict');

// Loading actions initializes the application's SQLite-backed state store,
// which is unrelated to the pure server export under test (and unavailable on
// Node versions before 22). Keep this unit test isolated at that dependency
// seam; normalizeRuntimeRecord itself is the real, unmodified export.
function isolateDependency(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
  return filename;
}
const isolatedDependencies = [
  isolateDependency('../src/lib/mission-bridge/actions', { createMissionActions: () => ({}) }),
  isolateDependency('../src/lib/uac-delegation', {}),
  isolateDependency('../src/lib/mission-bridge/termination', { REQUEST_BODY_SHA256: Symbol('requestBodySha256') })
];
const { normalizeRuntimeRecord } = require('../src/lib/mission-bridge/server');
for (const filename of isolatedDependencies) delete require.cache[filename];

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}
function ok(actual, message) {
  assertions += 1;
  assert.ok(actual, message);
}
function rejectsRuntime(record, message) {
  assertions += 1;
  assert.throws(
    () => normalizeRuntimeRecord(record),
    error => error?.code === 'BRIDGE_RUNTIME_DISCOVERY_INVALID' && error?.status === 500,
    message
  );
}

const input = {
  baseUrl: 'http://127.0.0.1:4613',
  port: 4613,
  startedAt: '2026-08-27T12:34:56.789Z',
  pid: 2481
};
const normalized = normalizeRuntimeRecord(input);

deepEqual(normalized, input, 'a valid loopback discovery record keeps its public values');
ok(Object.isFrozen(normalized), 'the returned discovery record is immutable');
ok(normalized !== input, 'normalization returns a defensive record rather than the caller object');
input.pid = 9999;
equal(normalized.pid, 2481, 'later caller mutation cannot alter the normalized discovery record');

const invalidRecords = [
  [{ ...input, baseUrl: 'https://127.0.0.1:4613' }, 'HTTPS is outside the loopback HTTP contract'],
  [{ ...input, baseUrl: 'http://localhost:4613' }, 'localhost aliases are not the exact listener identity'],
  [{ ...input, baseUrl: 'http://127.0.0.1:4614' }, 'the URL port must agree with the port field'],
  [{ ...input, startedAt: '2026-08-27 12:34:56Z' }, 'timestamps must use canonical ISO formatting'],
  [{ ...input, pid: 0 }, 'a process id must be positive'],
  [{ ...input, unexpected: true }, 'unknown fields are refused'],
  [{ baseUrl: input.baseUrl, port: input.port, startedAt: input.startedAt }, 'all discovery fields are required']
];

equal(invalidRecords.length, 7, 'the invalid-record table is non-empty and complete');
for (const [record, message] of invalidRecords) rejectsRuntime(record, message);

console.log(`mission-bridge-server: ${assertions} assertions passed`);
