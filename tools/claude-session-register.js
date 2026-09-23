#!/usr/bin/env node
'use strict';

// R1186: an owner-launched Claude session has no lane-run parent, so nothing
// registers it in the live presence registry, and nothing keeps its heartbeat
// current. Two failures came out of that:
//
//   1. Sessions that tried to self register recorded `process.pid` of a
//      short-lived `node -e` child, so the roster showed `process-gone`.
//   2. Even a correct pid decayed to `heartbeat-fault` within 45s
//      (DEFAULT_STALE_MS), because a session can only beat while it happens to
//      be running a tool call. That is why `--presence` reported zero live
//      roles while three seats were in fact filled.
//
// This registers the CURRENT Claude session against the real presence API
// (src/lib/agent-presence.js) and detaches the beater that keeps the seat
// honest. It adds no new state store and no parallel framework: presence stays
// the one runtime role registry, and who holds a role stays discoverable with
// `node tools/agent-roster.js --presence`.
//
// Roles are session-assigned. Nothing here pins a role to a model or to a named
// holder; the caller states its own seat and the provenance directive that
// assigned it, and the record closes when the session's process exits.

const path = require('path');
const { spawnSync, spawn } = require('child_process');
const presence = require('../src/lib/agent-presence');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const BEATER = 'claude-session-heartbeat.js';

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set(['finish', 'heartbeat-only', 'json', 'no-heartbeat']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail('SESSION_REGISTER_ARGUMENT_INVALID', `Expected --name value pairs; got ${arg}.`);
    const key = arg.slice(2);
    if (flags.has(key)) {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail('SESSION_REGISTER_ARGUMENT_INVALID', `Option --${key} needs a value.`);
    }
    values[key] = value;
    index += 1;
  }
  return values;
}

// One process snapshot serves both the ancestry walk and the duplicate-beater
// check. windowsHide keeps the probe off the desktop (STANDING-ORDERS class
// LOCAL-WORK rule 3).
function processTable() {
  if (process.platform !== 'win32') return null;
  const probe = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 1e8,
      env: safeLaunchEnvironment(process.env, { context: 'claude session process table' })
    }
  );
  if (probe.error || probe.status !== 0) return null;
  let rows;
  try {
    rows = JSON.parse(probe.stdout || '[]');
  } catch {
    return null;
  }
  return Array.isArray(rows) ? rows : [rows];
}

// The session's own process, not this helper's: walk up to the Claude host.
function resolveSessionPid(table) {
  if (process.platform !== 'win32') return process.ppid || process.pid;
  if (!table) return null;
  const byId = new Map(table.map(row => [row.ProcessId, row]));
  let cursor = process.pid;
  for (let hop = 0; hop < 16; hop += 1) {
    const row = byId.get(cursor);
    if (!row) return null;
    if (String(row.Name || '').toLowerCase() === 'claude.exe') return row.ProcessId;
    cursor = row.ParentProcessId;
    if (!cursor) return null;
  }
  return null;
}

// A second beater for the same seat would just contend on the registry lock.
function findBeater(agentId, table) {
  if (!table) return null;
  const found = table.find(row => {
    const cl = String(row.CommandLine || '');
    return cl.includes(BEATER) && cl.includes(`--agent ${agentId} `);
  });
  return found ? found.ProcessId : null;
}

