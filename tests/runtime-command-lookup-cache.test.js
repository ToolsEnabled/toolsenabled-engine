'use strict';

// A COMMAND LOOKUP MAY BE REMEMBERED, BUT ONLY IN ONE DIRECTION.
//
// commandExists() spawns where.exe every time it is asked, and for
// terraform/firebase it then runs the resolved binary with a 5,000 ms timeout.
// system.doctor asks about gcloud, terraform, firebase, node and npx across
// several provider modules per call, and system.status pays one on every poll.
// Measured on the owner's install: 6.6 s of process spawning per four
// system.doctor calls.
//
// The asymmetry is the whole design, and it is not an optimisation detail:
//
//   * A MISS MUST NOT BE LATCHED. runtime-command-lookup.test.js already pins
//     this; a diagnostic that keeps saying "not installed" after the customer
//     installed it is worse than a slow one. That suite is the contract, this
//     one is here so the cache cannot quietly grow the other way later.
//   * AN UNKNOWN MUST NOT BE LATCHED EITHER. COMMAND_LOOKUP_UNKNOWN says the
//     lookup could not be completed. Remembering it would turn "I could not
//     look" into "I looked".
//   * A HIT MAY BE REMEMBERED, BRIEFLY. Reporting an uninstalled command as
//     present is the worse error for a doctor, so the memory is bounded and a
//     change to any environment value the resolution reads drops it outright.

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const runtimePath = path.resolve(__dirname, '..', 'src', 'lib', 'runtime.js');
const realLoad = Module._load;
const answers = [];
let probes = 0;

Module._load = function mockRuntimeDependencies(request, parent, isMain) {
  if (request === 'node:child_process' && parent && parent.filename === runtimePath) {
    const real = realLoad(request, parent, isMain);
    return {
      ...real,
      spawnSync() {
        probes += 1;
        if (!answers.length) throw new Error('the code under test spawned more lookups than this case allowed');
        return answers.shift();
      }
    };
  }
  return realLoad(request, parent, isMain);
};

delete require.cache[runtimePath];
const { commandPath, commandExists, resetCommandPathCache } = require(runtimePath);
Module._load = realLoad;

const checks = [];
function check(name, run) { checks.push([name, run]); }

function fresh() { resetCommandPathCache(); answers.length = 0; probes = 0; }

check('a resolved command is answered once and remembered', () => {
  fresh();
  answers.push({ status: 0, stdout: '/bin/present\n', stderr: '' });
  assert.equal(commandPath('present-tool'), '/bin/present');
  assert.equal(probes, 1, 'the first lookup must really probe');
  for (let i = 0; i < 5; i += 1) assert.equal(commandPath('present-tool'), '/bin/present');
  assert.equal(probes, 1, `five repeat lookups must not spawn again; saw ${probes} probes`);
});

check('a miss is never latched -- the next call probes again', () => {
  fresh();
  answers.push({ status: 1, stdout: '', stderr: '' });
  assert.equal(commandPath('later-installed'), null);
  answers.push({ status: 0, stdout: '/bin/later-installed\n', stderr: '' });
  assert.equal(commandPath('later-installed'), '/bin/later-installed',
    'a command installed since the last look must be seen immediately');
  assert.equal(probes, 2, 'both calls must have probed; a cached miss would have skipped the second');
});

check('a lookup that could not be completed is not remembered as an answer', () => {
  fresh();
  const cause = Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
  answers.push({ error: cause, status: null, stdout: '', stderr: '' });
  assert.throws(() => commandPath('unknowable'), error => error && error.code === 'COMMAND_LOOKUP_UNKNOWN');
  answers.push({ status: 0, stdout: '/bin/unknowable\n', stderr: '' });
  assert.equal(commandPath('unknowable'), '/bin/unknowable',
    'an unknown must not be cached, and must not poison the next real answer');
  assert.equal(probes, 2);
});

check('commandExists rides the same memory', () => {
  fresh();
  answers.push({ status: 0, stdout: '/bin/node\n', stderr: '' });
  assert.equal(commandExists('node-ish'), true);
  for (let i = 0; i < 10; i += 1) assert.equal(commandExists('node-ish'), true);
  assert.equal(probes, 1, `commandExists must not re-spawn per call; saw ${probes}`);
});

check('a PATH change drops what was remembered', () => {
  fresh();
  const originalPath = process.env.PATH;
  try {
    answers.push({ status: 0, stdout: '/old/tool\n', stderr: '' });
    assert.equal(commandPath('moving-tool'), '/old/tool');
    process.env.PATH = `${originalPath || ''}${path.delimiter}/a/new/entry`;
    answers.push({ status: 0, stdout: '/new/tool\n', stderr: '' });
    assert.equal(commandPath('moving-tool'), '/new/tool',
      'a changed PATH must never be served an answer resolved against the old one');
    assert.equal(probes, 2);
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\nruntime-command-lookup-cache: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
