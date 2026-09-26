const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { authenticatedRequest } = require('../google-oauth');
const { oauthKeysFor } = require('../google-accounts');
const { mimeForFile } = require('./drive');
const { HostControlError, resolveHostPath } = require('./host-control');

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

// Attachment bounds. Gmail's users.messages.send `raw` field is a base64url
// encoding of the WHOLE RFC822 message, and an attachment inside that message
// is *already* base64 -- so a raw attachment byte is inflated twice, by 4/3
// each time (16/9 ~= 1.78x) before it reaches the wire. The per-message cap
// below is therefore chosen so that a full-size attachment set still lands
// under MAX_ENCODED_MESSAGE_BYTES rather than failing opaquely inside the API.
// Larger payloads legitimately belong on the resumable upload endpoint, which
// this provider does not implement; refusing early is the honest answer.
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_TOTAL_BYTES = 2_750_000;
const MAX_ENCODED_MESSAGE_BYTES = 5_000_000;
const MAX_ATTACHMENT_FILENAME_LENGTH = 255;
const MIME_TOKEN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;
// RFC 2231 attribute-char set: everything else is percent-escaped.
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function encodeBase64Url(value) { return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

// Typed, caller-actionable failures. Mirrors the failure(code, message)
// convention already used across src/lib/providers, and keeps
// classifyGmailSendFailure() from flattening these into GMAIL_SEND_FAILED.
function attachmentFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function attachmentFileFailure(error, index, sourcePath) {
  if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    return attachmentFailure('GMAIL_ATTACHMENT_NOT_FOUND', `attachments[${index}] file not found: ${sourcePath}`);
  }
  const failure = attachmentFailure(
    'GMAIL_ATTACHMENT_READ_UNAVAILABLE',
    `attachments[${index}] could not be inspected or read: ${sourcePath}; this does NOT claim that the file is absent.`
  );
  failure.cause = error;
  return failure;
}

// CONTAINMENT, before any stat or read. Reuses host-control.js's own
// resolveHostPath -- the same fence host.read_file already enforces on the
// owner's profile tree, including its credential-store exclusion
// (isCredentialProtectedPath) -- rather than inventing a second path
// validator for this provider alone. An attachment path is exactly the same
// class of question host.read_file already answers: "may this provider read
// this file on the owner's machine at all," and the answer must not depend on
// which tool asks it.
//
// Mapped onto this provider's own typed-failure convention so a caller sees
// GMAIL_ATTACHMENT_* codes throughout rather than a mix of two providers'
// error shapes; GMAIL_ATTACHMENT_NOT_FOUND is reused verbatim for
// HOST_PATH_NOT_FOUND so the existing missing-file contract is unchanged.
function attachmentPathFailure(error, index, requestedPath) {
  if (!(error instanceof HostControlError)) throw error;
  if (error.code === 'HOST_PATH_NOT_FOUND') {
    return attachmentFailure('GMAIL_ATTACHMENT_NOT_FOUND', `attachments[${index}] file not found: ${requestedPath}`);
  }
  if (error.code === 'HOST_PATH_OUTSIDE_PROFILE') {
    return attachmentFailure('GMAIL_ATTACHMENT_OUTSIDE_PROFILE', `attachments[${index}] is outside the owner profile tree and cannot be attached: ${requestedPath}`);
  }
  if (error.code === 'HOST_PATH_FORBIDDEN') {
    return attachmentFailure('GMAIL_ATTACHMENT_FORBIDDEN', `attachments[${index}] names a bounded credential, session, or environment-secret store and is never attached: ${requestedPath}`);
  }
  // HOST_PATH_INVALID / HOST_PATH_CHECK_FAILED and anything else this helper
  // may one day add: could-not-look, not a claim of absence, same convention
  // as attachmentFileFailure's own default branch above.
  const failure = attachmentFailure(
    'GMAIL_ATTACHMENT_READ_UNAVAILABLE',
    `attachments[${index}] could not be inspected or read: ${requestedPath}; this does NOT claim that the file is absent.`
  );
  failure.cause = error;
  return failure;
}

