'use strict';
/* HEALTH CLASSIFICATION, DRIVEN THROUGH THE PURE SEAM.
 *
 * classifyProbe() is the one place that turns what the Codex account surface
 * said into a status the switcher may act on, and it is pure: every fixture
 * below is a captured answer shape, no process is started and no home is
 * opened. probeSignInPresence() is the Gemini judgement, presence only, and
 * is driven here through an injected filesystem for the same reason.
 *
 * THE FIXTURE THAT MATTERS is the first one. A Codex account whose WEEKLY
 * window is fully spent while its five-hour window is fresh used to classify
 * as healthy, and the usage-ranked modes then put it at the head of every
 * start. That fixture is the defect, stated as a test that fails on the old
 * comparison.
 *
 *   node --test tests/multi-account-health.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { STATUS, classifyProbe, probeAccount, probeSignInPresence } = require('../src/lib/multi-account/health.js');

const ACCOUNT = Object.freeze({ name: 'acct', provider: 'codex', home: '.codex-acct', expectEmail: null, priority: 1 });
const IDENTITY = Object.freeze({ account: { email: 'acct@example.test', planType: 'pro' } });

test('Grok and Antigravity keep failed and unreported allowance checks separate from sign-in', () => {
  const { classifyGrokBilling, classifyAntigravityQuota } = require('../src/lib/multi-account/health.js');
  const standing = { status: 'healthy', canServe: true, usedPercent: null,
    windows: { hourly: null, weekly: null, weeklyWindows: [] } };
  const grok = classifyGrokBilling({ name: 'grok-work', provider: 'grok' }, standing, { billingError: 'refused' });
  assert.equal(grok.status, 'healthy');
  assert.equal(grok.canServe, true);
  assert.equal(grok.usageStatus, 'unavailable');
  assert.match(grok.usageReason, /could not.*allowance|allowance could not/i);
  const unreported = classifyGrokBilling({ name: 'grok-work', provider: 'grok' }, standing,
    { billing: { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } } });
  assert.equal(unreported.usageStatus, 'not_reported');
  assert.equal(unreported.usedPercent, null, 'an absent percentage became zero');
  const agy = classifyAntigravityQuota(standing, { code: 1, error: { code: 'PROBE_TIMEOUT' } });
  assert.equal(agy.status, 'healthy');
  assert.equal(agy.canServe, true);
  assert.equal(agy.usageStatus, 'unavailable');
  const empty = classifyAntigravityQuota(standing, { code: 0,
    stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }) });
  assert.equal(empty.usageStatus, 'not_reported');
});

test('Grok reports a monthly percentage without pretending it is a weekly ranking window', () => {
  const { classifyGrokBilling } = require('../src/lib/multi-account/health.js');
  const standing = { status: 'healthy', canServe: true, usedPercent: null,
    windows: { hourly: null, weekly: null, weeklyWindows: [] } };
  for (const percent of [0, 37, 100]) {
    const answer = classifyGrokBilling({ name: 'grok-work', provider: 'grok' }, standing, {
      billing: { subscription_tier: 'Sample plan', config: { creditUsagePercent: percent,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2031-02-01T00:00:00Z' } } }
    });
    assert.deepEqual(answer.reportedUsage, { usedPercent: percent, period: 'month', resetsAt: '2031-02-01T00:00:00.000Z' });
    assert.equal(answer.usageStatus, 'measured');
    assert.equal(answer.windows.weekly, null);
    assert.equal(answer.usedPercent, null, 'monthly usage must not enter the existing weekly ranking contract');
    assert.equal(answer.status, percent === 100 ? 'exhausted' : 'healthy');
    assert.equal(answer.canServe, percent < 100, 'a fully spent monthly allowance became usable');
  }
});

// Reset times in epoch seconds, as `account/rateLimits/read` reports them.
const SHORT_RESET = 1_756_900_000;
const LONG_RESET = 1_757_300_000;

function codexReading({ primary, secondary }) {
  return {
    rateLimits: {
      primary: { usedPercent: primary, windowMinutes: 300, resetsAt: SHORT_RESET },
      ...(secondary === undefined ? {} : { secondary: { usedPercent: secondary, windowMinutes: 10_080, resetsAt: LONG_RESET } })
    }
  };
}

function classify(rateLimitsResult, exhaustedAtPercent = 99) {
  return classifyProbe({ account: ACCOUNT, accountRead: IDENTITY, rateLimitsResult, exhaustedAtPercent });
}

test('a weekly-spent Codex account is EXHAUSTED even when its short window is fresh', () => {
  const result = classify(codexReading({ primary: 10, secondary: 100 }));
  assert.equal(result.status, STATUS.EXHAUSTED, 'a fully spent weekly window classified as healthy');
  assert.equal(result.canServe, false);
  // The short window is still what usedPercent means, for every existing reader.
  assert.equal(result.usedPercent, 10);
  assert.equal(result.resetsAt, new Date(SHORT_RESET * 1000).toISOString());
  // And the pair says which window is the one that is full.
  assert.equal(result.windows.hourly.usedPercent, 10);
  assert.equal(result.windows.weekly.usedPercent, 100);
  assert.match(result.reason, /100% of its weekly allowance/);
  /* THE RESET TIME IS A FIELD, NOT PROSE (health.js states why).
     This sentence used to end "; resets <ISO>", and what that assertion was
     really pinning is that the time named belonged to the WEEKLY window --
     the one that stopped the account -- and not to the fresh short one. That
     guarantee is asserted here where the time now lives: on each window,
     which is what the accounts menu reads and turns into "resets in 4 days".
     MEASURED 2026-09-03, the ISO string in the sentence was reaching the menu
     verbatim ("Signed in at 52% of its allowance; resets
     2026-09-07T02:29:34.000Z."), which is a machine value on a screen a
     person reads. */
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(result.reason),
    'a raw timestamp is back in a sentence a person reads');
  assert.equal(result.windows.weekly.resetsAt, new Date(LONG_RESET * 1000).toISOString());
  assert.equal(result.windows.hourly.resetsAt, new Date(SHORT_RESET * 1000).toISOString());
});

