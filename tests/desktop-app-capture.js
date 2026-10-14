'EXECUTABLE CHANGE';

// testcanfail-tests-desktop-app-capture-js
// Strengthened live-test preconditions: an unavailable monitor surface, an empty
// window enumeration, or no safe capture candidate now fails rather than silently
// bypassing the assertions this file exists to exercise.
// Mutation execution precondition not met: this host has no powershell.exe, so a
// temporary product mutation could not reach these Windows-only branches. The
// unmutated run fails before the first subject result with:
// "Error: spawnSync powershell.exe ENOENT".
// NOT-FOUND (2): no exit-status/truthy-return assertion.
// NOT-FOUND (3): no subject failure is swallowed (cleanup catches only unlink).
// NOT-FOUND (4): no mock of the desktop implementation.
// NOT-FOUND (6): no expected value is computed by the implementation under test.

'use strict';

// Live Windows regression coverage for the non-invasive app capture path. The
// test never focuses, moves, restores, or closes a window. It intentionally avoids
// browser candidates so an OAuth page is not captured as a test fixture.

require('./lib/isolated-environment').activate('desktop-app-capture');
// The captures directory THE PRODUCT resolves, not a pinned precedence.
// desktop.js:100 computes rootPath('captures'); before fe452d3 the isolated
// environment left TOOLSENABLED_STATE_ROOT unset, so that fell back to
// process.cwd() and these tests pinned the fallback -- green only in a world
// the shipped shell never produces. Deriving the expectation through the same
// resolver keeps the confinement assertion while following the environment.
const CAPTURES_DIR = require('../src/lib/runtime').rootPath('captures');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const desktop = require('../src/lib/desktop');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_PREFIX = `desktop-app-capture-${process.pid}`;

function assertPng(file, width, height) {
  const data = fs.readFileSync(file);
  assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE), 'capture must be PNG');
  assert.equal(data.toString('ascii', 12, 16), 'IHDR');
  assert.equal(data.readUInt32BE(16), width, 'PNG width must match metadata');
  assert.equal(data.readUInt32BE(20), height, 'PNG height must match metadata');
}

function cleanup(file) {
  if (file) {
    try { fs.unlinkSync(file); } catch { /* best-effort test cleanup */ }
  }
}

function captureArgs(window, filename, overrides = {}) {
  return {
    windowId: window.windowId,
    expectedProcessId: window.processId,
    expectedProcessStartKey: window.processStartKey,
    filename,
    ...overrides
  };
}

