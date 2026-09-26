'use strict';
// A stand-in agent that speaks ACP correctly until it is asked for a turn, and
// then answers with a response carrying an id nobody requested. That is one of
// the shapes acp-adapter's strict response matching refuses outright
// (_handleResponse: "ACP response did not match a pending request"), so the
// reader fails closed with ACP_PROTOCOL_INVALID -- the code the owner's
// resumed Grok session refused every send with.
//
// It records its own pid and then STAYS ALIVE, exactly as the real agent did
// while the poisoned session still looked ready, so a test can prove that what
// ends this process is the adapter's own closure and nothing else.
const fs = require('node:fs');

if (process.env.ACP_POISON_PID_FILE) fs.writeFileSync(process.env.ACP_POISON_PID_FILE, String(process.pid));

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const UNREQUESTED_ID = 424242;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (!message.method) continue;
    if (message.method === 'initialize') {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    } else if (message.method === 'session/new' || message.method === 'session/load') {
      send({ id: message.id, result: { sessionId: 'poison-session' } });
    } else if (message.method === 'session/prompt') {
      // Never answers the prompt's own id. The turn stays pending until the
      // reader refuses this line and rejects it.
      send({ id: UNREQUESTED_ID, result: {} });
    } else {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
setInterval(() => {}, 1000);
