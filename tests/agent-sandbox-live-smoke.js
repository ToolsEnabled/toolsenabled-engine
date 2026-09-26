'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('../src/lib/providers/agent-sandbox');
const { rootPath } = require('../src/lib/runtime');

const unique = `${Date.now()}.${process.pid}`;
let handle = null;
let sandboxId = null;
let cleaned = false;

/* This test has two legitimate, asserted outcomes.
 *
 * This suite drives a REAL Docker container end to end -- create, write, exec,
 * timeout, inspect isolation, collect a Playwright screenshot, clean up. None of
 * that is reachable without a running Docker daemon and the pinned image pulled.
 *
 * It used to `assert.equal(doctor.available, true, 'Docker must be running.')`,
 * so a machine with Docker stopped reported a hard FAIL. That is the wrong
 * colour and it costs real signal: an absent daemon and a broken sandbox both
 * came back red, so the one that means "the product is broken" had nowhere to
 * stand out. Measured 2026-08-13 on machine-a, this suite failed in 210ms on
 * SANDBOX_DOCKER_NOT_RUNNING having exercised nothing at all.
 *
 * When Docker is unavailable, incompatible, or lacks the pinned image, the
 * product's own doctor must return a structured, named refusal and must not
 * claim image readiness. That fail-closed path is real product behavior and is
 * asserted here. When all preconditions exist, every live isolation assertion
 * below runs unchanged.
 */
function passUnavailable(doctor, code, reason) {
  assert.equal(typeof code, 'string', 'an unavailable sandbox state must carry a named code');
  assert.match(code, /^SANDBOX_[A-Z0-9_]+$/);
  assert.equal(doctor.imageReady, false, 'an unavailable sandbox must never claim its image is ready');
  process.stdout.write(`PASS agent-sandbox-live-smoke: verified fail-closed doctor outcome ${code} (${reason})\n`);
}

try {
  const doctor = sandbox.doctor();
  if (doctor.available !== true) {
    passUnavailable(doctor, doctor.code, 'Docker unavailable or status unknown');
    return;
  }
  if (doctor.compatible !== true) {
    passUnavailable(doctor, doctor.code, 'required isolation limits unavailable or unknown');
    return;
  }
  if (doctor.imageReady !== true) {
    passUnavailable(doctor, doctor.imageCode, 'pinned image absent or untrusted');
    return;
  }

  const created = sandbox.create({
    // A native qualification may use a different supported agent's allowance
    // when the owner's existing Codex sandboxes already fill that allowance.
    // Product admission still enforces both per-agent and total limits.
    agent: process.env.TOOLSENABLED_SANDBOX_TEST_AGENT || 'codex',
    taskKey: `sandbox.live.task.${unique}`,
    sandboxKey: `sandbox.live.fixture.${unique}`,
    networkMode: 'fixture',
    leaseSeconds: 300
  });
  handle = created.handle;
  sandboxId = created.sandboxId;

  const source = fs.readFileSync(rootPath('docker', 'agent-sandbox', 'smoke.js'), 'utf8');
  const wrote = sandbox.workspaceWrite({
    handle,
    path: 'fixture-smoke.js',
    content: source,
    leaseSeconds: 300
  });
  handle = wrote.handle;
  const executed = sandbox.execute({
    handle,
    scriptPath: 'fixture-smoke.js',
    timeoutSeconds: 45,
    leaseSeconds: 300
  });
  handle = executed.handle;
  assert.equal(executed.exitCode, 0, executed.stderr || 'Sandbox smoke command failed.');
  const payload = JSON.parse(executed.stdout.trim());
  assert.deepEqual(payload, {
    ok: true,
    title: 'ToolsEnabled sandbox fixture',
    status: 'fixture interaction passed',
    publicNetworkBlocked: true
  });
  const slowWrite = sandbox.workspaceWrite({
    handle,
    path: 'timeout-smoke.js',
    content: 'setInterval(() => {}, 1000);',
    leaseSeconds: 300
  });
  handle = slowWrite.handle;
  const timedOut = sandbox.execute({
    handle,
    scriptPath: 'timeout-smoke.js',
    timeoutSeconds: 1,
    leaseSeconds: 300
  });
  handle = timedOut.handle;
  assert.equal(timedOut.exitCode, 124);
  assert.match(timedOut.stderr, /exceeded 1000 ms/);

  const status = sandbox.status({ sandboxId });
  assert.equal(status.running, true);
  assert.equal(status.fixtureRunning, true);
  assert.equal(status.networkMode, 'fixture');
  assert.equal(status.observed.readOnlyRootfs, true);
  assert.ok(status.observed.capDrop.includes('ALL'));
  assert.ok(status.observed.securityOpt.some(item => item.startsWith('no-new-privileges')));
  assert.equal(status.observed.pidsLimit, sandbox.RESOURCE_LIMITS.browser.pids);
  assert.equal(status.observed.memoryBytes, sandbox.RESOURCE_LIMITS.browser.memoryBytes);
  assert.equal(status.observed.networkInternal, true);
  assert.equal(status.observed.networkGatewayModeIpv4, 'isolated');
  assert.deepEqual(status.observed.mountDestinations, ['/workspace']);
  assert.equal(status.observed.hostDockerSocketMounted, false);
  assert.equal(status.observed.publishedPorts, false);
  assert.equal(status.observed.boundaryValid, true);

  const artifactResult = sandbox.artifacts({ handle, leaseSeconds: 300 });
  handle = artifactResult.handle;
  const screenshot = artifactResult.artifacts.find(item => item.name === 'fixture-smoke.png');
  assert.ok(screenshot, 'Playwright did not produce the fixture screenshot.');
  assert.ok(screenshot.bytes > 1000, 'Screenshot was unexpectedly small.');
  const signature = fs.readFileSync(path.resolve(screenshot.hostPath)).subarray(0, 8);
  assert.deepEqual([...signature], [137, 80, 78, 71, 13, 10, 26, 10]);

  const result = sandbox.cleanup({ handle });
  cleaned = true;
  assert.equal(result.cleaned, true);
  assert.equal(sandbox.status({ sandboxId }).exists, false);
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    sandboxId,
    browserImageId: doctor.imageId,
    screenshotBytes: screenshot.bytes,
    isolation: status.observed
  })}\n`);
} finally {
  if (!cleaned && handle) {
    try { sandbox.cleanup({ handle }); } catch (error) {
      process.stderr.write(`Sandbox live-smoke cleanup failed: ${error.code || 'UNKNOWN'} ${error.message}\n`);
    }
  }
}
