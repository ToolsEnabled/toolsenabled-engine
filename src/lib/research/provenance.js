'use strict';

// Optional byte pins for declared process inputs. These are observations at
// execution boundaries, not a sandbox, a signature, or a scientific checker.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const accountBoundary = require('../account-profile-boundary');

const MAX_PINNED_FILES = 64;
const MAX_PINNED_BYTES = 256 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// Durable task JSON sorts object keys. Receipt digests must survive that
// serialization and an export/import, while preserving array order.
const hashJson = value => sha256(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item));

class ProvenanceError extends Error {
  constructor(code, message) { super(message); this.name = 'ProvenanceError'; this.code = code; }
}

function literalFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new ProvenanceError('RESEARCH_PIN_CONFIG_INVALID', 'Each pinned file needs an absolute literal path of at most 1024 characters.');
  }
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value)
      || /[<>:"|?*]/.test(value.slice(2)) || value.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part)))) {
    throw new ProvenanceError('RESEARCH_PIN_PATH_REFUSED', 'Pinned files require ordinary drive paths without device, stream, or ambiguous Windows aliases.');
  }
  if (value.split(process.platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')) {
    throw new ProvenanceError('RESEARCH_PIN_PATH_REFUSED', 'Pinned file paths cannot contain dot or parent traversal segments.');
  }
  return path.normalize(value);
}

function validatePinnedFiles(runnerKind, config = {}) {
  if (!Object.hasOwn(config, 'pinnedFiles')) return null;
  if (runnerKind !== 'process') {
    throw new ProvenanceError('RESEARCH_PIN_RUNNER_UNSUPPORTED', 'pinnedFiles is supported only by the process runner; dispatch or HTTP receipts cannot establish local input checks.');
  }
  const pins = config.pinnedFiles;
  if (!Array.isArray(pins) || pins.length < 1 || pins.length > MAX_PINNED_FILES) {
    throw new ProvenanceError('RESEARCH_PIN_CONFIG_INVALID', `pinnedFiles must contain 1 through ${MAX_PINNED_FILES} path and SHA-256 pairs, or be omitted.`);
  }
  const seen = new Set();
  return pins.map(pin => {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)
        || Object.keys(pin).some(key => !['path', 'sha256'].includes(key))
        || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(pin.sha256)) {
      throw new ProvenanceError('RESEARCH_PIN_CONFIG_INVALID', 'Each pinned file must contain only path and a full SHA-256 digest.');
    }
    const file = literalFilePath(pin.path);
    const identity = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(identity)) throw new ProvenanceError('RESEARCH_PIN_CONFIG_INVALID', 'pinnedFiles contains the same path more than once.');
    seen.add(identity);
    return Object.freeze({ path: file, sha256: pin.sha256.toLowerCase() });
  });
}

