'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CODE = 'LINUX_PROCESS_NATIVE_UNAVAILABLE';
const MESSAGE = 'Host workers need Linux 5.3+ with pidfd_open; this system lacks or blocks the required native process support.';

// Probe the exact host backend in a disposable helper. No provider process is
// admitted, and neither the OpenShell marker nor a successful earlier probe
// selects a fallback or waives the guardian's own checks on every launch.
function requireHostWorkerNative({ spawnSyncImpl = spawnSync } = {}) {
  let result;
  try {
    result = spawnSyncImpl('/usr/bin/python3', ['-I', '-S', '-B',
      path.join(__dirname, 'linux-process-supervisor.py'), '--probe'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      timeout: 5000, maxBuffer: 4096,
    });
    if (!result.error && result.status === 0 && !result.signal
        && result.stdout === '{"available":true,"backend":"linux-subreaper-pidfd-v2"}\n') {
      return Object.freeze({ backend: 'linux-subreaper-pidfd-v2' });
    }
  } catch { /* Missing helpers, unsupported kernels and blocked syscalls refuse. */ }
  throw Object.assign(new Error(`${CODE}: ${MESSAGE}`), { code: CODE, retryable: false });
}

module.exports = { requireHostWorkerNative };
