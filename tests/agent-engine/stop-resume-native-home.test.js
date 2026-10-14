'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startClaudeSession, resumeClaudeSession } = require('../../src/lib/agent-engine/claude-cli-process');
const { startCodexSession, resumeCodexSession } = require('../../src/lib/agent-engine/codex-process');

// Only the external CLI is a fixture. The real process transports and adapters
// stop, restart, and read the conversation from one inert, account-like home.
function nativePeer() {
  const fs = require('node:fs'), path = require('node:path');
  const provider = process.env.RESUME_FIXTURE_PROVIDER;
  if (process.argv.includes('--version')) {
    process.stdout.write(provider === 'claude' ? '2.1.280 (Claude Code)\n' : 'codex-cli ' + process.env.RESUME_FIXTURE_VERSION + '\n');
    return;
  }
  if (process.argv.includes('--help')) {
    process.stdout.write(fs.readFileSync(process.env.RESUME_FIXTURE_HELP, 'utf8'));
    return;
  }
  const home = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  const file = path.join(home, 'inert-conversation.json');
  const argv = process.argv.slice(2);
  let threadId = provider === 'claude' ? argv[argv.indexOf('--resume') + 1] : null;
  if (provider === 'claude' && argv.includes('--session-id')) threadId = argv[argv.indexOf('--session-id') + 1];
  const launch = { provider, home, argv, pid: process.pid };
  fs.appendFileSync(process.env.RESUME_FIXTURE_LOG, JSON.stringify(launch) + '\n');
  const emit = packet => process.stdout.write(JSON.stringify(packet) + '\n');
  const save = text => fs.writeFileSync(file, JSON.stringify({ threadId, text }));
  const recall = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const respond = (request, result) => emit({ id: request.id, result });
  require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    const request = JSON.parse(line);
    if (provider === 'claude') {
      if (request.type === 'control_request') {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } });
      } else if (request.type === 'user') {
        const text = request.message.content[0].text;
        if (text === 'Remember CHECKWORD.') save(text);
        const saved = recall();
        if (saved.threadId !== threadId) throw new Error('fixture conversation identity changed');
        emit({ type: 'system', subtype: 'init', session_id: threadId });
        emit({ type: 'result', session_id: threadId, subtype: 'success', result: saved.text });
      }
      return;
    }
    if (request.method === 'initialize') return respond(request, { userAgent: 'inert-fixture' });
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') {
      threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      return respond(request, { thread: { id: threadId, turns: [] } });
    }
    if (request.method === 'thread/resume') {
      threadId = request.params.threadId;
      const saved = recall();
      if (saved.threadId !== threadId) throw new Error('fixture conversation identity changed');
      return respond(request, { thread: { id: threadId, turns: request.params.excludeTurns ? [] : [{ id: 'saved-turn', status: 'completed',
        items: [{ id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: saved.text }] }] }] } });
    }
    if (request.method === 'thread/turns/list') {
      const saved = recall();
      return respond(request, { data: [{ id: 'saved-turn', status: 'completed',
        items: [{ id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: saved.text }] }] }], nextCursor: null });
    }
    if (request.method === 'turn/start') {
      threadId = request.params.threadId;
      save(request.params.input[0].text);
      return respond(request, { turn: { id: 'saved-turn' } });
    }
    emit({ id: request.id, error: { code: -32601, message: 'Method not found in inert fixture' } });
  });
}

const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function commandIn(dir) {
  const script = path.join(dir, 'native-peer.cjs');
  fs.writeFileSync(script, '(' + nativePeer.toString() + ')();\n');
  const command = path.join(dir, process.platform === 'win32' ? 'native-peer.cmd' : 'native-peer');
  fs.writeFileSync(command, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath.replace(/"/g, '""') + '" "' + script.replace(/"/g, '""') + '" %*\r\n'
    : '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n', { mode: 0o700 });
  return command;
}
async function stopped(pid) {
  const deadline = Date.now() + 30_000; // Process cleanup bound, not a performance assertion.
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) throw new Error('inert provider did not stop within cleanup bound');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
for (const [provider, version] of [['claude', null], ['codex', '0.153.0'], ['codex', '0.156.0']]) {
  test(provider + (version ? ' ' + version : '') + ': stopping the native process then resuming keeps its conversation and sign-in home', async () => {
    const scratch = path.join(__dirname, '..', '..', '.test-scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(scratch, 'stop-resume-'));
    const home = path.join(cwd, 'original-inert-home'), laterHome = path.join(cwd, 'different-inert-home');
    fs.mkdirSync(home); fs.mkdirSync(laterHome);
    const log = path.join(cwd, 'launches.jsonl'), command = commandIn(cwd);
    const env = { ...process.env, RESUME_FIXTURE_PROVIDER: provider, RESUME_FIXTURE_VERSION: version || '', RESUME_FIXTURE_LOG: log,
      RESUME_FIXTURE_HELP: path.join(__dirname, '..', 'fixtures', 'claude-help-2.1.280.txt'),
      CODEX_HOME: provider === 'codex' ? home : laterHome,
      CLAUDE_CONFIG_DIR: provider === 'claude' ? laterHome : home };
    const options = { cwd, command, env, startupTimeoutMs: 30_000,
      ...(provider === 'claude' ? { configDir: home } : {}) };
    let first, resumed;
    try {
      first = await (provider === 'claude' ? startClaudeSession : startCodexSession)(options);
      const sent = await first.adapter.sendTurn({ threadId: first.threadId, text: 'Remember CHECKWORD.' });
      assert.ok(sent.turnId);
      first.close();
      const original = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
      await stopped(original.pid);
      // The caller's current default differs; the supplied original home must win.
      resumed = await (provider === 'claude' ? resumeClaudeSession : resumeCodexSession)(
        { ...options, threadId: first.threadId, threadProvider: provider });
      assert.equal(resumed.threadId, first.threadId);
      const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(launches.length, 2);
      assert.equal(launches[0].home, home);
      assert.equal(launches[1].home, home);
      if (provider === 'claude') {
        assert.equal(launches[0].argv[launches[0].argv.indexOf('--session-id') + 1], first.threadId);
        assert.equal(launches[1].argv[launches[1].argv.indexOf('--resume') + 1], first.threadId);
        assert.equal(launches[1].argv.includes('--session-id'), false);
        assert.equal((await resumed.adapter.sendTurn({ threadId: resumed.threadId, text: 'Recall the word.' })).text, 'Remember CHECKWORD.');
      } else {
        assert.equal(resumed.turns[0].said[0].text, 'Remember CHECKWORD.');
        assert.equal(resumed.turns[0].said[0].who, 'you');
      }
      resumed.close();
      await stopped(launches[1].pid);
    } finally {
      first?.close(); resumed?.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
