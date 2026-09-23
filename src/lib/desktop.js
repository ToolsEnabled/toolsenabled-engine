'use strict';

// Local desktop capability: toast notifications, clipboard read/write, and full
// virtual-screen capture. These are `local-*` effect tools, so they run through the
// registry's schema validation and audit but do not touch the outward kill switch.
// Arbitrary text is handed to PowerShell via a temp file (never a command line), and
// screenshots are constrained to the workspace `captures/` directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, rootPath, ensureDir } = require('./runtime');
const { scrubText } = require('./audit');
const { canonicalizeForContainment } = require('./canonical-path');

const HELPER = rootPath('tools', 'desktop.ps1');
const MAX_TEXT = 100000;
const MAX_ASK_MESSAGE = 16384;
const MAX_TTS_TEXT = 4000;
const MAX_OCR_BYTES = 20 * 1024 * 1024;
const MAX_OCR_TEXT = 50000;
const MAX_MCP_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_MCP_THUMBNAIL = 512;
const WINDOW_ID = /^[1-9][0-9]{0,18}$/;
const PROCESS_START_KEY = /^[0-9]{1,19}$/;
const MONITOR_ID = /^[A-Za-z0-9_.\\\\:-]{1,128}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function invoke(verb, arg1, { timeoutMs = 30000, runFn = run } = {}) {
  if (process.platform === 'linux' && verb === 'ask') {
    return require('./linux-desktop-ask').ask(arg1, { timeoutMs });
  }
  if (process.platform === 'linux' && verb === 'window-list') {
    return require('./linux-desktop').windowList();
  }
  if (process.platform === 'linux' && verb === 'monitor-list') {
    return require('./linux-desktop').monitorList();
  }
  if (process.platform === 'linux') {
    throw coded('DESKTOP_PLATFORM_UNSUPPORTED', 'This desktop operation does not yet have a native Linux backend.');
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, verb];
  if (arg1 !== undefined) args.push(arg1);
  const result = runFn('powershell.exe', args, { timeout: timeoutMs });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `desktop ${verb} failed`).trim().slice(0, 2000));
  }
  return result;
}

function withTempFile(prefix, content, fn) {
  // Payloads can contain clipboard, speech or dialog text. A predictable name
  // in the shared temp directory allowed pre-created aliases and ordinary
  // umask permissions. Own a fresh private directory and create exclusively.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-desktop-'));
  const file = path.join(directory, 'payload.tmp');
  let completed = false;
  let created = false;
  try {
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    const result = fn(file);
    completed = true;
    return result;
  } finally {
    try {
      if (created) fs.unlinkSync(file);
      fs.rmdirSync(directory);
    } catch (error) {
      // Preserve an action error already in flight. After success, returning a
      // definite positive would hide that the sensitive input may remain.
      if (completed) throw cleanupFailed('Desktop temporary file', error);
    }
  }
}

function requireInteger(value, label, { minimum, maximum }) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

// The module's coded-refusal helper, mirroring provider-safety.safeError():
// the sentence stays for the person, the code is what a model and the shared
// error taxonomy can branch on. The 2026-08-19 sweep measured this module's
// refusals reaching agents as prose with no machine code at all.
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanupFailed(subject, cause) {
  const error = coded('DESKTOP_CLEANUP_FAILED', `${subject} cleanup could not be established; the requested desktop action may have completed.`);
  error.actionOutcome = 'may_have_completed';
  error.cause = cause;
  return error;
}

function parseHelperJson(result, verb) {
  try {
    const value = JSON.parse(String(result.stdout || '').trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`desktop ${verb} returned invalid JSON.`);
  }
}

function notify(args = {}) {
  const title = String(args.title === undefined ? 'ToolsEnabled' : args.title).slice(0, 200);
  const message = String(args.message === undefined ? '' : args.message).slice(0, 2000);
  let durationSeconds = Number(args.durationSeconds);
  if (!Number.isFinite(durationSeconds)) durationSeconds = 5;
  durationSeconds = Math.min(Math.max(Math.trunc(durationSeconds), 1), 30);
  withTempFile('notify', JSON.stringify({ title, message, durationSeconds }), file => invoke('notify', file));
  return { shown: true, title, message, durationSeconds };
}

function clipboardRead() {
  const result = invoke('clipboard-get');
  const full = result.stdout || '';
  const text = full.slice(0, MAX_TEXT);
  return { text, length: text.length, truncated: full.length > MAX_TEXT };
}

function clipboardWrite(args = {}) {
  if (typeof args.text !== 'string') throw new Error('text must be a string.');
  if (args.text.length > MAX_TEXT) throw new Error(`text exceeds the ${MAX_TEXT}-character limit.`);
  withTempFile('clipboard', args.text, file => invoke('clipboard-set', file));
  return { written: true, length: args.text.length };
}

function resolveCapturePath(filename) {
  const dir = rootPath('captures');
  if (process.platform === 'linux') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  else ensureDir(dir);
  let base = typeof filename === 'string' ? path.basename(filename) : '';
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(base)) base = `screen-${Date.now()}.png`;
  if (!/\.png$/i.test(base)) base += '.png';
  let output = path.join(dir, base);
  // Capture output is deliberately create-only.  A previously-existing path can
  // be a symlink or hard link planted in captures/, and a capture must never
  // overwrite it.  Preserve a usable requested stem by selecting a random direct
  // sibling when it collides; the helper independently rejects any race-created
  // destination before it writes.
  if (fs.existsSync(output)) {
    const extension = path.extname(base);
    const stem = base.slice(0, -extension.length);
    output = path.join(dir, `${stem}-${crypto.randomBytes(12).toString('hex')}${extension}`);
    if (fs.existsSync(output)) throw new Error('could not reserve a new capture filename.');
  }
  return output;
}