function startHeartbeat(agentId, runId, sessionPid, intervalMs, table) {
  const already = findBeater(agentId, table);
  if (already) return Promise.resolve(already);
  const args = [
    path.join(__dirname, BEATER),
    '--agent', agentId,
    '--run-id', runId,
    '--session-pid', String(sessionPid)
  ];
  if (intervalMs) args.push('--interval-ms', String(intervalMs));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    cwd: ROOT,
    env: safeLaunchEnvironment(process.env, { context: 'claude session heartbeat' })
  });
  child.unref();
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid));
    child.once('error', reject);
  });
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const agentId = values.agent;
  const runId = values['run-id'];
  if (!agentId) fail('SESSION_REGISTER_ARGUMENT_INVALID', 'Missing --agent <id>.');
  if (!runId) fail('SESSION_REGISTER_ARGUMENT_INVALID', 'Missing --run-id <session id>.');

  const registry = presence.readRegistry(presence.DEFAULT_STATE_FILE);
  const existing = registry.agents[agentId] || null;

  if (values.finish) {
    if (!existing) fail('SESSION_REGISTER_NOT_FOUND', `No presence record for ${agentId}.`);
    let done;
    try {
      done = presence.finish(agentId, runId, { exitCode: 0, verdict: values.verdict || null });
    } catch (error) {
      fail(error.code || 'SESSION_REGISTER_FAILED', error.message);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, action: 'finish', agentId, status: done.status })}\n`);
    return;
  }

  const table = processTable();
  const sessionPid = resolveSessionPid(table);
  if (sessionPid === null) {
    fail('SESSION_REGISTER_PID_UNRESOLVED', 'Could not resolve the owning claude.exe pid; refusing to record a pid that is already gone.');
  }

  // Same session re-running this tool is a heartbeat, not a collision. Restart
  // the beater too: if it died, the seat was about to go stale.
  if (existing && existing.runId === runId && !presence.TERMINAL.has(existing.status)) {
    let beat;
    try {
      beat = presence.heartbeat(agentId, runId, {
        pid: sessionPid,
        currentTask: values.task === undefined ? null : values.task
      });
    } catch (error) {
      fail(error.code || 'SESSION_REGISTER_FAILED', error.message);
    }
    let heartbeatPid = null;
    if (!values['no-heartbeat']) {
      try {
        heartbeatPid = await startHeartbeat(agentId, runId, sessionPid, values['heartbeat-ms'], table);
      } catch (error) {
        fail('SESSION_REGISTER_HEARTBEAT_FAILED', `Could not start the heartbeat process: ${error.message}`);
      }
    }
    process.stdout.write(`${JSON.stringify({
      ok: true, action: 'heartbeat', agentId, pid: beat.pid, role: beat.role, status: beat.status, heartbeatPid
    })}\n`);
    return;
  }

  if (values['heartbeat-only']) {
    fail('SESSION_REGISTER_NO_RECORD', `--heartbeat-only needs an existing record owned by run ${runId}.`);
  }

  if (existing && existing.runId !== runId && !presence.TERMINAL.has(existing.status) && existing.status !== 'stale') {
    fail('SESSION_REGISTER_SEAT_HELD', `${agentId} is held by run ${existing.runId} (status ${existing.status}). Pick another agent id or close that record first.`);
  }

  for (const required of ['role', 'tier', 'lane', 'brief']) {
    if (!values[required]) fail('SESSION_REGISTER_ARGUMENT_INVALID', `Missing --${required}.`);
  }

  // Provenance rides in the brief: the roster then shows not just who holds a
  // seat but which owner directive seated them.
  const brief = values.provenance ? `${values.brief} [assigned by: ${values.provenance}]` : values.brief;
  const now = Date.now();
  const record = {
    agentId,
    runId,
    kind: 'claude',
    role: values.role,
    tier: values.tier,
    reportsTo: values['reports-to'] === undefined || values['reports-to'] === 'owner' ? null : values['reports-to'],
    dispatcher: values.dispatcher || 'owner',
    lane: values.lane,
    territory: values.territory || ROOT,
    currentTask: values.task === undefined ? null : values.task,
    brief,
    consoleLog: path.join(ROOT, 'logs', 'lane-consoles', `${agentId}.log`),
    worktree: values.worktree || ROOT,
    launchSpec: values['launch-spec'] || 'owner-launched claude session (self-registered)',
    pid: sessionPid,
    startedAt: now,
    lastHeartbeat: now,
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null
  };

  let registered;
  try {
    registered = presence.register(record);
  } catch (error) {
    fail(error.code || 'SESSION_REGISTER_FAILED', error.message);
  }
  let heartbeatPid = null;
  if (!values['no-heartbeat']) {
    try {
      heartbeatPid = await startHeartbeat(agentId, runId, sessionPid, values['heartbeat-ms'], table);
    } catch (error) {
      fail('SESSION_REGISTER_HEARTBEAT_FAILED', `Could not start the heartbeat process: ${error.message}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, action: 'register', agentId, pid: registered.pid, role: registered.role,
    tier: registered.tier, heartbeatPid
  })}\n`);
}

main().catch(error => fail(error.code || 'SESSION_REGISTER_FAILED', error.message));
