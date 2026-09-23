'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Zed context-terminal end-to-end test skipped outside Windows.');
  process.exit(0);
}

const node = 'C:\\agent-apps\\node-v22.19.0\\node.exe';
const wrapper = path.resolve(__dirname, '..', 'tools', 'zed-context-terminal.js');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-context-e2e-'));
const sessionRoot = path.join(fixtureRoot, 'sessions');
const stateRoot = path.join(fixtureRoot, 'state');
const logRoot = path.join(fixtureRoot, 'logs');
const fakeAgent = path.join(fixtureRoot, 'fake-agent.js');
const resumeShim = path.join(fixtureRoot, 'resume');
const resumeEvidence = path.join(fixtureRoot, 'resume-evidence.json');
const terminalReset = '\x1b[2J\x1b[3J\x1b[H';
const STARTUP_TIMEOUT_MS = 8000;
const LAUNCH_TIMEOUT_MS = 12000;
const LIVE_CHECK_MS = 900;

function permanentTail(output) {
  const resetAt = output.lastIndexOf(terminalReset);
  return resetAt === -1 ? output : output.slice(resetAt + terminalReset.length);
}

fs.mkdirSync(sessionRoot, { recursive: true });
// `buildResumeArgs()` invokes a Codex-compatible command as
// `command resume ... <saved-session-id>`. Node treats an extensionless file
// named `resume` as its script here, letting this fixture verify the exact
// session ID supplied by the wrapper before handing control to the fake TUI.
fs.writeFileSync(resumeShim, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[2];
const sessionFile = process.argv[3];
const placeholderSessionId = process.argv[4];
const cwd = process.argv[5];
const reply = process.argv[6];
const resumedSessionId = process.argv[7];
fs.writeFileSync(path.join(cwd, 'resume-evidence.json'), JSON.stringify({
  placeholderSessionId,
  resumedSessionId,
  sessionFile
}));
process.argv = [process.argv[0], target, sessionFile, resumedSessionId, cwd, reply];
require(path.resolve(target));
`, 'utf8');
fs.writeFileSync(fakeAgent, `'use strict';
const fs = require('node:fs');
const sessionFile = process.argv[2];
const sessionId = process.argv[3];
const cwd = process.argv[4];
const reply = process.argv[5];
fs.appendFileSync(sessionFile, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd, source: 'cli', originator: 'codex-tui' } }) + '\\n');
process.stdout.write('RAW_BOOTSTRAP_HIDDEN\\n');
const statusRedraw = setInterval(() => process.stdout.write('RAW_STATUS_REDRAW\\n'), 100);
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
let pending = '';
let handled = false;
process.stdin.on('data', chunk => {
  pending += chunk.toString('utf8');
  let newline;
  while ((newline = pending.search(/[\\r\\n]/)) !== -1) {
    const request = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!request) continue;
    if (request === '__EXIT__') {
      clearInterval(statusRedraw);
      process.exit(0);
    }
    if (handled) continue;
    handled = true;
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: request } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', input: 'RAW_TOOL_DETAIL_HIDDEN' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: reply } }),
      ''
    ].join('\\n'));
    process.stdout.write('RAW_TOOL_DETAIL_HIDDEN\\n');
  }
});
process.stdin.resume();
setTimeout(() => process.exit(3), 8000).unref();
`, 'utf8');

function launch({ sessionFile, sessionId, request, reply }) {
  const args = [
    wrapper,
    '--agent', 'codex',
    '--command', node,
    '--cwd', fixtureRoot,
    '--log-dir', logRoot,
    '--state-dir', stateRoot,
    '--session-root', sessionRoot,
    '--poll-ms', '50'
  ];
  args.push('--', fakeAgent, sessionFile, sessionId, fixtureRoot, reply);
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { cwd: fixtureRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let liveSnapshot = '';
    let interactionStarted = false;
    let settled = false;
    let startupTimer = null;
    let liveCheck = null;
    let launchTimer = null;

    const clearTimers = () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (liveCheck) clearTimeout(liveCheck);
      if (launchTimer) clearTimeout(launchTimer);
      startupTimer = null;
      liveCheck = null;
      launchTimer = null;
    };
    const fail = (error, { kill = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (kill && !child.killed) child.kill();
      reject(error);
    };
    const succeed = code => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, stdout, stderr, liveSnapshot });
    };
    const writeInput = (value, label) => {
      if (!child.stdin.writable || child.stdin.destroyed) {
        fail(new Error(`context-terminal stdin closed before ${label}`), { kill: true });
        return false;
      }
      try {
        child.stdin.write(value);
        return true;
      } catch (error) {
        fail(new Error(`context-terminal could not send ${label}: ${error.message}`), { kill: true });
        return false;
      }
    };
    const startInteraction = () => {
      if (interactionStarted || settled) return;
      interactionStarted = true;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      if (!writeInput(`${request}\r`, 'request')) return;
      // Default native previews have a 500 ms hard lifetime. Start this window
      // only after the fake TUI proves it booted, so a cold relay compile cannot
      // queue request and exit together before the first 100 ms status tick.
      liveCheck = setTimeout(() => {
        liveCheck = null;
        if (settled) return;
        liveSnapshot = stdout;
        writeInput('__EXIT__\r', 'exit request');
      }, LIVE_CHECK_MS);
    };

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!interactionStarted && stdout.includes('RAW_BOOTSTRAP_HIDDEN')) startInteraction();
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdin.on('error', () => { /* child may already be closing */ });
    startupTimer = setTimeout(() => {
      fail(new Error('context-terminal startup timed out before RAW_BOOTSTRAP_HIDDEN'), { kill: true });
    }, STARTUP_TIMEOUT_MS);
    launchTimer = setTimeout(() => {
      fail(new Error('context-terminal end-to-end launch timed out'), { kill: true });
    }, LAUNCH_TIMEOUT_MS);
    child.once('error', error => fail(error));
    child.once('close', code => {
      if (!interactionStarted) {
        fail(new Error(`context-terminal closed before RAW_BOOTSTRAP_HIDDEN (code ${code})`));
        return;
      }
      succeed(code);
    });
  });
}

async function main() {
  const firstId = '019fbaaf-3e2d-7960-9c78-820d7e67e4ad';
  const firstSessionFile = path.join(sessionRoot, 'first.jsonl');
  const first = await launch({
    sessionFile: firstSessionFile,
    sessionId: firstId,
    request: 'hello durable context',
    reply: 'assistant context survives'
  });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /hello durable context/);
  assert.match(first.stdout, /assistant context survives/);
  assert.match(first.stdout, /RAW_TOOL_DETAIL_HIDDEN/);
  assert.match(first.stdout, /RAW_STATUS_REDRAW/);
  assert.doesNotMatch(permanentTail(first.stdout), /RAW_BOOTSTRAP_HIDDEN|RAW_TOOL_DETAIL_HIDDEN|RAW_STATUS_REDRAW/);
  assert.match(permanentTail(first.stdout), /hello durable context/);
  assert.match(permanentTail(first.stdout), /assistant context survives/);
  assert.doesNotMatch(permanentTail(first.liveSnapshot), /RAW_BOOTSTRAP_HIDDEN|RAW_TOOL_DETAIL_HIDDEN|RAW_STATUS_REDRAW/);
  assert.match(permanentTail(first.liveSnapshot), /hello durable context/);
  assert.match(permanentTail(first.liveSnapshot), /assistant context survives/);

  const rawLogs = fs.readdirSync(logRoot).filter(name => name.endsWith('.stdout.log'));
  assert.equal(rawLogs.length, 1);
  assert.match(fs.readFileSync(path.join(logRoot, rawLogs[0]), 'utf8'), /RAW_TOOL_DETAIL_HIDDEN/);
  assert.match(fs.readFileSync(path.join(logRoot, rawLogs[0]), 'utf8'), /RAW_STATUS_REDRAW/);
  const historyFile = fs.readdirSync(stateRoot).find(name => name.endsWith('.context.jsonl'));
  const stateFile = fs.readdirSync(stateRoot).find(name => name.endsWith('.state.json'));
  const durableHistory = fs.readFileSync(path.join(stateRoot, historyFile), 'utf8');
  assert.match(durableHistory, /hello durable context/);
  assert.match(durableHistory, /assistant context survives/);
  assert.doesNotMatch(durableHistory, /RAW_TOOL_DETAIL_HIDDEN/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, stateFile), 'utf8')).sessionId, firstId);

  const second = await launch({
    sessionFile: firstSessionFile,
    sessionId: '3603b824-9a1f-4ce4-af25-a2e2880df2c5',
    request: 'after simulated restart',
    reply: 'second durable reply'
  });
  assert.equal(second.code, 0, second.stderr);
  const resumed = JSON.parse(fs.readFileSync(resumeEvidence, 'utf8'));
  assert.equal(resumed.placeholderSessionId, '3603b824-9a1f-4ce4-af25-a2e2880df2c5');
  assert.equal(resumed.resumedSessionId, firstId);
  assert.equal(path.resolve(resumed.sessionFile), firstSessionFile);
  const secondPermanent = permanentTail(second.stdout);
  assert.equal((secondPermanent.match(/hello durable context/g) || []).length, 1);
  assert.equal((secondPermanent.match(/assistant context survives/g) || []).length, 1);
  assert.match(secondPermanent, /after simulated restart/);
  assert.match(secondPermanent, /second durable reply/);
  assert.doesNotMatch(secondPermanent, /RAW_BOOTSTRAP_HIDDEN|RAW_TOOL_DETAIL_HIDDEN|RAW_STATUS_REDRAW/);
  const stateAfterRestart = JSON.parse(fs.readFileSync(path.join(stateRoot, stateFile), 'utf8'));
  assert.equal(stateAfterRestart.sessionId, firstId);
  assert.equal(path.resolve(stateAfterRestart.sessionFile), firstSessionFile);
  const historyAfterRestart = fs.readFileSync(path.join(stateRoot, historyFile), 'utf8');
  assert.equal((historyAfterRestart.match(/hello durable context/g) || []).length, 1);
  assert.equal((historyAfterRestart.match(/assistant context survives/g) || []).length, 1);
  assert.equal((historyAfterRestart.match(/after simulated restart/g) || []).length, 1);
  assert.equal((historyAfterRestart.match(/second durable reply/g) || []).length, 1);
  console.log('Zed context-terminal exact-session restart persistence test passed.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  catch (error) {
    console.error(`could not remove end-to-end fixture: ${error.message}`);
    process.exitCode = 1;
  }
});
