'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const googleModulePath = require.resolve('../src/lib/providers/google');
const providerRoot = path.dirname(googleModulePath);
let auditWrites = 0;
let transportCalls = 0;
let credentialLookups = 0;

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && path.dirname(parent.filename) === providerRoot) {
    if (request === '../policy') return { assertActive() {} };
    if (request === '../audit') return { record() { auditWrites += 1; } };
    if (request === '../google-accounts') {
      return { oauthKeysFor() { credentialLookups += 1; return { account: 'oversize-test' }; } };
    }
    if (request === '../google-oauth') {
      return { authenticatedRequest: async () => { transportCalls += 1; return { body: { id: 'must-not-send' } }; } };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[googleModulePath];
let google;
try {
  google = require('../src/lib/providers/google');
} finally {
  Module._load = originalLoad;
}

(async () => {
  const attachment = Buffer.alloc(google.MAX_ATTACHMENT_TOTAL_BYTES, 0xa5);
  let refusal;
  try {
    await google.gmailSend({
      to: 'recipient@example.com',
      subject: 'Oversized encoded message',
      text: 'body',
      attachments: [{ filename: 'payload.bin', content: attachment }]
    });
  } catch (error) {
    refusal = error;
  }

  assert.ok(refusal, 'gmailSend must refuse an encoded message over the send limit');
  assert.equal(refusal.code, 'GMAIL_MESSAGE_TOO_LARGE');
  assert.match(refusal.message, /^The encoded message is \d+ bytes; the limit is 5000000 bytes for users\.messages\.send\.$/);
  assert.equal(credentialLookups, 1, 'the driven gmailSend path should resolve its account once');
  assert.equal(transportCalls, 0, 'refusal must happen before the Gmail transport is invoked');
  assert.equal(auditWrites, 0, 'refusal must not claim a send or failed transport in the audit log');
  console.log('ok - GMAIL_MESSAGE_TOO_LARGE is returned before transport or audit writes');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
