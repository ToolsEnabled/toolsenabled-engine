// EXECUTABLE CHANGE
// Discrimination report (testcanfail-tests-mission-bridge-bootstrap-auth-test-js):
// - Strengthened cliSurface's bootstrap-proof documentation check. Mutation:
//   in a scratch copy, remove usage()'s four explanatory bootstrap-proof lines.
//   The former /proof/i assertion still passes because the unrelated identifier
//   "bootstrapProofFile" remains in the text; the new assertions require the
//   user-facing requirement and its ?proof= transport, so that mutation fails.
// - RED run precondition not met: this host is Node 20.20.2, which cannot load
//   node:sqlite. The attempted target-file run stopped at module loading with
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite";
//   obtaining Node 22 with `npx -y node@22` was blocked by registry E403.
// - NOT-FOUND (1): no assertion is inside a possibly-empty loop/forEach.
// - NOT-FOUND (2): no assertion treats a child-process exit status or truthy
//   process return as evidence; the ACL stub's status is its configured input.
// - NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure;
//   the two finally blocks only perform unconditional resource cleanup.
// - NOT-FOUND (4): no assertion asks a mock to reproduce the subject's result;
//   the ACL spy records the real mintBootstrapProof call boundary.
// - NOT-FOUND (5): there are no skips or platform precondition guards.
// - NOT-FOUND (6): expected values are literals or independent test inputs, not
//   values computed by the production function being checked.
// - Source restoration: no source file was edited, so code under test remains
//   byte-for-byte unchanged. A final green run could not be made for the named
//   node:sqlite/Node-version precondition above.
'use strict';

// R1162 Stage 0 / N9: GET /v1/bootstrap used to hand out the mission-bridge
// bearer on the Origin/CORS check alone, before any real authorization ran
// (src/lib/mission-bridge/server.js:251-259 pre-fix). Per
// docs/coordinator/R1162-SECCOUNCIL-FINAL-SYNTHESIS.md D9, an Origin header
// is not authorization against the local-attacker premise this program
// operates under -- it is trivially forgeable by any local, non-browser HTTP
// client, and it does not defend a genuine browser-mediated attacker either
// (a malicious/XSS'd page loaded at an allowed origin could simply fetch it).
//
// This file exercises the fix in isolation: a local, filesystem-ACL'd
// "bootstrap proof" now gates bearer issuance, and the origin allowlist
// itself is validated against a narrower, structurally bounded shape. It
// does not touch src/lib/mission-bridge/actions.js or
// tests/mission-bridge-killswitch.test.js (occupied by other in-flight
// Stage 0 work) and does not depend on config/managed-processes.json.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BOOTSTRAP_PROOF_FILE, MAX_ALLOWED_ORIGINS, ORIGIN_PORT_MAX, ORIGIN_PORT_MIN,
  authorizedBootstrap, createMissionBridgeServer, mintBootstrapProof, originSet
} = require('../src/lib/mission-bridge/server');
const bridgeCli = require('../tools/mission-bridge');

let assertions = 0;
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function throwsCode(fn, code, message) {
  assertions += 1;
  assert.throws(fn, error => error && error.code === code, message);
}

// The exact 11-entry allowlist declared in config/managed-processes.json's
// mission-bridge entry today. Hardcoded here (mirroring the same fixture in
// tests/mission-bridge.test.js) rather than read from that file, because
// config/managed-processes.json is outside this change's territory --
// narrowing the *declared* count is a follow-up left to whoever owns that
// file. This test only guards that today's production config keeps
// validating under the tightened rules, so this landing cannot silently
// break the live registered bridge.
function declaredProductionOrigins() {
  return [
    'http://localhost:4600',
    'http://127.0.0.1:4600',
    ...Array.from({ length: 9 }, (_value, index) => `http://127.0.0.1:${4601 + index}`)
  ];
}

