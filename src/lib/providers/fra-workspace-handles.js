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
  isCredentialOrHistoryPath
} = require('../fra-workspace-policy');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERSION_RE = /^[a-f0-9]{64}$/;
const CONTEXT_RE = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 16;
const SESSION_TTL_MS = 20 * 60 * 1000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const IDENTITY_DOMAIN = 'ToolsEnabled/FRA/workspace-handle/v1';
const DIRECTORY_DOMAIN = 'ToolsEnabled/FRA/workspace-directory/v1';
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
    maxSessions = MAX_SESSIONS,
    serviceRegistryOptions = {},
    authorityFactory = null
  } = {}) {
    this.fs = fsApi;
    this.randomBytes = randomBytes;
    this.audit = auditApi;
    this.now = now;
    this.maxHandlesPerSession = maxHandlesPerSession;
    this.maxSessions = maxSessions;
    this.serviceRegistryOptions = serviceRegistryOptions;
    if (authorityFactory !== null && typeof authorityFactory !== 'function') fail('WORKSPACE_COORDINATION_UNAVAILABLE', 'Workspace coordination adapter is invalid.');
    this.authorityFactory = authorityFactory;
    this.root = path.resolve(root);
    this.canonicalRoot = this._realpath(this.root);
    if (!inside(this.root, this.canonicalRoot) && !inside(this.canonicalRoot, this.root)) {
      fail('WORKSPACE_ROOT_INVALID', 'workspace protected root is invalid');
    }
    const opened = this._openIdentity(this.root, 'directory', { allowRoot: true });
    this.rootVersion = opened.version;
    this._close(opened.fd);
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
    if (EXCLUDED_DIR_NAMES.has(segments[0].toLowerCase())
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
      descriptor = this.fs.openSync(absolute, 'r');
      const opened = this.fs.fstatSync(descriptor, { bigint: true });
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

  _cleanup() {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [key, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(key);
    }
  }

  _session(context, create = true) {
    try { fileContexts.requireFraFileToolContext(context.fileToolContext, context.fraWorkspaceContext); }
    catch (error) { throw readRefusal(error); }
    const binding = normalizeContext(context, this.serviceRegistryOptions);
    this._cleanup();
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
        touchedAt: this.now(),
        rootHandle: null
      };
      this.sessions.set(binding.sessionContextDigest, session);
    }
    if (!session) fail('WORKSPACE_SESSION_UNKNOWN', 'workspace session is unavailable');
    if (session.fileToolContext !== context.fileToolContext) fail('WORKSPACE_FRA_CONTEXT_REQUIRED', 'Workspace handles belong to a different accepted connection.');
    session.touchedAt = this.now();
    return session;
  }

  _register(session, opened) {
    const key = `${opened.kind}\0${opened.canonical.toLowerCase()}\0${opened.version}`;
    const existingToken = session.byIdentity.get(key);
    if (existingToken) {
      const existing = session.handles.get(existingToken);
      if (existing) return existing;
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
    return record;
  }

  _rootRecord(session) {
    if (session.rootHandle) {
      const existing = session.handles.get(session.rootHandle);
      if (existing) return existing;
    }
    const opened = this._openIdentity(this.root, 'directory', { allowRoot: true });
    try {
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

  _entrySet(directoryRecord, openedDirectory, session) {
    const raw = this.fs.readdirSync(openedDirectory.absolute, { withFileTypes: true });
    if (raw.length > MAX_DIRECTORY_ENTRIES) {
      fail('WORKSPACE_DIRECTORY_TOO_LARGE', 'workspace directory exceeds its entry bound');
    }
    raw.sort((left, right) => compareText(left.name, right.name));
    const entries = [];
    for (const entry of raw) {
      if (!entry || typeof entry.name !== 'string' || !entry.name
          || entry.name !== entry.name.normalize('NFC')
          || /[\\/\0]/.test(entry.name)) {
        fail('WORKSPACE_ENTRY_INVALID', 'workspace directory contains an invalid entry');
      }
      const candidate = path.join(openedDirectory.absolute, entry.name);
      let child;
      try {
        const childKind = entry.isDirectory() ? 'directory'
          : entry.isFile() ? 'file' : null;
        if (!childKind) continue;
        child = this._openIdentity(candidate, childKind);
        const record = this._register(session, child);
        entries.push(Object.freeze({
          name: entry.name,
          kind: childKind,
          handle: record.token,
          version: record.version,
          ...(childKind === 'file' ? { bytes: Number(child.identity.size) } : {})
        }));
      } catch (error) {
        if (error instanceof FraWorkspaceError
            && ['WORKSPACE_ENTRY_FORBIDDEN', 'WORKSPACE_REPARSE_REFUSED'].includes(error.code)) {
          continue;
        }
        throw error;
      } finally {
        if (child) this._close(child.fd);
      }
    }
    const setDigest = crypto.createHash('sha256')
      .update(DIRECTORY_DOMAIN, 'utf8').update('\0', 'utf8')
      .update(directoryRecord.version, 'utf8').update('\0', 'utf8')
      .update(entries.map(entry => [
        entry.name,
        entry.kind,
        entry.version
      ].join('\0')).join('\n'), 'utf8')
      .digest('hex');
    return { entries, setDigest };
  }

  list(args = {}, context = {}) {
    if (!plainObject(args)) fail('WORKSPACE_ARGUMENTS_INVALID', 'workspace list arguments are invalid');
    const session = this._session(context);
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
      const snapshot = this._entrySet(directoryRecord, opened, session);
      const after = this.fs.fstatSync(opened.fd, { bigint: true });
      if (identityVersion('directory', identityOf(after)) !== directoryRecord.version) {
        fail('WORKSPACE_HANDLE_STALE', 'workspace directory changed while listing');
      }
      let offset = 0;
      if (args.cursor !== undefined) {
        if (!HANDLE_RE.test(args.cursor)) {
          fail('WORKSPACE_CURSOR_INVALID', 'workspace cursor is invalid');
        }
        const cursor = session.cursors.get(args.cursor);
        session.cursors.delete(args.cursor);
        if (!cursor || cursor.expiresAt < this.now()
            || cursor.directoryHandle !== directoryRecord.token
            || cursor.directoryVersion !== directoryRecord.version
            || cursor.entrySetDigest !== snapshot.setDigest) {
          fail('WORKSPACE_CURSOR_STALE', 'workspace cursor is stale');
        }
        offset = cursor.offset;
      }
      const page = snapshot.entries.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      let nextCursor = null;
      if (nextOffset < snapshot.entries.length) {
        do { nextCursor = opaqueToken(this.randomBytes); }
        while (session.cursors.has(nextCursor));
        session.cursors.set(nextCursor, Object.freeze({
          directoryHandle: directoryRecord.token,
          directoryVersion: directoryRecord.version,
          entrySetDigest: snapshot.setDigest,
          offset: nextOffset,
          expiresAt: this.now() + CURSOR_TTL_MS
        }));
      }
      this._recordAudit('workspace.list', auditTarget(directoryRecord.relative), {
        entries: page.length,
        complete: nextCursor === null
      });
      return Object.freeze({
        directoryHandle: directoryRecord.token,
        version: directoryRecord.version,
        entries: Object.freeze(page),
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
      assertCurrent,
      materializeRead: resource => {
        assertCurrent();
        materialized = this._materializeRead(record, resource);
        if (materialized.bytes.length !== totalBytes) fail('WORKSPACE_HANDLE_STALE', 'workspace file changed');
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
  MAX_HANDLES_PER_SESSION,
  MAX_SESSIONS,
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
