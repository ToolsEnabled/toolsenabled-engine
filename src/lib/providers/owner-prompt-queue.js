'use strict';

// Durable queue for owner-entered local forms. Requests contain fixed kind,
// vault-key, and label fields plus bounded public credential context; values
// never enter this state file. One shared runner owns queue transitions and
// sequential presentation. Native Windows and Linux adapters own only the UI.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { rootPath } = require('../runtime');
const { STATE_ROOT_ENV, stateRoot } = require('../runtime-state-root');
const { safeLaunchEnvironment } = require('./subscription-launch-env');
const { deleteEnvMatching } = require('../env-scrub');
const safety = require('./provider-safety');

const VERSION = 1;
const QUEUE_FILE = rootPath('state', 'owner-prompt-queue.json');
const RUNNER = rootPath('src', 'lib', 'owner-prompt-runner.js');
const WINDOWS_UI = rootPath('tools', 'owner-prompt-queue.ps1');
const native = require('../owner-prompt-platform');
// Keep the retired owner_host_start value readable so an upgrade can cancel a
// queued legacy item instead of declaring the entire owner-input queue corrupt.
// New requests can use only QUEUEABLE_KINDS; the app owns its host lifecycle.
const KINDS = Object.freeze(['credential', 'payment_card', 'owner_host_start']);
const QUEUEABLE_KINDS = Object.freeze(['credential', 'payment_card']);
const CONTEXTUAL_KINDS = Object.freeze(['credential', 'payment_card']);
const STATUS = Object.freeze(['queued', 'presenting', 'completed', 'cancelled', 'failed']);
const KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const REQUEST_CONTEXT_KEYS = Object.freeze(['purpose', 'scope', 'lifetime']);
const REQUEST_CONTEXT_SORTED_KEYS = Object.freeze([...REQUEST_CONTEXT_KEYS].sort());
const REQUESTERS = Object.freeze(['codex', 'claude', 'gemini', 'toolsenabled', 'unattributed']);
// HOW THE NAME GOT HERE, RECORDED SEPARATELY FROM THE NAME ITSELF.
//
// `requester` is a CLAIM, never a proof, and this queue has no way to make it
// one. Trace it back: on the stdio transport it is
// `process.env.TOOLSENABLED_AGENT_ACTOR` (src/mcp-server.js) on an anonymous
// direct-stdio session. The installed owner-host route is stronger: its opaque
// credential resolves server-side to an exact agent session. This queue field
// still stores only the bounded provider label for display, not that principal,
// so it deliberately does not claim an agent identity was verified here.
//
// src/lib/agent-launch-audit.js met the same problem and answered it by
// refusing to collapse two different facts into one word: a gated dispatch is
// `controller.agent.launch`, an after-the-fact observation is
// `agent.session.launched` with `gated: false`, because writing the observed
// one under the gated one would make the ledger overstate itself. This field is
// that answer here. `declared` says a principal name accompanied the request
// and nothing checked it; `none` says no principal name arrived at all. Neither
// value ever claims verification, so the owner-facing form can stop presenting
// a config-file string as an established identity.
const REQUESTER_EVIDENCE = Object.freeze(['declared', 'none']);
// WHY `none` IS FATAL FOR A PAYMENT CARD AND NOT A CREDENTIAL.
//
// A credential form asks the owner to type a provider secret he can rotate. The
// card form asks for the instrument that spends his money. An unnamed requester
// is a reason to tell the owner plainly and let him decide on a credential; on
// the card form it is a reason to refuse, because there is no cheap recovery
// from a wrong answer. Refusing both is what made the whole credential path dead on
// every transport that names no actor -- measured 2026-08-11, and still true on
// 2026-08-13.
const IDENTITY_BOUND_KINDS = Object.freeze(['payment_card']);
const REQUEST_CONTEXT_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 .,:;()/_+&@'-]{0,71}$/;
const REQUEST_CONTEXT_SECRET_HINT_RE = /(?:bearer\s|token\s*=|secret\s*=|password\s*=|api[_ -]?key\s*=)/i;
const REQUEST_CONTEXT_VALUE_MAX = 72;
const MAX_ITEMS = 100;
const MAX_EVENTS = 200;
const REQUEST_ID_RE = /^owner-prompt-[a-f0-9-]{36}$/;
// A QUEUED PROMPT NEVER EXPIRES, BECAUSE THE OWNER IS PUTTING INFORMATION IN.
// This used to cancel a queued prompt after two hours and a presenting one
// after four. Both limits existed for ONE reason, stated plainly in the code
// they replaced: a single active request held the only slot for EVERY other
// key, so an unanswered prompt silently disabled every path needing a
// credential, and expiry was how the wedge eventually cleared.
//
// The slot is gone (see enqueue), so the wedge is gone, and with it the only
// argument for a deadline. What remains is a person typing a secret into a
// form. Expiring that is a data-loss bug wearing a safety hat: the owner walks
// away mid-entry, comes back, and the request he was answering has been
// cancelled underneath him with nothing to say so. The runner already drains a
// multi-item queue in order, and its own dialog says "$Count private steps are
// ready, one at a time" -- it was always built for a queue, not a slot.
//
// `presenting` still needs a route back, and it is RECOVERY, not expiry:
// recoverOrphanedPresenting() re-queues an item whose runner is provably gone,
// so a dialog killed by a reboot returns to the queue instead of being
// cancelled. A LIVE dialog is never touched, however long the owner takes.
const ACTIVE_STATUSES = Object.freeze(['queued', 'presenting']);

