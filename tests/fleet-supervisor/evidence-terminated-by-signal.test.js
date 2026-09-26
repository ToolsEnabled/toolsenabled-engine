'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  runHarnessCommand,
  verifyEvidence
} = require('../../src/lib/fleet-supervisor/evidence.js');

function signalTerminatedChild({ signal = 'SIGTERM', output = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    throw new Error('the timeout must not try to kill an already closed child');
  };
  process.nextTick(() => {
    if (output) child.stdout.write(output);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null, signal);
  });
  return child;
}

(async () => {
  const plan = {
    executable: process.execPath,
    args: ['fixture.js']
  };

  let directSpawns = 0;
  let directSpawnOptions;
  const direct = await runHarnessCommand(plan, {
    workspace: process.cwd(),
    spawnImpl: (_executable, _args, options) => {
      directSpawns += 1;
      directSpawnOptions = options;
      return signalTerminatedChild({ output: 'partial evidence\n' });
    }
  });

  assert.equal(directSpawns, 1, 'the harness spawns the requested command exactly once');
  assert.deepEqual(directSpawnOptions.stdio, ['ignore', 'pipe', 'pipe'],
    'the harness opens no writable stdin through which it could send input after refusal');
  assert.equal(directSpawnOptions.shell, false, 'the refused command was not delegated to a shell');
  assert.equal(direct.ran, false, 'a signal-terminated command is not reported as having run');
  assert.equal(direct.code, 'TERMINATED_BY_SIGNAL', 'signal termination has its typed refusal code');
  assert.equal(direct.exitCode, null, 'signal termination has no invented exit status');
  assert.equal(direct.output, 'partial evidence\n', 'partial output is diagnostic evidence, not success');
  assert.equal(direct.detail, 'reviewer command terminated by SIGTERM', 'the terminating signal accompanies the refusal');

  let verificationSpawns = 0;
  const verified = await verifyEvidence({
    command: 'node fixture.js',
    claimedOutput: 'partial evidence',
    workspace: process.cwd(),
    spawnImpl: () => {
      verificationSpawns += 1;
      return signalTerminatedChild({ signal: 'SIGKILL', output: 'partial evidence\n' });
    }
  });

  assert.equal(verificationSpawns, 1,
    'refusal does not spawn a confirming rerun even when partial output matches the claim');
  assert.equal(verified.verified, false, 'partial output from a killed command cannot verify the claim');
  assert.equal(verified.classification, 'not-executable', 'the caller receives the refusal classification');
  assert.match(verified.reason, /TERMINATED_BY_SIGNAL reviewer command terminated by SIGKILL/,
    'the caller retains both the typed code and signal detail');
  assert.equal(verified.reruns, 1, 'the refused attempt is recorded without a second execution');
  assert.equal(verified.exitCode, null, 'the caller does not receive an invented exit status');
  assert.equal(verified.harnessOutput, 'partial evidence\n', 'diagnostic partial output remains available');
  assert.equal(verified.match, null, 'refused output is never passed to the output matcher');

  process.stdout.write('fleet-supervisor evidence signal refusal: behaviour checks passed\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
