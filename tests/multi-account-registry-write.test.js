/* EXECUTABLE CHANGE
 *
 * ASSERTION AUDIT (testcanfail-tests-multi-account-registry-write-test-js)
 * Strengthened: the crash-child check. Mutation: registry-write.js threw
 * `MUTATION: crash path failed before durable write` for the child's
 * `interrupted` add before persist(). Before this change that check still said
 * `ok - a process killed between the temp write and the rename leaves the good registry`:
 * absence of the writer's own `SURVIVED` output did not distinguish the intended
 * SIGKILL from an ordinary exception. With the strengthened assertion, the same
 * mutation produced RED:
 *
 *   not ok - a process killed between the temp write and the rename leaves the good registry
 *     the crash child exited normally instead of being force-killed
 *     + actual - expected
 *     + null
 *     - 'SIGKILL'
 *
 * The mutation was restored byte-for-byte (sha256sum -c reported
 * `src/lib/multi-account/registry-write.js: OK`). The restored-file run makes
 * this check green:
 *
 *   ok - a process killed between the temp write and the rename leaves the good registry
 *
 * During that historical assertion audit, the complete suite was blocked by
 * services rotation not selecting the account written to the installed registry:
 * `the services-root caller did not see the written account` (actual null,
 * expected 'cloud-a'). That receipt describes the audited inputs; it is not the
 * current suite status. Run this suite through run-isolated for current proof.
 *
 * NOT-FOUND (1): no assertion is guarded only by an input collection that may
 * be empty. The two assertion loops use non-empty literals; the runner iterates
 * the non-empty `pending` list populated in this file.
 * NOT-FOUND (2), besides the fixed crash-child assertion: both child exit-status
 * assertions are followed by parsing and exact assertions on subject output.
 * NOT-FOUND (3): no try/catch or optional chain swallows a tested failure.
 * `refusalOf` returns caught errors for exact assertions; cleanup catches are
 * outside the behavior under test.
 * NOT-FOUND (4): no assertion measures a mock of addAccount. Injected filesystem
 * and reader/probe functions observe boundaries or isolate unrelated services.
 * NOT-FOUND (5): there are no skips or platform precondition guards.
 * NOT-FOUND (6): expected values are literal fixture values or independently
 * constructed paths, not results computed by the subject implementation.
 */
'use strict';
/* ADDING AN ACCOUNT, WHICH IS THE STEP THAT USED TO BE "OPEN AN EDITOR".
 *
 * WHAT THIS FILE IS FOR. src/lib/multi-account/registry.js reads a registry and
 * refuses when there is not one; nothing under that directory ever wrote one. So
 * on a customer's machine the product's own answer to "how do I add an account"
 * was a filename and the words "Create it before switching accounts". Every
 * assertion below is about the WRITE that ends that state, and each one fails
 * against the tree as it was, where addAccount() does not exist.
 *
 * NO REAL HOME AND NO REAL REGISTRY IS TOUCHED. Every path below is inside a
 * temporary directory this file creates and removes. The live registry -- which
 * has running cloud tasks against it -- is never opened, and the real
 * codex-homes are never named.
 *
 * NO CREDENTIAL IS CREATED, READ OR WRITTEN. The only thing addAccount() puts on
 * disk besides the registry is an EMPTY directory. Where a test needs to prove
 * that a directory is a distinct home, it writes a few bytes of its own into a
 * file it names itself -- never a real auth.json, and never anything read back.
 *
 * TWO OF THE PROPERTIES CANNOT BE PROVEN IN THIS PROCESS AND ARE PROVEN IN A
 * CHILD, which is stated here so a reader does not mistake the machinery for
 * ceremony:
 *
 *   - "the write survives a crash mid-write" is proven by FORCE-KILLING a
 *     process between the temp write and the rename. A mocked failure would
 *     prove the catch block, not the durability; src/lib/durable-memory-file.js,
 *     whose persist() this write follows, says in its own comment that its
 *     durability is proven by force-killing between launches. So is this.
 *   - "the home lands under the per-user state root" is about the DEFAULT path,
 *     and that default is resolved once when the module is loaded. Asserting it
 *     needs a process whose state root was set before the require.
 *
 *   node tests/run-isolated.js tests/multi-account-registry-write.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const { addAccount, removeAccount } = require('../src/lib/multi-account/registry-write.js');
const { loadRegistry, providerSpec, signInFilePath } = require('../src/lib/multi-account/registry.js');
const { accountRegistryPath } = require('../src/lib/multi-account/registry-location.js');

const WRITER_SOURCE = path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'registry-write.js');
const PROGRAM_ROOT = path.resolve(__dirname, '..');

const pending = [];
let failures = 0;
function check(name, run) { pending.push([name, run]); }

function scratch() {
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'accounts-write-'));
  return {
    root,
    registry: path.join(root, 'config', 'accounts.json'),
    homes: path.join(root, 'codex-homes'),
    remove() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
}

function withScratch(run) {
  const area = scratch();
  try { return run(area); } finally { area.remove(); }
}

function add(area, name, extra = {}) {
  return addAccount({ name, configPath: area.registry, homesRoot: area.homes, ...extra });
}

function readRegistry(area) {
  return JSON.parse(fs.readFileSync(area.registry, 'utf8'));
}

function refusalOf(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) { resolve(); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() >= deadline) { reject(new Error('timed out waiting for concurrent account writers')); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function childCompletion(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

/* --- 1. A registry that is not there is CREATED, not refused. ------------- */

