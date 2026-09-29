'use strict';

// FRA-only, pathless workspace reader. A peer can traverse only from an
// internally opened root directory and can refer to descendants only by
// session-scoped random handles returned by this module. Caller-supplied
// absolute or relative paths do not exist in either public schema.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../audit');
const fileContexts = require('../file-tool-context');
const {
  assertSanctionedMachineAddress,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../service-registry');
const {
  EXCLUDED_DIR_NAMES,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_BYTES,
  MAX_HANDLES_PER_SESSION,
  MAX_PAGE_ENTRIES,
  MAX_READ_BYTES,
  WORKSPACE_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST,
  isCredentialOrHistoryPath,
  isExcludedDirectoryPath
} = require('../fra-workspace-policy');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERSION_RE = /^[a-f0-9]{64}$/;
const CONTEXT_RE = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 16;
const SESSION_TTL_MS = 20 * 60 * 1000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
// Cursors are single-use and expire independently of their session. Bound the
// outstanding set as well, because an active peer can otherwise retain every
// expired token it never presents again.
const MAX_CURSORS_PER_SESSION = 256;
const MAX_PAGE_MARKERS = MAX_PAGE_ENTRIES;
const IDENTITY_DOMAIN = 'ToolsEnabled/FRA/workspace-handle/v1';
const DIRECTORY_DOMAIN = 'ToolsEnabled/FRA/workspace-directory/v1';
const CHILD_SET_DOMAIN = 'ToolsEnabled/FRA/workspace-child-set/v1';
// A folder handle whose listed child set no longer matches its folder. Kept in
// the session so the old handle keeps answering stale instead of unknown.
const CHILD_SET_STALE = Symbol('child-set-stale');
const CONTENT_DOMAIN = 'ToolsEnabled/FRA/workspace-file-content/v1';
// A file handle whose bytes no longer match what this session bound it to.
const CONTENT_STALE = Symbol('content-stale');
// A file changed this recently may change again under the same time stamps:
// NTFS stamps move in 15.6 ms steps, coarse POSIX stamps in one kernel tick,
// FAT write times in 2 s. Its stat version alone cannot prove that a later
// read returns the bytes that were listed, so a listing binds such a file to
// its bytes. Older files cannot collide: any later write gets a newer stamp.
const SAME_STAMP_WINDOW_MS = 3000;
// Bytes one listing call may read to bind recently changed files (about 20 ms
// on NTFS). A file past this budget is bound by its first read instead.
const LISTING_CONTENT_BUDGET_BYTES = 4 * 1024 * 1024;
const AUDIT_DOMAIN = 'ToolsEnabled/FRA/workspace-audit-target/v1';
class FraWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraWorkspaceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FraWorkspaceError(code, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function identityOf(stat) {
  if (!stat || ![
    'dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'
  ].every(field => typeof stat[field] === 'bigint')) {
    fail('WORKSPACE_IDENTITY_UNAVAILABLE', 'workspace handle identity is unavailable');
  }
  // POSIX directories count their own and child-directory entries as links;
  // that is not a hard-linked regular file. Keep the exact observed count in
  // the identity and every before/opened/after comparison, but require one
  // link only for non-directory entries. NTFS directories may report one.
  const directory = typeof stat.isDirectory === 'function' && stat.isDirectory();
  if (stat.dev <= 0n || stat.ino <= 0n
      || (directory ? stat.nlink < 1n : stat.nlink !== 1n) || stat.size < 0n) {
    fail('WORKSPACE_IDENTITY_INVALID', 'workspace handle identity is invalid');
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  });
}

function sameIdentity(left, right) {
  const a = identityOf(left);
  const b = identityOf(right);
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink
    && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs;
}

function identityVersion(kind, identity) {
  return crypto.createHash('sha256')
    .update(IDENTITY_DOMAIN, 'utf8').update('\0', 'utf8')
    .update(kind, 'utf8').update('\0', 'utf8')
    .update([
      identity.dev,
      identity.ino,
      identity.nlink,
      identity.size,
      identity.mtimeNs,
      identity.ctimeNs
    ].map(value => value.toString(10)).join('\0'), 'utf8')
    .digest('hex');
}

// Every enumerated name with its entry kind, hidden names included: the facts
// a POSIX folder's link count and change time track, taken from the
// enumeration itself so they do not depend on how finely the filesystem stamps
// times (an NTFS folder keeps one link and size zero, and its times move in
// 15.6 ms steps). Child versions and marker codes are left out: each child's
// own handle carries those, and an unreadable file becoming readable must not
// make its folder stale.
function childSetDigest(rawEntries) {
  const digest = crypto.createHash('sha256').update(CHILD_SET_DOMAIN, 'utf8');
  for (const entry of rawEntries) {
    const rawName = Buffer.isBuffer(entry?.name)
      ? entry.name : Buffer.from(entry?.name || '', 'utf8');
    const kind = typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink() ? 'link'
      : typeof entry?.isDirectory === 'function' && entry.isDirectory() ? 'directory'
        : typeof entry?.isFile === 'function' && entry.isFile() ? 'file' : 'other';
    digest.update(`\0${kind}\0${rawName.length}\0`, 'utf8').update(rawName);
  }
  return digest.digest('hex');
}

function contentDigest(bytes) {
  return crypto.createHash('sha256').update(CONTENT_DOMAIN, 'utf8').update('\0', 'utf8')
    .update(bytes).digest('hex');
}

// True when the newest of a file's write and change times lies within the
// same-stamp window of the listing clock (or the clock is unusable).
function changedWithinSameStampWindow(identity, listedAtMs) {
  if (!Number.isFinite(listedAtMs)) return true;
  const newest = identity.mtimeNs > identity.ctimeNs ? identity.mtimeNs : identity.ctimeNs;
  return newest >= BigInt(Math.trunc(listedAtMs) - SAME_STAMP_WINDOW_MS) * 1000000n;
}

function opaqueToken(randomBytes) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    fail('WORKSPACE_RANDOM_UNAVAILABLE', 'workspace handle randomness is unavailable');
  }
  try {
    const token = bytes.toString('base64url');
    if (!HANDLE_RE.test(token)) {
      fail('WORKSPACE_RANDOM_INVALID', 'workspace handle randomness is invalid');
    }
    return token;
  } finally {
    bytes.fill(0);
  }
}

