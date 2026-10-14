// Confinement, argv transport and sign-in custody checks use inert fixtures.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activate, isolatedTemporaryRoot } = require('./lib/isolated-environment');
activate('agent-session-confinement');
// This suite tests the three permission tiers with native tools admitted.
// ToolsEnabled-only deliberately narrows the native sandbox further and has
// its own all-mode writer/launcher contract test in the application suite.
const settingsPath = require('../src/lib/settings').resolveValuesPath({});
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ revision: 1, values: { 'agent.tool_mode': 'ToolsEnabled and native tools' }, provenance: { 'agent.tool_mode': { source: 'user', atMs: 1, directive: null } } }));

// These baseline tests exercise permission tiers with both tool sets enabled.
const apiSettingsFile = require('../src/lib/settings').resolveValuesPath({});
fs.mkdirSync(path.dirname(apiSettingsFile), { recursive: true });
fs.writeFileSync(apiSettingsFile, JSON.stringify({ revision: 1,
  values: { 'agent.agent_api': 'Enabled' },
  provenance: { 'agent.agent_api': { source: 'user', atMs: 1, directive: null } } }));

const confinement = require('../src/lib/agent-session-confinement');
const accountBoundary = require('../src/lib/account-profile-boundary');
const { executableFor } = require('../src/lib/providers/cli-provider-gateway');
const machineRecord = require('../src/lib/setup/machine-record');
const policy = require('../src/lib/permission-tier-policy');
const { codexArgs, claudeArgs } = require('../src/lib/mission-bridge/actions');

let checks = 0;
let windowsProfileCasesSkipped = false;
const temporary = [];

function scratch(prefix) {
  // The Dev account's native TEMP can be exposed as an ambiguous SAMPLE~1 alias.
  // Product confinement correctly refuses that spelling, so account-boundary
  // fixtures use the same long owner-root helper as the isolated runner.
  const parent = process.platform === 'linux' ? path.join(__dirname, '.custody-fixtures') : isolatedTemporaryRoot();
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(parent, `agent-confinement-${prefix}-`));
  temporary.push(directory);
  return directory;
}

function writeRecord(servicesRoot, tier, { workspace = scratch('ws'), mutate = null } = {}) {
  const record = machineRecord.buildMachineRecord({
    tier,
    installRoot: path.join(__dirname, '..'),
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspace]
  });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  if (mutate) {
    const file = machineRecord.machineRecordPath(servicesRoot);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(parsed);
    fs.writeFileSync(file, JSON.stringify(parsed));
  }
  return record;
}

// --- 1. every level maps to exactly one confinement --------------------------

function levelsMapToOneConfinement() {
  // The three levels and nothing else. A level added to one list and not the
  // other is the drift this asserts against, not a hypothetical: INSTALL_TIERS
  // and the confinement map are two files that must agree.
  assert.deepEqual(
    Object.keys(confinement.INSTALL_TIER_AGENT_CONFINEMENT).sort(),
    [...policy.INSTALL_TIERS].sort()
  );
  checks += 1;

  const expected = {
    guided: { sandbox: 'read-only', claudePermissionMode: 'plan', isolated: true },
    standard: { sandbox: 'workspace-write', claudePermissionMode: 'acceptEdits', isolated: true },
    unrestricted: { sandbox: 'danger-full-access', claudePermissionMode: 'bypassPermissions', isolated: true }
  };
  for (const [tier, want] of Object.entries(expected)) {
    const resolved = confinement.agentConfinement(tier);
    assert.equal(resolved.sandbox, want.sandbox, `${tier} sandbox`);
    assert.equal(resolved.claudePermissionMode, want.claudePermissionMode, `${tier} claude mode`);
    assert.equal(resolved.isolated, want.isolated, `${tier} isolation`);
    // 'never' at EVERY level, including the confined ones. 'on-request' would
    // let the model ask to leave its sandbox, and the agent host exposes no way
    // to answer -- so it would either hang the turn or, once a reply path
    // exists, become a route around the ceiling.
    assert.equal(resolved.approvalPolicy, 'never', `${tier} approval policy`);
    checks += 4;
  }

  // The ordering that makes `guided` a ceiling and not merely a different shape.
  const ladder = ['read-only', 'workspace-write', 'danger-full-access'];
  assert.deepEqual(policy.INSTALL_TIERS.map(t => confinement.agentConfinement(t).sandbox), ladder);
  checks += 1;
}

// --- 2. fail closed ----------------------------------------------------------

function unreadableLevelsRefuse() {
  // Absent, malformed and unrecognised, at the function that maps a WORD to a
  // confinement. None may answer; in particular none may answer
  // danger-full-access, and none may answer "no sandbox word", which Codex
  // reads as the user config's own sandbox_mode.
  for (const bad of [undefined, null, '', 'FULL', 'Guided', 'admin', 'unrestricted ', {}, [], 42, true]) {
    assert.throws(
      () => confinement.agentConfinement(bad),
      error => error.code === 'PERMISSION_INSTALL_TIER_REFUSED',
      `level ${JSON.stringify(bad)} must be refused`
    );
    checks += 1;
  }
}

function unreadableRecordsFailClosedToTheNarrowestSession() {
  // The three ways a real installation loses its answer, each through the
  // function the agent host actually calls. Every one must produce read-only.
  const cases = [
    ['absent', () => scratch('absent')],
    ['malformed', () => {
      const root = scratch('malformed');
      fs.writeFileSync(machineRecord.machineRecordPath(root), '{ this is not json');
      return root;
    }],
    ['unknown level', () => {
      const root = scratch('unknown');
      writeRecord(root, 'guided', { mutate: parsed => { parsed.tier = 'superuser'; } });
      return root;
    }],
    ['level removed', () => {
      const root = scratch('missing-tier');
      writeRecord(root, 'unrestricted', { mutate: parsed => { delete parsed.tier; } });
      return root;
    }]
  ];

  for (const [label, build] of cases) {
    const servicesRoot = build();
    const plan = confinement.confinedSessionPlan({ servicesRoot });
    assert.equal(plan.threadOptions.sandbox, 'read-only', `${label} must fail closed to read-only`);
    assert.equal(plan.threadOptions.approvalPolicy, 'never', `${label} approval policy`);
    assert.equal(plan.tier, 'guided', `${label} tier`);
    assert.equal(plan.failedClosed, true, `${label} must report that it failed closed`);
    assert.equal(plan.isolated, true, `${label} must still be isolated`);
    // Nothing was recorded, so nothing is granted: the prepared home carries no
    // MCP server at all rather than the ones the user happens to have.
    assert.deepEqual([...plan.servers], [], `${label} must grant no servers`);
    checks += 6;
  }
}

// --- 3. the prepared home ----------------------------------------------------

