'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { STATUS } = require('../../src/lib/multi-account/health.js');
const {
  CLAUDE_USAGE_PROBE_TIMEOUT_MS,
  CODE,
  DEFAULT_FAILOVER_MODE,
  FAILOVER_MODES,
  STATE_LEAF,
  claudeProbeFactory,
  claudeStatusOf,
  normalizeMode,
  resolveAccountForSession,
  resolveThresholds,
  statePathFor
} = require('../../src/lib/multi-account/rotation.js');

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('failover mode defaults safely to manual for absent and invalid values', () => {
  assert.deepStrictEqual(FAILOVER_MODES, ['manual', 'auto']);
  assert.strictEqual(DEFAULT_FAILOVER_MODE, 'manual');
  assert.strictEqual(normalizeMode(), 'manual');
  assert.strictEqual(normalizeMode('automatic'), 'manual');
  assert.strictEqual(normalizeMode('auto'), 'auto');
});

check('the state filename is joined beneath the supplied services root', () => {
  assert.strictEqual(STATE_LEAF, 'multi-account-state.json');
  assert.strictEqual(
    statePathFor(path.join('var', 'agent-services')),
    path.join('var', 'agent-services', 'multi-account-state.json')
  );
});

check('Claude subscription observations map to switcher health statuses', () => {
  const states = {
    AUTHENTICATED: 'authenticated',
    RATE_LIMITED: 'rate_limited',
    SIGNED_OUT: 'signed_out',
    EXPIRED: 'expired'
  };
  assert.strictEqual(claudeStatusOf({ state: states.AUTHENTICATED, billingSource: 'subscription' }, states), STATUS.HEALTHY);
  assert.strictEqual(claudeStatusOf({ state: states.RATE_LIMITED, billingSource: 'subscription' }, states), STATUS.EXHAUSTED);
  assert.strictEqual(claudeStatusOf({ state: states.SIGNED_OUT, billingSource: 'subscription' }, states), STATUS.SIGNED_OUT);
  assert.strictEqual(claudeStatusOf({ state: states.EXPIRED, billingSource: 'subscription' }, states), STATUS.SIGNED_OUT);
  assert.strictEqual(claudeStatusOf({ state: 'unknown', billingSource: 'subscription' }, states), STATUS.TRANSIENT);
});

check('a signed-in subscription home that made no live request is selectable; one whose live request failed is not', () => {
  const states = { AUTHENTICATED: 'authenticated', INDETERMINATE: 'indeterminate' };
  // The free probe path (capability: false): identity and billing route proven, serve unproven.
  assert.strictEqual(
    claudeStatusOf({ state: states.INDETERMINATE, capabilityRan: false, billingSource: 'subscription' }, states),
    STATUS.HEALTHY
  );
  // A live request was made and failed for no attributable reason: still transient.
  assert.strictEqual(
    claudeStatusOf({ state: states.INDETERMINATE, capabilityRan: true, billingSource: 'subscription' }, states),
    STATUS.TRANSIENT
  );
  // The billing gate outranks the unproven path: a metered key is never selected.
  assert.strictEqual(
    claudeStatusOf({ state: states.INDETERMINATE, capabilityRan: false, billingSource: 'api_key' }, states),
    STATUS.EXHAUSTED
  );
  // An older probe result without the field is not promoted.
  assert.strictEqual(
    claudeStatusOf({ state: states.INDETERMINATE, billingSource: 'subscription' }, states),
    STATUS.TRANSIENT
  );
});

check('Claude API-key billing is exhausted even when authentication is healthy', () => {
  const states = { AUTHENTICATED: 'authenticated' };
  assert.strictEqual(claudeStatusOf({ state: states.AUTHENTICATED, billingSource: 'api_key' }, states), STATUS.EXHAUSTED);
});

check('an unsupported provider preserves the ordinary launch path', async () => {
  // Gemini became a supported folder-based provider, so the negative control
  // is now a provider this registry has never heard of.
  const result = await resolveAccountForSession({ provider: 'mistral', servicesRoot: '/unused' });
  assert.strictEqual(result.rotated, false);
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(result.code, CODE.NONE_FOR_PROVIDER);
  assert.strictEqual(result.account, null);
  assert.strictEqual(result.env, null);
});

