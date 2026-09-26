/*
 * Mutation: changed the non-zero command exit result from present: true to present: false.
 * The edit was applied in src/lib/setup/probe.js and was confirmed to have landed.
 * This isolated test file went red with that mutation (exit code 1).
 * The module was restored to its original SHA-256 before the passing run.
 */
'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');

const {
  commandVersion,
  firstFreePort,
  freeDiskBytes,
  pathExists,
  portIsFree
} = require('../src/lib/setup/probe');

function testCommandVersionReportsObservedProcessState() {
  const calls = [];
  const success = commandVersion('example', ['--version'], {
    env: { SENTINEL: 'yes' },
    runner(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '  example 2.4.1  \nextra output\n' };
    }
  });

  assert.deepEqual(success, { present: true, version: 'example 2.4.1' });
  assert.deepEqual(calls[0], {
    command: 'example',
    args: ['--version'],
    options: {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: { SENTINEL: 'yes' }
    }
  });
  assert.deepEqual(
    commandVersion('example', [], { runner: () => ({ status: 7, stderr: 'no version' }) }),
    { present: true, version: null },
    'a non-zero exit proves the executable is present even when its version is unreadable'
  );
  assert.deepEqual(
    commandVersion('missing', [], {
      runner: () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    }),
    { present: false, version: null }
  );
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    assert.throws(
      () => commandVersion('busy', [], {
        runner: () => ({ error: Object.assign(new Error(code), { code }) })
      }),
      (error) => error.code === 'SETUP_PROBE_COMMAND_UNMEASURED'
        && error.cause.code === code
        && /NOT claiming it is absent/.test(error.message),
      `${code} must remain an unmeasured result rather than become absent`
    );
  }
}

function testFilesystemReadingsPreserveUnknownState() {
  assert.equal(pathExists('/present', { stat: () => ({}) }), true);
  assert.equal(pathExists('/missing', {
    stat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  }), false);
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    assert.throws(
      () => pathExists('/busy', {
        stat: () => { throw Object.assign(new Error(code), { code }); }
      }),
      (error) => error.code === 'SETUP_PROBE_PATH_UNMEASURED'
        && error.cause.code === code
        && /NOT claiming it is absent/.test(error.message),
      `${code} must remain an unmeasured result rather than become missing`
    );
  }

  assert.equal(freeDiskBytes('/disk', { statfs: () => ({ bavail: 12, bsize: 4096 }) }), 49_152);
  assert.equal(freeDiskBytes('/disk', { statfs: () => ({ bavail: Number.NaN, bsize: 4096 }) }), null);
  assert.equal(freeDiskBytes('/disk', { statfs: () => { throw new Error('unavailable'); } }), null);
}

async function testPortReadingsUseActualBindResults() {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });

  const port = occupied.address().port;
  try {
    assert.equal(await portIsFree(port, { host: '127.0.0.1' }), false);
    assert.equal(await firstFreePort({ first: port, last: port }, { host: '127.0.0.1' }), null);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }

  assert.equal(await portIsFree(port, { host: '127.0.0.1' }), true);
  assert.equal(await firstFreePort({ first: port, last: port }, { host: '127.0.0.1' }), port);
  assert.equal(await portIsFree(port, { host: 'not a valid host name' }), null);
  assert.equal(
    await firstFreePort({ first: port, last: port }, { host: 'not a valid host name' }),
    undefined
  );
}

async function run() {
  testCommandVersionReportsObservedProcessState();
  console.log('  PASS commandVersion reports observed process state');
  testFilesystemReadingsPreserveUnknownState();
  console.log('  PASS filesystem readings preserve unknown state');
  await testPortReadingsUseActualBindResults();
  console.log('  PASS port readings use actual bind results');
  console.log('setup probe behaviour tests passed (3 groups).');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
