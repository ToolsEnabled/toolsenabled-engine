'use strict';
require('./lib/isolated-environment').activate('linux-process-control');
const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { spawnLinuxOwned } = require('../src/lib/linux-process-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { runProcess } = require('../src/lib/research/runners');
const hostControl = require('../src/lib/providers/host-control');

assert.equal(process.platform, 'linux');
function launch(program, { terminateDescendantsOnRootExit = true, beforeRootSpawn,
  spawnImpl, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  const child = spawnLinuxOwned(process.execPath, ['-e', program], {
    env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    stdio, terminateDescendantsOnRootExit,
  }, { safeLaunchEnvironment, beforeRootSpawn, spawnImpl });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.stdin?.on('error', () => {});
  child.on('error', () => {});
  const timer = setTimeout(() => { void child.terminateJob(); }, 5000);
  child.jobClosed.finally(() => clearTimeout(timer));
  return { child, output: () => output, errors: () => errors };
}
function empty(outcome, minimum = 1) {
  assert.equal(outcome.backend, 'linux-subreaper-pidfd-v2');
  assert.equal(outcome.activeProcesses, 0);
  assert.equal(outcome.observedChildren >= minimum, true, JSON.stringify(outcome));
  assert.equal(outcome.observedChildren, outcome.reapedChildren);
}

const hostAdmission = {
  requireRecordAsync: async () => ({ durable: true }),
  recordAsync: async () => ({ durable: true })
};
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

test('host commands use native Linux shells and the OS profile even with a private test HOME', async t => {
  const directory = fs.mkdtempSync(path.join(os.userInfo().homedir, '.te-linux-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const good = await hostControl.exec({ command: 'printf "host-native-ok\\n"; pwd', cwd: directory }, hostAdmission);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.shell, 'sh');
  assert.equal(good.stdout, `host-native-ok\n${directory}\n`);
  const failed = await hostControl.exec({ command: 'printf "host-native-failure\\n"; exit 7', shell: 'bash', cwd: directory }, hostAdmission);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stdout, 'host-native-failure\n');
  const startup = path.join(directory, 'startup.sh');
  fs.writeFileSync(startup, 'printf "UNREQUESTED_STARTUP\\n"; exit 13\n');
  const previous = process.env.BASH_ENV;
  process.env.BASH_ENV = startup;
  try {
    const clean = await hostControl.exec({ command: 'printf "requested-command\\n"', shell: 'bash', cwd: directory }, hostAdmission);
    assert.equal(clean.ok, true);
    assert.equal(clean.stdout, 'requested-command\n', 'the command does not source ambient shell startup code');
  } finally {
    if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous;
  }
  const processes = await hostControl.listProcesses({}, hostAdmission);
  const self = processes.processes.find(row => row.pid === process.pid);
  assert.ok(self && self.name && self.workingSetBytes > 0);
  assert.equal(self.startTime, null, 'unmeasured start time stays explicit');
  const filtered = await hostControl.listProcesses({ nameFilter: self.name.toUpperCase() }, hostAdmission);
  assert.ok(filtered.processes.some(row => row.pid === process.pid));
  assert.ok(filtered.processes.every(row => row.name.toLowerCase().includes(self.name.toLowerCase())));
});

test('host timeout reaps its actual shell and a detached descendant before answering', async () => {
  const program = `require('node:child_process').spawn(process.execPath,['-e',
    'process.stdout.write("DETACHED_READY\\\\n");setInterval(()=>{},1000)'],
    {detached:true,stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  let child;
  const result = await hostControl.exec({ command: `${shellQuote(process.execPath)} -e ${shellQuote(program)}`, timeoutMs: 1000 }, {
    ...hostAdmission,
    spawnInJobImpl(...args) { child = spawnLinuxOwned(...args); return child; }
  });
  assert.match(result.stdout, /DETACHED_READY/);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.terminationFailure, null);
  empty(await child.jobOutcome, 3);
  assert.equal((await child.jobClosed).failure, null);
});

test('host output limit stops the native scope and keeps only the bounded output', async () => {
  let child;
  const result = await hostControl.exec({ command: 'while :; do printf "0123456789012345678901234567890123456789"; done', timeoutMs: 5000 }, {
    ...hostAdmission,
    spawnInJobImpl(...args) { child = spawnLinuxOwned(...args); return child; }
  });
  assert.equal(result.outputTruncated, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, false);
  assert.equal(Buffer.byteLength(result.stdout), hostControl.MAX_OUTPUT_BYTES);
  empty(await child.jobOutcome);
});

test('host launch failures retain their typed native refusal and cannot report success', async () => {
  const result = await hostControl.exec({ command: 'printf MUST_NOT_EXECUTE' }, {
    ...hostAdmission,
    spawnImpl(_command, args, options) {
      return spawn(path.join(__dirname, 'fixtures', 'absent-linux-host-helper'), args, options);
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
  assert.equal(result.error.code, 'LINUX_PROCESS_HELPER_UNAVAILABLE');
  assert.ok(result.terminationFailure, 'missing custody cannot claim successful cleanup');
});

test('interactive stdin and arbitrary stdout never share the private native receipt channel', async () => {
  const f = launch('process.stdin.on("data", b => { process.stdout.write(b); process.exit(0); });');
  await f.child.jobReady;
  const spoof = '{"version":2,"type":"complete","quiescent":true}\n';
  f.child.stdin.write(spoof);
  const outcome = await f.child.jobOutcome;
  empty(outcome); assert.equal(outcome.exitCode, 0);
  assert.equal(f.output(), spoof);
  assert.equal((await f.child.jobClosed).failure, null);
});

test('native admission identifies the measured root separately from its guardian', async () => {
  const f = launch('process.stdout.write(JSON.stringify({pid:process.pid}));');
  const ready = await f.child.jobReady;
  const outcome = await f.child.jobOutcome;
  empty(outcome);
  assert.equal(ready.rootPid, JSON.parse(f.output()).pid);
  assert.notEqual(ready.rootPid, f.child.pid);
  assert.equal((await f.child.jobClosed).failure, null);
});

test('readonly file stdin preserves its open position through the retained native wrapper', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-owned-file-stdin-'));
  const file = path.join(directory, 'brief.txt');
  const content = 'skip:exact native file content \u00e9\n';
  fs.writeFileSync(file, content);
  let fd = fs.openSync(file, 'r');
  let f;
  try {
    fs.readSync(fd, Buffer.alloc(5), 0, 5, null);
    f = launch(`const fs=require('node:fs');let writeError=null;
      try{fs.writeSync(0,'forbidden');}catch(error){writeError=error.code;}
      process.stdout.write(JSON.stringify({regularFile:fs.fstatSync(0).isFile(),writeError,input:fs.readFileSync(0,'utf8')}));`, {
      stdio: [fd, 'pipe', 'pipe']
    });
    fs.closeSync(fd); fd = null;
    assert.equal(f.child.stdin, null, 'a duplicated input file has no parent writer');
    const outcome = await f.child.jobOutcome;
    empty(outcome);
    assert.equal(outcome.exitCode, 0);
    assert.equal((await f.child.jobClosed).failure, null);
    assert.deepEqual(JSON.parse(f.output()), { regularFile: true, writeError: 'EBADF', input: content.slice(5) });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (f) { await f.child.terminateJob().catch(() => {}); await f.child.jobClosed; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid or non-file stdin descriptors refuse before creating the native wrapper', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-owned-invalid-stdin-'));
  const directoryFd = fs.openSync(directory, 'r');
  const file = path.join(directory, 'closed.txt');
  fs.writeFileSync(file, 'fixture');
  const closedFd = fs.openSync(file, 'r');
  fs.closeSync(closedFd);
  let spawns = 0;
  try {
    for (const fd of [-1, 0.5, directoryFd, closedFd]) {
      assert.throws(() => spawnLinuxOwned(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: [fd, 'pipe', 'pipe']
      }, { safeLaunchEnvironment, spawnImpl() { spawns += 1; throw new Error('must not create a wrapper'); } }),
      { code: 'LINUX_PROCESS_INPUT_INVALID' });
    }
    assert.equal(spawns, 0);
  } finally {
    fs.closeSync(directoryFd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('root exit cleans a real detached leaf, retaining pidfds until ECHILD', async () => {
  const leaf = 'process.stdout.write("LEAF_READY\\n");setInterval(()=>{},1000);';
  const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','pipe','inherit'],env:process.env});c.stdout.once('data',()=>process.exit(0));`;
  const f = launch(root);
  await f.child.jobReady;
  const outcome = await f.child.jobOutcome;
  empty(outcome, 2); assert.equal(outcome.exitCode, 0); assert.equal(outcome.type, 'exit');
  assert.equal((await f.child.jobClosed).failure, null);
});

test('retained cancellation reaps a live root and setsid descendant without PID/group selection', async () => {
  const leaf = 'process.stdout.write("LEAF_READY\\n");setInterval(()=>{},1000);';
  const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','pipe','inherit'],env:process.env});c.stdout.once('data',()=>process.stdout.write('TREE_READY\\n'));setInterval(()=>{},1000);`;
  const f = launch(root);
  await f.child.jobReady;
  if (!f.output().includes('TREE_READY')) await once(f.child.stdout, 'data');
  assert.match(f.output(), /TREE_READY/);
  const first = f.child.terminateJob();
  assert.equal(f.child.terminateJob(), first);
  const outcome = await first;
  empty(outcome, 2); assert.equal(outcome.type, 'terminated');
  assert.equal((await f.child.jobClosed).failure, null);
});

// This disposable guardian installs a kernel seccomp denial in its own process.
// It changes no host profile or service. The recording wrapper calls the real
// syscall and records only actual EPERM; it does not invent denied signals.
test('kernel-denied cleanup signals are bounded while custody lasts until the child really exits', async t => {
  const shim = `import ctypes, errno, signal, sys, time
class Filter(ctypes.Structure):
    _fields_ = [("code",ctypes.c_ushort),("jt",ctypes.c_ubyte),("jf",ctypes.c_ubyte),("k",ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [("len",ctypes.c_ushort),("filter",ctypes.POINTER(Filter))]
# pidfd_send_signal=424 on Linux x86_64/aarch64. Allow signal0 admission,
# and make only actual positive signals fail with kernel EPERM.
filters = (Filter * 6)(Filter(0x20,0,0,0),Filter(0x15,0,3,424),
    Filter(0x20,0,0,24),Filter(0x15,1,0,0),Filter(0x06,0,0,0x50000|errno.EPERM),Filter(0x06,0,0,0x7fff0000))
libc = ctypes.CDLL(None,use_errno=True)
assert libc.prctl(38,1,0,0,0) == 0
program = Program(6,filters)
assert libc.prctl(22,2,ctypes.byref(program),0,0) == 0
real_send = signal.pidfd_send_signal
def measured(fd,sig,*args):
    try:
        return real_send(fd,sig,*args)
    except PermissionError as error:
        assert error.errno == errno.EPERM
        sys.stderr.write("KERNEL_DENIED:%s:%s\\n" % (sig,time.monotonic()))
        sys.stderr.flush()
        raise
signal.pidfd_send_signal = measured
source = sys.argv[1]
exec(compile(open(source).read(),source,"exec"),{"__name__":"__main__"})
`;
  const f = launch('process.stdout.write("DENIAL_CHILD_READY\\n");setTimeout(()=>process.exit(0),2200);', {
    spawnImpl(command, args, options) {
      return spawn(command, ['-I', '-S', '-B', '-c', shim, args.at(-1)], options);
    }
  });
  await f.child.jobReady;
  if (!f.output().includes('DENIAL_CHILD_READY')) await once(f.child.stdout, 'data');
  assert.match(f.output(), /DENIAL_CHILD_READY/);
  let settled = false;
  f.child.jobOutcome.then(() => { settled = true; });
  const pending = f.child.terminateJob();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(settled, false, 'denial or retry exhaustion cannot release a live descendant');
  const attempts = f.errors().trim().split('\n').filter(line => line.startsWith('KERNEL_DENIED:'));
  assert.ok(attempts.length >= 2 && attempts.length <= 6, 'actual kernel-denied signal calls: ' + attempts.length);
  assert.ok(attempts.some(line => line.startsWith('KERNEL_DENIED:9:')), 'the native kernel refused SIGKILL');
  const outcome = await pending;
  empty(outcome);
  assert.equal(outcome.reasonCode, 'LINUX_PROCESS_OBSERVER_FAILED');
  assert.equal(outcome.exitCode, 0, 'the denied child exited naturally');
  assert.equal(f.errors().trim().split('\n').filter(line => line.startsWith('KERNEL_DENIED:')).length, attempts.length,
    'exhausted signals are not sent again while waiting for natural exit');
  assert.equal((await f.child.jobClosed).failure, null, 'only actual waitid/ECHILD establishes empty custody');
  t.diagnostic(JSON.stringify({ realKernelEPERM: true, deniedSignalCalls: attempts.length,
    custodyUnresolvedAfterMs: 1200, naturalChildExit: true, finalOutcome: outcome }));
});

test('admission refusal happens before the executable, with a positively closed empty scope', async () => {
  const f = launch('process.stdout.write("MUST_NOT_EXECUTE");', {
    beforeRootSpawn() { throw Object.assign(new Error('private refusal'), { code: 'FIXTURE_REFUSAL' }); }
  });
  await assert.rejects(f.child.jobReady, { code: 'FIXTURE_REFUSAL' });
  const outcome = await f.child.jobOutcome;
  empty(outcome, 0); assert.equal(outcome.observedChildren, 0);
  assert.equal(outcome.type, 'not-started'); assert.equal(f.output(), '');
  assert.equal((await f.child.jobClosed).failure, null);
});

test('real Linux research runner preserves declared JSON stdin and reports native success, not a group guess', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-runner-stdin-'));
  let outcome;
  try {
    outcome = await runProcess({ experiment: { runnerConfig: { command: process.execPath,
      args: ['-e', 'let x="";process.stdin.on("data",b=>x+=b).on("end",()=>process.stdout.write(x));'],
      envKeys: ['ELECTRON_RUN_AS_NODE'], stdin: 'params-json' }, timeoutMs: 5000 },
      run: { runId: 'linux-native-stdin', params: { text: 'fixture', count: 2 } }, artifactDir: dir });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(JSON.parse(outcome.stdout), { text: 'fixture', count: 2 });
    assert.equal(outcome.processLifecycle.backend, 'linux-subreaper-pidfd-v2');
    assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY');
    assert.equal(outcome.processLifecycle.acceptanceReady, true);
    assert.equal(outcome.processLifecycle.groupStopRequested, false);
  } finally {
    if (outcome?.processLifecycle.cleanupStatus === 'EMPTY') fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing native executable settles ignored stdin without a crash or invented empty receipt', async () => {
  const missing = path.join(__dirname, 'fixtures', 'absent-linux-native-helper');
  assert.equal(fs.existsSync(missing), false);
  const f = launch('process.stdout.write("MUST_NOT_EXECUTE");', {
    stdio: ['ignore', 'pipe', 'pipe'],
    spawnImpl(_command, args, options) { return spawn(missing, args, options); }
  });
  await assert.rejects(f.child.jobReady, { code: 'LINUX_PROCESS_HELPER_UNAVAILABLE' });
  const outcome = await f.child.jobOutcome;
  assert.equal(outcome.type, 'unknown');
  assert.equal(outcome.activeProcesses, null);
  assert.equal(outcome.observedChildren, null);
  assert.equal(f.output(), '');
  assert.equal((await f.child.jobClosed).failure, 'LINUX_PROCESS_HELPER_UNAVAILABLE');
});

test('an asynchronous admission callback is refused and its rejected promise cannot escape', async () => {
  const f = launch('process.stdout.write("MUST_NOT_EXECUTE");', {
    async beforeRootSpawn() { throw new Error('private asynchronous refusal'); }
  });
  await assert.rejects(f.child.jobReady, { code: 'LINUX_PROCESS_ADMISSION_ASYNC' });
  const outcome = await f.child.jobOutcome;
  empty(outcome, 0);
  assert.equal(outcome.observedChildren, 0);
  assert.equal(outcome.type, 'not-started');
  assert.equal(f.output(), '');
  assert.equal((await f.child.jobClosed).failure, null);
});

test('actual helper EOF and wrong private nonce cannot attest an empty process scope', async t => {
  for (const kind of ['eof', 'wrong-nonce']) await t.test(kind, async () => {
    // A finite dependency fixture, not a mocked cleanup receipt: it creates no
    // worker or descendant. The actual adapter must reject its private stream.
    const program = kind === 'eof' ? 'process.exit(0);'
      : 'require("node:fs").writeSync(3,JSON.stringify({version:2,nonce:"0".repeat(64),type:"ready"})+"\\n");process.exit(0);';
    const f = launch('process.stdout.write("MUST_NOT_EXECUTE");', {
      stdio: ['ignore', 'pipe', 'pipe'],
      spawnImpl(_command, _args, options) {
        return spawn(process.execPath, ['-e', program], {
          ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }
        });
      }
    });
    await assert.rejects(f.child.jobReady, {
      code: kind === 'eof' ? 'LINUX_PROCESS_CLEANUP_UNPROVEN' : 'LINUX_PROCESS_PROTOCOL_INVALID'
    });
    const outcome = await f.child.jobOutcome;
    assert.equal(outcome.type, 'unknown');
    assert.equal(outcome.activeProcesses, null);
    assert.equal(outcome.reapedChildren, null);
    assert.equal(f.output(), '');
    assert.notEqual((await f.child.jobClosed).failure, null);
  });
});

// The same fixture body is exercised below with inert fd/process boundaries.
// Resource release is conditional on the exact owned child's closed receipt.
async function descriptorInheritanceCase() {
  let directory = null, lockFd = null, server = null, child = null;
  let primaryError = null, cleanupError = null;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-owned-fd-'));
    const lockPath = path.join(directory, 'lifetime.lock');
    lockFd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const socketFd = server._handle.fd;
    const socketTarget = fs.readlinkSync('/proc/self/fd/' + socketFd);
    const held = pid => {
      const rows = [];
      for (const name of fs.readdirSync('/proc/' + pid + '/fd')) {
        try { rows.push(fs.readlinkSync('/proc/' + pid + '/fd/' + name)); } catch { /* raced */ }
      }
      return rows;
    };
    child = launch('setTimeout(() => {}, 4000);', {
      spawnImpl(command, args, options) {
        const stdio = [...options.stdio];
        while (stdio.length < 9) stdio.push('ignore');
        stdio[9] = lockFd;
        stdio[10] = socketFd;
        return spawn(command, args, { ...options, stdio });
      }
    }).child;
    const ready = await child.jobReady;
    for (const [role, pid] of [['helper', child.pid], ['worker', ready.rootPid]]) {
      const rows = held(pid);
      assert.equal(rows.includes(lockPath), false, role + ' still holds the lifetime lock');
      assert.equal(rows.includes(socketTarget), false, role + ' still holds the listening socket');
    }
  } catch (error) { primaryError = error; }
  finally {
    try {
      if (child) {
        // Await both settlements even when cancellation refuses. Unknown custody
        // keeps the fixture intact; the enclosing owned test runner can report it.
        let outcome, terminationError;
        try { outcome = await child.terminateJob(); } catch (error) { terminationError = error; }
        const closed = await child.jobClosed;
        if (terminationError) throw terminationError;
        empty(outcome, 0);
        assert.equal(closed.failure, null);
      }
      if (server) await new Promise((resolve, reject) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      if (lockFd !== null) fs.closeSync(lockFd);
      if (directory !== null) fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) { cleanupError = error; }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'descriptor fixture cleanup unconfirmed');
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
}

test('neither the helper nor the worker inherits a caller descriptor above the fd contract',
  { skip: process.platform !== 'linux' ? 'Linux descriptor tables only' : false }, descriptorInheritanceCase);

// No sockets, processes or filesystem mutations cross these VM boundaries.
function inertDescriptorCase({ failAt = '', held = false, leak = false } = {}) {
  const vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const events = [], failure = new Error('inert ' + failAt);
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
  };
  const termination = deferred(), closure = deferred();
  const outcome = { backend: 'linux-subreaper-pidfd-v2', activeProcesses: 0, observedChildren: 1, reapedChildren: 1 };
  if (!held) {
    if (failAt === 'terminate') termination.reject(failure); else termination.resolve(outcome);
    closure.resolve({ failure: failAt === 'closed' ? failure : null });
  }
  const step = name => { events.push(name); if (failAt === name) throw failure; };
  const server = new EventEmitter();
  server._handle = { fd: 71 };
  server.listen = (_port, _host, callback) => {
    events.push('listen');
    if (failAt === 'listen') server.emit('error', failure);
    else callback();
  };
  server.close = callback => {
    events.push('server-close');
    if (callback) callback(failAt === 'server-close' ? failure : undefined);
  };
  const io = {
    constants: { O_RDWR: 2, O_CREAT: 64 },
    mkdtempSync() { step('mkdir'); return '/inert/linux-owned-fd-case'; },
    openSync() { step('open'); return 70; },
    readlinkSync(file) {
      if (file === '/proc/self/fd/71') { step('readlink'); return 'socket:[inert]'; }
      return leak ? '/inert/linux-owned-fd-case/lifetime.lock' : '/dev/null';
    },
    readdirSync() { return ['9']; },
    closeSync(fd) { assert.equal(fd, 70); events.push('fd-close'); },
    rmSync(file) { assert.equal(file, '/inert/linux-owned-fd-case'); events.push('remove'); }
  };
  const child = {
    pid: 100, jobReady: failAt === 'ready' ? Promise.reject(failure) : Promise.resolve({ rootPid: 101 }),
    jobClosed: closure.promise,
    terminateJob() { events.push('terminate'); return termination.promise; }
  };
  child.jobReady.catch(() => {});
  let finished = false;
  const result = vm.runInNewContext('(' + descriptorInheritanceCase.toString() + ')()', {
    fs: io, net: { createServer() { step('server'); return server; } },
    os: { tmpdir: () => '/inert' }, path, assert, empty,
    launch() { step('launch'); return { child }; },
    spawn() { throw new Error('inert descriptor fixture must not spawn'); }
  }).then(() => ({ ok: true }), error => ({ ok: false, error })).then(value => { finished = true; return value; });
  return { result, events, failure, termination, closure, outcome, finished: () => finished };
}
const descriptorFlush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const failAt of ['mkdir', 'open', 'server', 'listen', 'readlink', 'launch', 'ready']) {
  test('descriptor fixture releases only acquired resources after ' + failAt + ' failure', async () => {
    const f = inertDescriptorCase({ failAt });
    const result = await f.result;
    assert.equal(result.ok, false);
    assert.equal(result.error, f.failure);
    const expected = failAt === 'mkdir' ? [] : failAt === 'open' ? ['remove']
      : failAt === 'server' ? ['fd-close', 'remove'] : ['server-close', 'fd-close', 'remove'];
    assert.deepEqual(f.events.filter(name => ['server-close', 'fd-close', 'remove'].includes(name)), expected);
    assert.equal(f.events.includes('terminate'), failAt === 'ready');
    if (failAt === 'ready') assert.ok(f.events.indexOf('terminate') < f.events.indexOf('server-close'));
  });
}
for (const leak of [false, true]) {
  test('descriptor fixture awaits owned termination and closure after ' + (leak ? 'assertion failure' : 'success'), async () => {
    const f = inertDescriptorCase({ held: true, leak });
    await descriptorFlush();
    assert.equal(f.finished(), false);
    assert.equal(f.events.filter(name => name === 'terminate').length, 1);
    assert.equal(f.events.includes('server-close'), false);
    f.termination.resolve(f.outcome);
    await descriptorFlush();
    assert.equal(f.finished(), false);
    assert.equal(f.events.includes('server-close'), false);
    f.closure.resolve({ failure: null });
    const result = await f.result;
    assert.equal(result.ok, !leak);
    if (leak) assert.match(result.error.message, /helper still holds the lifetime lock/);
    assert.deepEqual(f.events.slice(-3), ['server-close', 'fd-close', 'remove']);
  });
}
for (const failAt of ['terminate', 'closed']) {
  test('descriptor fixture retains resources for unconfirmed ' + failAt, async () => {
    const f = inertDescriptorCase({ failAt });
    const result = await f.result;
    assert.equal(result.ok, false);
    assert.equal(f.events.filter(name => name === 'terminate').length, 1);
    assert.equal(f.events.some(name => ['server-close', 'fd-close', 'remove'].includes(name)), false);
  });
}
test('descriptor fixture preserves the assertion and retains fixtures when cleanup also refuses', async () => {
  const f = inertDescriptorCase({ failAt: 'terminate', leak: true });
  const result = await f.result;
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'AggregateError');
  assert.match(result.error.errors[0].message, /helper still holds the lifetime lock/);
  assert.equal(result.error.errors[1], f.failure);
  assert.equal(f.events.includes('remove'), false);
});
test('descriptor fixture retains its file resources until listener close is confirmed', async () => {
  const f = inertDescriptorCase({ failAt: 'server-close' });
  const result = await f.result;
  assert.equal(result.ok, false);
  assert.equal(result.error, f.failure);
  assert.equal(f.events.includes('fd-close'), false);
  assert.equal(f.events.includes('remove'), false);
});

