// EXECUTABLE CHANGE
//
// DISCRIMINATION REPORT (testcanfail-tests-providers-google-suite-google-oauth-access-token-js)
// Suspect: the refresh assertions accepted the token endpoint mock's response
// without proving that the subject sent the OAuth refresh grant. Mutation:
// replace the production request body with `form({})`. Before this change the
// test stayed green: "google-oauth access-token absence: 5 checks passed".
// The strengthened assertion makes that mutation RED (quoted output):
// "AssertionError [ERR_ASSERTION]: refresh must submit the complete OAuth"
// "refresh-token grant" / "+ actual - expected" / "+       body: {},"
// The production file was restored byte-for-byte (SHA-256
// 34e26656e7c260f8ab2e5b7c56c2aee5846ff7a7708492eee93aa110300e5bfb).
// Final green run: "google-oauth access-token absence: 5 checks passed".
// NOT-FOUND: empty loop/forEach; exit-status or truthy-return-only evidence;
// swallowed failure via try/catch or optional chaining; mock of google-oauth
// itself; skip or platform precondition guard; expected value computed by the
// same production code. Preconditions unmet: none.

'use strict';

// ABSENCE IS NOT A QUESTION FOR THE OWNER.
//
// src/lib/google-oauth.js resolves a short-lived Google access token, minting a
// new one from the refresh token whenever the cached one is missing or stale.
// Missing is the ordinary case -- the token lives about an hour -- yet every MCP
// tool handler runs inside an ENABLED credential-prompt context
// (src/lib/tool-registry.js wraps each handler in withCredentialPrompt), and in
// that context runtime.js's getSecret() escalates SECRET_NOT_CONFIGURED into a
// queued owner credential request instead of returning. optionalSecret()
// rethrows OWNER_PROMPT_* on purpose, so the escalation aborted the very call
// that was one line away from refreshing successfully.
//
// Measured on the owner's machine 2026-08-11: with a valid refresh token and
// client credentials in the vault, deleting ONLY google_access_token__acctb
// made drive.find fail through the live MCP surface; restoring the cached token
// made it pass again.
//
// These checks pin the ABSENCE behaviour of every credential this function
// reads. They never touch the real vault, the real owner-prompt queue, or the
// network: runtime and http are stubbed through the Module._load pattern this
// suite already uses (see gmail-send-failure.js).

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const libRoot = path.resolve(__dirname, '..', '..', 'src', 'lib');
const oauthModulePath = require.resolve('../../src/lib/google-oauth');
const originalLoad = Module._load;

const KEYS = Object.freeze({
  accessKey: 'google_access_token__acct',
  refreshKey: 'google_refresh_token__acct',
  clientIdKey: 'google_client_id',
  clientSecretKey: 'google_client_secret'
});

// Faithful stand-in for runtime.js getSecret() in the WORST-CASE context: a
// prompt context is enabled, so any absent key that is not read with
// `prompt: false` escalates rather than returning.
function makeRuntime(present) {
  const escalated = [];
  const stored = [];
  return {
    escalated,
    stored,
    module: {
      getSecret(key, options = {}) {
        if (Object.prototype.hasOwnProperty.call(present, key)) return present[key];
        const absent = new Error(`Secret '${key}' is not configured.`);
        absent.code = 'SECRET_NOT_CONFIGURED';
        if (options && options.prompt === false) throw absent;
        escalated.push(key);
        const queued = new Error('Owner credential input is queued.');
        queued.code = 'OWNER_PROMPT_QUEUED';
        throw queued;
      },
      setSecret(key, value) { stored.push({ key, value }); }
    }
  };
}

