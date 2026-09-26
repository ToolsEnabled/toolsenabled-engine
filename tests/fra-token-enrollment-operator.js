/* EXECUTABLE CHANGE
 *
 * Assertion strengthened: sourceContractHasNoAutomaticReload now requires one
 * protected-pipe definition and one protected-pipe call, in addition to pinning
 * their order and excluding raw constructions at the call site.
 *
 * Mutation: in a temporary edit, replaced `$pipe = New-ProtectedPipeServer` in
 * fra-token-enrollment-vault-helper.ps1 with a raw NamedPipeServerStream call.
 * RED (exit 1):
 * "AssertionError [ERR_ASSERTION]: the enrollment pipe must have exactly one
 * protected construction call\n\n0 !== 1"
 *
 * Restoration: SHA-256 before and after was
 * 139975e648fc1f56469559c1cc5705fe53ee2d4653147a655b36fc32e408e49e.
 * The restored run passed this assertion and continued to the Windows-only ACL
 * integration check, where this Linux host reports status=null:
 * "AssertionError [ERR_ASSERTION]: disposable pipe ACL check failed"
 * A completely green file run therefore requires the unmet precondition of a
 * Windows host with Windows PowerShell available through powerShellPath().
 *
 * NOT-FOUND (1): no assertion body iterates a possibly empty collection; the
 * only assertion loop uses the fixed two-element [receiver, coordinator] list.
 * NOT-FOUND (2): no assertion accepts merely non-zero/truthy process evidence;
 * helper processes require status 0 and clean stderr, and outputs are consumed.
 * NOT-FOUND (3): catches/finalizers do not swallow the expected failure.
 * NOT-FOUND (4): transaction fakes are boundaries for orchestration assertions,
 * not mocks of runEnrollment; the helper bootstrap mock checks launch metadata.
 * NOT-FOUND (5): there is no skip or precondition guard that makes the file pass.
 * NOT-FOUND (6): JS tokenFingerprint is an independent oracle for the PowerShell
 * helper implementation; other expected values are literals or manual hashes.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadWithPairedServiceRegistry } = require('./helpers/paired-service-registry');
const {
  AUTH_VAULT_KEY,
  TARGET_VAULT_KEY,
  TOKEN_FINGERPRINT_DOMAIN,
  createAuthenticatedOfferWrapper,
  createEnrollmentRecipientContext,
  tokenFingerprint
} = require('../tools/lib/fra-token-enrollment');
const {
  PIPE_SCHEMA,
  derivedPaths,
  launchPowerShellHelper,
  powerShellPath,
  runPrivateVaultHelper
} = require('../tools/lib/fra-token-enrollment-vault');
const {
  receiver: {
    createEnrollmentSession,
    DEFAULT_TTL_MS: RECEIVER_DEFAULT_TTL_MS,
    parseCli: parseReceiverCli
  },
  coordinator: {
    parseCli: parseCoordinatorCli,
    pinnedUrl,
    REQUEST_TIMEOUT_MS,
    runEnrollment
  }
} = loadWithPairedServiceRegistry(() => ({
  receiver: require('../tools/fra-token-enrollment-receiver'),
  coordinator: require('../tools/fra-token-enrollment-a')
}));

const NOW = 1_785_620_000_000;
const AUTH_KEY = Buffer.alloc(32, 0x19);
const TOKEN = Buffer.alloc(32, 0x29).toString('base64url');
const CUSTOMER_REGISTRY_OPTIONS = Object.freeze({
  registry: Object.freeze({
    schemaVersion: 1,
    machines: Object.freeze({
      'studio-host': Object.freeze({ address: '192.0.2.40', root: path.resolve(__dirname, '..') }),
      'travel-laptop': Object.freeze({ address: '192.0.2.90', root: path.join(path.resolve(__dirname, '..'), '.test-peer-root') })
    }),
    services: Object.freeze({})
  })
});

async function signCanonical(keyId, bytes) {
  assert.equal(keyId, AUTH_VAULT_KEY);
  return crypto.createHmac('sha256', AUTH_KEY).update(bytes).digest('base64url');
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class FakeTransaction {
  constructor({
    role,
    events,
    previouslyPresent = false,
    failCommit = false,
    failRollback = false
  }) {
    this.role = role;
    this.events = events;
    this.previouslyPresent = previouslyPresent;
    this.failCommit = failCommit;
    this.failRollback = failRollback;
    this.state = null;
  }

  async status() {
    this.events.push(`${this.role}.status`);
    if (!this.state) throw coded('INVALID_STATE');
    return { ...this.state };
  }

  async prepare(token) {
    this.events.push(`${this.role}.prepare`);
    assert.equal(token, TOKEN);
    this.state = {
      phase: 'prepared',
      previouslyPresent: this.previouslyPresent,
      previousFingerprint: this.previouslyPresent
        ? crypto.createHash('sha256').update(`${this.role}.old`).digest('base64url')
        : null,
      newFingerprint: tokenFingerprint(token)
    };
    return { ...this.state };
  }

  async commit() {
    this.events.push(`${this.role}.commit`);
    assert.equal(this.state.phase, 'prepared');
    if (this.failCommit) throw coded('VAULT_COMMIT_FAILED');
    this.state.phase = 'committed';
    return { ...this.state };
  }

  async rollback() {
    this.events.push(`${this.role}.rollback`);
    assert.ok(this.state);
    if (this.failRollback) throw coded('ROLLBACK_RECOVERY_REQUIRED');
    this.state.phase = 'rolled_back';
    return { ...this.state };
  }
}

async function makeHarness({
  loseStageAck = false,
  loseCommitAck = false,
  failLocalCommit = false,
  failLocalRollback = false
} = {}) {
  const events = [];
  let bTransaction;
  const session = await createEnrollmentSession({
    repoRoot: path.resolve(__dirname, '..'),
    now: NOW,
    ttlMs: 60_000,
    serviceRegistryOptions: CUSTOMER_REGISTRY_OPTIONS,
    signCanonical,
    transactionFactory: () => {
      bTransaction = new FakeTransaction({ role: 'b', events, previouslyPresent: true });
      return bTransaction;
    }
  });
  let aTransaction;
  let stageLost = false;
  let commitLost = false;
  const postEnvelope = async ({ action, envelope }) => {
    const ack = await session.handleEnvelope(envelope, NOW);
    if (action === 'stage_b' && loseStageAck && !stageLost) {
      stageLost = true;
      throw coded('HTTP_REQUEST_FAILED');
    }
    if (action === 'commit_b' && loseCommitAck && !commitLost) {
      commitLost = true;
      throw coded('HTTP_REQUEST_FAILED');
    }
    return ack;
  };
  const execute = () => runEnrollment({
    offerWrapper: session.offerWrapper,
    signCanonical,
    postEnvelope,
    repoRoot: path.resolve(__dirname, '..'),
    transactionFactory: () => {
      aTransaction = new FakeTransaction({
        role: 'a',
        events,
        previouslyPresent: false,
        failCommit: failLocalCommit,
        failRollback: failLocalRollback
      });
      return aTransaction;
    },
    tokenGenerator: () => TOKEN,
    now: NOW,
    serviceRegistryOptions: CUSTOMER_REGISTRY_OPTIONS
  });
  return {
    events,
    session,
    execute,
    getATransaction: () => aTransaction,
    getBTransaction: () => bTransaction
  };
}

async function expectCode(action, expected) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected);
}

function expectSyncCode(action, expected) {
  assert.throws(action, error => error && error.code === expected);
}

async function successStagesBothBeforeEitherCommit() {
  const harness = await makeHarness();
  try {
    const result = await harness.execute();
    assert.equal(result.status, 'committed');
    assert.equal(result.listenerReloaded, false);
    assert.equal(harness.getATransaction().state.phase, 'committed');
    assert.equal(harness.getBTransaction().state.phase, 'committed');
    const aPrepared = harness.events.indexOf('a.prepare');
    const bPrepared = harness.events.indexOf('b.prepare');
    const bCommitted = harness.events.indexOf('b.commit');
    const aCommitted = harness.events.indexOf('a.commit');
    assert.ok(aPrepared >= 0 && bPrepared > aPrepared);
    assert.ok(bCommitted > bPrepared);
    assert.ok(aCommitted > bCommitted);
  } finally {
    harness.session.destroy();
  }
}

async function lostStageAckRollsBothBack() {
  const harness = await makeHarness({ loseStageAck: true });
  try {
    await expectCode(harness.execute, 'REMOTE_STAGE_FAILED_ROLLED_BACK');
    assert.equal(harness.getATransaction().state.phase, 'rolled_back');
    assert.equal(harness.getBTransaction().state.phase, 'rolled_back');
    assert.equal(harness.events.includes('a.commit'), false);
    assert.equal(harness.events.includes('b.commit'), false);
  } finally {
    harness.session.destroy();
  }
}

async function lostCommitAckCompensatesSplitCommit() {
  const harness = await makeHarness({ loseCommitAck: true });
  try {
    await expectCode(harness.execute, 'REMOTE_COMMIT_UNCONFIRMED_ROLLED_BACK');
    assert.equal(harness.getATransaction().state.phase, 'rolled_back');
    assert.equal(harness.getBTransaction().state.phase, 'rolled_back');
    assert.ok(harness.events.indexOf('b.commit') >= 0);
    assert.equal(harness.events.includes('a.commit'), false);
    assert.ok(harness.events.indexOf('b.rollback') > harness.events.indexOf('b.commit'));
  } finally {
    harness.session.destroy();
  }
}

async function localCommitFailureRollsRemoteBack() {
  const harness = await makeHarness({ failLocalCommit: true });
  try {
    await expectCode(harness.execute, 'LOCAL_COMMIT_FAILED_ROLLED_BACK');
    assert.equal(harness.getATransaction().state.phase, 'rolled_back');
    assert.equal(harness.getBTransaction().state.phase, 'rolled_back');
    assert.ok(harness.events.indexOf('b.commit') < harness.events.indexOf('a.commit'));
    assert.ok(harness.events.indexOf('b.rollback') > harness.events.indexOf('a.commit'));
  } finally {
    harness.session.destroy();
  }
}

async function incompleteCompensationFailsClosed() {
  const harness = await makeHarness({
    loseCommitAck: true,
    failLocalRollback: true
  });
  try {
    await expectCode(harness.execute, 'ROLLBACK_INCOMPLETE');
    assert.equal(harness.getBTransaction().state.phase, 'rolled_back');
    assert.equal(harness.getATransaction().state.phase, 'prepared');
  } finally {
    harness.session.destroy();
  }
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  body.fill(0);
  return frame;
}

function encodeRawFrame(value) {
  const body = Buffer.from(value);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  body.fill(0);
  return frame;
}

function privatePipeLaunch({
  canary,
  emittedOutput = false,
  observedLaunch,
  unauthenticatedProbe = null
}) {
  return ({ executable, helperPath, pipeName, pipeAuthenticator, repoRoot }) => {
    assert.ok(Buffer.isBuffer(pipeAuthenticator));
    assert.equal(pipeAuthenticator.length, 32);
    const expectedAuthenticator = Buffer.from(pipeAuthenticator);
    observedLaunch.push({
      executable, helperPath, pipeName, repoRoot,
      authenticatorBytes: pipeAuthenticator.length
    });
    assert.equal(JSON.stringify(observedLaunch).includes(canary), false);
    return new Promise((resolve, reject) => {
      const pipePath = `\\\\.\\pipe\\${pipeName}`;
      const server = net.createServer(socket => {
        const chunks = [];
        let total = 0;
        let authenticated = false;
        let closed = false;
        const closeInvalid = () => {
          if (closed) return;
          closed = true;
          if (unauthenticatedProbe) unauthenticatedProbe.closed = true;
          socket.destroy();
        };
        socket.on('data', chunk => {
          if (closed) { chunk.fill(0); return; }
          chunks.push(Buffer.from(chunk));
          total += chunk.length;
          chunk.fill(0);
          try {
            while (true) {
              const combined = Buffer.concat(chunks, total);
              if (combined.length < 4) { combined.fill(0); return; }
              const declared = combined.readUInt32LE(0);
              if (declared <= 0 || declared > 96 * 1024 || combined.length < declared + 4) {
                combined.fill(0);
                return;
              }
              const body = Buffer.from(combined.subarray(4, declared + 4));
              const remainder = Buffer.from(combined.subarray(declared + 4));
              for (const prior of chunks) prior.fill(0);
              chunks.length = 0;
              if (remainder.length > 0) chunks.push(remainder);
              total = remainder.length;
              combined.fill(0);
              if (!authenticated) {
                if (body.length !== expectedAuthenticator.length
                  || !crypto.timingSafeEqual(body, expectedAuthenticator)) {
                  body.fill(0);
                  closeInvalid();
                  return;
                }
                body.fill(0);
                authenticated = true;
                continue;
              }
              const request = JSON.parse(body.toString('utf8'));
              body.fill(0);
              assert.equal(request.tokenBase64Url, canary);
              const response = encodeFrame({
                schemaVersion: PIPE_SCHEMA,
                ok: true,
                action: 'test'
              });
              closed = true;
              socket.end(response, () => {
                response.fill(0);
                server.close(() => resolve({
                  code: 0,
                  signal: null,
                  stdoutBytes: emittedOutput ? 1 : 0,
                  stderrBytes: 0
                }));
              });
              return;
            }
          } catch (error) {
            reject(error);
            socket.destroy();
          }
        });
        socket.on('error', error => {
          if (!closed && !unauthenticatedProbe) reject(error);
        });
      });
      server.once('error', reject);
      server.listen({ path: pipePath, readableAll: false, writableAll: false }, () => {
        if (!unauthenticatedProbe) return;
        const attacker = net.createConnection(pipePath);
        attacker.once('connect', () => {
          const invalidAuthentication = encodeRawFrame(Buffer.alloc(32, 0x7f));
          attacker.write(invalidAuthentication, () => invalidAuthentication.fill(0));
        });
        attacker.on('data', chunk => {
          unauthenticatedProbe.receivedBytes += chunk.length;
          chunk.fill(0);
        });
        attacker.on('error', () => {});
      });
    });
  };
}

async function privatePipeHasNoArgvEnvOrConsoleSecretPath() {
  const canary = Buffer.alloc(32, 0x39).toString('base64url');
  const observedLaunch = [];
  const request = {
    schemaVersion: PIPE_SCHEMA,
    action: 'set_candidate',
    authKeyId: AUTH_VAULT_KEY,
    targetKey: TARGET_VAULT_KEY,
    role: 'a',
    operationId: Buffer.alloc(16, 0x49).toString('base64url'),
    tokenBase64Url: canary
  };
  const response = await runPrivateVaultHelper({
    request,
    repoRoot: path.resolve(__dirname, '..'),
    launchHelper: privatePipeLaunch({ canary, observedLaunch })
  });
  assert.equal(response.ok, true);
  assert.equal(observedLaunch.length, 1);
  assert.equal(JSON.stringify(observedLaunch[0]).includes(canary), false);

  const unauthenticatedProbe = { receivedBytes: 0, closed: false };
  const authenticatedResponse = await runPrivateVaultHelper({
    request,
    repoRoot: path.resolve(__dirname, '..'),
    launchHelper: privatePipeLaunch({
      canary,
      observedLaunch: [],
      unauthenticatedProbe
    })
  });
  assert.equal(authenticatedResponse.ok, true);
  assert.equal(unauthenticatedProbe.closed, true);
  assert.equal(unauthenticatedProbe.receivedBytes, 0,
    'unauthenticated pipe client received secret-bearing request bytes');

  await expectCode(() => runPrivateVaultHelper({
    request,
    repoRoot: path.resolve(__dirname, '..'),
    launchHelper: privatePipeLaunch({
      canary,
      emittedOutput: true,
      observedLaunch: []
    })
  }), 'HELPER_CONSOLE_OUTPUT');
}

async function helperBootstrapStaysOutOfProcessMetadata() {
  const pipeName = 'toolsenabled-fra-enroll-test-metadata';
  const authenticator = Buffer.alloc(32, 0x5a);
  let observedArgs;
  let observedOptions;
  let observedBootstrap;
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (value, callback) => {
    observedBootstrap = Buffer.from(value);
    callback();
  };
  child.stdin.end = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const result = await launchPowerShellHelper({
    executable: 'powershell.exe',
    helperPath: 'C:\\private-helper.ps1',
    pipeName,
    pipeAuthenticator: authenticator,
    repoRoot: 'C:\\private-root',
    timeoutMs: 1000,
    spawnImpl: (executable, args, options) => {
      observedArgs = [executable, ...args];
      observedOptions = options;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    }
  });
  try {
    assert.deepEqual(result, { code: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 });
    assert.ok(Buffer.isBuffer(observedBootstrap));
    assert.equal(observedArgs.includes(pipeName), false);
    assert.equal(JSON.stringify(observedArgs).includes(authenticator.toString('base64')), false);
    assert.equal(JSON.stringify(observedArgs).includes(authenticator.toString('hex')), false);
    assert.equal(JSON.stringify(observedOptions.env).includes(pipeName), false);
    assert.equal(JSON.stringify(observedOptions.env).includes(authenticator.toString('base64')), false);
    assert.equal(JSON.stringify(observedOptions.env).includes(authenticator.toString('hex')), false);
  } finally {
    authenticator.fill(0);
    if (observedBootstrap) observedBootstrap.fill(0);
  }
}

async function sourceContractHasNoAutomaticReload() {
  const helper = await fsp.readFile(
    path.join(__dirname, '..', 'tools', 'fra-token-enrollment-vault-helper.ps1'),
    'utf8'
  );
  const receiver = await fsp.readFile(
    path.join(__dirname, '..', 'tools', 'fra-token-enrollment-receiver.js'),
    'utf8'
  );
  const coordinator = await fsp.readFile(
    path.join(__dirname, '..', 'tools', 'fra-token-enrollment-a.js'),
    'utf8'
  );
  const paramBlock = helper.match(/param\([\s\S]*?\)/i);
  assert.ok(paramBlock);
  assert.equal(/Token|VaultPath|KeyId|Secret/i.test(paramBlock[0]), false);
  assert.equal(/\bWrite-(?:Host|Output|Verbose|Debug|Information)\b/i.test(helper), false);
  assert.match(helper, /NamedPipeServerStream/);
  assert.match(helper, /PipeSecurity/);
  assert.match(helper, /SetAccessRuleProtection\(\$true,\s*\$false\)/);
  assert.match(helper, /PipeAccessRule/);
  assert.match(helper, /S-1-5-18/);
  assert.match(helper, /S-1-5-32-544/);
  assert.match(helper, /PipeOptions\]::Asynchronous/);
  assert.doesNotMatch(helper, /PipeOptions\]::Inheritable/);
  assert.doesNotMatch(helper, /NamedPipeClientStream/);
  assert.doesNotMatch(helper, /readableAll|writableAll/);
  /* THE ANCHOR LANDED ON THE DEFINITION, 397 LINES ABOVE THE CALL.
   *
   * `helper.indexOf('New-ProtectedPipeServer')` returns the FIRST occurrence,
   * which is `function New-ProtectedPipeServer {` at line 120 (offset 4362). The
   * call this ordering claim is about is at line 517 (offset 19207). So the
   * comparison was 19243 > 4362 -- true no matter what happens at the call site,
   * and true even if the symbol were renamed out of existence, since indexOf
   * would then return -1 and every offset is greater than -1.
   *
   * MEASURED: replacing the call with a raw
   * `New-Object IO.Pipes.NamedPipeServerStream(...)` -- an enrollment pipe with no
   * PipeSecurity, no SetAccessRuleProtection and no SID restriction at all -- left
   * this suite green. The assertions at the top of this block survive it too,
   * because the unused function definition still contains every string they look
   * for.
   *
   * Anchor on the CALL SITE, whose text occurs exactly once, and pin the invariant
   * that actually matters: the one raw pipe construction lives inside the
   * protected constructor and nowhere else. */
  const protectedDefAt = helper.indexOf('function New-ProtectedPipeServer');
  const pipeCreateAt = helper.indexOf('$pipe = New-ProtectedPipeServer');
  const waitAt = helper.indexOf('$pipe.WaitForConnection()');
  const readAt = helper.indexOf('$receivedAuthenticator = Read-PipeFrame');
  assert.equal(helper.split('function New-ProtectedPipeServer').length - 1, 1,
    'the protected pipe constructor must have exactly one unambiguous definition');
  assert.equal(helper.split('$pipe = New-ProtectedPipeServer').length - 1, 1,
    'the enrollment pipe must have exactly one protected construction call');
  assert.notEqual(protectedDefAt, -1, 'the helper must still define New-ProtectedPipeServer');
  assert.notEqual(pipeCreateAt, -1,
    'the helper must build its pipe through New-ProtectedPipeServer, not a raw NamedPipeServerStream');
  assert.notEqual(waitAt, -1, 'the helper must still wait for a connection');
  assert.notEqual(readAt, -1, 'the helper must still read the authenticator frame');
  const rawPipeConstructions = helper.split('New-Object IO.Pipes.NamedPipeServerStream').length - 1;
  assert.equal(rawPipeConstructions, 1,
    'a NamedPipeServerStream is constructed outside New-ProtectedPipeServer, so an enrollment pipe can exist with no ACL');
  const rawPipeAt = helper.indexOf('New-Object IO.Pipes.NamedPipeServerStream');
  assert.ok(rawPipeAt > protectedDefAt && rawPipeAt < pipeCreateAt,
    'the only raw pipe construction must live inside New-ProtectedPipeServer, which applies the ACL');
  assert.ok(pipeCreateAt > protectedDefAt, 'the call must follow its definition');
  assert.ok(waitAt > pipeCreateAt, 'the protected pipe must exist before anything waits on it');
  assert.ok(readAt > waitAt, 'the authenticator frame must be read only after a connection');
  for (const source of [receiver, coordinator]) {
    assert.equal(/Restart-Service|Start-Service|Stop-Service|Start-Process/i.test(source), false);
    assert.equal(/full-remote-access-control\.ps1/i.test(source), false);
    assert.equal(/listenerReloaded:\s*true/i.test(source), false);
  }
}

