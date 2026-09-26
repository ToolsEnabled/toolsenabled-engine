'use strict';

const { fetchBridgeResponse, UNKNOWN_OUTCOME } = require('./online-fra-bridge-response');
const { BROWSER_DISPATCH_GUARD } = require('./online-fra-browser-authority');

// TWO SERVERS ON ONE MACHINE, AND ONE DOOR FROM THE TUNNEL.
//
// A tunnelled request arrives at the relay shell as a path. Until now every
// such path went to one place: the action bridge, discovered from its runtime
// and token files. But the agent surface a signed-in browser drives does not
// live there. It lives in the desktop shell's own loopback facade, which is
// deliberately undiscoverable -- no runtime file, no token file, no route that
// announces it -- because a file on disk naming a port and a bearer is a file
// any process on the machine can read. The shell hands its origin and bearer
// to this leg directly, through the environment of the child it spawned, and
// nowhere else.
//
// So the door has to split. This module is that split and nothing more:
//
//   /v1/agent/*, /v1/org*  ->  the shell's facade      (env-supplied)
//   everything else        ->  the action bridge       (file-discovered)
//
// ...and on the second of those, the owner's web-drive switch. The facade half
// has always been governed by it, at the relay principal the shell builds per
// request; the action half was not governed at all. See TUNNEL_READS below for
// what still gets through with the switch off and why that list is an allowlist.
//
// PREFIX MATCHING IS A SECURITY DECISION, NOT A CONVENIENCE. The prefixes are
// anchored and compared against the path with its query stripped, so
// `/v1/agentXextra` is not agent traffic and `/v1/organisations` is not org
// traffic. A loose `startsWith('/v1/org')` would send both to the facade,
// where they would 404 -- harmless today, and exactly the sort of thing that
// stops being harmless when someone adds a route.
//
// ORIGIN IS STRIPPED, DELIBERATELY. The facade refuses any request carrying an
// Origin header before it even looks at the bearer, because no browser is ever
// a legitimate caller of a loopback port. A relayed request is not a browser on
// this machine -- it arrived over an authenticated tunnel from a leg that had
// to hold a minted lease -- but the browser at the far end may well have put an
// Origin on it. Passing that through would make every single agent call 403 for
// a reason nobody could see from either end. The action bridge already strips
// it for the same reason, in the same words.
//
// ABSENT CREDENTIALS REFUSE; THEY DO NOT GUESS. If the shell did not hand over
// both an origin and a bearer -- the app is not running, or it is an older
// build that predates the facade -- facade-bound paths answer AGENT_FACADE_ABSENT
// and the action bridge is never offered as a substitute. Forwarding an agent
// command to the wrong server on the same machine is worse than not answering.

const AGENT_PREFIXES = Object.freeze(['/v1/agent/', '/v1/org/']);
const AGENT_EXACT = Object.freeze(['/v1/org']);

