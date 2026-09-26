'use strict';

/* THE READER THAT CANNOT HAND BACK ANYTHING BUT A PICTURE.
 *
 * tests/agent-engine/claude-cli-process.test.js asserts, against the source
 * text, that the Claude protocol half and its transport half open no file and
 * name no credential store: "The child authenticates itself. Nothing here may
 * open, read, copy or forward a sign-in." A pasted picture still has to come
 * off disk, so the read lives in src/lib/agent-engine/turn-image-bytes.js --
 * and the only thing that makes that acceptable is the guarantee this file
 * pins: a path handed to that module comes back as a PICTURE or as a refusal,
 * never as bytes.
 *
 * So the important case here is not the happy one. It is a file that a caller
 * (or a bug, or a crafted path) points at which is NOT a picture: a settings
 * file, a token file, a key. Those must refuse, and their contents must never
 * leave the module.
 *
 * Run alone with:
 *   node tests/run-isolated.js tests/agent-engine/turn-image-bytes.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTurnImage, imageMimeTypeFor, MAX_IMAGE_BYTES } = require('../../src/lib/agent-engine/turn-image-bytes');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-image-bytes-'));
const write = (name, bytes) => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, bytes);
  return file;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('the rest of a very small png')
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jfif-ish')]);
const GIF = Buffer.from('GIF89a and some pixels');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

/* ---- 1. the four formats come back with the provider's media type ------- */
for (const [name, bytes, mimeType] of [
  ['pasted.png', PNG, 'image/png'],
  ['pasted.jpg', JPEG, 'image/jpeg'],
  ['pasted.gif', GIF, 'image/gif'],
  ['pasted.webp', WEBP, 'image/webp']
]) {
  const loaded = readTurnImage(write(name, bytes));
  assert.ok(Buffer.isBuffer(loaded.bytes), `${name} must come back as bytes`);
  assert.equal(loaded.bytes.length, bytes.length, `${name} must come back whole`);
  assert.ok(loaded.bytes.equals(bytes), `${name} must come back unchanged`);
  assert.equal(loaded.mimeType, mimeType, `${name} must be described by what it IS`);
}

/* ---- 2. THE EXTENSION IS A CLAIM, NOT EVIDENCE -------------------------- */
{
  /* A settings-or-token-shaped file wearing a picture's name. The value below
     is a placeholder written by this test; nothing real is involved. */
  const disguised = write('screenshot.png', Buffer.from('{"token":"PLACEHOLDER-NOT-A-REAL-VALUE"}'));
  assert.throws(
    () => readTurnImage(disguised),
    error => error.code === 'TURN_IMAGE_NOT_AN_IMAGE',
    'a non-picture named .png must refuse; the name is a claim the file makes about itself'
  );
}

/* ---- 3. a real non-picture, refused, and nothing of it returned --------- */
{
  const notes = write('notes.txt', Buffer.from('these are words, not pixels'));
  let caught = null;
  try { readTurnImage(notes); } catch (error) { caught = error; }
  assert.ok(caught, 'a text file must refuse');
  assert.equal(caught.code, 'TURN_IMAGE_NOT_AN_IMAGE');
  assert.ok(!caught.message.includes('these are words'),
    'a refusal must name the file, never quote its contents back');
  assert.ok(caught.message.includes('notes.txt'),
    'a refusal must say WHICH file, so a person can tell which picture did not go');
}

/* ---- 4. absent, empty and oversized each refuse under their own name ---- */
assert.throws(
  () => readTurnImage(path.join(scratch, 'never-written.png')),
  error => error.code === 'TURN_IMAGE_UNREADABLE'
);
assert.throws(
  () => readTurnImage(write('empty.png', Buffer.alloc(0))),
  error => error.code === 'TURN_IMAGE_EMPTY'
);
{
  const huge = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(MAX_IMAGE_BYTES + 1)
  ]);
  assert.throws(
    () => readTurnImage(write('huge.png', huge)),
    error => error.code === 'TURN_IMAGE_TOO_LARGE',
    'a picture past the bound must refuse rather than be truncated into a corrupt one'
  );
}
assert.throws(
  () => readTurnImage(''),
  error => error.code === 'TURN_IMAGE_PATH_INVALID'
);

/* ---- 5. the sniffer says no to bytes that merely start plausibly -------- */
assert.equal(imageMimeTypeFor(Buffer.from('GIF87')), null,
  'a truncated signature is not a match');
assert.equal(imageMimeTypeFor(Buffer.alloc(0)), null);
assert.equal(imageMimeTypeFor(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), null,
  'a RIFF container that is not WebP is not a picture');

process.stdout.write('turn-image-bytes tests passed.\n');
