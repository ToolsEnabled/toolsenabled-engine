'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const host = require('../tools/full-remote-access-listener-host');
const HOST_PATH = path.join(__dirname, '..', 'tools', 'full-remote-access-listener-host.js');

function fakeFs() {
  const calls = [];
  return {
    calls,
    mkdirSync(...args) { calls.push(['mkdirSync', ...args]); },
    openSync(...args) { calls.push(['openSync', ...args]); return 41; },
    writeSync(...args) { calls.push(['writeSync', ...args]); },
    closeSync(...args) { calls.push(['closeSync', ...args]); }
  };
}

function invokeHost(script) {
  return spawnSync(process.execPath, ['-e', `
    const host = require(${JSON.stringify(HOST_PATH)});
    ${script}
  `], { encoding: 'utf8', timeout: 10000, windowsHide: true });
}

function appendedLog(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const result = action();
  const appended = fs.readFileSync(file).subarray(before).toString('utf8');
  return { result, appended };
}

test('installStreamRedirect refuses every invalid stream and file input with its named code', () => {
  const writable = { write() {} };
  const invalidValues = [
    [null, '/absolute.log'],
    [{}, '/absolute.log'],
    [{ write: true }, '/absolute.log'],
    [writable, null],
    [writable, 7],
    [writable, 'relative.log']
  ];

  for (const [stream, file] of invalidValues) {
    assert.throws(
      () => host.installStreamRedirect(stream, file, fakeFs()),
      { message: 'FRA_LISTENER_STREAM_REDIRECT_INVALID' },
      `expected refusal for stream=${String(stream)} file=${String(file)}`
    );
  }
});

test('installStreamRedirect writes buffers and strings and exposes restore and close', () => {
  const writes = [];
  const originalWrite = chunk => { writes.push(chunk); return false; };
  const stream = { write: originalWrite };
  const io = fakeFs();
  const redirect = host.installStreamRedirect(stream, '/tmp/fra-listener-test.log', io);
  let callbacks = 0;

  assert.equal(stream.write('hello', 'utf8', () => { callbacks += 1; }), true);
  assert.equal(stream.write(Buffer.from('!'), () => { callbacks += 1; }), true);
  assert.equal(callbacks, 2);
  assert.deepEqual(io.calls.filter(call => call[0] === 'writeSync').map(call => call[2].toString()), ['hello', '!']);
  redirect.restore();
  assert.equal(stream.write, originalWrite);
  redirect.close();
  assert.deepEqual(io.calls.at(-1), ['closeSync', 41]);
});

test('startup refusals use a bounded named code and exit 1', () => {
  for (const [code, expected] of [
    ['BRIDGE_REFUSED', 'BRIDGE_REFUSED'],
    ['lowercase-is-not-safe', 'FRA_STARTUP_FAILED'],
    ['X'.repeat(101), 'FRA_STARTUP_FAILED'],
    [null, 'FRA_STARTUP_FAILED']
  ]) {
    const { result, appended } = appendedLog(host.STDERR_LOG, () => invokeHost(`
      host.run({ loadBridge: () => {
        const error = new Error('sensitive detail');
        error.code = ${JSON.stringify(code)};
        throw error;
      }});
    `));
    assert.equal(result.status, 1, `startup refusal ${String(code)} must exit 1`);
    assert.match(appended, new RegExp(`startup failed: ${expected}\\n$`));
    assert.doesNotMatch(appended, /sensitive detail/);
  }
});

test('SIGTERM closes the service and takes the named successful exit 0', () => {
  const result = invokeHost(`
    host.run({ loadBridge: () => ({
      start: () => ({ id: 'service-value' }),
      closeService: (service, done) => {
        if (service.id !== 'service-value') process.exit(9);
        done();
      }
    }) });
    process.emit('SIGTERM');
  `);
  assert.equal(result.status, 0);
});

test('a synchronous shutdown refusal takes the named failure exit 1', () => {
  const { result, appended } = appendedLog(host.STDERR_LOG, () => invokeHost(`
      host.run({ loadBridge: () => ({
        start: () => ({ id: 'service-value' }),
        closeService: () => { throw new Error('close refused'); }
      }) });
      process.emit('SIGINT');
    `));
  assert.equal(result.status, 1);
  assert.equal(appended, '', 'the refusal is contained rather than escaping as an uncaught exception');
});

test('an asynchronous scope-retirement refusal exits 1 and logs only its bounded code', () => {
  for (const [code, expected] of [
    ['FRA_FILE_SCOPE_RETIREMENT_FAILED', 'FRA_FILE_SCOPE_RETIREMENT_FAILED'],
    ['private scope detail: not a code', 'FRA_FILE_SCOPE_RETIREMENT_FAILED']
  ]) {
    const { result, appended } = appendedLog(host.STDERR_LOG, () => invokeHost(`
      host.run({ loadBridge: () => ({
        start: () => ({ id: 'service-value' }),
        closeService: (service, done) => {
          const error = Object.assign(new Error('sensitive scope and path detail'), { code: ${JSON.stringify(code)} });
          setImmediate(() => done(error));
        }
      }) });
      process.emit('SIGTERM');
    `));
    assert.equal(result.error, undefined, 'the owned child must finish inside its finite deadline');
    assert.equal(result.status, 1, 'unproved scope retirement cannot report successful shutdown');
    assert.match(appended, new RegExp(`shutdown unproved: ${expected}\\n$`));
    assert.doesNotMatch(appended, /sensitive scope|private scope detail/);
  }
});

test('real closeService requires and awaits the scope-retirement join without inventing cleanup success', async () => {
  const { closeService } = require('../src/full-remote-access-bridge');
  const makeService = waitForFileScopeRetirements => ({
    health: { close(done) { done(); } },
    bridge: { destroySessions() {}, close(done) { done(); }, ...waitForFileScopeRetirements }
  });
  const missing = await new Promise(resolve => closeService(makeService({}), resolve));
  assert.equal(missing?.code, 'FRA_FILE_SCOPE_RETIREMENT_FAILED');
  for (const failed of [false, true]) {
    let settle;
    let called = false;
    let joined = false;
    const refusal = Object.assign(new Error('fixture unresolved retirement'), { code: 'FRA_FILE_SCOPE_RETIREMENT_FAILED' });
    const wait = new Promise((resolve, reject) => { settle = () => failed ? reject(refusal) : resolve(); });
    const closing = new Promise(resolve => closeService(makeService({
      waitForFileScopeRetirements() { joined = true; return wait; }
    }), error => { called = true; resolve(error); }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(joined, true);
    assert.equal(called, false, 'requesting retirement is not completion of its durable join');
    settle();
    assert.equal(await closing, failed ? refusal : undefined);
  }
});
