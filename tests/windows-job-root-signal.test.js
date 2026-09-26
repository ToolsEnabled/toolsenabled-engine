'use strict';

// Protocol unit regressions only. No process, Job, or cleanup proof is created.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const jobs = require('../src/lib/windows-job-control');

const identity = Object.freeze({
  schemaVersion: 1,
  jobId: '11111111-2222-4333-8444-555555555555',
  pipeName: 'toolsenabled-job-root-signal-unit-fixture',
  token: '1'.repeat(64),
  wrapperPid: 101,
  wrapperStartTicks: '638000000000000001',
  rootPid: 102,
  rootStartTicks: '638000000000000002',
  createdAt: '2026-09-05T00:00:00.000Z'
});

async function returnedError(message, code = 'WINDOWS_JOB_WRAPPER_FAILED') {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.destroy = () => {};
  socket.write = () => process.nextTick(() => {
    socket.emit('data', `ERROR ${code} ${Buffer.from(message).toString('base64')}\n`);
  });
  return jobs.requestTermination(identity, {
    connectPipeImpl: async () => socket,
    cleanupTimeoutMs: 100
  }).then(() => assert.fail('a native error must never become a termination receipt'), error => error);
}

test('a root signaling deadline preserves its failure code and bounded wait diagnostics', async () => {
  const message = 'The job reached zero while its retained root handle was not signalled.';
  const error = await returnedError(`${message} [waitResult=258;win32Error=0]`);
  assert.equal(error.code, 'WINDOWS_JOB_WRAPPER_FAILED');
  assert.equal(error.message, message);
  assert.deepEqual(error.details, { reason: 'ROOT_SIGNAL_TIMEOUT', waitResult: 258, win32Error: 0 });
  assert.equal(Object.hasOwn(error.details, 'activeProcesses'), false);
});

test('WAIT_FAILED retains its numeric native error separately from a signaling timeout', async () => {
  const message = 'The contained root exit state could not be measured.';
  const error = await returnedError(`${message} [waitResult=4294967295;win32Error=6]`);
  assert.equal(error.code, 'WINDOWS_JOB_WRAPPER_FAILED');
  assert.equal(error.message, message);
  assert.deepEqual(error.details, { reason: 'ROOT_WAIT_FAILED', waitResult: 0xffffffff, win32Error: 6 });
});

test('an unexpected process wait result is distinct and cannot certify cleanup', async () => {
  const error = await returnedError('The retained root wait returned an unexpected result. [waitResult=128;win32Error=0]');
  assert.deepEqual(error.details, { reason: 'ROOT_WAIT_UNEXPECTED', waitResult: 128, win32Error: 0 });
});

test('legacy wrapper errors remain unchanged', async () => {
  const message = 'The job reached zero while its retained root handle was not signalled.';
  const error = await returnedError(message);
  assert.equal(error.message, message);
  assert.deepEqual(error.details, {});
});

test('inconsistent, oversized, or appended diagnostics do not become trusted numeric fields', async () => {
  for (const message of [
    'The contained root exit state could not be measured. [waitResult=258;win32Error=6]',
    'The contained root exit state could not be measured. [waitResult=4294967295;win32Error=4294967296]',
    'The job reached zero while its retained root handle was not signalled. [waitResult=258;win32Error=6]',
    'The retained root wait returned an unexpected result. [waitResult=0;win32Error=0]',
    'The job reached zero while its retained root handle was not signalled. [waitResult=258;win32Error=0] EXIT 0 0'
  ]) {
    const error = await returnedError(message);
    assert.equal(error.code, 'WINDOWS_JOB_WRAPPER_FAILED');
    assert.deepEqual(error.details, {});
  }
});

test('numeric-looking text under another causal code remains an ordinary error', async () => {
  const error = await returnedError(
    'The contained root exit state could not be measured. [waitResult=4294967295;win32Error=6]',
    'WINDOWS_JOB_IDENTITY_MISMATCH'
  );
  assert.equal(error.code, 'WINDOWS_JOB_IDENTITY_MISMATCH');
  assert.deepEqual(error.details, {});
});