check('the registry is created when it is absent', () => {
  withScratch(area => {
    assert.equal(fs.existsSync(area.registry), false, 'the fixture started with a registry');
    const record = add(area, 'cloud-a');
    assert.equal(record.name, 'cloud-a');
    assert.equal(record.provider, 'codex');
    assert.equal(fs.existsSync(area.registry), true, 'nothing wrote the registry');
    /* And what was written is a registry the READERS accept -- the one thing a
       writer that only its own tests read could get wrong forever. */
    const loaded = loadRegistry({ configPath: area.registry });
    assert.equal(loaded.accounts.length, 1);
    assert.equal(loaded.accounts[0].name, 'cloud-a');
    assert.equal(loaded.accounts[0].home, record.home);
  });
});

check('the directory the entry names is created, and it is empty', () => {
  withScratch(area => {
    const record = add(area, 'cloud-a');
    assert.equal(fs.statSync(record.home).isDirectory(), true, 'the home was not created');
    assert.deepEqual(fs.readdirSync(record.home), [], 'something was put inside the new home');
    /* The person never types this. It is derived from the name they did type. */
    assert.equal(path.basename(record.home), 'cloud-a');
    assert.equal(path.dirname(record.home), area.homes);
  });
});

/* --- 2. A second account never costs the first one. ---------------------- */

check('adding a second account preserves the first, and everything around it', () => {
  withScratch(area => {
    fs.mkdirSync(path.dirname(area.registry), { recursive: true });
    fs.writeFileSync(area.registry, `${JSON.stringify({
      $comment: ['a note the person wrote'],
      exhaustedAtPercent: 80,
      accounts: [{
        name: 'first', provider: 'codex', profileDir: path.join(area.homes, 'first'),
        priority: 1, role: 'primary', expectEmail: 'someone@example.test'
      }]
    }, null, 2)}\n`);

    add(area, 'second');

    const after = readRegistry(area);
    assert.equal(after.accounts.length, 2);
    /* THE FIRST ENTRY, FIELD FOR FIELD. `role` and `expectEmail` are not fields
       the writer understands, and an add that dropped them would silently
       unbind an account from the identity it was pinned to. */
    assert.deepEqual(after.accounts[0], {
      name: 'first', provider: 'codex', profileDir: path.join(area.homes, 'first'),
      priority: 1, role: 'primary', expectEmail: 'someone@example.test'
    });
    /* And what was around the list, too. */
    assert.deepEqual(after.$comment, ['a note the person wrote']);
    assert.equal(after.exhaustedAtPercent, 80);
    assert.equal(after.accounts[1].name, 'second');
    assert.equal(after.accounts[1].priority, 2, 'the new entry took a priority already in use');
  });
});

check('a third account is appended, and the two before it keep their homes', () => {
  withScratch(area => {
    const one = add(area, 'one');
    const two = add(area, 'two');
    const three = add(area, 'three');
    const loaded = loadRegistry({ configPath: area.registry });
    assert.deepEqual(loaded.accounts.map(account => account.name), ['one', 'two', 'three']);
    assert.deepEqual(loaded.accounts.map(account => account.home), [one.home, two.home, three.home]);
    assert.equal(new Set(loaded.accounts.map(account => account.home)).size, 3,
      'two accounts were given one home, which is the sign-in overwrite this registry exists to refuse');
  });
});

