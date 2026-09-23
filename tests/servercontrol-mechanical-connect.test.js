'use strict';

// Deterministic tests for packages/servercontrol/Mechanical-Connect.ps1, the
// one-toggle key rendezvous on the direct Ethernet link.
//
// NOTHING HERE TALKS TO THE PEER MACHINE.  On a pair that is already bridged a
// live rotation would replace a credential that is currently in use.
// Every cross-machine behaviour is proved one of three ways instead:
//
//   1. pure functions, dot-sourced with -LoadOnly (no I/O at all)
//   2. the connection handler driven over a MemoryStream (no socket at all)
//   3. one real exchange against a fake peer on 127.0.0.1, writing into a
//      throwaway vault via TOOLSENABLED_VAULT_PATH
//
// The real vault is never opened: every child that could write one is given a
// TOOLSENABLED_VAULT_PATH inside a temp directory this file created.
//
// The service registry is a fixture too. The engine takes every address it
// will ever accept from config/service-registry.json, so a suite that read the
// installed one would be asserting against whatever pair that machine happens
// to be half of -- and would fail outright on an install that has no registry
// yet. Instead this file writes its own two-machine registry into a temp root
// and points every child at it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'packages', 'servercontrol', 'Mechanical-Connect.ps1');
const PANEL = path.join(ROOT, 'packages', 'servercontrol', 'Server-Control-Panel.ps1');
const COMMON = path.join(ROOT, 'packages', 'servercontrol', 'ServerControl.Common.ps1');
const SECRETS = path.join(ROOT, 'tools', 'secrets.ps1');
const POWERSHELL = path.join(
  process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);
const VAULT_KEY = 'custom.full_remote_access_token';

const engineText = fs.readFileSync(ENGINE, 'utf8');
const engineLines = engineText.split(/\r?\n/);
const panelText = fs.readFileSync(PANEL, 'utf8');

/*
EXECUTABLE CHANGE
Strengthened assertion: the Remove-Item scan must contain exactly the one
state-temp cleanup before checking its target. Mutation: removed the product's
only Remove-Item line. Before strengthening the suspect check stayed green:
"ok  the vault is written only through secrets.ps1 set-stdin, and never cleared".
After strengthening it went red:
"FAIL  the vault is written only through secrets.ps1 set-stdin, and never cleared
engine must retain its one state-temp cleanup and no other deletion
0 !== 1".
The product file was restored byte-for-byte (SHA-256
734ea0befe4c9170e13bcd33ca5e1b1c81f5dbd05204b8d606197155d505f29e),
and the restored targeted check was green:
"ok  the vault is written only through secrets.ps1 set-stdin, and never cleared".
NOT-FOUND: output-free exit-status/truthy-return assertions; swallowed failures;
assertions against mocks of their own subject; file-wide skips/precondition
guards; expected values computed by the same product code. Other loops either
use nonempty literals or have an explicit nonempty/cardinality assertion.
UNMET PRECONDITION: this Linux host has no Windows PowerShell executable at
C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe, so the complete
restored suite cannot be green here; it ends with spawn ENOENT.
*/

// A comment may legitimately name a banned construct in order to explain why it
// is banned, so bans are asserted against the executable text only. This is
// safe here because no string literal in the engine contains '#'.
const engineCodeLines = engineLines
  .filter(line => !/^\s*#/.test(line))
  .map(line => line.replace(/\s+#.*$/, ''));
const engineCode = engineCodeLines.join('\n');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error && error.message}\n`);
  }
}

function slice(from, to) {
  const start = engineText.indexOf(from);
  const end = engineText.indexOf(to);
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`);
  return engineText.slice(start, end);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mechconnect-'));
const harnessDir = path.join(scratch, 'harness');
fs.mkdirSync(harnessDir, { recursive: true });

function makeRegistryRoot(name, registryText) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test root\n', 'ascii');
  // The engine resolves every helper it shells out to from the root it was
  // pointed at, so a fixture root has to carry the same few files a real
  // checkout does: the registry reader, and the vault CLI the credential
  // commit runs through, with the two scripts that one dot-sources.
  for (const relative of [
    ['tools', 'lib', 'service-registry.ps1'],
    ['tools', 'lib', 'vault-acl.ps1'],
    ['tools', 'owner-prompt-theme.ps1'],
    ['tools', 'secrets.ps1']
  ]) {
    fs.copyFileSync(path.join(ROOT, ...relative), path.join(root, ...relative));
  }
  if (registryText !== null) {
    fs.writeFileSync(path.join(root, 'config', 'service-registry.json'), registryText, 'utf8');
  }
  return root;
}

// The pair every harness below runs against. TEST-NET-1 (RFC 5737) is reserved
// for documentation and is routable nowhere, so a fixture address that escaped
// into a real request could not reach a machine even in principle. Which of
// the two mints is not a fixture choice: the engine gives that role to the
// numerically lower address, and the assertions below depend on it.
const MINTER_IP = '192.0.2.1';
const RECEIVER_IP = '192.0.2.2';
const fixtureRegistry = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: RECEIVER_IP, role: 'peer' },
    'machine-b': { address: MINTER_IP, role: 'peer' }
  },
  services: {
    'remote-agent-bridge': { resolution: 'self', port: 8788 },
    'shared-agent-bus': { resolution: 'fixed', fixedMachine: 'machine-b', port: 8787 }
  }
};
const fixtureRoot = makeRegistryRoot('fixture-registry', JSON.stringify(fixtureRegistry));

// A second registry on an ordinary routed LAN, to prove the packaged engine
// carries no attachment to the addresses the fixture above happens to use.
const lanRegistry = JSON.parse(JSON.stringify(fixtureRegistry));
lanRegistry.machines['machine-a'].address = '10.0.0.5';
lanRegistry.machines['machine-b'].address = '10.0.0.6';
const lanRegistryRoot = makeRegistryRoot('lan-registry', JSON.stringify(lanRegistry));

