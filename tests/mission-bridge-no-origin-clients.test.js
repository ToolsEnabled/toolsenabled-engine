'use strict';
// A CLI, script, or agent sends no Origin header -- that is a browser concept.
// The mission bridge used to refuse every such request with 403
// BRIDGE_ORIGIN_REFUSED, which locked every non-browser client out of the
// product entirely. The owner asked that our own agents run from inside the
// product; they could not reach it at all.
//
// The change admits requests that carry NO Origin, and this suite exists to
// prove that admitting them cost nothing. The load-bearing assertions are the
// three that must STILL refuse:
//
//   * no Origin + no bearer          -> 401, auth is untouched
//   * no Origin + wrong bearer       -> 401
//   * present-but-unlisted Origin    -> 403, browser protection intact
//
// Only the fourth is the new capability. A suite that proved only the fourth
// would be evidence of nothing -- it is trivial to make a gate stop refusing.
//
// Why admitting no-Origin is sound, from this file's own stated threat model
// (see the BOOTSTRAP_PROOF_FILE comment in server.js): "A browser Origin header
// is trivially forgeable by any local, non-browser HTTP client, so it was never
// real authorization for a same-user attacker -- only for a genuine cross-origin
// browser fetch." A hostile local client sends `Origin: <allowed>` and passes
// either way; only honest clients were blocked. Real protection is `authorized()`,
// which this change does not touch.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');

let passed = 0;
function check(name, condition, detail) {
  assert.ok(condition, detail || name);
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const ALLOWED = 'http://127.0.0.2:4600';
const UNLISTED = 'http://evil.example:4600';

async function main() {
  const token = crypto.randomBytes(32);
  const bootstrapProof = crypto.randomBytes(32);
  const runtimeFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-no-origin-')), 'runtime.json'
  );

  // A minimal actions surface: status is the cheapest authenticated route.
  const actions = {
    async status() { return { ok: true, probe: 'no-origin-suite' }; }
  };

  const bridge = createMissionBridgeServer({
    token, bootstrapProof, allowedOrigins: [ALLOWED], actions,
    runtimeFile, allowTestRuntimeFile: true, allowTestPortZero: true,
    runtimeDependencies: { platform: 'test' }
  });

  const bearer = `Bearer ${token.toString('base64url')}`;

  try {
    const address = await bridge.listen(0);
    const url = `${address.baseUrl}/v1/status`;

    // --- the three that must still refuse ---------------------------------

    const noOriginNoAuth = await fetch(url);
    check('no Origin and NO bearer is still refused 401 -- auth is untouched',
      noOriginNoAuth.status === 401,
      `expected 401, got ${noOriginNoAuth.status}`);

    const noOriginBadAuth = await fetch(url, {
      headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }
    });
    check('no Origin and a WRONG bearer is still refused 401',
      noOriginBadAuth.status === 401,
      `expected 401, got ${noOriginBadAuth.status}`);

    const unlistedOrigin = await fetch(url, {
      headers: { origin: UNLISTED, authorization: bearer }
    });
    check('a PRESENT but unlisted Origin is still refused 403 -- browsers stay protected',
      unlistedOrigin.status === 403,
      `expected 403, got ${unlistedOrigin.status}`);

    const unlistedOriginBody = await unlistedOrigin.json().catch(() => ({}));
    check('the browser refusal still names BRIDGE_ORIGIN_REFUSED',
      JSON.stringify(unlistedOriginBody).includes('BRIDGE_ORIGIN_REFUSED'));

    // --- the new capability ------------------------------------------------

    const noOriginAuthed = await fetch(url, { headers: { authorization: bearer } });
    check('no Origin WITH a valid bearer now succeeds -- a CLI or agent can reach the bridge',
      noOriginAuthed.status === 200,
      `expected 200, got ${noOriginAuthed.status}`);

    const payload = await noOriginAuthed.json();
    check('and it returns the real route body, not an empty success',
      payload && payload.probe === 'no-origin-suite');

    // --- the allowed-origin browser path is unchanged ----------------------

    const allowedOrigin = await fetch(url, {
      headers: { origin: ALLOWED, authorization: bearer }
    });
    check('an allowed Origin with a valid bearer still succeeds',
      allowedOrigin.status === 200,
      `expected 200, got ${allowedOrigin.status}`);

    check('a browser request still receives its CORS echo header',
      allowedOrigin.headers.get('access-control-allow-origin') === ALLOWED);

    check('a no-Origin request receives NO CORS header -- meaningless without an Origin',
      noOriginAuthed.headers.get('access-control-allow-origin') === null);

    // --- pre-auth routes must not have widened -----------------------------

    const bootstrapNoOrigin = await fetch(`${address.baseUrl}/v1/bootstrap`);
    check('bootstrap without the filesystem proof is still refused, Origin or not',
      bootstrapNoOrigin.status === 401,
      `expected 401, got ${bootstrapNoOrigin.status}`);
  } finally {
    await bridge.close().catch(() => {});
  }

  process.stdout.write(`\n${passed} checks passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
