'use strict';

const assert = require('node:assert/strict');
const { createClaudeAcpTransport } = require('../../src/lib/agent-engine/claude-process');

async function main() {
  const transport = createClaudeAcpTransport({
    command: process.execPath,
    args: ['-e', "process.stdout.write('present\\n'); process.stderr.write('diagnostic\\n')"],
    env: { PATH: process.env.PATH }
  });

  const stdout = [];
  const stderr = [];
  let exitInfo;

  // These observers prove that a failed observer is local to that observer. If
  // the transport swallowed a read failure instead, the following independent
  // observers could not establish that the output and exit ever happened.
  transport.onData(() => { throw new Error('reject stdout observation'); });
  transport.onStderr(() => { throw new Error('reject stderr observation'); });

  const exited = new Promise(resolve => {
    transport.onData((chunk, info) => {
      if (chunk === null) {
        exitInfo = info;
        resolve();
      } else {
        stdout.push(chunk);
      }
    });
  });
  transport.onStderr(chunk => stderr.push(chunk));

  await exited;
  assert.equal(stdout.join(''), 'present\n');
  assert.equal(stderr.join(''), 'diagnostic\n');
  assert.equal(exitInfo.code, 0);
  assert.equal(exitInfo.error, null);

  process.stdout.write(
    'ok - an observer could not accept delivery is distinguishable from the child did not produce it\n'
  );
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
