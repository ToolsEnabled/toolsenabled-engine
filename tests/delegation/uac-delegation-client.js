// EXECUTABLE CHANGE -- token-leak scan made non-vacuous and recursive; mutation evidence and census are below.
'use strict';

// UAC delegation CLIENT tests (the non-elevated half).
//
// Everything here is deterministic and offline. Where a real named pipe is
// used it is a per-run unique test pipe served by the real helper server with a
// runOperation stub -- no elevation, no scheduled task, no real netsh/schtasks.
// The scheduled-task start is injected so the suite never touches Task
// Scheduler.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');

const uac = require('../../src/lib/uac-delegation');
const helper = require('../../src/uac-delegation-helper');
const client = require('../../src/lib/uac-delegation-client');

const OWNER = 'TESTDOMAIN\\owner';
const killSwitch = active => ({ status: () => ({ active }) });

function makeMockAudit() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) { events.push({ kind: 'require', action, target, details }); return { durable: true, anchored: true }; },
    record(action, target, details) { events.push({ kind: 'record', action, target, details }); return { ok: true }; }
  };
}

const rawAllowlist = () => ({
  schemaVersion: 1,
  operations: [
    { id: 'restart-fleet-supervisor', description: 'restart', steps: [
      { exec: 'schtasks.exe', args: ['/End', '/TN', 'ToolsEnabled Fleet Supervisor'] },
      { exec: 'schtasks.exe', args: ['/Run', '/TN', 'ToolsEnabled Fleet Supervisor'] }
    ] }
  ]
});

const rawCollectorAllowlist = () => ({
  schemaVersion: 1,
  operations: [
    { id: 'collect-process-visibility', description: 'collect bounded process visibility', steps: [
      { exec: 'powershell.exe', args: [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', 'tools\\collect-process-visibility.ps1'
      ] }
    ] }
  ]
});

const allowlist = uac.parseAllowlist(rawAllowlist(), { ownerPrincipal: OWNER });

// A token file for the CURRENT boot, written where the client will read it.
// (uac.writeTokenFile requires a repo-internal path, so this lives under state/
// and is removed in the finally block.)
function mintTestToken() {
  const tokenFile = path.join(uac.TOKEN_FILE, '..', `uac-delegation-token.client-test-${process.pid}-${crypto.randomUUID()}.json`);
  const token = uac.loadOrCreateToken({
    tokenFile
  });
  return { tokenFile, token };
}

function startTestHelper(options = {}) {
  const pipeName = `\\\\.\\pipe\\ToolsEnabledUacClientTest-${process.pid}-${crypto.randomUUID()}`;
  const audit = makeMockAudit();
  const ran = [];
  const server = helper.startHelper({
    pipeName,
    expectedToken: options.expectedToken,
    allowlist: options.allowlist || allowlist,
    audit,
    killSwitch: killSwitch(Boolean(options.killSwitchActive)),
    idleMs: false,
    runOperation: options.runOperation || ((resolved) => { ran.push(resolved.id); return { ok: true, steps: [{ executable: 'x', ok: true, exitCode: 0 }] }; })
  });
  return { pipeName, server, audit, ran };
}

const results = [];
const ok = message => { results.push(message); console.log(`OK: ${message}`); };

