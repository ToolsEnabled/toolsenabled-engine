#!/usr/bin/env node
'use strict';

// REPRODUCIBLE COLD-START CEILING -- the number a customer actually waits for.
//
// WHY THIS EXISTS. tools/idle-cpu-check.js measures what the product costs
// while sitting still, and deliberately EXCLUDES startup as "a one-time cost,
// not idle drain". That is correct, and it left the one-time cost measured by
// nothing at all. So it grew, unwatched, until a client waited ~5.5 seconds for
// its first response -- and the cause had a shape that gets worse over time
// rather than announcing itself:
//
//   mcp-tool-surface's instance sweep spawned one powershell.exe PER PREVIOUSLY
//   RECORDED MCP INSTANCE to ask whether it was still alive. Measured
//   2026-08-17: 19 spawns, 6.34s, essentially the whole cold start. A machine
//   that had run the product a lot started slower than a fresh one, and nothing
//   in the product could see it happening.
//
// That is fixed (windowsStartTicksMany batches the sweep into one spawn), but
// the reason it went unnoticed for so long is the part worth keeping: there was
// no gate. This is the gate.
//
// WHAT IT MEASURES. Time from spawning `src/mcp-server.js` to the first
// JSON-RPC response to a real `initialize` -- exactly what Claude Code, Codex,
// or the owner-host proxy waits through on every launch, using the same stdio
// transport a client uses. Not module-load time, not "ready" as the process
// judges itself: the first moment a client gets an answer.
//
// THE CEILING: 2.5 seconds. Measured after the batching fix, this machine
// returns in 0.81-1.06s, so the ceiling leaves roughly 2.5x headroom for a
// slower customer machine while still failing loudly on the ~5.5s regression it
// was written to catch. It is a ceiling, not a target -- do not raise it to make
// a red run green; that is the one change this file exists to prevent.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const TARGET_SCRIPT = path.join(ROOT, 'src', 'mcp-server.js');
const CEILING_MS = 2_500;
const HARD_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

// A real client's first message. Nothing here is product-specific beyond the
// protocol version: if this stops being what a client sends, this check should
// be updated rather than kept passing on a request nobody makes.
const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cold-start-check', version: '1' }
  }
};
const INITIALIZE = JSON.stringify(INITIALIZE_REQUEST);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function measureOnce() {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [TARGET_SCRIPT], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Scrubbed, per the repository's spawn-environment gate, which flagged
      // this call site as soon as it existed. Measuring the product must not be
      // the one path that hands a child every provider credential in ambient
      // env -- and the scrub is a plain object build, far below the resolution
      // of what this check times.
      env: safeLaunchEnvironment(process.env, { context: 'cold-start measurement' })
    });
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'no response before the hard timeout' }), HARD_TIMEOUT_MS);
    child.on('error', error => finish({ ok: false, reason: `could not spawn: ${error.message}` }));
    child.once('exit', (code, signal) => {
      if (!settled) finish({ ok: false, reason: `exited before answering (code=${code}, signal=${signal})` });
    });
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffered += decoder.write(chunk);
      // A stdio client cannot use a partial line, an unrelated reply, or a
      // notification that happens to contain "result". Time only the complete
      // response to this initialize request, including its negotiated shape.
      while (!settled) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (!isObject(response) || response.jsonrpc !== '2.0'
          || response.id !== INITIALIZE_REQUEST.id || Object.hasOwn(response, 'method')) continue;
        if (Object.hasOwn(response, 'error')) {
          finish({ ok: false, reason: 'initialize failed with a JSON-RPC error response' });
          continue;
        }
        const result = response.result;
        if (!isObject(result) || result.protocolVersion !== INITIALIZE_REQUEST.params.protocolVersion
          || !isObject(result.capabilities) || !isObject(result.serverInfo)
          || result.serverInfo.name !== 'toolsenabled'
          || typeof result.serverInfo.version !== 'string' || result.serverInfo.version.length === 0) {
          finish({ ok: false, reason: 'invalid initialize result' });
          continue;
        }
        finish({ ok: true, ms: Date.now() - startedAt });
      }
    });
    child.stdin.write(INITIALIZE + '\n');
  });
}

async function main() {
  process.stdout.write(`Measuring cold start: spawn ${path.relative(ROOT, TARGET_SCRIPT)}, send initialize, time the first response.\n`);
  const timings = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = await measureOnce();
    if (!result.ok) {
      process.stdout.write(`FAIL: attempt ${attempt} produced no measurement -- ${result.reason}.\n`);
      process.exitCode = 1;
      return;
    }
    timings.push(result.ms);
    process.stdout.write(`  attempt ${attempt}: ${(result.ms / 1000).toFixed(2)}s\n`);
  }

  // The SLOWEST attempt is the verdict, not the mean. A customer does not
  // experience an average launch; they experience the one they are waiting on,
  // and a mean hides exactly the intermittent stall worth catching.
  const worst = Math.max(...timings);
  process.stdout.write(`Slowest of ${ATTEMPTS}: ${(worst / 1000).toFixed(2)}s.  Ceiling: ${(CEILING_MS / 1000).toFixed(1)}s.\n`);

  if (worst > CEILING_MS) {
    process.stdout.write('FAIL: cold start exceeds the stated ceiling.\n');
    process.stdout.write('Before raising the ceiling, count the synchronous child spawns during startup -- '
      + 'the last time this regressed, one powershell.exe per recorded MCP instance was the whole cost, '
      + 'and it grew with every instance ever recorded.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('PASS: cold start is within the stated ceiling.\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${(error && error.stack) || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CEILING_MS, ATTEMPTS, TARGET_SCRIPT, measureOnce };