function preparedHomeCarriesOnlyWhatTheLevelPermits() {
  const expectedServers = {
    guided: ['toolsenabled-readonly'],
    standard: ['toolsenabled-readonly', 'toolsenabled', 'playwright'],
    unrestricted: ['toolsenabled-readonly', 'toolsenabled', 'playwright']
  };
  for (const [tier, servers] of Object.entries(expectedServers)) {
    const servicesRoot = scratch(`home-${tier}`);
    writeRecord(servicesRoot, tier);
    const userCodexHome = scratch(`user-codex-${tier}`);
    const source = path.join(userCodexHome, 'auth.json');
    fs.writeFileSync(source, '{"fixture":"official sign-in stays here"}');
    const before = fs.statSync(source);
    const methods = ['linkSync', 'copyFileSync', 'writeFileSync', 'readFileSync', 'renameSync'];
    const original = Object.fromEntries(methods.map(name => [name, fs[name]]));
    let plan;
    try {
      for (const method of methods) fs[method] = (...args) => {
        if (args.slice(0, method === 'renameSync' || method === 'linkSync' || method === 'copyFileSync' ? 2 : 1)
          .some(file => typeof file === 'string' && path.basename(file) === 'auth.json')) {
          assert.fail(`${method} touched a Codex sign-in`);
        }
        return original[method](...args);
      };
      plan = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
      assert.equal(plan.ok, true, plan.code);
      assert.equal(plan.env.CODEX_HOME, userCodexHome);
      assert.equal(plan.codexHome, userCodexHome);
      assert.ok(plan.agentHome.startsWith(servicesRoot));
      assert.deepEqual([...plan.servers], servers);
      const config = plan.codexConfig;
      assert.equal(config.sandbox_mode, confinement.agentConfinement(tier).sandbox);
      assert.equal(config.approval_policy, 'never');
      assert.deepEqual(config.notify, []);
      assert.deepEqual(Object.keys(config.mcp_servers), servers);
      for (const name of servers) {
        assert.equal(config.mcp_servers[name].enabled, true, 'each confined server must be enabled');
        checks++;
      }
      for (const name of servers.filter(name => name.startsWith('toolsenabled'))) {
        assert.equal(config.mcp_servers[name].tool_timeout_sec, 900);
        checks++;
      }
      assert.ok(plan.codexArgs.includes('-c'));
      assert.ok(plan.codexArgs.some(arg => arg.startsWith('mcp_servers=')));
      const reprepared = confinement.prepareConfinedCodexHome(confinement.agentConfinement(tier),
        { servicesRoot, userCodexHome, record: null });
      assert.equal(reprepared.codexHome, userCodexHome);
    } finally {
      for (const method of methods) fs[method] = original[method];
    }
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(path.join(directory, entry.name)) : [entry.name]);
    assert.equal(walk(servicesRoot).includes('auth.json'), false, 'no sign-in name was created in any agent home');
    assert.equal(fs.statSync(source).ino, before.ino);
    assert.equal(fs.statSync(source).nlink, before.nlink);
    assert.equal(fs.existsSync(path.join(plan.agentHome, 'config.toml')), false);
    checks += 16;
  }
}

function accountFenceFollowsEveryGeneratedCodexHome() {
  const accountHome = scratch('account-home');
  const fencePath = path.join(accountHome, 'ACCOUNT-FENCE.md');
  const firstFence = Buffer.from(`# local account fence\nfirst-${process.pid}\n`);
  fs.writeFileSync(fencePath, firstFence);

  const userCodexHome = scratch('fence-user-codex');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  const cases = [
    { tier: 'guided', servicesRoot: scratch('fence-guided'), accountName: null },
    { tier: 'standard', servicesRoot: scratch('fence-standard'), accountName: null },
    { tier: 'unrestricted', servicesRoot: scratch('fence-unrestricted'), accountName: null },
    { tier: 'standard', servicesRoot: scratch('fence-named'), accountName: 'Work Account' }
  ];

  for (const item of cases) {
    const built = confinement.prepareConfinedCodexHome(confinement.agentConfinement(item.tier), {
      servicesRoot: item.servicesRoot,
      userCodexHome,
      accountHome,
      accountName: item.accountName,
      record: null
    });
    assert.deepEqual(
      fs.readFileSync(path.join(built.agentHome, 'AGENTS.md')),
      firstFence,
      `${item.tier}/${item.accountName || '@default'} did not receive the current account fence bytes`
    );
    assert.ok(built.codexConfig.developer_instructions.includes(firstFence.toString('utf8')),
      'the launch directives must carry the current account fence');
    checks += 2;
  }

  const refreshedFence = Buffer.from(`# local account fence\nrefreshed-${process.pid}\n`);
  fs.writeFileSync(fencePath, refreshedFence);
  for (const item of cases) {
    const rebuilt = confinement.prepareConfinedCodexHome(confinement.agentConfinement(item.tier), {
      servicesRoot: item.servicesRoot,
      userCodexHome,
      accountHome,
      accountName: item.accountName,
      record: null
    });
    assert.deepEqual(
      fs.readFileSync(path.join(rebuilt.agentHome, 'AGENTS.md')),
      refreshedFence,
      `${item.tier}/${item.accountName || '@default'} retained stale account-fence bytes`
    );
    assert.ok(rebuilt.codexConfig.developer_instructions.includes(refreshedFence.toString('utf8')),
      'the launch directives must carry refreshed account-fence bytes');
    checks += 2;
  }

  // No account fence means no generated global directives. A stale AGENTS.md
  // from an earlier account must be removed before the next session starts.
  const noFenceAccountHome = scratch('account-home-without-fence');
  const noFenceRoot = scratch('no-fence-root');
  const withoutFence = confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'), {
    servicesRoot: noFenceRoot,
    userCodexHome,
    accountHome: noFenceAccountHome,
    record: null
  });
  const absentTarget = path.join(withoutFence.agentHome, 'AGENTS.md');
  assert.ok(!fs.existsSync(absentTarget), 'an absent account fence invented an AGENTS.md');
  const existingMemory = Buffer.from('existing confined-home memory\n');
  fs.writeFileSync(absentTarget, existingMemory);
  confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'), {
    servicesRoot: noFenceRoot,
    userCodexHome,
    accountHome: noFenceAccountHome,
    record: null
  });
  assert.ok(!fs.existsSync(absentTarget),
    'an absent account fence retained stale global directives in the generated home');
  checks += 2;

  // A boundary path that exists but is not a regular file cannot silently be
  // treated as absence. The prepare refuses before producing a startable home.
  const ambiguousAccountHome = scratch('ambiguous-account-fence');
  fs.mkdirSync(path.join(ambiguousAccountHome, 'ACCOUNT-FENCE.md'));
  assert.throws(
    () => confinement.prepareConfinedCodexHome(confinement.agentConfinement('standard'), {
      servicesRoot: scratch('ambiguous-fence-root'),
      userCodexHome,
      accountHome: ambiguousAccountHome,
      record: null
    }),
    error => error.code === 'AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE'
  );
  checks += 1;
}

