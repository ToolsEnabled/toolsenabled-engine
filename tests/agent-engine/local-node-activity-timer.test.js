'use strict';

/* THE LOCAL TURN TIMER MEASURES SILENCE, NOT DURATION.
 *
 * The adapter's own header promises "the same generosity as the Claude
 * engine": a timeout that fires on honest work kills a session that was
 * succeeding, and the timer exists only so a runtime that stalls without
 * closing its stream cannot leave a promise pending forever. The Claude engine
 * keeps that promise with an activity clock (text, reasoning and tool activity
 * refresh it). This adapter armed one timer at turn start and never refreshed
 * it, so a productive tool-and-reasoning turn longer than turnTimeoutMs was
 * aborted mid-work as LOCAL_NODE_TURN_TIMEOUT and its answer discarded.
 *
 * Both halves are proved with a short turnTimeoutMs: a busy turn whose every
 * gap is well inside the window but whose total is far beyond it completes,
 * and a runtime that genuinely goes silent is still stopped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-local-timer-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;
test.after(() => { try { fs.rmSync(STATE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const { LocalNodeAdapter } = require('../../src/lib/agent-engine/local-node-adapter');

const WINDOW_MS = 300;
const STEP_MS = 90;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function abortable(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}

test('a productive reasoning-and-tool turn longer than the window completes; activity refreshes the timer', async () => {
  let rounds = 0;
  const tools = {
    list: () => [{ name: 'slow.lookup', description: 'A slow lookup', inputSchema: { type: 'object', properties: {} }, server: 'fake' }],
    async call() { await pause(STEP_MS * 2); return { text: 'looked up', isError: false }; }
  };
  const adapter = new LocalNodeAdapter({
    model: 'test:1b', tools, turnTimeoutMs: WINDOW_MS,
    transport: {
      async chat(body, { signal, onAccepted, onPacket }) {
        rounds += 1;
        const stop = abortable(signal);
        const step = async (packet, ms = STEP_MS) => { await Promise.race([pause(ms), stop]); await onPacket(packet); };
        await onAccepted?.();
        if (rounds === 1) {
          /* Reasoning only: the model is working, nothing is spoken yet. */
          for (let i = 0; i < 4; i += 1) await step({ message: { role: 'assistant', content: '', thinking: `step ${i} ` }, done: false });
          await step({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'slow.lookup', arguments: {} } }] }, done: true, done_reason: 'stop' });
          return;
        }
        for (const word of ['The ', 'answer ', 'is ', 'ready.']) await step({ message: { role: 'assistant', content: word }, done: false });
        await step({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
      }
    }
  });
  const events = [];
  adapter.onEvent(event => events.push(event));
  const { threadId } = await adapter.startThread({});
  const started = Date.now();
  const result = await adapter.sendTurn({ threadId, text: 'look it up' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed > WINDOW_MS * 2, `the turn really outlasted the window (${elapsed}ms > ${WINDOW_MS * 2}ms)`);
  assert.equal(result.status, 'success', 'honest work is not cut off by a fixed deadline');
  assert.equal(result.text, 'The answer is ready.');
  assert.ok(events.some(event => event.type === 'tool_result'), 'the tool round ran');
  assert.equal(events.at(-1).type, 'turn_completed');
  adapter.close?.();
});

test('a runtime that goes silent is still stopped after the window', async () => {
  const adapter = new LocalNodeAdapter({
    model: 'test:1b', turnTimeoutMs: WINDOW_MS,
    transport: {
      async chat(body, { signal, onAccepted, onPacket }) {
        await onAccepted?.();
        await onPacket({ message: { role: 'assistant', content: 'Starting' }, done: false });
        await abortable(signal); // never another byte
      }
    }
  });
  const { threadId } = await adapter.startThread({});
  /* The adapter unrefs its timer (it must not hold the application open), so
     an otherwise idle test process needs its own reason to keep running. */
  const keepAlive = setInterval(() => {}, 1_000);
  const started = Date.now();
  try {
    await assert.rejects(adapter.sendTurn({ threadId, text: 'hang' }), error => error && error.code === 'LOCAL_NODE_TURN_TIMEOUT');
  } finally { clearInterval(keepAlive); }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= WINDOW_MS - 20 && elapsed < WINDOW_MS * 4, `the stall is ended by the silence window (${elapsed}ms)`);
  adapter.close?.();
});
