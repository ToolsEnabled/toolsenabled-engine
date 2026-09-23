'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const REFUSALS = new Set(['DESKTOP_NATIVE_UNAVAILABLE', 'DESKTOP_SESSION_UNAVAILABLE',
  'DESKTOP_PROMPT_INVALID', 'DESKTOP_PROMPT_INTERRUPTED', 'DESKTOP_PROMPT_FAILED']);
function failure(code) {
  return Object.assign(new Error('The Linux confirmation could not be completed. The action remains unapproved.'), { code });
}

function ask(file, { timeoutMs, environment = process.env, spawnSyncImpl = spawnSync } = {}) {
  // Keep prompt text out of command arguments and exclude loader/config hooks.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.homedir() };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  let result;
  try {
    result = spawnSyncImpl('/usr/bin/python3', ['-I', '-S', '-B', path.join(__dirname, 'linux-desktop-ask.py'), file], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      timeout: timeoutMs, maxBuffer: 16384,
    });
  } catch { throw failure('DESKTOP_PROMPT_FAILED'); }
  if (result.error || result.signal) {
    throw failure(result.error?.code === 'ENOENT' ? 'DESKTOP_NATIVE_UNAVAILABLE' : 'DESKTOP_PROMPT_INTERRUPTED');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw failure('DESKTOP_NATIVE_PROTOCOL_INVALID'); }
  if (result.status !== 0 && value?.ok === false && REFUSALS.has(value.code)
      && Object.keys(value).sort().join(',') === 'code,ok') throw failure(value.code);
  if (result.status !== 0 || value?.ok !== true || !['yes', 'no', 'timeout'].includes(value.answer)
      || Object.keys(value).sort().join(',') !== 'answer,ok') throw failure('DESKTOP_NATIVE_PROTOCOL_INVALID');
  return { status: 0, stdout: value.answer, stderr: '' };
}

module.exports = Object.freeze({ ask });
