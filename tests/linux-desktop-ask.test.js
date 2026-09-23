'use strict';
require('./lib/isolated-environment').activate('linux-desktop-ask');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
const { spawnLinuxOwned } = require('../src/lib/linux-process-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const adapter = require('../src/lib/linux-desktop-ask');

test('Linux confirmation uses private input and strict native results without shell or inherited hooks', () => {
  for (const answer of ['yes', 'no', 'timeout']) {
    const result = adapter.ask('/private/payload.tmp', { timeoutMs: 20000,
      environment: { DISPLAY: ':99', LD_PRELOAD: '/injected.so', PYTHONPATH: '/injected', NODE_OPTIONS: '--require=bad' },
      spawnSyncImpl(command, args, options) {
        assert.equal(command, '/usr/bin/python3');
        assert.deepEqual(args.slice(0, 3), ['-I', '-S', '-B']);
        assert.equal(args.at(-1), '/private/payload.tmp');
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 20000);
        assert.equal(options.env.DISPLAY, ':99');
        for (const key of ['LD_PRELOAD', 'PYTHONPATH', 'NODE_OPTIONS']) assert.equal(options.env[key], undefined);
        return { status: 0, stdout: JSON.stringify({ ok: true, answer }) };
      } });
    assert.equal(result.stdout, answer);
  }
  for (const result of [
    { status: 0, stdout: 'yes' }, { status: 0, stdout: '{"ok":true,"answer":"yes","extra":1}' },
    { status: 1, stdout: '{"ok":true,"answer":"yes"}' },
    { status: null, signal: 'SIGTERM', stdout: '{"ok":true,"answer":"yes"}' },
    { status: 0, error: { code: 'ETIMEDOUT' }, stdout: '{"ok":true,"answer":"yes"}' },
  ]) assert.throws(() => adapter.ask('/private/payload.tmp', { spawnSyncImpl: () => result }));
  assert.throws(() => adapter.ask('/private/payload.tmp', { spawnSyncImpl: () => ({ status: 1,
    stdout: '{"ok":false,"code":"DESKTOP_SESSION_UNAVAILABLE"}' }) }), { code: 'DESKTOP_SESSION_UNAVAILABLE' });
});

function authority(number, cookie) {
  const field = data => { const size = Buffer.alloc(2); size.writeUInt16BE(data.length); return Buffer.concat([size, data]); };
  return Buffer.concat([Buffer.from([255, 255]), field(Buffer.alloc(0)), field(Buffer.from(number)),
    field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

test('real Linux dialog approves only Yes; No, Escape, timeout and parent termination leave no dialog',
  { skip: process.platform !== 'linux', timeout: 60000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-confirmation-native-'));
    const children = [], env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
    let originalFailure;
    const launch = (command, args) => {
      const child = spawnLinuxOwned(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true }, { safeLaunchEnvironment });
      child.on('error', () => {}); child.stderr.resume(); children.push(child); return child;
    };
    const cookie = randomBytes(16), serverAuth = path.join(directory, 'server.auth'), clientAuth = path.join(directory, 'client.auth');
    fs.writeFileSync(serverAuth, authority('', cookie), { flag: 'wx', mode: 0o600 });
    try {
      const server = launch('/usr/bin/Xvfb', ['-displayfd', '1', '-screen', '0', '900x700x24', '-nolisten', 'tcp', '-noreset', '-auth', serverAuth]);
      await server.jobReady;
      const reader = createInterface({ input: server.stdout });
      const number = (await reader[Symbol.asyncIterator]().next()).value;
      assert.match(number, /^[0-9]{1,5}$/);
      fs.writeFileSync(clientAuth, authority(number, cookie), { flag: 'wx', mode: 0o600 });
      Object.assign(env, { DISPLAY: ':' + number, XAUTHORITY: clientAuth, XDG_SESSION_TYPE: 'x11' });
      // Keep the test event loop free for the native lifetime handshake.
      const xdo = args => new Promise(resolve => execFile('/usr/bin/xdotool', args,
        { env, encoding: 'utf8', timeout: 7000 }, (error, stdout) => resolve({ status: error ? error.code : 0, stdout })));
      for (const action of ['no', 'yes', 'escape', 'timeout', 'parent-exit']) {
        const title = 'Confirmation fixture ' + randomBytes(8).toString('hex');
        const source = `const desktop=require(${JSON.stringify(path.resolve(__dirname, '../src/lib/desktop'))});
          try { console.log(JSON.stringify(desktop.ask(${JSON.stringify({ title, message: 'Native fixture only. No external action will run.\nLiteral <b>text</b> $(not a command).', timeoutSeconds: 5 })}))); }
          catch(error) { console.log(JSON.stringify({error:error.code||error.message})); process.exitCode=1; }`;
        const child = launch(process.execPath, ['-e', source]);
        const identity = await child.jobReady;
        let output = ''; child.stdout.on('data', data => { output += data; });
        // This display belongs only to this test. Match a new random title,
        // then operate only that window; never search the owner's desktop.
        const found = await xdo(['search', '--sync', '--onlyvisible', '--name', '^' + title + '$']);
        assert.equal(found.status, 0, 'the actual dialog must open: ' + output);
        const windows = found.stdout.trim().split(/\s+/); assert.equal(windows.length, 1);
        const window = windows[0]; assert.match(window, /^[0-9]+$/);
        if (action === 'parent-exit') process.kill(identity.rootPid, 'SIGKILL');
        else if (action !== 'timeout') {
          assert.equal((await xdo(['windowfocus', '--sync', window])).status, 0);
          const keys = action === 'yes' ? ['Tab', 'Return'] : action === 'escape' ? ['Escape'] : ['Return'];
          for (const key of keys) assert.equal((await xdo(['key', key])).status, 0);
        }
        const closed = await child.jobClosed;
        assert.equal(closed.failure, null, action + ': ' + output);
        if (action !== 'parent-exit') {
          const answer = JSON.parse(output.trim());
          assert.equal(answer.answer, action === 'escape' ? 'no' : action);
          assert.equal(answer.approved, action === 'yes');
          assert.equal(answer.timedOut, action === 'timeout');
        }
        assert.notEqual((await xdo(['search', '--onlyvisible', '--name', '^' + title + '$'])).status, 0, 'finished prompts must not linger');
      }
      reader.close();
    } catch (error) { originalFailure = error; throw error; }
    finally {
      const cleanup = [];
      for (const child of children.reverse()) {
        await child.terminateJob(); const closed = await child.jobClosed;
        if (closed.failure) cleanup.push(closed.failure);
      }
      fs.rmSync(directory, { recursive: true });
      if (!originalFailure) assert.deepEqual(cleanup, []);
    }
  });
