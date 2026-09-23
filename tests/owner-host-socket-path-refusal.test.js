'use strict';
// The kernel copies a unix socket path into sockaddr_un.sun_path, a fixed
// 108-byte field including its NUL terminator. Past that the path is
// TRUNCATED rather than rejected, and the consequence is the dangerous part:
// listen() reports success while no socket is created on disk. Measured on
// this machine at 211 bytes -- listen() succeeded, fs.existsSync was false,
// the directory listing was empty.
//
// src/lib/owner-host-linux.js already refuses such a path before listen(), so
// this suite pins that refusal rather than introducing it. What it also pins
// is the DIAGNOSTIC: a refusal that says only "invalid or too long" reads as
// "your path is malformed" when the true answer is "your path is 211 bytes
// and the kernel allows 107". An operator who cannot tell those apart cannot
// fix the one that is fixable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const linux = require(path.join(__dirname, '..', 'src', 'lib', 'owner-host-linux.js'));

const SUN_PATH_BYTES = 108;

function overLongPath(bytes) {
  const suffix = '.sock';
  const dir = '/run/user/1000/toolsenabled-owner-host/';
  return dir + 'a'.repeat(bytes - dir.length - suffix.length) + suffix;
}

test('the kernel boundary is pinned exactly: 107 accepted, 108 refused', () => {
  assert.equal(linux.validSocketPath(overLongPath(107)), true, '107 bytes fits sun_path with its terminator');
  assert.equal(linux.validSocketPath(overLongPath(108)), false, '108 bytes cannot fit the terminator');
});

test('an over-long socket path is refused BEFORE listen, naming the byte count and the limit', () => {
  const file = overLongPath(211);
  assert.equal(Buffer.byteLength(file, 'utf8'), 211);
  assert.throws(() => linux.prepareSocketDirectory(file), (error) => {
    assert.equal(error.code, 'OWNER_HOST_LINUX_PATH_REFUSED');
    assert.match(error.message, /211/, 'the refusal must name the measured byte count');
    assert.match(error.message, new RegExp(String(SUN_PATH_BYTES - 1)),
      'the refusal must name the limit the operator has to get under');
    return true;
  });
});

test('a malformed path is refused as malformed, not reported as too long', () => {
  assert.throws(() => linux.prepareSocketDirectory('relative/not/absolute.sock'), (error) => {
    assert.equal(error.code, 'OWNER_HOST_LINUX_PATH_REFUSED');
    assert.doesNotMatch(error.message, /bytes/,
      'a short invalid path must not be blamed on length');
    return true;
  });
});
