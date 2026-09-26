'use strict';
require('./lib/isolated-environment').activate('native-agent-probe-shell');
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const launcher = require('../sidecars/native-agent/src/native-agent-launcher');
const host = require('../src/lib/providers/host-control');

function probeArguments(objective) {
  const command = /^  command: (.+)$/m.exec(objective);
  assert.ok(command, 'the acceptance objective contains one concrete command');
  const shell = /^  shell: "([^"]+)"$/m.exec(objective);
  return { command: command[1], ...(shell ? { shell: shell[1] } : {}) };
}

test('Linux acceptance uses a POSIX command and leaves shell choice to the host provider', () => {
  const args = probeArguments(launcher.acceptanceObjective('/opt/Node With Spaces/node', { platform: 'linux' }));
  assert.equal(args.shell, undefined, 'the caller must not override platform automatic selection');
  assert.equal(args.command, `'/opt/Node With Spaces/node' '${launcher.PROBE_FILE}'`);
});

test('probe paths with apostrophes remain one literal argument in each shell grammar', () => {
  assert.equal(launcher.probeCommand("/opt/Node O'Brien/node", { platform: 'linux' }),
    `'/opt/Node O'\\''Brien/node' '${launcher.PROBE_FILE}'`);
  assert.equal(launcher.probeCommand("C:\\Program Files\\Node O'Brien\\node.exe", { platform: 'win32' }),
    `& 'C:\\Program Files\\Node O''Brien\\node.exe' '${launcher.PROBE_FILE}'`);
});

// The provider and generated objective are real. Platform and child lifecycle
// are controlled collaborators: this proves argv selection, not a Linux run.
for (const platform of ['linux', 'win32']) test(`${platform} acceptance reaches the matching host executable with no caller default`, async () => {
  const args = probeArguments(launcher.acceptanceObjective(process.execPath, { platform }));
  let launched;
  const outcome = await host.exec(args, {
    platform, requireRecordAsync: async () => ({ ok: true }), recordAsync: async () => ({ ok: true }),
    spawnInJobImpl(file, argv, options) {
      launched = { file, argv, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.jobOutcome = Promise.resolve({ activeProcesses: 0, exitCode: 0 });
      setImmediate(() => child.emit('close', 0));
      return child;
    }
  });
  assert.equal(outcome.ok, true);
  assert.equal(args.shell, undefined);
  assert.equal(outcome.shell, platform === 'linux' ? 'sh' : 'powershell');
  assert.equal(launched.file, platform === 'linux' ? '/bin/sh'
    : '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(launched.options.shell, false);
  assert.equal(launched.argv.at(-1), args.command);
  if (platform === 'linux') assert.deepEqual(launched.argv, ['-c', args.command]);
  else assert.ok(launched.argv.includes('-NoProfile'));
});
