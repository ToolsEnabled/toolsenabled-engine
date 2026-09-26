#!/usr/bin/env node
'use strict';

// Hook entry point: put every agent session this machine starts into the
// canonical signed ledger.
//
// Measured 2026-08-12, which is why this file exists: the newest
// `controller.agent.launch` in state/audit.sqlite3 was four days old while six
// agents were running. The ledger was intact (26,527 entries, audit.verify
// valid) and simply had no writer for the launch paths actually in use.
// SessionStart and SubagentStart registered liveness in the presence roster
// and wrote nothing signed. See src/lib/agent-launch-audit.js for why these
// records are `agent.session.launched` and not `controller.agent.launch`.
//
// TWO MODES, AND THE SPLIT IS THE WHOLE DESIGN.
//
//   hook mode (default)  Reads the hook payload on stdin, derives the launch
//                        descriptor, spawns the worker DETACHED, exits 0.
//                        Target cost: tens of milliseconds.
//   --worker             Does the actual fail-closed ledger append.
//
// WHY DETACH, MEASURED RATHER THAN ASSUMED. Every append re-verifies the whole
// chain before it is allowed to extend it -- that verification IS the
// tamper-evidence, and it is not negotiable. On this ledger it costs:
//
//     audit.status() (full verify)  ~4.0 s
//     record() once warm            ~0.3 s
//
// A hook is a fresh process, so it pays the cold ~5 s every time. Blocking
// SessionStart on that would add five seconds to every session start, and
// SubagentStart fires once per subagent -- sixty concurrent starts would mean
// sixty simultaneous full-chain verifications of a 34 MB database. So the hook
// returns immediately and the ledger write happens behind it.
//
// THE COST OF DETACHING, STATED PLAINLY: the record lands a few seconds AFTER
// the agent starts, so there is a window in which a running agent is not yet in
// the chain. This is recording, not gating, and it never pretended otherwise --
// the harness has already started the process before any hook can run, so
// nothing observed here could have refused it. Gating harness launches is a
// design change (they would have to be dispatched through the controller's
// `/v1/actions/dispatch`, which does record before spawning and does refuse).
//
// ONE WRITER AT A TIME. The worker takes a machine-wide lock before touching
// the ledger. Without it, a wave of subagent starts becomes a wave of
// concurrent 4-second verifications thrashing CPU and the WAL. The ledger's own
// BEGIN IMMEDIATE would still keep them correct; the lock keeps them cheap.
// A launch that cannot get the lock in time is logged as unrecorded rather
// than silently dropped.
//
// FAIL-OPEN, ALWAYS EXIT 0, in both modes. A session that cannot be recorded
// must still run: the alternative is a ledger outage becoming a work outage.
// Every failure is written to logs/agent-launch-audit.log, so "not recorded" is
// a visible fact on disk and not an absence somebody has to notice.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'agent-launch-audit.log');
const LOCK_DIR = path.join(ROOT, 'state', 'agent-launch-audit.lock');
const STDIN_LIMIT_BYTES = 1024 * 1024;

// Lock waiting is bounded by the real cost of the work it protects: a cold
// append is ~5 s, so a queue of a dozen waiters is a couple of minutes.
const LOCK_WAIT_MS = 180_000;
const LOCK_POLL_MS = 250;
const LOCK_STALE_MS = 120_000;

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // A recorder that cannot log still must not block the session.
  }
}

