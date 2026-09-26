'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { plain } = require('./gemini-quota-protocol');
const MAX_AUTH_BYTES = 1048576;
const UNSUPPORTED_ENV = Object.freeze(['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA']);
function unsupportedEnvironment(environment) {
  return Object.entries(environment || {}).some(([key, value]) => typeof value === 'string' && value.length > 0
    && (UNSUPPORTED_ENV.includes(key.toUpperCase())
      || key.toUpperCase() === 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE' && value.toLowerCase() === 'true'));
}
function fault(code) { return Object.assign(new Error(code), { code }); }
function assertPlainPath(file, fsImpl = fs) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = fsImpl.lstatSync(current);
    if (info.isSymbolicLink() || current !== absolute && !info.isDirectory()) throw fault('GEMINI_AUTH_FILE_UNSUPPORTED');
  }
  return absolute;
}
function generation(info) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(info[key])).join(':');
}
function readBoundFile(file, { optional = false, fsImpl = fs } = {}) {
  let handle;
  try {
    assertPlainPath(file, fsImpl);
    const before = fsImpl.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_AUTH_BYTES)) throw fault('GEMINI_AUTH_FILE_UNSUPPORTED');
    handle = fsImpl.openSync(file, 'r');
    const opened = fsImpl.fstatSync(handle, { bigint: true });
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
    if (!same(before, opened)) throw fault('GEMINI_AUTH_FILE_CHANGED');
    // A writer can enlarge the file after lstat. Bound the actual read, not
    // merely the earlier size observation, and compare the opened handle too.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fsImpl.readSync(handle, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (BigInt(length) !== before.size || !same(before, fsImpl.fstatSync(handle, { bigint: true }))) throw fault('GEMINI_AUTH_FILE_CHANGED');
    const bytes = buffer.subarray(0, length).toString('utf8');
    const after = fsImpl.lstatSync(file, { bigint: true });
    if (!same(before, after) || after.isSymbolicLink()) throw fault('GEMINI_AUTH_FILE_CHANGED');
    return { bytes, generation: generation(after) };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (typeof error.code === 'string' && error.code.startsWith('GEMINI_')) throw error;
    throw fault('GEMINI_AUTH_FILE_UNAVAILABLE');
  } finally { if (handle !== undefined) fsImpl.closeSync(handle); }
}
function readBoundJson(file, options) {
  const read = readBoundFile(file, options);
  if (!read) return null;
  try {
    const value = JSON.parse(read.bytes);
    if (!plain(value)) throw new Error('not an object');
    return value;
  } catch { throw fault('GEMINI_AUTH_FILE_UNSUPPORTED'); }
}
function assertPersonalCredentials(auth) {
  if (!plain(auth)) throw fault('GEMINI_AUTH_FILE_UNSUPPORTED');
  if (Object.hasOwn(auth, 'type') || Object.hasOwn(auth, 'client_id') || Object.hasOwn(auth, 'client_secret')
    || Object.hasOwn(auth, 'credential_source') || Object.hasOwn(auth, 'private_key')) throw fault('GEMINI_AUTH_MODE_UNSUPPORTED');
  if (typeof auth.refresh_token !== 'string' || auth.refresh_token.length === 0
    || auth.refresh_token.length > 32768 || auth.access_token != null && typeof auth.access_token !== 'string'
    || auth.expiry_date != null && (!Number.isFinite(auth.expiry_date) || auth.expiry_date < 0)) throw fault('GEMINI_AUTH_FILE_UNSUPPORTED');
}
// Validate only the supported storage route. Token values never leave this
// function; the official SDK reads and refreshes that same original file.
function validatePlainPersonalHome(home, { fsImpl = fs } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw fault('GEMINI_AUTH_FILE_UNSUPPORTED');
  const auth = readBoundJson(path.join(home, '.gemini', 'oauth_creds.json'), { fsImpl });
  assertPersonalCredentials(auth);
  const settings = readBoundJson(path.join(home, '.gemini', 'settings.json'), { optional: true, fsImpl });
  const selectedType = settings?.security?.auth?.selectedType;
  if (selectedType != null && selectedType !== 'oauth-personal') throw fault('GEMINI_AUTH_MODE_UNSUPPORTED');
  return Object.freeze({ home: path.resolve(home), storage: 'personal-oauth-plaintext' });
}

