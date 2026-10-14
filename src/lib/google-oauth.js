'use strict';

// THIS IS THE CAPABILITY LAYER'S GOOGLE OAUTH. IT IS NOT PRODUCT SIGN-IN, AND
// IT MUST NOT BE REUSED AS ONE.
//
// What this file is for: letting the OWNER's own agents call Google APIs AS
// HIM. It is a CONFIDENTIAL-CLIENT refresh-token flow -- it reads
// `google_client_secret` from the vault on this machine and exchanges a
// long-lived refresh token for access tokens with Drive/Gmail/Calendar scopes.
// That is correct here: this runs on his computer, the secret is his, and the
// vault is DPAPI-sealed to his Windows login.
//
// Every one of those properties is FALSE in the shipped desktop product:
//
//   - A client secret inside a program customers download is not a secret.
//     Anything in the artifact is public, whatever it is called.
//   - A refresh token is a durable credential to somebody's Google account. The
//     product calls no Google API on a customer's behalf, so storing one would
//     be keeping a key to their mail in exchange for nothing.
//   - Drive/Gmail/Calendar scopes drag whoever asks for them into Google's
//     sensitive-scope verification. Sign-in needs none of them.
//
// The product's sign-in is a separate, public-client implementation in the app
// tree and shares no code with this file, deliberately:
//
//   desktop-app/shell/google-signin.cjs          authorization code + PKCE,
//                                                  loopback redirect, system
//                                                  browser, NO client secret,
//                                                  NO stored token
//   desktop-app/shell/google-oidc.cjs            id_token verified against
//                                                  Google's JWKS
//   desktop-app/docs/GOOGLE-SIGN-IN-SETUP.md     the owner's registration
//                                                  steps for the Desktop-app
//                                                  client id
//
// If you are here because you want to add sign-in somewhere, go there instead.

const { getSecret, setSecret } = require('./runtime');
const { request, form } = require('./http');

// `prompt: false` is not decoration. getSecret() turns a SECRET_NOT_CONFIGURED
// into a QUEUED OWNER CREDENTIAL REQUEST whenever it runs inside an enabled
// credential-prompt context, and every MCP tool handler runs inside one
// (src/lib/tool-registry.js wraps each handler in withCredentialPrompt). So for
// a value the owner could not possibly type, asking without prompt:false turns
// ordinary absence into an owner-facing question and a hard failure.
function optionalSecret(name, { prompt } = {}) {
  try { return getSecret(name, prompt === false ? { prompt: false } : {}); }
  catch (error) {
    // SECRET_NOT_CONFIGURED is the vault's definite statement that the value
    // is absent. A failed vault read establishes no such thing: propagate it
    // rather than collapsing an unreadable secret into an empty one.
    if (error && error.code === 'SECRET_NOT_CONFIGURED') return '';
    throw error;
  }
}

// Resolves a short-lived Google access token. A current access token is preferred;
// when absent or rejected, an optional refresh-token credential set renews it and
// stores the new token only in the local DPAPI vault.
async function accessToken({ accessKey, refreshKey, clientIdKey, clientSecretKey, forceRefresh = false }) {
  // THE ACCESS TOKEN AND THE REFRESH TOKEN ARE BOTH MACHINE-MINTED.
  //
  // The access token is what this function exists to produce; it lives about an
  // hour and the owner has never seen a copy. The refresh token comes only from
  // the consent flow in tools/google-oauth-login.js. Neither is something a
  // human can supply at a prompt, so the ABSENCE of either must resolve to
  // "empty, go refresh" -- never to a queued owner request.
  //
  // Measured on this machine 2026-08-11: with a valid refresh token and client
  // credentials in the vault, deleting ONLY google_access_token__<alias> made
  // drive.find fail through the MCP surface. The empty cache raised
  // SECRET_NOT_CONFIGURED, the enabled prompt context escalated it into an owner
  // request, optionalSecret() rethrew the OWNER_PROMPT_* code by design, and the
  // refresh that would have fixed everything one line later never ran. With an
  // unrelated request already queued the escalation returned
  // OWNER_PROMPT_DIFFERENT_ACTIVE instead, so every Drive/Gmail/Calendar call
  // failed for as long as that unrelated request sat unanswered.
  const existing = optionalSecret(accessKey, { prompt: false });
  if (existing && !forceRefresh) return existing;
  const refreshToken = optionalSecret(refreshKey, { prompt: false });
  // The client id/secret ARE owner-suppliable, so they keep the prompt. But ask
  // only once a refresh is actually possible: without a refresh token those two
  // values cannot mint anything, and prompting for them would ask the owner for
  // something that cannot fix the failure he is looking at.
  const clientId = refreshToken ? optionalSecret(clientIdKey) : '';
  const clientSecret = refreshToken ? optionalSecret(clientSecretKey) : '';
  if (!refreshToken || !clientId || !clientSecret) {
    if (existing && !forceRefresh) return existing;
    const error = new Error((forceRefresh
      ? `Access token '${accessKey}' was rejected and complete refresh-token credentials are unavailable.`
      : `No access token or complete refresh-token credentials are available for '${accessKey}'.`)
      + ' Complete the selected Google account sign-in before retrying.');
    error.code = forceRefresh ? 'GOOGLE_OAUTH_SIGN_IN_REQUIRED' : 'GOOGLE_OAUTH_NOT_CONFIGURED';
    throw error;
  }
  const result = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
  });
  if (!result.body.access_token) throw new Error('Google OAuth refresh did not return an access token.');
  setSecret(accessKey, result.body.access_token);
  return result.body.access_token;
}

async function authenticatedRequest(url, init, keys) {
  const run = async forceRefresh => request(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${await accessToken({ ...keys, forceRefresh })}` }
  });
  try { return await run(false); }
  catch (error) {
    if (!/^HTTP 401\b/.test(error.message || '')) throw error;
    return run(true);
  }
}

module.exports = { authenticatedRequest };
