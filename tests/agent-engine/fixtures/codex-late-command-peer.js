'use strict';

// Harmless local app-server peer. It deliberately acknowledges interrupt while
// its own command finishes later, reproducing the observed packet order. No
// provider executable, account configuration, API, or network is involved.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const send = packet => process.stdout.write(`${JSON.stringify(packet)}\n`);
let turn = 0;
const leaf = `
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
child.unref();
process.stdout.write('READY\\n');
setTimeout(()=>process.exit(0),700);
`;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'local-command-fixture' } });
  else if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  } else if (request.method === 'turn/start') {
    const id = `turn-${++turn}`;
    send({ id: request.id, result: { turn: { id } } });
    if (turn === 1) {
      const command = spawn(process.execPath, ['-e', leaf], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
      command.stdout.once('data', () => send({ method: 'item/started', params: { threadId: 'thread-1', turnId: id,
        item: { id: 'command-1', type: 'commandExecution', command: 'harmless local fixture', cwd: process.cwd() } } }));
      command.once('close', code => send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: id,
        item: { id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: code, aggregatedOutput: 'late fixture result' } } }));
    } else {
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: id,
        item: { id: 'reply-2', type: 'agentMessage', text: 'next turn answered' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } });
    }
  }
});
setInterval(() => {}, 1000);
