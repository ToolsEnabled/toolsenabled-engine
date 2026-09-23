'use strict';

// Exercise the whole driver with two real Node processes before using the
// separately invoked SSH mode. A local pass is explicitly not a Windows proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runPairedProbe, parseArgs, buildWindowsCommand, assertDirectionalKeySeparation } = require('../tools/fra-paired-machine-probe');

(async () => {
  const frame = bytes => ({ ciphertext: Buffer.from(bytes).toString('base64url') });
  assert.throws(() => assertDirectionalKeySeparation(frame([42]), frame([42])), /at least 32 ciphertext bytes/,
    'A one-byte collision cannot establish key separation or its failure');
  assert.throws(() => assertDirectionalKeySeparation(frame(Buffer.alloc(32, 42)), frame(Buffer.alloc(32, 42))), /Directions must use independent keys/,
    'A repeated full challenge must still fail the gate');
  assert.doesNotThrow(() => assertDirectionalKeySeparation(frame(Buffer.alloc(32, 42)), frame(Buffer.alloc(32, 43))));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-paired-driver-test-'));
  const peerRoot = fs.mkdtempSync(path.join(scratch, 'peer-'));
  const profileRoot = path.join(scratch, 'profile');
  const appData = path.join(profileRoot, 'AppData', 'Roaming');
  const localAppData = path.join(profileRoot, 'AppData', 'Local');
  for (const directory of [appData, localAppData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(peerRoot, 0o700);
  try {
    const result = await runPairedProbe({
      localScratch: scratch,
      expectedPeerPlatform: process.platform,
      transport: 'local-child-process',
      launchPeer(options) {
        const peerOptions = { ...options, engineRoot: path.resolve(__dirname, '..'), evidenceRoot: peerRoot };
        return spawn(process.execPath, [path.resolve(__dirname, '../tools/fra-paired-machine-probe.js'),
          '--peer-stdio', Buffer.from(JSON.stringify(peerOptions)).toString('base64')],
        { stdio: ['pipe', 'pipe', 'pipe'], cwd: peerRoot, windowsHide: true, env: {
          ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
          // This fixture may itself run under LIVE's bundled Electron in Node
          // mode. Select that same mode explicitly for its child, without
          // inheriting the caller's ambient environment or a display session.
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          PATH: path.dirname(process.execPath), TEMP: scratch, TMP: scratch, TMPDIR: scratch,
          HOME: profileRoot, USERPROFILE: profileRoot, APPDATA: appData, LOCALAPPDATA: localAppData
        } });
      }
    });
    assert.equal(result.ok, true);
    assert.match(result.scope, /local-child-process/);
    assert.equal(result.enrollmentPerformed, false);
    assert.equal(result.workspaceCommandsAdmitted, false);
    assert.equal(result.terminal.code, 0);
    assert.equal(result.remote.nodeVersion, process.version);
    assert.notEqual(result.local.pid, result.remote.pid);
    assert.equal(fs.existsSync(path.join(peerRoot, 'incomplete.json')), false);
    assert.equal(result.local.moduleSha256, result.remote.moduleSha256);
    for (const name of ['windows-rejects-unpinned-device-key', 'linux-rejects-unpinned-device-key',
      'windows-rejects-replayed-linux-frame', 'linux-rejects-replayed-windows-frame',
      'windows-refuses-session-with-failed-audit-sink', 'linux-refuses-session-with-failed-audit-sink',
      'sealed-roundtrip-194560-bytes', 'sealed-roundtrip-1-bytes', 'directions-use-independent-keys']) assert.ok(result.checks.includes(name), name);
    const saved = JSON.parse(fs.readFileSync(path.join(result.local.evidenceRoot, 'paired-result.json'), 'utf8'));
    assert.deepEqual(saved, result);

    const windowsOptions = {
      windowsProfile: 'C:\\Users\\ToolsEnabled-Dev',
      windowsTemp: 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp',
      windowsEngine: 'C:\\Users\\ToolsEnabled-Dev\\Desktop\\ToolsEnabled-1.0.41-WorkingFolder\\engine',
      windowsNode: 'C:\\agent-apps\\node-v22.19.0\\node.exe', runId: 'fra-test-command'
    };
    const { command, bootstrap } = buildWindowsCommand(windowsOptions, { role: 'B' });
    const script = Buffer.from(bootstrap.trim(), 'base64').toString('utf8');
    assert.ok(command.length < 8000, 'Windows OpenSSH must fit the cmd.exe bound');
    assert.ok(script.includes("'^C:\\\\Users\\\\[A-Za-z0-9._-]+$'"));
    assert.ok(script.includes('ReparsePoint'));
    assert.ok(script.includes('SSH account does not own the pinned profile'));
    assert.ok(script.includes('exit $LASTEXITCODE'));
    assert.throws(() => parseArgs([]), /Missing required probe option/);
    console.log(`fra-paired-machine-probe: ${result.checks.length} real two-process checks passed; SSH proof remains a separate run`);
  } finally {
    // Both roots were created by this test, and the peer has exited before
    // the driver resolves. No owner state or pre-existing files are removed.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
