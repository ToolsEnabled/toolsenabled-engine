'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const CODES = new Set(['DESKTOP_PLATFORM_UNSUPPORTED', 'DESKTOP_SESSION_UNAVAILABLE',
  'DESKTOP_NATIVE_UNAVAILABLE', 'DESKTOP_WINDOW_MANAGER_UNSUPPORTED',
  'DESKTOP_SNAPSHOT_UNAVAILABLE', 'DESKTOP_SNAPSHOT_CHANGED', 'DESKTOP_WINDOW_LIMIT',
  'DESKTOP_PROCESS_IDENTITY_UNAVAILABLE', 'DESKTOP_MONITOR_UNSUPPORTED']);
function failure(code) {
  return Object.assign(new Error('The Linux desktop window snapshot could not be established safely.'), { code });
}

function query(operation, { environment = process.env, spawnSyncImpl = spawnSync } = {}) {
  // Never inherit loader hooks or Python configuration into the fixed helper.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.homedir() };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY']) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  let result;
  try {
    result = spawnSyncImpl('/usr/bin/python3', ['-I', '-S', '-B',
      path.join(__dirname, 'linux-desktop.py'), operation], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch { throw failure('DESKTOP_SNAPSHOT_UNAVAILABLE'); }
  if (result.error || result.signal) {
    throw failure(result.error?.code === 'ENOENT' ? 'DESKTOP_NATIVE_UNAVAILABLE' : 'DESKTOP_SNAPSHOT_UNAVAILABLE');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw failure('DESKTOP_NATIVE_PROTOCOL_INVALID'); }
  if (value?.ok === false && Object.keys(value).sort().join(',') === 'code,ok' && CODES.has(value.code)) {
    throw failure(value.code);
  }
  const field = operation === 'window-list' ? 'windows' : 'monitors';
  if (result.status !== 0 || !value || value.ok !== true
      || Object.keys(value).sort().join(',') !== [field, 'ok'].sort().join(',') || !Array.isArray(value[field])
      || value[field].length > (field === 'windows' ? 500 : 32)
      || (field === 'monitors' && value[field].length === 0)) throw failure('DESKTOP_NATIVE_PROTOCOL_INVALID');
  return { status: 0, stdout: JSON.stringify({ [field]: value[field] }), stderr: '' };
}

module.exports = Object.freeze({ windowList: dependencies => query('window-list', dependencies),
  monitorList: dependencies => query('monitor-list', dependencies) });