function originSetNarrowing() {
  equal(ORIGIN_PORT_MIN, 4600, 'the declared dashboard/app port range starts at 4600');
  equal(ORIGIN_PORT_MAX, 4609, 'the declared dashboard/app port range ends one below the bridge\'s own 4610');

  const declared = declaredProductionOrigins();
  equal(declared.length, 11, 'fixture matches the live declared 11-entry allowlist');
  const accepted = originSet(declared);
  equal(accepted.size, 11, 'the full, currently-declared production allowlist still validates -- narrowing does not regress live config');

  const withPreview = originSet([...declared, 'http://127.0.0.2:4600']);
  ok(withPreview.has('http://127.0.0.2:4600'), 'the 127.0.0.2 worktree-preview origin (P2 pattern, BRIDGE-LIVE-REPORT.md) remains accepted');

  throwsCode(() => originSet(['http://127.0.0.1:4610']),
    'BRIDGE_ORIGIN_INVALID', 'an origin on the bridge\'s own listener port is refused, not accepted as a dashboard origin');
  throwsCode(() => originSet(['http://127.0.0.1:4599']),
    'BRIDGE_ORIGIN_INVALID', 'an origin below the declared dashboard range is refused');
  throwsCode(() => originSet(['http://127.0.0.1']),
    'BRIDGE_ORIGIN_INVALID', 'an origin with no explicit port (implicit :80) is refused');
  throwsCode(() => originSet(['http://127.0.0.1:65535']),
    'BRIDGE_ORIGIN_INVALID', 'an arbitrary far-off port is refused');
  throwsCode(() => originSet(Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_value, index) => `origin-${index}`)),
    'BRIDGE_ORIGIN_ALLOWLIST_TOO_BROAD', 'an allowlist wider than the structural cap is refused before any per-origin parsing');
}

function authorizedBootstrapUnit() {
  const proof = crypto.randomBytes(32);
  const withProof = query => new URL(`http://loopback.invalid/v1/bootstrap${query}`);

  equal(authorizedBootstrap(withProof(`?proof=${proof.toString('base64url')}`), proof), true,
    'the exact minted proof authorizes bootstrap');
  equal(authorizedBootstrap(withProof(`?proof=${crypto.randomBytes(32).toString('base64url')}`), proof), false,
    'a different, well-formed proof is refused');
  equal(authorizedBootstrap(withProof(''), proof), false,
    'a missing proof query parameter is refused -- this is the exact pre-fix behavior (Origin alone was enough)');
  equal(authorizedBootstrap(withProof('?proof=too-short'), proof), false,
    'a malformed (wrong-shape) proof value is refused');
  equal(authorizedBootstrap(null, proof), false,
    'a non-URL input is refused rather than throwing');

  // A caller cannot satisfy authorizedBootstrap with the bearer TOKEN itself
  // instead of the distinct proof -- issuance must not become circular.
  const token = crypto.randomBytes(32);
  equal(authorizedBootstrap(withProof(`?proof=${token.toString('base64url')}`), proof), false,
    'presenting an unrelated 32-byte value (standing in for the bearer) does not satisfy the proof gate');
}

function mintBootstrapProofAcl() {
  // uac.loadOrCreateToken's writeTokenFile refuses any path outside this
  // repo's own root, so the throwaway test file must live inside state/,
  // exactly like tests/delegation/uac-delegation.js's own token-file test.
  const proofFile = path.join(BOOTSTRAP_PROOF_FILE, '..', `mission-bridge-bootstrap-proof.test-${process.pid}-${crypto.randomUUID()}.json`);
  try {
    const firstAclCalls = [];
    const minted = mintBootstrapProof({
      bootstrapProofFile: proofFile,
      allowTestBootstrapProofFile: true,
      bootstrapProofDependencies: {
        platform: 'win32',
        ownerPrincipal: 'WORKGROUP\\Owner',
        spawnSyncImpl(command, args, options) {
          firstAclCalls.push({ command, args, options });
          return { status: 0, error: null };
        }
      }
    });
    ok(Buffer.isBuffer(minted) && minted.length === 32, 'a fresh 32-byte proof is minted by default');
    ok(fs.existsSync(proofFile), 'the proof is persisted to the given file');
    equal(firstAclCalls.length, 1, 'minting applies exactly one Windows owner-only ACL');
    equal(firstAclCalls[0].command, '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe', 'the bootstrap proof uses the fixed Windows ACL executable');
    ok(firstAclCalls[0].args.includes('/inheritance:r') && firstAclCalls[0].args.includes('WORKGROUP\\Owner:(F)'),
      'the ACL removes inheritance and grants only the owner full control');
    const onDisk = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
    equal(onDisk.token, minted.toString('base64url'), 'the on-disk record carries the exact minted proof');

    const secondAclCalls = [];
    const rotated = mintBootstrapProof({
      bootstrapProofFile: proofFile,
      allowTestBootstrapProofFile: true,
      bootstrapProofDependencies: {
        platform: 'win32', ownerPrincipal: 'WORKGROUP\\Owner',
        spawnSyncImpl(command, args, options) { secondAclCalls.push({ command, args, options }); return { status: 0, error: null }; }
      }
    });
    equal(secondAclCalls.length, 1, 'a second mint re-applies the ACL rather than trusting a stale file');
    ok(!minted.equals(rotated), 'each mint produces an independent random proof (per-boot rotation, mirroring the bearer token)');

    throwsCode(() => mintBootstrapProof({ bootstrapProofFile: proofFile }),
      'BRIDGE_BOOTSTRAP_PROOF_PATH_REFUSED', 'a non-default proof path is refused without the explicit test escape hatch');
    throwsCode(() => mintBootstrapProof({ bootstrapProof: Buffer.alloc(16) }),
      'BRIDGE_BOOTSTRAP_PROOF_INVALID', 'an injected proof of the wrong length is refused');
    const injected = crypto.randomBytes(32);
    equal(mintBootstrapProof({ bootstrapProof: injected }), injected, 'an injected 32-byte buffer bypasses the file entirely (test convenience path)');
  } finally {
    fs.rmSync(proofFile, { force: true });
  }
}

