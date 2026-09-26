'use strict';

// Offline lifecycle regressions. Protocol packets are fixtures; the pipe-error
// case owns a real Node child, never a provider process or signed-in account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');
const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');
const { createClaudeCliTransport } = require('../../src/lib/agent-engine/claude-cli-process');

function codexFixture() {
  let receive;
  const writes = [];
  const adapter = new CodexAdapter({
    codexVersion: CODEX_CLI_VERSION,
    transport: {
      onData(listener) { receive = listener; return () => {}; },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') {
          receive(`${JSON.stringify({ id: request.id, result: {
            userAgent: 'offline-fixture', codexHome: '/fixture',
            platformFamily: 'fixture', platformOs: 'fixture'
          } })}\n`);
        }
      }
    }
  });
  return { adapter, writes, reply: packet => receive(`${JSON.stringify(packet)}\n`) };
}

async function settledByNextTurn(promise) {
  return Promise.race([
    promise.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', code: error.code })),
    new Promise(resolve => setImmediate(() => resolve({ status: 'pending' })))
  ]);
}

for (const [name, begin] of [
  ['start', adapter => adapter.startThread()],
  ['resume', adapter => adapter.resumeThread('saved-thread')],
  ['send', adapter => adapter.sendTurn({ threadId: 'saved-thread', text: 'one turn' })],
  ['interrupt', adapter => adapter.interrupt({ threadId: 'saved-thread', turnId: 'running-turn' })]
]) {
  for (const malformed of [null, [], {}, { code: 'invalid' }]) {
    test(`Codex ${name} settles after malformed RPC error ${JSON.stringify(malformed)}`, async t => {
      const f = codexFixture();
      t.after(() => f.adapter.close());
      await f.adapter.initialize();
      const pending = begin(f.adapter);
      f.reply({ id: f.writes.at(-1).id, error: malformed });
      assert.deepEqual(await settledByNextTurn(pending), { status: 'rejected', code: 'CODEX_PROTOCOL_INVALID' },
        'a closed protocol reader must reject the control it can no longer answer');
      await assert.rejects(f.adapter.startThread(), { code: 'CODEX_PROTOCOL_INVALID' });
    });
  }
}

test('Claude failed stop write releases its pending control and preserves the turn', async () => {
  let receive;
  const sent = [];
  const failure = Object.assign(new Error('fixture pipe became unavailable'), { code: 'EPIPE' });
  const adapter = new ClaudeCliAdapter({ transport: {
    onData(listener) { receive = listener; },
    send(packet) {
      sent.push(packet);
      if (packet.type === 'control_request') throw failure;
    }
  } });
  await adapter.resumeThread('saved-thread');
  const running = adapter.sendTurn({ threadId: 'saved-thread', text: 'one turn' });
  try {
    await assert.rejects(adapter.interrupt(), error => error === failure);
    assert.equal(adapter.pendingControl.size, 0,
      'a handled write error must not leave another promise to reject during close or timeout');
    receive({ type: 'result', subtype: 'success', result: 'answer after the failed stop' });
    assert.equal((await running).text, 'answer after the failed stop');
  } finally {
    // A red pre-fix run must not leave its orphaned control promise rejecting
    // after the assertion. Supply the fixture acknowledgement before cleanup.
    for (const packet of sent.filter(packet => packet.type === 'control_request')) {
      receive({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id } });
    }
    adapter.close();
    await running.catch(() => {});
  }
});

test('Claude stdin errors terminate the protocol without an uncaught stream error', async t => {
  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    stderrSink: () => null
  });
  const closed = new Promise(resolve => transport.child.once('close', resolve));
  t.after(async () => { transport.close(); await closed; });
  const packets = [];
  const exits = [];
  transport.onData((packet, info) => packet === null ? exits.push(info) : packets.push(packet));
  const failure = Object.assign(new Error('fixture write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => transport.child.stdin.emit('error', failure),
    'Node emits a failed pipe write asynchronously on stdin; the transport must handle it');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].error, failure);
  assert.deepEqual(packets, []);
  assert.throws(() => transport.send({ type: 'user' }), { code: 'CLAUDE_CLI_CLOSED' });
  transport.child.stdin.emit('error', failure);
  assert.equal(exits.length, 1, 'subsequent pipe errors must not emit another session ending');
  transport.child.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
  assert.deepEqual(packets, [], 'a protocol already ended by a pipe failure cannot deliver later output');
});

test('Claude timeout closes the uncorrelated stream before another turn can be admitted', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  let receive;
  const sent = [], events = [];
  let transportCloses = 0;
  const adapter = new ClaudeCliAdapter({ turnTimeoutMs: 20, transport: {
    onData(listener) { receive = listener; },
    send(packet) { sent.push(packet); },
    close() { transportCloses += 1; }
  } });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.resumeThread('timeout-thread');
  await assert.rejects(adapter.sendTurn({ threadId: 'timeout-thread', text: 'first question' }),
    { code: 'CLAUDE_CLI_TURN_TIMEOUT' });
  assert.equal(transportCloses, 1, 'timing out must reclaim the program still working on the old request');
  const second = adapter.sendTurn({ threadId: 'timeout-thread', text: 'second question' });
  receive({ type: 'result', subtype: 'success', result: 'late answer to the first question' });
  await assert.rejects(second, { code: 'CLAUDE_CLI_CLOSED' },
    'the old result cannot become a successful answer to the next question');
  assert.equal(sent.length, 1, 'no subsequent work can enter the timed-out stream');
  assert.deepEqual(events, [], 'late packets cannot reopen a timed-out session');
});

test('Claude timeout closes its real owned process and detached descendant', {
  skip: !['linux', 'win32'].includes(process.platform), timeout: 20000
}, async t => {
  const leaf = 'process.stdout.write("READY\\n");setInterval(()=>{},1000);';
  const program = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','pipe','inherit'],env:process.env});child.stdout.once('data',()=>process.stdout.write(JSON.stringify({type:'fixture_ready'})+'\\n'));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
  const transport = createClaudeCliTransport({ command: process.execPath, args: ['-e', program],
    stderrSink: () => null });
  t.after(async () => { transport.close(); await transport.child.jobOutcome; await transport.child.jobClosed; });
  await new Promise((resolve, reject) => transport.onData((packet, info) => {
    if (packet?.type === 'fixture_ready') resolve();
    else if (packet === null) reject(new Error(`fixture ended before readiness: ${JSON.stringify(info)}`));
  }));
  const adapter = new ClaudeCliAdapter({ transport, turnTimeoutMs: 20 });
  t.after(() => adapter.close());
  await adapter.resumeThread('timeout-thread');
  await assert.rejects(adapter.sendTurn({ threadId: 'timeout-thread', text: 'never answered' }),
    { code: 'CLAUDE_CLI_TURN_TIMEOUT' });
  const receipt = await transport.child.jobOutcome;
  assert.equal(receipt.activeProcesses, 0, 'the terminal timeout must end its actual process scope');
  assert.equal((await transport.child.jobClosed).failure, null);
  if (process.platform === 'linux') {
    assert.ok(receipt.observedChildren >= 2, 'the measured cleanup includes the detached descendant');
    assert.equal(receipt.observedChildren, receipt.reapedChildren);
  }
});