// Only install in the dedicated worker before importing pinned core 0.58.0.
// Its public OAuth API has no storage injection: it directly reads/writes this
// leaf through fs.promises. Keep other SDK filesystem operations unchanged.
// This fences observed replacements; rename is atomic, not an OS CAS/lock
// against an unrelated writer racing between the final stat and rename.
function installGeminiStorageBoundary(home, { fsImpl = fs } = {}) {
  const leaf = path.join(path.resolve(home), '.gemini', 'oauth_creds.json');
  const operations = fsImpl.promises;
  const original = { readFile: operations.readFile.bind(operations), writeFile: operations.writeFile.bind(operations),
    chmod: operations.chmod.bind(operations) };
  let boundGeneration = null, failureCode = null, writes = Promise.resolve();
  const matches = value => typeof value === 'string' && path.resolve(value) === leaf;
  const fail = code => { failureCode ||= code; throw fault(code); };
  const currentGeneration = () => {
    assertPlainPath(leaf, fsImpl);
    return generation(fsImpl.lstatSync(leaf, { bigint: true }));
  };
  operations.readFile = async (file, ...args) => {
    if (!matches(file)) return original.readFile(file, ...args);
    try {
      const read = readBoundFile(leaf, { fsImpl });
      assertPersonalCredentials(JSON.parse(read.bytes));
      if (boundGeneration && read.generation !== boundGeneration) return fail('GEMINI_AUTH_FILE_CHANGED');
      boundGeneration = read.generation;
      const encoding = typeof args[0] === 'string' ? args[0] : args[0]?.encoding;
      return encoding ? read.bytes : Buffer.from(read.bytes);
    } catch (error) { return fail(error.code?.startsWith('GEMINI_') ? error.code : 'GEMINI_AUTH_FILE_UNSUPPORTED'); }
  };
  operations.writeFile = (file, data, ...args) => {
    if (!matches(file)) return original.writeFile(file, data, ...args);
    const write = async () => {
      let temp = null, handle = null;
      try {
        if (!boundGeneration || currentGeneration() !== boundGeneration) return fail('GEMINI_AUTH_FILE_CHANGED');
        if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_AUTH_BYTES) return fail('GEMINI_AUTH_FILE_UNSUPPORTED');
        assertPersonalCredentials(JSON.parse(data));
        temp = path.join(path.dirname(leaf), `oauth_creds.toolsenabled-${randomBytes(16).toString('hex')}.tmp`);
        handle = await operations.open(temp, 'wx', 0o600);
        await handle.writeFile(data, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        if (currentGeneration() !== boundGeneration) return fail('GEMINI_AUTH_FILE_CHANGED');
        await operations.rename(temp, leaf); temp = null;
        boundGeneration = currentGeneration();
      } catch (error) {
        failureCode ||= error.code?.startsWith('GEMINI_') ? error.code : 'GEMINI_AUTH_FILE_UNAVAILABLE';
        throw fault(failureCode);
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (temp) await operations.unlink(temp).catch(() => {});
      }
    };
    const pending = writes.then(write);
    writes = pending.catch(() => {});
    return pending;
  };
  operations.chmod = async (file, mode) => {
    if (!matches(file)) return original.chmod(file, mode);
    if (mode !== 0o600 || !boundGeneration || currentGeneration() !== boundGeneration) return fail('GEMINI_AUTH_FILE_CHANGED');
    // The atomic replacement was created with this exact mode. Do not chmod a
    // pathname again after committing it; a replacement may now occupy it.
  };
  return Object.freeze({ failureCode: () => failureCode, drain: () => writes,
    restore() { for (const [name, operation] of Object.entries(original)) operations[name] = operation; } });
}
module.exports = Object.freeze({ MAX_AUTH_BYTES, unsupportedEnvironment, assertPlainPath, validatePlainPersonalHome,
  assertPersonalCredentials, installGeminiStorageBoundary });
