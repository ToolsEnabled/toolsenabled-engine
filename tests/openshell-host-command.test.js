'use strict';

// `toolsenabled-authority` (bin/toolsenabled-openshell-host.js): the command for the
// ToolsEnabled host outside the OpenShell sandboxes. The last test serves the
// real engine from a temporary root and calls it over HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'toolsenabled-openshell-host.js');
const command = require('../bin/toolsenabled-openshell-host');
const ledgerPage = require('../src/lib/openshell-ledger-page');
const settingsPage = require('../src/lib/openshell-settings-page');

function place() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-host-command-'));
  fs.mkdirSync(path.join(dir, 'home'));
  return { dir, root: path.join(dir, 'root'), home: path.join(dir, 'home') };
}

function run(where, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args, ...(args[0] === 'link' ? [] : ['--root', where.root])], {
    env: { HOME: where.home, PATH: process.env.PATH, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 60000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the host keeps only a few variables from the shell that starts it', () => {
  const env = command.hostEnvironment('/srv/te-host', {
    HOME: '/home/p', PATH: '/usr/bin', LANG: 'C.UTF-8',
    GITHUB_TOKEN: 'person-token', ANTHROPIC_API_KEY: 'k', DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:x',
    TOOLSENABLED_AGENT_ACTOR: 'codex', TOOLSENABLED_STATE_ROOT: '/elsewhere', OPENSHELL_SANDBOX: '0'
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'HOME', 'LANG', 'PATH', 'TOOLSENABLED_OPENSHELL_HOST', 'TOOLSENABLED_OPENSHELL_HOST_ROOT', 'TOOLSENABLED_STATE_ROOT',
    'TOOLSENABLED_TOOL_ALLOWLIST', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
  ]);
  assert.equal(env.TOOLSENABLED_STATE_ROOT, path.join('/srv/te-host', 'state'));
  assert.equal(env.TOOLSENABLED_OPENSHELL_HOST, '1');
});

test('the host\'s pages carry the host\'s note instead of the sandbox pages\' note', () => {
  const text = command.hostPageText(`A1  open\n\n${ledgerPage.NOT_A_BOUNDARY}\n--\n${settingsPage.NOT_A_BOUNDARY}\n`);
  assert.equal(text.includes(ledgerPage.NOT_A_BOUNDARY), false);
  assert.equal(text.includes(settingsPage.NOT_A_BOUNDARY), false);
  assert.equal(text.split(command.HOST_PAGE_NOTE).length, 3);
});

