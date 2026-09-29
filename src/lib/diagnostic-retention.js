'use strict';

// Routine product diagnostics only. Never enrol an existing log or history.
// Every candidate must have this store's metadata inside its dedicated root.
const fsDefault = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SETTING_ID = 'diagnostics.retention';
const DEFAULT_CHOICE = '7 days / 64 MiB';
const CHOICES = Object.freeze([DEFAULT_CHOICE, '30 days / 256 MiB', 'Keep diagnostics', 'Archive diagnostics']);
const MIB = 1024 * 1024, DAY = 86400000;
const LIMITS = Object.freeze({ entriesPerPass: 64, candidates: 64, filesPerPass: 8,
  bytesPerPass: 8 * MIB, segmentBytes: MIB, writerBytes: 4 * MIB, lineBytes: 16384, metadataBytes: 4096 });
const KINDS = new Set(['main-lag', 'main-heap', 'exit-record', 'native-decisions', 'native-stream', 'startup-fatal']);
const ID = /^diag-[0-9]{1,16}-[a-f0-9-]{36}\.jsonl$/;

function resolveDiagnosticPolicy(value = DEFAULT_CHOICE) {
  if (!CHOICES.includes(value)) return Object.freeze({ choice: value, mode: 'blocked', cleanup: false,
    maxAgeDays: null, maxBytes: null, reason: 'The saved diagnostic retention choice is unreadable. Existing files are retained.' });
  const long = value === CHOICES[1];
  return Object.freeze({ choice: value, mode: value === CHOICES[2] ? 'keep' : value === CHOICES[3] ? 'archive' : 'finite',
    cleanup: value !== CHOICES[2], maxAgeDays: long ? 30 : 7, maxBytes: (long ? 256 : 64) * MIB });
}
function readDiagnosticPolicy({ loadSettings = require('./settings').loadSettings, ...options } = {}) {
  try {
    const result = loadSettings({ ...options, ids: [SETTING_ID] });
    if (result.rejected?.some(row => row.id === '*' || row.id === SETTING_ID)) return resolveDiagnosticPolicy(null);
    return resolveDiagnosticPolicy(result.values?.[SETTING_ID]);
  } catch { return resolveDiagnosticPolicy(null); }
}
function resolveDiagnosticDirectory(options) {
  return path.join(require('./durable-memory-file').resolveServicesRoot(options), 'diagnostics-v1');
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}
function limitedLine(value, maximum) {
  let line = String(value).replace(/\n?$/, '\n');
  if (Buffer.byteLength(line) <= maximum) return line;
  line = Buffer.from(line).subarray(0, maximum - 4).toString('utf8') + '\n';
  while (Buffer.byteLength(line) > maximum) line = line.slice(0, -2) + '\n';
  return line;
}