function pngDimensions(file, retainedDescriptor = null) {
  const header = Buffer.alloc(24);
  const descriptor = retainedDescriptor === null ? fs.openSync(file, 'r') : retainedDescriptor;
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
      || !header.subarray(0, 8).equals(PNG_SIGNATURE)
      || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('desktop capture did not write a valid PNG.');
    }
  } finally {
    if (retainedDescriptor === null) fs.closeSync(descriptor);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('desktop capture PNG has invalid dimensions.');
  return { width, height };
}

function captureFileMetadata(output, expectedWidth, expectedHeight, identity = null) {
  if (identity) {
    const descriptor = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const dimensions = pngDimensions(output, descriptor);
      const named = fs.lstatSync(output, { bigint: true });
      if (String(opened.dev) !== identity.dev || String(opened.ino) !== identity.ino
          || opened.nlink !== 1n || opened.size !== BigInt(identity.bytes)
          || named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1n
          || dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
        throw coded('CAPTURE_OUTPUT_UNAVAILABLE', 'The original Linux capture output is no longer identified.');
      }
      return { path: output, ...dimensions, bytes: identity.bytes };
    } finally { fs.closeSync(descriptor); }
  }
  const captures = fs.realpathSync(rootPath('captures'));
  const lstat = fs.lstatSync(output);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.nlink !== 1) {
    throw new Error('desktop capture output is not a safe regular capture file.');
  }
  if (fs.realpathSync(path.dirname(output)) !== captures) {
    throw new Error('desktop capture output escaped the captures directory.');
  }
  const stat = fs.statSync(output);
  if (stat.size < 1) throw new Error('desktop capture did not write an image.');
  const dimensions = pngDimensions(output);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error('desktop capture dimensions did not match the PNG output.');
  }
  return { path: output, ...dimensions, bytes: stat.size };
}

function safeText(value, maximum = 1000) {
  return scrubText(String(value === undefined || value === null ? '' : value), maximum);
}

function captureLimitations(value) {
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string')) {
    throw new Error('desktop capture returned invalid limitations.');
  }
  const limitations = value.map(item => safeText(item, 300));
  if (limitations.some(item => !item)) throw new Error('desktop capture returned invalid limitations.');
  return limitations;
}

// Every refusal here is one condition -- "the path argument does not name an
// acceptable captures file" -- so every throw carries CAPTURE_PATH_INVALID.
// This is the Guided sweep's fence refusal that reached agents as an unnamed
// sentence on 2026-08-19.
//
// THE COMPARISON IS CANONICAL, NOT LEXICAL, for the same reason
// captureFileMetadata (above) already realpath()s before comparing, and for
// the same reason host-control.js's resolveHostPath re-checks containment
// against fs.realpathSync.native: a lexical path.relative/dirname compares
// TEXT, and two spellings of the identical directory produce different text.
// MEASURED 2026-09-03: rootPath('captures') resolves TOOLSENABLED_STATE_ROOT
// through account-profile-boundary.js, which canonicalizes an 8.3 short name
// to its long form; a caller's own path built from that same environment
// variable (or any other short-name-bearing temp path) is not. A file staged
// at the genuine, physical captures directory was refused
// "path must identify a file inside the ToolsEnabled captures directory" --
// an untrue fault, since the path named exactly that file -- because the
// 8.3 short-name spelling of the account profile and its full long-name
// spelling name the same captures directory and only one side of the
// comparison had been normalized. canonicalizeForContainment resolves both
// sides through the real
// filesystem before either check runs, which also closes the reparse-point
// bypass the comment below warns about: unlike captureFileMetadata's plain
// realpathSync (safe there only because the file was just written and so is
// known to exist), this target is caller-supplied and may not exist yet, so
// it uses the shared helper that walks up to the nearest real ancestor.
function resolveCaptureInput(file) {
  if (typeof file !== 'string' || !file) throw coded('CAPTURE_PATH_INVALID', 'path must be a non-empty capture path.');
  const captures = path.resolve(rootPath('captures'));
  const resolved = path.resolve(file);
  let canonicalCaptures;
  let canonicalResolved;
  try {
    canonicalCaptures = canonicalizeForContainment(captures);
    canonicalResolved = canonicalizeForContainment(resolved);
  } catch {
    throw coded('CAPTURE_PATH_INVALID', 'path must identify a file inside the ToolsEnabled captures directory.');
  }
  const relative = path.relative(canonicalCaptures, canonicalResolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw coded('CAPTURE_PATH_INVALID', 'path must identify a file inside the ToolsEnabled captures directory.');
  }
  if (!/\.(?:png|jpe?g|bmp|gif|tiff?)$/i.test(resolved)) throw coded('CAPTURE_PATH_INVALID', 'path must be an image file.');
  // Captures are created as direct children.  Do not follow a symlink/junction or
  // permit a nested path here: otherwise a caller could use the OCR helper as an
  // arbitrary local-image reader by planting a reparse point under captures/.
  if (path.dirname(canonicalResolved) !== canonicalCaptures) {
    throw coded('CAPTURE_PATH_INVALID', 'path must identify a direct capture file inside the ToolsEnabled captures directory.');
  }
  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.nlink !== 1 || lstat.size < 1 || lstat.size > MAX_OCR_BYTES) {
    throw coded('CAPTURE_PATH_INVALID', `path must identify a non-empty image no larger than ${MAX_OCR_BYTES} bytes.`);
  }
  return resolved;
}

