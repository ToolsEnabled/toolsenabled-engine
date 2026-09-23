'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { rootPath } = require('./runtime');
const MAX_BYTES = 20 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CODES = new Set(['DESKTOP_PLATFORM_UNSUPPORTED', 'DESKTOP_SESSION_UNAVAILABLE',
  'DESKTOP_NATIVE_UNAVAILABLE', 'DESKTOP_SNAPSHOT_UNAVAILABLE', 'DESKTOP_SNAPSHOT_CHANGED',
  'DESKTOP_CAPTURE_UNAVAILABLE', 'DESKTOP_CAPTURE_REGION_INVALID', 'DESKTOP_CAPTURE_LIMIT',
  'DESKTOP_PIXEL_FORMAT_UNSUPPORTED', 'DESKTOP_IMAGE_INVALID', 'DESKTOP_MONITOR_UNSUPPORTED', 'DESKTOP_MONITOR_NOT_FOUND',
  'DESKTOP_WINDOW_TARGET_CHANGED', 'DESKTOP_WINDOW_CAPTURE_UNAVAILABLE']);
const fail = code => Object.assign(new Error('The Linux capture could not be completed safely.'), { code });

function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid; }
function destination(output, action) {
  const captures = path.resolve(rootPath('captures'));
  if (typeof output !== 'string' || path.dirname(output) !== captures
      || !/^[A-Za-z0-9._-]{1,180}\.png$/i.test(path.basename(output))) throw fail('CAPTURE_PATH_INVALID');
  const descriptors = [];
  let file = null, created = false;
  try {
    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    let fd = fs.openSync('/', directoryFlags);
    descriptors.push(fd);
    let current = '';
    for (const component of captures.split('/').filter(Boolean)) {
      fd = fs.openSync(`/proc/self/fd/${fd}/${component}`, directoryFlags);
      descriptors.push(fd);
      current += `/${component}`;
      const stat = fs.fstatSync(fd, { bigint: true });
      const mode = Number(stat.mode & 0o7777n);
      const stickyRoot = stat.uid === 0n && Boolean(mode & 0o1000);
      if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== BigInt(process.getuid()))
          || ((mode & 0o022) && !stickyRoot)) throw fail('CAPTURE_PATH_INVALID');
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== current) throw fail('CAPTURE_PATH_INVALID');
    }
    const parent = fs.fstatSync(fd, { bigint: true });
    if (parent.uid !== BigInt(process.getuid()) || Number(parent.mode & 0o077n) !== 0) throw fail('CAPTURE_PATH_INVALID');
    const named = `/proc/self/fd/${fd}/${path.basename(output)}`;
    try { fs.lstatSync(named); throw fail('CAPTURE_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The child gets no filesystem destination. Capture/decode must finish
    // before this parent creates any output, through the retained directory.
    const value = action();
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== captures
        || !same(parent, fs.lstatSync(captures, { bigint: true }))) throw fail('CAPTURE_PATH_INVALID');
    file = fs.openSync(named, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    const opened = fs.fstatSync(file, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || Number(opened.mode & 0o777n) !== 0o600) throw fail('CAPTURE_OUTPUT_UNAVAILABLE');
    fs.writeFileSync(file, value.png);
    fs.fsyncSync(file);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(file, { bigint: true });
    if (!same(opened, after) || after.nlink !== 1n || after.size !== BigInt(value.png.length)
        || !same(after, fs.lstatSync(named, { bigint: true }))
        || fs.readlinkSync(`/proc/self/fd/${fd}`) !== captures) throw fail('CAPTURE_OUTPUT_UNAVAILABLE');
    const result = { status: 0, stdout: JSON.stringify(value.metadata), stderr: '',
      captureIdentity: { dev: String(after.dev), ino: String(after.ino), bytes: value.png.length } };
    Object.defineProperty(result, 'captureBytes', { value: value.png, enumerable: false });
    return result;
  } catch (error) {
    const result = fail(CODES.has(error.code) || ['CAPTURE_PATH_INVALID', 'CAPTURE_OUTPUT_EXISTS'].includes(error.code)
      ? error.code : 'CAPTURE_OUTPUT_UNAVAILABLE');
    // Never unlink by a stale pathname on failure. A partially written private
    // output is retained; no completion is reported and replacements stay intact.
    if (created) result.actionOutcome = 'may_have_completed';
    throw result;
  } finally {
    if (file !== null) fs.closeSync(file);
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
}

function native(request, source, { environment = process.env, spawnSyncImpl = spawnSync } = {}) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.homedir() };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY']) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  let result;
  try {
    result = spawnSyncImpl('/usr/bin/python3', ['-I', '-S', '-B', path.join(__dirname, 'linux-capture.py')], {
      env, input: Buffer.concat([Buffer.from(JSON.stringify(request) + '\n'), source || Buffer.alloc(0)]),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false, timeout: 10000, maxBuffer: MAX_BYTES + 65536,
    });
  } catch { throw fail('DESKTOP_CAPTURE_UNAVAILABLE'); }
  if (result.error || result.signal) throw fail(result.error?.code === 'ENOENT' ? 'DESKTOP_NATIVE_UNAVAILABLE' : 'DESKTOP_CAPTURE_UNAVAILABLE');
  let metadata;
  try { metadata = JSON.parse(result.stdout.toString('utf8')); } catch { throw fail('DESKTOP_CAPTURE_UNAVAILABLE'); }
  if (metadata?.ok === false && Object.keys(metadata).sort().join(',') === 'code,ok' && CODES.has(metadata.code)) throw fail(metadata.code);
  const png = result.output?.[3];
  const fields = request.operation === 'thumbnail' ? 'bytes,height,ok,status,width'
    : request.operation === 'window' ? 'bytes,height,limitations,method,ok,status,width,window'
    : request.operation === 'monitor' ? 'bytes,height,method,monitorId,ok,status,width,x,y' : 'bytes,height,method,ok,status,width,x,y';
  if (result.status !== 0 || !metadata || Object.keys(metadata).sort().join(',') !== fields || metadata.ok !== true
      || !(metadata.status === 'captured' || (request.operation === 'window' && metadata.status === 'blank_or_uniform'))
      || !Buffer.isBuffer(png) || png.length < 24 || png.length > MAX_BYTES
      || metadata.bytes !== png.length || !png.subarray(0, 8).equals(PNG) || png.toString('ascii', 12, 16) !== 'IHDR'
      || !Number.isSafeInteger(metadata.width) || metadata.width < 1 || !Number.isSafeInteger(metadata.height) || metadata.height < 1
      || metadata.width * metadata.height > 16777216 || png.readUInt32BE(16) !== metadata.width
      || png.readUInt32BE(20) !== metadata.height) throw fail('DESKTOP_CAPTURE_UNAVAILABLE');
  if (request.operation === 'window') {
    const window = metadata.window;
    if (metadata.method !== 'xcomposite_named_pixmap' || !window
        || window.windowId !== request.windowId || window.processId !== request.expectedProcessId
        || window.processStartKey !== request.expectedProcessStartKey || window.captureEligible !== true
        || window.width !== metadata.width || window.height !== metadata.height
        || JSON.stringify(metadata.limitations) !== '["client_area_only","existing_compositor_storage"]') {
      throw fail('DESKTOP_CAPTURE_UNAVAILABLE');
    }
  } else if (request.operation === 'thumbnail') {
    if (metadata.width > request.maxWidth || metadata.height > request.maxHeight) throw fail('DESKTOP_CAPTURE_UNAVAILABLE');
  } else if (metadata.method !== 'copy_from_screen' || !Number.isSafeInteger(metadata.x) || !Number.isSafeInteger(metadata.y)
      || metadata.x < 0 || metadata.y < 0
      || (request.operation === 'monitor' && metadata.monitorId !== request.monitorId)
      || (request.operation === 'screen' && (metadata.x !== 0 || metadata.y !== 0))
      || (request.operation === 'region' && ['x', 'y', 'width', 'height'].some(key => metadata[key] !== request[key]))) {
    throw fail('DESKTOP_CAPTURE_UNAVAILABLE');
  }
  return { metadata, png };
}