function fail(code, message) { return safety.safeError(code, message); }
function now() { return Date.now(); }
function emptyQueue() { return { version: VERSION, nextSequence: 1, items: [], events: [] }; }

function validRequestContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== REQUEST_CONTEXT_SORTED_KEYS.length || keys.some((key, index) => key !== REQUEST_CONTEXT_SORTED_KEYS[index])) return false;
  return REQUEST_CONTEXT_KEYS.every(key => {
    if (typeof value[key] !== 'string') return false;
    const text = value[key].trim();
    return text.length >= 1 && text.length <= REQUEST_CONTEXT_VALUE_MAX
      && REQUEST_CONTEXT_VALUE_RE.test(text)
      && !REQUEST_CONTEXT_SECRET_HINT_RE.test(text)
      && !(!/\s/.test(text) && text.length >= 24)
      && !/[A-Za-z0-9+/_=-]{40,}/.test(text);
  });
}

function validRequester(value) {
  return typeof value === 'string' && REQUESTERS.includes(value);
}

// The only honest reading of a requester name this queue can produce. It says
// how the name arrived, never that it is true.
function requesterEvidenceFor(value) {
  return value === 'unattributed' ? 'none' : 'declared';
}

function publicRequestContext(value) {
  if (!validRequestContext(value)) {
    throw fail('OWNER_PROMPT_INVALID', 'Credential request context must contain only bounded public purpose, scope, and lifetime strings.');
  }
  return Object.freeze(Object.fromEntries(REQUEST_CONTEXT_KEYS.map(key => [key, value[key]])));
}

function pruneOldestTerminal(queue) {
  if (queue.items.length < MAX_ITEMS) return;
  const candidates = queue.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => ['completed', 'cancelled', 'failed'].includes(item.status))
    .sort((left, right) => left.item.createdAtMs - right.item.createdAtMs || left.index - right.index);
  if (!candidates.length) {
    throw fail('OWNER_PROMPT_QUEUE_FULL', 'Too many owner prompts are already stored; terminal requests are not available for pruning.');
  }
  const removeId = candidates[0].item.requestId;
  queue.items = queue.items.filter(item => item.requestId !== removeId);
}

function safeItem(item) {
  return Object.freeze({
    requestId: item.requestId,
    kind: item.kind,
    status: item.status,
    createdAtMs: item.createdAtMs,
    updatedAtMs: item.updatedAtMs,
    completedAtMs: item.completedAtMs || null
  });
}

function validateQueue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION ||
      !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.items) || !Array.isArray(value.events) ||
      value.items.length > MAX_ITEMS || value.events.length > MAX_EVENTS) {
    throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
  }
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || typeof item.requestId !== 'string' || !REQUEST_ID_RE.test(item.requestId) ||
        !KINDS.includes(item.kind) || !STATUS.includes(item.status) || !Number.isSafeInteger(item.createdAtMs) || !Number.isSafeInteger(item.updatedAtMs) ||
        !KEY_RE.test(String(item.vaultKey || '')) || !LABEL_RE.test(String(item.label || ''))) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
    const terminal = ['completed', 'cancelled', 'failed'].includes(item.status);
    if (item.requestContext !== undefined && !validRequestContext(item.requestContext)) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
    if (item.requester !== undefined && !validRequester(item.requester)) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
    // OPTIONAL, DELIBERATELY. Records written before this field existed are
    // readable and are NOT retro-stamped: absence means "this record predates
    // the distinction", which is itself the truth about it. Only an
    // out-of-vocabulary value is rejected, so no reader has to guess.
    if (item.requesterEvidence !== undefined && !REQUESTER_EVIDENCE.includes(item.requesterEvidence)) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
    // Older terminal records have no attribution metadata. New queued or
    // presenting sensitive owner-input records must carry it.
    if (CONTEXTUAL_KINDS.includes(item.kind) && !terminal &&
        (!validRequestContext(item.requestContext) || !validRequester(item.requester))) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
  }
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        typeof event.requestId !== 'string' || !REQUEST_ID_RE.test(event.requestId) || !KINDS.includes(event.kind) ||
        !['queued', 'presented', 'requeued_after_interruption', 'completed', 'cancelled', 'failed'].includes(event.type) ||
        !STATUS.includes(event.status) || !Number.isSafeInteger(event.atMs)) {
      throw fail('OWNER_PROMPT_QUEUE_INVALID', 'The durable owner prompt queue is invalid.');
    }
  }
  return value;
}

