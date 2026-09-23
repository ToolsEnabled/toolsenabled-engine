'use strict';

// ONE-TIME interactive Google consent using the OAuth 2.0 "installed app"
// loopback flow (RFC 8252). Run this once per account:
//
//   node tools/google-oauth-login.js --client-id XXX
//   node tools/google-oauth-login.js            (reuses client id/secret already in the vault)
// A missing client id or secret is requested through the masked local vault
// workflow. Secret values are never accepted in process arguments.
//
// It opens Google's consent screen, captures the redirect on 127.0.0.1, exchanges
// the code for a REFRESH TOKEN, and stores everything in the DPAPI vault. From then
// on the Drive/Gmail/Calendar providers refresh access tokens silently: no password,
// no Duo, no PIN is ever requested again, because refreshing a token does not
// re-run interactive login or MFA. Revoke anytime at
// https://myaccount.google.com/permissions or with `secrets.ps1 del google_refresh_token`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getSecret, setSecret, withCredentialPrompt } = require('../src/lib/runtime');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const accounts = require('../src/lib/google-accounts');

function aliasFromEmail(email) {
  return String(email).split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'default';
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar'
];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function configuredEmail(account, registry = accounts) {
  const known = registry.load().accounts[account];
  return known && typeof known.email === 'string' && known.email.includes('@') ? known.email : '';
}

// This is a per-authorization-request hint. It never removes, reorders, or
// otherwise mutates the other Google accounts signed into the Chrome profile.
function resolveAccountSelection({ account: requestedAccount, email: requestedEmail } = {}, registry = accounts) {
  const explicitAccount = typeof requestedAccount === 'string' ? requestedAccount.trim() : '';
  const explicitEmail = typeof requestedEmail === 'string' ? requestedEmail.trim() : '';
  if (explicitAccount) {
    registry.assertAlias(explicitAccount);
    return { account: explicitAccount, email: explicitEmail || configuredEmail(explicitAccount, registry), source: 'explicit-account' };
  }
  if (explicitEmail) {
    return { account: aliasFromEmail(explicitEmail), email: explicitEmail, source: 'explicit-email' };
  }
  const account = registry.resolve();
  return { account, email: configuredEmail(account, registry), source: 'configured-default' };
}

function buildAuthorizationUrl({ clientId, redirectUri, scopes, state, loginHint = '' }) {
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: scopes, access_type: 'offline', prompt: 'consent', state,
    include_granted_scopes: 'true'
  });
  if (typeof loginHint === 'string' && loginHint.includes('@')) query.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

function optional(key) { return getSecret(key); }

const GOOGLE_OAUTH_CREDENTIAL_REQUEST = Object.freeze({
  requester: 'toolsenabled',
  requestContext: Object.freeze({
    purpose: 'Set up the local Google OAuth login flow',
    scope: 'Google Drive, Gmail, and Calendar OAuth client setup',
    lifetime: 'Until provider expiry, replacement, or revocation'
  })
});

function promptForCredential(key) {
  return withCredentialPrompt(
    () => getSecret(key, { prompt: true }),
    GOOGLE_OAUTH_CREDENTIAL_REQUEST
  );
}

function openBrowser(url) {
  // Best-effort; if it fails the URL is also printed for manual paste.
  // `cmd /c start` can still allocate a transient console on Windows even
  // when the parent requests `windowsHide`. Explorer accepts an HTTPS URL
  // directly and hands it to the default browser without a shell hop.
  try {
    spawn('explorer.exe', [url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      shell: false,
      env: safeLaunchEnvironment(process.env, { context: 'google-oauth-login browser' })
    }).unref();
  }
  catch { /* printed below */ }
}

async function exchange(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  return json;
}

async function main() {
  if (arg('--client-secret') !== undefined) {
    throw new Error('Refusing a Google OAuth client secret in process arguments. Re-run without --client-secret; the masked local vault workflow will request it if needed.');
  }
  let clientId = arg('--client-id') || optional('google_client_id');
  let clientSecret = optional('google_client_secret');
  if (!clientId) clientId = promptForCredential('google_client_id');
  if (!clientSecret) clientSecret = promptForCredential('google_client_secret');
  const scopes = (arg('--scopes') || DEFAULT_SCOPES.join(' ')).trim();
  let selection;
  try {
    selection = resolveAccountSelection({ account: arg('--account'), email: arg('--email') });
  } catch (error) {
    if (!error || !['GOOGLE_ACCOUNT_NOT_CONFIGURED', 'GOOGLE_ACCOUNT_NOT_FOUND'].includes(error.code)) {
      throw error;
    }
    console.error('A registered account alias is required when no configured default exists.\n'
      + 'Example: node tools/google-oauth-login.js --account personal --email you@example.com');
    process.exit(2);
  }
  const { account, email } = selection;
  const noOpen = process.argv.includes('--no-open');

  if (!clientId || !clientSecret) {
    console.error('Missing OAuth client credentials.\n\n'
      + 'Create a "Desktop app" OAuth client:\n'
      + '  1. https://console.cloud.google.com/  -> create/select a project\n'
      + '  2. APIs & Services -> Enable "Google Drive API" (and Gmail/Calendar if wanted)\n'
      + '  3. APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Desktop app\n'
      + '  4. Run this tool again. It will request each missing value through the masked local vault form.\n'
      + '       node tools/google-oauth-login.js --client-id <PUBLIC_CLIENT_ID>\n');
    process.exit(2);
  }

  // Persist the client credentials so future runs and the providers can refresh.
  setSecret('google_client_id', clientId);
  setSecret('google_client_secret', clientSecret);

  const state = require('crypto').randomBytes(16).toString('hex');
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const returnedState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      const authCode = u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      if (err || !authCode || returnedState !== state) {
        res.end('<h2>Authorization failed.</h2><p>You can close this tab and re-run the tool.</p>');
        server.close();
        reject(new Error(err || 'Missing or mismatched authorization code.'));
        return;
      }
      res.end('<h2>ToolsEnabled is authorized.</h2><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(authCode);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      server._redirectUri = redirectUri;
      const authUrl = buildAuthorizationUrl({ clientId, redirectUri, scopes, state, loginHint: email });
      console.error(`\nAuthorize account '${account}'${email ? ` (${email})` : ''}. If a browser does not open, paste this URL:\n`);
      console.log(authUrl);
      const urlFile = arg('--url-file') || path.join(__dirname, '..', 'logs', 'oauth-url.txt');
      try { fs.writeFileSync(urlFile, authUrl); } catch { /* console output is enough */ }
      // stash for the exchange step
      main._redirectUri = redirectUri;
      if (!noOpen) openBrowser(authUrl);
    });
  });

  const tokens = await exchange(code, clientId, clientSecret, main._redirectUri);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token. Remove the app at '
      + 'https://myaccount.google.com/permissions and re-run so the consent prompt reappears.');
  }
  setSecret(`google_refresh_token__${account}`, tokens.refresh_token);
  if (tokens.access_token) setSecret(`google_access_token__${account}`, tokens.access_token);
  accounts.register(account, email || `${account}@unknown`, { makeDefault: false });
  console.error(`\nStored refresh token for account '${account}' in the vault and registered it.`);
  console.error(`Test with:  node tools/drive-upload.js --account ${account} --find "Joshua Pickard"\n`);
}

if (require.main === module) {
  main().catch(e => { console.error('OAuth setup error:', e.message); process.exit(1); });
}

module.exports = { aliasFromEmail, resolveAccountSelection, buildAuthorizationUrl, main };
