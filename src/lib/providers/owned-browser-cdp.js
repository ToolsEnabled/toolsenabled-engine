'use strict';

// DRIVING THE TOOLSENABLED-OWNED BROWSER OVER CDP, FENCED TO ONE GENERATION.
//
// This module contains only the generic attach boundary: connect to the owned
// browser's loopback CDP endpoint, prove the generation has not changed under
// you, list targets, validate a debugger URL, and evaluate one bounded expression.
//
// WHY THE GENERATION FENCE IS NOT OPTIONAL. Every CDP drive re-attaches and
// compares identity immediately before it acts. Loopback is not proof: a launcher
// restart can hand the same port to a different browser generation, and a probe
// that trusted the port alone would evaluate its expression in whatever browser
// answered.

const safety = require('./provider-safety');

const CDP_TIMEOUT_MS = 10_000;
const GENERATION = /^[A-Za-z0-9_-]{43}$/;
const PROCESS_ID = /^[1-9][0-9]{0,9}$/;
const PROCESS_START_KEY = /^[0-9]{1,19}$/;
const BROWSER_UNAVAILABLE = 'OWNED_BROWSER_CDP_UNAVAILABLE';
const DEBUGGER_URL_INDETERMINATE = 'OWNED_BROWSER_CDP_DEBUGGER_URL_INDETERMINATE';

function fail(code, message) { return safety.safeError(code, message); }

function endpointFor(session) {
  let endpoint;
  try { endpoint = new URL(session && session.cdpEndpoint); }
  catch { throw fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser could not be attached.'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
      || !/^\d{2,5}$/.test(endpoint.port) || Number(endpoint.port) !== Number(session.cdpPort)) {
    throw fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP endpoint is invalid.');
  }
  return endpoint;
}

function validSession(session) {
  return Boolean(session) && GENERATION.test(String(session.generation || ''))
    && PROCESS_ID.test(String(session.processId || '')) && PROCESS_START_KEY.test(String(session.processStartKey || ''))
    && PROCESS_ID.test(String(session.cdpProcessId || '')) && PROCESS_START_KEY.test(String(session.cdpProcessStartKey || ''))
    && Number.isInteger(Number(session.cdpPort));
}

function sameSessionIdentity(before, after) {
  return validSession(before) && validSession(after)
    && before.generation === after.generation && Number(before.processId) === Number(after.processId)
    && before.processStartKey === after.processStartKey && Number(before.cdpProcessId) === Number(after.cdpProcessId)
    && before.cdpProcessStartKey === after.cdpProcessStartKey && Number(before.cdpPort) === Number(after.cdpPort)
    && endpointFor(before).href === endpointFor(after).href;
}

// Every CDP drive is fenced to the generation that was initially attached.
// Do not reuse an endpoint simply because it is loopback: a launcher restart
// may allocate the same port to a different browser generation.
function revalidateSession(browserOwner, before, code = BROWSER_UNAVAILABLE) {
  let after;
  try { after = browserOwner.attach(); }
  catch { throw fail(code, 'The ToolsEnabled-owned browser identity changed before the CDP operation.'); }
  if (!sameSessionIdentity(before, after)) {
    throw fail(code, 'The ToolsEnabled-owned browser identity changed before the CDP operation.');
  }
  return Object.freeze({ session: after, endpoint: endpointFor(after) });
}

async function targetsFor(fetchFn, endpoint) {
  let response;
  try { response = await fetchFn(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) }); }
  catch { throw fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP target list is unavailable.'); }
  if (!response || response.ok !== true) throw fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP target list is unavailable.');
  try {
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('invalid');
    return targets;
  } catch { throw fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP target list is invalid.'); }
}

function safeDebuggerUrl(value, session) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) === Number(session.cdpPort)
      && /^\/devtools\/page\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname) ? url.href : null;
  } catch (error) {
    // ERR_INVALID_URL is the one definite negative: the supplied value is not a URL.
    // Conversion can also execute user-provided coercion, whose operational failures
    // must not be reported to callers as though the debugger URL were absent.
    if (error && error.code === 'ERR_INVALID_URL') return null;
    throw fail(DEBUGGER_URL_INDETERMINATE,
      'The debugger URL could not be checked; this is NOT claiming that it is absent.');
  }
}

function evaluate(WebSocketImpl, debuggerUrl, expression, validate) {
  return new Promise((resolve, reject) => {
    let socket; let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket && socket.readyState === socket.OPEN) socket.close(); } catch { /* loopback connection cleanup */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe timed out.')), CDP_TIMEOUT_MS);
    try { socket = new WebSocketImpl(debuggerUrl); }
    catch { finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe could not start.')); return; }
    const open = () => {
      try { socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: false } })); }
      catch { finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe could not run.')); }
    };
    const message = event => {
      let parsed;
      try { parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
      catch { finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe returned invalid data.')); return; }
      if (!parsed || parsed.id !== 1) return;
      const value = parsed.result && parsed.result.result && parsed.result.result.value;
      if (!validate(value)) {
        finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe returned invalid data.'));
        return;
      }
      finish(null, value);
    };
    const error = () => finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser CDP probe could not run.'));
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', open, { once: true });
      socket.addEventListener('message', message);
      socket.addEventListener('error', error, { once: true });
    } else {
      socket.once('open', open); socket.on('message', message); socket.once('error', error);
    }
  });
}

function bringToFront(WebSocketImpl, debuggerUrl) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket && socket.readyState === socket.OPEN) socket.close(); } catch { /* loopback connection cleanup */ }
      if (error) reject(error); else resolve(true);
    };
    const unavailable = () => finish(fail(BROWSER_UNAVAILABLE, 'The ToolsEnabled-owned browser page could not be focused.'));
    const timer = setTimeout(unavailable, CDP_TIMEOUT_MS);
    try { socket = new WebSocketImpl(debuggerUrl); }
    catch { unavailable(); return; }
    const open = () => {
      try { socket.send(JSON.stringify({ id: 1, method: 'Page.bringToFront', params: {} })); }
      catch { unavailable(); }
    };
    const message = event => {
      let parsed;
      try { parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
      catch { unavailable(); return; }
      if (!parsed || parsed.id !== 1) return;
      if (parsed.error || !parsed.result || Object.keys(parsed.result).length !== 0) { unavailable(); return; }
      finish(null);
    };
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', open, { once: true });
      socket.addEventListener('message', message);
      socket.addEventListener('error', unavailable, { once: true });
    } else {
      socket.once('open', open); socket.on('message', message); socket.once('error', unavailable);
    }
  });
}

module.exports = {
  BROWSER_UNAVAILABLE, CDP_TIMEOUT_MS, DEBUGGER_URL_INDETERMINATE,
  bringToFront, endpointFor, evaluate, revalidateSession, safeDebuggerUrl, sameSessionIdentity, targetsFor, validSession
};