function readQueue(file = QUEUE_FILE) {
  try {
    // Tolerate a leading UTF-8 BOM: Set-Content -Encoding UTF8 in Windows
    // PowerShell 5.1 writes one, and JSON.parse rejects it outright. The
    // shared writer now uses BOM-less UTF-8, but an older file must read cleanly.
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return validateQueue(JSON.parse(raw));
  }
  catch (error) {
    if (error && error.code === 'ENOENT') return emptyQueue();
    if (error && error.code === 'OWNER_PROMPT_QUEUE_INVALID') throw error;
    throw fail('OWNER_PROMPT_QUEUE_UNAVAILABLE', 'The durable owner prompt queue is unavailable.');
  }
}

function writeQueue(queue, file = QUEUE_FILE) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(queue, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* atomic move already consumed it */ }
  }
}

function withLock(work, options = {}) {
  const file = path.resolve(options.queueFile || QUEUE_FILE);
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch {
    throw fail('OWNER_PROMPT_QUEUE_BUSY', 'The owner prompt queue is busy; retry shortly.');
  }
  try {
    const queue = readQueue(file);
    const result = work(queue);
    // A read-only outcome must leave the file BYTE-IDENTICAL. Rewriting it would
    // reformat a queue the caller was refused any change to, and callers depend
    // on a refusal not touching the queue at all. Work that mutates says nothing
    // and still writes, so every existing call site keeps its behaviour.
    if (!result || result.mutated !== false) writeQueue(queue, file);
    return result;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

function appendEvent(queue, item, type) {
  queue.events.push({
    sequence: queue.nextSequence++, requestId: item.requestId, kind: item.kind, type,
    status: item.status, atMs: item.updatedAtMs
  });
  if (queue.events.length > MAX_EVENTS) queue.events.splice(0, queue.events.length - MAX_EVENTS);
}

// A DIALOG WHOSE RUNNER IS GONE IS THE ONE STATE WITH NO ROUTE BACK, because
// cancel() refuses a presenting item outright -- deliberately, so nothing can
// yank a form out from under the owner mid-entry. Previously a four-hour timer
// was the floor under that. A timer cannot tell "he is still typing" from "the
// process died", so it eventually cancelled both.
//
// runnerIsAlive() can tell them apart, so ask it. If no runner owns this queue
// file, the form on screen is not on screen: re-queue it for the next runner.
// The event word is the existing `requeued_after_interruption` that the
// PowerShell runner's own Recover-InterruptedRequests writes, so nothing new
// enters the vocabulary validateQueue enforces and an older copy of this module
// can still read the file. Callers MUST already hold the queue lock.
// Defaults to exact native process-generation observation; tests may supply a probe.
function probeRunnerAlive(overrides = {}) {
  return typeof overrides.runnerAlive === 'function' ? overrides.runnerAlive : runnerIsAlive;
}

function recoverOrphanedPresenting(queue, atMs, overrides = {}) {
  const recovered = [];
  const queueFile = path.resolve(overrides.queueFile || QUEUE_FILE);
  const runner = overrides.runner || RUNNER;
  for (const item of queue.items) {
    if (!item || item.status !== 'presenting') continue;
    let alive = true;
    // A probe that throws must NOT be read as "the runner is dead" -- that
    // would re-queue a form the owner is actively filling in.
    //
    // The probe is INJECTABLE because the property that matters most here --
    // "a live dialog is never disturbed" -- is otherwise untestable: a test
    // process has no real runner, so the real probe always answers "dead" and
    // the protective branch never executes. A safety rule no test can reach is
    // a safety rule nobody is checking.
    try { alive = probeRunnerAlive(overrides)(runner, queueFile); } catch { alive = true; }
    if (alive) continue;
    item.status = 'queued';
    item.updatedAtMs = atMs;
    appendEvent(queue, item, 'requeued_after_interruption');
    recovered.push(item.requestId);
  }
  return recovered;
}

// A detached launch is accepted only after the shared runner publishes an
// exact process-generation lock. This proves a runner, not owner interaction.
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function runnerIsAlive(_runner, queueFile) {
  return native.runnerIsAlive(queueFile);
}

function assertPromptPlatform(overrides = {}, kind) {
  native.assertAvailable({ ...overrides, kind });
}

function launchWaitingDialog(overrides = {}) {
  const spawnProcess = overrides.spawn || spawn;
  /* The liveness check runs only on the REAL spawn. An injected spawn returns a
   * synthetic child whose pid belongs to no process, so probing it would fail
   * every existing test for a defect that is not there. */
  const injectedSpawn = Boolean(overrides.spawn);
  assertPromptPlatform(overrides);
  const runner = path.resolve(overrides.runner || RUNNER);
  const queueFile = path.resolve(overrides.queueFile || QUEUE_FILE);
  // existsSync() collapses every lookup failure to false. In particular, a
  // busy or exhausted machine (EMFILE/EAGAIN/EBUSY), an I/O failure (EIO), or
  // an interrupted lookup would therefore be reported as the definite fact
  // that the runner is absent. Only ENOENT proves that fact; every other
  // failure says the lookup itself did not answer and must remain retryable.
  try {
    fs.statSync(runner);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw fail('OWNER_PROMPT_RUNNER_UNAVAILABLE', 'The owner prompt queue runner is unavailable.');
    }
    const failure = fail('OWNER_PROMPT_RUNNER_LOOKUP_UNAVAILABLE',
      'The owner prompt runner could not be checked; this does not mean the runner is absent.');
    failure.cause = error instanceof Error ? error.message : String(error);
    throw failure;
  }
  try {
    // Built here, not just inside launchSpec, so the spawn below carries an
    // env the static scrub gate (tools/check-spawn-env-scrub.js) can verify
    // directly -- it cannot see through a returned spec.options across a
    // file boundary. Same two calls native.launchSpec's own cleanEnvironment
    // makes internally (safeLaunchEnvironment, then the same non-provider
    // name list), so this does not change what the child receives.
    const env = deleteEnvMatching(
      safeLaunchEnvironment({ ...process.env, [STATE_ROOT_ENV]: stateRoot() }, { context: 'owner prompt queue launch' }),
      key => native.NON_PROVIDER_LAUNCH_ENV_NAMES.test(key));
    const spec = native.launchSpec(runner, queueFile, { ...overrides, environment: env });
    const child = spawnProcess(spec.command, spec.args, { ...spec.options, env });
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
      // spawn() reports a missing executable twice: immediately through an
      // absent pid and asynchronously through the child's error event. Consume
      // only that already-failed child's event so our safe error below remains
      // the caller-visible failure instead of a later uncaught-process crash.
      if (child && typeof child.once === 'function') child.once('error', () => {});
      throw new Error('launch failed');
    }
    if (typeof child.unref === 'function') child.unref();
    if (!injectedSpawn) {
      // Consume the async failure path too, so a child that dies reports here
      // rather than surfacing later as an uncaught process error.
      if (typeof child.once === 'function') child.once('error', () => {});
      const deadline = performance.now() + (Number.isSafeInteger(overrides.livenessMs) ? overrides.livenessMs : 30_000);
      let alive = false;
      do {
        sleepSync(100);
        alive = runnerIsAlive(runner, queueFile);
        if (alive) break;
        if (!native.launcherIsAlive(child.pid)) break;
      } while (performance.now() < deadline);
      if (!alive) throw new Error('runner did not start');
      // UI interaction and completion are reported by queue events. A live
      // runner does not establish that the owner saw or answered the form.
    }
    return true;
  } catch (error) {
    // The public code stays fixed and path-free, but the cause used to be thrown
    // away here -- which made "launch failed" and "runner did not start"
    // indistinguishable while diagnosing the blue-flash/no-dialog defect. Carry
    // it on the error for logs and tests; never in the message that crosses to
    // an agent.
    const failure = fail('OWNER_PROMPT_RUNNER_UNAVAILABLE', 'The owner prompt queue runner could not be started.');
    failure.cause = error instanceof Error ? error.message : String(error);
    throw failure;
  }
}

