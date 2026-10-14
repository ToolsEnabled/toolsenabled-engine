// EXECUTABLE CHANGE
// Strengthened assertion: the recovery replay must contain both
// "interactive root request" and "interactive root reply"; the former
// alternation could succeed when either entry was absent.
// Mutation: PersistentContextHistory.replay temporarily omitted the
// "interactive root reply" entry. Before strengthening, the test remained
// green: "Zed context-only terminal filter tests passed." After strengthening,
// it went red: "AssertionError [ERR_ASSERTION]: The input did not match the
// regular expression /interactive root reply/. Input:\n\n'interactive root request\\n'".
// The product file was restored byte-for-byte (cmp succeeded), and the final
// run was green: "Zed context-only terminal filter tests passed."
// NOT-FOUND (1): no assertion body is guarded by a possibly empty iteration.
// NOT-FOUND (2): no exit-status or truthy process-return assertion exists.
// NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// NOT-FOUND (4): no assertion tests a mock of the subject under test.
// NOT-FOUND (5): no skip or platform precondition can turn this file into a no-op.
// NOT-FOUND (6): no expected value is computed by the code it checks.
// Preconditions not met: none.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const {
  PersistentContextHistory,
  SessionProjector,
  TerminalDisplay,
  buildResumeArgs,
  clearVisibleTerminal,
  chooseSessionFile,
  extractContextText,
  extractSessionId,
  extractTransientActivity,
  lanePaths,
  parseArgs,
  resolveResumeSource,
  sanitizeContextText,
  terminalDimension
} = require('../tools/zed-context-terminal');

let terminalReset = '';
clearVisibleTerminal({ write(value) { terminalReset += value; } });
assert.equal(terminalReset, '\x1b[2J\x1b[3J\x1b[H');
assert.equal(terminalDimension(120, 80), 120);
assert.equal(terminalDimension(0, 80), 80);
assert.equal(sanitizeContextText('\x1b[2Jkept\r\ntext\x00'), 'kept\ntext');

const defaultDisplay = new TerminalDisplay({ write() {} });
assert.equal(defaultDisplay.transientMs, 500);
assert.equal(defaultDisplay.maxPreviewMs, 500);
defaultDisplay.finish();

const codexSessionId = '019fbaaf-3e2d-7960-9c78-820d7e67e4ad';
const claudeSessionId = '3603b824-9a1f-4ce4-af25-a2e2880df2c5';
const recoveredRootSessionId = '11111111-1111-4111-8111-111111111111';
const rejectedSubagentSessionId = '22222222-2222-4222-8222-222222222222';
function codexSessionMeta(sessionId, cwd = process.cwd()) {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd, source: 'cli', originator: 'codex-tui' }
  });
}
function codexSubagentMeta(sessionId, parentSessionId, cwd = process.cwd()) {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: parentSessionId, depth: 1 } } },
      originator: 'codex_vscode'
    }
  });
}
assert.equal(extractSessionId('codex', { type: 'session_meta', payload: { id: codexSessionId } }), codexSessionId);
assert.equal(extractSessionId('claude', { type: 'user', sessionId: claudeSessionId }), claudeSessionId);
assert.deepEqual(
  buildResumeArgs('codex', ['--dangerously-bypass-approvals-and-sandbox'], codexSessionId),
  ['resume', '--dangerously-bypass-approvals-and-sandbox', codexSessionId]
);
assert.deepEqual(
  buildResumeArgs('claude', ['--dangerously-skip-permissions'], claudeSessionId),
  ['--resume', claudeSessionId, '--dangerously-skip-permissions']
);

assert.deepEqual(
  extractContextText('claude', {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'context remains' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'hidden.js' } }
      ]
    }
  }),
  ['context remains']
);
assert.deepEqual(
  extractContextText('claude', {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'hidden result' }] }
  }),
  []
);
assert.deepEqual(
  extractContextText('codex', {
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'codex context remains' }
  }),
  ['codex context remains']
);
assert.deepEqual(
  extractContextText('codex', {
    type: 'event_msg',
    payload: { type: 'user_message', message: 'user context remains' }
  }),
  ['user context remains']
);
assert.deepEqual(
  extractContextText('codex', {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'structured context' }]
    }
  }),
  []
);
assert.deepEqual(
  extractContextText('codex', {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'hidden bootstrap instructions' }]
    }
  }),
  []
);
assert.deepEqual(
  extractContextText('codex', {
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', input: 'echo hidden command' }
  }),
  []
);
assert.deepEqual(
  extractTransientActivity('claude', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'hidden.js' } }] }
  }),
  ['Edit']
);
assert.deepEqual(
  extractTransientActivity('codex', {
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', input: 'hidden command' }
  }),
  ['shell']
);

