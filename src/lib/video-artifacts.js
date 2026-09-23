'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { rootPath } = require('./runtime');
const { resolveTarget, requestPinned } = require('./ssrf-guard');

function error(code, message) { return Object.assign(new Error(message), { code }); }

function directoryForArtifacts(directory) {
  const resolved = path.resolve(directory);
  const volume = path.parse(resolved).root;
  let current = volume;
  for (const component of resolved.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw error('VIDEO_ARTIFACT_PATH_UNSAFE', 'The video artifact directory must contain only real directories.');
  }
  return resolved;
}

async function withSignal(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function download(url, options = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 12 || maxBytes > 1024 * 1024 * 1024) throw new TypeError('maxBytes must be between 12 and 1073741824.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('timeoutMs must be between 1 and 120000.');
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(error('VIDEO_DOWNLOAD_TIMEOUT', 'The video download exceeded its deadline.')), timeoutMs);
  const assertCurrent = options.assertCurrent || (() => {});
  let stream;
  let partial;
  let descriptor;
  try {
    signal.throwIfAborted();
    assertCurrent();
    const target = await withSignal((options.resolveTarget || resolveTarget)(url), signal);
    signal.throwIfAborted();
    assertCurrent();
    // The media request carries no provider credential. The target is pinned
    // to public DNS and redirects are refused rather than followed blindly.
    const response = await withSignal((options.requestPinned || requestPinned)(target,
      { method: 'GET', headers: { accept: 'video/mp4,application/octet-stream' }, timeoutMs, signal }).then(result => {
      if (signal.aborted) result.stream?.destroy();
      return result;
    }), signal);
    stream = response.stream;
    if (response.status !== 200 || !stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw error('VIDEO_DOWNLOAD_FAILED', 'The video host did not return a downloadable file. Refresh video.status if its URL has expired.');
    }
    const length = response.headers?.['content-length'];
    if (length !== undefined && /^\d+$/.test(String(length)) && Number(length) > maxBytes) {
      throw error('VIDEO_DOWNLOAD_TOO_LARGE', 'The video exceeds the requested download size limit.');
    }
    const directory = directoryForArtifacts(options.directory || rootPath('state', 'artifacts', 'video'));
    const name = `video-${randomUUID()}`;
    partial = path.join(directory, `${name}.part`);
    const destination = path.join(directory, `${name}.mp4`);
    descriptor = fs.openSync(partial, 'wx', 0o600);
    const output = fs.createWriteStream(partial, { fd: descriptor, autoClose: true });
    descriptor = undefined;
    const digest = createHash('sha256');
    let bytes = 0;
    let header = Buffer.alloc(0);
    await pipeline(stream, async function* (source) {
      for await (const chunk of source) {
        signal.throwIfAborted();
        assertCurrent();
        if (!(chunk instanceof Uint8Array)) throw error('VIDEO_DOWNLOAD_INVALID', 'The video host returned an invalid byte stream.');
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw error('VIDEO_DOWNLOAD_TOO_LARGE', 'The video exceeds the requested download size limit.');
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 12 - header.length)]);
        digest.update(chunk);
        yield chunk;
      }
    }, output, { signal });
    signal.throwIfAborted();
    assertCurrent();
    if (bytes < 12 || header.subarray(4, 8).toString('ascii') !== 'ftyp') {
      throw error('VIDEO_DOWNLOAD_INVALID', 'The downloaded data is not an MP4 file.');
    }
    // A hard link publishes only a new name; it cannot overwrite an existing
    // artifact. The unfinished file is removed on success and on every error.
    fs.linkSync(partial, destination);
    return { path: destination, bytes, sha256: digest.digest('hex'), contentType: 'video/mp4' };
  } catch (failure) {
    if (signal.aborted) throw signal.reason;
    if (typeof failure.code === 'string' && failure.code.startsWith('VIDEO_')) throw failure;
    throw error('VIDEO_DOWNLOAD_FAILED', 'The video could not be saved. Check network access and the artifact directory, then retry the download.');
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (partial) fs.rmSync(partial, { force: true });
  }
}

module.exports = { download };