/* THE TWO CLAUDE CHILD PROCESSES START TOGETHER.
 *
 * WHAT THIS GUARDS. claudeProbeFactory spawns the Claude program twice per
 * account -- `claude auth status --json` for the sign-in, and the CLI's control
 * protocol for the usage figure. Neither reads any part of the other's answer.
 * They used to run one after the other, which bought the program's start-up
 * time twice and sat directly in front of pressing Start. MEASURED 2026-09-03
 * on this machine (claude.CMD, an empty scratch CLAUDE_CONFIG_DIR, five rounds,
 * medians): auth 481.2 ms, usage 1282.9 ms, sequentially 1736.6 ms, together
 * 1482.4 ms -- 254.2 ms per account read, and a usage-ranked mode reads every
 * listed account.
 *
 * WHY THE ASSERTION IS STRUCTURAL AND NOT A STOPWATCH. A wall-clock budget on a
 * loaded machine is a flaky test. This holds the auth probe open and asserts the
 * usage probe has ALREADY BEEN ENTERED while it is held -- which is false for
 * any sequential arrangement, whatever the machine is doing.
 *
 * MUTATION AUDIT 2026-09-03: restoring the sequential shape in
 * src/lib/multi-account/rotation.js (`const observed = await askAuth(...)`
 * before the usage call, as it stood at abbe37c) makes this check fail with
 * "the usage probe had not been entered while the auth probe was still running"
 * (5/7 -> reported below); the check passes again once the concurrent shape is
 * restored. */
check('the Claude auth and usage probes are in flight at the same time', async () => {
  const account = { name: 'one', provider: 'claude', configDir: path.join(path.parse(process.cwd()).root, 'fixture-homes', 'one'), priority: 1 };

  let usageEntered = false;
  let releaseAuth;
  const authHeld = new Promise(resolve => { releaseAuth = resolve; });

  const probe = claudeProbeFactory({
    homeDir: path.join(path.parse(process.cwd()).root, 'fixture-homes'),
    fsImpl: { readFileSync() { throw Object.assign(new Error('no cache'), { code: 'ENOENT' }); } },
    exhaustedAtPercent: 99,
    authProbe: async () => {
      await authHeld;
      return { state: 'indeterminate', capabilityRan: false, billingSource: 'subscription', account: null, plan: null, reason: 'held' };
    },
    usageProbe: async () => {
      usageEntered = true;
      return { status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null };
    }
  });

  const reading = probe(account);
  // Two turns of the microtask queue is all a started promise needs to reach
  // its first statement; the auth probe is still parked on `authHeld`.
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(usageEntered, true,
    'the usage probe had not been entered while the auth probe was still running -- '
    + 'the two child processes are being started one after the other again');

  releaseAuth();
  const answer = await reading;
  assert.strictEqual(answer.account, 'one');
  assert.strictEqual(answer.status, STATUS.HEALTHY,
    'running the two probes together changed what the account was judged to be');
});

/* Running both probes together must preserve the live allowance and auth
 * outcomes independently. A cache that is not bound to this sign-in cannot
 * fill in an unavailable live reading. Auth faults still reach the caller. */
