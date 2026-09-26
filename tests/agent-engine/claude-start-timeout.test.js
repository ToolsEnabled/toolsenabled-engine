'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const modulePath = require.resolve('../../src/lib/agent-engine/claude-process');
const originalLoad = Module._load;
const observations = {
  adapterCloses: 0,
  initializeCalls: 0,
  kills: 0,
  spawns: [],
  starts: 0,
  writes: []
};

function fakeStream() {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.writable = true;
  stream.setEncoding = () => {};
  stream.write = chunk => {
    observations.writes.push(chunk);
    return true;
  };
  stream.destroy = () => {
    stream.destroyed = true;
    stream.writable = false;
  };
  return stream;
}

function spawnHidden(command, args, options) {
  observations.spawns.push({ command, args, options });
  const child = new EventEmitter();
  child.stdin = fakeStream();
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    observations.kills += 1;
    child.signalCode = 'SIGTERM';
    return true;
  };
  return child;
}

class ClaudeAdapter {
  constructor({ transport }) {
    this.transport = transport;
  }

  initialize() {
    observations.initializeCalls += 1;
    return new Promise(() => {});
  }

  startThread() {
    observations.starts += 1;
    throw new Error('startThread must not be reached after initialization times out');
  }

  close() {
    observations.adapterCloses += 1;
  }
}

async function main() {
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === modulePath && request === '../proc/hidden-spawn') {
      return { spawnHidden };
    }
    if (parent && parent.filename === modulePath && request === './claude-adapter') {
      return { ClaudeAdapter };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[modulePath];
  let startClaudeSession;
  try {
    ({ startClaudeSession } = require(modulePath));
  } finally {
    Module._load = originalLoad;
  }

  const startedAt = Date.now();
  let refusal;
  try {
    await startClaudeSession({
      cwd: process.cwd(),
      apiKey: undefined,
      startupTimeoutMs: 15
    });
    assert.fail('a permanently pending ACP initialization must time out');
  } catch (error) {
    refusal = error;
  }

  assert.equal(refusal.code, 'CLAUDE_ACP_START_TIMEOUT');
  assert.match(refusal.message, /^Timed out after 15ms starting the Claude ACP session$/);
  assert.ok(Date.now() - startedAt >= 10, 'the asynchronous timeout must actually elapse');
  assert.equal(refusal.claudeProcess.code, null);
  assert.equal(refusal.claudeProcess.signal, null);
  assert.equal(refusal.claudeProcess.error, null);
  assert.equal(refusal.claudeProcess.stderr, '');
  assert.deepEqual(refusal.claudeProcess.cleanupErrors, []);

  assert.equal(observations.initializeCalls, 1, 'the module must drive initialization before timing out');
  assert.equal(observations.starts, 0, 'the refusal must prevent thread creation');
  assert.deepEqual(observations.writes, [], 'the refusal path must not write through the transport seam');
  assert.equal(observations.spawns.length, 1, 'startup inherently creates exactly one ACP process');
  assert.equal(observations.adapterCloses, 1, 'the timed-out adapter must be closed');
  assert.equal(observations.kills, 1, 'the timed-out child must be terminated');

  const configDir = observations.spawns[0].options.env.CLAUDE_CONFIG_DIR;
  assert.equal(fs.existsSync(configDir), false, 'the timed-out session config directory must be removed');

  process.stdout.write('ok - pending Claude ACP initialization refuses with CLAUDE_ACP_START_TIMEOUT and cleans up\n');
}

main().catch(error => {
  Module._load = originalLoad;
  delete require.cache[modulePath];
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
