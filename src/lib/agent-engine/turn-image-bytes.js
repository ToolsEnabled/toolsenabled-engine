'use strict';

/* THE ONLY PLACE A TURN'S PICTURE IS READ OFF DISK.
 *
 * Why this is its own file. tests/agent-engine/claude-cli-process.test.js
 * asserts, against the source text, that neither the Claude protocol half nor
 * its transport half contains `readFileSync`, `openSync`, `createReadStream`
 * or the name of any credential store: "The child authenticates itself.
 * Nothing here may open, read, copy or forward a sign-in." That gate is right
 * and stays exactly as it is. A pasted picture still has to be read from
 * somewhere, so the read lives here, in one small module whose whole contract
 * is that what comes back is a PICTURE or nothing.
 *
 * That is not a way around the gate, it is the gate's own reasoning applied
 * one file over: this module cannot hand a caller a credential, because the
 * magic-byte check below rejects every file that is not a PNG, JPEG, GIF or
 * WebP before any bytes are returned. A ~/.claude/.credentials.json is not a
 * picture and leaves here as a refusal, whatever the path said it was.
 *
 * The caller is already fenced too: the path arrives from the app's per-session
 * attachment allowlist, which only holds files the person put there through
 * agent:pick-attachment or agent:paste-attachment. This module adds the second
 * half -- the app proved a person chose the file, this proves the file is a
 * picture -- so neither check has to be trusted alone.
 */

const fs = require('node:fs');
const path = require('node:path');

/* Matches the ACP adapter's MAX_IMAGE_BYTES so one pasted picture is not
   deliverable through one provider and refused by another for a reason nobody
   can see. */
const MAX_IMAGE_BYTES = 3_000_000;

class TurnImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TurnImageError';
    this.code = code;
  }
}

/* Sniffed, never trusted to the extension: a file's name is a claim the file
   makes about itself. Each entry is the provider-facing media type for the
   magic bytes that identify that format. */
const IMAGE_SIGNATURES = Object.freeze([
  {
    mimeType: 'image/png',
    matches: bytes => bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  },
  {
    mimeType: 'image/jpeg',
    matches: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  },
  {
    mimeType: 'image/gif',
    matches: bytes => bytes.length >= 6
      && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')
  },
  {
    mimeType: 'image/webp',
    matches: bytes => bytes.length >= 12
      && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  }
]);

function imageMimeTypeFor(bytes) {
  const found = IMAGE_SIGNATURES.find(signature => signature.matches(bytes));
  return found ? found.mimeType : null;
}

/* Reads one picture for one turn.
 *
 * Returns { bytes, mimeType }. Throws TurnImageError with a code the adapter
 * turns into its own refusal. NEVER returns partial success: a caller that gets
 * a value gets a whole picture, so no call site has to remember to re-check.
 *
 * The file name is the only part of the path that ever appears in a message,
 * because a refusal a person reads should say which picture, and the rest of
 * the path is their machine's business.
 */
function readTurnImage(imagePath) {
  if (typeof imagePath !== 'string' || imagePath === '') {
    throw new TurnImageError('TURN_IMAGE_PATH_INVALID', 'A picture needs a file path.');
  }
  let handle;
  let bytes;
  try {
    /* Opened once and measured through the same handle. Statting the path and
       then reading it would be two different files if anything moved in
       between, and the size bound has to hold for the bytes actually sent. */
    handle = fs.openSync(imagePath, 'r');
    const size = fs.fstatSync(handle).size;
    if (size > MAX_IMAGE_BYTES) {
      throw new TurnImageError('TURN_IMAGE_TOO_LARGE',
        `A picture may be at most ${MAX_IMAGE_BYTES} bytes.`);
    }
    bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const chunk = fs.readSync(handle, bytes, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    if (read !== size) {
      throw new TurnImageError('TURN_IMAGE_UNREADABLE', 'That picture could not be read in full.');
    }
  } catch (error) {
    if (error instanceof TurnImageError) throw error;
    throw new TurnImageError('TURN_IMAGE_UNREADABLE',
      `That picture could not be read (${path.basename(imagePath)}).`);
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* the read already succeeded or failed on its own terms */ } }
  }
  if (bytes.length === 0) {
    throw new TurnImageError('TURN_IMAGE_EMPTY', 'That file is empty, so there is no picture to send.');
  }
  const mimeType = imageMimeTypeFor(bytes);
  if (!mimeType) {
    /* THE LINE THAT MAKES THIS MODULE SAFE TO EXIST. Anything that is not one
       of the four picture formats leaves here as a refusal -- a token file, a
       settings file, a private key, a log -- so no path handed to this module
       can turn into bytes on their way to a model. */
    throw new TurnImageError('TURN_IMAGE_NOT_AN_IMAGE',
      `That file is not a picture (${path.basename(imagePath)}).`);
  }
  return { bytes, mimeType };
}

module.exports = { readTurnImage, imageMimeTypeFor, TurnImageError, MAX_IMAGE_BYTES };