check('starting both probes together preserves live usage without adopting an unbound cache', async () => {
  const account = { name: 'one', provider: 'claude', configDir: path.join(path.parse(process.cwd()).root, 'fixture-homes', 'one'), priority: 1 };
  const cached = JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() - 60_000,
      utilization: { limits: [{ kind: 'seven_day', percent: 40, resets_at: null, is_active: true }] }
    }
  });
  let cacheReads = 0;
  const fsImpl = { readFileSync: () => { cacheReads += 1; return cached; } };
  const signedIn = async () => ({
    state: 'indeterminate', capabilityRan: false, billingSource: 'subscription',
    account: null, plan: null, reason: 'stub'
  });
  const factory = usageProbe => claudeProbeFactory({
    homeDir: path.join(path.parse(process.cwd()).root, 'fixture-homes'), fsImpl, exhaustedAtPercent: 99, authProbe: signedIn, usageProbe
  });

  const asked = [];
  const live = await factory(async ({ configDir, timeoutMs }) => {
    asked.push([configDir, timeoutMs]);
    return { status: 'MEASURED', limits: [{ kind: 'seven_day', percent: 95, resets_at: null, is_active: true }] };
  })(account);
  assert.deepStrictEqual(asked, [[account.configDir, CLAUDE_USAGE_PROBE_TIMEOUT_MS]],
    'the live surface was not asked about this folder, with this budget');
  assert.strictEqual(live.usedPercent, 95, 'the cache outranked a live measurement');

  const faulted = await factory(async () => { throw new Error('program missing'); })(account);
  assert.strictEqual(faulted.usedPercent, null, 'a failed live read must not adopt a cached identity’s figure');
  assert.strictEqual(faulted.status, STATUS.HEALTHY);
  assert.strictEqual(faulted.canServe, true);
  assert.strictEqual(faulted.usageStatus, 'unavailable');

  const absent = await factory(null)(account);
  assert.strictEqual(absent.usedPercent, null, 'without a live surface usage remains unknown');
  assert.strictEqual(absent.status, STATUS.HEALTHY);
  assert.strictEqual(absent.canServe, true);
  assert.strictEqual(absent.usageStatus, 'unavailable');
  assert.strictEqual(cacheReads, 0, 'account selection must not read the unbound provider cache');

  /* An auth probe that throws still reaches the caller. The usage promise now
     exists before that throw, so this also proves it cannot become an
     unhandled rejection: node exits non-zero on one, and this file's runner
     would not report the check as passed. */
  let thrown = null;
  try {
    await claudeProbeFactory({
      homeDir: path.join(path.parse(process.cwd()).root, 'fixture-homes'), fsImpl, exhaustedAtPercent: 99,
      authProbe: async () => { throw new Error('auth surface faulted'); },
      usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null })
    })(account);
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, 'an auth probe that throws no longer reaches the caller');
  assert.strictEqual(thrown.message, 'auth surface faulted');
});

/* THE IDENTITY GATE ON THE CLAUDE LEG.
 *
 * WHAT THIS GUARDS. Nothing checked that a Claude sign-in landed in the account
 * its row is named for. `expectEmail` was compared in exactly one place in the
 * engine -- health.js's classifyProbe, the Codex leg -- and claudeProbeFactory
 * read the probe's e-mail only to copy it into the answer. Pressing Sign in
 * beside a row opens the program's own browser window, and whichever account
 * that browser is already holding is the one signed in; the product never sees
 * that choice. So the wrong account could be signed in under a row labelled
 * "work", every later start would use it, and nothing said so.
 *
 * THREE CASES, BECAUSE THERE ARE THREE ANSWERS. Recorded and equal (the account
 * is what it claims). Recorded and different (a refusal a person can read, and
 * NOT a failover state -- the wrong identity is a fault to see, not to route
 * around). Recorded and unreadable (the probe answered no address at all):
 * "could not look" is not "not there", so it stops rather than accuses. And the
 * fourth, which is the one every registry on disk today is in: nothing
 * recorded, nothing checked, nothing changed.
 *
 * VALUES, NOT SPELLINGS. Each case calls the factory with an account object and
 * asserts on the status, canServe and the sentence's content. */
