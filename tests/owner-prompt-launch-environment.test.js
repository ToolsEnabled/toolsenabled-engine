'use strict';
const isolated = require('./lib/isolated-environment').activate('owner-prompt-launch-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const queue = require('../src/lib/providers/owner-prompt-queue');

// Exercise the queue's actual launchSpec and its stronger platform scrub. The
// injected spawn retains the exact environment and executes a bounded Node
// reader instead of opening an owner form. No secret value enters the report.
const forbidden = ['OPENAI_API_KEY', 'aNtHrOpIc_ApI_kEy', 'AWS_ACCESS_KEY_ID',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'GI_TYPELIB_PATH', 'GIO_EXTRA_MODULES', 'GTK_PATH', 'GTK_MODULES', 'PSModulePath'];
const probe = path.join(isolated.root, 'environment-reader.cjs');
fs.writeFileSync(probe, `const blocked=${JSON.stringify(forbidden.map(x => x.toLowerCase()))};
const seen=Object.keys(process.env).filter(k=>blocked.includes(k.toLowerCase()));
console.log(JSON.stringify({seen,control:process.env.T55_PUBLIC_CONTROL==='present',
  pathPresent:Object.keys(process.env).some(k=>k.toLowerCase()==='path'),
  stateRootPresent:typeof process.env.TOOLSENABLED_STATE_ROOT==='string'}));\n`, {flag:'wx'});

for (const platform of ['win32', 'linux']) {
  test(`owner prompt ${platform} launch keeps provider and loader values out of a real child`, () => {
    const names = [...forbidden, 'T55_PUBLIC_CONTROL'];
    const previous = names.map(name => [name, process.env[name]]);
    let calls = 0;
    try {
      for (const name of forbidden) process.env[name] = 'synthetic-do-not-inherit';
      process.env.T55_PUBLIC_CONTROL = 'present';
      const result = queue.launchWaitingDialog({ platform,
        queueFile:path.join(isolated.root, `${platform}-queue.json`),
        spawn(command, args, options) {
          calls++;
          assert.notEqual(options.env, process.env);
          for (const name of forbidden) {
            assert.equal(Object.keys(options.env).some(k => k.toLowerCase() === name.toLowerCase()), false,
              `blocked name survived: ${name}`);
          }
          assert.equal(options.env.T55_PUBLIC_CONTROL, 'present');
          assert.equal(args.includes(queue.RUNNER), true);
          assert.equal(options.windowsHide, true);
          if (platform === 'win32') assert.match(command, /[\\/]conhost\.exe$/i);
          else assert.equal(command, process.execPath);
          const child = spawnSync(process.execPath, [probe], {
            env:options.env, windowsHide:true, encoding:'utf8', timeout:10000,
            cwd:isolated.root, maxBuffer:4096,
          });
          assert.equal(child.error, undefined);
          assert.equal(child.signal, null);
          assert.equal(child.status, 0);
          assert.deepEqual(JSON.parse(child.stdout), {
            seen:[], control:true, pathPresent:true, stateRootPresent:true,
          });
          return {pid:child.pid, unref() {}};
        },
      });
      assert.equal(calls, 1);
      assert.equal(result, true);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
}
