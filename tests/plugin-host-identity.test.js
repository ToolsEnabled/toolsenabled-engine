/*
 * Mutation: in identity.js packageIdentity(), replaced the four length-prefixed
 * hash.update() calls with a plain `hash.update(relativeBytes); hash.update(contents)`
 * concatenation, and removed the `files:<n>` count commitment above them so the
 * mutant was the naive join exactly.
 * Landed: yes; both edits were present in src/lib/plugin-host/identity.js.
 * Result: red; 'the digest is injective across the path/content boundary' failed
 * (1 of 7) because the two crafted packages produced one digest. Restored: green.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const identity = require('../src/lib/plugin-host/identity');

// Fixtures live under the home directory, not /tmp: src/lib/providers/host-control.js
// fences paths to $HOME, and a fixture outside it fails with HOST_PATH_OUTSIDE_PROFILE
// before any assertion in this file has run.
function scratch() {
  return fs.mkdtempSync(path.join(os.homedir(), '.te-plugin-identity-'));
}

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test('the digest is injective across the path/content boundary', () => {
  // THE WHOLE REASON THE HASH IS LENGTH-PREFIXED.
  //
  // Package A holds one file at "a/b" containing "c".
  // Package B holds one file at "a"   containing "b/c"  -- which is illegal as a
  // directory/file pair, so use the pair that a naive join really does collide:
  //   A: "ab" -> "c"      joined: "ab" + "c"  = "abc"
  //   B: "a"  -> "bc"     joined: "a"  + "bc" = "abc"
  const a = scratch();
  const b = scratch();
  try {
    write(a, 'ab', 'c');
    write(b, 'a', 'bc');
    const left = identity.packageIdentity(a);
    const right = identity.packageIdentity(b);
    assert.notEqual(left.sha256, right.sha256,
      'two different packages whose joined bytes agree must not share a digest');
    assert.equal(left.fileCount, 1);
    assert.equal(right.fileCount, 1);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('one changed byte moves the id, and identical bytes keep it', () => {
  const first = scratch();
  const second = scratch();
  const third = scratch();
  try {
    write(first, 'plugin.json', '{"schemaVersion":1}');
    write(first, 'tools/run.py', 'print(1)\n');
    write(second, 'plugin.json', '{"schemaVersion":1}');
    write(second, 'tools/run.py', 'print(1)\n');
    write(third, 'plugin.json', '{"schemaVersion":1}');
    write(third, 'tools/run.py', 'print(2)\n');

    const a = identity.packageIdentity(first);
    const b = identity.packageIdentity(second);
    const c = identity.packageIdentity(third);
    assert.equal(a.sha256, b.sha256, 'byte-identical packages are one package');
    assert.notEqual(a.sha256, c.sha256, 'one changed character is a different package');
    assert.match(a.id, /^plugin-[0-9a-f]{16}$/);
    assert.equal(a.id, `plugin-${a.sha256.slice(0, 16)}`);
    assert.equal(a.fileCount, 2);
    assert.deepEqual(a.inventory.map(entry => entry.path), ['plugin.json', 'tools/run.py']);
  } finally {
    for (const root of [first, second, third]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a renamed file moves the id even when every byte of content is the same', () => {
  const a = scratch();
  const b = scratch();
  try {
    write(a, 'tools/scan.py', 'x');
    write(b, 'tools/scan2.py', 'x');
    assert.notEqual(identity.packageIdentity(a).sha256, identity.packageIdentity(b).sha256);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('every file in the folder counts: dependencies, caches, logs, records and .git move the id too', () => {
  // 1.0.50 release review F2. These paths were skipped as "run-time output" while
  // the product said any changed file makes a new plugin -- and node loads a
  // script's dependency from node_modules, and Python a cached or sourceless .pyc,
  // without the reviewed code naming the file. The probe ran a changed dependency
  // under the old grant. Red before the fix (each of these kept the id), green after.
  // The fixtures are named by the SHAPE of what they hold, never by a real one:
  // this repository is published.
  for (const [relative, contents] of [
    ['node_modules/dep/index.js', 'module.exports = "changed";\n'],
    ['tools/__pycache__/helper.cpython-312.pyc', 'bytecode'],
    ['tools/helper.pyc', 'sourceless bytecode'],
    ['logs/egress.log', 'ALLOW example.test\n'],
    ['records/example.json', '{"program":"example"}'],
    ['notes.log', 'a line\n'],
    ['.git/config', '[core]\n']
  ]) {
    const root = scratch();
    try {
      write(root, 'plugin.json', '{}');
      write(root, 'tools/run.py', 'import helper\n');
      const before = identity.packageIdentity(root);
      write(root, relative, contents);
      const after = identity.packageIdentity(root);
      assert.notEqual(after.sha256, before.sha256, `${relative} was left out of the digest`);
      assert.ok(after.inventory.some(entry => entry.path === relative), `${relative} is not in the inventory`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a symbolic link is refused rather than followed or ignored', () => {
  const root = scratch();
  const outside = scratch();
  try {
    write(outside, 'secret.txt', 'owner private data');
    write(root, 'plugin.json', '{}');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
    assert.throws(() => identity.packageIdentity(root), (error) => {
      assert.equal(error.code, 'PLUGIN_PACKAGE_SYMLINK');
      assert.match(error.message, /identity of a package has to be decided by the package/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a missing or non-directory package is named, not guessed at', () => {
  const root = scratch();
  try {
    assert.throws(() => identity.packageIdentity(path.join(root, 'nope')), (error) => {
      assert.equal(error.code, 'PLUGIN_PACKAGE_MISSING');
      return true;
    });
    write(root, 'file', 'x');
    assert.throws(() => identity.packageIdentity(path.join(root, 'file')), (error) => {
      assert.equal(error.code, 'PLUGIN_PACKAGE_NOT_DIRECTORY');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the digest does not depend on the order the filesystem reports entries in', () => {
  const root = scratch();
  try {
    for (const name of ['c.py', 'a.py', 'b.py']) write(root, `tools/${name}`, name);
    const first = identity.packageIdentity(root).sha256;
    // A readdir that reports the same entries in the opposite order must produce
    // the same digest: the walk sorts, and the sort is what makes the id a
    // property of the package rather than of this machine's filesystem.
    const reversing = {
      ...fs,
      readdirSync: (directory, options) => fs.readdirSync(directory, options).reverse()
    };
    assert.equal(identity.packageIdentity(root, { fsImpl: reversing }).sha256, first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
