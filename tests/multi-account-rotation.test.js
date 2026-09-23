// EXECUTABLE CHANGE
/* TEST-CAN-FAIL REPORT (testcanfail-tests-multi-account-rotation-test-js)
 *
 * SAME-CODE ORACLE: FOUND. Nine assertions compared returned status codes with
 * rotation.CODE, the same exported object used by the implementation to create
 * those returns: no-list, unreadable-list, unresolved-identity, no-provider,
 * sole-selection, none-usable, manual-exhaustion, manual-exhaustion-on-retry,
 * and router-no-registry. Mutation: changed every CODE string in rotation.js
 * to a MUTANT_* value. The strengthened literal assertions made the run RED:
 * "Expected values to be strictly equal:\n+ * + actual - expected\n+ * + 'MUTANT_ACCOUNTS_NOT_CONFIGURED'\n+ * - 'ACCOUNTS_NOT_CONFIGURED'" and the run ended
 * "FAIL - multi-account-rotation (8 failing)". (Two assertions share the
 * manual-exhaustion test, so the first stopped that run.) A second mutation
 * returned MUTANT_ACCOUNT_EXHAUSTED_MANUAL only on the retry and went RED with
 * "the refused fallback became preferred and bypassed manual mode on retry"
 * and "+ 'MUTANT_ACCOUNT_EXHAUSTED_MANUAL'". rotation.js was then restored
 * byte-for-byte after each mutation; the confirmation run ended
 * "PASS - multi-account-rotation (0 failing)".
 *
 * NOT-FOUND: vacuous iteration (all assertion loops use non-empty literals);
 * exit-status/truthy-only process evidence; swallowed failures via try/catch or
 * optional chaining; mocks of the behavior under test; file-wide skips or
 * platform precondition guards. Preconditions not met: none.
 */
'use strict';
/* ROTATION, AT THE SEAM WHERE A REAL AGENT START ACTUALLY REACHES IT.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT COVERED BY THE FILES BESIDE IT.
 * tests/multi-account-failover.test.js already proves the SELECTION POLICY is
 * right, and it always did. What nothing proved -- because nothing did it -- was
 * that a local agent start CONSULTS that policy at all. Measured 2026-08-18 by
 * instrumenting the shipped start path: zero multi-account calls during a whole
 * start, and the switcher's own state file recording 20 selections of which
 * every single one was `automatic: false`. Correct machinery, never called.
 *
 * So every assertion here is about the CALL and its consequences, and each one
 * is written to fail against the code as it was: at HEAD~ there is no
 * rotation.js, prepareConfinedCodexHome() takes no account, and the confined
 * home has one path per level rather than one per account.
 *
 * NO PROVIDER REQUEST IS EVER MADE. Exhaustion is driven through `probe`, the
 * documented injection point selectAccount() already takes -- the same seam
 * tests/multi-account-failover.test.js uses. Draining a real account to prove a
 * selection rule would cost the owner an allowance to learn something the
 * classification seam can state for free.
 *
 * NO REAL HOME IS TOUCHED. Every directory below is created by this file in a
 * temporary folder, and every "credential" in it is a few bytes this file wrote.
 * The real ~/.codex, the real .codex-* homes and the real ~/.claude are never
 * read, never written and never named.
 *
 *   node tests/run-isolated.js tests/multi-account-rotation.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rotation = require('../src/lib/multi-account/rotation.js');
const { STATUS } = require('../src/lib/multi-account/health.js');
const { PROVIDERS, accountsFor, loadRegistry, signInFilePath } = require('../src/lib/multi-account/registry.js');
const { activeFor, readState, switchTo } = require('../src/lib/multi-account/switcher.js');
const { MODE } = require('../src/lib/multi-account/selection-modes.js');
const confinement = require('../src/lib/agent-session-confinement.js');
const { TOOL_REGISTRY, listAccountRouter, systemStatusWithAccountRouter } = require('../src/lib/tool-registry.js');

const ROTATION_SOURCE = path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'rotation.js');
/* The one module in this lane that IS allowed to open a file, and therefore the
   one that has to be fenced by name rather than by the blanket absence of a
   read verb. See the check further down. */
const CLAUDE_ALLOWANCE_SOURCE = path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'claude-allowance.js');

let failures = 0;
const pending = [];
function check(name, run) { pending.push([name, run]); }

/* A whole machine in a temporary folder: a services root for the account list,
   and one throwaway home per account holding an inert sign-in file. */
async function withMachine(run, { accounts, exhaustedAtPercent } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-rotation-'));
  const servicesRoot = path.join(scratch, 'ToolsEnabled');
  const capabilityRoot = path.join(scratch, 'identity', 'capability');
  const registryPath = path.join(capabilityRoot, 'config', 'accounts.json');
  const homeDir = path.join(scratch, 'home');
  fs.mkdirSync(servicesRoot, { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  for (const account of accounts || []) {
    if (account.signedIn === false) continue;
    const dir = path.join(homeDir, account.profileDir || account.configDir || account.homeDir);
    /* The sign-in file sits where the provider table says it does -- for
       Gemini that is one level down, inside the CLI's own `.gemini` folder. */
    const signIn = signInFilePath(dir, PROVIDERS[account.provider] || PROVIDERS.codex);
    fs.mkdirSync(path.dirname(signIn), { recursive: true });
    /* Inert bytes. Nothing under test opens this file -- presence is the whole
       signal -- so this proves the gate is about a file EXISTING and never about
       anything inside it. */
    fs.writeFileSync(signIn, '{"note":"not a credential"}');
  }
  if (accounts) {
    fs.writeFileSync(registryPath, JSON.stringify({
      ...(exhaustedAtPercent ? { exhaustedAtPercent } : {}),
      accounts: accounts.map(({ signedIn, ...entry }) => entry)
    }));
  }
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = capabilityRoot;
  try {
    return await run({ scratch, servicesRoot, capabilityRoot, registryPath, homeDir });
  } finally {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// A probe that answers from a table, so exhaustion is stated rather than bought.
function probeReturning(byName) {
  return async account => {
    const status = byName[account.name] || STATUS.HEALTHY;
    return Object.freeze({
      account: account.name,
      email: null,
      usedPercent: status === STATUS.EXHAUSTED ? 100 : 4,
      resetsAt: null,
      planType: 'pro',
      status,
      canServe: status === STATUS.HEALTHY,
      reason: status === STATUS.EXHAUSTED
        ? 'the allowance for this account is spent.'
        : `stubbed ${status}`
    });
  };
}

const TWO_CODEX = [
  { name: 'school', provider: 'codex', profileDir: '.codex-school', priority: 1 },
  { name: 'personal', provider: 'codex', profileDir: '.codex-personal', priority: 2 }
];

check('Linux unresolved selected home is unreadable, not permission to use the default sign-in', async () => {
  if (process.platform !== 'linux') return;
  await withMachine(async ({ servicesRoot }) => {
    const answer = await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot,
      homeDir: '', probe: probeReturning({}) });
    assert.equal(answer.rotated, false);
    assert.equal(answer.account, null);
    assert.equal(answer.code, 'ACCOUNTS_REGISTRY_UNREADABLE');
    assert.match(answer.reason, /No replacement sign-in was selected/);
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   1. THE FAIL-CLOSED PROMISE: a computer with no account list is unchanged.
   ------------------------------------------------------------------ */

check('no account list means no rotation, and never an error that blocks a start', async () => {
  await withMachine(async ({ servicesRoot }) => {
    for (const provider of ['codex', 'claude']) {
      const result = await rotation.resolveAccountForSession({ provider, servicesRoot });
      assert.equal(result.rotated, false);
      assert.equal(result.blocked, false, 'an absent account list stopped a start that would have worked');
      assert.equal(result.env, null);
      assert.equal(result.code, 'ACCOUNTS_NOT_CONFIGURED');
    }
  });
});

check('an account list that cannot be read still lets the start proceed', async () => {
  await withMachine(async ({ servicesRoot, registryPath }) => {
    fs.writeFileSync(registryPath, '{ not json');
    const result = await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot });
    assert.equal(result.rotated, false);
    assert.equal(result.blocked, false,
      'a damaged optional file became a reason a person could not work');
    assert.equal(result.code, 'ACCOUNTS_REGISTRY_UNREADABLE');
    /* The refusal is still LOUD where it should be: the builder CLI reads the
       same file through loadRegistry(), which throws. Only the start path
       converts it. */
    const loud = rotation.readRegistryQuietly(registryPath);
    assert.equal(loud.registry, null);
  });
});

check('an unresolved installation identity still lets the start proceed', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-rotation-no-identity-'));
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  delete process.env.TOOLSENABLED_STATE_ROOT;
  try {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot: scratch
    });
    assert.equal(result.rotated, false);
    assert.equal(result.blocked, false);
    assert.equal(result.code, 'ACCOUNTS_REGISTRY_UNREADABLE');
    assert.equal(result.detail, 'ACCOUNTS_REGISTRY_NOT_PRESENT_HERE');
  } finally {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

check('a busy state read is unknown rather than absent, is not latched, and probe caching remains', async () => {
  const busy = Object.assign(new Error('machine is busy'), { code: 'EBUSY' });
  const unreadable = rotation.activeAccountRecord('/services', {
    statePath: '/state.json',
    fsImpl: { readFileSync() { throw busy; } }
  });
  assert.equal(unreadable.code, 'ACCOUNT_STATE_UNREADABLE');
  assert.equal(unreadable.detail, 'ACCOUNTS_JSON_READ_FAILED');
  assert.match(unreadable.reason, /does NOT claim that no active account is recorded/);
  assert.notEqual(unreadable, null, 'a could-not-look result became the same answer as no record');

  const recovered = rotation.activeAccountRecord('/services', {
    statePath: '/state.json',
    fsImpl: { readFileSync() { return '{"activeAccount":"school"}'; } }
  });
  assert.equal(recovered.activeAccount, 'school', 'the transient read failure was latched');

  await withMachine(async ({ servicesRoot, homeDir }) => {
    let probes = 0;
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual',
      probe: async account => { probes += 1; return probeReturning({})(account); }
    });
    assert.equal(result.rotated, true);
    assert.equal(probes, 1,
      'control: the manual preflight and commit stopped sharing their legitimately cached probe');
  }, { accounts: TWO_CODEX });
});

check('an account list holding none of this provider does not rotate', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir });
    assert.equal(result.rotated, false);
    assert.equal(result.code, 'ACCOUNTS_NONE_FOR_PROVIDER');
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   2. THE SWITCH ITSELF, ON THE PATH A START TAKES.
   ------------------------------------------------------------------ */

check('an exhausted account hands the session to the next one, when the person allowed it', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'auto',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.equal(result.rotated, true, 'rotation did not fire on a spent account');
    assert.equal(result.account.name, 'personal');
    assert.equal(result.switched, true);
    // The environment the child is spawned under names the chosen home, and
    // names nothing else.
    assert.deepEqual(Object.keys(result.env), ['CODEX_HOME']);
    assert.equal(result.env.CODEX_HOME, path.join(homeDir, '.codex-personal'));
  }, { accounts: TWO_CODEX });
});

check('the switch is recorded as automatic, which is what had never once happened', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'auto',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    const written = JSON.parse(fs.readFileSync(path.join(servicesRoot, rotation.STATE_LEAF), 'utf8'));
    assert.equal(written.activeAccount, 'personal');
    assert.equal(written.lastSwitch.automatic, true,
      'the switch was recorded as manual, which is the state that proved rotation had never fired');
    // Names and statuses only; a credential must never reach this file.
    assert.ok(!/sk-|Bearer |eyJ/.test(JSON.stringify(written)));
  }, { accounts: TWO_CODEX });
});

check('one account is pinned only after the same health gates as every selection', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    let probed = 0;
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'auto',
      probe: async account => { probed += 1; return probeReturning({})(account); }
    });
    assert.equal(probed, 1, 'a single account bypassed the provider health and identity gates');
    assert.equal(result.rotated, true);
    assert.equal(result.code, 'ACCOUNT_SELECTED_SOLE');
    assert.equal(result.env.CODEX_HOME, path.join(homeDir, '.codex-school'));
  }, { accounts: [TWO_CODEX[0]] });
});

check('one exhausted account is refused rather than handed to the caller', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir,
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.equal(result.rotated, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'ACCOUNT_NONE_USABLE');
  }, { accounts: [TWO_CODEX[0]] });
});

/* ------------------------------------------------------------------
   3. THE SETTING IS REAL: manual means manual.
   ------------------------------------------------------------------ */

check('manual STOPS on a spent account instead of switching, and says what to do', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.equal(result.rotated, false, 'a computer set to let the person switch switched by itself');
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'ACCOUNT_EXHAUSTED_MANUAL');
    // The exhaustion is SURFACED, with both names, and with one thing to do.
    assert.match(result.reason, /school/);
    assert.match(result.nextStep, /personal/);
    assert.equal(fs.existsSync(path.join(servicesRoot, rotation.STATE_LEAF)), false,
      'the refused automatic fallback was persisted as the active account');

    const retried = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.equal(retried.code, 'ACCOUNT_EXHAUSTED_MANUAL',
      'the refused fallback became preferred and bypassed manual mode on retry');
  }, { accounts: TWO_CODEX });
});

check('an unreadable or absent answer falls back to manual, the safer half', async () => {
  for (const nonsense of [undefined, null, '', 'AUTO', 'yes', 42]) {
    assert.equal(rotation.normalizeMode(nonsense), 'manual');
  }
  assert.equal(rotation.normalizeMode('auto'), 'auto');
  assert.equal(rotation.DEFAULT_FAILOVER_MODE, 'manual');
});

check('manual does not stop a start it has no reason to stop', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual', probe: probeReturning({})
    });
    assert.equal(result.rotated, true, 'manual blocked a start where nothing was spent');
    assert.equal(result.blocked, false);
    assert.equal(result.code, 'ACCOUNT_SELECTED');
    assert.equal(result.account.name, 'school');
    assert.equal(result.account.provider, 'codex');
    assert.equal(result.account.resolvedHome, path.join(homeDir, '.codex-school'));
    assert.deepEqual(result.env, { CODEX_HOME: path.join(homeDir, '.codex-school') });
    assert.equal(result.switched, false);
    assert.equal(result.nextStep, null);
    assert.match(result.reason, /Using \"school\"/);

    const state = JSON.parse(fs.readFileSync(path.join(servicesRoot, rotation.STATE_LEAF), 'utf8'));
    assert.equal(state.activeAccount, 'school');
    assert.equal(state.history.at(-1).outcome, 'selected');
    assert.equal(state.history.at(-1).account, 'school');
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   4. THE CLAUDE LEG, INCLUDING THE ONE THING THAT KEPT IT OUT.
   ------------------------------------------------------------------ */

check('a Claude session is pointed at the chosen sign-in folder, by its own name', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'claude', servicesRoot, homeDir, mode: 'auto',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.equal(result.rotated, true);
    assert.equal(result.account.name, 'personal');
    assert.deepEqual(Object.keys(result.env), ['CLAUDE_CONFIG_DIR'],
      'a Claude session was handed a Codex variable, which it does not read');
    assert.equal(result.env.CLAUDE_CONFIG_DIR, path.join(homeDir, '.claude-personal'));
  }, {
    accounts: [
      { name: 'school', provider: 'claude', configDir: '.claude-school', priority: 1 },
      { name: 'personal', provider: 'claude', configDir: '.claude-personal', priority: 2 }
    ]
  });
});

