'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ControllerFocusStore, FOCUS_PROJECTS, selectedFocus } = require('../../src/lib/controller-focus');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-focus-'));
const stateFile = path.join(root, 'controller-focus.json');
try {
  const store = new ControllerFocusStore({ stateFile });
  assert.equal(store.read().selected, 'all');
  const selected = store.set('toolsenabled');
  assert.equal(selected.selected, 'toolsenabled');
  assert.match(selected.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(new ControllerFocusStore({ stateFile }).read().selected, 'toolsenabled');
  assert.throws(() => store.set('C:\\private\\path'), error => error.code === 'INVALID_CONTROLLER_FOCUS');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, selected: 'toolsenabled', updatedAt: 'bad', path: 'C:\\private' }));
  assert.throws(() => store.read(), error => error.code === 'INVALID_CONTROLLER_FOCUS_STATE',
    'malformed or surplus state must be surfaced, not coerced to default focus');
  fs.writeFileSync(stateFile, '{not-json');
  assert.throws(() => store.read(), SyntaxError, 'corrupt JSON must be surfaced, not coerced to default focus');
  const originalReadFileSync = fs.readFileSync;
  const permissionError = Object.assign(new Error('denied'), { code: 'EACCES' });
  fs.readFileSync = () => { throw permissionError; };
  try {
    assert.throws(() => store.read(), error => error === permissionError,
      'permission failures must be surfaced, not coerced to default focus');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.deepEqual(FOCUS_PROJECTS.map(project => project.id), ['all', 'toolsenabled']);
  assert.equal(selectedFocus('unknown'), 'all');
  console.log('Controller focus tests passed (closed owner display preference and safe persistence).');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}
