// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-auth-duo-duo-desktop-js):
// - STRENGTHENED: the approval-script InvokePattern assertion. Mutation:
//   replace the sole `.Invoke()` actuator call with `$null = $candidates[0]`.
//   Before strengthening, this test stayed green because other InvokePattern
//   references satisfied the broad regex. With the assertion below, RED was:
//     AssertionError [ERR_ASSERTION]: The input did not match the regular expression
//     /\[System\.Windows\.Automation\.InvokePattern\][^\r\n]*\.Invoke\(\)/.
//   The mutated source was restored byte-for-byte; the final green run was:
//     Duo Desktop provider tests passed.
// - NOT-FOUND (1): no loop/forEach in this test contains an assertion that can
//   be skipped by an empty collection.
// - NOT-FOUND (2): no exit-status/nonzero/truthy-process-return assertion is
//   used as evidence of subject behavior.
// - NOT-FOUND (3): no try/catch or optional chain swallows an assertion failure.
// - NOT-FOUND (4): injected process seams simulate external executors; no mock
//   replaces the parsing, policy, or approval behavior under test.
// - NOT-FOUND (5): this file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected results are explicit fixtures, not computed by the
//   same implementation path being checked.
// - PRECONDITION: live Windows/Duo UI automation was unavailable and was not
//   needed; the deterministic script-contract and injected-seam tests ran.

'use strict';

require('../lib/isolated-environment').activate('duo-desktop');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const duo = require('../../src/lib/providers/duo-desktop');
const approval = require('../../src/lib/providers/duo-desktop-approval');