// A blocked caller may retry in a tight loop, and each recovery launch costs a
// process that may sit on the global mutex before exiting. The runner only ever
// needs to be started ONCE to clear a wedge, so attempts are throttled per
// process. This is deliberately in-memory: the alternative, a timestamp in the
// queue file, would make a REFUSED request write to the queue, and callers rely
// on a refusal leaving the queue byte-identical.
const RELAUNCH_THROTTLE_MS = 60000;
let lastRelaunchAtMs = 0;

function shouldRequestRelaunch(overrides = {}) {
  const throttleMs = Number.isSafeInteger(overrides.relaunchThrottleMs) && overrides.relaunchThrottleMs >= 0
    ? overrides.relaunchThrottleMs
    : RELAUNCH_THROTTLE_MS;
  const at = now();
  // A backwards clock step must not disable recovery until the clock catches up.
  if (lastRelaunchAtMs && at >= lastRelaunchAtMs && at - lastRelaunchAtMs < throttleMs) return false;
  lastRelaunchAtMs = at;
  return true;
}

function queueCounts(queue) {
  const counts = { queued: 0, presenting: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const item of queue.items) counts[item.status] += 1;
  return counts;
}

function enqueue({ kind, vaultKey, label, requestContext, requester } = {}, overrides = {}) {
  if (!QUEUEABLE_KINDS.includes(kind) || !KEY_RE.test(String(vaultKey || '')) || !LABEL_RE.test(String(label || ''))) {
    throw fail('OWNER_PROMPT_INVALID', 'The owner prompt request is invalid.');
  }
  const contextual = CONTEXTUAL_KINDS.includes(kind);
  const normalizedContext = contextual ? publicRequestContext(requestContext) : undefined;
  const normalizedRequester = contextual ? requester : undefined;
  // A name outside the closed set is still refused outright: it is neither a
  // claim this queue understands nor an honest absence, and the runner would
  // have to invent a rendering for it.
  if (contextual && !validRequester(normalizedRequester)) {
    throw fail('OWNER_PROMPT_ATTRIBUTION_REQUIRED', 'Sensitive owner-input requests require an authenticated agent or fixed local-workflow identity.');
  }
  const evidence = contextual ? requesterEvidenceFor(normalizedRequester) : undefined;
  if (evidence === 'none' && IDENTITY_BOUND_KINDS.includes(kind)) {
    throw fail('OWNER_PROMPT_ATTRIBUTION_REQUIRED', 'Payment-card forms require a named requester; this request named none.');
  }
  const result = withLock(queue => {
    // ONE KEY DEDUPES; IT DOES NOT BLOCK. A request for the SAME kind+key that is
    // still active is the same question, so it replays the existing id rather
    // than asking the owner twice. A request for a DIFFERENT key is a different
    // question and simply queues behind it -- that used to be refused with
    // OWNER_PROMPT_DIFFERENT_ACTIVE, which is what turned one unanswered prompt
    // into a machine-wide credential outage (seventeen hours of it, measured
    // 2026-08-11). The runner presents them one at a time in order.
    const atMs = now();
    const existing = queue.items.find(item => item.kind === kind && item.vaultKey === vaultKey && ACTIVE_STATUSES.includes(item.status));
    if (existing) return { item: existing, replayed: true, counts: queueCounts(queue) };
    if (queue.items.filter(item => ACTIVE_STATUSES.includes(item.status)).length >= 24) {
      throw fail('OWNER_PROMPT_QUEUE_FULL', 'Too many owner prompts are already waiting.');
    }
    pruneOldestTerminal(queue);
    const item = { requestId: `owner-prompt-${crypto.randomUUID()}`, kind, vaultKey, label, status: 'queued', createdAtMs: atMs, updatedAtMs: atMs };
    if (contextual) {
      item.requestContext = { ...normalizedContext };
      item.requester = normalizedRequester;
      // Written next to the name, always, including for a named requester. A
      // record that carried the marker only when attribution was missing would
      // read as verification by omission the rest of the time.
      item.requesterEvidence = evidence;
    }
    queue.items.push(item);
    appendEvent(queue, item, 'queued');
    return { item, replayed: false, counts: queueCounts(queue) };
  }, overrides);
  /* THE SAME RULE AS THE BLOCKED PATH ABOVE, WHICH THIS USED TO BREAK.
   *
   * Twenty lines up: "A launch failure must not replace the caller's real
   * reason for stopping." That is exactly what this line did. The item is
   * already durable -- withLock() wrote and released before we got here -- so a
   * throw from launchWaitingDialog() skipped the return entirely and the caller
   * never learned the requestId of a request that now exists forever.
   *
   * The consequences compounded, which is why this was worth chasing:
   *   - the item stays `queued` with nobody able to name it, so nobody can
   *     cancel it either -- cancel() needs the id this throw discarded.
   *   (When this was written a third consequence compounded it: `queued` was an
   *   ACTIVE status, so the orphan then refused EVERY later enqueue for ANY key.
   *   That single-slot rule was removed on 2026-08-21, which removes the
   *   machine-wide blast radius but not this bug: an id the caller never
   *   received is still an id nobody can act on.)
   * Observed 2026-08-20: a credential request failed to queue, and the next
   * identical request queued fine once a runner happened to be running -- the
   * difference was never the request.
   *
   * So the launch outcome is REPORTED, not thrown. A caller holding the id can
   * cancel or retry; a caller holding an exception cannot do either. */
  /* A RETURNED requestId IS NOT A QUEUED REQUEST. Read the queue back and prove
   * the item is in it before telling anyone it was accepted.
   *
   * THE FAILURE THIS CLOSES, observed 2026-08-20. Three credential requests
   * returned {status:'queued', requestId} and `owner_prompts.start` returned
   * {launcherRequested:true}, while NONE of those ids existed anywhere in the
   * queue file -- its newest entry was hours older than the first call. The
   * runner then did exactly what it should: read a queue with nothing pending,
   * drained it, exited 0. No dialog, no error, and an agent waiting on a value
   * that could never arrive. The owner watched three windows fail to appear and
   * had to say so before anything noticed.
   *
   * The cause that time was a long-lived server holding code from before the
   * fixes above -- a whole class this file cannot prevent, because a stale
   * process runs stale code by definition. What it CAN do is refuse to report
   * success it has not verified, so the next occurrence names itself instead of
   * looking like a working queue.
   *
   * This is the same lesson as `909455a` ("a pid is not a running dialog") one
   * layer up: there, a spawn that returned a pid was not a dialog; here, a write
   * that returned an id is not a durable request. Both were true-looking values
   * standing in for the thing actually wanted.
   *
   * A REPLAY is checked too. It reports an id the caller will act on, and an
   * item that vanished between the lock and here is exactly as unusable. */
  const persisted = readQueue(overrides.queueFile).items
    .some(item => item.requestId === result.item.requestId);
  if (!persisted) {
    throw fail('OWNER_PROMPT_NOT_PERSISTED',
      'The owner prompt was accepted but is not in the queue on disk, so no dialog can present it.');
  }

  let launcherRequested = false;
  let launchFailure = null;
  try {
    // Deduplication does not make an unsupported form available. Report this
    // known prerequisite on replays too, without spawning a duplicate runner.
    assertPromptPlatform(overrides, kind);
    if (!result.replayed) launcherRequested = launchWaitingDialog(overrides);
  } catch (error) {
    launcherRequested = false;
    // The code only -- the message may name paths, and this crosses to agents.
    launchFailure = (error && error.code) || 'OWNER_PROMPT_RUNNER_UNAVAILABLE';
  }
  return Object.freeze({
    ...safeItem(result.item),
    replayed: result.replayed,
    launcherRequested,
    /* Present only when it happened, so the ordinary shape is unchanged and a
     * caller testing for it is testing for a real event. */
    ...(launchFailure ? { launchFailure } : {}),
    counts: result.counts
  });
}

