'use strict';
// Pins the owner-designated Codex identity for dispatched workers.
//
// The incident (2026-08-09): the owner directed that Codex workers run as a
// specific account. ~/.codex held a DIFFERENT account, and mission-bridge
// dispatch scrubbed CODEX_HOME without pinning a replacement, so every worker
// silently ran as the wrong identity and nothing surfaced it. These checks pin
// the fix's whole contract: the scrub still strips caller-supplied values, the
// config pin is applied after it, an unusable configured profile REFUSES
// rather than falling back, and only a genuinely absent config restores the
// legacy default.

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
// actions.js imports the SQLite-backed audit singleton, although this pure
// helper does not use it. Keep the focused test runnable on pre-Node-22 hosts.
const auditFilename = require.resolve('../src/lib/audit');
const stateStoreFilename = require.resolve('../src/lib/state-store');
const toolRegistryFilename = require.resolve('../src/lib/tool-registry');
require.cache[auditFilename] = { id: auditFilename, filename: auditFilename, loaded: true, exports: {}, children: [], paths: [] };
require.cache[stateStoreFilename] = { id: stateStoreFilename, filename: stateStoreFilename, loaded: true, exports: {}, children: [], paths: [] };
require.cache[toolRegistryFilename] = { id: toolRegistryFilename, filename: toolRegistryFilename, loaded: true, exports: { executeTool() {} }, children: [], paths: [] };
const {
  accountConfinedDispatchEnvironment,
  codexDispatchEnvironment,
  scrubEnvironment,
  MissionBridgeError
} = require('../src/lib/mission-bridge/actions.js');
const confinement = require('../src/lib/agent-session-confinement.js');
delete require.cache[auditFilename];
delete require.cache[stateStoreFilename];
delete require.cache[toolRegistryFilename];

const TEST_TEMP_ROOT = process.platform === 'win32'
  ? path.join(confinement.installationProfileRoot(), 'AppData', 'Local', 'Temp')
  : os.tmpdir();
const HOME = path.join(TEST_TEMP_ROOT, 'codex-dispatch-profile-home');
const CONFIG = path.join(TEST_TEMP_ROOT, 'codex-dispatch-profile-repo', 'config', 'codex.json');
const ABSOLUTE_PROFILE = path.join(TEST_TEMP_ROOT, 'codex-dispatch-profile-absolute');

function fakeFs({ config, authFiles = [], authError = null, onAuthStat = () => {} }) {
  return {
    readFileSync(file) {
      if (path.resolve(file) === path.resolve(CONFIG) && config !== undefined) return config;
      const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error;
    },
    statSync(file) {
      onAuthStat(file);
      if (authError) { const error = new Error(authError); error.code = authError; throw error; }
      if (authFiles.some(candidate => path.resolve(candidate) === path.resolve(file))) return { isFile: () => true };
      const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error;
    }
  };
}

const checks = [];
function check(name, fn) { checks.push([name, fn]); }
function checkWindows(name, fn) {
  checks.push([name, fn, process.platform !== 'win32' && 'requires native Windows account path semantics']);
}

check('a caller-supplied CODEX_HOME is scrubbed, then the configured profile is pinned over it', () => {
  const scrubbed = scrubEnvironment({ CODEX_HOME: path.join(os.tmpdir(), 'attacker-profile'), PATH: 'x' });
  assert.strictEqual(scrubbed.CODEX_HOME, undefined);
  const env = codexDispatchEnvironment(scrubbed, {
    configPath: CONFIG, homeDir: HOME,
    fsImpl: fakeFs({ config: JSON.stringify({ profileDir: '.codex-owner' }), authFiles: [path.join(HOME, '.codex-owner', 'auth.json')] })
  });
  assert.strictEqual(env.CODEX_HOME, path.join(HOME, '.codex-owner'));
  assert.strictEqual(env.PATH, 'x');
});

check('an absolute profileDir is used verbatim', () => {
  const env = codexDispatchEnvironment({}, {
    configPath: CONFIG, homeDir: HOME,
    fsImpl: fakeFs({ config: JSON.stringify({ profileDir: ABSOLUTE_PROFILE }), authFiles: [path.join(ABSOLUTE_PROFILE, 'auth.json')] })
  });
  assert.strictEqual(env.CODEX_HOME, ABSOLUTE_PROFILE);
});

checkWindows('a profile in another Windows account is refused before auth.json is inspected', () => {
  let authStats = 0;
  const foreignProfile = 'C:\\Users\\fixture-user\\.codex';
  assert.throws(
    () => codexDispatchEnvironment({}, {
      configPath: CONFIG,
      homeDir: HOME,
      profileRoot: confinement.installationProfileRoot(),
      fsImpl: fakeFs({
        config: JSON.stringify({ profileDir: foreignProfile }),
        authFiles: [path.join(foreignProfile, 'auth.json')],
        onAuthStat: () => { authStats += 1; }
      })
    }),
    error => error instanceof MissionBridgeError
      && error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
      && error.status === 403
  );
  assert.strictEqual(authStats, 0,
    'an explicitly foreign account spelling must be rejected lexically, without probing that profile');
});

