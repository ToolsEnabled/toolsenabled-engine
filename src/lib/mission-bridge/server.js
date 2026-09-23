'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const uac = require('../uac-delegation');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');
// state/ is per-user runtime data, not a program resource. Installed, it
// resolves under the user's own state root instead of into the directory the
// program was installed to -- which the three files below made an especially
// sharp problem, being a per-boot bearer, its bootstrap proof, and the
// discovery record that points at them. src/lib/runtime-state-root.js.
const { statePath } = require('../runtime-state-root');
const { createMissionActions } = require('./actions');
const { resolveAgentSessionCredential } = require('../agent-session-credential');
const { REQUEST_BODY_SHA256 } = require('./termination');
const { MissionBridgeError, typedError } = require('./errors');
const { createBridgeApiContract } = require('./api-contract');

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT_MIN = 4610;
const DEFAULT_PORT_MAX = 4619;
const DEFAULT_PORTS = Object.freeze(Array.from(
  { length: DEFAULT_PORT_MAX - DEFAULT_PORT_MIN + 1 },
  (_value, index) => DEFAULT_PORT_MIN + index
));
// The dashboard/app seam is declared (config/managed-processes.json's
// mission-bridge entry, DYNAMIC-PORTS-REPORT.md) to live in the bounded port
// range immediately below the bridge's own DEFAULT_PORT_MIN..MAX listener
// range. An allowed origin outside 4600..4609 -- including, notably, the
// bridge's own 4610..4619 range -- is always a configuration mistake, never
// a legitimate dashboard instance. MAX_ALLOWED_ORIGINS bounds how wide a
// single misconfiguration can ever make the allowlist; it does not by
// itself narrow whatever a caller actually declares (N9, R1162 Stage 0).
const ORIGIN_PORT_MIN = 4600;
const ORIGIN_PORT_MAX = 4609;
const MAX_ALLOWED_ORIGINS = 16;
const MAX_BODY_BYTES = 32 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const TOKEN_FILE = statePath('state', 'mission-bridge-token.json');
const RUNTIME_FILE = statePath('state', 'mission-bridge-runtime.json');
// N9 fix: /v1/bootstrap used to hand out the bearer on the Origin/CORS check
// alone (Bucket B -- "loopback is not a control against the local-attacker
// premise", R1162-SECCOUNCIL-FINAL-SYNTHESIS.md D9). A browser Origin header
// is trivially forgeable by any local, non-browser HTTP client, so it was
// never real authorization for a same-user attacker -- only for a genuine
// cross-origin browser fetch. This file carries a per-boot secret that is
// ACL'd to the owner principal exactly like TOKEN_FILE/RUNTIME_FILE below;
// unlike the Origin header, a sandboxed web page (XSS in the dashboard, a
// malicious ad/extension, a page merely loaded at an allowed origin) cannot
// read it, because that requires real local filesystem access, not just an
// Origin string. A local launcher that already has filesystem access reads
// this file and passes its value to /v1/bootstrap as ?proof=; the bearer
// itself is never required to obtain the bearer, which would be circular.
const BOOTSTRAP_PROOF_FILE = statePath('state', 'mission-bridge-bootstrap-proof.json');
const ROUTES = Object.freeze({
  '/v1/actions/dispatch': 'dispatch',
  '/v1/actions/report-read': 'readReport',
  // Read-only: what happened to a launch this bridge already handed over.
  '/v1/actions/launch-status': 'launchStatus',
  '/v1/actions/queue': 'queue',
  '/v1/actions/thread-reply': 'reply',
  '/v1/actions/decision': 'decide',
  '/v1/actions/terminate': 'terminate',
  '/v1/actions/ledger-archive': 'ledgerArchive',
  // The in-app owner popup's two write actions. Mission Control's renderer
  // (wt-installer src/mission-bridge.js ACTION_ROUTES) posts exactly these
  // paths; its read half is GET /v1/owner-prompts below.
  '/v1/actions/owner-prompt-presented': 'ownerPromptPresented',
  '/v1/actions/owner-prompt-decision': 'ownerPromptDecision',
  // Codex Cloud. These are POST even when an individual action only reads,
  // because this router authorizes and error-shapes exactly one method and
  // adding a GET family here would mean a second, differently-checked path
  // into the same actions. The read/write distinction that matters is enforced
  // where it is enforced for everything else -- the tool's declared effect,
  // which decides the permission tier, the approvals gate and the audit class.
  '/v1/actions/cloud-accounts': 'cloudAccounts',
  '/v1/actions/cloud-mirror-list': 'cloudMirrorList',
  '/v1/actions/cloud-mirror-register': 'cloudMirrorRegister',
  '/v1/actions/cloud-mirror-disable': 'cloudMirrorDisable',
  '/v1/actions/cloud-mirror-publish': 'cloudMirrorPublish',
  '/v1/actions/cloud-tasks': 'cloudTasks',
  '/v1/actions/cloud-task-status': 'cloudTaskStatus',
  '/v1/actions/cloud-launch': 'cloudLaunch',
  // The research family. All POST for the same reason the cloud family is:
  // one router, one auth check, one error shape; read-vs-write is enforced at
  // the provider behind the action, not by the HTTP verb.
  '/v1/actions/research-snapshot': 'researchSnapshot',
  '/v1/actions/research-runs': 'researchRuns',
  '/v1/actions/research-results': 'researchResults',
  '/v1/actions/research-findings': 'researchFindings',
  '/v1/actions/research-project-save': 'researchProjectSave',
  '/v1/actions/research-experiment-save': 'researchExperimentSave',
  '/v1/actions/research-run-submit': 'researchRunSubmit',
  '/v1/actions/research-session-assign': 'researchSessionAssign',
  '/v1/actions/research-finding-save': 'researchFindingSave',
  '/v1/actions/research-lifecycle': 'researchLifecycle',
  // The machines family: the direct link between the owner's computers,
  // driven by tools/direct-link.ps1 through machines-actions.js. All POST for
  // the same one-router/one-auth-check/one-error-shape reason as the families
  // above. None is in NON_OUTWARD_ACTIONS, so all three are refused during a
  // kill event — the conservative default for a family that can open a
  // network listener. Deliberately no "settings" in any path or action name:
  // tests/settings-surface-readonly.test.js forbids it, and these are
  // controls, not settings writes.
  '/v1/actions/machines-link-status': 'machinesLinkStatus',
  '/v1/actions/machines-link-on': 'machinesLinkOn',
  '/v1/actions/machines-link-off': 'machinesLinkOff',
  /* The research bench family: the durable task queue, and the bounded local
     judge. Each wraps the same registered tool the MCP surface serves — see
     the bench section of actions.js. */
  '/v1/actions/task-submit': 'taskSubmit',
  '/v1/actions/task-claim': 'taskClaim',
  '/v1/actions/task-get': 'taskGet',
  '/v1/actions/task-list': 'taskList',
  '/v1/actions/role-complete': 'roleComplete'});
