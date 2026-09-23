// EXECUTABLE CHANGE
'use strict';
// The composite bridge: one door from the tunnel, two servers behind it.
// Agent and org paths go to the desktop shell's loopback facade, whose origin
// and bearer arrive in this process's environment; everything else goes to the
// action bridge, exactly as it always did. What is tested here is mostly what
// must NOT happen -- an agent path reaching the action bridge, an Origin header
// surviving the hop, a missing facade being silently substituted for.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  createCompositeBridge,
  facadeFromEnvironment,
  FACADE_ORIGIN_ENV,
  FACADE_TOKEN_ENV,
  TUNNEL_READS,
  isTunnelRead,
  WEB_DRIVE_REFUSAL_CODE,
  WEB_DRIVE_REFUSAL_MESSAGE,
  WEB_DRIVE_PROBE_PATH,
  CONNECT_SECTION,
  WEB_DRIVE_CONTROL_LABEL
} = require('../src/lib/online-fra-composite-bridge');
const { createLocalBridge } = require('../src/lib/online-fra-local-bridge');
const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');

/* GUILTY UNTIL IT FINISHES.
   The first run of this file exited 0 and printed NOTHING: the timeout case
   below awaited a promise that only settles when the bridge's abort timer
   fires, and that timer is unref'd on purpose (a pending request must never
   hold the process open), so node emptied the loop and left silently. A test
   that evaporates reports success it never earned, which is the one failure
   mode this codebase keeps paying for. So the file fails by default and only
   the last line clears it. */
process.exitCode = 1;

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const rejects = async (p, code) => { assertions += 1; await assert.rejects(p, (e) => e.code === code, code); };

/* An action bridge that records everything handed to it and answers 200. If a
   path that belongs to the facade ever shows up in `seen`, that is the whole
   defect this module exists to prevent. */
function recordingActionBridge() {
  const seen = [];
  return {
    seen,
    async fetch(pathname, init) { seen.push({ pathname, init }); return { status: 200, headers: {}, async arrayBuffer() { return new ArrayBuffer(0); } }; }
  };
}

/* A fetch that records the URL and headers it was called with and answers 200,
   so the test can inspect what actually went on the wire to the facade. */
function recordingFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status: 200, headers: {}, async arrayBuffer() { return new ArrayBuffer(0); } };
  };
  impl.calls = calls;
  return impl;
}

async function bodyCode(response) {
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  try { return JSON.parse(text).error.code; } catch { return null; }
}

const FACADE = { origin: 'http://127.0.0.1:51234', token: 'A'.repeat(43) };

async function bodyText(response) {
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}
async function bodyMessage(response) {
  try { return JSON.parse(await bodyText(response)).error.message; } catch { return null; }
}

/* A facade that answers the web-drive probe with whatever the switch is set to
   right now, and 200s everything else. `switchState` is a function so a case can
   flip the switch between two calls and prove the answer is not cached.

   THE ROUTE IS SPELLED OUT HERE, NOT READ FROM WEB_DRIVE_PROBE_PATH, and that is
   the whole point of writing it twice. A fixture that answered whatever the
   constant happened to say would follow the constant anywhere -- including to a
   path the real facade does not route, which it would 404, which reads as "the
   switch is off" and refuses EVERY write on the machine for ever. Measured: with
   the fixture keyed to the constant, moving the probe to a route that does not
   exist left this whole file green. So the fixture models the facade's actual
   route table (desktop-app shell/agent-facade.cjs ROUTES, where
   '/v1/agent/remote-status' is one of the two the facade answers itself) and
   404s anything else on the agent surface, exactly as the facade does. */
