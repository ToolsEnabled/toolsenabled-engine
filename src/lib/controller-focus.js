'use strict';

// Owner-selected dashboard focus is a local display preference, never task,
// filesystem, provider, or execution authority.  Browser consumers receive
// only these controlled labels and identifiers; paths are intentionally absent.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FOCUS_PROJECTS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All registered projects' }),
  Object.freeze({ id: 'toolsenabled', label: 'ToolsEnabled' })
]);
const FOCUS_IDS = new Set(FOCUS_PROJECTS.map(project => project.id));
const TRANSIENT_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WRITE_ATTEMPTS = 8;

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && value.endsWith('Z');
}

function selectedFocus(value) {
  return typeof value === 'string' && FOCUS_IDS.has(value) ? value : 'all';
}

function stateFor(selected, updatedAt = new Date().toISOString()) {
  return Object.freeze({ version: 1, selected: selectedFocus(selected), updatedAt });
}

function defaultState() {
  return stateFor('all', null);
}

function validateStoredState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'selected' || keys[1] !== 'updatedAt' || keys[2] !== 'version') return null;
  if (value.version !== 1 || !FOCUS_IDS.has(value.selected) || !isTimestamp(value.updatedAt)) return null;
  return stateFor(value.selected, value.updatedAt);
}

function invalidStoredState() {
  const error = new Error('The stored controller focus state is invalid.');
  error.code = 'INVALID_CONTROLLER_FOCUS_STATE';
  return error;
}

function renameWithRetry(temporary, target) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      if (!TRANSIENT_WRITE_CODES.has(error?.code) || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      waitSync(25 * (attempt + 1));
    }
  }
}

class ControllerFocusStore {
  constructor({ stateFile } = {}) {
    if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)) {
      throw new Error('A fixed absolute controller focus state path is required.');
    }
    this.stateFile = path.resolve(stateFile);
  }

  read() {
    try {
      const entry = fs.lstatSync(this.stateFile);
      if (!entry.isFile() || entry.isSymbolicLink()) throw invalidStoredState();
      const state = validateStoredState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')));
      if (!state) throw invalidStoredState();
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultState();
      throw error;
    }
  }

  set(selected) {
    if (typeof selected !== 'string' || !FOCUS_IDS.has(selected)) {
      const error = new Error('The controller focus is unsupported.');
      error.code = 'INVALID_CONTROLLER_FOCUS';
      throw error;
    }
    const current = this.read();
    if (current.selected === selected && current.updatedAt !== null) return current;
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const next = stateFor(selected);
    const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(next)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      renameWithRetry(temporary, this.stateFile);
    } finally {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
    return next;
  }
}

module.exports = Object.freeze({ ControllerFocusStore, FOCUS_PROJECTS, selectedFocus });