(async () => {
  const monitorListing = desktop.listMonitors();
  assert.ok(monitorListing.count >= 1);
  assert.equal(monitorListing.coordinateSpace, 'physical_pixels_per_monitor_dpi_aware');
  for (const monitor of monitorListing.monitors) {
    assert.match(monitor.monitorId, /^[A-Za-z0-9_.\\:-]{1,128}$/);
    assert.ok(Number.isInteger(monitor.x) && Number.isInteger(monitor.y));
    assert.ok(monitor.width > 0 && monitor.height > 0 && monitor.dpiX > 0 && monitor.dpiY > 0);
  }
  const negativeCoordinateMonitor = monitorListing.monitors.find(monitor => monitor.x < 0 || monitor.y < 0);
  if (negativeCoordinateMonitor) {
    assert.ok(negativeCoordinateMonitor.x < 0 || negativeCoordinateMonitor.y < 0, 'negative monitor origins must survive validation');
  } else {
    console.log('No negative-coordinate monitor is connected; validation remains platform-independent.');
  }

  const monitor = negativeCoordinateMonitor || monitorListing.monitors[0];
  const monitorCapture = desktop.screenCaptureMonitor({ monitorId: monitor.monitorId, filename: `${TEST_PREFIX}-monitor.png` });
  const monitorAvailable = monitorCapture.status === 'captured';
  assert.equal(monitorAvailable, true, 'live monitor capture must be available for PNG and confinement coverage');
  if (monitorAvailable) {
    try {
      assert.equal(monitorCapture.method, 'copy_from_screen');
      assert.deepEqual(monitorCapture.monitorBounds, { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height });
      assertPng(monitorCapture.path, monitor.width, monitor.height);
    } finally { cleanup(monitorCapture.path); }
  } else {
    assert.equal(monitorCapture.status, 'unavailable');
    assert.equal(monitorCapture.captured, false);
    assert.equal(monitorCapture.usable, false);
    assert.equal(monitorCapture.method, 'copy_from_screen');
    assert.deepEqual(monitorCapture.monitorBounds, { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height });
  }

  const absentMonitor = desktop.screenCaptureMonitor({ monitorId: 'DISPLAY999999', filename: `${TEST_PREFIX}-missing-monitor.png` });
  assert.deepEqual(absentMonitor, {
    status: 'monitor_not_found', captured: false, usable: false, monitorId: 'DISPLAY999999', method: 'copy_from_screen'
  });
  assert.throws(() => desktop.screenCaptureMonitor({ monitorId: '../not-a-monitor' }), /monitorId is invalid/);

  if (monitorAvailable) {
    // A traversal-shaped name is normalized to a direct captures/ child before the
    // helper is called. Verify the resulting image and clean up only that generated
    // safe path.
    const confined = desktop.screenCaptureMonitor({ monitorId: monitor.monitorId, filename: `..\\..\\${TEST_PREFIX}-confined.png` });
    try {
      assert.equal(path.dirname(confined.path), CAPTURES_DIR);
      assertPng(confined.path, monitor.width, monitor.height);
    } finally { cleanup(confined.path); }

    // A capture name is create-only. A pre-existing capture could be a link planted
    // in captures/, so a repeated name gets a unique sibling and cannot overwrite
    // the first image. Hard links are not accepted as OCR inputs either.
    const collisionName = `${TEST_PREFIX}-collision.png`;
    const collisionFirst = desktop.screenCaptureMonitor({ monitorId: monitor.monitorId, filename: collisionName });
    const hardLink = path.join(CAPTURES_DIR, `${TEST_PREFIX}-hard-link.png`);
    let collisionSecond;
    try {
      const firstBytes = fs.readFileSync(collisionFirst.path);
      fs.linkSync(collisionFirst.path, hardLink);
      assert.throws(() => desktop.ocrRead({ path: collisionFirst.path }), /non-empty image/);
      collisionSecond = desktop.screenCaptureMonitor({ monitorId: monitor.monitorId, filename: collisionName });
      assert.notEqual(collisionSecond.path, collisionFirst.path);
      assert.deepEqual(fs.readFileSync(collisionFirst.path), firstBytes, 'an existing capture must not be overwritten');
      assertPng(collisionSecond.path, monitor.width, monitor.height);
    } finally {
      cleanup(hardLink);
      cleanup(collisionFirst.path);
      cleanup(collisionSecond && collisionSecond.path);
    }
  } else {
    console.log('Interactive screen surface unavailable; skipped monitor PNG/race assertions.');
  }

  const listed = desktop.windowList();
  assert.equal(listed.contentTrust, 'untrusted');
  assert.equal(listed.grantsAuthority, false);
  assert.equal(listed.count, listed.windows.length);
  assert.ok(listed.windows.length > 0, 'live window enumeration must exercise per-window validation');
  for (const window of listed.windows) {
    assert.match(window.windowId, /^[1-9][0-9]{0,18}$/);
    assert.ok(Number.isInteger(window.processId) && window.processId > 0);
    assert.equal(typeof window.appLabel, 'string');
    assert.equal(typeof window.title, 'string');
    assert.ok(window.width > 0 && window.height > 0);
    assert.equal(typeof window.isMinimized, 'boolean');
    assert.equal(typeof window.isOffscreen, 'boolean');
    assert.equal(typeof window.isPartial, 'boolean');
    if (window.captureEligible) assert.match(window.processStartKey, /^[0-9]{1,19}$/);
  }

  const candidate = listed.windows.find(window => window.captureEligible && !window.isMinimized
    && !/chrome|msedge|firefox/i.test(window.processName));
  assert.ok(candidate, 'live window capture requires a safe eligible non-browser window');
  if (!candidate) {
    console.log('No safe eligible non-browser window is available; skipped live PrintWindow rendering assertion.');
  } else {
    assert.throws(() => desktop.screenCaptureWindow({ windowId: candidate.windowId }), /expectedProcessId/);
    const mismatchFile = path.join(CAPTURES_DIR, `${TEST_PREFIX}-mismatch.png`);
    const mismatch = desktop.screenCaptureWindow(captureArgs(candidate, `${TEST_PREFIX}-mismatch.png`, { expectedProcessStartKey: '1' }));
    assert.equal(mismatch.status, 'target_changed');
    assert.equal(mismatch.captured, false);
    assert.equal(fs.existsSync(mismatchFile), false, 'a stale process identity must not create an image');

    const result = desktop.screenCaptureWindow(captureArgs(candidate, `${TEST_PREFIX}-window.png`));
    try {
      assert.match(result.status, /^(captured|blank_or_uniform|unavailable|target_changed)$/);
      assert.equal(result.method, 'printwindow_renderfullcontent');
      assert.equal(result.windowId, candidate.windowId);
      assert.notEqual(result.method, 'copy_from_screen', 'window capture must never photograph an occluder');
      if (result.captured) {
        assert.ok(result.path);
        assertPng(result.path, result.width, result.height);
        assert.equal(result.window.processId, candidate.processId);
        assert.equal(result.window.processStartKey, candidate.processStartKey);
      } else {
        assert.equal(result.usable, false);
      }
    } finally { cleanup(result.path); }
  }

  const minimized = listed.windows.find(window => window.captureEligible && window.isMinimized
    && !/chrome|msedge|firefox/i.test(window.processName));
  if (minimized) {
    const result = desktop.screenCaptureWindow(captureArgs(minimized, `${TEST_PREFIX}-minimized.png`));
    try {
      assert.match(result.status, /^(captured|blank_or_uniform|unavailable|target_changed)$/);
      assert.equal(result.method, 'printwindow_renderfullcontent');
      if (result.window) assert.equal(result.window.isMinimized, true);
      if (result.status === 'blank_or_uniform') assert.equal(result.usable, false);
    } finally { cleanup(result.path); }
  }

  console.log('Desktop app capture tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