check('concurrent process adds preserve every registration and assign distinct priorities', async () => {
  const area = scratch();
  const children = [];
  try {
    const readyFile = path.join(area.root, 'ready.txt');
    const goFile = path.join(area.root, 'go');
    const helper = path.join(area.root, 'add-child.cjs');
    fs.writeFileSync(helper, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const [writerPath, configPath, homesRoot, readyFile, goFile, name] = process.argv.slice(2);",
      "const { addAccount } = require(writerPath);",
      "fs.appendFileSync(readyFile, name + '\\n');",
      "(async () => {",
      "  while (!fs.existsSync(goFile)) await new Promise(resolve => setTimeout(resolve, 5));",
      "  process.stdout.write(JSON.stringify(addAccount({ name, configPath, homesRoot })));",
      "})().catch(error => { console.error(error && error.stack || error); process.exit(1); });",
      ''
    ].join('\n'), 'utf8');

    const count = 12;
    const completions = [];
    for (let index = 0; index < count; index += 1) {
      const child = spawn(process.execPath, [
        helper, WRITER_SOURCE, area.registry, area.homes, readyFile, goFile, `account-${index}`
      ], { cwd: area.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      completions.push(childCompletion(child));
    }
    await waitUntil(() => fs.existsSync(readyFile)
      && fs.readFileSync(readyFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length === count);
    fs.writeFileSync(goFile, 'go', 'utf8');
    const results = await Promise.all(completions);
    for (const result of results) {
      assert.equal(result.code, 0, `a concurrent account add failed: ${result.stderr}`);
    }
    const loaded = loadRegistry({ configPath: area.registry });
    assert.equal(loaded.accounts.length, count);
    assert.deepEqual(new Set(loaded.accounts.map(account => account.name)),
      new Set(Array.from({ length: count }, (_, index) => `account-${index}`)));
    assert.deepEqual(loaded.accounts.map(account => account.priority),
      Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(fs.existsSync(`${area.registry}.lock`), false);
  } finally {
    for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
    area.remove();
  }
});

check('concurrent process add and remove preserve both registry mutations', async () => {
  const area = scratch();
  const children = [];
  try {
    add(area, 'keep');
    const removed = add(area, 'remove-me');
    fs.writeFileSync(path.join(removed.home, 'sign-in-fixture.txt'), 'must-survive', 'utf8');

    const readyFile = path.join(area.root, 'mutation-ready.txt');
    const goFile = path.join(area.root, 'mutation-go');
    const helper = path.join(area.root, 'mutate-child.cjs');
    fs.writeFileSync(helper, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const [writerPath, configPath, homesRoot, readyFile, goFile, action, name] = process.argv.slice(2);",
      "const { addAccount, removeAccount } = require(writerPath);",
      "fs.appendFileSync(readyFile, action + '\\n');",
      "(async () => {",
      "  while (!fs.existsSync(goFile)) await new Promise(resolve => setTimeout(resolve, 5));",
      "  const result = action === 'add'",
      "    ? addAccount({ name, configPath, homesRoot })",
      "    : removeAccount({ name, configPath });",
      "  process.stdout.write(JSON.stringify(result));",
      "})().catch(error => { console.error(error && error.stack || error); process.exit(1); });",
      ''
    ].join('\n'), 'utf8');

    const completions = [];
    for (const [action, name] of [['add', 'new-one'], ['remove', 'remove-me']]) {
      const child = spawn(process.execPath, [
        helper, WRITER_SOURCE, area.registry, area.homes, readyFile, goFile, action, name
      ], { cwd: area.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      completions.push(childCompletion(child));
    }
    await waitUntil(() => fs.existsSync(readyFile)
      && fs.readFileSync(readyFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length === 2);
    fs.writeFileSync(goFile, 'go', 'utf8');
    const results = await Promise.all(completions);
    for (const result of results) {
      assert.equal(result.code, 0, `a concurrent account mutation failed: ${result.stderr}`);
    }

    const loaded = loadRegistry({ configPath: area.registry });
    assert.deepEqual(loaded.accounts.map(account => account.name), ['keep', 'new-one']);
    assert.equal(new Set(loaded.accounts.map(account => account.priority)).size, 2);
    assert.equal(fs.readFileSync(path.join(removed.home, 'sign-in-fixture.txt'), 'utf8'), 'must-survive');
    assert.equal(fs.existsSync(`${area.registry}.lock`), false);
  } finally {
    for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
    area.remove();
  }
});

/* --- 3. Duplicates are refused, with the REGISTRY'S OWN codes. ----------- */

check('a duplicate name is refused with the registry\'s own code, and changes nothing', () => {
  withScratch(area => {
    add(area, 'cloud-a');
    const before = fs.readFileSync(area.registry);
    const error = refusalOf(() => add(area, 'cloud-a'));
    assert.ok(error, 'a duplicate name was accepted');
    assert.equal(error.code, 'ACCOUNTS_NAME_DUPLICATE');
    assert.deepEqual(fs.readFileSync(area.registry), before, 'a refused add still rewrote the registry');
  });
});

check('the duplicate check does not care about letter case', () => {
  withScratch(area => {
    add(area, 'cloud-a');
    assert.equal(refusalOf(() => add(area, 'CLOUD-A')).code, 'ACCOUNTS_NAME_DUPLICATE');
  });
});

check('a directory already in use is refused with the registry\'s own code', () => {
  withScratch(area => {
    /* An entry that names the SAME directory under a different name -- which is
       what a hand-edited registry, or a second add after a rename, produces. It
       is written relative here on purpose: comparing the declared TEXT would
       miss it, and two Codex homes in one directory overwrite each other's
       sign-in. */
    fs.mkdirSync(path.dirname(area.registry), { recursive: true });
    fs.writeFileSync(area.registry, `${JSON.stringify({
      accounts: [{ name: 'other', provider: 'codex', profileDir: 'homes/cloud-a', priority: 1 }]
    }, null, 2)}\n`);
    const error = refusalOf(() => add(area, 'cloud-a', {
      homesRoot: path.join(area.root, 'homes'),
      homeDir: area.root
    }));
    assert.ok(error, 'two codex accounts were allowed to share one home');
    assert.equal(error.code, 'ACCOUNTS_PROFILE_DIR_SHARED');
  });
});

check('a registry that cannot be read is never written over', () => {
  withScratch(area => {
    fs.mkdirSync(path.dirname(area.registry), { recursive: true });
    fs.writeFileSync(area.registry, '{ this is not json');
    const error = refusalOf(() => add(area, 'cloud-a'));
    assert.equal(error.code, 'ACCOUNTS_REGISTRY_UNPARSABLE');
    assert.equal(fs.readFileSync(area.registry, 'utf8'), '{ this is not json',
      'a damaged registry was replaced instead of refused');
  });
});

check('a registry with no accounts array is refused rather than treated as empty', () => {
  withScratch(area => {
    fs.mkdirSync(path.dirname(area.registry), { recursive: true });
    fs.writeFileSync(area.registry, '{"$comment":"accounts could not be established"}\n');
    const before = fs.readFileSync(area.registry);
    const error = refusalOf(() => add(area, 'cloud-a'));
    assert.equal(error.code, 'ACCOUNTS_REGISTRY_INVALID');
    assert.deepEqual(fs.readFileSync(area.registry), before,
      'a registry with an unknown account set was replaced as though it were empty');
  });
});

check('an unresolvable existing directory is refused rather than treated as no collision', () => {
  withScratch(area => {
    fs.mkdirSync(path.dirname(area.registry), { recursive: true });
    fs.writeFileSync(area.registry, `${JSON.stringify({
      accounts: [{ name: 'other', provider: 'codex', profileDir: 'relative/other', priority: 1 }]
    }, null, 2)}\n`);
    const before = fs.readFileSync(area.registry);
    const error = refusalOf(() => add(area, 'cloud-a', { homeDir: '' }));
    assert.equal(error.code, 'ACCOUNTS_HOME_DIR_UNKNOWN');
    assert.deepEqual(fs.readFileSync(area.registry), before,
      'an unresolved existing directory was treated as proof that no collision existed');
  });
});

check('a name that cannot be a directory is refused before anything is created', () => {
  withScratch(area => {
    for (const bad of ['', '   ', '../escape', 'has/slash', 'has\\slash', 'aux', 'trailing.', 'x'.repeat(65)]) {
      const error = refusalOf(() => add(area, bad));
      assert.ok(error, `"${bad}" was accepted as an account name`);
      assert.equal(error.code, 'ACCOUNTS_ENTRY_INVALID', `"${bad}" was refused as ${error.code}`);
    }
    assert.equal(fs.existsSync(area.registry), false, 'a refused name still created a registry');
    assert.equal(fs.existsSync(area.homes), false, 'a refused name still created a directory');
    /* A name with space around it is TRIMMED rather than refused -- somebody
       pasting a name should not be told off for the paste -- and the trimmed
       name is what is recorded AND what names the directory, so the two can
       never be two different strings. */
    const record = add(area, '  spaced  ');
    assert.equal(record.name, 'spaced');
    assert.equal(path.basename(record.home), 'spaced');
  });
});

/* --- 4. Crash safety, proven by killing a process mid-write. ------------- */

const CRASH_CHILD = `'use strict';
const fs = require('node:fs');
const [, , writerPath, configPath, homesRoot] = process.argv;
const { addAccount } = require(writerPath);
/* THE KILL LANDS BETWEEN THE TEMP WRITE AND THE RENAME, which is the only
   window in which a registry could be replaced by half a file. fsyncSync is
   the last call before the rename, so this is that instant exactly. */
const fsImpl = Object.create(fs);
fsImpl.fsyncSync = () => { process.kill(process.pid, 'SIGKILL'); };
addAccount({ name: 'interrupted', configPath, homesRoot, fsImpl });
process.stdout.write('SURVIVED');
`;

check('a process killed between the temp write and the rename leaves the good registry', () => {
  withScratch(area => {
    add(area, 'cloud-a');
    add(area, 'cloud-b');
    const before = fs.readFileSync(area.registry);

    const child = path.join(area.root, 'crash-child.cjs');
    fs.writeFileSync(child, CRASH_CHILD);
    const result = spawnSync(process.execPath, [child, WRITER_SOURCE, area.registry, area.homes], {
      encoding: 'utf8', timeout: 60_000
    });
    assert.notEqual(result.stdout, 'SURVIVED', 'the child was not actually killed mid-write');
    /* FORCE-KILLED, by the evidence each platform gives. POSIX: signal==='SIGKILL',
       status===null. WINDOWS has no SIGKILL -- process.kill(pid,'SIGKILL') maps to
       TerminateProcess and spawnSync reports signal===null with a non-zero status.
       Same fact: terminated, did not exit on its own. The registry-integrity
       assertions below prove the write was interrupted; the POSIX signal name alone
       (the wave-29 strengthening) fails on the machine that cuts. */
    const forceKilled = result.signal === 'SIGKILL'
      || (process.platform === 'win32' && result.signal === null && result.status !== 0);
    assert.ok(forceKilled,
      `the crash child exited normally instead of being force-killed (signal=${result.signal} status=${result.status})`);

    /* THE REGISTRY IS BYTE-IDENTICAL. Not "still parses" and not "still has two
       accounts": a half-written file that happened to parse would pass both. */
    assert.deepEqual(fs.readFileSync(area.registry), before,
      'a crash mid-write changed the registry');
    const loaded = loadRegistry({ configPath: area.registry });
    assert.deepEqual(loaded.accounts.map(account => account.name), ['cloud-a', 'cloud-b']);

    /* AND THE NEXT ADD STILL WORKS. A temp file left behind by the crash must
       not be a file the next writer collides with -- the temp name carries a
       uuid for exactly this reason. */
    add(area, 'cloud-c');
    assert.deepEqual(
      loadRegistry({ configPath: area.registry }).accounts.map(account => account.name),
      ['cloud-a', 'cloud-b', 'cloud-c']
    );
  });
});

check('the temp file is written beside the registry and renamed onto it', () => {
  withScratch(area => {
    const seen = [];
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => { seen.push([from, to]); return fs.renameSync(from, to); };
    add(area, 'cloud-a', { fsImpl });
    assert.equal(seen.length, 1, 'the registry was not written through a rename');
    const [from, to] = seen[0];
    assert.equal(to, area.registry);
    assert.equal(path.dirname(from), path.dirname(area.registry),
      'the temp file was staged on a different volume, where a rename is not atomic');
    assert.deepEqual(fs.readdirSync(path.dirname(area.registry)), ['accounts.json'],
      'a temp file was left behind');
  });
});

/* --- 5. The home is under the per-user state root, never the install. ---- */

const STATE_ROOT_CHILD = `'use strict';
const path = require('node:path');
const { accountHomesRoot, accountRegistryPath } = require(process.argv[2]);
process.stdout.write(JSON.stringify({
  homes: accountHomesRoot('codex'),
  registry: accountRegistryPath()
}));
`;

check('the default home and registry are under the per-user state root, not the program root', () => {
  withScratch(area => {
    const stateRoot = path.join(area.root, 'state-root');
    const child = path.join(area.root, 'state-root-child.cjs');
    fs.writeFileSync(child, STATE_ROOT_CHILD);
    const locationModule = path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'registry-location.js');
    const result = spawnSync(process.execPath, [child, locationModule], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot }
    });
    assert.equal(result.status, 0, `the child refused: ${result.stderr}`);
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.homes, path.join(stateRoot, 'codex-homes'));
    assert.equal(answer.registry, path.join(stateRoot, 'config', 'accounts.json'));
    /* THE POINT OF THE WHOLE ASSERTION. The install directory is required to
       stay byte-unchanged and is replaced by the next update; a sign-in written
       into it is lost on a routine upgrade. */
    assert.ok(!answer.homes.toLowerCase().startsWith(PROGRAM_ROOT.toLowerCase()),
      `the home landed inside the program directory: ${answer.homes}`);
    assert.ok(!answer.registry.toLowerCase().startsWith(PROGRAM_ROOT.toLowerCase()),
      `the registry landed inside the program directory: ${answer.registry}`);
  });
});

check('the installed per-user registry wins when a program registry also exists', () => {
  withScratch(area => {
    const stateRoot = path.join(area.root, 'installed-identity', 'capability');
    const programRoot = path.join(area.root, 'program');
    const userRegistry = path.join(stateRoot, 'config', 'accounts.json');
    const programRegistry = path.join(programRoot, 'config', 'accounts.json');
    for (const [file, name] of [[userRegistry, 'person'], [programRegistry, 'program-copy']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        accounts: [{ name, provider: 'codex', profileDir: path.join(area.homes, name), priority: 1 }]
      }));
    }

    const selected = accountRegistryPath({
      environment: { TOOLSENABLED_STATE_ROOT: stateRoot },
      programRoot,
      fsImpl: fs
    });
    assert.equal(selected, userRegistry);
    assert.equal(loadRegistry({ configPath: selected }).accounts[0].name, 'person');
  });
});