check('a Claude home billing a metered key is never selected', async () => {
  /* THE CONDITION THAT USED TO KEEP CLAUDE OUT OF THE REGISTRY ALTOGETHER.
     Every other signal for such a home reads green -- logged in, plan "max" --
     while it quietly bills per token. claudeStatusOf() is the classification
     that makes it unusable, so rotation walks past it instead of spending it. */
  const { STATE } = require('../src/lib/providers/claude-auth-probe.js');
  assert.equal(
    rotation.claudeStatusOf({ state: STATE.AUTHENTICATED, billingSource: 'api_key' }, STATE),
    STATUS.EXHAUSTED,
    'a home on metered billing was treated as usable, which is money spent invisibly'
  );
  // The positive control: the same home on the subscription IS usable.
  assert.equal(
    rotation.claudeStatusOf({ state: STATE.AUTHENTICATED, billingSource: 'subscription' }, STATE),
    STATUS.HEALTHY
  );
  // And an answer that proves nothing stops the cascade rather than spending
  // another account on a guess.
  assert.equal(rotation.claudeStatusOf({ state: STATE.INDETERMINATE }, STATE), STATUS.TRANSIENT);
});

/* ------------------------------------------------------------------
   5. THE CONFINED HOME IS PER ACCOUNT, WHICH IS A BUG THIS AVOIDS.
   ------------------------------------------------------------------ */

check('two accounts get two confined homes, so a second start cannot re-sign the first', async () => {
  /* THE FAILURE THIS PREVENTS, AND IT IS NOT HYPOTHETICAL FROM THE CODE'S SIDE.
     linkCredential() re-links on every prepare, deliberately, because a token
     refresh strands an old link on a superseded inode. With ONE home per level,
     starting a second session as another account would re-link the directory a
     RUNNING session is already using, and that session would carry on as
     somebody else with nothing anywhere to show it. */
  await withMachine(({ servicesRoot, homeDir }) => {
    const tier = { tier: 'standard', sandbox: 'workspace-write', approvalPolicy: 'never', isolated: true };
    const first = confinement.prepareConfinedCodexHome(tier, {
      servicesRoot, accountName: 'school', userCodexHome: path.join(homeDir, '.codex-school')
    });
    const second = confinement.prepareConfinedCodexHome(tier, {
      servicesRoot, accountName: 'personal', userCodexHome: path.join(homeDir, '.codex-personal')
    });
    assert.notEqual(first.codexHome, second.codexHome,
      'two accounts shared one confined home; the second start would re-sign the first session');
    assert.equal(first.account, 'school');
    assert.equal(second.account, 'personal');
  }, { accounts: TWO_CODEX });
});

check('with no account chosen the confined home is the path it has always been', async () => {
  /* The other half of the fail-closed promise, and the reason it is stated as a
     PATH rather than as behaviour: an installation that never adds an account
     must not have its existing home moved out from under it by an upgrade. */
  await withMachine(({ servicesRoot, homeDir }) => {
    const built = confinement.prepareConfinedCodexHome(
      { tier: 'standard', sandbox: 'workspace-write', approvalPolicy: 'never', isolated: true },
      { servicesRoot, userCodexHome: path.join(homeDir, '.codex-school') }
    );
    /* Compared as a LOCATION, not as a spelling. The confinement boundary
       now returns the path Windows really calls this directory, and the
       scratch root here arrives as an 8.3 short name because it lives
       under %TEMP%. Both name the same folder; asserting on the written
       form would pin the test to whichever alias the harness happened to
       be handed. */
    const expected = path.join(servicesRoot, confinement.CONFINED_HOME_LEAF, 'standard');
    assert.equal(fs.realpathSync.native(path.dirname(built.codexHome)),
      fs.realpathSync.native(path.dirname(expected)));
    assert.equal(path.basename(built.codexHome), path.basename(expected));
    assert.equal(built.account, null);
  }, { accounts: TWO_CODEX });
});

check('an account name can never choose a directory', () => {
  for (const hostile of ['../../elsewhere', '..\\..\\elsewhere', '/rooted', 'C:\\rooted', '....', '.']) {
    const segment = confinement.accountSegment(hostile);
    assert.ok(segment === null || !/[\\/:]/.test(segment), `"${hostile}" produced a path: ${segment}`);
    assert.ok(segment === null || !segment.startsWith('.'), `"${hostile}" produced a dotted segment: ${segment}`);
  }
});

/* ------------------------------------------------------------------
   6. THE CREDENTIAL INVARIANT, ASSERTED AGAINST THE SOURCE.
   ------------------------------------------------------------------ */

check('rotation never reads, copies or transmits a sign-in', () => {
  /* An absence of code, which no behavioural test can observe -- the same device
     the Claude engine's own fence test uses. The product invariant, verbatim
     from the legal position of 2026-08-18: "we never read, copy, transmit, or
     hold a provider credential store; sign-in happens inside the official
     client's own flow." This module resolves DIRECTORY NAMES. */
  const code = fs.readFileSync(ROTATION_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const FORBIDDEN = [
    'readFileSync', 'readFile', 'createReadStream', 'openSync', 'readSync',
    'copyFileSync', 'writeFileSync', 'keychain', 'keytar',
    'auth.json', '.credentials', 'ANTHROPIC_API_KEY'
  ];
  for (const forbidden of FORBIDDEN) {
    assert.ok(!code.includes(forbidden),
      `rotation.js contains ${forbidden}. It resolves directory names and must never touch a sign-in.`);
  }
});

check('the one module that may open a file may open exactly one filename', () => {
  /* THE EXCEPTION TO THE RULE ABOVE, FENCED RATHER THAN TRUSTED.
   *
   * Claude's free auth surface reports no usage figure, so the only way to know
   * a Claude account is nearly spent WITHOUT spending a turn to find out is the
   * cache Claude Code writes into `.claude.json`. That is a real read of a real
   * file inside a provider home, which is why it was kept out of rotation.js
   * and given its own module -- and why that module gets its own guard instead
   * of inheriting the blanket one.
   *
   * The rule is narrow on purpose. `.claude.json` is settings and cached state.
   * `.credentials.json` is the SIGN-IN, in the same directory, and this module
   * must be structurally unable to name it. The implementation also compares
   * the resolved basename, so a configDir full of `..` cannot walk the read
   * somewhere else; this asserts the filename never appears in the source at
   * all, which is the part no behavioural test can observe. */
  const code = fs.readFileSync(CLAUDE_ALLOWANCE_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const forbidden of ['.credentials', 'auth.json', 'ANTHROPIC_API_KEY', 'keychain', 'keytar',
    'writeFileSync', 'copyFileSync', 'createReadStream']) {
    assert.ok(!code.includes(forbidden),
      `claude-allowance.js contains ${forbidden}. It may read one cache file and must never touch a sign-in.`);
  }
  const reads = code.match(/readFileSync|readFile\b|openSync|readSync/g) || [];
  assert.equal(reads.length, 1,
    `claude-allowance.js performs ${reads.length} file reads; exactly one is allowed.`);
  assert.ok(code.includes("CACHE_LEAF = '.claude.json'"),
    'claude-allowance.js must name the single cache file it is allowed to open.');

  /* And behaviourally: a directory whose sign-in file is the only thing in it
     yields no reading at all, rather than an exception or a fabricated one. */
  const { claudeAllowance } = require('../src/lib/multi-account/claude-allowance.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-allowance-'));
  try {
    fs.writeFileSync(path.join(scratch, '.credentials.json'), '{"not":"read"}');
    const answer = claudeAllowance(scratch, { exhaustedAtPercent: 90 });
    assert.equal(answer.usedPercent, null, 'an absent cache must not produce a percentage');
    assert.equal(answer.exhausted, false, 'an absent cache must never call an account spent');
    assert.equal(answer.windows.hourly, null);
    assert.equal(answer.windows.weekly, null);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

check('nothing rotation returns carries a credential-shaped value', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'auto',
      probe: probeReturning({ school: STATUS.EXHAUSTED })
    });
    assert.ok(!/sk-|Bearer |eyJ[A-Za-z0-9_-]{6}/.test(JSON.stringify(result)));
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   7. THE THIRD FOLDER-BASED PROVIDER: GEMINI, JUDGED BY PRESENCE ALONE.
   ------------------------------------------------------------------ */

const TWO_GEMINI = [
  { name: 'school', provider: 'gemini', homeDir: '.gemini-school', priority: 1, signedIn: false },
  { name: 'personal', provider: 'gemini', homeDir: '.gemini-personal', priority: 2 }
];

check('a Gemini session is pointed at its home by the Gemini variable, and a missing sign-in is walked past', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    /* No probe injected: this drives the REAL default Gemini probe, which is a
       storage validation followed by a contained quota worker; these inert bytes are refused before any provider request. */
    const result = await rotation.resolveAccountForSession({
      provider: 'gemini', servicesRoot, homeDir, mode: 'auto'
    });
    assert.equal(result.rotated, true, 'a signed-in Gemini home was not selectable');
    assert.equal(result.account.name, 'personal');
    assert.equal(result.switched, true);
    assert.deepEqual(Object.keys(result.env), ['GEMINI_CLI_HOME'],
      'a Gemini session was handed a variable its CLI does not read');
    assert.equal(result.env.GEMINI_CLI_HOME, path.join(homeDir, '.gemini-personal'));
    assert.equal(result.attempts[0].status, STATUS.SIGNED_OUT);
    assert.match(result.attempts[0].reason, /not signed in/);
    // Presence proves sign-in and NOTHING about allowance: never a number.
    assert.equal(result.attempts[1].status, STATUS.HEALTHY);
    assert.equal(result.attempts[1].usedPercent, null);
    assert.deepEqual(result.attempts[1].windows, { hourly: null, weekly: null, weeklyWindows: [] });
  }, { accounts: TWO_GEMINI });
});

check('the accounts panel lists a Gemini account with unread windows, never as 0%', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    fs.writeFileSync(registryPath, JSON.stringify({
      selectionMode: 'most-available',
      accounts: TWO_GEMINI.map(({ signedIn, ...entry }) => entry)
    }));
    const usage = await rotation.readAccountUsage({ registryPath, homeDir, providers: ['gemini'] });
    assert.equal(usage.ok, true);
    assert.equal(usage.accounts.length, 2);
    const personal = usage.accounts.find(row => row.name === 'personal');
    assert.equal(personal.provider, 'gemini');
    assert.equal(personal.status, STATUS.HEALTHY);
    assert.equal(personal.canServe, true);
    assert.equal(personal.usedPercent, null, 'an unmeasured Gemini allowance was given a number');
    assert.deepEqual(personal.windows, { hourly: null, weekly: null, weeklyWindows: [] });
    assert.match(personal.reason, /Allowance and authenticated identity require a separate current check/);
    const school = usage.accounts.find(row => row.name === 'school');
    assert.equal(school.canServe, false);
    // The usage-ranked order says out loud that nothing was measured.
    assert.equal(usage.orders[0].provider, 'gemini');
    assert.equal(usage.orders[0].unmeasuredCount, 2);
    assert.match(usage.orders[0].why, /No account reported/);
  }, { accounts: TWO_GEMINI });
});

check('Grok uses its own sign-in admission and never Codex account status or invented usage', async () => {
  const accounts = [
    { name: 'school', provider: 'grok', configDir: '.grok-school', priority: 1, signedIn: false },
    { name: 'personal', provider: 'grok', configDir: '.grok-personal', priority: 2 }
  ];
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    // Exercise the native probe's unavailable-billing fallback in this fixture,
    // without depending on or starting a developer's installed Grok program.
    // Node rejects the Grok inspection arguments and closes under real custody.
    const { probeGrokAccount } = require('../src/lib/multi-account/health.js');
    const probe = account => probeGrokAccount(account, { homeDir, command: process.execPath });
    const result = await rotation.resolveAccountForSession({ provider: 'grok', servicesRoot, homeDir, mode: 'auto', probe });
    assert.equal(result.rotated, true);
    assert.equal(result.account.name, 'personal');
    assert.deepEqual(result.env, { GROK_HOME: path.join(homeDir, '.grok-personal') });
    assert.deepEqual(result.attempts.map(row => row.status), [STATUS.SIGNED_OUT, STATUS.HEALTHY]);
    const usage = await rotation.readAccountUsage({ registryPath, homeDir, providers: ['grok'], probeFor: () => probe });
    const row = usage.accounts.find(row => row.name === 'personal');
    assert.equal(row.canServe, true);
    assert.equal(row.usedPercent, null);
    assert.deepEqual(row.windows, { hourly: null, weekly: null, weeklyWindows: [] });
    assert.match(row.reason, /first turn checks/);
    assert.doesNotMatch(row.reason, /Codex|quota exhausted/);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.accounts.find(row => row.name === 'personal').expectEmail = 'expected@example.test';
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const pinned = await rotation.resolveAccountForSession({ provider: 'grok', servicesRoot, homeDir, keepTryingAccounts: true, probe });
    assert.equal(pinned.blocked, true, 'sign-in presence must not bypass an expected identity');
    assert.equal(pinned.account, null);
    assert.equal(pinned.attempts.find(row => row.account === 'personal').status, STATUS.TRANSIENT);
  }, { accounts });
});

/* ------------------------------------------------------------------
   8. A PROBE THAT THROWS IS AN ATTEMPT, NOT THE END OF THE LIST.
   ------------------------------------------------------------------ */

check('a probe that throws is recorded as a transient attempt instead of abandoning the list', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const probe = async account => {
      if (account.name === 'school') throw Object.assign(new Error('surface down'), { code: 'EPROBE' });
      return probeReturning({ personal: STATUS.EXHAUSTED })(account);
    };
    for (const selectionMode of ['most-available', 'priority']) {
      const result = await rotation.resolveAccountForSession({
        provider: 'codex', servicesRoot, homeDir, selectionMode, probe
      });
      assert.equal(result.rotated, false);
      assert.equal(result.blocked, true,
        `${selectionMode}: a throwing probe took the start off the registry instead of stopping at the account`);
      assert.equal(result.code, 'ACCOUNT_NONE_USABLE');
      assert.equal(result.selectionMode, selectionMode, 'the mode was lost with the attempt trail');
      assert.equal(result.attempts.length, 1, 'a transient check must stop the walk, not spend the next account');
      assert.equal(result.attempts[0].account, 'school');
      assert.equal(result.attempts[0].status, STATUS.TRANSIENT);
      assert.match(result.attempts[0].reason, /EPROBE/);
      assert.equal(result.attempts[0].usedPercent, null);
    }
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   9. A SWITCH MADE BY HAND STANDS UNTIL THE PERSON CHANGES IT.
   ------------------------------------------------------------------ */

// A probe with real windows, so the usage-ranked modes have something to rank.
function probeWithRoom(usedByName, statusByName = {}) {
  return async account => {
    const used = usedByName[account.name];
    const status = statusByName[account.name] || STATUS.HEALTHY;
    const hourly = Number.isFinite(used)
      ? { kind: 'hourly', usedPercent: used, remainingPercent: 100 - used, resetsAt: null, label: 'primary' }
      : null;
    return Object.freeze({
      account: account.name, email: null, usedPercent: Number.isFinite(used) ? used : null, resetsAt: null,
      planType: 'pro', windows: { hourly, weekly: null }, status, canServe: status === STATUS.HEALTHY,
      reason: `stubbed ${status}`
    });
  };
}

check('a manual switch to the worse-ranked account holds start after start, and only the person moves it', async () => {
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const probe = probeWithRoom({ school: 20, personal: 60 });
    const start = () => rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    const statePath = rotation.statePathFor(servicesRoot);
    const codexOnly = () => {
      const registry = loadRegistry({ configPath: registryPath });
      return { ...registry, accounts: accountsFor(registry, 'codex') };
    };

    const first = await start();
    assert.equal(first.account.name, 'school', 'most room left did not pick the account with the most room');
    assert.equal(first.selectionPinned, null);

    // The person presses "Use this one" on the worse-ranked account.
    const switched = await switchTo({ registry: codexOnly(), selector: 'personal', probe, statePath });
    assert.equal(switched.ok, true);

    /* SEVERAL STARTS, NOT ONE. The one-shot pin this replaces honoured the
       choice on the first start and let the ranking take it back on the
       second -- which on the owner's machine read as a pick that reverted
       itself a couple of minutes later. */
    let held = null;
    for (let run = 1; run <= 5; run += 1) {
      held = await start();
      assert.equal(held.account.name, 'personal', `the ranking took the choice back on start ${run}`);
      assert.equal(held.selectionPinned, 'personal');
      assert.match(held.selectionWhy, /"personal" was chosen by hand/);
      assert.equal(readState(statePath).history.at(-1).outcome, 'selected', 'the start did not consume the pin');
    }
    assert.equal(held.selectionPinnedServed, true);
    assert.equal(first.selectionPinnedServed, null, 'nobody had chosen, so there is nothing to have served');
    assert.equal(readState(statePath).manualPinByProvider.codex, 'personal',
      'the choice lives only in the history, where twenty entries will roll it away');

    // And the person's next choice replaces it, which is the only thing that does.
    assert.equal((await switchTo({ registry: codexOnly(), selector: 'school', probe, statePath })).ok, true);
    const moved = await start();
    assert.equal(moved.account.name, 'school');
    assert.equal(moved.selectionPinned, 'school');
  }, { accounts: TWO_CODEX });
});

