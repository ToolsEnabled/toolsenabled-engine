'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalizeForContainment } = require('../src/lib/canonical-path');

function run() {
  const scratchRoot = path.join(os.tmpdir(), `canonical-path-test-${process.pid}-${Date.now()}`);
  const realDir = path.join(scratchRoot, 'real-target');
  const excludedFile = path.join(realDir, 'secret.txt');
  const junctionDir = path.join(scratchRoot, 'alias-junction');

  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(excludedFile, 'protected content\n', 'utf8');

  try {
    // --- verified reparse points on THIS real Windows profile (the review's exact evidence) ---
    // These assertions describe Windows-created compatibility junctions. Keep
    // them live on Windows without pretending that ordinary POSIX directories
    // named "Local Settings" and "Application Data" are those junctions.
    if (process.platform === 'win32') {
      const home = os.homedir();
      const localSettings = canonicalizeForContainment(path.join(home, 'Local Settings'));
      assert.equal(localSettings, path.join(home, 'AppData', 'Local'));
      const localSettingsCredentials = canonicalizeForContainment(path.join(home, 'Local Settings', 'Microsoft', 'Credentials'));
      assert.equal(localSettingsCredentials, path.join(home, 'AppData', 'Local', 'Microsoft', 'Credentials'));
      const appData = canonicalizeForContainment(path.join(home, 'Application Data'));
      assert.equal(appData, path.join(home, 'AppData', 'Roaming'));
      console.log('OK: legacy Windows profile junctions (Local Settings, Application Data) canonicalize to their real AppData targets');
    } else {
      console.log('OK: legacy Windows profile-junction evidence is not asserted on a non-Windows filesystem');
    }

    // --- a fresh junction we create ourselves: existing target ---
    fs.symlinkSync(realDir, junctionDir, 'junction');
    const throughJunction = path.join(junctionDir, 'secret.txt');
    assert.equal(canonicalizeForContainment(throughJunction), excludedFile, 'a path spelled through a junction to an EXISTING file must canonicalize to the real file');
    console.log('OK: an existing file reached through a fresh junction canonicalizes to its real location');

    // --- a fresh junction, target does not exist yet (the write case) ---
    const newFileThroughJunction = path.join(junctionDir, 'not-created-yet.txt');
    const expectedRealNewFile = path.join(realDir, 'not-created-yet.txt');
    assert.equal(canonicalizeForContainment(newFileThroughJunction), expectedRealNewFile, 'a not-yet-existing target reached through a junction must canonicalize via its nearest existing (junction) ancestor');
    console.log('OK: a not-yet-existing write target through a junction canonicalizes via the nearest existing ancestor');

    // --- a plain path with no reparse points anywhere: canonical form equals itself ---
    const plainNewFile = path.join(realDir, 'plain-new-file.txt');
    assert.equal(canonicalizeForContainment(plainNewFile), plainNewFile);
    console.log('OK: a plain path with no reparse points canonicalizes to itself');

    // --- an existing symlink whose target cannot be canonicalized ---
    const danglingLink = path.join(scratchRoot, 'dangling-link');
    fs.symlinkSync(path.join(scratchRoot, 'missing-target'), danglingLink, 'junction');
    assert.throws(
      () => canonicalizeForContainment(path.join(danglingLink, 'new-file.txt')),
      error => error.code === 'ENOENT'
    );
    console.log('OK: a dangling symlink refuses instead of being treated as an absent path segment');

    // --- nonsense path with no existing ancestor at all ---
    if (process.platform === 'win32') {
      assert.throws(() => canonicalizeForContainment('Z:\\this\\drive\\does\\not\\exist\\at\\all'), error => error.code === 'CANONICAL_ANCESTOR_NOT_FOUND');
      console.log('OK: a path on a nonexistent Windows drive refuses cleanly');
    } else {
      // POSIX always has the existing root directory, so every absolute path
      // has an ancestor. Prove the equivalent nearest-ancestor behavior rather
      // than treating a Windows drive spelling as an absolute POSIX path.
      const nonexistent = path.join(scratchRoot, 'does', 'not', 'exist', 'at', 'all');
      assert.equal(canonicalizeForContainment(nonexistent), nonexistent);
      console.log('OK: a nonexistent POSIX descendant canonicalizes through its existing root');
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

run();
process.stdout.write('canonical-path tests passed.\n');