check('a Claude account is held to the sign-in its entry expects, when its entry names one', async () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'fixture-homes');
  const signedInAs = address => async () => ({
    state: 'indeterminate', capabilityRan: false, billingSource: 'subscription',
    account: address, plan: 'max', reason: 'stub'
  });
  const probeFor = (account, address) => claudeProbeFactory({
    homeDir,
    fsImpl: { readFileSync() { throw Object.assign(new Error('no cache'), { code: 'ENOENT' }); } },
    exhaustedAtPercent: 99,
    authProbe: signedInAs(address),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null })
  })(account);

  const named = {
    name: 'work', provider: 'claude', configDir: path.join(path.parse(process.cwd()).root, 'fixture-homes', 'work'),
    priority: 1, expectEmail: 'work@example.test'
  };

  // 1. RECORDED AND EQUAL. Case and surrounding space are not a difference.
  const matched = await probeFor(named, '  Work@Example.Test ');
  assert.strictEqual(matched.status, STATUS.HEALTHY,
    'a Claude home signed in as the account its entry expects was refused');
  assert.strictEqual(matched.canServe, true);

  // 2. RECORDED AND DIFFERENT. Refused, unusable, and the sentence names the
  //    address that is actually there -- the one the person has to recognise.
  const wrong = await probeFor(named, 'someone.else@example.test');
  assert.strictEqual(wrong.status, STATUS.ACCOUNT_MISMATCH,
    'a Claude home signed in as a different account passed as usable');
  assert.strictEqual(wrong.canServe, false);
  assert.match(wrong.reason, /someone\.else@example\.test/,
    'the refusal does not say which account is actually signed in');
  assert.ok(!wrong.reason.includes('CLAUDE_CONFIG_DIR'),
    'the refusal sends a person to an environment variable rather than to a press on the menu');
  // An allowance read off the wrong identity is somebody else's subscription,
  // so the usage-ranked modes must be given nothing to rank it on.
  assert.strictEqual(wrong.usedPercent, null);
  assert.strictEqual(wrong.windows.hourly, null);
  assert.strictEqual(wrong.windows.weekly, null);
  // The address is still reported, because the row has to be able to show it.
  assert.strictEqual(wrong.email, 'someone.else@example.test');

  // 3. RECORDED AND UNREADABLE. Not an accusation and not a pass.
  const silent = await probeFor(named, null);
  assert.strictEqual(silent.status, STATUS.TRANSIENT,
    'a sign-in that reported no account at all was judged as though it had');
  assert.strictEqual(silent.canServe, false);
  assert.ok(!/not the account it expects/.test(silent.reason),
    'a sign-in that said nothing was accused of being the wrong account');

  // 4. NOTHING RECORDED. Every registry written before this is here.
  const unnamed = { name: 'work', provider: 'claude', configDir: path.join(path.parse(process.cwd()).root, 'fixture-homes', 'work'), priority: 1 };
  for (const address of ['anyone@example.test', null]) {
    const reading = await probeFor(unnamed, address);
    assert.strictEqual(reading.status, STATUS.HEALTHY,
      `an entry that expects no particular account was refused for being signed in as ${address}`);
    assert.strictEqual(reading.canServe, true);
  }
});

/* AND THE GATE DOES NOT SPEAK OVER A FAULT THE PERSON HAS TO FIX FIRST. A home
 * that is signed out reports no address, and answering "the two could not be
 * compared" there would replace the one sentence that tells them what to do. */
check('a signed-out Claude home keeps its own reason even when its entry expects an account', async () => {
  const account = {
    name: 'work', provider: 'claude', configDir: path.join(path.parse(process.cwd()).root, 'fixture-homes', 'work'),
    priority: 1, expectEmail: 'work@example.test'
  };
  const reading = await claudeProbeFactory({
    homeDir: path.join(path.parse(process.cwd()).root, 'fixture-homes'),
    fsImpl: { readFileSync() { throw Object.assign(new Error('no cache'), { code: 'ENOENT' }); } },
    exhaustedAtPercent: 99,
    authProbe: async () => ({
      state: 'signed_out', capabilityRan: false, billingSource: null, account: null, plan: null,
      reason: 'This Claude CLI has no signed-in account. Run `claude auth login` for it.'
    }),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null })
  })(account);
  assert.strictEqual(reading.status, STATUS.SIGNED_OUT,
    'the identity check overrode a sign-out, which is the fault a person has to fix first');
  assert.match(reading.reason, /no signed-in account/);
});

