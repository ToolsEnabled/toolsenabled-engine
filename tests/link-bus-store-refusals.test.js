'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

let spawnCalls = 0;
for (const method of ['spawn', 'spawnSync', 'exec', 'execFile', 'fork']) {
  const original = childProcess[method];
  childProcess[method] = function countedProcessLaunch(...args) {
    spawnCalls += 1;
    return original.apply(this, args);
  };
}
const { createStore } = require('../sidecars/link-bus/store');

function temporaryStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'link-bus-store-refusals-'));
}

function snapshot(directory) {
  return fs.readdirSync(directory).sort().map(name => ({
    name,
    contents: fs.readFileSync(path.join(directory, name))
  }));
}

function assertRefusal(action, { code, message }) {
  assert.throws(action, error => {
    assert.strictEqual(error.code, code);
    assert.strictEqual(error.message, message);
    return true;
  });
}

// sender is checked before channelState() can create or load a channel. This
// drives the public append operation and proves malformed input cannot append.
{
  const stateDir = temporaryStateDir();
  const store = createStore({ stateDir, now: () => 123 });

  assertRefusal(() => store.append({
    channel: 'coordination',
    sender: '../not-an-agent',
    message: 'must not be persisted',
    sentAt: '2026-08-27T00:00:00.000Z'
  }), {
    code: 'LINK_BUS_SENDER_INVALID',
    message: 'sender must be a short agent-name-shaped string.'
  });
  assert.deepStrictEqual(snapshot(stateDir), [], 'invalid sender must not write a channel file');
  assert.strictEqual(store.totalCount(), 0, 'invalid sender must not enter in-memory state');
  assert.strictEqual(spawnCalls, 0, 'invalid sender must not launch a process');
}

// cursor conversion is also performed before channelState(). A non-integral
// cursor therefore refuses without creating, loading, or changing a channel.
{
  const stateDir = temporaryStateDir();
  const store = createStore({ stateDir });

  assertRefusal(() => store.list({ channel: 'coordination', cursor: '1.5' }), {
    code: 'LINK_BUS_CURSOR_INVALID',
    message: 'cursor must be a non-negative integer.'
  });
  assert.deepStrictEqual(snapshot(stateDir), [], 'invalid cursor must not write a channel file');
  assert.strictEqual(store.totalCount(), 0, 'invalid cursor must not create a channel state');
  assert.strictEqual(spawnCalls, 0, 'invalid cursor must not launch a process');
}

// A caller can reach STORE_UNAVAILABLE by opening a channel whose durable file
// is corrupt. Preserve the exact bytes to prove a failed read neither repairs
// nor replaces evidence on disk.
{
  const stateDir = temporaryStateDir();
  const channelFile = path.join(stateDir, 'channel-coordination.ndjson');
  const corruptBytes = Buffer.from('{not valid ndjson}\n', 'utf8');
  fs.writeFileSync(channelFile, corruptBytes);
  const before = snapshot(stateDir);
  const store = createStore({ stateDir });

  assertRefusal(() => store.list({ channel: 'coordination', cursor: '0' }), {
    code: 'LINK_BUS_STORE_UNAVAILABLE',
    message: 'The link bus durable store is corrupt.'
  });
  assert.deepStrictEqual(snapshot(stateDir), before, 'a corrupt-store refusal must not mutate durable state');
  assert.strictEqual(spawnCalls, 0, 'a corrupt-store refusal must not launch a process');
}

console.log('Link bus store refusal tests passed (3 driven refusals).');
