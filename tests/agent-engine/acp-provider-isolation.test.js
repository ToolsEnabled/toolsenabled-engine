'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate, isolatedTemporaryRoot } = require('../lib/isolated-environment');
activate('acp-provider-isolation');
const isolation = require('../../src/lib/provider-session-isolation');
const { prepareAcpSurface } = require('../../src/lib/agent-engine/acp-confinement');
const { startAcpSession } = require('../../src/lib/agent-engine/acp-process');
const { createCodexProcessTransport } = require('../../src/lib/agent-engine/codex-process');
const confinement = require('../../src/lib/agent-session-confinement');

// Real child processes and the production resolver/transport; only the remote
// provider protocol is a fixture. No account token or network request is used.
function peer() {
  const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
  const provider = path.basename(process.argv[1]).includes('gemini') ? 'gemini' : 'grok';
  const home = process.env[provider === 'grok' ? 'GROK_HOME' : 'GEMINI_CLI_HOME'];
  const inspect = process.argv.includes('inspect');
  fs.appendFileSync(path.join(home, 'observations.jsonl'), JSON.stringify({ provider, inspect,
    argv: process.argv.slice(2), codexHomePresent: !!process.env.CODEX_HOME, home }) + '\n');
  if (inspect) { process.stdout.write(JSON.stringify({ hooks: [], plugins: [], mcpServers: [], lspServers: [] })); return; }
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result = {};
    if (request.method === 'initialize') result = { protocolVersion: 1,
      agentInfo: { name: 'private-fixture', version: '1' },
      agentCapabilities: {}, authMethods: [{ id: provider === 'grok' ? 'cached_token' : 'oauth-personal' }] };
    if (request.method === 'session/new') result = { sessionId: 'private-' + provider,
      models: { currentModelId: 'fixture-model', availableModels: [] } };
    if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'private-' + provider, update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'PRIVATE_' + provider } } } }) + '\n');
      result = { stopReason: 'end_turn' };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
}

for (const provider of ['grok', 'gemini']) {
  test(`${provider} private ACP launch uses its selected home and executable without Codex`, async () => {
    const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'acp-private-'));
    fs.chmodSync(root, 0o700);
    const raw = { ...process.env, TOOLSENABLED_PROVIDER_ISOLATION_ROOT: root,
      TOOLSENABLED_STATE_ROOT: path.join(root, 'ToolsEnabled-Development', 'capability') };
    for (const variable of Object.values(isolation.HOME_ENV)) delete raw[variable];
    const context = isolation.isolationContext(raw), pins = isolation.profileEnvironment(context);
    const names = [...Object.keys(pins), ...Object.values(isolation.HOME_ENV)];
    const previous = names.map(name => [name, process.env[name]]);
    let session, retainedRoot;
    try {
      Object.assign(process.env, pins);
      for (const variable of Object.values(isolation.HOME_ENV)) delete process.env[variable];
      const home = path.join(context.servicesRoot, 'account-homes', provider, 'selected');
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), 'private-fixture');
      fs.writeFileSync(path.join(home, 'auth.json'), 'private-fixture');
      const authFile = path.join(home, ...(provider === 'grok' ? ['auth.json'] : ['.gemini', 'oauth_creds.json']));
      const externalLink = root + '-foreign-credential';
      fs.linkSync(authFile, externalLink);
      try {
        assert.throws(() => confinement.prepareClaudeToolSurface(confinement.agentConfinement('guided'), {
          provider, configDir: home, accountName: 'selected', accountHome: context.userProfile,
          servicesRoot: context.servicesRoot, record: null, agentApiMode: 'Only'
        }), { code: 'AGENT_PROVIDER_ISOLATION_PATH' }, 'the shared surface must check this provider’s credential file');
      } finally { fs.unlinkSync(externalLink); }
      const prefix = pins.npm_config_prefix;
      const entry = process.platform === 'win32'
        ? path.join(prefix, 'node_modules', ...(provider === 'grok' ? ['@xai-official','grok','bin','grok'] : ['@google','gemini-cli','bundle','gemini.js']))
        : path.join(prefix, 'bin', provider);
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, `#!${process.execPath}\n(${peer.toString()})();\n`, { mode: 0o700 });
      const directory = path.join(context.servicesRoot, 'tool-surface', provider);
      fs.mkdirSync(directory, { recursive: true });
      const surface = prepareAcpSurface({ provider, directory, configDir: home, entries: [], servers: [],
        env: pins, account: 'selected', agentApiMode: 'Only', writeAtomic: fs.writeFileSync });
      session = await startAcpSession({ provider, plan: { ok: true, agentApiMode: 'Only', ...surface }, env: { ...raw, ...pins },
        rootLaunch: { beforeRootSpawn() {}, spawned(child) { retainedRoot = child; } },
        startupTimeoutMs: 15000, cleanupTimeoutMs: 15000 });
      const events = []; session.adapter.onEvent(event => events.push(event));
      await session.adapter.sendTurn({ threadId: session.threadId, text: 'fixture turn' });
      assert.equal(events.find(event => event.type === 'assistant_text').text, 'PRIVATE_' + provider);
      const observations = fs.readFileSync(path.join(home, 'observations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(observations.length, provider === 'grok' ? 2 : 1);
      assert.ok(observations.every(row => row.provider === provider && row.home === home && !row.codexHomePresent));
      assert.ok(observations.every(row => !row.argv.some(word => word.includes('cli_auth_credentials_store'))));
      // The shared transport must still require Codex's own selected account
      // when the caller has not explicitly selected another provider.
      assert.throws(() => createCodexProcessTransport({ env: { ...raw, ...pins }, cwd: directory }),
        { code: 'AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED' });
    } finally {
      if (session) {
        const receipt = await session.adapter.transport.closeForStartupFailure(15000);
        assert.equal(receipt.activeProcesses, 0);
        session.adapter.close();
      }
      // An empty native job proves the provider is gone. Its retained wrapper
      // must also close before Windows releases the fixture working directory.
      if (retainedRoot) assert.equal((await retainedRoot.jobClosed).failure, null);
      for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
