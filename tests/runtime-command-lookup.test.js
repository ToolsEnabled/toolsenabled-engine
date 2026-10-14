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
const { commandPath, findBrowser, resetCommandPathCache } = require(runtimePath);
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

// findBrowser() answers with a path, never a boolean. system.status reports it
// as browser.path and system.doctor takes path.basename() of it, which threw
// "The \"path\" argument must be of type string. Received type boolean (true)"
// on every Linux desktop with Chrome, Chromium or Edge on PATH. The Windows
// branch probes fixed install folders instead, so this runs off Windows only.
if (process.platform !== 'win32') {
  resetCommandPathCache();
  answers.push({ status: 1, stdout: '', stderr: '' });
  answers.push({ status: 0, stdout: '/usr/bin/chromium\n', stderr: '' });
  const found = findBrowser();
  assert.equal(typeof found, 'string', 'findBrowser returns the browser path, not a boolean');
  assert.equal(found, '/usr/bin/chromium');
  assert.equal(path.basename(found), 'chromium');

  resetCommandPathCache();
  answers.push({ status: 1, stdout: '', stderr: '' });
  answers.push({ status: 1, stdout: '', stderr: '' });
  answers.push({ status: 1, stdout: '', stderr: '' });
  assert.equal(findBrowser(), null, 'no browser on PATH is null, not false');
  assert.equal(probes, 13);
}
console.log('runtime command lookup preserves absence and reports could-not-tell separately');