function screen(output, dependencies) { return destination(output, () => native({ operation: 'screen' }, null, dependencies)); }
function region({ path: output, x, y, width, height }, dependencies) {
  if (![x, y, width, height].every(Number.isSafeInteger)) throw fail('DESKTOP_CAPTURE_REGION_INVALID');
  return destination(output, () => native({ operation: 'region', x, y, width, height }, null, dependencies));
}
function thumbnail({ output, source, maxWidth, maxHeight }, dependencies) {
  if (!Buffer.isBuffer(source) || source.length < 1 || source.length > MAX_BYTES
      || ![maxWidth, maxHeight].every(n => Number.isSafeInteger(n) && n >= 32 && n <= 1024)) throw fail('DESKTOP_IMAGE_INVALID');
  return destination(output, () => native({ operation: 'thumbnail', sourceBytes: source.length, maxWidth, maxHeight }, source, dependencies));
}
function monitor({ output, monitorId }, dependencies) {
  if (typeof monitorId !== 'string' || !/^x11-[1-9][0-9]{0,19}-[1-9][0-9]{0,19}$/.test(monitorId)) throw fail('DESKTOP_MONITOR_NOT_FOUND');
  try { return destination(output, () => native({ operation: 'monitor', monitorId }, null, dependencies)); }
  catch (error) {
    if (error.code !== 'DESKTOP_MONITOR_NOT_FOUND') throw error;
    return { status: 0, stdout: JSON.stringify({ status: 'monitor_not_found', monitorId, method: 'copy_from_screen' }), stderr: '' };
  }
}
function windowCapture({ path: output, windowId, expectedProcessId, expectedProcessStartKey }, dependencies) {
  if (!/^[1-9][0-9]{0,18}$/.test(windowId) || !Number.isSafeInteger(expectedProcessId) || expectedProcessId < 1
      || !/^[0-9]{1,19}$/.test(expectedProcessStartKey)) throw fail('DESKTOP_WINDOW_TARGET_CHANGED');
  try {
    return destination(output, () => native({ operation: 'window', windowId, expectedProcessId, expectedProcessStartKey }, null, dependencies));
  } catch (error) {
    const status = { DESKTOP_WINDOW_TARGET_CHANGED: 'target_changed', DESKTOP_WINDOW_CAPTURE_UNAVAILABLE: 'unavailable' }[error.code];
    if (!status) throw error;
    return { status: 0, stdout: JSON.stringify({ status, method: 'xcomposite_named_pixmap',
      window: null, limitations: ['client_area_only', 'existing_compositor_storage'] }), stderr: '' };
  }
}
module.exports = Object.freeze({ screen, region, thumbnail, monitor, windowCapture });
