'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const jobs = require('../src/lib/windows-job-control');

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(extra = {}) {
  const native = new EventEmitter();
  native.pid = 4242;
  native.kill = () => { queueMicrotask(() => native.emit('close', 125, null)); return true; };
  const socket = new EventEmitter();
  const sent = [];
  socket.setEncoding = () => {};
  socket.write = value => { sent.push(value.split(' ')[0]); return true; };
  socket.destroy = () => { socket.destroyed = true; };
  const files = new Map();
  const fsImpl = {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    mkdirSync: () => {},
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFileSync: file => { if (!files.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return files.get(file); },
    unlinkSync: file => files.delete(file)
  };
  const child = jobs.spawnInJob('inert-fixture', [], { cwd: path.resolve(__dirname), env: {} }, {
    platform: 'win32', spawnImpl: () => native, fsImpl,
    recordDirectory: path.resolve(__dirname, 'in-memory-only'),
    assemblyCacheDirectory: null, safeLaunchEnvironment: value => value,
    connectPipeImpl: async () => socket, ...extra
  });
  child.on('error', () => {});
  return { child, native, socket, sent };
}
async function observedOutcome(child) {
  let result;
  child.jobOutcome.then(value => { result = { value }; }, error => { result = { error }; });
  await turn();
  return result;
}

test('pre-READY error settles original failure on actual close without inventing identity', async () => {
  const { child, native, socket } = fixture();
  native.emit('spawn');
  await turn();
  const message = 'The control client did not send a bounded request.';
  socket.emit('data', 'ERROR WINDOWS_JOB_WRAPPER_FAILED ' + Buffer.from(message).toString('base64') + '\n');
  await assert.rejects(child.jobReady, { code: 'WINDOWS_JOB_WRAPPER_FAILED', message });
  assert.equal(await observedOutcome(child), undefined, 'no outcome before actual native close');
  native.emit('close', 125, null);
  const result = await observedOutcome(child);
  assert.ok(result, 'actual close must settle outcome without waiting for a command timeout');
  assert.equal(result.error.code, 'WINDOWS_JOB_WRAPPER_FAILED');
  assert.equal(result.error.message, message);
  assert.equal(child.jobIdentity, null);
  assert.equal((await child.jobClosed).failure, result.error);
});

test('close before any status settles an explicit failure', async () => {
  const { child, native } = fixture();
  native.emit('close', 125, null);
  const result = await observedOutcome(child);
  assert.equal(result.error.code, 'WINDOWS_JOB_WRAPPER_FAILED');
  assert.equal(child.jobIdentity, null);
});

test('trusted admission refusal retains not-started outcome and sends no OWNER', async () => {
  const { child, native, sent } = fixture({
    beforeRootSpawn() { throw Object.assign(new Error('fixture admission refused'), { code: 'AGENT_RESOURCE_REFUSED' }); }
  });
  native.emit('spawn');
  await turn();
  await assert.rejects(child.jobReady, { code: 'AGENT_RESOURCE_REFUSED' });
  assert.equal((await observedOutcome(child)).value.type, 'not-started');
  assert.deepEqual(sent, []);
  assert.equal(child.jobIdentity, null);
});

test('explicit cancellation before OWNER retains not-started outcome', async () => {
  let release;
  const preparation = new Promise(resolve => { release = resolve; });
  const { child, native, sent } = fixture({ prepareRootSpawn: () => preparation });
  native.emit('spawn');
  await turn();
  const result = await child.terminateJob();
  release();
  await turn();
  assert.equal(result.type, 'not-started');
  assert.equal(result.activeProcesses, 0);
  assert.deepEqual(sent, []);
  assert.equal(child.jobIdentity, null);
});

test('normal READY and terminal receipt remain successful', async () => {
  const { child, native, socket } = fixture();
  native.emit('spawn');
  await turn();
  socket.emit('data', 'READY 4242 1234 4343 5678\n');
  await child.jobReady;
  socket.emit('data', 'EXIT 0 0\n');
  native.emit('close', 0, null);
  assert.deepEqual((await observedOutcome(child)).value, { type: 'exit', exitCode: 0, activeProcesses: 0 });
  assert.equal((await child.jobClosed).failure, null);
});
