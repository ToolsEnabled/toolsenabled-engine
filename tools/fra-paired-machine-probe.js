#!/usr/bin/env node
'use strict';

// A transport proof using the production online FRA session on two processes.
// The SSH variant runs the other endpoint on the explicitly pinned Windows
// host. Fresh device keys stay in their creating processes; only public keys,
// signed hellos, encrypted frames and metadata travel. This does not enroll a
// device, load an owner vault, expose a listener, or admit workspace commands.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ENGINE_ROOT = path.resolve(__dirname, '..');
const CAPABILITY_DIGEST = crypto.createHash('sha256').update('ToolsEnabled/FRA/transport-only-probe/v1; no workspace capabilities').digest('hex');

// Self-contained because the exact function also runs on the Windows peer.
// The production module is loaded from that peer's checkout, never copied.
function createProbeState(options) {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const modulePath = path.join(options.engineRoot, 'src', 'lib', 'online-fra-e2e-session.js');
  const online = require(modulePath);
  const identity = crypto.generateKeyPairSync('ed25519');
  const publicKeyWire = identity.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const events = [];
  const sessions = [];
  const logPath = path.join(options.evidenceRoot, 'session-events.ndjson');
  let logFd = fs.openSync(logPath, 'wx', 0o600);
  let auditClosedForTest = false;
  let finished = false;
  function eventSink(event) {
    const allowed = ['kind', 'version', 'generation', 'session'];
    if (Object.keys(event).some(key => !allowed.includes(key))) throw new Error('Unexpected event field');
    fs.writeSync(logFd, JSON.stringify(event) + '\n');
    fs.fsyncSync(logFd);
    events.push(event);
  }
  function endpoint({ peerPublicKeyWire, generation, ...overrides }) {
    const peerPublicKey = crypto.createPublicKey({ key: Buffer.from(peerPublicKeyWire, 'base64url'), format: 'der', type: 'spki' });
    return online.createEndpoint({
      identityPrivateKey: identity.privateKey, peerPublicKey,
      pairId: options.pairId, capabilityDigest: options.capabilityDigest,
      localDeviceId: options.role === 'A' ? 'probe-linux' : 'probe-windows',
      peerDeviceId: options.role === 'A' ? 'probe-windows' : 'probe-linux',
      role: options.role, generation, eventSink, ...overrides
    });
  }
  function remember(session) { sessions.push(session); return session; }
  function breakAudit() {
    fs.closeSync(logFd);
    logFd = null;
    auditClosedForTest = true;
  }
  function finish() {
    if (finished) throw new Error('Probe already finished');
    finished = true;
    for (const session of sessions) if (!session.closed) session.close();
    if (logFd !== null) { fs.closeSync(logFd); logFd = null; }
    const counts = {};
    for (const event of events) counts[event.kind] = (counts[event.kind] || 0) + 1;
    const report = {
      platform: process.platform, nodeVersion: process.version, pid: process.pid,
      moduleSha256: crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'),
      eventCount: events.length, eventKinds: counts,
      auditSha256: crypto.createHash('sha256').update(fs.readFileSync(logPath)).digest('hex'),
      allSessionsClosed: sessions.every(session => session.closed),
      logDescriptorClosed: logFd === null, auditClosedForTest,
      evidenceRoot: options.evidenceRoot, privateKeysExported: false
    };
    fs.writeFileSync(path.join(options.evidenceRoot, 'peer-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  }
  return { online, endpoint, remember, breakAudit, finish, publicKeyWire, events,
    moduleSha256: crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex') };
}

// A small, bounded control protocol. No operation accepts a filesystem path
// or a command. "frame" only decrypts and re-encrypts bytes using FRA itself.
async function peerMain(options) {
  const fs = require('node:fs');
  const path = require('node:path');
  const readline = require('node:readline');
  const state = createProbeState(options);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  let endpoint = null;
  let session = null;
  let stopped = false;
  let previousGeneration = 0;
  const watchdog = setTimeout(() => input.close(), 25_000);
  send({ ready: true, publicKeyWire: state.publicKeyWire, moduleSha256: state.moduleSha256, platform: process.platform, nodeVersion: process.version });
  try {
    for await (const line of input) {
      if (Buffer.byteLength(line, 'utf8') > state.online.MAX_FRAME_BYTES + 4096) throw new Error('Control frame too large');
      const message = JSON.parse(line);
      if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Invalid request id');
      let result;
      try {
        if (message.op === 'start') {
          if (!Number.isSafeInteger(message.generation) || message.generation <= previousGeneration) throw new Error('Generation did not advance');
          previousGeneration = message.generation;
          if (session && !session.closed) session.close();
          session = null;
          endpoint = state.endpoint({ peerPublicKeyWire: options.peerPublicKeyWire, generation: message.generation,
            ...(message.shortLease === true ? { leaseTtlMs: 1000 } : {}) });
          result = { hello: endpoint.createHello() };
        } else if (message.op === 'accept') {
          session = state.remember(endpoint.acceptPeerHello(message.hello));
          result = { transcriptHash: session.transcriptHash, expiresAtMs: session.expiresAtMs };
        } else if (message.op === 'frame') {
          result = { frame: session.seal(session.open(message.frame)) };
        } else if (message.op === 'close') {
          if (session && !session.closed) session.close();
          result = { closed: session === null || session.closed };
        } else if (message.op === 'break-audit') {
          if (session && !session.closed) throw new Error('Close the session before the audit refusal test');
          state.breakAudit();
          result = { auditClosed: true };
        } else if (message.op === 'finish') {
          result = state.finish();
          stopped = true;
        } else throw new Error('Unsupported control operation');
        send({ id: message.id, ok: true, result });
      } catch (error) {
        send({ id: message.id, ok: false, code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROBE_PEER_FAILED',
          closed: Boolean(session && session.closed) });
      }
      if (stopped) break;
    }
  } finally {
    clearTimeout(watchdog);
    input.close();
    process.stdin.destroy();
    if (!stopped) {
      // Completion is not inferred from EOF or SSH termination. This marker
      // is metadata only and the controller must still observe a clean exit.
      try { state.finish(); } catch {}
      fs.writeFileSync(path.join(options.evidenceRoot, 'incomplete.json'), '{"complete":false}\n', { flag: 'wx', mode: 0o600 });
      process.exitCode = 1;
    }
  }
}

function makePeerScript() {
  return `'use strict';\nconst createProbeState = ${createProbeState.toString()};\n(${peerMain.toString()})(JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8'))).catch(() => { process.stderr.write('FRA probe peer failed\\n'); process.exitCode = 1; });`;
}

function psString(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function buildWindowsCommand(options, peerOptions) {
  const code = zlib.deflateRawSync(Buffer.from(makePeerScript(), 'utf8')).toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$profileRoot = ${psString(options.windowsProfile)}
$scratchRoot = ${psString(options.windowsTemp)}
if ($profileRoot -notmatch '^C:\\\\Users\\\\[A-Za-z0-9._-]+$') { throw 'Explicit profile root required' }
if (-not [string]::Equals($scratchRoot, ($profileRoot + '\\AppData\\Local\\Temp'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Explicit owner temp root required' }
$accountName = [Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\\')[-1]
if (-not [string]::Equals($accountName, (Split-Path -Leaf $profileRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'SSH account does not own the pinned profile' }
function Assert-ProbePath([string]$target, [bool]$executable = $false) {
  $full = [IO.Path]::GetFullPath($target)
  $inside = $full.StartsWith(($profileRoot + '\\'), [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($full, $profileRoot, [StringComparison]::OrdinalIgnoreCase)
  if (-not $inside -and (-not $executable -or $full.StartsWith('C:\\Users\\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Probe path is outside the pinned profile' }
  $ancestors = New-Object 'Collections.Generic.List[string]'
  $cursor = $full
  while ($cursor) {
    $ancestors.Insert(0, $cursor)
    $next = Split-Path -Parent $cursor
    if ($next -eq $cursor) { break }
    $cursor = $next
  }
  foreach ($ancestor in $ancestors) {
    try { $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { break }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Probe path has a reparse ancestor' }
  }
  return $full
}
$engineRoot = Assert-ProbePath ${psString(options.windowsEngine)}
$modulePath = Assert-ProbePath (Join-Path $engineRoot 'src\\lib\\online-fra-e2e-session.js')
$nodePath = Assert-ProbePath ${psString(options.windowsNode)} $true
$scratchRoot = Assert-ProbePath $scratchRoot
$evidenceRoot = Assert-ProbePath (Join-Path $scratchRoot ${psString(options.runId)})
if (Test-Path -LiteralPath $evidenceRoot) { throw 'Probe evidence root already exists' }
[void][IO.Directory]::CreateDirectory($evidenceRoot)
$evidenceRoot = Assert-ProbePath $evidenceRoot
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(Buffer.from(JSON.stringify(peerOptions)).toString('base64'))})) | ConvertFrom-Json
$config | Add-Member -NotePropertyName evidenceRoot -NotePropertyValue $evidenceRoot
$config64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Compress)))
$pinnedEnvironment = @{ SystemRoot='C:\\Windows'; WINDIR='C:\\Windows'; TEMP=$scratchRoot; TMP=$scratchRoot; USERPROFILE=$profileRoot; HOME=$profileRoot; APPDATA=($profileRoot + '\\AppData\\Roaming'); LOCALAPPDATA=($profileRoot + '\\AppData\\Local'); PATH=((Split-Path -Parent $nodePath) + ';C:\\Windows\\System32'); TOOLSENABLED_STATE_ROOT=$evidenceRoot }
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }
foreach ($name in $pinnedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $pinnedEnvironment[$name], 'Process') }
Set-Location -LiteralPath $evidenceRoot
& $nodePath -e 'eval(require(process.argv[1]).inflateRawSync(Buffer.from(process.argv[2],process.argv[3])).toString())' 'node:zlib' ${psString(code)} 'base64' $config64
exit $LASTEXITCODE
`;
  // Windows OpenSSH commonly invokes cmd.exe, whose command line is much
  // shorter than CreateProcess's. Send the non-secret bootstrap on stdin;
  // no frame follows it until Node has reported ready, so the PowerShell
  // line reader cannot prefetch any of the endpoint's protocol input.
  const loader = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))";
  const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(loader, 'utf16le').toString('base64');
  assert.ok(command.length < 8000, 'Remote loader exceeds the Windows SSH command-line bound');
  return { command, bootstrap: Buffer.from(script, 'utf8').toString('base64') + '\n' };
}

function connectControl(child) {
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let readyResolve;
  let readyReject;
  let stderr = '';
  let closed = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completion = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    const error = new Error('Peer ended before its response' + (stderr.trim() ? ': ' + stderr.trim() : ''));
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    resolve({ code, signal, stderr });
  }));
  child.on('error', error => { readyReject(error); for (const item of pending.values()) item.reject(error); });
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) { child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { child.kill(); return; }
      if (message.ready === true) { readyResolve(message); continue; }
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); item.resolve(message); }
    }
  });
  async function request(op, fields = {}) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const timer = setTimeout(() => { pending.get(id)?.reject(new Error('Peer response timed out')); pending.delete(id); }, 8000);
    child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
    try { return await response; } finally { clearTimeout(timer); }
  }
  return { ready, completion, request, get closed() { return closed; } };
}

function assertDirectionalKeySeparation(sent, received) {
  const outbound = Buffer.from(sent.ciphertext, 'base64url');
  const inbound = Buffer.from(received.ciphertext, 'base64url');
  // A single encrypted byte has only 256 possible values. Independent keys
  // can produce the same byte; use a full challenge for this separate proof.
  assert.ok(outbound.length >= 32 && inbound.length >= 32, 'Key separation requires at least 32 ciphertext bytes');
  assert.notDeepEqual(outbound, inbound, 'Directions must use independent keys');
}

async function runPairedProbe({ localScratch, launchPeer, expectedPeerPlatform = 'win32', transport = 'pinned-ssh' }) {
  assert.ok(path.isAbsolute(localScratch), 'An explicit absolute local scratch root is required');
  const evidenceRoot = fs.mkdtempSync(path.join(fs.realpathSync(localScratch), 'fra-paired-machine-'));
  fs.chmodSync(evidenceRoot, 0o700);
  const common = { pairId: 'probe-' + crypto.randomBytes(12).toString('hex'), capabilityDigest: CAPABILITY_DIGEST };
  const local = createProbeState({ ...common, engineRoot: ENGINE_ROOT, evidenceRoot, role: 'A' });
  const child = launchPeer({ ...common, role: 'B', peerPublicKeyWire: local.publicKeyWire });
  const control = connectControl(child);
  const timeout = setTimeout(() => child.kill(), 40_000);
  const checks = [];
  let generation = 0;
  let remote;
  let localReport;
  let terminal = null;
  function check(name, condition) { assert.ok(condition, name); checks.push(name); }
  function refused(name, response, code, mustClose = true) {
    check(name, response.ok === false && response.code === code && (!mustClose || response.closed === true));
  }
  function localRefusal(name, action, code, session) {
    assert.throws(action, error => error.code === code, name);
    check(name, !session || session.closed === true);
  }
  async function begin({ shortLease = false, localOverrides = {}, accept = true } = {}) {
    const currentGeneration = ++generation;
    const started = await control.request('start', { generation: currentGeneration, shortLease });
    assert.ok(started.ok, 'Remote endpoint did not create its hello');
    const endpoint = local.endpoint({ peerPublicKeyWire: remote.publicKeyWire, generation: currentGeneration,
      ...(shortLease ? { leaseTtlMs: 1000 } : {}), ...localOverrides });
    const hello = endpoint.createHello();
    if (!accept) return { endpoint, hello, remoteHello: started.result.hello };
    const session = local.remember(endpoint.acceptPeerHello(started.result.hello));
    const accepted = await control.request('accept', { hello });
    assert.ok(accepted.ok && accepted.result.transcriptHash === session.transcriptHash, 'Both production endpoints must bind the same transcript');
    return session;
  }
  async function exchange(session, plaintext) {
    const sent = session.seal(plaintext);
    const answer = await control.request('frame', { frame: sent });
    assert.ok(answer.ok, 'Remote frame was refused');
    assert.ok(sent.direction === 'A->B' && answer.result.frame.direction === 'B->A', 'FRA directions must be reciprocal');
    assert.ok(session.open(answer.result.frame) === plaintext, 'Round-trip plaintext must match byte-for-byte');
    return { sent, received: answer.result.frame };
  }
  try {
    remote = await control.ready;
    check('peer-runs-on-required-platform', remote.platform === expectedPeerPlatform);
    check('production-session-source-identical', remote.moduleSha256 === local.moduleSha256);
    let session = await begin();
    const marker = 'probe-' + crypto.randomBytes(32).toString('hex');
    for (const length of [1, 256, 65536, local.online.MAX_PLAINTEXT_BYTES]) {
      const frames = await exchange(session, marker.repeat(Math.ceil(length / marker.length)).slice(0, length));
      if (length === 256) {
        assertDirectionalKeySeparation(frames.sent, frames.received);
        checks.push('directions-use-independent-keys');
      }
      checks.push(`sealed-roundtrip-${length}-bytes`);
    }
    await exchange(session, 'Unicode: \u2603 \ud83e\uddea \u4e2d\u6587');
    checks.push('sealed-roundtrip-unicode');
    check('local-audit-contains-no-plaintext', !JSON.stringify(local.events).includes(marker));
    session.close();

    session = await begin();
    let frames = await exchange(session, marker);
    refused('windows-rejects-replayed-linux-frame', await control.request('frame', { frame: frames.sent }), 'ONLINE_FRA_SEQUENCE_INVALID');
    refused('windows-replay-closes-session', await control.request('frame', { frame: session.seal(marker) }), 'ONLINE_FRA_SESSION_CLOSED');
    session.close();

    session = await begin();
    frames = await exchange(session, marker);
    localRefusal('linux-rejects-replayed-windows-frame', () => session.open(frames.received), 'ONLINE_FRA_SEQUENCE_INVALID', session);
    localRefusal('linux-replay-closes-session', () => session.seal(marker), 'ONLINE_FRA_SESSION_CLOSED', session);

    session = await begin();
    let frame = session.seal(marker);
    const bytes = Buffer.from(frame.ciphertext, 'base64url'); bytes[0] ^= 1;
    refused('windows-rejects-modified-ciphertext', await control.request('frame', { frame: { ...frame, ciphertext: bytes.toString('base64url') } }), 'ONLINE_FRA_DECRYPTION_FAILED');
    session.close();

    session = await begin();
    const reply = await control.request('frame', { frame: session.seal(marker) });
    assert.ok(reply.ok, 'Peer must return a valid sealed frame before tampering');
    const tag = Buffer.from(reply.result.frame.tag, 'base64url'); tag[0] ^= 1;
    localRefusal('linux-rejects-modified-authentication-tag', () => session.open({ ...reply.result.frame, tag: tag.toString('base64url') }), 'ONLINE_FRA_DECRYPTION_FAILED', session);

    const impostor = crypto.generateKeyPairSync('ed25519');
    let handshake = await begin({ accept: false, localOverrides: { identityPrivateKey: impostor.privateKey } });
    refused('windows-rejects-unpinned-device-key', await control.request('accept', { hello: handshake.hello }), 'ONLINE_FRA_SIGNATURE_INVALID', false);
    handshake = await begin({ accept: false, localOverrides: { peerPublicKey: impostor.publicKey } });
    localRefusal('linux-rejects-unpinned-device-key', () => handshake.endpoint.acceptPeerHello(handshake.remoteHello), 'ONLINE_FRA_SIGNATURE_INVALID');

    handshake = await begin({ accept: false, localOverrides: { capabilityDigest: '0'.repeat(64) } });
    refused('windows-rejects-capability-binding-mismatch', await control.request('accept', { hello: handshake.hello }), 'ONLINE_FRA_PEER_MISMATCH', false);
    localRefusal('linux-rejects-capability-binding-mismatch', () => handshake.endpoint.acceptPeerHello(handshake.remoteHello), 'ONLINE_FRA_PEER_MISMATCH');

    session = await begin({ shortLease: true });
    frame = session.seal(marker);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, session.expiresAtMs - Date.now()) + 80));
    refused('windows-rejects-actually-expired-session', await control.request('frame', { frame }), 'ONLINE_FRA_SESSION_EXPIRED');
    localRefusal('linux-rejects-actually-expired-session', () => session.seal(marker), 'ONLINE_FRA_SESSION_EXPIRED', session);

    handshake = await begin({ accept: false });
    assert.ok((await control.request('break-audit')).ok, 'Remote audit descriptor must close for the refusal test');
    refused('windows-refuses-session-with-failed-audit-sink', await control.request('accept', { hello: handshake.hello }), 'ONLINE_FRA_EVENT_SINK_FAILED', false);
    local.breakAudit();
    localRefusal('linux-refuses-session-with-failed-audit-sink', () => handshake.endpoint.acceptPeerHello(handshake.remoteHello), 'ONLINE_FRA_EVENT_SINK_FAILED');

    const final = await control.request('finish');
    check('windows-terminal-cleanup-report', final.ok && final.result.allSessionsClosed && final.result.logDescriptorClosed);
    child.stdin.end();
    terminal = await control.completion;
    assert.ok(terminal.code === 0 && terminal.signal === null && terminal.stderr === '',
      'Peer terminal did not confirm clean completion: ' + JSON.stringify(terminal));
    checks.push('ssh-and-windows-child-exited-zero');
    localReport = local.finish();
    check('linux-terminal-cleanup-report', localReport.allSessionsClosed && localReport.logDescriptorClosed);
    for (const peer of [localReport, final.result]) {
      check(`${peer.platform}-metadata-records-created-sessions`, peer.eventKinds.online_fra_session_created >= 6);
      check(`${peer.platform}-metadata-records-frame-rejection`, peer.eventKinds.online_fra_frame_rejected >= 2);
      check(`${peer.platform}-metadata-records-handshake-rejection`, peer.eventKinds.online_fra_handshake_rejected >= 2);
      check(`${peer.platform}-metadata-records-real-expiry`, peer.eventKinds.online_fra_session_expired === 1);
    }
    const report = { ok: true, scope: `production-online-fra-session-over-${transport}; no enrollment or workspace admission`, accountCreated: false, enrollmentPerformed: false,
      workspaceCommandsAdmitted: false, completedAt: new Date().toISOString(), checks,
      local: localReport, remote: final.result, terminal: { code: terminal.code, signal: terminal.signal } };
    fs.writeFileSync(path.join(evidenceRoot, 'paired-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    fs.writeFileSync(path.join(evidenceRoot, 'incomplete.json'), JSON.stringify({
      complete: false, checks, terminal, code: error.code || 'PROBE_FAILED', message: error.message
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!control.closed) {
      try { await control.request('finish'); child.stdin.end(); } catch { child.kill(); }
      await control.completion;
    }
    if (!localReport) { try { local.finish(); } catch {} }
  }
}

function parseArgs(argv) {
  const names = new Map([['--host', 'host'], ['--user', 'user'], ['--identity', 'identity'], ['--known-hosts', 'knownHosts'],
    ['--windows-node', 'windowsNode'], ['--windows-engine', 'windowsEngine'], ['--windows-profile', 'windowsProfile'],
    ['--windows-temp', 'windowsTemp'], ['--local-scratch', 'localScratch']]);
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(names.has(argv[index]) && typeof argv[index + 1] === 'string', 'Every probe option requires an explicit value');
    const name = names.get(argv[index]);
    assert.ok(!Object.hasOwn(out, name), 'Repeated probe option'); out[name] = argv[index + 1];
  }
  for (const name of names.values()) assert.ok(out[name], `Missing required probe option: ${name}`);
  assert.ok(/^[A-Za-z0-9.-]+$/.test(out.host) && !out.host.startsWith('-'), 'Invalid pinned SSH host');
  assert.ok(/^[A-Za-z0-9._-]+$/.test(out.user), 'Invalid SSH user');
  for (const name of ['identity', 'knownHosts', 'localScratch']) assert.ok(path.isAbsolute(out[name]), `${name} must be absolute`);
  out.runId = 'fra-paired-machine-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  return out;
}

async function main() {
  if (process.argv[2] === '--peer-stdio') {
    return peerMain(JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8')));
  }
  const options = parseArgs(process.argv.slice(2));
  const report = await runPairedProbe({ localScratch: options.localScratch, launchPeer(peerOptions) {
    const { command, bootstrap } = buildWindowsCommand(options, { ...peerOptions, engineRoot: options.windowsEngine });
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
      '-o', 'UserKnownHostsFile=' + options.knownHosts, '-i', options.identity, '-l', options.user, options.host, command],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: safeLaunchEnvironment(process.env, { context: 'FRA paired-machine pinned SSH probe' }) });
    child.stdin.write(bootstrap);
    return child;
  } });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

module.exports = { buildWindowsCommand, createProbeState, runPairedProbe, parseArgs, assertDirectionalKeySeparation };
if (require.main === module) main().catch(error => {
  process.stderr.write(`FRA paired-machine probe failed: ${error.code || 'PROBE_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
