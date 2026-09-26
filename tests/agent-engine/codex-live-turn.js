'use strict';

const assert = require('node:assert/strict');
const { startCodexSession } = require('../../src/lib/agent-engine/codex-process');

const TURN_TIMEOUT_MS = 120_000;

function codexIsMissing(error) {
  for (let current = error; current; current = current.cause) {
    if (current.code === 'CODEX_CLI_NOT_FOUND' || current.code === 'ENOENT') return true;
  }
  return false;
}

async function main() {
  const cwd = process.cwd();
  const deltas = [];
  const completedTexts = [];
  const completedTurns = [];
  const stderr = [];
  let session = null;
  let activeThreadId = null;
  let resolveCompleted;
  const completed = new Promise(resolve => {
    resolveCompleted = resolve;
  });

  try {
    try {
      session = await startCodexSession({
        cwd,
        onEvent(event) {
          if (activeThreadId && event.threadId !== activeThreadId) return;
          if (event.type === 'assistant_text_delta') deltas.push(event.text);
          if (event.type === 'assistant_text') completedTexts.push(event.text);
          if (event.type === 'turn_completed') {
            completedTurns.push(event);
            resolveCompleted(event);
          }
        }
      });
    } catch (error) {
      if (codexIsMissing(error)) {
        console.log(`SKIP codex-live-turn: codex CLI is missing (${error.message})`);
        return;
      }
      throw error;
    }

    activeThreadId = session.threadId;
    session.adapter.transport.onStderr(chunk => stderr.push(chunk));
    assert.equal(typeof activeThreadId, 'string');
    assert.notEqual(activeThreadId.length, 0);

    let timeoutHandle;
    const timeout = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Timed out after ${TURN_TIMEOUT_MS}ms waiting for turn/completed`)),
        TURN_TIMEOUT_MS
      );
    });
    let completedTurn;
    try {
      await session.adapter.sendTurn({
        threadId: activeThreadId,
        text: 'Reply with exactly the word: PONG',
        options: { approvalPolicy: 'never', cwd }
      });
      completedTurn = await Promise.race([completed, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    const assembledText = completedTexts.length > 0 ? completedTexts.join('') : deltas.join('');
    const diagnostic = stderr.join('').trim();

    assert.equal(completedTurn.status, 'completed', `Codex turn status was ${completedTurn.status}; stderr: ${diagnostic || '<empty>'}`);
    assert.match(assembledText, /PONG/, `Codex emitted no PONG text; stderr: ${diagnostic || '<empty>'}`);
    assert.ok(completedTurns.some(event => event.status === 'completed'));
    console.log(`PASS codex-live-turn: thread ${activeThreadId} completed with ${JSON.stringify(assembledText)}`);
  } finally {
    if (session) session.close();
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