const API_CONTRACT = createBridgeApiContract(ROUTES);

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeRuntimeRecord(value) {
  if (!plain(value)
      || Reflect.ownKeys(value).some(key => !['baseUrl', 'port', 'startedAt', 'pid'].includes(key))
      || ['baseUrl', 'port', 'startedAt', 'pid'].some(key => !Object.hasOwn(value, key))) {
    throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_INVALID', 'Runtime discovery record is invalid.', { status: 500 });
  }
  let parsed;
  try { parsed = new URL(value.baseUrl); }
  catch { throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_INVALID', 'Runtime discovery baseUrl is invalid.', { status: 500 }); }
  const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
  if (parsed.protocol !== 'http:' || parsed.hostname !== LOOPBACK || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || parsed.port !== String(value.port)
      || !Number.isFinite(startedAtMs) || new Date(startedAtMs).toISOString() !== value.startedAt
      || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_INVALID', 'Runtime discovery record is invalid.', { status: 500 });
  }
  return Object.freeze({ baseUrl: parsed.origin, port: value.port, startedAt: value.startedAt, pid: value.pid });
}

function writeRuntimeDiscovery(value, dependencies = {}) {
  const record = normalizeRuntimeRecord(value);
  const runtimeFile = path.resolve(dependencies.runtimeFile || RUNTIME_FILE);
  if (runtimeFile !== RUNTIME_FILE && dependencies.allowTestRuntimeFile !== true) {
    throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_PATH_REFUSED', 'Production runtime discovery path is fixed inside state/.', { status: 500 });
  }
  const io = dependencies.fs || fs;
  const temporary = `${runtimeFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    io.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    io.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    const platform = dependencies.platform || process.platform;
    if (platform === 'win32' && dependencies.spawnSyncImpl !== false) {
      const principal = uac.ownerPrincipal(dependencies);
      const run = dependencies.spawnSyncImpl || spawnSync;
      const acl = run('\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe', [path.toNamespacedPath(temporary), '/inheritance:r', '/grant:r', `${principal}:(F)`], {
        encoding: 'utf8', stdio: 'ignore', windowsHide: true, shell: false, timeout: 15_000,
        env: safeLaunchEnvironment()
      });
      if (acl.error || acl.status !== 0) {
        throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE', 'Runtime discovery file could not be access-controlled to the owner only.', { status: 500 });
      }
    }
    io.renameSync(temporary, runtimeFile);
    return Object.freeze({ record, runtimeFile });
  } catch (error) {
    if (created) { try { io.unlinkSync(temporary); } catch {} }
    if (error instanceof MissionBridgeError) throw error;
    /* A BUSY MACHINE IS NOT A BROKEN ONE (T454).
     *
     * ownerPrincipal() above reads this process's own Windows identity so the
     * discovery record can be ACLed to the owner alone. When that probe does
     * not ANSWER -- a loaded box, not a wrong answer -- it now says so with its
     * own code, and this must not flatten that into the same sentence as a disk
     * that refused a write. It used to: the identity probe timed out at five
     * seconds, this turned it into BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE,
     * listen() closed the server, and the app printed
     * `[capability-layer] not started: CAPABILITY_EXITED`. Nothing retried,
     * because nothing downstream could tell there was anything to retry.
     *
     * The record is still not written -- an unACLed discovery file naming a
     * live loopback bearer is not an acceptable fallback -- but the refusal now
     * carries the one fact a caller needs to act on it. */
    if (error?.code === 'UAC_OWNER_PRINCIPAL_UNAVAILABLE') {
      throw new MissionBridgeError(
        'BRIDGE_OWNER_IDENTITY_UNAVAILABLE',
        'This computer has not yet reported which account the capability layer is running as, so its discovery record cannot be restricted to that account. This is usually a busy machine, and it can be retried.',
        { status: 503, details: { retryable: true } }
      );
    }
    throw new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE', 'Runtime discovery file could not be written.', { status: 500 });
  }
}

/* HOW LONG listen() KEEPS TRYING TO WRITE ITS DISCOVERY RECORD, and why it
 * keeps the listener open while it does.
 *
 * The server is already bound and healthy at this point; the only thing that
 * has not happened is naming the owner it should be ACLed to. Closing the
 * listener for that -- which is what a single failure used to do -- throws away
 * a working capability layer over a question that answers itself a moment
 * later. Only a RETRYABLE refusal is retried: a real write failure, a refused
 * path, a wrong-but-answered identity all still fail on the first attempt. */
const DISCOVERY_RETRY_ATTEMPTS = 4;
const DISCOVERY_RETRY_BACKOFF_MS = Object.freeze([0, 500, 1500, 3000]);

function retryableDiscoveryFailure(error) {
  return error instanceof MissionBridgeError && error.details?.retryable === true;
}

function removeRuntimeDiscovery(expected, dependencies = {}) {
  if (!expected) return;
  const runtimeFile = path.resolve(dependencies.runtimeFile || RUNTIME_FILE);
  const io = dependencies.fs || fs;
  try {
    const current = JSON.parse(io.readFileSync(runtimeFile, 'utf8'));
    if (JSON.stringify(normalizeRuntimeRecord(current)) === JSON.stringify(expected)) io.unlinkSync(runtimeFile);
  } catch (error) {
    // ENOENT means the file is already gone -- another close(), or an
    // operator cleanup, got there first, and that is not a failure. Any
    // other error (EACCES, EBUSY, EPERM, a JSON.parse throw on a corrupt
    // file, ...) means the stale discovery record may still be sitting
    // there pointing at a dead bridge, and swallowing it silently was the
    // defect: a caller could believe close() fully cleaned up when it did
    // not. Only ENOENT is safe to ignore.
    if (error?.code !== 'ENOENT') throw error;
  }
}

function errorBody(error, requestId) {
  const typed = error instanceof MissionBridgeError ? error : typedError(error);
  return {
    status: typed.status,
    body: {
      ok: false,
      error: {
        code: typed.code,
        message: typed.message,
        requestId,
        ...(typed.details ? { details: typed.details } : {})
      }
    }
  };
}

function originSet(values) {
  if (!Array.isArray(values) || values.length === 0) throw new MissionBridgeError('BRIDGE_ORIGIN_REQUIRED', 'At least one dashboard origin is required.', { status: 500 });
  if (values.length > MAX_ALLOWED_ORIGINS) {
    throw new MissionBridgeError('BRIDGE_ORIGIN_ALLOWLIST_TOO_BROAD', `Dashboard origin allowlist must not exceed ${MAX_ALLOWED_ORIGINS} entries.`, {
      status: 500, details: { max: MAX_ALLOWED_ORIGINS, supplied: values.length }
    });
  }
  const origins = new Set();
  for (const value of values) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new MissionBridgeError('BRIDGE_ORIGIN_INVALID', 'Dashboard origin is invalid.', { status: 500 }); }
    const port = Number(parsed.port || 80);
    if (parsed.origin !== value || parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '127.0.0.2'].includes(parsed.hostname)
        || !Number.isInteger(port) || port < ORIGIN_PORT_MIN || port > ORIGIN_PORT_MAX) {
      throw new MissionBridgeError('BRIDGE_ORIGIN_INVALID', `Dashboard origins must be exact local HTTP origins with a port from ${ORIGIN_PORT_MIN} through ${ORIGIN_PORT_MAX}.`, { status: 500 });
    }
    origins.add(value);
  }
  return origins;
}

// A request with NO Origin header is not browser-initiated, so it is not the
// threat this check defends against, and refusing it bought nothing.
//
// This file already states the threat model, at the BOOTSTRAP_PROOF_FILE comment
// above: "A browser Origin header is trivially forgeable by any local,
// non-browser HTTP client, so it was never real authorization for a same-user
// attacker -- only for a genuine cross-origin browser fetch." That is exactly
// right, and it is the reason refusing an absent Origin was backwards. A hostile
// local client simply sends `Origin: http://127.0.0.1:4600` and passes; only an
// honest client that sends no Origin -- every CLI, script, and agent -- was
// blocked. The check was rejecting precisely the callers it could not protect
// against, and admitting the ones it could not stop.
//
// What actually guards this surface is unchanged and untouched: `authorized()`
// gates every route except OPTIONS, GET /v1/runtime (discovery only -- base URL,
// port, pid, no secret), and GET /v1/bootstrap, which carries its own
// filesystem-read proof precisely because "the origin check alone is not
// authorization". So admitting no-Origin requests exposes no secret and weakens
// no control.
//
// Cross-origin browser requests always carry an Origin, so the browser
// protection below is intact: a present-but-unlisted Origin is still refused.
// CORS response headers are omitted for no-Origin callers because they are
// meaningless without one -- the browser is the only thing that reads them.
//
// The concrete defect this fixes: the owner asked that our own agents run from
// inside the product, and they could not reach the mission bridge at all.
const NO_ORIGIN_HEADERS = Object.freeze({});

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (typeof origin === 'undefined') return NO_ORIGIN_HEADERS;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

function send(response, status, body, headers = {}) {
  // A 204 has no representation, so it must not advertise the JSON bytes
  // Node suppresses on the wire. A nonzero Content-Length leaves clients
  // with contradictory framing after a successful CORS preflight.
  const encoded = status === 204 ? null : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(status, {
    ...(encoded ? { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length } : {}),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(encoded || undefined);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) {
      return reject(new MissionBridgeError('BRIDGE_CONTENT_TYPE_REQUIRED', 'POST actions require application/json.', { status: 415 }));
    }
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const accept = finish(resolve);
    const refuse = finish(reject);
    const timer = setTimeout(() => {
      refuse(new MissionBridgeError('BRIDGE_BODY_TIMEOUT', 'Request body timed out.', { status: 408 }));
      request.resume();
    }, BODY_TIMEOUT_MS);
    timer.unref?.();
    request.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        refuse(new MissionBridgeError('BRIDGE_BODY_TOO_LARGE', 'Request body exceeds 32 KiB.', { status: 413 }));
        request.resume();
      } else chunks.push(chunk);
    });
    request.on('error', refuse);
    request.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks);
      if (!isUtf8(body)) return refuse(new MissionBridgeError('BRIDGE_JSON_INVALID', 'Request body must be valid UTF-8 JSON.'));
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return refuse(new MissionBridgeError('BRIDGE_JSON_INVALID', 'Request body is not valid JSON.')); }
      if (!plain(parsed)) return refuse(new MissionBridgeError('BRIDGE_JSON_INVALID', 'Request body must be a JSON object.'));
      Object.defineProperty(parsed, REQUEST_BODY_SHA256, {
        value: crypto.createHash('sha256').update(body).digest('hex'),
        enumerable: false,
        configurable: false,
        writable: false
      });
      accept(parsed);
    });
  });
}

