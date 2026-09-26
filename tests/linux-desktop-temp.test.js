'use strict';
require('./lib/isolated-environment').activate('linux-desktop-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktop = require('../src/lib/desktop');

test('desktop helper text stays private under permissive umask and is removed after success', () => {
  const previous = process.umask(0);
  let payload, directory;
  try {
    const result = desktop.ask({ message: 'fixture-private-dialog' }, { invoke(verb, file) {
      assert.equal(verb, 'ask');
      payload = file; directory = path.dirname(file);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(file).nlink, 1);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, 'fixture-private-dialog');
      return { stdout: 'no' };
    } });
    assert.equal(result.approved, false);
    assert.equal(fs.existsSync(payload), false);
    assert.equal(fs.existsSync(directory), false);
  } finally { process.umask(previous); }
});

test('helper failure preserves its refusal and removes its private payload', () => {
  let directory;
  const refusal = Object.assign(new Error('fixture refusal'), { code: 'FIXTURE_REFUSAL' });
  assert.throws(() => desktop.soundPlay({}, { invoke(_verb, file) {
    directory = path.dirname(file);
    throw refusal;
  } }), error => error === refusal);
  assert.equal(fs.existsSync(directory), false);
});

test('exclusive payload creation refuses a pre-created alias without modifying its target', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-temp-alias-test-'));
  const target = path.join(parent, 'target');
  fs.writeFileSync(target, 'untouched', { mode: 0o600 });
  const original = fs.mkdtempSync;
  let child, invoked = false;
  try {
    fs.mkdtempSync = prefix => {
      child = original(prefix);
      fs.symlinkSync(target, path.join(child, 'payload.tmp'));
      return child;
    };
    assert.throws(() => desktop.soundPlay({}, { invoke() { invoked = true; } }), { code: 'EEXIST' });
    assert.equal(invoked, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    assert.ok(fs.lstatSync(path.join(child, 'payload.tmp')).isSymbolicLink());
  } finally {
    fs.mkdtempSync = original;
    if (child) { fs.unlinkSync(path.join(child, 'payload.tmp')); fs.rmdirSync(child); }
    fs.unlinkSync(target); fs.rmdirSync(parent);
  }
});

test('unsupported Linux operations return a typed refusal, not a PowerShell launch error', () => {
  assert.equal(process.platform, 'linux');
  for (const call of [() => desktop.clipboardRead(), () => desktop.clipboardWrite({ text: 'fixture' }),
    () => desktop.notify({ message: 'fixture' }), () => desktop.windowFocus({ windowId: '1' }),
    () => desktop.ttsSpeak({ text: 'fixture' }), () => desktop.soundPlay()]) {
    assert.throws(call, { code: 'DESKTOP_PLATFORM_UNSUPPORTED' });
  }
});

test('confirmation retains a complete bounded preview and rejects embedded NUL before invoking a helper', () => {
  const message = 'Review the complete action: ' + 'long action detail '.repeat(250) + 'END OF ACTION';
  let invoked = 0;
  const dependencies = { invoke(_verb, file) {
    invoked++;
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, message);
    return { stdout: 'no' };
  } };
  assert.equal(desktop.ask({ message }, dependencies).approved, false);
  for (const args of [{ message: 'before\0after' }, { title: 'bad\0title', message: 'fixture' },
    { message: 'x'.repeat(desktop.MAX_ASK_MESSAGE + 1) }]) assert.throws(() => desktop.ask(args, dependencies));
  assert.equal(invoked, 1);
});
