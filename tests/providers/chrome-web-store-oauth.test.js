/* Mutation check (2026-08-27):
 * Changed sameState's return to `crypto.timingSafeEqual(leftBytes, rightBytes)`,
 * removing its byte-length guard in src/lib/providers/chrome-web-store-oauth.js.
 * The mutation landed (confirmed by matching the replacement line).
 * This isolated test went red with exit code 1 (RangeError).
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const oauth = require('../../src/lib/providers/chrome-web-store-oauth.js');

let checks = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

// Deterministic entropy makes the PKCE contract observable without reaching
// Google, opening a browser, or depending on secrets from the host.
const entropy = Buffer.alloc(32, 0xa5);
const material = oauth.authorizationMaterial(size => {
  check(size, 32, 'authorization entropy must request 256 bits');
  return entropy;
});
const encodedEntropy = entropy.toString('base64url');
check(material.state, encodedEntropy, 'state must be base64url-encoded entropy');
check(material.verifier, encodedEntropy, 'the PKCE verifier must use independent base64url entropy');
check(
  material.challenge,
  crypto.createHash('sha256').update(encodedEntropy, 'ascii').digest('base64url'),
  'the PKCE challenge must be the base64url SHA-256 digest of the verifier'
);

const authorizeUrl = new URL(oauth.authorizationUrl({
  clientId: 'client id',
  redirectUri: 'http://127.0.0.1:4321/toolsenabled/cws/oauth2/callback',
  state: 'state-value',
  challenge: 'challenge-value',
  loginHint: 'publisher@example.test'
}));
check(authorizeUrl.origin + authorizeUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth', 'authorization must use the Google OAuth endpoint');
check(authorizeUrl.searchParams.get('client_id'), 'client id', 'authorization must identify the configured client');
check(authorizeUrl.searchParams.get('response_type'), 'code', 'authorization must request an authorization code');
check(authorizeUrl.searchParams.get('scope'), oauth.CWS_SCOPE, 'authorization must request only the Chrome Web Store scope');
check(authorizeUrl.searchParams.get('code_challenge_method'), 'S256', 'authorization must require PKCE S256');
check(authorizeUrl.searchParams.get('login_hint'), 'publisher@example.test', 'authorization must target the fixed publisher login');

const port = 4321;
const validRequest = {
  method: 'GET',
  headers: { host: `127.0.0.1:${port}` },
  url: `${oauth.CALLBACK_PATH}?state=expected-state&code=authorization-code`
};
check(
  oauth.callbackRequest(validRequest, port),
  { kind: 'code', state: 'expected-state', code: 'authorization-code' },
  'a well-formed loopback callback must yield its state and code'
);
check(oauth.callbackRequest({ ...validRequest, method: 'POST' }, port), { kind: 'reject' }, 'non-GET callbacks must be rejected');
check(oauth.callbackRequest({ ...validRequest, headers: { host: 'localhost:4321' } }, port), { kind: 'reject' }, 'callbacks with a non-literal loopback host must be rejected');
check(oauth.callbackRequest({ ...validRequest, url: `${oauth.CALLBACK_PATH}?state=a&state=b&code=c` }, port), { kind: 'reject' }, 'callbacks with duplicate state parameters must be rejected');
check(
  oauth.callbackRequest({ ...validRequest, url: `${oauth.CALLBACK_PATH}?state=expected-state&error=access_denied` }, port),
  { kind: 'denied', state: 'expected-state' },
  'an OAuth denial must be distinguished from a malformed callback'
);

check(oauth.sameState('same-state', 'same-state'), true, 'identical states must match');
check(oauth.sameState('same-state', 'other-state'), false, 'different states must not match');
/* THE CASE THIS LINE NAMES HAD TO BE BUILT, NOT JUST DESCRIBED.
   It read sameState('é', 'ab') -- which is 1 character against 2, and
   2 BYTES against 2. Equal byte lengths, so timingSafeEqual never throws, so
   the assertion returned false and passed with the module's byte-length guard
   REMOVED. It read as coverage of the crash directly above it in
   providers/chrome-web-store-oauth.js -- "any local process that could reach
   the loopback callback port could crash the broker mid-authorization" -- and
   covered none of it.
   'éx' against 'ab' is 2 characters against 2 with 3 bytes against 2,
   which is the shape the guard exists for: unguarded it throws RangeError.
   Measured both ways before this was changed. */
