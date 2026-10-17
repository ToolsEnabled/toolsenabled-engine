'use strict';

// A deliberately small peer for each driver. The launcher supplies a wholly
// synthetic environment; no installed agent, settings or sign-in is consulted.
const fs = require('node:fs');
const readline = require('node:readline');

function run(driver) {
  const args = process.argv.slice(2);
  const log = value => fs.appendFileSync(process.env.MATRIX_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const rpc = value => send({ jsonrpc: '2.0', ...value });
  const result = (id, value) => rpc({ id, result: value });
  const probe = args.includes('--version') || args.includes('--help');
  log({ started: true, probe, driver, args, env: process.env });
  if (probe) {
    // Help intentionally has no feature claims; the real best-effort probe
    // handles an unknown listing. Version parsing needs a numeric version.
    process.stdout.write(args.includes('--version') ? 'fixture-cli 0.160.0\n' : 'Local inheritance fixture\n');
    return;
  }
  const threadId = `matrix-thread-${process.pid}`;
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  // Start in a different mode so the matrix has to select and confirm Fleet's
  // agent, even when a late config layer changes the CLI's default.
  const configOptions = inline.default_agent ? [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select',
    currentValue: 'build', options: [{ value: 'build', name: 'Build' },
      ...Object.keys(inline.agent || {}).map(value => ({ value, name: value }))] }] : [];
  const kinds = ['read', 'edit', 'execute', 'future-kind'];
  let promptId, permission = 0;
  const nextPermission = () => {
    if (permission === kinds.length) {
      result(promptId, { stopReason: 'end_turn' });
      return;
    }
    const kind = kinds[permission++];
    rpc({ id: `permission-${permission}`, method: 'session/request_permission', params: {
      sessionId: threadId, toolCall: { toolCallId: `tool-${permission}`, kind, title: kind },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Reject once' },
      ],
    } });
  };
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const packet = JSON.parse(line);
    log({ packet });
    if (driver === 'stream-json') {
      if (packet.type === 'control_request') send({ type: 'control_response', response: {
        request_id: packet.request_id, subtype: 'success', response: {},
      } });
      else if (packet.type === 'user') {
        const sessionId = args[args.indexOf('--session-id') + 1];
        send({ type: 'system', subtype: 'init', session_id: sessionId });
        send({ type: 'result', subtype: 'success', session_id: sessionId,
          result: 'Fixture finished.', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
      } else throw new Error(`Unexpected stream packet: ${packet.type}`);
      return;
    }
    const { id, method, params } = packet;
    if (driver === 'app-server') {
      if (method === 'initialize') result(id, { userAgent: 'inheritance-fixture' });
      else if (method === 'initialized') return;
      else if (method === 'config/read') result(id, { config: { developer_instructions: '' } });
      else if (method === 'thread/start') {
        const types = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
        result(id, { thread: { id: threadId, cwd: params.cwd, turns: [] },
          model: params.model || 'fixture-model', reasoningEffort: null,
          sandbox: { type: types[params.sandbox] || 'workspaceWrite' } });
      } else if (method === 'turn/start') {
        result(id, { turn: { id: 'fixture-turn' } });
        rpc({ method: 'turn/completed', params: { threadId, turn: { id: 'fixture-turn', status: 'completed', items: [] } } });
      } else if (method === 'turn/interrupt') result(id, {});
      else throw new Error(`Unexpected app-server method: ${method}`);
      return;
    }
    if (driver !== 'acp') throw new Error(`Unimplemented fixture driver: ${driver}`);
    if (method === 'initialize') result(id, { protocolVersion: 1, agentCapabilities: {},
      agentInfo: { name: 'inheritance-fixture', version: '1' } });
    else if (method === 'session/new') result(id, { sessionId: threadId, ...(configOptions.length ? { configOptions } : {}) });
    else if (method === 'session/set_config_option') {
      const option = configOptions.find(item => item.id === params.configId);
      if (params.sessionId !== threadId || !option?.options.some(item => item.value === params.value)) {
        throw new Error('The fixture cannot select an unadvertised session option.');
      }
      option.currentValue = params.value;
      result(id, { configOptions });
    } else if (method === 'session/prompt') {
      log({ prompted: true, selectedMode: configOptions.find(item => item.category === 'mode')?.currentValue });
      promptId = id; nextPermission();
    }
    else if (Object.hasOwn(packet, 'result')) nextPermission();
    else if (method === 'session/cancel') result(promptId, { stopReason: 'cancelled' });
    else throw new Error(`Unexpected ACP method: ${method}`);
  });
}

module.exports = Object.freeze({ run });