test('a Codex account under the threshold on both windows is HEALTHY', () => {
  const result = classify(codexReading({ primary: 10, secondary: 50 }));
  assert.equal(result.status, STATUS.HEALTHY);
  assert.equal(result.canServe, true);
  assert.equal(result.usedPercent, 10);
  assert.equal(result.windows.weekly.usedPercent, 50);
});

test('a short-window-spent Codex account is EXHAUSTED, and the sentence now names WHICH window stopped it', () => {
  const result = classify(codexReading({ primary: 100, secondary: 5 }));
  assert.equal(result.status, STATUS.EXHAUSTED);
  assert.equal(result.usedPercent, 100);
  /* This sentence used to say only "its allowance". There was one threshold
     then, so naming the window would have been noise. There are two now, one
     per window, and a person reading "threshold 99%" has to be able to tell
     which of the two sliders that number came from. */
  assert.match(result.reason, /at 100% of its 5-hour allowance \(threshold 99%\)/);
  assert.doesNotMatch(result.reason, /weekly/);
});

test('the threshold applies to the worst window, whichever one it is', () => {
  assert.equal(classify(codexReading({ primary: 10, secondary: 90 }), 90).status, STATUS.EXHAUSTED);
  assert.equal(classify(codexReading({ primary: 10, secondary: 89 }), 90).status, STATUS.HEALTHY);
  // Only the short window reported: the comparison is the one it always was.
  assert.equal(classify(codexReading({ primary: 95 })).status, STATUS.HEALTHY);
  assert.equal(classify(codexReading({ primary: 99 })).status, STATUS.EXHAUSTED);
});

test('a signed-out Codex home is told so in one sentence that names no variable', () => {
  const result = classifyProbe({ account: ACCOUNT, accountRead: { account: null, requiresOpenaiAuth: true }, exhaustedAtPercent: 99 });
  assert.equal(result.status, STATUS.SIGNED_OUT);
  assert.equal(result.canServe, false);
  assert.equal(result.reason, 'This Codex home is not signed in.');
  assert.doesNotMatch(result.reason, /CODEX_HOME/);
});

test('a Codex home whose stored credential was revoked is signed out, in a sentence that names no variable', () => {
  const result = classifyProbe({
    account: ACCOUNT, accountRead: IDENTITY,
    rateLimitsError: 'Your authentication token has been invalidated.', exhaustedAtPercent: 99
  });
  assert.equal(result.status, STATUS.SIGNED_OUT);
  assert.match(result.reason, /no longer accepted \(the stored token was invalidated\)\. Sign in to it again\.$/);
  assert.doesNotMatch(result.reason, /CODEX_HOME/);
});

test('an allowance permission refusal does not prove that Codex authentication expired', () => {
  const { FAILOVER_STATUSES } = require('../src/lib/multi-account/health.js');
  for (const rateLimitsError of ['403 Forbidden', '403 Forbidden: allowance endpoint access is restricted by workspace policy']) {
    const result = classifyProbe({ account: ACCOUNT, accountRead: IDENTITY, rateLimitsError, exhaustedAtPercent: 99 });
    assert.equal(result.status, 'transient');
    assert.equal(result.canServe, false, 'an unavailable allowance must not authorize a start');
    assert.equal(FAILOVER_STATUSES.has(result.status), false, 'a permission refusal must not spend another account');
    assert.equal(result.email, 'acct@example.test');
    assert.equal(result.usedPercent, null);
    assert.equal(result.windows.hourly, null);
    assert.equal(result.windows.weekly, null);
    assert.doesNotMatch(result.reason, /no longer accepted|sign in.*again/i);
  }
});

