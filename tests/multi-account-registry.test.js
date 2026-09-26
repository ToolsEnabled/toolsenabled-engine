/* Mutation check:
 * Changed the module's Codex `signInFile: 'auth.json'` to `signInFile: 'auth-broken.json'`.
 * The edit landed (one exact match was replaced).
 * This isolated test file went red with exit code 1.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_EXHAUSTED_AT_PERCENT,
  PROVIDER_IDS,
  MultiAccountError,
  accountsFor,
  describeProviders,
  findAccount,
  loadRegistry,
  parseRegistry,
  profileProvisioned,
  providerSpec,
  requireAccount,
  resolveProfileDir,
  signInFilePath
} = require('../src/lib/multi-account/registry.js');

const REGISTRY_TEXT = JSON.stringify({
  exhaustedAtPercent: 87,
  accounts: [
    { name: 'Work', role: 'primary', provider: 'codex', profileDir: '.codex-work', priority: 3 },
    { name: 'Personal', role: 'backup', provider: 'codex', profileDir: '.codex-personal', priority: 1 },
    { name: 'Work', role: 'primary', provider: 'claude', configDir: '.claude-work', priority: 2 }
  ]
});

test('provider metadata describes the supported account homes', () => {
  assert.deepEqual(PROVIDER_IDS, ['codex', 'claude', 'gemini', 'grok']);
  assert.deepEqual(providerSpec('codex'), {
    id: 'codex', dirField: 'profileDir', homeEnv: 'CODEX_HOME', signInFile: 'auth.json'
  });
  assert.deepEqual(providerSpec('claude'), {
    id: 'claude', dirField: 'configDir', homeEnv: 'CLAUDE_CONFIG_DIR', signInFile: '.credentials.json'
  });
  // Verified against upstream gemini-cli: homedir() honours GEMINI_CLI_HOME and
  // the sign-in is OAUTH_FILE 'oauth_creds.json' under its `.gemini` folder.
  assert.deepEqual(providerSpec('gemini'), {
    id: 'gemini', dirField: 'homeDir', homeEnv: 'GEMINI_CLI_HOME', signInFile: 'oauth_creds.json'
  });
  assert.equal(providerSpec('mistral'), null);
  assert.equal(describeProviders(), 'codex, claude, gemini and grok');
});

test('a Gemini account names its home in the provider own word and is presence-checked one level down', () => {
  const registry = parseRegistry(JSON.stringify({
    accounts: [{ name: 'lab', provider: 'gemini', homeDir: '/profiles/gemini-lab' }]
  }), { source: 'memory://gemini' });
  assert.equal(registry.accounts[0].provider, 'gemini');
  assert.equal(registry.accounts[0].homeDir, '/profiles/gemini-lab');
  assert.equal(registry.accounts[0].home, '/profiles/gemini-lab');

  // The Gemini CLI treats GEMINI_CLI_HOME as a home directory and keeps its
  // own state in `.gemini` inside it, so the presence check looks there.
  const observed = [];
  const fsImpl = { statSync(file) { observed.push(file); return { isFile: () => true }; } };
  assert.equal(profileProvisioned(registry.accounts[0], { fsImpl }), true);
  assert.deepEqual(observed, [path.resolve('/profiles/gemini-lab/.gemini/oauth_creds.json')]);
  assert.equal(signInFilePath('/x', providerSpec('gemini')), path.join('/x', '.gemini', 'oauth_creds.json'));
  assert.equal(signInFilePath('/x', providerSpec('codex')), path.join('/x', 'auth.json'));

  // A Gemini entry spelled with the Codex field is refused and told which field.
  assert.throws(
    () => parseRegistry(JSON.stringify({
      accounts: [{ name: 'lab', provider: 'gemini', profileDir: '/profiles/gemini-lab' }]
    }), { source: 'memory://gemini' }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_ENTRY_INVALID' && /homeDir/.test(error.message)
  );
});

test('parseRegistry normalizes entries, permits names per provider, and sorts by priority', () => {
  const registry = parseRegistry(REGISTRY_TEXT, { source: 'memory://accounts' });

  assert.equal(registry.exhaustedAtPercent, 87);
  assert.equal(registry.source, 'memory://accounts');
  assert.deepEqual(registry.accounts.map(({ name, provider, home, role, priority }) => (
    { name, provider, home, role, priority }
  )), [
    { name: 'Personal', provider: 'codex', home: '.codex-personal', role: 'backup', priority: 1 },
    { name: 'Work', provider: 'claude', home: '.claude-work', role: 'primary', priority: 2 },
    { name: 'Work', provider: 'codex', home: '.codex-work', role: 'primary', priority: 3 }
  ]);

  const defaulted = parseRegistry(JSON.stringify({
    exhaustedAtPercent: 0,
    accounts: [{ name: 'Only', provider: 'codex', profileDir: '.only' }]
  }), { source: 'memory://default' });
  assert.equal(defaulted.exhaustedAtPercent, DEFAULT_EXHAUSTED_AT_PERCENT);
});

test('selection is provider-scoped and accepts case-insensitive names and roles', () => {
  const registry = parseRegistry(REGISTRY_TEXT, { source: 'memory://accounts' });

  assert.deepEqual(accountsFor(registry, ' CODEX ').map(({ name }) => name), ['Personal', 'Work']);
  assert.deepEqual(accountsFor(registry, 'claude').map(({ name }) => name), ['Work']);
  assert.equal(findAccount(registry, ' PRIMARY ', { provider: 'claude' }).home, '.claude-work');
  assert.equal(findAccount(registry, 'work', { provider: 'codex' }).home, '.codex-work');
  assert.equal(findAccount(registry, 'missing'), null);
  assert.equal(requireAccount(registry, 'backup', { provider: 'codex' }).name, 'Personal');
  assert.throws(
    () => requireAccount(registry, 'missing', { provider: 'claude' }),
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNT_UNKNOWN'
      && /Known accounts: Work \(primary\)/.test(error.message)
  );
});

test('invalid registries refuse with specific public error codes', () => {
  const cases = [
    ['not json', 'ACCOUNTS_REGISTRY_UNPARSABLE'],
    [JSON.stringify({}), 'ACCOUNTS_REGISTRY_INVALID'],
    [JSON.stringify({ accounts: [] }), 'ACCOUNTS_REGISTRY_EMPTY'],
    [JSON.stringify({ accounts: [{ name: 'x', provider: 'mistral', profileDir: '.x' }] }), 'ACCOUNTS_PROVIDER_UNSUPPORTED'],
    [JSON.stringify({ accounts: [
      { name: 'x', provider: 'codex', profileDir: '.x' },
      { name: 'X', provider: 'codex', profileDir: '.y' }
    ] }), 'ACCOUNTS_NAME_DUPLICATE']
  ];

  for (const [raw, code] of cases) {
    assert.throws(
      () => parseRegistry(raw, { source: 'memory://invalid' }),
      error => error instanceof MultiAccountError && error.code === code,
      code
    );
  }
});

test('loadRegistry reads through the supplied filesystem and reports missing input', () => {
  const registry = loadRegistry({
    configPath: '/virtual/accounts.json',
    fsImpl: { readFileSync: (file, encoding) => {
      assert.equal(file, '/virtual/accounts.json');
      assert.equal(encoding, 'utf8');
      return REGISTRY_TEXT;
    } }
  });
  assert.equal(registry.source, '/virtual/accounts.json');
  assert.equal(registry.accounts.length, 3);

  assert.throws(
    () => loadRegistry({ configPath: '/missing/accounts.json', fsImpl: { readFileSync() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    } } }),
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNTS_REGISTRY_MISSING'
      && error.details.cause === 'ENOENT'
  );
});

// COULD NOT LOOK IS NOT NOT THERE. A registry loadRegistry cannot READ must
// never be reported as a registry that does not EXIST -- the two are
// different facts with different remedies, and this catch used to answer
// both with "No account registry at <path>. Add an account...", which is a
// false statement about a file that may be sitting right there. ENOENT and
// ENOTDIR are the only two codes that prove absence (matched above and
// mirrored by profileProvisioned() and by readForUpdate() in
// ./registry-write.js); every other failure is reported unreadable instead.
test('loadRegistry reports a read failure as unreadable, never as an absent registry', () => {
  const permissionDenied = () => loadRegistry({
    configPath: '/locked/accounts.json',
    fsImpl: { readFileSync() {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    } }
  });
  assert.throws(
    permissionDenied,
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNTS_REGISTRY_UNREADABLE'
      && error.details.cause === 'EACCES'
      && error.details.source === '/locked/accounts.json'
      && !/add an account/i.test(error.message)
  );

  // A directory sitting where the registry file should be is likewise
  // unknown rather than absent: EISDIR carries no information about whether
  // an accounts.json exists at this path, only that this attempt could not
  // read one there.
  const isADirectory = () => loadRegistry({
    configPath: '/locked/accounts.json',
    fsImpl: { readFileSync() {
      const error = new Error('is a directory');
      error.code = 'EISDIR';
      throw error;
    } }
  });
  assert.throws(
    isADirectory,
    error => error instanceof MultiAccountError && error.code === 'ACCOUNTS_REGISTRY_UNREADABLE'
  );

  // ENOTDIR -- an ancestor path component genuinely cannot exist as a
  // directory -- is the one other code that proves absence, exactly like
  // ENOENT, and must keep reporting ACCOUNTS_REGISTRY_MISSING.
  const parentIsAFile = () => loadRegistry({
    configPath: '/locked/accounts.json',
    fsImpl: { readFileSync() {
      const error = new Error('not a directory');
      error.code = 'ENOTDIR';
      throw error;
    } }
  });
  assert.throws(
    parentIsAFile,
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNTS_REGISTRY_MISSING'
      && error.details.cause === 'ENOTDIR'
  );
});

test('loadRegistry refuses an invalid path before touching the filesystem', () => {
  let filesystemCalls = 0;
  const untouchedFs = {
    readFileSync() { filesystemCalls += 1; },
    writeFileSync() { filesystemCalls += 1; }
  };

  assert.throws(
    () => loadRegistry({ configPath: '   ', fsImpl: untouchedFs }),
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNTS_REGISTRY_PATH_INVALID'
      && error.message === 'No account registry path was given.'
  );
  assert.equal(filesystemCalls, 0, 'an invalid path must refuse before any read or write');
});

test('loadRegistry refuses duplicate provider roles without writing anything', () => {
  let reads = 0;
  let writes = 0;
  const duplicateRoles = JSON.stringify({ accounts: [
    { name: 'First', role: ' Primary ', provider: 'codex', profileDir: '.first' },
    { name: 'Second', role: 'primary', provider: 'codex', profileDir: '.second' }
  ] });
  const fsImpl = {
    readFileSync(file, encoding) {
      reads += 1;
      assert.equal(file, '/virtual/duplicate-roles.json');
      assert.equal(encoding, 'utf8');
      return duplicateRoles;
    },
    writeFileSync() { writes += 1; }
  };

  assert.throws(
    () => loadRegistry({ configPath: '/virtual/duplicate-roles.json', fsImpl }),
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNTS_ROLE_DUPLICATE'
      && error.details.role === 'primary'
      && error.details.provider === 'codex'
  );
  assert.equal(reads, 1, 'the duplicate must be discovered by parsing the supplied registry');
  assert.equal(writes, 0, 'registry validation must not write after refusing');
});

test('directory resolution and provisioning use each provider sign-in filename', () => {
  const codex = { name: 'Codex', provider: 'codex', home: '.codex-test' };
  const claude = { name: 'Claude', provider: 'claude', home: '/profiles/claude-test' };

  assert.equal(resolveProfileDir(codex, { homeDir: '/users/tester' }), path.resolve('/users/tester/.codex-test'));
  assert.equal(resolveProfileDir(claude), path.resolve('/profiles/claude-test'));

  const observed = [];
  const fsImpl = { statSync(file) {
    observed.push(file);
    return { isFile: () => true };
  } };
  assert.equal(profileProvisioned(codex, { homeDir: '/users/tester', fsImpl }), true);
  assert.equal(profileProvisioned(claude, { fsImpl }), true);
  assert.deepEqual(observed, [
    path.resolve('/users/tester/.codex-test/auth.json'),
    path.resolve('/profiles/claude-test/.credentials.json')
  ]);

  assert.equal(profileProvisioned(codex, { homeDir: '/users/tester', fsImpl: { statSync() {
    const error = new Error('absent');
    error.code = 'ENOENT';
    throw error;
  } } }), false);
});

test('profileProvisioned refuses an indeterminate stat instead of reporting absence', () => {
  let stats = 0;
  let writes = 0;
  const account = { name: 'Locked', provider: 'codex', home: '/profiles/locked' };
  const fsImpl = {
    statSync(file) {
      stats += 1;
      assert.equal(file, path.resolve('/profiles/locked/auth.json'));
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
    writeFileSync() { writes += 1; }
  };

  assert.throws(
    () => profileProvisioned(account, { fsImpl }),
    error => error instanceof MultiAccountError
      && error.code === 'ACCOUNT_PROVISIONING_UNKNOWN'
      && error.details.name === 'Locked'
      && error.details.provider === 'codex'
      && error.details.cause === 'EACCES'
  );
  assert.equal(stats, 1, 'the refusal must be driven by the injected stat failure');
  assert.equal(writes, 0, 'a failed provisioning probe must remain read-only');
});

test('Antigravity is an explicit Gemini client and cannot reuse legacy provisioning evidence', () => {
  const entry = { name: 'google', provider: 'gemini', homeDir: '/profiles/ag', client: 'antigravity', expectEmail: 'Known@Example.test' };
  const account = parseRegistry(JSON.stringify({ accounts: [entry] }), { source: 'memory://clients' }).accounts[0];
  assert.equal(account.client, 'antigravity');
  assert.throws(() => parseRegistry(JSON.stringify({ accounts: [entry, { ...entry, name: 'alias', homeDir: '/profiles/empty-alias' }] }), { source: 'memory://aliases' }),
    error => error.code === 'ACCOUNTS_CLIENT_SIGNIN_SHARED', 'a HOME alias must not manufacture another account or quota');
  assert.equal(account.expectEmail, 'known@example.test');
  assert.throws(() => profileProvisioned(account, { fsImpl: { statSync() { throw new Error('must not inspect credentials'); } } }),
    error => error.code === 'ACCOUNT_PROVISIONING_UNKNOWN' && error.details.cause === 'NATIVE_CLIENT_STATUS_REQUIRED');
  for (const invalid of [{ ...entry, client: 'other' }, { name: 'grok', provider: 'grok', configDir: '/profiles/grok', client: 'antigravity' }]) {
    assert.throws(() => parseRegistry(JSON.stringify({ accounts: [invalid] }), { source: 'memory://clients' }),
      error => error.code === 'ACCOUNTS_CLIENT_UNSUPPORTED');
  }
});
