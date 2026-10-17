'use strict';

// Terminal questions and notices round trip through the real MCP dispatcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'toolsenabled-openshell.js');
const STANDIN = path.join(ROOT, 'src', 'mcp-server.js');

function sandboxEnv(home) {
  const env = { HOME: home, PATH: process.env.PATH, OPENSHELL_SANDBOX: '1' };
  for (const name of ['LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function person(home, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { env: sandboxEnv(home), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, `toolsenabled ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

// The server entry setup registers for the CLIs, started through the stand-in
// wrapper with the stand-in's two tools added to the list.
function startAgentServer(home, actor = 'claude') {
  const command = process.execPath;
  const env = { ...sandboxEnv(home), TOOLSENABLED_STATE_ROOT: path.join(home, '.toolsenabled'),
    TOOLSENABLED_PERMISSION_ORIGIN: 'local', TOOLSENABLED_PERMISSION_TIER: 'full' };
  const child = spawn(command, ['-e', `require(${JSON.stringify(STANDIN)}).start({ permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' } });`], {
    env: { PATH: process.env.PATH, HOME: home, ...env, TOOLSENABLED_AGENT_ACTOR: actor, TOOLSENABLED_TOOL_ALLOWLIST: 'system.ask,system.notify' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let buffer = '';
  let nextId = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  child.stderr.resume();
  const rpc = (method, params) => new Promise((resolve) => {
    nextId += 1; waiting.set(nextId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
  });
  const call = async (name, args) => {
    const started = Date.now();
    const response = await rpc('tools/call', { name, arguments: args });
    const result = response.result || {};
    return { isError: Boolean(response.error) || result.isError === true, text: result.content?.[0]?.text || '', value: result.structuredContent || null, ms: Date.now() - started };
  };
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'action-rules-test', version: '0' } })
    .then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`));
  return { ready, call, stop: () => { child.stdin.end(); child.kill(); } };
}

async function untilWaiting(home, id) {
  const file = path.join(home, '.toolsenabled', 'state', 'openshell-person-channel.json');
  for (let i = 0; i < 200; i += 1) {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).asks.some((ask) => ask.id === id && ask.state === 'waiting')) return;
    } catch { /* not written yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`${id} never appeared`);
}

test('pending questions, terminal answers and notices round trip over MCP', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-action-rules-'));
  fs.mkdirSync(path.join(home, '.toolsenabled'), { recursive: true });
  const server = startAgentServer(home);
  try {
    await server.ready;
    const args = { message: 'Publish the docs after tests pass?', timeoutSeconds: 5 };
    const pending = await server.call('system.ask', args);
    assert.equal(pending.isError, false, pending.text);
    assert.deepEqual([pending.value.pending, pending.value.askId], [true, 'Q1']);
    assert.ok(pending.ms < 15000);
    assert.match(person(home, ['approvals']), /Q1 {2}question {2}from claude/);
    person(home, ['approvals', 'approve', 'Q1', 'after', 'review']);
    const answered = await server.call('system.ask', args);
    assert.deepEqual([answered.value.answer, answered.value.note], ['yes', 'after review']);
    assert.equal(answered.value.approvalToken, undefined);
    const asking = server.call('system.ask', { ...args, timeoutSeconds: 30 });
    await untilWaiting(home, 'Q2');
    person(home, ['approvals']);
    person(home, ['approvals', 'deny', 'Q2', 'Not', 'today.']);
    assert.equal((await asking).value.reason, 'Not today.');
    const notice = await server.call('system.notify', { title: 'Build', message: 'The docs build finished.' });
    assert.equal(notice.value.posted, true);
    assert.match(person(home, ['watch', '--once']), /notice N1 .*Build: The docs build finished/);
    assert.equal((await server.call('system.ask', { action: 'standin.send', arguments: {} })).isError, true);
  } finally { server.stop(); }
});

test('questions are offered without bringing back retired payment tools or a token issuer', () => {
  const { OPENSHELL_TOOLS } = require('../src/lib/openshell-surface');
  const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
  assert.ok(OPENSHELL_TOOLS.includes('system.ask') && OPENSHELL_TOOLS.includes('system.notify'));
  assert.equal(Object.keys(TOOL_REGISTRY).some(name => /^(pay|purchase|p_ledger|owner_prompts|payment_method)\./.test(name)), false);
});