(async () => {
  // -------------------------------------------------------------------------
  // 1. A non-allowlisted operation is refused LOCALLY: no task start, no pipe.
  // -------------------------------------------------------------------------
  {
    const attempts = [];
    await assert.rejects(
      () => client.runOperation('delete-everything', {
        allowlist,
        startTask: () => { attempts.push('start'); return { started: true }; },
        connect: () => { attempts.push('connect'); throw new Error('must not connect'); }
      }),
      error => error && error.code === 'UAC_CLIENT_NOT_ALLOWLISTED'
    );
    assert.deepEqual(attempts, [], 'a non-allowlisted id must not start the task or open the pipe');

    // Shapes that are not ids at all are refused the same way.
    for (const bad of ['', 'Restart-Fleet', '../evil', 'schtasks.exe /Run', 42, null, { id: 'x' }]) {
      await assert.rejects(() => client.runOperation(bad, { allowlist, startTask: () => { attempts.push('start'); } }),
        error => error && error.code === 'UAC_CLIENT_NOT_ALLOWLISTED', `rejected: ${String(bad)}`);
    }
    assert.deepEqual(attempts, [], 'no malformed id reaches the elevated side');
    ok('a non-allowlisted operation is refused locally without starting the task or opening the pipe');
  }

  // -------------------------------------------------------------------------
  // 2. The shipped authority set is neutral. Installation-specific elevated
  //    operations must be explicitly configured before the client exposes one.
  // -------------------------------------------------------------------------
  {
    const operations = client.allowedOperations({ ownerPrincipal: OWNER });
    assert.deepEqual(operations, []);
    ok('the client exposes no elevated operation from the neutral shipped allowlist');
  }

  // -------------------------------------------------------------------------
  // 3. Happy path over a real pipe: exactly three wire keys, accepted, and the
  //    token appears NOWHERE in the returned value.
  // -------------------------------------------------------------------------
  {
    const { tokenFile, token } = mintTestToken();
    const { pipeName, server, ran } = startTestHelper({ expectedToken: token });
    try {
      await once(server, 'listening');

      // Observe the exact bytes the client puts on the wire.
      let wire = null;
      const connect = name => {
        const socket = net.createConnection(name);
        const originalWrite = socket.write.bind(socket);
        socket.write = chunk => { if (wire === null) wire = String(chunk); return originalWrite(chunk); };
        return socket;
      };

      const result = await client.runOperation('restart-fleet-supervisor', {
        allowlist, pipeName, tokenFile, connect,
        startTask: () => { throw new Error('the helper was already listening; the task must not be started'); }
      });

      assert.equal(result.decision, 'accept');
      assert.equal(result.ok, true);
      assert.equal(ran.length, 1, 'the operation executed exactly once');

      const sent = JSON.parse(wire.trim());
      assert.deepEqual(Object.keys(sent).sort(), ['operation', 'token', 'type'],
        'the request carries EXACTLY three keys -- an extra key makes the helper close the socket silently');
      assert.equal(sent.type, 'operation');
      assert.equal(sent.operation, 'restart-fleet-supervisor');

      const serialized = JSON.stringify(result);
      const secret = token.toString('base64url');
      assert.ok(!serialized.includes(secret), 'the token never appears in the returned result');
      assert.ok(!JSON.stringify(result.outcome || {}).includes(secret));
      ok('an accepted operation round-trips with exactly three wire keys and no token in the result');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Q39's real collector operation crosses the complete client/helper
  //    protocol as one fixed read-only argv vector. The elevated script is
  //    deliberately STUBBED: this proves routing and containment, not a live
  //    privileged collection claim.
  // -------------------------------------------------------------------------
  {
    const configuredAllowlist = uac.parseAllowlist(rawCollectorAllowlist(), { ownerPrincipal: OWNER });
    const { tokenFile, token } = mintTestToken();
    const resolved = [];
    const { pipeName, server } = startTestHelper({
      expectedToken: token,
      allowlist: configuredAllowlist,
      runOperation: operation => {
        resolved.push(operation);
        return { ok: true, steps: [{ executable: operation.steps[0].executable, ok: true, exitCode: 0 }] };
      }
    });
    try {
      await once(server, 'listening');
      const result = await client.runOperation('collect-process-visibility', {
        allowlist: configuredAllowlist,
        pipeName,
        tokenFile,
        startTask: () => { throw new Error('the test helper is already listening'); }
      });

      assert.equal(result.ok, true);
      assert.equal(resolved.length, 1, 'the Q39 collector operation is dispatched exactly once');
      assert.equal(resolved[0].id, 'collect-process-visibility');
      assert.equal(resolved[0].steps.length, 1, 'the Q39 collector has exactly one fixed step');
      assert.ok(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(resolved[0].steps[0].executable));
      assert.deepEqual([...resolved[0].steps[0].args], [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', 'tools\\collect-process-visibility.ps1'
      ], 'no caller-selected executable, arguments, path, or PID reaches the elevated collector');
      ok('the Q39 collector crosses the client/helper pipe as one fixed read-only argv vector (stubbed, not elevated)');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 5. The kill switch is honored: the helper refuses and the client reports
  //    ok:false with reason 'killswitch' -- never a thrown-away success.
  // -------------------------------------------------------------------------
  {
    const { tokenFile, token } = mintTestToken();
    const { pipeName, server, ran } = startTestHelper({ expectedToken: token, killSwitchActive: true });
    try {
      await once(server, 'listening');
      const result = await client.runOperation('restart-fleet-supervisor', { allowlist, pipeName, tokenFile, startTask: () => ({ started: true }) });
      assert.equal(result.decision, 'refuse');
      assert.equal(result.reason, 'killswitch');
      assert.equal(result.ok, false);
      assert.equal(ran.length, 0, 'the kill switch prevented execution');
      ok('the kill switch is honored end to end and reported as a refusal');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 6. accept + outcome.ok:false is NOT success.
  // -------------------------------------------------------------------------
  {
    const { tokenFile, token } = mintTestToken();
    const { pipeName, server } = startTestHelper({
      expectedToken: token,
      runOperation: () => ({ ok: false, steps: [{ executable: 'C:\\Windows\\System32\\schtasks.exe', ok: false, exitCode: 1, error: 'ERROR: access denied' }] })
    });
    try {
      await once(server, 'listening');
      const result = await client.runOperation('restart-fleet-supervisor', { allowlist, pipeName, tokenFile, startTask: () => ({ started: true }) });
      assert.equal(result.decision, 'accept');
      assert.equal(result.ok, false, 'an accepted operation whose step failed is NOT success');
      assert.equal(result.outcome.ok, false);
      assert.equal(result.outcome.steps[0].exitCode, 1);
      ok('an accepted operation whose elevated step failed is reported as ok:false');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 7. A silent close (how the helper rejects a malformed request) must not
  //    hang, and must be reported as "did not run".
  // -------------------------------------------------------------------------
  {
    const { tokenFile } = mintTestToken();
    const pipeName = `\\\\.\\pipe\\ToolsEnabledUacClientClose-${process.pid}-${crypto.randomUUID()}`;
    // Wait until the request is received before closing. Destroying immediately
    // races the client's write on Unix and can produce EPIPE instead of the
    // silent-close protocol error this assertion is specifically checking.
    const server = net.createServer(socket => socket.once('data', () => socket.end()));
    server.listen(pipeName);
    try {
      await once(server, 'listening');
      await assert.rejects(
        () => client.runOperation('restart-fleet-supervisor', { allowlist, pipeName, tokenFile, startTask: () => ({ started: true }) }),
        error => error && error.code === 'UAC_CLIENT_PROTOCOL' && /did NOT run/.test(error.message)
      );
      ok('a helper that closes without answering fails fast and is reported as "did not run"');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 8. A response timeout is UNKNOWN, never failure, and never retried.
  // -------------------------------------------------------------------------
  {
    const { tokenFile } = mintTestToken();
    const pipeName = `\\\\.\\pipe\\ToolsEnabledUacClientHang-${process.pid}-${crypto.randomUUID()}`;
    let connections = 0;
    const held = [];
    const server = net.createServer(socket => { connections += 1; held.push(socket); /* never answer */ });
    server.listen(pipeName);
    try {
      await once(server, 'listening');
      await assert.rejects(
        () => client.runOperation('restart-fleet-supervisor', { allowlist, pipeName, tokenFile, responseTimeoutMs: 400, startTask: () => ({ started: true }) }),
        error => error && error.code === 'UAC_CLIENT_TIMEOUT' && error.outcomeUnknown === true && /MAY have executed/.test(error.message)
      );
      assert.equal(connections, 1, 'a request is never replayed after the bytes are on the wire');
      ok('a response timeout is reported as UNKNOWN (not failure) and the request is never retried');
    } finally {
      for (const socket of held) { try { socket.destroy(); } catch { /* ignore */ } }
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 9. Missing helper task: a specific, actionable error -- and the token is
  //    never written to stdout/stderr or any state file by this client.
  // -------------------------------------------------------------------------
  {
    const { tokenFile, token } = mintTestToken();
    const scanRoot = path.join(uac.TOKEN_FILE, '..', '..');
    const sentinels = ['logs', 'state'].map(dir => {
      const full = path.join(scanRoot, dir);
      fs.mkdirSync(full, { recursive: true });
      const file = path.join(full, `uac-client-scan-${process.pid}.txt`);
      fs.writeFileSync(file, 'token leak scan sentinel\n', 'utf8');
      return file;
    });
    try {
      await assert.rejects(
        () => client.runOperation('restart-fleet-supervisor', {
          allowlist, tokenFile,
          pipeName: `\\\\.\\pipe\\ToolsEnabledUacClientAbsent-${process.pid}-${crypto.randomUUID()}`,
          connectTimeoutMs: 300, pollIntervalMs: 50,
          execFileSync: () => { const error = new Error('ERROR: The system cannot find the file specified.'); error.status = 1; throw error; }
        }),
        error => error && error.code === 'UAC_CLIENT_TASK_MISSING' && /uac-delegation-task\.ps1 -Register/.test(error.message)
      );

      // The token file this test minted must be the ONLY place the secret
      // exists: nothing under logs/ or state/ (other than the token file) may
      // contain it after a client run.
      const secret = token.toString('base64url');
      const scanned = [];
      for (const dir of ['logs', 'state']) {
        const pending = [path.join(scanRoot, dir)];
        let filesInDirectory = 0;
        while (pending.length > 0) {
          const full = pending.pop();
          const entries = fs.readdirSync(full, { withFileTypes: true });
          for (const entry of entries) {
            const file = path.join(full, entry.name);
            if (entry.isDirectory()) { pending.push(file); continue; }
            if (!entry.isFile()) continue;
            if (file === tokenFile) continue;
            if (!/\.(json|jsonl|log|txt)$/i.test(entry.name)) continue;
            const text = fs.readFileSync(file, 'utf8');
            filesInDirectory += 1;
            scanned.push(file);
            assert.ok(!text.includes(secret), `the delegation token must never be written to ${file}`);
          }
        }
        assert.ok(filesInDirectory > 0, `the token-leak scan actually read a file under ${dir}/`);
      }
      assert.ok(sentinels.every(file => scanned.includes(file)), 'the token-leak scan traversed both controlled sentinel files');

      // And the scrubber removes a token even if a future edit leaks one.
      assert.ok(!client.scrub(`token=${secret} failed`).includes(secret), 'scrub() removes a token-shaped string');
      ok(`a missing helper task gives an actionable error, and the token appears in none of ${scanned.length} scanned log/state files`);
    } finally {
      fs.rmSync(tokenFile, { force: true });
      for (const file of sentinels) fs.rmSync(file, { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 10. A busy/failing machine must not turn an unreadable token into absence.
  //     CONTROL: genuine ENOENT still starts the helper exactly once.
  // -------------------------------------------------------------------------
  {
    for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY']) {
      let starts = 0;
      const io = { readFileSync: () => { const error = new Error(`${code}: token read failed`); error.code = code; throw error; } };
      await assert.rejects(
        () => client.obtainToken({ fs: io, startTask: () => { starts += 1; return { started: true }; }, connectTimeoutMs: 0, pollIntervalMs: 0 }),
        error => error && error.code === 'UAC_CLIENT_TOKEN_STATUS_UNAVAILABLE' && /NOT claim that the token is absent/.test(error.message)
      );
      assert.equal(starts, 0, `${code} must not start the helper as though the token were absent`);
    }

    let starts = 0;
    const absentFs = { readFileSync: () => { const error = new Error('ENOENT: token absent'); error.code = 'ENOENT'; throw error; } };
    await assert.rejects(
      () => client.obtainToken({ fs: absentFs, startTask: () => { starts += 1; return { started: true }; }, connectTimeoutMs: 0, pollIntervalMs: 0 }),
      error => error && error.code === 'UAC_CLIENT_TOKEN_UNAVAILABLE'
    );
    assert.equal(starts, 1, 'CONTROL: a genuinely absent token still starts the helper exactly once');
    ok('unreadable token status stays unknown without starting the helper; genuine absence still starts it once');
  }

  // -------------------------------------------------------------------------
  // 11. The helper is started on demand exactly once when nothing is listening.
  // -------------------------------------------------------------------------
  {
    const { tokenFile, token } = mintTestToken();
    const pipeName = `\\\\.\\pipe\\ToolsEnabledUacClientLazy-${process.pid}-${crypto.randomUUID()}`;
    let server = null;
    let starts = 0;
    try {
      const result = await client.runOperation('restart-fleet-supervisor', {
        allowlist, pipeName, tokenFile, pollIntervalMs: 50, connectTimeoutMs: 5000,
        startTask: () => {
          starts += 1;
          const started = helper.startHelper({
            pipeName, expectedToken: token, allowlist, audit: makeMockAudit(), killSwitch: killSwitch(false),
            idleMs: false, runOperation: () => ({ ok: true, steps: [{ executable: 'x', ok: true, exitCode: 0 }] })
          });
          server = started;
          return { started: true };
        }
      });
      assert.equal(result.ok, true);
      assert.equal(starts, 1, 'the on-demand task is started exactly once');
      assert.equal(result.helperStarted, true, 'the result records that the helper had to be started');
      ok('the client starts the on-demand helper task exactly once when the pipe is absent');
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      fs.rmSync(tokenFile, { force: true });
    }
  }

  console.log(`UAC delegation client tests passed (${results.length} checks).`);
})().catch(error => { console.error(error); process.exitCode = 1; });

// MUTATION: in a scratch copy, startHelperTask wrote the token to
// state/uac-client-mutation/nested/leak.log before reporting a missing task.
// RED: "AssertionError [ERR_ASSERTION]: the delegation token must never be written to .../nested/leak.log"
// RESTORE: the scratch source was restored byte-for-byte; the complete run was
// green: "UAC delegation client tests passed (10 checks)."
// NOT-FOUND (1): every other assertion loop has a fixed non-empty input, or an explicit non-empty postcondition.
// NOT-FOUND (2): no assertion treats a process exit status or truthy spawn return as subject evidence.
// NOT-FOUND (3): no remaining catch or optional chain swallows the failure an assertion is intended to detect.
// NOT-FOUND (4): the stubbed collector outcome assertion measures its mock and was not weakened; its routing assertions measure real protocol behavior.
// NOT-FOUND (5): the file has no skip or platform precondition guard. The immediate-close fixture raced with EPIPE on Unix and is now deterministic.
// NOT-FOUND (6): no expected assertion value is computed by the same product code it checks.
// PRECONDITIONS: named-pipe-compatible local sockets and permission to create temporary files beneath logs/ and state/.