check('a start that cannot use the chosen account says so, keeps the choice, and comes back to it', async () => {
  /* THE OWNER'S OWN RECORD, MEASURED 2026-09-03 in
     %LOCALAPPDATA%/ToolsEnabled-Live/multi-account-state.json (account names
     withheld from source per ACCOUNT-FENCE.md). Entry 10 is a
     hand switch to one account at 13:16:57Z. Entry 11, 87 seconds later, is a
     start that put it first, found it 92% through a week that did not reset
     until 16:59:59Z, and used a DIFFERENT account instead -- and that start
     became this provider's last history entry, so the one-shot pin was spent
     by the start that could not honour it. Nothing brought the choice back at
     16:59 either, because by then nothing remembered it. */
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    let chosenIsSpent = false;
    const probe = async account => {
      const spent = chosenIsSpent && account.name === 'personal';
      const weekly = {
        kind: 'weekly', usedPercent: spent ? 92 : 8, remainingPercent: spent ? 8 : 92,
        resetsAt: spent ? '2026-09-03T16:59:59.000Z' : null, label: 'weekly'
      };
      return Object.freeze({
        account: account.name, email: null, planType: 'pro',
        usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt,
        windows: { hourly: null, weekly },
        status: spent ? STATUS.EXHAUSTED : STATUS.HEALTHY, canServe: !spent,
        reason: spent
          ? '92% of its weekly allowance is used; resets 2026-09-03T16:59:59.000Z.'
          : 'stubbed healthy'
      });
    };
    const start = () => rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    const statePath = rotation.statePathFor(servicesRoot);
    const registry = loadRegistry({ configPath: registryPath });

    assert.equal((await switchTo({
      registry: { ...registry, accounts: accountsFor(registry, 'codex') },
      selector: 'personal', probe, statePath
    })).ok, true);

    // The chosen account's week runs out after the person chose it.
    chosenIsSpent = true;
    for (let run = 1; run <= 4; run += 1) {
      const ran = await start();
      assert.equal(ran.account.name, 'school', `the start did not fail over on run ${run}`);
      assert.equal(ran.selectionPinned, 'personal', `the failover took the choice away on run ${run}`);
      assert.match(ran.selectionWhy, /"personal" was chosen by hand and could not serve this start/);
      assert.match(ran.selectionWhy, /resets 2026-09-03T16:59:59\.000Z/,
        'the sentence did not carry the reset the person needs to know');
      assert.match(ran.selectionWhy, /"school" was used instead/);
      assert.match(ran.selectionWhy, /"personal" is still the chosen account/);
      assert.equal(ran.selectionPinnedServed, false);
      assert.equal(readState(statePath).activeByProvider.codex, 'school',
        'control: the failover does overwrite the account in use');
      assert.equal(readState(statePath).manualPinByProvider.codex, 'personal',
        `the failover overwrote the choice on run ${run}`);
    }

    // The allowance comes back, and so does the account the person chose.
    chosenIsSpent = false;
    const back = await start();
    assert.equal(back.account.name, 'personal',
      'the choice did not survive the hours its account was spent');
    assert.equal(back.selectionPinnedServed, true);
  }, { accounts: TWO_CODEX });
});

check('the choice is said and kept under the listed order too, where there is no ranking sentence', async () => {
  /* `priority` is the DEFAULT and it is what the owner's machine runs. It has
     no ranking, so `selectionWhy` was null and the clause that explains a
     failover was gated behind having one -- a choice that was moved off with
     no explanation anywhere. And the head under `priority` is the previously
     active account, which after one failover is the failover's own account, so
     the choice was lost with nothing even recording that it had been. */
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    let chosenIsSpent = false;
    const probe = async account => {
      const spent = chosenIsSpent && account.name === 'personal';
      return Object.freeze({
        account: account.name, email: null, planType: 'pro',
        usedPercent: spent ? 99 : 5, resetsAt: null, windows: { hourly: null, weekly: null },
        status: spent ? STATUS.EXHAUSTED : STATUS.HEALTHY, canServe: !spent,
        reason: spent ? 'the allowance for this account is spent.' : 'stubbed healthy'
      });
    };
    const start = () => rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'priority', probe
    });
    const statePath = rotation.statePathFor(servicesRoot);
    const registry = loadRegistry({ configPath: registryPath });

    assert.equal((await switchTo({
      registry: { ...registry, accounts: accountsFor(registry, 'codex') },
      selector: 'personal', probe, statePath
    })).ok, true);

    chosenIsSpent = true;
    const movedOff = await start();
    assert.equal(movedOff.account.name, 'school');
    assert.equal(movedOff.selectionMode, 'priority');
    assert.equal(movedOff.selectionPinned, 'personal');
    assert.match(movedOff.selectionWhy, /"personal" was chosen by hand and could not serve this start/,
      'the listed order said nothing about moving off the chosen account');
    assert.match(movedOff.selectionWhy, /"personal" is still the chosen account/);
    assert.equal(movedOff.selectionPinnedServed, false);

    chosenIsSpent = false;
    const back = await start();
    assert.equal(back.account.name, 'personal',
      'the listed order kept the failover account at the head instead of the chosen one');
    assert.equal(back.selectionPinnedServed, true);
    assert.match(back.selectionWhy, /"personal" was chosen by hand, so it went first\./);
  }, { accounts: TWO_CODEX });
});

check('the choice outlives the twenty entries of history it used to be read from', async () => {
  /* The record keeps the last twenty history entries. A choice that lives only
     in a `manual-switch` entry is therefore forgotten silently once twenty
     starts have been recorded after it -- on the owner's machine twenty
     entries covered a single working day. The field the switch writes is what
     makes the choice outlast them; this proves it by rolling the history
     right past the entry. */
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const probe = probeWithRoom({ school: 20, personal: 60 });
    const start = () => rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    const statePath = rotation.statePathFor(servicesRoot);
    const registry = loadRegistry({ configPath: registryPath });

    assert.equal((await switchTo({
      registry: { ...registry, accounts: accountsFor(registry, 'codex') },
      selector: 'personal', probe, statePath
    })).ok, true);

    for (let run = 0; run < 25; run += 1) await start();

    const state = readState(statePath);
    assert.equal(state.history.length, 20, 'control: the history did not roll');
    assert.equal(state.history.some(entry => entry.outcome === 'manual-switch'), false,
      'control: the switch entry is still in the window, so nothing was proven');

    const after = await start();
    assert.equal(after.account.name, 'personal', 'the choice fell out of the record with the history');
    assert.equal(after.selectionPinned, 'personal');
    assert.equal(state.manualPinByProvider.codex, 'personal');
  }, { accounts: TWO_CODEX });
});

check('a record that carries the choice only in its history is read, and then promoted into the field', async () => {
  /* A record written before the field existed. The history walk still answers
     it, so an upgrade does not lose a choice already made -- and the first
     start to commit writes it into the field, before the history rolls. */
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const statePath = rotation.statePathFor(servicesRoot);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      activeAccount: 'school',
      activeByProvider: { codex: 'school', claude: null, gemini: null },
      lastSwitch: { at: 't1', from: 'school', to: 'personal', provider: 'codex', automatic: false },
      history: [{ at: 't1', outcome: 'manual-switch', account: 'personal', provider: 'codex', automatic: false }]
    }));
    assert.equal(rotation.manualPin(readState(statePath), 'codex'), 'personal');

    const probe = probeWithRoom({ school: 20, personal: 60 });
    const ran = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    assert.equal(ran.account.name, 'personal',
      'the upgrade lost a choice the old record still carried');
    assert.equal(readState(statePath).manualPinByProvider.codex, 'personal',
      'the choice was read from the history and left there to roll away');
  }, { accounts: TWO_CODEX });
});

check('a switch made by hand on one program survives a start on the other, and pins only its own program', async () => {
  /* THE RECORD IS SHARED. A Codex start appends its own entry and overwrites
     lastSwitch, and the pin used to read only the final entry -- so the Claude
     account the person had just chosen was consumed by a Codex start that
     never looked at it. The Codex start here fails over, so lastSwitch ends up
     automatic and about Codex: both halves of the old check would have
     refused the Claude pin. */
  const BOTH = [
    { name: 'school', provider: 'codex', profileDir: '.codex-school', priority: 1 },
    { name: 'personal', provider: 'codex', profileDir: '.codex-personal', priority: 2 },
    { name: 'school', provider: 'claude', configDir: '.claude-school', priority: 1 },
    { name: 'personal', provider: 'claude', configDir: '.claude-personal', priority: 2 }
  ];
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const probe = async account => (account.provider === 'codex' && account.name === 'school'
      ? probeWithRoom({ school: 20, personal: 60 }, { school: STATUS.EXHAUSTED })(account)
      : probeWithRoom({ school: 20, personal: 60 })(account));
    const start = provider => rotation.resolveAccountForSession({
      provider, servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    const statePath = rotation.statePathFor(servicesRoot);

    assert.equal((await start('claude')).account.name, 'school');

    const registry = loadRegistry({ configPath: registryPath });
    const switched = await switchTo({
      registry: { ...registry, accounts: accountsFor(registry, 'claude') },
      selector: 'personal', probe, statePath
    });
    assert.equal(switched.ok, true);
    assert.equal(rotation.manualPin(readState(statePath), 'claude'), 'personal');
    assert.equal(rotation.manualPin(readState(statePath), 'codex'), null, 'a Claude switch pinned a Codex start');

    const codex = await start('codex');
    assert.equal(codex.account.name, 'personal', 'control: the Codex head was refused, so it failed over');
    assert.equal(codex.switched, true);
    assert.equal(codex.selectionPinned, null, 'a Claude switch pinned a Codex start');
    const between = readState(statePath);
    assert.equal(between.lastSwitch.provider, 'codex');
    assert.equal(between.lastSwitch.automatic, true, 'control: the Codex failover must overwrite lastSwitch');
    assert.equal(between.history.at(-1).provider, 'codex');

    const claude = await start('claude');
    assert.equal(claude.account.name, 'personal',
      'a start on the other program consumed the switch the person made by hand');
    assert.equal(claude.selectionPinned, 'personal');
    assert.match(claude.selectionWhy, /"personal" was chosen by hand/);

    const again = await start('claude');
    assert.equal(again.account.name, 'personal', 'the second Claude start took the choice back');
    assert.equal(again.selectionPinned, 'personal');
    assert.equal(rotation.manualPin(readState(statePath), 'codex'), null,
      'the Codex start wrote itself a choice nobody made');
  }, { accounts: BOTH });
});

check('the choice is read per program, from the field when there is one and from the history when there is not', () => {
  const claudeSwitch = { at: 't1', outcome: 'manual-switch', account: 'personal', provider: 'claude', automatic: false };
  const codexStart = { at: 't2', outcome: 'selected', account: 'personal', provider: 'codex', automatic: true };
  const claudeStart = { at: 't3', outcome: 'selected', account: 'school', provider: 'claude', automatic: true };
  const byHand = { at: 't1', to: 'personal', provider: 'claude', automatic: false };
  const overwritten = { at: 't2', to: 'personal', provider: 'codex', automatic: true };
  const map = { codex: 'personal', claude: 'personal', gemini: null };

  /* THE FIELD ANSWERS ALONE WHEN THE RECORD CARRIES ONE. "Written, and nothing
     in it for this program" is a person having made no choice here, so the
     spent switches still in the history behind it must not be read as live. */
  const chosen = {
    activeAccount: 'personal', activeByProvider: map,
    manualPinByProvider: { codex: null, claude: 'personal', gemini: null },
    lastSwitch: byHand, history: [claudeSwitch, codexStart, claudeStart]
  };
  assert.equal(rotation.manualPin(chosen, 'claude'), 'personal');
  assert.equal(rotation.manualPin(chosen, 'codex'), null, 'a spent history entry was read as a standing choice');
  assert.equal(rotation.manualPin(chosen, 'gemini'), null);

  // Only the Claude switch, in a record written before the field existed.
  const fresh = { activeAccount: 'personal', activeByProvider: map, lastSwitch: byHand, history: [claudeSwitch] };
  assert.equal(rotation.manualPin(fresh, 'claude'), 'personal');
  assert.equal(rotation.manualPin(fresh, 'codex'), null, 'a Claude switch pinned a Codex start');
  assert.equal(rotation.manualPin(fresh, 'gemini'), null);

  // A Codex start, with its own entry and the lastSwitch it overwrote, in between.
  const later = { activeAccount: 'personal', activeByProvider: map, lastSwitch: overwritten, history: [claudeSwitch, codexStart] };
  assert.equal(rotation.manualPin(later, 'claude'), 'personal', 'the other program\'s start consumed the choice');
  assert.equal(rotation.manualPin(later, 'codex'), null);

  /* A start on the SAME program no longer clears it either. That was the
     one-shot rule, and it is what spent the choice on the very start that
     could not honour it. */
  assert.equal(rotation.manualPin({ ...later, history: [...later.history, claudeStart] }, 'claude'), 'personal');

  // Nor does an automatic lastSwitch about this program, which is what a failover writes.
  assert.equal(rotation.manualPin({ ...fresh, lastSwitch: { ...byHand, automatic: true } }, 'claude'), 'personal');
  assert.equal(rotation.manualPin({ ...fresh, lastSwitch: null }, 'claude'), 'personal');

  // A record written before entries named a program answers whichever program asks.
  const legacy = { activeAccount: 'old', activeByProvider: null, lastSwitch: { to: 'old', automatic: false }, history: [{ outcome: 'manual-switch', account: 'old' }] };
  assert.equal(rotation.manualPin(legacy, 'claude'), 'old');
  assert.equal(rotation.manualPin(legacy, 'codex'), 'old');

  // A history with no hand switch in it at all is nobody's choice.
  assert.equal(rotation.manualPin({ ...fresh, history: [codexStart, claudeStart] }, 'claude'), null);
  assert.equal(rotation.manualPin({ activeAccount: null, activeByProvider: null, lastSwitch: null, history: [] }, 'claude'), null);
});

