// EXECUTABLE CHANGE
//
// Assertion audit report (testcanfail-tests-remote-surface-tier-parity-test-js):
// - Strengthened both write-tool refusal checks. Mutation: inserted an
//   unconditional Error at the start of mcp-server's tools/call dispatch, so
//   the subject returned its own generic failure before permission enforcement.
//   Before this change both checks stayed green. After this change they went
//   red with: "expected the permission dispatcher to handle host.write_file"
//   (twice), and the summary reported "6 checks, 2 failure(s)".
// - The mutation was removed and src/mcp-server.js was restored byte-for-byte
//   (SHA-256 01740ece369e371684173a2fd787ec4c25aecaf7df234dc635201b016f6ee5bb).
//   The restored run was green: "remote-surface-tier-parity: 8 checks,
//   0 failure(s)".
// - NOT-FOUND (1): no assertion iterates a possibly empty collection. The only
//   assertion loop uses a two-element array literal; tierSurface also has an
//   explicit non-empty precondition.
// - NOT-FOUND (2), after the two fixes above: no exit-status/truthy-return
//   assertion substitutes for subject-owned evidence.
// - NOT-FOUND (3): no try/catch or optional chain swallows an assertion failure.
//   Cleanup catches occur only after checks have been recorded.
// - NOT-FOUND (4): no assertion tests a mock of the bridge, registry, or policy.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6): no expected value is computed by the same function it checks;
//   tierSurface is the policy oracle used to check the independently running
//   listener. Fixed literals independently pin the security-critical tools.
// - PRECONDITION: the default Node 20.20.2 lacks node:sqlite. Node 24.15.0 was
//   available and was used for every executable mutation and restoration run.

'use strict';

// THE ADVERTISED REMOTE SURFACE MUST NOT BE WIDER THAN THE TIER, AND ON
// 2026-08-11 IT WAS.
//
// Measured against the real Machine B peer that day: the bridge advertised 294
// tools, 140 of them write-effect, including host.write_file -- which was then
// CALLED over the hop, executed, and left a file on the peer's disk. The same
// machine's own policy refuses every one of them: guardedToolNames() returns
// only local-read/external-read tools and assertToolAllowed refuses
// host.write_file with PERMISSION_EFFECT_REFUSED.
//
// The code was right and the listener was not applying it, because ENUMERATION
// AND DISPATCH RESOLVED THROUGH TWO DIFFERENT MECHANISMS:
//
//   tools/call  -> permissionSession -> assertToolAllowed  (an effect tier)
//   tools/list  -> TOOLSENABLED_TOOL_ALLOWLIST             (a process-global
//                                                           NAME filter)
//
// A name filter is not a permission tier. The two disagreed in BOTH directions:
// the allowlist admitted every write tool the tier refuses, and it also refused
// clipboard.read, which the tier permits. And the name filter is an environment
// variable -- absent, stale, or inherited-wider, it silently reads as THE FULL
// REGISTRY, which is exactly what a remote peer enumerated.
//
// So the invariant pinned here is not "the checker reports parity". It is that
// the LISTENER cannot advertise or dispatch past its tier, tested over a real
// authenticated TCP hop rather than by asserting on source text -- a
// source-text assertion cannot see what a running listener actually answers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  createBridge,
  assertAdvertisedSurfaceWithinTier,
  REMOTE_PERMISSION_SESSION
} = require('../src/remote-agent-bridge');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const policy = require('../src/lib/permission-tier-policy');

const LOOPBACK = /^127\.0\.0\.1$/;
const TOKEN = 'tier-parity-test-token-0123456789';