test('explicit authentication rejection remains signed out even alongside a 403 status', () => {
  for (const rateLimitsError of ['401 Unauthorized', '403 Forbidden: token_invalidated',
    '403 Forbidden: Your authentication token has been invalidated.']) {
    const result = classifyProbe({ account: ACCOUNT, accountRead: IDENTITY, rateLimitsError, exhaustedAtPercent: 99 });
    assert.equal(result.status, 'signed_out');
    assert.equal(result.canServe, false);
    assert.equal(result.usedPercent, null);
    assert.match(result.reason, /Sign in to it again/);
  }
});

test('a missing short-window percentage still refuses as TRANSIENT rather than guessing from the long one', () => {
  const result = classify({ rateLimits: { secondary: { usedPercent: 100, windowMinutes: 10_080 } } });
  assert.equal(result.status, STATUS.TRANSIENT);
  assert.equal(result.usedPercent, null);
});

function presenceFs(answer) {
  const observed = [];
  return {
    observed,
    statSync(file) {
      observed.push(file);
      if (answer === 'present') return { isFile: () => true };
      const error = new Error(answer);
      error.code = answer;
      throw error;
    }
  };
}

const GEMINI = Object.freeze({ name: 'lab', provider: 'gemini', homeDir: '/profiles/gemini-lab', home: '/profiles/gemini-lab', priority: 1 });

test('a present Gemini sign-in is healthy with no windows and no percentage', async () => {
  const fsImpl = presenceFs('present');
  const result = await probeSignInPresence(GEMINI, { fsImpl });
  assert.equal(result.status, STATUS.HEALTHY);
  assert.equal(result.canServe, true);
  assert.equal(result.usedPercent, null, 'presence invented a percentage');
  assert.equal(result.resetsAt, null);
  assert.deepEqual(result.windows, { hourly: null, weekly: null, weeklyWindows: [] });
  assert.equal(result.reason,
    'Sign-in data is present. Allowance and authenticated identity require a separate current check for this Gemini connection.');
  // The check is about the CLI's own file, one level down, and nothing else.
  assert.deepEqual(fsImpl.observed, [path.resolve('/profiles/gemini-lab/.gemini/oauth_creds.json')]);
});

test('an absent Gemini sign-in is signed out and cannot serve', async () => {
  const result = await probeSignInPresence(GEMINI, { fsImpl: presenceFs('ENOENT') });
  assert.equal(result.status, STATUS.SIGNED_OUT);
  assert.equal(result.canServe, false);
  assert.equal(result.usedPercent, null);
  // The state, in one sentence. The way in is the menu's own Sign in button,
  // so a variable name is not something the sentence tells a person.
  assert.equal(result.reason, 'This Gemini home is not signed in.');
  assert.doesNotMatch(result.reason, /GEMINI_CLI_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR/);
});

test('a Gemini presence check that could not be made is transient, not signed out', async () => {
  const result = await probeSignInPresence(GEMINI, { fsImpl: presenceFs('EACCES') });
  assert.equal(result.status, STATUS.TRANSIENT);
  assert.equal(result.canServe, false);
  assert.match(result.reason, /EACCES/);
  assert.match(result.reason, /Not treated as signed out/);
});

test('a Gemini entry whose folder cannot be worked out is skipped without throwing', async () => {
  const result = await probeSignInPresence({ name: 'lab', provider: 'gemini', home: '.relative' }, { fsImpl: presenceFs('present') });
  assert.equal(result.status, STATUS.NOT_PROVISIONED);
  assert.match(result.reason, /could not be worked out/);
});

test('the Codex account surface refuses a non-Codex account on purpose, before building any environment', async () => {
  const claude = { name: 'school', provider: 'claude', configDir: '.claude-school', home: '.claude-school', priority: 1 };
  const result = await probeAccount(claude, {
    homeDir: '/users/tester',
    environmentFor: () => { throw new Error('a non-Codex account must not reach the launcher'); },
    executable: { command: 'codex', prefixArgs: [] },
    exhaustedAtPercent: 99,
    spawnImpl: () => { throw new Error('a non-Codex account must not spawn the Codex surface'); }
  });
  assert.equal(result.status, STATUS.NOT_PROVISIONED);
  assert.equal(result.canServe, false);
  assert.equal(result.usedPercent, null);
  assert.match(result.reason, /is a claude account/);
});

