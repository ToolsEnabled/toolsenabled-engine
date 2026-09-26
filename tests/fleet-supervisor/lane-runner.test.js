'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_REPORTED_FILES,
  changedFileCount,
  laneEnvironment,
  runLane,
  parseReportedFiles
} = require('../../src/lib/fleet-supervisor/lane-runner.js');

// The lane response contract is deliberately exercised with values rather
// than by inspecting the implementation. A supervisor needs normalized file
// names from the two report lines, even when Gemini uses Markdown backticks or
// supplies only one of the two lines.
assert.deepEqual(
  parseReportedFiles([
    'Work complete.',
    'FILES-READ: `src/input.js`, docs/guide.md',
    'FILES-CHANGED: `src/output.js`, tests/output.test.js'
  ].join('\n')),
  {
    filesRead: ['src/input.js', 'docs/guide.md'],
    filesChanged: ['src/output.js', 'tests/output.test.js']
  }
);
assert.deepEqual(parseReportedFiles('FILES-READ: (none)'), {
  filesRead: [],
  filesChanged: []
});
assert.equal(parseReportedFiles('ordinary response with no file report'), null);

// Bound hostile or accidental over-reporting to the exported contract limit.
const tooMany = Array.from({ length: MAX_REPORTED_FILES + 5 }, (_, index) => `file-${index}.js`);
assert.equal(
  parseReportedFiles(`FILES-CHANGED: ${tooMany.join(', ')}`).filesChanged.length,
  MAX_REPORTED_FILES
);

// Exercise changedFileCount through its injected command boundary: the lane
// ownership marker is bookkeeping, not work product, and an unavailable git
// measurement must remain unknown rather than being reported as a clean lane.
let invocation;
const count = changedFileCount('/worktree', (command, args, options) => {
  invocation = { command, args, options };
  return ' M src/changed.js\n?? .toolsenabled-fleet-lane.json\n?? tests/new.test.js\n';
});
assert.equal(count, 2);
assert.deepEqual(invocation, {
  command: 'git',
  args: ['status', '--porcelain'],
  options: { cwd: '/worktree', encoding: 'utf8', windowsHide: true, shell: false }
});
assert.equal(changedFileCount('/worktree', () => { throw new Error('git unavailable'); }), null);

