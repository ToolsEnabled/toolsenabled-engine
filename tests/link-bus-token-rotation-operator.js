// EXECUTABLE CHANGE
/*
 * Assertion strengthened: the LINK_BUS_HOST checks in
 * testExactLauncherIsShellFreeAndEnvironmentPinned previously derived their
 * expected value by calling machineForId(), the same resolver used by the
 * launcher under test.  Mutation: machineForId() was temporarily changed to
 * return 198.51.100.77.  Before this change the test stayed green.  With the
 * independent registry expectation below it went red with:
 *
 *   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *   + actual - expected
 *   + '198.51.100.77'
 *   - '203.0.113.2'
 *
 * The resolver mutation was restored byte-for-byte.  Against the same valid
 * two-machine registry fixture, the restored source then went green with:
 *
 *   link-bus-token-rotation-operator: all focused tests passed
 *
 * Census: empty loop/forEach assertions NOT-FOUND; exit-status/truthy-return
 * assertions supported only by subject output NOT-FOUND; swallowed failures
 * via catch/optional chaining NOT-FOUND; assertions against a mock of the
 * behavior under test NOT-FOUND (the injected fs/spawn/inspect/probe doubles
 * expose interactions and their effects are asserted); silent skips or
 * platform guards NOT-FOUND; same-code expected values FOUND and fixed above.
 *
 * The checks use a disposable customer-neutral two-computer registry. They do
 * not depend on an operator's installed machine names or service-registry
 * state.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OFFER_AUTH_ALGORITHM,
  VERIFICATION_SCHEMA,
  verifyVerificationReceiptWithSigner
} = require('../tools/lib/link-bus-token-rotation');
const {
  childEnvironment,
  launchExact
} = require('../tools/link-bus-exact-launch');
const {
  verifyRotation
} = require('../tools/link-bus-token-rotation-verify');
const {
  runLocalControl
} = require('../tools/link-bus-token-rotation-local');
// Disposable customer topology: the shipped registry is intentionally not an
// operator's private two-machine installation. The expected address is still
// read independently from the declarative input while the production resolver
// consumes that same input through its supported injection seam.
const SERVICE_REGISTRY = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'customer-left': Object.freeze({ address: '203.0.113.2' }),
    'customer-right': Object.freeze({ address: '203.0.113.3' })
  }),
  services: Object.freeze({})
});
const SERVICE_REGISTRY_OPTIONS = Object.freeze({ registry: SERVICE_REGISTRY });
const COORDINATOR_ADDRESS = SERVICE_REGISTRY.machines['customer-left'].address;
const IPV4_LITERAL_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

const fsPromises = fs.promises;
const OPERATION_ID = Buffer.alloc(16, 0x71).toString('base64url');
const TOKEN_SHA256 = Buffer.alloc(32, 0x72).toString('base64url');
const RECEIPT_KEY = Buffer.alloc(32, 0x73);

async function signReceipt(canonical, key = RECEIPT_KEY) {
  return crypto.createHmac('sha256', key)
    .update(canonical)
    .digest('base64url');
}

async function authenticateReceipt({ receipt, state }) {
  return verifyVerificationReceiptWithSigner({
    receipt,
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    signCanonical: canonical => signReceipt(canonical)
  });
}

function testExactLauncherIsShellFreeAndEnvironmentPinned() {
  const previous = {
    LINK_BUS_HOST: process.env.LINK_BUS_HOST,
    LINK_BUS_PORT: process.env.LINK_BUS_PORT,
    LINK_BUS_STATE_DIR: process.env.LINK_BUS_STATE_DIR,
    TOOLSENABLED_VAULT_PATH: process.env.TOOLSENABLED_VAULT_PATH
  };
  process.env.LINK_BUS_HOST = '0.0.0.0';
  process.env.LINK_BUS_PORT = '9999';
  process.env.LINK_BUS_STATE_DIR = 'C:\\poisoned-state';
  process.env.TOOLSENABLED_VAULT_PATH = 'C:\\poisoned-vault.json';
  try {
    const env = childEnvironment(path.resolve('synthetic-fixed-state'), {
      serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS
    });
    assert.equal(env.LINK_BUS_HOST, COORDINATOR_ADDRESS);
    assert.equal(env.LINK_BUS_PORT, '8787');
    assert.equal(env.LINK_BUS_STATE_DIR, path.resolve('synthetic-fixed-state'));
    assert.equal(
      Object.hasOwn(env, 'TOOLSENABLED_VAULT_PATH'),
      false
    );

    const opened = [];
    const closed = [];
    let spawnRecord;
    let unrefCalls = 0;
    const result = launchExact({
      repoRoot: path.resolve('synthetic-tools-enabled'),
      fsImpl: {
        statSync: () => ({ isFile: () => true }),
        mkdirSync: () => {},
        openSync: target => {
          opened.push(target);
          return opened.length + 10;
        },
        closeSync: descriptor => closed.push(descriptor)
      },
      spawnImpl: (file, args, options) => {
        spawnRecord = { file, args, options };
        return {
          pid: 45678,
          unref() {
            unrefCalls += 1;
          }
        };
      },
      serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS
    });
    assert.equal(result.pid, 45678);
    assert.equal(spawnRecord.options.windowsHide, true);
    assert.equal(spawnRecord.options.shell, false);
    assert.equal(spawnRecord.options.detached, true);
    assert.equal(spawnRecord.options.env.LINK_BUS_HOST, COORDINATOR_ADDRESS);
    assert.equal(
      Object.hasOwn(
        spawnRecord.options.env,
        'TOOLSENABLED_VAULT_PATH'
      ),
      false
    );
    assert.deepEqual(spawnRecord.options.stdio.slice(0, 1), ['ignore']);
    assert.equal(opened.length, 2);
    assert.deepEqual(closed, [11, 12]);
    assert.equal(unrefCalls, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function testExactLauncherDoesNotReportUnreadableFilesAsMissing() {
  assert.throws(
    () => launchExact({
      repoRoot: path.resolve('synthetic-tools-enabled'),
      fsImpl: {
        statSync: () => {
          const error = new Error('access denied');
          error.code = 'EACCES';
          throw error;
        }
      }
    }),
    error => error.code === 'REQUIRED_FILE_INSPECTION_FAILED' &&
      error.message === 'current Node executable could not be inspected'
  );
}

function testRestartScriptUsesExactIdentityOnly() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'restart-link-bus-exact.ps1'),
    'utf8'
  );
  assert.equal(source.includes('Stop-Process -Id $ExpectedPid'), true);
  assert.equal(/Stop-Process\s+-Name/i.test(source), false);
  assert.equal(/Get-Process\s+-Name/i.test(source), false);
  assert.equal(source.includes('ExpectedCreationDate'), true);
  // This used to require the literal string "LocalAddress '203.0.113.2'".
  // Commit 6653bef deliberately replaced that hardcoded address with
  // $MachineAAddress, derived from the service registry, so the literal check
  // went red for a change that made the script BETTER -- and, worse, it would
  // have pushed a maintainer to hardcode the address again to get green.
  //
  // The property is that the restart binds to the deterministic coordinator
  // address from the customer registry, never to something typed in twice.
  assert.equal(/-LocalAddress\s+\$CoordinatorAddress/.test(source), true,
    'the bind address must come from the service registry, not a literal');
  assert.equal(source.includes('Resolve-ServiceRegistryDirectionalTopology -Root $resolvedRoot'), true);
  assert.equal(source.includes("$Topology.localRole -cne 'coordinator'"), true,
    'only the locally resolved coordinator may replace the coordinator listener');
  assert.equal(source.includes('$CoordinatorAddress = [string]$Topology.coordinatorMachine.address'), true);
  assert.equal(source.includes('Resolve-ToolsEnabledNode -Root $resolvedRoot'), true);
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(source), false,
    'no IPv4 literal may reappear in this script');
  assert.equal(source.includes('LocalPort 8787'), true);
  assert.equal(source.includes('remote-agent-bridge'), false);
  assert.equal(source.includes('LocalPort 8788'), false);

  const statusSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'tools',
      'special-session-link-bus-local-status.ps1'
    ),
    'utf8'
  );
  assert.equal(statusSource.includes('LocalPort 8788'), true);
  assert.equal(statusSource.includes('GetOwnerSid'), true);
  assert.equal(statusSource.includes('CommandLine'), true);
  // -Role selects a directional endpoint from the customer registry; no
  // installation-specific machine identifier is embedded in the probe.
  assert.equal(statusSource.includes('Resolve-ServiceRegistryDirectionalTopology -Root $resolvedRoot'), true);
  assert.equal(statusSource.includes('$topology.coordinatorMachine'), true);
  assert.equal(statusSource.includes('$topology.recipientMachine'), true);
  assert.equal(statusSource.includes('Resolve-ToolsEnabledNode -Root $resolvedRoot'), true);
  assert.doesNotMatch(statusSource, /\bmachine-[ab]\b|\bMachine [AB]\b/i);
  assert.equal(IPV4_LITERAL_RE.test(statusSource), false,
    'no IPv4 literal may reappear in the status probe');

  const probeSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'tools',
      'special-session-link-bus-token-probe.ps1'
    ),
    'utf8'
  );
  // The origin is built from the registry's deterministic coordinator;
  // only the protocol port stays literal.
  assert.equal(probeSource.includes('Resolve-ServiceRegistryDirectionalTopology -Root $repoRoot'), true);
  assert.equal(probeSource.includes("$topology.localRole -cne 'recipient'"), true);
  assert.equal(probeSource.includes('$coordinatorAddress = [string]$topology.coordinatorMachine.address'), true);
  assert.equal(
    probeSource.includes("$relayOrigin = 'http://' + $coordinatorAddress + ':8787'"),
    true,
    'the probe origin must be built from the resolved address'
  );
  assert.doesNotMatch(probeSource, /\bmachine-[ab]\b|\bMachine [AB]\b/i);
  assert.equal(probeSource.includes("$uri = $relayOrigin + '/health'"), true);
  assert.equal(
    probeSource.includes(
      "$uri = $relayOrigin + '/v1/messages?channel=rotation-probe&cursor=0&limit=1'"
    ),
    true
  );
  assert.equal(IPV4_LITERAL_RE.test(probeSource), false,
    'no IPv4 literal may reappear in the token probe');
  assert.equal(
    probeSource.includes("$expectedKeyId = 'custom.link_bus_bridge_token'"),
    true
  );
  assert.equal(probeSource.includes('$request.Proxy = $null'), true);
  assert.equal(probeSource.includes('[Console]::Out.Write'), true);
}

function fakeState(root, phase = 'committed') {
  return {
    phase,
    operationId: OPERATION_ID,
    newTokenSha256: TOKEN_SHA256,
    canonicalPath: path.join(root, 'vault', 'secrets.json'),
    backupPath: path.join(root, 'vault', 'old.encrypted.bak'),
    failedNewPath: path.join(root, 'vault', 'failed-new.encrypted.bak'),
    verification: null
  };
}

async function testVerifierAndLocalFinalizeGates() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'link-bus-token-rotation-operator-')
  );
  try {
    const state = fakeState(root);
    let markedReceipt = null;
    let finalized = false;
    const transaction = {
      repoRoot: root,
      paths: {
        statePath: path.join(root, 'vault', '.state.json')
      },
      deps: {
        fs: fsPromises,
        restrictAcl: async () => {}
      },
      async status() {
        return { ...state, verification: markedReceipt };
      },
      async markVerified(receipt) {
        markedReceipt = receipt;
        state.phase = 'verified';
        return { ...state, verification: receipt };
      },
      async finalize() {
        finalized = true;
        state.phase = 'finalized';
        return { ...state, verification: markedReceipt };
      }
    };
    const probe = async ({ mode, vaultPath }) => {
      if (mode === 'Health') return 200;
      if (vaultPath === state.canonicalPath) return 200;
      if (vaultPath === state.backupPath) return 401;
      throw new Error('unexpected probe');
    };
    const verified = await verifyRotation({
      repoRoot: root,
      mode: 'post-restart',
      expectedListenerPid: 54321,
      expectedListenerCreationDate: '20260730120000.000000-420',
      transaction,
      probe,
      inspect: async () => ({
        valid: true,
        role: 'b',
        port8788Closed: true
      }),
      signReceipt,
      now: 1800000002000
    });
    assert.equal(verified.status, 'post_restart_verified');
    assert.equal(markedReceipt.listenerPid, 54321);
    const receiptText = await fsPromises.readFile(
      verified.receiptPath,
      'utf8'
    );
    assert.equal(receiptText.includes('Bearer'), false);
    assert.equal(receiptText.includes('ciphertext'), false);
    assert.deepEqual(JSON.parse(receiptText), {
      schemaVersion: VERIFICATION_SCHEMA,
      operationId: OPERATION_ID,
      tokenSha256: TOKEN_SHA256,
      healthStatus: 200,
      newTokenStatus: 200,
      oldTokenStatus: 401,
      port8788Closed: true,
      listenerPid: 54321,
      listenerCreationDate: '20260730120000.000000-420',
      verifiedAt: 1800000002000,
      signatureAlgorithm: OFFER_AUTH_ALGORITHM,
      proof: markedReceipt.proof
    });
    await authenticateReceipt({
      receipt: markedReceipt,
      state
    });
    const verifiedAgain = await verifyRotation({
      repoRoot: root,
      mode: 'post-restart',
      expectedListenerPid: 54321,
      expectedListenerCreationDate: '20260730120000.000000-420',
      transaction,
      probe,
      inspect: async () => ({
        valid: true,
        role: 'b',
        port8788Closed: true
      }),
      signReceipt,
      now: 1800000003000
    });
    assert.equal(verifiedAgain.receiptPath, verified.receiptPath);
    assert.equal(markedReceipt.verifiedAt, 1800000002000);

    const inspectCalls = [];
    const tamperedReceiptPath = path.join(root, 'tampered-receipt.json');
    await fsPromises.writeFile(
      tamperedReceiptPath,
      `${JSON.stringify({
        ...JSON.parse(receiptText),
        listenerPid: 54322
      })}\n`,
      'utf8'
    );
    let tamperedInspectCalled = false;
    await assert.rejects(
      runLocalControl({
        repoRoot: root,
        role: 'a',
        action: 'accept-verification',
        receiptPath: tamperedReceiptPath,
        transaction: {
          ...transaction,
          async status() {
            return {
              ...fakeState(root),
              phase: 'committed'
            };
          }
        },
        authenticateReceipt,
        inspect: async () => {
          tamperedInspectCalled = true;
          throw new Error('tampered receipt reached process inspection');
        }
      }),
      error => error.code === 'VERIFICATION_AUTHENTICATION_FAILED'
    );
    assert.equal(tamperedInspectCalled, false);

    const accepted = await runLocalControl({
      repoRoot: root,
      role: 'a',
      action: 'accept-verification',
      receiptPath: verified.receiptPath,
      transaction: {
        ...transaction,
        async status() {
          return {
            ...fakeState(root),
            phase: 'committed'
          };
        },
        async markVerified(receipt) {
          markedReceipt = receipt;
          return {
            ...fakeState(root),
            phase: 'verified',
            verification: receipt
          };
        }
      },
      authenticateReceipt,
      inspect: async input => {
        inspectCalls.push(input);
        return {
          valid: true,
          role: 'a',
          listenerPid: input.expectedPid,
          listenerCreationDate: input.expectedCreationDate,
          port8788Closed: true
        };
      }
    });
    assert.equal(accepted.status, 'verification_accepted');
    assert.equal(inspectCalls[0].expectedPid, 54321);
    assert.equal(
      inspectCalls[0].expectedCreationDate,
      '20260730120000.000000-420'
    );

    const finalizedResult = await runLocalControl({
      repoRoot: root,
      role: 'b',
      action: 'finalize',
      transaction,
      authenticateReceipt,
      inspect: async input => {
        inspectCalls.push(input);
        return {
          valid: true,
          role: 'b',
          port8788Closed: true
        };
      }
    });
    assert.equal(finalizedResult.status, 'finalized');
    assert.equal(finalized, true);

    const failingState = fakeState(root);
    await assert.rejects(
      verifyRotation({
        repoRoot: root,
        mode: 'post-restart',
        expectedListenerPid: 54321,
        expectedListenerCreationDate: '20260730120000.000000-420',
        transaction: {
          ...transaction,
          async status() {
            return failingState;
          }
        },
        inspect: async () => ({
          valid: true,
          role: 'b',
          port8788Closed: true
        }),
        signReceipt,
        probe: async ({ mode, vaultPath }) => (
          mode === 'Health'
            ? 200
            : vaultPath === failingState.canonicalPath
              ? 200
              : 200
        )
      }),
      error => error.code === 'POST_RESTART_VERIFICATION_FAILED'
    );

    let closedPortSignerCalls = 0;
    await assert.rejects(
      verifyRotation({
        repoRoot: root,
        mode: 'post-restart',
        expectedListenerPid: 54321,
        expectedListenerCreationDate: '20260730120000.000000-420',
        transaction: {
          ...transaction,
          async status() {
            return failingState;
          }
        },
        inspect: async () => ({
          valid: false,
          role: 'b',
          port8788Closed: false
        }),
        signReceipt: async canonical => {
          closedPortSignerCalls += 1;
          return signReceipt(canonical);
        },
        probe
      }),
      error => error.code === 'POST_RESTART_VERIFICATION_FAILED'
    );
    assert.equal(closedPortSignerCalls, 0);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  testExactLauncherIsShellFreeAndEnvironmentPinned();
  testExactLauncherDoesNotReportUnreadableFilesAsMissing();
  testRestartScriptUsesExactIdentityOnly();
  await testVerifierAndLocalFinalizeGates();
  process.stdout.write(
    'link-bus-token-rotation-operator: all focused tests passed\n'
  );
}

main().catch(error => {
  process.stderr.write(
    `link-bus-token-rotation-operator failed: ${
      error && error.code || 'TEST_FAILED'
    } ${error && error.stack || error && error.message || ''}\n`
  );
  process.exitCode = 1;
});
