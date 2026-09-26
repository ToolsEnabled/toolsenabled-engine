// Discrimination report (testcanfail-tests-auth-duo-duo-desktop-js):
// - NOT-FOUND (1): no loop/forEach in this test contains an assertion that can
//   be skipped by an empty collection.
// - NOT-FOUND (2): no exit-status/nonzero/truthy-process-return assertion is
//   used as evidence of subject behavior.
// - NOT-FOUND (3): no try/catch or optional chain swallows an assertion failure.
// - NOT-FOUND (4): injected process seams simulate external executors; no mock
//   replaces the parsing or status-summary behavior under test.
// - NOT-FOUND (5): this file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected results are explicit fixtures, not computed by the
//   same implementation path being checked.
// - PRECONDITION: live Windows/Duo status probing was unavailable and was not
//   needed; the deterministic parser and injected-seam tests ran.

'use strict';

require('../lib/isolated-environment').activate('duo-desktop');
const assert = require('node:assert/strict');
const duo = require('../../src/lib/providers/duo-desktop');

const healthyProbe = JSON.stringify({
  Installed: true,
  Version: '7.19.0.0',
  SignatureValid: true,
  SignerMatches: true,
  ProcessRunning: true,
  ServicesReady: true
});

(async () => {
  assert.deepEqual(duo.versionParts('6.12.0'), [6, 12, 0, 0]);
  assert.equal(duo.versionParts('6.12.bad'), null);
  assert.equal(duo.versionAtLeast('6.12.0.0'), true);
  assert.equal(duo.versionAtLeast('6.11.9.9'), false);
  assert.equal(duo.versionAtLeast('7.0.0.0'), true);

  const parsed = duo.parseStatusProbe(healthyProbe);
  assert.equal(parsed.Version, '7.19.0.0');
  assert.deepEqual(duo.summarizeStatus(parsed), {
    installed: true,
    version: '7.19.0.0',
    signature: 'valid_duo',
    running: true,
    services: 'ready',
    authenticationMethodCapable: true,
    enrollment: 'verified_only_during_live_prompt',
    preferredRoute: 'duo_desktop',
    fallbacks: ['remembered_device', 'duo_mobile_or_other_provider_method'],
    ownerPresence: 'provider_enforced'
  });
  assert.throws(
    () => duo.parseStatusProbe(JSON.stringify({ ...parsed, Unexpected: true })),
    error => error && error.code === 'DUO_DESKTOP_STATUS_INVALID'
  );

  const statusAudits = [];
  const status = await duo.desktopStatus({}, {
    platform: 'win32',
    audit: { record(action, target, details) { statusAudits.push({ action, target, details }); } },
    runStatusProbe: async (command, timeoutMs) => {
      assert.equal(command, duo.STATUS_PROBE);
      assert.equal(timeoutMs, duo.STATUS_TIMEOUT_MS);
      return { ok: true, stdout: healthyProbe };
    }
  });
  assert.equal(status.authenticationMethodCapable, true);
  assert.deepEqual(statusAudits, [{
    action: 'duo.desktop_status',
    target: 'local-duo-desktop',
    details: status
  }]);

  let unsupportedProbeCalls = 0;
  let unsupportedError;
  await assert.rejects(
    () => duo.desktopStatus({}, {
      platform: 'linux',
      audit: { record() {} },
      runStatusProbe: async () => { unsupportedProbeCalls += 1; return { ok: true, stdout: healthyProbe }; }
    }),
    error => {
      unsupportedError = error;
      return error && error.code === 'DUO_DESKTOP_PLATFORM_UNSUPPORTED'
        && /only on Windows/.test(error.message);
    }
  );
  assert.equal(unsupportedProbeCalls, 0, 'an unsupported platform must be decided without attempting the Windows probe');

  let probeFailureError;
  await assert.rejects(
    () => duo.desktopStatus({}, {
      platform: 'win32',
      audit: { record() {} },
      runStatusProbe: async () => ({ ok: false, stdout: '' })
    }),
    error => {
      probeFailureError = error;
      return error && error.code === 'DUO_DESKTOP_STATUS_PROBE_FAILED'
        && /could not be completed/.test(error.message);
    }
  );
  assert.notEqual(unsupportedError.code, probeFailureError.code);
  await assert.rejects(
    () => duo.desktopStatus({}, {
      platform: 'win32',
      audit: { record() {} },
      runStatusProbe: async () => { throw new Error('raw probe failure must not escape'); }
    }),
    error => error && error.code === 'DUO_DESKTOP_STATUS_PROBE_FAILED'
      && !/raw probe failure/.test(error.message)
  );

  process.stdout.write('Duo Desktop provider tests passed.\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