const DESCRIPTOR_SANITATION_PROBE = "import ast\nimport errno\nimport os\nfrom pathlib import Path\nimport sys\nimport unittest\n\nROOT = Path(sys.argv[1])\nFILES = {\n    \"supervisor\": ROOT / \"src/lib/linux-process-supervisor.py\",\n    \"vault\": ROOT / \"src/linux-vault.py\",\n}\n\nclass Descriptors:\n    def __init__(self, unavailable=False, refused=False):\n        self.unavailable, self.refused = unavailable, refused\n        self.opened = set(range(5)) | {9, 10}\n        self.closed, self.ranges = [], []\n    def listdir(self, path):\n        assert path == \"/proc/self/fd\"\n        if self.unavailable:\n            raise OSError(errno.EACCES, \"inert enumeration refused\")\n        return [str(fd) for fd in sorted(self.opened)] + [\"27\"]\n    def sysconf(self, name):\n        assert name == \"SC_OPEN_MAX\"\n        return 8  # fd9/10 existed before the soft limit was lowered.\n    def closerange(self, low, high):\n        self.ranges.append((low, high))\n        self.opened.difference_update(range(low, high))\n    def close(self, fd):\n        if self.refused and fd == 9:\n            raise OSError(errno.EACCES, \"inert close refused\")\n        if fd not in self.opened:\n            raise OSError(errno.EBADF, \"listing descriptor already closed\")\n        self.closed.append(fd)\n        self.opened.remove(fd)\n\ndef function(kind, io):\n    tree = ast.parse(FILES[kind].read_text())\n    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == \"close_inherited\")\n    env = {\"os\": io, \"errno\": errno, \"CONTRACT\": (0, 1, 2, 3, 4)}\n    # Compile only the exact sanitizer definition, never import/start a helper.\n    exec(compile(ast.Module(body=[node], type_ignores=[]), str(FILES[kind]), \"exec\"), env)\n    return env[\"close_inherited\"]\n\nclass Sanitation(unittest.TestCase):\n    pass\n\ndef unavailable(kind):\n    def check(self):\n        io = Descriptors(unavailable=True)\n        with self.assertRaisesRegex(RuntimeError, \"enumeration unavailable\"):\n            function(kind, io)()\n        self.assertIn(9, io.opened)\n        self.assertEqual(io.closed, [])\n        self.assertEqual(io.ranges, [])\n    return check\n\ndef refused(kind):\n    def check(self):\n        io = Descriptors(refused=True)\n        with self.assertRaisesRegex(RuntimeError, \"closure unconfirmed\"):\n            function(kind, io)()\n        self.assertIn(9, io.opened)\n    return check\n\ndef complete(kind):\n    def check(self):\n        io = Descriptors()\n        function(kind, io)()\n        self.assertEqual(io.opened, set(range(5 if kind == \"supervisor\" else 3)))\n        self.assertEqual(io.ranges, [])\n    return check\n\nfor kind in FILES:\n    for name, make in [(\"unavailable_enumeration_above_lowered_limit\", unavailable),\n                       (\"unconfirmed_close_refuses_admission\", refused),\n                       (\"complete_enumeration_preserves_contract\", complete)]:\n        setattr(Sanitation, \"test_\" + kind + \"_\" + name, make(kind))\n\ndef entry_calls(kind, name):\n    node = next(n for n in ast.parse(FILES[kind].read_text()).body if isinstance(n, ast.FunctionDef) and n.name == name)\n    return [n.value.func.id for n in node.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)]\n\ndef supervisor_entry(self):\n    self.assertEqual(entry_calls(\"supervisor\", \"main\")[0], \"close_inherited\")\ndef vault_entry(self):\n    self.assertEqual(entry_calls(\"vault\", \"main\")[0], \"close_inherited\")\n    self.assertEqual(entry_calls(\"vault\", \"serve\")[0], \"close_inherited\")\n    self.assertNotIn(\"close_inherited\", entry_calls(\"vault\", \"protect_process\"))\n\nSanitation.test_supervisor_sanitizes_before_ownership_setup = supervisor_entry\nSanitation.test_vault_subprocess_only_preserves_imported_prompt = vault_entry\nresult = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Sanitation))\nprint(\"%d checks; failures=%d; errors=%d\" % (result.testsRun, len(result.failures), len(result.errors)))\nraise SystemExit(0 if result.testsRun == 8 and result.wasSuccessful() else 1)\n";

test('descriptor sanitation refuses incomplete inherited-fd knowledge through inert OS boundaries', () => {
  const result = require('node:child_process').spawnSync('/usr/bin/python3',
    ['-I', '-S', '-B', '-c', DESCRIPTOR_SANITATION_PROBE, path.resolve(__dirname, '..')], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'], shell: false
    });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /8 checks; failures=0; errors=0/);
});