function accountProfileIsPinnedAndForeignRootsRefuseBeforePreparation() {
  const profileRoot = confinement.installationProfileRoot();
  const moduleRelative = path.relative(profileRoot, __dirname);
  assert.ok(moduleRelative !== '' && !moduleRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(moduleRelative),
    'the installation profile was derived from ambient state instead of the engine location');

  const servicesRoot = scratch('profile-pins-root');
  writeRecord(servicesRoot, 'unrestricted');
  const userCodexHome = scratch('profile-pins-codex');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  const plan = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
  assert.equal(plan.ok, true);
  for (const name of [
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME'
  ]) {
    const relative = path.relative(profileRoot, plan.env[name]);
    assert.ok(relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)),
      `${name} was not pinned inside the installation account profile`);
    checks += 1;
  }
  if (process.platform !== 'win32') {
    // Reported by main() as a declared TAP skip; session preparation and environment checks above still ran.
    windowsProfileCasesSkipped = true;
    return;
  }
  assert.equal(plan.env.HOMEDRIVE.toLowerCase(), path.parse(profileRoot).root.replace(/[\\/]$/, '').toLowerCase());
  assert.equal(path.resolve(`${plan.env.HOMEDRIVE}${plan.env.HOMEPATH}`), path.resolve(profileRoot));
  checks += 4;

  // These aliases are a Windows filesystem feature. The native Windows run
  // exercises them below; Linux still verifies its real pinned environment
  // above and refuses relative paths through its own actual platform branch.
  if (process.platform !== 'win32') {
    assert.throws(() => confinement.assertAccountProfilePath('relative/profile'),
      error => error.code === 'AGENT_CONFINEMENT_PROFILE_PATH_INVALID');
    checks += 1;
    return;
  }

  // These are data-only path strings. The subject must reject them lexically;
  // the suite never creates, stats or opens either foreign-profile target.
  const foreignRoot = '\x43:\\Users\\fixture-user';
  const profileDrive = path.win32.parse(profileRoot).root[0];
  const profileTail = profileRoot.slice(path.win32.parse(profileRoot).root.length);
  const ownedExtendedDrive = `\\\\?\\${profileRoot}`;
  const ownedAdminShare = `\\\\localhost\\${profileDrive}$\\${profileTail}`;
  const ownedExtendedAdminShare = `\\\\?\\UNC\\localhost\\${profileDrive}$\\${profileTail}`;
  const ordinaryUnc = '\\\\fixture-files.invalid\\projects\\artifact';
  const ordinaryExtendedUnc = '\\\\?\\UNC\\fixture-files.invalid\\projects\\artifact';

  assert.equal(confinement.assertAccountProfilePath(ownedExtendedDrive, { profileRoot }), profileRoot,
    'the owned extended-drive spelling was not reduced to the installation profile');
  assert.equal(confinement.assertAccountProfilePath(ownedAdminShare, { profileRoot }), profileRoot,
    'the provably-local owned admin share was not reduced without opening the share');
  assert.equal(confinement.assertAccountProfilePath(ownedExtendedAdminShare, { profileRoot }), profileRoot,
    'the extended-UNC form of the provably-local owned share was not preserved');
  assert.equal(confinement.assertAccountProfilePath(ordinaryUnc, { profileRoot }), path.win32.normalize(ordinaryUnc),
    'an ordinary non-profile UNC path was rejected');
  assert.equal(
    confinement.assertAccountProfilePath(ordinaryExtendedUnc, { profileRoot }),
    path.win32.normalize(ordinaryUnc),
    'a safe extended ordinary UNC path was not reduced to its ordinary spelling'
  );
  const ownedAliasEnvironment = {
    OWNED_EXTENDED: `${ownedExtendedDrive}\\bin`,
    OWNED_ADMIN: `${ownedAdminShare}\\bin`,
    OWNED_EXTENDED_ADMIN: `${ownedExtendedAdminShare}\\bin`,
    ORDINARY_UNC: ordinaryUnc,
    ORDINARY_EXTENDED_UNC: ordinaryExtendedUnc,
    NON_FILESYSTEM_DEVICE: '\\\\.\\pipe\\toolsenabled-fixture'
  };
  assert.equal(
    confinement.assertAccountProfileEnvironment(ownedAliasEnvironment, profileRoot),
    ownedAliasEnvironment,
    'owned aliases or a safe non-profile UNC/device value were rejected'
  );
  checks += 6;

  const foreignAliases = [
    `\\\\localhost\\${profileDrive}$\\Users\\fixture-user\\bin`,
    `\\\\?\\UNC\\localhost\\${profileDrive}$\\Users\\fixture-user\\bin`,
    `\\\\?\\${profileDrive}:\\Users\\fixture-user\\bin`,
    `\\\\.\\${profileDrive}:\\Users\\fixture-user\\bin`,
    `\\\\.\\UNC\\localhost\\${profileDrive}$\\Users\\fixture-user\\bin`,
    `\\\\localhost\\${profileDrive}$\\Windows\\..\\Users\\fixture-user\\bin`,
    `\\\\?\\${profileDrive}:\\Windows\\..\\Users\\fixture-user\\bin`,
    `\\\\remote-fixture.invalid\\${profileDrive}$\\Users\\${path.win32.basename(profileRoot)}\\bin`,
    '\\\\remote-fixture.invalid\\projects\\Users\\fixture-user\\bin',
    '\\\\?\\UNC\\remote-fixture.invalid\\projects\\Users\\fixture-user\\bin',
    `\\\\??\\${profileDrive}:\\Users\\${path.win32.basename(profileRoot)}\\bin`,
    `\\??\\${profileDrive}:\\Users\\${path.win32.basename(profileRoot)}\\bin`,
    '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\Users\\fixture-user\\bin'
  ];
  const realLstatSync = fs.lstatSync;
  let foreignAliasFilesystemProbes = 0;
  try {
    fs.lstatSync = () => {
      foreignAliasFilesystemProbes += 1;
      throw Object.assign(new Error('a foreign alias reached the filesystem'), { code: 'EFENCEPROBE' });
    };
    for (const alias of foreignAliases) {
      assert.throws(
        () => confinement.assertAccountProfilePath(alias, { profileRoot }),
        error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
        `foreign or unsupported alias was accepted as a path: ${alias}`
      );
      assert.throws(
        () => confinement.assertAccountProfileEnvironment({ ALIAS: alias }, profileRoot),
        error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT'
          && error.details.variables.length === 1
          && error.details.variables[0] === 'ALIAS',
        `foreign or unsupported alias was accepted in the final environment: ${alias}`
      );
      checks += 2;
    }
  } finally {
    fs.lstatSync = realLstatSync;
  }
  assert.equal(foreignAliasFilesystemProbes, 0,
    'a foreign or unsupported alias was probed before the account boundary refused it');
  checks += 1;

  const foreignCredential = confinement.confinedSessionPlan({
    servicesRoot,
    userCodexHome: path.win32.join(foreignRoot, '.codex')
  });
  assert.equal(foreignCredential.ok, false);
  assert.equal(foreignCredential.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE');

  const foreignServices = confinement.confinedSessionPlan({
    servicesRoot: path.win32.join(foreignRoot, 'AppData', 'Local', 'ToolsEnabled')
  });
  assert.equal(foreignServices.ok, false);
  assert.equal(foreignServices.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE');

  const foreignAccount = confinement.confinedSessionPlan({
    servicesRoot,
    account: { name: 'foreign', resolvedHome: path.win32.join(foreignRoot, '.codex') }
  });
  assert.equal(foreignAccount.ok, false);
  assert.equal(foreignAccount.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE');

  const foreignWorkspaceServices = scratch('foreign-workspace-record');
  writeRecord(foreignWorkspaceServices, 'standard', { workspace: path.win32.join(foreignRoot, 'workspace') });
  const foreignWorkspace = confinement.confinedSessionPlan({ servicesRoot: foreignWorkspaceServices });
  assert.equal(foreignWorkspace.ok, false);
  assert.equal(foreignWorkspace.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE');

  assert.throws(
    () => confinement.confinedCodexConfig(confinement.agentConfinement('guided'), {
      mcpServers: {
        foreign: { command: path.win32.join(foreignRoot, 'bin', 'server.exe'), args: [] }
      }
    }),
    error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
  );
  assert.throws(
    () => confinement.stateRootForGeneratedServers({
      TOOLSENABLED_STATE_ROOT: path.win32.join(foreignRoot, 'state')
    }),
    error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
  );
  const ownedEnvironment = { PATH: `\x43:\\Windows\\System32;${path.join(profileRoot, 'bin')}` };
  assert.equal(confinement.assertAccountProfileEnvironment(ownedEnvironment), ownedEnvironment);
  assert.throws(
    () => confinement.assertAccountProfileEnvironment({
      PATH: `\x43:\\Windows\\System32;${path.win32.join(foreignRoot, 'bin')}`,
      SAFE: 'value'
    }),
    error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT'
      && Array.isArray(error.details.variables)
      && error.details.variables.length === 1
      && error.details.variables[0] === 'PATH'
  );
  const foreignCanary = path.win32.join(foreignRoot, 'AppData', 'Roaming');
  let foreignLstatCalls = 0;
  const originalLstat = fs.lstatSync;
  try {
    fs.lstatSync = (candidate, ...args) => {
      if (path.resolve(String(candidate)).toLowerCase().startsWith(path.resolve(foreignRoot).toLowerCase())) {
        foreignLstatCalls += 1;
      }
      return originalLstat(candidate, ...args);
    };
    const confinedEnvironment = accountBoundary.accountConfinedEnvironment({
      APPDATA: foreignCanary,
      PATH: `\x43:\\Windows\\System32;${path.win32.join(foreignRoot, 'bin')}`
    }, { profileRoot });
    assert.equal(foreignLstatCalls, 0, 'foreign APPDATA/PATH are removed lexically before filesystem probing');
    assert.equal(confinedEnvironment.APPDATA, path.win32.join(profileRoot, 'AppData', 'Roaming'));
    assert.equal(confinedEnvironment.PATH.includes(path.win32.join(foreignRoot, 'bin')), false);
    assert.equal(confinedEnvironment.PATH.includes('\x43:\\Windows\\System32'), true);
    const inspected = [];
    const claude = executableFor('claude', {
      environment: confinedEnvironment,
      platform: 'win32',
      fsImpl: {
        existsSync(candidate) {
          inspected.push(path.resolve(candidate));
          return path.resolve(candidate).toLowerCase() === path.resolve(
            profileRoot, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
          ).toLowerCase();
        }
      }
    });
    assert.equal(claude.command.toLowerCase().startsWith(profileRoot.toLowerCase()), true,
      'provider discovery selects the installation-owner CLI candidate');
    assert.equal(inspected.some(candidate => candidate.toLowerCase().startsWith(foreignRoot.toLowerCase())), false,
      'provider discovery never probes a foreign-profile candidate');
  } finally {
    fs.lstatSync = originalLstat;
  }
  checks += 18;

  /* A Windows profile is an OS-owned absolute path, not necessarily a
   * <profile-root>/ child. Prove the actual launch boundary on a redirected layout
   * without opening any sibling path. The same parent spelling on another
   * drive is hostile too; customers can redirect profiles per volume. */
  const redirectedProfile = '\x44:\\Profiles\\Alice';
  const redirectedSibling = '\x44:\\Profiles\\Bob';
  const crossDriveSibling = '\x45:\\Profiles\\Mallory';
  const unrelatedWorkspace = '\x45:\\Projects\\Build';
  assert.equal(accountBoundary.sameWindowsPath('\x64:/profiles/alice/', redirectedProfile), true,
    'case, slash direction, and a trailing separator do not change a Windows profile identity');
  assert.equal(accountBoundary.sameWindowsPath('\x44:\\', '\x64:/'), true,
    'normalizing trailing separators preserves a drive-root identity');
  assert.equal(accountBoundary.sameWindowsPath('\x44:\\Profiles\\Alice.', redirectedProfile), false,
    'a trailing dot is not normalized into the owner profile identity');
  assert.equal(accountBoundary.sameWindowsPath('\x44:\\Profiles\\Alice ', redirectedProfile), false,
    'a trailing space is not normalized into the owner profile identity');
  for (const mixedPathValue of [
    `\x43:\\Windows\\System32 ${redirectedSibling}\\secret`,
    `\x43:\\Windows\\System32,${redirectedSibling}\\secret`,
    `\x43:\\Windows\\System32\t${redirectedSibling}\\secret`,
    `${redirectedProfile}\\bin \x43:\\Users\\fixture-user\\secret`,
    `\\\\fixture-files.invalid\\projects\\artifact \\\\localhost\\D$\\Profiles\\Bob\\secret`,
    `\\\\localhost\\D$\\Profiles\\Alice\\bin,\\\\localhost\\D$\\Profiles\\Bob\\secret`,
    `\\\\?\\UNC\\fixture-files.invalid\\projects\\artifact\t\\\\?\\UNC\\localhost\\D$\\Profiles\\Bob\\secret`
  ]) {
    assert.equal(accountBoundary.valueReferencesForeignProfile(mixedPathValue, redirectedProfile), true,
      `a foreign second absolute path was swallowed by an allowed first path: ${mixedPathValue}`);
  }
  assert.equal(accountBoundary.valueReferencesForeignProfile(
    '\\\\fixture-files.invalid\\projects\\one \\\\fixture-files.invalid\\projects\\two',
    redirectedProfile
  ), false, 'two ordinary remote UNC paths remain allowed data');
  assert.equal(accountBoundary.valueReferencesForeignProfile(
    '\\\\localhost\\D$\\Profiles\\Alice\\one,\\\\localhost\\D$\\Profiles\\Alice\\two',
    redirectedProfile
  ), false, 'two owned local-admin UNC paths remain owner data');
  checks += 13;
  const realRedirectedLstat = fs.lstatSync;
  const realRedirectedRealpath = fs.realpathSync.native;
  let redirectedForeignProbes = 0;
  try {
    fs.lstatSync = candidate => {
      const lowered = path.win32.normalize(String(candidate)).toLowerCase();
      if (lowered.startsWith(redirectedSibling.toLowerCase())
          || lowered.startsWith(crossDriveSibling.toLowerCase())) redirectedForeignProbes += 1;
      throw Object.assign(new Error('fixture path is lexical only'), { code: 'ENOENT' });
    };
    fs.realpathSync.native = () => {
      throw Object.assign(new Error('fixture path is lexical only'), { code: 'ENOENT' });
    };
    for (const boundary of [accountBoundary, confinement]) {
      assert.equal(boundary.assertAccountProfilePath(redirectedProfile, {
        profileRoot: redirectedProfile, requireOwnedProfile: true
      }), redirectedProfile);
      assert.equal(boundary.assertAccountProfilePath(path.win32.join(redirectedProfile, 'AppData'), {
        profileRoot: redirectedProfile, requireOwnedProfile: true
      }), path.win32.join(redirectedProfile, 'AppData'));
      for (const foreign of [redirectedSibling, crossDriveSibling, '\x43:\\Users\\fixture-user']) {
        assert.throws(
          () => boundary.assertAccountProfilePath(path.win32.join(foreign, 'secrets'), {
            profileRoot: redirectedProfile
          }),
          error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
        );
      }
      assert.equal(boundary.assertAccountProfilePath(unrelatedWorkspace, {
        profileRoot: redirectedProfile
      }), unrelatedWorkspace);
      assert.throws(
        () => boundary.assertAccountProfilePath(unrelatedWorkspace, {
          profileRoot: redirectedProfile, requireOwnedProfile: true
        }),
        error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
      );
      checks += 7;
    }

    const scrubbedRedirected = accountBoundary.accountConfinedEnvironment({
      PATH: `\x43:\\Windows\\System32;${redirectedSibling}\\bin;${crossDriveSibling}\\bin`,
      FOREIGN_HOME: redirectedSibling,
      SYSTEMROOT: '\x43:\\Windows'
    }, { profileRoot: redirectedProfile });
    assert.equal(scrubbedRedirected.USERPROFILE, redirectedProfile);
    assert.equal(scrubbedRedirected.PATH.includes(redirectedSibling), false);
    assert.equal(scrubbedRedirected.PATH.includes(crossDriveSibling), false);
    assert.equal(scrubbedRedirected.PATH.includes('\x43:\\Windows\\System32'), true);
    assert.equal(Object.hasOwn(scrubbedRedirected, 'FOREIGN_HOME'), false);
    assert.throws(
      () => confinement.assertAccountProfileEnvironment({ PATH: `${redirectedSibling}\\bin` }, redirectedProfile),
      error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT'
    );
    checks += 6;
  } finally {
    fs.lstatSync = realRedirectedLstat;
    fs.realpathSync.native = realRedirectedRealpath;
  }
  assert.equal(redirectedForeignProbes, 0,
    'redirected sibling profiles were touched before the lexical account fence refused them');
  checks += 1;
}

function aRefusalDistinguishesScrubbedFromScrubCouldNotBeEstablished() {
  const servicesRoot = scratch('scrub-distinction');
  writeRecord(servicesRoot, 'guided');
  const userCodexHome = scratch('scrub-user');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  const originalFailure = Object.assign(new Error('generation refused'), { code: 'FIXTURE_GENERATION_REFUSED' });
  const generate = () => { throw originalFailure; };

  const scrubbed = confinement.confinedSessionPlan({ servicesRoot, userCodexHome, generate });
  assert.equal(scrubbed.code, 'FIXTURE_GENERATION_REFUSED',
    'when cleanup happened, the caller must retain the refusal that triggered it');

  const configPath = path.join(servicesRoot, confinement.CONFINED_HOME_LEAF, 'guided', 'config.toml');
  fs.writeFileSync(configPath, 'stale but startable');
  const realRmSync = fs.rmSync;
  try {
    fs.rmSync = (file, options) => {
      if (file === configPath) throw Object.assign(new Error('cannot establish deletion'), { code: 'EACCES' });
      return realRmSync(file, options);
    };
    const unestablished = confinement.confinedSessionPlan({ servicesRoot, userCodexHome, generate });
    assert.equal(unestablished.code, 'AGENT_CONFINEMENT_HOME_SCRUB_INCOMPLETE',
      '"this did not remain" and "this could not be established" must be different caller answers');
  } finally {
    fs.rmSync = realRmSync;
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'stale but startable',
    'the named incomplete-scrub answer must have a real surviving artifact as its subject');
  checks += 3;
}

function aBusyCredentialCheckIsNotReportedOrLatchedAsSignedOut() {
  const servicesRoot = scratch('busy-sign-in');
  const userCodexHome = scratch('busy-sign-in-user');
  const source = path.join(userCodexHome, 'auth.json');
  fs.writeFileSync(source, '{"fixture":"still present"}');
  const realStatSync = fs.statSync;
  try {
    fs.statSync = (file, options) => {
      if (file === source) throw Object.assign(new Error('file table busy'), { code: 'EMFILE' });
      return realStatSync(file, options);
    };
    assert.equal(confinement.confinedSessionPlan({ servicesRoot, userCodexHome }).code,
      'AGENT_CONFINEMENT_SIGN_IN_UNAVAILABLE');
  } finally { fs.statSync = realStatSync; }
  const second = confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'),
    { servicesRoot, userCodexHome, record: null });
  assert.equal(second.env.CODEX_HOME, userCodexHome);
  fs.unlinkSync(source);
  const missing = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'AGENT_CONFINEMENT_SIGNED_OUT');
  assert.equal(fs.existsSync(path.join(second.agentHome, 'auth.json')), false);
  checks += 5;
}

// --- 4. the TOML this writes -------------------------------------------------

function desktopSessionReachesCodexTools() {
  const document = { mcpServers: Object.fromEntries(
    ['toolsenabled', 'toolsenabled-readonly', 'playwright', 'unrelated-server'].map(name =>
      [name, { command: process.execPath, args: [] }])) };
  const config = confinement.confinedCodexConfig(confinement.agentConfinement('standard'), document);
  const expected = process.platform === 'linux'
    ? ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY'] : [];
  for (const [name, server] of Object.entries(config.mcp_servers)) {
    assert.deepEqual(server.env_vars || [], name === 'unrelated-server' ? [] : expected);
    assert.equal(/OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN/.test(JSON.stringify(server)), false);
    checks += 2;
  }
}

function windowsPathsSurviveTheConfigWriter() {
  // A Windows path is full of backslashes. Written as a TOML BASIC string,
  // `<profile-root>/<anyone>` contains `\U` -- a unicode escape -- and Codex refuses
  // to load the file. Literal strings process no escapes, which is why they
  // are used, and this asserts the path arrives unmangled. The fixture stays
  // inside the profile this installation owns because foreign profile paths are
  // now refused before a generated config can name them.
  const profileRoot = confinement.installationProfileRoot();
  const command = path.join(profileRoot, 'AppData', 'Local', 'Programs', 'Mission Control', 'Mission Control.exe');
  const written = confinement.confinedCodexConfig(
    confinement.agentConfinement('standard'),
    {
      mcpServers: {
        toolsenabled: {
          command,
          args: [path.join(profileRoot, 'Desktop', 'tools', 'mcp-server.js')],
          cwd: path.join(profileRoot, 'Desktop'),
          /* ELECTRON_RUN_AS_NODE is part of the fixture because the writer now
             REFUSES an entry whose command is not a plain Node without it: that
             entry starts the application again instead of a server. See the
             assertion in confinedCodexConfig() and its measurement. */
          env: { ELECTRON_RUN_AS_NODE: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'system.status,task.list' }
        }
      }
    }
  );
  assert.equal(written.mcp_servers.toolsenabled.command, command);
  assert.equal(written.mcp_servers.toolsenabled.env.TOOLSENABLED_TOOL_ALLOWLIST, 'system.status,task.list');
  assert.ok(confinement.codexConfigOverrideArgs(written).some(value => value.includes(JSON.stringify(command))));
  checks += 3;

  // A value that cannot be written literally is REFUSED rather than quietly
  // re-quoted into a basic string, because switching quoting styles silently is
  // how a path with one odd character becomes a different path.
  for (const hostile of ["\x43:\\it's\\here", '\x43:\\a\nb', '\x43:\\a\r\nb']) {
    assert.throws(
      () => confinement.confinedCodexConfig(
        confinement.agentConfinement('guided'),
        { mcpServers: { toolsenabled: { command: hostile, args: [] } } }
      ),
      error => error.code === 'AGENT_CONFINEMENT_HOME_UNWRITABLE',
      `${JSON.stringify(hostile)} must be refused`
    );
    checks += 1;
  }

  // A server NAME that is not a plain identifier cannot become a TOML table
  // header either.
  assert.throws(
    () => confinement.confinedCodexConfig(
      confinement.agentConfinement('guided'),
      { mcpServers: { 'evil.name]\n[mcp_servers.escape': { command: 'node', args: [] } } }
    ),
    error => error.code === 'AGENT_CONFINEMENT_HOME_UNWRITABLE'
  );
  checks += 1;
}

// --- 4a. the runtime this file names, and the caller it declares -------------

function theConfiguredRuntimeIsThisBuildRunningAsNode() {
  /* THE DEFECT, MEASURED ON THE OWNER'S OWN MACHINE 2026-08-18. Every level's
   * confined config.toml read
   *     command = '<localappdata>\Programs\toolsenabled\ToolsEnabled.exe'
   *     args    = ['<desktop>\engine-checkout\src\mcp-server.js']
   * with no [mcp_servers.*.env] naming ELECTRON_RUN_AS_NODE anywhere in the
   * file: one installation's GUI binary, another checkout's scripts. Handed a
   * .js argument without that variable, Electron ignores the argument and boots
   * the application -- so every app-started session started three copies of the
   * app instead of three MCP servers, and had NONE of this product's own tools.
   * Measured on a staged build: no answer to `initialize`, 0 tools advertised,
   * 5 new top-level windows owned by that child; with the variable, `initialize`
   * answered, the allowlist advertised exactly, 0 windows. */

  // 1. The writer REFUSES what the generator would no longer produce, so the two
  //    cannot disagree. Negative control first: the same entry is accepted the
  //    moment the variable is present.
  const guided = confinement.agentConfinement('guided');
  const ownedProfile = confinement.installationProfileRoot();
  const packagedRoot = path.join(ownedProfile, 'AppData', 'Local', 'Programs', 'toolsenabled');
  const packaged = {
    mcpServers: {
      toolsenabled: {
        command: path.join(packagedRoot, 'ToolsEnabled.exe'),
        args: [path.join(packagedRoot, 'resources', 'capability', 'src', 'mcp-server.js')],
        cwd: path.join(packagedRoot, 'resources', 'capability')
      }
    }
  };
  assert.throws(
    () => confinement.confinedCodexConfig(guided, packaged),
    error => error.code === 'AGENT_CONFINEMENT_RUNTIME_NOT_NODE',
    'a config naming the application binary with nothing telling it to run as Node must be refused'
  );
  const repaired = {
    mcpServers: {
      toolsenabled: { ...packaged.mcpServers.toolsenabled, env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  };
  assert.equal(confinement.confinedCodexConfig(guided, repaired).mcp_servers.toolsenabled.env.ELECTRON_RUN_AS_NODE, '1');
  // A plain node runtime is untouched by any of this.
  const nativePlainNode = path.join(isolatedTemporaryRoot(), 'plain-node-runtime', 'node.exe');
  assert.ok(
    confinement.confinedCodexConfig(guided, {
      mcpServers: { toolsenabled: { command: nativePlainNode, args: [] } }
    }).mcp_servers.toolsenabled.command === nativePlainNode,
    'a native plain-Node path must be preserved verbatim'
  );
  checks += 3;

  // 2. The record handed to the generator is THIS build's, whatever the record
  //    on disk says -- and the record on disk is not rewritten.
  const engineRoot = path.resolve(__dirname, '..');
  const stale = {
    tier: 'standard',
    installRoot: '\x43:\\somewhere\\a-checkout-that-may-not-exist',
    nodePath: '\x43:\\Program Files\\an-older-install\\ToolsEnabled.exe'
  };
  const substituted = confinement.generationRecord(stale);
  assert.equal(substituted.installRoot, engineRoot, 'the generator must be given the engine that is running');
  assert.equal(substituted.nodePath, process.execPath, 'the generator must be given the runtime that is running');
  assert.equal(substituted.tier, 'standard', 'nothing else may be substituted');
  assert.equal(stale.nodePath, '\x43:\\Program Files\\an-older-install\\ToolsEnabled.exe',
    'the record itself must not be rewritten -- the workspace check reads it and means something else by it');
  checks += 4;

  // 3. And the prepared home really passes that record, and really declares the
  //    caller. Asserted through the generator seam so the two facts are read
  //    from the call rather than from the file they happen to produce.
  const servicesRoot = scratch('runtime');
  const record = writeRecord(servicesRoot, 'standard');
  const userCodexHome = scratch('user-runtime');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  let seen = null;
  confinement.prepareConfinedCodexHome(confinement.agentConfinement('standard'), {
    servicesRoot,
    userCodexHome,
    record: { ...record, nodePath: '\x43:\\Program Files\\an-older-install\\ToolsEnabled.exe' },
    generate: (given, options) => { seen = { given, options }; return { document: { mcpServers: {} } }; }
  });
  assert.equal(seen.given.nodePath, process.execPath);
  assert.equal(seen.given.installRoot, engineRoot);
  assert.equal(seen.options.agentActor, 'codex',
    'a confined Codex home must declare its caller, or the server refuses actor-bound tools in a process nobody is watching');
  checks += 3;

  /* WHERE THOSE SERVERS KEEP WHAT THEY WRITE. Measured by a two-node drive: the
   * application sets TOOLSENABLED_STATE_ROOT for the layer it starts itself, but
   * an MCP server is the CLI's child and inherits nothing, so it fell back to
   * the payload's per-user default -- a different directory. An agent registered
   * in the application's own directory file could not be found by a server
   * reading the other one. The value has to travel in the document because
   * inheritance cannot reach a grandchild, which is the same reason the tool
   * allowlist is written there. */
  const declaredRoot = path.join(servicesRoot, 'declared-state-root');
  const previousRoot = process.env.TOOLSENABLED_STATE_ROOT;
  try {
    process.env.TOOLSENABLED_STATE_ROOT = declaredRoot;
    assert.equal(confinement.stateRootForGeneratedServers(), declaredRoot);
    const stamped = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
    const written = stamped.codexConfig;
    assert.ok(stamped.servers.length > 0,
      'a recorded standard session must expose at least one server before its state-root stamps can be checked');
    for (const server of stamped.servers) {
      assert.ok(written.mcp_servers[server].env, `${server} carries no environment`);
    }
    const stampCount = Object.values(written.mcp_servers).filter(server => server.env?.TOOLSENABLED_STATE_ROOT === declaredRoot).length;
    assert.equal(stampCount, stamped.servers.length,
      'every server must be told the same records directory, or two of them disagree about where the records live');
    checks += 3 + stamped.servers.length;

    /* ABSENT MEANS NOTHING IS STAMPED, and a relative value is not silently
       accepted either -- a checkout, a test and a CLI are all in the first case
       and none of them may be able to tell this shipped. */
    delete process.env.TOOLSENABLED_STATE_ROOT;
    assert.equal(confinement.stateRootForGeneratedServers(), null);
    process.env.TOOLSENABLED_STATE_ROOT = 'not/absolute';
    assert.equal(confinement.stateRootForGeneratedServers(), null,
      'a relative value must read as absent rather than reaching the generator, which would refuse it');
    checks += 2;
  } finally {
    if (previousRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousRoot;
  }

  // 4. End to end, on a real record: the caller reaches the written file.
  const stamped = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
  const written = stamped.codexConfig;
  assert.equal(written.mcp_servers['toolsenabled'].env.TOOLSENABLED_AGENT_ACTOR, 'codex');
  assert.ok(stamped.servers.length > 0,
    'a recorded standard session must expose at least one server before its caller environment can be checked');
  for (const server of stamped.servers.filter(name => name.startsWith('toolsenabled'))) {
    assert.equal(written.mcp_servers[server].env.TOOLSENABLED_AGENT_ACTOR, 'codex',
      `${server} must carry the authenticated caller metadata`);
  }
  if (stamped.servers.includes('playwright')) {
    assert.equal(Object.keys(written.mcp_servers.playwright.env || {}).some(key =>
      /^TOOLSENABLED_AGENT_(?:ACTOR|ID|SESSION_CREDENTIAL)$/.test(key)), false);
  }
  checks += 2 + stamped.servers.filter(name => name.startsWith('toolsenabled')).length
    + Number(stamped.servers.includes('playwright'));
}

// --- 4b. the pin a differently-cased variable must not defeat ---------------

function theConfinedHomePinSurvivesACasedParentVariable() {
  /* WINDOWS ENVIRONMENT VARIABLES ARE CASE-INSENSITIVE; JAVASCRIPT OBJECT KEYS
   * ARE NOT. The agent host builds a confined child's environment as
   * `{ ...process.env, ...plan.env }` with plan.env = { CODEX_HOME: <our home> }.
   * If the parent already carries `codex_home`, that object holds BOTH spellings
   * and only the spawn decides which one the child can read. If the parent's
   * spelling won, the entire MCP-isolation half of this lane would be bypassable
   * by anyone able to set an environment variable -- no code change, no elevation.
   *
   * This case class is not hypothetical: the session-env-scrub lane found the
   * billing scrub genuinely bypassable this way, because DELETING `X` leaves a
   * lowercase `x` in the object and the child still reads it. Deleting and
   * PINNING are different operations, so their result does not transfer to this
   * one by reasoning -- it had to be measured.
   *
   * MEASURED, both orders, four spellings: the pin holds. The rule is that among
   * duplicate spellings the one sorting FIRST in ASCII wins, and an all-uppercase
   * name always sorts before any mixed- or lower-case variant -- verified
   * directly, `Codex_Home` beats `codex_home` in either insertion order, and
   * `CODEX_HOME` beats both. So the canonical spelling this code uses is safe by
   * a rule rather than by luck. That is the property pinned here, because a
   * future refactor that renamed the pin to a non-canonical spelling would still
   * look correct and would silently become defeatable.
   *
   * ASSERTED ON A REAL SPAWNED CHILD. Asserting on the constructed object would
   * verify this suite's own bookkeeping and not what a process can actually read,
   * which is the only thing that matters here. */
  const { spawnSync } = require('node:child_process');
  const ours = path.join(scratch('pin'), 'confined-home');
  const theirs = path.join(scratch('pin'), 'escape-hatch');

  function childReads(environment) {
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CODEX_HOME || "(none)")'],
      { env: environment, encoding: 'utf8', windowsHide: true }
    );
    return result.stdout;
  }

  for (const spelling of ['CODEX_HOME', 'codex_home', 'Codex_Home', 'CODEX_home']) {
    const parent = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'CODEX_HOME') parent[key] = value;
    }
    parent[spelling] = theirs;
    // Exactly the construction shell/agent-host.cjs performs for a confined
    // session: the parent first, our pin last.
    assert.equal(childReads({ ...parent, CODEX_HOME: ours }), ours,
      `a parent '${spelling}' defeated the confined home pin`);
    checks += 1;

    /* The reverse order is asserted ONLY for a spelling that differs from ours,
     * and the exclusion is the point rather than an omission. When the parent
     * uses the SAME spelling, `{ CODEX_HOME: ours, ...parent }` is ordinary key
     * overwrite -- one key, last write wins -- which says nothing about casing
     * and is not what the host builds anyway. Asserting it there would fail for
     * a reason unrelated to what this test is about, which is exactly what it
     * did when first written. Where the spellings DIFFER the object genuinely
     * carries two keys and only the spawn can arbitrate, so order is a real
     * variable and worth pinning. */
    if (spelling !== 'CODEX_HOME') {
      assert.equal(childReads({ CODEX_HOME: ours, ...parent }), ours,
        `a parent '${spelling}' defeated the confined home pin when it came last`);
      checks += 1;
    }
  }
}

