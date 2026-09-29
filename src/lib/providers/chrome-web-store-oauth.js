'use strict';

// Owner-interactive authorization for the one Chrome Web Store identity. This
// path deliberately does not reuse generic Google OAuth keys or the refresh
// helper: a new authorization is capability-verified before vault persistence.
const crypto = require('node:crypto');
const http = require('node:http');
const { form, request } = require('../http');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { getSecret, setSecretPair } = require('../runtime');
const googleAccounts = require('../google-accounts');
const { applyGoogleAccount } = require('../browser-account-url');
const browserOwner = require('../browser-owner');
const { protectedStoreItemId } = require('./chrome-web-store');

const ACCOUNT_ALIAS = 'configured_cws_login';
const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALLBACK_PATH = '/toolsenabled/cws/oauth2/callback';
const TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_KEYS = Object.freeze({
  clientId: 'cws_client_id', clientSecret: 'cws_client_secret', publisherId: 'cws_publisher_id',
  accessToken: 'cws_access_token', refreshToken: 'cws_refresh_token'
});
const SAFE_ERROR_MESSAGES = Object.freeze({
  CWS_OAUTH_CONFIGURATION_MISSING: 'Chrome Web Store OAuth configuration is incomplete. Add the fixed client and publisher ID configuration to the local DPAPI vault, then retry. No browser was opened.',
  CWS_OAUTH_CONFIGURATION_LOOKUP_FAILED: 'Chrome Web Store OAuth configuration could not be read. This is NOT claiming that the configuration is absent; retry when the machine is available. No browser was opened.'
});