function disposablePipeAclRefusesUnapprovedSid() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$owner=([Security.Principal.WindowsIdentity]::GetCurrent()).User",
    "if($null -eq $owner){throw 'owner missing'}",
    "$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$administrators=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    '$security=New-Object IO.Pipes.PipeSecurity',
    '$security.SetAccessRuleProtection($true,$false)',
    '$allow=[Security.AccessControl.AccessControlType]::Allow',
    '$full=[IO.Pipes.PipeAccessRights]::FullControl',
    'foreach($identity in @($owner,$system,$administrators)){ $security.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($identity,$full,$allow))) }',
    "$name='toolsenabled-fra-acl-test-'+[Guid]::NewGuid().ToString('N')",
    '$pipe=New-Object IO.Pipes.NamedPipeServerStream($name,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,0,0,$security)',
    'try {',
    '  $rules=$pipe.GetAccessControl().GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])',
    '  $sids=@($rules | ForEach-Object { $_.IdentityReference.Value })',
    "  if(-not ($sids -contains $owner.Value -and $sids -contains 'S-1-5-18' -and $sids -contains 'S-1-5-32-544')){exit 2}",
    "  if($sids -contains 'S-1-5-32-545'){exit 3}",
    '} finally { $pipe.Dispose() }'
  ].join('\n');
  const result = spawnSync(powerShellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    env: minimalPowerShellEnvironment(),
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024
  });
  assert.equal(result.status, 0, result.stderr || 'disposable pipe ACL check failed');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