// --- 5. the dispatched-worker lane ------------------------------------------

function laneArgumentsCarryTheSameCeiling() {
  const tier = { model: 'm', effort: 'e', cliModel: 'cm' };
  const sessions = {
    full: { origin: 'local', tier: 'full' },
    guided: { origin: 'local', tier: 'confined', profile: 'read-only' },
    standard: { origin: 'local', tier: 'confined', profile: 'workspace' }
  };

  // The unrestricted lane is UNCHANGED, byte for byte. This is the assertion
  // that confinement cost nothing to the user who chose to have nothing taken
  // away -- and the one that would catch a refactor quietly rewriting the lane
  // that works today.
  const full = codexArgs({ root: '\x43:/root', tier, permissionSession: sessions.full });
  assert.deepEqual(full.slice(0, 2), ['exec', '--dangerously-bypass-approvals-and-sandbox']);
  assert.ok(!full.includes('--sandbox'));
  assert.ok(claudeArgs({ root: '\x43:/root', tier, permissionSession: sessions.full }).includes('--dangerously-skip-permissions'));
  checks += 3;

  for (const [level, session] of [['guided', sessions.guided], ['standard', sessions.standard]]) {
    const want = confinement.agentConfinement(level);
    const codex = codexArgs({ root: '\x43:/root', tier, permissionSession: session });
    assert.deepEqual(codex.slice(0, 3), ['exec', '--sandbox', want.sandbox], `${level} codex sandbox`);
    assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'), `${level} must not bypass`);
    const claude = claudeArgs({ root: '\x43:/root', tier, permissionSession: session });
    assert.ok(!claude.includes('--dangerously-skip-permissions'), `${level} must not skip permissions`);
    assert.equal(claude[claude.indexOf('--permission-mode') + 1], want.claudePermissionMode, `${level} claude mode`);
    checks += 4;
  }

  // `--add-dir PRODUCT_ROOT` REACHES ONLY THE UNRESTRICTED LANE (1.0.50 review
  // of fixes, 2.1). The flag gives the product's own checkout the same file
  // access as the working directory, and the standard profile runs
  // acceptEdits with Edit and Write; since M1 a confined lane loads nothing
  // from there, so for it the flag was pure reach over the engine's own code.
  // The dispatch root is a sibling of the checkout, so the "root already
  // covers the checkout" omission cannot be what keeps the flag away.
  const productRoot = path.resolve(__dirname, '..');
  const rootOutsideProduct = path.join(path.dirname(productRoot), `not-the-checkout-${process.pid}`);
  assert.ok(path.relative(productRoot, rootOutsideProduct).startsWith('..'), 'the probe root must sit outside PRODUCT_ROOT');
  const unrestricted = claudeArgs({ root: rootOutsideProduct, tier, permissionSession: sessions.full });
  assert.equal(unrestricted[unrestricted.indexOf('--add-dir') + 1], productRoot,
    'the unrestricted lane is still told where the checkout is');
  for (const [level, session] of [['guided', sessions.guided], ['standard', sessions.standard]]) {
    const claude = claudeArgs({ root: rootOutsideProduct, tier, permissionSession: session });
    assert.ok(!claude.includes('--add-dir'), `${level} lane must not be handed the product checkout as an added directory: ${claude.join(' ')}`);
    assert.ok(!claude.includes(productRoot), `${level} lane argv must not name PRODUCT_ROOT at all`);
    checks += 2;
  }
  checks += 2;

  // A remote caller cannot borrow a spawn lane by naming a tier.
  for (const session of [{ origin: 'remote', tier: 'guarded' }, { origin: 'remote', tier: 'confined', profile: 'workspace' }]) {
    assert.throws(
      () => codexArgs({ root: '\x43:/root', tier, permissionSession: session }),
      error => typeof error.code === 'string' && error.code.startsWith('PERMISSION_'),
      `remote ${session.tier} must be refused a worker`
    );
    checks += 1;
  }

  // AN OMITTED SESSION MUST REFUSE, NOT SPAWN UNSANDBOXED.
  //
  // Both builders defaulted permissionSession to {origin:'local',tier:'full'}.
  // laneConfinement() returns null for local/full, and null is what selects
  // --dangerously-bypass-approvals-and-sandbox, so an ABSENT session emitted
  // the most dangerous argv this product has.
  //
  // executeTool()'s refusal cannot reach this: a destructured default fires on
  // `undefined` before the callee ever runs, and the consequence here is an
  // unsandboxed OS process rather than one refused tool call.
  //
  // Measured when this was written: reintroducing that default left FIVE
  // suites green -- this one, guarded-permission-tier, r1152-sandbox-progress,
  // permission-session-chokepoint and install-tier-enforcement. Nothing in the
  // tree objected. The assertions below are the ones that do, and they are
  // deliberately phrased as "absence refuses" rather than "the default is
  // gone", because the next form of this bug will not be spelled the same way.
  for (const [label, build] of [['codexArgs', codexArgs], ['claudeArgs', claudeArgs]]) {
    assert.throws(
      () => build({ root: '\x43:/root', tier }),
      error => typeof error.code === 'string' && error.code.startsWith('PERMISSION_'),
      `${label} with NO permission session must refuse; a default here spawns an unsandboxed agent`
    );
    assert.throws(
      () => build({ root: '\x43:/root', tier, permissionSession: undefined }),
      error => typeof error.code === 'string' && error.code.startsWith('PERMISSION_'),
      `${label} with an explicitly undefined session must refuse exactly as an omitted one does`
    );
    checks += 2;
  }
}

