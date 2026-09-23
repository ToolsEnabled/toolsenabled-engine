'use strict';

// A DURABLE MEMORY BACKEND THAT LIVES WHERE AN INSTALLATION MAY ACTUALLY WRITE.
//
// src/lib/custom-role-store.js was built to take its storage as a constructor
// argument -- it needs exactly three methods, getMemory/setMemory/searchMemory
// -- and its default was createStateStore() from src/lib/state-store.js. That
// default is why the feature could not ship. state-store resolves its files
// through runtime.js's rootPath(), which is `path.resolve(__dirname, '..',
// '..')`: the payload directory itself. In a packaged installation that is
// `resources/capability/`, so every custom role a customer defined would be
// written INSIDE the application's own payload.
//
// That is not a theoretical objection. tools/check-payload-boundary.mjs already
// fails a build that finds a `state/` directory in the payload, and it does
// find one, because the packaged app writes runtime files back into itself.
// Adding role definitions to that pile would put operator-authored content in a
// directory the packaging guard is trying to keep clean, and would lose it on
// reinstall.
//
// So this backend keeps the store's data where the rest of the installation's
// own data already lives: %LOCALAPPDATA%\<productName>, the directory
// src/lib/setup/machine-record.js calls "one folder a person could delete", and
// the same one src/lib/settings.js resolves its values file into.
//
// IT IS A BACKEND, NOT A SECOND STORE. It holds no opinion about roles. Every
// rule about what a role may be named, what fields it carries and how it is
// validated stays in custom-role-store.js, which is the only module that
// interprets any of this. This file does persistence and revisions and nothing
// else, so there is no role logic here that could drift from the role logic
// there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { STATE_ROOT_ENV, configuredStateRoot } = require('./runtime-state-root');

const SCHEMA_VERSION = 1;

// Bounds, so a renderer cannot turn a definitions file into unbounded disk.
// Generous against real use: custom-role-store caps custom roles at 10 and each
// rule field at 1500 characters, so the whole realistic file is a few KB.
const MAX_ENTRIES = 256;
const MAX_RECORD_BYTES = 1024 * 1024;

class DurableMemoryFileError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DurableMemoryFileError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new DurableMemoryFileError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The product-directory identity for installation-owned service state.
 *
 * ONE IDENTITY SOURCE. The Electron shell already resolves the running
 * product's userData directory from its productName, then sets
 * TOOLSENABLED_STATE_ROOT to <userData>/capability before loading or spawning
 * this payload. The parent of that state root therefore supplies the running
 * build's identity-bearing leaf: ToolsEnabled for the shipping product,
 * ToolsEnabled Test for a renamed lifecycle build. It does not move service
 * state into that parent; resolveServicesRoot combines this leaf with the
 * verified owner's LOCALAPPDATA. Reading the payload package name would be
 * wrong -- that package is byte-identical across builds -- and parsing the
 * executable would create a second identity resolver beside Electron's.
 *
 * Missing or malformed identity fails closed. Falling back to a literal here
 * would recreate the exact cross-installation write this resolver prevents.
 * machine-record.js and settings.js import this function; they do not restate
 * it. tests/agent-org-store.test.js pins all three consumers to one answer.
 * The account registry is not service state and remains below the selected
 * state root at config/accounts.json.
 */
function resolveProductDirectory({ env = process.env } = {}) {
  const rawStateRoot = env && typeof env[STATE_ROOT_ENV] === 'string'
    ? env[STATE_ROOT_ENV].trim()
    : '';
  if (!rawStateRoot) {
    fail('SERVICE_PRODUCT_IDENTITY_UNAVAILABLE',
      `The running product identity is unavailable because ${STATE_ROOT_ENV} is not set.`);
  }
  if (!path.isAbsolute(rawStateRoot)) {
    fail('SERVICE_PRODUCT_IDENTITY_UNAVAILABLE',
      `The running product identity is unavailable because ${STATE_ROOT_ENV} is not an absolute path.`);
  }
  const userData = path.dirname(path.resolve(rawStateRoot));
  const productDirectory = path.basename(userData);
  if (!productDirectory || userData === path.parse(userData).root) {
    fail('SERVICE_PRODUCT_IDENTITY_UNAVAILABLE',
      `The running product identity cannot be derived from ${STATE_ROOT_ENV}.`);
  }
  return productDirectory;
}