check('the hourly demotion runs on the registry\'s own threshold, at the start and on the panel', async () => {
  /* Registry threshold 90. "school" is at 92% of its hour but has more room
     than "personal" on the binding window, so on the default 99 it is the
     head; on the registry's 90 it has spent its hour and goes to the back,
     which is where health.js already puts it. */
  const window = (kind, usedPercent) => ({ kind, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: null, label: kind });
  const probe = async account => Object.freeze({
    account: account.name, email: null, planType: 'pro', status: STATUS.HEALTHY, canServe: true,
    usedPercent: account.name === 'school' ? 92 : 10, resetsAt: null,
    windows: account.name === 'school'
      ? { hourly: window('hourly', 92), weekly: window('weekly', 0) }
      : { hourly: window('hourly', 10), weekly: window('weekly', 95) },
    reason: 'stubbed'
  });
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', probe
    });
    assert.equal(result.rotated, true);
    assert.equal(result.account.name, 'personal', 'an account past the registry threshold was put at the head');
    assert.match(result.selectionWhy, /"school" has spent its hour/);

    fs.writeFileSync(registryPath, JSON.stringify({ exhaustedAtPercent: 90, selectionMode: 'most-available', accounts: TWO_CODEX }));
    const usage = await rotation.readAccountUsage({ registryPath, homeDir, providers: ['codex'], probeFor: () => probe });
    assert.equal(usage.ok, true);
    assert.equal(usage.policy.exhaustedAtPercent, 90);
    assert.deepEqual([...usage.orders[0].names], ['personal', 'school'], 'the panel ranked on the default threshold');
    assert.match(usage.orders[0].why, /"school" has spent its hour/);

    // And health calls the same account spent at the same number.
    const { classifyProbe } = require('../src/lib/multi-account/health.js');
    const judged = classifyProbe({
      account: TWO_CODEX[0], accountRead: { account: { email: 'school@example.test', planType: 'pro' } },
      rateLimitsResult: { rateLimits: { primary: { usedPercent: 92, windowMinutes: 300, resetsAt: 1_756_900_000 } } },
      exhaustedAtPercent: 90
    });
    assert.equal(judged.status, STATUS.EXHAUSTED);
  }, { accounts: TWO_CODEX, exhaustedAtPercent: 90 });
});

/* ------------------------------------------------------------------
   10. ONE ACTIVE NAME PER PROVIDER.
   ------------------------------------------------------------------ */

check('a Codex switch does not change the Claude head under manual mode, even with the same names', async () => {
  const BOTH = [
    { name: 'school', provider: 'codex', profileDir: '.codex-school', priority: 1 },
    { name: 'personal', provider: 'codex', profileDir: '.codex-personal', priority: 2 },
    { name: 'school', provider: 'claude', configDir: '.claude-school', priority: 1 },
    { name: 'personal', provider: 'claude', configDir: '.claude-personal', priority: 2 }
  ];
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const probe = probeReturning({});
    const claudeStart = () => rotation.resolveAccountForSession({
      provider: 'claude', servicesRoot, homeDir, mode: 'manual', probe
    });
    const codexStart = () => rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual', probe
    });

    assert.equal((await claudeStart()).account.name, 'school');
    const registry = loadRegistry({ configPath: registryPath });
    const switched = await switchTo({
      registry: { ...registry, accounts: accountsFor(registry, 'codex') },
      selector: 'personal', probe, statePath: rotation.statePathFor(servicesRoot)
    });
    assert.equal(switched.ok, true);

    assert.equal((await codexStart()).account.name, 'personal', 'the Codex switch was not honoured for Codex');
    assert.equal((await claudeStart()).account.name, 'school',
      'a Codex switch changed which account the next Claude session started on');

    const state = readState(rotation.statePathFor(servicesRoot));
    assert.deepEqual(state.activeByProvider, { codex: 'personal', claude: 'school', gemini: null, grok: null });
    // The legacy single name is still written for older readers.
    assert.equal(state.activeAccount, 'school');
    const record = rotation.activeAccountRecord(servicesRoot);
    assert.deepEqual(record.activeByProvider, { codex: 'personal', claude: 'school', gemini: null, grok: null });
  }, { accounts: BOTH });
});

check('a record written before the map existed is consulted once, then kept per provider', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const statePath = rotation.statePathFor(servicesRoot);
    fs.writeFileSync(statePath, JSON.stringify({ activeAccount: 'personal', lastSwitch: null, history: [] }));
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'manual', probe: probeReturning({})
    });
    assert.equal(result.account.name, 'personal', 'the legacy name was ignored on an old record');
    const state = readState(statePath);
    // The map is read back with every known provider named, unchosen ones null.
    assert.deepEqual(state.activeByProvider, { codex: 'personal', claude: null, gemini: null, grok: null });
    // With the map present, another provider gets no head from the legacy name.
    assert.equal(activeFor(state, 'claude'), null);
    assert.equal(activeFor(state, 'codex'), 'personal');
    assert.equal(activeFor({ activeAccount: 'legacy', activeByProvider: null }, 'claude'), 'legacy');
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   11. THE EXPLANATION NAMES THE ACCOUNT THAT RAN.
   ------------------------------------------------------------------ */

check('after a failover the explanation names the account that actually ran', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    // school has the most room on paper and is refused by the provider anyway.
    const result = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available',
      probe: probeWithRoom({ school: 10, personal: 50 }, { school: STATUS.EXHAUSTED })
    });
    assert.equal(result.rotated, true);
    assert.equal(result.account.name, 'personal');
    assert.equal(result.switched, true);
    assert.match(result.selectionWhy, /^"school" has the most left/);
    assert.match(result.selectionWhy, /"school" could not serve, so "personal" was used\./,
      'the explanation still described the refused head');
  }, { accounts: TWO_CODEX });
});

/* ------------------------------------------------------------------
   12. THE CLAUDE FIGURE: LIVE USAGE AND CURRENT AUTH STAY SEPARATE.
   ------------------------------------------------------------------ */

function measuredReading(hourly, weekly) {
  return {
    status: 'MEASURED', source: 'claude-get-usage', fetchedAtMs: Date.now(), ageMs: 0, accountUuid: null,
    limits: [
      { kind: 'five_hour', group: null, applicability: 'MEASURED', percent: hourly, resetsAt: null, model: null, isActive: true, index: 0 },
      { kind: 'seven_day', group: null, applicability: 'MEASURED', percent: weekly, resetsAt: null, model: null, isActive: true, index: 1 }
    ],
    bindingLimit: null,
    activeLimits: []
  };
}

function writeFormerClaudeUsage(configDir, usedPercent) {
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      accountUuid: 'fictional-former-account-a', fetchedAtMs: Date.now() - 60_000,
      utilization: { limits: [
        { kind: 'five_hour', percent: usedPercent, resets_at: null, is_active: true },
        { kind: 'seven_day', percent: usedPercent, resets_at: null, is_active: true }
      ] }
    }
  }));
}

function currentClaudeAuth() {
  return require('../src/lib/providers/claude-auth-probe.js').classifyClaudeAuth({
    statusExit: 0, statusStdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai',
      subscriptionType: 'sample-plan', email: 'current-b@example.test' })
  });
}

const CURRENT_CLAUDE = { name: 'current', provider: 'claude', configDir: '.claude-current',
  expectEmail: 'current-b@example.test', priority: 1 };

check('a previous Claude identity cache cannot exhaust the current signed-in account', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    writeFormerClaudeUsage(path.join(homeDir, CURRENT_CLAUDE.configDir), 99);
    const probe = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
      authProbe: async () => currentClaudeAuth(),
      usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_TIMEOUT' }) });
    const row = await probe(CURRENT_CLAUDE);
    assert.equal(row.status, 'healthy', 'the former identity\'s cached 99% changed current authentication to exhausted');
    assert.equal(row.canServe, true);
    assert.equal(row.email, 'current-b@example.test');
    assert.equal(row.usedPercent, null);
    assert.deepEqual(row.windows, { hourly: null, weekly: null, weeklyWindows: [] });
    assert.equal(row.readAt, null);
    assert.equal(row.usageSource, null);
    assert.equal(row.usageStatus, 'unavailable');
    assert.equal(row.usageCode, 'CLAUDE_USAGE_TIMEOUT');
    const selected = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir,
      mode: 'manual', probe });
    assert.equal(selected.blocked, false, 'the actual start resolver still rejects current auth using old cached usage');
    assert.equal(selected.account.name, 'current');
  }, { accounts: [CURRENT_CLAUDE], exhaustedAtPercent: 90 });
});

check('Claude selection cannot rank a new identity using the former identity cached room', async () => {
  const other = { name: 'measured', provider: 'claude', configDir: '.claude-measured', priority: 2 };
  await withMachine(async ({ servicesRoot, registryPath, homeDir }) => {
    writeFormerClaudeUsage(path.join(homeDir, CURRENT_CLAUDE.configDir), 0);
    const probe = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
      authProbe: async () => currentClaudeAuth(), usageProbe: async ({ configDir }) =>
        configDir === path.join(homeDir, CURRENT_CLAUDE.configDir)
          ? { status: 'UNKNOWN', reason: 'CLAUDE_USAGE_TIMEOUT' } : measuredReading(50, 50) });
    const selected = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir,
      selectionMode: 'most-available', probe });
    assert.equal(selected.account.name, 'measured', 'the former identity\'s cached room outranked a current live reading');
    const record = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    fs.writeFileSync(registryPath, JSON.stringify({ ...record, selectionMode: 'most-available' }));
    const usage = await rotation.readAccountUsage({ registryPath, homeDir, providers: ['claude'], probeFor: () => probe });
    assert.deepEqual([...usage.orders[0].names], ['measured', 'current']);
    assert.equal(usage.accounts.find(row => row.name === 'current').usedPercent, null);
    assert.equal(usage.accounts.find(row => row.name === 'measured').usedPercent, 50);
  }, { accounts: [CURRENT_CLAUDE, other], exhaustedAtPercent: 90 });
});

check('current live Claude exhaustion still refuses a start despite room in a former identity cache', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    writeFormerClaudeUsage(path.join(homeDir, CURRENT_CLAUDE.configDir), 0);
    const probe = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
      authProbe: async () => currentClaudeAuth(), usageProbe: async () => measuredReading(99, 99) });
    const row = await probe(CURRENT_CLAUDE);
    assert.equal(row.status, 'exhausted');
    assert.equal(row.canServe, false);
    assert.equal(row.usedPercent, 99);
    assert.equal(row.usageSource, 'claude-get-usage');
    assert.equal(row.usageStatus, 'measured');
    const selected = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir,
      mode: 'manual', probe });
    assert.equal(selected.blocked, true);
    assert.equal(selected.account, null);
  }, { accounts: [CURRENT_CLAUDE], exhaustedAtPercent: 90 });
});

check('a definite Claude reading is reused for a short while instead of starting the two programs again', async () => {
  /* MEASURED 2026-09-18/19 on the owner's computer: 1150 usage-probe launches,
     67 in one hour, eight tree resumes in four minutes each re-reading every
     account. The owner: "why is one of your agents trying to sign into claude
     40 times". A reading both children attested closed is answered again for
     CLAUDE_READING_REUSE_MS; a signed-out one never is. */
  const { withProbeLifecycle } = require('../src/lib/multi-account/probe-lifecycle.js');
  const { classifyClaudeAuth } = require('../src/lib/providers/claude-auth-probe.js');
  rotation.forgetRecentClaudeReadings();
  try {
    await withMachine(async ({ homeDir }) => {
      let clock = 1_000_000;
      let authCalls = 0;
      let usageCalls = 0;
      const probe = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
        reuseWithinMs: rotation.CLAUDE_READING_REUSE_MS, now: () => clock,
        authProbe: async () => { authCalls += 1; return withProbeLifecycle(currentClaudeAuth(), 'closed'); },
        usageProbe: async () => { usageCalls += 1; return withProbeLifecycle(measuredReading(50, 50), 'closed'); } });
      const first = await probe(CURRENT_CLAUDE);
      assert.equal(first.status, 'healthy');
      assert.equal(first.reused, undefined, 'the first reading of an account is a measurement');
      assert.deepEqual([authCalls, usageCalls], [1, 1]);

      clock += 10_000;
      const again = await probe(CURRENT_CLAUDE);
      assert.deepEqual([authCalls, usageCalls], [1, 1], 'a second check ten seconds later started the two Claude programs again');
      assert.equal(again.reused, true, 'a reused reading says so by name');
      assert.equal(again.reusedAfterMs, 10_000);
      assert.equal(again.status, 'healthy');
      assert.equal(again.canServe, true);
      assert.equal(again.usedPercent, 50);
      assert.equal(again.email, 'current-b@example.test');

      clock += rotation.CLAUDE_READING_REUSE_MS;
      const later = await probe(CURRENT_CLAUDE);
      assert.deepEqual([authCalls, usageCalls], [2, 2], 'a reading older than the reuse window was answered instead of measured');
      assert.equal(later.reused, undefined);

      /* A different threshold is a different question, so it is measured. */
      const stricter = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 40,
        reuseWithinMs: rotation.CLAUDE_READING_REUSE_MS, now: () => clock,
        authProbe: async () => { authCalls += 1; return withProbeLifecycle(currentClaudeAuth(), 'closed'); },
        usageProbe: async () => { usageCalls += 1; return withProbeLifecycle(measuredReading(50, 50), 'closed'); } });
      const judged = await stricter(CURRENT_CLAUDE);
      assert.equal(judged.status, 'exhausted');
      assert.deepEqual([authCalls, usageCalls], [3, 3]);
      const judgedAgain = await stricter(CURRENT_CLAUDE);
      assert.equal(judgedAgain.reused, true, 'a spent reading is as definite as a healthy one and is reused');
      assert.deepEqual([authCalls, usageCalls], [3, 3]);

      /* Signed out is never reused: that is the state a person is about to fix. */
      let signedOutCalls = 0;
      const signedOut = classifyClaudeAuth({ statusExit: 1, statusStdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) });
      const out = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
        reuseWithinMs: rotation.CLAUDE_READING_REUSE_MS, now: () => clock,
        authProbe: async () => { signedOutCalls += 1; return withProbeLifecycle(signedOut, 'closed'); },
        usageProbe: async () => withProbeLifecycle({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_RATE_LIMITS_UNAVAILABLE' }, 'closed') });
      const outOne = await out({ ...CURRENT_CLAUDE, name: 'gone', configDir: '.claude-gone' });
      assert.equal(outOne.canServe, false);
      await out({ ...CURRENT_CLAUDE, name: 'gone', configDir: '.claude-gone' });
      assert.equal(signedOutCalls, 2, 'a signed-out reading was reused, hiding the sign-in a person just did');

      /* An injected probe with no reuse asked for is measured every time, so
         every other check in this file keeps counting its own calls. */
      let plainCalls = 0;
      const plain = rotation.claudeProbeFactory({ homeDir, fsImpl: fs, exhaustedAtPercent: 90,
        authProbe: async () => { plainCalls += 1; return withProbeLifecycle(currentClaudeAuth(), 'closed'); },
        usageProbe: async () => withProbeLifecycle(measuredReading(50, 50), 'closed') });
      await plain({ ...CURRENT_CLAUDE, name: 'plain', configDir: '.claude-plain' });
      await plain({ ...CURRENT_CLAUDE, name: 'plain', configDir: '.claude-plain' });
      assert.equal(plainCalls, 2);
    }, { accounts: [CURRENT_CLAUDE], exhaustedAtPercent: 90 });
  } finally {
    rotation.forgetRecentClaudeReadings();
  }
});