// Fixture alias, not the owner's real configured Duo/UCR account: this test
// must pass identically regardless of what (if anything) is configured on
// the machine that runs it, so every duo.ucrLogin() call below injects this
// via the overrides.ucrAccount seam instead of relying on real config.
const FIXTURE_UCR_ACCOUNT = 'acct-institutional';

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

  // A transient registry read failure is not "no account" and is not latched:
  // the next call retries. Once the read succeeds, the stable configuration
  // answer remains cached, preserving the reason this resolver has a cache.
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    let accountReads = 0;
    const resolveAccount = duo.createUcrAccountResolver({
      duoAccount() {
        accountReads += 1;
        if (accountReads === 1) throw Object.assign(new Error('temporary registry read failure'), { code });
        return { alias: FIXTURE_UCR_ACCOUNT };
      }
    });
    assert.throws(
      () => resolveAccount(),
      error => error && error.code === 'DUO_DESKTOP_ACCOUNT_PROBE_FAILED'
        && /does not mean that the account is absent/.test(error.message)
    );
    assert.equal(resolveAccount(), FIXTURE_UCR_ACCOUNT, `${code} must be retried`);
    assert.equal(resolveAccount(), FIXTURE_UCR_ACCOUNT);
    assert.equal(accountReads, 2, 'a successful account read remains cached');
  }

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

  const loginAudits = [];
  const login = await duo.ucrLogin({ account: FIXTURE_UCR_ACCOUNT, timeoutSeconds: 120 }, {
    platform: 'win32',
    ucrAccount: FIXTURE_UCR_ACCOUNT,
    audit: { record(action, target, details) { loginAudits.push({ action, target, details }); } },
    runStatusProbe: async () => ({ ok: true, stdout: healthyProbe }),
    runLogin: async ({ timeoutMs, exactAgentApproval }) => {
      assert.equal(timeoutMs, 120000);
      assert.equal(exactAgentApproval, false);
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          url: 'https://drive.google.com/drive/my-drive?must-not-leak=1',
          steps: [
            'navigate-drive',
            'google-identifier',
            'cas-signin',
            'duo-desktop-authentication-pending-owner-presence',
            'google-speedbump-continue'
          ]
        })
      };
    }
  });
  assert.deepEqual(login, {
    status: 'signed_in',
    account: FIXTURE_UCR_ACCOUNT,
    target: 'ucr_google_workspace',
    route: 'duo_desktop',
    duoDesktopApproval: 'owner_presence',
    ownerPresence: 'completed_in_provider_owned_windows_prompt',
    fallbacksRetained: ['remembered_device', 'duo_mobile_or_other_provider_method']
  });
  assert.doesNotMatch(JSON.stringify(loginAudits), /drive\.google|must-not-leak/i);
  assert.equal(loginAudits.at(-1).action, 'duo.ucr_login');

  await assert.rejects(
    () => duo.ucrLogin({ account: 'acct-primary' }, {
      ucrAccount: FIXTURE_UCR_ACCOUNT,
      audit: { record() {} },
      runStatusProbe: async () => { throw new Error('must not run'); },
      runLogin: async () => { throw new Error('must not run'); }
    }),
    error => error && error.code === 'DUO_DESKTOP_ACCOUNT_MISMATCH'
  );

  const exactLogin = await duo.ucrLogin({
    account: FIXTURE_UCR_ACCOUNT, timeoutSeconds: 120, duoDesktopApproval: 'exact_owner_requested'
  }, {
    platform: 'win32',
    ucrAccount: FIXTURE_UCR_ACCOUNT,
    audit: { record() {} },
    runStatusProbe: async () => ({ ok: true, stdout: healthyProbe }),
    runLogin: async ({ timeoutMs, exactAgentApproval }) => {
      assert.equal(timeoutMs, 120000);
      assert.equal(exactAgentApproval, true);
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          steps: ['duo-desktop-selected', 'duo-desktop-authentication-pending-owner-presence', 'duo-desktop-approve-invoked']
        })
      };
    }
  });
  assert.equal(exactLogin.status, 'signed_in');
  assert.equal(exactLogin.duoDesktopApproval, 'exact_owner_requested');

  await assert.rejects(
    () => duo.ucrLogin({ account: FIXTURE_UCR_ACCOUNT, duoDesktopApproval: 'anything_else' }, {
      ucrAccount: FIXTURE_UCR_ACCOUNT,
      audit: { record() {} }, runStatusProbe: async () => ({ ok: true, stdout: healthyProbe }), runLogin: async () => ({ ok: false, stdout: '{}' })
    }),
    error => error && error.code === 'DUO_DESKTOP_APPROVAL_MODE_INVALID'
  );

  // No Duo/UCR account configured is refused as not-configured, distinctly
  // from a mismatched-account refusal.
  await assert.rejects(
    () => duo.ucrLogin({ account: FIXTURE_UCR_ACCOUNT }, {
      ucrAccount: null,
      audit: { record() {} },
      runStatusProbe: async () => { throw new Error('must not run'); },
      runLogin: async () => { throw new Error('must not run'); }
    }),
    error => error && error.code === 'DUO_DESKTOP_ACCOUNT_NOT_CONFIGURED'
  );

  await assert.rejects(
    () => duo.ucrLogin({ account: FIXTURE_UCR_ACCOUNT, timeoutSeconds: 60 }, {
      platform: 'win32',
      ucrAccount: FIXTURE_UCR_ACCOUNT,
      audit: { record() {} },
      runStatusProbe: async () => ({ ok: true, stdout: healthyProbe }),
      runLogin: async () => ({
        ok: false,
        timedOut: true,
        stdout: JSON.stringify({
          ok: false,
          steps: ['duo-desktop-authentication-pending-owner-presence'],
          reason: 'raw provider text must not be surfaced'
        })
      })
    }),
    error => error && error.code === 'DUO_DESKTOP_OWNER_PRESENCE_TIMEOUT'
      && !/raw provider text/i.test(error.message)
  );

  assert.throws(
    () => duo.parseLoginResult(JSON.stringify({ ok: true, steps: ['untrusted-step'] })),
    error => error && error.code === 'DUO_DESKTOP_LOGIN_RESULT_INVALID'
  );
  assert.equal(duo.classifyLoginFailure({ code: 'ETIMEDOUT' }, ''), 'timeout');
  assert.equal(duo.classifyLoginFailure({ code: 1 }, 'Profile directory is locked by another ProcessSingleton'), 'browser_session_busy');
  assert.equal(duo.classifyLoginFailure({ code: 1 }, 'unclassified helper failure'), 'helper_failed');
  assert.equal(
    duo.normalizeLoginProtocol('launcher emitted unexpected text', 'browser_session_busy'),
    JSON.stringify({ ok: false, steps: [], failure: 'browser_session_busy' })
  );
  const waitingProtocol = JSON.stringify({ ok: false, steps: ['duo-desktop-authentication-pending-owner-presence'] });
  assert.equal(duo.normalizeLoginProtocol(waitingProtocol, 'helper_failed'), waitingProtocol);
  assert.deepEqual(
    duo.parseLoginResult(JSON.stringify({ ok: false, steps: [], failure: 'browser_session_busy' })),
    { ok: false, steps: [], failure: 'browser_session_busy' }
  );
  assert.throws(
    () => duo.parseLoginResult(JSON.stringify({ ok: false, steps: [], failure: 'untrusted' })),
    error => error && error.code === 'DUO_DESKTOP_LOGIN_RESULT_INVALID'
  );

  const approvalAudits = [];
  const approvalResult = await approval.approveExactPendingPrompt({ timeoutMs: 1000 }, {
    audit: { record(action, target, details) { approvalAudits.push({ action, target, details }); } },
    runApproval: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 1000);
      return { ok: true, stdout: JSON.stringify({ status: 'invoked' }) };
    }
  });
  assert.deepEqual(approvalResult, {
    status: 'invoked', invoked: true, scope: 'exact_live_ucr_duo_desktop_prompt'
  });
  assert.equal(approvalAudits[0].action, 'duo.desktop_approval_attempt');
  assert.deepEqual(approval.parseResult(JSON.stringify({ status: 'not_found' })), { status: 'not_found', invoked: false });
  assert.throws(
    () => approval.parseResult(JSON.stringify({ status: 'invoked', title: 'untrusted' })),
    error => error && error.code === 'DUO_DESKTOP_APPROVAL_RESULT_INVALID'
  );
  await assert.rejects(
    () => approval.approveExactPendingPrompt({ timeoutMs: 1000 }, {
      runApproval: async () => ({ ok: false, stdout: '' })
    }),
    error => error && error.code === 'DUO_DESKTOP_APPROVAL_UNAVAILABLE'
  );
  await assert.rejects(
    () => approval.approveExactPendingPrompt({ timeoutMs: 1000 }, {
      runApproval: async () => { throw new Error('helper transport failed'); }
    }),
    /helper transport failed/
  );
  await assert.rejects(
    () => approval.approveExactPendingPrompt({ timeoutMs: 999 }),
    error => error && error.code === 'DUO_DESKTOP_APPROVAL_TIMEOUT_INVALID'
  );
  const approvalScript = fs.readFileSync(approval.APPROVAL_SCRIPT, 'utf8');
  assert.match(approvalScript, /Get-AuthenticodeSignature/);
  assert.match(approvalScript, /Name -cne 'Approve'/);
  assert.match(approvalScript, /InvokePattern/);
  assert.match(approvalScript, /\[System\.Windows\.Automation\.InvokePattern\][^\r\n]*\.Invoke\(\)/);
  assert.doesNotMatch(approvalScript, /SendKeys|mouse_event|SetCursorPos/i);

  const proofGates = [
    { instruction: 'The approval target is bound to an exact owner-requested Duo handoff.', met: true, evidence: 'fixture' },
    { instruction: duo.EXACT_APPROVAL_PROOF_GATE, met: false, evidence: '' },
    { instruction: 'Unrelated or ambiguous Duo requests are refused and audited.', met: true, evidence: 'fixture' }
  ];
  assert.equal(Object.hasOwn(duo, 'EXACT_APPROVAL_OWNER_REQUEST_ID'), false,
    'the provider exports no historical magic request id');
  assert.equal(duo.allowsExactApprovalLiveProof({
    requestId: 'R2001', gates: proofGates, input: { duoDesktopApproval: 'exact_owner_requested' }
  }), true, 'current request-local gate evidence authorizes the bounded live proof');
  assert.equal(duo.allowsExactApprovalLiveProof({
    requestId: 'R86', gates: [], input: { duoDesktopApproval: 'exact_owner_requested' }
  }), false, 'a historical request-id collision alone confers no MFA actuation authority');
  assert.equal(duo.allowsExactApprovalLiveProof({
    requestId: 'R86', gates: proofGates, input: { duoDesktopApproval: 'exact_owner_requested' }
  }), duo.allowsExactApprovalLiveProof({
    requestId: 'R2001', gates: proofGates, input: { duoDesktopApproval: 'exact_owner_requested' }
  }), 'request numbers are not authorization semantics; only current gate provenance decides');

  process.stdout.write('Duo Desktop provider tests passed.\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
