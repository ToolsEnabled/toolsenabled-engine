// EXECUTABLE CHANGE
// Assertion audit report (testcanfail-tests-multi-account-failover-test-js):
// - FOUND (empty collection): replacing `acheck` with a no-op previously exited
//   0 with "13/13 checks passed". The cardinality assertions below now fail
//   under that mutation with
//   "Expected values to be strictly equal:\n\n0 !== 17".
// - NOT-FOUND: exit-status/truthy-return assertions used without own-output
//   evidence; swallowed failures via try/catch or optional chaining; assertions
//   against a mock of the subject; whole-file skip/precondition guards; and
//   expected values computed by the same subject code.
// - The per-installation account registry is exercised through a disposable
//   config/accounts.json fixture; no operator profile is read.
// - RESTORATION: the mutated file was restored byte-for-byte (SHA-256
//   cd70b2e45b3ab58e76fa845b563b76e75b5d7d63d80c12b95915cea10456fbac).
//   The restored pre-change suite was not green: the existing "a launch
//   candidate does not become active before a launch succeeds" assertion fails
//   because resolveForLaunch persists activeAccount "accta". This existing
//   assertion was neither deleted nor weakened.
'use strict';
// Registry validation, selection order, and the automatic failover policy.
//
// The policy is narrow on purpose. Only positive evidence that an account
// cannot serve moves us off it. A timeout is not evidence that an allowance is
// spent, and rotating on one would abandon a good account and, over a flaky
// hour, walk through every account the owner has. When nothing is usable the
// answer is a refusal -- never a silent fall back to API-key billing, which is
// the failure mode that costs real money while looking like success.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRegistry, requireAccount, findAccount, MultiAccountError } = require('../src/lib/multi-account/registry.js');
const { STATUS } = require('../src/lib/multi-account/health.js');
const { selectAccount, resolveForLaunch, switchTo, readState, syncCodexPin, writeState } = require('../src/lib/multi-account/switcher.js');

const STATE = 'C:\\repo\\state\\multi-account\\state.json';
const PIN = 'C:\\repo\\config\\codex.json';

const REGISTRY_JSON = JSON.stringify({
  exhaustedAtPercent: 99,
  accounts: [
    { name: 'acctc', role: 'institutional', provider: 'codex', profileDir: '.codex-acctc', expectEmail: 'acctc@example.test', priority: 1 },
    { name: 'accta', role: null, provider: 'codex', profileDir: '.codex-accta', expectEmail: 'accta@example.test', priority: 2 },
    { name: 'acctb', role: null, provider: 'codex', profileDir: '.codex-acctb', expectEmail: 'acctb@example.test', priority: 3 }
  ]
});

function registry() { return parseRegistry(REGISTRY_JSON, { source: 'test' }); }

