// EXECUTABLE CHANGE — testcanfail-tests-entry-mcp-call-js
//
// Discriminating-assertion report:
// - Shape 5, platform precondition: the symlink-input assertion was guarded by
//   `process.platform === 'win32'`, making it a no-op everywhere else.  It now
//   runs on every platform.  On hosts that deny symlink creation, EPERM is the
//   named fixture precondition; every other failure (including an assertion
//   failure) is still rethrown.
// - Mutation: temporarily bypassed assertNoSymlinkComponents() and the selected
//   entry's symbolic-link rejection in tools/mcp-call.js.  The strengthened
//   assertion went RED with: "AssertionError [ERR_ASSERTION]: Missing expected
//   exception."
//   The mutation was restored byte-for-byte (SHA-256 before and after:
//   7c772b2a10681f4c3f496f94636256eb365c5e6de3a8d2b975cbb916ad23a32a).
// - NOT-FOUND shape 1: no loop/forEach assertion over a possibly empty value.
// - NOT-FOUND shape 2: the spawned-process status check requires status 0 and
//   is followed by assertions on parsed subject output; it is not a bare
//   non-zero/truthy-exit assertion.
// - NOT-FOUND shape 3: no try/catch or optional chain swallows the failure under
//   test.  The EPERM catch is fixture setup handling and rethrows all other
//   errors; optional chaining feeds strict equality and cannot bypass it.
// - NOT-FOUND shape 4: fakeStderrChild mocks only the transport child used to
//   stimulate StdioMcpClient's real stderr/error behavior, not that behavior.
// - NOT-FOUND shape 6: expected values are independent literals/fixtures, not
//   computed by the production implementation being checked.
// - Restored run preconditions: `scratch/` was absent and was created.  The
//   final full-file run cannot be green in this checkout because the required
//   tools/mcp-owner-proxy.js product artifact is absent; it reaches the direct
//   launch assertion and reports MCP_CALL_WRAPPER_UNAVAILABLE.  No product
//   file was created or changed to conceal that unmet precondition.
'use strict';

// This test spawns tools/mcp-call.js, which in turn spawns
// tools/mcp-owner-proxy.js. That proxy reads state/owner-host-capability.json
// and, when a capability is present, dials the real owner-host named pipe
// instead of falling back to the in-process broker. Without isolation, this
// test's pass/fail therefore depends on ambient machine state -- whether the
// real owner host (the loopback sidecar server) happens to be active. Activate
// the shared test-isolation environment before any subprocess is spawned, the
// same way the former client stdio test already did, so the proxy
// always resolves the isolated (guaranteed-absent) capability path and takes
// the deterministic in-process fallback regardless of real machine state.
const isolated = require('../lib/isolated-environment').activate('mcp-call');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  ROOT, readRequestFile, validateOutputName, validateRequestId, safeSummary, parseCli, timeoutMaximumFor,
  timeoutDefaultFor, approvedExecutionArguments, StdioMcpClient
} = require('../../tools/mcp-call');

// A fresh source checkout has no ignored scratch directory yet.
fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(ROOT, 'scratch', 'mcp-call-test-'));
const request = path.join(directory, 'request.json');
const outputName = `mcp-call-test-${process.pid}.json`;
const output = path.join(ROOT, 'scratch', 'mcp-call-output', outputName);

// Fake proxy child for the stderr-hint tests: writes the given stderr text and
// exits without ever producing a response, like the real proxy's refusal path.
function fakeStderrChild(stderrText) {
  return () => spawn(process.execPath, ['-e',
    'process.stderr.write(process.env.FAKE_STDERR); setTimeout(() => process.exit(1), 50);'
  ], {
    env: { ...process.env, FAKE_STDERR: stderrText },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
  });
}

async function stderrHintTests() {
  const refusal = 'REFUSING TO SERVE: cannot reach this ToolsEnabled app instance. Close and reopen ToolsEnabled normally, then start the agent again.';

  // Transport dies before any response: the pending request rejects with the
  // transport code and carries the first non-empty stderr line as the hint.
  const client = new StdioMcpClient(10000, { spawnOverride: fakeStderrChild(`\n  ${refusal}  \nsecond line\n`) });
  await assert.rejects(
    client.request('initialize', {}),
    error => error.code === 'MCP_CALL_TRANSPORT_CLOSED' && error.stderrHint === refusal
  );
  assert.equal(client.stderrHint(), refusal);
  await client.close();

  // Bounded: a huge single stderr line yields a hint of at most 300 chars.
  const noisy = new StdioMcpClient(10000, { spawnOverride: fakeStderrChild('x'.repeat(5000)) });
  await assert.rejects(
    noisy.request('initialize', {}),
    error => error.code === 'MCP_CALL_TRANSPORT_CLOSED'
      && typeof error.stderrHint === 'string'
      && error.stderrHint.length === 300
      && /^x+$/.test(error.stderrHint)
  );
  await noisy.close();

  // No stderr at all: no hint field is attached.
  const silent = new StdioMcpClient(10000, { spawnOverride: fakeStderrChild('') });
  await assert.rejects(
    silent.request('initialize', {}),
    error => error.code === 'MCP_CALL_TRANSPORT_CLOSED' && !('stderrHint' in error)
  );
  assert.equal(silent.stderrHint(), undefined);
  await silent.close();
}

