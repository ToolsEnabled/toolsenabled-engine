'use strict';

const path = require('node:path');
const { createResearchWorkerSupervisor } = require('../../src/lib/research/worker-supervisor');
const { installResearchLifecycle } = require('../../src/lib/research/lifecycle-channel');
if (require.main === module) {
  const dir = process.env.TOOLSENABLED_RESEARCH_CHANNEL_FIXTURE;
  if (!dir || !path.isAbsolute(dir) || !path.basename(dir).startsWith('research-lifecycle-channel-')) throw new Error('Invalid isolated channel fixture.');
  const host = createResearchWorkerSupervisor({ runtimeDir: path.join(dir, 'runtime'), stateFile: path.join(dir, 'state.sqlite3') });
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