// Minimal in-memory filesystem so state and pin writes are observable without
// touching the real repo.
function memoryFs(seed = {}) {
  const files = new Map(Object.entries(seed).map(([key, value]) => [path.resolve(key), value]));
  return {
    files,
    readFileSync(file) {
      const key = path.resolve(file);
      if (!files.has(key)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return files.get(key);
    },
    writeFileSync(file, contents) { files.set(path.resolve(file), contents); },
    mkdirSync() {},
    read(file) { return JSON.parse(files.get(path.resolve(file))); }
  };
}

function probeReturning(byName) {
  return async account => {
    const status = byName[account.name] || STATUS.HEALTHY;
    return Object.freeze({
      account: account.name,
      email: account.expectEmail,
      usedPercent: status === STATUS.HEALTHY ? 5 : null,
      resetsAt: status === STATUS.EXHAUSTED ? '2026-08-25T12:00:00.000Z' : null,
      planType: 'pro',
      status,
      canServe: status === STATUS.HEALTHY,
      reason: `stubbed ${status}`
    });
  };
}

const checks = [];
function check(name, fn) { checks.push([name, fn]); }
const asyncChecks = [];
function acheck(name, fn) { asyncChecks.push([name, fn]); }

// ---------------------------------------------------------------- registry

check('a registry with duplicate names is refused', () => {
  const json = JSON.stringify({ accounts: [
    { name: 'a', provider: 'codex', profileDir: '.x' },
    { name: 'A', provider: 'codex', profileDir: '.y' }
  ] });
  assert.throws(() => parseRegistry(json, { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_NAME_DUPLICATE');
});

check('two accounts sharing one profile directory is refused', () => {
  // Sharing a home is not multi-account: they would overwrite each other's
  // auth.json, which is exactly what the per-directory launchpad replaced.
  const json = JSON.stringify({ accounts: [
    { name: 'a', provider: 'codex', profileDir: '.same' },
    { name: 'b', provider: 'codex', profileDir: '.SAME' }
  ] });
  assert.throws(() => parseRegistry(json, { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_PROFILE_DIR_SHARED');
});

check('an unparsable registry refuses instead of yielding an empty account list', () => {
  // An empty list would silently mean "nothing is usable", which must be a
  // loud refusal, not a degraded default.
  assert.throws(() => parseRegistry('{ not json', { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_REGISTRY_UNPARSABLE');
});

check('an empty registry is refused', () => {
  assert.throws(() => parseRegistry(JSON.stringify({ accounts: [] }), { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_REGISTRY_EMPTY');
});

/* THE CLAUDE REFUSAL, AND WHY IT IS GONE -- READ THE OLD REASON FIRST.
 *
 * Until 2026-08-18 this file asserted the opposite: `provider: "claude"` was
 * refused with ACCOUNTS_PROVIDER_UNSUPPORTED. That refusal was not tidiness and
 * it is not being waved away. Its stated reason, verbatim from the version this
 * replaces:
 *
 *   "The auth-integrity lane measured that `claude auth status` reports
 *    loggedIn:true, authMethod:'claude.ai', subscriptionType:'max' while
 *    actually billing per token, with `apiKeySource: ANTHROPIC_API_KEY` as the
 *    only tell. Every health signal this switcher reads is Codex-shaped and
 *    would come back green for such an account, so it would happily rotate
 *    between Claude accounts that are all quietly on API billing -- the exact
 *    invisible cost this lane exists to prevent. Until a Claude-aware
 *    billingSource check is wired in, the registry refuses to carry one at
 *    all."
 *
 * THAT CONDITION IS NOW MET, WHICH IS THE ONLY REASON THIS CHANGED. The
 * Claude-aware check the old comment named as its unblocking condition exists:
 * src/lib/providers/claude-auth-probe.js reports `billingSource` as
 * 'subscription' | 'api_key', read off the CLI's own `apiKeySource` field --
 * the field the old comment identified as the only tell -- and
 * src/lib/multi-account/rotation.js refuses to select any Claude account whose
 * billing route is not the subscription. So the registry may now carry a Claude
 * account because something downstream can finally tell the difference the old
 * refusal existed to protect. The invariant it was protecting is asserted
 * directly in tests/multi-account-rotation.test.js.
 *
 * A REGISTRY ENTRY IS A DIRECTORY NAME AND NOTHING ELSE. Nothing here, and
 * nothing this registry feeds, opens a credential file. The user signs each home
 * in themselves with the provider's own client. */
check('a Claude account registers, and names its directory in the provider own word', () => {
  const json = JSON.stringify({ accounts: [{ name: 'personal', provider: 'claude', configDir: '.claude-personal' }] });
  const registry = parseRegistry(json, { source: 't' });
  assert.strictEqual(registry.accounts[0].provider, 'claude');
  assert.strictEqual(registry.accounts[0].configDir, '.claude-personal');
  // `home` is the one field every consumer resolves, whichever provider set it.
  assert.strictEqual(registry.accounts[0].home, '.claude-personal');
});

check('a Claude account that names no configDir is refused, and is told which field', () => {
  // The Codex spelling is not silently accepted for a Claude account: it would
  // read as configured while naming a directory nothing ever points at.
  const json = JSON.stringify({ accounts: [{ name: 'personal', provider: 'claude', profileDir: '.claude-personal' }] });
  let thrown = null;
  try { parseRegistry(json, { source: 't' }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof MultiAccountError);
  assert.strictEqual(thrown.code, 'ACCOUNTS_ENTRY_INVALID');
  assert.match(thrown.message, /configDir/);
});

check('a provider this registry does not know is still refused, not silently accepted', () => {
  // The negative control for the two checks above. Opening the registry to a
  // second and a third provider must not open it to any string at all.
  const json = JSON.stringify({ accounts: [{ name: 'personal', provider: 'mistral', profileDir: '.mistral' }] });
  assert.throws(() => parseRegistry(json, { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_PROVIDER_UNSUPPORTED'
      /* Four supported providers since a57cd698 (2026-09-10) added grok to the
         registry's vocabulary; the refusal names them all, and this still pins the
         list rather than merely that a refusal happened. */
      && /codex, claude, gemini and grok/.test(error.message));
});

check('one fixture identity with both subscriptions may use the same name on both', () => {
  // Names are unique PER PROVIDER. A global uniqueness rule would force a
  // cross-provider pair to be renamed even though the provider disambiguates it.
  const json = JSON.stringify({ accounts: [
    { name: 'shared', provider: 'codex', profileDir: '.codex-shared' },
    { name: 'shared', provider: 'claude', configDir: '.claude-shared' }
  ] });
  const registry = parseRegistry(json, { source: 't' });
  assert.strictEqual(registry.accounts.length, 2);
  assert.strictEqual(findAccount(registry, 'shared', { provider: 'claude' }).provider, 'claude');
  assert.strictEqual(findAccount(registry, 'shared', { provider: 'codex' }).provider, 'codex');
});

check('the same name twice under ONE provider is still a duplicate', () => {
  const json = JSON.stringify({ accounts: [
    { name: 'shared', provider: 'claude', configDir: '.claude-a' },
    { name: 'shared', provider: 'claude', configDir: '.claude-b' }
  ] });
  assert.throws(() => parseRegistry(json, { source: 't' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_NAME_DUPLICATE');
});

check('accounts are ordered by priority regardless of file order', () => {
  const json = JSON.stringify({ accounts: [
    { name: 'third', provider: 'codex', profileDir: '.c', priority: 3 },
    { name: 'first', provider: 'codex', profileDir: '.a', priority: 1 },
    { name: 'second', provider: 'codex', profileDir: '.b', priority: 2 }
  ] });
  assert.deepStrictEqual(parseRegistry(json, { source: 't' }).accounts.map(a => a.name), ['first', 'second', 'third']);
});

check('an account is findable by handle and by role, case-insensitively', () => {
  const reg = registry();
  assert.strictEqual(findAccount(reg, 'institutional').name, 'acctc');
  assert.strictEqual(findAccount(reg, 'INSTITUTIONAL').name, 'acctc');
  assert.strictEqual(findAccount(reg, 'acctc').name, 'acctc');
  assert.strictEqual(findAccount(reg, 'nope'), null);
});

check('an unknown selector names the accounts that do exist', () => {
  let thrown = null;
  try { requireAccount(registry(), 'nope'); } catch (error) { thrown = error; }
  assert.strictEqual(thrown.code, 'ACCOUNT_UNKNOWN');
  assert.ok(thrown.message.includes('acctc'));
});

check('a disposable config/accounts.json satisfies the registry invariants', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-account-registry-'));
  const fixturePath = path.join(fixtureRoot, 'config', 'accounts.json');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${REGISTRY_JSON}\n`, 'utf8');
  try {
    const parsed = parseRegistry(fs.readFileSync(fixturePath, 'utf8'), { source: fixturePath });
    assert.ok(parsed.accounts.length > 0, 'a registry that exists must name at least one account');
    const priorities = parsed.accounts.map(account => account.priority);
    assert.strictEqual(new Set(priorities).size, priorities.length,
      'two accounts sharing a priority leave the failover order ambiguous');
    assert.deepStrictEqual([...priorities].sort((a, b) => a - b), priorities,
      'accounts must be stored in their failover order');
    const names = parsed.accounts.map(account => String(account.name).toLowerCase());
    assert.strictEqual(new Set(names).size, names.length, 'account names must be unique');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- failover

acheck('the highest-priority healthy account is chosen and nothing is switched', async () => {
  const result = await selectAccount({ registry: registry(), probe: probeReturning({}) });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'acctc');
  assert.strictEqual(result.switched, false);
  assert.strictEqual(result.attempts.length, 1);
});

acheck('an exhausted account fails over to the next one, and says so', async () => {
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.EXHAUSTED })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'accta');
  assert.strictEqual(result.switched, true);
  // The switch must be visible: a silent switch is its own trust problem.
  assert.ok(result.reason.includes('Failed over'));
  assert.strictEqual(result.attempts.length, 2);
  assert.strictEqual(result.attempts[0].status, STATUS.EXHAUSTED);
  assert.strictEqual(result.attempts[0].resetsAt, '2026-08-25T12:00:00.000Z');
  assert.strictEqual(result.attempts[1].resetsAt, null,
    'an unobserved reset must stay unknown instead of receiving a plausible default');
});

acheck('failover walks past several unusable accounts', async () => {
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.SIGNED_OUT })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'acctb');
  assert.strictEqual(result.attempts.length, 3);
});

acheck('an unprovisioned account is skipped, not fatal', async () => {
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.NOT_PROVISIONED })
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'accta');
});

acheck('a TRANSIENT failure STOPS the cascade and never burns another account', async () => {
  // The expensive mistake: a network blip on account one must not spend
  // account two. Nothing here proves the allowance is gone.
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.TRANSIENT })
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_STATUS_UNKNOWN');
  assert.strictEqual(result.switched, false);
  assert.strictEqual(result.attempts.length, 1, 'no further account may be probed or spent');
});

acheck('an ACCOUNT_MISMATCH stops the cascade so the misconfiguration is seen', async () => {
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.ACCOUNT_MISMATCH })
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_MISMATCH');
  assert.strictEqual(result.attempts.length, 1);
});

acheck('when NO account is usable the answer is a refusal, never a fallback', async () => {
  const result = await selectAccount({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.EXHAUSTED, acctb: STATUS.EXHAUSTED })
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'NO_ACCOUNT_USABLE');
  assert.strictEqual(result.account, null);
  assert.ok(/never falls back to API-key billing/i.test(result.reason));
  assert.strictEqual(result.attempts.length, 3);
});

acheck('a preferred account is tried first, ahead of registry priority', async () => {
  const result = await selectAccount({ registry: registry(), preferred: 'acctb', probe: probeReturning({}) });
  assert.strictEqual(result.account.name, 'acctb');
  assert.strictEqual(result.attempts.length, 1);
});

acheck('a preferred-but-exhausted account still falls back to registry priority order', async () => {
  const result = await selectAccount({
    registry: registry(),
    preferred: 'acctb',
    probe: probeReturning({ acctb: STATUS.EXHAUSTED })
  });
  assert.strictEqual(result.account.name, 'acctc');
  assert.strictEqual(result.attempts[0].account, 'acctb');
});

acheck('selection refuses to guess when no probe is supplied', async () => {
  await assert.rejects(() => selectAccount({ registry: registry() }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_PROBE_MISSING');
});

// ------------------------------------------------------- state and the pin

acheck('a launch candidate does not become active before a launch succeeds', async () => {
  const originalState = {
    activeAccount: null,
    // A record written before the per-provider maps existed reads as null
    // here -- for the account in use and for the account the person chose
    // alike -- and an uncommitted launch must leave it that way.
    activeByProvider: null,
    manualPinByProvider: null,
    lastSwitch: null,
    history: [{ at: '2026-08-09T00:00:00.000Z', outcome: 'manual-switch', account: 'old' }]
  };
  const originalPin = { $comment: ['keep me'], profileDir: '.codex-old' };
  const fsImpl = memoryFs({ [STATE]: JSON.stringify(originalState), [PIN]: JSON.stringify(originalPin) });
  const result = await resolveForLaunch({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.EXHAUSTED }),
    statePath: STATE,
    codexConfigPath: PIN,
    persistSelection: false,
    fsImpl,
    now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'accta');
  const state = readState(STATE, { fsImpl });
  assert.deepStrictEqual(state, originalState);
  assert.deepStrictEqual(fsImpl.read(PIN), originalPin);
  assert.ok(!state.history.some(entry => entry.outcome === 'selected'));
});

acheck('syncing the pin preserves the operator-editable comment and unknown keys', async () => {
  const fsImpl = memoryFs({ [PIN]: JSON.stringify({ $comment: ['keep me'], profileDir: '.codex-old', somethingElse: 7 }) });
  syncCodexPin(PIN, { name: 'x', profileDir: '.codex-new' }, { fsImpl });
  const written = fsImpl.read(PIN);
  assert.deepStrictEqual(written.$comment, ['keep me']);
  assert.strictEqual(written.somethingElse, 7);
  assert.strictEqual(written.profileDir, '.codex-new');
});

acheck('a refusal is recorded too, so a blocked launch is visible afterwards', async () => {
  const fsImpl = memoryFs();
  const result = await resolveForLaunch({
    registry: registry(),
    probe: probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.EXHAUSTED, acctb: STATUS.EXHAUSTED }),
    statePath: STATE,
    fsImpl,
    now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(result.ok, false);
  const state = readState(STATE, { fsImpl });
  assert.strictEqual(state.history.at(-1).outcome, 'refused');
  assert.strictEqual(state.history.at(-1).code, 'NO_ACCOUNT_USABLE');
});

acheck('a refused launch keeps the per-provider map it found, and never writes it back as null', async () => {
  /* Seeded WITHOUT grok on purpose: this is the shape a state file written before
     a57cd698 has. The claim under test is that a refusal keeps the answers it
     found -- 'acctc' and 'other-program' below still have to survive -- and a
     provider that did not exist when the file was written normalises to null,
     the same value an unset provider already had. */
  const seeded = { codex: 'acctc', claude: 'other-program', gemini: null };
  const seededAfterRead = { ...seeded, grok: null };
  const fsImpl = memoryFs({ [STATE]: JSON.stringify({
    activeAccount: 'acctc', activeByProvider: seeded, lastSwitch: null, history: []
  }) });
  const result = await resolveForLaunch({
    registry: registry(), provider: 'codex',
    probe: probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.EXHAUSTED, acctb: STATUS.EXHAUSTED }),
    statePath: STATE, fsImpl, now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(result.ok, false);
  const state = readState(STATE, { fsImpl });
  assert.deepStrictEqual(state.activeByProvider, seededAfterRead, 'a refusal rewrote the map');
  assert.strictEqual(state.activeAccount, 'acctc');
  assert.strictEqual(state.history.at(-1).outcome, 'refused');
  assert.strictEqual(state.history.at(-1).provider, 'codex');
});

acheck('a refusal written after the probes keeps a commit the other program made while they ran', async () => {
  /* Both starts are awaited from the same host and interleave: this Codex
     start reads the record, probes, and is refused, and a Claude start
     commits in between. The refusal must add its own entry to the record as
     it is NOW, not write back the map it read before the probes. */
  const fsImpl = memoryFs();
  const probe = probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.EXHAUSTED, acctb: STATUS.EXHAUSTED });
  const interleaved = async account => {
    if (account.name === 'acctb') {
      writeState(STATE, {
        activeAccount: 'other-program',
        activeByProvider: { codex: null, claude: 'other-program', gemini: null },
        lastSwitch: { at: '2026-08-10T00:00:01.000Z', from: null, to: 'other-program', provider: 'claude', automatic: false, reason: 'x' },
        history: [{ at: '2026-08-10T00:00:01.000Z', outcome: 'selected', account: 'other-program', provider: 'claude' }]
      }, { fsImpl });
    }
    return probe(account);
  };
  const result = await resolveForLaunch({
    registry: registry(), provider: 'codex', probe: interleaved, statePath: STATE, fsImpl,
    now: () => '2026-08-10T00:00:02.000Z'
  });
  assert.strictEqual(result.ok, false);
  const state = readState(STATE, { fsImpl });
  assert.ok(state.activeByProvider, 'the refusal wrote the map it read before the probes, which was none');
  assert.strictEqual(state.activeByProvider.claude, 'other-program', 'the refusal overwrote a commit made while it probed');
  assert.strictEqual(state.activeAccount, 'other-program');
  assert.strictEqual(state.lastSwitch.provider, 'claude');
  assert.deepStrictEqual(state.history.map(entry => [entry.outcome, entry.provider]), [['selected', 'claude'], ['refused', 'codex']]);
});

acheck('without a named provider, a registry of one program still starts from that program\'s own active name', async () => {
  // The legacy single name belongs to whoever committed last; the map is the record.
  const fsImpl = memoryFs({ [STATE]: JSON.stringify({
    activeAccount: 'acctb',
    activeByProvider: { codex: 'accta', claude: 'other-program', gemini: null },
    lastSwitch: null, history: []
  }) });
  const result = await resolveForLaunch({
    registry: registry(), probe: probeReturning({}), statePath: STATE, fsImpl, persistSelection: false
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account.name, 'accta', 'the legacy name outranked the map for a single-program registry');
  assert.strictEqual(result.previousAccount, 'accta');
  assert.strictEqual(result.changed, false);
});

acheck('a manual switch records which program it was for', async () => {
  const fsImpl = memoryFs();
  const result = await switchTo({
    registry: registry(), selector: 'accta', probe: probeReturning({}),
    statePath: STATE, fsImpl, now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(result.ok, true);
  const state = readState(STATE, { fsImpl });
  assert.strictEqual(state.history.at(-1).outcome, 'manual-switch');
  assert.strictEqual(state.history.at(-1).provider, 'codex', 'the history entry does not say which program was switched');
  assert.strictEqual(state.lastSwitch.provider, 'codex');
  assert.deepStrictEqual(state.activeByProvider, { codex: 'accta', claude: null, gemini: null, grok: null });
});

acheck('a manual switch verifies the target before committing to it', async () => {
  const fsImpl = memoryFs();
  const refused = await switchTo({
    registry: registry(), selector: 'accta',
    probe: probeReturning({ accta: STATUS.SIGNED_OUT }),
    statePath: STATE, codexConfigPath: PIN, fsImpl
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(readState(STATE, { fsImpl }).activeAccount, null, 'a refused switch must not change the active account');
});

acheck('a manual switch by ROLE works and is attributed as manual', async () => {
  const fsImpl = memoryFs();
  const result = await switchTo({
    registry: registry(), selector: 'institutional', probe: probeReturning({}),
    statePath: STATE, codexConfigPath: PIN, fsImpl, now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.account, 'acctc');
  const state = readState(STATE, { fsImpl });
  assert.strictEqual(state.lastSwitch.automatic, false);
  assert.strictEqual(fsImpl.read(PIN).profileDir, '.codex-acctc');
});

acheck('--force can override a refusal, and records that it was forced', async () => {
  const fsImpl = memoryFs();
  const result = await switchTo({
    registry: registry(), selector: 'accta',
    probe: probeReturning({ accta: STATUS.SIGNED_OUT }),
    statePath: STATE, codexConfigPath: PIN, fsImpl, force: true
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.forced, true);
  assert.strictEqual(readState(STATE, { fsImpl }).activeAccount, 'accta');
});

acheck('persisted state contains no credential-shaped value', async () => {
  const fsImpl = memoryFs();
  await resolveForLaunch({
    registry: registry(), probe: probeReturning({ acctc: STATUS.EXHAUSTED, accta: STATUS.EXHAUSTED, acctb: STATUS.EXHAUSTED }),
    statePath: STATE, codexConfigPath: PIN, fsImpl, now: () => '2026-08-10T00:00:00.000Z'
  });
  const raw = fsImpl.readFileSync(STATE);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(raw), 'a JWT must never be persisted');
  assert.ok(!/\bsk-[A-Za-z0-9_-]{8,}/.test(raw), 'an API key must never be persisted');
  assert.ok(!/refresh_token|access_token|id_token/.test(raw));
});

acheck('a refused launch cannot revert a switch that landed while it was probing', async () => {
  /* TWO STARTS AT ONCE, WHICH IS THE NORMAL CASE ON A TREE, NOT AN EXOTIC ONE.
   *
   * resolveForLaunch reads state, AWAITS a probe walk, then writes. The success
   * path is safe because commitLaunchSelection re-reads state and compare-and-
   * swaps on the account it expected to be replacing. The refusal path wrote
   * activeAccount and lastSwitch straight from the snapshot taken BEFORE the
   * await, so a switch committed by another start during the walk was silently
   * rolled back and its history entry erased -- and the next start then
   * preferred the spent account all over again.
   *
   * The gate below makes that interleave deterministic rather than hoping for
   * it: the refusing launch parks inside its first probe until the switching
   * launch has finished committing. */
  const fsImpl = memoryFs();
  await switchTo({
    registry: registry(), selector: 'accta', probe: probeReturning({}),
    statePath: STATE, fsImpl, now: () => '2026-08-10T00:00:00.000Z'
  });
  assert.strictEqual(readState(STATE, { fsImpl }).activeAccount, 'accta',
    'the starting point both launches read must be "accta"');

  let releaseWalk;
  const gate = new Promise(resolve => { releaseWalk = resolve; });
  const refusing = resolveForLaunch({
    registry: registry(),
    probe: async account => {
      await gate;
      return Object.freeze({
        account: account.name, status: STATUS.EXHAUSTED, canServe: false,
        usedPercent: 100, resetsAt: null, reason: 'stubbed exhausted'
      });
    },
    statePath: STATE, fsImpl, now: () => '2026-08-10T00:00:02.000Z'
  });

  const switched = await resolveForLaunch({
    registry: registry(),
    probe: probeReturning({ accta: STATUS.EXHAUSTED, acctc: STATUS.EXHAUSTED }),
    statePath: STATE, fsImpl, now: () => '2026-08-10T00:00:01.000Z'
  });
  assert.strictEqual(switched.ok, true, 'the second launch must find a usable account');
  assert.strictEqual(switched.account.name, 'acctb');
  assert.strictEqual(readState(STATE, { fsImpl }).activeAccount, 'acctb',
    'the switch must be committed before the refusal is released');

  releaseWalk();
  const refused = await refusing;
  assert.strictEqual(refused.ok, false, 'the parked launch must still refuse');

  const after = readState(STATE, { fsImpl });
  assert.strictEqual(after.activeAccount, 'acctb',
    'a refusal must not resurrect the account that was switched away from');
  assert.strictEqual(after.lastSwitch && after.lastSwitch.to, 'acctb',
    'the committed switch record must survive a concurrent refusal');
  const outcomes = after.history.map(entry => entry.outcome);
  assert.ok(outcomes.includes('selected'),
    `the committed selection must remain in history, saw ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.includes('refused'),
    `the refusal must still be recorded, saw ${JSON.stringify(outcomes)}`);
});

(async () => {
  let failures = 0;
  // These are collection cardinality assertions, not merely non-empty checks:
  // dropping even one registration must make the runner fail rather than
  // silently reducing the amount of behavior exercised.
  assert.strictEqual(checks.length, 13, 'every synchronous check must be registered');
  assert.strictEqual(asyncChecks.length, 22, 'every asynchronous check must be registered');
  for (const [name, fn] of checks) {
    try { fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failures += 1; process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
  }
  for (const [name, fn] of asyncChecks) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failures += 1; process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
  }
  const total = checks.length + asyncChecks.length;
  process.stdout.write(`\n${total - failures}/${total} checks passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