function normalizeContext(context, serviceRegistryOptions = {}) {
  const binding = context && context.fraWorkspaceContext;
  if (!plainObject(binding)
      || Object.keys(binding).sort().join(',') !==
        'clientHost,generation,serverHost,sessionContextDigest'
      || !CONTEXT_RE.test(binding.sessionContextDigest || '')
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'workspace handles require a bound FRA session');
  }
  try {
    assertSanctionedMachineAddress(binding.serverHost, serviceRegistryOptions);
    assertSanctionedMachineAddress(binding.clientHost, serviceRegistryOptions);
    if (binding.serverHost === binding.clientHost
        || peerMachineForAddress(binding.serverHost, serviceRegistryOptions).address !== binding.clientHost) {
      fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'workspace handles require a bound FRA session');
    }
  } catch (error) {
    if (error instanceof FraWorkspaceError) throw error;
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'workspace handles require a bound FRA session');
    }
    throw error;
  }
  return Object.freeze({ ...binding });
}

function safeRelative(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!inside(root, candidate)) {
    fail('WORKSPACE_ROOT_ESCAPE', 'workspace entry escaped the protected root');
  }
  return relative.split(path.sep).join('/');
}

function auditTarget(relative) {
  return crypto.createHash('sha256')
    .update(AUDIT_DOMAIN, 'utf8').update('\0', 'utf8')
    .update(relative, 'utf8').digest('hex');
}

function readRefusal(error) {
  if (error instanceof FraWorkspaceError) return error;
  // Neither the generic byte refusal projector nor arbitrary filesystem
  // messages are pathless. Keep authority internals and repair bytes private.
  const code = error && error.code;
  if (['WORKSPACE_FRA_CONTEXT_REQUIRED', 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED',
    'REPO_FILE_INVOCATION_INVALID', 'BYTE_SCOPE_CLOSED'].includes(code)) {
    return new FraWorkspaceError('WORKSPACE_FRA_CONTEXT_REQUIRED', 'Workspace access requires its current accepted FRA connection.');
  }
  if (code === 'BYTE_AUTHORITY_BUSY') return new FraWorkspaceError('WORKSPACE_COORDINATION_BUSY', 'Workspace coordination is busy; retry from the current connection.');
  return new FraWorkspaceError('WORKSPACE_COORDINATION_UNAVAILABLE', 'Workspace coordination could not prove this read; no file content is returned.');
}

class FraWorkspaceHandleBroker {
  constructor({
    root = ROOT,
    fsApi = fs,
    randomBytes = crypto.randomBytes,
    auditApi = audit,
    now = Date.now,
    maxHandlesPerSession = MAX_HANDLES_PER_SESSION,
    maxCursorsPerSession = MAX_CURSORS_PER_SESSION,
    maxSessions = MAX_SESSIONS,
    listingContentBudgetBytes = LISTING_CONTENT_BUDGET_BYTES,
    serviceRegistryOptions = {},
    authorityFactory = null
  } = {}) {
    this.fs = fsApi;
    this.randomBytes = randomBytes;
    this.audit = auditApi;
    this.now = now;
    this.maxHandlesPerSession = maxHandlesPerSession;
    if (!Number.isSafeInteger(maxCursorsPerSession) || maxCursorsPerSession < 1) {
      fail('WORKSPACE_CURSOR_CAPACITY_INVALID', 'workspace cursor capacity configuration is invalid');
    }
    this.maxCursorsPerSession = maxCursorsPerSession;
    this.maxSessions = maxSessions;
    if (!Number.isSafeInteger(listingContentBudgetBytes) || listingContentBudgetBytes < 0) {
      fail('WORKSPACE_CONTENT_BUDGET_INVALID', 'workspace listing content budget is invalid');
    }
    this.listingContentBudgetBytes = listingContentBudgetBytes;
    this.serviceRegistryOptions = serviceRegistryOptions;
    if (authorityFactory !== null && typeof authorityFactory !== 'function') fail('WORKSPACE_COORDINATION_UNAVAILABLE', 'Workspace coordination adapter is invalid.');
    this.authorityFactory = authorityFactory;
    this.root = path.resolve(root);
    this.canonicalRoot = this._realpath(this.root);
    if (!inside(this.root, this.canonicalRoot) && !inside(this.canonicalRoot, this.root)) {
      fail('WORKSPACE_ROOT_INVALID', 'workspace protected root is invalid');
    }
    const opened = this._openIdentity(this.root, 'directory', { allowRoot: true });
    try {
      const { birthtimeNs } = this.fs.fstatSync(opened.fd, { bigint: true });
      if (typeof birthtimeNs !== 'bigint' || birthtimeNs === 0n) {
        fail('WORKSPACE_ROOT_IDENTITY_UNAVAILABLE', 'workspace root creation identity is unavailable');
      }
      this.rootVersion = opened.version;
      // Content timestamps may change between connections. Creation identity
      // also binds the object when a filesystem reuses a retired inode number.
      this.rootIdentity = Object.freeze({ dev: opened.identity.dev, ino: opened.identity.ino, birthtimeNs });
    } finally { this._close(opened.fd); }
    this.sessions = new Map();
  }