function authorized(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const encoded = header.slice(7);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  return uac.verifyToken(Buffer.from(encoded, 'base64url'), token);
}

function sessionCredentialFromRequest(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Session ')) return null;
  const encoded = header.slice(8);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64url'); } catch { return null; }
  const canonical = bytes.length === 32 && bytes.toString('base64url') === encoded;
  bytes.fill(0);
  return canonical ? encoded : null;
}

async function resolveRequestPrincipal(request, token, resolver = resolveAgentSessionCredential) {
  if (authorized(request, token)) return Object.freeze({ kind: 'owner-ui' });
  const credential = sessionCredentialFromRequest(request);
  if (!credential) return null;
  let resolved;
  try { resolved = await resolver(credential); }
  catch (error) {
    if (['AGENT_SESSION_CREDENTIAL_INVALID', 'AGENT_SESSION_CREDENTIAL_REFUSED'].includes(error?.code)) {
      throw new MissionBridgeError('BRIDGE_UNAUTHORIZED', 'The agent session credential is invalid or no longer active.', { status: 401 });
    }
    throw new MissionBridgeError('BRIDGE_SESSION_AUTHORITY_UNAVAILABLE', 'The agent session authority could not verify this request.', { status: 503 });
  }
  if (!resolved || resolved.agentId === null) {
    throw new MissionBridgeError('BRIDGE_AGENT_IDENTITY_REQUIRED', 'This agent session has no authoritative declared agent identity.', { status: 403 });
  }
  return Object.freeze({ kind: 'agent-session', ...resolved });
}

