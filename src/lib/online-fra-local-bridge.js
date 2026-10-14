'use strict';
// HOW THIS MACHINE PERFORMS A TUNNELLED REQUEST: against its own action bridge,
// exactly as the local UI would, with the same bearer.
//
// The action bridge (src/lib/mission-bridge/server.js) binds loopback and
// writes two owner-only files per boot: state/mission-bridge-runtime.json
// (where it is listening) and state/mission-bridge-token.json (the bearer).
// The local UI obtains that bearer through GET /v1/bootstrap with a proof read
// from a third owner-only file, because a BROWSER cannot read files. This is
// not a browser. It is a process running as the owner on the owner's machine,
// and the files ARE the authorization model: whoever can read them is the
// owner, by the bridge's own design ("the same per-boot ACL pattern as the
// bearer token file"). So it reads the bearer and uses it, and sends no
// Origin, which the bridge treats as a non-browser caller.
//
// READ PER CALL, NOT ONCE. Both files rotate every time the bridge restarts.
// A bearer cached at shell start would be refused after the first bridge
// restart with a 401 that points nowhere near its cause; reading two small
// files per request costs nothing and is always current.
//
// PATH ONLY. The caller hands a path+query; the origin is always this
// machine's own bridge. There is no parameter by which a tunnelled request
// can be sent anywhere else.

const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');
const { fetchBridgeResponse, BridgeResponseError } = require('./online-fra-bridge-response');
const { BROWSER_DISPATCH_GUARD } = require('./online-fra-browser-authority');

class OnlineFraLocalBridgeError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraLocalBridgeError'; this.code = code; }
}
function fail(code, message) { throw new OnlineFraLocalBridgeError(code, message); }

const RUNTIME_FILE = statePath('state', 'mission-bridge-runtime.json');
const TOKEN_FILE = statePath('state', 'mission-bridge-token.json');
const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

function readJson(file, code) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { fail(code, `${path.basename(file)} is not readable (${error.code || error.message}). Is the action bridge running on this machine?`); }
  try { return JSON.parse(raw); } catch { fail(code, `${path.basename(file)} is not valid JSON.`); }
}

function createLocalBridge({ runtimeFile = RUNTIME_FILE, tokenFile = TOKEN_FILE, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof fetchImpl !== 'function') fail('LOCAL_BRIDGE_OPTIONS_INVALID', 'No fetch implementation; inject one.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    fail('LOCAL_BRIDGE_OPTIONS_INVALID', 'The local bridge timeout must be a positive bounded integer.');
  }

  function target() {
    const runtime = readJson(runtimeFile, 'LOCAL_BRIDGE_RUNTIME_UNAVAILABLE');
    const baseUrl = typeof runtime.baseUrl === 'string' ? runtime.baseUrl.replace(/\/$/, '') : null;
    // Loopback or nothing. A runtime file naming any other host would be a
    // file somebody else wrote, and this module must not follow it.
    if (!baseUrl || !LOOPBACK_BASE.test(baseUrl)) fail('LOCAL_BRIDGE_RUNTIME_INVALID', 'The bridge runtime record does not name a loopback base URL.');
    const token = readJson(tokenFile, 'LOCAL_BRIDGE_TOKEN_UNAVAILABLE');
    if (typeof token.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token.token)) fail('LOCAL_BRIDGE_TOKEN_INVALID', 'The bridge token record does not hold a bearer.');
    return { baseUrl, bearer: token.token };
  }

  async function fetch(pathname, init = {}) {
    if (typeof pathname !== 'string' || pathname[0] !== '/' || pathname.startsWith('//') || /[\r\n\0]/.test(pathname)) {
      fail('LOCAL_BRIDGE_PATH_INVALID', 'A tunnelled request names a /path[?query] on this machine\'s own bridge, nothing else.');
    }
    let headers;
    try { headers = Object.fromEntries(new Headers(init.headers || {}).entries()); }
    catch { fail('LOCAL_BRIDGE_HEADERS_INVALID', 'The local bridge request headers are invalid.'); }
    delete headers.origin; delete headers.authorization;
    const { baseUrl, bearer } = target();
    headers.authorization = `Bearer ${bearer}`;
    if (init[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
    try {
      return await fetchBridgeResponse(`${baseUrl}${pathname}`, { method: init.method || 'GET', headers,
        body: init.body, signal: init.signal }, { fetchImpl, timeoutMs });
    } catch (error) {
      if (error instanceof BridgeResponseError) fail(error.code.replace('BRIDGE_HTTP_', 'LOCAL_BRIDGE_'), error.message);
      throw error;
    }
  }

  return Object.freeze({ fetch, target, runtimeFile, tokenFile });
}

module.exports = Object.freeze({ OnlineFraLocalBridgeError, createLocalBridge, RUNTIME_FILE, TOKEN_FILE });
