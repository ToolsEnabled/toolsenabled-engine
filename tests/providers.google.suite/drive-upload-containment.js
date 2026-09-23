'use strict';

// drive.js driveUpload() has the identical unmediated-read shape gmail.send's
// attachments once had: a caller-supplied filePath, resolved with a bare
// path.resolve() and read with fs.readFileSync(), with zero containment and
// zero credential-name exclusion. Same treatment as
// providers.google.suite/gmail-attachments.js's containment tests, adjacent
// commit, so gmail is never closed while drive stays open.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const driveModulePath = require.resolve('../../src/lib/providers/drive');
const providerRoot = path.dirname(driveModulePath);

// The real network call must never be reachable from this test. A synthetic
// authenticatedRequest that always throws proves any test that gets past
// containment is refused for the RIGHT reason (containment), not because the
// (absent) real network call happened to fail first.
function loadDriveWithNoNetwork() {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent && path.dirname(parent.filename) === providerRoot) {
      if (request === '../policy') return { assertActive() {} };
      if (request === '../audit') return { record() {} };
      if (request === '../google-accounts') return { oauthKeysFor() { return { account: 'drive-containment-test' }; } };
      if (request === '../google-oauth') {
        return { authenticatedRequest: async () => { throw new Error('network must not be reached in this test'); } };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[driveModulePath];
  try { return require('../../src/lib/providers/drive'); }
  finally { Module._load = originalLoad; }
}

let checks = 0;
const ok = label => { checks += 1; console.log(`  ok  ${label}`); };

const tempDir = fs.mkdtempSync(path.join(process.platform === 'linux' ? os.userInfo().homedir : os.tmpdir(), '.toolsenabled-drive-upload-containment-'));
const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } };

async function main() {
  const drive = loadDriveWithNoNetwork();

  // 1. A path outside the owner profile tree is refused before any existence
  // check — no fixture is created there, real file or not is irrelevant.
  const outsideProfilePath = process.platform === 'win32'
    ? path.win32.join(path.win32.parse(os.homedir()).root, 'toolsenabled-containment-test-outside-profile.pdf')
    : path.resolve('/toolsenabled-containment-test-outside-profile.pdf');
  assert.ok(
    path.relative(os.homedir(), outsideProfilePath).startsWith('..'),
    'test setup error: the constructed path must actually be outside the home directory'
  );
  await assert.rejects(
    () => drive.driveUpload({ filePath: outsideProfilePath }),
    error => {
      assert.equal(error.code, 'DRIVE_UPLOAD_OUTSIDE_PROFILE');
      assert.doesNotMatch(error.message, /ENOENT|not found/i, 'must refuse on containment, not on absence');
      return true;
    }
  );
  ok('an upload path outside the owner profile tree is refused before any existence check');

  // 2. A real fixture, inside the owned temp directory, but named like a
  // bounded credential store. Harmless synthetic content only.
  const credentialShapedPath = path.join(tempDir, 'credentials.json');
  fs.writeFileSync(credentialShapedPath, JSON.stringify({ note: 'synthetic fixture, not a real credential' }));
  let readAttempted = false;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (args[0] === credentialShapedPath) readAttempted = true;
    return originalReadFileSync.apply(fs, args);
  };
  try {
    await assert.rejects(
      () => drive.driveUpload({ filePath: credentialShapedPath }),
      error => {
        assert.equal(error.code, 'DRIVE_UPLOAD_FORBIDDEN');
        return true;
      }
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(readAttempted, false, 'a credential-shaped upload path must never reach fs.readFileSync');
  ok('an upload path shaped like a credential store is refused, and the file is never read');

  // 3. An ordinary document from the owner's own working folder must still
  // upload exactly as before. The synthetic transport throws deliberately
  // (see loadDriveWithNoNetwork), so success here means containment passed
  // and the function reached the network call — not that it truly uploaded.
  const ordinaryPath = path.join(tempDir, 'quarterly-report.pdf');
  fs.writeFileSync(ordinaryPath, Buffer.from('%PDF-1.7\n test fixture, not a real document\n%%EOF\n'));
  await assert.rejects(
    () => drive.driveUpload({ filePath: ordinaryPath }),
    error => {
      // Reaching the synthetic network failure (rather than a containment
      // refusal) IS the passing signal for this case.
      assert.equal(error.message, 'network must not be reached in this test');
      return true;
    }
  );
  ok('an ordinary upload path from the owner profile tree passes containment and reaches the transport');

  // 4. Existing missing-file contract is unchanged in shape (still refused,
  // now with a typed code rather than a bare Error, but still ENOENT-shaped
  // in its message for anyone matching on text).
  const missingPath = path.join(tempDir, 'does-not-exist.pdf');
  await assert.rejects(
    () => drive.driveUpload({ filePath: missingPath }),
    error => {
      assert.equal(error.code, 'DRIVE_UPLOAD_NOT_FOUND');
      return true;
    }
  );
  ok('a missing upload file is still refused, now with a typed DRIVE_UPLOAD_NOT_FOUND code');

  console.log(`\nDrive upload containment tests passed (${checks} checks).`);
}

main().catch(error => {
  cleanup();
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(cleanup);
