'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const guard = require('../src/lib/shared-write-guard');

function disabled(extra = {}) {
  return {
    loadSettings: () => ({ values: { [guard.SETTING_ID]: false }, rejected: [] }),
    ...extra
  };
}

test('a live whole-file lock produces SHARED_WRITE_CONFLICT without running the write', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-write-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  const lockFile = guard.lockPathFor(target, { servicesRoot: root });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  let writes = 0;
  assert.throws(
    () => guard.withSharedWrite(target, () => { writes += 1; }, disabled({ servicesRoot: root })),
    error => error.code === 'SHARED_WRITE_CONFLICT'
      && error.details.target === target
      && error.details.holderPid === process.pid
  );
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(lockFile), true, 'a refusal must not disturb the other writer\'s lock');
});

test('an unclassified acquire failure reports LOCK_ACQUIRE_FAILED and does not run the write', () => {
  const root = path.join(os.tmpdir(), 'shared-write-acquire-failure');
  const fsImpl = new Proxy({}, {
    get: () => () => { throw new Error('filesystem offline'); }
  });
  let writes = 0;
  assert.throws(
    () => guard.withSharedWrite(path.join(root, 'target.txt'), () => { writes += 1; },
      disabled({ servicesRoot: root, fsImpl })),
    error => error.code === 'SHARED_WRITE_LOCK_STATE_UNAVAILABLE'
      && error.details.cause === 'LOCK_ACQUIRE_FAILED'
  );
  assert.equal(writes, 0);
});

test('an unclassified release failure reports LOCK_RELEASE_FAILED after exactly one operation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-write-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  const fsImpl = Object.create(fs);
  // Acquisition writes without reading. Release first reads the holder record,
  // so this fails specifically at release verification with an un-coded error.
  fsImpl.readFileSync = () => { throw new Error('release verification denied'); };

  let operations = 0;
  assert.throws(
    () => guard.withSharedWrite(target, () => { operations += 1; },
      disabled({ servicesRoot: root, fsImpl })),
    error => error.code === 'SHARED_WRITE_LOCK_RELEASE_FAILED'
      && error.details.cause === 'LOCK_RELEASE_FAILED'
  );
  assert.equal(operations, 1);
  assert.equal(fs.existsSync(guard.lockPathFor(target, { servicesRoot: root })), true,
    'the refusal accurately leaves the unreleased lock in place');
});

test('a release that silently leaves the lock reports SHARED_WRITE_LOCK_RELEASE_FAILED', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-write-release-stuck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  const fsImpl = Object.create(fs);
  fsImpl.rmSync = file => file.endsWith('.lock') ? undefined : fs.rmSync(file, { force: true });

  let operations = 0;
  assert.throws(
    () => guard.withSharedWrite(target, () => { operations += 1; },
      disabled({ servicesRoot: root, fsImpl })),
    error => error.code === 'SHARED_WRITE_LOCK_RELEASE_FAILED'
      && !Object.hasOwn(error.details, 'cause')
  );
  assert.equal(operations, 1);
  assert.equal(fs.existsSync(guard.lockPathFor(target, { servicesRoot: root })), true);
});
