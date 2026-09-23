'use strict';

// The durable half of Q39's elevated collector.  Collection/elevation lives
// outside this module; this file accepts only the minimized producer input,
// re-validates it through the closed contract, and atomically replaces the
// one fixed state file.  A partial or malformed elevated result must never be
// observable as fresh health data.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const producer = require('./process-visibility-producer.js');
const targets = require('./process-visibility-targets.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SNAPSHOT_FILE = path.join(ROOT, 'state', 'process-visibility.json');
const MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

class ProcessVisibilityWriterError extends Error {
  constructor(code, message) {
    super(`process-visibility-writer: ${message}`);
    this.name = 'ProcessVisibilityWriterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProcessVisibilityWriterError(code, message);
}

function boundedSnapshotJson(input, { expectedTaskNames = targets.TASK_NAMES } = {}) {
  const serialized = producer.serializeProcessVisibilitySnapshot(input, { expectedTaskNames });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    fail('PROCESS_VISIBILITY_WRITER_OVERSIZE', `serialized snapshot exceeds ${MAX_SERIALIZED_BYTES} bytes`);
  }
  return serialized;
}

function writeFileAtomically(serialized, { file = SNAPSHOT_FILE } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    fail('PROCESS_VISIBILITY_WRITER_FILE_INVALID', 'snapshot file must be a non-empty string');
  }
  const directory = path.dirname(file);
  let temporary;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(handle, `${serialized}\n`, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    if (temporary !== undefined) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Preserve the original write failure, which is the actionable error.
      }
    }
    if (error instanceof ProcessVisibilityWriterError) throw error;
    fail('PROCESS_VISIBILITY_WRITER_WRITE_FAILED', `could not atomically write snapshot: ${error && error.message}`);
  }
  return file;
}

function writeProcessVisibilitySnapshot(input, options = {}) {
  const serialized = boundedSnapshotJson(input, options);
  const snapshot = producer.normalizeProcessVisibilityObservation(input, {
    expectedTaskNames: options.expectedTaskNames || targets.TASK_NAMES
  });
  const file = writeFileAtomically(serialized, options);
  return Object.freeze({
    file,
    capturedAtMs: snapshot.capturedAtMs,
    taskCount: snapshot.tasks.length,
    processCount: snapshot.processes.length,
    bytes: Buffer.byteLength(serialized, 'utf8')
  });
}

module.exports = Object.freeze({
  MAX_SERIALIZED_BYTES,
  ProcessVisibilityWriterError,
  ROOT,
  SNAPSHOT_FILE,
  boundedSnapshotJson,
  writeFileAtomically,
  writeProcessVisibilitySnapshot
});
