'use strict';
// A stand-in for the official Grok CLI, answering only what the account usage
// read may ask, with the replies captured from Grok CLI 1.0.25 on 2026-09-10
// (grok-billing-acp-20260910.json, address and team id replaced). It records
// every method it receives so a test can prove no session or prompt was sent,
// and it stays alive after answering, as the real agent does, so the probe's
// process custody is what ends it.
const fs = require('node:fs');
const path = require('node:path');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'grok-billing-acp-20260910.json'), 'utf8'));
const args = process.argv.slice(2);
const record = method => {
  if (process.env.FAKE_GROK_METHODS) fs.appendFileSync(process.env.FAKE_GROK_METHODS, `${method}\n`);
};

if (args.includes('inspect')) {
  record('inspect');
  const extras = process.env.FAKE_GROK_EXTRAS === '1' ? [{ name: 'ambient' }] : [];
  process.stdout.write(`${JSON.stringify({ hooks: [], plugins: [], mcpServers: extras, lspServers: [] })}\n`);
  process.exit(0);
}

const billing = process.env.FAKE_GROK_BILLING ? JSON.parse(process.env.FAKE_GROK_BILLING) : fixture.billing;
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
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
    if (!message.method) { record(`reply:${message.id}`); continue; }
    record(message.method);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'cached_token', name: 'cached_token' }, { id: 'grok.com', name: 'Grok' }] } });
    } else if (message.method === 'authenticate') {
      send({ method: '_x.ai/mcp/servers_updated', params: { mcpServers: [] } });
      // An agent-to-client request the read must refuse rather than hang on.
      send({ id: 'agent-1', method: 'session/request_permission', params: {} });
      send({ id: message.id, result: { _meta: fixture.authenticateMeta } });
    } else if (message.method === '_x.ai/billing') {
      send({ id: message.id, result: billing });
    } else {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
setInterval(() => {}, 1000);