// --- 6. the stdio broker's own ceiling --------------------------------------

function theStdioBrokerAlwaysBindsASession() {
  // src/lib/tool-registry.js runs its tier check only when a permissionSession
  // is present, and src/mcp-server.js start() never set one -- so the check was
  // dead on the local path. The postcondition asserted here is the fix: the
  // resolver has NO branch that returns undefined.
  const { resolvePermissionSession } = require('../src/mcp-server');
  const absent = { machineRecord: { resolveServicesRoot: () => scratch('broker'), readMachineRecord: () => null } };
  const unreadable = {
    machineRecord: {
      resolveServicesRoot: () => scratch('broker2'),
      readMachineRecord: () => { const error = new Error('nope'); error.code = 'SETUP_MACHINE_RECORD_MALFORMED'; throw error; }
    }
  };
  for (const [label, options] of [['absent', absent], ['unreadable', unreadable]]) {
    const session = resolvePermissionSession(options);
    assert.notEqual(session, undefined, `${label} must not produce an unbounded session`);
    assert.equal(session.tier, 'confined', `${label} tier`);
    assert.equal(session.profile, 'read-only', `${label} profile`);
    assert.equal(session.origin, 'local', `${label} origin`);
    checks += 4;
  }

  // A recorded level is honoured, and an explicit session still wins so the two
  // remote bridges keep the sessions they construct.
  const servicesRoot = scratch('broker3');
  writeRecord(servicesRoot, 'unrestricted');
  const honoured = resolvePermissionSession({
    machineRecord: { resolveServicesRoot: () => servicesRoot, readMachineRecord: machineRecord.readMachineRecord }
  });
  assert.equal(honoured.tier, 'full');
  const explicit = resolvePermissionSession({ permissionSession: { origin: 'remote', tier: 'guarded' } });
  assert.deepEqual(explicit, { origin: 'remote', tier: 'guarded' });
  checks += 2;
}

