'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createByteAuthority } = require('../../src/lib/region-holds/byte-authority');
const { assertAccountProfilePath } = require('../../src/lib/account-profile-boundary');

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function binding(name) {
  return { principal: name, runtimeScopeId: 'scope-' + name, scopeKind: 'owner-host-session',
    canonicalLaunchId: null, laneId: null, runId: null, rosterRef: null };
}
function absentOrStat(file) {
  assertAccountProfilePath(file, { field: 'byte fixture leaf', requireOwnedProfile: true });
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function regular(stat, links = 1n) {
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links) {
    throw Object.assign(new Error('Fixture refuses missing, symbolic, or unexplained hard-link identity'), { code: 'FIXTURE_LINK_REFUSED' });
  }
}
function materialize(file) {
  const stat = absentOrStat(file);
  if (!stat) return { present: false };
  regular(stat);
  return { bytes: fs.readFileSync(file), identity: stat.dev + ':' + stat.ino };
}
function prepareCreate({ resource, publicationPath, stagingPath, operationId, after, afterSha256, assertCurrent }) {
  assert.equal(stagingPath, path.join(path.dirname(publicationPath), '.te-' + operationId + '.create.tmp'));
  assert.equal(path.resolve(resource).toLowerCase(), path.resolve(publicationPath).toLowerCase());
  assert.equal(hash(after), afterSha256);
  assertAccountProfilePath(stagingPath, { field: 'byte fixture create stage', requireOwnedProfile: true });
  assertCurrent();
  const descriptor = fs.openSync(stagingPath, 'wx');
  let identity;
  try {
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    identity = fs.fstatSync(descriptor, { bigint: true });
    regular(identity);
  } finally { fs.closeSync(descriptor); }
  return { stagingPath, device: String(identity.dev), inode: String(identity.ino), sha256: afterSha256, bytes: after.length };
}
function matchesPreparation(file, stat, preparation, links) {
  regular(stat, links);
  assert.equal(String(stat.dev), preparation.device);
  assert.equal(String(stat.ino), preparation.inode);
  assert.equal(Number(stat.size), preparation.bytes);
  assert.equal(hash(fs.readFileSync(file)), preparation.sha256);
}
function publishCreate(input, { afterLink } = {}) {
  const { publicationPath, createPreparation: stage, assertCurrent } = input;
  matchesPreparation(stage.stagingPath, absentOrStat(stage.stagingPath), stage, 1n);
  assertCurrent();
  // linkSync is an actual no-replace filesystem operation: an independently
  // created target makes it fail with EEXIST, never replace the other file.
  fs.linkSync(stage.stagingPath, publicationPath);
  if (afterLink) afterLink(input);
  matchesPreparation(publicationPath, absentOrStat(publicationPath), stage, 2n);
  matchesPreparation(stage.stagingPath, absentOrStat(stage.stagingPath), stage, 2n);
  fs.unlinkSync(stage.stagingPath);
  return { published: true, publicationMode: 'create-only' };
}
function reconcileCreateStage({ publicationPath, operationId, createPreparation: stage, afterSha256, afterBytes }) {
  assert.equal(stage.stagingPath, path.join(path.dirname(publicationPath), '.te-' + operationId + '.create.tmp'));
  assert.equal(stage.sha256, afterSha256);
  assert.equal(stage.bytes, afterBytes);
  const targetStat = absentOrStat(publicationPath);
  const stageStat = absentOrStat(stage.stagingPath);
  if (targetStat) matchesPreparation(publicationPath, targetStat, stage, stageStat ? 2n : 1n);
  if (stageStat) {
    matchesPreparation(stage.stagingPath, stageStat, stage, targetStat ? 2n : 1n);
    fs.unlinkSync(stage.stagingPath);
  }
  if (targetStat) matchesPreparation(publicationPath, absentOrStat(publicationPath), stage, 1n);
  return { reconciled: true };
}
function fixture(t, contents = 'abcdefghij', options = {}) {
  const temporaryRoot = assertAccountProfilePath(process.env.TOOLSENABLED_BYTE_TEST_TEMP_ROOT
    || (process.platform === 'win32' ? path.join(os.userInfo().homedir, 'AppData', 'Local', 'Temp') : os.tmpdir()),
  { field: 'disposable byte authority fixture', requireOwnedProfile: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'te-byte-authority-'));
  const resource = path.join(root, 'subject.txt');
  if (contents !== null) fs.writeFileSync(resource, contents);
  let publications = 0;
  const publish = input => {
    if (input.publicationMode === 'create-only') {
      const result = publishCreate(input, { afterLink: options.afterCreateLink });
      publications += 1;
      return result;
    }
    const { resource: file, beforeSha256, after, operationId, assertCurrent } = input;
    assert.equal(hash(fs.readFileSync(file)), beforeSha256);
    const staging = file + '.' + operationId + '.tmp';
    const descriptor = fs.openSync(staging, 'wx');
    try { fs.writeFileSync(descriptor, after); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (assertCurrent) assertCurrent();
    fs.renameSync(staging, file);
    publications += 1;
    return { published: true };
  };
  const authority = createByteAuthority({ stateRoot: root, materialize, publish, prepareCreate, reconcileCreateStage, ...options });
  t.after(() => {
    const absolute = fs.realpathSync(root);
    const parent = fs.realpathSync(temporaryRoot);
    assert.equal(path.dirname(absolute).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(absolute).startsWith('te-byte-authority-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return { root, resource, authority, materialize, publish, prepareCreate, reconcileCreateStage, publications: () => publications,
    file: (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; } };
}
function change(authority, actor, resource, startByte, endByte, replacement, extra = {}) {
  return authority.applyPatch({ binding: actor, resource, ...extra,
    derivePatch: () => ({ startByte, endByte, replacement: Buffer.from(replacement) }) });
}
function inspect(authority, sql, ...args) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(authority.dataFile, { readOnly: true });
  try { return db.prepare(sql).all(...args); }
  finally { db.close(); }
}

module.exports = { binding, fixture, change, inspect, hash, materialize, prepareCreate, publishCreate, reconcileCreateStage };