check(oauth.sameState('\u00e9x', 'ab'), false, 'equal character counts with unequal UTF-8 byte lengths must safely fail');
check(oauth.sameState(null, 'null'), false, 'non-string states must safely fail');

check(
  oauth.fixedAccount({ cwsLoginAccount: () => ({ alias: 'publisher', email: 'publisher@example.test', ignored: true }) }),
  { alias: 'publisher', email: 'publisher@example.test' },
  'the fixed account must expose only its alias and valid email'
);
assert.throws(
  () => oauth.fixedAccount({ cwsLoginAccount: () => ({ alias: 'publisher', email: 'not-an-email' }) }),
  error => error.code === 'CWS_OAUTH_ACCOUNT_NOT_CONFIGURED',
  'an invalid fixed account must fail with the stable OAuth error code'
);
checks += 1;

// A failed machine read is not evidence that configuration is absent. Exercise
// every transient code named by the contract, and retry through the same helper
// to prove that a could-not-tell result is not latched for the process lifetime.
for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
  let attempts = 0;
  const read = key => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('machine unavailable'), { code });
    return `${key}-value`;
  };
  assert.throws(
    () => oauth.fixedCredentials(read),
    error => error.code === 'CWS_OAUTH_CONFIGURATION_LOOKUP_FAILED' && error.message.includes('NOT claiming'),
    `${code} must report could-not-tell rather than missing configuration`
  );
  check(
    oauth.fixedCredentials(read),
    { clientId: 'cws_client_id-value', clientSecret: 'cws_client_secret-value', publisherId: 'cws_publisher_id-value' },
    `${code} must not latch the failed lookup`
  );
  check(attempts, 4, `${code} retry must perform all three reads after the failed attempt`);
  checks += 1;
}

// Control: the genuine-absence answer remains the pre-existing stable result.
assert.throws(
  () => oauth.fixedCredentials(() => null),
  error => error.code === 'CWS_OAUTH_CONFIGURATION_MISSING',
  'an answered read with an absent value must still report missing configuration'
);
checks += 1;

assert.throws(
  () => oauth.fixedAccount({ cwsLoginAccount: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }),
  error => error.code === 'CWS_OAUTH_CONFIGURATION_LOOKUP_FAILED' && error.message.includes('NOT claiming'),
  'a failed account lookup must not claim that the account is unconfigured'
);
checks += 1;

function fakeServer(options = {}) {
  const server = new EventEmitter();
  server.listen = () => process.nextTick(() => server.emit('listening'));
  server.address = () => options.address === undefined ? { port: 4321 } : options.address;
  server.close = callback => { server.closed = true; callback(); };
  return server;
}

function dependencies(overrides = {}) {
  const effects = { launches: [], writes: [], audits: [], servers: [] };
  const deps = {
    assertActive() {},
    googleAccounts: { cwsLoginAccount: () => ({ alias: 'publisher', email: 'publisher@example.test' }) },
    getSecret: key => `${key}-value`,
    randomBytes: () => Buffer.alloc(32, 0xa5),
    browserOwner: { start: url => effects.launches.push(url) },
    setSecretPair: (...args) => effects.writes.push(args),
    record: (...args) => effects.audits.push(args),
    createServer: handler => {
      const server = fakeServer();
      server.handler = handler;
      effects.servers.push(server);
      return server;
    },
    ...overrides
  };
  return { deps, effects };
}

async function refusal(promise, code) {
  await assert.rejects(promise, error => error.code === code, `authorization must refuse with ${code}`);
  checks += 1;
}