check('Claude keeps a failed usage check separate from a successful sign-in check', async () => {
  const { STATE } = require('../src/lib/providers/claude-auth-probe.js');
  const configDir = path.join(os.tmpdir(), 'fixture-claude-usage-not-read');
  const account = { name: 'school', provider: 'claude', configDir, priority: 1 };
  const missingCache = { readFileSync() { throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' }); } };
  const answer = await rotation.claudeProbeFactory({
    homeDir: os.tmpdir(), fsImpl: missingCache, exhaustedAtPercent: 99,
    authProbe: async () => ({ state: STATE.INDETERMINATE, capabilityRan: false, billingSource: 'subscription',
      account: 'school@example.test', plan: 'sample-plan' }),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_TIMEOUT' })
  })(account);
  assert.equal(answer.status, 'healthy');
  assert.equal(answer.canServe, true, 'usage reporting must not change authentication');
  assert.equal(answer.usedPercent, null);
  assert.equal(answer.usageStatus, 'unavailable');
  assert.equal(answer.usageCode, 'CLAUDE_USAGE_TIMEOUT');
  assert.match(answer.usageReason, /could not.*allowance/i);
  assert.equal(answer.readAt, null);
});

check('account usage does not restamp an explicitly unknown measurement time', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    const reading = rotation.claudeAllowanceFromReading({ ...measuredReading(10, 25), fetchedAtMs: 1e50 },
      { exhaustedAtPercent: 99 });
    assert.equal(reading.readAt, null);
    const answer = await rotation.readAccountUsage({ registryPath, homeDir,
      now: () => '2031-01-01T00:00:00.000Z',
      probeFor: () => async () => ({ ...reading, status: 'healthy', canServe: true, usageStatus: 'measured' }) });
    assert.equal(answer.accounts.length, 1);
    assert.equal(answer.accounts[0].readAt, null, 'a new batch timestamp was substituted for unknown measurement age');
    assert.equal(answer.accounts[0].usageStatus, 'measured');
  }, { accounts: [{ name: 'school', provider: 'claude', configDir: '.claude-school', priority: 1 }] });
});

check('the Claude probe uses live usage and leaves unbound cache figures out of account decisions', async () => {
  const { STATE } = require('../src/lib/providers/claude-auth-probe.js');
  const signedIn = async () => ({ state: STATE.INDETERMINATE, capabilityRan: false, billingSource: 'subscription', account: null, plan: null, reason: 'stub' });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-claude-usage-'));
  try {
    const configDir = path.join(scratch, '.claude-school');
    fs.mkdirSync(configDir, { recursive: true });
    // A fresh cache saying 40% of the week, which the live answer must outrank.
    const cachedAt = Date.now() - 60_000;
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: cachedAt,
        utilization: { limits: [
          { kind: 'five_hour', percent: 10, resets_at: null, is_active: true },
          { kind: 'seven_day', percent: 40, resets_at: null, is_active: true }
        ] }
      }
    }));
    const account = { name: 'school', provider: 'claude', configDir, home: configDir, priority: 1 };
    const factory = options => rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 99, authProbe: signedIn, ...options
    });

    const asked = [];
    const live = await factory({ usageProbe: async ({ configDir: dir, timeoutMs }) => { asked.push([dir, timeoutMs]); return measuredReading(30, 95); } })(account);
    assert.deepEqual(asked, [[configDir, rotation.CLAUDE_USAGE_PROBE_TIMEOUT_MS]], 'the live surface was not asked about this folder');
    assert.equal(live.usedPercent, 95, 'the cache outranked a live measurement');
    assert.equal(live.windows.weekly.usedPercent, 95);
    assert.equal(live.windows.hourly.usedPercent, 30);
    assert.equal(live.status, STATUS.HEALTHY);

    const unknown = await factory({ usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_UNAVAILABLE', detail: null }) })(account);
    assert.equal(unknown.usedPercent, null, 'an UNKNOWN live answer adopted an unbound cached figure');
    assert.equal(unknown.readAt, null, 'an unrelated cache supplied this account\'s measurement time');
    assert.equal(unknown.usageStatus, 'unavailable');
    assert.equal(unknown.usageSource, null);
    assert.equal(unknown.status, 'healthy', 'missing usage changed the current auth verdict');

    const faulted = await factory({ usageProbe: async () => { throw new Error('program missing'); } })(account);
    assert.equal(faulted.usedPercent, null, 'a faulting live surface adopted an unbound cached figure');
    assert.equal(faulted.usageCode, 'CLAUDE_USAGE_READ_FAILED');
    assert.equal(faulted.status, 'healthy');

    const absent = await factory({ usageProbe: null })(account);
    assert.equal(absent.usedPercent, null, 'an absent live surface adopted an unbound cached figure');
    assert.equal(absent.status, 'healthy');

    // Only a measured figure at or over the threshold moves a healthy account to spent.
    const spent = await rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 90, authProbe: signedIn,
      usageProbe: async () => measuredReading(30, 95)
    })(account);
    assert.equal(spent.status, STATUS.EXHAUSTED);
    assert.equal(spent.canServe, false);

    // The default CLI can report Fable as its active limit while this session
    // starts Opus. Live reads must use this session's model; an unbound cache
    // cannot claim model-specific exhaustion for either one.
    const scoped = measuredReading(10, 97);
    scoped.limits.push({ kind: 'seven_day', group: 'weekly', applicability: 'MEASURED',
      percent: 100, resetsAt: null, model: 'Fable', isActive: true, index: 2 });
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { limits: [
        { kind: 'five_hour', percent: 10, is_active: false },
        { kind: 'seven_day', percent: 97, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: true,
          scope: { model: { display_name: 'Fable' } } }
      ] } }
    }));
    for (const usageProbe of [async () => scoped, null]) {
      const opus = await factory({ model: 'claude/opus', usageProbe })(account);
      assert.equal(opus.status, STATUS.HEALTHY);
      assert.equal(opus.usedPercent, usageProbe ? 97 : null);
      const fable = await factory({ model: 'claude/fable', usageProbe })(account);
      assert.equal(fable.status, usageProbe ? STATUS.EXHAUSTED : STATUS.HEALTHY);
      assert.equal(fable.canServe, !usageProbe);
      if (!usageProbe) assert.equal(fable.usedPercent, null);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // Keep the public diagnostic budget compatible without using it for ranking.
  assert.equal(rotation.CLAUDE_CACHE_FRESHNESS_BUDGET_MS, 6 * 60 * 60 * 1000);
  // A live reading is converted with the same rules the cache is.
  const converted = rotation.claudeAllowanceFromReading(measuredReading(30, 95), { exhaustedAtPercent: 99 });
  assert.equal(converted.usedPercent, 95);
  assert.equal(converted.exhausted, false);
  assert.equal(rotation.claudeAllowanceFromReading({ ...measuredReading(30, 95), fetchedAtMs: 1e50 },
    { exhaustedAtPercent: 99 }).readAt, null, 'an invalid provider time must not throw or become a fresh date');
  assert.equal(rotation.claudeAllowanceFromReading({ status: 'UNKNOWN', reason: 'x' }, { exhaustedAtPercent: 99 }), null);
});

check('a measured Claude figure judged against an invalid threshold is transient, not healthy', async () => {
  const { STATE } = require('../src/lib/providers/claude-auth-probe.js');
  const signedIn = async () => ({ state: STATE.INDETERMINATE, capabilityRan: false, billingSource: 'subscription', account: null, plan: null, reason: 'stub' });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-claude-threshold-'));
  try {
    const configDir = path.join(scratch, '.claude-school');
    fs.mkdirSync(configDir, { recursive: true });
    const account = { name: 'school', provider: 'claude', configDir, home: configDir, priority: 1 };
    const factory = options => rotation.claudeProbeFactory({ homeDir: scratch, fsImpl: fs, authProbe: signedIn, ...options });

    for (const exhaustedAtPercent of [undefined, Number.NaN, -1, 101, '90']) {
      const live = await factory({ exhaustedAtPercent, usageProbe: async () => measuredReading(30, 95) })(account);
      assert.equal(live.status, STATUS.TRANSIENT,
        `threshold ${String(exhaustedAtPercent)}: a measured account judged against nothing passed as healthy`);
      assert.equal(live.canServe, false);
      assert.equal(live.usedPercent, 95, 'the figure itself is still reported');
      assert.match(live.reason, /threshold is not a valid percentage/);
      assert.match(live.reason, /95% of its weekly allowance is used/);
    }

    // An unbound provider cache cannot supply a figure to judge at all.
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: Date.now() - 60_000, utilization: { limits: [
        { kind: 'five_hour', percent: 10, resets_at: null, is_active: true },
        { kind: 'seven_day', percent: 40, resets_at: null, is_active: true }
      ] } }
    }));
    const cached = await factory({ exhaustedAtPercent: Number.NaN, usageProbe: null })(account);
    assert.equal(cached.status, STATUS.HEALTHY);
    assert.equal(cached.usedPercent, null);
    assert.equal(cached.usageStatus, 'unavailable');

    // Nothing measured means nothing judged: an unread allowance never makes an account worse.
    fs.rmSync(path.join(configDir, '.claude.json'));
    const unread = await factory({ exhaustedAtPercent: Number.NaN, usageProbe: null })(account);
    assert.equal(unread.status, STATUS.HEALTHY, 'an unread allowance was refused over a threshold it never used');

    // A home the auth probe refused keeps its own reason, whatever the threshold.
    const signedOut = async () => ({ state: STATE.SIGNED_OUT, capabilityRan: false, billingSource: 'subscription', account: null, plan: null, reason: 'not signed in' });
    const out = await factory({ authProbe: signedOut, exhaustedAtPercent: Number.NaN, usageProbe: async () => measuredReading(30, 95) })(account);
    assert.equal(out.status, STATUS.SIGNED_OUT);

    // The conversion reports the flag both ways.
    assert.equal(rotation.claudeAllowanceFromReading(measuredReading(30, 95), { exhaustedAtPercent: Number.NaN }).thresholdInvalid, true);
    assert.equal(rotation.claudeAllowanceFromReading(measuredReading(30, 95), { exhaustedAtPercent: 99 }).thresholdInvalid, false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});


/* THE SENTENCE AN EXHAUSTED ROW GETS, WHICH USED TO BE THE PROBE CLI'S.
 *
 * MEASURED 2026-09-03 in the installed copy's own accounts-usage-cache.json
 * (%APPDATA%/ToolsEnabled-Live), written by the accounts menu's last read: the
 * exhausted Claude row's sentence was
 *
 *   "The account surface reports a signed-in session, but no request was made,
 *    so it is not proven able to serve one. Re-run with capability checking
 *    enabled to resolve this. 92% of its weekly allowance is used; resets
 *    2026-09-03T17:00:00.309845+00:00."
 *
 * -- claude-auth-probe.js's INDETERMINATE sentence (advice for whoever runs
 * that probe from a command line) followed by a microsecond ISO timestamp,
 * under a row already flagged "exhausted". selectionReason() only rewrote
 * STATUS.HEALTHY, so every other status inherited the probe's wording, and the
 * live-reading note in claudeAllowanceFromReading() still appended the raw
 * time its cache-reading sibling had already dropped.
 *
 * Asserted as VALUES: the whole sentence, both ways an account becomes spent,
 * and the two neighbours that must NOT change (a healthy home keeps its own
 * sentence, a signed-out one keeps the probe's, because "signed out" and "out
 * of allowance" send a person to two different places). */
const SPENT_RESETS_AT = '2031-01-07T07:00:00.309845+00:00';

function readingWithReset(hourly, weekly, resetsAt) {
  const reading = measuredReading(hourly, weekly);
  return { ...reading, limits: reading.limits.map(limit => (limit.kind === 'seven_day' ? { ...limit, resetsAt } : limit)) };
}

check('an exhausted Claude row says it is out of allowance, in the menu\'s words and with no machine value', async () => {
  const { STATE } = require('../src/lib/providers/claude-auth-probe.js');
  const PROBE_CLI_ADVICE = 'The account surface reports a signed-in session, but no request was made, so it is not proven able to serve one. Re-run with capability checking enabled to resolve this.';
  const signedIn = async () => ({
    state: STATE.INDETERMINATE, capabilityRan: false, billingSource: 'subscription',
    account: 'someone@example.test', plan: 'sample-plan', reason: PROBE_CLI_ADVICE
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-claude-spent-'));
  try {
    const configDir = path.join(scratch, '.claude-school');
    fs.mkdirSync(configDir, { recursive: true });
    const account = { name: 'school', provider: 'claude', configDir, home: configDir, priority: 1 };
    const factory = options => rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 90, authProbe: signedIn, ...options
    });

    const spent = await factory({ usageProbe: async () => readingWithReset(30, 92, SPENT_RESETS_AT) })(account);
    assert.equal(spent.status, STATUS.EXHAUSTED);
    assert.equal(spent.canServe, false);
    assert.equal(spent.reason,
      'Signed in, but this account is out of allowance for now, so it is not being started. 92% of its weekly allowance is used.');
    assert.ok(!spent.reason.includes('capability checking'),
      'the probe CLI\'s advice is back on a row a person reads');
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(spent.reason),
      'a raw ISO timestamp is back in the sentence');
    // The time itself is not lost: it is a field, and the window carries it too.
    assert.equal(spent.resetsAt, SPENT_RESETS_AT);
    assert.equal(spent.windows.weekly.resetsAt, SPENT_RESETS_AT);

    // The provider refusing outright is the other road to spent, and says so.
    const refused = async () => ({
      state: STATE.RATE_LIMITED, capabilityRan: true, billingSource: 'subscription',
      account: 'someone@example.test', plan: 'sample-plan',
      reason: 'The account is signed in but the provider refused the request for allowance reasons. This is time-bounded: back off or rotate, but the account is not broken.'
    });
    const limited = await rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 90, authProbe: refused, usageProbe: null
    })(account);
    assert.equal(limited.status, STATUS.EXHAUSTED);
    assert.equal(limited.reason,
      'Signed in, but the provider refused the last request for allowance reasons, so this account is not being started.');
    assert.ok(!limited.reason.includes('back off or rotate'), 'operator advice is back on the row');

    // A home with allowance left keeps the sentence it already had.
    const healthy = await factory({ usageProbe: async () => readingWithReset(30, 40, SPENT_RESETS_AT) })(account);
    assert.equal(healthy.status, STATUS.HEALTHY);
    assert.equal(healthy.reason,
      'Signed in on the subscription as someone@example.test; the first turn proves it can serve. 40% of its weekly allowance is used.');

    // And a signed-out home keeps the probe's own sentence: the rewrite is narrow.
    const signedOut = async () => ({
      state: STATE.SIGNED_OUT, capabilityRan: false, billingSource: 'subscription', account: null, plan: null,
      reason: 'This Claude CLI has no signed-in account. Run `claude auth login` for it.'
    });
    const out = await rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 90, authProbe: signedOut, usageProbe: null
    })(account);
    assert.equal(out.status, STATUS.SIGNED_OUT);
    assert.match(out.reason, /Run `claude auth login` for it\./);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // The conversion itself names no time, which is what its cache-reading
  // sibling claude-allowance.js already promised for the same figures.
  const converted = rotation.claudeAllowanceFromReading(readingWithReset(30, 95, SPENT_RESETS_AT), { exhaustedAtPercent: 90 });
  assert.equal(converted.note, '95% of its weekly allowance is used.');
  assert.equal(converted.resetsAt, SPENT_RESETS_AT, 'the time is dropped from the prose, not from the answer');
});