function readStableCapture(file) {
  const input = resolveCaptureInput(file);
  const before = fs.lstatSync(input);
  const descriptor = fs.openSync(input, 'r');
  try {
    const opened = fs.fstatSync(descriptor);
    const after = fs.lstatSync(input);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        opened.nlink !== 1 || opened.size < 1 || opened.size > MAX_OCR_BYTES) {
      throw new Error('capture changed while it was being opened.');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error('capture could not be read completely.');
      offset += count;
    }
    return { input, bytes, stat: opened };
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusive(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Return a deliberately small PNG only through MCP's image content. The
// original capture remains confined on disk; generic tool results never embed
// screenshots, avoiding accidental multi-monitor context inflation.
function readCapture(args = {}) {
  const linux = process.platform === 'linux';
  const maxWidth = args.maxWidth === undefined ? DEFAULT_MCP_THUMBNAIL : requireInteger(args.maxWidth, 'maxWidth', { minimum: 32, maximum: 1024 });
  const maxHeight = args.maxHeight === undefined ? DEFAULT_MCP_THUMBNAIL : requireInteger(args.maxHeight, 'maxHeight', { minimum: 32, maximum: 1024 });
  const maximumBytes = args.maxBytes === undefined ? MAX_MCP_IMAGE_BYTES : requireInteger(args.maxBytes, 'maxBytes', { minimum: 32768, maximum: MAX_MCP_IMAGE_BYTES });
  const source = readStableCapture(args.path);
  const copy = resolveCapturePath(`mcp-source-${crypto.randomBytes(10).toString('hex')}.png`);
  const thumbnail = resolveCapturePath(`mcp-thumb-${crypto.randomBytes(10).toString('hex')}.png`);
  let completed = false;
  try {
    if (!linux) writeExclusive(copy, source.bytes);
    const response = linux
      ? require('./linux-capture').thumbnail({ output: thumbnail, source: source.bytes, maxWidth, maxHeight })
      : withTempFile('thumbnail', JSON.stringify({ source: copy, path: thumbnail, maxWidth, maxHeight }), file => invoke('thumbnail', file));
    const helper = parseHelperJson(response, 'thumbnail');
    const width = requireInteger(helper.width, 'thumbnail width', { minimum: 1, maximum: 1024 });
    const height = requireInteger(helper.height, 'thumbnail height', { minimum: 1, maximum: 1024 });
    if (helper.status !== 'captured' || width > maxWidth || height > maxHeight) throw new Error('desktop thumbnail returned invalid metadata.');
    const metadata = captureFileMetadata(thumbnail, width, height, response.captureIdentity);
    if (metadata.bytes > maximumBytes) throw new Error(`thumbnail exceeds the ${maximumBytes}-byte MCP image limit.`);
    const data = linux ? response.captureBytes : readStableCapture(thumbnail).bytes;
    const output = {
      path: thumbnail, width, height, bytes: metadata.bytes, mimeType: 'image/png',
      thumbnail: true, sourceBytes: source.stat.size, contentTrust: 'untrusted', grantsAuthority: false
    };
    Object.defineProperty(output, '__mcpImage', { value: data, enumerable: false, configurable: false, writable: false });
    completed = true;
    return output;
  } finally {
    try {
      if (!linux) fs.unlinkSync(copy);
    } catch (error) {
      if (completed) throw cleanupFailed('Desktop ephemeral capture source', error);
    }
    if (!completed && !linux) {
      try { fs.unlinkSync(thumbnail); } catch { /* best-effort failed-thumbnail cleanup */ }
    }
  }
}

function screenCapture(args = {}) {
  const output = resolveCapturePath(args.filename);
  const result = process.platform === 'linux' ? require('./linux-capture').screen(output) : invoke('screenshot', output);
  const helper = parseHelperJson(result, 'screenshot');
  const width = requireInteger(helper.width, 'desktop screenshot width', { minimum: 1, maximum: 131072 });
  const height = requireInteger(helper.height, 'desktop screenshot height', { minimum: 1, maximum: 131072 });
  const x = requireInteger(helper.x, 'desktop screenshot x', { minimum: -131072, maximum: 131072 });
  const y = requireInteger(helper.y, 'desktop screenshot y', { minimum: -131072, maximum: 131072 });
  const status = String(helper.status || '');
  if (!['captured', 'unavailable'].includes(status) || helper.method !== 'copy_from_screen') {
    throw new Error('desktop screenshot returned invalid capture metadata.');
  }
  if (status === 'unavailable') {
    return {
      status, captured: false, usable: false, method: helper.method,
      virtualBounds: { x, y, width, height }, limitations: captureLimitations(helper.limitations)
    };
  }
  return {
    ...captureFileMetadata(output, width, height, result.captureIdentity),
    method: helper.method,
    virtualBounds: { x, y, width, height }
  };
}

function screenCaptureRegion(args = {}) {
  const output = resolveCapturePath(args.filename);
  const region = {
    path: output,
    x: requireInteger(args.x, 'x', { minimum: -32768, maximum: 32767 }),
    y: requireInteger(args.y, 'y', { minimum: -32768, maximum: 32767 }),
    width: requireInteger(args.width, 'width', { minimum: 1, maximum: 32768 }),
    height: requireInteger(args.height, 'height', { minimum: 1, maximum: 32768 })
  };
  const result = process.platform === 'linux' ? require('./linux-capture').region(region)
    : withTempFile('capture-region', JSON.stringify(region), file => invoke('capture-region', file));
  const helper = parseHelperJson(result, 'capture-region');
  const status = String(helper.status || '');
  if (!['captured', 'unavailable'].includes(status) || helper.method !== 'copy_from_screen'
    || helper.width !== region.width || helper.height !== region.height) {
    throw new Error('desktop capture-region returned invalid capture metadata.');
  }
  if (status === 'unavailable') {
    return {
      status, captured: false, usable: false, method: helper.method,
      region: { x: region.x, y: region.y, width: region.width, height: region.height },
      limitations: captureLimitations(helper.limitations)
    };
  }
  return {
    ...captureFileMetadata(output, region.width, region.height, result.captureIdentity),
    method: helper.method,
    region: { x: region.x, y: region.y, width: region.width, height: region.height }
  };
}

function windowId(value) {
  if (typeof value !== 'string' || !WINDOW_ID.test(value)) throw new Error('windowId is invalid.');
  return value;
}

function expectedProcess(args) {
  const processId = requireInteger(args.expectedProcessId, 'expectedProcessId', { minimum: 1, maximum: 4294967295 });
  const processStartKey = String(args.expectedProcessStartKey === undefined ? '' : args.expectedProcessStartKey);
  if (!PROCESS_START_KEY.test(processStartKey)) throw new Error('expectedProcessStartKey is invalid.');
  return { processId, processStartKey };
}

function normaliseMonitorId(value, label = 'monitorId') {
  if (typeof value !== 'string' || !MONITOR_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function normaliseWindow(item, index, { requireCaptureIdentity = false } = {}) {
  const invalid = !item || typeof item !== 'object' || Array.isArray(item)
    || !WINDOW_ID.test(String(item.windowId || ''))
    || !Number.isSafeInteger(item.processId) || item.processId < 1 || item.processId > 4294967295
    || typeof item.title !== 'string' || typeof item.appLabel !== 'string' || typeof item.processName !== 'string'
    || !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)
    || !Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1
    || typeof item.isMinimized !== 'boolean' || typeof item.isOffscreen !== 'boolean'
    || typeof item.isPartial !== 'boolean' || typeof item.isCloaked !== 'boolean'
    || typeof item.captureEligible !== 'boolean';
  if (invalid) throw new Error(`desktop window-list returned invalid window ${index}.`);
  const processStartKey = item.processStartKey === null ? null : String(item.processStartKey || '');
  if (processStartKey !== null && !PROCESS_START_KEY.test(processStartKey)) {
    throw new Error(`desktop window-list returned invalid process identity for window ${index}.`);
  }
  if (requireCaptureIdentity && (!item.captureEligible || !processStartKey)) {
    throw new Error(`desktop capture-window returned an ineligible target ${index}.`);
  }
  const monitorId = item.monitorId === null ? null : normaliseMonitorId(item.monitorId, 'desktop monitorId');
  return {
    windowId: String(item.windowId),
    processId: item.processId,
    processStartKey,
    processName: safeText(item.processName, 300),
    appLabel: safeText(item.appLabel, 300),
    title: safeText(item.title, 1000),
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    monitorId,
    isMinimized: item.isMinimized,
    isOffscreen: item.isOffscreen,
    isPartial: item.isPartial,
    isCloaked: item.isCloaked,
    captureEligible: item.captureEligible
  };
}

function windowList() {
  const output = parseHelperJson(invoke('window-list'), 'window-list');
  if (!Array.isArray(output.windows) || output.windows.length > 500) throw new Error('desktop window-list returned invalid windows.');
  const windows = output.windows.map((item, index) => normaliseWindow(item, index));
  return { windows, count: windows.length, contentTrust: 'untrusted', grantsAuthority: false };
}

function windowFocus(args = {}) {
  const id = windowId(args.windowId);
  const output = parseHelperJson(invoke('window-focus', id), 'window-focus');
  if (typeof output.focused !== 'boolean' || String(output.windowId || '') !== id) throw new Error('desktop window-focus returned invalid output.');
  if (!output.focused) return {
    focused: false, windowId: id, code: 'WINDOW_FOREGROUND_REFUSED',
    reason: 'Windows did not bring the requested window to the foreground. Select it on the taskbar, then retry.'
  };
  return { focused: true, windowId: id };
}

function windowFocusFenced(args = {}, dependencies = {}) {
  const id = windowId(args.windowId);
  const target = expectedProcess(args);
  if (typeof args.expectedProcessName !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(args.expectedProcessName)) {
    throw new Error('expectedProcessName is invalid.');
  }
  if (typeof args.expectedTitle !== 'string' || args.expectedTitle.length < 1 || args.expectedTitle.length > 1000 || /[\x00-\x1F\x7F]/.test(args.expectedTitle)) {
    throw new Error('expectedTitle is invalid.');
  }
  const payload = {
    windowId: id,
    expectedProcessId: target.processId,
    expectedProcessStartKey: target.processStartKey,
    expectedProcessName: args.expectedProcessName,
    expectedTitle: args.expectedTitle
  };
  const temporary = dependencies.withTempFile || withTempFile;
  const invokeFocus = dependencies.invoke || invoke;
  const output = parseHelperJson(temporary('window-focus-fenced', JSON.stringify(payload), file =>
    invokeFocus('window-focus-fenced', file)), 'window-focus-fenced');
  const status = String(output.status || '');
  if (!['focused', 'target_changed', 'focus_failed'].includes(status)
      || String(output.windowId || '') !== id || output.focused !== (status === 'focused')) {
    throw new Error('desktop window-focus-fenced returned invalid output.');
  }
  return { focused: status === 'focused', targetChanged: status === 'target_changed', windowId: id };
}

function windowClose(args = {}, dependencies = {}) {
  const id = windowId(args.windowId);
  const target = expectedProcess(args);
  if (typeof args.expectedProcessName !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(args.expectedProcessName)) {
    throw new Error('expectedProcessName is invalid.');
  }
  if (typeof args.expectedTitle !== 'string' || args.expectedTitle.length < 1 || args.expectedTitle.length > 1000 || /[\x00-\x1F\x7F]/.test(args.expectedTitle)) {
    throw new Error('expectedTitle is invalid.');
  }
  const timeoutSeconds = args.timeoutSeconds === undefined
    ? 300 : requireInteger(args.timeoutSeconds, 'timeoutSeconds', { minimum: 30, maximum: 900 });
  const payload = {
    windowId: id,
    expectedProcessId: target.processId,
    expectedProcessStartKey: target.processStartKey,
    expectedProcessName: args.expectedProcessName,
    expectedTitle: args.expectedTitle,
    timeoutSeconds
  };
  const temporary = dependencies.withTempFile || withTempFile;
  const invokeClose = dependencies.invoke || invoke;
  const output = parseHelperJson(temporary('window-close', JSON.stringify(payload), file =>
    invokeClose('window-close', file)), 'window-close');
  const status = String(output.status || '');
  if (!['closed', 'manual_cancelled', 'manual_timeout', 'target_changed'].includes(status) ||
      String(output.windowId || '') !== id || output.requested !== false ||
      (status === 'closed' && output.ownerPerformed !== true)) {
    throw new Error('desktop window-close returned invalid metadata.');
  }
  return {
    status,
    requested: false,
    closed: status === 'closed',
    ownerPerformed: status === 'closed',
    windowId: id,
    processId: target.processId,
    processStartKey: target.processStartKey,
    processName: args.expectedProcessName,
    title: safeText(args.expectedTitle, 1000),
    forced: false
  };
}

function listMonitors() {
  const linux = process.platform === 'linux';
  const output = parseHelperJson(invoke('monitor-list'), 'monitor-list');
  if (!Array.isArray(output.monitors) || output.monitors.length < 1 || output.monitors.length > 32) {
    throw new Error('desktop monitor-list returned invalid monitors.');
  }
  const seen = new Set();
  const monitors = output.monitors.map((item, index) => {
    const invalid = !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.monitorId !== 'string' || !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)
      || !Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1
      || (!(linux && ['workX', 'workY', 'workWidth', 'workHeight'].every(key => item[key] === null))
        && (!Number.isSafeInteger(item.workX) || !Number.isSafeInteger(item.workY)
          || !Number.isSafeInteger(item.workWidth) || item.workWidth < 1 || !Number.isSafeInteger(item.workHeight) || item.workHeight < 1))
      || (!(linux && item.dpiX === null) && (!Number.isSafeInteger(item.dpiX) || item.dpiX < 1))
      || (!(linux && item.dpiY === null) && (!Number.isSafeInteger(item.dpiY) || item.dpiY < 1))
      || typeof item.primary !== 'boolean';
    if (invalid) throw new Error(`desktop monitor-list returned invalid monitor ${index}.`);
    const monitorId = normaliseMonitorId(item.monitorId);
    if (seen.has(monitorId)) throw new Error('desktop monitor-list returned duplicate monitor identifiers.');
    seen.add(monitorId);
    return {
      monitorId, x: item.x, y: item.y, width: item.width, height: item.height,
      workArea: linux && item.workX === null ? null : { x: item.workX, y: item.workY, width: item.workWidth, height: item.workHeight },
      dpiX: item.dpiX, dpiY: item.dpiY, primary: item.primary
    };
  });
  return { monitors, count: monitors.length,
    coordinateSpace: linux ? 'x11_root_pixels' : 'physical_pixels_per_monitor_dpi_aware',
    ...(linux ? { dpiSource: 'randr_reported_millimeters_not_ui_scale', workAreaSource: 'ewmh_current_desktop_intersection',
      contentTrust: 'untrusted', grantsAuthority: false } : {}) };
}

function screenCaptureMonitor(args = {}) {
  const output = resolveCapturePath(args.filename);
  const monitorId = normaliseMonitorId(args.monitorId);
  const result = process.platform === 'linux'
    ? require('./linux-capture').monitor({ output, monitorId })
    : withTempFile('capture-monitor', JSON.stringify({ path: output, monitorId }), file => invoke('capture-monitor', file));
  const helper = parseHelperJson(result, 'capture-monitor');
  const status = String(helper.status || '');
  if (String(helper.monitorId || '') !== monitorId || !['captured', 'unavailable', 'monitor_not_found'].includes(status)) {
    throw new Error('desktop capture-monitor returned invalid capture metadata.');
  }
  if (status === 'monitor_not_found') {
    return { status: 'monitor_not_found', captured: false, usable: false, monitorId, method: 'copy_from_screen' };
  }
  const width = requireInteger(helper.width, 'desktop monitor capture width', { minimum: 1, maximum: 131072 });
  const height = requireInteger(helper.height, 'desktop monitor capture height', { minimum: 1, maximum: 131072 });
  const x = requireInteger(helper.x, 'desktop monitor x', { minimum: -131072, maximum: 131072 });
  const y = requireInteger(helper.y, 'desktop monitor y', { minimum: -131072, maximum: 131072 });
  if (status === 'unavailable') {
    return {
      status, captured: false, usable: false, monitorId, method: 'copy_from_screen',
      monitorBounds: { x, y, width, height }, limitations: captureLimitations(helper.limitations)
    };
  }
  if (helper.method !== 'copy_from_screen') throw new Error('desktop capture-monitor returned invalid capture method.');
  return {
    ...captureFileMetadata(output, width, height, result.captureIdentity),
    status: 'captured', captured: true, usable: true, monitorId, method: helper.method,
    monitorBounds: {
      x, y, width, height
    }
  };
}

function screenCaptureWindow(args = {}) {
  const output = resolveCapturePath(args.filename);
  const target = expectedProcess(args);
  const payload = { path: output, windowId: windowId(args.windowId), expectedProcessId: target.processId, expectedProcessStartKey: target.processStartKey };
  const linux = process.platform === 'linux';
  const result = linux ? require('./linux-capture').windowCapture(payload)
    : withTempFile('capture-window', JSON.stringify(payload), file => invoke('capture-window', file));
  const helper = parseHelperJson(result, 'capture-window');
  const status = String(helper.status || '');
  if (!['captured', 'blank_or_uniform', 'unavailable', 'target_changed'].includes(status)
    || helper.method !== (linux ? 'xcomposite_named_pixmap' : 'printwindow_renderfullcontent')) {
    throw new Error('desktop capture-window returned invalid capture metadata.');
  }
  const limitations = captureLimitations(helper.limitations);
  let window = helper.window && typeof helper.window === 'object'
    ? normaliseWindow(helper.window, 'capture result', { requireCaptureIdentity: status === 'captured' || status === 'blank_or_uniform' })
    : null;
  if (window && (window.windowId !== payload.windowId || window.processId !== target.processId
    || window.processStartKey !== target.processStartKey)) {
    if (status === 'captured' || status === 'blank_or_uniform') {
      throw new Error('desktop capture-window returned a different target.');
    }
    // A target_changed result can legitimately include the current occupant of a
    // recycled HWND. Do not surface metadata for that different app to the caller.
    window = null;
  }
  if (status === 'captured' || status === 'blank_or_uniform') {
    const width = requireInteger(helper.width, 'desktop window capture width', { minimum: 1, maximum: 131072 });
    const height = requireInteger(helper.height, 'desktop window capture height', { minimum: 1, maximum: 131072 });
    if (!window || width !== window.width || height !== window.height) {
      throw new Error('desktop capture-window returned invalid target dimensions.');
    }
    return {
      ...captureFileMetadata(output, width, height, result.captureIdentity),
      status, captured: true, usable: status === 'captured', method: helper.method,
      windowId: payload.windowId, processId: target.processId, processStartKey: target.processStartKey,
      window, limitations, contentAssessment: status === 'blank_or_uniform' ? 'sampled_uniform' : 'not_uniform'
    };
  }
  return {
    status, captured: false, usable: false, method: helper.method,
    windowId: payload.windowId, processId: target.processId, processStartKey: target.processStartKey,
    window, limitations
  };
}

function ocrRead(args = {}, dependencies = {}) {
  const input = resolveCaptureInput(args.path);
  const invokeOcr = dependencies.invoke || invoke;
  let result;
  try {
    result = invokeOcr('ocr', input, { timeoutMs: 90000 });
  } catch (error) {
    // tools/desktop.ps1 throws this fixed sentence when the Windows profile
    // has no OCR language pack (OcrEngine.TryCreateFromUserProfileLanguages()
    // answers null). The helper is this module's own subprocess and the
    // sentence is a constant both sides ship, so translating it here is an
    // adapter mapping its own errno, not a controller regexing provider
    // prose. Installing a language pack is an owner action, which is exactly
    // what the code's MISSING condition tells the taxonomy.
    if (error && typeof error.message === 'string' && error.message.includes('no OCR language is installed')) {
      throw coded('OCR_LANGUAGE_PACK_MISSING', error.message);
    }
    throw error;
  }
  const output = parseHelperJson(result, 'ocr');
  if (typeof output.text !== 'string' || typeof output.language !== 'string') throw new Error('desktop ocr returned invalid text.');
  const text = scrubText(output.text, MAX_OCR_TEXT);
  return {
    path: input,
    text,
    language: output.language.slice(0, 100),
    lines: text ? text.split(/\r?\n/).filter(Boolean).slice(0, 2000).length : 0,
    truncated: output.text.length > text.length,
    contentTrust: 'untrusted',
    grantsAuthority: false
  };
}

function ttsSpeak(args = {}) {
  if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > MAX_TTS_TEXT) {
    throw new Error(`text must be a non-empty string of at most ${MAX_TTS_TEXT} characters.`);
  }
  const rate = args.rate === undefined ? 0 : requireInteger(args.rate, 'rate', { minimum: -10, maximum: 10 });
  const volume = args.volume === undefined ? 100 : requireInteger(args.volume, 'volume', { minimum: 0, maximum: 100 });
  const voice = args.voice === undefined ? '' : String(args.voice);
  if (voice.length > 200 || /[\x00\r\n]/.test(voice)) throw new Error('voice is invalid.');
  withTempFile('tts', JSON.stringify({ text: args.text, rate, volume, voice }), file => invoke('tts', file, { timeoutMs: 90000 }));
  return { spoken: true, characters: args.text.length, rate, volume, voice: voice || null };
}

function soundPlay(args = {}, dependencies = {}) {
  const sound = args.sound === undefined ? 'asterisk' : args.sound;
  if (!['asterisk', 'beep', 'exclamation', 'hand', 'question', 'generic-ramp'].includes(sound)) throw new Error('sound is invalid.');
  const temporary = dependencies.withTempFile || withTempFile;
  const invokeSound = dependencies.invoke || invoke;
  temporary('sound', JSON.stringify({ sound }), file => invokeSound('sound', file, { timeoutMs: 15000 }));
  return { played: true, sound, progressivelyLouder: sound === 'generic-ramp' };
}

function ask(args = {}, dependencies = {}) {
  const title = String(args.title === undefined ? 'ToolsEnabled confirmation' : args.title);
  const message = String(args.message === undefined ? '' : args.message);
  if (!message.trim() || title.length > 200 || message.length > MAX_ASK_MESSAGE || /\0/.test(title + message)) throw new Error('title or message is invalid.');
  const timeoutSeconds = args.timeoutSeconds === undefined ? 60 : requireInteger(args.timeoutSeconds, 'timeoutSeconds', { minimum: 5, maximum: 900 });
  const temporary = dependencies.withTempFile || withTempFile;
  const invokeAsk = dependencies.invoke || invoke;
  const result = temporary('ask', JSON.stringify({ title, message, timeoutSeconds }), file =>
    invokeAsk('ask', file, { timeoutMs: (timeoutSeconds + 15) * 1000 })
  );
  const answer = String(result.stdout || '').trim().toLowerCase();
  if (!['yes', 'no', 'timeout'].includes(answer)) throw new Error('desktop ask returned an invalid answer.');
  return { answer, approved: answer === 'yes', timedOut: answer === 'timeout', timeoutSeconds };
}

// Capture helpers wait synchronously for PowerShell. Keep that existing
// validation/cleanup implementation on one worker when the async registry
// dispatches it, so an agent screenshot cannot freeze the owner's window.
const ASYNC_OPERATIONS = new Set(['screenCapture', 'screenCaptureRegion', 'screenCaptureMonitor',
  'screenCaptureWindow', 'readCapture', 'listMonitors', 'windowList']);

/* A NON-ENUMERABLE PROPERTY DOES NOT SURVIVE postMessage, SO THE IMAGE HAS TO
 * CROSS AS AN ORDINARY FIELD AND BE PUT BACK ON THE OTHER SIDE.
 *
 * readCapture attaches its PNG with `enumerable: false` so that
 * mcp-server.js's `structured()` -- literally
 * `Object.fromEntries(Object.entries(value))` -- can never publish raw pixels
 * into structuredContent or ordinary JSON logging. That held while the call
 * ran on the main thread. Since 46189b9b every capture runs on a
 * worker_threads worker, and the structured-clone algorithm postMessage uses
 * carries only enumerable own properties: the attachment was silently gone by
 * the time toolResult() looked for it, so screen.read_capture succeeded,
 * returned correct metadata, and contained no picture, with no error anywhere.
 *
 * The bytes therefore cross as WORKER_IMAGE_FIELD, an ordinary base64 string,
 * and the receiving side converts it back to exactly the non-enumerable Buffer
 * the pre-46189b9b code produced and DELETES the named field. The protection
 * the original design bought is kept -- by an explicit strip instead of by a
 * visibility flag a clone does not respect -- and every consumer downstream of
 * this boundary is unchanged. */
const WORKER_IMAGE_FIELD = '__mcpImageBase64';

function encodeWorkerAttachment(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Buffer.isBuffer(result.__mcpImage)) {
    return result;
  }
  // Spreading copies enumerable own properties only, which is precisely why
  // __mcpImage has to be named explicitly here rather than carried along.
  return { ...result, [WORKER_IMAGE_FIELD]: result.__mcpImage.toString('base64') };
}