function cancel(input = {}, overrides = {}) {
  safety.exactKeys(input, ['requestId'], 'owner_prompts.cancel input');
  if (!REQUEST_ID_RE.test(String(input.requestId || ''))) {
    throw fail('OWNER_PROMPT_INVALID', 'The owner prompt request is invalid.');
  }
  const result = withLock(queue => {
    // Recover first. A `presenting` item is the one state with no route back from
    // JS -- the refusal below is unconditional, so a dialog lost to a reboot or a
    // killed runner would stay presenting forever. Re-queueing it when its runner
    // is provably gone makes it cancellable here, while a form genuinely in front
    // of the owner is still refused, however long he takes over it.
    const atMs = now();
    recoverOrphanedPresenting(queue, atMs, overrides);
    const item = queue.items.find(candidate => candidate.requestId === input.requestId);
    if (!item) throw fail('OWNER_PROMPT_NOT_FOUND', 'The owner prompt request is unavailable.');
    if (item.status === 'presenting') {
      throw fail('OWNER_PROMPT_IN_PROGRESS', 'The owner prompt is already being presented and cannot be cancelled from another process.');
    }
    if (item.status === 'queued') {
      item.status = 'cancelled';
      item.updatedAtMs = atMs;
      item.completedAtMs = item.updatedAtMs;
      appendEvent(queue, item, 'cancelled');
    }
    return { item, counts: queueCounts(queue) };
  }, overrides);
  return Object.freeze({ ...safeItem(result.item), counts: result.counts });
}