// THE OWNER'S WEB-DRIVE SWITCH GOVERNS THIS DOOR, NOT HALF OF IT.
//
// The switch's own copy is the specification. Settings draws it as: "Off means
// a browser can see what is here and change nothing"
// (desktop-app src/connect-computer-settings.js, webDriveMarkup). Until this
// gate existed that sentence was true of the facade half and false of the other
// one: shell/relay-supervisor.cjs webDriveMayWrite() had exactly one reader,
// the facade's relay principal, so a signed-in browser reaching this machine
// with the switch OFF still reached /v1/actions/* carrying the owner's own
// bridge bearer -- it could dispatch an agent, terminate one, launch a billable
// cloud task, retire ledger requests, approve a purchase batch. Reads were the
// only thing the sentence actually promised, and writes were the only thing it
// did not deliver.
//
// AN ALLOWLIST, SO FAIL-CLOSED IS STRUCTURAL. What follows names the tunnelled
// requests that only READ. Everything else -- every route in the table today,
// every route added tomorrow, every verb nobody thought about -- is a write and
// meets the switch. A denylist would have to be updated in step with every new
// action or it would quietly widen; this cannot widen by omission, only by
// somebody deliberately adding a line here.
//
// THE CLASSIFICATION IS THE PRODUCT'S OWN, NOT A GUESS FROM THE VERB. The
// mission bridge routes almost everything over POST on purpose ("one router,
// one auth check, one error shape ... read-vs-write is enforced at the provider
// behind the action", mission-bridge/server.js), so the verb decides nothing.
// Each POST row below is a route whose handler the product itself declares
// read-only:
//
//   report-read, launch-status   NON_OUTWARD_ACTIONS in mission-bridge/actions.js
//                                names them "Pure reads" / "Reading the fate of
//                                a lane"; server.js: "Read-only: what happened
//                                to a launch this bridge already handed over".
//   cloud-accounts, cloud-tasks, actions.js runs these through cloud.account_list
//   cloud-task-status            / cloud.task_list / cloud.task_status, whose
//                                declared effect in tool-registry.js is
//                                'external-read' (readOnlyHint true).
//   research-snapshot, -runs,    mission-bridge/research-actions.js passes these
//   -results, -findings          to control.snapshot/runs/results/findings with
//                                no actor and no store call; the six siblings
//                                that DO write all go through asHuman().
//                                research.run_list / result_list / finding_list
//                                declare 'local-read'.
//   task-get, task-list          task.get / task.list declare 'local-read'.
//
// NOTE ON `terminate`: it IS in NON_OUTWARD_ACTIONS, but for a different
// question -- "may this still run during a kill event", answered yes because
// stopping a lane REDUCES activity. That is not a claim it is a read. It kills
// a running agent, so it is a write and it is not on this list.
//
// FAILED CLOSED, DELIBERATELY, AND NAMED HERE SO THE CHOICE IS VISIBLE:
//   /v1/bootstrap             a read by verb, but what it reads out is this
//                             machine's bridge bearer. A credential handout does
//                             not belong on a "reads stay" list. Nothing is lost:
//                             a browser on the tunnel never calls it -- with a
//                             transport installed, desktop-app
//                             src/mission-bridge.js request() returns through the
//                             transport before bootstrap() can run -- and without
//                             the owner-only proof file the bridge 401s it anyway.
//   machines-link-status      it only reports, but machines-actions.js weighed
//                             exactly this and refused to widen: "-Off and
//                             -Status could arguably join ... but widening that
//                             carve-out is a policy decision, and the safe
//                             default for a new action family is refused". Its
//                             own default is followed rather than overridden.
const TUNNEL_READS = Object.freeze({
  GET: Object.freeze([
    // Discovery. No secret in the answer, and it is what the app probes over the
    // tunnel to decide a machine is reachable (mission-bridge.js bridgeReachable).
    '/v1/runtime',
    '/v1/contract',                      // authenticated action-surface metadata; no tool invocation
    '/v1/status',                        // system.status      local-read
    '/v1/settings',                      // settings.read      local-read
    '/v1/owner-prompts',                 // the popup's read half, per server.js
    '/v1/research/local-tiers-status',   // research.local_tiers_status local-read
  ]),
  POST: Object.freeze([
    '/v1/actions/report-read',
    '/v1/actions/launch-status',
    '/v1/actions/cloud-accounts',
    '/v1/actions/cloud-tasks',
    '/v1/actions/cloud-task-status',
    '/v1/actions/research-snapshot',
    '/v1/actions/research-runs',
    '/v1/actions/research-results',
    '/v1/actions/research-findings',
    '/v1/actions/task-get',
    '/v1/actions/task-list',
  ]),
});

/* THE REFUSAL, IN THE VOCABULARY THE PRODUCT ALREADY HAS.
 *
 * The code is the one the facade half has always answered for this exact
 * condition -- MC_AGENT_PRINCIPAL_READ_ONLY, 403 -- so the browser binding, the
 * app's copy table and every log in between read it with the path they already
 * have instead of learning a second word for one thing.
 *
 * THE SENTENCE TRAVELS WITH IT, and that is not decoration. The relay web
 * transport (website public/relay-web/relay-bridge-transport.mjs) shows
 * `value.error.message` when there is one and otherwise falls back to "That
 * machine turned this request down (403)" -- a generic 403 that names nothing a
 * person can act on. So the refusal carries the sentence.
 *
 * The words are desktop-app src/agent-availability-copy.js's own entry for
 * this code, made standalone (that copy is composed behind "Nothing was
 * started." and cannot be reused verbatim), and the two names in it are
 * CONNECT_SECTION and WEB_DRIVE_CONTROL_LABEL from
 * desktop-app src/device-claim-flow.js:34 and :108. They are repeated here
 * rather than imported for the same reason src/device-claim-flow.js repeats the
 * preference key it cannot import: this module is the payload, that one is the
 * shell's renderer, and neither can reach the other. tests/
 * online-fra-composite-bridge.test.js pins both strings so a rename on one side
 * cannot silently point a person at a control that is not there -- which is the
 * defect that copy was itself written to repair. */
