'use strict';

const path = require('node:path');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DECLARED_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'], ['.gz', 'application/gzip'],
  ['.wav', 'audio/wav'], ['.sqlite', 'application/vnd.sqlite3'], ['.sqlite3', 'application/vnd.sqlite3']
]);

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// This is a bounded text-input classifier, not an image decoder or MIME oracle.
// Signatures take precedence over suffixes. Unknown binary is also refused if
// it contains NUL/control bytes or is not valid UTF-8; printable UTF-8 is text.
function signatureMime(bytes) {
  const starts = signature => bytes.subarray(0, signature.length).equals(signature);
  if (starts(PNG)) return 'image/png';
  if (starts(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (starts(Buffer.from('GIF87a')) || starts(Buffer.from('GIF89a'))) return 'image/gif';
  if (starts(Buffer.from('%PDF-'))) return 'application/pdf';
  if ([3, 5, 7].some(third => starts(Buffer.from([0x50, 0x4b, third, third === 3 ? 4 : third === 5 ? 6 : 8])))) return 'application/zip';
  if (starts(Buffer.from([0x1f, 0x8b]))) return 'application/gzip';
  if (starts(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  if (starts(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WAVE'))) return 'audio/wav';
  if (starts(Buffer.from('SQLite format 3\0'))) return 'application/vnd.sqlite3';
  if (starts(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'application/x-elf';
  return null;
}

function assertTextInput(bytes, target) {
  const mime = signatureMime(bytes);
  const declared = DECLARED_MIME.get(path.extname(target).toLowerCase());
  if (mime && declared && declared !== mime) {
    refuse('HOST_FILE_MIME_MISMATCH', `The filename declares ${declared}, but the bytes do not match it (${mime || 'unrecognized content'}). Check the file type; host.read_file accepts UTF-8 text only.`);
  }
  if (mime === 'image/png' && (bytes.length < 33 || bytes.readUInt32BE(8) !== 13
      || !bytes.subarray(12, 16).equals(Buffer.from('IHDR'))
      || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0)) {
    refuse('HOST_FILE_MALFORMED_IMAGE', 'The image/png header is incomplete or malformed. host.read_file does not decode or repair images; use an authorized image input or image reader if available.');
  }
  if (mime || bytes.some(byte => byte === 0 || (byte < 0x20 && ![9, 10, 13, 27].includes(byte)))) {
    refuse('HOST_FILE_BINARY_UNSUPPORTED', `Binary input (${mime || 'application/octet-stream'}) is not supported by host.read_file. It accepts UTF-8 text only; use an authorized image input or image reader for images, or a format-specific reader if available. No binary content was returned.`);
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    refuse('HOST_FILE_TEXT_ENCODING_UNSUPPORTED', 'The file is not valid UTF-8 text. Convert a copy to UTF-8 with an explicit source encoding, or use a format-specific reader if available. No lossy replacement text was returned.');
  }
}

module.exports = { assertTextInput };