test('a grant\'s token goes once to a new owner-only file; the profile and policy it prints bind it', () => {
  const where = place();
  const tokenFile = path.join(where.dir, 'claude.token');
  const added = run(where, ['grant', 'add', 'claude-dev', '--actor', 'claude', '--tools', 'settings.read,a_ledger.file', '--token-file', tokenFile]);
  assert.equal(added.status, 0, added.stderr);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^te-host-[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(added.stdout.includes(token), false, 'the token is never printed');
  assert.match(added.stdout, /openshell profile import --file te-host-claude-dev\.yaml/);
  assert.equal(fs.readFileSync(path.join(where.root, 'openshell-host', 'grants.json'), 'utf8').includes(token), false);

  const again = run(where, ['grant', 'add', 'other', '--actor', 'codex', '--tools', 'ledger.read', '--token-file', tokenFile]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);

  const profile = run(where, ['profile', 'claude-dev', '--env-var', 'TE_HOST_CLAUDE']);
  assert.equal(profile.status, 0, profile.stderr);
  assert.match(profile.stdout, /^id: te-host-claude-dev$/m);
  assert.match(profile.stdout, /env_vars: \[TE_HOST_CLAUDE\]/);
  assert.match(profile.stdout, /auth_style: bearer/);
  assert.doesNotMatch(profile.stdout, /^endpoints:/m, 'endpointless: the sandbox policy binds it');

  const binary = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const policy = run(where, ['policy', 'claude-dev', '--binary', binary]);
  assert.equal(policy.status, 0, policy.stderr);
  for (const line of ['host: host.openshell.internal', 'port: 18795', 'path: /mcp/claude-dev', 'protocol: mcp', 'enforcement: enforce',
    'method: tools/call', 'tool: { any: [settings.read, a_ledger.file] }', 'provider: te-host-claude-dev', `- path: ${JSON.stringify(binary)}`]) {
    assert.ok(policy.stdout.includes(line), `policy lacks: ${line}`);
  }
  assert.notEqual(run(where, ['policy', 'claude-dev']).status, 0, 'a policy names at least one binary');
  assert.notEqual(run(where, ['policy', 'claude-dev', '--binary', 'claude']).status, 0, 'binaries are absolute paths');
  assert.notEqual(run(where, ['profile', 'claude-dev', '--env-var', 'lower']).status, 0);
  assert.notEqual(run(where, ['profile', 'nobody', '--env-var', 'TE_X']).status, 0);
});

test('host commands refuse to run inside a sandbox', () => {
  const where = place();
  const inside = run(where, ['grant', 'list'], { OPENSHELL_SANDBOX: '1' });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /not inside a sandbox/);
});

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function post(port, pathname, token, body, sessionId) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
      host: `host.openshell.internal:${port}`, 'content-type': 'application/json', authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' } : {})
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('served from its own root: a read, a write the host keeps, and the person\'s page on the host', async (t) => {
  const where = place();
  assert.equal(run(where, ['init', '--audit']).status, 0);
  const tokenFile = path.join(where.dir, 'claude.token');
  assert.equal(run(where, ['grant', 'add', 'claude-dev', '--actor', 'claude', '--tools', 'settings.read,a_ledger.file,audit.status,audit.verify', '--token-file', tokenFile]).status, 0);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--root', where.root], {
    env: { HOME: where.home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; if (text.includes('serving MCP')) resolve(); });
    child.once('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
  assert.ok(fs.existsSync(path.join(where.root, 'openshell-host', 'server.pid')));

  const opened = await post(port, '/mcp/claude-dev', token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(opened.status, 200);
  for (const protocolVersion of require('../src/mcp-server').SUPPORTED_PROTOCOLS) {
    const negotiated = await post(port, '/mcp/claude-dev', token, { jsonrpc: '2.0', id: 20, method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'revision-test', version: '0' } } });
    assert.equal(negotiated.json.result.protocolVersion, protocolVersion);
  }
  const sessionId = opened.headers['mcp-session-id'];
  const call = (id, name, args) => post(port, '/mcp/claude-dev', token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId);

  const listed = await post(port, '/mcp/claude-dev', token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
  assert.deepEqual(listed.json.result.tools.map((tool) => tool.name).sort(), ['a_ledger.file', 'audit.status', 'audit.verify', 'settings.read']);

  const settings = await call(3, 'settings.read', { ids: ['audit.enabled'] });
  // The values are the host's own (`init --audit` turned the audit on there);
  // where the host keeps them is not told to a sandboxed caller.
  assert.equal(settings.json.result.structuredContent.values['audit.enabled'], true, 'the settings are the host\'s own');
  assert.equal(settings.json.result.structuredContent.valuesPath, require('../src/lib/openshell-host-server').HOST_PATH_TEXT);

  const filed = await call(4, 'a_ledger.file', { actor: 'claude', scope: 'global', words: 'May I rename the branch?' });
  assert.equal(filed.json.result.structuredContent.filedBy, 'claude');
  assert.match(filed.json.result.structuredContent.note, /toolsenabled-authority ledger/);

  const forged = await call(5, 'a_ledger.file', { actor: 'codex', scope: 'global', words: 'forged' });
  assert.equal(forged.json.error.code, -32602);
  const outside = await call(6, 't_ledger.file', { actor: 'claude', scope: 'global', words: 'not granted' });
  assert.ok(outside.json.error || outside.json.result.isError, 'a tool outside the grant is refused');

  const verified = await call(7, 'audit.verify', {});
  assert.equal(verified.json.result.structuredContent.valid, true);
  assert.ok(verified.json.result.structuredContent.entries > 0, 'the host signs the calls it serves');
  const status = await call(8, 'audit.status', {});
  assert.equal(status.json.result.structuredContent.ok, true);
  assert.equal(status.json.result.structuredContent.path, require('../src/lib/openshell-host-server').HOST_PATH_TEXT);
  for (const reply of [settings, status, verified]) {
    assert.equal(JSON.stringify(reply.json).includes(where.root), false, 'no reply to the sandbox names a path on the host');
  }

  const ledger = run(where, ['ledger']);
  assert.equal(ledger.status, 0, ledger.stderr);
  assert.match(ledger.stdout, /A1 +open \(from claude\) +May I rename the branch\?/);
  assert.ok(ledger.stdout.includes(command.HOST_PAGE_NOTE));
  assert.equal(ledger.stdout.includes(ledgerPage.NOT_A_BOUNDARY), false);

  const answered = run(where, ['ledger', 'answer', 'A1', 'yes']);
  assert.equal(answered.status, 0, answered.stderr);
  assert.doesNotMatch(run(where, ['ledger']).stdout, /A1/, 'an answered ask leaves the open view');
  const all = run(where, ['ledger', '--all']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /A1 +answered/, 'the sandbox page\'s own options pass through');

  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(where.root, 'openshell-host', 'server.pid')), false);
});