/* AND THE ROW THE ACCOUNT SURFACE NEVER ANSWERED FOR, which the guard above
 * still left to the probe.
 *
 * The two rewrites above name a status apiece, so a row routed to any other
 * status went on inheriting claude-auth-probe.js's voice -- the same shape that
 * put the probe CLI's advice on the exhausted row. MEASURED 2026-09-03 by
 * driving that module's own classifyClaudeAuth() through claudeProbeFactory
 * (a readable usage cache on the folder, a status probe that timed out), the
 * row read:
 *
 *   "The Claude account surface could not be reached (timed out after 6000ms).
 *    This is not evidence about the account, so it is not treated as a
 *    sign-out. 92% of its weekly allowance is used."
 *
 * -- a transport figure and the probe's own routing vocabulary, under a row
 * the accounts menu draws with canServe false.
 *
 * THE FIXTURES ARE THE PROBE'S OWN ANSWERS, not sentences typed here: whatever
 * that module says on these two roads is exactly what this row would inherit if
 * the rewrite stopped covering them. And the two NEIGHBOURS are asserted with
 * them, because the fix must not reach either: a home that says nothing about a
 * sign-in must not be told it is signed in (could-not-look and not-there are
 * different answers), and a home the surface said IS signed out keeps the
 * sentence that sends a person to sign it in. */
const NOTHING_SEEN_SENTENCE = 'This copy could not read the Claude sign-in for this account, so whether it is signed in is not known right now. It is not being started, and it is not being called signed out or out of allowance.';

check('a Claude row the account surface never answered for says so in the menu\'s words, and is not told it is signed in', async () => {
  const { classifyClaudeAuth, STATE } = require('../src/lib/providers/claude-auth-probe.js');
  const unreachable = classifyClaudeAuth({ statusTransportError: 'timed out after 6000ms' });
  const unreadable = classifyClaudeAuth({ statusExit: 0, statusStdout: 'not json' });
  const malformed = classifyClaudeAuth({ statusExit: 1, statusStdout: JSON.stringify({ error: 'temporarily unavailable' }) });
  const signedOut = classifyClaudeAuth({ statusExit: 1, statusStdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) });
  const signedIn = classifyClaudeAuth({ statusExit: 0, statusStdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'someone@example.test' }) });

  // The fact the sentence turns on, stated as a value: on these three roads the
  // account surface named no billing route at all, so no sign-in was seen.
  for (const observed of [unreachable, unreadable, malformed]) {
    assert.equal(observed.state, STATE.INDETERMINATE);
    assert.equal(observed.capabilityRan, false);
    assert.equal(observed.billingSource, null, 'the surface named a billing route on a road where it said nothing');
  }
  assert.equal(signedIn.billingSource, 'subscription', 'a seen sign-in stopped being distinguishable from an unseen one');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-claude-unseen-'));
  try {
    const configDir = path.join(scratch, '.claude-school');
    fs.mkdirSync(configDir, { recursive: true });
    // Even a readable provider cache cannot invent an allowance for an
    // account whose current identity the auth surface never answered for.
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: Date.now() - 60_000,
        utilization: { limits: [
          { kind: 'five_hour', percent: 0, resets_at: null, is_active: true },
          { kind: 'seven_day', percent: 92, resets_at: SPENT_RESETS_AT, is_active: true }
        ] }
      }
    }));
    const account = { name: 'school', provider: 'claude', configDir, home: configDir, priority: 1 };
    const rowFor = (observed, options = {}) => rotation.claudeProbeFactory({
      homeDir: scratch, fsImpl: fs, exhaustedAtPercent: 90, authProbe: async () => observed, usageProbe: null, ...options
    })(account);

    for (const observed of [unreachable, unreadable, malformed]) {
      const row = await rowFor(observed);
      assert.equal(row.status, STATUS.TRANSIENT);
      assert.equal(row.canServe, false);
      assert.equal(row.reason, NOTHING_SEEN_SENTENCE);
      assert.equal(row.usedPercent, null);
      assert.ok(!row.reason.includes('timed out after'), 'a transport figure is back under the row');
      assert.ok(!row.reason.includes('account surface'), 'the probe\'s own vocabulary is back under the row');
      assert.ok(!row.reason.includes('Signed in'), 'a sign-in this copy never saw is being claimed');
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(row.reason), 'a raw ISO timestamp is back in the sentence');
    }

    // NEIGHBOUR ONE: the surface answered, and answered signed out. That is a
    // different fact and a different place to send a person, so it keeps the
    // sentence it had.
    const out = await rowFor(signedOut);
    assert.equal(out.status, STATUS.SIGNED_OUT);
    assert.ok(!out.reason.includes(NOTHING_SEEN_SENTENCE), 'a stated sign-out was rewritten as "could not tell"');
    assert.match(out.reason, /Run `claude auth login` for it\./);

    // NEIGHBOUR TWO: the surface answered, and answered signed in on the
    // subscription. Unchanged, sentence and all.
    const healthy = await rowFor(signedIn, { usageProbe: async () => measuredReading(30, 40) });
    assert.equal(healthy.status, STATUS.HEALTHY);
    assert.equal(healthy.reason,
      'Signed in on the subscription as someone@example.test; the first turn proves it can serve. 40% of its weekly allowance is used.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
/* ------------------------------------------------------------------
   13. THE AGENT-FACING READ: UNKNOWN NEVER BECOMES AVAILABLE.
   ------------------------------------------------------------------ */

const ROUTER_UNKNOWN = 'UNKNOWN';
const ROUTER_CODEX = { name: 'first', provider: PROVIDERS.codex.id, profileDir: 'profiles/first', priority: 1 };
const ROUTER_CLAUDE = { name: 'first', provider: PROVIDERS.claude.id, configDir: 'profiles/first', priority: 1 };

/* THE SERVICES ROOT IS ALWAYS INJECTED, NEVER LEFT AMBIENT. listAccountRouter
   now reports the account in use, which lives in the rotation state under the
   services root; left to resolve itself it would read the RUNNING COMPUTER'S
   real record and make every check here machine-dependent -- and read the
   owner's live state from a unit test. The default is a path inside the
   scratch area that does not exist, so the reading is a deterministic "no
   record yet" rather than whatever this machine happens to hold. */
const ROUTER_NO_SERVICES_ROOT = path.join(os.tmpdir(), 'te-rotation-absent-services-root');
function routerDependencies(registryPath, probeImpl, servicesRoot = ROUTER_NO_SERVICES_ROOT) {
  return { registryPathImpl: () => registryPath, probeImpl, servicesRootImpl: () => servicesRoot };
}

check('the agent account router is exposed through the existing local-read system status surface', () => {
  const tool = TOOL_REGISTRY.find(entry => entry.name === 'system.status');
  assert.ok(tool, 'system.status was not registered');
  assert.equal(tool.effect, 'local-read');
  assert.ok(tool.inputSchema.properties.includeAccountRouter, 'system.status has no account-router request field');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  const unchanged = { status: 'unchanged' };
  assert.equal(systemStatusWithAccountRouter({}, {
    systemStatusImpl: () => unchanged,
    registryPathImpl: () => { throw new Error('ordinary system.status must not inspect accounts'); }
  }), unchanged);
});

check('the agent account list reports no registry as an empty reading, not a fabricated account', async () => {
  await withMachine(async ({ registryPath }) => {
    const result = await systemStatusWithAccountRouter({ includeAccountRouter: true }, {
      ...routerDependencies(registryPath, async () => { throw new Error('an absent registry must not probe'); }),
      systemStatusImpl: () => ({ status: 'base' })
    });
    assert.equal(result.status, 'base');
    assert.equal(result.accountRouter.registryStatus, 'ACCOUNTS_NOT_CONFIGURED');
    assert.equal(result.accountRouter.complete, true);
    assert.deepEqual(result.accountRouter.accounts, []);
    assert.deepEqual(result.accountRouter.availableAccounts, []);
  });
});

check('one account reports provider evidence without inventing a lock state', async () => {
  await withMachine(async ({ registryPath }) => {
    const reset = '2026-08-25T00:00:00.000Z';
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async account => ({
        account: account.name, status: STATUS.HEALTHY, canServe: true,
        usedPercent: 25, resetsAt: reset, reason: 'Provider reading succeeded.'
      })
    ));
    assert.deepEqual(result.accounts[0], {
      name: 'first',
      provider: PROVIDERS.codex.id,
      locked: ROUTER_UNKNOWN,
      usable: ROUTER_UNKNOWN,
      providerUsable: true,
      remainingPercent: 75,
      resetsAt: reset,
      healthStatus: STATUS.HEALTHY,
      reason: 'Provider reading succeeded.'
    });
    assert.deepEqual(result.availableAccounts, [], 'unknown lock state was routed as available');
  }, { accounts: [ROUTER_CODEX] });
});

check('a failed provider probe makes the account-router reading explicitly incomplete', async () => {
  await withMachine(async ({ registryPath }) => {
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async () => { throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); }
    ));
    assert.equal(result.complete, false);
    assert.equal(result.accounts[0].providerUsable, ROUTER_UNKNOWN);
    assert.equal(result.accounts[0].remainingPercent, ROUTER_UNKNOWN);
    assert.equal(result.accounts[0].usable, ROUTER_UNKNOWN);
    assert.match(result.accounts[0].reason, /could not be checked \(PROVIDER_UNAVAILABLE\)/);
    assert.deepEqual(result.availableAccounts, []);
  }, { accounts: [ROUTER_CODEX] });
});

check('a provider without published allowance stays distinct from zero and full and cannot become available', async () => {
  await withMachine(async ({ registryPath }) => {
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async () => ({
        status: STATUS.HEALTHY, canServe: true, usedPercent: null, resetsAt: null,
        reason: 'The provider publishes no allowance reading.'
      })
    ));
    const account = result.accounts[0];
    assert.equal(account.provider, PROVIDERS.claude.id);
    assert.equal(account.remainingPercent, ROUTER_UNKNOWN);
    assert.equal(account.resetsAt, ROUTER_UNKNOWN);
    assert.notEqual(account.remainingPercent, 0);
    assert.notEqual(account.remainingPercent, 100);
    assert.equal(account.usable, ROUTER_UNKNOWN);
    assert.deepEqual(result.availableAccounts, [], 'UNKNOWN allowance was reported as available');
  }, { accounts: [ROUTER_CLAUDE] });
});

check('a locked raw registry entry stays UNKNOWN because the existing registry contract does not expose locks', async () => {
  await withMachine(async ({ registryPath }) => {
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async () => ({
        status: STATUS.HEALTHY, canServe: true, usedPercent: 0,
        resetsAt: '2026-08-25T00:00:00.000Z', reason: 'Provider reading succeeded.'
      })
    ));
    assert.equal(result.accounts[0].locked, ROUTER_UNKNOWN);
    assert.equal(result.accounts[0].remainingPercent, 100, 'full was not preserved as a numeric value');
    assert.equal(result.accounts[0].usable, ROUTER_UNKNOWN);
    assert.deepEqual(result.availableAccounts, []);
  }, { accounts: [{ ...ROUTER_CODEX, locked: true }] });
});

check('known exhaustion is unusable even when allowance quantity is unknown', async () => {
  await withMachine(async ({ registryPath }) => {
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async () => ({
        status: STATUS.EXHAUSTED, canServe: false, usedPercent: null, resetsAt: null,
        reason: 'The provider reports its spend control reached.'
      })
    ));
    assert.equal(result.accounts[0].providerUsable, false);
    assert.equal(result.accounts[0].remainingPercent, ROUTER_UNKNOWN);
    assert.equal(result.accounts[0].usable, false);
    assert.deepEqual(result.availableAccounts, []);
  }, { accounts: [ROUTER_CODEX] });
});

/* ------------------------------------------------------------------
   THE SENTENCE THE ACCOUNT ROUTER GIVES A CLAUDE ROW.
   ------------------------------------------------------------------

   WHY THIS SURFACE NEEDS ITS OWN CHECKS. The accounts menu and this router
   both ask rotation.claudeStatusOf() what a Claude sign-in's status is, and
   only the menu rewrote the sentence underneath it. So the router forwarded
   claude-auth-probe.js's own reason -- and on the path both surfaces actually
   take (capability: false, because a probe before every start must not spend
   allowance) that reason is the INDETERMINATE one, which tells the reader to
   "Re-run with capability checking enabled". Under a row this same reader had
   just called `exhausted`.

   MEASURED 2026-09-03, driving listAccountRouter() with the measured billing
   tell and no provider spawned: healthStatus `exhausted`, reason "The account
   surface reports a signed-in session, but no request was made, so it is not
   proven able to serve one. Re-run with capability checking enabled to resolve
   this."

   The probe is injected, so no Claude program is started and no allowance is
   spent to learn a sentence. */

const PROBE_CLI_SENTENCE = /not proven able to serve one|capability checking/i;

function claudeObservation(fields) {
  return Object.freeze({
    account: 'someone@example.com',
    plan: 'max',
    authMethod: 'claude.ai',
    capabilityRan: false,
    usable: false,
    canFailover: false,
    reason: 'The account surface reports a signed-in session, but no request was made, so it is not proven able to serve one. Re-run with capability checking enabled to resolve this.',
    ...fields
  });
}

function routerWithAuth(registryPath, homeDir, observed) {
  return {
    registryPathImpl: () => registryPath,
    homeDir,
    claudeAuthProbeImpl: async () => observed,
    /* Injected for the same reason routerDependencies injects it. */
    servicesRootImpl: () => ROUTER_NO_SERVICES_ROOT
  };
}

check('a metered-key Claude row on the account router says the billing route is wrong, not that it is unproven', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    const result = await listAccountRouter({}, routerWithAuth(registryPath, homeDir, claudeObservation({
      state: 'indeterminate', billingSource: 'api_key'
    })));
    const row = result.accounts[0];
    assert.equal(row.healthStatus, STATUS.EXHAUSTED);
    assert.equal(row.providerUsable, false);
    assert.equal(row.reason, '"first" is set up to bill a metered key rather than the subscription, so it was skipped.');
    assert.doesNotMatch(row.reason, PROBE_CLI_SENTENCE, 'the probe CLI\'s advice reached an exhausted row');
    assert.deepEqual(result.availableAccounts, []);
  }, { accounts: [ROUTER_CLAUDE] });
});

check('a rate-limited Claude row on the account router says the provider refused it', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    const result = await listAccountRouter({}, routerWithAuth(registryPath, homeDir, claudeObservation({
      state: 'rate_limited', billingSource: 'subscription', capabilityRan: true,
      reason: 'The account is signed in but the provider refused the request for allowance reasons.'
    })));
    const row = result.accounts[0];
    assert.equal(row.healthStatus, STATUS.EXHAUSTED);
    assert.equal(row.reason, 'Signed in, but the provider refused the last request for allowance reasons, so this account is not being started.');
    assert.doesNotMatch(row.reason, PROBE_CLI_SENTENCE);
  }, { accounts: [ROUTER_CLAUDE] });
});

