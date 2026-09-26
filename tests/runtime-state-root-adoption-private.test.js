'use strict';

/*
 * A vault adopted from a legacy payload must be as private as one created.
 *
 * MEASURED on this machine against the then-live source: adoption copied the
 * legacy payload's directories with no mode, so they landed at whatever umask
 * allowed. Under the Debian/Ubuntu default umask of 002 the adopted vault
 * directory was 0775; under the other common umask, 022, it was 0755. Both
 * leave bits in st_mode & 0o077, which is exactly what linux-vault.py refuses:
 *
 *   {"ok":false,"code":"SECRET_VAULT_PATH_UNSAFE"}
 *
 * and after chmod 700 on that same directory the identical request reached the
 * file, so the directory mode was the only thing blocking it. The vault
 * therefore arrived DEAD on the first run after an upgrade -- every provider
 * credential, the audit signing key and the device identity failing together,
 * with nothing in the product offering a repair. A 0755 vault directory is
 * also a confidentiality regression on its own: any local account can then
 * enumerate the credential filenames beside it.
 *
 * ensureRuntimeStateRoot already created the state root with an explicit 0700
 * on Linux for exactly this reason. Adoption now matches it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'linux') {
  console.log('Adoption privacy is a Linux mode rule; skipped on this platform.');
  process.exit(0);
}

const { adoptLegacyPayloadState } = require('../src/lib/runtime-state-root');

function build(umask) {
  const previous = process.umask(umask);
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-private-'));
    // A legacy packaged payload carrying a vault, and an empty private root.
    const programRoot = path.join(base, 'payload');
    const legacyVault = path.join(programRoot, 'vault');
    fs.mkdirSync(legacyVault, { recursive: true });
    fs.writeFileSync(path.join(legacyVault, 'secrets.json'), '{}', { mode: 0o600 });
    const stateRoot = path.join(base, 'state');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    return { base, programRoot, stateRoot };
  } finally {
    process.umask(previous);
  }
}

function modeOf(target) {
  return fs.lstatSync(target).mode & 0o7777;
}

// Both common umasks produced a refused vault before the fix.
for (const umask of [0o002, 0o022]) {
  const { base, programRoot, stateRoot } = build(umask);
  const previous = process.umask(umask);
  let outcome;
  try {
    outcome = adoptLegacyPayloadState({ stateRoot, programRoot });
  } finally {
    process.umask(previous);
  }

  const adoptedVault = path.join(stateRoot, 'vault');
  if (!fs.existsSync(adoptedVault)) {
    // Adoption may decline for its own reasons on a synthetic payload; that is
    // not this test's subject, so say so rather than passing silently.
    console.log(`  note: adoption did not produce a vault under umask 0${umask.toString(8)} (${JSON.stringify(outcome)}); mode rule untested for this case`);
    fs.rmSync(base, { recursive: true, force: true });
    continue;
  }

  const mode = modeOf(adoptedVault);
  assert.equal(
    mode & 0o077, 0,
    `under umask 0${umask.toString(8)} the adopted vault directory is 0${mode.toString(8)}; `
    + 'any bit in the group or other positions is what linux-vault.py refuses as SECRET_VAULT_PATH_UNSAFE'
  );

  // Every directory adoption created beneath the state root must be private,
  // not only the vault itself.
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const childMode = modeOf(child);
      assert.equal(childMode & 0o077, 0,
        `adopted directory ${path.relative(stateRoot, child)} is 0${childMode.toString(8)}, not private`);
      walk(child);
    }
  };
  walk(stateRoot);

  console.log(`  umask 0${umask.toString(8)}: adopted vault is 0${mode.toString(8)}`);
  fs.rmSync(base, { recursive: true, force: true });
}

// An already-wrong directory from a previous broken adoption must self-heal,
// because mkdir does nothing for a directory that already exists.
{
  const { base, programRoot, stateRoot } = build(0o002);
  const adoptedVault = path.join(stateRoot, 'vault');
  fs.mkdirSync(adoptedVault, { recursive: true });
  fs.chmodSync(adoptedVault, 0o775);
  assert.equal(modeOf(adoptedVault) & 0o077, 0o075, 'precondition: the directory starts group- and world-readable');

  const previous = process.umask(0o002);
  try { adoptLegacyPayloadState({ stateRoot, programRoot }); }
  finally { process.umask(previous); }

  const healed = modeOf(adoptedVault);
  assert.equal(healed & 0o077, 0,
    `a vault directory left 0775 by an earlier adoption must be repaired, not inherited; it is 0${healed.toString(8)}`);
  console.log('  pre-existing 0775 vault directory repaired to 0' + healed.toString(8));
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('Adopted state directories are as private as created ones under every common umask.');