/* THE IDENTITY GATE ON THE CODEX LEG, AND THE ANSWER IT USED TO SKIP.
 *
 * The gate was written as `email !== account.expectEmail`. An identity object
 * that carries NO readable address makes `email` null, null is not the expected
 * address, and so every one of those readings came back account_mismatch with
 * the sentence "signed in as a different account than "work" expects" --
 * accusing a person whose sign-in may be perfectly right, and sending them to
 * redo the one thing that was never wrong. account_mismatch is deliberately
 * outside FAILOVER_STATUSES, so it also pinned that account in a state nothing
 * routes around, on a comparison that never happened.
 *
 * "Could not look" and "not there" are different answers. These assert the
 * four, by calling with values. */
const NAMED = Object.freeze({
  name: 'work', provider: 'codex', home: '.codex-work',
  expectEmail: 'work@example.test', priority: 1
});
const HEALTHY_LIMITS = Object.freeze(codexReading({ primary: 10, secondary: 50 }));

function classifyIdentity(identity, account = NAMED) {
  return classifyProbe({
    account, accountRead: { account: identity }, rateLimitsResult: HEALTHY_LIMITS, exhaustedAtPercent: 99
  });
}

test('a Codex home whose address could not be read is not accused of being the wrong account', () => {
  // Four shapes the account surface has for "I did not tell you the address".
  // Every one of them used to answer account_mismatch.
  for (const [label, identity] of [
    ['absent', { planType: 'pro' }],
    ['blank', { email: '   ', planType: 'pro' }],
    ['null', { email: null, planType: 'pro' }],
    ['not a string', { email: 42, planType: 'pro' }]
  ]) {
    const result = classifyIdentity(identity);
    assert.equal(result.status, STATUS.TRANSIENT,
      `an address that was ${label} was judged as though it had been compared`);
    assert.equal(result.canServe, false, `${label}: an uncompared identity must not serve`);
    assert.ok(!/is not the account/.test(result.reason),
      `${label}: a home that said nothing was accused of being the wrong account`);
    assert.match(result.reason, /could not be compared/,
      `${label}: the refusal does not say that nothing was compared`);
    // Nothing was compared, so nothing may be ranked on it either.
    assert.equal(result.usedPercent, null, `${label}: an unjudged identity still offered an allowance`);
    assert.equal(result.windows.hourly, null);
    assert.equal(result.windows.weekly, null);
  }
});

test('a Codex home signed in as a different account is refused, and the refusal names that account', () => {
  const result = classifyIdentity({ email: 'personal@example.test', planType: 'pro' });
  assert.equal(result.status, STATUS.ACCOUNT_MISMATCH, 'a wrong identity passed as usable');
  assert.equal(result.canServe, false);
  // The address a person needs is the unexpected one: it is the account they
  // signed in by mistake, and the thing they have to recognise.
  assert.match(result.reason, /personal@example\.test/,
    'the refusal does not say which account is actually signed in');
  assert.match(result.reason, /"work"/);
  // An allowance read off the wrong identity is somebody else's subscription.
  assert.equal(result.usedPercent, null);
  assert.equal(result.windows.hourly, null);
  assert.equal(result.windows.weekly, null);
  // The address is still reported, because the row has to be able to show it.
  assert.equal(result.email, 'personal@example.test');
});

test('a Codex home signed in as the account its entry expects passes the gate', () => {
  // Case and surrounding space are not a difference: registry.js stores the
  // expectation trimmed and lower-cased, and an address is not case-sensitive
  // in the half that matters here.
  for (const address of ['work@example.test', '  Work@Example.Test ']) {
    const result = classifyIdentity({ email: address, planType: 'pro' });
    assert.equal(result.status, STATUS.HEALTHY, `${address} was refused as the wrong account`);
    assert.equal(result.canServe, true);
    assert.equal(result.usedPercent, 10, `${address}: a matching identity lost its allowance`);
  }
});

test('a Codex entry that expects no account is checked against nothing, whatever it is signed in as', () => {
  // Every registry written before expectEmail existed is in this case.
  for (const identity of [
    { email: 'anyone@example.test', planType: 'pro' },
    { planType: 'pro' },
    { email: null, planType: 'pro' }
  ]) {
    for (const account of [ACCOUNT, { ...ACCOUNT, expectEmail: undefined }, { ...ACCOUNT, expectEmail: '  ' }]) {
      const result = classifyIdentity(identity, account);
      assert.equal(result.status, STATUS.HEALTHY,
        'an entry that promised nothing was refused for an identity nobody asked about');
      assert.equal(result.canServe, true);
    }
  }
});