function longSessionHomesKeepWindowsDatabasesCompactAndIsolated() {
  const servicesRoot = scratch('sqlite-session');
  const userCodexHome = path.join(scratch('sqlite-signin'), 'a'.repeat(120));
  fs.mkdirSync(userCodexHome);
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"fixture":"inert sign-in"}');
  const prepare = (sessionId, tier = 'unrestricted') =>
    confinement.prepareConfinedCodexHome(confinement.agentConfinement(tier), {
      servicesRoot, userCodexHome, sessionId,
      agentId: 'coordinator-' + 'a'.repeat(50)
    });
  const first = prepare('session-one'), next = prepare('session-two'), guided = prepare('session-one', 'guided');
  for (const plan of [first, next, guided]) {
    const database = plan.codexConfig.sqlite_home;
    assert.equal(plan.env.CODEX_HOME, userCodexHome);
    assert.equal(plan.codexConfig.approval_policy, 'never');
    assert.equal(database, first.codexConfig.sqlite_home, 'native history must survive a fresh app session authority');
    assert.ok(fs.statSync(database).isDirectory());
    if (process.platform === 'win32') {
      assert.ok(userCodexHome.length > 220, 'fixture must reproduce a long official account home');
      assert.ok(database.length <= 220);
      assert.equal(path.dirname(database), path.join(servicesRoot, 'agent-db'));
      assert.notEqual(database, userCodexHome);
      checks += 4;
    } else {
      assert.equal(database, userCodexHome);
      checks++;
    }
    checks += 4;
  }
  const otherHome = path.join(scratch('sqlite-other-signin'), 'b'.repeat(120));
  fs.mkdirSync(otherHome);
  fs.writeFileSync(path.join(otherHome, 'auth.json'), '{"fixture":"separate official account"}');
  const other = confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'), {
    servicesRoot, userCodexHome: otherHome, accountName: 'separate-account' });
  assert.notEqual(other.codexConfig.sqlite_home, first.codexConfig.sqlite_home);
  assert.equal(first.codexConfig.sandbox_mode, 'danger-full-access');
  assert.equal(guided.codexConfig.sandbox_mode, 'read-only');
  checks += 3;
}