function operatorEntryPointsAreExplicitAndPinned() {
  assert.equal(RECEIVER_DEFAULT_TTL_MS, 2 * 60 * 60 * 1000);
  assert.equal(REQUEST_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  expectSyncCode(() => parseReceiverCli([]), 'EXECUTION_CONFIRMATION_REQUIRED');
  expectSyncCode(() => parseCoordinatorCli([]), 'EXECUTION_CONFIRMATION_REQUIRED');
  assert.equal(
    parseReceiverCli(['--execute-fra-token-enrollment-receiver']).port,
    8792
  );
  assert.equal(
    parseCoordinatorCli(['--execute-fra-token-enrollment']).port,
    8792
  );
  expectSyncCode(() => pinnedUrl(
    'http://127.0.0.1:8792/v1/fra-token-enrollment/offer',
    '/v1/fra-token-enrollment/offer',
    8792
  ), 'URL_PIN_MISMATCH');
  expectSyncCode(() => pinnedUrl(
    'http://203.0.113.1:8792/v1/fra-token-enrollment/command?x=1',
    '/v1/fra-token-enrollment/command',
    8792
  ), 'URL_PIN_MISMATCH');
}

function minimalPowerShellEnvironment() {
  const env = Object.create(null);
  for (const name of [
    'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'ProgramData'
  ]) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return env;
}

async function realHelperRunsOnlyAgainstDisposableVault() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fra-enroll-helper-'));
  const toolsDirectory = path.join(root, 'tools');
  const vaultDirectory = path.join(root, 'vault');
  const helperPath = path.join(toolsDirectory, 'fra-token-enrollment-vault-helper.ps1');
  const sourceHelper = path.join(
    __dirname,
    '..',
    'tools',
    'fra-token-enrollment-vault-helper.ps1'
  );
  const authSecret = Buffer.alloc(32, 0x59).toString('base64url');
  const legacyToken = Buffer.alloc(30, 0x68).toString('base64url');
  const token = Buffer.alloc(32, 0x69).toString('base64url');
  const rotatedToken = Buffer.alloc(32, 0x6a).toString('base64url');
  let input;
  let encrypted;
  let legacyInput;
  let legacyEncrypted;
  try {
    await fsp.mkdir(toolsDirectory);
    await fsp.mkdir(vaultDirectory);
    await fsp.copyFile(sourceHelper, helperPath);
    const encryptScript = [
      "$ErrorActionPreference='Stop'",
      '$records=[Console]::In.ReadToEnd() | ConvertFrom-Json',
      '$result=[ordered]@{}',
      'foreach($record in $records){',
      '  $secure=ConvertTo-SecureString -String ([string]$record.value) -AsPlainText -Force',
      '  try{$result[[string]$record.key]=ConvertFrom-SecureString -SecureString $secure}finally{$secure.Dispose()}',
      '}',
      '[Console]::Out.Write(($result | ConvertTo-Json -Compress))'
    ].join('\n');
    input = Buffer.from(JSON.stringify([
      { key: AUTH_VAULT_KEY, value: authSecret },
      { key: 'ordinary.test', value: 'ordinary-disposable-value' }
    ]), 'utf8');
    encrypted = spawnSync(powerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      encryptScript
    ], {
      cwd: root,
      env: minimalPowerShellEnvironment(),
      input,
      encoding: null,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024
    });
    input.fill(0);
    input = null;
    assert.equal(encrypted.status, 0, encrypted.stderr.toString('utf8'));
    assert.equal(encrypted.stderr.length, 0);
    await fsp.writeFile(path.join(vaultDirectory, 'secrets.json'), encrypted.stdout);
    encrypted.stdout.fill(0);
    encrypted.stderr.fill(0);

    const canonical = Buffer.from('disposable-signing-input', 'utf8');
    const signResponse = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'sign',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        canonicalBase64Url: canonical.toString('base64url')
      },
      repoRoot: root,
      helperPath
    });
    const expectedProof = crypto.createHmac('sha256', authSecret)
      .update(canonical)
      .digest('base64url');
    canonical.fill(0);
    assert.equal(signResponse.proof, expectedProof);

    const operationId = Buffer.alloc(16, 0x79).toString('base64url');
    const paths = derivedPaths(
      path.join(vaultDirectory, 'secrets.json'),
      'a',
      operationId
    );
    await fsp.copyFile(paths.canonicalPath, paths.candidatePath);
    const before = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        slot: 'canonical'
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(before.exists, false);
    assert.equal(before.fingerprint, null);

    legacyInput = Buffer.from(JSON.stringify([
      { key: AUTH_VAULT_KEY, value: authSecret },
      { key: TARGET_VAULT_KEY, value: legacyToken },
      { key: 'ordinary.test', value: 'ordinary-disposable-value' }
    ]), 'utf8');
    legacyEncrypted = spawnSync(powerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      encryptScript
    ], {
      cwd: root,
      env: minimalPowerShellEnvironment(),
      input: legacyInput,
      encoding: null,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024
    });
    legacyInput.fill(0);
    legacyInput = null;
    assert.equal(legacyEncrypted.status, 0, legacyEncrypted.stderr.toString('utf8'));
    assert.equal(legacyEncrypted.stderr.length, 0);
    await fsp.writeFile(paths.canonicalPath, legacyEncrypted.stdout);
    legacyEncrypted.stdout.fill(0);
    legacyEncrypted.stderr.fill(0);
    await fsp.rm(paths.candidatePath);
    await fsp.copyFile(paths.canonicalPath, paths.candidatePath);
    await fsp.copyFile(paths.canonicalPath, paths.stagedBackupPath);

    const expectedLegacyFingerprint = crypto.createHash('sha256')
      .update(Buffer.from(`${TOKEN_FINGERPRINT_DOMAIN}\0`, 'utf8'))
      .update(Buffer.from(legacyToken, 'utf8'))
      .digest('base64url');
    const legacyCanonical = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        slot: 'canonical'
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(legacyCanonical.exists, true);
    assert.equal(legacyCanonical.fingerprint, expectedLegacyFingerprint);
    const legacyBackup = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        slot: 'stagedBackup'
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(legacyBackup.fingerprint, expectedLegacyFingerprint);
    await expectCode(() => runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        slot: 'candidate'
      },
      repoRoot: root,
      helperPath
    }), 'INVALID_BASE64URL');
    await expectCode(() => runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'set_candidate',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        tokenBase64Url: legacyToken
      },
      repoRoot: root,
      helperPath
    }), 'INVALID_BASE64URL');

    const set = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'set_candidate',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        tokenBase64Url: token
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(set.fingerprint, tokenFingerprint(token));
    const after = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        slot: 'candidate'
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(after.exists, true);
    assert.equal(after.fingerprint, tokenFingerprint(token));

    const rotated = await runPrivateVaultHelper({
      request: {
        schemaVersion: PIPE_SCHEMA,
        action: 'set_candidate',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role: 'a',
        operationId,
        tokenBase64Url: rotatedToken
      },
      repoRoot: root,
      helperPath
    });
    assert.equal(rotated.fingerprint, tokenFingerprint(rotatedToken));
  } finally {
    if (input) input.fill(0);
    if (legacyInput) legacyInput.fill(0);
    if (encrypted && encrypted.stdout) encrypted.stdout.fill(0);
    if (encrypted && encrypted.stderr) encrypted.stderr.fill(0);
    if (legacyEncrypted && legacyEncrypted.stdout) legacyEncrypted.stdout.fill(0);
    if (legacyEncrypted && legacyEncrypted.stderr) legacyEncrypted.stderr.fill(0);
    const resolved = path.resolve(root);
    const temporary = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith('fra-enroll-helper-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

async function run() {
  await successStagesBothBeforeEitherCommit();
  await lostStageAckRollsBothBack();
  await lostCommitAckCompensatesSplitCommit();
  await localCommitFailureRollsRemoteBack();
  await incompleteCompensationFailsClosed();
  await privatePipeHasNoArgvEnvOrConsoleSecretPath();
  await helperBootstrapStaysOutOfProcessMetadata();
  await sourceContractHasNoAutomaticReload();
  operatorEntryPointsAreExplicitAndPinned();
  if (process.platform === 'win32') {
    disposablePipeAclRefusesUnapprovedSid();
    await realHelperRunsOnlyAgainstDisposableVault();
  } else {
    console.log('SKIP disposable named-pipe ACL and DPAPI enrollment helper: require native Windows');
  }
  AUTH_KEY.fill(0);
  console.log('fra-token enrollment operator tests passed');
}

run().catch(error => {
  AUTH_KEY.fill(0);
  console.error(
    error && typeof error.code === 'string' ? `code=${error.code}` : '',
    error && error.stack ? error.stack : error
  );
  process.exitCode = 1;
});