const FACADE_REMOTE_STATUS_ROUTE = '/v1/agent/remote-status';
function facadeAnsweringSwitch(switchState) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/v1/agent/') && !String(url).endsWith(FACADE_REMOTE_STATUS_ROUTE)
      && !String(url).includes('/v1/agent/availability') && !String(url).includes('/v1/agent/start')
      && !String(url).includes('/v1/agent/history')) {
      const text = JSON.stringify({ ok: false, error: { code: 'AGENT_FACADE_UNKNOWN_ROUTE' } });
      return new Response(text, { status: 404 });
    }
    if (String(url).endsWith(FACADE_REMOTE_STATUS_ROUTE)) {
      const body = typeof switchState === 'function' ? switchState() : switchState;
      const text = JSON.stringify(body);
      return new Response(text, { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  impl.calls = calls;
  impl.probes = () => calls.filter(c => c.url.endsWith(FACADE_REMOTE_STATUS_ROUTE)).length;
  return impl;
}
const SWITCH_ON = Object.freeze({ ok: true, facade: 'ready', sessionsOpen: 0, maxSessions: 8, mayWrite: true });
const SWITCH_OFF = Object.freeze({ ok: true, facade: 'ready', sessionsOpen: 0, maxSessions: 8, mayWrite: false });

(async () => {
  // --- construction refuses rather than degrades ---------------------------
  assert.throws(() => createCompositeBridge({}), (e) => e.code === 'COMPOSITE_BRIDGE_OPTIONS_INVALID');
  assertions += 1;
  assert.throws(() => createCompositeBridge({ actionBridge: {}, facade: FACADE }), (e) => e.code === 'COMPOSITE_BRIDGE_OPTIONS_INVALID',
    'an actionBridge without fetch is refused: this module routes, it does not replace');
  assertions += 1;

  // --- the split, in both directions --------------------------------------
  {
    const action = recordingActionBridge();
    /* The switch is ON here: this block measures WHERE a request goes, and a
       gated write would never arrive anywhere to be measured. What the switch
       does when it is off has its own section further down. */
    const fetchImpl = facadeAnsweringSwitch(SWITCH_ON);
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });

    for (const facadePath of ['/v1/agent/availability', '/v1/agent/start', '/v1/org', '/v1/org/reparent', '/v1/agent/history?limit=20']) {
      await bridge.fetch(facadePath, { method: 'GET' });
    }
    equal(action.seen.length, 0, 'NO agent or org path may reach the action bridge');
    equal(fetchImpl.calls.length, 5, 'all five reached the facade');
    equal(fetchImpl.calls[0].url, `${FACADE.origin}/v1/agent/availability`, 'and reached it at the facade origin');
    equal(fetchImpl.calls[4].url, `${FACADE.origin}/v1/agent/history?limit=20`, 'query strings survive the hop intact');

    for (const otherPath of ['/v1/actions/run', '/v1/status', '/health', '/v1/organisations', '/v1/agentXextra']) {
      await bridge.fetch(otherPath, { method: 'GET' });
    }
    equal(action.seen.length, 5, 'everything else goes to the action bridge, untouched');
    equal(fetchImpl.calls.length - fetchImpl.probes(), 5,
      'and none of it reached the facade as a forwarded request -- only the switch was asked about');
  }

  /* THE NEAR-MISSES ARE THE POINT. A loose startsWith('/v1/org') would send
     /v1/organisations to the facade, and a prefix compared against the raw
     path would let a query string decide which server answers. Neither is a
     bug today; both become one the moment somebody adds a route. */
  {
    const bridge = createCompositeBridge({ actionBridge: recordingActionBridge(), facade: FACADE, fetchImpl: recordingFetch() });
    equal(bridge.isFacadePath('/v1/org'), true, 'the org root is facade traffic');
    equal(bridge.isFacadePath('/v1/org/reparent'), true);
    equal(bridge.isFacadePath('/v1/organisations'), false, 'but a longer word that merely starts the same is not');
    equal(bridge.isFacadePath('/v1/agentXextra'), false);
    equal(bridge.isFacadePath('/v1/agent/history?x=/v1/actions'), true, 'a query string cannot change the destination');
    equal(bridge.isFacadePath('/v1/actions?x=/v1/agent/start'), false, 'in either direction');
  }

  // --- ORIGIN IS STRIPPED, and this is the one that would have broken -----
  /* The facade refuses ANY request carrying an Origin header before it looks
     at the bearer. A browser at the far end of the tunnel may well put one on.
     If it survived this hop, every single agent call in the product would 403
     for a reason visible from neither end. */
  {
    const fetchImpl = recordingFetch();
    const bridge = createCompositeBridge({ actionBridge: recordingActionBridge(), facade: FACADE, fetchImpl });
    await bridge.fetch('/v1/agent/availability', {
      method: 'GET',
      headers: { Origin: 'https://toolsenabled.ai', origin: 'https://evil.example', 'content-type': 'application/json' }
    });
    const sent = fetchImpl.calls[0].init.headers;
    const names = Object.keys(sent).map(n => n.toLowerCase());
    equal(names.includes('origin'), false, 'no spelling of Origin survives the hop to the facade');
    equal(sent['content-type'], 'application/json', 'but ordinary headers do');
    equal(sent.authorization, `Bearer ${FACADE.token}`, 'and the facade bearer is the one that goes');
  }

  /* A caller's own authorization header must never reach the facade either:
     the tunnel already authenticated, and the only bearer the facade accepts
     is the one the shell minted. Forwarding somebody else's would at best 401
     and at worst hand the facade a credential it was never given. */
  {
    const fetchImpl = recordingFetch();
    const bridge = createCompositeBridge({ actionBridge: recordingActionBridge(), facade: FACADE, fetchImpl });
    await bridge.fetch('/v1/agent/availability', { headers: { Authorization: 'Bearer somebody-elses-token' } });
    equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${FACADE.token}`,
      'the caller\'s own authorization is replaced, not appended to');
  }

  // --- absent credentials refuse; they never fall through ------------------
  for (const [name, facade, expectedCode] of [
    ['nothing at all', null],
    ['origin only', { origin: FACADE.origin }],
    ['token only', { token: FACADE.token }],
    ['empty strings', { origin: '', token: '' }],
    ['a throwing reader', () => { throw new Error('unreadable'); }, 'AGENT_FACADE_TARGET_UNREADABLE'],
    ['an off-machine origin', { origin: 'http://192.168.1.9:51234', token: FACADE.token }],
    ['an https origin', { origin: 'https://toolsenabled.ai', token: FACADE.token }]
  ]) {
    const action = recordingActionBridge();
    const fetchImpl = recordingFetch();
    const bridge = createCompositeBridge({ actionBridge: action, facade, fetchImpl });
    const response = await bridge.fetch('/v1/agent/availability');
    equal(response.status, 503, `${name}: refused`);
    equal(await bodyCode(response), expectedCode || 'AGENT_FACADE_ABSENT',
      `${name}: distinguished an unreadable target from an established absence`);
    equal(action.seen.length, 0, `${name}: and the action bridge was NOT offered as a substitute`);
    equal(fetchImpl.calls.length, 0, `${name}: nothing went on the wire`);
  }

  // --- the facade being unreachable is not a refusal it made ---------------
  {
    const bridge = createCompositeBridge({
      actionBridge: recordingActionBridge(), facade: FACADE,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    const response = await bridge.fetch('/v1/agent/availability');
    equal(response.status, 503);
    equal(await bodyCode(response), 'AGENT_FACADE_UNREACHABLE',
      'an unreachable facade gets its own code, so the far end does not report a reason the machine never gave');
  }
  {
    const bridge = createCompositeBridge({
      actionBridge: recordingActionBridge(), facade: FACADE, timeoutMs: 5,
      /* A real in-flight request holds an open socket, which holds the event
         loop; this fake must hold it too, or node exits during the await and
         the case is never run. Hence the ref'd keepalive. */
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        const keepalive = setTimeout(() => {}, 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepalive);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    });
    const response = await bridge.fetch('/v1/agent/availability');
    equal(response.status, 504);
    equal(await bodyCode(response), 'AGENT_FACADE_TIMEOUT', 'and a timeout is distinguishable from a refusal');
  }

  // --- read per call, because the shell re-mints on every listen -----------
  {
    let current = { origin: FACADE.origin, token: 'A'.repeat(43) };
    const fetchImpl = recordingFetch();
    const bridge = createCompositeBridge({ actionBridge: recordingActionBridge(), facade: () => current, fetchImpl });
    await bridge.fetch('/v1/agent/availability');
    current = { origin: 'http://127.0.0.1:51999', token: 'B'.repeat(43) };
    await bridge.fetch('/v1/agent/availability');
    equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${'A'.repeat(43)}`);
    equal(fetchImpl.calls[1].init.headers.authorization, `Bearer ${'B'.repeat(43)}`,
      'a bearer captured once at startup would begin being refused after the first restart');
    equal(fetchImpl.calls[1].url.startsWith('http://127.0.0.1:51999'), true, 'and the new origin is used too');
  }

  // --- a path is a path ----------------------------------------------------
  {
    const bridge = createCompositeBridge({ actionBridge: recordingActionBridge(), facade: FACADE, fetchImpl: recordingFetch() });
    for (const bad of ['', 'v1/agent/availability', '//evil.example/v1/agent/availability', '/v1/agent/a\r\nX: y', '/v1/agent/a\0b', null, 42]) {
      await rejects(bridge.fetch(bad), 'COMPOSITE_BRIDGE_PATH_INVALID');
    }
  }

  // --- the environment handoff, spelled the same on both sides -------------
  {
    const read = facadeFromEnvironment({ [FACADE_ORIGIN_ENV]: FACADE.origin, [FACADE_TOKEN_ENV]: FACADE.token });
    equal(read.origin, FACADE.origin);
    equal(read.token, FACADE.token);
    const empty = facadeFromEnvironment({});
    equal(empty.origin, null, 'an unset environment reads as absent, not as an empty origin');
    equal(empty.token, null);
    ok(FACADE_ORIGIN_ENV === 'TOOLSENABLED_AGENT_FACADE_ORIGIN' && FACADE_TOKEN_ENV === 'TOOLSENABLED_AGENT_FACADE_TOKEN',
      'the shell\'s supervisor writes exactly these names; a rename on one side only is a silent absence');
  }

  /* ====================================================================
     THE OWNER'S WEB-DRIVE SWITCH, ON THE ACTION HALF OF THE DOOR.

     Settings promises, of the switch turned off: "a browser can see what is
     here and change nothing". Until this gate existed that was true of
     /v1/agent/* and false of everything else -- a signed-in browser could
     still dispatch an agent, terminate one, launch a billable cloud task or
     approve a purchase batch, carrying the owner's own bridge bearer, because
     webDriveMayWrite() had exactly one reader and it was the facade's
     principal. These cases are the sentence, made checkable.
     ==================================================================== */

  // --- a write with the switch OFF is refused, and the refusal names the switch
  {
    const action = recordingActionBridge();
    const fetchImpl = facadeAnsweringSwitch(SWITCH_OFF);
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });

    /* The five the defect report named by name, plus the purchase batch. Each
       is a real route in mission-bridge/server.js ROUTES. */
    for (const write of [
      '/v1/actions/dispatch', '/v1/actions/terminate', '/v1/actions/cloud-launch',
      '/v1/actions/ledger-archive', '/v1/actions/decision', '/v1/actions/queue',
      '/v1/actions/thread-reply', '/v1/actions/research-run-submit', '/v1/actions/task-submit',
      '/v1/actions/machines-link-on', '/v1/actions/owner-prompt-decision'
    ]) {
      const response = await bridge.fetch(write, { method: 'POST', body: '{}' });
      equal(response.status, 403, `${write}: refused`);
      equal(await bodyCode(response), WEB_DRIVE_REFUSAL_CODE, `${write}: with the code the product already uses`);
    }
    equal(action.seen.length, 0,
      'and NOT ONE of them reached the action bridge: a refusal after the agent has spawned is not a refusal');

    /* A SILENT FAILURE OR A BARE 403 WOULD BE WORSE THAN THE DEFECT. The relay
       web transport shows error.message when there is one and otherwise says
       "That machine turned this request down (403)", which names nothing a
       person can act on -- and the remedy for this one is on a machine they may
       not be sitting at. */
    const said = await bodyMessage(await bridge.fetch('/v1/actions/dispatch', { method: 'POST', body: '{}' }));
    ok(typeof said === 'string' && said.length > 40, `the refusal carries a sentence: ${said}`);
    ok(said.includes(CONNECT_SECTION), `it names the Settings section: ${said}`);
    ok(said.includes(WEB_DRIVE_CONTROL_LABEL), `it names the control: ${said}`);
    ok(/on that computer/i.test(said), 'and says the remedy is not here, because it is not');
    ok(!/try (once more|again)/i.test(said), 'pressing it again can never clear this');
    ok(!/close ToolsEnabled/i.test(said), 'a closed app cannot be reached from a browser at all');

    /* DRIFT LOCK across two repos. These two strings are CONNECT_SECTION and
       WEB_DRIVE_CONTROL_LABEL in desktop-app src/device-claim-flow.js (:34,
       :108) -- the same constants the app's own sentence for this code and the
       Settings row that draws the control both read. The payload cannot import
       that module, so the values are repeated; renaming the control without
       changing this line would walk a person to a switch that is not there,
       which is the exact defect that copy was written to repair. */
    equal(CONNECT_SECTION, 'Connect this computer');
    equal(WEB_DRIVE_CONTROL_LABEL, 'Let a signed-in browser drive this computer');
    equal(WEB_DRIVE_REFUSAL_CODE, 'MC_AGENT_PRINCIPAL_READ_ONLY',
      'the same code the facade half has always answered; a second vocabulary for one condition is a bug');

    /* AND THE PROBE MUST NAME A ROUTE THE FACADE ACTUALLY SERVES. This one has a
       failure mode with no error in it: a probe pointed at a route the shell
       does not route is 404'd, a 404 is not a `true`, and the machine then
       refuses every write for ever while looking exactly like a machine whose
       owner left the switch off. The route is
       desktop-app shell/agent-facade.cjs ROUTES['/v1/agent/remote-status'],
       whose own test pins that the facade answers it. */
    equal(WEB_DRIVE_PROBE_PATH, FACADE_REMOTE_STATUS_ROUTE);
    equal(bridge.isFacadePath(WEB_DRIVE_PROBE_PATH), true,
      'and it is on the facade side of the door, or it would be asked of the mission bridge instead');
  }

  // --- the same write with the switch ON goes through, untouched -----------
  {
    const action = recordingActionBridge();
    const fetchImpl = facadeAnsweringSwitch(SWITCH_ON);
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });
    const response = await bridge.fetch('/v1/actions/dispatch', { method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } });
    equal(response.status, 200, 'the switch is on, so the write is performed');
    equal(action.seen.length, 1, 'and it reached the action bridge');
    equal(action.seen[0].pathname, '/v1/actions/dispatch');
    equal(action.seen[0].init.body, '{"x":1}', 'with its body intact -- the gate decides, it does not rewrite');
    equal(action.seen[0].init.headers['content-type'], 'application/json');
  }

  // --- a READ with the switch OFF still answers ----------------------------
  /* The other half of the promise. A switch that turned the machine opaque
     would be a different feature from the one the owner ruled on. */
  {
    const action = recordingActionBridge();
    const fetchImpl = facadeAnsweringSwitch(SWITCH_OFF);
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });

    /* DISCRIMINATION REPORT (testcanfail-tests-online-fra-composite-bridge-test-js)
       MUTATION: deleted '/v1/settings' from TUNNEL_READS.GET. Before this
       assertion existed the file stayed green and printed:
         "online-fra-composite-bridge: 228 assertions passed"
       That proved the loop below derived both its cases and its expected count
       from the subject under test. Pin the reviewed policy independently so a
       deleted route cannot also delete its own test case. With this assertion,
       the same mutation is RED:
         "AssertionError [ERR_ASSERTION]: the reviewed tunnel-read policy cannot delete its own test cases"
         "+ actual - expected ... Lines skipped"
         "-     '/v1/settings',"
         "at /workspace/engine/tests/online-fra-composite-bridge.test.js:403:12"

       NOT-FOUND (1): all other loops iterate non-empty literals; the sole
       product-derived loop is now preceded by this independent full census.
       NOT-FOUND (2): no exit-status or truthy process-result assertion.
       NOT-FOUND (3): no try/catch or optional chain swallows an assertion;
       JSON helpers return null, which their callers reject.
       NOT-FOUND (4): injected bridges/fetches measure routing boundaries, not
       mocked implementations of createCompositeBridge/isTunnelRead.
       NOT-FOUND (5): no skip or platform precondition guard.
       NOT-FOUND (6): fixed here; the TUNNEL_READS-derived cases/count were the
       one expectation computed from the same product value being checked.

       PRECONDITION: the installed Node 20 lacks node:sqlite (the package
       requires Node >=22.19). Runs used a /tmp preload supplying only the
       load-time DatabaseSync symbol; this test never constructs it. */
    assert.deepEqual(TUNNEL_READS, {
      GET: [
        '/v1/runtime',
        '/v1/contract',
        '/v1/status',
        '/v1/settings',
        '/v1/owner-prompts',
        '/v1/research/local-tiers-status'
      ],
      POST: [
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
        '/v1/actions/task-list'
      ]
    }, 'the reviewed tunnel-read policy cannot delete its own test cases');
    assertions += 1;

    const reads = [
      ...TUNNEL_READS.GET.map(p => [p, 'GET']),
      ...TUNNEL_READS.POST.map(p => [p, 'POST'])
    ];
    for (const [route, method] of reads) {
      const response = await bridge.fetch(route, { method });
      equal(response.status, 200, `${method} ${route}: still answered with the switch off`);
    }
    equal(action.seen.length, reads.length, 'every read reached the bridge');
    equal(fetchImpl.probes(), 2 * reads.length,
      'each native admission is checked before dispatch and after the buffered read; Drive OFF still permits reads');

    // A query string does not change whether something is a read.
    equal((await bridge.fetch('/v1/status?x=1', { method: 'GET' })).status, 200);
    // ...nor does it smuggle a write in behind one.
    equal((await bridge.fetch('/v1/actions/dispatch?x=/v1/status', { method: 'POST' })).status, 403);
  }

  // --- WHAT COUNTS AS A READ IS AN ALLOWLIST, AND IT FAILS CLOSED ----------
  {
    equal(isTunnelRead('GET', '/v1/status'), true);
    equal(isTunnelRead('GET', '/v1/contract'), true, 'credentialed contract discovery is a read');
    equal(isTunnelRead('POST', '/v1/contract'), false, 'no contract write route is opened');
    equal(isTunnelRead('GET', '/v1/contractX'), false, 'contract metadata uses an exact route');
    equal(isTunnelRead('POST', '/v1/status'), false, 'a read route reached by the wrong verb is not a read');
    equal(isTunnelRead('GET', '/v1/actions/task-get'), false, 'and neither is a POST read reached by GET');
    equal(isTunnelRead('POST', '/v1/actions/task-get'), true);
    equal(isTunnelRead('DELETE', '/v1/status'), false, 'a verb with no read list at all is not a read');
    equal(isTunnelRead('get', '/v1/status'), false, 'an unrecognised spelling is not a read either');
    equal(isTunnelRead('GET', '/v1/statusX'), false, 'exact routes only -- a longer word that starts the same is not one');
    equal(isTunnelRead('GET', '/v1/status/../actions/dispatch'), false);
    equal(isTunnelRead('POST', '/v1/actions/dispatch'), false, 'the whole point');

    /* `terminate` IS in NON_OUTWARD_ACTIONS, and that set answers a DIFFERENT
       question -- may this run during a kill event -- yes, because stopping a
       lane reduces activity. It kills a running agent. It is not a read. */
    equal(TUNNEL_READS.POST.includes('/v1/actions/terminate'), false,
      'terminate is not a read, whatever the kill-switch carve-out says about it');
    /* Failed closed on purpose, both named in the module. */
    equal(isTunnelRead('GET', '/v1/bootstrap'), false, 'the route that hands out this machine\'s bearer is not a "read"');
    equal(isTunnelRead('POST', '/v1/actions/machines-link-status'), false,
      'machines-actions.js declined to widen its own carve-out; that default is followed, not overridden');

    /* Anything nobody has classified is a write. This is the property that
       makes the list survive the next route somebody adds. */
    equal(isTunnelRead('POST', '/v1/actions/a-route-invented-tomorrow'), false);
    equal(isTunnelRead('GET', '/some/path/nobody/declared'), false);
  }

  // --- EVERY WAY OF NOT KNOWING IS A REFUSAL, NOT A GRANT ------------------
  /* Four separate ways the probe can fail to produce a `true`, each its own
     case, because "unreadable resolved to may-write through some shortcut" is
     the only defect that would matter here. */
  /* TWO REFUSALS, AND THE PERSON IS TOLD WHICH. Both change nothing, so both
     are safe -- but they are not both TRUE. "Go and turn the switch on" said to
     someone whose switch is already on, because the machine could not be asked,
     sends them to a screen where everything looks right and leaves them with no
     next move: the exact loop this vocabulary exists to escape. So a machine
     that ANSWERED gets the switch sentence, and a machine that could not be
     asked keeps the facade's own code and says so. */
  {
    // ---- the machine answered: the switch really is off ------------------
    for (const [name, body] of [
      ['mayWrite false', { ok: true, facade: 'ready', sessionsOpen: 0, maxSessions: 8, mayWrite: false }]
    ]) {
      const action = recordingActionBridge();
      const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl: facadeAnsweringSwitch(body) });
      const response = await bridge.fetch('/v1/actions/dispatch', { method: 'POST' });
      equal(response.status, 403, `${name}: refused`);
      equal(await bodyCode(response), WEB_DRIVE_REFUSAL_CODE, `${name}: named as the switch`);
      ok((await bodyMessage(response)).includes(WEB_DRIVE_CONTROL_LABEL), `${name}: and points at the control`);
      equal(action.seen.length, 0, `${name}: nothing performed`);
    }

    // ---- every way of NOT KNOWING: refused just as hard, named honestly ---
    for (const [name, options] of [
      ['no facade credentials at all', { facade: null, fetchImpl: facadeAnsweringSwitch(SWITCH_ON) }],
      ['a facade that is unreachable', { facade: FACADE, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }],
      ['a probe that answers non-200', { facade: FACADE, fetchImpl: async () => ({ status: 500, headers: {}, async text() { return '{"mayWrite":true}'; }, async arrayBuffer() { return new ArrayBuffer(0); } }) }],
      ['a body that is not JSON', { facade: FACADE, fetchImpl: async () => ({ status: 200, headers: {}, async text() { return 'not json'; }, async arrayBuffer() { return new ArrayBuffer(0); } }) }],
      ['an OLDER SHELL with no mayWrite field', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: true, facade: 'ready', sessionsOpen: 0, maxSessions: 8 }) }],
      ['ok:false with mayWrite true', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: false, mayWrite: true }) }],
      ['mayWrite as the STRING "true"', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: true, mayWrite: 'true' }) }],
      ['mayWrite as the string "on"', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: true, mayWrite: 'on' }) }],
      ['mayWrite as 1', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: true, mayWrite: 1 }) }],
      ['mayWrite as null', { facade: FACADE, fetchImpl: facadeAnsweringSwitch({ ok: true, mayWrite: null }) }]
    ]) {
      const action = recordingActionBridge();
      const bridge = createCompositeBridge({ actionBridge: action, ...options });
      const response = await bridge.fetch('/v1/actions/dispatch', { method: 'POST' });
      ok(response.status >= 400, `${name}: refused (${response.status})`);
      equal(action.seen.length, 0, `${name}: and NOTHING was performed -- not knowing is not permission`);

      const code = await bodyCode(response);
      ok(/^AGENT_FACADE_/.test(code), `${name}: kept the facade's own code rather than blaming the switch (${code})`);
      const said = await bodyMessage(response);
      ok(typeof said === 'string' && said.length > 40, `${name}: carries a sentence, not a bare code: ${said}`);
      ok(!said.includes(WEB_DRIVE_CONTROL_LABEL),
        `${name}: and does NOT send the person to flip a switch that may already be on`);
      ok(/open ToolsEnabled/i.test(said), `${name}: it names what would actually help`);

      const read = await bridge.fetch('/v1/status', { method: 'GET' });
      if (options.facade === null) {
        equal(read.status, 200, 'the explicit standalone mode retains its existing read behavior');
        equal(action.seen.length, 1, 'the standalone read was dispatched once');
      } else {
        equal(read.status, 503, `${name}: a configured native admission must be confirmed for reads too`);
        equal(await bodyCode(read), 'AGENT_FACADE_CONNECTION_CLOSED', `${name}: a fixed refusal hides probe errors`);
        equal(action.seen.length, 0, `${name}: the read was not dispatched`);
      }
    }
  }

  // A credential replacement cannot authorize an older request, including a
  // replacement that arrives while the preflight or final probe is awaiting.
  for (const changeAt of ['preflight', 'local-read', 'final-probe']) {
    let current = { ...FACADE };
    let probes = 0;
    let reads = 0;
    const credentialsUsed = [];
    const replace = () => { current = { origin: FACADE.origin, token: 'B'.repeat(43) }; };
    const bridge = createCompositeBridge({
      facade: () => current,
      actionBridge: { async fetch() {
        reads += 1;
        if (changeAt === 'local-read') replace();
        return new Response('private-old-answer');
      } },
      fetchImpl: async (url, init) => {
        probes += 1;
        credentialsUsed.push(init.headers.authorization);
        if ((changeAt === 'preflight' && probes === 1) || (changeAt === 'final-probe' && probes === 2)) replace();
        return new Response(JSON.stringify(SWITCH_OFF));
      }
    });
    const response = await bridge.fetch('/v1/status');
    equal(response.status, 503, `${changeAt}: replacement invalidates the earlier admission`);
    equal(await bodyCode(response), 'AGENT_FACADE_CONNECTION_CLOSED');
    ok(!(await bodyText(response)).includes('private-old-answer'), `${changeAt}: no old body released`);
    equal(reads, changeAt === 'preflight' ? 0 : 1, `${changeAt}: no dispatch before authority and no refetch`);
    ok(credentialsUsed.every(value => value === `Bearer ${FACADE.token}`), `${changeAt}: probes never adopt the replacement credential`);
  }

  for (const [name, facade] of [
    ['missing supervised credentials', () => null],
    ['unreadable supervised credentials', () => { throw new Error('private credential source error'); }],
    ['partial credentials', { origin: FACADE.origin }],
    ['off-machine target', { origin: 'https://remote.example', token: FACADE.token }]
  ]) {
    const action = recordingActionBridge();
    const fetchImpl = recordingFetch();
    const response = await createCompositeBridge({ actionBridge: action, facade, fetchImpl }).fetch('/v1/status');
    equal(response.status, 503, `${name}: no standalone fallback`);
    equal(await bodyCode(response), 'AGENT_FACADE_CONNECTION_CLOSED');
    equal(action.seen.length, 0, `${name}: no action bridge call`);
    equal(fetchImpl.calls.length, 0, `${name}: no facade network call`);
    ok(!(await bodyText(response)).includes('private credential source error'), `${name}: no raw source error`);
  }

  // --- READ PER CALL, because flipping the switch does not respawn the child
  /* main.cjs reads the switch per command for exactly this reason: "turning it
     off takes effect on the next command instead of on the next launch". The
     relay child is NOT restarted when mc-prefs:write lands, so a value captured
     at spawn would go on granting a permission the owner had withdrawn. */
  {
    let on = true;
    const action = recordingActionBridge();
    const fetchImpl = facadeAnsweringSwitch(() => (on ? SWITCH_ON : SWITCH_OFF));
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });

    equal((await bridge.fetch('/v1/actions/dispatch', { method: 'POST' })).status, 200, 'on: performed');
    on = false;
    equal((await bridge.fetch('/v1/actions/dispatch', { method: 'POST' })).status, 403,
      'turned off between two calls, the second is refused -- with no restart of anything');
    on = true;
    equal((await bridge.fetch('/v1/actions/dispatch', { method: 'POST' })).status, 200, 'and back on again');
    equal(action.seen.length, 2, 'exactly the two that were allowed');
    equal(fetchImpl.probes(), 3, 'one probe per write, never a cached answer');
  }

  /* ====================================================================
     THE DESK IS UNAFFECTED.

     This is the regression that would hurt the owner most: a gate that also
     locked him out of his own application is worse than the defect it closes.

     The proof is not an assertion about the code, it is the same live mission
     bridge driven twice with the switch OFF -- once the way the person sitting
     at the machine drives it (a direct loopback request at an allowed dashboard
     origin, carrying the bridge's own bearer), and once the way a browser over
     the relay does (through the composite bridge). One must succeed and one
     must be refused, in the same process, against the same server, in the same
     switch state.
     ==================================================================== */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-drive-gate-'));
    const runtimeFile = path.join(dir, 'runtime.json');
    const tokenFile = path.join(dir, 'token.json');
    const token = crypto.randomBytes(32);
    const bearer = token.toString('base64url');
    const DESK_ORIGIN = 'http://127.0.0.1:4600';

    /* Injected actions: this test is about who may reach the write, not about
       what the write does. A real dispatch() spawns an agent. */
    const performed = [];
    const actions = {
      dispatch: async (input) => { performed.push(['dispatch', input]); return { ok: true, receipt: { action: 'dispatch' } }; },
      status: async () => ({ ok: true, receipt: { action: 'status' } })
    };

    const bridge = createMissionBridgeServer({
      actions,
      token,
      bootstrapProof: crypto.randomBytes(32),
      allowedOrigins: [DESK_ORIGIN],
      allowTestPortZero: true,
      allowTestRuntimeFile: true,
      runtimeFile,
      /* icacls is the production ACL step; this file is in a temp dir the test
         owns and deletes, and spawning it here would only slow the case down. */
      runtimeDependencies: { spawnSyncImpl: false }
    });
    const listening = await bridge.listen(0);

    try {
      fs.writeFileSync(tokenFile, JSON.stringify({ token: bearer }));

      // ---- 1. THE PERSON AT THE KEYBOARD, with the switch OFF --------------
      /* Exactly what desktop-app src/mission-bridge.js does with no relay
         transport installed: its own origin, the bearer it bootstrapped. */
      const desk = await globalThis.fetch(`${listening.baseUrl}/v1/actions/dispatch`, {
        method: 'POST',
        headers: { origin: DESK_ORIGIN, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ brief: 'from the desk' })
      });
      equal(desk.status, 200, 'THE DESK STILL WRITES with the switch off; the switch is about browsers, not about him');
      equal((await desk.json()).ok, true);
      equal(performed.length, 1, 'and the action really ran');

      // ---- 2. A BROWSER OVER THE RELAY, same server, same switch state -----
      const relay = createCompositeBridge({
        actionBridge: createLocalBridge({ runtimeFile, tokenFile }),
        facade: FACADE,
        fetchImpl: facadeAnsweringSwitch(SWITCH_OFF)
      });
      const refused = await relay.fetch('/v1/actions/dispatch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: 'from a browser' })
      });
      equal(refused.status, 403, 'the browser is refused');
      equal(await bodyCode(refused), WEB_DRIVE_REFUSAL_CODE);
      equal(performed.length, 1, 'and the action did NOT run a second time');

      // ---- 3. and the browser can still LOOK at the same live bridge -------
      const seen = await relay.fetch('/v1/status', { method: 'GET' });
      equal(seen.status, 200, 'a browser-over-relay read still answers from the real bridge');
      equal(JSON.parse(await bodyText(seen)).ok, true);

      // ---- 4. with the switch ON, the browser writes to the same server ----
      const allowed = createCompositeBridge({
        actionBridge: createLocalBridge({ runtimeFile, tokenFile }),
        facade: FACADE,
        fetchImpl: facadeAnsweringSwitch(SWITCH_ON)
      });
      const wrote = await allowed.fetch('/v1/actions/dispatch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: 'switch on' })
      });
      equal(wrote.status, 200, 'switch on: the browser writes');
      equal(performed.length, 2, 'and this one really ran -- so case 2 was the gate, not a broken fixture');
    } finally {
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* THE GATE CANNOT BE WALKED AROUND, because there is nothing to walk around
     it to. The action bridge is constructed at exactly one place in this
     payload and handed straight into the composite bridge; no other module
     holds a reference to it, and nothing reaches the tunnel's HTTP surface
     except online-fra-relay-shell.js's single localBridge.fetch call. If that
     ever stops being true, this fails and says so. */
  {
    const root = path.resolve(__dirname, '..');
    const constructors = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        /* The lookbehind drops the DEFINITION -- `function createLocalBridge(`
           in the module that owns it. Defining the factory is not opening a
           door; calling it is. */
        if (/(?<!function\s)\bcreateLocalBridge\s*\(/.test(text)) constructors.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    };
    for (const where of ['src', 'tools', 'bin']) {
      const dir = path.join(root, where);
      if (fs.existsSync(dir)) walk(dir);
    }
    assert.deepEqual(constructors, ['tools/relay-shell.js'],
      'the action bridge is built in exactly one place, and that place wraps it in the composite bridge; '
      + `a second construction site would be a second, ungated door: ${constructors.join(', ')}`);
    assertions += 1;

    const wiring = fs.readFileSync(path.join(root, 'tools', 'relay-shell.js'), 'utf8');
    ok(/localBridge:\s*createCompositeBridge\(/.test(wiring),
      'and the relay shell is handed the composite bridge, never the action bridge directly');

    // Execute the actual CLI construction in a VM, stopping before its relay
    // starts. Only transport/vault dependencies are replaced; the configured
    // composite is real. No account, vault, or external network is touched.
    for (const [name, supervised, env, expected] of [
      ['bare CLI', false, {}, 200],
      ['parent IPC without credentials', true, {}, 503],
      ['CLI origin only', false, { [FACADE_ORIGIN_ENV]: FACADE.origin }, 503],
      ['CLI token only', false, { [FACADE_TOKEN_ENV]: FACADE.token }, 503],
      ['CLI empty credentials', false, { [FACADE_ORIGIN_ENV]: '', [FACADE_TOKEN_ENV]: '' }, 503],
      ['parent IPC with credentials', true, { [FACADE_ORIGIN_ENV]: FACADE.origin, [FACADE_TOKEN_ENV]: FACADE.token }, 200],
      ['CLI with credentials', false, { [FACADE_ORIGIN_ENV]: FACADE.origin, [FACADE_TOKEN_ENV]: FACADE.token }, 200]
    ]) {
      const stop = new Error('captured construction before relay start');
      const action = recordingActionBridge();
      let selected;
      assert.throws(() => vm.runInNewContext(wiring, {
        process: { env, argv: ['node', 'relay-shell.js'], send: supervised ? () => {} : undefined, on() {} },
        require(name) {
          if (name === '../src/lib/online-fra-relay-shell') return { createRelayShell(options) { selected = options.localBridge; throw stop; } };
          if (name === '../src/lib/online-fra-relay-close') return require('../src/lib/online-fra-relay-close');
          if (name === '../src/lib/online-fra-local-bridge') return { createLocalBridge: () => action };
          if (name === '../src/lib/online-fra-composite-bridge') return { facadeFromEnvironment,
            createCompositeBridge: options => createCompositeBridge({ ...options, fetchImpl: facadeAnsweringSwitch(SWITCH_OFF) }) };
          if (name === '../src/lib/online-fra-desktop-controller') return { createDesktopController: () => ({}) };
          if (name === '../src/lib/runtime') return { getSecret() { throw new Error('vault accessed'); }, setSecret() { throw new Error('vault accessed'); } };
          throw new Error(`unexpected CLI dependency: ${name}`);
        }
      }, { timeout: 1000 }), error => error === stop);
      assertions += 1;
      equal((await selected.fetch('/v1/status')).status, expected, `${name}: actual entrypoint chooses the correct read admission`);
      equal(action.seen.length, expected === 200 ? 1 : 0, `${name}: only an admitted or explicitly standalone read reaches the bridge`);
    }
  }

  // --- HeadersInit is not a record ------------------------------------------
  /* A CALLER'S HEADERS USED TO VANISH IF THEY ARRIVED AS A Headers INSTANCE.
   *
   * `{ ...init.headers }` looks like it copies headers and does not: a native
   * Headers keeps its entries behind its iterable interface and has NO
   * enumerable own properties, so the spread produced {} and every header the
   * caller set was dropped before the facade's credential boundary was applied.
   * `{ ...new Headers({ authorization: 'x' }) }` is `{}` -- run it.
   *
   * A plain object works, which is why this survived: every call site in the
   * tree passes one today. The first caller to pass what the Fetch API says is
   * a HeadersInit would have had its headers silently disappear, and a header
   * that disappears does not fail loudly -- the request just behaves as though
   * nobody asked for anything.
   *
   * Both shapes are driven below because a fix that reads only Headers would
   * break the plain-object callers that exist now. */
  {
    const action = recordingActionBridge();
    const fetchImpl = facadeAnsweringSwitch(SWITCH_ON);
    const bridge = createCompositeBridge({ actionBridge: action, facade: FACADE, fetchImpl });

    await bridge.fetch('/v1/agent/availability', {
      method: 'GET',
      headers: new Headers({ 'x-mc-trace': 'abc', 'content-type': 'application/json' }),
    });
    const viaHeaders = fetchImpl.calls.at(-1).init.headers;
    equal(viaHeaders['x-mc-trace'], 'abc',
      'a header set through a Headers instance was dropped: object spread cannot see them, and a header that vanishes fails silently');
    equal(viaHeaders['content-type'], 'application/json', 'and so was content-type');

    await bridge.fetch('/v1/agent/availability', {
      method: 'GET',
      headers: { 'x-mc-trace': 'plain' },
    });
    equal(fetchImpl.calls.at(-1).init.headers['x-mc-trace'], 'plain',
      'a plain object must still work -- every caller in the tree passes one, and a Headers-only fix would break all of them');

    /* THE BOUNDARY STILL APPLIES TO THE NORMALISED SHAPE -- widening what the
       module can READ must not widen what a caller may SET.

       WHAT THESE TWO LINES ACTUALLY HOLD, MEASURED RATHER THAN ASSUMED:
         delete the ORIGIN strip                 -> this goes red
         delete the facade credential assignment -> this goes red
         delete the AUTHORIZATION strip          -> THIS STAYS GREEN
       The last one is not a gap in the product and it is not covered either. The
       assignment two lines below the strip overwrites headers.authorization
       unconditionally, so removing the strip is unobservable from outside: the
       right value goes out either way. That makes the strip's correctness rest
       entirely on the assignment that follows it, which is a coupling worth
       knowing about -- reorder those two and the strip becomes load-bearing with
       nothing watching it. Said here rather than left for somebody to discover
       by trusting a green run. */
    await bridge.fetch('/v1/agent/availability', {
      method: 'GET',
      headers: new Headers({ authorization: 'Bearer forged', origin: 'https://evil.example' }),
    });
    const fenced = fetchImpl.calls.at(-1).init.headers;
    equal(fenced.authorization, `Bearer ${FACADE.token}`,
      'a caller-supplied authorization survived the hop -- reading Headers must not also let one through');
    equal(fenced.origin, undefined, 'a caller-supplied origin survived the hop');
  }

  console.log(`online-fra-composite-bridge: ${assertions} assertions passed`);
  process.exitCode = 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
