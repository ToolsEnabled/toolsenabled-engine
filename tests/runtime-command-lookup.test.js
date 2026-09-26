'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const runtimePath = path.resolve(__dirname, '..', 'src', 'lib', 'runtime.js');
const realLoad = Module._load;
const answers = [];
let probes = 0;

Module._load = function mockRuntimeDependencies(request, parent, isMain) {
  if (request === 'node:child_process' && parent && parent.filename === runtimePath) {
    const real = realLoad(request, parent, isMain);
    return {
      ...real,
      spawnSync() {
        probes += 1;
        return answers.shift();
      }
    };
  }
  return realLoad(request, parent, isMain);
};

delete require.cache[runtimePath];
const { commandPath } = require(runtimePath);
Module._load = realLoad;

// CONTROL: an answered miss remains the same definite absence it was before;
// runtime has never cached command lookups, so there is no legitimate cache to
// preserve. Calling it twice also pins that an earlier miss is not latched.
answers.push({ status: 1, stdout: '', stderr: '' });
assert.equal(commandPath('definitely-missing'), null);
answers.push({ status: 0, stdout: '/bin/now-present\n', stderr: '' });
assert.equal(commandPath('definitely-missing'), '/bin/now-present');

for (const causeCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  const cause = Object.assign(new Error(causeCode), { code: causeCode });
  answers.push({ error: cause, status: null, stdout: '', stderr: '' });
  assert.throws(
    () => commandPath('busy-machine-tool'),
    error => error.code === 'COMMAND_LOOKUP_UNKNOWN'
      && error.causeCode === causeCode
      && /not a claim that it is absent/.test(error.message),
    `${causeCode} must be unknown rather than absent`
  );
}

answers.push({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
assert.throws(
  () => commandPath('silent-child'),
  error => error.code === 'COMMAND_LOOKUP_UNKNOWN'
    && error.causeCode === 'SIGNAL_SIGTERM'
    && /whether it is installed is unknown/.test(error.message)
);

assert.equal(probes, 8);
console.log('runtime command lookup preserves absence and reports could-not-tell separately');