const parsed = parseArgs([
  '--agent', 'claude',
  '--command', 'claude.exe',
  '--poll-ms', '300',
  '--', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'
]);
assert.equal(parsed.options.agent, 'claude');
assert.equal(parsed.options.pollMs, 300);
assert.deepEqual(parsed.targetArgs, ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']);

const parsedNewSession = parseArgs([
  '--agent', 'codex', '--command', 'codex.exe', '--new-session', '--state-dir', 'state/custom', '--'
]);
assert.equal(parsedNewSession.options.resume, false);
assert.equal(parsedNewSession.options.stateDir, 'state/custom');

let mirroredInput = '';
const inputDisplay = new TerminalDisplay({ write(value) { mirroredInput += value; } }, { columns: 80, transientMs: 25 });
inputDisplay.renderDynamic();
inputDisplay.handleKeypress('h', { name: 'h' });
inputDisplay.handleKeypress('i', { name: 'i' });
assert.match(mirroredInput, /› hi/);
inputDisplay.handleKeypress(undefined, { name: 'backspace' });
inputDisplay.handleKeypress('!', { name: '!' });
inputDisplay.handleKeypress(undefined, { name: 'return' });
assert.match(mirroredInput, /› h!  \[sent\]/);
inputDisplay.writeContext('h!');
inputDisplay.finish();
assert.match(mirroredInput, /h!\n/);

let previewOutput = '';
const permanentContext = ['durable before preview'];
const previewDisplay = new TerminalDisplay({ write(value) { previewOutput += value.toString(); } }, { columns: 80, transientMs: 25 });
previewDisplay.setPermanentReplay(() => {
  for (const context of permanentContext) previewDisplay.writeContext(context, { redraw: false });
});
previewDisplay.writeContext(permanentContext[0]);
previewDisplay.renderDynamic();
previewDisplay.handleKeypress('/', { name: '/' });
previewDisplay.showRawPreview(Buffer.from('\x1b[?1049hNATIVE / COMMAND MENU\nNATIVE EDIT PREVIEW'));
permanentContext.push('durable during preview');
previewDisplay.writeContext(permanentContext[1]);
const resetCountWhileHeld = (previewOutput.match(/\x1b\[2J\x1b\[3J\x1b\[H/g) || []).length;
assert.equal(previewDisplay.restoreRawPreview(), false, 'slash menu should remain visible while slash input is active');
assert.equal((previewOutput.match(/\x1b\[2J\x1b\[3J\x1b\[H/g) || []).length, resetCountWhileHeld);
previewDisplay.handleKeypress(undefined, { name: 'backspace' });
assert.equal(previewDisplay.restoreRawPreview(), true);
const restoredPreviewTail = previewOutput.slice(previewOutput.lastIndexOf(terminalReset) + terminalReset.length);
assert.match(restoredPreviewTail, /durable before preview/);
assert.match(restoredPreviewTail, /durable during preview/);
assert.doesNotMatch(restoredPreviewTail, /NATIVE \/ COMMAND MENU|NATIVE EDIT PREVIEW/);
const suppressedLength = previewOutput.length;
assert.equal(previewDisplay.showRawPreview('PASSIVE STATUS REDRAW'), false);
assert.equal(previewOutput.length, suppressedLength, 'passive redraw must stay suppressed after preview cleanup');
previewDisplay.handleKeypress('/', { name: '/' });
assert.equal(previewDisplay.showRawPreview('REARMED SLASH MENU'), true);
previewDisplay.finish();

let boundedPreviewOutput = '';
const boundedPreview = new TerminalDisplay(
  { write(value) { boundedPreviewOutput += value.toString(); } },
  { columns: 80, transientMs: 25, maxPreviewMs: 40 }
);
boundedPreview.setPermanentReplay(() => boundedPreview.writeContext('bounded permanent context', { redraw: false }));
boundedPreview.showRawPreview('CONTINUOUS STATUS 1');
boundedPreview.showRawPreview('CONTINUOUS STATUS 2');
assert.equal(boundedPreview.expireRawPreview(), true);
const boundedAfterExpiry = boundedPreviewOutput.length;
assert.equal(boundedPreview.showRawPreview('CONTINUOUS STATUS 3'), false);
assert.equal(boundedPreviewOutput.length, boundedAfterExpiry);
assert.match(boundedPreviewOutput.slice(boundedPreviewOutput.lastIndexOf(terminalReset)), /bounded permanent context/);
boundedPreview.handleKeypress('x', { name: 'x' });
assert.equal(boundedPreview.showRawPreview('USER-REARMED PREVIEW'), true);
boundedPreview.finish();

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-context-terminal-'));
try {
  const sessionRoot = path.join(fixtureRoot, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, 'session.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'user', cwd: process.cwd(), message: { role: 'user', content: [{ type: 'text', text: 'request context' }] } }),
    JSON.stringify({ type: 'assistant', cwd: process.cwd(), message: { role: 'assistant', content: [{ type: 'text', text: 'assistant context' }] } }),
    JSON.stringify({ type: 'assistant', cwd: process.cwd(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'hidden command' } }] } }),
    JSON.stringify({ type: 'user', cwd: process.cwd(), message: { role: 'user', content: [{ type: 'tool_result', content: 'hidden edit output' }] } }),
    ''
  ].join('\n'));
  const now = new Date();
  fs.utimesSync(sessionFile, now, now);
  let visible = '';
  const output = new Writable({ write(chunk, encoding, callback) { visible += chunk.toString(); callback(); } });
  const projector = new SessionProjector({
    agent: 'claude',
    root: sessionRoot,
    cwd: process.cwd(),
    startedAt: Date.now() - 100,
    output,
    pollMs: 250
  });
  projector.tick();
  assert.match(visible, /request context/);
  assert.match(visible, /assistant context/);
  assert.doesNotMatch(visible, /hidden command|hidden edit output/);
  assert.match(visible, /working: Bash/);
  projector.stop();

  const selectionRoot = path.join(fixtureRoot, 'selection');
  fs.mkdirSync(selectionRoot, { recursive: true });
  const oldSession = path.join(selectionRoot, 'old.jsonl');
  const newSession = path.join(selectionRoot, 'new.jsonl');
  const event = JSON.stringify({ cwd: process.cwd(), type: 'event_msg', payload: { type: 'agent_message', message: 'visible' } });
  fs.writeFileSync(oldSession, `${codexSessionMeta(codexSessionId)}\n${event}\n`);
  fs.writeFileSync(newSession, `${codexSessionMeta(codexSessionId)}\n${event}\n`);
  const selectionTime = new Date();
  fs.utimesSync(oldSession, selectionTime, selectionTime);
  fs.utimesSync(newSession, selectionTime, selectionTime);
  assert.equal(
    chooseSessionFile({
      agent: 'codex',
      root: selectionRoot,
      cwd: process.cwd(),
      startedAt: Date.now() - 100,
      currentFile: null,
      ignoredFiles: new Set([oldSession])
    }),
    newSession
  );

  const rotatedRoot = path.join(fixtureRoot, 'rotated');
  fs.mkdirSync(rotatedRoot, { recursive: true });
  const resumedOld = path.join(rotatedRoot, 'old-segment.jsonl');
  const resumedNew = path.join(rotatedRoot, 'new-segment.jsonl');
  const resumedMeta = `${codexSessionMeta(codexSessionId)}\n`;
  fs.writeFileSync(resumedOld, resumedMeta);
  const resumedSnapshot = new Set([resumedOld]);
  fs.writeFileSync(resumedNew, resumedMeta);
  assert.equal(
    chooseSessionFile({
      agent: 'codex',
      root: rotatedRoot,
      cwd: process.cwd(),
      startedAt: Date.now() - 100,
      currentFile: resumedOld,
      ignoredFiles: resumedSnapshot,
      sessionId: codexSessionId
    }),
    resumedNew
  );

  const isolatedRoot = path.join(fixtureRoot, 'isolated');
  fs.mkdirSync(isolatedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(isolatedRoot, 'stale.jsonl'),
    `${codexSessionMeta(codexSessionId)}\n${JSON.stringify({ cwd: process.cwd(), type: 'event_msg', payload: { type: 'agent_message', message: 'stale agent output' } })}\n`
  );
  let isolatedVisible = '';
  const isolatedOutput = new Writable({ write(chunk, encoding, callback) { isolatedVisible += chunk.toString(); callback(); } });
  const isolatedProjector = new SessionProjector({
    agent: 'codex',
    root: isolatedRoot,
    cwd: process.cwd(),
    startedAt: Date.now(),
    output: isolatedOutput,
    pollMs: 250
  });
  isolatedProjector.start();
  const freshSession = path.join(isolatedRoot, 'fresh.jsonl');
  fs.writeFileSync(
    freshSession,
    `${codexSessionMeta(codexSessionId)}\n${JSON.stringify({ cwd: process.cwd(), type: 'event_msg', payload: { type: 'agent_message', message: 'fresh agent output' } })}\n`
  );
  isolatedProjector.tick();
  isolatedProjector.stop();
  assert.doesNotMatch(isolatedVisible, /stale agent output/);
  assert.match(isolatedVisible, /fresh agent output/);

  const recoveryRoot = path.join(fixtureRoot, 'subagent-recovery');
  const recoveryStateRoot = path.join(fixtureRoot, 'subagent-recovery-state');
  fs.mkdirSync(recoveryRoot, { recursive: true });
  const interactiveRootFile = path.join(recoveryRoot, 'interactive-root.jsonl');
  const subagentFile = path.join(recoveryRoot, 'review-subagent.jsonl');
  fs.writeFileSync(interactiveRootFile, [
    codexSessionMeta(recoveredRootSessionId),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'interactive root request' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'interactive root reply' } }),
    ''
  ].join('\n'));
  fs.writeFileSync(subagentFile, [
    codexSubagentMeta(rejectedSubagentSessionId, '33333333-3333-4333-8333-333333333333'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'wrong reviewer request' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'wrong reviewer reply' } }),
    ''
  ].join('\n'));
  const recoverySeed = new PersistentContextHistory({ stateDir: recoveryStateRoot, agent: 'codex', cwd: process.cwd() });
  recoverySeed.updateSource({
    sessionId: rejectedSubagentSessionId,
    sessionFile: subagentFile,
    offset: fs.statSync(subagentFile).size
  });
  // Legacy rows did not carry session provenance. They inherit the saved
  // session during this one-time recovery and receive a durable context-ID
  // tombstone so they stay hidden after the state switches to the root.
  fs.writeFileSync(
    recoverySeed.paths.historyPath,
    `${JSON.stringify({ version: 1, id: 'wrong-reviewer-entry', text: 'wrong reviewer reply' })}\n`,
    'utf8'
  );
  const recoveryHistory = new PersistentContextHistory({ stateDir: recoveryStateRoot, agent: 'codex', cwd: process.cwd() });
  const recoveredSource = resolveResumeSource({
    history: recoveryHistory,
    root: recoveryRoot,
    agent: 'codex',
    cwd: process.cwd()
  });
  assert.equal(recoveredSource.sessionId, recoveredRootSessionId);
  assert.equal(recoveredSource.sessionFile, interactiveRootFile);
  assert.equal(recoveredSource.offset, 0);
  assert.equal(recoveredSource.recoveredFromSessionId, rejectedSubagentSessionId);
  assert.deepEqual(recoveryHistory.state.excludedSessionIds, [rejectedSubagentSessionId]);
  assert.deepEqual(recoveryHistory.state.excludedContextIds, ['wrong-reviewer-entry']);
  assert.equal(
    chooseSessionFile({
      agent: 'codex',
      root: recoveryRoot,
      cwd: process.cwd(),
      startedAt: 0,
      currentFile: null,
      ignoredFiles: null
    }),
    interactiveRootFile,
    'newer IDE subagents must never be selected as an interactive terminal session'
  );
  let recoveredVisible = '';
  const recoveredDisplay = new TerminalDisplay({ write(value) { recoveredVisible += value; } }, { columns: 100, transientMs: 25 });
  recoveryHistory.replay(recoveredDisplay);
  assert.doesNotMatch(recoveredVisible, /wrong reviewer reply/);
  recoveryHistory.updateSource(recoveredSource);
  const recoveryProjector = new SessionProjector({
    agent: 'codex',
    root: recoveryRoot,
    cwd: process.cwd(),
    startedAt: Date.now(),
    display: recoveredDisplay,
    history: recoveryHistory,
    pollMs: 250,
    initialFile: interactiveRootFile,
    initialOffset: 0,
    sessionId: recoveredRootSessionId
  });
  recoveryProjector.tick();
  recoveryProjector.stop();
  assert.match(recoveredVisible, /interactive root request/);
  assert.match(recoveredVisible, /interactive root reply/);
  assert.doesNotMatch(recoveredVisible, /wrong reviewer request|wrong reviewer reply/);
  assert.match(fs.readFileSync(recoveryHistory.paths.historyPath, 'utf8'), /wrong reviewer reply/);
  const reloadedRecoveryHistory = new PersistentContextHistory({ stateDir: recoveryStateRoot, agent: 'codex', cwd: process.cwd() });
  let reloadedRecoveryVisible = '';
  const reloadedRecoveryDisplay = new TerminalDisplay({ write(value) { reloadedRecoveryVisible += value; } });
  reloadedRecoveryHistory.replay(reloadedRecoveryDisplay);
  assert.match(reloadedRecoveryVisible, /interactive root request/);
  assert.match(reloadedRecoveryVisible, /interactive root reply/);
  assert.doesNotMatch(reloadedRecoveryVisible, /wrong reviewer request|wrong reviewer reply/);

  const durableSessionRoot = path.join(fixtureRoot, 'durable-sessions');
  const durableStateRoot = path.join(fixtureRoot, 'durable-state');
  fs.mkdirSync(durableSessionRoot, { recursive: true });
  const durableSession = path.join(durableSessionRoot, `rollout-${codexSessionId}.jsonl`);
  fs.writeFileSync(durableSession, [
    codexSessionMeta(codexSessionId),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'survives restart' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', input: 'never persisted visibly' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'durable reply' } }),
    ''
  ].join('\n'));
  const durableNow = new Date();
  fs.utimesSync(durableSession, durableNow, durableNow);

  let firstVisible = '';
  const firstDisplay = new TerminalDisplay({ write(value) { firstVisible += value; } }, { columns: 100, transientMs: 25 });
  const firstHistory = new PersistentContextHistory({ stateDir: durableStateRoot, agent: 'codex', cwd: process.cwd() });
  const firstProjector = new SessionProjector({
    agent: 'codex',
    root: durableSessionRoot,
    cwd: process.cwd(),
    startedAt: Date.now() - 100,
    display: firstDisplay,
    history: firstHistory,
    pollMs: 250
  });
  firstProjector.tick();
  firstProjector.stop();
  firstDisplay.finish();
  assert.match(firstVisible, /survives restart/);
  assert.match(firstVisible, /durable reply/);
  assert.doesNotMatch(fs.readFileSync(firstHistory.paths.historyPath, 'utf8'), /never persisted visibly/);
  assert.equal(firstHistory.state.sessionId, codexSessionId);
  assert.equal(firstHistory.state.offset, fs.statSync(durableSession).size);

  const savedPaths = lanePaths(durableStateRoot, 'codex', process.cwd());
  assert.equal(savedPaths.statePath, firstHistory.paths.statePath);
  const resumedHistory = new PersistentContextHistory({ stateDir: durableStateRoot, agent: 'codex', cwd: process.cwd() });
  const resumeSource = resolveResumeSource({
    history: resumedHistory,
    root: durableSessionRoot,
    agent: 'codex',
    cwd: process.cwd()
  });
  assert.equal(resumeSource.sessionId, codexSessionId);
  assert.equal(resumeSource.sessionFile, durableSession);

  let restartedVisible = '';
  const restartedDisplay = new TerminalDisplay({ write(value) { restartedVisible += value; } }, { columns: 100, transientMs: 25 });
  resumedHistory.replay(restartedDisplay);
  restartedDisplay.renderDynamic();
  const restartedProjector = new SessionProjector({
    agent: 'codex',
    root: durableSessionRoot,
    cwd: process.cwd(),
    startedAt: Date.now(),
    display: restartedDisplay,
    history: resumedHistory,
    pollMs: 250,
    initialFile: durableSession,
    // Deliberately replay the source from zero: event IDs must still prevent
    // duplicated permanent context after a crash before the offset commit.
    initialOffset: 0,
    sessionId: codexSessionId
  });
  restartedProjector.tick();
  assert.equal((restartedVisible.match(/survives restart/g) || []).length, 1);
  fs.appendFileSync(
    durableSession,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new after reboot' } })}\n`
  );
  restartedProjector.tick();
  restartedProjector.stop();
  restartedDisplay.finish();
  assert.match(restartedVisible, /new after reboot/);
  const finalHistory = new PersistentContextHistory({ stateDir: durableStateRoot, agent: 'codex', cwd: process.cwd() });
  assert.equal(finalHistory.entries.length, 3);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('Zed context-only terminal filter tests passed.');
