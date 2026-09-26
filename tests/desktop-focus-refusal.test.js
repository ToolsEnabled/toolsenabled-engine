'use strict';

require('./lib/isolated-environment').activate('desktop-focus-refusal');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Supply the OS helper's result at the existing process boundary. The complete
// public focus function and its JSON/argument validation run unchanged.
function desktopWithResponse(output) {
  const file = path.resolve(__dirname, '../src/lib/desktop.js');
  const runtime = require('../src/lib/runtime');
  const fakeRuntime = { ...runtime, run: () => ({ status: 0, stdout: JSON.stringify(output) }) };
  const module = { exports: {} };
  const localRequire = require('node:module').createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
    require: name => name === './runtime' ? fakeRuntime : localRequire(name),
    process: { platform: 'win32', env: process.env }, Buffer, console,
  }, { filename: file });
  return module.exports;
}

test('window.focus returns an actionable OS foreground refusal, not an internal error', () => {
  const result = desktopWithResponse({ focused: false, windowId: '101' }).windowFocus({ windowId: '101' });
  assert.equal(result.focused, false);
  assert.equal(result.windowId, '101');
  assert.equal(result.code, 'WINDOW_FOREGROUND_REFUSED');
  assert.match(result.reason, /Windows.*foreground/);
  assert.match(result.reason, /taskbar/);
});

test('window.focus only confirms the matching target and preserves invalid-output failures', () => {
  const result = desktopWithResponse({ focused: true, windowId: '101' }).windowFocus({ windowId: '101' });
  assert.equal(result.focused, true);
  assert.equal(result.windowId, '101');
  assert.throws(() => desktopWithResponse({ focused: true, windowId: '202' }).windowFocus({ windowId: '101' }));
  assert.throws(() => desktopWithResponse({ windowId: '101' }).windowFocus({ windowId: '101' }));
});

test('focus does not attach to another input queue or claim success from only the request', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../tools/desktop.ps1'), 'utf8');
  const focus = script.slice(script.indexOf('function Focus-WindowHandle('), script.indexOf('function Await-WinRt('));
  assert.doesNotMatch(focus, /::(?:AttachThreadInput|BringWindowToTop|SetFocus)\(/);
  assert.doesNotMatch(focus, /\$requested\s+-or/);
  assert.match(focus, /GetForegroundWindow\(\) -eq \$Handle/);
});