checkWindows('every Windows provider environment is rebound to the installation account and names its actor', () => {
  const foreign = 'C:\\Users\\fixture-user';
  const env = accountConfinedDispatchEnvironment({
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: foreign,
    HOME: foreign,
    APPDATA: path.join(foreign, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(foreign, 'AppData', 'Local')
  }, 'claude');
  const owner = confinement.installationProfileRoot();
  assert.strictEqual(env.USERPROFILE, owner);
  assert.strictEqual(env.HOME, owner);
  assert.strictEqual(env.APPDATA, path.join(owner, 'AppData', 'Roaming'));
  assert.strictEqual(env.LOCALAPPDATA, path.join(owner, 'AppData', 'Local'));
  assert.strictEqual(env.TOOLSENABLED_AGENT_ACTOR, 'claude');
  assert.strictEqual(Object.values(env).some(value => typeof value === 'string' && value.includes(foreign)), false);
});

checkWindows('a foreign Windows profile hidden in an unrelated inherited variable is removed before launch', () => {
  const foreign = 'C:\\Users\\fixture-user\\stale-directives';
  const env = accountConfinedDispatchEnvironment({
    PATH: 'C:\\Windows\\System32',
    STALE_DIRECTIVE_ROOT: foreign
  }, 'claude');
  assert.strictEqual(env.STALE_DIRECTIVE_ROOT, undefined);
  assert.strictEqual(Object.values(env).some(value => typeof value === 'string' && value.includes(foreign)), false);
});

check('no config file at all means no pin -- legacy default profile', () => {
  const env = codexDispatchEnvironment({ PATH: 'x' }, { configPath: CONFIG, homeDir: HOME, fsImpl: fakeFs({}) });
  assert.strictEqual(env.CODEX_HOME, undefined);
});

check('profileDir null explicitly restores the default without refusing', () => {
  const env = codexDispatchEnvironment({}, {
    configPath: CONFIG, homeDir: HOME,
    fsImpl: fakeFs({ config: JSON.stringify({ profileDir: null }) })
  });
  assert.strictEqual(env.CODEX_HOME, undefined);
});

check('a configured profile with no auth.json REFUSES the dispatch instead of falling back', () => {
  assert.throws(
    () => codexDispatchEnvironment({}, {
      configPath: CONFIG, homeDir: HOME,
      fsImpl: fakeFs({ config: JSON.stringify({ profileDir: '.codex-owner' }), authFiles: [] })
    }),
    error => error instanceof MissionBridgeError && error.code === 'BRIDGE_CODEX_PROFILE_UNAVAILABLE'
  );
});

check('an auth.json inspection failure is unknown, never reported as definite absence or cached', () => {
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    let statCalls = 0;
    const dependencies = {
      configPath: CONFIG,
      homeDir: HOME,
      fsImpl: fakeFs({
        config: JSON.stringify({ profileDir: '.codex-owner' }),
        authError: code,
        onAuthStat: () => { statCalls += 1; }
      })
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => codexDispatchEnvironment({}, dependencies),
        error => error instanceof MissionBridgeError
          && error.code === 'BRIDGE_CODEX_PROFILE_AUTH_UNREADABLE'
          && error.details.cause === code
          && /does NOT claim that auth\.json is absent/.test(error.message)
      );
    }
    assert.strictEqual(statCalls, 2, `${code} uncertainty must be retried, not cached or latched`);
  }
});

check('CONTROL: proven auth presence still succeeds on every call without changing the existing result', () => {
  let statCalls = 0;
  const profile = path.join(HOME, '.codex-owner');
  const dependencies = {
    configPath: CONFIG,
    homeDir: HOME,
    fsImpl: fakeFs({
      config: JSON.stringify({ profileDir: '.codex-owner' }),
      authFiles: [path.join(profile, 'auth.json')],
      onAuthStat: () => { statCalls += 1; }
    })
  };
  assert.strictEqual(codexDispatchEnvironment({}, dependencies).CODEX_HOME, profile);
  assert.strictEqual(codexDispatchEnvironment({}, dependencies).CODEX_HOME, profile);
  assert.strictEqual(statCalls, 2, 'the pre-existing uncached auth check must remain uncached');
});

check('unparsable config REFUSES rather than dispatching under an undetermined identity', () => {
  assert.throws(
    () => codexDispatchEnvironment({}, { configPath: CONFIG, homeDir: HOME, fsImpl: fakeFs({ config: '{not json' }) }),
    error => error instanceof MissionBridgeError && error.code === 'BRIDGE_CODEX_PROFILE_UNAVAILABLE'
  );
});

check('the REAL config, if present in this checkout, names a resolvable logged-in profile', () => {
  const fsReal = require('node:fs');
  const realConfig = path.resolve(__dirname, '..', 'config', 'codex.json');
  if (!fsReal.existsSync(realConfig)) return; // absent = legacy default, valid
  const parsed = JSON.parse(fsReal.readFileSync(realConfig, 'utf8'));
  if (parsed.profileDir === null) return;
  const home = process.env.USERPROFILE || process.env.HOME;
  const resolved = path.isAbsolute(parsed.profileDir) ? parsed.profileDir : path.join(home, parsed.profileDir);
  assert.ok(fsReal.existsSync(path.join(resolved, 'auth.json')),
    `config/codex.json names profile ${resolved} but it has no auth.json -- dispatches would refuse`);
});

let failed = 0;
let skipped = 0;
for (const [name, fn, skip] of checks) {
  if (skip) { skipped += 1; process.stdout.write(`  SKIP ${name}: ${skip}\n`); continue; }
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}: ${error && error.message}\n`); }
}
if (failed > 0) { process.stdout.write(`codex-dispatch-profile: ${failed} FAILED\n`); process.exit(1); }
process.stdout.write(`codex-dispatch-profile: ${checks.length - skipped} checks passed, ${skipped} skipped\n`);
