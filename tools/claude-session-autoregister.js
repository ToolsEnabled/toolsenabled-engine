#!/usr/bin/env node
'use strict';

// Owner fix directive (in-session, 2026-08-12, on the shadow cycle-1 report,
// verbatim): "For 3 not good i dont understand but fix the issue without
// interrrupting current workt". Item 3 was: the coordination layer is blind to
// everything actually running -- live interactive Claude sessions never appear
// in the presence registry, so `agent-roster --presence` reports an empty
// house while sessions work the tree.
//
// Root cause, measured that cycle: the R1186 registration pair
// (tools/claude-session-register.js + tools/claude-session-heartbeat.js)
// exists and solves exactly this, but NOTHING INVOKED IT. Registration was a
// duty an agent had to remember, and per STANDING-ORDERS LOCAL-WORK
// 0-COMMERCIAL a rule that stays prose gets broken silently -- this one was,
// for every session since the tools landed. This hook is the mechanization:
// SessionStart runs it, so an owner-launched session is visible in the
// roster without anyone remembering anything.
//
// Contract, deliberately narrow:
//   - FAIL-OPEN, ALWAYS EXIT 0. A session that cannot register must still
//     start; the failure is logged to logs/session-autoregister.log, and the
//     registry honestly missing a row is better than a blocked session.
//   - LIVENESS ONLY, NOT A SEAT CLAIM. The record registers role `observer`
//     with an explicit placeholder brief. Roles are session-assigned by the
//     owner in conversation (R1192: roles are settings, not agent
//     inventions); a session that takes a real seat re-registers under that
//     seat with tools/claude-session-register.js, exactly as before.
//   - NO NEW STATE. Everything goes through the existing presence API via
//     claude-session-register.js, which resolves the real claude.exe pid by
//     ancestry walk and detaches the existing heartbeat sidecar.
//
// Test seam: --dry-run prints the derived registration argv as JSON and spawns
// nothing, so tests can verify derivation without touching the registry or the
// process table.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'session-autoregister.log');
const REGISTER = path.join(__dirname, 'claude-session-register.js');
const STDIN_LIMIT_BYTES = 1024 * 1024;

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // A hook that cannot log still must not block the session.
  }
}

function readStdin() {
  try {
    const chunks = [];
    let total = 0;
    const descriptor = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      let bytes;
      try {
        bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      } catch (error) {
        // EOF on Windows pipes surfaces as EOF error; EAGAIN means no piped stdin.
        if (error && (error.code === 'EOF' || error.code === 'EAGAIN')) break;
        throw error;
      }
      if (!bytes) break;
      total += bytes;
      if (total > STDIN_LIMIT_BYTES) {
        return { ok: false, reason: `hook payload exceeded ${STDIN_LIMIT_BYTES} bytes` };
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    }
    return { ok: true, value: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    return {
      ok: false,
      reason: `stdin read failed: ${error && (error.code || error.message) ? (error.code || error.message) : String(error)}`
    };
  }
}

// The agent id must be stable across restarts of the SAME session (so a
// re-fired SessionStart lands on the register tool's heartbeat path, not a
// seat collision) and distinct across sessions. The session id gives both.
function deriveRegistration(sessionId) {
  const trimmed = String(sessionId || '').toLowerCase();
  // Hex-and-dash only: session ids are UUID-shaped. A looser [a-z0-9-] grammar
  // accepted the string 'undefined' (a real payload shape: session_id absent),
  // which would have registered a phantom seat named session-undefined.
  if (!/^[0-9a-f][0-9a-f-]{7,}$/.test(trimmed)) return null;
  const short = trimmed.replace(/-/g, '').slice(0, 12);
  return {
    agentId: `session-${short}`,
    argv: [
      REGISTER,
      '--agent', `session-${short}`,
      '--run-id', trimmed,
      '--role', 'observer',
      '--tier', 'claude/interactive',
      '--lane', 'interactive-session',
      '--brief', 'Owner-launched interactive Claude session, auto-registered at SessionStart. Liveness record only: the observer role is a placeholder until the session takes a seat (roles are session-assigned; a seated session re-registers under its seat).',
      '--provenance', 'SessionStart autoregister hook (owner fix directive 2026-08-12: coordination layer must see live sessions)',
      '--json'
    ]
  };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const stdin = readStdin();
  if (!stdin.ok) {
    log(`skip: hook payload not measured (${stdin.reason})`);
    return 0;
  }
  const raw = stdin.value;
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
  const sessionId = payload && (payload.session_id || payload.sessionId);
  const derived = deriveRegistration(sessionId);
  if (!derived) {
    // JSON.stringify(undefined) is undefined, not a string -- the first
    // version of this line crashed on exactly the payload it was logging.
    log(`skip: no usable session id in hook payload (saw: ${String(JSON.stringify(sessionId) ?? 'undefined').slice(0, 60)})`);
    return 0;
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, agentId: derived.agentId, argv: derived.argv })}\n`);
    return 0;
  }
  // A Node child can go on to launch a provider CLI, so an unscrubbed env here
  // is the exact leak the spawn gate exists for: measured on this machine,
  // ANTHROPIC_API_KEY and friends arrive SET in a spawned child.
  const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
  const result = spawnSync(process.execPath, derived.argv, {
    cwd: ROOT, windowsHide: true, shell: false, encoding: 'utf8', timeout: 20_000,
    env: safeLaunchEnvironment(process.env, { context: 'claude session autoregister' })
  });
  if (result.error) {
    log(`register spawn failed for ${derived.agentId}: ${result.error.code || result.error.message}`);
    return 0;
  }
  const out = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 500);
  if (result.status === 0) {
    log(`registered ${derived.agentId}: ${out}`);
  } else if (Number.isInteger(result.status)) {
    // SESSION_REGISTER_SEAT_HELD and friends land here; logged, never blocking.
    log(`register refused for ${derived.agentId} (exit ${result.status}): ${out}`);
  } else {
    // A signal/unknown termination supplies no exit status, so it does not
    // establish that the registration command refused the request.
    log(`register outcome not measured for ${derived.agentId} (signal ${result.signal || 'unknown'}): ${out}`);
  }
  return 0;
}

// FAIL-OPEN IS A MECHANISM, NOT A CONVENTION. A SessionStart hook that exits
// non-zero on an unexpected payload turns a registry nicety into a
// session-start outage -- and the first version of this file did exactly that,
// crashing in its own skip-path log line. Every failure lands here, gets
// logged, and the session starts anyway.
try {
  process.exit(main());
} catch (error) {
  log(`unexpected failure (fail-open): ${error && error.message ? error.message.slice(0, 300) : String(error)}`);
  process.exit(0);
}
