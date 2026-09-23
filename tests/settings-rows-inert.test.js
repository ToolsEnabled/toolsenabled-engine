'use strict';
/* A DECLARED ENFORCER THAT NEVER READS THE ROW.
 *
 * WHAT WAS WRONG, MEASURED 2026-09-03 ON THIS TREE.
 * tests/settings-enforcement-honesty.test.js already stops a settings row being
 * added with `enforcedBy: ""`. Its guard is `enforcementDeclared()`, which asks
 * whether the catalogue wrote ANY non-empty string -- so a row could name a
 * file that has never mentioned it and count as enforced, which is the same
 * shape as the defect that file was written to fix one level down ("" IS a
 * string, so an entry that named nothing validated exactly like one that named
 * both).
 *
 * tools/settings-set.js has said so in a comment since it was written --
 * "the catalogue is asserting a file, and four of these assertions name a file
 * that never mentions the id" -- and nothing acted on it. A comment naming a
 * defect is the disabled button with an excuse. Opening every .js/.mjs/.cjs/
 * .ps1 outside node_modules and asking which contain each row's id found
 * exactly those four, out of 71 rows:
 *
 *   accounts.failover              declared src/lib/multi-account/rotation.js.
 *                                  rotation.js quotes "the settings row's own
 *                                  words" in its header and never asks what the
 *                                  row says; its only production caller,
 *                                  shell/main.cjs resolveSessionAccount, passes
 *                                  `selectionMode` off the ACCOUNT REGISTRY and
 *                                  never passes `mode`, so the `legacy` slot the
 *                                  row would have used had no production caller
 *                                  either. WIRED by this change, below.
 *   model.api_key                  declared tools/secrets.ps1 and
 *                                  src/lib/providers/customer-model.js. Neither
 *                                  mentions it: the key lives in the vault under
 *                                  `user_model_api_key` and customer-model.js
 *                                  reads it from there. The row's own text says
 *                                  the key "is never written into settings" --
 *                                  and `settings-set model.api_key <key>` wrote
 *                                  it into settings.json. Now declared read-only
 *                                  with the reason, and REFUSED on load.
 *   machines.direct_link_setup     declared a paragraph naming seven files.
 *                                  tools/direct-link.ps1 reads no settings file
 *                                  at all; the switch is its own -On/-Off flags.
 *                                  Declaration emptied: the row is inert and now
 *                                  says so.
 *   outward.identity_authorization declared config/owner-authorization.json and
 *                                  three readers of it. The RECORD is the
 *                                  authority and a two-option seg cannot be one
 *                                  -- src/lib/owner-authorization.js rejects a
 *                                  grant that reserves nothing, which this row
 *                                  has no field for. Declaration emptied.
 *
 * The two emptied rows joined UNENFORCED_BASELINE in
 * tests/settings-enforcement-honesty.test.js, with model.api_key, as DISCOVERED
 * debt rather than new debt: all three were always inert, and the declaration is
 * what hid them from the instrument that counts inert rows.
 *
 * WHY THE RULE IS EXPRESSED THIS WAY. The check derives everything from the
 * source at run time, so a row added tomorrow with a made-up enforcer fails on
 * the day it is added, named. There is deliberately no exemption list.
 *
 * AND "COULD NOT LOOK" IS NOT "NOT THERE". A named file that cannot be read is
 * `unlooked` and never `absent`, because retiring a real enforcer on the
 * strength of a permissions error is the same mistake pointed the other way.
 *
 *   node tests/run-isolated.js tests/settings-rows-inert.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registryModule = require('../src/lib/settings-registry');
const settings = require('../src/lib/settings');
const { failoverChoice, SETTING_ID: FAILOVER_ID } = require('../src/lib/multi-account/failover-setting.js');
const rotation = require('../src/lib/multi-account/rotation.js');
const { PROVIDERS, signInFilePath } = require('../src/lib/multi-account/registry.js');
const { STATUS } = require('../src/lib/multi-account/health.js');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. THE VERDICT ITSELF, DRIVEN WITH VALUES. Every answer it can give, through
//    an injected reader, so none of these depend on what is on disk today.
// ---------------------------------------------------------------------------

function readerOver(files) {
  return relativePath => (Object.prototype.hasOwnProperty.call(files, relativePath)
    ? { ok: true, text: files[relativePath] }
    : { ok: false, reason: 'ENOENT' });
}

test('a row that names no enforcer is undeclared, not absent', () => {
  for (const enforcedBy of ['', '   ', '\t\n', undefined, null, 0, false, [], {}]) {
    const verdict = registryModule.enforcementVerdict({ id: 'x.y', enforcedBy }, { readSource: readerOver({}) });
    assert.equal(verdict.verdict, 'undeclared', `enforcedBy: ${JSON.stringify(enforcedBy)} produced ${verdict.verdict}`);
    assert.deepEqual(verdict.sites, []);
  }
});

test('a declaration naming a file that carries the id is verified', () => {
  const verdict = registryModule.enforcementVerdict(
    { id: 'x.y', enforcedBy: 'src/lib/thing.js reads it before anything else.' },
    { readSource: readerOver({ 'src/lib/thing.js': "const ID = 'x.y';\n" }) },
  );
  assert.equal(verdict.verdict, 'verified');
  assert.deepEqual(verdict.sites, ['src/lib/thing.js']);
  assert.deepEqual(verdict.carrying, ['src/lib/thing.js']);
});

test('a declaration whose every named file was read and does not carry the id is absent', () => {
  const verdict = registryModule.enforcementVerdict(
    { id: 'x.y', enforcedBy: 'src/lib/thing.js and tools/other.ps1 do it together.' },
    { readSource: readerOver({ 'src/lib/thing.js': 'nothing here\n', 'tools/other.ps1': "$id = 'a.b'\n" }) },
  );
  assert.equal(verdict.verdict, 'absent', 'a declaration nothing backs was not reported as absent');
  assert.deepEqual(verdict.sites, ['src/lib/thing.js', 'tools/other.ps1']);
  assert.deepEqual(verdict.carrying, []);
});

test('a named file that could not be read is unlooked, which is not the same answer as absent', () => {
  const verdict = registryModule.enforcementVerdict(
    { id: 'x.y', enforcedBy: 'src/lib/present.js and src/lib/gone.js.' },
    { readSource: readerOver({ 'src/lib/present.js': 'nothing here\n' }) },
  );
  assert.equal(verdict.verdict, 'unlooked',
    'an unreadable file was reported as proof that no enforcer exists');
  assert.deepEqual(verdict.unreadable, [{ site: 'src/lib/gone.js', reason: 'ENOENT' }]);

  /* And an unreadable file does NOT hide a reader that was found. */
  const found = registryModule.enforcementVerdict(
    { id: 'x.y', enforcedBy: 'src/lib/present.js and src/lib/gone.js.' },
    { readSource: readerOver({ 'src/lib/present.js': "const ID = 'x.y'\n" }) },
  );
  assert.equal(found.verdict, 'verified');
});