function loadOauthWith(runtimeModule, httpModule) {
  Module._load = function load(request, parent, isMain) {
    if (parent && path.dirname(parent.filename) === libRoot) {
      if (request === './runtime') return runtimeModule;
      if (request === './http') return httpModule;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[oauthModulePath];
  try { return require('../../src/lib/google-oauth'); }
  finally { Module._load = originalLoad; }
}

// accessToken() is not exported, so it is driven through the module's real
// public entry point. The transport answers the token endpoint with a freshly
// minted value and records the authorization header the API call was handed.
// google-oauth.js destructures `request`/`form` at require time, so this object
// must be complete BEFORE the module is loaded -- patching it afterwards would
// silently do nothing.
function refreshingHttp(accessTokenValue) {
  const state = { tokenCalls: 0, tokenRequests: [], authorizations: [] };
  state.module = {
    form(fields) { return fields; },
    async request(url, init) {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        state.tokenCalls += 1;
        state.tokenRequests.push({ url: String(url), init });
        return { body: { access_token: accessTokenValue, expires_in: 3599 } };
      }
      state.authorizations.push(init && init.headers && init.headers.authorization);
      return { body: { ok: true } };
    }
  };
  return state;
}

async function resolveThroughAuthenticatedRequest(oauth, http) {
  await oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS);
  return http.authorizations[http.authorizations.length - 1];
}