function oauthError(code = 'CWS_OAUTH_FAILED') {
  const error = new Error(SAFE_ERROR_MESSAGES[code] || 'Chrome Web Store OAuth authorization did not complete safely.');
  error.code = code;
  return error;
}
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function randomVerifier(randomBytes = crypto.randomBytes) { return base64url(randomBytes(32)); }
function codeChallenge(verifier) { return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'); }
function authorizationMaterial(randomBytes = crypto.randomBytes) {
  const state = base64url(randomBytes(32));
  const verifier = randomVerifier(randomBytes);
  return { state, verifier, challenge: codeChallenge(verifier) };
}
function authorizationUrl({ clientId, redirectUri, state, challenge, loginHint }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: CWS_SCOPE, state,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', login_hint: loginHint
  }).toString();
  return url.toString();
}
function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      server.close(error => { if (error) reject(error); else resolve(); });
    } catch (error) { reject(error); }
  });
}
function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port)) reject(oauthError('CWS_OAUTH_CALLBACK_BIND_FAILED'));
      else resolve(address.port);
    };
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
}
function fixedAccount(accounts = googleAccounts) {
  let account;
  try { account = accounts.cwsLoginAccount(); }
  catch { throw oauthError('CWS_OAUTH_CONFIGURATION_LOOKUP_FAILED'); }
  if (!account || typeof account.alias !== 'string' || typeof account.email !== 'string' || !account.email.includes('@')) {
    throw oauthError('CWS_OAUTH_ACCOUNT_NOT_CONFIGURED');
  }
  return Object.freeze({ alias: account.alias, email: account.email });
}
function fixedCredentials(read = getSecret) {
  let clientId; let clientSecret; let publisherId;
  try {
    clientId = read(OAUTH_KEYS.clientId, { prompt: false });
    clientSecret = read(OAUTH_KEYS.clientSecret, { prompt: false });
    publisherId = read(OAUTH_KEYS.publisherId, { prompt: false });
  } catch { throw oauthError('CWS_OAUTH_CONFIGURATION_LOOKUP_FAILED'); }
  if (!clientId || !clientSecret || !publisherId) throw oauthError('CWS_OAUTH_CONFIGURATION_MISSING');
  return { clientId, clientSecret, publisherId };
}
function callbackRequest(incoming, port) {
  if (incoming.method !== 'GET') return { kind: 'reject' };
  const expectedHost = `127.0.0.1:${port}`;
  if (String(incoming.headers.host || '').toLowerCase() !== expectedHost) return { kind: 'reject' };
  let url;
  try { url = new URL(incoming.url, `http://${expectedHost}`); } catch { return { kind: 'reject' }; }
  if (url.pathname !== CALLBACK_PATH || url.searchParams.getAll('state').length !== 1) return { kind: 'reject' };
  if (url.searchParams.get('error') !== null) return { kind: 'denied', state: url.searchParams.get('state') };
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) return { kind: 'reject' };
  return { kind: 'code', state: url.searchParams.get('state'), code: codes[0] };
}
function sameState(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  // Compare BYTE lengths, not JS string lengths. timingSafeEqual throws a
  // RangeError on buffers of unequal byte length, and a string-length check
  // does not prove that: a crafted callback `state` with the same character
  // count but a multi-byte character produced buffers of different byte
  // length, and the resulting throw escaped the synchronous request listener
  // as an uncaught exception — any local process that could reach the
  // loopback callback port could crash the broker mid-authorization.
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
async function exchangeAndVerify({ code, verifier, redirectUri, credentials }, dependencies) {
  const send = dependencies.request || request;
  const active = dependencies.assertActive || assertActive;
  active('chromeWebStore.oauthAuthorize.exchange', { provider: 'chromeWebStore' });
  let token;
  try {
    token = (await send(TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    })).body;
  } catch { throw oauthError('CWS_OAUTH_TOKEN_EXCHANGE_FAILED'); }
  if (!token || typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token) {
    throw oauthError('CWS_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
  active('chromeWebStore.oauthAuthorize.verify', { provider: 'chromeWebStore' });
  // This whole flow exists to authorize that one fixed item, so an unconfigured
  // installation cannot complete it and must say so rather than build a URL
  // around an empty id and let the API answer with something confusing.
  const fixedItemId = protectedStoreItemId();
  if (!fixedItemId) throw oauthError('CWS_OAUTH_CAPABILITY_VERIFICATION_FAILED');
  const statusUrl = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(fixedItemId)}:fetchStatus`;
  try { await send(statusUrl, { headers: { authorization: `Bearer ${token.access_token}` } }); }
  catch { throw oauthError('CWS_OAUTH_CAPABILITY_VERIFICATION_FAILED'); }
  return token;
}
async function authorize(dependencies = {}) {
  const active = dependencies.assertActive || assertActive;
  const writePair = dependencies.setSecretPair || setSecretPair;
  const audit = dependencies.record || record;
  const owner = dependencies.browserOwner || browserOwner;
  const accounts = dependencies.googleAccounts || googleAccounts;
  const createServer = dependencies.createServer || http.createServer;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const timeoutMs = Number.isSafeInteger(dependencies.timeoutMs) ? dependencies.timeoutMs : TIMEOUT_MS;
  if (timeoutMs < 1000 || timeoutMs > TIMEOUT_MS) throw oauthError('CWS_OAUTH_TIMEOUT_INVALID');
  active('chromeWebStore.oauthAuthorize', { provider: 'chromeWebStore' });
  const account = fixedAccount(accounts);
  const credentials = fixedCredentials(dependencies.getSecret || getSecret);
  const material = authorizationMaterial(dependencies.randomBytes || crypto.randomBytes);
  let server; let timer; let settled = false; let callbackConsumed = false; let resolveAuthorization; let rejectAuthorization;
  const complete = async (error, value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimer(timer);
    let completionError = error;
    try { await closeServer(server); }
    catch { completionError ||= oauthError(); }
    if (completionError) rejectAuthorization(completionError); else resolveAuthorization(value);
  };
  const authorization = new Promise((resolve, reject) => { resolveAuthorization = resolve; rejectAuthorization = reject; });
  try {
    server = createServer((incoming, response) => {
      const callback = callbackRequest(incoming, server.address() && server.address().port);
      if (callback.kind === 'reject' || !sameState(callback.state, material.state) || callbackConsumed) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end('Authorization callback rejected.'); return;
      }
      callbackConsumed = true;
      if (callback.kind === 'denied') {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end('Authorization was not completed.');
        void complete(oauthError('CWS_OAUTH_DENIED')); return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end('Authorization received. You may close this window.');
      void (async () => {
        try {
          const port = server.address().port;
          const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
          const token = await exchangeAndVerify({ code: callback.code, verifier: material.verifier, redirectUri, credentials }, dependencies);
          audit('chromeWebStore.oauthAuthorize', 'configured-cws-login', { scope: CWS_SCOPE, capabilityVerified: true });
          active('chromeWebStore.oauthAuthorize.store', { provider: 'chromeWebStore' });
          writePair(OAUTH_KEYS.refreshToken, token.refresh_token, OAUTH_KEYS.accessToken, token.access_token);
          await complete(null, { authorized: true, account: ACCOUNT_ALIAS, scope: CWS_SCOPE, capabilityVerified: true });
        } catch (error) {
          await complete(error && typeof error.code === 'string' && error.code.startsWith('CWS_OAUTH_') ? error : oauthError());
        }
      })();
    });
    const port = await listenLoopback(server);
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const url = authorizationUrl({ clientId: credentials.clientId, redirectUri, state: material.state, challenge: material.challenge, loginHint: account.email });
    active('chromeWebStore.oauthAuthorize.launch', { provider: 'chromeWebStore' });
    owner.start(applyGoogleAccount(url, account.email));
    timer = setTimer(() => { void complete(oauthError('CWS_OAUTH_TIMEOUT')); }, timeoutMs);
    return await authorization;
  } catch (error) {
    await complete(error && typeof error.code === 'string' && error.code.startsWith('CWS_OAUTH_') ? error : oauthError());
    return authorization;
  }
}
module.exports = { ACCOUNT_ALIAS, CALLBACK_PATH, CWS_SCOPE, OAUTH_KEYS, SAFE_ERROR_MESSAGES, TIMEOUT_MS, authorizationMaterial, authorizationUrl, authorize, callbackRequest, codeChallenge, fixedAccount, fixedCredentials, sameState };