test('the generated policy explicitly permits every revision the bundled agents negotiate', () => {
  const supported = require('../src/mcp-server').SUPPORTED_PROTOCOLS;
  for (const version of command.INSPECTED_PROTOCOLS) assert.ok(supported.includes(version));
  assert.ok(command.INSPECTED_PROTOCOLS.includes('2025-06-18'));
  assert.ok(command.INSPECTED_PROTOCOLS.includes('2025-11-25'));
  const where = place();
  const added = run(where, ['grant', 'add', 'worker', '--actor', 'gemini', '--tools', 'ledger.read', '--token-file', path.join(where.dir, 'token')]);
  assert.equal(added.status, 0, added.stderr);
  const policy = run(where, ['policy', 'worker', '--binary', '/usr/bin/agent']);
  assert.equal(policy.status, 0, policy.stderr);
  assert.ok(policy.stdout.includes(`versions: ${JSON.stringify(command.INSPECTED_PROTOCOLS)}`));
  assert.notEqual(run(where, ['policy', 'worker', '--binary', '/usr/bin/agent', '--provider', 'bad\nprovider']).status, 0);
});

test('authority questions belong to each grant; only host commands answer, and status records revisions', async t => {
  const where = place(), port = await freePort();
  t.after(() => fs.rmSync(where.dir, { recursive: true, force: true }));
  assert.equal(run(where, ['init', '--audit']).status, 0);
  const grants = require('../src/lib/openshell-host-grants');
  const one = grants.createGrant(where.root, { id: 'one', actor: 'gemini', tools: ['system.ask', 'system.notify', 'settings.read', 'ledger.read', 'audit.status'] });
  const two = grants.createGrant(where.root, { id: 'two', actor: 'gemini', tools: ['system.ask'] });
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--root', where.root], {
    env: { HOME: where.home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  });
  await new Promise((resolve, reject) => {
    let text = ''; child.stdout.on('data', chunk => { text += chunk; if (text.includes('serving MCP')) resolve(); });
    child.once('exit', code => reject(new Error(`serve exited ${code}`)));
  });
  const initialize = grant => post(port, `/mcp/${grant.grant.id}`, grant.token, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2099-01-01', clientInfo: { name: 'authority-test', version: '2.0', private: 'not-retained' } } });
  const opened = await initialize(one), second = await initialize(two);
  assert.equal(opened.json.result.protocolVersion, require('../src/mcp-server').SUPPORTED_PROTOCOLS[0]);
  let id = 1;
  const call = (name, args = {}, grant = one, session = opened) => post(port, `/mcp/${grant.grant.id}`, grant.token,
    { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, session.headers['mcp-session-id']);
  const question = { title: 'Release', message: 'May I proceed?', timeoutSeconds: 5 };
  const pending = (await call('system.ask', question)).json.result.structuredContent;
  assert.equal(pending.pending, true);
  assert.match(pending.reason, /toolsenabled-authority ask/);
  const notice = (await call('system.notify', { message: 'Waiting for the release decision.' })).json.result.structuredContent;
  assert.equal(notice.posted, true);
  const list = run(where, ['ask', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /gemini \(one\)/);
  assert.match(list.stdout, /May I proceed/);
  assert.match(list.stdout, /Waiting for the release decision/);
  assert.ok(list.stdout.includes(command.HOST_PAGE_NOTE));
  const watch = run(where, ['watch', '--once']);
  assert.equal(watch.status, 0, watch.stderr);
  assert.match(watch.stdout, /May I proceed/);
  assert.equal(run(where, ['ask', 'answer', pending.askId, 'yes', 'Proceed carefully.']).status, 0);
  const other = (await call('system.ask', question, two, second)).json.result.structuredContent;
  assert.equal(other.pending, true, 'a second grant with the same actor cannot collect the first answer');
  assert.notEqual(other.askId, pending.askId);
  const answer = (await call('system.ask', question)).json.result.structuredContent;
  assert.equal(answer.answer, 'yes');
  assert.equal(answer.note, 'Proceed carefully.');
  for (const [name, args] of [
    ['system.ask.answer', { id: other.askId, answer: 'yes' }],
    ['system.ask', { ...question, decision: 'approve', from: 'gemini (two)' }],
    ['settings.set', { id: 'audit.enabled', value: false }],
    ['ledger.answer', { id: 'A1', words: 'yes' }],
    ['host.read_file', { path: path.join(where.root, 'state', 'vault', 'audit-signing-key') }],
    ['host.write_file', { path: path.join(where.root, 'state', 'reports', 'OWNER-REQUEST-LEDGER.json'), content: '{}' }]
  ]) {
    const refused = (await call(name, args)).json;
    assert.ok(refused.error || refused.result?.isError, name);
  }
  assert.notEqual(run(where, ['ask', 'answer', other.askId, 'yes'], { OPENSHELL_SANDBOX: '1' }).status, 0);
  const status = run(where, ['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /gemini: asked 2099-01-01; answered 2025-11-25; client authority-test 2.0/);
  const saved = fs.readFileSync(path.join(where.root, 'state', 'state', 'mcp-revisions.json'), 'utf8');
  assert.doesNotMatch(saved, /not-retained|private/);
  const log = fs.readFileSync(path.join(where.root, 'openshell-host', 'access.jsonl'), 'utf8');
  for (const token of [one.token, two.token]) assert.equal(log.includes(token), false);
});

test('authority watch streams questions while the process is still running', async t => {
  const where = place();
  const channel = require('../src/lib/openshell-person-channel');
  const file = path.join(where.root, 'state', 'state', 'openshell-person-channel.json');
  let now = Date.now();
  await channel.ask({ message: 'A question for the live host watch.', timeoutSeconds: 5 }, {
    file, from: 'gemini (watcher)', now: () => now, sleep: async ms => { now += ms; }
  });
  const child = spawn(process.execPath, [BIN, 'watch', '--root', where.root], {
    env: { HOME: where.home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(where.dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Authority watch did not stream a question.')), 5000);
    child.stdout.on('data', data => {
      text += data;
      if (text.includes('A question for the live host watch.')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Watch exited early: ${code}`)); });
  });
  assert.equal(child.exitCode, null);
  // The page marks the question after printing it. The pipe can deliver its
  // line before that following disk write has completed.
  const deadline = Date.now() + 2000;
  while (!channel.read({ file }).asks[0].shownAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(channel.read({ file }).asks[0].shownAt);
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exit, 0);
});
