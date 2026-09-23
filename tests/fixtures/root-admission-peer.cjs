'use strict';
// Harmless Node protocol peer. It never invokes a CLI, tools, network or auth.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\n');
  process.exit(0);
}
const marker = process.argv[2];
const root = process.env.TOOLSENABLED_TEST_ROOT;
const relative = root && marker ? path.relative(root, marker) : '..';
if (!root || !marker || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('isolated marker required');
fs.writeFileSync(marker, String(process.pid));
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'control_request' && request.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } }) + '\n');
    return;
  }
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { userAgent: 'harmless-node-peer' }
    : { thread: { id: request.params?.threadId || 'harmless-thread', turns: [] } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