const WEB_DRIVE_REFUSAL_CODE = 'MC_AGENT_PRINCIPAL_READ_ONLY';
const CONNECT_SECTION = 'Connect this computer';
const WEB_DRIVE_CONTROL_LABEL = 'Let a signed-in browser drive this computer';
const WEB_DRIVE_REFUSAL_MESSAGE = 'This computer has not been told it may be driven from a browser, '
  + 'so it will show you anything and change nothing. That permission is given on the computer itself, '
  + 'on purpose: it is what stops someone who has your password from driving your machine. '
  + `On that computer, open ToolsEnabled, go to Settings, open “${CONNECT_SECTION}” under Start here, `
  + `and turn on “${WEB_DRIVE_CONTROL_LABEL}”.`;

/* THE OTHER REFUSAL, AND IT IS A DIFFERENT SENTENCE ON PURPOSE.
 *
 * A write is also refused when the switch cannot be READ -- the app is not
 * running, the facade did not bind, the answer did not parse. Both outcomes
 * change nothing, so both are safe; they are not both true. Telling someone to
 * go and turn on a switch that is already on, because the machine could not be
 * asked, sends them to a screen where everything looks correct and leaves them
 * with no next move. That is the loop the switch's own copy was rewritten to
 * escape, and it would have been rebuilt here.
 *
 * So not-knowing keeps the facade's own codes -- the module already holds that
 * line for reads ("the facade being unreachable is a state of this machine, not
 * a refusal it made") -- and carries a sentence of its own, because those codes
 * have no entry in the app's copy table and a bare 503 renders as "That machine
 * turned this request down", which names nothing anybody can act on. */
const WEB_DRIVE_UNKNOWN_MESSAGE = 'This computer could not be asked whether it may be driven from a browser, '
  + 'so it changed nothing. That question is answered by ToolsEnabled itself on that computer, '
  + 'which means it is not running there, or it is still starting up. On that computer, open ToolsEnabled '
  + 'and leave it open, then check its connection and try this again.';

/* The facade's own read of the switch. It is a GET on the agent surface, so it
   is served by the door this bridge already holds credentials for, and the
   shell answers it from relayPrincipal() -- the single reader of
   webDriveMayWrite(). Asking per write rather than caching is what keeps
   "turning it off takes effect on the next command" true for this half too:
   the relay child is not respawned when the switch moves, so anything captured
   at spawn would go on granting a permission the owner had already withdrawn. */
const WEB_DRIVE_PROBE_PATH = '/v1/agent/remote-status';

/* The path as routed: query and fragment removed, so a query string can never
   change which server a request reaches, nor whether a route counts as a read. */