/* THE CUT GATE FOR T367: A PERSON'S OWN SAVED CONVERSATION IS NOT REFUSED BY
 * THEIR OWN SETTING.
 *
 * WHAT WENT WRONG. The Accounts page carries a start cutoff. It exists to spread
 * AUTOMATIC starts across accounts. It was also applied to an exact resume --
 * and a resume is not a selection: the thread lives in one account's home and no
 * other account can continue it. MEASURED on the owner's machine: an hourly
 * cutoff of 25% classed every account past a quarter of its 5-hour window as
 * spent, and seventeen start refusals in one day were all this, none from a
 * provider. A saved Manager on an account with most of its WEEK left was
 * refused four times.
 *
 * WHY THIS ASSERTS THE DECISION AND NOT A SENTENCE. The refusal wording will and
 * should improve. A gate that pinned the string would fail against a better
 * message, and the quickest way back to green would be to put the defect back.
 * So it asserts the two things that decide the behaviour: which limit a resolve
 * is judged against, and that the same measured account classifies differently
 * under each.
 *
 * MUTATION AUDIT, both directions recorded because a gate nobody has broken is
 * a gate nobody has tested. Making resolveThresholds() ignore
 * `providerLimitsOnly` -- the defect -- turns this RED on the first assertion;
 * restoring it is GREEN.
 */
check('an exact resume is judged on the provider ceiling, not the configured cutoff', () => {
  const registry = { exhaustedAtPercent: 90, exhaustedAtPercentHourly: 25, exhaustedAtPercentWeekly: 100 };

  // AUTOMATIC selection keeps the person's own numbers. Nothing is relaxed.
  const automatic = resolveThresholds(registry, false);
  assert.strictEqual(automatic.exhaustedAtPercentHourly, 25,
    'an automatic start must still honour the configured hourly cutoff');
  assert.strictEqual(automatic.exhaustedAtPercent, 90);

  // A RESUME is judged on what the provider itself would refuse.
  const resume = resolveThresholds(registry, true);
  assert.strictEqual(resume.exhaustedAtPercentHourly, 100,
    'a saved conversation is being refused by a limit set on this computer');
  assert.strictEqual(resume.exhaustedAtPercentWeekly, 100);
  assert.strictEqual(resume.exhaustedAtPercent, 100);

  // And the two answers must actually differ, or the gate proves nothing.
  assert.notDeepStrictEqual(automatic, resume,
    'the resume path and an automatic start are being judged identically');
});

check('the same measured account is spent for an automatic start and usable for a resume', () => {
  const windows = require('../../src/lib/multi-account/usage-windows.js');
  const registry = { exhaustedAtPercent: 90, exhaustedAtPercentHourly: 25, exhaustedAtPercentWeekly: 100 };
  /* The owner's shape: past the configured quarter-hour cutoff, nowhere near
     spending its week. */
  const measured = {
    hourly: windows.windowRecord({ kind: 'hourly', percent: 55 }),
    weekly: windows.windowRecord({ kind: 'weekly', percent: 16 })
  };

  const forAutomatic = windows.spentWindow(measured, windows.windowLimits(resolveThresholds(registry, false)));
  assert.ok(forAutomatic, 'the configured cutoff no longer classes this account spent for automatic starts');
  assert.strictEqual(forAutomatic.kind, 'hourly');
  assert.ok(forAutomatic.limit < 100, "a limit below 100 is a choice made on this computer, not by the provider");

  const forResume = windows.spentWindow(measured, windows.windowLimits(resolveThresholds(registry, true)));
  assert.strictEqual(forResume, null,
    'a saved conversation on this account is still being turned away');

  /* A genuinely spent account is still refused on the resume path, or the fix
     would have become "resumes always start". */
  const reallySpent = {
    hourly: windows.windowRecord({ kind: 'hourly', percent: 100 }),
    weekly: windows.windowRecord({ kind: 'weekly', percent: 100 })
  };
  assert.ok(windows.spentWindow(reallySpent, windows.windowLimits(resolveThresholds(registry, true))),
    'an account with nothing left must still be refused for a resume');
});

(async () => {
  assert.strictEqual(checks.length, 12, 'every behavior check must remain registered');
  let failures = 0;
  for (const [name, run] of checks) {
    try {
      await run();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`FAIL ${name}\n${error.stack}\n`);
    }
  }
  process.stdout.write(`\n${checks.length - failures}/${checks.length} checks passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
