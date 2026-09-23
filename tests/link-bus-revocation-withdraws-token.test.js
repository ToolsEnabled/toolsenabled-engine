'use strict';

/* DELETING THE VAULT RECORD LEFT THE OLD TOKEN ACCEPTED, FOREVER, SILENTLY.
 *
 * sidecars/link-bus/server.js re-reads its bearer token from the vault every two
 * seconds so a rotation takes effect without a restart. That reload ended:
 *
 *     .catch(() => {});
 *
 * loadTokenAsync REJECTS when the record is gone, so a deleted credential took
 * that empty catch, left tokenRef.current holding the OLD token, and the server
 * went on accepting it for the life of the process with nothing logged. A
 * credential you have revoked still opening the door is the whole thing a
 * revocation is for.
 *
 * SCOPE, SO NOBODY READS THIS AS BIGGER THAN IT IS: this sidecar is NOT in the
 * packed payload and NOT in the installed product -- both checked. It is a
 * builder-side tool on the direct-Ethernet link bus. No customer is exposed. It
 * is fixed because it is a revocation hole and the fix is small, not because it
 * blocks a beta.
 *
 * THE FIX IS NOT "REFUSE ON ANY FAILED READ". That read spawns PowerShell and can
 * lose a race with a vault writer, so a single failure must not look like a
 * revocation. Three consecutive failures withdraw the token, and a later
 * successful read re-arms it, so the server recovers without a restart.
 *
 * THIS FILE'S FIRST VERSION MEASURED NOTHING, and the reason is worth keeping:
 * it drove GET /health, which returns 200 BEFORE the auth check (server.js:277
 * returns; the token is consulted at :284, on /v1/messages only). Every request
 * it made would have answered 200 with no token at all. The wrong-token control
 * below exists so that can never happen again silently: if the route stops
 * consulting the token, the control fails first and names it.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../sidecars/link-bus/server.js');

const GOOD = 'a-token-long-enough-to-be-real-0123456789';
/* Written as character classes rather than escaped dots: this file is generated
   through shells that eat backslashes, and [.] is exact where a bare . is not. */
const LOOPBACK = /^(::1|::ffff:127[.]0[.]0[.]1|127[.]0[.]0[.]1)$/;
const GUARDED = '/v1/messages?channel=probe';

const open = [];
let checks = 0;

function request(port, token) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: GUARDED, method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

function start(reloadToken) {
  const server = createServer({
    token: GOOD,
    reloadIntervalMs: 20,
    /* With no peer configured the server's own allowlist matches NOTHING and
       every socket is destroyed -- correct, and it means a test must name the
       address it dials from or it measures a closed socket, not the token. */
    allowedRemoteRe: LOOPBACK,
    reloadToken,
  });
  open.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* Real time, because the reload is a real interval. Kept short deliberately: a
   test that waits seconds gets deleted by the next person in a hurry. */
const settle = ticks => new Promise(resolve => setTimeout(resolve, ticks * 20 + 60));

(async () => {
  let readsFail = false;
  const port = await start(async () => {
    if (readsFail) throw new Error('the vault record is gone');
    return Buffer.from(GOOD, 'utf8');
  });

  /* ---- CONTROL: the route consults the token at all -------------------- */
  assert.equal(await request(port, 'not-the-token'), 401,
    'a wrong bearer token was accepted, so this route does not gate on the token and nothing below '
    + 'measures a revocation');
  checks += 1;

  assert.notEqual(await request(port, GOOD), 401,
    'the server refused its own token to begin with, so nothing below measures anything');
  checks += 1;

  /* ---- 1. THE VAULT RECORD DISAPPEARS ---------------------------------- */
  readsFail = true;
  await settle(6);

  assert.equal(await request(port, GOOD), 401,
    'the vault record was deleted and the old token is still accepted -- a revoked credential still '
    + 'opens the door, which is the whole thing a revocation is for');
  checks += 1;

  /* ---- 2. IT RECOVERS WHEN THE VAULT ANSWERS AGAIN --------------------- */
  /* THE CONTROL that stops this fix becoming a one-way trip. Without it,
     withdrawing on the first hiccup and never re-arming would satisfy the
     assertion above while making an ordinary vault race permanently fatal. */
  readsFail = false;
  await settle(6);

  assert.notEqual(await request(port, GOOD), 401,
    'the vault answered again and the server never re-armed, so one transient read failure kills it '
    + 'until somebody restarts it by hand');
  checks += 1;

  /* ---- 3. A SINGLE HICCUP IS NOT A REVOCATION -------------------------- */
  /* One failure, then reads that never answer. THE PENDING READS ARE THE POINT:
     an earlier version returned the good token again on the next tick, which
     re-armed the server within 20 ms -- so a server that withdrew on the FIRST
     failure passed this assertion anyway and the check measured nothing. It was
     caught by mutation, not by review. Leaving the later reads unresolved holds
     the server in the state the single failure left it in, which is the state
     this assertion is about. */
  let firstRead = true;
  const tolerantPort = await start(() => {
    if (firstRead) { firstRead = false; return Promise.reject(new Error('transient')); }
    return new Promise(() => {});
  });
  await settle(6);

  assert.notEqual(await request(tolerantPort, GOOD), 401,
    'one failed vault read withdrew the token; that read spawns a process and can lose a race with a '
    + 'writer, so a single failure must not look like a revocation');
  checks += 1;

  console.log(`link-bus-revocation-withdraws-token: ${checks} checks passed on ${process.platform}`);
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}).finally(() => {
  /* Closed here, not after the last assertion: a throw used to leave the servers
     listening and the whole file hung until the harness killed it, which turns a
     one-line failure into a ten-minute timeout nobody reads. */
  for (const server of open) server.close();
});