// N9 fix: this is the pre-issuance authorization /v1/bootstrap was missing.
// It is deliberately NOT the bearer -- demanding the bearer to hand out the
// bearer would be circular, since bootstrap is how a client first obtains
// it. `proof` is a second, independent per-boot secret read straight off
// BOOTSTRAP_PROOF_FILE, which is owner-ACL'd exactly like TOKEN_FILE; only a
// caller with real local filesystem access (a local launcher, not a page
// rendered in a browser sandbox) can ever have it.
function authorizedBootstrap(parsedUrl, proof) {
  const supplied = parsedUrl instanceof URL ? parsedUrl.searchParams.get('proof') : null;
  if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  return uac.verifyToken(Buffer.from(supplied, 'base64url'), proof);
}

// A bridge that asks for any of the test-only escape hatches is a test fixture,
// never the real service: tools/mission-bridge.js sets none of them. That
// distinction matters because minting is DESTRUCTIVE -- it unlinks and
// recreates the file -- and both auth files live at fixed production paths.
//
// This is not hypothetical. Six fixtures injected a `token` but no
// `bootstrapProof`, so every run of the suite silently unlinked the live
// bridge's state/mission-bridge-bootstrap-proof.json and wrote a proof no
// running process held. The live bridge kept serving, kept its own proof in
// memory, and answered every /v1/bootstrap with 401 BOOTSTRAP_PROOF_REQUIRED
// from then on. Mission Control's owner popup swallows that failure whenever
// no prompt is currently open, so the owner's approvals simply never appeared
// and nothing anywhere said why. Failing loudly here costs a fixture one line;
// not failing cost the owner his approval queue.
function testScopedServer(options) {
  return options.allowTestPortZero === true
    || options.allowTestRuntimeFile === true
    || options.allowTestTokenFile === true
    || options.allowTestBootstrapProofFile === true;
}