function decodeWorkerAttachment(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Object.hasOwn(result, WORKER_IMAGE_FIELD)) {
    return result;
  }
  const encoded = result[WORKER_IMAGE_FIELD];
  // Strip first, and unconditionally: on every path out of this function the
  // transport field must not remain on an object mcp-server.js will publish.
  delete result[WORKER_IMAGE_FIELD];
  const data = typeof encoded === 'string' && encoded.length > 0
    && encoded.length <= 4 * Math.ceil(MAX_MCP_IMAGE_BYTES / 3)
    ? Buffer.from(encoded, 'base64')
    : null;
  // A silent drop is the defect this whole seam exists to fix, so an
  // attachment that cannot be used is refused by name instead of quietly
  // producing a successful result with no picture in it.
  if (!data || data.length < 1 || data.length > MAX_MCP_IMAGE_BYTES) {
    throw coded('DESKTOP_WORKER_IMAGE_INVALID', 'The desktop worker returned an unusable image attachment.');
  }
  Object.defineProperty(result, '__mcpImage', {
    value: data, enumerable: false, configurable: false, writable: false
  });
  return result;
}

function createDesktopWorkerClient({ WorkerImpl = require('node:worker_threads').Worker, workerFile = __filename } = {}) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();
  const errorFrom = value => Object.assign(new Error(value?.message || 'Desktop worker failed.'), {
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(value?.actionOutcome ? { actionOutcome: value.actionOutcome } : {})
  });
  function ensureWorker() {
    if (worker) return worker;
    const active = new WorkerImpl(workerFile, { execArgv: [], workerData: { kind: 'toolsenabled-desktop-operations' } });
    worker = active;
    active.on('message', message => {
      if (worker !== active || !message || !Number.isSafeInteger(message.id)) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(errorFrom(message.error));
      else if (Object.hasOwn(message, 'result')) {
        // The receiving half of the image seam: puts the attachment back as
        // the non-enumerable Buffer every caller downstream expects.
        try {
          const hasImage = message.result && typeof message.result === 'object'
            && Object.hasOwn(message.result, WORKER_IMAGE_FIELD);
          if ((waiter.operation === 'readCapture') !== Boolean(hasImage)
              || Object.hasOwn(message, 'image')) {
            throw coded('DESKTOP_WORKER_INVALID_REPLY', 'Desktop worker returned no valid bounded image.');
          }
          waiter.resolve(decodeWorkerAttachment(message.result));
        }
        catch (error) { waiter.reject(error); }
      } else waiter.reject(coded('DESKTOP_WORKER_INVALID_REPLY', 'Desktop worker returned no result.'));
      if (!pending.size) active.unref();
    });
    const fail = error => {
      if (worker !== active) return;
      worker = null;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    active.on('error', error => fail(errorFrom(error)));
    active.on('exit', code => fail(coded('DESKTOP_WORKER_EXITED', `Desktop worker exited (${code}).`)));
    active.unref();
    return active;
  }
  function run(operation, args = {}) {
    if (!ASYNC_OPERATIONS.has(operation)) return Promise.reject(coded('DESKTOP_WORKER_OPERATION_INVALID', 'Unsupported desktop worker operation.'));
    if (pending.size >= 16) return Promise.reject(coded('DESKTOP_WORKER_BUSY', 'The desktop capture queue is full; retry after the current capture.'));
    return new Promise((resolve, reject) => {
      let active;
      try { active = ensureWorker(); } catch (error) { reject(error); return; }
      const id = ++nextId;
      pending.set(id, { resolve, reject, operation });
      active.ref();
      try { active.postMessage({ id, operation, args }); }
      catch (error) { pending.delete(id); if (!pending.size) active.unref(); reject(error); }
    });
  }
  async function close() {
    if (pending.size) throw coded('DESKTOP_WORKER_BUSY', 'Desktop operations must finish before closing their worker.');
    const active = worker;
    worker = null;
    if (active) await active.terminate();
  }
  return Object.freeze({ run, close });
}