function status(input = {}, overrides = {}) {
  safety.exactKeys(input, [], 'owner_prompts.status input');
  const queue = readQueue(overrides.queueFile || QUEUE_FILE);
  const counts = queueCounts(queue);
  // WHICH REQUEST HOLDS THE SINGLE ACTIVE SLOT, stated once instead of left to
  // be re-derived from the request list by every caller that gets refused. This
  // is a read: it reports abandonment, it does not act on it, because a status
  // call must never rewrite the queue underneath a runner. Only the request id
  // and its age travel -- no label, no vault key, no owner-entered value.
  const active = queue.items.find(item => ACTIVE_STATUSES.includes(item.status)) || null;
  const presenting = queue.items.find(item => item.status === 'presenting') || null;
  let presentingWithoutRunner = false;
  if (presenting) {
    // Unlike recovery, status has a caller to whom uncertainty can be carried.
    // Refuse rather than reporting the definite negative
    // `presentingWithoutRunner: false` when runner state was not measured.
    try {
      presentingWithoutRunner = !probeRunnerAlive(overrides)(overrides.runner || RUNNER, path.resolve(overrides.queueFile || QUEUE_FILE));
    } catch (error) {
      if (error && error.code === 'OWNER_PROMPT_RUNNER_UNAVAILABLE') throw error;
      const failure = fail('OWNER_PROMPT_RUNNER_UNAVAILABLE', 'The owner prompt runner state could not be measured.');
      failure.cause = error instanceof Error ? error.message : String(error);
      throw failure;
    }
  }
  return Object.freeze({
    waitingForOwner: counts.queued > 0,
    activeRequestId: active ? active.requestId : null,
    activeSinceMs: active && Number.isSafeInteger(active.updatedAtMs) ? active.updatedAtMs : null,
    activeCount: queue.items.filter(item => ACTIVE_STATUSES.includes(item.status)).length,
    // Replaces `activeAbandoned`. Nothing is abandoned by age any more; the only
    // state a caller can usefully act on is a form whose runner has died.
    presentingWithoutRunner,
    counts: Object.freeze(counts),
    requests: Object.freeze(queue.items.slice(-50).map(safeItem))
  });
}

