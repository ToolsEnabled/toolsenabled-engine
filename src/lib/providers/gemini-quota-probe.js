'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { parseFrame, unavailable } = require('./gemini-quota-protocol');
const { unsupportedEnvironment } = require('./gemini-quota-storage');
const { withProbeLifecycle, probeLifecycleOf } = require('../multi-account/probe-lifecycle');

function workerEnvironment(base, home, cwd) {
  const environment = {};
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
  for (const [key, value] of Object.entries(base || {})) if (allowed.has(key.toUpperCase()) && typeof value === 'string') environment[key] = value;
  return { ...environment, HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
    APPDATA: home, LOCALAPPDATA: home, TEMP: cwd, TMP: cwd, TMPDIR: cwd,
    NO_COLOR: '1', CI: 'true', NO_BROWSER: 'true', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false', ELECTRON_RUN_AS_NODE: '1' };
}

async function probeGeminiQuota({ home, signal = null, timeoutMs = 15000, baseEnvironment = process.env,
  spawnImpl = require('../proc/hidden-spawn').spawnHidden, fsImpl = fs,
  temporaryRoot = os.tmpdir(), workerPath = path.join(__dirname, 'gemini-quota-worker.mjs'),
  executable = process.execPath, project = null
} = {}) {
  if (signal?.aborted) return unavailable('GEMINI_USAGE_CANCELLED');
  if (typeof home !== 'string' || !path.isAbsolute(home)) return unavailable('GEMINI_AUTH_FILE_UNSUPPORTED');
  if (unsupportedEnvironment(baseEnvironment)) return unavailable('GEMINI_AUTH_MODE_UNSUPPORTED');
  let cwd;
  try { cwd = fsImpl.mkdtempSync(path.join(temporaryRoot, 'toolsenabled-gemini-quota-')); }
  catch { return unavailable('GEMINI_USAGE_UNAVAILABLE'); }
  let answer = null, frames = 0;
  const id = randomBytes(16).toString('hex');
  let result;
  try {
    // Success only settles on natural close. Seeing a frame never finishes
    // the worker while its official OAuth refresh write can still be pending.
    result = await require('../multi-account/health').runOwnedProbe({
      command: executable, args: [workerPath], cwd, env: workerEnvironment(baseEnvironment, home, cwd),
      signal, timeoutMs, maxTimeoutMs: 20000, spawnImpl, captureOutput: false,
      timeoutCode: 'GEMINI_USAGE_TIMEOUT', outputLimitCode: 'GEMINI_USAGE_OUTPUT_LIMIT',
      onStart({ write, end }) { write({ version: 1, id, home, cwd, project }); end(); },
      onLine(line, { finish }) {
        frames += 1;
        answer = parseFrame(line, id);
        if (frames !== 1 || !answer) finish({ error: { code: 'GEMINI_USAGE_MALFORMED' } });
      },
      onClose({ pending, finish }) {
        if (pending.length) finish({ error: { code: 'GEMINI_USAGE_MALFORMED' } });
      }
    });
  } finally {
    // The shared runner has either proved closure or thrown retained cleanup
    // custody. In the latter case leave the owned scratch path for recovery.
    if (result) { try { fsImpl.rmSync(cwd, { recursive: true, force: true }); } catch { /* not an allowance fact */ } }
  }
  let reading;
  if (result?.error) reading = unavailable(result.error.code === 'ABORT_ERR' ? 'GEMINI_USAGE_CANCELLED' : result.error.code);
  else if (result?.code !== 0) reading = unavailable('GEMINI_WORKER_EXIT_FAILED');
  else reading = frames === 1 && answer ? answer : unavailable('GEMINI_USAGE_MALFORMED');
  return probeLifecycleOf(result) === 'closed' ? withProbeLifecycle(reading, 'closed') : reading;
}
module.exports = Object.freeze({ probeGeminiQuota, workerEnvironment });
