'use strict';

const path = require('node:path');
const { createResearchWorkerSupervisor } = require('../../src/lib/research/worker-supervisor');
const { installResearchLifecycle } = require('../../src/lib/research/lifecycle-channel');
if (require.main === module) {
  const dir = process.env.TOOLSENABLED_RESEARCH_CHANNEL_FIXTURE;
  if (!dir || !path.isAbsolute(dir) || !path.basename(dir).startsWith('research-lifecycle-channel-')) throw new Error('Invalid isolated channel fixture.');
  const host = createResearchWorkerSupervisor({ runtimeDir: path.join(dir, 'runtime'), stateFile: path.join(dir, 'state.sqlite3') });
  if (process.argv[2] === '--bridge-parent-lifetime') {
    // Run the actual executable's main with its real inherited IPC lifecycle.
    // Only the credential-bearing HTTP surface is replaced by a real, private
    // loopback listener; this fixture does not claim bridge API qualification.
    const fs = require('node:fs');
    const net = require('node:net');
    const vm = require('node:vm');
    const filename = path.resolve(__dirname, '../../tools/mission-bridge.js');
    const entryRequire = require('node:module').createRequire(filename);
    const socket = net.createServer();
    setTimeout(() => process.exit(2), 5000);
    process.on('message', message => {
      if (message?.channel === 'toolsenabled.test.fixture' && message.type === 'lose-parent') process.disconnect();
    });
    process.argv = [process.execPath, filename, '--research-lifecycle-channel', 'inherited'];
    const load = request => {
      if (request === '../src/lib/research/worker-supervisor') return { getResearchWorkerSupervisor: () => host };
      if (request === '../src/lib/mission-bridge/server') return {
        BOOTSTRAP_PROOF_FILE: null,
        createMissionBridgeServer: () => ({
          listen: () => new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.listen(0, '127.0.0.1', () => resolve({ baseUrl: 'http://127.0.0.1', port: socket.address().port,
              runtime: { startedAt: Date.now(), pid: process.pid } }));
          }),
          close: () => new Promise((resolve, reject) => socket.close(error => {
            if (error) return reject(error);
            fs.writeFileSync(path.join(dir, 'bridge-closed.json'), JSON.stringify({ admissionSealed: host.snapshot().admissionSealed,
              listenerClosed: !socket.listening }), { mode: 0o600 });
            resolve();
          }))
        })
      };
      return entryRequire(request);
    };
    vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmain().catch(error => { process.stderr.write(error.stack); process.exit(3); });`,
      { require: load, module: { exports: {} }, process }, { filename });
  } else {
  const server = installResearchLifecycle({ host });
  const maximum = setTimeout(() => { server.close(); process.exit(2); }, 5000);
  process.on('disconnect', () => { clearTimeout(maximum); server.close(); process.exitCode = 0; });
  process.on('message', async message => {
    if (message?.channel === 'toolsenabled.test.fixture' && message.type === 'finish') {
      server.close(); process.disconnect();
    }
    if (message?.channel === 'toolsenabled.test.fixture' && message.type === 'terminal') {
      try {
        const observed = await host.quiesceOwned({ requestId: 'actual-terminal-cleanup' });
        await server.publishQuiescence(observed);
        server.close(); process.disconnect();
      } catch { server.close(); process.exit(3); }
    }
  });
  }
}
