'use strict';

// gmailSend() previously audited only a successful send: a future token
// expiry, revoked grant, or Gmail API failure would leave zero trace in the
// signed ledger. This test proves the fix with an injected failing
// transport, following provider-untrusted-content.js's established
// Module._load stubbing pattern (this file never reaches Google or the
// network) and mirroring the `<action>.failed` / typed `code` convention
// already used by firebase.js's accountLogin() and vertex-gemini.js's
// geminiComplete().

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const providerRoot = path.resolve(__dirname, '..', '..', 'src', 'lib', 'providers');
const googleModulePath = require.resolve('../../src/lib/providers/google');
const originalLoad = Module._load;

const gmailBase = { to: 'to@example.com', subject: 'subject', text: 'body' };

// Loads a fresh copy of google.js with the given google-oauth/audit stubs.
// A fresh require (via a cache-clear) is necessary each time because
// Module._load is only consulted the first time a module is resolved.
function loadGoogleWith({ authenticatedRequest, record }) {
  Module._load = function load(request, parent, isMain) {
    if (parent && path.dirname(parent.filename) === providerRoot) {
      if (request === '../policy') return { assertActive() {} };
      if (request === '../audit') return { record };
      if (request === '../google-accounts') return { oauthKeysFor() { return { account: 'accta' }; } };
      if (request === '../google-oauth') return { authenticatedRequest };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[googleModulePath];
  try { return require('../../src/lib/providers/google'); }
  finally { Module._load = originalLoad; }
}

async function expectFailedSend(transportError, expectedCode) {
  const recorded = [];
  const google = loadGoogleWith({
    authenticatedRequest: async () => { throw transportError; },
    record: (action, target, details) => recorded.push({ action, target, details })
  });
  await assert.rejects(google.gmailSend({ ...gmailBase }), error => error === transportError);
  const failureRecords = recorded.filter(entry => entry.action === 'gmail.send.failed');
  const successRecords = recorded.filter(entry => entry.action === 'gmail.send');
  assert.equal(successRecords.length, 0, 'a failed send must never also write a success record');
  assert.equal(failureRecords.length, 1, 'a failed send must write exactly one failure record');
  const entry = failureRecords[0];
  assert.equal(entry.target, gmailBase.to, 'the failure target falls back to the recipient, same as the success path');
  assert.deepEqual(Object.keys(entry.details).sort(), ['bcc', 'cc', 'code', 'hasHtml', 'subject', 'to'].sort(),
    'failure details must carry only the same safe fields as a success record, plus a typed code -- never a raw message or stack');
  assert.equal(entry.details.code, expectedCode);
  assert.equal(entry.details.to, gmailBase.to);
  assert.equal(entry.details.subject, gmailBase.subject);
  assert.equal(entry.details.hasHtml, false);
}

(async () => {
  try {
    // An already-typed error (e.g. a credential helper's CREDENTIAL_* code,
    // or http.js's HTTP_REDIRECT_REFUSED) is preserved as-is.
    await expectFailedSend(
      Object.assign(new Error('Access token was rejected.'), { code: 'CREDENTIAL_UNAVAILABLE' }),
      'CREDENTIAL_UNAVAILABLE'
    );

    // A bare HTTP failure (token expiry surfaces as Gmail returning 401,
    // matching http.js's `HTTP <status> <statusText>: <detail>` error shape)
    // is reduced to a bounded, safe status-only code -- never the raw
    // response detail, which can contain Gmail's own error text.
    await expectFailedSend(
      new Error('HTTP 401 Unauthorized: {"error":{"message":"Invalid Credentials"}}'),
      'GMAIL_SEND_HTTP_401'
    );
    await expectFailedSend(
      new Error('HTTP 500 Internal Server Error: {"error":{"message":"Backend Error"}}'),
      'GMAIL_SEND_HTTP_500'
    );

    // A request timeout (AbortError, matching http.js's AbortController
    // usage) gets its own code rather than falling into the generic bucket.
    await expectFailedSend(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      'GMAIL_SEND_TIMEOUT'
    );

    // Anything unclassifiable still gets a bounded fallback code, never the
    // raw message.
    await expectFailedSend(new Error('socket hang up'), 'GMAIL_SEND_FAILED');

    // The original error must reach the caller unchanged: metering a
    // failure must never replace or reshape what the caller actually sees.
    // (Covered by the `error === transportError` identity check inside
    // expectFailedSend() above for every case; asserted once more explicitly
    // here for a case with no typed code at all.)
    const bareError = new Error('HTTP 403 Forbidden: quota exceeded');
    const bareGoogle = loadGoogleWith({
      authenticatedRequest: async () => { throw bareError; },
      record: () => {}
    });
    await assert.rejects(bareGoogle.gmailSend({ ...gmailBase }), error => {
      assert.equal(error, bareError, 'the exact original error instance must propagate, not a wrapped copy');
      return true;
    });

    // A meter/audit-write failure must never mask or replace the original
    // send failure (best-effort, matching vertex-gemini.js's
    // `/* preserve original failure */` convention).
    const transportError = new Error('HTTP 401 Unauthorized: expired');
    const brokenAuditGoogle = loadGoogleWith({
      authenticatedRequest: async () => { throw transportError; },
      record: () => { throw new Error('synthetic audit outage'); }
    });
    await assert.rejects(brokenAuditGoogle.gmailSend({ ...gmailBase }), error => error === transportError,
      'the send failure must still surface even though the audit write for it also failed');

    // Regression: the success path is unchanged -- still writes exactly one
    // gmail.send record, never a failure record.
    const successRecorded = [];
    const successGoogle = loadGoogleWith({
      authenticatedRequest: async () => ({ body: { id: 'sent-1' } }),
      record: (action, target, details) => successRecorded.push({ action, target, details })
    });
    const sendResult = await successGoogle.gmailSend({ ...gmailBase });
    assert.equal(sendResult.id, 'sent-1');
    assert.equal(successRecorded.filter(entry => entry.action === 'gmail.send').length, 1);
    assert.equal(successRecorded.filter(entry => entry.action === 'gmail.send.failed').length, 0);

    console.log('gmailSend failure-path audit tests passed (typed code classification, safe details, original error preserved, audit-write failure isolation, success regression).');
  } finally {
    Module._load = originalLoad;
    delete require.cache[googleModulePath];
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