async function exerciseRefusals() {
  // A Vertex request without an explicitly configured account must refuse
  // before it probes credentials or creates the per-lane settings home.
  const vertexFsCalls = [];
  const vertexFs = {
    existsSync(file) { vertexFsCalls.push(['existsSync', file]); return true; },
    mkdirSync(file) { vertexFsCalls.push(['mkdirSync', file]); },
    writeFileSync(file) { vertexFsCalls.push(['writeFileSync', file]); }
  };
  assert.throws(
    () => laneEnvironment({
      backend: 'vertex',
      laneId: 'account-refusal',
      project: 'explicit-project',
      account: null,
      baseEnv: { APPDATA: '/credentials' },
      fsImpl: vertexFs,
      tmpdir: () => '/scratch'
    }),
    error => error.code === 'FLEET_VERTEX_ACCOUNT_MISSING' && /configured billing account/.test(error.message)
  );
  assert.deepEqual(vertexFsCalls, [], 'account refusal must not probe, create, or write files');

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-runner-refusals-'));
  try {
    let spawnCount = 0;
    const common = {
      cwd: worktree,
      buildOnboardingPacket: () => 'onboarding packet',
      resolveExecutable: () => ({ command: 'gemini', prefixArgs: [] }),
      spawnImpl: () => { spawnCount += 1; throw new Error('spawn must not be reached'); }
    };

    // An unclassified environment-builder failure is normalized to the
    // generic refusal and resolves (rather than rejecting) without spawning.
    const envRefusal = await runLane({
      ...common,
      laneId: 'env-refusal',
      brief: 'brief',
      buildEnvironment: () => { throw new Error('injected environment refusal'); }
    });
    assert.deepEqual(envRefusal, {
      ok: false,
      code: 'LANE_ENV_REFUSED',
      detail: 'injected environment refusal',
      changedFileCount: 0
    });
    assert.equal(spawnCount, 0);
    assert.deepEqual(fs.readdirSync(worktree), [], 'environment refusal must not write in the worktree');

    // A lane id containing a missing path component makes the module's real
    // scratch-file write fail. This drives BRIEF_FILE_FAILED without replacing
    // fs or merely searching the source, and must still stop before spawn.
    const missingComponent = `missing-${process.pid}-${Date.now()}`;
    const briefRefusal = await runLane({
      ...common,
      laneId: `${missingComponent}/brief-refusal`,
      brief: 'brief',
      buildEnvironment: () => ({ env: {}, home: null, billing: { backend: 'subscription' } })
    });
    assert.equal(briefRefusal.ok, false);
    assert.equal(briefRefusal.code, 'BRIEF_FILE_FAILED');
    assert.equal(briefRefusal.changedFileCount, 0);
    assert.match(briefRefusal.detail, /ENOENT/);
    assert.equal(spawnCount, 0);
    assert.deepEqual(fs.readdirSync(worktree), [], 'brief refusal must not write in the worktree');
    assert.equal(
      fs.existsSync(path.join(os.tmpdir(), `toolsenabled-fleet-lane-brief-${missingComponent}`)),
      false,
      'failed staging must not leave a scratch directory behind'
    );
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

async function exerciseRunningLifetimes() {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const crypto = require('node:crypto');
  const { spawnHidden } = require('../../src/lib/proc/hidden-spawn');
  const { root } = require('../lib/isolated-environment').activate('lane-fd-lifetime');
  const directory = fs.mkdtempSync(path.join(root, 'lane-lifetime-'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // timeoutMs starts before native ownership, root, and detached-leaf cold start.
  // Match the proven Windows allowance so Linux observes real lifetime behavior.
  const limit = 10000;
  const brief = 'Long brief \u00e9 \u4e16\u754c\n'.repeat(10000);
  const prompt = 'Isolated onboarding fixture.\n\n' + brief;
  const expectedHash = crypto.createHash('sha256').update(prompt).digest('hex');
  try {
    for (const mode of ['success', 'timeout', 'nonzero']) {
      const marker = path.join(directory, `${mode}.effects`), done = path.join(directory, `${mode}.done`);
      const inputReceipt = path.join(directory, `${mode}.stdin.json`);
      const script = path.join(directory, `${mode}.root.cjs`), leaf = path.join(directory, `${mode}.leaf.cjs`);
      fs.writeFileSync(leaf, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ready');
        const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'effect'),20);
        setTimeout(()=>{clearInterval(t);fs.writeFileSync(${JSON.stringify(done)},'done');},${mode === 'timeout' ? limit + 1000 : 1000});`);
      fs.writeFileSync(script, `const fs=require('node:fs'),crypto=require('node:crypto');
        let writeError=null;try{fs.writeSync(0,'must-not-write');}catch(e){writeError=e.code;}
        const input=fs.readFileSync(0);fs.writeFileSync(${JSON.stringify(inputReceipt)},JSON.stringify({regularFile:fs.fstatSync(0).isFile(),writeError,bytes:input.length,sha256:crypto.createHash('sha256').update(input).digest('hex'),onboardingHash:process.env.TOOLSENABLED_ONBOARDING_PACKET_HASH}));
        const leaf=require('node:child_process').spawn(process.execPath,[${JSON.stringify(leaf)}],{detached:true,stdio:'ignore',windowsHide:true});leaf.unref();
        const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(ready);
          process.stdout.write(JSON.stringify({response:'FILES-READ: (none)\\nFILES-CHANGED: (none)',stats:{models:{fixture:{tokens:{total:1}}}}}),()=>{${mode === 'timeout' ? '' : `process.exit(${mode === 'nonzero' ? 7 : 0});`}});},5);
        setTimeout(()=>process.exit(0),${limit + 1500});`);
      let child, closed = false, closedPromise, briefFile, rootStarted = false;
      const startNotifications = [];
      const laneId = `lifetime-${mode}-${crypto.randomUUID()}`;
      try {
        const result = await runLane({ laneId, itemId: 'Q1', cwd: directory, brief,
          timeoutMs: mode === 'timeout' ? limit : 20000,
          buildEnvironment: () => ({ env: { ...process.env }, home: null, billing: { backend: 'fixture' } }),
          buildOnboardingPacket: () => 'Isolated onboarding fixture.',
          resolveExecutable: () => ({ command: process.execPath, prefixArgs: [script] }), execImpl: () => '',
          onStart(pid, identity) {
            assert.equal(rootStarted, true, 'start notification requires actual native root-start evidence');
            startNotifications.push({ pid, identity });
          },
          spawnImpl(file, args, options) {
            assert.equal(Number.isSafeInteger(options.stdio[0]), true);
            assert.equal(fs.fstatSync(options.stdio[0]).isFile(), true, 'the original readonly brief FD reaches native spawn');
            assert.deepEqual(options.stdio.slice(1), ['pipe', 'pipe']);
            assert.equal(args.includes('--prompt'), false);
            assert.ok([file, ...args].join(' ').length < 32000, 'a large brief never moves back onto argv');
            briefFile = path.join(os.tmpdir(), `toolsenabled-fleet-lane-brief-${laneId}.txt`);
            child = spawnHidden(file, args, options);
            child.jobReady?.then(() => { rootStarted = true; }, () => {});
            child.on('error', () => {});
            closedPromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
            return child;
          }
        });
        assert.equal(fs.existsSync(marker), true, `${mode}: a real detached descendant must run`);
        const stdin = JSON.parse(fs.readFileSync(inputReceipt, 'utf8'));
        assert.equal(stdin.regularFile, true, 'the native root receives a file, without pipe conversion');
        assert.ok(stdin.writeError, 'the root cannot write to the readonly brief descriptor');
        assert.equal(stdin.bytes, Buffer.byteLength(prompt));
        assert.equal(stdin.sha256, expectedHash);
        assert.equal(stdin.onboardingHash, expectedHash);
        const atReturn = fs.readFileSync(marker, 'utf8');
        await sleep(180);
        assert.equal(fs.readFileSync(marker, 'utf8'), atReturn, `${mode}: no descendant effects after lane terminal outcome`);
        assert.equal(result.ok, mode === 'success');
        assert.equal(result.code, { success: null, timeout: 'TIMEOUT', nonzero: 'EXIT_NONZERO' }[mode]);
        assert.equal(result.cleanupConfirmed, true);
        assert.deepEqual(startNotifications, [{ pid: child.pid, identity: { pidKind: 'native-wrapper' } }]);
        if (mode === 'nonzero') assert.equal(result.exitCode, 7);
        if (mode === 'success') assert.equal(result.reportedTokens, 1);
        assert.equal(closed, true);
        assert.equal(fs.existsSync(briefFile), false, 'cleanup removes the brief only after native custody closes');
        const receipt = await child.jobOutcome;
        assert.equal(receipt.activeProcesses, 0);
        assert.equal((await child.jobClosed).failure, null);
        if (process.platform === 'linux') {
          assert.ok(receipt.observedChildren >= 2);
          assert.equal(receipt.reapedChildren, receipt.observedChildren);
        }
      } finally {
        if (child?.jobOutcome) {
          if (!closed) await child.terminateJob().catch(() => {});
          await child.jobClosed;
        } else if (child) {
          const deadline = Date.now() + limit + 2000;
          while (!fs.existsSync(done) && Date.now() < deadline) await sleep(20);
          assert.equal(fs.existsSync(done), true, 'the baseline detached leaf must self-terminate');
          await sleep(80);
          if (!closed) child.kill('SIGTERM');
        }
        if (closedPromise) await closedPromise;
      }
    }
    const forbiddenRoot = path.join(directory, 'admission.forbidden');
    const deniedScript = path.join(directory, 'admission.root.cjs');
    fs.writeFileSync(deniedScript, `require('node:fs').writeFileSync(${JSON.stringify(forbiddenRoot)},'started');`);
    let deniedChild;
    const deniedStarts = [];
    try {
      const result = await runLane({ laneId: `admission-${crypto.randomUUID()}`, itemId: 'Q1', cwd: directory,
        brief: 'must not start', timeoutMs: 20000,
        buildEnvironment: () => ({ env: { ...process.env }, home: null, billing: { backend: 'fixture' } }),
        buildOnboardingPacket: () => 'Isolated onboarding fixture.',
        resolveExecutable: () => ({ command: process.execPath, prefixArgs: [deniedScript] }), execImpl: () => '',
        onStart: (...args) => deniedStarts.push(args),
        spawnImpl(file, args, options) {
          deniedChild = spawnHidden(file, args, { ...options, rootLaunch: {
            beforeRootSpawn() { throw Object.assign(new Error('Fixture native admission refused.'), { code: 'LANE_TEST_ADMISSION_REFUSED' }); },
            spawned() {}
          } });
          deniedChild.on('error', () => {});
          return deniedChild;
        }
      });
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(forbiddenRoot), false);
      assert.deepEqual(deniedStarts, [], 'a refused native root never changes durable state to running');
      const outcome = await deniedChild.jobOutcome;
      assert.equal(outcome.type, 'not-started');
      assert.equal(outcome.activeProcesses, 0);
      await deniedChild.jobClosed;
    } finally {
      if (deniedChild) { await deniedChild.terminateJob().catch(() => {}); await deniedChild.jobClosed; }
    }
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    for (const kind of ['closed', 'live-descendant']) {
      const child = new EventEmitter();
      child.pid = 1234;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.jobReady = Promise.resolve();
      let resolveOutcome, resolveClosed;
      child.jobOutcome = new Promise(resolve => { resolveOutcome = resolve; });
      child.jobClosed = new Promise(resolve => { resolveClosed = resolve; });
      child.terminateJob = () => child.jobOutcome;
      child.terminateRetainedWrapper = async () => {};
      const laneId = `receipt-${kind}-${crypto.randomUUID()}`;
      const briefFile = path.join(os.tmpdir(), `toolsenabled-fleet-lane-brief-${laneId}.txt`);
      const laneHome = fs.mkdtempSync(path.join(directory, 'settings-'));
      let answered = false, worktreeProbes = 0;
      const pending = runLane({ laneId, itemId: 'Q1', cwd: directory, brief: 'retained fixture input',
        buildEnvironment: () => ({ env: {}, home: laneHome, billing: { backend: 'fixture' } }),
        buildOnboardingPacket: () => 'Isolated onboarding fixture.',
        resolveExecutable: () => ({ command: process.execPath, prefixArgs: [] }),
        execImpl: () => { worktreeProbes += 1; return ''; },
        spawnImpl: () => child
      }).then(result => { answered = true; return result; });
      child.stdout.write(JSON.stringify({ response: 'FILES-READ: fixture.js', stats: { models: {} } }));
      resolveOutcome({ type: 'exit', exitCode: 0, activeProcesses: kind === 'closed' ? 0 : 1 });
      child.emit('close', 0);
      await sleep(5);
      assert.equal(answered, false, 'root close alone cannot settle a lane');
      assert.equal(fs.existsSync(briefFile), true, 'retain its brief until native wrapper cleanup settles');
      assert.equal(fs.existsSync(laneHome), true, 'retain its settings home during native cleanup');
      resolveClosed({ failure: null });
      const result = await pending;
      assert.equal(result.ok, kind === 'closed');
      assert.equal(result.cleanupConfirmed, kind === 'closed');
      if (kind === 'live-descendant') {
        assert.equal(result.code, 'CLEANUP_UNPROVEN');
        assert.equal(result.response, undefined, 'unknown custody cannot produce a settled lane answer');
        assert.equal(result.changedFileCount, null);
        assert.equal(worktreeProbes, 0, 'unknown custody must not probe a worktree that may still change');
        assert.deepEqual(result.retainedScratch, { briefFile, laneHome });
      }
      assert.equal(fs.existsSync(briefFile), kind === 'live-descendant');
      assert.equal(fs.existsSync(laneHome), kind === 'live-descendant');
      fs.rmSync(briefFile, { force: true }); // This receipt fixture created no process.
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

exerciseRefusals().then(exerciseRunningLifetimes).then(() => {
  console.log('lane-runner behaviour and refusals: ok');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
