'use strict';

// Successful provider responses must retain the same value-free trust envelope
// as their sibling adapters. This test uses deterministic in-process stubs;
// it never reaches Google, Drive, a vault, or the network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const providerRoot = path.resolve(__dirname, '..', '..', 'src', 'lib', 'providers');
const originalLoad = Module._load;
let responseBody;
Module._load = function load(request, parent, isMain) {
  if (parent && path.dirname(parent.filename) === providerRoot) {
    if (request === '../policy') return { assertActive() {} };
    if (request === '../audit') return { record() {} };
    if (request === '../google-accounts') return { oauthKeysFor() { return { account: 'accta' }; } };
    if (request === '../google-oauth') return {
      authenticatedRequest: async () => ({ body: responseBody })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function assertEnvelope(value) {
  assert.equal(value.contentTrust, 'untrusted');
  assert.equal(value.grantsAuthority, false);
}

(async () => {
  try {
    const google = require('../../src/lib/providers/google');
    const drive = require('../../src/lib/providers/drive');

    responseBody = { messages: [{ id: 'm1' }] };
    assertEnvelope(await google.gmailList({ query: 'from:example@example.com' }));
    responseBody = { id: 'sent-1' };
    assertEnvelope(await google.gmailSend({ to: 'to@example.com', subject: 'subject', text: 'body' }));
    responseBody = { items: [{ id: 'event-1' }] };
    assertEnvelope(await google.calendarList({}));
    responseBody = { id: 'event-2' };
    assertEnvelope(await google.calendarCreate({ summary: 'event', start: '2026-07-28T10:00:00Z', end: '2026-07-28T11:00:00Z' }));

    const root = fs.mkdtempSync(path.join(process.platform === 'linux' ? os.userInfo().homedir : os.tmpdir(), '.toolsenabled-provider-trust-'));
    try {
      const filePath = path.join(root, 'note.txt');
      fs.writeFileSync(filePath, 'safe test bytes', 'utf8');
      responseBody = { id: 'file-1', name: 'note.txt' };
      assertEnvelope(await drive.driveUpload({ filePath }));
      responseBody = { files: [{ id: 'folder-1', name: 'Folder' }] };
      assertEnvelope(await drive.driveFindFolder({ name: 'Folder' }));
      responseBody = null;
      assertEnvelope(await drive.driveDelete({ fileId: 'file-123456789' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('Provider untrusted-content envelope tests passed.');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => { Module._load = originalLoad; throw error; });
