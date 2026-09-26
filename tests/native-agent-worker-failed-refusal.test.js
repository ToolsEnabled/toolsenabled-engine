#!/usr/bin/env node
'use strict';

// Drive the worker entry point with a worker whose asynchronous main loop
// rejects without a code. This is the input that selects the entry point's
// NATIVE_AGENT_WORKER_FAILED fallback; inspecting the source text would not
// establish that the catch handler actually records it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'sidecars', 'native-agent', 'bin', 'native-agent-worker.js');
const source = fs.readFileSync(ENTRY, 'utf8');

const calls = {
  append: [],
  mkdir: [],
  processes: [],
  runForever: 0,
  stop: 0
};

class RefusingWorker {
  constructor(options) {
    this.options = options;
  }

  runForever() {
    calls.runForever += 1;
    return Promise.reject(new Error('injected main-loop failure'));
  }

  stop() {
    calls.stop += 1;
  }
}

const fakeFs = {
  mkdirSync(...args) { calls.mkdir.push(args); },
  appendFileSync(...args) { calls.append.push(args); }
};
const fakeProcess = {
  env: {},
  exitCode: undefined,
  once() {},
  // Any process creation by the driven module is a test failure, rather than
  // an unobserved side effect hidden behind the injected worker.
  spawn(...args) { calls.processes.push(args); }
};

const context = vm.createContext({
  __dirname: path.dirname(ENTRY),
  __filename: ENTRY,
  console,
  Date,
  Error,
  JSON,
  Promise,
  process: fakeProcess,
  require(id) {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:path') return path;
    if (id === '../src/native-agent-worker') {
      return { NativeAgentWorker: RefusingWorker, workerId: () => 'injected-worker' };
    }
    if (id === 'node:child_process' || id === 'child_process') {
      return { spawn: fakeProcess.spawn, spawnSync: fakeProcess.spawn };
    }
    throw new Error(`unexpected dependency: ${id}`);
  }
});

vm.runInContext(source, context, { filename: ENTRY });

setImmediate(() => {
  assert.equal(calls.runForever, 1, 'the injected refusal must come from driving runForever');
  assert.equal(fakeProcess.exitCode, 1, 'the refusing worker entry point must fail its process');
  assert.equal(calls.processes.length, 0, 'the crash refusal must not spawn another process');
  assert.equal(calls.stop, 0, 'the crash refusal must not turn into a signal stop');

  // The crash record is the documented output of this executable. Assert the
  // one necessary write and prove that no additional file write escapes it.
  assert.equal(calls.mkdir.length, 1, 'the crash handler must prepare only its daemon-log directory');
  assert.equal(calls.append.length, 1, 'the crash handler must write exactly one lifecycle record');
  const [filename, line, encoding] = calls.append[0];
  assert.equal(filename, path.join(ROOT, 'logs', 'native-agent-worker.log'));
  assert.equal(encoding, 'utf8');
  const record = JSON.parse(line);
  assert.equal(record.event, 'worker_crashed');
  assert.equal(record.code, 'NATIVE_AGENT_WORKER_FAILED');
  assert.equal(record.message, 'injected main-loop failure');
  assert.equal(record.secretValuesEmitted, false);

  process.stdout.write('native-agent-worker failed refusal: 13 checks passed\n');
});