function events(input = {}, overrides = {}) {
  safety.exactKeys(input, ['afterSequence', 'limit'], 'owner_prompts.events input');
  const afterSequence = input.afterSequence === undefined ? 0 : input.afterSequence;
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw fail('OWNER_PROMPT_EVENTS_INVALID', 'The owner prompt event cursor is invalid.');
  }
  const queue = readQueue(overrides.queueFile || QUEUE_FILE);
  const entries = queue.events.filter(event => event.sequence > afterSequence).slice(0, limit)
    .map(event => Object.freeze({ sequence: event.sequence, requestId: event.requestId, kind: event.kind, type: event.type, status: event.status, atMs: event.atMs }));
  return Object.freeze({ events: Object.freeze(entries), nextSequence: entries.length ? entries.at(-1).sequence : afterSequence });
}

// RECOVERY HAS TO BE REACHABLE WITHOUT ANOTHER VICTIM ARRIVING.
//
// The old sweep ran from enqueue() and cancel(), and both of those are somebody
// ELSE being blocked -- so the only thing that could free a stuck state was the
// next caller turning up to be refused by it. That reasoning survives even
// though the expiry it defended does not, because a `presenting` item whose
// runner died is still unreachable from JS: cancel() refuses it outright.
//
// start() is the right place and status() is the wrong one. This is the moment a
// person is actually dealing with their prompts; it already writes, because it
// launches the runner. status() stays a pure read -- it must never rewrite the
// queue underneath a running dialog.
//
// NOTHING HERE IS CANCELLED. Recovery re-queues; it never terminates a request,
// so an owner who walks away mid-entry loses nothing, and the ids of anything
// re-queued are RETURNED rather than silently changed.
//
// A BUSY QUEUE IS NOT A STUCK ONE. withLock refuses when the PowerShell runner
// holds the lock -- which is precisely when someone IS working the queue, so
// there is nothing to recover. Rather than turn that into a failure of `start`,
// the pre-existing lock-free read is used and no recovery is claimed.
function start(input = {}, overrides = {}) {
  safety.exactKeys(input, [], 'owner_prompts.start input');
  let expired = [];
  let counts;
  try {
    ({ expired, counts } = withLock(queue => {
      const swept = recoverOrphanedPresenting(queue, now(), overrides);
      return {
        expired: swept,
        counts: queueCounts(queue),
        // A start that sweeps NOTHING is a read, and withLock keeps a read
        // byte-identical. Without this the common case -- the overwhelmingly
        // common case, since start also runs on the refusal-relaunch path --
        // rewrote a queue it had changed nothing in, against the invariant
        // documented on withLock itself and against callers that rely on an
        // untouched file. Measured: a no-op start changed the file's bytes and
        // its mtime.
        mutated: swept.length > 0
      };
    }, overrides));
  } catch (error) {
    if (error && error.code !== 'OWNER_PROMPT_QUEUE_BUSY') throw error;
    expired = [];
    counts = queueCounts(readQueue(overrides.queueFile || QUEUE_FILE));
  }
  const launcherRequested = counts.queued > 0 ? launchWaitingDialog(overrides) : false;
  return Object.freeze({
    status: counts.queued > 0 ? 'waiting_for_owner' : 'no_pending_prompts',
    launcherRequested,
    expired: Object.freeze(expired),
    counts: Object.freeze(counts)
  });
}