let checks = 0;
let failures = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok  ${name}`); checks += 1; })
    .catch(error => {
      console.log(`  FAIL  ${name}: ${error && error.message}`);
      failures += 1;
    });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

// A real client for a real listener: TCP connect, authorize handshake, then
// newline-delimited JSON-RPC. Nothing here reaches into the bridge's internals,
// so what it observes is what any remote peer would observe.
function openPeer(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1');
    socket.setEncoding('utf8');
    let buffer = '';
    const waiters = [];
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const waiter = waiters.shift();
        if (waiter) {
          try { waiter.resolve(JSON.parse(line)); }
          catch (error) { waiter.reject(error); }
        }
      }
    });
    socket.once('error', reject);
    const nextMessage = () => new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    socket.once('connect', () => {
      const identity = nextMessage();
      socket.write(`${JSON.stringify({ type: 'authorize', token: TOKEN })}\n`);
      identity.then(() => resolve({
        socket,
        call(message) {
          const reply = nextMessage();
          socket.write(`${JSON.stringify(message)}\n`);
          return reply;
        },
        close() { socket.destroy(); }
      })).catch(reject);
    });
  });
}

async function withPeer(port, fn) {
  const peer = await openPeer(port);
  try { return await fn(peer); }
  finally { peer.close(); }
}

function advertisedNames(response) {
  assert.ok(response && response.result && Array.isArray(response.result.tools),
    `tools/list did not return a tool array: ${JSON.stringify(response).slice(0, 200)}`);
  return response.result.tools.map(tool => tool.name);
}

function assertPermissionRefusal(response, toolName) {
  // isError alone is not evidence of policy enforcement: a broken dispatcher,
  // unknown tool, or handler crash produces the same truthy bit. Pin the policy
  // layer's structured refusal so only the behavior under test satisfies this.
  assert.equal(response.error, undefined,
    `expected the permission dispatcher to handle ${toolName}: ${JSON.stringify(response).slice(0, 300)}`);
  assert.equal(response.result && response.result.isError, true,
    `${toolName} must return an MCP refusal result`);
  assert.equal(response.result && response.result.structuredContent
    && response.result.structuredContent.error && response.result.structuredContent.error.code,
  'PERMISSION_EFFECT_REFUSED',
  `${toolName} must be refused by the guarded permission tier`);
}

async function main() {
  const logFile = path.join(os.tmpdir(), `remote-surface-tier-parity-${process.pid}.log`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-parity-'));
  const writeTarget = path.join(scratch, 'must-not-exist.txt');
  const tierSurface = new Set(policy.guardedToolNames(TOOL_REGISTRY));
  const priorAllowlist = process.env.TOOLSENABLED_TOOL_ALLOWLIST;

  assert.ok(tierSurface.size > 0, 'the guarded tier surface must not be empty');
  assert.ok(!tierSurface.has('host.write_file'), 'guarded tier must not carry host.write_file');

  const server = createBridge({
    token: TOKEN,
    allowedRemoteRe: LOOPBACK,
    logFile,
    reloadToken: () => TOKEN
  });
  const port = await listen(server);

  try {
    // THE ORIGINAL DEFECT. With no name filter configured, enumeration fell
    // through to the full registry while dispatch stayed tiered. Absence of an
    // environment variable is not a permission decision.
    await check('enumeration with no name filter is exactly the tier surface', async () => {
      delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
      await withPeer(port, async peer => {
        const names = advertisedNames(await peer.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
        const widened = names.filter(name => !tierSurface.has(name));
        assert.equal(widened.length, 0,
          `advertised ${names.length} tools, ${widened.length} wider than the tier (e.g. ${widened.slice(0, 5).join(', ')})`);
        assert.equal(names.length, tierSurface.size,
          `advertised ${names.length} tools but the tier carries ${tierSurface.size}`);
      });
    });

    // A wider environment variable must not widen the hop. This is the shape
    // that actually bit: the value is process-global and inheritable, so any
    // parent process could set it.
    await check('a wider name filter cannot widen the advertised surface', async () => {
      process.env.TOOLSENABLED_TOOL_ALLOWLIST = 'host.*,repo.*,system.*,clipboard.*';
      await withPeer(port, async peer => {
        const names = advertisedNames(await peer.call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
        const widened = names.filter(name => !tierSurface.has(name));
        assert.equal(widened.length, 0,
          `a wide name filter widened the hop by ${widened.length} tools (e.g. ${widened.slice(0, 5).join(', ')})`);
        assert.ok(!names.includes('host.write_file'), 'host.write_file must never be advertised remotely');
      });
    });

    // The tier is a ceiling, not a floor: a narrower operator-set filter is
    // still honoured. This is what stops the fix from being "ignore the filter".
    await check('a narrower name filter still narrows', async () => {
      process.env.TOOLSENABLED_TOOL_ALLOWLIST = 'system.status';
      await withPeer(port, async peer => {
        const names = advertisedNames(await peer.call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
        assert.deepEqual(names, ['system.status'],
          `a narrow filter must still apply, got ${names.length} tools`);
      });
    });

    // THE MEASURED INCIDENT, REPRODUCED AS A TEST. Not "is it listed" -- call
    // it, and prove nothing landed on disk.
    await check('a write tool called across the hop is refused and writes nothing', async () => {
      delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
      await withPeer(port, async peer => {
        const response = await peer.call({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'host.write_file', arguments: { path: writeTarget, content: 'breach' } }
        });
        const refused = Boolean(response.error)
          || Boolean(response.result && response.result.isError);
        assert.ok(refused, `host.write_file was not refused across the hop: ${JSON.stringify(response).slice(0, 300)}`);
        assertPermissionRefusal(response, 'host.write_file');
        assert.equal(fs.existsSync(writeTarget), false,
          'host.write_file left a file on disk across a guarded hop');
      });
    });

    // Even when a name filter explicitly admits it, the tier still refuses.
    // Dispatch and enumeration must agree on one answer.
    await check('a name filter that admits a write tool cannot make it callable', async () => {
      process.env.TOOLSENABLED_TOOL_ALLOWLIST = 'host.write_file,system.status';
      await withPeer(port, async peer => {
        const names = advertisedNames(await peer.call({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }));
        assert.ok(!names.includes('host.write_file'),
          'a name filter admitted host.write_file into the advertised remote surface');
        const response = await peer.call({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'host.write_file', arguments: { path: writeTarget, content: 'breach' } }
        });
        const refused = Boolean(response.error) || Boolean(response.result && response.result.isError);
        assert.ok(refused, 'an allowlisted write tool was dispatched across a guarded hop');
        assertPermissionRefusal(response, 'host.write_file');
        assert.equal(fs.existsSync(writeTarget), false, 'an allowlisted write tool wrote across a guarded hop');
      });
    });

    // The other direction of the disagreement: the live allowlist refused
    // clipboard.read, which the tier permits. Whatever the tier says is the
    // answer, so a tool the tier carries must be reachable when nothing else
    // narrows.
    await check('a read tool the tier permits stays reachable', async () => {
      delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
      await withPeer(port, async peer => {
        const names = advertisedNames(await peer.call({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }));
        for (const name of ['system.status', 'clipboard.read']) {
          assert.equal(names.includes(name), tierSurface.has(name),
            `${name} advertisement disagrees with the tier`);
        }
      });
    });
    // The listener's own startup check. It is a second statement of the same
    // invariant, for the next transport that binds a port without binding a
    // session -- so it is tested by feeding it a surface that IS too wide,
    // rather than only by watching it pass.
    await check('the listener refuses to start when its surface exceeds the tier', async () => {
      assert.throws(
        () => assertAdvertisedSurfaceWithinTier({
          enumerate: () => [{ name: 'host.write_file' }, { name: 'system.status' }]
        }),
        error => error && error.code === 'REMOTE_SURFACE_WIDER_THAN_TIER' && error.widenedBy === 1,
        'a surface carrying host.write_file must refuse to listen'
      );
      const ok = assertAdvertisedSurfaceWithinTier();
      assert.equal(ok.widenedBy, 0);
      assert.equal(ok.advertised, tierSurface.size,
        `the listener would advertise ${ok.advertised} tools against a tier of ${tierSurface.size}`);
      assert.deepEqual(REMOTE_PERMISSION_SESSION, { origin: 'remote', tier: 'guarded' });
    });

    // An unreadable policy must not enumerate as an empty -- or full -- surface.
    await check('a malformed session refuses rather than enumerating', async () => {
      const { listTools } = require('../src/lib/tool-registry');
      assert.throws(() => listTools({ permissionSession: { origin: 'remote', tier: 'mystery' } }),
        error => /^PERMISSION_/.test(error && error.code));
      assert.throws(() => listTools({ permissionSession: { origin: 'remote', tier: 'full' } }),
        error => error && error.code === 'PERMISSION_REMOTE_FULL_REFUSED');
    });
  } finally {
    if (priorAllowlist === undefined) delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
    else process.env.TOOLSENABLED_TOOL_ALLOWLIST = priorAllowlist;
    await closeServer(server);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(logFile, { force: true }); } catch {}
  }

  console.log(`\nremote-surface-tier-parity: ${checks} checks, ${failures} failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