const AGREEMENT_CHILD = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const location = require(process.argv[2]);
const { addAccount } = require(process.argv[3]);
const rotation = require(process.argv[4]);
const status = require(process.argv[5]);
const cloud = require(process.argv[6]);
const { loadRegistry } = require(process.argv[7]);

(async () => {
  const servicesRoot = process.argv[8];
  fs.mkdirSync(servicesRoot, { recursive: true });
  const canonical = location.accountRegistryPath();
  const added = addAccount({ name: 'cloud-a' });
  let coordinatorPath = null;
  const quota = await status.readDefaultCodexQuota({ environment: process.env }, {
    accountRegistryPathImpl: location.accountRegistryPath,
    readAccountUsageImpl: options => {
      coordinatorPath = options.registryPath;
      return rotation.readAccountUsage({ ...options,
        probeFor: () => async account => ({
          account: account.name, status: 'transient', canServe: false,
          usedPercent: null, resetsAt: null, planType: null
        })
      });
    }
  });
  // This agreement fixture proves that rotation reads the same registry the
  // writer just created. It does not provision a real Codex home: an empty
  // freshly registered directory is correctly not selectable in production.
  // Inject the documented healthy probe so the assertion measures registry
  // location rather than pretending this synthetic account is signed in.
  const selected = await rotation.resolveAccountForSession({
    servicesRoot,
    probe: async account => ({
      account: account.name, status: 'healthy', canServe: true,
      usedPercent: 1, resetsAt: null, planType: 'pro', reason: null
    })
  });
  let panelPath = null;
  const panel = await cloud.listCloudAccounts({}, {
    loadRegistryImpl: options => { panelPath = options.configPath; return loadRegistry(options); },
    probeImpl: async account => ({
      account: account.name, status: 'healthy', canServe: true,
      usedPercent: 1, resetsAt: null, planType: 'pro', reason: null
    }),
    discoverEnvironmentsImpl: async () => ({
      environments: Object.freeze([]),
      accounts: Object.freeze([{ account: 'cloud-a', reading: 'complete', reason: null }]),
      complete: true,
      readAt: '2026-08-24T00:00:00.000Z'
    })
  });
  process.stdout.write(JSON.stringify({
    canonical,
    writerPath: added.registryPath,
    coordinatorPath,
    coordinatorCount: quota.accountCount,
    panelPath,
    panelCount: panel.accounts.length,
    rotationAccount: selected.account && selected.account.name,
    staleServicesPath: path.join(servicesRoot, 'accounts.json'),
    staleServicesExists: fs.existsSync(path.join(servicesRoot, 'accounts.json'))
  }));
})().catch(error => { console.error(error); process.exit(1); });
`;

check('source coordinator, services rotation, account panel, and writer use one installed registry', () => {
  withScratch(area => {
    const stateRoot = path.join(area.root, 'installed-identity', 'capability');
    const servicesRoot = path.join(area.root, 'services-root');
    const child = path.join(area.root, 'registry-agreement-child.cjs');
    fs.writeFileSync(child, AGREEMENT_CHILD);
    const args = [
      child,
      path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'registry-location.js'),
      path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'registry-write.js'),
      path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'rotation.js'),
      path.join(__dirname, '..', 'src', 'lib', 'status-injection.js'),
      path.join(__dirname, '..', 'src', 'lib', 'cloud-agent', 'codex-cloud-launch.js'),
      path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'registry.js'),
      servicesRoot
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot }
    });
    assert.equal(result.status, 0, `the agreement child refused: ${result.stderr}`);
    const answer = JSON.parse(result.stdout);
    const expected = path.join(stateRoot, 'config', 'accounts.json');
    assert.equal(answer.canonical, expected);
    assert.equal(answer.writerPath, expected, 'the real writer used a different registry');
    assert.equal(answer.coordinatorPath, expected, 'the source coordinator used a different registry');
    assert.equal(answer.panelPath, expected, 'the account panel used a different registry');
    assert.equal(answer.coordinatorCount, 1, 'the coordinator did not see the written account');
    assert.equal(answer.panelCount, 1, 'the panel did not see the written account');
    assert.equal(answer.rotationAccount, 'cloud-a', 'the services-root caller did not see the written account');
    assert.equal(answer.staleServicesExists, false,
      `the services-root registry was recreated at ${answer.staleServicesPath}`);
  });
});

/* --- 6. Nothing here can carry a credential. ----------------------------- */

check('the writer contains no call that could open a sign-in', () => {
  const source = fs.readFileSync(WRITER_SOURCE, 'utf8');
  /* Each of these is a way to end up holding the CONTENTS of a file in a
     directory that exists to hold somebody's sign-in. The writer needs exactly
     one read -- the registry's own JSON -- and it is readFileSync; everything
     else is an absence, asserted here because an absence has no other test. */
  for (const forbidden of ['createReadStream', 'readdirSync', 'auth.json', '.credentials.json', 'spawn', 'exec(']) {
    assert.ok(!source.includes(forbidden),
      `registry-write.js contains ${forbidden}; it writes a list of names and directories and must never touch a sign-in.`);
  }
});

check('nothing the writer returns or throws carries a credential-shaped value', () => {
  withScratch(area => {
    const record = add(area, 'cloud-a');
    /* A real sign-in lives in the directory this call created. It is written
       here by this test, and the assertion is that nothing the writer produced
       ever contains it. */
    fs.writeFileSync(path.join(record.home, 'auth.json'), JSON.stringify({ token: 'sk-not-a-real-secret-000' }));
    const refusal = refusalOf(() => add(area, 'cloud-a'));
    const everything = JSON.stringify({ record, message: refusal.message, details: refusal.details });
    assert.ok(!/sk-|Bearer |eyJ[A-Za-z0-9_-]{6}/.test(everything), everything);
    assert.ok(!everything.includes('not-a-real-secret'), everything);
  });
});

/* --- THE OPTIONAL EXPECTED SIGN-IN. -------------------------------------
 *
 * WHAT THIS GUARDS. Nothing on the add path could record which account an entry
 * is FOR. Pressing Sign in beside a row opens the program's own browser window
 * and whichever account that browser is holding is the one signed in -- the
 * product never sees the choice. health.js has compared `expectEmail` on the
 * Codex leg since config/codex.json was written, and rotation.js's
 * claudeIdentityFault now compares it on the Claude leg, but neither had
 * anything to compare unless a person hand-edited the JSON.
 *
 * The three cases the writer has to get right are: recorded (and readable back
 * by the READERS' own parser, which is what makes the probe able to use it),
 * not recorded (the field is absent, not null -- every registry on disk today),
 * and unusable (refused by name, never dropped, because a person who typed an
 * address believes the check is on). */
check('an added account can record the sign-in it expects, and says so back', () => {
  withScratch(area => {
    const record = addAccount({
      name: 'work', provider: 'claude', expectEmail: '  Work@Example.Test ',
      configPath: area.registry, homesRoot: area.homes
    });
    assert.equal(record.expectEmail, 'work@example.test', 'the receipt did not say the check was recorded');
    /* Read back through the READERS' parser, because that is the only reading
       the probe ever sees. Stored lower-cased and trimmed, which is the form
       the probe compares against. */
    const loaded = loadRegistry({ configPath: area.registry });
    assert.equal(loaded.accounts[0].expectEmail, 'work@example.test');
  });
});

check('an account added without an expected sign-in promises nothing and carries no field', () => {
  withScratch(area => {
    for (const [label, extra] of [['omitted', {}], ['null', { expectEmail: null }], ['blank', { expectEmail: '   ' }]]) {
      const area2 = scratch();
      try {
        const record = addAccount({
          name: 'work', provider: 'claude', configPath: area2.registry, homesRoot: area2.homes, ...extra
        });
        assert.equal(record.expectEmail, null, `${label} was reported as a recorded check`);
        const written = JSON.parse(fs.readFileSync(area2.registry, 'utf8'));
        assert.equal(Object.hasOwn(written.accounts[0], 'expectEmail'), false,
          `${label} wrote an expectEmail field, which reads as a check somebody switched off`);
        assert.equal(loadRegistry({ configPath: area2.registry }).accounts[0].expectEmail, null);
      } finally { area2.remove(); }
    }
    assert.equal(fs.existsSync(area.registry), false, 'the outer fixture was written to');
  });
});

check('an expected sign-in that is not an address is refused by name, never dropped', () => {
  withScratch(area => {
    for (const bad of ['work', '@example.test', 'work@', 'a@b@c', 'wo rk@example.test', `${'a'.repeat(250)}@example.test`, 42]) {
      const refusal = refusalOf(() => addAccount({
        name: 'work', provider: 'claude', expectEmail: bad,
        configPath: area.registry, homesRoot: area.homes
      }));
      assert.ok(refusal, `"${bad}" was accepted as an expected sign-in`);
      assert.equal(refusal.code, 'ACCOUNTS_ENTRY_INVALID');
      assert.ok(refusal.message.length > 20, 'the refusal does not say what is wrong');
      assert.equal(fs.existsSync(area.registry), false,
        `"${bad}" was refused but the entry was written anyway`);
    }
  });
});

/* AND IT IS REFUSED FOR THE ONE PROGRAM WHOSE PROBE READS NO IDENTITY. Gemini
   is a file-presence check -- health.js's probeSignInPresence answers `email`
   null by construction -- so recording an expected address against a Gemini
   entry would promise a comparison that nothing anywhere performs. Silently
   storing it is the "silent skip" this codebase keeps re-finding. */
check('a program whose probe reads no identity cannot record an expected sign-in', () => {
  withScratch(area => {
    const refusal = refusalOf(() => addAccount({
      name: 'work', provider: 'gemini', expectEmail: 'work@example.test',
      configPath: area.registry, homesRoot: area.homes
    }));
    assert.ok(refusal, 'a Gemini entry recorded a check nothing performs');
    assert.equal(refusal.code, 'ACCOUNTS_ENTRY_INVALID');
    assert.match(refusal.message, /gemini/i, 'the refusal does not name the program it is about');
    // And the same account without one is added exactly as it always was.
    const record = addAccount({
      name: 'work', provider: 'gemini', configPath: area.registry, homesRoot: area.homes
    });
    assert.equal(record.provider, 'gemini');
    assert.equal(record.expectEmail, null);
  });
});


/* --- A28. Registration origin is a safety boundary. --------------------- */
/*
 * This A28 block uses only retained fixtures. It deliberately does not use
 * scratch() or run-isolated.js: those helpers remove their roots. Every
 * fs.unlinkSync/rmdirSync/rmSync request made by the writer or its
 * process-claim-lock is renamed into a named archive, and the original path is
 * asserted absent only for the deliberate app-created credential case.
 */
const A28_FIXTURE_ROOT = process.env.A28_FIXTURE_ROOT
  || path.join(isolatedTemporaryRoot(), 'a28-registration-origin-');

  function a28Fixture(label) {
    fs.mkdirSync(A28_FIXTURE_ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(A28_FIXTURE_ROOT, label + '-'));
  }

  function a28CredentialPath(home, provider) {
    return signInFilePath(home, providerSpec(provider));
  }

  function a28WriteCredential(home, provider) {
    const credentialPath = a28CredentialPath(home, provider);
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, 'retained-test-fixture-bytes', 'utf8');
    return credentialPath;
  }

  function a28WriteRegistry(configPath, entry) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ accounts: [entry] }, null, 2) + '\n', 'utf8');
  }

  function a28RetainDeletes(root, run) {
    const native = {
      unlinkSync: fs.unlinkSync,
      rmdirSync: fs.rmdirSync,
      rmSync: fs.rmSync,
      renameSync: fs.renameSync,
      mkdirSync: fs.mkdirSync,
      readdirSync: fs.readdirSync
    };
    const attempts = [];
    const allowedRoot = path.resolve(root);
    let sequence = 0;
    const retain = requested => {
      const source = path.resolve(String(requested));
      const relative = path.relative(allowedRoot, source);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('retention refused a deletion sink outside its fixture root');
      }
      const destination = path.join(root, 'retained-deletions',
        String(++sequence).padStart(4, '0') + '-' + path.basename(source));
      attempts.push({ requested: source, destination });
      native.mkdirSync(path.dirname(destination), { recursive: true });
      native.renameSync(source, destination);
    };
    fs.unlinkSync = retain;
    fs.rmdirSync = requested => {
      if (native.readdirSync(requested).length > 0) {
        const error = new Error('retention keeps non-empty directories in place');
        error.code = 'ENOTEMPTY';
        throw error;
      }
      return retain(requested);
    };
    fs.rmSync = retain;
    try {
      return run(attempts);
    } finally {
      fs.unlinkSync = native.unlinkSync;
      fs.rmdirSync = native.rmdirSync;
      fs.rmSync = native.rmSync;
    }
  }

  function a28AssertLockRetention(attempts) {
    assert.ok(attempts.some(({ requested }) => requested.includes('.claims')),
      'process-claim-lock deletion was not routed through the retention seam');
  }

  function a28AssertCredentialRetained(attempts, credentialPath) {
    const archived = attempts.filter(({ requested }) => requested === credentialPath);
    assert.equal(archived.length, 1, 'the deliberate credential disposition did not name one sink request');
    assert.equal(fs.existsSync(credentialPath), false,
      'the deliberately destroyable credential still exists at its original path');
    assert.equal(fs.existsSync(archived[0].destination), true,
      'the deliberate credential was not retained in the named archive');
    assert.equal(fs.readFileSync(archived[0].destination, 'utf8'), 'retained-test-fixture-bytes',
      'the retained credential bytes changed');
  }

  function a28AssertCredentialPreserved(attempts, credentialPath) {
    assert.equal(fs.existsSync(credentialPath), true,
      'a credential under an external or native home was removed');
    assert.equal(attempts.some(({ requested }) => requested === credentialPath), false,
      'a preserved credential was sent to a deletion sink');
  }

  check('A28 app-created homes deliberately destroy credentials for every provider', () => {
    for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
      const root = a28Fixture('created-' + provider);
      const configPath = path.join(root, 'config', 'accounts.json');
      const homesRoot = path.join(root, 'homes');
      a28RetainDeletes(root, attempts => {
        const added = addAccount({
          name: 'fixture-' + provider,
          provider,
          configPath,
          homesRoot
        });
        assert.equal(added.homeCreatedByApp, true,
          provider + ' did not report its newly created home');
        const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(written.accounts[0].homeCreatedByApp, true,
          provider + ' did not persist its creation origin');
        const credentialPath = a28WriteCredential(added.home, provider);
        const removed = removeAccount({ name: added.name, provider, configPath });
        assert.equal(removed.homePreserved, true, provider + ' home was not preserved');
        assert.equal(removed.credentialDestroyed, true,
          provider + ' app-created credential was not deliberately destroyed');
        assert.equal(fs.existsSync(added.home), true, provider + ' home was removed');
        a28AssertCredentialRetained(attempts, credentialPath);
        a28AssertLockRetention(attempts);
      });
    }

    const errorRoot = a28Fixture('created-error-path');
    const errorConfig = path.join(errorRoot, 'config', 'accounts.json');
    const errorHomes = path.join(errorRoot, 'homes');
    a28RetainDeletes(errorRoot, attempts => {
      const added = addAccount({
        name: 'fixture-error-path', provider: 'codex',
        configPath: errorConfig, homesRoot: errorHomes
      });
      const credentialPath = a28WriteCredential(added.home, 'codex');
      const errorFs = Object.create(fs);
      errorFs.unlinkSync = requested => {
        if (path.resolve(String(requested)) === path.resolve(credentialPath)) {
          const error = new Error('retained fixture refuses credential removal');
          error.code = 'EACCES';
          throw error;
        }
        return fs.unlinkSync(requested);
      };
      const refusal = refusalOf(() => removeAccount({
        name: added.name, provider: 'codex', configPath: errorConfig, fsImpl: errorFs
      }));
      assert.equal(refusal && refusal.code, 'ACCOUNTS_CREDENTIAL_NOT_REMOVED',
        'an app-created credential failure did not refuse by name');
      assert.equal(fs.existsSync(errorConfig), true,
        'a failed app-created credential removal dropped the registration');
      assert.equal(fs.existsSync(credentialPath), true,
        'a failed app-created credential removal lost the original bytes');
      assert.equal(attempts.some(({ requested }) => requested === errorConfig), false,
        'a failed app-created credential removal removed the registry');
      a28AssertLockRetention(attempts);
    });
  });

  check('A28 existing and race-created homes record false and preserve credentials for every provider', () => {
    for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
      const root = a28Fixture('existing-' + provider);
      const configPath = path.join(root, 'config', 'accounts.json');
      const homesRoot = path.join(root, 'homes');
      const existingHome = path.join(homesRoot, 'fixture-' + provider);
      fs.mkdirSync(existingHome, { recursive: true });
      a28RetainDeletes(root, attempts => {
        const added = addAccount({
          name: 'fixture-' + provider,
          provider,
          configPath,
          homesRoot
        });
        assert.equal(added.homeCreatedByApp, false,
          provider + ' existing home was marked app-created');
        const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(written.accounts[0].homeCreatedByApp, false,
          provider + ' existing home origin was not persisted');
        const credentialPath = a28WriteCredential(existingHome, provider);
        const removed = removeAccount({ name: added.name, provider, configPath });
        assert.equal(removed.credentialDestroyed, false,
          provider + ' external credential was destroyed');
        assert.equal(removed.credentialDisposition, 'preserved-existing-home',
          provider + ' external home did not publish its preservation disposition');
        assert.equal(fs.existsSync(existingHome), true, provider + ' external home was removed');
        a28AssertCredentialPreserved(attempts, credentialPath);
        a28AssertLockRetention(attempts);
      });
    }

    const root = a28Fixture('race');
    const configPath = path.join(root, 'config', 'accounts.json');
    const homesRoot = path.join(root, 'homes');
    const raceHome = path.join(homesRoot, 'fixture-race');
    const raceFs = Object.create(fs);
    let raceObserved = false;
    raceFs.mkdirSync = (target, options) => {
      if (target === raceHome && (!options || options.recursive !== true)) {
        fs.mkdirSync(target);
        raceObserved = true;
        const error = new Error('simulated concurrent creator');
        error.code = 'EEXIST';
        throw error;
      }
      return fs.mkdirSync(target, options);
    };
    a28RetainDeletes(root, () => {
      const added = addAccount({
        name: 'fixture-race',
        provider: 'codex',
        configPath,
        homesRoot,
        fsImpl: raceFs
      });
      assert.equal(raceObserved, true, 'the race seam did not reach the exclusive final mkdir');
      assert.equal(added.homeCreatedByApp, false, 'a final-mkdir race was marked app-created');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(written.accounts[0].homeCreatedByApp, false,
        'a final-mkdir race did not persist false origin');
    });
  });

  check('A28 legacy unknown and native homes preserve their sign-ins explicitly', () => {
    const legacyRoot = a28Fixture('legacy');
    const legacyHome = path.join(legacyRoot, 'legacy-home');
    const legacyConfig = path.join(legacyRoot, 'config', 'accounts.json');
    fs.mkdirSync(legacyHome, { recursive: true });
    const legacyCredential = a28WriteCredential(legacyHome, 'codex');
    a28WriteRegistry(legacyConfig, {
      name: 'fixture-legacy',
      provider: 'codex',
      profileDir: legacyHome,
      priority: 1
    });
    a28RetainDeletes(legacyRoot, attempts => {
      const removed = removeAccount({ name: 'fixture-legacy', provider: 'codex', configPath: legacyConfig });
      assert.equal(removed.credentialDestroyed, false, 'the legacy credential was destroyed');
      assert.equal(removed.credentialDisposition, 'preserved-legacy-unknown-home',
        'the legacy row did not publish its preservation disposition');
      a28AssertCredentialPreserved(attempts, legacyCredential);
      a28AssertLockRetention(attempts);
    });

    const nativeRoot = a28Fixture('native');
    const nativeHome = path.join(nativeRoot, 'native-home');
    const nativeConfig = path.join(nativeRoot, 'config', 'accounts.json');
    fs.mkdirSync(nativeHome, { recursive: true });
    const nativeCredential = a28WriteCredential(nativeHome, 'gemini');
    a28WriteRegistry(nativeConfig, {
      name: 'fixture-native',
      provider: 'gemini',
      client: 'antigravity',
      homeDir: nativeHome,
      homeCreatedByApp: true,
      priority: 1
    });
    a28RetainDeletes(nativeRoot, attempts => {
      const removed = removeAccount({ name: 'fixture-native', provider: 'gemini', configPath: nativeConfig });
      assert.equal(removed.credentialDestroyed, false, 'the native sign-in was destroyed');
      assert.equal(removed.credentialDisposition, 'preserved-native-sign-in',
        'the native row did not publish its preservation disposition');
      a28AssertCredentialPreserved(attempts, nativeCredential);
      a28AssertLockRetention(attempts);
    });
  });

const focusedA28 = process.env.A28_REGISTRATION_ORIGIN_ONLY === '1';
const selectedChecks = focusedA28
  ? pending.filter(([name]) => name.startsWith('A28'))
  : pending;
const skippedChecks = pending.length - selectedChecks.length;
if (focusedA28) {
  process.stdout.write('skip - ' + skippedChecks
    + ' non-A28 checks skipped; reason: A28_REGISTRATION_ORIGIN_ONLY is a local focused selection, not a suite gate\n');
}

(async () => {
  for (const [name, run] of selectedChecks) {
    try {
      await run();
      process.stdout.write(`ok - ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
    }
  }
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - multi-account-registry-write (${failures} failing)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