function routablePath(pathname) {
  const cut = pathname.search(/[?#]/);
  return cut === -1 ? pathname : pathname.slice(0, cut);
}

/* Is this tunnelled request one of the reads?
 *
 * The method must be one of the canonical spellings EXACTLY. The relay shell
 * only ever forwards those (its own regex), so requiring them costs nothing
 * real and means this function never has to reason about what a server would
 * make of `Post` -- an unrecognised spelling is simply not a read. */
function isTunnelRead(method, pathname) {
  const verb = typeof method === 'string' && method ? method : 'GET';
  const routes = Object.prototype.hasOwnProperty.call(TUNNEL_READS, verb) ? TUNNEL_READS[verb] : null;
  if (!routes) return false;
  return routes.includes(routablePath(pathname));
}

// Loopback or nothing, exactly as the action bridge insists. An origin handed
// in by a parent process is more trustworthy than a file on disk, but "more
// trustworthy" is not a reason to accept a route off this machine.
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

class OnlineFraCompositeBridgeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraCompositeBridgeError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraCompositeBridgeError(code, message); }

function isFacadePath(pathname) {
  const route = routablePath(pathname);
  if (AGENT_EXACT.includes(route)) return true;
  return AGENT_PREFIXES.some(prefix => route.startsWith(prefix));
}

/* A refusal the relay shell can forward like any other answer. It is shaped
   like the facade's own refusals -- {ok:false,error:{code}} -- so the browser's
   binding reads it with the code path it already has, rather than seeing a
   transport failure and inventing a reason the machine never gave. */
function refusal(status, code, message) {
  const error = typeof message === 'string' && message ? { code, message } : { code };
  const body = Buffer.from(JSON.stringify({ ok: false, error }), 'utf8');
  return {
    status,
    headers: { 'content-type': 'application/json' },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    async text() { return body.toString('utf8'); },
  };
}

/**
 * createCompositeBridge({ actionBridge, facade, fetchImpl, timeoutMs })
 *
 *   actionBridge  { fetch(path, init) } -- the existing local bridge; buffers
 *                 its bounded response before resolving, including body bytes.
 *   facade        { origin, token } or a function returning one. Read PER CALL,
 *                 like the action bridge reads its files per call: the shell
 *                 re-mints its bearer on every listen(), and a value captured
 *                 once at connect time would be refused after the first restart
 *                 with a 401 pointing nowhere near its cause. A configured
 *                 facade also authorizes mission reads; only an explicitly
 *                 absent facade keeps the standalone CLI's read behavior.
 */
function createCompositeBridge({ actionBridge, facade, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (!actionBridge || typeof actionBridge.fetch !== 'function') {
    fail('COMPOSITE_BRIDGE_OPTIONS_INVALID', 'actionBridge.fetch is required; the composite bridge routes, it does not replace.');
  }
  if (typeof fetchImpl !== 'function') fail('COMPOSITE_BRIDGE_OPTIONS_INVALID', 'No fetch implementation; inject one.');
  const readFacade = typeof facade === 'function' ? facade : () => facade;
  const requiresReadAdmission = facade !== undefined && facade !== null;

  /* Both halves or neither. A bearer with no origin has nowhere to go; an
     origin with no bearer would be answered 401 by the facade, which reads to
     the person driving as "your machine refused you" rather than "your machine
     never told this leg how to reach it". */
  function facadeTarget() {
    let value;
    try { value = readFacade(); }
    catch {
      /* A reader that failed did not establish that the facade is absent.
         Keep that uncertainty distinct so callers are not given a confident
         absence for a credential source that could not be measured. */
      fail('AGENT_FACADE_TARGET_UNREADABLE', 'The facade target could not be read.');
    }
    if (!value || typeof value !== 'object') return null;
    const origin = typeof value.origin === 'string' ? value.origin.replace(/\/$/, '') : null;
    const token = typeof value.token === 'string' ? value.token : null;
    if (!origin || !token) return null;
    if (!LOOPBACK_ORIGIN.test(origin)) return null;
    return { origin, token };
  }

  async function fetch(pathname, init = {}) {
    if (typeof pathname !== 'string' || pathname[0] !== '/' || pathname.startsWith('//') || /[\r\n\0]/.test(pathname)) {
      fail('COMPOSITE_BRIDGE_PATH_INVALID', 'A tunnelled request names a /path[?query] on this machine, nothing else.');
    }
    if (!isFacadePath(pathname)) {
      /* Reads need a current native admission when this relay was configured
         by the app. The separate Drive switch still governs only writes.
         Refusing a write happens before the action bridge is touched at all.

         `init && init.method` rather than `init.method`: the default parameter
         only covers undefined, and an explicit null used to reach the action
         bridge harmlessly. It must not start throwing here instead. */
      /* Union of two lanes, 2026-09-06. A tunnelled read now owes BOTH duties:
         the native read admission (admittedRead) and the browser-authority
         check. The guard is NOT applied here, before the call -- admittedRead
         yields on its admission probe, and the LIVE side's own reasoning a few
         lines below is that browser authority must be checked at the ACTUAL
         dispatch handoff, after any yield, because it can expire or be
         displaced while a probe runs. So the guard travels into admittedRead
         and sits immediately before each of its two dispatch points. */
      if (isTunnelRead(init && init.method, pathname)) return admittedRead(pathname, init);
      const verdict = await webDriveMayWrite();
      if (verdict.mayWrite !== true) {
        /* Two refusals, one outcome. The machine SAID the switch is off, or the
           machine could not be asked -- and the person is told which, because
           only one of them has a remedy they can reach. */
        return verdict.code === null
          ? refusal(403, WEB_DRIVE_REFUSAL_CODE, WEB_DRIVE_REFUSAL_MESSAGE)
          : refusal(verdict.status, verdict.code, WEB_DRIVE_UNKNOWN_MESSAGE);
      }
      // The permission probe above yielded. Browser authority may have expired
      // or been displaced while it ran; check at the actual dispatch handoff.
      if (init?.[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
      return actionBridge.fetch(pathname, init);
    }

    return forwardToFacade(pathname, init);
  }

  function readUnavailable() {
    return refusal(503, 'AGENT_FACADE_CONNECTION_CLOSED',
      'This computer could not confirm its current remote connection. Open ToolsEnabled on that computer and check its connection before trying again.');
  }

  function sameFacade(target) {
    try {
      const current = facadeTarget();
      return current !== null && current.origin === target.origin && current.token === target.token;
    } catch { return false; }
  }

  async function admittedRead(pathname, init) {
    if (!requiresReadAdmission) {
      // No native admission is owed on this configuration, but the browser
      // authority check still is: this is a real dispatch handoff.
      if (init?.[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
      return actionBridge.fetch(pathname, init);
    }
    let target;
    try { target = facadeTarget(); } catch { return readUnavailable(); }
    if (!target) return readUnavailable();
    const signal = init && init.signal;
    const before = await probeFacade(target, signal);
    if (before.code !== null || !sameFacade(target)) return readUnavailable();

    // The admission probe above yielded. Browser authority may have expired or
    // been displaced while it ran, so it is checked HERE, at the actual
    // dispatch handoff -- the same reasoning the write path states below.
    if (init?.[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
    const response = await actionBridge.fetch(pathname, init);

    // The local bridge has finished buffering its bounded body here. Recheck
    // this request's captured admission before releasing any of it. A new
    // credential cannot authorize an old answer, and no read is fetched again.
    // Revocation after the final authorization can still race delivery; this
    // is not an atomic transaction with the separate native process.
    if (!sameFacade(target)) return readUnavailable();
    const after = await probeFacade(target, signal);
    if (after.code !== null || !sameFacade(target)) return readUnavailable();
    return response;
  }

  /* Everything below here is the facade leg, unchanged in behaviour: it is a
     function of its own only so the switch probe can use the same credentials,
     the same header discipline and the same timeout as any other facade call
     rather than growing a second, subtly different copy of them. */
  async function forwardToFacade(pathname, init = {}, capturedTarget) {
    let target;
    try { target = capturedTarget === undefined ? facadeTarget() : capturedTarget; }
    catch (error) {
      if (error && error.code === 'AGENT_FACADE_TARGET_UNREADABLE') {
        return refusal(503, error.code);
      }
      throw error;
    }
    if (!target) return refusal(503, 'AGENT_FACADE_ABSENT');

    /* HeadersInit is not necessarily a record: a native Headers instance keeps
       its entries in its iterable interface, so object spread silently drops
       every caller header. Normalize all Fetch-supported forms before applying
       the facade's credential boundary. Keep a plain record for compatibility
       with injected fetch implementations that inspect the forwarded init. */
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    /* Case-insensitively, because a header that arrived over the wire may be
       spelled any way at all and the facade compares its own way. */
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'origin') delete headers[key];
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    headers.authorization = `Bearer ${target.token}`;

    if (init?.[BROWSER_DISPATCH_GUARD]) init[BROWSER_DISPATCH_GUARD]();
    try {
      return await fetchBridgeResponse(`${target.origin}${pathname}`, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: init.signal,
      }, { fetchImpl, timeoutMs });
    } catch (error) {
      /* The facade being unreachable is a state of this machine, not a refusal
         it made. It gets its own code so the far end does not report a reason
         the shell never gave. */
      if (error && error.code === 'BRIDGE_HTTP_TIMEOUT') return refusal(504, 'AGENT_FACADE_TIMEOUT',
        `This computer did not complete its response in time. ${UNKNOWN_OUTCOME}`);
      if (error && error.code === 'BRIDGE_HTTP_RESPONSE_TOO_LARGE') return refusal(502, 'AGENT_FACADE_RESPONSE_TOO_LARGE',
        `This computer's response exceeds the tunnel limit. ${UNKNOWN_OUTCOME}`);
      if (error && error.code === 'BRIDGE_HTTP_ABORTED') return refusal(503, 'AGENT_FACADE_ABORTED',
        `This computer's request was cancelled. ${UNKNOWN_OUTCOME}`);
      return refusal(503, 'AGENT_FACADE_UNREACHABLE',
        `This computer's response could not be completed. ${UNKNOWN_OUTCOME}`);
    }
  }

  /* MAY A TUNNELLED CALLER CHANGE ANYTHING RIGHT NOW?
   *
   * TRUE IS THE ONLY ANSWER THAT GRANTS, and it has to be read out of a 200
   * that actually said so. Every other outcome is a way of not knowing, and
   * not knowing is not permission:
   *
   *   no facade credentials     the shell never handed them over, or this is an
   *                             older build with no facade at all. main.cjs's
   *                             own armRelayFacade() already states the
   *                             consequence -- "the leg still answers reads ...
   *                             and the log says why writes will not work".
   *   unreachable, or timed out forwardToFacade turns both into its own refusal
   *                             body, which carries no mayWrite and so denies.
   *   a 200 without the field   a shell older than this gate. It must read as
   *                             OFF: inheriting "absent means allowed" is the
   *                             precise shape of the defect being closed.
   *   anything but boolean true 'on', 'true', 1 -- webDriveMayWrite() in the
   *                             shell answers a real boolean and nothing else
   *                             is that answer.
   *
   * Note this is deliberately NOT routed through fetch(): a probe that went
   * back through the front door would be one edit away from recursing.
   *
   * The answer is {mayWrite, code, status}. `code: null` means the facade
   * genuinely answered the question -- only then is "the switch is off" a true
   * thing to say to somebody. Every other row carries the facade's own code and
   * refuses just as hard. */
  function unknown(code, status) { return { mayWrite: false, code, status }; }

  async function webDriveMayWrite() {
    return probeFacade();
  }

  async function probeFacade(target, signal) {
    let response;
    try { response = await forwardToFacade(WEB_DRIVE_PROBE_PATH, { method: 'GET', signal }, target); }
    catch { return unknown('AGENT_FACADE_UNREACHABLE', 503); }
    if (!response) return unknown('AGENT_FACADE_UNREACHABLE', 503);
    let body = null;
    try { body = JSON.parse(await response.text()); } catch { body = null; }
    if (response.status !== 200) {
      /* forwardToFacade's own refusals already name the reason (absent,
         unreachable, timed out) and their status is the honest one; a non-2xx
         from the facade itself keeps its status too. */
      const named = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
      return unknown(named || 'AGENT_FACADE_UNREACHABLE', response.status);
    }
    if (!body || body.ok !== true) return unknown('AGENT_FACADE_UNREACHABLE', 503);
    /* A 200 THAT DOES NOT CARRY THE FIELD IS A SHELL OLDER THAN THIS GATE, and
       it is reported as not-knowing rather than as "the switch is off": on such
       a build the switch cannot be read at all, so pointing at it would send
       somebody to flip a control that changes nothing. Either way, no write. */
    if (typeof body.mayWrite !== 'boolean') return unknown('AGENT_FACADE_ABSENT', 503);
    return { mayWrite: body.mayWrite === true, code: null, status: 403 };
  }

  return Object.freeze({ fetch, isFacadePath, facadeTarget, isTunnelRead, webDriveMayWrite });
}

/* The environment the desktop shell's supervisor sets on this child. Named here
   so the two sides share one spelling; the supervisor writes exactly these. */
const FACADE_ORIGIN_ENV = 'TOOLSENABLED_AGENT_FACADE_ORIGIN';
const FACADE_TOKEN_ENV = 'TOOLSENABLED_AGENT_FACADE_TOKEN';

function facadeFromEnvironment(env = process.env) {
  return {
    origin: typeof env[FACADE_ORIGIN_ENV] === 'string' ? env[FACADE_ORIGIN_ENV] : null,
    token: typeof env[FACADE_TOKEN_ENV] === 'string' ? env[FACADE_TOKEN_ENV] : null,
  };
}

module.exports = Object.freeze({
  OnlineFraCompositeBridgeError,
  createCompositeBridge,
  facadeFromEnvironment,
  FACADE_ORIGIN_ENV,
  FACADE_TOKEN_ENV,
  AGENT_PREFIXES,
  AGENT_EXACT,
  TUNNEL_READS,
  isTunnelRead,
  WEB_DRIVE_REFUSAL_CODE,
  WEB_DRIVE_REFUSAL_MESSAGE,
  WEB_DRIVE_UNKNOWN_MESSAGE,
  WEB_DRIVE_PROBE_PATH,
  CONNECT_SECTION,
  WEB_DRIVE_CONTROL_LABEL,
});