async function driveCallback(context, query) {
  while (context.effects.launches.length === 0) await new Promise(resolve => setImmediate(resolve));
  const launched = new URL(context.effects.launches[0]);
  const state = launched.searchParams.get('state');
  const response = { writeHead() {}, end() {} };
  context.effects.servers[0].handler({
    method: 'GET', headers: { host: '127.0.0.1:4321' },
    url: `${oauth.CALLBACK_PATH}?state=${encodeURIComponent(state)}&${query}`
  }, response);
}

(async () => {
  // These preflight refusals happen before server construction, browser launch,
  // or persistence.  The side-effect assertions make that ordering contractual.
  for (const [code, overrides] of [
    ['CWS_OAUTH_TIMEOUT_INVALID', { timeoutMs: 999 }],
    ['CWS_OAUTH_CONFIGURATION_MISSING', { getSecret: () => null }]
  ]) {
    const context = dependencies(overrides);
    await refusal(oauth.authorize(context.deps), code);
    check(context.effects, { launches: [], writes: [], audits: [], servers: [] }, `${code} must have no external effects`);
  }

  const bind = dependencies({ createServer: handler => {
    const server = fakeServer({ address: null }); server.handler = handler; bind.effects.servers.push(server); return server;
  } });
  await refusal(oauth.authorize(bind.deps), 'CWS_OAUTH_CALLBACK_BIND_FAILED');
  check(bind.effects.launches, [], 'a callback bind refusal must not launch a browser');
  check(bind.effects.writes, [], 'a callback bind refusal must not persist tokens');

  const denied = dependencies();
  const deniedAuthorization = oauth.authorize(denied.deps);
  await driveCallback(denied, 'error=access_denied');
  await refusal(deniedAuthorization, 'CWS_OAUTH_DENIED');
  check(denied.effects.writes, [], 'an owner denial must not persist tokens');
  check(denied.effects.audits, [], 'an owner denial must not claim authorization');

  const exchange = dependencies({ request: async () => { throw new Error('token endpoint unavailable'); } });
  const exchangeAuthorization = oauth.authorize(exchange.deps);
  await driveCallback(exchange, 'code=authorization-code');
  await refusal(exchangeAuthorization, 'CWS_OAUTH_TOKEN_EXCHANGE_FAILED');
  check(exchange.effects.writes, [], 'a failed token exchange must not persist tokens');
  check(exchange.effects.audits, [], 'a failed token exchange must not claim authorization');

  const capability = dependencies({ request: async () => ({ body: { access_token: 'access', refresh_token: 'refresh' } }) });
  const capabilityAuthorization = oauth.authorize(capability.deps);
  await driveCallback(capability, 'code=authorization-code');
  await refusal(capabilityAuthorization, 'CWS_OAUTH_CAPABILITY_VERIFICATION_FAILED');
  check(capability.effects.writes, [], 'an unverified capability must not persist tokens');
  check(capability.effects.audits, [], 'an unverified capability must not claim authorization');

  let timeoutCallback;
  const timeout = dependencies({ setTimeout: callback => { timeoutCallback = callback; return 1; }, clearTimeout() {} });
  const timeoutAuthorization = oauth.authorize(timeout.deps);
  while (!timeoutCallback) await new Promise(resolve => setImmediate(resolve));
  timeoutCallback();
  await refusal(timeoutAuthorization, 'CWS_OAUTH_TIMEOUT');
  check(timeout.effects.writes, [], 'a timeout must not persist tokens');
  check(timeout.effects.audits, [], 'a timeout must not claim authorization');

  const failed = dependencies({ browserOwner: { start: () => { throw new Error('launcher failure'); } } });
  await refusal(oauth.authorize(failed.deps), 'CWS_OAUTH_FAILED');
  check(failed.effects.writes, [], 'an unexpected launch failure must not persist tokens');
  check(failed.effects.audits, [], 'an unexpected launch failure must not claim authorization');

  console.log(`chrome-web-store-oauth behaviour: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
