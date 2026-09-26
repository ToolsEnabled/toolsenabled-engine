'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spawnOwned = process.platform === 'win32'
  ? require('../src/lib/windows-job-control').spawnInJob
  : require('../src/lib/linux-process-control').spawnLinuxOwned;
const nativePlatform = ['linux', 'win32'].includes(process.platform);

const ROOT = path.resolve(__dirname, '..');
const closure = ['tests/run-isolated.js', 'tests/lib/isolated-child.js',
  'tests/lib/isolated-environment.js', 'tests/lib/suite-list.js', 'tests/lib/suite-timeouts.js',
  'tools/lib/test-completion.js', 'tools/lib/strict-lifecycle-record.js', 'src/lib/env-scrub.js',
  'src/lib/linux-process-control.js', 'src/lib/linux-process-supervisor.py',
  'src/lib/windows-job-control.js', 'src/lib/runtime-state-root.js',
  'src/lib/account-profile-boundary.js', 'tools/windows-job-wrapper.ps1'];

for (const mode of ['exit', 'nonzero', 'timeout']) {
  test(`native isolated runner closes a real detached descendant before the next file: ${mode}`,
    { skip: !nativePlatform, timeout: 45000 }, async t => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-isolated-custody-')));
      const root = path.join(directory, 'engine');
      const write = (file, bytes) => {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      };
      for (const file of closure) write(file, fs.readFileSync(path.join(ROOT, file)));
      write('package.json', '{"type":"commonjs"}');
      const marker = path.join(directory, 'effects'), receipt = path.join(directory, 'return.json');
      write('tests/leaf.cjs', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ready\\n');
        setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'effect\\n'),20);`);
      write('tests/root.cjs', `const fs=require('node:fs');const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,[${JSON.stringify(path.join(root, 'tests/leaf.cjs'))}],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();
        const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(ready);
          ${mode === 'timeout' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'nonzero' ? 7 : 0});`}},10);`);
      write('tests/next.cjs', `const fs=require('node:fs');const assert=require('node:assert/strict');
        const before=fs.readFileSync(${JSON.stringify(marker)},'utf8');
        setTimeout(()=>assert.equal(fs.readFileSync(${JSON.stringify(marker)},'utf8'),before,'no previous descendant may write during the next test'),300);`);
      write('probe.cjs', `const fs=require('node:fs');const {spawnSync}=require('node:child_process');
        const result=spawnSync(process.execPath,['tests/run-isolated.js','--timeout-ms','5000','--summary','summary.json','tests/root.cjs','tests/next.cjs'],{
          cwd:__dirname,env:process.env,windowsHide:true,encoding:'utf8',timeout:20000});
        fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({status:result.status,error:result.error?.code,stdout:result.stdout,stderr:result.stderr}));`);
      const env = { ...process.env };
      delete env.TOOLSENABLED_TEST_STRICT;
      delete env.NODE_TEST_CONTEXT;
      // An independent outer native scope contains the deliberately broken
      // before-fix fixture too. Failed assertions cannot leak its detached leaf.
      const outer = spawnOwned(process.execPath, [path.join(root, 'probe.cjs')], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true
      }, { safeLaunchEnvironment: value => ({ ...value }) });
      outer.on('error', () => {}); outer.stdout.resume(); outer.stderr.resume();
      const timer = setTimeout(() => void outer.terminateJob(), 30000);
      t.after(async () => {
        await outer.terminateJob(); await outer.jobClosed; clearTimeout(timer);
        fs.rmSync(directory, { recursive: true, force: true });
      });
      const outcome = await outer.jobOutcome;
      assert.equal((await outer.jobClosed).failure, null);
      assert.equal(outcome.activeProcesses, 0);
      if (process.platform === 'linux') assert.equal(outcome.observedChildren, outcome.reapedChildren);
      const returned = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      const summary = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
      assert.equal(returned.error, undefined, returned.stderr);
      assert.equal(summary.files[1].status, 'pass', returned.stdout + returned.stderr);
      assert.equal(returned.status, { exit: 0, nonzero: 7, timeout: 124 }[mode]);
      assert.equal(summary.files[0].status, { exit: 'pass', nonzero: 'fail', timeout: 'timeout' }[mode]);
      const custody = summary.files[0].process.custody;
      assert.equal(custody.activeProcesses, 0);
      if (process.platform === 'linux') {
        assert.ok(custody.observedChildren >= 2);
        assert.equal(custody.observedChildren, custody.reapedChildren);
      } else {
        assert.ok(['exit', 'terminated'].includes(custody.type));
      }
    });
}

for (const mode of ['output-limit', 'signal', 'stdin']) {
  test(`native isolated child preserves completion on ${mode}`,
    { skip: !nativePlatform || (mode === 'signal' && process.platform === 'win32')
      ? 'requires native POSIX signal delivery for this case' : false, timeout: 35000 }, async t => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-isolated-stream-')));
      const marker = path.join(directory, 'ready'), receipt = path.join(directory, 'receipt.json');
      const probe = path.join(directory, 'probe.cjs');
      const input = 'exact inherited input \u00e9\n';
      const program = mode === 'stdin' ? 'process.stdout.write(require("node:fs").readFileSync(0));'
        : `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');
          ${mode === 'output-limit' ? 'process.stdout.write(Buffer.alloc(4096,120));' : ''}setInterval(()=>{},1000);`;
      fs.writeFileSync(probe, `const fs=require('node:fs');
        const {runIsolatedChild}=require(${JSON.stringify(path.join(ROOT, 'tests/lib/isolated-child.js'))});
        ${mode === 'signal' ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.kill(process.pid,'SIGTERM');}},10);` : ''}
        runIsolatedChild(process.execPath,['-e',${JSON.stringify(program)}],{cwd:__dirname,env:process.env,
          stdio:['inherit','pipe','pipe'],encoding:'utf8',maxBuffer:1024,timeout:10000}).then(result=>{
          fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({...result,error:result.error?.code}));
        });`);
      const outer = spawnOwned(process.execPath, [probe], {
        cwd: directory, env: { ...process.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true
      }, { safeLaunchEnvironment: value => ({ ...value }) });
      outer.on('error', () => {}); outer.stdout.resume(); outer.stderr.resume();
      outer.stdin.end(mode === 'stdin' ? input : '');
      const timer = setTimeout(() => void outer.terminateJob(), 20000);
      t.after(async () => {
        await outer.terminateJob(); await outer.jobClosed; clearTimeout(timer);
        fs.rmSync(directory, { recursive: true, force: true });
      });
      await outer.jobOutcome;
      assert.equal((await outer.jobClosed).failure, null);
      const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(result.custody.activeProcesses, 0);
      if (process.platform === 'linux') assert.equal(result.custody.observedChildren, result.custody.reapedChildren);
      assert.equal(result.error, { 'output-limit': 'ENOBUFS', signal: 'EINTR', stdin: undefined }[mode]);
      if (mode === 'stdin') assert.equal(result.stdout, input);
      if (mode === 'output-limit') assert.equal(Buffer.byteLength(result.stdout), 1024);
    });
}
