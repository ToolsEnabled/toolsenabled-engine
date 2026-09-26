'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const HELPER = path.join(__dirname, 'lib/linux-keyring-fixture.py');

test('private keyring fixture validates the selected temp parent before reading its request or opening D-Bus',
  { skip: process.platform !== 'linux' }, t => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-parent-'));
    const root = fs.mkdtempSync(path.join(parent, 'toolsenabled-private-libsecret-'));
    const data = path.join(root, 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const invoke = (overrides = {}) => spawnSync('/usr/bin/python3', ['-I', HELPER], {
      env: { TMPDIR: parent, TOOLSENABLED_TEST_ROOT: root, XDG_DATA_HOME: data, ...overrides },
      // An incomplete request is reached only after the context guard passes.
      // It cannot contact a service; the full linux-vault suite supplies that
      // separate real native continuation proof.
      input: '{', encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const refused = (overrides = {}) => {
      const result = invoke(overrides);
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '', 'refusal precedes JSON parsing and service access');
    };
    const accepted = (overrides = {}) => {
      const result = invoke(overrides);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /JSONDecodeError/);
    };
    accepted();
    accepted({ TMPDIR: '', TMP: parent });
    accepted({ TMPDIR: '', TEMP: parent });
    refused({ TMPDIR: 'relative-parent' });
    refused({ TMPDIR: path.join(parent, 'missing') });
    refused({ TOOLSENABLED_TEST_ROOT: `${root}-suffix` });
    refused({ XDG_DATA_HOME: parent });
    const linkedParent = path.join(parent, 'linked-parent');
    fs.symlinkSync(parent, linkedParent);
    refused({ TMPDIR: linkedParent, TOOLSENABLED_TEST_ROOT: path.join(linkedParent, path.basename(root)),
      XDG_DATA_HOME: path.join(linkedParent, path.basename(root), 'data') });
    const linkedRoot = path.join(parent, 'toolsenabled-private-libsecret-Abc123');
    fs.symlinkSync(root, linkedRoot);
    refused({ TOOLSENABLED_TEST_ROOT: linkedRoot, XDG_DATA_HOME: path.join(linkedRoot, 'data') });
    for (const directory of [parent, root, data]) {
      const original = fs.statSync(directory).mode & 0o777;
      try { fs.chmodSync(directory, 0o777); refused(); }
      finally { fs.chmodSync(directory, original); }
    }
    const oldData = path.join(root, 'original-data');
    fs.renameSync(data, oldData);
    fs.symlinkSync(oldData, data);
    refused();
    fs.unlinkSync(data);
    fs.renameSync(oldData, data);
    accepted();
  });