test('a declaration that names no file at all is unsited, which is its own answer and not a pass', () => {
  const verdict = registryModule.enforcementVerdict(
    { id: 'x.y', enforcedBy: 'built-in product policy, honestly' },
    { readSource: readerOver({}) },
  );
  assert.equal(verdict.verdict, 'unsited');
  assert.deepEqual(verdict.sites, []);
});

test('the path reader takes the whole extension, so a .json record is not read as a .js module', () => {
  assert.deepEqual(
    registryModule.enforcementSites({ id: 'x.y', enforcedBy: 'config/owner-authorization.json is the record.' }),
    ['config/owner-authorization.json'],
  );
  assert.deepEqual(
    registryModule.enforcementSites({ id: 'x.y', enforcedBy: 'src/a.mjs, src/b.cjs, tools/c.ps1 and src/a.mjs again.' }),
    ['src/a.mjs', 'src/b.cjs', 'tools/c.ps1'],
  );
});

test('the id-list helpers report the ids, sorted, and refuse a non-array', () => {
  const entries = [
    { id: 'b.absent', enforcedBy: 'src/lib/quiet.js' },
    { id: 'a.absent', enforcedBy: 'src/lib/quiet.js' },
    { id: 'c.unlooked', enforcedBy: 'src/lib/gone.js' },
    { id: 'd.verified', enforcedBy: 'src/lib/loud.js' },
  ];
  const dependencies = { readSource: readerOver({ 'src/lib/quiet.js': '', 'src/lib/loud.js': 'd.verified' }) };
  assert.deepEqual(registryModule.unverifiedEnforcementIds(entries, dependencies), ['a.absent', 'b.absent']);
  assert.deepEqual(registryModule.unlookedEnforcementIds(entries, dependencies), ['c.unlooked']);
  assert.throws(() => registryModule.unverifiedEnforcementIds('not an array', dependencies), TypeError);
});