function resolveServicesRoot({
  env = process.env,
  homedir = os.homedir,
  platform = process.platform,
  accountBoundary = require('./account-profile-boundary'),
  configuredStateRootImpl = configuredStateRoot,
  fileSystem = fs
} = {}) {
  const productDirectory = resolveProductDirectory({ env });

  /* Preserve the shipped non-Windows location contract. LOCALAPPDATA is
   * honored first when a host deliberately supplies it; otherwise XDG data
   * home (or the ordinary home fallback) carries the selected product name. */
  if (platform !== 'win32') {
    const local = require('./local-user-profile').localProfileServicesRoot(configuredStateRootImpl(env), { fileSystem });
    if (local) return local;
    const localAppData = env && typeof env.LOCALAPPDATA === 'string'
      ? env.LOCALAPPDATA.trim()
      : '';
    if (localAppData && path.isAbsolute(localAppData)) {
      return path.join(localAppData, productDirectory);
    }
    const xdgDataHome = env && typeof env.XDG_DATA_HOME === 'string'
      ? env.XDG_DATA_HOME.trim()
      : '';
    const dataHome = xdgDataHome && path.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : path.join(homedir(), '.local', 'share');
    return path.join(dataHome, productDirectory);
  }

  /* On Windows the install owner and the running token must agree before an
   * ambient account path is inspected. installationProfileRoot is lexical,
   * so a wrong principal or an unbound Program Files payload is refused with
   * zero filesystem probes. */
  let ownerProfile;
  try { ownerProfile = accountBoundary.installationProfileRoot(); }
  catch (error) {
    fail('SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'The installation service root was refused because the running Windows principal does not own this ToolsEnabled installation.',
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }

  const localAppData = env && typeof env.LOCALAPPDATA === 'string'
    ? env.LOCALAPPDATA.trim()
    : '';
  if (!localAppData || !path.win32.isAbsolute(localAppData)) {
    fail('SERVICE_ROOT_UNAVAILABLE',
      'The installation service root is unavailable because LOCALAPPDATA is not an absolute path.');
  }

  let fencedLocalAppData;
  try {
    fencedLocalAppData = accountBoundary.assertAccountProfilePath(localAppData, {
      field: 'LOCALAPPDATA service root',
      profileRoot: ownerProfile,
      requireOwnedProfile: true,
      fileSystem
    });
  } catch (error) {
    fail('SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'The installation service root was refused because LOCALAPPDATA crosses an untrusted account or reparse boundary.',
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }

  let stateRoot;
  try { stateRoot = configuredStateRootImpl(env); }
  catch (error) {
    fail('SERVICE_ACCOUNT_BOUNDARY_REFUSED',
      'The installation service root was refused because its configured state root crosses an untrusted account or reparse boundary.',
      { cause: error && error.code ? String(error.code) : 'unknown' });
  }
  if (typeof stateRoot !== 'string' || !path.win32.isAbsolute(stateRoot)) {
    fail('SERVICE_PRODUCT_IDENTITY_UNAVAILABLE',
      `The running product identity cannot be rebound from ${STATE_ROOT_ENV}.`);
  }
  const selectedUserData = path.win32.dirname(stateRoot);
  const reboundProductDirectory = path.win32.basename(selectedUserData);
  const sameProductDirectory = platform === 'win32'
    ? reboundProductDirectory.toLowerCase() === productDirectory.toLowerCase()
    : reboundProductDirectory === productDirectory;
  if (!sameProductDirectory) {
    fail('SERVICE_PRODUCT_IDENTITY_UNAVAILABLE',
      `The running product identity cannot be rebound to the parent of ${STATE_ROOT_ENV}.`);
  }

  /* Machine/settings/org/roles/rotation state remains in the installation's
   * owner-fenced LOCALAPPDATA tree. Only the product-directory identity comes
   * from the shell-selected state root. The account registry is intentionally
   * separate at <stateRoot>/config/accounts.json. */
  const local = require('./local-user-profile').localProfileServicesRoot(stateRoot, {
    fileSystem,
    assertPath: value => accountBoundary.assertAccountProfilePath(value, {
      field: 'local profile services', profileRoot: ownerProfile, requireOwnedProfile: true, fileSystem
    })
  });
  return local || path.win32.join(fencedLocalAppData, productDirectory);
}

function emptyRecord() {
  return { schemaVersion: SCHEMA_VERSION, entries: {} };
}

/**
 * A damaged file does NOT silently become an empty one. `damaged` carries the
 * reason, and every operation that would otherwise report a definite result
 * refuses when the record could not be established.
 */
function parseRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { record: emptyRecord(), damaged: 'the file contains malformed JSON' };
  }
  if (!plain(parsed)) return { record: emptyRecord(), damaged: 'the file does not contain a JSON object' };
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return { record: emptyRecord(), damaged: `the file has schema version ${JSON.stringify(parsed.schemaVersion)}, which this build does not understand` };
  }
  if (!plain(parsed.entries)) {
    return { record: emptyRecord(), damaged: 'the file does not contain an entries object' };
  }
  const entries = {};
  for (const [composite, value] of Object.entries(parsed.entries)) {
    if (!plain(value) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        typeof value.namespace !== 'string' || typeof value.key !== 'string' ||
        composite !== namespacedKey(value.namespace, value.key) ||
        (value.note !== undefined && typeof value.note !== 'string') ||
        (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string')))) {
      return { record: emptyRecord(), damaged: `the file contains an invalid entry at ${JSON.stringify(composite)}` };
    }
    // `note` and `tags` are RELOADED, not dropped. They were dropped once, and
    // the effect was not a missing label: searchMemory matches against them,
    // so every stored entry became invisible to a search the moment the
    // process restarted. custom-role-store.js lists roles through
    // searchMemory, so a custom role defined in one session simply did not
    // exist in the next one -- persisted perfectly, and unreachable.
    entries[composite] = {
      namespace: value.namespace,
      key: value.key,
      value: value.value,
      revision: value.revision,
      updatedAt: String(value.updatedAt || ''),
      ...(value.note === undefined ? {} : { note: value.note }),
      ...(value.tags === undefined ? {} : { tags: value.tags })
    };
  }
  return { record: { schemaVersion: SCHEMA_VERSION, entries }, damaged: null };
}

