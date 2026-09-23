'use strict';

// Per-host native execution. The companion remains a separately required
// exact-source receipt in the complete release census; it is never a pass here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runIsolatedChild } = require('../lib/isolated-child');
const { clearAuthority } = require('../../tools/lib/strict-lifecycle-record');
const ROOT = path.resolve(__dirname, '../..');
const LEAVES = Object.freeze({ linux: 'tests/linux-vault.test.js', win32: 'tests/vault-native.test.js' });
const PREFIX = 'NATIVE CUSTODY RECEIPT: ';

async function main() {
  if (process.argv.length !== 2 || !Object.hasOwn(LEAVES, process.platform)) {
    process.stderr.write('Native key custody requires Linux or Windows and accepts no selection arguments.\n');
    process.exitCode = 2;
    return;
  }
  const measure = () => Object.fromEntries(Object.entries(LEAVES).map(([platform, file]) => [platform,
    { file, sha256: createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex') }]));
  const inputs = measure(), selected = inputs[process.platform];
  const result = await runIsolatedChild(process.execPath,
    [path.join(ROOT, 'tests/run-isolated.js'), selected.file], {
      cwd: ROOT, env: clearAuthority(), stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  let inputsUnchanged = false;
  try { inputsUnchanged = JSON.stringify(measure()) === JSON.stringify(inputs); } catch {}
  const passed = result.status === 0 && !result.signal && !result.error
    && result.cleanupConfirmed === true && inputsUnchanged;
  const receipt = { schema: 'toolsenabled.native-custody-source-execution', platform: process.platform,
    selected, exitCode: result.status, signal: result.signal || null, errorCode: result.error?.code || null,
    cleanupConfirmed: result.cleanupConfirmed === true, inputsUnchanged, passed,
    companion: Object.entries(inputs).filter(([platform]) => platform !== process.platform)
      .map(([platform, input]) => ({ platform, ...input, status: 'unexecuted' })),
    authority: 'Per-host source execution only; paired exact-source native receipts and installed qualification remain required.' };
  if (result.stdout && !result.stdout.endsWith('\n')) process.stdout.write('\n');
  process.stdout.write(`${PREFIX}${JSON.stringify(receipt)}\n`);
  process.exitCode = passed ? 0 : Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
}

main().catch(error => {
  process.stderr.write(`Native key custody could not complete: ${error.code || error.name}\n`);
  process.exitCode = 1;
});