// ---------------------------------------------------------------------------
// 2. THE RATCHET, OVER THE SHIPPED CATALOGUE AND THE REAL TREE.
// ---------------------------------------------------------------------------

test('no shipped row declares an enforcer that names a file which never mentions it', () => {
  const { entries } = registryModule.loadRegistry();
  assert.ok(entries.length > 0, 'the catalogue is empty, so nothing was judged');
  const absent = registryModule.unverifiedEnforcementIds(entries);
  assert.deepEqual(absent, [],
    'these rows name an enforcer that was read and does not mention them, so the product tells a person '
    + `they are wired and they are not: ${absent.join(', ')}`);
  const unlooked = registryModule.unlookedEnforcementIds(entries);
  assert.deepEqual(unlooked, [],
    `these rows name a file this check could not open, so nothing here proves them either way: ${unlooked.join(', ')}`);
});

/* Every source file below the repo, once, so both tests over the tree pay for
   the walk a single time. */
function treeSources() {
  const skip = new Set(['node_modules', '.git', 'release', 'builds', 'coverage', 'scratch', 'state']);
  const found = [];
  (function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs|ps1)$/.test(entry.name)) found.push(full);
    }
  }(ROOT));
  assert.ok(found.length > 100, `the tree walk found only ${found.length} source files, so it walked the wrong place`);
  return found;
}