function createDiagnosticStore({ directory, fs = fsDefault, now = Date.now, pid = process.pid,
  uuid = randomUUID, isAlive = processAlive, readPolicy = readDiagnosticPolicy,
  limits = LIMITS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('A product diagnostic directory is required.');
  const root = path.resolve(directory), io = fs.promises;
  const bounds = { ...LIMITS, ...limits };
  if (Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 1)
    || bounds.lineBytes < 8 || bounds.segmentBytes < bounds.lineBytes || bounds.writerBytes < bounds.segmentBytes) throw new TypeError('Invalid diagnostic work bounds.');
  let policy = resolveDiagnosticPolicy(null), disposed = false, timer = null, cursor = null, scanning = false;
  let started = false, browseCursor = null, browsing = false, browseUnknownCount = 0, maintenanceFlight = null;
  const operations = new Set();
  let inspectFlight = null, disposalFlight = null, closureFailure = null, disposalConfirmed = false;
  let census = { entries: 0, bytes: 0, protectedBytes: 0, candidates: [], unknownCount: 0 };
  let last = { complete: false, scannedEntries: 0, removed: [], archived: [], policy };
  const active = new Set(), writers = new Set();
  function refreshPolicy() {
    try { const next = readPolicy(); policy = next && CHOICES.includes(next.choice) ? resolveDiagnosticPolicy(next.choice) : resolveDiagnosticPolicy(null); }
    catch { policy = resolveDiagnosticPolicy(null); }
    return policy;
  }
  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(root).isSymbolicLink() || path.resolve(fs.realpathSync(root)) !== root) throw new Error('Diagnostic storage cannot follow links.');
  }
  function filename(id) { if (!ID.test(id)) throw new Error('Unknown diagnostic identity.'); return path.join(root, id); }
  function saveMetadata(meta) {
    const destination = filename(meta.id) + '.meta.json';
    const temporary = destination + '.' + uuid() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  }
  function createWriter(kind) {
    if (!KINDS.has(kind) || disposed) throw new Error('This diagnostic producer is unavailable.');
    refreshPolicy();
    let meta = null, lastId = null, bytes = 0, totalBytes = 0, dropped = 0, closed = false, failure = null;
    function seal() {
      if (!meta) return;
      const held = meta; meta = null;
      held.closed = true;
      try {
        const saved = JSON.parse(fs.readFileSync(filename(held.id) + '.meta.json', 'utf8'));
        if (saved.id !== held.id || typeof saved.keep !== 'boolean' || typeof saved.archive !== 'boolean') throw new Error('Unreadable diagnostic choices.');
        saveMetadata({ ...saved, ...held, keep: saved.keep, archive: saved.archive });
      } catch { /* Never overwrite an unreadable keep choice. The unsealed file stays protected. */ }
      active.delete(held.id);
    }
    function open() {
      ensureRoot();
      const stamp = now(), id = 'diag-' + stamp + '-' + uuid() + '.jsonl';
      fs.writeFileSync(filename(id), '', { flag: 'wx', mode: 0o600 });
      meta = { version: 1, id, kind, createdAt: stamp, pid, closed: false,
        keep: policy.mode === 'keep', archive: policy.mode === 'archive' };
      saveMetadata(meta); active.add(id); lastId = id; bytes = 0;
    }
    const writer = {
      append(value) {
        if (disposed || closed) return { written: false, reason: 'closed' };
        const line = limitedLine(value, bounds.lineBytes), length = Buffer.byteLength(line);
        // Unknown policy cannot authorise growth without bounds or destruction.
        if (!['keep', 'archive'].includes(policy.mode) && totalBytes + length > bounds.writerBytes) {
          dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
          // Persist the named suppression once, so another process's Settings
          // reader can see it even when a legacy caller ignores append's return.
          if (dropped === 1 && meta) {
            try {
              const saved = JSON.parse(fs.readFileSync(filename(meta.id) + '.meta.json', 'utf8'));
              if (saved.id === meta.id && typeof saved.keep === 'boolean' && typeof saved.archive === 'boolean') {
                saveMetadata({ ...saved, outputSuppressed: 'diagnostic-output-budget' });
              }
            } catch { failure = 'diagnostic-suppression-record-failed'; }
          }
          return { written: false, reason: 'diagnostic-output-budget', dropped };
        }
        try {
          if (!meta || bytes + length > bounds.segmentBytes || now() - meta.createdAt >= DAY) { seal(); open(); }
          fs.appendFileSync(filename(meta.id), line, { encoding: 'utf8', mode: 0o600 });
          bytes += length; totalBytes += length;
          return { written: true };
        } catch (error) { failure = error.code || 'diagnostic-write-failed'; return { written: false, reason: failure }; }
      },
      rotate() { if (!closed && !disposed) { seal(); bytes = 0; } },
      close() { if (!closed) { seal(); closed = true; writers.delete(writer); } },
      state: () => ({ id: meta?.id || lastId, kind, pid, bytes, totalBytes, dropped, closed, failure }),
    };
    writers.add(writer); return writer;
  }
  async function inspectFile(id) {
    const file = filename(id), sidecar = file + '.meta.json';
    const [stat, metaStat] = await Promise.all([io.lstat(file), io.lstat(sidecar)]);
    if (!stat.isFile() || stat.isSymbolicLink() || !metaStat.isFile() || metaStat.isSymbolicLink()
      || metaStat.size > bounds.metadataBytes || stat.nlink > 1 || metaStat.nlink > 1) return null;
    const meta = JSON.parse(await io.readFile(sidecar, 'utf8'));
    if (meta.version !== 1 || meta.id !== id || !KINDS.has(meta.kind) || !Number.isSafeInteger(meta.createdAt)
      || !Number.isSafeInteger(meta.pid) || meta.pid <= 0 || typeof meta.closed !== 'boolean'
      || typeof meta.keep !== 'boolean' || typeof meta.archive !== 'boolean') return null;
    const isActive = active.has(id) || (!meta.closed && isAlive(meta.pid) !== false);
    return { id, file, sidecar, meta, bytes: stat.size + metaStat.size, dataBytes: stat.size,
      active: isActive, identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, metaStat.ino, metaStat.mtimeMs].join(':') };
  }
  async function readCandidate(entry) {
    // A managed-looking data file without readable metadata is also unknown.
    // Valid pairs are counted once, when their sidecar entry is visited.
    if (ID.test(entry.name)) {
      try { await io.lstat(filename(entry.name) + '.meta.json'); return {}; }
      catch { return { unknown: true }; }
    }
    if (!entry.name.endsWith('.jsonl.meta.json')) return {};
    const id = entry.name.slice(0, -10);
    if (!ID.test(id)) return {};
    try { const row = await inspectFile(id); return row ? { row } : { unknown: true }; }
    catch { return { unknown: true }; }
  }
  async function rootState() {
    try {
      const stat = await io.lstat(root);
      return !stat.isSymbolicLink() && stat.isDirectory() && path.resolve(await io.realpath(root)) === root ? 'ready' : 'unavailable';
    } catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unavailable'; }
  }
  async function rootSafe() { return await rootState() === 'ready'; }
  function locked(id, operation) {
    if (disposed) return Promise.resolve({ ok: false, reason: 'closed' });
    const flight = performLocked(id, operation);
    operations.add(flight);
    flight.then(() => operations.delete(flight), () => operations.delete(flight));
    return flight;
  }
  function unconfirmedClosure(error, resource) {
    if (!closureFailure) {
      closureFailure = Object.assign(new Error('Diagnostic resource closure is unconfirmed.'), {
        code: 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED', resource, causeCode: error?.code || 'close-failed',
      });
    }
    return closureFailure;
  }
  async function closeDirectory(directory, resource) {
    try { await directory.close(); }
    catch (error) { throw unconfirmedClosure(error, resource); }
  }
  async function performLocked(id, operation) {
    const lock = filename(id) + '.lock';
    let handle;
    try { handle = await io.open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return { ok: false, reason: 'diagnostic-busy' }; throw error; }
    try { return disposed ? { ok: false, reason: 'closed' } : await operation(); }
    finally {
      try { await handle.close(); await io.unlink(lock); }
      catch (error) { throw unconfirmedClosure(error, 'diagnostic-lock'); }
    }
  }
  async function moveToArchive(row) {
    const archive = path.join(root, 'archive');
    await io.mkdir(archive, { recursive: true });
    if ((await io.lstat(archive)).isSymbolicLink() || path.resolve(await io.realpath(archive)) !== archive) throw new Error('Archive cannot follow links.');
    // Data moves first. An interrupted move leaves unclassified files, never a
    // false candidate in the live directory, and never erases the only copy.
    const destination = path.join(archive, row.id);
    await io.mkdir(destination, { recursive: false });
    await io.rename(row.file, path.join(destination, row.id));
    await io.rename(row.sidecar, path.join(destination, row.id + '.meta.json'));
    return { ok: true, id: row.id, archivePath: path.join(destination, row.id) };
  }
  async function keep(id, value = true) {
    if (typeof value !== 'boolean' || !await rootSafe()) throw new Error('Diagnostic keep request is unavailable.');
    return locked(id, async () => {
      const row = await inspectFile(id); if (!row) throw new Error('Diagnostic metadata is unavailable.');
      if (disposed) return { ok: false, reason: 'closed' };
      saveMetadata({ ...row.meta, keep: value }); return { ok: true, id, keep: value };
    });
  }
  async function exportFile(id, destination) {
    if (!path.isAbsolute(destination || '') || !await rootSafe()) throw new Error('Choose an export file.');
    const target = path.resolve(destination);
    const relative = path.relative(root, target);
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Export outside managed diagnostic storage.');
    return locked(id, async () => {
      const row = await inspectFile(id); if (!row || row.active) return { ok: false, reason: 'diagnostic-active' };
      if (disposed) return { ok: false, reason: 'closed' };
      await io.copyFile(row.file, target, fs.constants.COPYFILE_EXCL);
      return { ok: true, id, destination: target, bytes: row.dataBytes };
    });
  }
  async function archiveFile(id) {
    if (!await rootSafe()) throw new Error('Diagnostic archive is unavailable.');
    return locked(id, async () => {
      const row = await inspectFile(id); if (!row || row.active) return { ok: false, reason: 'diagnostic-active' };
      if (disposed) return { ok: false, reason: 'closed' };
      return moveToArchive(row);
    });
  }
  function maintenance() {
    if (disposed || maintenanceFlight) return Promise.resolve(last);
    maintenanceFlight = runMaintenance().finally(() => { maintenanceFlight = null; });
    return maintenanceFlight;
  }
  async function runMaintenance() {
    if (disposed || scanning) return last;
    scanning = true;
    try {
      refreshPolicy();
      const rootStatus = await rootState();
      if (rootStatus !== 'ready') return last = { complete: rootStatus === 'absent', scanComplete: rootStatus === 'absent', scannedEntries: 0,
        unknownCount: 0, managedBytes: rootStatus === 'absent' ? 0 : null, protectedBytes: rootStatus === 'absent' ? 0 : null, budgetMet: null,
        reason: rootStatus === 'absent' ? 'no-managed-diagnostics' : 'diagnostic-root-unavailable', policy };
      if (!cursor) { cursor = await io.opendir(root); census = { entries: 0, bytes: 0, protectedBytes: 0, candidates: [], unknownCount: 0 }; }
      let complete = false, processed = 0;
      while (processed < bounds.entriesPerPass) {
        const entry = await cursor.read();
        if (!entry) { complete = true; await closeDirectory(cursor, 'maintenance-directory'); cursor = null; break; }
        processed++; census.entries++;
        const { row, unknown } = await readCandidate(entry);
        if (unknown) census.unknownCount++;
        if (!row) continue;
        census.bytes += row.bytes;
        if (row.active || row.meta.keep || row.meta.createdAt > now()) { census.protectedBytes += row.bytes; continue; }
        census.candidates.push(row);
        census.candidates.sort((a, b) => a.meta.createdAt - b.meta.createdAt || a.id.localeCompare(b.id));
        if (census.candidates.length > bounds.candidates) census.candidates.length = bounds.candidates;
      }
      const removed = [], archived = [], deferred = [];
      let projected = census.bytes, actedBytes = 0;
      if (complete && census.unknownCount === 0 && policy.cleanup) for (const original of census.candidates) {
        if (removed.length + archived.length >= bounds.filesPerPass) break;
        if (now() - original.meta.createdAt < policy.maxAgeDays * DAY && projected <= policy.maxBytes) continue;
        if (actedBytes + original.bytes > bounds.bytesPerPass) { deferred.push(original.id); continue; }
        if (disposed || !refreshPolicy().cleanup) break;
        const result = await locked(original.id, async () => {
          const row = await inspectFile(original.id);
          if (disposed || !refreshPolicy().cleanup) return { ok: false, reason: 'policy-changed' };
          if (!row || row.identity !== original.identity || row.active || row.meta.keep) return { ok: false, reason: 'changed-or-protected' };
          if (now() - row.meta.createdAt < policy.maxAgeDays * DAY && projected <= policy.maxBytes) return { ok: false, reason: 'policy-changed' };
          if (policy.mode === 'archive' || row.meta.archive) return { ...await moveToArchive(row), archived: true };
          await io.unlink(row.file);
          await io.unlink(row.sidecar);
          return { ok: true };
        });
        if (result.ok) { (result.archived ? archived : removed).push(original.id); projected -= original.bytes; actedBytes += original.bytes; }
        else deferred.push(original.id);
      }
      const inventoryComplete = complete && census.unknownCount === 0;
      return last = { complete: inventoryComplete, scanComplete: complete, scannedEntries: census.entries, entriesThisPass: processed,
        unknownCount: census.unknownCount, reason: census.unknownCount ? 'diagnostic-candidate-unreadable' : null,
        managedBytes: inventoryComplete ? census.bytes : null, projectedBytes: inventoryComplete ? projected : null,
        protectedBytes: inventoryComplete ? census.protectedBytes : null,
        knownManagedBytes: census.bytes, knownProtectedBytes: census.protectedBytes,
        candidateLimit: bounds.candidates, budgetMet: inventoryComplete && policy.maxBytes !== null ? projected <= policy.maxBytes : null,
        removed, archived, deferred, policy };
    } catch (error) { return last = { ...last, complete: false, scanComplete: false, managedBytes: null, protectedBytes: null,
      projectedBytes: null, budgetMet: null, reason: error.code || 'diagnostic-maintenance-failed', policy }; }
    finally {
      scanning = false;
      if (disposed && cursor) { await closeDirectory(cursor, 'maintenance-directory'); cursor = null; }
    }
  }
  // Inspection never calls maintenance. Each page inspects at most the same
  // bounded number of directory entries; a partial page is not a total.
  function inspect(options = {}) {
    if (disposed || inspectFlight) return Promise.resolve({ ok: false, reason: disposed ? 'closed' : 'diagnostic-busy', files: [] });
    // The admitted flight includes runInspect's finally, so disposal cannot
    // overtake a pending read or the directory close that follows it.
    inspectFlight = runInspect(options).finally(() => { inspectFlight = null; });
    return inspectFlight;
  }
  async function runInspect({ next = false } = {}) {
    refreshPolicy();
    browsing = true;
    try {
      const rootStatus = await rootState();
      if (disposed) return { ...status(), ok: false, complete: false, scanComplete: false, files: [], reason: 'closed' };
      if (rootStatus !== 'ready') return { ...status(), ok: rootStatus === 'absent', complete: rootStatus === 'absent',
        scanComplete: rootStatus === 'absent', unknownCount: 0, budgetMet: null, managedBytes: rootStatus === 'absent' ? 0 : null,
        entriesThisPage: 0, files: [], reason: rootStatus === 'absent' ? 'no-managed-diagnostics' : 'diagnostic-root-unavailable' };
      if (!next && browseCursor) { await closeDirectory(browseCursor, 'inspection-directory'); browseCursor = null; }
      if (!browseCursor) { browseCursor = await io.opendir(root); browseUnknownCount = 0; }
      const files = [];
      let complete = false, entriesThisPage = 0;
      while (!disposed && entriesThisPage < bounds.entriesPerPass) {
        const entry = await browseCursor.read();
        if (!entry) { await closeDirectory(browseCursor, 'inspection-directory'); browseCursor = null; complete = true; break; }
        entriesThisPage++;
        const { row, unknown } = await readCandidate(entry);
        if (unknown) browseUnknownCount++;
        if (row) files.push({ id: row.id, kind: row.meta.kind, pid: row.meta.pid, createdAt: row.meta.createdAt, bytes: row.dataBytes,
          active: row.active, keep: row.meta.keep, archive: row.meta.archive,
          outputSuppressed: row.meta.outputSuppressed === 'diagnostic-output-budget' ? row.meta.outputSuppressed : null });
      }
      return { ...status(), ok: !disposed && browseUnknownCount === 0,
        reason: disposed ? 'closed' : browseUnknownCount ? 'diagnostic-candidate-unreadable' : null,
        complete: complete && browseUnknownCount === 0 && !disposed, scanComplete: complete,
        unknownCount: browseUnknownCount, entriesThisPage, files: disposed ? [] : files,
        ...(browseUnknownCount ? { budgetMet: null, managedBytes: null, protectedBytes: null, projectedBytes: null } : {}) };
    } finally {
      browsing = false;
      if (disposed && browseCursor) { await closeDirectory(browseCursor, 'inspection-directory'); browseCursor = null; }
    }
  }
  function status() {
    return { ...last, policy, activeWriters: writers.size,
      disposal: { requested: disposed, confirmed: disposalConfirmed, reason: closureFailure?.code || null },
      writers: [...writers].map(writer => writer.state()), limits: { ...bounds }, directory: root };
  }
  async function tick() {
    timer = null;
    let result;
    try { result = await maintenance(); }
    catch { return; } // The stored closure refusal remains visible; do not restart this timer.
    if (!disposed) { timer = schedule(tick, result.complete || result.reason ? 60000 : 1000); timer?.unref?.(); }
  }
  function start() { if (!disposed && !started) { started = true; timer = schedule(tick, 60000); timer?.unref?.(); } }
  function dispose() {
    if (disposalFlight) return disposalFlight;
    disposed = true;
    let resolveDisposal, rejectDisposal;
    disposalFlight = new Promise((resolve, reject) => { resolveDisposal = resolve; rejectDisposal = reject; });
    // Begin synchronously: process exit still seals append-only writers before
    // returning. Retain the promise first so concurrent disposal shares it.
    finishDisposal().then(resolveDisposal, rejectDisposal);
    return disposalFlight;
  }
  async function finishDisposal() {
    try { if (timer) cancel(timer); }
    catch (error) { unconfirmedClosure(error, 'maintenance-timer'); }
    timer = null;
    for (const writer of [...writers]) {
      try { writer.close(); } catch (error) { unconfirmedClosure(error, 'diagnostic-writer'); }
    }
    // Drain every admitted operation even if another one rejects. Rejections
    // and remembered close failures must never turn into successful closure.
    const outcomes = await Promise.allSettled([maintenanceFlight, inspectFlight, ...operations].filter(Boolean));
    for (const outcome of outcomes) if (outcome.status === 'rejected') unconfirmedClosure(outcome.reason, 'admitted-operation');
    if (cursor && !scanning) {
      try { await closeDirectory(cursor, 'maintenance-directory'); cursor = null; }
      catch (error) { unconfirmedClosure(error, 'maintenance-directory'); }
    }
    if (browseCursor && !browsing) {
      try { await closeDirectory(browseCursor, 'inspection-directory'); browseCursor = null; }
      catch (error) { unconfirmedClosure(error, 'inspection-directory'); }
    }
    if (closureFailure) throw closureFailure;
    disposalConfirmed = true;
    return { ok: true, closed: true };
  }
  refreshPolicy();
  return { createWriter, maintenance, start, dispose, keep, exportFile, archiveFile, inspect, status, directory: root };
}
module.exports = { SETTING_ID, DEFAULT_CHOICE, CHOICES, LIMITS, resolveDiagnosticPolicy, readDiagnosticPolicy, resolveDiagnosticDirectory, createDiagnosticStore };