// Queue transitions belong here, under the same lock and validation on both OSes.
// Native adapters receive public request metadata and return a closed outcome only.
function runnerPrepare(options = {}) {
  return withLock(queue => {
    let changed = false;
    for (const item of queue.items) {
      if (item.status === 'presenting') {
        item.status = 'queued'; item.updatedAtMs = now();
        appendEvent(queue, item, 'requeued_after_interruption'); changed = true;
      }
      if (item.status === 'queued' && (item.kind === 'owner_host_start'
          || (IDENTITY_BOUND_KINDS.includes(item.kind) && item.requester === 'unattributed'))) {
        item.status = 'cancelled'; item.updatedAtMs = now(); item.completedAtMs = item.updatedAtMs;
        appendEvent(queue, item, 'cancelled'); changed = true;
      }
    }
    return { mutated: changed };
  }, options);
}
function runnerClaim(requestId, options = {}) {
  return withLock(queue => {
    const item = queue.items.find(candidate => candidate.requestId === requestId);
    if (!item || item.status !== 'queued') return { mutated: false, item: null };
    if (item.kind === 'owner_host_start' || (IDENTITY_BOUND_KINDS.includes(item.kind) && item.requester === 'unattributed')) {
      item.status = 'cancelled'; item.updatedAtMs = now(); item.completedAtMs = item.updatedAtMs;
      appendEvent(queue, item, 'cancelled'); return { item: null };
    }
    if (queue.items.some(candidate => candidate.status === 'presenting')) return { mutated: false, item: null };
    item.status = 'presenting'; item.updatedAtMs = now(); appendEvent(queue, item, 'presented');
    return { item: { ...item, requestContext: { ...item.requestContext } } };
  }, options).item;
}
function runnerSettle(requestId, outcome, options = {}) {
  if (!['completed', 'cancelled', 'failed', 'timeout', 'deferred'].includes(outcome)) throw fail('OWNER_PROMPT_INVALID', 'The native owner form outcome is invalid.');
  return withLock(queue => {
    const item = queue.items.find(candidate => candidate.requestId === requestId);
    if (!item || item.status !== 'presenting') throw fail('OWNER_PROMPT_INVALID', 'The native owner form no longer owns this request.');
    const requeued = outcome === 'timeout' || outcome === 'deferred';
    item.status = requeued ? 'queued' : outcome;
    item.updatedAtMs = now();
    if (!requeued) item.completedAtMs = item.updatedAtMs;
    appendEvent(queue, item, requeued ? 'requeued_after_interruption' : outcome);
    return safeItem(item);
  }, options);
}

module.exports = Object.freeze({
  KINDS, QUEUEABLE_KINDS, CONTEXTUAL_KINDS, QUEUE_FILE, RUNNER, WINDOWS_UI,
  STATUS, REQUEST_CONTEXT_KEYS, REQUESTERS, REQUESTER_EVIDENCE, IDENTITY_BOUND_KINDS, MAX_ITEMS, MAX_EVENTS,
  runnerPrepare, runnerClaim, runnerSettle, cancel, enqueue, events, launchWaitingDialog, readQueue, recoverOrphanedPresenting, start, status
});