test('every row that claims an enforcer is mentioned somewhere that runs', () => {
  /* THE OTHER HALF, AND THE ONE THE PERSON FEELS. The verdict above judges the
     DECLARATION -- whether the named file carries the id. This asks the tree:
     is the row's id anywhere at all outside the catalogue and its tests? A row
     that claims an enforcer and appears in no executable file is a control that
     moves and changes nothing, whichever files the sentence happens to name. */
  const { entries } = registryModule.loadRegistry();
  const declared = entries.filter(entry => registryModule.enforcementDeclared(entry));
  assert.ok(declared.length > 0, 'no row declares an enforcer, so nothing was judged');

  const sources = treeSources().filter(file => !file.startsWith(path.join(ROOT, 'tests') + path.sep));
  const bodies = sources.map(file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } });
  const unread = declared
    .filter(entry => !bodies.some(body => body.includes(entry.id)))
    .map(entry => entry.id)
    .sort();

  assert.deepEqual(unread, [],
    'these rows claim an enforcer and their id appears in no source file outside tests, so nothing on this '
    + `computer can read what the person chose: ${unread.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 3. accounts.failover, WIRED -- the reader, then the behaviour it changes.
// ---------------------------------------------------------------------------

test('the failover row is read only when the person chose one of its own two answers', () => {
  const chosen = value => ({ values: { [FAILOVER_ID]: value }, provenance: { [FAILOVER_ID]: { source: 'user' } } });

  assert.deepEqual(
    { ...failoverChoice({ loadSettings: () => chosen('manual') }) },
    { chosen: true, settingId: FAILOVER_ID, value: 'manual', reason: 'chosen', source: 'user' },
  );
  assert.equal(failoverChoice({ loadSettings: () => chosen('auto') }).value, 'auto');
  assert.equal(
    failoverChoice({
      loadSettings: () => ({ values: { [FAILOVER_ID]: 'auto' }, provenance: { [FAILOVER_ID]: { source: 'installer' } } }),
    }).value,
    'auto',
    'a value the installer recorded was refused',
  );

  /* A value nobody chose decides nothing, so a flipped catalogue default cannot
     move a machine. */
  assert.deepEqual(
    { ...failoverChoice({ loadSettings: () => ({ values: { [FAILOVER_ID]: 'auto' }, provenance: { [FAILOVER_ID]: { source: 'default' } } }) }) },
    { chosen: false, settingId: FAILOVER_ID, value: null, reason: 'not-chosen', source: 'default' },
  );
  assert.equal(failoverChoice({ loadSettings: () => ({ values: { [FAILOVER_ID]: 'auto' }, provenance: {} }) }).reason, 'not-chosen');

  /* Anything that is not one of the row's own two answers is not an answer. */
  for (const nonsense of ['AUTO', 'priority', '', true, 42, null, undefined]) {
    const answer = failoverChoice({ loadSettings: () => ({ values: { [FAILOVER_ID]: nonsense }, provenance: { [FAILOVER_ID]: { source: 'user' } } }) });
    assert.equal(answer.chosen, false, `${JSON.stringify(nonsense)} was accepted as a choice`);
    assert.equal(answer.reason, 'not-a-choice');
  }

  assert.equal(failoverChoice({ loadSettings: () => ({ values: {} }) }).reason, 'not-declared');
  assert.equal(failoverChoice({ loadSettings: () => { throw new Error('settings file is a directory'); } }).reason, 'settings-unreadable',
    'an unreadable settings file was allowed to escape as a thrown error and stop a start');
});

/* A whole machine in a temporary folder, the same shape
   tests/multi-account-rotation.test.js builds: an account list and one
   throwaway home per account holding inert bytes. No real home is touched and
   no provider is contacted. */
async function withMachine(run, accounts) {
  /* UNDER THE REPO, NOT UNDER TEMP. TOOLSENABLED_STATE_ROOT is fenced by
     src/lib/runtime-state-root.js accountFencedStateRoot(), and on this machine
     os.tmpdir() is the 8.3 short-name form of the profile (C:\\Users\\TOOLSE~2\\
     AppData\\Local\\Temp), which the fence refuses with
     ERR_STATE_ROOT_ACCOUNT_BOUNDARY -- so a fixture in TEMP makes every call
     answer ACCOUNTS_REGISTRY_UNREADABLE and the assertions below would be
     measuring the fence rather than the row. `scratch/` is ignored by git and
     is removed in the finally. */
  const scratchRoot = path.join(ROOT, 'scratch');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'te-failover-row-'));
  const servicesRoot = path.join(scratch, 'ToolsEnabled');
  const capabilityRoot = path.join(scratch, 'identity', 'capability');
  const registryPath = path.join(capabilityRoot, 'config', 'accounts.json');
  const homeDir = path.join(scratch, 'home');
  fs.mkdirSync(servicesRoot, { recursive: true });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  for (const account of accounts) {
    const signIn = signInFilePath(path.join(homeDir, account.profileDir), PROVIDERS[account.provider]);
    fs.mkdirSync(path.dirname(signIn), { recursive: true });
    fs.writeFileSync(signIn, '{"note":"not a credential"}');
  }
  fs.writeFileSync(registryPath, JSON.stringify({ accounts }));
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = capabilityRoot;
  try {
    return await run({ servicesRoot, homeDir });
  } finally {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const TWO_CODEX = [
  { name: 'school', provider: 'codex', profileDir: '.codex-school', priority: 1 },
  { name: 'personal', provider: 'codex', profileDir: '.codex-personal', priority: 2 },
];

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
      reason: status === STATUS.EXHAUSTED ? 'the allowance for this account is spent.' : `stubbed ${status}`,
    });
  };
}

function rowSaying(value) {
  return () => Object.freeze({ chosen: true, settingId: FAILOVER_ID, value, reason: 'chosen', source: 'user' });
}

test('moving the failover row changes what a start does when an account is spent', async () => {
  /* THE ASSERTION THE ROW EXISTED FOR AND NEVER HAD. Same machine, same spent
     account, same probe; the only difference is what the person chose. */
  await withMachine(async ({ servicesRoot, homeDir }) => {
    const stopped = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir,
      probe: probeReturning({ school: STATUS.EXHAUSTED }),
      failoverChoiceImpl: rowSaying('manual'),
    });
    assert.equal(stopped.code, 'ACCOUNT_EXHAUSTED_MANUAL',
      'the person chose to be asked and the computer switched anyway');
    assert.equal(stopped.rotated, false);
    assert.equal(stopped.blocked, true);
    assert.match(stopped.reason, /school/);
    assert.match(stopped.nextStep, /personal/);
  }, TWO_CODEX);

  await withMachine(async ({ servicesRoot, homeDir }) => {
    const moved = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir,
      probe: probeReturning({ school: STATUS.EXHAUSTED }),
      failoverChoiceImpl: rowSaying('auto'),
    });
    assert.equal(moved.code, 'ACCOUNT_SELECTED');
    assert.equal(moved.rotated, true);
    assert.equal(moved.blocked, false);
    assert.equal(moved.account.name, 'personal', 'the person chose to carry on and the computer stopped');
  }, TWO_CODEX);
});

test('a row nobody moved leaves the shipped answer exactly where it was', async () => {
  /* The half that makes wiring this safe to land: an unchosen row must be
     indistinguishable from the code before this change, which walked. */
  for (const unchosen of [
    () => ({ chosen: false, reason: 'not-chosen', value: null }),
    () => ({ chosen: false, reason: 'settings-unreadable', value: null }),
    () => ({ chosen: false, reason: 'not-declared', value: null }),
  ]) {
    await withMachine(async ({ servicesRoot, homeDir }) => {
      const result = await rotation.resolveAccountForSession({
        provider: 'codex', servicesRoot, homeDir,
        probe: probeReturning({ school: STATUS.EXHAUSTED }),
        failoverChoiceImpl: unchosen,
      });
      assert.equal(result.code, 'ACCOUNT_SELECTED', 'an unchosen row changed what the product does');
      assert.equal(result.account.name, 'personal');
    }, TWO_CODEX);
  }
});

test('anything more specific than the global row still wins, and the row is not even asked', async () => {
  /* Precedence, asserted as behaviour rather than as a reading of the code: a
     caller's answer and the accounts panel's answer both beat the global row,
     and the row's reader is not consulted at all when they do -- so a start
     that already has its answer never opens the settings file. */
  await withMachine(async ({ servicesRoot, homeDir }) => {
    let asked = 0;
    const counting = () => { asked += 1; return { chosen: true, value: 'manual' }; };

    const byCaller = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, selectionMode: 'priority',
      probe: probeReturning({ school: STATUS.EXHAUSTED }),
      failoverChoiceImpl: counting,
    });
    assert.equal(byCaller.code, 'ACCOUNT_SELECTED', 'the global row overrode what the caller asked for');
    assert.equal(byCaller.account.name, 'personal');

    const byLegacy = await rotation.resolveAccountForSession({
      provider: 'codex', servicesRoot, homeDir, mode: 'auto',
      probe: probeReturning({ school: STATUS.EXHAUSTED }),
      failoverChoiceImpl: counting,
    });
    assert.equal(byLegacy.code, 'ACCOUNT_SELECTED', 'the global row overrode a mode the caller stated');

    assert.equal(asked, 0, 'the settings file was opened for an answer that was already decided');
  }, TWO_CODEX);
});

test('the row shows the answer the product actually gives when nobody has chosen', () => {
  /* It shipped saying "manual" -- stop -- while ./selection-modes.js defaults to
     the walk, so the control misreported the value in force as well as failing
     to change it. Both halves are read from the code, not restated. */
  const { byId } = registryModule.loadRegistry();
  const row = byId.get(FAILOVER_ID);
  assert.ok(row, 'the failover row is gone from the catalogue');
  const { DEFAULT_SELECTION_MODE, MODE } = require('../src/lib/multi-account/selection-modes.js');
  assert.equal(row.default, DEFAULT_SELECTION_MODE === MODE.MANUAL ? 'manual' : 'auto',
    'the row names a different answer than the one an unchosen machine gives');
  assert.deepEqual(row.options, ['manual', 'auto']);
});

// ---------------------------------------------------------------------------
// 4. A READBACK THAT DECLARES ITSELF READ-ONLY IS READ-ONLY ON THE WAY IN.
// ---------------------------------------------------------------------------

function settingsFile(t, document) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-readonly-row-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(document));
  return file;
}

test('a stored value for a row the catalogue calls read-only is refused, with the catalogue\'s own reason', (t) => {
  const entries = [
    { id: 'locked.thing', control: 'readback', default: 'from elsewhere', readOnlyReason: 'The real one lives in the vault.', enforcedBy: '', derivedFrom: '' },
    { id: 'open.thing', control: 'readback', default: '', enforcedBy: 'src/lib/reader.js', derivedFrom: 'R1' },
  ];
  const fixture = { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
  const valuesPath = settingsFile(t, {
    revision: 3,
    values: { 'locked.thing': 'sk-secret-value', 'open.thing': 'https://example.invalid/v1' },
    provenance: {
      'locked.thing': { source: 'user', atMs: 1, directive: null },
      'open.thing': { source: 'user', atMs: 1, directive: null },
    },
  });

  const resolved = settings.loadSettings({ registry: fixture, valuesPath });
  assert.equal(resolved.values['locked.thing'], 'from elsewhere',
    'a value stored against a read-only row was applied');
  const refusal = resolved.rejected.find(item => item.id === 'locked.thing');
  assert.ok(refusal, 'a value stored against a read-only row was dropped without saying so');
  assert.match(refusal.reason, /The real one lives in the vault\./,
    'the refusal did not carry the reason the catalogue wrote');

  /* A readback WITHOUT that declaration stays writable, which model.endpoint and
     model.name need: src/lib/providers/customer-model.js reads those two out of
     settings.json. */
  assert.equal(resolved.values['open.thing'], 'https://example.invalid/v1');
  assert.equal(resolved.rejected.some(item => item.id === 'open.thing'), false);
});

test('the shipped credential row is one of those, so a key cannot be parked in settings.json', (t) => {
  const { byId } = registryModule.loadRegistry();
  const row = byId.get('model.api_key');
  assert.ok(row, 'the credential row is gone from the catalogue');
  assert.equal(row.control, 'readback');
  assert.match(row.readOnlyReason, /vault/i, 'the credential row no longer says where the key really lives');

  const valuesPath = settingsFile(t, {
    revision: 1,
    values: { 'model.api_key': 'sk-not-a-real-key' },
    provenance: { 'model.api_key': { source: 'user', atMs: 1, directive: null } },
  });
  const resolved = settings.loadSettings({ valuesPath });
  assert.equal(resolved.values['model.api_key'], row.default,
    'a key written into settings.json was accepted as this row\'s value');
  assert.ok(resolved.rejected.some(item => item.id === 'model.api_key'),
    'a key written into settings.json was dropped silently');
});