/* AND THE TWO LEGS GIVE THE SAME ANSWER, WHICH IS WHY THE COMPARISON IS SHARED.
 *
 * They were written months apart, each spelling the comparison out for itself,
 * and they had already drifted on exactly one case -- the unreadable address,
 * which Claude stopped on and Codex accused. This drives BOTH legs with the
 * same four identities and asserts they reach the same status, so the next
 * person to change one cannot silently leave the other behind. */
test('the Codex and Claude identity gates answer the same status for the same identity', async () => {
  const { claudeProbeFactory } = require('../src/lib/multi-account/rotation.js');
  const homeDir = path.join('C:', 'homes');
  const noCache = { readFileSync() { throw Object.assign(new Error('no cache'), { code: 'ENOENT' }); } };

  const claudeStatus = async (expectEmail, address) => (await claudeProbeFactory({
    homeDir,
    fsImpl: noCache,
    exhaustedAtPercent: 99,
    authProbe: async () => ({
      state: 'indeterminate', capabilityRan: false, billingSource: 'subscription',
      account: address, plan: 'max', reason: 'stub'
    }),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null })
  })({
    name: 'work', provider: 'claude', configDir: path.join('C:', 'homes', 'work'),
    priority: 1, ...(expectEmail === null ? {} : { expectEmail })
  })).status;

  const codexStatus = (expectEmail, address) => classifyIdentity(
    { email: address, planType: 'pro' },
    { ...NAMED, ...(expectEmail === null ? { expectEmail: null } : { expectEmail }) }
  ).status;

  const EXPECTED = 'work@example.test';
  for (const [label, expectEmail, address, want] of [
    ['recorded and equal', EXPECTED, 'work@example.test', STATUS.HEALTHY],
    ['recorded, case differs', EXPECTED, '  Work@Example.Test ', STATUS.HEALTHY],
    ['recorded and different', EXPECTED, 'someone.else@example.test', STATUS.ACCOUNT_MISMATCH],
    ['recorded and unreadable', EXPECTED, null, STATUS.TRANSIENT],
    ['nothing recorded', null, 'anyone@example.test', STATUS.HEALTHY],
    ['nothing recorded, unreadable', null, null, STATUS.HEALTHY]
  ]) {
    const codex = codexStatus(expectEmail, address);
    const claude = await claudeStatus(expectEmail, address);
    assert.equal(codex, want, `the Codex leg answered ${codex} for "${label}"`);
    assert.equal(claude, want, `the Claude leg answered ${claude} for "${label}"`);
  }
});

test('Antigravity admission requires native Gemini catalogue success and never invents usage or identity', () => {
  const { classifyAntigravityCatalog } = require('../src/lib/multi-account/health');
  const account = { name: 'google', provider: 'gemini', client: 'antigravity' };
  const stdout = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus\n';
  const good = classifyAntigravityCatalog(account, { stdout, code: 0 });
  assert.equal(good.canServe, true);
  assert.equal(good.email, null);
  assert.equal(good.identityScope, 'current-user');
  assert.match(good.reason, /does not provide a separate account/);
  assert.equal(good.usedPercent, null);
  assert.equal(good.resetsAt, null);
  assert.deepEqual(good.models, ['gemini-3.8-flash-high']);
  for (const result of [{ stdout, code: 1 }, { stdout: 'Fetching available models...', code: 0 }, { stdout: 'gemini-3.8-flash-high\t   ', code: 0 },
    { stdout: 'claude-opus-4-6-thinking\tClaude Opus', code: 0 }, { stdout, code: 0, error: { code: 'AGY_ACCOUNT_TIMEOUT' } }]) {
    assert.equal(classifyAntigravityCatalog(account, result).canServe, false);
  }
  assert.equal(classifyAntigravityCatalog(account, { stderr: 'Error: Please sign in to view available models.', code: 1 }).status, STATUS.SIGNED_OUT);
  const pinned = classifyAntigravityCatalog({ ...account, expectEmail: 'expected@example.test' }, { stdout, code: 0 });
  assert.equal(pinned.canServe, false);
  assert.equal(pinned.status, STATUS.TRANSIENT);
});