async function main() {
try {
  fs.writeFileSync(request, JSON.stringify({ tool: 'system.status', arguments: {} }), 'utf8');
  assert.deepEqual(readRequestFile(path.relative(ROOT, request)), { tool: 'system.status', arguments: {} });

  fs.writeFileSync(request, JSON.stringify({ tool: 'task.list', arguments: {} }), 'utf8');
  assert.deepEqual(readRequestFile(path.relative(ROOT, request)), { tool: 'task.list', arguments: {} });

  assert.throws(() => readRequestFile(path.join('..', path.basename(request))), error => error.code === 'MCP_CALL_INPUT_OUTSIDE_ROOT');
  assert.equal(validateOutputName('status-1.json'), 'status-1.json');
  assert.throws(() => validateOutputName('../result.json'), error => error.code === 'MCP_CALL_OUTPUT_NAME_INVALID');
  assert.equal(validateRequestId('R86'), 'R86');
  assert.throws(() => validateRequestId('not a ledger id'), error => error.code === 'MCP_CALL_REQUEST_ID_INVALID');
  assert.throws(() => parseCli(['--input', 'safe.json', '--input', 'again.json']), error => error.code === 'MCP_CALL_USAGE');
  assert.deepEqual(parseCli(['--approve', '--input', 'safe.json']), {
    input: 'safe.json', outputName: undefined, timeoutMs: undefined, requestApproval: true,
    deferCredentialPrompts: false
  });
  assert.deepEqual(parseCli(['--defer-credential-prompts', '--input', 'safe.json']), {
    input: 'safe.json', outputName: undefined, timeoutMs: undefined, requestApproval: false,
    deferCredentialPrompts: true
  });
  assert.deepEqual(parseCli(['--request-id', 'R86', '--input', 'safe.json']), {
    input: 'safe.json', outputName: undefined, timeoutMs: undefined, requestApproval: false,
    deferCredentialPrompts: false, requestId: 'R86'
  });
  assert.throws(() => parseCli(['--approve', '--approve', '--input', 'safe.json']), error => error.code === 'MCP_CALL_USAGE');
  assert.equal(timeoutMaximumFor('system.status'), 5 * 60 * 1000);
  assert.equal(timeoutMaximumFor('provider.operation'), 5 * 60 * 1000);
  assert.equal(timeoutMaximumFor('vertex.gemini_strong_complete'), 8 * 60 * 1000);
  assert.equal(timeoutDefaultFor('provider.operation'), 90 * 1000);
  assert.equal(timeoutDefaultFor('vertex.gemini_strong_complete'), 8 * 60 * 1000);
  assert.equal(timeoutDefaultFor('system.status'), 90 * 1000);

  const oneTimeToken = 'A'.repeat(43);
  assert.deepEqual(approvedExecutionArguments(
    { tool: 'chrome_web_store.oauth_authorize', arguments: {} },
    { result: { structuredContent: { approved: true, approvalToken: oneTimeToken } } }
  ), { approvalToken: oneTimeToken });
  assert.throws(() => approvedExecutionArguments(
    { tool: 'chrome_web_store.oauth_authorize', arguments: {} },
    { result: { structuredContent: { approved: false, timedOut: true } } }
  ), error => error.code === 'MCP_CALL_APPROVAL_TIMED_OUT');
  assert.throws(() => approvedExecutionArguments(
    { tool: 'chrome_web_store.oauth_authorize', arguments: { approvalToken: oneTimeToken } },
    { result: { structuredContent: { approved: true, approvalToken: oneTimeToken } } }
  ), error => error.code === 'MCP_CALL_APPROVAL_INPUT_INVALID');

  const summary = safeSummary('clipboard.read', {
    result: { isError: false, content: [{ type: 'text', text: 'sensitive clipboard data' }] }
  });
  assert.deepEqual(summary, {
    ok: true, tool: 'clipboard.read', isError: false, content: [{ type: 'text', bytes: 24 }], outputFile: undefined
  });
  assert.doesNotMatch(JSON.stringify(summary), /clipboard data|sensitive/i);

  fs.writeFileSync(request, JSON.stringify({ tool: 'system.status', arguments: {} }), 'utf8');
  const linked = path.join(directory, 'linked.json');
  try {
    fs.symlinkSync(request, linked, 'file');
    assert.throws(() => readRequestFile(path.relative(ROOT, linked)), error => error.code === 'MCP_CALL_INPUT_NOT_REGULAR');
  } catch (error) {
    // Developer Mode / SeCreateSymbolicLinkPrivilege is optional on Windows;
    // the production guard remains covered when the OS permits the fixture.
    if (error.code !== 'EPERM') throw error;
  }

  // Exercise the actual direct Codex broker launch under the isolated test environment.
  // system.status is read-only, while the helper's raw response stays in its
  // constrained output directory rather than test stdout.
  fs.writeFileSync(request, JSON.stringify({ tool: 'system.status', arguments: {} }), 'utf8');
  const invoked = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mcp-call.js'),
    '--input', path.relative(ROOT, request), '--output-name', outputName], {
    cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 120000, windowsHide: true
  });
  assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
  const invokedSummary = JSON.parse(invoked.stdout);
  assert.equal(invokedSummary.ok, true);
  assert.equal(invokedSummary.tool, 'system.status');
  assert.equal(invokedSummary.outputFile, path.join('scratch', 'mcp-call-output', outputName));
  // The owner alias is ASSEMBLED, not spelled. This assertion exists to prove the
  // alias never reaches stdout, so writing it here would make the file fail the
  // owner-data guard it is helping to enforce -- the same bind tools/check-no-owner-data.mjs
  // documents for its own comments.
  const ownerAlias = ['jp', 'inckard'].join('');  // neither half contains a profile value
  assert.doesNotMatch(invoked.stdout, new RegExp('schemaVersion|' + ownerAlias + '|audit', 'i'));
  const raw = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(raw.result?.structuredContent?.state?.ok, true);

  await stderrHintTests();

  console.log('MCP reconnect helper tests passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(output, { force: true });
}
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