function readStdin() {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      // EOF on Windows pipes surfaces as an EOF error; EAGAIN means no
      // piped stdin at all. Both are "nothing to read", not failures.
      if (error && (error.code === 'EOF' || error.code === 'EAGAIN')) break;
      throw error;
    }
    if (!bytes) break;
    total += bytes;
    if (total > STDIN_LIMIT_BYTES) {
      throw new Error(`hook payload exceeded ${STDIN_LIMIT_BYTES} byte limit`);
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* The hook payload names the session; the descriptor names the launch.
 *
 * `session_id` is the identity everything hangs off and is the only field
 * whose absence aborts -- a launch row with no run id is a phantom, and this
 * codebase has already shipped that bug once (the string 'undefined' nearly
 * became a registered seat in claude-session-autoregister.js).
 *
 * Subagents carry their own id, so a subagent is recorded against ITS id with
 * the parent session named alongside; otherwise a wave of subagents would
 * collapse into one row for the parent. */
function deriveDescriptor(payload, { kindHint } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = payload.session_id || payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;

  // HEX-AND-DASH ONLY, and this grammar is load-bearing rather than tidy.
  // Real session ids are UUID-shaped. Test suites drive this hook with fixture
  // payloads (`session-fixture` in tests/agent-onboarding-hook-contract.js),
  // and a looser grammar let those fixtures append REAL rows to the REAL
  // ledger -- observed once, at sequences 26619-26620, before this check
  // existed. An append-only chain cannot be tidied up afterwards, so running
  // the test suite must not be able to write to it at all.
  //
  // claude-session-autoregister.js already carries the same check for the same
  // reason (there, the literal string 'undefined' nearly became a registered
  // seat). Keep the two grammars in agreement.
  if (!/^[0-9a-f][0-9a-f-]{7,}$/.test(sessionId.trim().toLowerCase())) return null;

  const subagentId = payload.subagent_id || payload.subagentId || payload.agent_id || payload.agentId;
  const subagentName = payload.subagent_name || payload.subagentName || payload.agent_name || payload.agentName;
  const subagentType = payload.subagent_type || payload.subagentType;
  const hookEvent = payload.hook_event_name || payload.hookEventName || kindHint || 'unknown';
  const isSubagent = /subagent/i.test(String(hookEvent)) || Boolean(subagentId || subagentName);

  // The run id must be unique per launch. A subagent shares its parent's
  // session id, so on its own that id would collide across every subagent of
  // one session and every one after the first would be refused as a duplicate.
  const runId = isSubagent && subagentId
    ? `${sessionId}:${subagentId}`
    : sessionId;

  const descriptor = {
    runId,
    agentId: (subagentName || subagentId || `session-${String(sessionId).replace(/-/g, '').slice(0, 12)}`),
    kind: isSubagent ? 'subagent' : 'interactive-session',
    provider: 'claude',
    provenance: `${hookEvent} hook`
  };
  if (typeof subagentType === 'string' && subagentType.trim()) descriptor.tier = subagentType;
  if (isSubagent) descriptor.parentAgentId = `session-${String(sessionId).replace(/-/g, '').slice(0, 12)}`;
  return descriptor;
}

/* mkdir is the lock: it is atomic on every filesystem this runs on, needs no
   daemon, and leaves a readable owner record behind. A crashed holder would
   otherwise wedge every later launch, so a lock older than LOCK_STALE_MS is
   taken over rather than waited on forever. */
function acquireLock(deadline) {
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: false });
      try {
        fs.writeFileSync(path.join(LOCK_DIR, 'owner.json'),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
      } catch { /* the directory is the lock; its contents are only evidence */ }
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return false;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; } catch { ageMs = 0; }
      if (ageMs > LOCK_STALE_MS) {
        log(`taking over a stale launch-audit lock (${Math.round(ageMs / 1000)}s old)`);
        releaseLock();
        continue;
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

function runWorker(descriptor) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  if (!acquireLock(deadline)) {
    log(`NOT RECORDED ${descriptor.agentId} (${descriptor.runId}): could not acquire the launch-audit lock within ${LOCK_WAIT_MS}ms`);
    return 0;
  }
  try {
    const { recordAgentSessionLaunch } = require(path.join(ROOT, 'src', 'lib', 'agent-launch-audit.js'));
    const startedAt = Date.now();
    const result = recordAgentSessionLaunch(descriptor);
    const tookMs = Date.now() - startedAt;
    if (result.ok && result.recorded) {
      log(`recorded ${descriptor.agentId} (${descriptor.runId}) seq=${result.sequence} in ${tookMs}ms`);
    } else if (result.ok) {
      log(`already recorded ${descriptor.agentId} (${descriptor.runId}) in ${tookMs}ms`);
    } else {
      log(`NOT RECORDED ${descriptor.agentId} (${descriptor.runId}): ${result.code} ${result.reason} (${tookMs}ms)`);
    }
  } catch (error) {
    log(`NOT RECORDED ${descriptor.agentId} (${descriptor.runId}): worker threw ${error && error.message ? error.message.slice(0, 200) : String(error)}`);
  } finally {
    releaseLock();
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const workerFlag = argv.indexOf('--worker');
  if (workerFlag !== -1) {
    const encoded = argv[workerFlag + 1];
    let descriptor;
    try {
      descriptor = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
    } catch {
      log('worker: undecodable descriptor');
      return 0;
    }
    return runWorker(descriptor);
  }

  const raw = readStdin();
  if (!raw.trim()) {
    log('skip: no hook payload on stdin');
    return 0;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('skip: hook payload was not JSON');
    return 0;
  }
  const descriptor = deriveDescriptor(payload);
  if (!descriptor) {
    log('skip: hook payload named no session');
    return 0;
  }

  if (argv.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, descriptor })}\n`);
    return 0;
  }
  if (argv.includes('--inline')) return runWorker(descriptor);

  // Detached, stdio ignored, unref'd: the hook must not wait for a ~5 s
  // fail-closed append, and the child must outlive it.
  try {
    // Scrubbed for the same reason as the caller in tools/agent-onboarding.js:
    // this is a Node child, Node children reach provider CLIs, and ambient env
    // on this machine carries live provider keys. The worker needs no
    // credential -- it reads its descriptor from argv and writes to the local
    // audit chain.
    const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
    const child = spawn(process.execPath, [
      __filename, '--worker', Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64')
    ], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
      env: safeLaunchEnvironment(process.env, { context: 'agent launch recorder worker' })
    });
    child.unref();
  } catch (error) {
    log(`NOT RECORDED ${descriptor.agentId}: could not spawn the worker (${error && error.code ? error.code : 'unknown'})`);
  }
  return 0;
}

// FAIL-OPEN IS A MECHANISM, NOT A CONVENTION. Every failure lands here, is
// logged, and the session starts anyway.
try {
  process.exit(main());
} catch (error) {
  log(`unexpected failure (fail-open): ${error && error.message ? error.message.slice(0, 300) : String(error)}`);
  process.exit(0);
}
