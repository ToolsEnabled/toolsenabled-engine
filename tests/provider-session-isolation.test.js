'use strict';

// Real private Node peers speak only the startup protocol and record their
// actual environment/argv. No provider CLI, real credential, network or turn is
// used. Separate DEV and synthetic LIVE canaries are observed on disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate, isolatedTemporaryRoot } = require('./lib/isolated-environment');
activate('provider-session-isolation');
const isolation = require('../src/lib/provider-session-isolation');
const confinement = require('../src/lib/agent-session-confinement');
const rotation = require('../src/lib/multi-account/rotation');
const registryWrite = require('../src/lib/multi-account/registry-write');
const { startCodexSession, detectCodexVersion } = require('../src/lib/agent-engine/codex-process');
const roots = [], sessions = [];

async function closeAndConfirm(session) {
  // close() requests termination synchronously. On Windows the retained Job
  // wrapper can still hold cwd after the provider exits, so await both the
  // owned empty-job receipt and its actual native exit before removing files.
  const transport = session.adapter.transport;
  let timer, unsubscribe;
  const exited = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Private provider wrapper did not exit')), 15000);
    unsubscribe = transport.onData((chunk, exit) => {
      if (chunk === null && exit) resolve(exit);
    });
  });
  exited.catch(() => {});
  try {
    session.close();
    if (process.platform === 'win32') {
      const receipt = await transport.closeForStartupFailure(15000);
      assert.equal(receipt.activeProcesses, 0);
      assert.ok(['exit', 'terminated'].includes(receipt.type));
    }
    assert.equal((await exited).error, null);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'te-private-provider-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const env = { ...process.env, TOOLSENABLED_PROVIDER_ISOLATION_ROOT: root,
    TOOLSENABLED_STATE_ROOT: path.join(root, 'ToolsEnabled-Development', 'capability') };
  for (const key of Object.keys(env)) if (['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME'].includes(key.toUpperCase())) delete env[key];
  const context = isolation.isolationContext(env);
  const home = path.join(context.servicesRoot, 'account-homes', 'codex', 'development');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'));
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fixture":"private account"}');
  Object.assign(env, isolation.profileEnvironment(context), { CODEX_HOME: home });
  const registry = path.join(context.stateRoot, 'config', 'accounts.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  return { root, env, context, home, registry };
}