test('Antigravity status timeout and Stop close the owned native probe before returning', async t => {
  const { probeAntigravityAccount } = require('../src/lib/multi-account/health');
  const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
  const account = { name: 'probe-fixture', provider: 'gemini', client: 'antigravity', home: require('node:os').tmpdir() };
  let starts = 0;
  const spawnImpl = (_command, _args, options) => {
    starts++;
    return spawnHidden(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
  };
  const timed = await probeAntigravityAccount(account, { timeoutMs: 20, spawnImpl }).catch(error => {
    t.diagnostic(JSON.stringify({ code: error.code, cleanup: error.cleanup,
      causes: error.errors?.map(cause => ({ code: cause.code, message: cause.message })) }));
    throw error;
  });
  assert.equal(timed.status, STATUS.TRANSIENT);
  assert.equal(timed.canServe, false);
  const stop = new AbortController();
  const pending = probeAntigravityAccount(account, { signal: stop.signal, spawnImpl });
  stop.abort(new Error('explicit Stop'));
  await assert.rejects(pending, /explicit Stop/);
  assert.equal(starts, 2);
});

/* ------------- Grok and Antigravity allowance reads (2026-09-10) ------------- *
 * The fixtures are the official clients' own replies captured on this computer
 * (Antigravity CLI 1.2.0 print-mode /quota JSON; Grok CLI 1.0.25 ACP
 * authenticate + `_x.ai/billing`), with the address and team id replaced. */
const fs = require('node:fs');
const os = require('node:os');
const AGY_QUOTA_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'antigravity-quota-print-json-20260910.json'), 'utf8');
const GROK_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'grok-billing-acp-20260910.json'), 'utf8'));
const THRESHOLDS = Object.freeze({ exhaustedAtPercent: 99, exhaustedAtPercentHourly: 40, exhaustedAtPercentWeekly: 100 });
const AGY = Object.freeze({ name: 'google', provider: 'gemini', client: 'antigravity' });
const AGY_CATALOG = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus\n';

test('Antigravity /quota: the Gemini weekly bucket decides, every weekly bucket is carried, nothing is invented', () => {
  const { antigravityQuotaWindows } = require('../src/lib/multi-account/health');
  const windows = antigravityQuotaWindows(AGY_QUOTA_FIXTURE);
  assert.equal(windows.hourly, null, 'Antigravity reported no short window and none was invented');
  assert.deepEqual({ ...windows.weekly }, { kind: 'weekly', usedPercent: 3.8, remainingPercent: 96.2,
    resetsAt: '2026-09-17T21:40:36.000Z', label: 'gemini-weekly', model: 'Gemini Models' });
  assert.deepEqual(windows.weeklyWindows.map(window => [window.model, window.usedPercent, window.label]),
    [['Gemini Models', 3.8, 'gemini-weekly'], ['Claude and GPT models', 0, '3p-weekly']]);
  const payload = JSON.parse(AGY_QUOTA_FIXTURE);
  assert.equal(payload.num_turns, 0, 'the captured read started no turn');
  assert.equal(payload.usage.total_tokens, 0, 'the captured read spent no tokens');
  for (const broken of ['', 'not json', JSON.stringify({ ...payload, status: 'ERROR' }),
    JSON.stringify({ ...payload, command: { name: 'model', data: payload.command.data } })]) {
    assert.equal(antigravityQuotaWindows(broken), null);
  }
  const unreadable = JSON.parse(AGY_QUOTA_FIXTURE);
  unreadable.command.data.groups[0].buckets[0].remaining_fraction = 1.5;
  unreadable.command.data.groups[1].buckets[0].remaining_fraction = 'full';
  assert.equal(antigravityQuotaWindows(JSON.stringify(unreadable)), null, 'an out-of-range fraction was drawn as a reading');
});

test('Antigravity /quota classification: measured healthy, spent Gemini bucket exhausted, unreadable read stays unknown', () => {
  const { classifyAntigravityCatalog, classifyAntigravityQuota } = require('../src/lib/multi-account/health');
  const catalog = classifyAntigravityCatalog(AGY, { stdout: AGY_CATALOG, code: 0 });
  const healthy = classifyAntigravityQuota(catalog, { stdout: AGY_QUOTA_FIXTURE, code: 0 }, THRESHOLDS);
  assert.equal(healthy.status, STATUS.HEALTHY);
  assert.equal(healthy.canServe, true);
  assert.equal(healthy.usedPercent, 3.8);
  assert.equal(healthy.resetsAt, '2026-09-17T21:40:36.000Z');
  assert.equal(healthy.email, null, 'the quota payload names no address and none was invented');
  assert.equal(healthy.identityScope, 'current-user');
  assert.match(healthy.reason, /does not provide a separate account/);
  assert.doesNotMatch(healthy.reason, /\d{4}-\d{2}-\d{2}T/, 'a reset timestamp reached the prose');

  const spentGemini = JSON.parse(AGY_QUOTA_FIXTURE);
  spentGemini.command.data.groups[0].buckets[0].remaining_fraction = 0;
  const exhausted = classifyAntigravityQuota(catalog, { stdout: JSON.stringify(spentGemini), code: 0 }, THRESHOLDS);
  assert.equal(exhausted.status, STATUS.EXHAUSTED);
  assert.equal(exhausted.canServe, false);
  assert.equal(exhausted.windows.weekly.usedPercent, 100);
  assert.equal(exhausted.resetsAt, '2026-09-17T21:40:36.000Z', 'the reset the client reported rides on the row');

  const spentOther = JSON.parse(AGY_QUOTA_FIXTURE);
  spentOther.command.data.groups[1].buckets[0].remaining_fraction = 0;
  const other = classifyAntigravityQuota(catalog, { stdout: JSON.stringify(spentOther), code: 0 }, THRESHOLDS);
  assert.equal(other.status, STATUS.HEALTHY, 'the Claude/GPT group decided a Gemini account');
  assert.equal(other.windows.weeklyWindows[1].usedPercent, 100, 'the other group is still shown');

  for (const failed of [{ code: 1, stdout: AGY_QUOTA_FIXTURE }, { error: { code: 'AGY_ACCOUNT_TIMEOUT' } }, { code: 0, stdout: 'garbage' }]) {
    const unknown = classifyAntigravityQuota(catalog, failed, THRESHOLDS);
    assert.equal(unknown.status, STATUS.HEALTHY, 'a failed allowance read overturned the catalogue verdict');
    assert.equal(unknown.usedPercent, null);
    assert.deepEqual(unknown.windows, { hourly: null, weekly: null, weeklyWindows: [] });
    assert.match(unknown.reason, /unknown rather than zero/);
  }
});

