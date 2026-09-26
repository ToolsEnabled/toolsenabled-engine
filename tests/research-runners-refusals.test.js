'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Install observable seams before runners.js captures its dependencies.  Each
// refusal below must happen by calling a public runner, not by inspecting its
// source, and these counters prove refused work never reaches the network or a
// child process.
const childProcess = require('node:child_process');
const http = require('../src/lib/http');
const originalSpawn = childProcess.spawn;
const originalRequest = http.request;
const originalWrite = fs.writeFileSync;
let spawnCalls = 0;
let requestCalls = 0;
let writeCalls = 0;
let requestResult;
childProcess.spawn = (...args) => {
  spawnCalls += 1;
  return originalSpawn(...args);
};
http.request = async () => {
  requestCalls += 1;
  return requestResult;
};
fs.writeFileSync = (...args) => {
  writeCalls += 1;
  return originalWrite(...args);
};

const { RunnerError, defaultDispatch, runHttp, runProcess } = require('../src/lib/research/runners');
childProcess.spawn = originalSpawn;
http.request = originalRequest;

function processInput(runnerConfig) {
  return {
    experiment: { runnerConfig, timeoutMs: 1000 },
    run: { runId: 'refusal-fixture', params: {} },
    artifactDir: process.cwd()
  };
}

async function rejectsCode(thunk, code) {
  await assert.rejects(thunk, error => error instanceof RunnerError && error.code === code);
}

test('invalid process configuration refuses before spawning or writing', async () => {
  const writesBefore = writeCalls;
  await rejectsCode(async () => runProcess(processInput({ command: '' })), 'RESEARCH_RUNNER_CONFIG_INVALID');
  assert.equal(spawnCalls, 0);
  assert.equal(writeCalls, writesBefore);
});

test('http transport and credentials refuse before a request is sent', async () => {
  const writesBefore = writeCalls;
  const experiment = url => ({ runnerConfig: { url }, timeoutMs: 1000 });
  await rejectsCode(() => runHttp({ experiment: experiment('http://example.com/research'), run: { params: {} } }),
    'RESEARCH_RUNNER_HTTPS_REQUIRED');
  await rejectsCode(() => runHttp({ experiment: experiment('https://user:secret@example.com/research'), run: { params: {} } }),
    'RESEARCH_RUNNER_CREDENTIAL_REFUSED');
  assert.equal(requestCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(writeCalls, writesBefore);
});

test('unsupported, unavailable, and unknown environment profiles refuse before spawning', async () => {
  const writesBefore = writeCalls;
  await rejectsCode(async () => runProcess(processInput({ command: 'unused', envProfile: 'owner-shell' })),
    'RESEARCH_ENV_PROFILE_UNSUPPORTED');

  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === '../multi-account/registry' && parent && /research[/\\]runners\.js$/.test(parent.filename)) {
        const error = new Error("Cannot find module '../multi-account/registry'");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    await rejectsCode(async () => runProcess(processInput({
      command: 'unused', envProfile: 'codex-account', envProfileAccount: 'missing'
    })), 'RESEARCH_ENV_PROFILE_UNAVAILABLE');

    let launchCalls = 0;
    Module._load = function (request, parent, isMain) {
      if (parent && /research[/\\]runners\.js$/.test(parent.filename)) {
        if (request === '../multi-account/registry') return { listAccounts: () => [] };
        if (request === '../multi-account/launch') return { launchEnvironment: () => { launchCalls += 1; return {}; } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    await rejectsCode(async () => runProcess(processInput({
      command: 'unused', envProfile: 'codex-account', envProfileAccount: 'missing'
    })), 'RESEARCH_ENV_PROFILE_ACCOUNT_UNKNOWN');
    assert.equal(launchCalls, 0, 'an unknown account must not be given to the launcher');
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(spawnCalls, 0);
  assert.equal(requestCalls, 0);
  assert.equal(writeCalls, writesBefore);
});

test('a negative bridge receipt rejects dispatch without spawning or writing', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'research-bridge-refusal-'));
  const fixtureState = path.join(fixtureRoot, 'state');
  fs.mkdirSync(fixtureState);
  fs.writeFileSync(path.join(fixtureState, 'mission-bridge-runtime.json'),
    JSON.stringify({ baseUrl: 'http://127.0.0.1:43123' }), 'utf8');
  fs.writeFileSync(path.join(fixtureState, 'mission-bridge-token.json'),
    JSON.stringify({ token: 'fixture-token' }), 'utf8');
  requestResult = {
    status: 503,
    body: { ok: false, error: { code: 'BRIDGE_BUSY' } }
  };
  const writesBefore = writeCalls;
  try {
    await rejectsCode(() => defaultDispatch(
      { brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 },
      { rootPath: (...parts) => path.join(fixtureRoot, ...parts) }
    ),
      'RESEARCH_BRIDGE_DISPATCH_FAILED');
    assert.equal(requestCalls, 1, 'the bridge refusal must come from a driven dispatch response');
    assert.equal(spawnCalls, 0);
    assert.equal(writeCalls, writesBefore);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('an indeterminate bridge-state path refuses before network or writes', async () => {
  const requestsBefore = requestCalls;
  const writesBefore = writeCalls;
  await rejectsCode(() => defaultDispatch(
    { brief: 'fixture', objectiveRef: 'fixture', timeoutMs: 1000 },
    { rootPath: () => { throw Object.assign(new Error('fixture state-root failure'), { code: 'EIO' }); } }
  ), 'RESEARCH_BRIDGE_STATE_INDETERMINATE');
  assert.equal(requestCalls, requestsBefore);
  assert.equal(spawnCalls, 0);
  assert.equal(writeCalls, writesBefore);
});

test.after(() => {
  childProcess.spawn = originalSpawn;
  http.request = originalRequest;
  fs.writeFileSync = originalWrite;
});
