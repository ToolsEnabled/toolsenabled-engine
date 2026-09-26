'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { startClaudeSession } = require('../../src/lib/agent-engine/claude-process');

const START_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 180_000;
const EXPECTED_WORD = 'PINEAPPLE';
const STDERR_LIMIT = 64 * 1024;
const FIXTURE_AGENT_ARG = '--toolsenabled-claude-turn-fixture';

function runFixtureAgent() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const respond = (request, result) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  };
  input.on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      respond(request, {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false }
        },
        agentInfo: { name: 'toolsenabled-claude-turn-fixture', version: '1' },
        authMethods: []
      });
      return;
    }
    if (request.method === 'session/new') {
      respond(request, { sessionId: `fixture-session-${process.pid}` });
      return;
    }
    if (request.method === 'session/prompt') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: EXPECTED_WORD },
            messageId: 'fixture-message-1'
          }
        }
      })}\n`);
      respond(request, { stopReason: 'end_turn' });
      return;
    }
    respond(request, {});
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createFixtureAgentCommand(directory) {
  if (process.platform === 'win32') {
    const command = path.join(directory, 'claude-turn-fixture.cmd');
    fs.writeFileSync(command,
      `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "${__filename.replace(/"/g, '""')}" ${FIXTURE_AGENT_ARG}\r\n`,
      'utf8');
    return command;
  }
  const command = path.join(directory, 'claude-turn-fixture');
  fs.writeFileSync(command,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(__filename)} ${FIXTURE_AGENT_ARG}\n`, 'utf8');
  fs.chmodSync(command, 0o700);
  return command;
}

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > STDERR_LIMIT ? combined.slice(-STDERR_LIMIT) : combined;
}

async function main() {
  const apiKey = typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.trim()
    ? process.env.ANTHROPIC_API_KEY
    : null;
  const fixtureRoot = apiKey ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-claude-turn-'));
  const previousCommand = process.env.CLAUDE_ACP_COMMAND;
  if (fixtureRoot) process.env.CLAUDE_ACP_COMMAND = createFixtureAgentCommand(fixtureRoot);
  const cwd = process.cwd();
  const deltas = [];
  const completedTexts = [];
  const completedTurns = [];
  let stderr = '';
  let session = null;
  let activeThreadId = null;

  try {
    session = await startClaudeSession({
      cwd,
      apiKey,
      startupTimeoutMs: START_TIMEOUT_MS,
      onEvent(event) {
        if (activeThreadId && event.threadId !== activeThreadId) return;
        if (event.type === 'assistant_text_delta') deltas.push(event.text);
        if (event.type === 'assistant_text') completedTexts.push(event.text);
        if (event.type === 'turn_completed') completedTurns.push(event);
      }
    });

    activeThreadId = session.threadId;
    session.adapter.transport.onStderr(chunk => {
      stderr = appendBounded(stderr, chunk);
    });
    assert.equal(typeof activeThreadId, 'string');
    assert.notEqual(activeThreadId.length, 0);

    let timeoutHandle;
    const timeout = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Timed out after ${TURN_TIMEOUT_MS}ms waiting for the Claude ACP turn`)),
        TURN_TIMEOUT_MS
      );
    });
    let turn;
    try {
      turn = await Promise.race([
        session.adapter.sendTurn({
          threadId: activeThreadId,
          text: `Reply with exactly the word: ${EXPECTED_WORD}`
        }),
        timeout
      ]);
    } catch (error) {
      // A session can be established and the PROMPT still be refused for auth;
      // that is the shape measured on machine-a, so the check belongs here and
      // not only around startClaudeSession above.
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const assembledText = completedTexts.length > 0 ? completedTexts.join('') : deltas.join('');
    const diagnostic = stderr.trim();
    assert.match(assembledText, new RegExp(EXPECTED_WORD),
      `Claude emitted no ${EXPECTED_WORD} text; stderr: ${diagnostic || '<empty>'}`);
    assert.ok(completedTurns.length > 0, `Claude emitted no turn_completed; stderr: ${diagnostic || '<empty>'}`);
    assert.ok(completedTurns.some(event => event.turnId === turn.turnId),
      `Claude turn_completed did not match ${turn.turnId}; stderr: ${diagnostic || '<empty>'}`);
    console.log(`PASS claude-live-turn: ${apiKey ? 'authenticated live ACP' : 'fixture-backed ACP process'} thread ${activeThreadId} completed with assistant text ${JSON.stringify(assembledText)}`);
  } finally {
    if (session) session.close();
    if (previousCommand === undefined) delete process.env.CLAUDE_ACP_COMMAND;
    else process.env.CLAUDE_ACP_COMMAND = previousCommand;
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes(FIXTURE_AGENT_ARG)) {
  runFixtureAgent();
} else {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