async function ambient(machine, run) {
  const names = [...Object.keys(isolation.profileEnvironment(machine.context)), 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME'];
  const previous = names.map(name => [name, process.env[name]]);
  Object.assign(process.env, isolation.profileEnvironment(machine.context));
  for (const name of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','GROK_HOME']) delete process.env[name];
  try { return await run(); }
  finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

function peer() {
  const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
  const version = process.argv.includes('--version');
  const pins = ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','CODEX_HOME','npm_config_cache','npm_config_prefix','TOOLSENABLED_STATE_ROOT'];
  const observed = Object.fromEntries(pins.map(name => [name, process.env[name]]));
  observed.argv = process.argv.slice(2); observed.pid = process.pid;
  observed.leaked = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','NODE_OPTIONS','BASH_ENV','GOOGLE_APPLICATION_CREDENTIALS'].filter(name => process.env[name]);
  fs.mkdirSync(process.env.HOME, { recursive:true });
  fs.writeFileSync(path.join(process.env.HOME, version ? 'version-observed.json' : 'start-observed.json'), JSON.stringify(observed));
  for (const name of ['APPDATA','XDG_CACHE_HOME','CODEX_HOME']) {
    fs.mkdirSync(process.env[name], { recursive:true });
    fs.writeFileSync(path.join(process.env[name], 'private-peer-write.txt'), process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT);
  }
  if (version) { process.stdout.write('codex-cli 0.146.0\n'); return; }
  const input = readline.createInterface({ input:process.stdin });
  input.on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === 'initialize' ? { userAgent:'private-peer', codexHome:process.env.CODEX_HOME, platformFamily:'test', platformOs:'test' }
      : request.method === 'thread/start' ? { thread:{ id:'private-thread' } } : {};
    process.stdout.write(JSON.stringify({ id:request.id, result }) + '\n');
  });
}

function installPeer(machine) {
  const prefix = path.join(machine.context.userProfile, '.npm-global');
  const leaf = process.platform === 'win32'
    ? path.join(prefix,'node_modules','@openai','codex','bin','codex.js')
    : path.join(prefix,'lib','node_modules','private-peer','codex.js');
  fs.mkdirSync(path.dirname(leaf), { recursive:true });
  fs.writeFileSync(leaf, `#!${process.execPath}\n(${peer.toString()})();\n`, { mode:0o700 });
  if (process.platform !== 'win32') {
    const bin = path.join(prefix,'bin');
    fs.mkdirSync(bin, { recursive:true });
    fs.symlinkSync('../lib/node_modules/private-peer/codex.js', path.join(bin,'codex'));
  }
  return leaf;
}

async function main() {
  assert.equal(isolation.PROVIDER_SESSION_ISOLATION_VERSION,1);
  assert.equal(confinement.PROVIDER_SESSION_ISOLATION_VERSION,1);
  assert.equal(Object.isFrozen(isolation),true);
  const unchanged = { HOME:'/a-normal-live-profile', CUSTOM:'preserved' };
  assert.equal(isolation.providerSessionEnvironment(unchanged),unchanged);
  assert.equal(isolation.resolvePrivateProviderExecutable('codex',unchanged),null);
  const first = fixture(), second = fixture(), live = fixture();
  const liveCanary = path.join(live.home,'auth.json'), liveBefore = fs.readFileSync(liveCanary,'utf8');
  const hostile = { ...first.env, HOME:live.context.userProfile, APPDATA:live.context.appData,
    npm_config_prefix:live.root, NPM_CONFIG_CACHE:live.root, NPM_CONFIG_GLOBAL:'true',
    OPENAI_API_KEY:'fixture', anthropic_api_key:'fixture', GOOGLE_APPLICATION_CREDENTIALS:liveCanary,
    NODE_OPTIONS:'--require outside', BASH_ENV:'/outside', GIT_CONFIG_GLOBAL:'/outside', GIT_CONFIG_COUNT:'1', LD_PRELOAD:'/outside' };
  const privateEnv = isolation.providerSessionEnvironment(hostile,{ provider:'codex',requireHome:true,create:true });
  assert.equal(privateEnv.HOME,path.join(first.root,'userprofile'));
  assert.equal(privateEnv.APPDATA,path.join(first.root,'userprofile','AppData','Roaming'));
  assert.equal(privateEnv.LOCALAPPDATA,path.join(first.root,'localappdata'));
  assert.equal(privateEnv.npm_config_prefix,path.join(first.root,'userprofile','.npm-global'));
  assert.equal(privateEnv.npm_config_cache,path.join(first.root,'localappdata','cache','npm'));
  assert.equal(privateEnv.CLAUDE_CODE_TMPDIR,path.join(first.root,'temp'));
  assert.equal(privateEnv.GEMINI_FORCE_FILE_STORAGE,'true');
  const claudeEnv = isolation.providerSessionEnvironment({ ...first.env,CLAUDE_SECURESTORAGE_CONFIG_DIR:live.home },
    { provider:'claude',home:path.join(first.root,'private-claude'),requireHome:true });
  assert.equal(claudeEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR,path.join(first.root,'private-claude'));
  assert.throws(() => isolation.assertProviderSessionEnvironment({ ...claudeEnv,CLAUDE_SECURESTORAGE_CONFIG_DIR:live.home }),
    { code:'AGENT_PROVIDER_ISOLATION_ENVIRONMENT' });
  const geminiHome = path.join(first.root,'private-gemini');
  fs.mkdirSync(path.join(geminiHome,'.gemini'),{ recursive:true });
  fs.linkSync(liveCanary,path.join(geminiHome,'.gemini','gemini-credentials.json'));
  assert.throws(() => isolation.providerSessionEnvironment(first.env,{ provider:'gemini',home:geminiHome,requireHome:true }),
    { code:'AGENT_PROVIDER_ISOLATION_PATH' });
  fs.unlinkSync(path.join(geminiHome,'.gemini','gemini-credentials.json'));
  const grokHome = path.join(first.context.servicesRoot, 'account-homes', 'grok', 'private');
  fs.mkdirSync(grokHome, { recursive: true });
  const grokEnv = isolation.providerSessionEnvironment(first.env, { provider: 'grok', home: grokHome, requireHome: true });
  assert.equal(grokEnv.GROK_HOME, grokHome, 'Grok sign-in and refresh use the selected private account');
  assert.equal(grokEnv.HOME, first.context.userProfile);
  assert.throws(() => isolation.providerSessionEnvironment(first.env, { provider: 'grok', requireHome: true }),
    { code: 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED' });
  assert.throws(() => isolation.providerSessionEnvironment({ ...first.env, GROK_HOME: live.home }),
    { code: 'AGENT_PROVIDER_ISOLATION_PATH' });
  fs.linkSync(liveCanary, path.join(grokHome, 'auth.json'));
  assert.throws(() => isolation.providerSessionEnvironment(first.env, { provider: 'grok', home: grokHome, requireHome: true }),
    { code: 'AGENT_PROVIDER_ISOLATION_PATH' });
  fs.unlinkSync(path.join(grokHome, 'auth.json'));
  fs.writeFileSync(path.join(grokHome, 'auth.json'), '{"fixture":"independent Grok account"}');
  isolation.providerSessionEnvironment(first.env, { provider: 'grok', home: grokHome, requireHome: true });
  assert.throws(() => isolation.assertProviderSessionEnvironment({ ...grokEnv, GROK_HOME: live.home }),
    { code: 'AGENT_PROVIDER_ISOLATION_PATH' });
  const grokPrefix = isolation.profileEnvironment(first.context).npm_config_prefix;
  const grokEntry = path.join(grokPrefix, ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules', '@xai-official', 'grok', 'bin', 'grok');
  fs.mkdirSync(path.dirname(grokEntry), { recursive: true });
  fs.writeFileSync(grokEntry, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(grokPrefix, 'bin'), { recursive: true });
    fs.symlinkSync('../lib/node_modules/@xai-official/grok/bin/grok', path.join(grokPrefix, 'bin', 'grok'));
  }
  const grokExecutable = isolation.resolvePrivateProviderExecutable('grok', grokEnv);
  assert.equal(grokExecutable.executablePath, grokEntry, 'a private npm Grok install is recognized');
  assert.deepEqual(grokExecutable.prefixArgs, process.platform === 'win32' ? [grokEntry] : []);
  assert.throws(() => isolation.resolvePrivateProviderExecutable('grok', second.env),
    { code: 'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED' });
  for (const key of ['OPENAI_API_KEY','anthropic_api_key','GOOGLE_APPLICATION_CREDENTIALS','NODE_OPTIONS','BASH_ENV','GIT_CONFIG_COUNT','LD_PRELOAD','NPM_CONFIG_GLOBAL','NPM_CONFIG_CACHE']) assert.equal(Object.hasOwn(privateEnv,key),false,key);
  isolation.assertProviderSessionEnvironment(privateEnv);
  assert.throws(() => isolation.assertProviderSessionEnvironment({ ...privateEnv,HOME:live.root }),{ code:'AGENT_PROVIDER_ISOLATION_ENVIRONMENT' });
  assert.throws(() => isolation.providerSessionEnvironment(first.env,{ provider:'codex',home:live.home }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  assert.throws(() => isolation.providerSessionEnvironment({ ...first.env,CODEX_HOME:'' },{ provider:'codex',requireHome:true }),{ code:'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED' });
  assert.throws(() => isolation.isolationContext({ ...first.env,TOOLSENABLED_STATE_ROOT:second.context.stateRoot }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  assert.throws(() => isolation.isolationContext(first.env,{ servicesRoot:second.context.servicesRoot }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  assert.throws(() => isolation.codexFileCredentialArgs(['-c','cli_auth_credentials_store="keyring"','app-server'],first.env),{ code:'AGENT_PROVIDER_ISOLATION_CREDENTIAL_STORE' });
  console.log('PASS private profile, state, billing/hooks, npm cache, and file-store policy');

  await ambient(first,async () => {
    assert.throws(() => require('../src/lib/agent-engine/claude-process').createClaudeAcpTransport(),
      { code:'AGENT_PROVIDER_ISOLATION_TRANSPORT_UNSUPPORTED' });
    assert.throws(() => isolation.isolationContext(second.env),{ code:'AGENT_PROVIDER_ISOLATION_INVALID' });
    assert.throws(() => isolation.providerSessionEnvironment({ CODEX_HOME:live.home }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
    let probes = 0;
    const choose = () => rotation.resolveAccountForSession({ provider:'codex',servicesRoot:first.context.servicesRoot,
      probe:async () => { probes++; throw new Error('must never probe'); } });
    assert.equal((await choose()).blocked,true,'missing registry used the default account');
    fs.writeFileSync(first.registry,'{corrupt');
    assert.equal((await choose()).blocked,true,'corrupt registry used the default account');
    fs.writeFileSync(first.registry,JSON.stringify({ accounts:[{ name:'outside',provider:'codex',profileDir:live.home,priority:1 }] }));
    assert.equal((await choose()).blocked,true,'foreign account used the default account');
    assert.equal((await rotation.readAccountUsage({ registryPath:first.registry })).ok,false);
    assert.equal(probes,0);
    assert.throws(() => registryWrite.removeAccount({ name:'outside',configPath:first.registry }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
    assert.equal(fs.readFileSync(liveCanary,'utf8'),liveBefore);
    assert.throws(() => registryWrite.addAccount({ name:'outside',configPath:first.registry,homesRoot:live.root }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
    fs.unlinkSync(first.registry);
    const account = registryWrite.addAccount({ name:'private',configPath:first.registry });
    assert.equal(account.home,path.join(first.context.stateRoot,'codex-homes','private'));
    assert.deepEqual(fs.readdirSync(account.home),[]);
    const preflight = confinement.preflightSessionPlan({ provider:'codex',servicesRoot:first.context.servicesRoot,agentApiMode:'Enabled' });
    assert.equal(preflight.ok,true);
    assert.equal(preflight.prepared,false);
    assert.equal(preflight.env.HOME,first.context.userProfile);
    assert.equal(confinement.confinedSessionPlan({ servicesRoot:first.context.servicesRoot,agentApiMode:'Enabled' }).code,'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED');
  });
  console.log('PASS missing/corrupt/foreign account refusal, private add/remove, non-startable preflight');

  await ambient(first, async () => {
    const machineRecord = require('../src/lib/setup/machine-record');
    const record = machineRecord.buildMachineRecord({ tier: 'unrestricted', installRoot: path.resolve(__dirname, '..'),
      servicesRoot: first.context.servicesRoot, nodePath: process.execPath, workspaceRoots: [path.join(first.root, 'workspace')] });
    machineRecord.writeMachineRecord(record, { servicesRoot: first.context.servicesRoot });
    assert.equal(typeof confinement.localSessionPlan, 'function', 'Local needs its own account-free shared planner entry');
    const credential = 'A'.repeat(43);
    for (const agentApiMode of ['Only', 'Enabled', 'Disabled']) {
      const options = { servicesRoot: first.context.servicesRoot, agentApiMode, agentId: 'local-worker',
        sessionId: `local-${agentApiMode.toLowerCase()}`, sessionCredential: credential };
      const plan = confinement.localSessionPlan(options);
      assert.equal(plan.ok, true, plan.code);
      assert.equal(plan.account, null);
      assert.equal(plan.agentApiMode, agentApiMode);
      assert.equal(plan.threadOptions.sandbox, agentApiMode === 'Only' ? 'read-only' : 'danger-full-access');
      assert.equal(plan.env.HOME, first.context.userProfile);
      for (const key of ['configDir', 'settings', 'codexHome', 'claudePermissionMode']) assert.equal(Object.hasOwn(plan, key), false, key);
      for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME']) assert.equal(Object.hasOwn(plan.env, key), false, key);
      isolation.assertIsolatedPath(plan.mcpConfig, first.context);
      const document = JSON.parse(fs.readFileSync(plan.mcpConfig, 'utf8'));
      assert.deepEqual(Object.keys(document.mcpServers), plan.servers);
      if (agentApiMode === 'Disabled') assert.deepEqual(document.mcpServers, {});
      else {
        const owned = Object.values(document.mcpServers).filter(server => server.env?.TOOLSENABLED_AGENT_ACTOR);
        assert.ok(owned.length > 0, 'the shared generator must emit a real actor-bound server');
        for (const server of owned) {
          assert.equal(server.env.TOOLSENABLED_AGENT_ACTOR, 'local');
          assert.equal(server.env.TOOLSENABLED_AGENT_ID, 'local-worker');
          assert.equal(server.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, credential);
          assert.equal(server.env.TOOLSENABLED_STATE_ROOT, first.context.stateRoot);
        }
      }
      assert.equal(confinement.localSessionPlan({ ...options, account: { name: 'development', resolvedHome: first.home } }).code,
        'AGENT_CONFINEMENT_ACCOUNT_INVALID', 'Local cannot borrow a subscription home');
      for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
        const cliPlan = provider === 'codex' ? confinement.confinedSessionPlan(options)
          : provider === 'claude' ? confinement.claudeToolsSessionPlan(options)
          : confinement.acpSessionPlan({ ...options, provider, agentApiMode: 'Only' });
        assert.equal(cliPlan.code, 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED', provider);
      }
    }
    assert.equal(confinement.localSessionPlan({ servicesRoot: first.context.servicesRoot, agentApiMode: 'Disabled', roleFunctionsOnly: true }).code,
      'AGENT_TOOL_MODE_ROLE_CONFLICT');
    assert.equal(confinement.localSessionPlan({ servicesRoot: second.context.servicesRoot }).ok, false, 'Local must preserve the private state boundary');
    fs.unlinkSync(machineRecord.machineRecordPath(first.context.servicesRoot));
  });
  console.log('PASS Local shared planner: three tool modes, exact actor/session stamps, no provider account, CLI guards retained');

  await ambient(first,async () => {
    const prepare = () => confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'),{
      servicesRoot:first.context.servicesRoot,userCodexHome:first.home,accountName:'development',accountHome:first.context.userProfile,record:null });
    const home = prepare();
    assert.equal(home.env.HOME,first.context.userProfile);
    assert.equal(fs.readFileSync(path.join(home.codexHome,'config.toml'),'utf8').includes('cli_auth_credentials_store = "file"'),true);
    assert.equal(fs.statSync(path.join(home.codexHome,'auth.json')).ino,fs.statSync(path.join(first.home,'auth.json')).ino);
    isolation.providerSessionEnvironment(home.env,{ provider:'codex',requireHome:true });
    assert.equal(prepare().codexHome,home.codexHome,'legitimate same-session links could not be reused');
    const outsideLink = path.join(live.root,'linked-private-auth.json');
    fs.linkSync(path.join(first.home,'auth.json'),outsideLink);
    assert.throws(() => isolation.providerSessionEnvironment(home.env,{ provider:'codex',requireHome:true }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
    fs.unlinkSync(outsideLink);
    const linkedDir = path.join(first.root,'linked-account');
    fs.symlinkSync(live.home,linkedDir,process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => isolation.providerSessionEnvironment(first.env,{ provider:'codex',home:linkedDir }),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
    fs.unlinkSync(linkedDir);
    const independentHome = path.join(first.context.servicesRoot,'account-homes','codex','unlinkable');
    fs.mkdirSync(independentHome,{ recursive:true });
    const independentAuth = path.join(independentHome,'auth.json');
    fs.writeFileSync(independentAuth,'synthetic private credential');
    const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
    let credentialCopies = 0;
    try {
      fs.linkSync = (source,...args) => {
        if (source === independentAuth) throw Object.assign(new Error('test cross-device link refusal'),{ code:'EXDEV' });
        return originalLink(source,...args);
      };
      fs.copyFileSync = (...args) => { credentialCopies++; return originalCopy(...args); };
      assert.throws(() => confinement.prepareConfinedCodexHome(confinement.agentConfinement('guided'),{
        servicesRoot:first.context.servicesRoot,userCodexHome:independentHome,accountName:'unlinkable',
        accountHome:first.context.userProfile,record:null }),{ code:'AGENT_CONFINEMENT_CREDENTIAL_UNLINKABLE' });
    } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
    assert.equal(credentialCopies,0,'a failed private hard link copied authentication');
    assert.equal(fs.readFileSync(independentAuth,'utf8'),'synthetic private credential');
    const machineRecord = require('../src/lib/setup/machine-record');
    const record = machineRecord.buildMachineRecord({ tier:'guided',installRoot:path.resolve(__dirname,'..'),
      servicesRoot:first.context.servicesRoot,nodePath:process.execPath,workspaceRoots:[path.join(first.root,'workspace')] });
    const generated = machineRecord.generateMcpConfig(record,{ stateRoot:first.context.stateRoot }).document;
    const servers = Object.values(generated.mcpServers);
    assert.ok(servers.length > 0,'no actual MCP server was checked');
    for (const server of servers) {
      assert.equal(server.env.HOME,first.context.userProfile);
      assert.equal(server.env.LOCALAPPDATA,first.context.localAppData);
      assert.equal(server.env.TOOLSENABLED_STATE_ROOT,first.context.stateRoot);
      isolation.assertProviderSessionEnvironment(server.env);
    }
    const unrestricted = machineRecord.buildMachineRecord({ tier:'unrestricted',installRoot:path.resolve(__dirname,'..'),
      servicesRoot:first.context.servicesRoot,nodePath:process.execPath,workspaceRoots:[path.join(first.root,'workspace')] });
    machineRecord.writeMachineRecord(unrestricted,{ servicesRoot:first.context.servicesRoot });
    const codexPlan = confinement.confinedSessionPlan({ servicesRoot:first.context.servicesRoot,
      account:{ name:'development',resolvedHome:first.home },agentApiMode:'Enabled' });
    assert.equal(codexPlan.ok,true,codexPlan.code);
    assert.equal(codexPlan.tier,'unrestricted');
    assert.equal(codexPlan.threadOptions.sandbox,'danger-full-access');
    assert.equal(codexPlan.threadOptions.approvalPolicy,'never');
    assert.equal(codexPlan.env.HOME,first.context.userProfile);
    assert.equal(path.relative(first.root,codexPlan.codexHome).startsWith('..'),false);
    const claudeHome = path.join(first.context.servicesRoot,'account-homes','claude','development');
    fs.mkdirSync(claudeHome,{ recursive:true });
    const claudePlan = confinement.claudeToolsSessionPlan({ servicesRoot:first.context.servicesRoot,
      account:{ name:'development',resolvedHome:claudeHome },agentApiMode:'Enabled',browserTools:false });
    assert.equal(claudePlan.ok,true,claudePlan.code);
    assert.equal(claudePlan.tier,'unrestricted');
    assert.equal(claudePlan.claudePermissionMode,'bypassPermissions');
    assert.equal(claudePlan.env.HOME,first.context.userProfile);
    assert.equal(claudePlan.configDir,claudeHome);
  });
  console.log('PASS credential links stay in-session, external links/junctions refuse, MCP children retain private state');

  const firstExe = installPeer(first); installPeer(second);
  assert.equal(isolation.resolvePrivateProviderExecutable('codex',first.env).executablePath,firstExe);
  assert.throws(() => isolation.resolvePrivateProviderExecutable('codex',live.env),{ code:'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED' });
  const platformBinary = path.join(isolation.profileEnvironment(first.context).npm_config_prefix,'platform-binary');
  fs.linkSync(firstExe,platformBinary);
  assert.equal(isolation.resolvePrivateProviderExecutable('codex',first.env).executablePath,firstExe,
    'the official installer may retain both binary names wholly inside its private prefix');
  assert.equal(isolation.assertPrivateProviderExecutablePath(firstExe,first.env),firstExe);
  const outsidePrefixLink = path.join(first.root,'outside-install-prefix');
  fs.linkSync(firstExe,outsidePrefixLink);
  assert.throws(() => isolation.resolvePrivateProviderExecutable('codex',first.env),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  assert.throws(() => isolation.assertPrivateProviderExecutablePath(firstExe,first.env),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  fs.unlinkSync(outsidePrefixLink);
  const externalExeLink = path.join(live.root,'shared-executable');
  fs.linkSync(firstExe,externalExeLink);
  assert.throws(() => isolation.resolvePrivateProviderExecutable('codex',first.env),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  assert.throws(() => isolation.assertPrivateProviderExecutablePath(firstExe,first.env),{ code:'AGENT_PROVIDER_ISOLATION_PATH' });
  fs.unlinkSync(externalExeLink);
  fs.unlinkSync(platformBinary);
  const started = await Promise.all([first,second].map(machine => startCodexSession({
    command:'owner-command-that-must-never-run',cwd:path.join(machine.root,'workspace'),
    env:{ ...machine.env,OPENAI_API_KEY:'fixture',NODE_OPTIONS:'--require outside' },timeoutMs:15000
  }).then(session => { sessions.push(session); return session; })));
  assert.equal(started.length,2);
  const observations = [first,second].map(machine => {
    const observed = JSON.parse(fs.readFileSync(path.join(machine.context.userProfile,'start-observed.json'),'utf8'));
    assert.equal(observed.HOME,path.join(machine.root,'userprofile'));
    assert.equal(observed.APPDATA,path.join(machine.root,'userprofile','AppData','Roaming'));
    assert.equal(observed.CODEX_HOME,machine.home);
    assert.equal(observed.XDG_CACHE_HOME,path.join(machine.root,'localappdata','cache'));
    assert.equal(observed.npm_config_prefix,path.join(machine.root,'userprofile','.npm-global'));
    assert.deepEqual(observed.leaked,[]);
    assert.deepEqual(observed.argv.slice(0,2),['-c','cli_auth_credentials_store="file"']);
    for (const directory of [observed.APPDATA,observed.XDG_CACHE_HOME,machine.home]) assert.equal(fs.readFileSync(path.join(directory,'private-peer-write.txt'),'utf8'),machine.root);
    return observed;
  });
  assert.notEqual(observations[0].pid,observations[1].pid);
  await closeAndConfirm(started[0]);
  process.kill(observations[1].pid,0);
  assert.equal(fs.readFileSync(liveCanary,'utf8'),liveBefore);
  assert.equal(fs.existsSync(path.join(live.context.userProfile,'start-observed.json')),false);
  fs.renameSync(firstExe,`${firstExe}.removed`);
  await assert.rejects(detectCodexVersion({ env:first.env,command:'owner-command-that-must-never-run' }),{ code:'AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED' });
  console.log('PASS two real private peers coexist, one closes independently, absent private install never falls back');
}

main().finally(async () => {
  for (const session of sessions) await closeAndConfirm(session);
  for (const root of roots) fs.rmSync(root,{ recursive:true,force:true });
}).then(() => console.log('Provider session isolation tests passed, including native process cleanup.')).catch(error => {
  console.error(error); process.exitCode = 1;
});