  _realpath(target) {
    const realpath = this.fs.realpathSync.native || this.fs.realpathSync;
    return realpath.call(this.fs.realpathSync, target);
  }

  _close(descriptor) {
    if (descriptor === undefined) return;
    this.fs.closeSync(descriptor);
  }

  _recordAudit(action, target, details) {
    let status;
    try {
      // record() may batch its anchor. A read release requires the exact
      // append anchored now, so ask the real audit plane for that contract.
      const record = this.audit.requireRecord || this.audit.record;
      status = record.call(this.audit, action, target, details);
    } catch {
      fail('WORKSPACE_AUDIT_UNAVAILABLE', 'workspace access audit is unavailable');
    }
    if (!status || status.durable !== true || status.anchored !== true) {
      fail('WORKSPACE_AUDIT_UNAVAILABLE', 'workspace access audit is unavailable');
    }
  }

  _validateRelative(relative, { allowRoot = false } = {}) {
    if (relative === '') {
      if (allowRoot) return;
      fail('WORKSPACE_ROOT_INVALID', 'workspace root cannot be selected as an entry');
    }
    const segments = relative.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      fail('WORKSPACE_ENTRY_INVALID', 'workspace entry identity is invalid');
    }
    if (isExcludedDirectoryPath(relative)
        || isCredentialOrHistoryPath(relative)) {
      fail('WORKSPACE_ENTRY_FORBIDDEN', 'workspace entry is outside the exposed tree');
    }
  }

  _openIdentity(target, expectedKind, { allowRoot = false } = {}) {
    const absolute = path.resolve(target);
    let before;
    let canonical;
    let descriptor;
    try {
      before = this.fs.lstatSync(absolute, { bigint: true });
      if (before.isSymbolicLink()) {
        fail('WORKSPACE_REPARSE_REFUSED', 'workspace entries must not be reparse points');
      }
      canonical = this._realpath(absolute);
      const relative = safeRelative(this.canonicalRoot, canonical);
      this._validateRelative(relative, { allowRoot });
      const kind = before.isDirectory() ? 'directory'
        : before.isFile() ? 'file' : null;
      if (kind !== expectedKind) {
        fail('WORKSPACE_HANDLE_KIND_MISMATCH', 'workspace handle kind changed');
      }
      const constants = this.fs.constants || fs.constants;
      const readFlags = typeof constants.O_RDONLY === 'number'
        ? constants.O_RDONLY : 0;
      const openFlags = process.platform === 'linux'
        && typeof constants.O_NONBLOCK === 'number'
        ? readFlags | constants.O_NONBLOCK : 'r';
      descriptor = this.fs.openSync(absolute, openFlags);
      const opened = this.fs.fstatSync(descriptor, { bigint: true });
      const openedKind = opened.isDirectory() ? 'directory'
        : opened.isFile() ? 'file' : null;
      if (openedKind !== expectedKind) {
        fail('WORKSPACE_HANDLE_KIND_MISMATCH', 'workspace handle kind changed');
      }
      // Cached session handles and explicit root selectors also come through
      // this open. Recheck the captured object before enumerating its bytes;
      // the legacy handle tuple alone cannot distinguish a recycled inode.
      if (allowRoot && this.rootIdentity) {
        if (typeof opened.birthtimeNs !== 'bigint' || opened.birthtimeNs === 0n) {
          fail('WORKSPACE_ROOT_IDENTITY_UNAVAILABLE', 'workspace root creation identity is unavailable');
        }
        if (opened.dev !== this.rootIdentity.dev || opened.ino !== this.rootIdentity.ino
            || opened.birthtimeNs !== this.rootIdentity.birthtimeNs) {
          fail('WORKSPACE_HANDLE_STALE', 'workspace protected root was replaced');
        }
      }
      const after = this.fs.lstatSync(absolute, { bigint: true });
      const canonicalAfter = this._realpath(absolute);
      if (!sameIdentity(before, opened) || !sameIdentity(opened, after)
          || canonicalAfter.toLowerCase() !== canonical.toLowerCase()) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace entry changed while opening');
      }
      const identity = identityOf(opened);
      return Object.freeze({
        fd: descriptor,
        absolute,
        canonical,
        relative,
        kind,
        identity,
        version: identityVersion(kind, identity)
      });
    } catch (error) {
      this._close(descriptor);
      if (error instanceof FraWorkspaceError) throw error;
      if (error && error.code === 'ENOENT') {
        fail('WORKSPACE_HANDLE_STALE', 'workspace entry no longer exists');
      }
      fail('WORKSPACE_ENTRY_UNAVAILABLE', 'workspace entry is unavailable');
    }
  }

  _cleanupCursors(session, now = this.now(), preserveToken = null) {
    for (const [token, cursor] of session.cursors) {
      if (token !== preserveToken && cursor.expiresAt <= now) session.cursors.delete(token);
    }
  }

  _cleanup(preserveSessionKey = null, preserveToken = null) {
    const now = this.now();
    const cutoff = now - SESSION_TTL_MS;
    for (const [key, session] of this.sessions) {
      if (session.touchedAt < cutoff) {
        this.sessions.delete(key);
        continue;
      }
      this._cleanupCursors(session, now, key === preserveSessionKey ? preserveToken : null);
    }
  }

  _session(context, create = true, preserveCursor = null) {
    try { fileContexts.requireFraFileToolContext(context.fileToolContext, context.fraWorkspaceContext); }
    catch (error) { throw readRefusal(error); }
    const binding = normalizeContext(context, this.serviceRegistryOptions);
    this._cleanup(binding.sessionContextDigest, preserveCursor);
    let session = this.sessions.get(binding.sessionContextDigest);
    if (!session && create) {
      if (this.sessions.size >= this.maxSessions) {
        fail('WORKSPACE_SESSION_CAPACITY', 'workspace session capacity is exhausted');
      }
      session = {
        binding,
        fileToolContext: context.fileToolContext,
        handles: new Map(),
        byIdentity: new Map(),
        cursors: new Map(),
        // Folder handle token -> child-set digest of its first listing.
        childSets: new Map(),
        // File handle token -> content digest it is bound to (see _bindContent).
        contentBindings: new Map(),
        touchedAt: this.now(),
        rootHandle: null
      };
      this.sessions.set(binding.sessionContextDigest, session);
    }
    if (!session) fail('WORKSPACE_SESSION_UNKNOWN', 'workspace session is unavailable');
    if (session.fileToolContext !== context.fileToolContext) fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'Workspace handles belong to a different accepted connection.');
    this._cleanupCursors(session, this.now(), preserveCursor);
    session.touchedAt = this.now();
    return session;
  }

  _identityKey(kind, canonical, version) {
    return `${kind}\0${canonical.toLowerCase()}\0${version}`;
  }

  _register(session, opened, listedContent = null) {
    const key = this._identityKey(opened.kind, opened.canonical, opened.version);
    const existingToken = session.byIdentity.get(key);
    if (existingToken) {
      const existing = session.handles.get(existingToken);
      const bound = session.contentBindings.get(existingToken);
      if (existing && (listedContent === null || bound === undefined || bound === listedContent)) {
        if (listedContent !== null && bound === undefined) {
          session.contentBindings.set(existingToken, listedContent);
        }
        return existing;
      }
      // Same stat version, different bytes: the old handle keeps answering
      // stale and this listing issues a new handle for the new bytes.
      if (existing) this._retireContent(session, existing);
    }
    if (session.handles.size >= this.maxHandlesPerSession) {
      fail('WORKSPACE_HANDLE_CAPACITY', 'workspace handle capacity is exhausted');
    }
    let token;
    do { token = opaqueToken(this.randomBytes); }
    while (session.handles.has(token));
    const record = Object.freeze({
      token,
      kind: opened.kind,
      absolute: opened.absolute,
      canonical: opened.canonical,
      relative: opened.relative,
      version: opened.version,
      byteLength: opened.kind === 'file' ? opened.identity.size : null
    });
    session.handles.set(token, record);
    session.byIdentity.set(key, token);
    if (listedContent !== null) session.contentBindings.set(token, listedContent);
    return record;
  }

  _retireContent(session, record) {
    session.contentBindings.set(record.token, CONTENT_STALE);
    const key = this._identityKey(record.kind, record.canonical, record.version);
    if (session.byIdentity.get(key) === record.token) session.byIdentity.delete(key);
  }

  // Reads a recently changed file once through the listing's own descriptor
  // and returns the digest of its bytes, or null when they could not be read
  // whole (the file's first read binds it instead). A change while hashing
  // needs no second stat: a new stat version makes the handle stale anyway,
  // and a same-stamp change only binds bytes a later read will not match.
  _listedContentDigest(opened) {
    const total = Number(opened.identity.size);
    let bytes;
    try {
      bytes = Buffer.alloc(total);
      let read = 0;
      while (read < total) {
        const count = this.fs.readSync(opened.fd, bytes, read, total - read, read);
        if (!Number.isSafeInteger(count) || count <= 0) return null;
        read += count;
      }
      return contentDigest(bytes);
    } catch {
      return null;
    } finally {
      if (bytes) bytes.fill(0);
    }
  }

  // A file's stat version cannot see a same-size rewrite within one time
  // stamp. Each file handle is bound per session to the bytes its listing
  // hashed (recently changed files) or else to the bytes of its first read;
  // once the file's bytes differ, that handle is stale, before any byte is
  // returned, and a fresh listing issues a new handle for the new bytes.
  _bindContent(session, record, bytes) {
    const digest = contentDigest(bytes);
    const bound = session.contentBindings.get(record.token);
    if (bound === undefined) {
      session.contentBindings.set(record.token, digest);
      return;
    }
    if (bound === digest) return;
    if (bound !== CONTENT_STALE) this._retireContent(session, record);
    fail('WORKSPACE_HANDLE_STALE', 'workspace file changed');
  }

  _rootRecord(session) {
    if (session.rootHandle) {
      const existing = session.handles.get(session.rootHandle);
      if (existing) return existing;
    }
    const opened = this._openIdentity(this.root, 'directory', { allowRoot: true });
    try {
      const { birthtimeNs } = this.fs.fstatSync(opened.fd, { bigint: true });
      if (typeof birthtimeNs !== 'bigint' || birthtimeNs === 0n) {
        fail('WORKSPACE_ROOT_IDENTITY_UNAVAILABLE', 'workspace root creation identity is unavailable');
      }
      if (opened.identity.dev !== this.rootIdentity.dev || opened.identity.ino !== this.rootIdentity.ino
          || birthtimeNs !== this.rootIdentity.birthtimeNs) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace protected root was replaced; reconnect after the host restores its protected root');
      }
      const record = this._register(session, opened);
      session.rootHandle = record.token;
      return record;
    } finally {
      this._close(opened.fd);
    }
  }

  _record(session, token, kind, expectedVersion) {
    if (!HANDLE_RE.test(token || '') || !VERSION_RE.test(expectedVersion || '')) {
      fail('WORKSPACE_HANDLE_INVALID', 'workspace handle or version is invalid');
    }
    const record = session.handles.get(token);
    if (!record || record.kind !== kind) {
      fail('WORKSPACE_HANDLE_UNKNOWN', 'workspace handle is not valid for this session');
    }
    if (record.version !== expectedVersion) {
      fail('WORKSPACE_HANDLE_STALE', 'workspace handle version is stale');
    }
    return record;
  }

  _entrySet(directoryRecord, openedDirectory, session,
    raw = this._boundedDirectoryEntries(openedDirectory.absolute)) {
    const listedAtMs = this.now();
    let contentBudget = this.listingContentBudgetBytes;
    const entries = [];
    const markers = [];
    const digestRows = [];
    const childMarkerCodes = new Set([
      'WORKSPACE_ENTRY_INVALID',
      'WORKSPACE_ENTRY_UNAVAILABLE',
      'WORKSPACE_HANDLE_KIND_MISMATCH',
      'WORKSPACE_HANDLE_STALE',
      'WORKSPACE_IDENTITY_INVALID',
      'WORKSPACE_IDENTITY_UNAVAILABLE',
      'WORKSPACE_REPARSE_REFUSED',
      'WORKSPACE_ROOT_ESCAPE'
    ]);
    const entryIdFor = rawName => crypto.createHash('sha256')
      .update('ToolsEnabled/FRA/workspace-entry/v1', 'utf8')
      .update('\0', 'utf8')
      .update(directoryRecord.version, 'utf8')
      .update('\0', 'utf8')
      .update(rawName)
      .digest('hex');
    const childRelative = name => directoryRecord.relative
      ? directoryRecord.relative + '/' + name : name;
    const policyHidden = name => {
      if (name === '[unavailable name]') return false;
      const aliases = new Set([name, name.normalize('NFC')]);
      const trimmed = name.replace(/ +$/u, '');
      if (trimmed !== name) aliases.add(trimmed);
      return [...aliases].some(alias => isExcludedDirectoryPath(childRelative(alias))
        || isCredentialOrHistoryPath(childRelative(alias)));
    };
    const addMarker = (rawName, name, code) => {
      markers.push(Object.freeze({
        name,
        kind: 'unavailable',
        code,
        entryId: entryIdFor(rawName)
      }));
      digestRows.push({ rawName: Buffer.from(rawName), kind: 'unavailable', value: code });
    };
    for (const entry of raw) {
      const rawName = Buffer.isBuffer(entry?.name)
        ? Buffer.from(entry.name) : Buffer.from(entry?.name || '', 'utf8');
      const decodedName = rawName.toString('utf8');
      const losslessUtf8 = Buffer.compare(Buffer.from(decodedName, 'utf8'), rawName) === 0;
      const displayName = losslessUtf8 ? decodedName : '[unavailable name]';
      if (policyHidden(displayName)) continue;
      const invalidName = rawName.length === 0 || rawName.includes(0)
        || rawName.includes(0x2f) || rawName.includes(0x5c)
        || !losslessUtf8 || decodedName !== decodedName.normalize('NFC');
      if (invalidName) {
        addMarker(rawName, displayName, 'WORKSPACE_ENTRY_INVALID');
        continue;
      }
      const candidate = path.join(openedDirectory.absolute, decodedName);
      let child;
      try {
        if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
          addMarker(rawName, displayName, 'WORKSPACE_REPARSE_REFUSED');
          continue;
        }
        const childKind = entry.isDirectory() ? 'directory'
          : entry.isFile() ? 'file' : null;
        if (!childKind) {
          addMarker(rawName, displayName, 'WORKSPACE_ENTRY_INVALID');
          continue;
        }
        child = this._openIdentity(candidate, childKind);
        let listedContent = null;
        if (childKind === 'file' && child.identity.size <= BigInt(MAX_FILE_BYTES)
            && child.identity.size <= BigInt(contentBudget)
            && changedWithinSameStampWindow(child.identity, listedAtMs)) {
          contentBudget -= Number(child.identity.size);
          listedContent = this._listedContentDigest(child);
        }
        /* A HANDLE BELONGS TO AN ENTRY THAT WAS RETURNED, NOT ONE MERELY
           SCANNED. Minting here registered one session handle per entry in the
           directory: a 1,500-entry folder listed at the default page size of
           100 took 1,501 of the 4,096-handle session ceiling, so the third such
           listing ended the session with WORKSPACE_HANDLE_CAPACITY. A customer
           browsing an ordinary project folder exhausted their own workspace,
           and a paired peer could do it deliberately in three calls. The set
           digest below is built from name, kind and version -- none of which
           need a handle -- so paging and cursor stability are unaffected. */
        entries.push(Object.freeze({
          name: displayName,
          kind: childKind,
          version: child.version,
          pending: Object.freeze({ child, listedContent }),
          ...(childKind === 'file' ? { bytes: Number(child.identity.size) } : {})
        }));
        digestRows.push({
          rawName: Buffer.from(rawName),
          kind: childKind,
          value: child.version
        });
      } catch (error) {
        if (error instanceof FraWorkspaceError && error.code === 'WORKSPACE_ENTRY_FORBIDDEN') {
          continue;
        }
        if (error instanceof FraWorkspaceError && childMarkerCodes.has(error.code)) {
          addMarker(rawName, displayName, error.code);
          continue;
        }
        throw error;
      } finally {
        if (child) this._close(child.fd);
      }
    }
    const digest = crypto.createHash('sha256')
      .update(DIRECTORY_DOMAIN, 'utf8').update('\0', 'utf8')
      .update(directoryRecord.version, 'utf8');
    for (const row of digestRows) {
      digest.update('\0', 'utf8')
        .update(row.kind, 'utf8')
        .update('\0', 'utf8')
        .update(row.rawName)
        .update('\0', 'utf8')
        .update(row.value, 'utf8');
    }
    return { entries, markers, setDigest: digest.digest('hex') };
  }

  // A folder's stat version cannot see a child added, removed or renamed within
  // one filesystem time step. Each folder handle is bound to the child set its
  // first listing enumerated; once the folder's set differs, that handle is
  // stale on every platform, before any child is opened or registered. The
  // handle is also retired from reuse, so a fresh listing of its parent issues
  // a new handle for the changed folder, as a changed stat version would.
  _assertChildSetCurrent(session, directoryRecord, digest) {
    const listed = session.childSets.get(directoryRecord.token);
    if (listed === undefined) {
      session.childSets.set(directoryRecord.token, digest);
      return;
    }
    if (listed === digest) return;
    if (listed !== CHILD_SET_STALE) {
      session.childSets.set(directoryRecord.token, CHILD_SET_STALE);
      const key = this._identityKey('directory', directoryRecord.canonical, directoryRecord.version);
      if (session.byIdentity.get(key) === directoryRecord.token) session.byIdentity.delete(key);
    }
    fail('WORKSPACE_HANDLE_STALE', 'workspace directory changed');
  }

  _boundedDirectoryEntries(directoryPath) {
    if (typeof this.fs.opendirSync !== 'function') {
      fail('WORKSPACE_DIRECTORY_UNAVAILABLE', 'workspace directory enumeration is unavailable');
    }
    let directory;
    const entries = [];
    try {
      // Keep directory names as raw bytes until the entry policy has decided
      // that a name is representable. Converting here loses byte identity and
      // can turn two distinct names into one path alias. The entry policy
      // handles decode/refusal; this prologue only bounds collection and
      // orders the raw names deterministically.
      directory = this.fs.opendirSync(directoryPath, { bufferSize: 1, encoding: 'buffer' });
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) {
          entries.sort((left, right) => Buffer.compare(left.name, right.name));
          return entries;
        }
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          fail('WORKSPACE_DIRECTORY_TOO_LARGE', 'workspace directory exceeds its entry bound');
        }
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof FraWorkspaceError) throw error;
      fail('WORKSPACE_DIRECTORY_UNAVAILABLE', 'workspace directory enumeration is unavailable');
    } finally {
      if (directory) {
        try { directory.closeSync(); } catch {}
      }
    }
  }

  list(args = {}, context = {}) {
    if (!plainObject(args)) fail('WORKSPACE_ARGUMENTS_INVALID', 'workspace list arguments are invalid');
    const session = this._session(context, true, args.cursor === undefined ? null : args.cursor);
    const limit = args.limit === undefined ? MAX_PAGE_ENTRIES : args.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ENTRIES) {
      fail('WORKSPACE_LIMIT_INVALID', 'workspace list limit is invalid');
    }

    let directoryRecord;
    if (args.directoryHandle === undefined) {
      if (args.expectedVersion !== undefined || args.cursor !== undefined) {
        fail('WORKSPACE_ROOT_ARGUMENTS_INVALID', 'root workspace listing cannot use a stale selector');
      }
      directoryRecord = this._rootRecord(session);
    } else {
      directoryRecord = this._record(
        session,
        args.directoryHandle,
        'directory',
        args.expectedVersion
      );
    }

    const opened = this._openIdentity(
      directoryRecord.absolute,
      'directory',
      { allowRoot: directoryRecord.relative === '' }
    );
    try {
      if (opened.version !== directoryRecord.version) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace directory changed');
      }
      const raw = this._boundedDirectoryEntries(opened.absolute);
      this._assertChildSetCurrent(session, directoryRecord, childSetDigest(raw));
      const snapshot = this._entrySet(directoryRecord, opened, session, raw);
      const after = this.fs.fstatSync(opened.fd, { bigint: true });
      if (identityVersion('directory', identityOf(after)) !== directoryRecord.version) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace directory changed while listing');
      }
      let offset = 0;
      let markerOffset = 0;
      if (args.cursor !== undefined) {
        if (!HANDLE_RE.test(args.cursor)) {
          fail('WORKSPACE_CURSOR_INVALID', 'workspace cursor is invalid');
        }
        const cursor = session.cursors.get(args.cursor);
        session.cursors.delete(args.cursor);
        if (!cursor || cursor.expiresAt <= this.now()
            || cursor.directoryHandle !== directoryRecord.token
            || cursor.directoryVersion !== directoryRecord.version
            || cursor.entrySetDigest !== snapshot.setDigest) {
          fail('WORKSPACE_CURSOR_STALE', 'workspace cursor is stale');
        }
        offset = cursor.offset;
        markerOffset = cursor.markerOffset || 0;
      }
      const page = snapshot.entries.slice(offset, offset + limit).map(entry => {
        const record = this._register(session, entry.pending.child, entry.pending.listedContent);
        const { pending, ...rest } = entry;
        return Object.freeze({ ...rest, handle: record.token, version: record.version });
      });
      const markers = Array.isArray(snapshot.markers) ? snapshot.markers : [];
      const markerPage = markers.slice(markerOffset, markerOffset + MAX_PAGE_MARKERS);
      const nextOffset = offset + page.length;
      const nextMarkerOffset = markerOffset + markerPage.length;
      let nextCursor = null;
      if (nextOffset < snapshot.entries.length || nextMarkerOffset < markers.length) {
        const now = this.now();
        this._cleanupCursors(session, now);
        if (session.cursors.size >= this.maxCursorsPerSession) {
          fail('WORKSPACE_CURSOR_CAPACITY', 'workspace cursor capacity is exhausted');
        }
        do { nextCursor = opaqueToken(this.randomBytes); }
        while (session.cursors.has(nextCursor));
        session.cursors.set(nextCursor, Object.freeze({
          directoryHandle: directoryRecord.token,
          directoryVersion: directoryRecord.version,
          entrySetDigest: snapshot.setDigest,
          offset: nextOffset,
          markerOffset: nextMarkerOffset,
          expiresAt: now + CURSOR_TTL_MS
        }));
      }
      this._recordAudit('workspace.list', auditTarget(directoryRecord.relative), {
        entries: page.length + markerPage.length,
        complete: nextCursor === null
      });
      return Object.freeze({
        directoryHandle: directoryRecord.token,
        version: directoryRecord.version,
        entries: Object.freeze([...page, ...markerPage]),
        nextCursor,
        complete: nextCursor === null
      });
    } finally {
      this._close(opened.fd);
    }
  }

  _authority(scope, authorityFactory = this.authorityFactory) {
    // The registry composes the shared byte authority. FRA must not import
    // another domain provider, and a missing adapter never permits raw reads.
    if (typeof authorityFactory !== 'function') {
      fail('WORKSPACE_COORDINATION_UNAVAILABLE', 'Workspace coordination adapter is unavailable.');
    }
    return authorityFactory(scope, this.canonicalRoot);
  }

  _materializeRead(record, resource) {
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(record.canonical) !== key(resource)) fail('WORKSPACE_ROOT_ESCAPE', 'Workspace resource identity changed.');
    const opened = this._openIdentity(record.absolute, 'file');
    let full;
    try {
      if (opened.version !== record.version || key(opened.canonical) !== key(record.canonical)) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace file changed');
      }
      const totalBytes = Number(opened.identity.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_FILE_BYTES) {
        fail('WORKSPACE_FILE_TOO_LARGE', 'workspace file exceeds its read bound');
      }
      full = Buffer.alloc(totalBytes);
      let read = 0;
      while (read < totalBytes) {
        const count = this.fs.readSync(opened.fd, full, read, totalBytes - read, read);
        if (count === 0) break;
        read += count;
      }
      const after = this.fs.fstatSync(opened.fd, { bigint: true });
      const named = this.fs.lstatSync(record.absolute, { bigint: true });
      if (read !== totalBytes || named.isSymbolicLink()
          || identityVersion('file', identityOf(after)) !== record.version
          || !sameIdentity(after, named)
          || key(this._realpath(record.absolute)) !== key(record.canonical)) {
        fail('WORKSPACE_FILE_CHANGED', 'workspace file changed while reading');
      }
      return { bytes: full, identity: `${after.dev}:${after.ino}` };
    } catch (error) {
      if (full) full.fill(0);
      if (error instanceof FraWorkspaceError) throw error;
      fail('WORKSPACE_FILE_CHANGED', 'workspace file changed while reading');
    } finally { this._close(opened.fd); }
  }

  read(args = {}, context = {}, authorityFactory = this.authorityFactory) {
    if (!plainObject(args)) fail('WORKSPACE_ARGUMENTS_INVALID', 'workspace read arguments are invalid');
    const session = this._session(context);
    const record = this._record(session, args.fileHandle, 'file', args.expectedVersion);
    const offset = args.offset === undefined ? 0 : args.offset;
    const length = args.length === undefined ? MAX_READ_BYTES : args.length;
    const encoding = args.encoding === undefined ? 'utf8' : args.encoding;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_BYTES
        || !Number.isSafeInteger(length) || length < 1 || length > MAX_READ_BYTES
        || !['utf8', 'base64'].includes(encoding)) {
      fail('WORKSPACE_READ_RANGE_INVALID', 'workspace read range is invalid');
    }

    const scope = context.fileToolContext;
    let binding;
    try {
      binding = fileContexts.requireFraFileToolContext(scope, context.fraWorkspaceContext);
      fileContexts.consumeFileToolInvocation(context.fileToolInvocation, scope, 'workspace.read');
    } catch (error) { throw readRefusal(error); }
    const totalBytes = Number(record.byteLength);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_FILE_BYTES) {
      fail('WORKSPACE_FILE_TOO_LARGE', 'workspace file exceeds its read bound');
    }
    const start = Math.min(offset, totalBytes);
    const end = Math.min(totalBytes, offset + length);
    const assertCurrent = () => {
      fileContexts.requireFraFileToolContext(scope, context.fraWorkspaceContext);
      fileContexts.assertFileToolInvocationCurrent(context.fileToolInvocation, scope, 'workspace.read');
      if (context.signal?.aborted) fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'Workspace read was interrupted.');
      if (this.sessions.get(session.binding.sessionContextDigest) !== session
          || session.handles.get(record.token) !== record) fail('WORKSPACE_HANDLE_UNKNOWN', 'workspace handle is no longer current');
    };
    let materialized;
    let content;
    let authority;
    try { authority = this._authority(scope, authorityFactory); }
    catch (error) { throw readRefusal(error); }
    return authority.observeRead({
      binding, resource: record.canonical, startByte: start, endByte: end,
      exactWorkspace: true,
      assertCurrent,
      materializeRead: resource => {
        assertCurrent();
        materialized = this._materializeRead(record, resource);
        if (materialized.bytes.length !== totalBytes) fail('WORKSPACE_HANDLE_STALE', 'workspace file changed');
        this._bindContent(session, record, materialized.bytes);
        return materialized;
      },
      validateRead: ({ bytes }) => {
        if (encoding === 'base64') content = bytes.toString('base64');
        else {
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { fail('WORKSPACE_FILE_NOT_UTF8', 'workspace file is not valid UTF-8'); }
        }
        this._recordAudit('workspace.read', auditTarget(record.relative), {
          offset, bytes: bytes.length, totalBytes,
          fileSha256: crypto.createHash('sha256').update(materialized.bytes).digest('hex')
        });
      }
    }).then(observed => {
      try {
        assertCurrent();
        return Object.freeze({
        fileHandle: record.token,
        version: record.version,
        offset,
        bytes: observed.bytes.length,
        totalBytes,
        fileSha256: observed.receipt.fileSha256,
        contentSha256: observed.receipt.contentSha256,
        encoding,
        content,
        eof: end >= totalBytes
        });
      } finally { observed.bytes.fill(0); }
    }).catch(error => { throw readRefusal(error); })
      .finally(() => { if (materialized) materialized.bytes.fill(0); });
  }

  closeSession(context) {
    const binding = normalizeContext(context, this.serviceRegistryOptions);
    return this.sessions.delete(binding.sessionContextDigest);
  }
}

