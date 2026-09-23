'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { accountFencedStateRoot, statePath } = require('../runtime-state-root');
const { explicitModel } = require('../local-model-options');

const MAX_THREAD_BYTES = 2 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_THREADS = 256;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createLocalThreadStore({ directory = statePath('state', 'local-model-threads') } = {}) {
  const root = accountFencedStateRoot(directory);
  function filename(id) {
    if (!ID.test(id)) throw failure('LOCAL_NODE_THREAD_UNKNOWN', 'That local conversation identifier cannot be recovered.');
    return accountFencedStateRoot(path.join(root, `${id}.json`));
  }
  function load(id) {
    const file = filename(id);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_THREAD_BYTES) throw new Error('invalid conversation file');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const record = saved?.record;
      if (saved.version !== 1 || saved.threadId !== id || !record || !explicitModel(record.model) ||
          !Array.isArray(record.messages) || record.messages.length > 400 ||
          record.messages.some(message => !message || !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
            typeof message.content !== 'string' || (message.turnId !== null && !ID.test(message.turnId)))) {
        throw new Error('invalid conversation record');
      }
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('LOCAL_NODE_THREAD_UNREADABLE', 'The saved local conversation could not be read. It was preserved; a new conversation was not substituted.', error);
    }
  }

  function prune(current) {
    const entries = [];
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      // The directory was fenced before this scan. lstat refuses links below
      // it without traversing them; do not repeat ancestor checks for every
      // retained snapshot on every coordinator turn.
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, size: stat.size, at: stat.mtimeMs });
    }
    entries.sort((left, right) => left.at - right.at);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (count <= MAX_THREADS && total <= MAX_STORE_BYTES) break;
      if (entry.file === current) continue;
      fs.unlinkSync(entry.file);
      total -= entry.size;
      count -= 1;
    }
  }

  function save(id, record) {
    if (record.ephemeral) return;
    const file = filename(id);
    const text = `${JSON.stringify({ version: 1, threadId: id, savedAtMs: Date.now(), record })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_THREAD_BYTES) {
      throw failure('LOCAL_NODE_THREAD_TOO_LARGE', 'This local conversation is too large to save. Start a new conversation to continue with restart recovery.');
    }
    const temporary = accountFencedStateRoot(path.join(root, `${randomUUID()}.tmp`));
    let descriptor;
    try {
      fs.mkdirSync(root, { recursive: true });
      // The root and destination are rechecked after mkdir, including reparse
      // boundaries, before any transcript is written.
      accountFencedStateRoot(root);
      filename(id);
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      prune(file);
    } catch (error) {
      throw failure('LOCAL_NODE_THREAD_SAVE_FAILED', 'The local conversation could not be saved for restart recovery.', error);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') process.emitWarning('A local conversation temporary file could not be removed.'); }
    }
  }

  return { directory: root, load, save };
}

module.exports = { MAX_STORE_BYTES, MAX_THREAD_BYTES, MAX_THREADS, createLocalThreadStore };