function roleScopedProvidersCannotInheritNativeAuthority() {
  const servicesRoot = scratch('role-tools');
  writeRecord(servicesRoot, 'unrestricted');
  const userCodexHome = scratch('role-tools-signin');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture-only"}}');
  const plan = confinement.confinedSessionPlan({ servicesRoot, userCodexHome,
    agentId: 'custom-reader', roleFunctionsOnly: true });
  assert.equal(plan.ok, true, plan.code);
  assert.equal(plan.tier, 'unrestricted', 'the owner permission tier is not changed');
  assert.equal(plan.roleFunctionsOnly, true);
  assert.equal(plan.threadOptions.sandbox, 'read-only');
  assert.deepEqual([...plan.servers], ['toolsenabled-readonly', 'toolsenabled']);
  const config = plan.codexConfig;
  assert.equal(config.sandbox_mode, 'read-only');
  assert.equal(config.features.code_mode_host, true);
  assert.equal(Object.values(config.mcp_servers).filter(server => server.default_tools_approval_mode === 'approve').length, 2);
  for (const name of ['shell_tool', 'unified_exec', 'apps', 'computer_use', 'browser_use', 'multi_agent', 'hooks', 'plugins']) {
    assert.equal(config.features[name], false, name + ' must be disabled');
    checks++;
  }
  const claude = confinement.claudeToolsSessionPlan({ servicesRoot, roleFunctionsOnly: true, agentId: 'custom-reader' });
  assert.equal(claude.ok, true, claude.code);
  assert.equal(claude.roleFunctionsOnly, true);
  assert.ok(!claude.servers.includes('playwright'));
  assert.equal(JSON.parse(fs.readFileSync(claude.settings, 'utf8')).disableAllHooks, true);
  assert.equal(confinement.confinedSessionPlan({ servicesRoot, roleFunctionsOnly: 'true' }).ok, false);
  checks += 13;
}