function mintToken(options) {
  if (Buffer.isBuffer(options.token)) {
    if (options.token.length !== 32) throw new MissionBridgeError('BRIDGE_TOKEN_INVALID', 'Injected token must contain 32 bytes.', { status: 500 });
    return options.token;
  }
  const tokenFile = path.resolve(options.tokenFile || TOKEN_FILE);
  if (tokenFile !== TOKEN_FILE && options.allowTestTokenFile !== true) {
    throw new MissionBridgeError('BRIDGE_TOKEN_PATH_REFUSED', 'Production token path is fixed inside state/.', { status: 500 });
  }
  if (tokenFile === TOKEN_FILE && testScopedServer(options)) {
    throw new MissionBridgeError('BRIDGE_TOKEN_PRODUCTION_MINT_REFUSED',
      'Refusing to mint a bearer token into the production file. This bridge asked for a test-only option, and minting is destructive: '
      + 'it would delete state/mission-bridge-token.json and write a new bearer, breaking every client of the bridge that is running right now. '
      + 'Your test is not wrong to build a real server; it just has to bring its own credential. '
      + 'Fix: pass token: crypto.randomBytes(32) in this createMissionBridgeServer(...) call.',
      { status: 500 });
  }
  try { fs.unlinkSync(tokenFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return uac.loadOrCreateToken({ tokenFile, token: crypto.randomBytes(32), ...(options.tokenDependencies || {}) });
}

// Mints (or accepts an injected) per-boot bootstrap proof, mirroring
// mintToken's own file-lock/ACL pattern -- deliberately a second, distinct
// file from TOKEN_FILE so that presenting the proof can never be confused
// with, or substituted for, presenting the bearer itself.
function mintBootstrapProof(options) {
  if (Buffer.isBuffer(options.bootstrapProof)) {
    if (options.bootstrapProof.length !== 32) throw new MissionBridgeError('BRIDGE_BOOTSTRAP_PROOF_INVALID', 'Injected bootstrap proof must contain 32 bytes.', { status: 500 });
    return options.bootstrapProof;
  }
  const proofFile = path.resolve(options.bootstrapProofFile || BOOTSTRAP_PROOF_FILE);
  if (proofFile !== BOOTSTRAP_PROOF_FILE && options.allowTestBootstrapProofFile !== true) {
    throw new MissionBridgeError('BRIDGE_BOOTSTRAP_PROOF_PATH_REFUSED', 'Production bootstrap proof path is fixed inside state/.', { status: 500 });
  }
  if (proofFile === BOOTSTRAP_PROOF_FILE && testScopedServer(options)) {
    throw new MissionBridgeError('BRIDGE_BOOTSTRAP_PROOF_PRODUCTION_MINT_REFUSED',
      'Refusing to mint a bootstrap proof into the production file. This bridge asked for a test-only option, and minting is destructive: '
      + 'it would delete state/mission-bridge-bootstrap-proof.json and write a proof that no running process holds. '
      + 'That is not a test-only inconvenience. A live bridge keeps its proof in memory, so it would answer every /v1/bootstrap with 401 from '
      + 'that moment until someone restarted it, and Mission Control would show the owner an empty approvals surface with no error explaining why. '
      + 'That exact failure hid eight decisions he was waiting on. '
      + 'Your test is not wrong to build a real server; it just has to bring its own credential. '
      + 'Fix: pass bootstrapProof: crypto.randomBytes(32) in this createMissionBridgeServer(...) call.',
      { status: 500 });
  }
  try { fs.unlinkSync(proofFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return uac.loadOrCreateToken({ tokenFile: proofFile, token: crypto.randomBytes(32), ...(options.bootstrapProofDependencies || {}) });
}

function credentialFile(options, valueName, fileName, productionFile) {
  if (Buffer.isBuffer(options[valueName])) return null;
  return path.resolve(options[fileName] || productionFile);
}

// Keep the previous bridge's credentials recoverable until every fallible part
// of constructing its replacement has completed. Renaming preserves the old
// file's owner-only ACL as well as its exact contents; rollback therefore does
// not have to recreate security metadata after a later mint/construction error.
function beginCredentialRotation(options) {
  const files = [
    credentialFile(options, 'token', 'tokenFile', TOKEN_FILE),
    credentialFile(options, 'bootstrapProof', 'bootstrapProofFile', BOOTSTRAP_PROOF_FILE)
  ].filter(Boolean);
  const saved = [];
  try {
    for (const file of files) {
      const backup = `${file}.${process.pid}.${crypto.randomUUID()}.previous`;
      try {
        fs.renameSync(file, backup);
        saved.push({ file, backup, existed: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        saved.push({ file, backup, existed: false });
      }
    }
  } catch (error) {
    for (const entry of saved.reverse()) {
      if (entry.existed) fs.renameSync(entry.backup, entry.file);
    }
    throw error;
  }
  return {
    commit() {
      for (const entry of saved) {
        // Once both new credentials exist, failure to remove an inaccessible
        // backup must not turn successful construction into a handle-less
        // failure after the shared files have already changed.
        if (entry.existed) {
          try { fs.unlinkSync(entry.backup); } catch { /* old secret is no longer accepted */ }
        }
      }
    },
    rollback() {
      let rollbackError = null;
      for (const entry of saved.reverse()) {
        try {
          try { fs.unlinkSync(entry.file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
          if (entry.existed) fs.renameSync(entry.backup, entry.file);
        } catch (error) {
          rollbackError ||= error;
        }
      }
      if (rollbackError) throw rollbackError;
    }
  };
}

function removeCredential(expected, file) {
  if (!file) return;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = typeof record?.token === 'string' ? Buffer.from(record.token, 'base64url') : null;
    // A replacement bridge may already own the shared path. Only the process
    // whose in-memory secret matches the file is allowed to remove it.
    if (current && uac.verifyToken(current, expected)) fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function createMissionBridgeServer(options = {}) {
  const host = options.host || LOOPBACK;
  if (host !== LOOPBACK) throw new MissionBridgeError('BRIDGE_BIND_REFUSED', 'Mission bridge binds only to 127.0.0.1.', { status: 500 });
  const allowedOrigins = originSet(options.allowedOrigins);
  const actionOptions = { ...(options.actionOptions || {}) };
  delete actionOptions.actor;
  delete actionOptions.principal;
  const createActions = options.createActions || createMissionActions;
  const ownerActions = options.actions || createActions({
    ...actionOptions,
    principal: Object.freeze({ kind: 'owner-ui' })
  });
  const resolveSession = options.resolveAgentSessionCredential || resolveAgentSessionCredential;
  const actionsForPrincipal = options.actionsForPrincipal || (principal => {
    if (principal.kind === 'owner-ui') return ownerActions;
    // A fixed injected action object is safe only for the owner fixture that
    // supplied it. Reusing it for an agent would discard the transport-bound
    // identity and recreate the global-coordinator defect this branch closes.
    if (options.actions) {
      throw new MissionBridgeError('BRIDGE_SESSION_AUTHORITY_UNAVAILABLE', 'This bridge has no principal-bound agent action factory.', { status: 503 });
    }
    return createActions({ ...actionOptions, principal });
  });
  const tokenFile = credentialFile(options, 'token', 'tokenFile', TOKEN_FILE);
  const bootstrapProofFile = credentialFile(options, 'bootstrapProof', 'bootstrapProofFile', BOOTSTRAP_PROOF_FILE);
  const credentialRotation = beginCredentialRotation(options);
  let token;
  let bootstrapProof;
  try {
    token = mintToken(options);
    bootstrapProof = mintBootstrapProof(options);
  } catch (error) {
    try { credentialRotation.rollback(); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Credential minting failed and the previous bridge credentials could not be restored.'); }
    throw error;
  }
  const allowTestPortZero = options.allowTestPortZero === true;
  const runtimeDependencies = {
    ...(options.runtimeDependencies || {}),
    ...(options.runtimeFile ? { runtimeFile: options.runtimeFile } : {}),
    ...(options.allowTestRuntimeFile === true ? { allowTestRuntimeFile: true } : {})
  };
  let runtimeRecord = null;
  // The request listener used to be `async (request, response) => {...}`
  // passed straight to http.createServer. Several `send()` calls inside it
  // -- the CORS refusal, OPTIONS, /v1/runtime, /v1/bootstrap, and the
  // pre-auth 401 -- sit outside any try/catch, and even the routes that DO
  // have a try/catch call send() again inside the catch block. http's
  // request-listener contract does not await or attach a .catch() to
  // whatever a listener returns, so if send() itself throws (writeHead after
  // headers already sent, end() on a socket that died mid-request), that
  // throw became an unhandled promise rejection instead of a handled error.
  // Splitting the async logic into its own function and driving it from a
  // synchronous listener that always attaches .catch() closes every one of
  // those sites in one place instead of wrapping each call individually.
  async function handleMissionBridgeRequest(request, response) {
    const requestId = crypto.randomUUID();
    const cors = corsHeaders(request, allowedOrigins);
    if (!cors) return send(response, 403, errorBody(new MissionBridgeError('BRIDGE_ORIGIN_REFUSED', 'Request origin is not an allowed dashboard origin.', { status: 403 }), requestId).body);
    if (request.method === 'OPTIONS') return send(response, 204, {}, cors);
    let parsedUrl;
    try {
      parsedUrl = new URL(request.url, 'http://loopback.invalid');
    } catch {
      // A request target that cannot be parsed is not evidence that no route
      // matches it. Returning BRIDGE_ROUTE_NOT_FOUND here used to collapse the
      // parser's "could not establish a pathname" into a definite 404. Refuse
      // the malformed target explicitly instead of making a routing claim.
      const failure = errorBody(new MissionBridgeError('BRIDGE_REQUEST_TARGET_INVALID', 'Request target is invalid.', { status: 400 }), requestId);
      return send(response, failure.status, failure.body, cors);
    }
    const pathname = parsedUrl.pathname;
    if (pathname === '/v1/runtime' && request.method === 'GET') {
      if (!runtimeRecord) {
        const failure = errorBody(new MissionBridgeError('BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE', 'Runtime discovery is not ready.', { status: 503 }), requestId);
        return send(response, failure.status, failure.body, cors);
      }
      return send(response, 200, { ok: true, ...runtimeRecord }, cors);
    }
    if (pathname === '/v1/bootstrap' && request.method === 'GET') {
      if (!authorizedBootstrap(parsedUrl, bootstrapProof)) {
        const failure = errorBody(new MissionBridgeError('BRIDGE_BOOTSTRAP_PROOF_REQUIRED', 'Bootstrap requires a local proof value read from the owner-only bootstrap proof file in state/; the origin check alone is not authorization.', { status: 401 }), requestId);
        return send(response, failure.status, failure.body, cors);
      }
      return send(response, 200, {
        ok: true,
        token: token.toString('base64url'),
        auth: 'bearer',
        trustBoundary: 'single-user-loopback-origin-and-local-file-proof-bound',
        capabilities: Object.keys(ROUTES).map(route => route.replace('/v1/actions/', ''))
      }, cors);
    }
    let principal;
    try { principal = await resolveRequestPrincipal(request, token, resolveSession); }
    catch (error) {
      const failure = errorBody(error, requestId);
      return send(response, failure.status, failure.body, cors);
    }
    if (!principal) {
      const failure = errorBody(new MissionBridgeError('BRIDGE_UNAUTHORIZED', 'A valid owner bearer or active agent session credential is required.', { status: 401 }), requestId);
      return send(response, failure.status, failure.body, cors);
    }
    // Contract discovery observes the registered surface, not a user's data.
    // It keeps the same exact-origin and owner/agent credential boundary and
    // never constructs or invokes an action, writes audit rows, or opens a
    // second listener. Presence here does not grant authority/readiness.
    if (pathname === '/v1/contract' && request.method === 'GET') {
      return send(response, 200, { ok: true, contract: API_CONTRACT }, cors);
    }
    let actions;
    try { actions = actionsForPrincipal(principal); }
    catch (error) {
      const failure = errorBody(error, requestId);
      return send(response, failure.status, failure.body, cors);
    }
    if (pathname === '/v1/status' && request.method === 'GET') {
      try { return send(response, 200, await actions.status(), cors); }
      catch (error) { const failure = errorBody(error, requestId); return send(response, failure.status, failure.body, cors); }
    }
    if (pathname === '/v1/owner-prompts' && request.method === 'GET') {
      if (principal.kind !== 'owner-ui') {
        const failure = errorBody(new MissionBridgeError('BRIDGE_OWNER_UI_REQUIRED', 'Owner prompts require the owner UI credential.', { status: 403 }), requestId);
        return send(response, failure.status, failure.body, cors);
      }
      // The in-app owner popup polls this. The snapshot carries the shared
      // theme manifest plus pending public prompts; credential prompts have
      // no shape here by design and never will.
      try { return send(response, 200, await actions.ownerPromptSnapshot(), cors); }
      catch (error) { const failure = errorBody(error, requestId); return send(response, failure.status, failure.body, cors); }
    }
    if (pathname === '/v1/research/local-tiers-status' && request.method === 'GET') {
      // What the two fixed local advisory tiers can do on this machine right
      // now, with machine-readable reasons. A read like /v1/status: it starts
      // no inference and mutates nothing.
      try { return send(response, 200, await actions.localTiersStatus(), cors); }
      catch (error) { const failure = errorBody(error, requestId); return send(response, failure.status, failure.body, cors); }
    }
    if (pathname === '/v1/settings' && request.method === 'GET') {
      if (principal.kind !== 'owner-ui') {
        const failure = errorBody(new MissionBridgeError('BRIDGE_OWNER_UI_REQUIRED', 'Settings require the owner UI credential.', { status: 403 }), requestId);
        return send(response, failure.status, failure.body, cors);
      }
      try {
        const { loadSettings } = require('../settings');
        return send(response, 200, loadSettings(), cors);
      } catch (error) {
        if (error?.code !== 'MODULE_NOT_FOUND') {
          const failure = errorBody(error, requestId);
          return send(response, failure.status, failure.body, cors);
        }
        const failure = errorBody(new MissionBridgeError('BRIDGE_SETTINGS_UNAVAILABLE', 'Resolved settings are not available.', { status: 503 }), requestId);
        return send(response, failure.status, failure.body, cors);
      }
    }
    const actionName = ROUTES[pathname];
    if (!actionName || request.method !== 'POST') {
      const failure = errorBody(new MissionBridgeError('BRIDGE_ROUTE_NOT_FOUND', 'No bounded bridge action matches this route.', { status: 404 }), requestId);
      return send(response, failure.status, failure.body, cors);
    }
    if (['ownerPromptPresented', 'ownerPromptDecision'].includes(actionName)
        && principal.kind !== 'owner-ui') {
      const failure = errorBody(new MissionBridgeError('BRIDGE_OWNER_UI_REQUIRED', 'Owner prompt actions require the owner UI credential.', { status: 403 }), requestId);
      return send(response, failure.status, failure.body, cors);
    }
    try {
      const input = await readJson(request);
      // Reading a body yields to the owner host. A session may be retired or
      // rebound while the sender is still uploading, so the header-time
      // principal cannot authorize the completed request by itself.
      const currentPrincipal = await resolveRequestPrincipal(request, token, resolveSession);
      if (!currentPrincipal || ['kind', 'sessionId', 'agentId', 'provider', 'roleId',
        'expectedOrgRevision', 'expectedRoleRevision'].some(key => currentPrincipal[key] !== principal[key])) {
        throw new MissionBridgeError('BRIDGE_UNAUTHORIZED', 'The initiating session changed before this request could be dispatched.', { status: 401 });
      }
      actions = actionsForPrincipal(currentPrincipal);
      const result = await actions[actionName](input);
      if (!result || result.ok !== true || !plain(result.receipt)) throw new MissionBridgeError('BRIDGE_DEPENDENCY_UNKNOWN', 'Action returned an unknown result.', { status: 503 });
      return send(response, 200, result, cors);
    } catch (error) {
      const failure = errorBody(error, requestId);
      return send(response, failure.status, failure.body, {
        ...cors,
        ...([408, 413].includes(failure.status) ? { connection: 'close' } : {})
      });
    }
  }
  let server;
  try {
    server = http.createServer((request, response) => {
      handleMissionBridgeRequest(request, response).catch(error => {
        // Last-resort guard: handleMissionBridgeRequest already handles every
        // known error internally via errorBody()/send(). Reaching here means
        // send() itself failed (or something outside its own try/catch
        // threw), so a normal error response is not guaranteed to be
        // possible. Best-effort a 500, and otherwise just make sure the
        // socket does not hang -- either way, this must never surface as an
        // unhandled promise rejection.
        try {
          if (!response.headersSent) send(response, 500, errorBody(error, crypto.randomUUID()).body);
        } catch { /* the response is unusable; nothing more can be sent */ }
        try {
          if (!response.writableEnded) response.destroy();
        } catch {}
      });
    });
    server.on('clientError', (_error, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {}
    });
    credentialRotation.commit();
  } catch (error) {
    try { credentialRotation.rollback(); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Bridge construction failed and the previous bridge credentials could not be restored.'); }
    throw error;
  }
  return Object.freeze({
    server,
    host,
    async listen(port) {
      const forced = port !== undefined;
      const validForcedPort = Number.isSafeInteger(port)
        && ((port === 0 && allowTestPortZero) || (port >= 1 && port <= 65535));
      if (forced && !validForcedPort) {
        throw new MissionBridgeError('BRIDGE_PORT_INVALID', 'port must be 1 through 65535.', { status: 500 });
      }
      const candidates = forced ? [port] : DEFAULT_PORTS;
      for (const candidate of candidates) {
        try {
          return await new Promise((resolve, reject) => {
            const onError = error => { server.off('listening', onListening); reject(error); };
            const onListening = () => {
              server.off('error', onError);
              const address = server.address();
              const baseUrl = `http://${host}:${address.port}`;
              const clock = runtimeDependencies.clock || Date.now;
              const pid = runtimeDependencies.pid === undefined ? process.pid : runtimeDependencies.pid;
              const record = normalizeRuntimeRecord({
                baseUrl, port: address.port, startedAt: new Date(clock()).toISOString(), pid
              });
              /* Asynchronous on purpose: the retry below has to wait between
                 attempts, and the listener must stay up while it does. */
              void (async () => {
                const delay = runtimeDependencies.delayImpl
                  || (ms => new Promise(done => { setTimeout(done, ms).unref?.(); }));
                for (let attempt = 0; attempt < DISCOVERY_RETRY_ATTEMPTS; attempt += 1) {
                  if (attempt > 0) await delay(DISCOVERY_RETRY_BACKOFF_MS[attempt]);
                  try {
                    writeRuntimeDiscovery(record, runtimeDependencies);
                    runtimeRecord = record;
                    resolve(Object.freeze({ host, port: address.port, baseUrl, runtime: record }));
                    return;
                  } catch (error) {
                    if (retryableDiscoveryFailure(error) && attempt + 1 < DISCOVERY_RETRY_ATTEMPTS) continue;
                    server.close(() => reject(error));
                    return;
                  }
                }
              })();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen({ host, port: candidate, exclusive: true });
          });
        } catch (error) {
          if (!forced && error?.code === 'EADDRINUSE') continue;
          if (error?.code === 'EADDRINUSE') {
            throw new MissionBridgeError('BRIDGE_PORT_UNAVAILABLE', `Mission bridge port ${candidate} is already in use.`, {
              status: 500, details: { port: candidate }
            });
          }
          throw error;
        }
      }
      throw new MissionBridgeError(
        'BRIDGE_PORT_RANGE_EXHAUSTED',
        `Mission bridge ports ${DEFAULT_PORT_MIN} through ${DEFAULT_PORT_MAX} are all in use.`,
        { status: 500, details: { firstPort: DEFAULT_PORT_MIN, lastPort: DEFAULT_PORT_MAX, count: DEFAULT_PORTS.length } }
      );
    },
    close() {
      return new Promise((resolve, reject) => server.close(error => {
        // A refused listen (or a repeated close) has no listener to stop, but
        // construction already minted credentials. Still remove only this
        // instance's matching records; never erase a replacement bridge's.
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') return reject(error);
        // A real removal failure (not "already gone") must reject close(),
        // not vanish inside this async callback -- a throw here would never
        // reach the Promise executor's own try/catch, since the executor
        // already returned by the time server.close's callback runs.
        const removalErrors = [];
        for (const remove of [
          () => removeRuntimeDiscovery(runtimeRecord, runtimeDependencies),
          () => removeCredential(token, tokenFile),
          () => removeCredential(bootstrapProof, bootstrapProofFile)
        ]) {
          try { remove(); } catch (error) { removalErrors.push(error); }
        }
        if (removalErrors.length) {
          // Keep the original identity for a retry. Matching checks still
          // protect a newer runtime record if another bridge replaced it.
          return reject(removalErrors.length === 1 ? removalErrors[0] : new AggregateError(removalErrors, 'Bridge shutdown cleanup failed.'));
        }
        runtimeRecord = null;
        resolve();
      }));
    }
  });
}

module.exports = Object.freeze({
  BODY_TIMEOUT_MS, BOOTSTRAP_PROOF_FILE, DEFAULT_PORT_MAX, DEFAULT_PORT_MIN, DEFAULT_PORTS, LOOPBACK,
  MAX_ALLOWED_ORIGINS, MAX_BODY_BYTES, ORIGIN_PORT_MAX, ORIGIN_PORT_MIN, ROUTES, RUNTIME_FILE, TOKEN_FILE,
  API_CONTRACT,
  authorized, authorizedBootstrap, createMissionBridgeServer, errorBody, mintBootstrapProof,
  resolveRequestPrincipal, sessionCredentialFromRequest,
  normalizeRuntimeRecord, originSet, removeRuntimeDiscovery, writeRuntimeDiscovery
});