(async () => {
  // 1. The cached access token is ABSENT and everything needed to mint one is
  //    present. This must refresh silently. Nothing may be escalated to the
  //    owner -- least of all the access token, which he has never held a copy of.
  {
    const runtime = makeRuntime({
      [KEYS.refreshKey]: 'refresh-value',
      [KEYS.clientIdKey]: 'client-id-value',
      [KEYS.clientSecretKey]: 'client-secret-value'
    });
    const http = refreshingHttp('minted-access-token');
    const oauth = loadOauthWith(runtime.module, http.module);
    const authorization = await resolveThroughAuthenticatedRequest(oauth, http);
    assert.equal(authorization, 'Bearer minted-access-token');
    assert.deepEqual(http.tokenRequests, [{
      url: 'https://oauth2.googleapis.com/token',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'refresh-value',
          client_id: 'client-id-value',
          client_secret: 'client-secret-value'
        }
      }
    }], 'refresh must submit the complete OAuth refresh-token grant');
    assert.deepEqual(runtime.escalated, [], 'an absent access token must never become an owner credential request');
    assert.deepEqual(runtime.stored, [{ key: KEYS.accessKey, value: 'minted-access-token' }]);
  }

  // 2. An EMPTY STRING is absence wearing a value's clothes. A falsy cached
  //    token must send the caller down the refresh path, never be handed to
  //    Google as a bearer credential.
  {
    const runtime = makeRuntime({
      [KEYS.accessKey]: '',
      [KEYS.refreshKey]: 'refresh-value',
      [KEYS.clientIdKey]: 'client-id-value',
      [KEYS.clientSecretKey]: 'client-secret-value'
    });
    const http = refreshingHttp('minted-after-empty');
    const oauth = loadOauthWith(runtime.module, http.module);
    const authorization = await resolveThroughAuthenticatedRequest(oauth, http);
    assert.equal(authorization, 'Bearer minted-after-empty');
    assert.deepEqual(http.tokenRequests[0].init.body, {
      grant_type: 'refresh_token',
      refresh_token: 'refresh-value',
      client_id: 'client-id-value',
      client_secret: 'client-secret-value'
    });
    assert.deepEqual(runtime.escalated, []);
  }

  // 3. No refresh token at all: the honest outcome is the typed "run the login
  //    flow" failure. The owner must NOT be asked for a refresh token he cannot
  //    produce, and must not be asked for client credentials that could not mint
  //    anything without it.
  {
    const runtime = makeRuntime({
      [KEYS.clientIdKey]: 'client-id-value',
      [KEYS.clientSecretKey]: 'client-secret-value'
    });
    const http = refreshingHttp('never-used');
    const oauth = loadOauthWith(runtime.module, http.module);
    await assert.rejects(
      () => oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS),
      error => {
        assert.match(error.message, /No access token or complete refresh-token credentials are available/);
        assert.equal(error.code, 'GOOGLE_OAUTH_NOT_CONFIGURED');
        assert.match(error.message, /Complete the selected Google account sign-in/);
        const taxonomy = require('../../src/lib/error-taxonomy');
        const failure = taxonomy.publicFailure(taxonomy.adaptProviderError(error));
        assert.equal(failure.code, 'INPUT_REQUIRED');
        assert.equal(failure.retryable, false);
        return true;
      }
    );
    assert.deepEqual(runtime.escalated, [], 'neither the access token nor the refresh token is owner-suppliable');
    assert.equal(http.tokenCalls, 0, 'no token exchange may be attempted without a refresh token');
  }

  // 4. The client id and client secret ARE owner-suppliable, and that path is
  //    deliberately preserved: with a refresh token present but no client
  //    credentials, the prompt still fires and its typed code still propagates.
  //    This is what keeps check 1 from being satisfied by simply swallowing
  //    every prompt error.
  {
    const runtime = makeRuntime({ [KEYS.refreshKey]: 'refresh-value' });
    const http = refreshingHttp('never-used');
    const oauth = loadOauthWith(runtime.module, http.module);
    await assert.rejects(
      () => oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS),
      error => {
        assert.equal(error.code, 'OWNER_PROMPT_QUEUED');
        return true;
      }
    );
    assert.deepEqual(runtime.escalated, [KEYS.clientIdKey]);
  }

  // 5. A cached token that Google REJECTS (HTTP 401) is re-minted, and the
  //    forced re-read of the rejected token must not prompt either.
  {
    const runtime = makeRuntime({
      [KEYS.accessKey]: 'stale-access-token',
      [KEYS.refreshKey]: 'refresh-value',
      [KEYS.clientIdKey]: 'client-id-value',
      [KEYS.clientSecretKey]: 'client-secret-value'
    });
    const seen = [];
    const httpModule = {
      form(fields) { return fields; },
      async request(url, init) {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return { body: { access_token: 'reminted-access-token', expires_in: 3599 } };
        }
        const authorization = init && init.headers && init.headers.authorization;
        seen.push(authorization);
        if (authorization === 'Bearer stale-access-token') throw new Error('HTTP 401 Unauthorized');
        return { body: { ok: true } };
      }
    };
    const oauth = loadOauthWith(runtime.module, httpModule);
    await oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS);
    assert.deepEqual(seen, ['Bearer stale-access-token', 'Bearer reminted-access-token']);
    assert.deepEqual(runtime.escalated, []);
    assert.deepEqual(runtime.stored, [{ key: KEYS.accessKey, value: 'reminted-access-token' }]);
  }

  // 6. A vault READ FAILURE is not evidence that a secret is absent. The old
  //    catch collapsed an untyped storage failure into an empty access token,
  //    then continued to refresh (or reported credentials unavailable). It
  //    must instead preserve the uncertainty by returning the original error.
  {
    const vaultFailure = new Error('DPAPI vault could not be read');
    const runtimeModule = {
      getSecret() { throw vaultFailure; },
      setSecret() { throw new Error('unreachable'); }
    };
    const http = refreshingHttp('never-used');
    const oauth = loadOauthWith(runtimeModule, http.module);
    await assert.rejects(
      () => oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS),
      error => error === vaultFailure
    );
    assert.equal(http.tokenCalls, 0, 'an unreadable vault must not be treated as missing credentials');
  }

  // 7. A rejected cached token without a refresh credential needs sign-in,
  //    not another request carrying the rejected token or a generic failure.
  {
    const runtime = makeRuntime({ [KEYS.accessKey]: 'rejected-cached-value' });
    const requests = [];
    const oauth = loadOauthWith(runtime.module, {
      form(fields) { return fields; },
      async request(url, init) {
        requests.push({ url, authorization: init.headers.authorization });
        throw new Error('HTTP 401 Unauthorized');
      }
    });
    await assert.rejects(() => oauth.authenticatedRequest('https://www.googleapis.com/drive/v3/files', {}, KEYS), error => {
      assert.equal(error.code, 'GOOGLE_OAUTH_SIGN_IN_REQUIRED');
      assert.match(error.message, /Complete the selected Google account sign-in/);
      const taxonomy = require('../../src/lib/error-taxonomy');
      const failure = taxonomy.publicFailure(taxonomy.adaptProviderError(error));
      assert.equal(failure.code, 'AUTH_EXPIRED');
      assert.equal(failure.retryable, false);
      return true;
    });
    assert.deepEqual(requests, [{ url: 'https://www.googleapis.com/drive/v3/files', authorization: 'Bearer rejected-cached-value' }]);
    assert.deepEqual(runtime.escalated, []);
    assert.deepEqual(runtime.stored, []);
  }

  console.log('google-oauth access-token absence: 7 checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
