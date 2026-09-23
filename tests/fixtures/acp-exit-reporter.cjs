'use strict';
// A controlled ACP child that exits after receiving a prompt. Tests select
// an exit code, signal or stderr flood without using a provider account.
const fs = require('node:fs');

const mode = process.env.ACP_EXIT_MODE || 'code';
if (process.env.ACP_EXIT_PID_FILE) fs.writeFileSync(process.env.ACP_EXIT_PID_FILE, String(process.pid));

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

function finish() {
  if (mode === 'signal') return;
  const complaint = process.env.ACP_EXIT_COMPLAINT || '';
  if (mode === 'flood') {
    // More than the adapter keeps, so the bound is measurable rather than assumed.
    process.stderr.write(`${'x'.repeat(50_000)}\nTAIL ${complaint}\n`);
  } else if (complaint) process.stderr.write(`${complaint}\n`);
  // Let stderr reach the parent before the status does.
  setTimeout(() => process.exit(Number(process.env.ACP_EXIT_STATUS || 7)), 50);
}

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
      send({ id: message.id, result: { sessionId: 'exit-reporter-session' } });
    } else if (message.method === 'session/prompt') {
      // The prompt receives no response before the controlled exit.
      finish();
    } else {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
setInterval(() => {}, 1000);