let desktopWorkerClient = null;
function runDesktopAsync(operation, args = {}) {
  if (!desktopWorkerClient) desktopWorkerClient = createDesktopWorkerClient();
  return desktopWorkerClient.run(operation, args);
}

module.exports = {
  DEFAULT_MCP_THUMBNAIL, MAX_MCP_IMAGE_BYTES, MAX_OCR_BYTES, MAX_OCR_TEXT, MAX_TEXT, MAX_TTS_TEXT, MAX_ASK_MESSAGE,
  ask, clipboardRead, clipboardWrite, listMonitors, notify, ocrRead, screenCapture,
  readCapture, screenCaptureMonitor, screenCaptureRegion, screenCaptureWindow, soundPlay, ttsSpeak,
  windowClose, windowFocus, windowFocusFenced, windowList, runDesktopAsync, createDesktopWorkerClient
};

const { isMainThread, workerData, parentPort } = require('node:worker_threads');
if (!isMainThread && parentPort && workerData?.kind === 'toolsenabled-desktop-operations') {
  parentPort.on('message', message => {
    if (!message || !Number.isSafeInteger(message.id)) return;
    try {
      if (!ASYNC_OPERATIONS.has(message.operation)) throw coded('DESKTOP_WORKER_OPERATION_INVALID', 'Unsupported desktop worker operation.');
      const result = module.exports[message.operation](message.args);
      // The sending half of the image seam. Must happen here, inside the
      // worker: this is the last point at which the non-enumerable attachment
      // still exists.
      parentPort.postMessage({ id: message.id, result: encodeWorkerAttachment(result) });
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: { message: String(error?.message || error),
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(error?.actionOutcome ? { actionOutcome: error.actionOutcome } : {}) } });
    }
  });
}