async function regularFile(file) {
  file = literalFilePath(file);
  // Decide the profile lexically before any filesystem call. In particular,
  // never resolve an unknown short-name alias to find out whose profile it is.
  if (process.platform === 'win32' && accountBoundary.pathReferencesForeignProfile(file, accountBoundary.installationProfileRoot())) {
    throw new ProvenanceError('RESEARCH_PIN_PATH_REFUSED', 'The pinned file is outside the Windows account that owns this installation.');
  }
  const root = path.parse(file).root;
  let cursor = root;
  let stat;
  for (const segment of ['', ...file.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    stat = await fs.promises.lstat(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (cursor !== file && !stat.isDirectory())) {
      throw new ProvenanceError('RESEARCH_PIN_PATH_REFUSED', 'A pinned file path crosses a linked or non-directory parent; it was not followed.');
    }
  }
  if (!stat.isFile()) throw new ProvenanceError('RESEARCH_PIN_PATH_REFUSED', 'A pinned input must be a regular file.');
  return stat;
}

function sameObservation(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

async function verifyPinnedFiles(pins, phase) {
  const startedAtMs = Date.now();
  const files = [];
  let totalBytes = 0;
  for (const pin of pins) {
    let handle;
    try {
      const before = await regularFile(pin.path);
      if (before.size > BigInt(MAX_PINNED_BYTES - totalBytes)) {
        throw new ProvenanceError('RESEARCH_PIN_LIMIT_EXCEEDED', `Pinned inputs exceed the ${MAX_PINNED_BYTES}-byte total verification limit.`);
      }
      handle = await fs.promises.open(pin.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!sameObservation(before, await handle.stat({ bigint: true }))) {
        throw new ProvenanceError('RESEARCH_PIN_CHANGED_DURING_READ', 'A pinned input changed while it was being opened.');
      }
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > MAX_PINNED_BYTES - totalBytes) {
          throw new ProvenanceError('RESEARCH_PIN_LIMIT_EXCEEDED', 'Pinned inputs grew beyond the total verification limit.');
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      if (!sameObservation(before, after) || !sameObservation(after, await regularFile(pin.path)) || BigInt(bytes) !== before.size) {
        throw new ProvenanceError('RESEARCH_PIN_CHANGED_DURING_READ', 'A pinned input changed while its bytes were being measured.');
      }
      const actual = hash.digest('hex');
      if (actual !== pin.sha256) {
        throw new ProvenanceError('RESEARCH_PIN_HASH_MISMATCH', `A pinned input did not match its declared SHA-256 during ${phase} verification. No result was accepted.`);
      }
      totalBytes += bytes;
      files.push({ path: pin.path, sha256: actual, bytes });
    } catch (error) {
      if (error instanceof ProvenanceError || ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT'].includes(error.code)) throw error;
      throw new ProvenanceError('RESEARCH_PIN_READ_FAILED', `A pinned input could not be measured during ${phase} verification (${String(error.code || 'unknown')}).`);
    } finally {
      if (handle) await handle.close();
    }
  }
  return { startedAtMs, checkedAtMs: Date.now(), files };
}

function invocationReceipt({ command, args, artifactDir, stdinMode, stdinPayload, environment }) {
  const environmentEntries = Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return {
    command, args: [...args], cwd: artifactDir,
    stdin: { mode: stdinMode, bytes: Buffer.byteLength(stdinPayload || '', 'utf8'), sha256: sha256(stdinPayload || '') },
    environmentKeys: environmentEntries.map(([key]) => key),
    environmentSha256: sha256(JSON.stringify(environmentEntries))
  };
}

function processReceipt({ invocation, before, after, runId }) {
  const receipt = {
    version: 1, scope: 'declared-file-checks-at-process-boundaries', runId,
    invocation, invocationSha256: hashJson(invocation), before, after
  };
  return { ...receipt, receiptSha256: hashJson(receipt) };
}

function assertProcessReceipt(receipt, { pins, runId, artifactDir }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ProvenanceError('RESEARCH_PIN_RECEIPT_MISSING', 'The process returned no receipt for its declared input checks. No result was accepted.');
  }
  const { receiptSha256, ...unsigned } = receipt;
  const invocation = receipt.invocation;
  const phaseValid = phase => phase && Number.isSafeInteger(phase.startedAtMs) && Number.isSafeInteger(phase.checkedAtMs)
    && phase.startedAtMs > 0 && phase.checkedAtMs >= phase.startedAtMs
    && Array.isArray(phase.files) && phase.files.length === pins.length
    && phase.files.every((file, index) => file && file.path === pins[index].path && file.sha256 === pins[index].sha256
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
    && phase.files.reduce((bytes, file) => bytes + file.bytes, 0) <= MAX_PINNED_BYTES;
  if (receipt.version !== 1 || receipt.scope !== 'declared-file-checks-at-process-boundaries' || receipt.runId !== runId
      || !invocation || invocation.cwd !== artifactDir || typeof invocation.command !== 'string'
      || !Array.isArray(invocation.args) || invocation.args.some(arg => typeof arg !== 'string')
      || !invocation.stdin || !['none', 'params-json'].includes(invocation.stdin.mode)
      || !Number.isSafeInteger(invocation.stdin.bytes) || invocation.stdin.bytes < 0 || !/^[a-f0-9]{64}$/.test(invocation.stdin.sha256)
      || !Array.isArray(invocation.environmentKeys) || invocation.environmentKeys.some(key => typeof key !== 'string')
      || !/^[a-f0-9]{64}$/.test(invocation.environmentSha256)
      || !phaseValid(receipt.before) || !phaseValid(receipt.after) || receipt.after.startedAtMs < receipt.before.checkedAtMs
      || receipt.after.files.some((file, index) => file.bytes !== receipt.before.files[index].bytes)
      || receipt.invocationSha256 !== hashJson(invocation) || receiptSha256 !== hashJson(unsigned)) {
    throw new ProvenanceError('RESEARCH_PIN_RECEIPT_INVALID', 'The input-check receipt is incomplete, changed, or belongs to a different run attempt. No result was accepted.');
  }
}

module.exports = { MAX_PINNED_FILES, MAX_PINNED_BYTES, ProvenanceError, validatePinnedFiles, verifyPinnedFiles, invocationReceipt, processReceipt, assertProcessReceipt };
