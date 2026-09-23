'use strict';

// Finite, offline child fixture. Its only writes are below the caller's
// isolated state-file parent; it never loads providers or operational state.
const fs = require('node:fs');
const path = require('node:path');
const { runSupervisedWorker } = require('../../src/lib/research/worker-protocol');
const { createStateStore } = require('../../src/lib/state-store');
const { runProcess } = require('../../src/lib/research/runners');

if (require.main === module) {
  const stateFile = process.env.TOOLSENABLED_STATE_PATH;
  const fixtureRoot = process.env.TOOLSENABLED_RESEARCH_FIXTURE_ROOT;
  if (!stateFile || !fixtureRoot || path.dirname(path.resolve(stateFile)) !== path.resolve(fixtureRoot)
      || !path.basename(fixtureRoot).startsWith('research-supervisor-')) throw new Error('Invalid isolated research fixture root.');
  let state;
  let release;
  const maximum = setTimeout(() => { process.exitCode = 2; release?.(); }, 15000);
  runSupervisedWorker({
    createWorker() {
      state = createStateStore({ file: stateFile }); state.health();
      fs.writeFileSync(path.join(fixtureRoot, 'worker-started'), 'started\n');
      if (process.env.TOOLSENABLED_RESEARCH_FIXTURE_NESTED === '1') {
        const controller = new AbortController();
        return {
          async runForever() {
            const ready = path.join(fixtureRoot, 'nested-leaf-ready');
            const survived = path.join(fixtureRoot, 'nested-leaf-survived');
            const leaf = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(survived)},'survived'),2000);setTimeout(()=>{},10000);`;
            const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();setTimeout(()=>{},10000);`;
            const result = await runProcess({ experiment: { runnerConfig: { command: process.execPath, args: ['-e', program], envKeys: ['ELECTRON_RUN_AS_NODE'] }, timeoutMs: 10000 },
              run: { runId: 'rr-nested-fixture', params: {} }, artifactDir: fixtureRoot, signal: controller.signal });
            fs.writeFileSync(path.join(fixtureRoot, 'nested-lifecycle.json'), JSON.stringify(result.processLifecycle));
          },
          stop() { controller.abort(new Error('finite fixture stop')); }
        };
      }
      return {
        runForever() { return new Promise(resolve => { release = resolve; }); },
        stop() { release?.(); }
      };
    },
    closeDatabase() {
      if (process.env.TOOLSENABLED_RESEARCH_FIXTURE_CLOSE_FAIL === '1') throw new Error('Injected DB close refusal');
      state?.close();
      fs.writeFileSync(path.join(fixtureRoot, 'worker-db-closed'), 'closed\n');
    }
  }).then(() => { clearTimeout(maximum); }, () => { clearTimeout(maximum); state?.close(); process.exitCode = 1; });
}