// RFC 2231 / RFC 6266 parameter encoding, so a filename with spaces, quotes,
// or non-ASCII characters survives intact instead of corrupting the header.
function encodeRfc2231(value) {
  let out = '';
  const bytes = Buffer.from(value, 'utf8');
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    out += byte < 0x80 && ATTR_CHAR.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// A pure-ASCII filename with no quote/backslash is safe as a quoted-string.
// Anything else additionally carries the RFC 2231 extended form, with an
// ASCII fallback for parsers that ignore filename*.
function filenameParameter(name, filename) {
  if (PRINTABLE_ASCII.test(filename) && !/["\\]/.test(filename)) return `${name}="${filename}"`;
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${name}="${fallback}"; ${name}*=UTF-8''${encodeRfc2231(filename)}`;
}

function wrapBase64(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join('\r\n');
}

// Accepts { filename, content: Buffer|base64 string, contentType } or
// { path } (read from disk here so callers never carry megabytes around).
// Returns parts whose content is ALREADY base64 text -- raw bytes never leave
// this function, so nothing downstream can log or record them.
function normalizeAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', 'attachments must be an array when provided.');
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments must contain at most ${MAX_ATTACHMENT_COUNT} entries.`);
  }
  const parts = [];
  let totalBytes = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    const entry = attachments[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}] must be an object.`);
    }
    let content = null;
    let sourcePath = null;
    if (entry.path !== undefined && entry.path !== null && entry.path !== '') {
      if (typeof entry.path !== 'string') throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}].path must be a string.`);
      try {
        sourcePath = resolveHostPath(entry.path, { mustExist: true });
      } catch (error) {
        throw attachmentPathFailure(error, index, entry.path);
      }
      let sourceStat;
      try {
        sourceStat = fs.statSync(sourcePath);
      } catch (error) {
        throw attachmentFileFailure(error, index, sourcePath);
      }
      if (!sourceStat.isFile()) {
        throw attachmentFailure('GMAIL_ATTACHMENT_NOT_FOUND', `attachments[${index}] file not found: ${sourcePath}`);
      }
      // Refuse by stat before reading, so an oversized file is never loaded.
      const declaredBytes = sourceStat.size;
      if (declaredBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw attachmentFailure('GMAIL_ATTACHMENT_TOO_LARGE', `attachments[${index}] is ${declaredBytes} bytes; the limit is ${MAX_ATTACHMENT_TOTAL_BYTES} bytes per message.`);
      }
      try {
        content = fs.readFileSync(sourcePath);
      } catch (error) {
        throw attachmentFileFailure(error, index, sourcePath);
      }
    } else if (Buffer.isBuffer(entry.content)) {
      content = entry.content;
    } else if (typeof entry.content === 'string') {
      content = Buffer.from(entry.content, 'base64');
    } else {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}] requires a path, a Buffer content, or base64 content.`);
    }
    const rawFilename = entry.filename === undefined || entry.filename === null || entry.filename === ''
      ? (sourcePath ? path.basename(sourcePath) : null)
      : entry.filename;
    if (typeof rawFilename !== 'string' || !rawFilename.trim()) {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}].filename is required when no path is given.`);
    }
    if (/[\r\n\u0000]/.test(rawFilename)) {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}].filename must not contain CR, LF, or NUL.`);
    }
    // Never let a caller-supplied name traverse or imply a directory.
    const filename = path.basename(rawFilename.replace(/\\/g, '/'));
    if (!filename || filename === '.' || filename === '..' || filename.length > MAX_ATTACHMENT_FILENAME_LENGTH) {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}].filename is not a usable file name.`);
    }
    const contentType = entry.contentType === undefined || entry.contentType === null || entry.contentType === ''
      ? mimeForFile(filename)
      : String(entry.contentType);
    if (!MIME_TOKEN.test(contentType)) {
      throw attachmentFailure('GMAIL_ATTACHMENT_INVALID', `attachments[${index}].contentType must be a simple type/subtype value.`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw attachmentFailure('GMAIL_ATTACHMENT_TOO_LARGE', `attachments total ${totalBytes} bytes; the limit is ${MAX_ATTACHMENT_TOTAL_BYTES} bytes per message.`);
    }
    parts.push({ filename, contentType, bytes: content.length, encoded: wrapBase64(content) });
  }
  return parts;
}

// Choose a boundary that appears nowhere in any body it will delimit. The
// candidate is generated outside all caller-controlled content; the explicit
// check keeps even a synthetic/adversarial body from terminating the multipart
// early. `exclude` lets the outer (mixed) boundary also differ from the inner
// (alternative) one.
function chooseBoundary(contents, exclude = []) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `=_toolsenabled_${crypto.randomBytes(12).toString('hex')}`;
    if (exclude.includes(candidate)) continue;
    if (contents.every(content => !String(content == null ? '' : content).includes(candidate))) return candidate;
  }
  throw new Error('Could not choose a safe MIME boundary.');
}