async function bootstrapHttpFlow() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-bridge-bootstrap-auth-'));
  const runtimeFile = path.join(directory, 'runtime.json');
  const token = crypto.randomBytes(32);
  const bootstrapProof = crypto.randomBytes(32);
  const actions = { async status() { return { ok: true, actions: [] }; } };
  const bridge = createMissionBridgeServer({
    token, bootstrapProof, allowedOrigins: ['http://127.0.0.2:4600'], actions,
    runtimeFile, allowTestRuntimeFile: true, allowTestPortZero: true,
    runtimeDependencies: { platform: 'test' }
  });
  const ALLOWED = 'http://127.0.0.2:4600';
  try {
    const address = await bridge.listen(0);

    const noProof = await fetch(`${address.baseUrl}/v1/bootstrap`, { headers: { origin: ALLOWED } });
    equal(noProof.status, 401, 'bootstrap with an allowed origin but no proof is refused -- this is the exact live gap being closed');
    const noProofBody = await noProof.json();
    equal(noProofBody.error.code, 'BRIDGE_BOOTSTRAP_PROOF_REQUIRED', 'refusal is typed');
    equal(JSON.stringify(noProofBody).includes(token.toString('base64url')), false, 'a refused bootstrap never leaks the bearer');

    const wrongProof = await fetch(`${address.baseUrl}/v1/bootstrap?proof=${crypto.randomBytes(32).toString('base64url')}`, { headers: { origin: ALLOWED } });
    equal(wrongProof.status, 401, 'bootstrap with the wrong proof is refused even from an allowed origin');

    const correctProofWrongOrigin = await fetch(`${address.baseUrl}/v1/bootstrap?proof=${bootstrapProof.toString('base64url')}`, { headers: { origin: 'http://evil.invalid' } });
    equal(correctProofWrongOrigin.status, 403, 'the origin check still runs first and independently -- a correct proof from a foreign origin is still refused');
    const originRefusalBody = await correctProofWrongOrigin.json();
    equal(originRefusalBody.error.code, 'BRIDGE_ORIGIN_REFUSED', 'the origin refusal is typed and takes priority over the proof check');

    const authorizedBootstrapResponse = await fetch(`${address.baseUrl}/v1/bootstrap?proof=${bootstrapProof.toString('base64url')}`, { headers: { origin: ALLOWED } });
    equal(authorizedBootstrapResponse.status, 200, 'bootstrap succeeds once both the origin and the local proof are correct');
    const authorizedBody = await authorizedBootstrapResponse.json();
    equal(authorizedBody.token, token.toString('base64url'), 'an authorized bootstrap returns the real bearer');
    equal(authorizedBody.trustBoundary, 'single-user-loopback-origin-and-local-file-proof-bound',
      'trustBoundary names the boundary actually delivered now, not the pre-fix "origin-bound" overclaim');

    const statusResponse = await fetch(`${address.baseUrl}/v1/status`, {
      headers: { origin: ALLOWED, authorization: `Bearer ${authorizedBody.token}` }
    });
    equal(statusResponse.status, 200, 'the bearer obtained through the newly-gated bootstrap still authorizes a real action');
  } finally {
    if (bridge.server.listening) await bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function cliSurface() {
  const helpText = bridgeCli.usage();
  ok(helpText.includes('requires a local proof value'),
    'CLI usage explicitly states that bootstrap requires a local proof value');
  ok(helpText.includes('?proof=...'),
    'CLI usage documents the query parameter that transports the bootstrap proof');
  ok(helpText.includes(`${ORIGIN_PORT_MIN}`) && helpText.includes(`${ORIGIN_PORT_MAX}`), 'CLI usage documents the narrowed origin port range');
  equal(bridgeCli.parseArgs(['--origin', 'http://127.0.0.2:4600', '--root', 'primary=.']).origins[0], 'http://127.0.0.2:4600',
    'CLI arg parsing for --origin is unchanged by the bootstrap-auth fix');
}

async function main() {
  originSetNarrowing();
  authorizedBootstrapUnit();
  mintBootstrapProofAcl();
  await bootstrapHttpFlow();
  cliSurface();
  console.log(`mission-bridge-bootstrap-auth: ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
