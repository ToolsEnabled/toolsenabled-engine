'use strict';

// A RELATIVE PATH IS RELATIVE TO THE OWNER PROFILE TREE.
//
// EVIDENCE. host.read_file, host.write_file and host.list_dir all describe this
// argument as "Absolute or relative path inside the owner profile tree", and
// host.list_dir adds "omit for the profile root" -- listDir's own default IS
// the profile root. resolveHostPath nonetheless anchored a relative path on
// process.cwd(): wherever this engine process happens to be running, which is
// not the profile root, not the agent's working directory, and not anything an
// MCP caller can see or name. The live action log carries ten "path does not
// exist." failures across host.list_dir and host.read_file.
//
// These checks drive the exported resolveHostPath over REAL directories created
// under the real profile root and under a real scratch directory that stands in
// for a process working directory, and assert WHICH path comes back. They never
// spell an implementation detail: the anchor is read only from where the
// resolved path lands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hostControl = require('../src/lib/providers/host-control');
const { resolveHostPath, HOME } = hostControl;

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function unique(prefix) {
  return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/* A name that exists ONLY under the profile root, and a second directory of the
   same name that exists ONLY under a scratch directory, so the resolved answer
   says which anchor was used and there is no way for both to be right. */
const NAME = unique('mc-anchor');
const underHome = path.join(HOME, NAME);
const scratchParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-anchor-cwd-'));
const underScratch = path.join(scratchParent, NAME);

const originalCwd = process.cwd();
const cleanup = [];

try {
  fs.mkdirSync(underHome, { recursive: true });
  cleanup.push(() => fs.rmSync(underHome, { recursive: true, force: true }));
  fs.mkdirSync(underScratch, { recursive: true });
  cleanup.push(() => fs.rmSync(scratchParent, { recursive: true, force: true }));

  check('a relative path lands under the profile root, not the process working directory', () => {
    /* Stand the process somewhere else entirely. The answer must not move. */
    const away = path.join(HOME, unique('mc-anchor-away'));
    fs.mkdirSync(away, { recursive: true });
    cleanup.push(() => fs.rmSync(away, { recursive: true, force: true }));
    process.chdir(away);
    assert.equal(resolveHostPath(NAME, { mustExist: true }), underHome,
      'a relative path was anchored on the process working directory');
    process.chdir(HOME);
    assert.equal(resolveHostPath(NAME, { mustExist: true }), underHome,
      'the answer changed when the process moved, so it is still ambient');
  });

  check('a relative path is resolved the same way whatever the process working directory is', () => {
    const seen = new Set();
    for (const where of [HOME, scratchParent, originalCwd]) {
      process.chdir(where);
      seen.add(resolveHostPath(path.join(NAME, 'child.txt')));
    }
    assert.equal(seen.size, 1, `one relative path produced ${seen.size} different answers: ${[...seen].join(' | ')}`);
    assert.equal([...seen][0], path.join(underHome, 'child.txt'));
  });

  check('the directory that only exists beside the process is NOT what a relative path finds', () => {
    /* The exact confusion the defect produced: a name that exists in both
       places, resolved while standing in the wrong one. Existence is required,
       so an answer that pointed at the scratch copy would still pass mustExist
       and the caller would be handed the wrong directory. */
    process.chdir(scratchParent);
    const resolved = resolveHostPath(NAME, { mustExist: true });
    assert.notEqual(resolved, underScratch, 'the caller was handed the directory beside the process');
    assert.equal(resolved, underHome);
  });

  check('an absolute path is untouched', () => {
    process.chdir(scratchParent);
    assert.equal(resolveHostPath(underHome, { mustExist: true }), underHome);
    const file = path.join(underHome, 'plain.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(resolveHostPath(file, { mustExist: true }), file);
  });

  check('a relative path that climbs out of the profile is still refused', () => {
    /* The containment fence is unchanged and this proves it on the new anchor:
       nothing about resolving under the profile root lets a caller leave it. */
    process.chdir(HOME);
    for (const escape of [path.join('..', 'Public', 'x.txt'), path.join('..', '..', 'Windows', 'System32')]) {
      assert.throws(() => resolveHostPath(escape), error => {
        assert.equal(error.code, 'HOST_PATH_OUTSIDE_PROFILE', `${escape} gave ${error.code}: ${error.message}`);
        return true;
      });
    }
  });

  check('a relative path naming an excluded store is still refused', () => {
    process.chdir(scratchParent);
    assert.throws(() => resolveHostPath('.ssh'), error => {
      assert.equal(error.code, 'HOST_PATH_FORBIDDEN', `.ssh gave ${error.code}: ${error.message}`);
      return true;
    });
  });

  check('an empty or blank path is still refused before anything is resolved', () => {
    for (const bad of ['', '   ', null, undefined, 7]) {
      assert.throws(() => resolveHostPath(bad), error => {
        assert.equal(error.code, 'HOST_PATH_INVALID');
        return true;
      });
    }
  });

  console.log(`host-control relative path anchor tests passed (${checks} checks: a relative path lands under the profile root, gives one answer wherever the process stands, does not find the directory beside the process, leaves absolute paths alone, and still refuses escapes, excluded stores and empty input).`);
} catch (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
} finally {
  try { process.chdir(originalCwd); } catch { /* the original directory went away */ }
  for (const undo of cleanup.reverse()) {
    try { undo(); } catch { /* a scratch directory that will not go is not a test result */ }
  }
}