function buildMimeEmail({ to, subject, cc = '', bcc = '', text = '', html = null, attachments = null }) {
  const parts = normalizeAttachments(attachments);
  const lines = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];
  if (cc) lines.splice(1, 0, `Cc: ${cc}`);
  if (bcc) lines.splice(1, 0, `Bcc: ${bcc}`);
  if (!parts.length) {
    // ---- Unchanged legacy path. Byte-for-byte identical to the pre-attachment
    // implementation for every input that carries no attachment, which is every
    // existing caller (agent-digest, owner-delivery, the gmail.send tool).
    if (html === null || html === undefined) {
      lines.push('Content-Type: text/plain; charset=UTF-8');
      return encodeBase64Url(`${lines.join('\r\n')}\r\n\r\n${text || ''}`);
    }
    if (typeof html !== 'string') throw new Error('html must be a string when provided.');
    const boundary = chooseBoundary([text, html]);
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text || '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
      ''
    ].join('\r\n');
    return encodeBase64Url(`${lines.join('\r\n')}\r\n\r\n${body}`);
  }

  // ---- multipart/mixed: [body part][attachment]... The body part is the
  // legacy structure verbatim -- a bare text/plain, or a nested
  // multipart/alternative -- so an attachment never changes how the message
  // itself renders.
  if (html !== null && html !== undefined && typeof html !== 'string') throw new Error('html must be a string when provided.');
  const collisionSources = [text, html, ...parts.map(part => part.encoded), ...parts.map(part => part.filename)];
  const inner = html === null || html === undefined ? null : chooseBoundary(collisionSources);
  const outer = chooseBoundary(collisionSources, inner ? [inner] : []);
  const bodyPart = inner === null
    ? ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text || '']
    : [
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      '',
      `--${inner}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text || '',
      `--${inner}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${inner}--`
    ];
  lines.push(`Content-Type: multipart/mixed; boundary="${outer}"`);
  const segments = [`--${outer}`, ...bodyPart];
  for (const part of parts) {
    segments.push(
      `--${outer}`,
      `Content-Type: ${part.contentType}; ${filenameParameter('name', part.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${filenameParameter('filename', part.filename)}`,
      '',
      part.encoded
    );
  }
  segments.push(`--${outer}--`, '');
  const raw = encodeBase64Url(`${lines.join('\r\n')}\r\n\r\n${segments.join('\r\n')}`);
  if (raw.length > MAX_ENCODED_MESSAGE_BYTES) {
    throw attachmentFailure('GMAIL_MESSAGE_TOO_LARGE', `The encoded message is ${raw.length} bytes; the limit is ${MAX_ENCODED_MESSAGE_BYTES} bytes for users.messages.send.`);
  }
  return raw;
}

function assertHeaderValue(value, label, { required = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (/[\r\n]/.test(value)) throw new Error(`${label} must not contain CR or LF characters.`);
  if (required && !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function isBasicEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) return false;
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator !== value.indexOf('@')) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => EMAIL_DOMAIN_LABEL.test(label));
}

function normalizeEmailList(value, label, { required = false } = {}) {
  assertHeaderValue(value, label, { required });
  if (!value.trim()) return '';
  const addresses = value.split(',').map(address => address.trim());
  if (addresses.some(address => !isBasicEmailAddress(address))) {
    throw new Error(`${label} must be a comma-separated list of basic email addresses.`);
  }
  return addresses.join(', ');
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseRfc3339(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an RFC3339 string.`);
  const match = RFC3339.exec(value);
  if (!match) throw new Error(`${label} must be an RFC3339 timestamp with a timezone.`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  const fractionalNanoseconds = BigInt((match[7] || '').padEnd(9, '0') || '0');
  const offsetHour = Number(match[10] || 0); const offsetMinute = Number(match[11] || 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const offset = match[8] === 'Z' ? 0 : (offsetHour * 60 + offsetMinute) * (match[9] === '+' ? 1 : -1);
  return BigInt(utc.getTime() - offset * 60_000) * 1_000_000n + fractionalNanoseconds;
}

function validateCalendarCreate({ summary, start, end, attendees }) {
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('summary is required and must be a non-empty string.');
  const startTime = parseRfc3339(start, 'start');
  const endTime = parseRfc3339(end, 'end');
  if (endTime <= startTime) throw new Error('end must be later than start.');
  if (!Array.isArray(attendees)) throw new Error('attendees must be an array of email addresses.');
  for (let index = 0; index < attendees.length; index += 1) {
    const attendee = attendees[index];
    if (typeof attendee !== 'string' || /[\r\n]/.test(attendee) || !isBasicEmailAddress(attendee)) {
      throw new Error(`attendees[${index}] must be a basic email address.`);
    }
  }
}

async function gmailList({ query = '', maxResults = 20, account }) {
  assertActive('gmail.list');
  const keys = oauthKeysFor(account);
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(Math.min(Math.max(Number(maxResults) || 20, 1), 100)));
  const result = (await authenticatedRequest(url, {}, keys)).body;
  record('gmail.list', keys.account, { hasQuery: Boolean(query), resultCount: Array.isArray(result.messages) ? result.messages.length : 0 });
  return { ...result, ...UNTRUSTED_CONTENT };
}

// Bounded, safe classification of a failed send -- never the raw error
// message (which may echo back Gmail API response text or credential-helper
// detail) and never a stack trace. An already-typed code (e.g. the
// CREDENTIAL_* family thrown by runtime.js's getSecret(), or http.js's
// HTTP_REDIRECT_REFUSED) is preserved as-is; anything else is reduced to a
// small fixed set of gmail.send-specific codes, mirroring the
// failure(code, message)/`<action>.failed` convention used elsewhere in
// src/lib/providers (see firebase.js's accountLogin, vertex-gemini.js's
// geminiComplete).
function classifyGmailSendFailure(error) {
  if (error && typeof error.code === 'string' && error.code) return error.code;
  if (error && error.name === 'AbortError') return 'GMAIL_SEND_TIMEOUT';
  const httpMatch = /^HTTP (\d{3})\b/.exec((error && error.message) || '');
  if (httpMatch) return `GMAIL_SEND_HTTP_${httpMatch[1]}`;
  return 'GMAIL_SEND_FAILED';
}

async function gmailSend({ to, subject, text, html = null, cc = '', bcc = '', attachments = null, account }) {
  assertActive('gmail.send');
  /* VALIDATE BEFORE RESOLVING CREDENTIALS. A malformed request — CR/LF in a
     header is injection surface — must be refused as malformed, not answered
     with the account registry's state. The test contract is named
     rejectsBeforeAuthentication and means exactly this ordering. */
  const normalizedTo = normalizeEmailList(to, 'to', { required: true });
  const normalizedCc = normalizeEmailList(cc, 'cc');
  const normalizedBcc = normalizeEmailList(bcc, 'bcc');
  assertHeaderValue(subject, 'subject', { required: true });
  if (text !== undefined && text !== null && typeof text !== 'string') throw new Error('text must be a string when provided.');
  const keys = oauthKeysFor(account);
  const raw = buildMimeEmail({
    to: normalizedTo, subject, cc: normalizedCc, bcc: normalizedBcc,
    text: text || '', html, attachments
  });
  // Metadata only: names and sizes, never attachment bytes.
  const attachmentSummary = Array.isArray(attachments) && attachments.length
    ? { attachmentCount: attachments.length, encodedMessageBytes: raw.length }
    : {};
  let result;
  try {
    result = (await authenticatedRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw })
    }, keys)).body;
  } catch (error) {
    // A token expiry, revoked grant, or Gmail API failure must leave a
    // trace even though nothing was ever durably sent -- previously this
    // path recorded nothing at all, so a future failure here was silent.
    // The audit write is best-effort: it must never replace or mask the
    // original send failure the caller actually needs to see.
    try {
      record('gmail.send.failed', to, { to, subject, cc, bcc, hasHtml: html !== null && html !== undefined, ...attachmentSummary, code: classifyGmailSendFailure(error) });
    } catch { /* preserve the original send failure over a secondary audit-write failure */ }
    throw error;
  }
  record('gmail.send', result.id || to, { to, subject, cc, bcc, hasHtml: html !== null && html !== undefined, ...attachmentSummary });
  return { ...result, ...UNTRUSTED_CONTENT };
}

