'use strict';

// THE SESSIONSTART AUTOREGISTER HOOK MUST NEVER BLOCK A SESSION.
//
// tools/claude-session-autoregister.js is wired as a SessionStart hook (owner
// fix directive 2026-08-12: live interactive sessions were invisible to the
// presence registry because registration was optional prose). Its contract has
// two halves and both are pinned here:
//
//   1. FAIL-OPEN: any malformed, empty, or oversized hook payload exits 0.
//      A hook that exits non-zero on bad input turns a registry nicety into a
//      session-start outage.
//   2. DERIVATION: a valid payload derives a stable agent id from the session
//      id (stable across restarts of the SAME session, distinct across
//      sessions) and registers role `observer` as a liveness placeholder --
//      never a seat claim.
//
// The spawn seam is --dry-run: it prints the derived registration argv and
// touches neither the process table nor the registry, so these checks run
// against the real CLI without mutating live presence state.

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'claude-session-autoregister.js');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

function run(stdin, args = []) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    input: stdin, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  });
}

// 1. Fail-open: garbage stdin exits 0 and prints nothing to stdout.
{
  const result = run('this is not json {{{', ['--dry-run']);
  check(result.status === 0, 'non-JSON hook payload must exit 0 (fail-open)');
  check(!result.stdout.trim(), 'non-JSON payload must not print a derivation');
}

// 2. Fail-open: empty stdin exits 0.
{
  const result = run('', ['--dry-run']);
  check(result.status === 0, 'empty payload must exit 0 (fail-open)');
}

// 3. Fail-open: JSON without a session id exits 0 and derives nothing.
{
  const result = run(JSON.stringify({ hook_event_name: 'SessionStart', cwd: 'C:/x' }), ['--dry-run']);
  check(result.status === 0, 'payload without session_id must exit 0');
  check(!result.stdout.trim(), 'payload without session_id must not derive a registration');
}

// 4. Fail-open: a hostile session id (bad grammar) is skipped, not registered.
{
  const result = run(JSON.stringify({ session_id: '../../etc; rm -rf' }), ['--dry-run']);
  check(result.status === 0, 'invalid session id grammar must exit 0');
  check(!result.stdout.trim(), 'invalid session id grammar must not derive a registration');
}

// 5. Derivation: a real session id produces a stable session-scoped agent id,
//    the observer placeholder role, and the full run id -- via the real
//    register CLI, not a parallel write path.
{
  const sessionId = 'FE08BA95-0156-491f-a4c0-619bad83e0e6';
  const result = run(JSON.stringify({ session_id: sessionId }), ['--dry-run']);
  check(result.status === 0, 'valid payload must exit 0');
  const parsed = JSON.parse(result.stdout);
  check(parsed.dryRun === true, 'dry-run must label itself');
  check(parsed.agentId === 'session-fe08ba950156', 'agent id must be session-<first 12 hex of lowercased id>');
  const argv = parsed.argv;
  check(argv[0].endsWith('claude-session-register.js'), 'must register through the existing R1186 register CLI');
  check(argv[argv.indexOf('--run-id') + 1] === sessionId.toLowerCase(), 'run id must be the full lowercased session id');
  check(argv[argv.indexOf('--role') + 1] === 'observer', 'auto-registration must claim only the observer placeholder role');
  check(argv[argv.indexOf('--agent') + 1] === parsed.agentId, 'argv agent id must match the derived id');
}

// 6. Stability and distinctness: same session id -> same agent id; different
//    session id -> different agent id.
{
  const first = JSON.parse(run(JSON.stringify({ session_id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' }), ['--dry-run']).stdout);
  const second = JSON.parse(run(JSON.stringify({ session_id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' }), ['--dry-run']).stdout);
  const third = JSON.parse(run(JSON.stringify({ session_id: 'bbbbcccc-dddd-eeee-ffff-000011112222' }), ['--dry-run']).stdout);
  check(first.agentId === second.agentId, 'the same session must always derive the same agent id');
  check(first.agentId !== third.agentId, 'different sessions must derive different agent ids');
}

console.log(`claude-session-autoregister tests passed (${checks} checks: fail-open on garbage/empty/missing/hostile ids, derivation through the real register CLI with observer placeholder, and id stability/distinctness).`);
