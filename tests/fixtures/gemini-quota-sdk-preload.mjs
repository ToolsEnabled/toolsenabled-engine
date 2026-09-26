// Synthetic transport only, installed by the native fixture's spawn seam.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const mode = process.env.TOOLSENABLED_GEMINI_FIXTURE;
const home = process.env.GEMINI_CLI_HOME;
const evidence = process.env.TOOLSENABLED_GEMINI_EVIDENCE;
if (!mode || !home || !evidence || !path.isAbsolute(home) || !path.isAbsolute(evidence)) throw Error('synthetic fixture required');
const originalWrite = fs.writeFileSync.bind(fs);
const audit = { mode, operations: [], forbidden: [], atomicWriteCompleted: false };
const blocked = name => () => { audit.forbidden.push(name); throw Error('network forbidden by synthetic fixture'); };
for (const [module, methods] of [[http, ['request','get']], [https, ['request','get']],
  [net, ['connect','createConnection']], [tls, ['connect']], [dns, ['lookup','resolve']]]) {
  for (const name of methods) module[name] = blocked(name);
}
net.Socket.prototype.connect = blocked('Socket.connect');
globalThis.fetch = async url => {
  if (String(url) !== 'https://www.googleapis.com/oauth2/v2/userinfo') return blocked('fetch')();
  audit.operations.push('userinfo-cache');
  return new Response(JSON.stringify({ email: 'fixture-current@example.invalid' }), { status: 200 });
};
const leaf = path.join(home, '.gemini', 'oauth_creds.json');
const replacement = JSON.stringify({ access_token: 'synthetic-owner-replacement', refresh_token: 'synthetic-owner-refresh', expiry_date: 2000000000000 });
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  const handle = await open(...args);
  if (typeof args[0] === 'string' && args[0].includes('oauth_creds.toolsenabled-')) {
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async (...values) => {
      if (mode === 'write-failure') throw Object.assign(Error('synthetic storage fault'), { code: 'EIO' });
      if (mode === 'delayed-refresh') await new Promise(resolve => setTimeout(resolve, 180));
      await writeFile(...values);
      if (mode === 'replace-during-write') originalWrite(leaf, replacement);
      audit.atomicWriteCompleted = true;
    };
  }
  return handle;
};
let tokenIssued = false;
const mkdir = fs.promises.mkdir.bind(fs.promises);
fs.promises.mkdir = async (...args) => {
  if (mode === 'replace-before-write' && tokenIssued && path.resolve(String(args[0])) === path.join(home, '.gemini')) originalWrite(leaf, replacement);
  return mkdir(...args);
};
syncBuiltinESMExports();
process.on('exit', () => { originalWrite(evidence, JSON.stringify(audit)); });
const require = createRequire(new URL('../../provider-runtimes/gemini-quota/sdk.mjs', import.meta.url));
const authRequire = createRequire(require.resolve('google-auth-library'));
const { Gaxios, GaxiosError } = authRequire('gaxios');
Gaxios.prototype.request = async function (options) {
  const url = new URL(String(options.url));
  const operation = url.pathname.split('/').pop().split(':').pop();
  const isUserinfo = url.origin === 'https://www.googleapis.com' && operation === 'userinfo' && options.method === 'GET';
  const allowed = isUserinfo || options.method === 'POST' && (url.origin === 'https://oauth2.googleapis.com' && ['token','tokeninfo'].includes(operation)
    || url.origin === 'https://cloudcode-pa.googleapis.com' && ['loadCodeAssist','retrieveUserQuota'].includes(operation));
  if (!allowed) return blocked('unapproved endpoint/method')();
  audit.operations.push(operation);
  const body = options.body ? JSON.parse(options.body) : null;
  if (operation === 'loadCodeAssist' && body?.mode !== 'HEALTH_CHECK') return blocked('onboard mode')();
  if (operation === 'retrieveUserQuota' && body?.project !== 'fixture-project') return blocked('wrong project')();
  if (mode === 'revoked' && operation === 'token') throw new GaxiosError('synthetic invalid grant', options,
    { data: { error: 'invalid_grant' }, status: 400, headers: new Headers(), config: options });
  if (mode === 'timeout' && operation === 'retrieveUserQuota') return new Promise(() => { setInterval(() => {}, 1000); });
  if (mode === 'quota-failure' && operation === 'retrieveUserQuota') throw Error('synthetic-secret-must-not-escape');
  if (mode === 'secret-log' && operation === 'retrieveUserQuota') {
    console.log('synthetic-secret-must-not-escape'); console.error('synthetic-secret-must-not-escape');
  }
  let data;
  if (operation === 'token') { tokenIssued = true; data = { access_token: 'synthetic-refreshed', expires_in: 3600, token_type: 'Bearer' }; }
  if (operation === 'tokeninfo') data = { expires_in: 3600, scope: 'fixture-scope' };
  if (isUserinfo) data = { email: 'fixture-current@example.invalid' };
  if (operation === 'loadCodeAssist') {
    data = { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'fixture-project' };
    if (mode === 'no-tier') data = { allowedTiers: [{ id: 'free-tier' }] };
    if (mode === 'retired-client') data = { allowedTiers: [{ id: 'free-tier' }], ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT',
      reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals.' }] };
  }
  if (operation === 'retrieveUserQuota') data = { buckets: [
    { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.421875, resetTime: '2026-09-15T01:02:03.123456789Z' },
    { modelId: 'gemini-2.5-flash', tokenType: 'TOKENS', remainingAmount: '900719925474099312345.125' }
  ] };
  return { data, status: 200, statusText: 'OK', headers: new Headers(), config: options };
};