function harness(name, body) {
  const file = path.join(harnessDir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runPowerShell(file, args, extraEnv) {
  const result = spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...(args || [])
  ], {
    cwd: ROOT,
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TOOLSENABLED_ROOT: fixtureRoot }, extraEnv || {}),
    timeout: 180000
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runJson(file, args, extraEnv) {
  const result = runPowerShell(file, args, extraEnv);
  if (result.code !== 0) {
    throw new Error(`harness ${path.basename(file)} exited ${result.code}: ${result.stderr.trim()}`);
  }
  const text = result.stdout.trim();
  try {
    return { value: JSON.parse(text), raw: result };
  } catch (error) {
    throw new Error(`harness ${path.basename(file)} did not emit JSON: ${text.slice(0, 400)}`);
  }
}

// The fake peer below lives in THIS process, so any harness that has to talk to
// it must be spawned asynchronously: spawnSync would block the event loop and
// the peer could never answer, which looks exactly like a hung handshake.
function runPowerShellAsync(file, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...(args || [])
    ], {
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      env: Object.assign({}, process.env, { TOOLSENABLED_ROOT: fixtureRoot }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (error) { /* already gone */ }
      reject(new Error(`harness ${path.basename(file)} did not finish within 180s`));
    }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runJsonAsync(file, args, extraEnv) {
  const result = await runPowerShellAsync(file, args, extraEnv);
  if (result.code !== 0) {
    throw new Error(`harness ${path.basename(file)} exited ${result.code}: ${result.stderr.trim()}`);
  }
  const text = result.stdout.trim();
  try {
    return { value: JSON.parse(text), raw: result };
  } catch (error) {
    throw new Error(`harness ${path.basename(file)} did not emit JSON: ${text.slice(0, 400)}`);
  }
}

function walkFiles(directory, found) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

process.stdout.write('servercontrol-mechanical-connect\n');

// ---------------------------------------------------------------------------
// 1. Both touched PowerShell files parse.
// ---------------------------------------------------------------------------
const parseHarness = harness('parse.ps1', `
param([string]$EnginePath,[string]$PanelPath,[string]$CommonPath)
$results = foreach($target in @($EnginePath,$PanelPath,$CommonPath)){
  $parseErrors = $null; $parseTokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($target,[ref]$parseTokens,[ref]$parseErrors)
  [pscustomobject][ordered]@{
    path = $target
    errorCount = @($parseErrors).Count
    messages = @(@($parseErrors) | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })
  }
}
ConvertTo-Json -Compress -Depth 5 -InputObject @($results)
`);

check('every touched .ps1 parses with zero parser errors', () => {
  const { value } = runJson(parseHarness, [ENGINE, PANEL, COMMON]);
  assert.equal(value.length, 3);
  for (const entry of value) {
    assert.equal(entry.errorCount, 0, `${entry.path}: ${JSON.stringify(entry.messages)}`);
  }
});

const identityRootHarness = harness('root-identity.ps1', `
param([string]$CommonPath,[string]$Actual,[string]$Alias)
. $CommonPath
$direct=Resolve-ServerControlCanonicalIdentityRoot -Path $Actual
$refusal=$null
try { [void](Resolve-ServerControlCanonicalIdentityRoot -Path $Alias); $refusal='RETURNED' }
catch { $refusal=$_.Exception.Message }
[pscustomobject][ordered]@{ direct=$direct; refusal=$refusal } | ConvertTo-Json -Compress
`);

check('one physical root cannot select another machine identity through a junction alias', () => {
  const actual = path.join(scratch, 'servercontrol-identity-root');
  const alias = path.join(scratch, 'servercontrol-identity-alias');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, 'junction');
  const { value } = runJson(identityRootHarness, [COMMON, actual, alias]);
  assert.equal(path.resolve(value.direct).toLowerCase(), path.resolve(actual).toLowerCase());
  assert.equal(value.refusal, 'SERVICE_LOCAL_MACHINE_UNKNOWN');
  assert.deepEqual(fs.readdirSync(actual), []);
});

// ---------------------------------------------------------------------------
// 2. Static invariants over the engine source.
// ---------------------------------------------------------------------------
check('the rendezvous port is 8795 and no live or one-shot port is reused', () => {
  assert.match(engineText, /\$script:RendezvousPort\s*=\s*8795\b/);
  for (const port of ['8787', '8790', '8791', '8792', '8793', '8794']) {
    assert.ok(!engineText.includes(port), `engine must not mention reserved port ${port}`);
  }
  // 8788 is legitimate: it is the bridge listener the engine restarts.
  assert.match(engineText, /\$script:BridgePort\s*=\s*8788\b/);
});

check('the listener binds one parsed address, never a wildcard', () => {
  assert.match(engineText, /New-Object System\.Net\.Sockets\.TcpListener \(\[System\.Net\.IPAddress\]::Parse\(\$localIp\)\),\$script:RendezvousPort/);
  assert.ok(!/IPAddress\]::Any/.test(engineText), 'must never bind IPAddress::Any');
  assert.ok(!/TcpListener\s*\(\s*\$script:RendezvousPort/.test(engineText), 'must never use the port-only TcpListener ctor');
  // The only executable 0.0.0.0 is read-only inspection of the OS listener table.
  const wildcardLines = engineCodeLines.filter(line => line.includes('0.0.0.0'));
  assert.equal(wildcardLines.length, 1);
  assert.match(wildcardLines[0], /\$text -eq '0\.0\.0\.0'/);
});

check('peer acceptance is an exact single address, never a range', () => {
  assert.match(engineText, /function Test-RendezvousPeerAddress/);
  assert.match(engineText, /Read-ToolsEnabledServiceRegistry -Root \$script:RepoRoot/);
  assert.match(engineText, /\$script:MachineAddressPolicy\.addresses -cnotcontains \$PeerIp/);
  assert.match(engineText, /return \(\$Address -ceq \$PeerIp\)/);
  assert.ok(!/-like/.test(engineText), 'no wildcard matching anywhere in the engine');
});

check('the token is a canonical 32-byte CSPRNG value, and never Get-Random', () => {
  assert.match(engineText, /\$script:TokenBytes\s*=\s*32\b/);
  assert.match(engineText, /\$script:TokenLength\s*=\s*43\b/);
  assert.match(engineText, /\[System\.Security\.Cryptography\.RandomNumberGenerator\]::Create\(\)/);
  assert.ok(!/Get-Random/.test(engineCode), 'Get-Random must never mint a credential');
  assert.match(engineText, /\$rng\.GetBytes\(\$buffer\)/, 'the CSPRNG must fill all 32 token bytes');
});

check('acceptance is exact canonical 32-byte base64url, never the legacy 30-byte shape', () => {
  assert.match(engineText, /\^\[A-Za-z0-9_-\]\{' \+ \$script:TokenLength \+ '\}/,
    'Test-RendezvousToken must accept the spec alphabet, including - and _');
  const accepts = token => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const bytes = Buffer.from(token, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === token;
  };
  const withUrlAlphabet = Buffer.alloc(32, 0xfb).toString('base64url');
  assert.equal(accepts(Buffer.alloc(32).toString('base64url')), true, 'canonical 32-byte token');
  assert.equal(accepts(withUrlAlphabet), true, 'canonical token using - and _');
  assert.equal(accepts(Buffer.alloc(30).toString('base64url')), false, 'legacy 30-byte token must be refused');
  assert.equal(accepts('A'.repeat(42)), false, '42 characters must be refused');
  assert.equal(accepts('A'.repeat(44)), false, '44 characters must be refused');
  assert.equal(accepts(`${'A'.repeat(42)}+`), false, "'+' is base64, not base64url, and must be refused");
  assert.equal(accepts(`${'A'.repeat(42)}B`), false, 'a non-canonical final sextet must be refused');
});

check('the vault is written only through secrets.ps1 set-stdin, and never cleared', () => {
  assert.match(engineText, /'set-stdin',\$script:VaultKey/);
  // The key is the FRA credential, fixed by the canonical spec. It is asserted
  // here because getting it wrong is silent: the exchange succeeds, both sides
  // report a converged generation, and every 8790 handshake still fails on the
  // credential proof because the FRA listener reads a key nobody wrote. That
  // is not hypothetical - this engine shipped pointing at the 8788 bridge key
  // and reached generation 8 while FRA never connected once.
  assert.match(engineText, /\$script:VaultKey\s*=\s*'custom\.full_remote_access_token'/);
  assert.ok(!/'custom\.remote_agent_bridge_token'/.test(engineText),
    'the bridge key has its own enrollment path and must not be what this engine converges');
  for (const action of ["'del'", "'set'", "'set-pair-stdin'", "'prompt-set'", "'get'"]) {
    assert.ok(!engineText.includes(action), `engine must not use the ${action} vault action`);
  }
  // The engine may delete exactly one thing: its own state temp file, when the
  // atomic replace could not be completed. Nothing else, ever.
  const removalLines = engineCodeLines.filter(text => /Remove-Item/i.test(text));
  assert.equal(removalLines.length, 1, 'engine must retain its one state-temp cleanup and no other deletion');
  for (const line of removalLines) {
    assert.match(line, /\$temporary/, `engine deletes something other than its own state temp file: ${line.trim()}`);
  }

  // The credential crosses stdin as RAW ASCII BYTES, not through the
  // TextWriter. The writer carries the ambient Console.InputEncoding, and a
  // host or locale that makes that UTF-8-with-BOM would prepend a preamble to
  // the stored value on one machine and not the other: both sides report
  // success, and every later bridge handshake fails with nothing but
  // "authorization failed" in a log.
  assert.match(engineText, /\$process\.StandardInput\.BaseStream\.Write\(\$tokenBytes,0,\$tokenBytes\.Length\)/);
  assert.match(engineText, /\$tokenBytes = \[System\.Text\.Encoding\]::ASCII\.GetBytes\(\$Token\)/);
  assert.ok(!/StandardInput\.Write\(\$Token\)/.test(engineText), 'the encoding-carrying TextWriter must not be used for the credential');
  assert.ok(!/StandardInput\.WriteLine/.test(engineText), 'WriteLine would append a newline to the credential');
});

check('no code path puts the token in argv, a log, or stdout', () => {
  const tokenLines = engineLines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(entry => /\$[Tt]oken\b/.test(entry.text));
  assert.ok(tokenLines.length > 0);

  const emitters = /(Write-Host|Write-Output|Write-Verbose|Write-Debug|Write-Warning|Write-Information|Write-Error|Out-File|Out-Host|Add-Content|Set-Content|Tee-Object|Export-Csv|\[Console\]::)/;
  const argv = /(Arguments|ArgumentList)\s*[=+]|-ArgumentList/;
  for (const entry of tokenLines) {
    assert.ok(!emitters.test(entry.text), `token reaches an output cmdlet at line ${entry.line}: ${entry.text.trim()}`);
    assert.ok(!argv.test(entry.text), `token reaches a child argument list at line ${entry.line}: ${entry.text.trim()}`);
  }

  // Exactly one place serialises the token, and it is the request body.
  const serialised = tokenLines.filter(entry => /ConvertTo-Json/.test(entry.text));
  assert.equal(serialised.length, 1);
  assert.match(serialised[0].text, /\$payload = \(\[ordered\]@\{ token = \$token; generation/);

  // The persisted state document has no field that could hold a credential.
  const stateBlock = slice('function New-RendezvousState', 'function Read-RendezvousState');
  assert.ok(!/token|secret|credential/i.test(stateBlock), 'the state file schema must have no secret-shaped field');

  // The vault child's stdout/stderr are drained and discarded, never logged.
  assert.match(engineText, /\[void\]\$outTask\.GetAwaiter\(\)\.GetResult\(\)/);
  assert.match(engineText, /\[void\]\$errTask\.GetAwaiter\(\)\.GetResult\(\)/);
});

check('every cross-machine deadline is sized for this link, not for loopback', () => {
  const read = name => {
    const match = engineText.match(new RegExp(`\\$script:${name}\\s*=\\s*(\\d+)`));
    assert.ok(match, `missing ${name}`);
    return Number(match[1]);
  };
  const probe = read('PeerProbeTimeoutMs');
  const exchange = read('PeerExchangeTimeoutMs');
  const connection = read('ConnectionTimeoutMs');
  const vault = read('VaultWriteTimeoutMs');
  for (const pair of [['probe', probe], ['exchange', exchange], ['connection', connection]]) {
    assert.ok(pair[1] >= 90000, `${pair[0]} deadline ${pair[1]}ms is localhost-sized; measured peer latency on a real direct link is 15-75s`);
  }
  // ADDITIVE, not merely ordered. `exchange > probe` is the wrong inequality
  // and certified a real split: a peer that is a full probe deep only begins
  // serving our exchange when its probe expires, and may then spend a whole
  // vault-write budget on the DPAPI commit before it can answer ok:true. If
  // our deadline expires first the peer commits and rotates its bridge while
  // we report peer-unreachable and do not.
  assert.ok(
    exchange >= probe + vault,
    `the exchange budget (${exchange}ms) must cover a full peer probe plus a full peer vault write (${probe + vault}ms)`
  );
  assert.ok(exchange - (probe + vault) >= 20000, 'leave real margin above the additive floor, not a rounding error');
  assert.match(engineText, /15-75 SECONDS/, 'the measured-latency reasoning must stay in the file');
});

check('no wait can starve the accept path, and none of them is unbounded', () => {
  // The livelock this prevents: both loops probe at the same instant, each
  // blocks without accepting, both time out together, and with no jitter they
  // stay phase-locked and never connect again.
  const client = slice('function Invoke-RendezvousHttpRequest', 'function Get-RendezvousPeerState');
  assert.match(client, /\[scriptblock\]\$Pump/, 'the client must be able to serve the peer while it waits');
  assert.match(client, /Stopwatch\]::StartNew\(\)/, 'the whole request needs one absolute deadline');
  assert.match(client, /if\(\$Pump\)\{ try \{ \[void\]\(& \$Pump\) \} catch \{\} \}/);
  assert.match(client, /BeginRead/, 'a blocking Read cannot be interrupted to serve the peer');
  assert.ok(!/\$stream\.Read\(\$chunk/.test(client), 'the synchronous blocking read must be gone');

  // Both cross-machine calls actually pass a pump from the loop.
  const loop = slice('function Start-RendezvousLoop', 'function Save-RendezvousLoopState');
  assert.match(loop, /\$pump = \{[\s\S]*Invoke-RendezvousPendingConnections \$listener \$state[\s\S]*\}\.GetNewClosure\(\)/);
  assert.match(loop, /Get-RendezvousPeerState -Address \$state\.peerIp -Pump \$pump/);
  assert.match(loop, /Invoke-RendezvousExchange .*-Pump \$pump/);
  // A key accepted DURING a pumped wait still has to restart the bridge, or
  // the pair reports connected while the bridge runs on the previous key.
  assert.match(loop, /if\(\$pumpResult\.Committed\)\{ \$restartBridge = \$true \}/);
  assert.match(engineText, /\$script:PollJitterFraction\s*=\s*0\.4/);
  assert.match(loop, /\$script:PollJitterFraction \* \(\(2\.0 \* \$random\.NextDouble\(\)\) - 1\.0\)/);
});

check('every child process is launched hidden (R193)', () => {
  const starts = engineText.match(/New-Object System\.Diagnostics\.ProcessStartInfo/g) || [];
  assert.ok(starts.length >= 2);
  assert.equal((engineText.match(/\$psi\.CreateNoWindow = \$true/g) || []).length, starts.length);
  assert.equal((engineText.match(/\$psi\.UseShellExecute = \$false/g) || []).length, starts.length);
  assert.equal((engineText.match(/\$psi\.WindowStyle = \[System\.Diagnostics\.ProcessWindowStyle\]::Hidden/g) || []).length, starts.length);
  assert.ok(!/Start-Process/.test(engineText), 'Start-Process can still flash a console host');

  // The long-lived -Serve loop is spawned here, and an unredirected child
  // inherits its parent's stdout handle for its whole life - so anything that
  // waits for -Enable to return waits for the serve loop instead. Redirected
  // and drained into the bit bucket, never into a file: nothing it prints is
  // worth making the owner read a log for, and faults go to the state doc.
  const launcher = slice('function Start-RendezvousHiddenProcess', 'function Test-RendezvousLoopAlive');
  assert.match(launcher, /\$psi\.RedirectStandardOutput = \$true/);
  assert.match(launcher, /\$psi\.RedirectStandardError = \$true/);
  assert.match(launcher, /StandardOutput\.BaseStream\.CopyToAsync\(\[System\.IO\.Stream\]::Null\)/);
  assert.match(launcher, /StandardError\.BaseStream\.CopyToAsync\(\[System\.IO\.Stream\]::Null\)/);
  const launchLines = engineLines.filter(line => line.includes('-NoProfile'));
  assert.ok(launchLines.length >= 3);
  for (const line of launchLines) {
    assert.ok(line.includes('Hidden'), `launch without a hidden window: ${line.trim()}`);
  }
});

check('turning the toggle off never touches the credential', () => {
  const body = slice('function Disable-Rendezvous', 'if($LoadOnly){ return }');
  assert.ok(body.length > 200);
  for (const forbidden of ['Save-RendezvousCredential', 'secrets.ps1', 'Stop-RendezvousBridgeProcess', 'New-RendezvousToken']) {
    assert.ok(!body.includes(forbidden), `Disable must not reference ${forbidden}`);
  }
  assert.match(body, /\$current\.armed = \$false/);
  assert.ok(!/generation\s*=\s*0/.test(body), 'Disable must keep the generation so re-arming does not re-mint');
});

check('commit ordering is enforced by construction in the minter path', () => {
  const body = slice('function Invoke-RendezvousExchange', 'function Test-RendezvousLocalListener');
  const push = body.indexOf("-Path '/v1/rendezvous/exchange'");
  const proof = body.indexOf('$result.Pushed = $true');
  const commit = body.indexOf('$stored = [bool](& $Commit $token)');
  assert.ok(push > 0 && proof > 0 && commit > 0, 'the three ordered steps must all be present');
  assert.ok(push < proof, 'ok:true can only be proved after the peer was asked');
  assert.ok(proof < commit, 'the local vault write must come after ok:true');
  // There is no other call site that could write first.
  assert.equal((engineText.match(/& \$Commit \$token/g) || []).length, 2, 'exactly one committer call per side');
});

// ---------------------------------------------------------------------------
// 3. Pure functions: identity, roles, token shape, exact-peer matching.
// ---------------------------------------------------------------------------
const pureHarness = harness('pure.ps1', `
param([string]$Engine)
. $Engine -LoadOnly
$tokens = @(1..8 | ForEach-Object { New-RendezvousToken })
[pscustomobject][ordered]@{
  roleLower      = (Get-RendezvousRole '192.0.2.1')
  roleHigher     = (Get-RendezvousRole '192.0.2.2')
  roleForeign    = (Get-RendezvousRole '10.0.0.5')
  roleEmpty      = (Get-RendezvousRole '')
  peerOfLower    = (Get-RendezvousPeer '192.0.2.1')
  peerOfHigher   = (Get-RendezvousPeer '192.0.2.2')
  peerOfForeign  = (Get-RendezvousPeer '192.0.2.3')
  tokenLengths   = @($tokens | ForEach-Object { $_.Length })
  tokensValid    = @($tokens | ForEach-Object { Test-RendezvousToken $_ })
  tokensDistinct = (@($tokens | Select-Object -Unique).Count)
  tokenAlphabet  = [bool](@($tokens | Where-Object { $_ -cmatch '^[A-Za-z0-9_-]+\\z' }).Count -eq $tokens.Count)
  rejectShort    = (Test-RendezvousToken ('a' * 42))
  rejectLong     = (Test-RendezvousToken ('a' * 44))
  rejectSymbol   = (Test-RendezvousToken (('a' * 42) + '!'))
  rejectNewline  = (Test-RendezvousToken ($tokens[0] + "\`n"))
  rejectLegacy   = (Test-RendezvousToken ('a' * 40))
  rejectNoncanonical = (Test-RendezvousToken (('A' * 42) + 'B'))
  rejectNull     = (Test-RendezvousToken $null)
  acceptExact    = (Test-RendezvousPeerAddress -Address '192.0.2.2' -PeerIp '192.0.2.2')
  rejectSelf     = (Test-RendezvousPeerAddress -Address '192.0.2.1' -PeerIp '192.0.2.2')
  rejectPrefix   = (Test-RendezvousPeerAddress -Address '192.0.2.20' -PeerIp '192.0.2.2')
  rejectOther    = (Test-RendezvousPeerAddress -Address '192.0.2.3' -PeerIp '192.0.2.2')
  rejectOffLink  = (Test-RendezvousPeerAddress -Address '10.0.0.5' -PeerIp '192.0.2.2')
  rejectPadded   = (Test-RendezvousPeerAddress -Address ' 192.0.2.2' -PeerIp '192.0.2.2')
  rejectEmpty    = (Test-RendezvousPeerAddress -Address '' -PeerIp '192.0.2.2')
  rejectBadPeer  = (Test-RendezvousPeerAddress -Address '192.0.2.7' -PeerIp '192.0.2.7')
} | ConvertTo-Json -Compress -Depth 4
`);

let pure = null;
check('role assignment is deterministic from the local IP on both machines', () => {
  pure = runJson(pureHarness, [ENGINE]).value;
  assert.equal(pure.roleLower, 'minter', 'the lower fixture address (machine-b) mints');
  assert.equal(pure.roleHigher, 'receiver', 'the higher fixture address (machine-a) receives');
  assert.equal(pure.roleForeign, null);
  assert.equal(pure.roleEmpty, null);
  assert.equal(pure.peerOfLower, RECEIVER_IP);
  assert.equal(pure.peerOfHigher, MINTER_IP);
  assert.equal(pure.peerOfForeign, null);
});

check('the minted token is canonical base64url for exactly 32 CSPRNG bytes', () => {
  assert.deepEqual(pure.tokenLengths, [43, 43, 43, 43, 43, 43, 43, 43]);
  assert.deepEqual(pure.tokensValid, [true, true, true, true, true, true, true, true]);
  assert.equal(pure.tokensDistinct, 8, 'eight draws must not collide');
  assert.equal(pure.tokenAlphabet, true);
  assert.equal(pure.rejectShort, false);
  assert.equal(pure.rejectLong, false);
  assert.equal(pure.rejectSymbol, false);
  assert.equal(pure.rejectNewline, false, 'a trailing newline must not pass validation');
  assert.equal(pure.rejectLegacy, false, 'the legacy 30-byte shape is read/verify-only');
  assert.equal(pure.rejectNoncanonical, false, 'a non-canonical final sextet must not pass');
  assert.equal(pure.rejectNull, false);
});

check('a foreign address is rejected; only the exact peer is accepted', () => {
  assert.equal(pure.acceptExact, true);
  assert.equal(pure.rejectSelf, false);
  assert.equal(pure.rejectPrefix, false, '192.0.2.20 must not match 192.0.2.2');
  assert.equal(pure.rejectOther, false);
  assert.equal(pure.rejectOffLink, false);
  assert.equal(pure.rejectPadded, false);
  assert.equal(pure.rejectEmpty, false);
  assert.equal(pure.rejectBadPeer, false, 'an address outside the link pair is never a valid peer');
});

const lanPolicyHarness = harness('lan-policy.ps1', `
param([string]$Engine)
. $Engine -LoadOnly
[pscustomobject][ordered]@{
  peer = (Get-RendezvousPeer '10.0.0.5')
  role = (Get-RendezvousRole '10.0.0.5')
  accepted = (Test-RendezvousPeerAddress -Address '10.0.0.6' -PeerIp '10.0.0.6')
  foreign = (Test-RendezvousPeerAddress -Address '10.0.0.7' -PeerIp '10.0.0.7')
  oldPair = (Test-RendezvousPeerAddress -Address '192.0.2.2' -PeerIp '192.0.2.2')
} | ConvertTo-Json -Compress
`);

check('the packaged rendezvous accepts an ordinary-LAN registry and nothing outside it', () => {
  const { value } = runJson(lanPolicyHarness, [ENGINE], { TOOLSENABLED_ROOT: lanRegistryRoot });
  assert.equal(value.peer, '10.0.0.6');
  assert.equal(value.role, 'minter');
  assert.equal(value.accepted, true);
  assert.equal(value.foreign, false);
  assert.equal(value.oldPair, false, 'the former direct-link pair has no implicit fallback');
});

check('the packaged rendezvous names and refuses every bad-registry class', () => {
  const emptyRegistry = JSON.parse(JSON.stringify(lanRegistry));
  emptyRegistry.machines = {};
  for (const [name, text, code] of [
    ['missing-registry', null, 'SERVICE_REGISTRY_UNAVAILABLE'],
    ['malformed-registry', '{bad', 'SERVICE_REGISTRY_INVALID'],
    ['empty-registry', JSON.stringify(emptyRegistry), 'SERVICE_REGISTRY_EMPTY']
  ]) {
    const root = makeRegistryRoot(name, text);
    const result = runPowerShell(ENGINE, ['-LoadOnly'], { TOOLSENABLED_ROOT: root });
    assert.notEqual(result.code, 0, `${name} must refuse`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(code), `${name} must name ${code}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The generation counter: idempotency and who mints.
// ---------------------------------------------------------------------------
const planHarness = harness('plan.ps1', `
param([string]$Engine,[string]$CasesPath)
. $Engine -LoadOnly
$cases = Get-Content -Raw -LiteralPath $CasesPath | ConvertFrom-Json
$results = foreach($case in $cases){
  $plan = Get-RendezvousPlan -LocalIp $case.localIp -LocalGeneration ([int]$case.localGeneration) -PeerReachable ([bool]$case.peerReachable) -PeerArmed ([bool]$case.peerArmed) -PeerGeneration ([int]$case.peerGeneration)
  [pscustomobject][ordered]@{
    id = [string]$case.id
    action = [string]$plan.Action
    role = [string]$plan.Role
    next = [int]$plan.NextGeneration
    connected = [bool]$plan.Connected
    status = [string]$plan.Status
  }
}
ConvertTo-Json -Compress -Depth 5 -InputObject @($results)
`);

const planCases = [
  { id: 'no-link', localIp: '10.0.0.5', localGeneration: 0, peerReachable: true, peerArmed: true, peerGeneration: 0 },
  { id: 'peer-silent', localIp: MINTER_IP, localGeneration: 3, peerReachable: false, peerArmed: false, peerGeneration: 0 },
  { id: 'peer-off', localIp: MINTER_IP, localGeneration: 3, peerReachable: true, peerArmed: false, peerGeneration: 3 },
  { id: 'fresh-pair', localIp: MINTER_IP, localGeneration: 0, peerReachable: true, peerArmed: true, peerGeneration: 0 },
  { id: 'already-agreed', localIp: MINTER_IP, localGeneration: 5, peerReachable: true, peerArmed: true, peerGeneration: 5 },
  { id: 'peer-was-reset', localIp: MINTER_IP, localGeneration: 5, peerReachable: true, peerArmed: true, peerGeneration: 0 },
  { id: 'peer-ahead', localIp: MINTER_IP, localGeneration: 2, peerReachable: true, peerArmed: true, peerGeneration: 7 },
  { id: 'receiver-agreed', localIp: RECEIVER_IP, localGeneration: 5, peerReachable: true, peerArmed: true, peerGeneration: 5 },
  { id: 'receiver-behind', localIp: RECEIVER_IP, localGeneration: 0, peerReachable: true, peerArmed: true, peerGeneration: 3 },
  { id: 'receiver-ahead', localIp: RECEIVER_IP, localGeneration: 9, peerReachable: true, peerArmed: true, peerGeneration: 4 },
  { id: 'receiver-peer-off', localIp: RECEIVER_IP, localGeneration: 4, peerReachable: true, peerArmed: false, peerGeneration: 4 }
];
const planCasesPath = path.join(scratch, 'plan-cases.json');
fs.writeFileSync(planCasesPath, JSON.stringify(planCases), 'utf8');

let plans = null;
check('the generation counter stops a connected pair from re-minting', () => {
  const rows = runJson(planHarness, [ENGINE, planCasesPath]).value;
  plans = Object.fromEntries(rows.map(entry => [entry.id, entry]));

  assert.equal(plans['already-agreed'].action, 'idle', 'matching generations must not mint');
  assert.equal(plans['already-agreed'].connected, true);
  assert.equal(plans['already-agreed'].next, 5, 'an idle poll leaves the generation alone');
  assert.equal(plans['receiver-agreed'].action, 'idle');
  assert.equal(plans['receiver-agreed'].connected, true);

  assert.equal(plans['fresh-pair'].action, 'mint');
  assert.equal(plans['fresh-pair'].next, 1, 'a never-connected pair mints generation 1');
  assert.equal(plans['peer-was-reset'].action, 'mint');
  assert.equal(plans['peer-was-reset'].next, 6, 'the next generation is strictly above both sides');
  assert.equal(plans['peer-ahead'].action, 'mint');
  assert.equal(plans['peer-ahead'].next, 8);
});

check('an unarmed or unreachable peer leaves everything alone', () => {
  for (const id of ['peer-silent', 'peer-off', 'receiver-peer-off']) {
    assert.equal(plans[id].action, 'wait-peer', `${id} must wait, not act`);
    assert.equal(plans[id].connected, false);
    assert.equal(plans[id].status, 'waiting-for-peer');
  }
  assert.equal(plans['peer-off'].next, 3, 'waiting must never move the generation');
  assert.equal(plans['no-link'].action, 'wait-link');
  assert.equal(plans['no-link'].status, 'no-link');
});

check('only the numerically lower address ever mints', () => {
  for (const entry of Object.values(plans)) {
    if (entry.action === 'mint') {
      assert.equal(entry.role, 'minter', `${entry.id} minted without the minter role`);
    }
    if (entry.role === 'receiver') {
      assert.notEqual(entry.action, 'mint', `${entry.id}: the receiver must never mint`);
    }
  }
  assert.equal(plans['receiver-behind'].action, 'await-mint');
  assert.equal(plans['receiver-ahead'].action, 'await-mint', 'a receiver ahead of the minter still waits');
});

// ---------------------------------------------------------------------------
// 4b. The persisted switch: it survives a restart, and the owner owns `armed`.
// ---------------------------------------------------------------------------
const stateHarness = harness('state.ps1', `
param([string]$Engine,[string]$StateFile,[string]$PartialFile)
. $Engine -LoadOnly
$script:StatePath = $StateFile
# An SSH environment is not the owner of a kernel object. These names must
# not affect the real mutex ACL or the persisted switch update below.
$env:USERDOMAIN = 'WORKGROUP'
$env:USERNAME = 'synthetic-missing-rendezvous-account'
$tokenSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$objectSid = (New-RendezvousObjectIdentity).Value

$missing = Read-RendezvousState
[void](Invoke-RendezvousStateUpdate { param($current) $current.armed = $true; $current.status = 'waiting-for-peer'; return $current })

$loopState = New-RendezvousState
$loopState.armed = $true
$loopState.generation = 7
$loopState.connected = $true
$loopState.role = 'minter'
$loopState.localIp = '192.0.2.1'
$loopState.peerIp = '192.0.2.2'
$loopState.status = 'connected'
$loopState.detail = 'keys exchanged'
$loopState.loopPid = 4242
Save-RendezvousLoopState $loopState
$afterLoop = Read-RendezvousState

# The owner switches off while the loop still holds a stale in-memory copy that
# believes it is armed and connected. The persisted switch must win.
[void](Invoke-RendezvousStateUpdate { param($current) $current.armed = $false; $current.connected = $false; $current.status = 'off'; $current.detail = ''; return $current })
Save-RendezvousLoopState $loopState
$afterDisable = Read-RendezvousState
$persistedText = Get-Content -Raw -LiteralPath $StateFile

$script:StatePath = $PartialFile
Set-Content -LiteralPath $PartialFile -Value '{"armed":true,"generation":2}' -Encoding UTF8
$upgraded = Read-RendezvousState

[pscustomobject][ordered]@{
  tokenSid          = $tokenSid
  objectSid         = $objectSid
  missingArmed       = [bool]$missing.armed
  missingGeneration  = [int]$missing.generation
  loopArmed          = [bool]$afterLoop.armed
  loopGeneration     = [int]$afterLoop.generation
  loopConnected      = [bool]$afterLoop.connected
  loopRole           = [string]$afterLoop.role
  loopStatus         = [string]$afterLoop.status
  disabledArmed      = [bool]$afterDisable.armed
  disabledConnected  = [bool]$afterDisable.connected
  disabledStatus     = [string]$afterDisable.status
  disabledGeneration = [int]$afterDisable.generation
  persistedFields    = @($afterDisable.PSObject.Properties.Name)
  persistedText      = [string]$persistedText
  upgradedArmed      = [bool]$upgraded.armed
  upgradedGeneration = [int]$upgraded.generation
  upgradedStatus     = [string]$upgraded.status
  upgradedFields     = @($upgraded.PSObject.Properties.Name)
} | ConvertTo-Json -Compress -Depth 5
`);

check('the switch is a file, so it survives a restart, and the owner owns it', () => {
  const stateFile = path.join(scratch, 'state', 'mechanical-connect-state.json');
  const partialFile = path.join(scratch, 'state', 'partial.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const { value } = runJson(stateHarness, [ENGINE, stateFile, partialFile]);

  assert.match(value.tokenSid, /^S-1-/);
  assert.equal(value.objectSid, value.tokenSid, 'kernel ownership follows the process SID despite misleading environment names');

  assert.equal(value.missingArmed, false, 'a machine that never armed reads as off');
  assert.equal(value.missingGeneration, 0);

  assert.equal(value.loopArmed, true);
  assert.equal(value.loopGeneration, 7, 'the generation is persisted, not memory-only');
  assert.equal(value.loopConnected, true);
  assert.equal(value.loopRole, 'minter');
  assert.equal(value.loopStatus, 'connected');

  // The stale loop copy still said armed+connected; the owner's OFF must win.
  assert.equal(value.disabledArmed, false, 'a stale loop write must not re-arm the switch');
  assert.equal(value.disabledConnected, false);
  assert.equal(value.disabledStatus, 'off');
  assert.equal(value.disabledGeneration, 7, 'switching off keeps the credential epoch');

  assert.ok(!/token|secret|credential/i.test(value.persistedText), 'the state file must never carry a secret');

  // An older or truncated document is upgraded, never rejected.
  assert.equal(value.upgradedArmed, true);
  assert.equal(value.upgradedGeneration, 2);
  assert.equal(value.upgradedStatus, 'off', 'missing fields fall back to the template');
  for (const field of ['schema', 'armed', 'generation', 'connected', 'role', 'localIp', 'peerIp', 'status', 'detail', 'loopPid', 'updatedAt']) {
    assert.ok(value.upgradedFields.includes(field), `upgraded state is missing ${field}`);
  }
});

// ---------------------------------------------------------------------------
// 4c. The toggle path itself, run the way the panel runs it: powershell.exe
//     -File, not a dot-source. An audit reported that -Enable always threw
//     CommandNotFoundException because GetNewClosure() rebinds a scriptblock
//     to a module scope that cannot see script-level functions, and concluded
//     the feature had never once turned on. That is reproduced here and shown
//     to be false - but the real gap it pointed at was genuine: nothing ever
//     invoked Enable-Rendezvous, so any toggle-path fault would have shipped.
//
//     Side-effecting helpers are stubbed in a COPY of the engine, so this test
//     registers no task, starts no loop, binds no port, and writes only inside
//     its own scratch directory.
// ---------------------------------------------------------------------------
const enableDir = path.join(scratch, 'enable-sandbox');
fs.mkdirSync(path.join(enableDir, 'state'), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, 'packages', 'servercontrol', 'ServerControl.Common.ps1'),
  path.join(enableDir, 'ServerControl.Common.ps1')
);
{
  // Test-unique kernel object names. Without these, arming or disarming the
  // sandbox would drive the loop mutex and stop event of a REAL loop running
  // on this machine.
  const stamp = `${process.pid}-${Date.now()}`;
  const stubs = [
    "$script:StatePath = Join-Path $PSScriptRoot 'state\\toggle.json'",
    `$script:LoopMutexName = 'Local\\MechTestLoop${stamp}'`,
    `$script:StateMutexName = 'Local\\MechTestState${stamp}'`,
    `$script:StopEventName = 'Local\\MechTestStop${stamp}'`,
    "$script:TaskName = 'ServerControl Mechanical Connect TEST'",
    "function Register-RendezvousTask { $script:StubTaskRegistered = $true; return $true }",
    "function Unregister-RendezvousTask { $script:StubTaskRegistered = $false; return $true }",
    "function Test-RendezvousTaskPresent { return [bool]$script:StubTaskRegistered }",
    "function Start-RendezvousHiddenProcess { param($File,[string[]]$Arguments=@()) $script:StubLoopStarted = $true; return 4242 }",
    "function Test-RendezvousLocalListener { param($Address,$Port) return $false }",
    "function Test-RendezvousVaultToolPresent { return $true }",
    "function Get-RendezvousLinkAddress { if($env:MECHTEST_LINK){ return [string]$env:MECHTEST_LINK }; return $null }",
    ''
  ].join('\n');
  const patched = engineText.replace('if($LoadOnly){ return }', `${stubs}if($LoadOnly){ return }`);
  assert.ok(patched !== engineText, 'could not inject the toggle-path stubs');
  fs.writeFileSync(path.join(enableDir, 'Mechanical-Connect.ps1'), patched, 'utf8');
}
const enableEngine = path.join(enableDir, 'Mechanical-Connect.ps1');
const toggleStateFile = path.join(enableDir, 'state', 'toggle.json');

check('-Enable really arms this machine, and -Disable really switches it off', () => {
  const enabled = runJson(enableEngine, ['-Enable'], { MECHTEST_LINK: MINTER_IP });
  assert.equal(enabled.value.armed, true, '-Enable must persist the switch, not throw');
  assert.equal(enabled.value.role, 'minter', 'the lower fixture address is the minter');
  assert.equal(enabled.value.peer, RECEIVER_IP);
  assert.equal(enabled.value.taskRegistered, true, 'sign-in survival must be registered');
  assert.equal(enabled.raw.stderr.trim(), '', `-Enable wrote to stderr: ${enabled.raw.stderr}`);
  assert.ok(fs.existsSync(toggleStateFile), '-Enable must write the state file');
  const persisted = JSON.parse(fs.readFileSync(toggleStateFile, 'utf8').replace(/^﻿/, ''));
  assert.equal(persisted.armed, true);
  assert.equal(persisted.peerIp, RECEIVER_IP, 'the closure must resolve the peer, not throw');
  assert.equal(persisted.role, 'minter');

  const disabled = runJson(enableEngine, ['-Disable'], { MECHTEST_LINK: MINTER_IP });
  assert.equal(disabled.value.armed, false);
  assert.equal(disabled.value.generation, enabled.value.generation, 'switching off keeps the credential epoch');
  assert.equal(disabled.value.status, 'off', 'a clean teardown reports off, not attention');
});

check('the same file arms the other machine with the opposite role', () => {
  fs.rmSync(toggleStateFile, { force: true });
  const enabled = runJson(enableEngine, ['-Enable'], { MECHTEST_LINK: RECEIVER_IP });
  assert.equal(enabled.value.armed, true);
  assert.equal(enabled.value.role, 'receiver');
  assert.equal(enabled.value.peer, MINTER_IP);
  runJson(enableEngine, ['-Disable'], { MECHTEST_LINK: RECEIVER_IP });
});

check('with no direct link the switch arms but says so, and never guesses a peer', () => {
  fs.rmSync(toggleStateFile, { force: true });
  const enabled = runJson(enableEngine, ['-Enable'], { MECHTEST_LINK: '' });
  assert.equal(enabled.value.armed, true);
  assert.equal(enabled.value.role, null);
  assert.equal(enabled.value.peer, null);
  assert.equal(enabled.value.status, 'no-link');
  runJson(enableEngine, ['-Disable'], { MECHTEST_LINK: '' });
});

check('a machine with no key store refuses to arm instead of thrashing the peer', () => {
  // Arming without a vault would make the minter push a fresh credential every
  // poll, rotating the FAR side's key and restarting its bridge six times a
  // minute while never being able to hold its own end.
  const noVaultEngine = path.join(enableDir, 'Mechanical-Connect-NoVault.ps1');
  fs.writeFileSync(
    noVaultEngine,
    fs.readFileSync(enableEngine, 'utf8')
      .replace('function Test-RendezvousVaultToolPresent { return $true }', 'function Test-RendezvousVaultToolPresent { return $false }')
      .replace("Join-Path $PSScriptRoot 'state\\toggle.json'", "Join-Path $PSScriptRoot 'state\\novault.json'"),
    'utf8'
  );
  const enabled = runJson(noVaultEngine, ['-Enable'], { MECHTEST_LINK: MINTER_IP });
  assert.equal(enabled.value.armed, false, 'a machine that cannot store a key must not arm');
  assert.equal(enabled.value.status, 'attention');
  assert.match(enabled.value.detail, /key store/);
});

check('the status object carries evidence, not just the switch position', () => {
  const status = runJson(enableEngine, ['-Status'], { MECHTEST_LINK: MINTER_IP }).value;
  for (const field of ['serving', 'loopAlive', 'taskRegistered', 'detail', 'updatedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, field), `status is missing ${field}`);
  }
});

// ---------------------------------------------------------------------------
// 4d. A fault must outlive the switch. The loop used to blank status/detail to
//     'off' whenever armed was false, which erased the only record of a split
//     credential when the split happened during a Disable.
// ---------------------------------------------------------------------------
const faultHarness = harness('fault.ps1', `
param([string]$Engine,[string]$StateFile,[string]$LockedFile,[string]$MutexName)
. $Engine -LoadOnly
$script:StatePath = $StateFile
# Never contend with a real loop's state mutex.
$script:StateMutexName = $MutexName

[void](Invoke-RendezvousStateUpdate { param($current) $current.armed = $false; $current.generation = 5; return $current })

$split = New-RendezvousState
$split.armed = $true
$split.generation = 5
$split.connected = $false
$split.status = 'attention'
$split.detail = 'the other machine took a new key and this one could not store it'
Save-RendezvousLoopState $split
$afterSplit = Read-RendezvousState

$ordinary = New-RendezvousState
$ordinary.armed = $true
$ordinary.generation = 5
$ordinary.status = 'connected'
$ordinary.detail = 'keys exchanged'
Save-RendezvousLoopState $ordinary
$afterOrdinary = Read-RendezvousState

# The state lock is unavailable: the update must refuse to write rather than
# clobber the file from an unsynchronised read. A Windows mutex is re-entrant
# per THREAD, so the holder has to be a different thread - a runspace, which
# is the cheapest genuine one available here.
$script:StatePath = $LockedFile
$script:StateLockTimeoutMs = 750
[void](Invoke-RendezvousStateUpdate { param($current) $current.armed = $false; $current.generation = 9; return $current })

$readyPath = "$LockedFile.held"
$holder = [PowerShell]::Create()
[void]$holder.AddScript({
  param([string]$Name,[string]$Ready,[int]$HoldMs)
  $m = New-Object System.Threading.Mutex($false,$Name)
  if($m.WaitOne(5000)){
    Set-Content -LiteralPath $Ready -Value 'held' -Encoding ASCII
    Start-Sleep -Milliseconds $HoldMs
    try { $m.ReleaseMutex() } catch {}
  }
  $m.Dispose()
}).AddArgument($script:StateMutexName).AddArgument($readyPath).AddArgument(6000)
$holderHandle = $holder.BeginInvoke()
for($i = 0; $i -lt 100; $i++){
  if(Test-Path -LiteralPath $readyPath){ break }
  Start-Sleep -Milliseconds 50
}

$threw = $false
try { [void](Invoke-RendezvousStateUpdate { param($current) $current.armed = $true; return $current }) } catch { $threw = $true }
$loopSwallowed = $true
$resurrect = New-RendezvousState
$resurrect.armed = $true
$resurrect.status = 'connected'
try { Save-RendezvousLoopState $resurrect } catch { $loopSwallowed = $false }
$afterLock = Read-RendezvousState
try { [void]$holder.EndInvoke($holderHandle) } catch {}
$holder.Dispose()

[pscustomobject][ordered]@{
  splitStatus     = [string]$afterSplit.status
  splitDetail     = [string]$afterSplit.detail
  ordinaryStatus  = [string]$afterOrdinary.status
  ordinaryDetail  = [string]$afterOrdinary.detail
  lockThrew       = [bool]$threw
  loopSwallowed   = [bool]$loopSwallowed
  lockedArmed     = [bool]$afterLock.armed
  lockedGeneration= [int]$afterLock.generation
} | ConvertTo-Json -Compress
`);

check('a fault survives the switch being turned off, and an ordinary status does not', () => {
  const stateFile = path.join(scratch, 'state', 'fault.json');
  const lockedFile = path.join(scratch, 'state', 'locked.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const { value } = runJson(faultHarness, [ENGINE, stateFile, lockedFile, `Local\\MechTestFault${process.pid}`]);

  assert.equal(value.splitStatus, 'attention', 'a split must not be blanked to off by the disable branch');
  assert.match(value.splitDetail, /could not store it/, 'the reason must survive too');
  assert.equal(value.ordinaryStatus, 'off', 'a healthy loop state still collapses to off when disarmed');
  assert.equal(value.ordinaryDetail, '');

  assert.equal(value.lockThrew, true, 'an unavailable state lock must fail loudly, not write unsynchronised');
  assert.equal(value.loopSwallowed, true, 'the loop must survive a lock failure and retry next poll');
  assert.equal(value.lockedArmed, false, "the owner's OFF must not be resurrected by a stale in-memory copy");
  assert.equal(value.lockedGeneration, 9);
});

// ---------------------------------------------------------------------------
// 5. The connection handler, driven over a MemoryStream. No socket, no vault.
// ---------------------------------------------------------------------------
const handlerHarness = harness('handler.ps1', `
param([string]$Engine)
. $Engine -LoadOnly

$script:calls = New-Object System.Collections.ArrayList
$script:acceptingCommit = { param([string]$candidate) [void]$script:calls.Add((Test-RendezvousToken $candidate)); return $true }
$script:failingCommit = { param([string]$candidate) [void]$script:calls.Add((Test-RendezvousToken $candidate)); return $false }

function New-ExchangeRequest {
  param([string]$Offered,[int]$Generation)
  $payload = '{"token":"' + $Offered + '","generation":' + $Generation + '}'
  return "POST /v1/rendezvous/exchange HTTP/1.1\`r\`nHost: h\`r\`nContent-Length: $($payload.Length)\`r\`n\`r\`n" + $payload
}

function Invoke-HandlerCase {
  param([string]$Id,[string]$Raw,[string]$Remote,$State,[scriptblock]$Commit)
  $before = $script:calls.Count
  $stream = New-Object System.IO.MemoryStream
  $requestBytes = [System.Text.Encoding]::ASCII.GetBytes($Raw)
  $stream.Write($requestBytes,0,$requestBytes.Length)
  $stream.Position = 0
  $outcome = Invoke-RendezvousConnection -Stream $stream -RemoteAddress $Remote -State $State -Commit $Commit
  $all = $stream.ToArray()
  $stream.Dispose()
  $responseText = ''
  if($all.Length -gt $requestBytes.Length){
    $responseText = [System.Text.Encoding]::UTF8.GetString($all,$requestBytes.Length,$all.Length - $requestBytes.Length)
  }
  $statusCode = 0
  if($responseText -match '^HTTP/1\\.1 (\\d{3})'){ $statusCode = [int]$Matches[1] }
  $bodyText = ''
  $split = $responseText.IndexOf("\`r\`n\`r\`n")
  if($split -ge 0){ $bodyText = $responseText.Substring($split + 4) }
  return [pscustomobject][ordered]@{
    id = $Id
    responseBytes = ($all.Length - $requestBytes.Length)
    statusCode = $statusCode
    body = $bodyText
    committed = [bool]$outcome.Committed
    generation = [int]$outcome.Generation
    reason = [string]$outcome.Reason
    commitCalls = ($script:calls.Count - $before)
    stateGeneration = [int]$State.generation
  }
}

$armed = New-RendezvousState
$armed.armed = $true; $armed.generation = 3; $armed.role = 'receiver'; $armed.peerIp = '192.0.2.1'
$idle = New-RendezvousState
$idle.armed = $false; $idle.generation = 3; $idle.role = 'receiver'; $idle.peerIp = '192.0.2.1'
$minter = New-RendezvousState
$minter.armed = $true; $minter.generation = 3; $minter.role = 'minter'; $minter.peerIp = '192.0.2.2'
$roleless = New-RendezvousState
$roleless.armed = $true; $roleless.generation = 3; $roleless.role = $null; $roleless.peerIp = '192.0.2.1'
$stateRequest = "GET /v1/rendezvous/state HTTP/1.1\`r\`nHost: h\`r\`n\`r\`n"
$good = 'A' * 43

$results = @(
  (Invoke-HandlerCase 'state' $stateRequest '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'state-foreign' $stateRequest '192.0.2.9' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'state-prefix' $stateRequest '192.0.2.10' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'state-empty' $stateRequest '' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-ok' (New-ExchangeRequest $good 4) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-foreign' (New-ExchangeRequest $good 9) '10.0.0.5' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-not-armed' (New-ExchangeRequest $good 9) '192.0.2.1' $idle $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-stale' (New-ExchangeRequest $good 3) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-backward' (New-ExchangeRequest $good 2) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-short-token' (New-ExchangeRequest ('A' * 42) 9) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-vault-failed' (New-ExchangeRequest $good 9) '192.0.2.1' $armed $script:failingCommit),
  (Invoke-HandlerCase 'exchange-at-minter' (New-ExchangeRequest $good 9) '192.0.2.2' $minter $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-no-role' (New-ExchangeRequest $good 9) '192.0.2.1' $roleless $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-ceiling' (New-ExchangeRequest $good 2147483000) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-far-future' (New-ExchangeRequest $good 999999) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'exchange-window-edge' (New-ExchangeRequest $good 4099) '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'unknown-path' "GET /v1/rendezvous/keys HTTP/1.1\`r\`nHost: h\`r\`n\`r\`n" '192.0.2.1' $armed $script:acceptingCommit),
  (Invoke-HandlerCase 'garbage' "not-http-at-all\`r\`n\`r\`n" '192.0.2.1' $armed $script:acceptingCommit)
)
[pscustomobject][ordered]@{
  cases = @($results)
  everyCommitSawAValidToken = [bool](@($script:calls | Where-Object { -not $_ }).Count -eq 0)
  totalCommitCalls = $script:calls.Count
} | ConvertTo-Json -Compress -Depth 6
`);

let handler = null;
check('the served wire contract matches the frozen shape exactly', () => {
  const result = runJson(handlerHarness, [ENGINE]).value;
  handler = Object.fromEntries(result.cases.map(entry => [entry.id, entry]));
  assert.equal(handler['state'].statusCode, 200);
  assert.equal(
    handler['state'].body,
    '{"schemaVersion":"fra-rendezvous.v1","armed":true,"ready":true,"generation":3,"role":"receiver","peer":"192.0.2.1","secretValuesEmitted":false}'
  );
  assert.equal(handler['exchange-ok'].statusCode, 200);
  assert.equal(
    handler['exchange-ok'].body,
    '{"schemaVersion":"fra-rendezvous.v1","ok":true,"accepted":true,"generation":4,"secretValuesEmitted":false}'
  );
  assert.equal(handler['exchange-ok'].committed, true);
  assert.equal(handler['exchange-ok'].generation, 4);
  assert.equal(handler['unknown-path'].statusCode, 404);
  assert.equal(handler['garbage'].statusCode, 400);
  assert.equal(result.everyCommitSawAValidToken, true);
  assert.equal(result.totalCommitCalls, 3, 'only well-formed, armed, in-role, in-window offers reach a committer');
});

check('only the receiver will ever install a pushed credential', () => {
  // The header always said "the lower address mints". Nothing enforced it on
  // the RECEIVING side, so the minter would also install whatever it was
  // handed. Two hosts that both compute `minter` (one duplicate address on a
  // second adapter is enough) would each commit the other's token, land on
  // the same generation holding DIFFERENT credentials, and then report
  // `connected` forever with a dead bridge.
  for (const id of ['exchange-at-minter', 'exchange-no-role']) {
    assert.equal(handler[id].statusCode, 409, `${id} must be refused`);
    assert.equal(handler[id].body, '{"ok":false,"reason":"role-conflict"}');
    assert.equal(handler[id].commitCalls, 0, `${id} must not reach the vault at all`);
    assert.equal(handler[id].committed, false);
    assert.equal(handler[id].generation, 3, `${id} must not move the generation`);
  }
});

check('the generation is bounded by a window, so one request cannot wedge rotation', () => {
  // Accepting anything up to int-max let a single POST pin the counter at the
  // ceiling. Every later mint then computed ceiling+1, threw inside the
  // exchange, was swallowed by the loop's catch, and the pair could never
  // rotate again - while the tray said "waiting for peer" forever.
  for (const id of ['exchange-ceiling', 'exchange-far-future']) {
    assert.equal(handler[id].statusCode, 409, `${id} must be refused`);
    assert.equal(handler[id].body, '{"ok":false,"reason":"generation-out-of-window"}');
    assert.equal(handler[id].commitCalls, 0);
    assert.equal(handler[id].generation, 3);
  }
  // The far edge of the window is still a legitimate offer.
  assert.equal(handler['exchange-window-edge'].statusCode, 200);
  assert.equal(handler['exchange-window-edge'].committed, true);
  assert.equal(handler['exchange-window-edge'].generation, 4099);
});

check('a connection from any address but the peer gets nothing and commits nothing', () => {
  for (const id of ['state-foreign', 'state-prefix', 'state-empty', 'exchange-foreign']) {
    assert.equal(handler[id].responseBytes, 0, `${id} must receive zero bytes`);
    assert.equal(handler[id].reason, 'foreign-address');
    assert.equal(handler[id].commitCalls, 0);
    assert.equal(handler[id].committed, false);
  }
});

check('a not-armed receiver refuses and writes nothing', () => {
  const entry = handler['exchange-not-armed'];
  assert.equal(entry.statusCode, 409);
  assert.equal(entry.body, '{"ok":false,"reason":"not-armed"}');
  assert.equal(entry.commitCalls, 0, 'the vault is not even opened when the toggle is off');
  assert.equal(entry.committed, false);
  assert.equal(entry.generation, 3, 'the generation is untouched');
});

check('replayed, backward, and malformed offers are refused before any write', () => {
  for (const id of ['exchange-stale', 'exchange-backward']) {
    assert.equal(handler[id].statusCode, 409);
    assert.equal(handler[id].reason, 'stale-generation');
    assert.equal(handler[id].commitCalls, 0);
  }
  assert.equal(handler['exchange-short-token'].statusCode, 400);
  assert.equal(handler['exchange-short-token'].reason, 'invalid-token');
  assert.equal(handler['exchange-short-token'].commitCalls, 0);
});

check('a failed local write answers ok:false so the peer does not commit either', () => {
  const entry = handler['exchange-vault-failed'];
  assert.equal(entry.statusCode, 500);
  assert.equal(entry.body, '{"ok":false,"reason":"vault-write-failed"}');
  assert.equal(entry.committed, false);
  assert.equal(entry.generation, 3, 'a failed write must not advance the generation');
});

// ---------------------------------------------------------------------------
// 5b. The same guard over a real socket, on loopback only. This is the one
//     place the accept path itself is exercised: bind, Pending, AcceptTcpClient,
//     and the remote-address check that runs before a single byte is read.
// ---------------------------------------------------------------------------
const socketHarness = harness('socket.ps1', `
param([string]$Engine)
. $Engine -LoadOnly

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse('127.0.0.1')),0
$listener.Start()
$port = $listener.LocalEndpoint.Port

$state = New-RendezvousState
$state.armed = $true
$state.generation = 2
$state.role = 'receiver'
$state.peerIp = '192.0.2.1'

$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('127.0.0.1',$port)
$stream = $client.GetStream()
$request = [System.Text.Encoding]::ASCII.GetBytes("GET /v1/rendezvous/state HTTP/1.1\`r\`nHost: h\`r\`n\`r\`n")
$stream.Write($request,0,$request.Length)
$stream.Flush()
Start-Sleep -Milliseconds 250

$pendingSeen = $listener.Pending()
$committed = Invoke-RendezvousPendingConnections $listener $state

$stream.ReadTimeout = 3000
$buffer = New-Object byte[] 256
$read = -1
try { $read = $stream.Read($buffer,0,$buffer.Length) } catch { $read = -2 }
$client.Close()
$listener.Stop()

[pscustomobject][ordered]@{
  listenerBound = ($port -gt 0)
  sawPending    = [bool]$pendingSeen
  committed     = [bool]$committed
  bytesReturned = [int]$read
  generation    = [int]$state.generation
} | ConvertTo-Json -Compress
`);

check('over a real socket, a non-peer connection is closed before a byte is read', () => {
  const { value } = runJson(socketHarness, [ENGINE]);
  assert.equal(value.listenerBound, true, 'the address-bound TcpListener must construct and bind');
  assert.equal(value.sawPending, true, 'the accept loop must see the queued connection');
  assert.equal(value.committed, false);
  assert.equal(value.generation, 2, 'a refused connection must not move the generation');
  // 0 is a clean close, -2 is a reset. Either way the caller received no reply.
  assert.ok(value.bytesReturned <= 0, `a foreign caller received ${value.bytesReturned} bytes`);
});

// ---------------------------------------------------------------------------
// 6. Commit ordering, against a fake peer on loopback and a throwaway vault.
// ---------------------------------------------------------------------------
const exchangeHarness = harness('exchange.ps1', `
param([string]$Engine,[int]$Port)
. $Engine -LoadOnly
$result = Invoke-RendezvousExchange -Address '127.0.0.1' -Port $Port -Generation 4 -SelfTest
[pscustomobject][ordered]@{
  pushed = [bool]$result.Pushed
  committed = [bool]$result.Committed
  generation = [int]$result.Generation
  reason = [string]$result.Reason
} | ConvertTo-Json -Compress
`);

const peerStateHarness = harness('peer-state.ps1', `
param([string]$Engine,[int]$Port)
. $Engine -LoadOnly
$result = Get-RendezvousPeerState -Address '127.0.0.1' -Port $Port
if($null -eq $result){
  [pscustomobject][ordered]@{ isNull = $true } | ConvertTo-Json -Compress
} else {
  [pscustomobject][ordered]@{
    isNull = $false
    armed = [bool]$result.Armed
    generation = [int]$result.Generation
    role = [string]$result.Role
    peer = [string]$result.Peer
  } | ConvertTo-Json -Compress
}
`);

const gateHarness = harness('gate.ps1', `
param([string]$Engine)
. $Engine -LoadOnly
function Test-Throws { param([scriptblock]$Action) try { & $Action | Out-Null; return $false } catch { return $true } }
[pscustomobject][ordered]@{
  selfTestRejectsRealPeer = (Test-Throws { Invoke-RendezvousExchange -Address '192.0.2.2' -Port 8795 -Generation 2 -SelfTest })
  selfTestRejectsLan      = (Test-Throws { Invoke-RendezvousExchange -Address '10.0.0.5' -Port 8795 -Generation 2 -SelfTest })
  liveRejectsLoopback     = (Test-Throws { Invoke-RendezvousExchange -Address '127.0.0.1' -Port 8795 -Generation 2 })
  liveRejectsForeign      = (Test-Throws { Invoke-RendezvousExchange -Address '192.0.2.9' -Port 8795 -Generation 2 })
  rejectsZeroGeneration   = (Test-Throws { Invoke-RendezvousExchange -Address '127.0.0.1' -Port 1 -Generation 0 -SelfTest })
} | ConvertTo-Json -Compress
`);

function makeVault(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'secrets.json');
}

function startFakePeer(behaviour) {
  const seen = { token: null, generation: null, requests: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.requests += 1;
      if (request.method === 'POST' && request.url === '/v1/rendezvous/exchange') {
        try {
          const parsed = JSON.parse(body);
          seen.token = parsed.token;
          seen.generation = parsed.generation;
        } catch (error) { /* left null, asserted by the caller */ }
      }
      const reply = behaviour();
      const payload = JSON.stringify(reply.payload);
      // Frame it exactly the way the real responder does: a declared
      // Content-Length and a closed connection, never chunked.
      response.writeHead(reply.status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'Connection': 'close'
      });
      response.end(payload);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function exchangeAgainst(behaviour, vault) {
  // Fail closed: an exchange really does write a credential, so refuse to run
  // one unless the target vault is inside this run's throwaway directory.
  assert.ok(
    path.resolve(vault).startsWith(path.resolve(scratch) + path.sep),
    'refusing to run an exchange against anything but a throwaway vault'
  );
  const peer = await startFakePeer(behaviour);
  try {
    const result = await runJsonAsync(exchangeHarness, [ENGINE, String(peer.port)], { TOOLSENABLED_VAULT_PATH: vault });
    return { result, peer };
  } finally {
    peer.server.close();
  }
}

async function stateAgainst(payload) {
  const peer = await startFakePeer(() => ({ status: 200, payload }));
  try {
    return await runJsonAsync(peerStateHarness, [ENGINE, String(peer.port)]);
  } finally {
    peer.server.close();
  }
}

async function main() {
  // The two machines shipped different field names for the same ready switch.
  // Accept both literal-boolean spellings and reject coercible substitutes.
  for (const [name, payload, expected] of [
    ['ready', { ready: true, generation: 7, role: 'receiver', peer: '192.0.2.1' }, true],
    ['armed', { armed: true, generation: 7, role: 'receiver', peer: '192.0.2.1' }, true],
    ['both-off', { armed: false, ready: false, generation: 7, role: 'receiver', peer: '192.0.2.1' }, false],
    ['ready-string', { ready: 'true', generation: 7, role: 'receiver', peer: '192.0.2.1' }, false]
  ]) {
    const run = await stateAgainst(payload);
    check(`peer state accepts only a literal armed/ready switch (${name})`, () => {
      assert.equal(run.value.isNull, false);
      assert.equal(run.value.armed, expected);
      assert.equal(run.value.generation, 7);
    });
  }

  // 6a. The peer refuses -> the local vault is not created or modified at all.
  {
    const vault = makeVault('vault-refused');
    const run = await exchangeAgainst(() => ({ status: 409, payload: { ok: false, reason: 'not-armed' } }), vault);
    check('a peer that refuses leaves the local vault completely untouched', () => {
      assert.equal(run.result.value.pushed, false);
      assert.equal(run.result.value.committed, false);
      assert.equal(run.result.value.reason, 'peer-refused');
      assert.equal(fs.existsSync(vault), false, 'nothing may be written when the peer says no');
      assert.equal(run.peer.seen.requests, 1);
    });
  }

  // 6b. The peer answers 200 but not a literal boolean true -> still no write.
  //     `$parsed.ok -ne $true` coerced the right operand to the left's type,
  //     so "true" and 1 both compared equal and unlocked the local commit.
  //     Both compatibility spellings must keep that strict type boundary.
  for (const [name, payload] of [
    ['ok-false', { ok: false, generation: 4 }],
    ['ok-string', { ok: 'true', generation: 4 }],
    ['ok-number', { ok: 1, generation: 4 }],
    ['accepted-false', { accepted: false, generation: 4 }],
    ['accepted-string', { accepted: 'true', generation: 4 }],
    ['accepted-number', { accepted: 1, generation: 4 }],
    ['ok-missing', { reason: 'stored' }]
  ]) {
    const vault = makeVault(`vault-${name}`);
    const run = await exchangeAgainst(() => ({ status: 200, payload }), vault);
    check(`only a literal boolean acceptance unlocks the local write (${name})`, () => {
      assert.equal(run.result.value.committed, false);
      assert.equal(run.result.value.reason, 'peer-refused');
      assert.equal(fs.existsSync(vault), false);
    });
  }

  // An accepted receipt must also identify the exact generation that was
  // committed remotely. Missing, differently typed, or mismatched echoes fail
  // before the local vault is opened.
  for (const [name, payload] of [
    ['generation-missing', { accepted: true }],
    ['generation-string', { accepted: true, generation: '4' }],
    ['generation-double', { accepted: true, generation: 4.5 }],
    ['generation-mismatch-accepted', { accepted: true, generation: 5 }],
    ['generation-mismatch-ok', { ok: true, generation: 5 }]
  ]) {
    const vault = makeVault(`vault-${name}`);
    const run = await exchangeAgainst(() => ({ status: 200, payload }), vault);
    check(`a receipt must echo the exact numeric generation (${name})`, () => {
      assert.equal(run.result.value.pushed, false);
      assert.equal(run.result.value.committed, false);
      assert.equal(run.result.value.reason, 'peer-generation-mismatch');
      assert.equal(fs.existsSync(vault), false);
    });
  }

  // 6c. The peer accepts -> and only then is the local vault written, with the
  //     same token the peer already holds.
  let acceptedToken = null;
  let acceptedRun = null;
  {
    const vault = makeVault('vault-accepted');
    const run = await exchangeAgainst(() => ({ status: 200, payload: { ok: true, generation: 4 } }), vault);
    acceptedToken = run.peer.seen.token;
    acceptedRun = run;
    check('ok:true commits exactly the token the peer already holds', () => {
      assert.equal(run.result.value.pushed, true);
      assert.equal(run.result.value.committed, true);
      assert.equal(run.result.value.generation, 4);
      assert.equal(run.peer.seen.generation, 4);
      assert.match(acceptedToken, /^[A-Za-z0-9_-]{43}$/, 'the wire token is canonical 32-byte base64url');
      assert.equal(Buffer.from(acceptedToken, 'base64url').length, 32);
      assert.equal(Buffer.from(acceptedToken, 'base64url').toString('base64url'), acceptedToken);

      const stored = JSON.parse(fs.readFileSync(vault, 'utf8'));
      assert.deepEqual(Object.keys(stored), [VAULT_KEY]);

      // Read it back through the same tool the writer used, without printing it.
      const readback = spawnSync(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SECRETS, 'get', VAULT_KEY
      ], {
        cwd: ROOT, windowsHide: true, encoding: 'utf8',
        env: Object.assign({}, process.env, { TOOLSENABLED_VAULT_PATH: vault })
      });
      assert.equal(readback.status, 0, readback.stderr);
      assert.equal(
        readback.stdout === acceptedToken, true,
        'the committed credential must be byte-identical to the one the peer accepted'
      );
      assert.equal(
        fs.readFileSync(vault, 'utf8').includes(acceptedToken), false,
        'the vault record must be DPAPI-encrypted, not plaintext'
      );
    });
  }

  {
    const vault = makeVault('vault-accepted-compatible');
    const run = await exchangeAgainst(() => ({
      status: 200,
      payload: { schemaVersion: 'fra-rendezvous.v1', accepted: true, generation: 4, secretValuesEmitted: false }
    }), vault);
    check('accepted:true with the matching generation commits the peer-compatible receipt', () => {
      assert.equal(run.result.value.pushed, true);
      assert.equal(run.result.value.committed, true);
      assert.equal(run.result.value.generation, 4);
      assert.equal(run.peer.seen.generation, 4);
    });
  }

  check('the exchange never writes the credential to stdout, stderr, or any file', () => {
    assert.ok(acceptedToken && acceptedToken.length === 43);
    assert.equal(acceptedRun.result.raw.stdout.includes(acceptedToken), false, 'token leaked to stdout');
    assert.equal(acceptedRun.result.raw.stderr.includes(acceptedToken), false, 'token leaked to stderr');
    for (const file of walkFiles(scratch, [])) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(acceptedToken), false, `token leaked into ${path.relative(scratch, file)}`);
    }
  });

  // 6d. The peer accepts but the local vault write fails -> the minter reports
  //     no commit, so its generation never advances and the pair re-converges.
  {
    const vault = makeVault('vault-corrupt');
    fs.writeFileSync(vault, 'this is not json', 'utf8');
    const before = fs.readFileSync(vault, 'utf8');
    const run = await exchangeAgainst(() => ({ status: 200, payload: { ok: true, generation: 4 } }), vault);
    check('a failed local write fails closed and leaves existing state intact', () => {
      assert.equal(run.result.value.pushed, true);
      assert.equal(run.result.value.committed, false);
      assert.equal(run.result.value.reason, 'local-vault-write-failed');
      assert.equal(fs.readFileSync(vault, 'utf8'), before, 'the existing vault file must be byte-identical');
    });
  }

  // 6e. The pump. This is the property that stops the two single-threaded
  //     loops starving each other, and it only exists while a request is
  //     outstanding, so it needs a peer that is deliberately slow to answer.
  {
    const slowPeer = await new Promise(resolve => {
      const server = http.createServer((request, response) => {
        setTimeout(() => {
          const payload = JSON.stringify({ armed: true, generation: 2, role: 'receiver', peer: '192.0.2.1' });
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          });
          response.end(payload);
        }, 2000);
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
    const pumpHarness = harness('pump.ps1', `
param([string]$Engine,[int]$Port,[int]$DeadPort)
. $Engine -LoadOnly
$script:pumped = 0
$pump = { $script:pumped += 1 }

$slow = Invoke-RendezvousHttpRequest -Address '127.0.0.1' -Port $Port -Method 'GET' \`
  -Path '/v1/rendezvous/state' -Body '' -TimeoutMs 30000 -Pump $pump
$pumpedDuringSlow = $script:pumped

# A peer that accepts and then says nothing must not hold this open past the
# absolute budget. Per-read timeouts alone could be reset forever.
$script:pumped = 0
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$stuck = Invoke-RendezvousHttpRequest -Address '127.0.0.1' -Port $DeadPort -Method 'GET' \`
  -Path '/v1/rendezvous/state' -Body '' -TimeoutMs 3000 -Pump $pump
$watch.Stop()

[pscustomobject][ordered]@{
  slowStatus       = [int]$(if($slow){ $slow.StatusCode } else { 0 })
  pumpedDuringSlow = [int]$pumpedDuringSlow
  stuckIsNull      = [bool]($null -eq $stuck)
  stuckElapsedMs   = [int]$watch.ElapsedMilliseconds
  pumpedWhileStuck = [int]$script:pumped
} | ConvertTo-Json -Compress
`);
    // A listener that accepts and never writes a byte.
    const deadNet = require('node:net');
    const deadPeer = await new Promise(resolve => {
      const server = deadNet.createServer(() => { /* accept and say nothing */ });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
    let pumpResult = null;
    try {
      pumpResult = (await runJsonAsync(pumpHarness, [ENGINE, String(slowPeer.port), String(deadPeer.port)])).value;
    } finally {
      slowPeer.server.close();
      deadPeer.server.close();
    }
    check('an outstanding request keeps serving the peer, and always ends', () => {
      assert.equal(pumpResult.slowStatus, 200, 'the slow peer must still be read correctly');
      assert.ok(pumpResult.pumpedDuringSlow >= 4, `the pump ran only ${pumpResult.pumpedDuringSlow} times across a 2s wait`);
      // The livelock: two loops each blocked on the other, both timing out at
      // the same instant, phase-locked forever with no jitter to break it.
      assert.equal(pumpResult.stuckIsNull, true, 'a silent peer must not return a bogus response');
      assert.ok(pumpResult.stuckElapsedMs >= 2500, 'the budget must actually be used');
      assert.ok(pumpResult.stuckElapsedMs < 20000, `a silent peer held the request for ${pumpResult.stuckElapsedMs}ms`);
      assert.ok(pumpResult.pumpedWhileStuck >= 4, 'the peer must be served even while we are stuck on a dead socket');
    });
  }

  // 6f. The serve loop itself: bind, publish, obey the stop event, exit. None
  //     of this had ever been executed. Pinned to loopback with a stubbed
  //     identity, so it cannot reach the other machine or the real vault.
  {
    const loopDir = path.join(scratch, 'serve-sandbox');
    fs.mkdirSync(path.join(loopDir, 'state'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'packages', 'servercontrol', 'ServerControl.Common.ps1'),
      path.join(loopDir, 'ServerControl.Common.ps1')
    );
    // A port of this run's own, never 8795: a real loop may legitimately hold
    // that one, and an interrupted earlier run can leave a sandbox loop on it.
    const loopPort = await new Promise(resolve => {
      const probe = require('node:net').createServer();
      probe.listen(0, '127.0.0.1', () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
    });
    const stamp = `${process.pid}-serve`;
    const stubs = [
      "$script:StatePath = Join-Path $PSScriptRoot 'state\\serve.json'",
      `$script:RendezvousPort = ${loopPort}`,
      `$script:LoopMutexName = 'Local\\MechTestServeLoop${stamp}'`,
      `$script:StateMutexName = 'Local\\MechTestServeState${stamp}'`,
      `$script:StopEventName = 'Local\\MechTestServeStop${stamp}'`,
      "$script:TaskName = 'ServerControl Mechanical Connect TEST'",
      "$script:PollIntervalMs = 1000",
      // Loopback identity. The role is RECEIVER, so this loop can never mint,
      // never opens the vault, and never reaches 192.0.2.2.
      "function Get-RendezvousLinkAddress { return '127.0.0.1' }",
      "function Get-RendezvousPeer { param([string]$LocalIp) return '127.0.0.2' }",
      "function Get-RendezvousRole { param([string]$LocalIp) return 'receiver' }",
      "function Register-RendezvousTask { return $true }",
      "function Unregister-RendezvousTask { return $true }",
      "function Test-RendezvousTaskPresent { return $false }",
      "function Test-RendezvousVaultToolPresent { return $true }",
      "function Restart-RendezvousBridgeListener { param($LocalIp) return 'skipped' }",
      // -Enable must not race this test's own explicitly spawned loop for the
      // mutex; the loop under test is the one spawned below.
      "function Start-RendezvousHiddenProcess { param($File,[string[]]$Arguments=@()) return 4242 }",
      ''
    ].join('\n');
    const loopEngine = path.join(loopDir, 'Mechanical-Connect.ps1');
    fs.writeFileSync(loopEngine, engineText.replace('if($LoadOnly){ return }', `${stubs}if($LoadOnly){ return }`), 'utf8');
    const loopState = path.join(loopDir, 'state', 'serve.json');

    const readLoopState = () => {
      try { return JSON.parse(fs.readFileSync(loopState, 'utf8').replace(/^﻿/, '')); } catch (error) { return null; }
    };
    const settle = async predicate => {
      for (let i = 0; i < 120; i += 1) {
        const current = readLoopState();
        if (current && predicate(current)) { return current; }
        await new Promise(done => setTimeout(done, 250));
      }
      return readLoopState();
    };

    runJson(loopEngine, ['-Enable']);
    const serving = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', loopEngine, '-Serve'
    ], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { TOOLSENABLED_ROOT: fixtureRoot })
    });
    let serveStderr = '';
    serving.stderr.setEncoding('utf8');
    serving.stderr.on('data', chunk => { serveStderr += chunk; });
    const exited = new Promise(resolve => serving.on('exit', code => resolve(code)));

    const running = await settle(current => current.loopPid > 0 && current.status !== 'off');
    let boundHere = false;
    // Publishing loopPid precedes opening the listener. Observe actual socket
    // readiness, with a fixed deadline, instead of treating the first refused
    // connection during startup as a permanently broken serve loop.
    const bindDeadline = Date.now() + 10_000;
    while (!boundHere && Date.now() < bindDeadline && serving.exitCode === null) {
      boundHere = await new Promise(resolve => {
        const socket = require('node:net').connect({ host: '127.0.0.1', port: loopPort });
        const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
        const timer = setTimeout(() => finish(false), Math.min(1000, Math.max(1, bindDeadline - Date.now())));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });
      if (!boundHere) await new Promise(resolve => setTimeout(resolve, 100));
    }

    runJson(loopEngine, ['-Disable']);
    const stopped = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 30000))
    ]);
    if (stopped === 'timeout') { try { serving.kill(); } catch (error) { /* best effort */ } }
    // Never leave a loop behind, whatever happened above: an interrupted run
    // used to leave a -Serve process alive holding a port forever, because the
    // switch it reads still said armed.
    try { if (serving.exitCode === null) { serving.kill(); } } catch (error) { /* best effort */ }
    const final = readLoopState();

    check('the serve loop actually binds, publishes, and stops when told to', () => {
      assert.ok(running, `the loop never published a state document (process=${stopped}; stderr=${serveStderr.trim()})`);
      assert.ok(running.loopPid > 0,
        `the loop must record its own pid so a dead loop is detectable (state=${JSON.stringify(running)}; process=${stopped}; stderr=${serveStderr.trim()})`);
      assert.equal(running.armed, true);
      assert.equal(running.role, 'receiver');
      assert.equal(boundHere, true, `nothing was listening on ${loopPort}`);
      // A receiver with an unreachable peer waits; it must never mint, and it
      // must not call this "connected".
      assert.equal(running.connected, false);
      assert.equal(running.status, 'waiting-for-peer', `unexpected loop status: ${running.status} / ${running.detail}`);
      assert.notEqual(stopped, 'timeout', 'the loop ignored the stop event');
      assert.equal(stopped, 0, `the serve process exited ${stopped}: ${serveStderr.trim()}`);
      assert.equal(serveStderr.trim(), '', `the serve loop wrote to stderr: ${serveStderr.trim()}`);
      assert.equal(final.armed, false);
      assert.equal(final.status, 'off', 'a clean stop is off, not a lingering fault');
    });
  }

  check('an exchange can only ever be aimed at the exact peer', () => {
    const { value } = runJson(gateHarness, [ENGINE]);
    assert.equal(value.selfTestRejectsRealPeer, true, 'a self-test must never reach a real machine');
    assert.equal(value.selfTestRejectsLan, true);
    assert.equal(value.liveRejectsLoopback, true, 'a live exchange must not target loopback');
    assert.equal(value.liveRejectsForeign, true);
    assert.equal(value.rejectsZeroGeneration, true);
  });

  // -------------------------------------------------------------------------
  // 7. The panel change is a tray toggle and nothing else.
  // -------------------------------------------------------------------------
  check('the tray menu gets one checkable switch wired to the engine', () => {
    const menu = panelText.slice(
      panelText.indexOf('function Build-TrayMenu'),
      panelText.indexOf('function Show-Panel')
    );
    assert.ok(menu.length > 200);
    // NOT "Tunnel". The panel already has a checkbox by that name driving the
    // 8787 message relay, and this switch starts neither that relay nor the
    // 8788 bridge - it makes the two machines agree on a credential. One name
    // on two controls is how "Tunnel: connected" and "OFF / message relay
    // disabled" ended up on screen at the same time.
    assert.match(menu, /ToolStripMenuItem\('Auto-connect keys'\)/);
    assert.ok(!/ToolStripMenuItem\('Tunnel'\)/.test(menu), 'the tray item must not reuse the message-relay name');
    assert.match(menu, /\$miTunnel\.Add_Click\(\{/);
    assert.match(menu, /\}\.GetNewClosure\(\)\)/);
    assert.match(menu, /Invoke-MechanicalConnectAction \$\(if\(\$armed\)\{'Disable'\}else\{'Enable'\}\)/);
    // The checkmark is never guessed. It used to be set optimistically on
    // click and otherwise only re-read when the SERVER LIST changed, so a
    // toggle that did nothing left a checked item beside a tooltip saying off.
    assert.ok(!/\$miTunnel\.Checked=\(-not \$armed\)/.test(menu), 'Checked must not be set optimistically on click');
    assert.match(menu, /\$miTunnel\.Enabled=\(Test-MechanicalConnectEngine\)/);
    assert.match(menu, /\$script:miTunnelStatus=\$miTunnelStatus/, 'the menu must carry a line for the engine detail');
  });

  check('the checkmark is reconciled from disk on the 2s tick, and a dead loop is restarted', () => {
    const refresh = panelText.slice(
      panelText.indexOf('function Update-MechanicalConnectTray'),
      panelText.indexOf('function Set-AccessStatus')
    );
    assert.ok(refresh.length > 200);
    assert.match(refresh, /\$script:miTunnel\.Checked=\$armed/);
    assert.match(refresh, /Test-MechanicalConnectStale/);
    assert.match(refresh, /Invoke-MechanicalConnectAction 'Enable'/, 'a stopped loop must be healed');
    assert.match(refresh, /MechanicalConnectHealAt/, 'healing needs a cooldown so it cannot spin every 2s');
    assert.match(panelText, /Update-MechanicalConnectTray\r?\n\s*\$mech=Get-MechanicalConnectTrayText/);
  });

  check('the engine keeps itself alive from a hidden session-0 task that cannot flash and never re-arms', () => {
    const register = slice('function Register-RendezvousTask', 'function Start-RendezvousServeProcess');

    // The original objection stands and is still asserted: Task Scheduler
    // launches powershell.exe itself, so this package's native CreateNoWindow
    // path does not apply and -WindowStyle Hidden only takes effect after the
    // console has been allocated. A repeating trigger therefore meant a visible
    // console flash on the interactive desktop every few minutes, forever.
    //
    // What changed is WHY there is no repetition. Removing it left the loop with
    // no keeper at all whenever the tray panel is not running -- which is the
    // normal state on any install whose panel watchdog is off and whose panel
    // was never started -- so a crashed rendezvous stayed dead and the live
    // listener was a
    // hand-started orphan. The task is the keeper again, without reviving either
    // fault: S4U puts it in session 0 where there is no desktop to flash, and
    // the action is -Serve, which honours `armed` and exits when it is false, so
    // it cannot re-arm a machine the owner switched off. Restart-on-failure, not
    // a cadence, is what brings a dead loop back.
    assert.ok(!/RepetitionInterval/.test(register), 'no repeating trigger may run the loop');
    assert.ok(!/RepetitionDuration/.test(register), 'no repeating trigger may run the loop');
    assert.match(register, /-LogonType S4U/, 'session 0 is what makes a console flash impossible');
    assert.match(register, /-File `"\$PSCommandPath`" -Serve/, 'the action must be -Serve, which honours armed, never -Enable, which re-arms');
    assert.ok(!/-File `"\$PSCommandPath`" -Enable/.test(register), 'the task must never re-arm the machine');
    assert.match(register, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/, 'PT3M would kill a loop meant to run for days');
    assert.match(register, /-RestartCount 999/, 'a crashed loop must come back');
    assert.match(register, /-Hidden/);

    // Sign-in trigger comes from the startup switch, never from a literal here:
    // a task that self-starts with Windows against the owner's setting is the
    // thing tools/lib/StartupPolicy.ps1 exists to prevent.
    assert.match(register, /New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon/);
    assert.ok(!/New-ScheduledTaskTrigger -AtStartup/.test(register), 'no boot trigger: DPAPI user scope is unavailable before first sign-in');
    // An on-demand task legitimately has no trigger at all, and
    // Register-ScheduledTask rejects an empty -Trigger, so the parameter must be
    // omitted rather than passed empty.
    assert.match(register, /if\(@\(\$triggers\)\.Count -gt 0\)\{ \$registerArgs\['Trigger'\] = \$triggers \}/);

    // Teardown is still verified rather than hoped for -- but what it verifies
    // changed with the action. OFF used to UNREGISTER the task, because an
    // -Enable action really would have switched the machine back on at the next
    // sign-in. A -Serve action cannot: it reads `armed` on entry and every
    // iteration and exits when false. Unregistering became pure cost, since
    // registering needs an administrator and every off-and-on cycle would have
    // demanded a UAC prompt to restore something that never needed removing.
    // So OFF stops the instance, and what must be checked is that nothing is
    // still LISTENING.
    const unregister = slice('function Unregister-RendezvousTask', '# --------------------------------------------------------------- serve loop --');
    assert.match(unregister, /Test-RendezvousTaskPresent/);
    const disable = slice('function Disable-Rendezvous', '# ----------------------------------------------------------------- dispatch --');
    assert.match(disable, /Stop-ScheduledTask/, 'OFF must stop the instance');
    assert.ok(!/\$unregistered = Unregister-RendezvousTask/.test(disable),
      'OFF must not unregister: that costs an administrator prompt on the next ON');
    assert.match(disable, /\$stillServing/, 'OFF must report a port that is still held rather than claim success');
  });

  check('arming reports a registration it could not do, instead of claiming success', () => {
    // [void](Register-RendezvousTask) discarded the result, so an -Enable that
    // could not install the sign-in task returned a cheerful "armed" with no
    // keeper behind it: the machine worked until the first crash and then stayed
    // down, silently. Registration needs an administrator and arming must not,
    // so failing here is the ordinary unelevated case -- it has to be reported,
    // not hidden.
    // Comments stripped first: this asserts about code, and the comment above
    // the fix necessarily quotes the discarded call it replaced.
    const enable = slice('function Enable-Rendezvous', 'function Disable-Rendezvous')
      .split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
    assert.ok(!/\[void\]\(Register-RendezvousTask\)/.test(enable), 'the registration result must not be discarded');
    assert.match(enable, /\$taskOk = /);
    assert.match(enable, /Register-RendezvousTask/);
    assert.match(enable, /if\(-not \$taskOk\)/);
    // And it only attempts registration when the task is absent: re-registering
    // needs an administrator every time, so an -Enable that always tried it
    // turned the ordinary unelevated ON press into a guaranteed "Access is
    // denied" on a machine that was already correctly set up.
    assert.match(enable, /if\(Test-RendezvousTaskPresent\)\{ \$true \}/);
    assert.match(enable, /Invoke-RendezvousStateUpdate/, 'the failure has to reach the state document the tray renders');
  });

  check('a loop that starts clears the connected claim it inherited from a dead one', () => {
    // Nothing cleared `connected` when a loop died, at a reboot, or on entry, so
    // a machine whose loop had been killed kept publishing "connected: true"
    // forever -- and the packet's CONNECT.ps1 gates on exactly that field and
    // SKIPS re-enabling. The one state that must never be inferred is the one
    // claiming the link is fine.
    const loop = slice('function Start-RendezvousLoop', 'function Save-RendezvousLoopState');
    const entry = loop.slice(0, loop.indexOf('while($true)'));
    assert.match(entry, /\$current\.connected = \$false/, 'entry must clear the inherited connected claim');
    assert.ok(!/\$current\.armed\s*=/.test(entry), 'entry must not touch the owner switch');
    assert.ok(!/\$current\.generation\s*=/.test(entry), 'entry must not touch the agreed credential');
  });

  check('the named objects are global, so a session-0 loop is visible to the interactive side', () => {
    // The loop runs as an S4U task in session 0 while -Status, -Disable and the
    // panel run in the owner's session. A Local\ name is per-session: the
    // interactive side would see no loop at all, -Enable would start a second
    // one that cannot bind, and -Disable's stop event would be set in a
    // namespace nobody is listening to -- an off switch that silently does
    // nothing. Global\ is what tools/full-remote-access-control.ps1 already uses.
    const names = slice('$script:TaskName         =', '# --- deadlines');
    assert.match(names, /\$script:LoopMutexName\s+= 'Global\\/);
    assert.match(names, /\$script:StateMutexName\s+= 'Global\\/);
    assert.match(names, /\$script:StopEventName\s+= 'Global\\/);
    assert.ok(!/'Local\\ServerControlMechanicalConnect/.test(engineText), 'no Local\\ name may survive anywhere in the engine');
  });

  check('the panel launches the toggle hidden and never handles a secret', () => {
    const action = panelText.slice(
      panelText.indexOf('function Invoke-MechanicalConnectAction'),
      panelText.indexOf('function Get-MechanicalConnectTrayText')
    );
    assert.ok(action.length > 100);
    assert.match(action, /Start-HiddenPowerShellProcess/);
    assert.match(action, /'-WindowStyle','Hidden'/);
    assert.match(action, /'-NonInteractive'/);
    assert.ok(!/RunAs/.test(action), 'the toggle must not elevate');
    // What the panel must never do is HANDLE the credential: no vault CLI, no
    // stdin write. Naming the key is a different thing -- the panel tells the
    // owner which credential is missing, which is the whole point of a status
    // line, and the name is not the value. So the vault-operation strings stay
    // forbidden and the key name does not.
    for (const forbidden of ['set-stdin', 'secrets.ps1']) {
      assert.ok(!panelText.includes(forbidden), `the panel must not reference ${forbidden}`);
    }
    for (const line of panelText.split('\n').filter(text => text.includes('full_remote_access_token'))) {
      assert.match(line, /Set-AccessStatus|"|'/, `the panel may only name the key in a message: ${line.trim()}`);
    }
  });

  check('the tray tooltip surfaces the connect state through Set-Tray', () => {
    assert.match(panelText, /\$mech=Get-MechanicalConnectTrayText/);
    const trayCalls = panelText.split(/\r?\n/).filter(line => /Set-Tray \$ico/.test(line));
    assert.equal(trayCalls.length, 3);
    for (const line of trayCalls) {
      assert.ok(/\$mech/.test(line), `Set-Tray call missing the connect state: ${line.trim()}`);
    }
    assert.match(panelText, /return 'Auto-connect: connected'/);
    assert.match(panelText, /return 'Auto-connect: waiting for peer'/);
  });

  check('the tray has a distinct text for every way this can go wrong', () => {
    const text = panelText.slice(
      panelText.indexOf('function Get-MechanicalConnectTrayText'),
      panelText.indexOf('function Get-MechanicalConnectMenuText')
    );
    assert.ok(text.length > 200);
    // Everything that was not off/connected/no-link used to collapse into
    // "waiting for peer" - including a port that could not be opened, a split
    // credential, and a bridge that never came back. A self-inflicted,
    // permanent failure was rendered as patient waiting.
    const states = [
      'Auto-connect: not installed',
      'Auto-connect: state unavailable',
      'Auto-connect: needs attention',
      'Auto-connect: off',
      'Auto-connect: stopped',
      'Auto-connect: connected',
      'Auto-connect: waiting for cable',
      'Auto-connect: waiting for peer'
    ];
    for (const state of states) {
      assert.ok(text.includes(`'${state}'`), `the tray cannot say: ${state}`);
    }
    assert.equal(new Set(states).size, states.length, 'two states must never render identically');
    // The NotifyIcon fallback rejects a Text longer than 63 characters, and
    // the whole tooltip is prefixed with the server summary.
    const prefix = 'Servers: all stopped  /  '.length;
    for (const state of states) {
      assert.ok(prefix + state.length <= 63, `"${state}" would overflow the tray tooltip`);
    }
  });

  check('a state file that cannot be read is not silently reported as off', () => {
    // Executable text only: the comment in there names Get-Content in order to
    // explain why it is banned.
    const reader = panelText.slice(
      panelText.indexOf('function Read-MechanicalConnectState'),
      panelText.indexOf('function Test-MechanicalConnectEngine')
    ).split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
    assert.ok(reader.length > 200);
    // Two separate defects: a fabricated armed=$false default made a corrupt
    // or mid-rename read indistinguishable from the owner switching it off,
    // and a Get-Content that does not share DELETE makes the engine's own
    // atomic replace fail from the other side.
    assert.match(reader, /return \$null/);
    assert.ok(!/armed=\$false/.test(reader), 'a read failure must not fabricate a switch position');
    assert.match(reader, /\[System\.IO\.FileShare\]::ReadWrite -bor \[System\.IO\.FileShare\]::Delete/);
    assert.ok(!/Get-Content/.test(reader), 'Get-Content does not share DELETE with the writer');
    assert.match(panelText, /Auto-connect: state unavailable/);
  });

  check('the reason a switch is unhappy reaches the owner without opening a file', () => {
    const menuText = panelText.slice(
      panelText.indexOf('function Get-MechanicalConnectMenuText'),
      panelText.indexOf('function Update-MechanicalConnectTray')
    );
    assert.ok(menuText.length > 100);
    // `detail` is the only field that says what actually broke, and nothing
    // displayed it anywhere.
    assert.match(menuText, /\$detail=\[string\]\$state\.detail/);
    assert.match(menuText, /return \$detail/);
    assert.match(panelText, /\$script:miTunnelStatus\.Text=/);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().then(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (error) { /* best effort */ }
}).catch(error => {
  process.stdout.write(`  FAIL  suite crashed: ${error && error.stack}\n`);
  process.exitCode = 1;
});
