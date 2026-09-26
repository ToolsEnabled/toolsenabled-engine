'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeStateRoot = require('../src/lib/runtime-state-root');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-root-indeterminate-'));

function makeLegacyRoot(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vault', 'secrets.json'), 'legacy-secret', 'utf8');
  return root;
}

try {
  // An unreadable adoption record must stop before any destination mutation.
  {
    const programRoot = makeLegacyRoot('unreadable-program');
    const stateRoot = path.join(scratch, 'unreadable-state');
    const writes = [];
    const copies = [];
    const directories = [];
    const fsImpl = {
      ...fs,
      readFileSync(file) {
        assert.equal(file, path.join(stateRoot, runtimeStateRoot.ADOPTION_RECORD));
        throw Object.assign(new Error('record cannot be read'), { code: 'EIO' });
      },
      writeFileSync(...args) { writes.push(args); return fs.writeFileSync(...args); },
      copyFileSync(...args) { copies.push(args); return fs.copyFileSync(...args); },
      mkdirSync(...args) { directories.push(args); return fs.mkdirSync(...args); },
    };

    const result = runtimeStateRoot.adoptLegacyPayloadState({
      stateRoot,
      programRoot,
      fsImpl,
      now: () => '2026-08-27T00:00:00.000Z',
    });

    assert.deepEqual(result, {
      reason: 'adoption-indeterminate',
      code: 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE',
      message: 'Could not read the adoption record; this is NOT claiming that legacy state is absent.',
      entries: [],
      pending: ['vault'],
    });
    assert.deepEqual(writes, [], 'an unreadable record must not be replaced');
    assert.deepEqual(copies, [], 'legacy data must not be copied without knowing the record state');
    assert.deepEqual(directories, [], 'the destination must not even be created after the refusal');
    assert.equal(fs.existsSync(stateRoot), false);
  }

  // A failed durable record write must not be reported as a completed adoption.
  {
    const programRoot = makeLegacyRoot('unwritable-program');
    const stateRoot = path.join(scratch, 'unwritable-state');
    const recordFile = path.join(stateRoot, runtimeStateRoot.ADOPTION_RECORD);
    let recordWriteAttempts = 0;
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...args) {
        if (file === recordFile) {
          recordWriteAttempts += 1;
          throw Object.assign(new Error('disk is read-only'), { code: 'EROFS' });
        }
        return fs.writeFileSync(file, ...args);
      },
    };

    const result = runtimeStateRoot.adoptLegacyPayloadState({
      stateRoot,
      programRoot,
      fsImpl,
      now: () => '2026-08-27T00:00:00.000Z',
    });

    assert.deepEqual(result, {
      reason: 'adoption-indeterminate',
      code: 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE',
      message: 'Could not write the adoption record; this is NOT claiming that legacy state is absent or fully adopted.',
      entries: ['vault'],
      pending: [],
    });
    assert.equal(recordWriteAttempts, 1);
    assert.equal(fs.existsSync(recordFile), false, 'a failed record write must leave no success record');
    assert.equal(fs.readFileSync(path.join(stateRoot, 'vault', 'secrets.json'), 'utf8'), 'legacy-secret');
  }

  // A per-file copy failure is pending, not absent or successfully adopted.
  {
    const programRoot = makeLegacyRoot('copy-failure-program');
    const stateRoot = path.join(scratch, 'copy-failure-state');
    const recordFile = path.join(stateRoot, runtimeStateRoot.ADOPTION_RECORD);
    let copyAttempts = 0;
    const fsImpl = {
      ...fs,
      copyFileSync() {
        copyAttempts += 1;
        throw Object.assign(new Error('source cannot be read'), { code: 'EIO' });
      },
    };

    const result = runtimeStateRoot.adoptLegacyPayloadState({
      stateRoot,
      programRoot,
      fsImpl,
      now: () => '2026-08-27T00:00:00.000Z',
    });

    assert.deepEqual(result, {
      reason: 'adoption-indeterminate',
      code: 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE',
      message: 'Could not inspect or copy all legacy state; this is NOT claiming that the pending state is absent.',
      entries: [],
      pending: ['vault'],
    });
    assert.equal(copyAttempts, 1);
    assert.equal(fs.existsSync(path.join(stateRoot, 'vault', 'secrets.json')), false,
      'the failed copy must not manufacture destination data');
    // CANONICAL, NOT A SPELLING. adoptLegacyPayloadState fences programRoot
    // through src/lib/account-profile-boundary.js before recording it ("An 8.3
    // short name is the same account, spelled shorter") -- assertAccountProfilePath
    // always returns fs.realpathSync.native() of the path, never the alias it
    // was handed, and the written record's `from` field is that canonical
    // value. On a machine where %TEMP% itself is handed out under an 8.3
    // short alias of the owner's profile folder, `programRoot` above -- a
    // plain path.join off os.tmpdir() -- names the same directory the record
    // was written from but does not SPELL it the same way.
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')), {
      version: runtimeStateRoot.ADOPTION_RECORD_VERSION,
      from: fs.realpathSync.native(programRoot),
      adopted: [],
      pending: ['vault'],
      at: '2026-08-27T00:00:00.000Z',
    });
  }

  console.log('runtime state-root indeterminate refusals: ok');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