async function calendarList({ calendarId = 'primary', timeMin, timeMax, maxResults = 20, account }) {
  assertActive('calendar.list');
  /* Validation precedes credential resolution; see gmailSend above. */
  const min = timeMin === undefined ? null : parseRfc3339(timeMin, 'timeMin');
  const max = timeMax === undefined ? null : parseRfc3339(timeMax, 'timeMax');
  if (min !== null && max !== null && max <= min) throw new Error('timeMax must be later than timeMin.');
  const keys = oauthKeysFor(account);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  if (timeMin) url.searchParams.set('timeMin', timeMin);
  if (timeMax) url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(Math.min(Math.max(Number(maxResults) || 20, 1), 2500)));
  const result = (await authenticatedRequest(url, {}, keys)).body;
  record('calendar.list', calendarId, { account: keys.account, timeMin, timeMax, resultCount: Array.isArray(result.items) ? result.items.length : 0 });
  return { ...result, ...UNTRUSTED_CONTENT };
}

async function calendarCreate({ calendarId = 'primary', summary, description = '', start, end, attendees = [], account }) {
  assertActive('calendar.create');
  /* Validation precedes credential resolution; see gmailSend above. */
  validateCalendarCreate({ summary, start, end, attendees });
  const keys = oauthKeysFor(account);
  const body = { summary, description, start: { dateTime: start }, end: { dateTime: end } };
  if (attendees.length) body.attendees = attendees.map(email => ({ email }));
  const result = (await authenticatedRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }, keys)).body;
  record('calendar.create', result.id || summary, { account: keys.account, calendarId, summary, start, end, attendeeCount: body.attendees ? body.attendees.length : 0 });
  return { ...result, ...UNTRUSTED_CONTENT };
}

module.exports = {
  gmailList, gmailSend, calendarList, calendarCreate, buildMimeEmail,
  MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ENCODED_MESSAGE_BYTES
};
