'use strict';
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
(async () => {
  const requests = [], listeners = [];
  const transport = {
    onData(fn) { listeners.push(fn); return () => {}; },
    write(line) {
      const request = JSON.parse(line); requests.push(request);
      if (!request.id) return;
      const result = request.method === 'initialize'
        ? { userAgent: 'test/1', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' }
        : request.method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } }
          : request.method === 'turn/steer' ? { turnId: 'turn-1' } : {};
      for (const fn of listeners) fn(JSON.stringify({ id: request.id, result }) + '\n');
    },
  };
  const adapter = new CodexAdapter({ transport, codexVersion: '0.146.0' });
  await adapter.initialize();
  await assert.rejects(adapter.steerTurn({ threadId: 'thread-1', turnId: 'turn-1', text: 'report' }), { code: 'CODEX_STEER_TURN_CHANGED' });
  await adapter.sendTurn({ threadId: 'thread-1', text: 'Keep working' });
  assert.deepEqual(await adapter.steerTurn({ threadId: 'thread-1', turnId: 'turn-1', text: 'Peer report' }), { threadId: 'thread-1', turnId: 'turn-1' });
  assert.deepEqual(requests.find(r => r.method === 'turn/steer').params, {
    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Peer report', text_elements: [] }]
  });
  await assert.rejects(adapter.steerTurn({ threadId: 'thread-1', turnId: 'other-turn', text: 'stale' }), { code: 'CODEX_STEER_TURN_CHANGED' });
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests.filter(r => r.method === 'turn/interrupt').length, 0);
  assert.equal(requests.filter(r => r.method === 'turn/steer').length, 1);
  for (const fn of listeners) fn(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } })+'\n');
  await assert.rejects(adapter.steerTurn({ threadId: 'thread-1', turnId: 'turn-1', text: 'late' }), { code: 'CODEX_STEER_TURN_CHANGED' });
  adapter.close();
  console.log('Codex active-turn steering passed without interrupting or starting a second turn.');
})().catch(error => { console.error(error); process.exitCode = 1; });