function fakeProgram(outputs) {
  const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args: [...args], stdin: options.stdio?.[0] });
    const text = outputs.shift();
    return spawnHidden(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], options);
  };
  return { calls, spawnImpl };
}

test('Antigravity probe runs the catalogue, then the print-mode /quota read, under the same owned custody', async () => {
  const { probeAntigravityAccount } = require('../src/lib/multi-account/health');
  const fake = fakeProgram([AGY_CATALOG, AGY_QUOTA_FIXTURE]);
  const result = await probeAntigravityAccount({ ...AGY, home: os.tmpdir() }, { spawnImpl: fake.spawnImpl, ...THRESHOLDS });
  assert.deepEqual(fake.calls.map(call => call.args), [['models'], ['-p', '/quota', '--output-format', 'json']]);
  assert.equal(result.status, STATUS.HEALTHY);
  assert.equal(result.windows.weekly.remainingPercent, 96.2);
  const signedOut = fakeProgram(['']);
  const refused = await probeAntigravityAccount({ ...AGY, home: os.tmpdir() }, {
    spawnImpl: (command, args, options) => signedOut.spawnImpl(command, args, options) });
  assert.equal(refused.canServe, false);
  assert.equal(signedOut.calls.length, 1, 'the quota read ran although the catalogue did not answer');
});

