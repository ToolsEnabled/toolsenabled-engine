'use strict';
const assert = require('node:assert/strict');
const { ClaudeCliAdapter, claudeForkArgs } = require('../../src/lib/agent-engine/claude-cli-adapter');
const { forkClaudeSession } = require('../../src/lib/agent-engine/claude-cli-process');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
const { forkCodexSession } = require('../../src/lib/agent-engine/codex-process');
const path = require('node:path');
const sourceId = '11111111-2222-3333-4444-555555555555';
const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function claude() {
  let receive, closed = false;
  const adapter = new ClaudeCliAdapter({ transport: { send() {}, onData(fn) { receive = fn; }, close() { closed = true; } },
    expectedFork: { sourceThreadId: sourceId, threadId: newId } });
  adapter.threadId = newId;
  return { adapter, receive: packet => receive(packet), closed: () => closed };
}
(async () => {
  const args = claudeForkArgs({ sourceThreadId: sourceId, threadId: newId, roleFunctionsOnly: true, permissionMode: 'plan' });
  assert.equal(args[args.indexOf('--resume') + 1], sourceId);
  assert.equal(args[args.indexOf('--session-id') + 1], newId);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--fork-session'));
  assert.throws(() => claudeForkArgs({ sourceThreadId: sourceId, threadId: sourceId }), { code: 'CLAUDE_EDITOR_FORK_INVALID' });
  assert.throws(() => claudeForkArgs({ sourceThreadId: sourceId, threadId: newId, extraArgs: ['--tools', 'Bash'] }), { code: 'CLAUDE_EDITOR_FORK_INVALID' });
  for (const packet of [{ type: 'system', subtype: 'init', session_id: sourceId }, { type: 'assistant', session_id: newId, message: { content: [] } }]) {
    const fixture = claude();
    const sent = fixture.adapter.sendTurn({ threadId: newId, text: 'benign test' });
    fixture.receive(packet);
    await assert.rejects(sent, { code: 'CLAUDE_EDITOR_FORK_INVALID' });
    assert.equal(fixture.closed(), true);
  }
  const confirmed = claude();
  const sent = confirmed.adapter.sendTurn({ threadId: newId, text: 'benign test' });
  confirmed.receive({ type: 'system', subtype: 'init', session_id: newId });
  assert.equal(confirmed.adapter.forkIdentityVerified, true);
  confirmed.receive({ type: 'result', subtype: 'success', session_id: newId, result: 'fixture answer', is_error: false });
  assert.equal((await sent).text, 'fixture answer');
  confirmed.adapter.close();
  await assert.rejects(forkClaudeSession({ threadId: sourceId, command: 'MUST_NOT_SPAWN' }), { code: 'CLAUDE_EDITOR_FORK_INVALID' });
  let staged = false;
  await assert.rejects(forkClaudeSession({ threadId: sourceId, command: 'MUST_NOT_SPAWN', configDir: process.cwd(),
    stageSource() { staged = true; return () => {}; }, assertSource() { const e = new Error('revoked'); e.code = 'EDITOR_IMPORT_REMOVED'; throw e; } }), { code: 'EDITOR_IMPORT_REMOVED' });
  assert.equal(staged, false);
  const sourcePath = path.join(process.cwd(), 'original', 'fixture.jsonl');
  const codexHome = path.join(process.cwd(), 'isolated-fork');
  await assert.rejects(forkCodexSession({ threadId: sourceId, sourcePath, command: 'MUST_NOT_SPAWN' }), { code: 'CODEX_EDITOR_FORK_INVALID' });
  await assert.rejects(forkCodexSession({ threadId: sourceId, sourcePath, command: 'MUST_NOT_SPAWN', env: { CODEX_HOME: codexHome },
    stageSource() { staged = true; return () => {}; }, assertSource() { const e = new Error('revoked'); e.code = 'EDITOR_IMPORT_REMOVED'; throw e; } }), { code: 'EDITOR_IMPORT_REMOVED' });
  assert.equal(staged, false);
  let cleaned = 0, asserted = 0;
  await assert.rejects(forkCodexSession({ threadId: sourceId, sourcePath, command: 'MUST_NOT_SPAWN', env: { CODEX_HOME: codexHome },
    stageSource(home) { assert.equal(home, codexHome); const cleanup = () => { cleaned += 1; }; cleanup.sourcePath = path.join(codexHome, 'sessions', 'fixture.jsonl'); return cleanup; },
    assertSource() { if (++asserted === 2) { const e = new Error('revoked after import'); e.code = 'EDITOR_IMPORT_REMOVED'; throw e; } } }), { code: 'EDITOR_IMPORT_REMOVED' });
  assert.equal(cleaned, 1);
  await assert.rejects(forkCodexSession({ threadId: sourceId, sourcePath, command: 'MUST_NOT_SPAWN', env: { CODEX_HOME: codexHome },
    stageSource() { const cleanup = () => { cleaned += 1; }; cleanup.sourcePath = sourcePath; return cleanup; }, assertSource() {} }), { code: 'CODEX_EDITOR_FORK_INVALID' });
  assert.equal(cleaned, 2);
  const codex = Object.create(CodexAdapter.prototype);
  codex.codexVersion = 'codex-cli 0.153.4';
  codex.initialized = true;
  const calls = [];
  codex._request = async (method, params) => { calls.push({ method, params }); return { thread: { id: newId, cwd: process.cwd(), turns: [] } }; };
  const forked = await codex.forkThreadFromPath(sourceId, require('node:path').join(process.cwd(), 'fixture.jsonl'), { cwd: process.cwd() });
  assert.equal(forked.threadId, newId);
  assert.equal(calls[0].params.deferGoalContinuation, true);
  assert.equal(calls[0].params.threadId, sourceId);
  codex._request = async () => ({ thread: { id: sourceId, cwd: process.cwd(), turns: [] } });
  await assert.rejects(codex.forkThreadFromPath(sourceId, require('node:path').join(process.cwd(), 'fixture.jsonl')), { code: 'CODEX_EDITOR_FORK_INVALID' });
  console.log('Editor fork argv, identity, receipt callbacks and provider contract tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
