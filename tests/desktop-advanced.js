// EXECUTABLE CHANGE
// testcanfail-tests-desktop-advanced-js
//
// Discriminating mutation: src/lib/desktop.js windowList() was temporarily
// changed to return an empty, otherwise valid window list. Before this change,
// the test stayed green and printed "Advanced desktop capability tests passed."
// With the assertion below, the same mutation was rejected with:
//   AssertionError [ERR_ASSERTION]: window.list must expose an eligible visible window for capture assertions
// The source file was then restored byte-for-byte (matching SHA-256), and the
// restored-source run reached the named non-Windows precondition below.
//
// Shape census:
// (1) FOUND: the candidate guard allowed all capture/image/OCR assertions to be
//     skipped for an empty or ineligible window list; the new assertion closes it.
// (2) NOT-FOUND: no exit-status or truthy-return assertion is used as evidence.
// (3) NOT-FOUND: catches only verify the OCR unavailable contract or clean up files;
//     optional property checks do not swallow the failure under test.
// (4) NOT-FOUND: injected helpers exercise desktop argument/result normalization,
//     not a mock of that normalization.
// (5) NOT-FOUND: there is no platform skip for the whole file. PRECONDITION:
//     live capture requires Windows with powershell.exe, an interactive eligible
//     window, and the audit signing key available to the current Windows identity.
// (6) NOT-FOUND: expected values are literals or independently derived inputs,
//     not computed by the implementation being checked.

'use strict';

require('./lib/isolated-environment').activate('desktop-advanced');
// The captures directory THE PRODUCT resolves, not a pinned precedence.
// desktop.js:100 computes rootPath('captures'); before fe452d3 the isolated
// environment left TOOLSENABLED_STATE_ROOT unset, so that fell back to
// process.cwd() and these tests pinned the fallback -- green only in a world
// the shipped shell never produces. Deriving the expectation through the same
// resolver keeps the confinement assertion while following the environment.
const CAPTURES_DIR = require('../src/lib/runtime').rootPath('captures');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const desktop = require('../src/lib/desktop');
const { getTool, executeTool } = require('./helpers/dispatch');
const { dispatch: unboundDispatch } = require('../src/mcp-server');
// See tests/helpers/owner-dispatch.js: executeTool() refuses a dispatch with no
// stated ceiling, and production never reaches dispatch() unbound.
const { OWNER_SESSION } = require('./helpers/dispatch');
const dispatch = (message, options = {}) =>
  unboundDispatch(message, { permissionSession: OWNER_SESSION, ...options });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(file) {
  const header = Buffer.alloc(8);
  const descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, header, 0, 8, 0); } finally { fs.closeSync(descriptor); }
  assert.ok(header.equals(PNG_SIGNATURE), 'capture must begin with the PNG signature');
}