// Lazy construction keeps importing the tool registry independent of workspace
// availability. The first actual workspace call still proves the root's identity;
// directory link counts are validated separately from regular-file hard links.
let defaultBrokerInstance = null;
function defaultBroker() {
  if (!defaultBrokerInstance) defaultBrokerInstance = new FraWorkspaceHandleBroker();
  return defaultBrokerInstance;
}

module.exports = Object.freeze({
  ROOT,
  HANDLE_RE,
  VERSION_RE,
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  MAX_DIRECTORY_ENTRIES,
  MAX_PAGE_ENTRIES,
  MAX_PAGE_MARKERS,
  MAX_HANDLES_PER_SESSION,
  MAX_CURSORS_PER_SESSION,
  MAX_SESSIONS,
  SAME_STAMP_WINDOW_MS,
  LISTING_CONTENT_BUDGET_BYTES,
  SESSION_TTL_MS,
  CURSOR_TTL_MS,
  WORKSPACE_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST,
  FraWorkspaceError,
  FraWorkspaceHandleBroker,
  identityOf,
  identityVersion,
  normalizeContext,
  list: (args, context) => defaultBroker().list(args, context),
  read: (args, context, authorityFactory) => defaultBroker().read(args, context, authorityFactory),
  closeSession: context => defaultBroker().closeSession(context)
});
