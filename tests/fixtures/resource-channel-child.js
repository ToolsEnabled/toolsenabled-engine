'use strict';

// Harmless private-IPC fixture only. It never loads a provider, authentication
// config, owner state, or mission service. Its optional child exits by itself.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createResourceClient, CHANNEL } = require('../../src/lib/agent-resource-channel');
const client = createResourceClient({ requestMs: Number(process.argv[2]) || undefined });
const leases = new Map();
const raw = new Map();
let nextLease = 0;
function report(value) { if (process.connected) process.send({ channel: 'fixture', ...value }); }
process.on('message', async message => {
  if (message?.channel === CHANNEL && message.type === 'reply' && raw.has(message.sequence)) {
    report({ id: raw.get(message.sequence), result: message }); raw.delete(message.sequence); return;
  }
  if (message?.channel !== 'fixture') return;
  try {
    let result;
    if (message.op === 'reserve') {
      const lease = await client.reserveLane(message.request || { provider: 'claude' }, message.principal || { kind: 'owner-ui' });
      const id = String(++nextLease); leases.set(id, lease); result = { leaseId: id, admission: lease.admission };
    } else if (message.op === 'consume') {
      leases.get(message.leaseId).beforeSpawn(); result = { consumed: true };
    } else if (message.op === 'root-check') {
      await leases.get(message.leaseId).prepareRootSpawn();
      leases.get(message.leaseId).beforeRootSpawn(); result = { checked: true };
    } else if (message.op === 'release') {
      leases.get(message.leaseId).release(); result = { released: true };
    } else if (message.op === 'direct-lane') {
      const { startAgentLane } = require('../../src/lib/mission-bridge/agent-lane-dispatch');
      const execution = startAgentLane({}, {
        // Exercise the direct branch even when this harmless fixture runs on
        // Windows. It proves transport/boundary wiring, not a native Linux OS.
        platform: 'linux', capMs: 3000, presence: {},
        env: { SystemRoot: process.env.SystemRoot, TEMP: process.cwd(), TMP: process.cwd() },
        reserveResources: () => client.reserveLane({ provider: 'claude' }, message.principal),
        runLane: async (_options, dependencies) => {
          await dependencies.beforeSpawn();
          const child = dependencies.spawnImpl(process.execPath, ['-e',
            'process.stdout.write("harmless-direct-root\\n"); process.exit(typeof process.send === "undefined" && !process.env.NODE_CHANNEL_FD ? 0 : 23)'], {
            cwd: process.cwd(), env: {}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
          let output = ''; let errors = '';
          child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
          child.once('spawn', () => report({ event: 'direct-root-spawned' }));
          return new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => resolve({ code, output, errors }));
          });
        },
      });
      void execution.started.catch(() => {});
      result = await execution.completion;
    } else if (message.op === 'spawn') {
      const lease = leases.get(message.leaseId);
      lease.beforeSpawn();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(typeof process.send === "undefined" && !process.env.NODE_CHANNEL_FD ? 0 : 23), 350)'], {
        cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot }, stdio: 'ignore', windowsHide: true,
      });
      if (message.unprovenJob) child.jobOutcome = Promise.reject(new Error('Synthetic missing Windows job outcome.'));
      lease.spawned(child);
      child.once('spawn', () => { if (!message.unprovenJob) lease.ready(); report({ event: 'spawned' }); });
      child.once('close', code => report({ event: 'closed', code }));
      child.once('error', error => report({ event: 'child-error', code: error.code }));
      result = { started: true };
    } else if (message.op === 'windows-job') {
      const jobs = require('../../src/lib/windows-job-control');
      const { safeLaunchEnvironment } = require('../../src/lib/providers/subscription-launch-env');
      const lease = leases.get(message.leaseId);
      lease.beforeSpawn();
      const child = jobs.spawnInJob(process.execPath, ['-e', 'process.stdout.write("harmless-root-started\\n"); setTimeout(() => process.exit(0), 150)'], {
        cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot, TEMP: process.cwd(), TMP: process.cwd() },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      }, {
        safeLaunchEnvironment, recordDirectory: path.join(process.cwd(), 'job-records'), assemblyCacheDirectory: path.join(process.cwd(), 'job-cache'),
        connectPipeImpl: async (name, options) => {
          if (message.wrapperDelayMs) await new Promise(resolve => setTimeout(resolve, message.wrapperDelayMs));
          return jobs.connectPipe(name, options);
        },
        prepareRootSpawn: () => lease.prepareRootSpawn(),
        beforeRootSpawn() {
          report({ event: 'root-check' });
          lease.beforeRootSpawn();
          report({ event: 'root-permitted' });
        },
      });
      lease.spawned(child);
      let output = ''; let errors = '';
      child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
      child.on('error', error => report({ event: 'child-error', code: error.code }));
      let refusal = null;
      child.jobReady.then(() => { lease.ready(); report({ event: 'root-ready' }); }, error => { refusal = error.code; report({ event: 'root-refused', code: error.code }); });
      child.jobOutcome.then(outcome => report({ event: 'job-outcome', outcome }), error => report({ event: 'job-unproven', code: error.code }));
      child.once('close', code => {
        report({ event: 'closed', code, output, errors });
        if (message.disconnectBeforeOwner) process.stdout.write(`WINDOWS_DISCONNECTED_RESULT ${JSON.stringify({ code, output, refusal })}\n`);
      });
      if (message.disconnectBeforeOwner) setTimeout(() => { client.close(); process.disconnect(); }, 100);
      result = { wrapperStarted: true };
    } else if (message.op === 'disconnect-then-consume') {
      client.close();
      process.disconnect();
      try { leases.get(message.leaseId).beforeSpawn(); process.stdout.write('UNEXPECTED_START\n'); }
      catch (error) { process.stdout.write(`${error.code}\n`); }
      return;
    } else if (message.op === 'raw') {
      raw.set(message.value.sequence, message.id); process.send(message.value); return;
    } else if (message.op === 'stop') { client.close(); process.exit(0); }
    else throw new Error('Unknown fixture command.');
    report({ id: message.id, ok: true, result });
  } catch (error) { report({ id: message.id, ok: false, code: error.code || 'FIXTURE_ERROR', message: error.message }); }
});
client.connect().then(result => report({ event: 'ready', ...result }), error => report({ event: 'failed', code: error.code }));
const deadline = setTimeout(() => process.exit(0), 20000);
deadline.unref();
