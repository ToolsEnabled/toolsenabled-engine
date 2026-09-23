'use strict';

// Fixed two-record maintenance seam. It never returns secret values and may
// replace only the audit signing key and protected head, under the vault's own
// lock and an expected ciphertext digest. Unrelated ciphertext is retained.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { vaultReaderContext } = require('./vault-location');
const HASH = /^[a-f0-9]{64}$/;
function fail(code = 'AUDIT_REKEY_VAULT_UNAVAILABLE') {
  throw Object.assign(new Error(code === 'AUDIT_REKEY_VAULT_CHANGED'
    ? 'The audit vault records changed. Inspect and confirm again; no record was replaced.'
    : 'The owned encrypted vault could not be inspected or updated safely. Its records were preserved.'), { code });
}
function checked(value) {
  if (!value || value.version !== 1 || !HASH.test(value.digest || '')
      || !['readable', 'unreadable', 'missing'].includes(value.signing)
      || !['readable', 'unreadable', 'missing'].includes(value.head)
      || !value.owner || value.owner.platform !== process.platform
      || typeof value.owner.id !== 'string' || !value.owner.id
      || typeof value.owner.elevated !== 'boolean') fail();
  return value;
}
function forStateRoot(stateRoot, environment = process.env) {
  const context = vaultReaderContext(stateRoot, environment);
  if (process.platform === 'win32') {
    const fence = require('./account-profile-boundary');
    fence.assertAccountProfilePath(context.location.file, { profileRoot: fence.installationProfileRoot(), field: 'audit repair vault' });
  }
  function run(action, fields = {}) {
    if (process.platform === 'linux') return checked(require('./vault-linux').auditPair(action, fields, context.location.file, context.environment));
    if (process.platform !== 'win32') fail();
    let output;
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', path.resolve(__dirname, '../../tools/secrets.ps1'), action], {
        input: JSON.stringify(fields), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true,
        timeout: 35000, maxBuffer: 16384,
        env: require('./providers/subscription-launch-env').safeLaunchEnvironment(context.environment, { context: 'audit identity vault maintenance' })
      });
    } catch { fail(); }
    let result;
    try { result = JSON.parse(output); } catch { fail(); }
    if (result?.code === 'AUDIT_REKEY_VAULT_CHANGED') fail(result.code);
    return checked(result);
  }
  return Object.freeze({
    inspect: () => run('audit-pair-inspect'),
    replace(expectedDigest, privateKey, anchor) {
      if (!HASH.test(expectedDigest || '') || typeof privateKey !== 'string' || !privateKey || typeof anchor !== 'string' || !anchor) fail();
      try { return run('audit-pair-replace', { expectedDigest, privateKey, anchor }); }
      finally { require('./runtime').invalidateSecretValueCache(); }
    }
  });
}
module.exports = { forStateRoot };