check('a signed-in Claude row the router calls healthy is not told to re-run a probe', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    const result = await listAccountRouter({}, routerWithAuth(registryPath, homeDir, claudeObservation({
      state: 'indeterminate', billingSource: 'subscription'
    })));
    const row = result.accounts[0];
    assert.equal(row.healthStatus, STATUS.HEALTHY);
    assert.equal(row.providerUsable, true);
    assert.equal(row.reason, 'Signed in on the subscription as someone@example.com; the first turn proves it can serve.');
    assert.doesNotMatch(row.reason, PROBE_CLI_SENTENCE);
  }, { accounts: [ROUTER_CLAUDE] });
});

check('a signed-out Claude row on the account router keeps the sign-in instruction it always had', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    const result = await listAccountRouter({}, routerWithAuth(registryPath, homeDir, claudeObservation({
      account: null, state: 'signed_out', billingSource: null,
      reason: 'This Claude CLI has no signed-in account. Run `claude auth login` for it.'
    })));
    const row = result.accounts[0];
    assert.equal(row.healthStatus, STATUS.SIGNED_OUT);
    assert.equal(row.reason, 'This Claude CLI has no signed-in account. Run `claude auth login` for it.');
  }, { accounts: [ROUTER_CLAUDE] });
});

/* ------------------------------------------------------------------
   THE ACCOUNT EACH ROW IS ACTUALLY SIGNED IN AS.
   ------------------------------------------------------------------ */

/* WHAT THIS GUARDS. Both live probes report the address the program answers
 * with -- health.js's classifyProbe for Codex, claudeProbeFactory's
 * `observed.account` for Claude -- and this row builder dropped it, so the one
 * surface a person reads (the accounts menu paints from exactly these rows)
 * could label a row "school" over a home signed in as somebody else and show
 * nothing that said so. The row now carries it, and it is null -- never the
 * row's own name -- when the probe did not answer one, because "not answered"
 * and "signed in as this" are not the same fact. */
check('every account row says which sign-in the program answered with, or says nothing', async () => {
  const reading = address => async account => Object.freeze({
    account: account.name,
    email: address,
    usedPercent: 4, resetsAt: null, planType: 'pro',
    status: STATUS.HEALTHY, canServe: true, reason: 'stubbed'
  });
  await withMachine(async ({ homeDir, registryPath }) => {
    const named = await rotation.readAccountUsage({
      registryPath, homeDir, providers: ['codex'], probeFor: () => reading('school@example.test')
    });
    assert.equal(named.ok, true);
    for (const row of named.accounts) {
      assert.equal(row.email, 'school@example.test',
        `the row for "${row.name}" dropped the sign-in the program reported`);
    }

    // A probe that answered no address leaves the field empty rather than
    // filling it in from the entry's label, which would make every row agree
    // with itself by construction.
    for (const silent of [null, '', undefined, 42]) {
      const unread = await rotation.readAccountUsage({
        registryPath, homeDir, providers: ['codex'], probeFor: () => reading(silent)
      });
      assert.equal(unread.accounts[0].email, null,
        `a probe answering ${JSON.stringify(silent)} produced an address on the row anyway`);
      assert.equal(unread.accounts[0].name, 'school', 'the row lost its own name');
    }
  }, { accounts: TWO_CODEX });
});

function heldReading() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

check('an allowance sweep bounds the total number of account probes across providers', async () => {
  const accounts = ['codex', 'claude'].flatMap(provider => Array.from({ length: 10 }, (_, index) => ({
    name: `${provider}-${index}`, provider, priority: index + 1,
    [provider === 'codex' ? 'profileDir' : 'configDir']: `.${provider}-${index}`
  })));
  await withMachine(async ({ registryPath, homeDir }) => {
    const held = heldReading();
    let active = 0, peak = 0, completed = 0;
    const checking = rotation.readAccountUsage({ registryPath, homeDir, probeFor: () => async account => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await held.promise;
        return await probeReturning({})(account);
      } finally { active -= 1; completed += 1; }
    } });
    try {
      await nextAccountTick();
      assert.equal(active, 4, 'one large list started more than four provider-account checks together');
    } finally {
      held.resolve();
      await checking;
    }
    const answer = await checking;
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(completed, 20);
    assert.equal(answer.accounts.length, 20);
    assert.ok(answer.accounts.every(row => row.status === 'healthy'));
  }, { accounts });
});

check('allowance rows retain their account binding and their own check time', async () => {
  await withMachine(async ({ registryPath, homeDir }) => {
    let clock = '2026-09-14T03:00:00.000Z';
    const held = heldReading();
    const checking = rotation.readAccountUsage({ registryPath, homeDir, now: () => clock,
      probeFor: () => async account => {
        if (account.name === 'personal') await held.promise;
        return await probeReturning({})(account);
      } });
    await nextAccountTick();
    clock = '2026-09-14T03:10:00.000Z';
    held.resolve();
    const answer = await checking;
    assert.equal(answer.accounts[0].readAt, '2026-09-14T03:00:00.000Z');
    assert.equal(answer.accounts[1].readAt, '2026-09-14T03:10:00.000Z');
    const binding = answer.accounts[0].allowanceBinding;
    assert.match(binding, /^[a-f0-9]{64}$/);
    assert.equal(binding, rotation.accountUsageBinding({ provider: 'codex', directory: path.join(homeDir, '.codex-school') }));
    assert.notEqual(binding, rotation.accountUsageBinding({ provider: 'codex', directory: path.join(homeDir, '.codex-replacement') }));
    assert.notEqual(rotation.accountUsageBinding({ provider: 'gemini', directory: homeDir }),
      rotation.accountUsageBinding({ provider: 'gemini', client: 'antigravity', directory: homeDir }));
  }, { accounts: TWO_CODEX });
});

check('an unavailable provider probe factory leaves its rows unknown and other providers usable', async () => {
  const accounts = [...TWO_CODEX, { name: 'writing', provider: 'claude', configDir: '.claude-writing', priority: 1 }];
  await withMachine(async ({ registryPath, homeDir }) => {
    let called = 0;
    const result = await rotation.readAccountUsage({ registryPath, homeDir, providers: ['claude', 'codex', 'codex'],
      probeFor: id => {
        if (id === 'claude') throw new Error('fixture provider unavailable');
        return async account => { called += 1; return await probeReturning({})(account); };
      } });
    assert.equal(result.ok, true);
    assert.equal(called, 2, 'duplicate provider filters launched duplicate checks');
    assert.equal(result.accounts.length, 3);
    const unknown = result.accounts.find(row => row.provider === 'claude');
    assert.equal(unknown.status, null);
    assert.equal(unknown.usedPercent, null, 'an unread provider became zero allowance');
    assert.equal(unknown.windows.hourly, null);
    assert.equal(unknown.windows.weekly, null);
    assert.ok(result.accounts.filter(row => row.provider === 'codex').every(row => row.status === 'healthy'));
  }, { accounts });
});

check('account binding uses native path case rules without exposing the directory', () => {
  const lower = rotation.accountUsageBinding({ provider: 'codex', directory: path.join(os.tmpdir(), 'case-account') });
  const upper = rotation.accountUsageBinding({ provider: 'codex', directory: path.join(os.tmpdir(), 'CASE-ACCOUNT') });
  if (process.platform === 'win32') assert.equal(lower, upper);
  else assert.notEqual(lower, upper, 'case-sensitive account homes must not share an identity');
  assert.match(lower, /^[a-f0-9]{64}$/);
  assert.equal(rotation.accountUsageBinding({ provider: 'codex', directory: 'relative-home' }), null);
});

const nextAccountTick = () => new Promise(resolve => setImmediate(resolve));
const captureSelection = promise => promise.then(value => ({ value }), error => ({ error }));

check('a pre-cancelled account selection never reads, quarantines, writes, or probes', async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  let probes = 0;
  const result = await captureSelection(rotation.resolveAccountForSession({
    provider: 'codex', servicesRoot: os.tmpdir(), homeDir: os.tmpdir(), signal: controller.signal,
    fsImpl: {
      readFileSync() { reads += 1; throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
      renameSync() { assert.fail('cancelled selection quarantined state'); },
      writeFileSync() { assert.fail('cancelled selection wrote state'); }
    },
    probe: async () => { probes += 1; }
  }));
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(reads, 0);
  assert.equal(probes, 0);
});

for (const status of [STATUS.HEALTHY, STATUS.TRANSIENT]) {
  check(`cancelling a pending ${status} probe prevents late account and refusal-history writes`, async () => {
    await withMachine(async ({ servicesRoot, homeDir }) => {
      const statePath = rotation.statePathFor(servicesRoot);
      const before = JSON.stringify({ activeAccount: 'school', activeByProvider: { codex: 'school' }, history: [] });
      fs.writeFileSync(statePath, before);
      const controller = new AbortController();
      const held = heldReading();
      let probes = 0;
      const selecting = captureSelection(rotation.resolveAccountForSession({
        provider: 'codex', servicesRoot, homeDir, selectionMode: 'priority', preferred: 'personal',
        signal: controller.signal,
        probe: async account => {
          probes += 1;
          await held.promise;
          return { account: account.name, status, canServe: status === STATUS.HEALTHY, reason: 'controlled reading' };
        }
      }));
      try {
        await nextAccountTick();
        assert.equal(probes, 1, 'the cancellation must land inside the real selection probe');
        controller.abort();
        const immediate = await Promise.race([selecting, nextAccountTick().then(() => ({ pending: true }))]);
        held.resolve();
        await selecting;
        await nextAccountTick();
        assert.equal(fs.readFileSync(statePath, 'utf8'), before,
          'the cancelled selection changed account state after the caller stopped waiting');
        assert.equal(immediate.error?.name, 'AbortError', 'selection remained blocked on its read-only probe');
        assert.equal(probes, 1, 'a cancelled selection started a fallback account probe');
      } finally {
        held.resolve();
        await selecting;
      }
    }, { accounts: TWO_CODEX });
  });
}

check('cancelling parallel ranked account probes prevents the selection walk and its writes', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const statePath = rotation.statePathFor(servicesRoot);
    const before = JSON.stringify({ activeAccount: 'school', activeByProvider: { codex: 'school' }, history: [] });
    fs.writeFileSync(statePath, before);
    const controller = new AbortController();
    const held = heldReading();
    const probed = [];
    const selecting = captureSelection(rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'most-available', signal: controller.signal,
      probe: async account => {
        probed.push(account.name);
        await held.promise;
        return { account: account.name, status: STATUS.HEALTHY, canServe: true, reason: 'controlled ranked reading' };
      }
    }));
    try {
      await nextAccountTick();
      assert.deepEqual(probed, ['school', 'personal']);
      controller.abort();
      const immediate = await Promise.race([selecting, nextAccountTick().then(() => ({ pending: true }))]);
      held.resolve();
      await selecting;
      await nextAccountTick();
      assert.equal(fs.readFileSync(statePath, 'utf8'), before);
      assert.equal(immediate.error?.name, 'AbortError');
      assert.deepEqual(probed, ['school', 'personal']);
    } finally {
      held.resolve();
      await selecting;
    }
  }, { accounts: TWO_CODEX });
});

check('recovery excludes the failed account even when its stale reading is healthy', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const seen = [];
    const result = await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot, homeDir,
      selectionMode: 'priority', preferred: 'school', excludeAccounts: ['school'],
      probe: async account => { seen.push(account.name); return probeReturning({})(account); } });
    assert.equal(result.rotated, true);
    assert.equal(result.account.name, 'personal');
    assert.deepEqual(seen, ['personal']);
  }, { accounts: TWO_CODEX });
});
check('recovery with every account excluded refuses without normal-home fallback or probes', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot, homeDir,
      excludeAccounts: ['school', 'personal'], probe: () => { throw new Error('must not probe'); } });
    assert.equal(result.blocked, true);
    assert.equal(result.rotated, false);
    assert.equal(result.code, 'ACCOUNT_RECOVERY_NO_ALTERNATE');
  }, { accounts: TWO_CODEX });
});

check('keep trying waits honestly when every registered account was already attempted', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const result = await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot, homeDir,
      excludeAccounts: ['school', 'personal'], keepTryingAccounts: true, recheckAttempt: 4,
      now: () => '2026-09-10T12:00:00.000Z', probe: () => { throw new Error('excluded accounts must not be probed'); } });
    assert.equal(result.code, 'ACCOUNT_RECOVERY_NO_ALTERNATE');
    assert.equal(result.blocked, true);
    assert.equal(result.retry.nextAttemptAt, '2026-09-10T12:05:00.000Z');
    assert.equal(result.retry.resetAt, null);
    assert.equal(result.retry.allQuotaExhausted, false);
    assert.equal(result.retry.reason, 'status-recheck');
    assert.deepEqual(result.attempts, [], 'no quota observations may be invented');
  }, { accounts: TWO_CODEX });
});

check('explicit per-node keep trying reaches a later healthy account without changing the standing manual policy', async () => {
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const before = fs.readFileSync(registryPath, 'utf8');
    const result = await rotation.resolveAccountForSession({provider:'codex',servicesRoot,homeDir,mode:'manual',
      keepTryingAccounts:true,probe:probeReturning({school:STATUS.TRANSIENT})});
    assert.equal(result.rotated,true);assert.equal(result.account.name,'personal');assert.equal(result.keepTryingAccounts,true);
    assert.deepEqual(result.attempts.map(row=>row.status),['transient','healthy']);
    assert.equal(fs.readFileSync(registryPath,'utf8'),before,'per-node retry must not rewrite the standing policy');
    assert.equal(result.retry.allQuotaExhausted,false);
  }, {accounts:TWO_CODEX});
});
check('blocked rotation carries the provider reset schedule through the actual resolver result', async () => {
  await withMachine(async ({servicesRoot,homeDir})=>{
    const result=await rotation.resolveAccountForSession({provider:'codex',servicesRoot,homeDir,keepTryingAccounts:true,
      now:()=> '2026-09-10T12:00:00.000Z',probe:async account=>({...await probeReturning({school:STATUS.EXHAUSTED,personal:STATUS.EXHAUSTED})(account),
        resetsAt:account.name==='school'?'2026-09-10T14:00:00Z':'2026-09-10T13:00:00Z'})});
    assert.equal(result.blocked,true);assert.equal(result.account,null);
    assert.equal(result.retry.nextAttemptAt,'2026-09-10T13:00:01.000Z');assert.equal(result.retry.allQuotaExhausted,true);
    assert.equal(rotation.ACCOUNT_RECOVERY_TIMING_VERSION,1);
    const unknown=await rotation.resolveAccountForSession({provider:'codex',servicesRoot,homeDir,keepTryingAccounts:true,recheckAttempt:4,
      now:()=> '2026-09-10T12:00:00.000Z',probe:probeReturning({school:STATUS.TRANSIENT,personal:STATUS.TRANSIENT})});
    assert.equal(unknown.retry.nextAttemptAt,'2026-09-10T12:05:00.000Z','durable retry count must reach the resolver timing calculation');
    assert.equal(unknown.retry.allQuotaExhausted,false);
  },{accounts:TWO_CODEX,exhaustedAtPercent:99});
});