function privateCodexSignInStaysInPlaceWithoutCredentialCustody() {
  const isolation = require('../src/lib/provider-session-isolation');
  const privateRoot = scratch('private-codex');
  fs.chmodSync(privateRoot, 0o700);
  const stateRoot = path.join(privateRoot, 'ToolsEnabled-Test', 'capability');
  const names = ['TOOLSENABLED_PROVIDER_ISOLATION_ROOT', 'TOOLSENABLED_STATE_ROOT'];
  const previous = names.map(name => [name, process.env[name]]);
  try {
    process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = privateRoot;
    process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
    const context = isolation.isolationContext();
    const userCodexHome = path.join(context.servicesRoot, 'account-homes', 'codex', 'selected');
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"fixture":"private official sign-in"}');
    const options = { servicesRoot: context.servicesRoot, userCodexHome, accountName: 'selected',
      accountHome: context.userProfile, record: null };
    const prepare = values => confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'), values);
    const original = Object.fromEntries(['linkSync', 'copyFileSync', 'readFileSync'].map(name => [name, fs[name]]));
    let plan;
    try {
      for (const name of Object.keys(original)) fs[name] = (...args) => {
        if (args.slice(0, name === 'readFileSync' ? 1 : 2).some(file =>
          typeof file === 'string' && path.basename(file) === 'auth.json')) assert.fail(name + ' touched private sign-in');
        return original[name](...args);
      };
      plan = prepare(options);
    } finally { for (const name of Object.keys(original)) fs[name] = original[name]; }
    assert.equal(plan.env.CODEX_HOME, userCodexHome);
    assert.equal(plan.codexConfig.cli_auth_credentials_store, 'file');
    assert.equal(fs.existsSync(path.join(plan.agentHome, 'auth.json')), false);
    assert.throws(() => prepare({ ...options, accountName: null }),
      error => error.code === 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED');
    assert.throws(() => prepare({ ...options, userCodexHome: path.dirname(privateRoot) }),
      error => error.code === 'AGENT_PROVIDER_ISOLATION_PATH');
    const outside = path.join(path.dirname(privateRoot), path.basename(privateRoot) + '-outside-auth');
    try {
      fs.linkSync(path.join(userCodexHome, 'auth.json'), outside);
      assert.throws(() => prepare(options), error => error.code === 'AGENT_PROVIDER_ISOLATION_PATH');
    } finally { fs.rmSync(outside, { force: true }); }
    checks += 6;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

function theSessionCredentialNeverReachesTheCodexCommandLine() {
  // The confined surface is passed to Codex as -c overrides on its command line, which any local process can read.
  // The agent's session credential must travel only in the Codex process environment, forwarded by name.
  const servicesRoot = scratch('session-credential');
  writeRecord(servicesRoot, 'standard');
  const userCodexHome = scratch('session-credential-signin');
  fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"fixture":"official sign-in stays here"}');
  const credential = require('node:crypto').randomBytes(32).toString('base64url');
  const plan = confinement.confinedSessionPlan({ servicesRoot, userCodexHome, agentId: 'credential-agent',
    sessionId: 'session-credential-test', sessionCredential: credential });
  assert.equal(plan.ok, true, plan.code);
  assert.equal(plan.codexArgs.some(arg => String(arg).includes(credential)), false,
    'the session credential was written into the Codex command line');
  assert.equal(plan.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL === credential, true,
    'the session credential must reach Codex through its environment');
  const server = plan.codexConfig.mcp_servers.toolsenabled;
  assert.ok(Array.isArray(server.env_vars) && server.env_vars.includes('TOOLSENABLED_AGENT_SESSION_CREDENTIAL'),
    'the tool server must receive the credential by name');
  assert.equal(server.env && Object.prototype.hasOwnProperty.call(server.env, 'TOOLSENABLED_AGENT_SESSION_CREDENTIAL'), false);
  checks += 4;
}

function main() {
  let results = 0, skipped = 0;
  // Each step is one TAP result; the Windows-only profile cases are a declared TAP skip elsewhere.
  const step = fn => { fn(); results += 1; process.stdout.write(`ok ${results + skipped} - ${fn.name}\n`); };
  try {
    step(levelsMapToOneConfinement);
    step(roleScopedProvidersCannotInheritNativeAuthority);
    step(theSessionCredentialNeverReachesTheCodexCommandLine);
    step(unreadableLevelsRefuse);
    step(unreadableRecordsFailClosedToTheNarrowestSession);
    step(preparedHomeCarriesOnlyWhatTheLevelPermits);
    step(privateCodexSignInStaysInPlaceWithoutCredentialCustody);
    step(longSessionHomesKeepWindowsDatabasesCompactAndIsolated);
    step(accountFenceFollowsEveryGeneratedCodexHome);
    step(accountProfileIsPinnedAndForeignRootsRefuseBeforePreparation);
    if (windowsProfileCasesSkipped) {
      skipped += 1;
      process.stdout.write(`ok ${results + skipped} - Windows profile alias, drive and provider-discovery cases # SKIP requires native Windows\n`);
    }
    step(aRefusalDistinguishesScrubbedFromScrubCouldNotBeEstablished);
    step(aBusyCredentialCheckIsNotReportedOrLatchedAsSignedOut);
    step(desktopSessionReachesCodexTools);
    step(windowsPathsSurviveTheConfigWriter);
    step(theConfiguredRuntimeIsThisBuildRunningAsNode);
    step(theConfinedHomePinSurvivesACasedParentVariable);
    step(laneArgumentsCarryTheSameCeiling);
    step(theStdioBrokerAlwaysBindsASession);
  } finally {
    for (const directory of temporary) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
  }
  /* The strict runner (tools/lib/test-completion.js) reads `ok N - ` lines as TAP and certifies a run
     only with its plan and the seven summary counts, skips included. A failing check throws before this
     point, so a stream without the summary still reports a failed run. */
  const total = results + skipped;
  process.stdout.write(`1..${total}\n# tests ${total}\n# suites 0\n# pass ${results}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`);
  console.log(`Agent session confinement tests passed (${checks} checks, ${policy.INSTALL_TIERS.length} levels bound to real sessions).`);
}

main();
