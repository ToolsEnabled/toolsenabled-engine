'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  TerminalDisplay,
  TerminalResizePipe,
  bindTerminalResize,
  normalizeTerminalDimensions
} = require('../tools/zed-context-terminal');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.records = [];
  }

  write(value) {
    this.records.push(Buffer.from(value));
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.listening = false;
    this.closed = false;
    this.unrefCalled = false;
  }

  listen(pipeName, callback) {
    this.pipeName = pipeName;
    this.listening = true;
    callback?.();
    this.emit('listening');
  }

  close(callback) {
    this.closed = true;
    this.listening = false;
    callback?.();
    this.emit('close');
  }

  unref() {
    this.unrefCalled = true;
  }
}

class FakeNet {
  constructor() {
    this.server = new FakeServer();
  }

  createServer() {
    return this.server;
  }
}

function dimensionsEventTarget(columns, rows) {
  const output = new EventEmitter();
  output.columns = columns;
  output.rows = rows;
  return output;
}

async function main() {
  assert.deepEqual(normalizeTerminalDimensions(20, 400), { columns: 20, rows: 400 });
  assert.equal(normalizeTerminalDimensions(19, 40), null);
  assert.equal(normalizeTerminalDimensions(40, 401), null);

  const fakeNet = new FakeNet();
  const pipe = new TerminalResizePipe({
    netModule: fakeNet,
    initialDimensions: { columns: 80, rows: 30 }
  });
  const start = pipe.start();
  assert.match(pipe.pipeName, /^\\\\\.\\pipe\\zed-context-terminal-resize-/);
  pipe.update(100, 40);
  pipe.update(120, 50);
  assert.equal(fakeNet.server.listenerCount('connection'), 1);
  await start;

  const socket = new FakeSocket();
  fakeNet.server.emit('connection', socket);
  assert.deepEqual(socket.records.map(record => record.toString('utf8')), ['120 50\n']);
  assert.equal(pipe.update(120, 50), false, 'duplicate dimensions must not be sent');
  assert.equal(pipe.update(19, 50), false, 'invalid columns must be ignored');
  assert.equal(pipe.update(130, 60), true);
  assert.deepEqual(socket.records.map(record => record.toString('utf8')), ['120 50\n', '130 60\n']);

  socket.emit('close');
  assert.equal(pipe.socket, null);
  await pipe.close();
  assert.equal(fakeNet.server.closed, true);
  assert.equal(fakeNet.server.listenerCount('connection'), 0);
  assert.equal(fakeNet.server.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(pipe.update(140, 70), false, 'closed pipe must not queue work');

  const failedNet = new FakeNet();
  failedNet.server.listen = function listen(pipeName) {
    this.pipeName = pipeName;
    this.emit('error', new Error('listen failed'));
  };
  const failedPipe = new TerminalResizePipe({ netModule: failedNet });
  const failedStart = failedPipe.start();
  await assert.rejects(failedStart, /listen failed/);
  await failedPipe.close();
  assert.equal(failedNet.server.closed, true, 'listen errors still close the named-pipe server');
  assert.equal(failedNet.server.listenerCount('connection'), 0);
  assert.equal(failedNet.server.listenerCount('error'), 0);

  let output = '';
  const display = new TerminalDisplay({ write(value) { output += value.toString(); } }, { columns: 80 });
  display.insertInput('a long input line');
  const stdout = dimensionsEventTarget(80, 30);
  const updates = [];
  const detachResize = bindTerminalResize(stdout, display, {
    update(columns, rows) { updates.push([columns, rows]); }
  });
  assert.equal(stdout.listenerCount('resize'), 1);
  const beforeResize = output.length;
  stdout.columns = 40;
  stdout.rows = 24;
  stdout.emit('resize');
  assert.equal(display.columns, 40);
  assert.deepEqual(updates, [[40, 24]]);
  assert.ok(output.length > beforeResize, 'resize redraws the current input line');

  display.showRawPreview('native preview');
  const duringPreview = output.length;
  stdout.columns = 60;
  stdout.rows = 25;
  stdout.emit('resize');
  assert.equal(display.columns, 60);
  assert.deepEqual(updates, [[40, 24], [60, 25]]);
  assert.equal(output.length, duringPreview, 'resize does not redraw over an active raw preview');
  display.restoreRawPreview({ force: true });
  assert.match(output.slice(output.lastIndexOf('\x1b[2J\x1b[3J\x1b[H')), /a long input line/);
  detachResize();
  assert.equal(stdout.listenerCount('resize'), 0);
  display.finish();

  let activityOutput = '';
  const activityDisplay = new TerminalDisplay({ write(value) { activityOutput += value.toString(); } }, { columns: 80 });
  activityDisplay.showActivity('shell');
  const activityStdout = dimensionsEventTarget(80, 30);
  const detachActivityResize = bindTerminalResize(activityStdout, activityDisplay, { update() {} });
  const beforeActivityResize = activityOutput.length;
  activityStdout.columns = 50;
  activityStdout.emit('resize');
  assert.equal(activityDisplay.columns, 50);
  assert.ok(activityOutput.length > beforeActivityResize, 'resize redraws the current activity line');
  detachActivityResize();
  assert.equal(activityStdout.listenerCount('resize'), 0);
  activityDisplay.finish();

  console.log('Zed context-terminal resize protocol and lifecycle tests passed.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