function namespacedKey(namespace, key) {
  return `${namespace}\u0000${key}`;
}

/**
 * A durable memory backend over one JSON file.
 *
 * `file` defaults to a name inside the installation's own directory. Tests pass
 * an explicit path; nothing else needs to.
 */
function createDurableMemoryFile({
  file,
  name = 'durable-memory.json',
  env = process.env,
  fileSystem = fs,
  randomUUID = crypto.randomUUID,
  clock = () => new Date().toISOString(),
  pid = process.pid
} = {}) {
  const target = file || path.join(resolveServicesRoot({ env }), name);
  const directory = path.dirname(target);

  let record = null;
  let damaged = null;

  function load() {
    if (record) return record;
    let text;
    try {
      text = fileSystem.readFileSync(target, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        record = emptyRecord();
        return record;
      }
      // Unreadable is not empty. Keep an internal placeholder only so `damage`
      // can explain the problem; result-producing reads and every write refuse.
      record = emptyRecord();
      damaged = `the file could not be read (${error && error.code ? error.code : 'unknown error'})`;
      return record;
    }
    const parsed = parseRecord(text);
    record = parsed.record;
    damaged = parsed.damaged;
    return record;
  }

  function persist(next) {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
      fail('DURABLE_MEMORY_TOO_LARGE', 'The stored record would exceed its size limit.');
    }
    const temporary = path.join(directory, `.${path.basename(target)}-${pid}-${randomUUID()}.tmp`);
    let descriptor;
    try {
      fileSystem.mkdirSync(directory, { recursive: true });
      descriptor = fileSystem.openSync(temporary, 'wx');
      fileSystem.writeFileSync(descriptor, text, 'utf8');
      // fsync BEFORE rename. Persistence is proven by force-killing the process
      // between launches, and a store that is only durable at a graceful exit
      // must not be able to pass that proof.
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(temporary, target);
    } catch (error) {
      fail('DURABLE_MEMORY_WRITE_FAILED', `The record could not be saved (${error && error.code ? error.code : 'unknown error'}).`);
    } finally {
      if (descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch { /* closing a failed handle */ }
      }
      try { fileSystem.unlinkSync(temporary); } catch { /* already renamed away */ }
    }
    record = next;
    damaged = null;
  }

  function refuseDamagedRead() {
    if (damaged) {
      fail('DURABLE_MEMORY_DAMAGED', `The record could not be read: ${damaged}`);
    }
  }

  return {
    file: target,

    /** Why the stored record could not be read, or null. */
    damage() {
      load();
      return damaged;
    },

    getMemory({ namespace, key }) {
      const current = load();
      refuseDamagedRead();
      const entry = current.entries[namespacedKey(namespace, key)];
      if (!entry) return null;
      return Object.freeze({ namespace, key, value: entry.value, revision: entry.revision, updatedAt: entry.updatedAt });
    },

    /**
     * `expectedRevision` is optimistic concurrency, and 0 means "this key must
     * not exist yet" -- the contract custom-role-store.js relies on to turn a
     * duplicate create into a named collision instead of an overwrite.
     */
    setMemory({ namespace, key, value, expectedRevision, note, tags }) {
      const current = load();
      if (damaged) {
        fail('DURABLE_MEMORY_DAMAGED', `Refusing to overwrite a record that could not be read: ${damaged}`);
      }
      const composite = namespacedKey(namespace, key);
      const existing = current.entries[composite] || null;
      const revision = existing ? existing.revision : 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        fail('MEMORY_REVISION_CONFLICT',
          `Expected revision ${expectedRevision} for "${key}" but found ${revision}.`,
          { namespace, key, expectedRevision, actualRevision: revision });
      }
      if (!existing && Object.keys(current.entries).length >= MAX_ENTRIES) {
        fail('DURABLE_MEMORY_FULL', `The store already holds its limit of ${MAX_ENTRIES} entries.`);
      }
      // namespace and key are stored as fields, not left to be recovered by
      // splitting the composite key back apart. The composite is an index, and
      // an index that is also the only copy of its own parts is a parser
      // waiting to disagree with the thing that wrote it.
      const updated = {
        namespace,
        key,
        value,
        revision: revision + 1,
        updatedAt: clock(),
        ...(note === undefined ? {} : { note }),
        ...(tags === undefined ? {} : { tags })
      };
      persist({ schemaVersion: SCHEMA_VERSION, entries: { ...current.entries, [composite]: updated } });
      return Object.freeze({
        entry: Object.freeze({ namespace, key, value, revision: updated.revision, updatedAt: updated.updatedAt }),
        created: !existing,
        replayed: false
      });
    },

    /**
     * Substring search over key and note, scoped to a namespace. Deliberately
     * simple: the only caller lists at most ten role definitions, so an index
     * would be machinery with no reader.
     */
    searchMemory({ namespace, query, limit = 20 }) {
      const current = load();
      refuseDamagedRead();
      const needle = String(query || '').toLowerCase();
      const found = [];
      // Read from the stored fields rather than splitting the composite back
      // apart: the composite is an index, and an index that is also the only
      // copy of its own parts is a parser waiting to disagree with its writer.
      for (const entry of Object.values(current.entries)) {
        const entryNamespace = entry.namespace;
        const key = entry.key;
        if (namespace !== undefined && entryNamespace !== namespace) continue;
        const haystack = `${key} ${entry.note || ''} ${(entry.tags || []).join(' ')}`.toLowerCase();
        if (needle && !haystack.includes(needle)) continue;
        found.push(Object.freeze({ namespace: entryNamespace, key, value: entry.value, revision: entry.revision, updatedAt: entry.updatedAt }));
        if (found.length >= limit) break;
      }
      return Object.freeze(found);
    },

    /** Remove one entry. Returns whether anything was removed. */
    deleteMemory({ namespace, key }) {
      const current = load();
      if (damaged) {
        fail('DURABLE_MEMORY_DAMAGED', `Refusing to write over a record that could not be read: ${damaged}`);
      }
      const composite = namespacedKey(namespace, key);
      if (!current.entries[composite]) return false;
      const entries = { ...current.entries };
      delete entries[composite];
      persist({ schemaVersion: SCHEMA_VERSION, entries });
      return true;
    }
  };
}

// Shared by the settings surface and lower-level admission readers, so both
// use the same per-installation file without importing the surface package.
function resolveSettingsValuesPath({ env = process.env } = {}) {
  return path.isAbsolute(env.TOOLSENABLED_SETTINGS_PATH || '')
    ? env.TOOLSENABLED_SETTINGS_PATH
    : path.join(resolveServicesRoot({ env }), 'settings.json');
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  MAX_ENTRIES,
  MAX_RECORD_BYTES,
  DurableMemoryFileError,
  resolveServicesRoot,
  resolveSettingsValuesPath,
  createDurableMemoryFile
});
