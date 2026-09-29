'use strict';

// Google Drive provider. Reuses the shared OAuth refresh-token machinery
// (src/lib/google-oauth.js): a refresh token is minted ONCE via the interactive
// consent flow (tools/google-oauth-login.js) and stored in the DPAPI vault.
// Every subsequent call mints a short-lived access token with NO password, NO
// Duo, and NO PIN — refreshing an OAuth token never re-triggers MFA.

const fs = require('fs');
const path = require('path');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { authenticatedRequest } = require('../google-oauth');
const { oauthKeysFor } = require('../google-accounts');
const { HostControlError, resolveHostPath } = require('./host-control');

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

// Minimal extension -> MIME map; unknown types fall back to octet-stream, which
// Drive accepts and stores faithfully.
const MIME_BY_EXT = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function mimeForFile(filePath, override) {
  if (override) return String(override);
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function assertFolderId(folderId) {
  if (folderId === undefined || folderId === null || folderId === '') return null;
  if (typeof folderId !== 'string' || !DRIVE_ID.test(folderId)) {
    throw new Error('folderId must be a Google Drive file ID (letters, digits, underscore, hyphen).');
  }
  return folderId;
}

function driveUploadFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// CONTAINMENT, before any stat or read. Identical treatment to
// providers/google.js's gmailSend attachments (see that file's
// attachmentPathFailure for the fuller comment): reuses host-control.js's
// resolveHostPath, the same fence host.read_file already enforces on the
// owner's profile tree including its credential-store exclusion, rather than
// inventing a second path validator for this provider.
function driveUploadPathFailure(error, requestedPath) {
  if (!(error instanceof HostControlError)) throw error;
  if (error.code === 'HOST_PATH_NOT_FOUND') {
    return driveUploadFailure('DRIVE_UPLOAD_NOT_FOUND', `File not found: ${requestedPath}`);
  }
  if (error.code === 'HOST_PATH_OUTSIDE_PROFILE') {
    return driveUploadFailure('DRIVE_UPLOAD_OUTSIDE_PROFILE', `filePath is outside the owner profile tree and cannot be uploaded: ${requestedPath}`);
  }
  if (error.code === 'HOST_PATH_FORBIDDEN') {
    return driveUploadFailure('DRIVE_UPLOAD_FORBIDDEN', `filePath names a bounded credential, session, or environment-secret store and is never uploaded: ${requestedPath}`);
  }
  return driveUploadFailure('DRIVE_UPLOAD_READ_UNAVAILABLE', `filePath could not be inspected or read: ${requestedPath}; this does NOT claim that the file is absent.`);
}

// Upload a local file into Drive, optionally parented to a shared folder.
// supportsAllDrives lets a file land in a Shared Drive folder; a folder that is
// merely "Shared with me" is addressed the same way by its ID.
async function driveUpload({ filePath, folderId = null, name, mimeType, account }) {
  assertActive('drive.upload');
  const keys = oauthKeysFor(account);
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('filePath is required.');
  let resolved;
  try {
    resolved = resolveHostPath(filePath, { mustExist: true });
  } catch (error) {
    throw driveUploadPathFailure(error, filePath);
  }
  const parent = assertFolderId(folderId);
  const displayName = (name && String(name).trim()) || path.basename(resolved);
  if (/[\r\n]/.test(displayName)) throw new Error('name must not contain CR or LF.');
  const contentType = mimeForFile(resolved, mimeType);
  const fileBytes = fs.readFileSync(resolved);

  const boundary = `toolsenabled-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = { name: displayName };
  if (parent) metadata.parents = [parent];
  const preamble = `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(preamble, 'utf8'), fileBytes, Buffer.from(epilogue, 'utf8')]);

  const url = 'https://www.googleapis.com/upload/drive/v3/files'
    + '?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,webViewLink';
  const result = (await authenticatedRequest(url, {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body
  }, keys)).body;

  record('drive.upload', result.id || displayName, {
    account: keys.account, name: displayName, folderId: parent, mimeType: contentType, bytes: fileBytes.length
  });
  return { ...result, account: keys.account, ...UNTRUSTED_CONTENT };
}

// Resolve a folder by name so callers never have to hand-copy an ID. Searches
// everything the account can see, including Shared Drives and "Shared with me".
async function driveFindFolder({ name, limit = 20, account }) {
  assertActive('drive.find');
  const keys = oauthKeysFor(account);
  if (typeof name !== 'string' || !name.trim()) throw new Error('name is required.');
  if (/['\\]/.test(name)) throw new Error('name must not contain quotes or backslashes.');
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', `mimeType = 'application/vnd.google-apps.folder' and name = '${name}' and trashed = false`);
  url.searchParams.set('fields', 'files(id,name,owners(displayName,emailAddress),driveId)');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('corpora', 'allDrives');
  url.searchParams.set('pageSize', String(Math.min(Math.max(Number(limit) || 20, 1), 100)));
  const result = (await authenticatedRequest(url, {}, keys)).body;
  if (!result || !Array.isArray(result.files)) {
    throw new Error('Google Drive folder search returned an invalid response: files must be an array.');
  }
  record('drive.find', name, { account: keys.account, resultCount: result.files.length });
  return { ...result, account: keys.account, ...UNTRUSTED_CONTENT };
}

// Permanently delete (trash-bypass) a Drive file by ID. Used for cleanup of
// agent-created artifacts; destructive and not reversible.
async function driveDelete({ fileId, account }) {
  assertActive('drive.delete');
  const keys = oauthKeysFor(account);
  if (typeof fileId !== 'string' || !DRIVE_ID.test(fileId)) throw new Error('fileId must be a Google Drive file ID.');
  await authenticatedRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: 'DELETE' }, keys);
  record('drive.delete', fileId, { account: keys.account });
  return { deleted: true, fileId, account: keys.account, ...UNTRUSTED_CONTENT };
}

module.exports = { driveUpload, driveFindFolder, driveDelete, mimeForFile };
