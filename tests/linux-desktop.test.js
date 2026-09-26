'use strict';
const isolated = require('./lib/isolated-environment').activate('linux-desktop');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// run-isolated creates its per-suite child with the caller's ordinary umask.
// This test owns that disposable directory; provision the capture prerequisite
// explicitly rather than weakening the product's ancestor-write refusal.
// The isolated runner uses a short te-*/NNN root so Unix sockets fit. A
// standalone test still owns a toolsenabled-linux-desktop-* root. Validate
// both exact disposable shapes before chmod, never an arbitrary test env path.
assert.ok([os.tmpdir(), '/tmp'].some(base => {
  const relative = path.relative(base, isolated.root).split(path.sep).join('/');
  return isolated.owner
    ? /^toolsenabled-linux-desktop-[A-Za-z0-9]{6}$/.test(relative)
    : /^te-[A-Za-z0-9]{6}\/[0-9]{3}$/.test(relative);
}));
assert.equal(fs.lstatSync(isolated.root).isSymbolicLink(), false);
assert.equal(fs.lstatSync(isolated.root).uid, process.getuid());
fs.chmodSync(isolated.root, 0o700);
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { spawnLinuxOwned } = require('../src/lib/linux-process-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const adapter = require('../src/lib/linux-desktop');
const desktop = require('../src/lib/desktop');
const capture = require('../src/lib/linux-capture');
const { rootPath } = require('../src/lib/runtime');

// Independent PNG reconstruction: native production uses Pillow, this fixture
// uses Node zlib + the five PNG row filters and checks actual literal pixels.
function rgb(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8); assert.equal(png[25], 2); assert.equal(png[28], 0);
  assert.ok(width * height <= 800 * 600);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = require('node:zlib').inflateSync(Buffer.concat(chunks), { maxOutputLength: height * (width * 3 + 1) });
  assert.equal(raw.length, height * (width * 3 + 1));
  const bytes = Buffer.alloc(width * height * 3), stride = width * 3;
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= 3 ? bytes[at - 3] : 0;
      const b = y ? bytes[at - stride] : 0, c = y && x >= 3 ? bytes[at - stride - 3] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      bytes[at] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixel: (x, y) => [...bytes.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
}

function launch(command, args, env) {
  const child = spawnLinuxOwned(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'],
    terminateDescendantsOnRootExit: true }, { safeLaunchEnvironment });
  child.on('error', () => {});
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  // This is the owned Xvfb/interactive-fixture lifetime, not a product helper timeout.
  // The scenario sends many real commands after startup; 15 seconds killed the fixture mid-protocol.
  const deadline = setTimeout(() => void child.terminateJob(), 60000);
  child.jobClosed.then(() => clearTimeout(deadline));
  return { child, async line() {
    const next = await iterator.next();
    assert.equal(next.done, false, 'native fixture must actually answer');
    return next.value;
  }, async close() {
    const outcome = await child.terminateJob();
    const closed = await child.jobClosed;
    assert.equal(outcome.activeProcesses, 0);
    assert.equal(outcome.observedChildren, outcome.reapedChildren);
    assert.equal(closed.failure, null);
    reader.close();
  } };
}
function authority(number, cookie) {
  const field = data => {
    const length = Buffer.alloc(2); length.writeUInt16BE(data.length);
    return Buffer.concat([length, data]);
  };
  return Buffer.concat([Buffer.from([255, 255]), field(Buffer.alloc(0)),
    field(Buffer.from(number)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

test('real X11 snapshot uses server-owned PID, actual bounds, and refuses stale/malformed observations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-desktop-native-'));
  fs.chmodSync(dir, 0o700);
  const cookie = randomBytes(16);
  const serverAuth = path.join(dir, 'server.auth'), clientAuth = path.join(dir, 'client.auth');
  fs.writeFileSync(serverAuth, authority('', cookie), { flag: 'wx', mode: 0o600 });
  const minimal = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  let server, fixture, worker;
  const keys = ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    server = launch('/usr/bin/Xvfb', ['-displayfd', '1', '-screen', '0', '800x600x24',
      '-nolisten', 'tcp', '-noreset', '-auth', serverAuth], minimal);
    await server.child.jobReady;
    const number = await server.line();
    assert.match(number, /^[0-9]{1,5}$/);
    fs.writeFileSync(clientAuth, authority(number, cookie), { flag: 'wx', mode: 0o600 });
    const env = { ...minimal, DISPLAY: `:${number}`, XAUTHORITY: clientAuth, XDG_SESSION_TYPE: 'x11' };
    fixture = launch('/usr/bin/python3', ['-I', '-S', '-B', path.join(__dirname, 'fixtures/linux-desktop-window.py')], env);
    await fixture.child.jobReady;
    const ready = JSON.parse(await fixture.line());
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    const answer = desktop.windowList();
    assert.equal(answer.count, 1, 'a fabricated empty list cannot pass');
    assert.equal(answer.contentTrust, 'untrusted');
    assert.equal(answer.grantsAuthority, false);
    const window = answer.windows[0];
    assert.equal(window.windowId, ready.windowId);
    assert.equal(window.processId, ready.pid, 'spoofed _NET_WM_PID=1 must not be trusted');
    const stat = fs.readFileSync(`/proc/${ready.pid}/stat`, 'utf8');
    assert.equal(window.processStartKey, stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
    assert.equal(window.title, 'Fixture — native Linux');
    assert.equal(window.appLabel, 'NativeFixture');
    assert.deepEqual([window.x, window.y, window.width, window.height], [40, 50, 320, 160]);
    assert.equal(window.captureEligible, false, 'listing is not a qualified capture adapter');
    worker = desktop.createDesktopWorkerClient();
    const asynchronous = await worker.run('windowList');
    assert.equal(asynchronous.count, 1);
    assert.equal(asynchronous.windows[0].windowId, ready.windowId);
    assert.equal(asynchronous.windows[0].processId, ready.pid);
    const full = await worker.run('screenCapture', { filename: 'native-full.png' });
    assert.deepEqual([full.width, full.height], [800, 600]);
    assert.equal(fs.statSync(full.path).mode & 0o777, 0o600);
    const pixels = rgb(fs.readFileSync(full.path));
    assert.deepEqual(pixels.pixel(0, 0), [0, 0, 0]);
    assert.deepEqual(pixels.pixel(60, 70), [255, 255, 255]);
    const region = await worker.run('screenCaptureRegion', { filename: 'native-region.png', x: 40, y: 50, width: 32, height: 32 });
    assert.deepEqual([region.width, region.height], [32, 32]);
    assert.deepEqual(rgb(fs.readFileSync(region.path)).pixel(16, 16), [255, 255, 255]);
    const preview = await worker.run('readCapture', { path: full.path, maxWidth: 80, maxHeight: 80 });
    assert.deepEqual([preview.width, preview.height], [80, 60]);
    assert.ok(Buffer.isBuffer(preview.__mcpImage), 'the actual worker must deliver image bytes, not only a path');
    assert.equal(Object.keys(preview).includes('__mcpImage'), false);
    assert.equal(JSON.stringify(preview).includes(preview.__mcpImage.toString('base64')), false);
    // Sample the interior, outside Lanczos' edge-filter support.
    assert.deepEqual(rgb(preview.__mcpImage).pixel(20, 13), [255, 255, 255]);
    assert.deepEqual(rgb(preview.__mcpImage).pixel(0, 0), [0, 0, 0]);
    const entries = fs.readdirSync(rootPath('captures'));
    assert.equal(entries.some(name => name.startsWith('mcp-source-')), false, 'Linux needs no transient image copy');
    await assert.rejects(worker.run('screenCaptureRegion', { filename: 'invalid-region.png', x: 790, y: 0, width: 20, height: 20 }),
      { code: 'DESKTOP_CAPTURE_REGION_INVALID' });
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'invalid-region.png')), false);
    const original = fs.readFileSync(full.path);
    const second = desktop.screenCapture({ filename: 'native-full.png' });
    assert.notEqual(second.path, full.path);
    assert.deepEqual(fs.readFileSync(full.path), original, 'the original capture is never overwritten');
    const outside = path.join(dir, 'outside.png'); fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
    const alias = path.join(rootPath('captures'), 'alias.png'); fs.symlinkSync(outside, alias);
    assert.throws(() => capture.screen(alias), { code: 'CAPTURE_OUTPUT_EXISTS' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
    fs.unlinkSync(alias);
    const refused = path.join(rootPath('captures'), 'refused.png');
    assert.throws(() => capture.screen(refused, { environment: { DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' } }),
      { code: 'DESKTOP_PLATFORM_UNSUPPORTED' });
    assert.equal(fs.existsSync(refused), false);
    assert.throws(() => capture.thumbnail({ output: refused, source: Buffer.from('not an image'), maxWidth: 80, maxHeight: 80 }));
    assert.equal(fs.existsSync(refused), false);
    const command = async name => {
      fixture.child.stdin.write(JSON.stringify({ command: name }) + '\n');
      assert.equal(JSON.parse(await fixture.line()).command, name);
    };
    const target = { windowId: window.windowId, expectedProcessId: window.processId,
      expectedProcessStartKey: window.processStartKey };
    const unavailable = await worker.run('screenCaptureWindow', { ...target, filename: 'unredirected.png' });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'unredirected.png')), false);
    await command('redirect-cover');
    assert.equal(desktop.windowList().windows[0].captureEligible, true);
    const coveredScreen = await worker.run('screenCaptureRegion', { x: 40, y: 50, width: 320, height: 160, filename: 'cover.png' });
    assert.deepEqual(rgb(fs.readFileSync(coveredScreen.path)).pixel(50, 50), [0, 0, 0]);
    const capturedWindow = await worker.run('screenCaptureWindow', { ...target, filename: 'window.png' });
    assert.equal(capturedWindow.status, 'blank_or_uniform');
    assert.equal(capturedWindow.method, 'xcomposite_named_pixmap');
    assert.equal(capturedWindow.usable, false);
    assert.deepEqual([capturedWindow.width, capturedWindow.height], [320, 160]);
    assert.deepEqual(rgb(fs.readFileSync(capturedWindow.path)).pixel(50, 50), [255, 255, 255]);
    for (const wrong of [{ expectedProcessId: 1 }, { expectedProcessStartKey: '0' }]) {
      const changed = await worker.run('screenCaptureWindow', { ...target, ...wrong, filename: 'wrong-target.png' });
      assert.equal(changed.status, 'target_changed');
      assert.equal(changed.window, null);
      assert.equal(fs.existsSync(path.join(rootPath('captures'), 'wrong-target.png')), false);
    }
    await command('uncover');
    await command('window-pattern');
    const patterned = await worker.run('screenCaptureWindow', { ...target, filename: 'window-pattern.png' });
    assert.equal(patterned.status, 'captured');
    assert.equal(patterned.usable, true);
    const patternPixels = rgb(fs.readFileSync(patterned.path));
    assert.deepEqual(patternPixels.pixel(5, 5), [0, 0, 0]);
    assert.deepEqual(patternPixels.pixel(50, 50), [255, 255, 255]);
    await command('unrelated-stale');
    const independent = await worker.run('screenCaptureWindow', { ...target, filename: 'unrelated-stale.png' });
    assert.equal(independent.status, 'captured', 'a stale unrelated window cannot prevent selected-target capture');
    await command('restore-list');
    const initialMonitors = await worker.run('listMonitors');
    assert.equal(initialMonitors.coordinateSpace, 'x11_root_pixels');
    assert.equal(initialMonitors.grantsAuthority, false);
    assert.ok(initialMonitors.monitors.some(item => item.width === 800 && item.height === 600));
    assert.ok(initialMonitors.monitors.every(item => item.workArea === null));
    await command('monitors-two');
    const multiple = await worker.run('listMonitors');
    const left = multiple.monitors.find(item => item.x === 0 && item.width === 400);
    const right = multiple.monitors.find(item => item.x === 400 && item.width === 400);
    assert.ok(left && right, 'native server must expose both explicitly configured monitor regions');
    assert.notEqual(left.monitorId, right.monitorId);
    assert.equal(left.dpiX, 102); assert.equal(left.dpiY, 102);
    const monitorCapture = await worker.run('screenCaptureMonitor', { filename: 'native-monitor.png', monitorId: right.monitorId });
    assert.deepEqual(monitorCapture.monitorBounds, { x: 400, y: 0, width: 400, height: 600 });
    assert.equal(monitorCapture.captured, true);
    assert.deepEqual(rgb(fs.readFileSync(monitorCapture.path)).pixel(60, 70), [0, 0, 0]);
    const leftCapture = await worker.run('screenCaptureMonitor', { filename: 'native-monitor-left.png', monitorId: left.monitorId });
    assert.deepEqual(rgb(fs.readFileSync(leftCapture.path)).pixel(60, 70), [255, 255, 255]);
    await command('monitors-workarea');
    const workAreas = desktop.listMonitors();
    assert.deepEqual(workAreas.monitors.find(item => item.monitorId === right.monitorId).workArea,
      { x: 400, y: 30, width: 400, height: 570 });
    await command('monitors-invalid-workarea');
    assert.throws(() => desktop.listMonitors(), { code: 'DESKTOP_SNAPSHOT_UNAVAILABLE' });
    await command('monitors-remove');
    const missing = await worker.run('screenCaptureMonitor', { filename: 'missing-monitor.png', monitorId: right.monitorId });
    assert.equal(missing.status, 'monitor_not_found');
    assert.equal(missing.captured, false);
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'missing-monitor.png')), false);
    await command('hide');
    assert.equal(desktop.windowList().windows[0].isMinimized, true);
    const hiddenCapture = await worker.run('screenCaptureWindow', { ...target, filename: 'hidden-window.png' });
    assert.equal(hiddenCapture.status, 'unavailable');
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'hidden-window.png')), false);
    await command('move');
    assert.equal(desktop.windowList().windows[0].x, 750);
    assert.equal(desktop.windowList().windows[0].isPartial, true);
    await command('other-desktop');
    assert.equal(desktop.windowList().windows[0].isCloaked, true);
    assert.equal(desktop.windowList().windows[0].isOffscreen, true);
    await command('invalid');
    assert.throws(() => desktop.windowList(), { code: 'DESKTOP_SNAPSHOT_UNAVAILABLE' });
    await command('empty');
    assert.equal(desktop.windowList().count, 0, 'a genuine empty EWMH list is distinct from a failed query');
    const absent = await worker.run('screenCaptureWindow', { ...target, filename: 'absent-window.png' });
    assert.equal(absent.status, 'target_changed');
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'absent-window.png')), false);
    await command('stale');
    assert.throws(() => desktop.windowList(), error => ['DESKTOP_SNAPSHOT_UNAVAILABLE', 'DESKTOP_PROCESS_IDENTITY_UNAVAILABLE'].includes(error.code));
    await assert.rejects(worker.run('screenCaptureWindow', { ...target, filename: 'destroyed-window.png' }));
    assert.equal(fs.existsSync(path.join(rootPath('captures'), 'destroyed-window.png')), false);
    await command('no-wm');
    assert.throws(() => desktop.windowList(), { code: 'DESKTOP_WINDOW_MANAGER_UNSUPPORTED' });
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    try {
      if (worker) await worker.close();
    } finally {
      try { if (fixture) await fixture.close(); } finally { if (server) await server.close(); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wayland, remote display and missing native session do not silently enumerate Xwayland or return empty success', () => {
  for (const environment of [{ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' },
    { DISPLAY: ':1', XDG_SESSION_TYPE: 'wayland' }]) {
    assert.throws(() => adapter.windowList({ environment }), { code: 'DESKTOP_PLATFORM_UNSUPPORTED' });
    assert.throws(() => adapter.monitorList({ environment }), { code: 'DESKTOP_PLATFORM_UNSUPPORTED' });
  }
  for (const DISPLAY of ['', 'localhost:10.0', 'other-host:0', ':1;injected']) {
    assert.throws(() => adapter.windowList({ environment: { DISPLAY } }), { code: 'DESKTOP_SESSION_UNAVAILABLE' });
    assert.throws(() => adapter.monitorList({ environment: { DISPLAY } }), { code: 'DESKTOP_SESSION_UNAVAILABLE' });
  }
});

test('fixed native helper gets only desktop plumbing and exposes no raw failure diagnostics', () => {
  let observed;
  assert.throws(() => adapter.windowList({ environment: { DISPLAY: ':1', LD_PRELOAD: 'fixture-loader',
    PYTHONPATH: 'fixture-hook', SECRET_SAMPLE: 'fixture-sensitive' }, spawnSyncImpl(command, args, options) {
    observed = { command, args, options };
    return { status: 1, stdout: '{"ok":false,"code":"UNTRUSTED_DIAGNOSTIC"}', stderr: 'fixture-sensitive' };
  } }), { code: 'DESKTOP_NATIVE_PROTOCOL_INVALID' });
  assert.equal(observed.command, '/usr/bin/python3');
  assert.deepEqual(observed.args.slice(0, 3), ['-I', '-S', '-B']);
  assert.equal(observed.options.env.DISPLAY, ':1');
  for (const key of ['LD_PRELOAD', 'PYTHONPATH', 'SECRET_SAMPLE']) assert.equal(observed.options.env[key], undefined);
  assert.throws(() => adapter.windowList({ spawnSyncImpl: () => ({ error: { code: 'ENOENT' } }) }), { code: 'DESKTOP_NATIVE_UNAVAILABLE' });
  assert.throws(() => adapter.windowList({ spawnSyncImpl: () => ({ signal: 'SIGTERM' }) }), { code: 'DESKTOP_SNAPSHOT_UNAVAILABLE' });
  assert.throws(() => adapter.windowList({ spawnSyncImpl() { throw new Error('fixture-sensitive'); } }),
    error => error.code === 'DESKTOP_SNAPSHOT_UNAVAILABLE' && !error.message.includes('fixture-sensitive'));
});

test('desktop worker never substitutes metadata-only success for a missing or misplaced image', async () => {
  const { EventEmitter } = require('node:events');
  for (const item of [
    { operation: 'readCapture', packet: { result: { width: 80, height: 60 } } },
    { operation: 'readCapture', packet: { result: {}, image: new Uint8Array() } },
    { operation: 'readCapture', packet: { result: {}, image: new Uint8Array(1024 * 1024 + 1) } },
    { operation: 'readCapture', packet: { result: { __mcpImage: 'untrusted' }, image: new Uint8Array([1]) } },
    { operation: 'windowList', packet: { result: { windows: [] }, image: new Uint8Array([1]) } },
  ]) {
    class Worker extends EventEmitter {
      ref() {} unref() {} async terminate() {}
      postMessage(message) { queueMicrotask(() => this.emit('message', { id: message.id, ...item.packet })); }
    }
    const worker = desktop.createDesktopWorkerClient({ WorkerImpl: Worker });
    try { await assert.rejects(worker.run(item.operation), { code: 'DESKTOP_WORKER_INVALID_REPLY' }); }
    finally { await worker.close(); }
  }
});

test('monitor native protocol rejects empty or wrong-operation envelopes', () => {
  for (const value of [{ ok: true, monitors: [] }, { ok: true, windows: [] },
    { ok: true, monitors: [{}], extra: true }]) {
    assert.throws(() => adapter.monitorList({ spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify(value) }) }),
      { code: 'DESKTOP_NATIVE_PROTOCOL_INVALID' });
  }
});
