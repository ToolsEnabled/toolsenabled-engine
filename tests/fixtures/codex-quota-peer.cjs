'use strict';

// A local JSON-RPC peer and detached descendant; no provider or credentials.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const [mode, marker] = process.argv.slice(2);
if (!['success', 'timeout', 'abort', 'output'].includes(mode) || !marker) process.exit(64);
const descendant = spawn(process.execPath, ['-e',
  'process.send({ready:true,pid:process.pid});setInterval(()=>{},60000);'],
{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true, windowsHide: true, env: process.env });
const ready = new Promise(resolve => descendant.once('message', message => {
  fs.writeFileSync(marker, JSON.stringify({ root: process.pid, descendant: message.pid }), { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ method: 'fixture/ready' })}\n`);
  resolve();
  if (mode === 'output') process.stderr.write(Buffer.alloc(131073, 65));
}));
descendant.unref();
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  const request = JSON.parse(line);
  await ready;
  if (mode !== 'success') return;
  const result = request.id === 1 ? {} : request.id === 2
    ? { account: { type: 'chatgpt', email: 'native-fixture@example.invalid', planType: 'plus' } }
    : { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 2000000000 } } };
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
setInterval(() => {}, 60000);
