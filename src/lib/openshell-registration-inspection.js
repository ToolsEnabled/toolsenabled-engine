'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./supervision/launch-environment');

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 65536;

function unknown(cli, reason, version) {
  return Object.freeze({ cli, absent: false, reason, ...(version ? { version } : {}) });
}

function completed(result) {
  return result && !result.error && !result.signal && Number.isInteger(result.status)
    && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= MAX_OUTPUT_BYTES;
}

// These exact results are qualified by isolated real-CLI sentinel probes.
// Claude 2.1.284 `mcp get` starts the registered server, so its only accepted
// evidence is the caller's fresh result from `mcp remove --scope user
// toolsenabled`, run with the same env/cwd. Never inspect Claude via get/list
// or configuration files. Unknown versions/formats retain the runtime; no
// result or absence is cached across uninstall retries.
function probe(cli, context = {}) {
  const descriptor = require('./agents/registry').loadRegistry({ env: context.env || process.env }).get(cli);
  const inspection = descriptor?.register.inspection;
  if (!inspection) return unknown(cli, 'NONCONNECTING_INSPECTION_UNAVAILABLE');
  const name = context.name || 'toolsenabled';
  if (inspection.kind === 'json-config') {
    try {
      const result = require('./agents/registration').jsonInspection(descriptor, context.entry, { env: context.env, name });
      return Object.freeze({ cli, absent: result.absent, owned: result.owned, reason: result.absent ? 'REGISTRATION_ABSENT' : result.owned ? 'REGISTRATION_OWNED' : 'REGISTRATION_TARGET_UNPROVEN' });
    } catch { return unknown(cli, 'REGISTRATION_INSPECTION_FAILED'); }
  }
  const { env, cwd, removalResult, spawnSync: launch = spawnSync } = context || {};
  if (inspection.kind === 'remove-absence' && (!completed(removalResult) || removalResult.status !== 1
    || removalResult.stdout !== ''
    || removalResult.stderr !== inspection.absentStderr.replaceAll('{name}', name))) {
    return unknown(cli, 'REGISTRATION_ABSENCE_UNPROVEN');
  }
  if (!env || typeof env !== 'object' || typeof env.HOME !== 'string' || !path.isAbsolute(env.HOME)
    || typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof launch !== 'function') {
    return unknown(cli, 'INSPECTION_CONTEXT_INVALID');
  }
  let environment;
  try {
    environment = safeLaunchEnvironment({ ...env, LANG: 'C', LC_ALL: 'C' },
      { context: `OpenShell uninstall: ${cli} registration inspection` });
  } catch { return unknown(cli, 'INSPECTION_ENVIRONMENT_REFUSED'); }
  const options = { env: environment, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: false, windowsHide: true };
  let versionResult;
  try { versionResult = launch(descriptor.command, ['--version'], options); }
  catch { return unknown(cli, 'VERSION_INSPECTION_FAILED'); }
  const version = completed(versionResult) ? require('./agents/registry').qualifiedVersion(inspection, versionResult.stdout) : null;
  if (!completed(versionResult) || versionResult.status !== 0 || versionResult.stderr !== '' || version === null) {
    return unknown(cli, 'VERSION_UNQUALIFIED');
  }
  if (inspection.kind === 'remove-absence') {
    return Object.freeze({ cli, absent: true, reason: 'REGISTRATION_ABSENT', version });
  }
  let result;
  try { result = launch(descriptor.command, inspection.args.map(arg => arg.replaceAll('{name}', name)), options); }
  catch { return unknown(cli, 'REGISTRATION_INSPECTION_FAILED', version); }
  if (!completed(result)) return unknown(cli, 'REGISTRATION_INSPECTION_FAILED', version);
  if (result.status === 1 && result.stdout === ''
    && result.stderr === inspection.absentStderr.replaceAll('{name}', name)) {
    return Object.freeze({ cli, absent: true, reason: 'REGISTRATION_ABSENT', version });
  }
  return Object.freeze({ ...unknown(cli, 'REGISTRATION_ABSENCE_UNPROVEN', version),
    ...(result.status === 0 && result.stderr === '' && result.stdout.length > 0 ? { present: true } : {}) });
}

module.exports = Object.freeze({ probe });