(async () => {
  const desktopHelper = fs.readFileSync(path.join(__dirname, '..', 'tools', 'desktop.ps1'), 'utf8');
  assert.match(desktopHelper, /function Focus-WindowHandle/);
  assert.match(desktopHelper, /AttachThreadInput/);
  assert.match(desktopHelper, /GetForegroundWindow/);
  for (const [name, effect] of [
    ['system.ask', 'local-write'], ['screen.capture_region', 'local-write'], ['screen.capture_window', 'local-write'], ['screen.capture_monitor', 'local-write'],
    ['screen.list_monitors', 'local-read'], ['screen.read_capture', 'local-read'],
    ['window.list', 'local-read'], ['window.focus', 'local-write'], ['window.close', 'local-write'], ['ocr.read', 'local-read'],
    ['tts.speak', 'local-write'], ['sound.play', 'local-write']
  ]) {
    const tool = getTool(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.effect, effect);
    assert.equal(tool.annotations.openWorldHint, false);
  }

  const answer = desktop.ask({ message: 'Unit-test confirmation', timeoutSeconds: 5 }, {
    withTempFile: (_prefix, _content, callback) => callback('ignored.json'),
    invoke: () => ({ stdout: 'yes' })
  });
  assert.deepEqual(answer, { answer: 'yes', approved: true, timedOut: false, timeoutSeconds: 5 });
  const timeout = desktop.ask({ message: 'Unit-test timeout' }, {
    withTempFile: (_prefix, _content, callback) => callback('ignored.json'),
    invoke: () => ({ stdout: 'timeout' })
  });
  assert.equal(timeout.approved, false);
  assert.equal(timeout.timedOut, true);
  assert.throws(() => desktop.ask({ message: 'x' }, {
    withTempFile: (_prefix, _content, callback) => callback('ignored.json'),
    invoke: () => ({ stdout: 'unexpected' })
  }), /invalid answer/);
  let soundPayload;
  const sound = desktop.soundPlay({ sound: 'generic-ramp' }, {
    withTempFile: (_prefix, content, callback) => {
      soundPayload = JSON.parse(content);
      return callback('ignored.json');
    },
    invoke: (verb, file, options) => {
      assert.equal(verb, 'sound');
      assert.equal(file, 'ignored.json');
      assert.deepEqual(options, { timeoutMs: 15000 });
      return { stdout: 'OK' };
    }
  });
  assert.deepEqual(soundPayload, { sound: 'generic-ramp' });
  assert.deepEqual(sound, { played: true, sound: 'generic-ramp', progressivelyLouder: true });

  const closeArgs = {
    windowId: '12345',
    expectedProcessId: 23456,
    expectedProcessStartKey: '133700000000000000',
    expectedProcessName: 'chrome',
    expectedTitle: 'Sample Calendar - Firebase console',
    timeoutSeconds: 300
  };
  let closePayload;
  const closed = desktop.windowClose(closeArgs, {
    withTempFile: (_prefix, content, callback) => {
      closePayload = JSON.parse(content);
      return callback('ignored.json');
    },
    invoke: () => ({ stdout: JSON.stringify({
      status: 'closed', requested: false, ownerPerformed: true, windowId: '12345'
    }) })
  });
  assert.deepEqual(closePayload, closeArgs);
  assert.deepEqual(closed, {
    status: 'closed', requested: false, closed: true, ownerPerformed: true, windowId: '12345',
    processId: 23456, processStartKey: '133700000000000000',
    processName: 'chrome', title: 'Sample Calendar - Firebase console', forced: false
  });
  const staleClose = desktop.windowClose(closeArgs, {
    withTempFile: (_prefix, _content, callback) => callback('ignored.json'),
    invoke: () => ({ stdout: JSON.stringify({
      status: 'target_changed', requested: false, ownerPerformed: false, windowId: '12345'
    }) })
  });
  assert.equal(staleClose.closed, false);
  assert.equal(staleClose.requested, false);
  assert.equal(staleClose.forced, false);
  assert.throws(() => desktop.windowClose({ ...closeArgs, expectedProcessStartKey: 'not-a-key' }), /expectedProcessStartKey/);
  assert.throws(() => desktop.windowClose({ ...closeArgs, expectedProcessName: 'chrome;bad' }), /expectedProcessName/);
  assert.throws(() => desktop.windowClose({ ...closeArgs, expectedTitle: '' }), /expectedTitle/);

  let focusPayload;
  const focused = desktop.windowFocusFenced(closeArgs, {
    withTempFile: (_prefix, content, callback) => {
      focusPayload = JSON.parse(content);
      return callback('ignored.json');
    },
    invoke: (verb, file) => {
      assert.equal(verb, 'window-focus-fenced');
      assert.equal(file, 'ignored.json');
      return { stdout: JSON.stringify({ status: 'focused', focused: true, windowId: '12345' }) };
    }
  });
  assert.deepEqual(focusPayload, {
    windowId: '12345', expectedProcessId: 23456, expectedProcessStartKey: '133700000000000000',
    expectedProcessName: 'chrome', expectedTitle: 'Sample Calendar - Firebase console'
  });
  assert.deepEqual(focused, { focused: true, targetChanged: false, windowId: '12345' });
  const staleFocus = desktop.windowFocusFenced(closeArgs, {
    withTempFile: (_prefix, _content, callback) => callback('ignored.json'),
    invoke: () => ({ stdout: JSON.stringify({ status: 'target_changed', focused: false, windowId: '12345' }) })
  });
  assert.deepEqual(staleFocus, { focused: false, targetChanged: true, windowId: '12345' });
  assert.throws(() => desktop.windowFocusFenced({ ...closeArgs, expectedTitle: '' }), /expectedTitle/);

  await assert.rejects(executeTool('screen.capture_region', { x: 0, y: 0, width: 0, height: 1 }), /at least 1/);
  await assert.rejects(executeTool('window.focus', { windowId: 'not-a-window' }), /must match/);
  await assert.rejects(executeTool('window.close', {
    windowId: '12345', expectedProcessId: 23456, expectedProcessStartKey: 'not-a-key',
    expectedProcessName: 'chrome', expectedTitle: 'Sample Calendar - Firebase console'
  }), /must match/);
  await assert.rejects(executeTool('tts.speak', { text: '', rate: 0 }), /at least 1/);
  await assert.rejects(executeTool('sound.play', { sound: 'arbitrary-file' }), /must be one of/);

  const listed = await executeTool('window.list', {});
  assert.equal(listed.contentTrust, 'untrusted');
  assert.equal(listed.grantsAuthority, false);
  assert.equal(listed.count, listed.windows.length);

  // Prefer our terminal/IDE over a browser: the test must not inspect an active
  // OAuth page just because it happens to be the first top-level window.
  const candidate = listed.windows.find(window => /^(WindowsTerminal|Code)$/i.test(window.processName)
    && !window.isMinimized && window.x >= 0 && window.y >= 0 && window.width >= 8 && window.height >= 8)
    || listed.windows.find(window => !/chrome|msedge|firefox/i.test(window.processName)
      && !window.isMinimized && window.x >= 0 && window.y >= 0 && window.width >= 8 && window.height >= 8);
  assert.ok(candidate, 'window.list must expose an eligible visible window for capture assertions');
  if (candidate) {
    const region = await executeTool('screen.capture_region', {
      x: candidate.x, y: candidate.y, width: Math.min(8, candidate.width), height: Math.min(8, candidate.height),
      filename: 'advanced-region-selftest.png'
    });
    if (region.status === 'unavailable') {
      assert.equal(region.captured, false);
      assert.equal(region.usable, false);
      assert.equal(region.method, 'copy_from_screen');
      console.log('Interactive screen surface unavailable; skipped region/image/OCR assertions.');
    } else {
      try {
        assert.equal(region.width, Math.min(8, candidate.width));
        assert.equal(region.height, Math.min(8, candidate.height));
        assertPng(region.path);
        const imageResult = await dispatch({ jsonrpc: '2.0', id: 901, method: 'tools/call', params: {
          name: 'screen.read_capture', arguments: { path: region.path, maxWidth: 64, maxHeight: 64, maxBytes: 1048576 }
        } });
        assert.equal(imageResult.content.length, 2, 'only explicit screen.read_capture returns an MCP image block');
        assert.equal(imageResult.content[1].type, 'image');
        assert.equal(imageResult.content[1].mimeType, 'image/png');
        assert.ok(Buffer.from(imageResult.content[1].data, 'base64').subarray(0, 8).equals(PNG_SIGNATURE));
        assert.equal(Object.prototype.hasOwnProperty.call(imageResult.structuredContent, '__mcpImage'), false);
        const thumbnailPath = imageResult.structuredContent.path;
        assert.equal(path.dirname(thumbnailPath), CAPTURES_DIR);
        try { fs.unlinkSync(thumbnailPath); } catch { /* test cleanup */ }
        try {
          const ocr = await executeTool('ocr.read', { path: region.path });
          assert.equal(ocr.contentTrust, 'untrusted');
          assert.equal(ocr.grantsAuthority, false);
          assert.equal(typeof ocr.text, 'string');
        } catch (error) {
          assert.match(String(error.message || error), /Windows OCR is unavailable|Windows OCR recognition is unavailable/);
        }
      } finally { try { fs.unlinkSync(region.path); } catch { /* test cleanup */ } }
    }

    const capturedWindow = await executeTool('screen.capture_window', {
      windowId: candidate.windowId,
      expectedProcessId: candidate.processId,
      expectedProcessStartKey: candidate.processStartKey,
      filename: 'advanced-window-selftest.png'
    });
    try {
      assert.match(capturedWindow.status, /^(captured|blank_or_uniform|unavailable|target_changed)$/);
      if (capturedWindow.path) {
        assert.ok(capturedWindow.width >= 1 && capturedWindow.height >= 1);
        assertPng(capturedWindow.path);
      }
    } finally { if (capturedWindow.path) try { fs.unlinkSync(capturedWindow.path); } catch { /* test cleanup */ } }
  }

  const missing = path.join(CAPTURES_DIR, 'not-an-image.txt');
  assert.throws(() => desktop.ocrRead({ path: missing }), /inside the ToolsEnabled captures directory|image file|ENOENT/);
  assert.throws(() => desktop.readCapture({ path: path.resolve(__dirname, '..', 'README.md') }), /inside the ToolsEnabled captures directory|image file/);

  console.log('Advanced desktop capability tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