check('Gemini model client filters before probing and preserves the selected native account contract', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const seen = [];
    const probe = async account => { seen.push(account.name); return probeReturning({})(account); };
    const args = { provider: 'gemini', servicesRoot, homeDir, probe };
    const legacy = await rotation.resolveAccountForSession(args);
    assert.equal(legacy.account.name, 'legacy');
    assert.deepEqual(seen, ['legacy']);
    seen.length = 0;
    const agy = await rotation.resolveAccountForSession({ ...args, client: 'antigravity' });
    assert.deepEqual(seen, ['agy']);
    assert.equal(agy.account.client, 'antigravity');
    assert.equal(agy.account.expectEmail, 'expected@example.test');
    assert.equal(agy.env.HOME, path.join(homeDir, '.ag-account'));
    assert.equal(agy.env.XDG_CONFIG_HOME, path.join(homeDir, '.ag-account', '.config'));
    assert.equal(agy.env.GEMINI_CLI_HOME, undefined);
    const excluded = await rotation.resolveAccountForSession({ ...args, client: 'antigravity', excludeAccounts: ['agy'] });
    assert.equal(excluded.code, 'ACCOUNT_RECOVERY_NO_ALTERNATE');
    assert.deepEqual(seen, ['agy'], 'an excluded AGY account must not fall back to the legacy client');
    assert.equal(rotation.ACCOUNT_CLIENT_CONTRACT_VERSION, 1);
  }, { accounts: [
    { name: 'legacy', provider: 'gemini', homeDir: '.old-google', priority: 1 },
    { name: 'agy', provider: 'gemini', homeDir: '.ag-account', client: 'antigravity', expectEmail: 'expected@example.test', priority: 2 }
  ] });
});

check('Rotate uses A/B/A and a new process continues with B from the saved provider cursor', async () => {
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    fs.writeFileSync(registryPath, JSON.stringify({ ...registry, selectionMode: 'rotate' }));
    const args = { provider: 'codex', servicesRoot, homeDir, probe: probeReturning({}) };
    const names = [];
    for (let i = 0; i < 3; i++) {
      const result = await rotation.resolveAccountForSession(args);
      assert.equal(result.rotated, true);
      assert.equal(result.selectionMode, 'rotate');
      names.push(result.account.name);
    }
    assert.deepEqual(names, ['school', 'personal', 'school']);
    const child = `const rotation = require(process.argv[1]);
      const input = JSON.parse(process.argv[2]);
      rotation.resolveAccountForSession({ ...input, probe: async account => ({
        account: account.name, status: 'healthy', canServe: true, reason: 'synthetic eligible account'
      }) }).then(result => { process.stdout.write(JSON.stringify({ name:result.account?.name, mode:result.selectionMode })); },
      error => { process.stderr.write(error.message); process.exitCode = 1; });`;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', child, ROTATION_SOURCE,
      JSON.stringify({ provider: 'codex', servicesRoot, homeDir })], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(actual, { name: 'personal', mode: 'rotate' });
    assert.equal(activeFor(readState(rotation.statePathFor(servicesRoot)), 'codex'), 'personal');
  }, { accounts: TWO_CODEX });
});

check('Rotate serializes concurrent same-provider starts across their free health checks', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const calls = [];
    const probe = async account => {
      calls.push(account.name);
      if (calls.length === 1) { entered(); await waiting; }
      return probeReturning({})(account);
    };
    const args = { provider: 'codex', servicesRoot, homeDir, selectionMode: 'rotate', probe };
    const first = rotation.resolveAccountForSession(args);
    await started;
    const second = rotation.resolveAccountForSession(args);
    const third = rotation.resolveAccountForSession(args);
    release();
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results.map(result => result.account?.name), ['school', 'personal', 'school']);
    assert.deepEqual(calls, ['school', 'personal', 'school']);
  }, { accounts: TWO_CODEX });
});

check('Rotate skips signed-out and exhausted accounts, and stops on unknown health without advancing', async () => {
  const accounts = [...TWO_CODEX,
    { name: 'reserve', provider: 'codex', profileDir: '.codex-reserve', priority: 3 }];
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const statuses = { school: STATUS.SIGNED_OUT, personal: STATUS.EXHAUSTED };
    const args = { provider: 'codex', servicesRoot, homeDir, selectionMode: 'rotate', probe: probeReturning(statuses) };
    const first = await rotation.resolveAccountForSession(args);
    assert.equal(first.account.name, 'reserve');
    assert.deepEqual(first.attempts.map(row => row.account), ['school', 'personal', 'reserve']);
    statuses.school = STATUS.TRANSIENT;
    const refused = await rotation.resolveAccountForSession(args);
    assert.equal(refused.blocked, true);
    assert.equal(refused.account, null);
    assert.equal(activeFor(readState(rotation.statePathFor(servicesRoot)), 'codex'), 'reserve');
    statuses.school = STATUS.HEALTHY;
    assert.equal((await rotation.resolveAccountForSession(args)).account.name, 'school');
  }, { accounts });
});

check('Rotate keeps provider cursors independent and preserves another mode manual pin', async () => {
  const accounts = [...TWO_CODEX,
    { name: 'claude-a', provider: 'claude', configDir: '.claude-a', priority: 1 },
    { name: 'claude-b', provider: 'claude', configDir: '.claude-b', priority: 2 }];
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const statePath = rotation.statePathFor(servicesRoot), registry = loadRegistry({ configPath: registryPath });
    await switchTo({ registry, selector: 'school', statePath, probe: probeReturning({}) });
    const start = provider => rotation.resolveAccountForSession({ provider, servicesRoot, homeDir,
      selectionMode: 'rotate', probe: probeReturning({}) });
    assert.equal((await start('codex')).account.name, 'personal', 'Rotate advances past the last selected account');
    assert.equal((await start('claude')).account.name, 'claude-a');
    assert.equal((await start('codex')).account.name, 'school');
    assert.equal((await start('claude')).account.name, 'claude-b');
    const state = readState(statePath);
    assert.equal(state.manualPinByProvider.codex, 'school', 'Rotate does not erase a saved manual choice');
    assert.equal((await rotation.resolveAccountForSession({ provider: 'codex', servicesRoot, homeDir,
      selectionMode: 'priority', probe: probeReturning({}) })).account.name, 'school');
  }, { accounts });
});

check('Rotate recorded at the top of the registry takes turns across eight starts with a stale by-hand choice still saved (T378)', async () => {
  /* MEASURED 2026-09-18 (ledger T378): 18 of the last 30 spawns landed on one
     account while the Accounts page read Rotate. The registry carried a
     program rule of its own beside the computer-wide one, and the pin from an
     earlier "Use this one" click was honoured under that older rule. That is
     the rule above behaving as a DEFAULT, which is what the Accounts page
     calls it, so the way out is the person picking "Use default" on that
     program's row -- the one control that drops its own mode and leaves its
     window and reserve. This is the registry that choice leaves behind, read
     the way a real start reads it -- no `selectionMode` argument, so
     `providerPolicyOf` decides -- and it has to take turns on every start
     while keeping the by-hand choice for a later return to a mode that reads
     it. The second half of this check is the state the owner actually ran,
     and it stays the documented outcome: a program rule of its own outranks
     the rule above, and under DYNAMIC the by-hand pin is honoured. */
  const accounts = [
    { name: 'claude-a', provider: 'claude', configDir: '.claude-a', priority: 1 },
    { name: 'claude-b', provider: 'claude', configDir: '.claude-b', priority: 2 },
    { name: 'claude-c', provider: 'claude', configDir: '.claude-c', priority: 3 }];
  await withMachine(async ({ servicesRoot, homeDir, registryPath }) => {
    const statePath = rotation.statePathFor(servicesRoot);
    await switchTo({ registry: loadRegistry({ configPath: registryPath }), selector: 'claude-b', statePath, probe: probeReturning({}) });
    assert.equal(rotation.manualPin(readState(statePath), 'claude'), 'claude-b', 'control: the by-hand choice is recorded');
    const recorded = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    fs.writeFileSync(registryPath, JSON.stringify({
      ...recorded, selectionMode: 'rotate',
      selectionByProvider: { claude: { rankWindow: 'hourly', reservePercent: 30 } }
    }));
    const landed = [];
    for (let run = 1; run <= 8; run += 1) {
      const start = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir, probe: probeReturning({}) });
      assert.equal(start.rotated, true, `start ${run} did not run the account list`);
      assert.equal(start.selectionMode, MODE.ROTATE, `start ${run} ran "${start.selectionMode}" instead of the mode recorded at the top`);
      assert.equal(start.selectionPinned, null, `start ${run} let the stale by-hand choice decide under Rotate`);
      landed.push(start.account.name);
    }
    for (let run = 1; run < landed.length; run += 1) {
      assert.notEqual(landed[run], landed[run - 1], `starts ${run} and ${run + 1} both landed on ${landed[run]}: ${landed.join(', ')}`);
    }
    for (const { name } of accounts) {
      assert.ok(landed.filter(used => used === name).length >= 2, `${name} served fewer than 2 of 8 starts: ${landed.join(', ')}`);
    }
    assert.equal(rotation.manualPin(readState(statePath), 'claude'), 'claude-b', 'Rotate erased the saved by-hand choice');
    /* The same registry with the program's own older rule still standing is
       what the owner's computer ran: every start on the one chosen account.
       That is the state the Accounts page write must not leave behind. */
    fs.writeFileSync(registryPath, JSON.stringify({
      ...recorded, selectionMode: 'rotate',
      selectionByProvider: { claude: { selectionMode: 'dynamic', rankWindow: 'hourly' } }
    }));
    const stale = await rotation.resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir, probe: probeReturning({}) });
    assert.equal(stale.selectionMode, MODE.DYNAMIC, 'control: a program rule of its own still outranks the computer-wide one');
    assert.equal(stale.selectionPinned, 'claude-b', 'control: the older rule reads the by-hand choice');
  }, { accounts });
});

check('cancelling a queued Rotate start neither advances the cursor nor releases an earlier turn', async () => {
  await withMachine(async ({ servicesRoot, homeDir }) => {
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let calls = 0;
    const args = { provider: 'codex', servicesRoot, homeDir, selectionMode: 'rotate', probe: async account => {
      if (++calls === 1) { entered(); await waiting; }
      return probeReturning({})(account);
    } };
    const first = rotation.resolveAccountForSession(args);
    await started;
    const controller = new AbortController();
    const cancelled = rotation.resolveAccountForSession({ ...args, signal: controller.signal });
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    controller.abort();
    await rejected;
    const third = rotation.resolveAccountForSession(args);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'third start cannot bypass the held first turn');
    release();
    assert.deepEqual((await Promise.all([first, third])).map(result => result.account?.name), ['school', 'personal']);
  }, { accounts: TWO_CODEX });
});

(async () => {
  for (const [name, run] of pending) {
    try {
      await run();
      process.stdout.write(`ok - ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
    }
  }
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - multi-account-rotation (${failures} failing)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();


/* WHICH ACCOUNT AM I ON -- THE QUESTION THIS SURFACE COULD NOT ANSWER.
 *
 * MEASURED 2026-09-19 (item 2): the owner reported that "checking account
 * status does not work". The Accounts PANEL was correct -- driven on a private
 * candidate it explained a moved-off pin twice, naming both accounts and the
 * reason. The AGENT-FACING surface never answered at all: listAccountRouter
 * returned name/provider/locked/usable/remainingPercent/resetsAt/healthStatus
 * /reason and nothing about which account was running. rotation.js
 * activeAccountRecord() returns exactly that answer and had ZERO production
 * callers in either repository, established three ways: no active/lastSwitch/
 * chosen/inUse/pinned/movedOff anywhere in the router's body; no caller of
 * activeAccountRecord outside its own definition, export and tests; and no
 * reference to activeFor, activeAccountRecord or readState( anywhere in
 * tool-registry.js. It was an ABSENCE, not a stale value.
 *
 * These checks hold the answer in place, and they assert BEHAVIOUR -- they
 * drive the router and read what an agent would receive. */
check('the account router says which account is in use and which one the person chose', async () => {
  const accounts = [
    { name: 'pinned-one', provider: 'claude', configDir: '.claude-pin' },
    { name: 'running-one', provider: 'claude', configDir: '.claude-run' }];
  await withMachine(async ({ registryPath, servicesRoot }) => {
    const statePath = rotation.statePathFor(servicesRoot);
    /* The shape the owner's computer was actually in: a by-hand choice on one
       account and a later automatic start on another. */
    await switchTo({ registry: loadRegistry({ configPath: registryPath }), selector: 'pinned-one', statePath, probe: probeReturning({}) });
    const before = readState(statePath);
    fs.writeFileSync(statePath, JSON.stringify({
      ...before,
      activeAccount: 'running-one',
      activeByProvider: { ...(before.activeByProvider || {}), claude: 'running-one' },
      lastSwitch: { at: '2026-09-19T09:51:43.361Z', from: 'pinned-one', to: 'running-one', provider: 'claude', automatic: true, reason: 'Failed over after 1 unusable account.' }
    }));

    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async account => ({ account: account.name, status: STATUS.HEALTHY, canServe: true, usedPercent: 10, reason: 'synthetic signed-in account' }),
      servicesRoot
    ));

    assert.ok(result.inUse, 'the router answered nothing about the account in use');
    assert.equal(result.inUse.activeByProvider.claude, 'running-one',
      'an agent asking which account it is on must be told the one that is running');
    assert.equal(result.inUse.manualPinByProvider.claude, 'pinned-one',
      'the standing by-hand choice must be carried beside the running account, or a start that ran elsewhere cannot be explained');
    assert.equal(result.inUse.lastSwitch.automatic, true);
    assert.equal(result.inUse.lastSwitch.to, 'running-one');
    /* The allowance half is unchanged: this adds an answer, it does not
       reshape the rows that were already right. */
    assert.equal(result.accounts.length, 2);
    assert.equal(result.registryStatus, 'PRESENT');
  }, { accounts });
});

check('an account router reading with no rotation record says "not known" rather than "nothing is running"', async () => {
  const accounts = [{ name: 'only-one', provider: 'claude', configDir: '.claude-only' }];
  await withMachine(async ({ registryPath }) => {
    /* Default services root: a path that does not exist. An absent record is
       the honest answer before the first session has ever run, and it must not
       read as "no account is in use". */
    const result = await listAccountRouter({}, routerDependencies(
      registryPath,
      async account => ({ account: account.name, status: STATUS.HEALTHY, canServe: true, usedPercent: 10, reason: 'synthetic signed-in account' })
    ));
    assert.ok(Object.hasOwn(result, 'inUse'), 'the field must always be present, so a caller never has to tell "not reported" from "nothing to report"');
    assert.ok(result.inUse, 'an absent record still answers');
    assert.equal(result.inUse.activeAccount, null);
    assert.equal(result.inUse.activeByProvider, null);
    /* And the registry half is still fully reported beside it. */
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].name, 'only-one');
  }, { accounts });
});

check('an unresolvable services root is refused by name on the router, and does not damage the registry rows beside it', async () => {
  const accounts = [{ name: 'only-one', provider: 'claude', configDir: '.claude-only' }];
  await withMachine(async ({ registryPath }) => {
    const result = await listAccountRouter({}, {
      registryPathImpl: () => registryPath,
      probeImpl: async account => ({ account: account.name, status: STATUS.HEALTHY, canServe: true, usedPercent: 10, reason: 'synthetic signed-in account' }),
      servicesRootImpl: () => { const error = new Error('no services root here'); error.code = 'SERVICE_ROOT_UNAVAILABLE'; throw error; }
    });
    assert.equal(result.inUse.code, 'SERVICE_ROOT_UNAVAILABLE', 'the refusal must name itself');
    assert.equal(result.inUse.activeAccount, null);
    assert.match(result.inUse.reason, /does NOT claim that no account is in use/,
      'an unreadable answer must not read as an empty one');
    assert.equal(result.accounts.length, 1, 'a services-root failure must not empty the registry rows');
    assert.equal(result.registryStatus, 'PRESENT');
  }, { accounts });
});
