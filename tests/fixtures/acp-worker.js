'use strict';

// A local ACP peer: no model, network, settings or sign-in access.
const fs = require('node:fs');
const readline = require('node:readline');
const log = value => fs.appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const update = value => send({ method: 'session/update', params: { sessionId: 'fixture-session', update: value } });
let prompt = null, permissionId = 100, queue = [], always = false, failAfterTools = false, failMessage = null;
log({ started: true, pid: process.pid, args: process.argv.slice(2),
  signInKept: process.env.OPENAI_API_KEY === 'synthetic-agent-sign-in',
  sessionSignInKept: process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN === 'synthetic-session-sign-in' });

function nextTool() {
  if (!queue.length) {
    if (failAfterTools) {
      send({ id: prompt, error: { code: -32603, message: failMessage || 'Fixture prompt failed after its tools.' } });
      prompt = null;
      return;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture finished.' } });
    result(prompt, { stopReason: 'end_turn' });
    prompt = null;
    return;
  }
  const kind = queue.shift(), toolCallId = `call-${permissionId}`;
  update({ sessionUpdate: 'tool_call', toolCallId, title: `Fixture ${kind}`, kind, status: 'pending' });
  const options = [
    { optionId: 'persistent-yes', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'persistent-no', kind: 'reject_always', name: 'Always reject' },
    ...(!always ? [
      { optionId: 'one-no', kind: 'reject_once', name: 'Reject once' },
      { optionId: 'one-yes', kind: 'allow_once', name: 'Allow once' },
    ] : []),
  ];
  send({ id: permissionId++, method: 'session/request_permission',
    params: { sessionId: 'fixture-session', toolCall: { toolCallId, kind, title: `Fixture ${kind}` }, options } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log(message);
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (process.argv.includes('--hang-initialize')) return;
    result(id, { protocolVersion: process.argv.includes('--bad-version') ? 99 : 1,
      agentCapabilities: { loadSession: !process.argv.includes('--no-load') },
      agentInfo: { name: 'fixture-agent', version: '1' },
      authMethods: [{ id: 'interactive-sign-in', name: 'Sign in yourself' }] });
  } else if (method === 'session/new' || method === 'session/load') {
    if (process.argv.includes('--auth-required')) {
      send({ id, error: { code: -32000, message: 'Authentication required' } });
      return;
    }
    if (method === 'session/load') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old history.' } });
    }
    result(id, method === 'session/new' ? { sessionId: 'fixture-session' }
      : process.argv.includes('--wrong-session') ? { sessionId: 'different-session' } : {});
  } else if (method === 'session/prompt') {
    prompt = id;
    const text = params.prompt.map(block => block.text || '').join('');
    if (text.includes('hold-until-cancel')) return;
    if (text.includes('exit-mid-turn')) process.exit(0);
    if (text.includes('malformed-mid-turn')) { process.stdout.write('not JSON\n'); return; }
    let script;
    try { script = JSON.parse(text); } catch { script = {}; }
    queue = script.kinds || ['read', 'edit', 'execute'];
    always = script.always === true;
    failAfterTools = script.failAfterTools === true;
    failMessage = typeof script.failMessage === 'string' ? script.failMessage : null;
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Fixture thinking.' } });
    // An extension request a Fleet client does not offer; its answer resumes the turn.
    if (script.askFirst === true || text.includes('[[ask-first]]')) {
      send({ id: 'fixture-ask-1', method: '_fixture/ask', params: { sessionId: 'fixture-session', question: 'May I?' } });
      return;
    }
    nextTool();
  } else if (id === 'fixture-ask-1' && Object.hasOwn(message, 'error')) {
    nextTool();
  } else if (method === 'session/cancel') {
    if (prompt !== null) { result(prompt, { stopReason: 'cancelled' }); prompt = null; }
  } else if (Object.hasOwn(message, 'result')) {
    update({ sessionUpdate: 'tool_call_update', toolCallId: `call-${id}`, status: 'completed' });
    nextTool();
  } else {
    send({ id, error: { code: -32601, message: 'Fixture does not support this method.' } });
  }
});