test('Grok billing: the captured reply gives plan and period end, and no percentage is invented', () => {
  const { grokBillingReading, classifyGrokBilling } = require('../src/lib/multi-account/health');
  const reading = grokBillingReading(GROK_FIXTURE.billing);
  assert.equal(reading.planType, 'X Premium+');
  assert.equal(reading.period, 'week');
  assert.equal(reading.resetsAt, '2026-09-17T08:47:13.160Z');
  assert.equal(reading.percent, null, 'the reply carried no creditUsagePercent and none was invented');
  assert.deepEqual(reading.windows, { hourly: null, weekly: null, weeklyWindows: [] });

  const presence = { account: 'grok', email: null, usedPercent: null, resetsAt: null, planType: null,
    windows: { hourly: null, weekly: null, weeklyWindows: [] }, status: STATUS.HEALTHY, canServe: true, reason: 'present' };
  const account = { name: 'grok', provider: 'grok' };
  const result = classifyGrokBilling(account, presence, { authMeta: GROK_FIXTURE.authenticateMeta, billing: GROK_FIXTURE.billing }, THRESHOLDS);
  assert.equal(result.status, STATUS.HEALTHY);
  assert.equal(result.canServe, true);
  assert.equal(result.usedPercent, null);
  assert.equal(result.planType, 'X Premium+');
  assert.equal(result.email, 'owner@example.test');
  assert.equal(result.resetsAt, '2026-09-17T08:47:13.160Z');
  assert.match(result.reason, /not how much of it is used/);
  assert.doesNotMatch(result.reason, /\d{4}-\d{2}-\d{2}T/);

  const withPercent = pct => ({ ...GROK_FIXTURE.billing, config: { ...GROK_FIXTURE.billing.config, creditUsagePercent: pct } });
  const measured = classifyGrokBilling(account, presence, { authMeta: GROK_FIXTURE.authenticateMeta, billing: withPercent(42) }, THRESHOLDS);
  assert.equal(measured.status, STATUS.HEALTHY);
  assert.equal(measured.usedPercent, 42);
  assert.deepEqual({ ...measured.windows.weekly }, { kind: 'weekly', usedPercent: 42, remainingPercent: 58,
    resetsAt: '2026-09-17T08:47:13.160Z', label: 'creditUsagePercent', model: null });
  const spent = classifyGrokBilling(account, presence, { authMeta: GROK_FIXTURE.authenticateMeta, billing: withPercent(100) }, THRESHOLDS);
  assert.equal(spent.status, STATUS.EXHAUSTED);
  assert.equal(spent.canServe, false);
  for (const bad of [150, -1, Number.NaN, '42', null]) {
    const unread = classifyGrokBilling(account, presence, { authMeta: GROK_FIXTURE.authenticateMeta, billing: withPercent(bad) }, THRESHOLDS);
    assert.equal(unread.status, STATUS.HEALTHY);
    assert.equal(unread.usedPercent, null, `an unusable creditUsagePercent (${bad}) became a figure`);
  }
  const monthly = { ...withPercent(42), config: { ...withPercent(42).config, currentPeriod: { ...GROK_FIXTURE.billing.config.currentPeriod, type: 'USAGE_PERIOD_TYPE_MONTHLY' } } };
  const month = classifyGrokBilling(account, presence, { billing: monthly }, THRESHOLDS);
  assert.deepEqual(month.windows, { hourly: null, weekly: null, weeklyWindows: [] }, 'a monthly figure was drawn as this week');
  assert.match(month.reason, /month/);

  const failed = classifyGrokBilling(account, presence, { error: { code: 'GROK_ACCOUNT_TIMEOUT' } }, THRESHOLDS);
  assert.equal(failed.status, STATUS.HEALTHY, 'a failed read overturned the presence verdict');
  assert.equal(failed.usedPercent, null);
  assert.match(failed.reason, /unknown rather than zero/);
  const skipped = classifyGrokBilling(account, presence, { skipped: 'extensions' }, THRESHOLDS);
  assert.match(skipped.reason, /extra startup extensions/);

  const pinned = { name: 'grok', provider: 'grok', expectEmail: 'someone-else@example.test' };
  const pinnedPresence = { ...presence, status: STATUS.TRANSIENT, canServe: false };
  const mismatch = classifyGrokBilling(pinned, pinnedPresence, { authMeta: GROK_FIXTURE.authenticateMeta, billing: GROK_FIXTURE.billing }, THRESHOLDS);
  assert.equal(mismatch.status, STATUS.ACCOUNT_MISMATCH);
  assert.equal(mismatch.canServe, false);
  const match = classifyGrokBilling({ ...pinned, expectEmail: 'owner@example.test' }, pinnedPresence,
    { authMeta: GROK_FIXTURE.authenticateMeta, billing: GROK_FIXTURE.billing }, THRESHOLDS);
  assert.equal(match.status, STATUS.HEALTHY, 'the confirmed address did not settle the presence doubt');
});

test('Grok probe: clean inspection, then initialize/authenticate/_x.ai/billing only -- no session, no prompt -- and custody ends the agent', async () => {
  const { probeGrokAccount } = require('../src/lib/multi-account/health');
  const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
  const fake = path.join(__dirname, 'fixtures', 'fake-grok-acp.cjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-probe-'));
  try {
    const methods = path.join(scratch, 'methods.txt');
    const account = { name: 'grok-lab', provider: 'grok', configDir: scratch, home: scratch };
    const run = extra => probeGrokAccount(account, { fsImpl: presenceFs('present'), ...THRESHOLDS,
      environmentFor: () => ({ PATH: process.env.PATH, FAKE_GROK_METHODS: methods, ...extra }),
      spawnImpl: (command, args, options) => spawnHidden(process.execPath, [fake, ...args], options) });
    const result = await run({});
    const seen = fs.readFileSync(methods, 'utf8').trim().split('\n');
    assert.deepEqual(seen, ['inspect', 'initialize', 'authenticate', 'reply:agent-1', '_x.ai/billing'],
      'the usage read sent something other than initialize, authenticate and the billing request');
    assert.equal(result.status, STATUS.HEALTHY);
    assert.equal(result.planType, 'X Premium+');
    assert.equal(result.email, 'owner@example.test');
    assert.equal(result.usedPercent, null);

    fs.writeFileSync(methods, '');
    const extras = await run({ FAKE_GROK_EXTRAS: '1' });
    assert.deepEqual(fs.readFileSync(methods, 'utf8').trim().split('\n'), ['inspect'], 'the agent started despite ambient extensions');
    assert.equal(extras.status, STATUS.HEALTHY);
    assert.equal(extras.planType, null);
    assert.match(extras.reason, /extra startup extensions/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
