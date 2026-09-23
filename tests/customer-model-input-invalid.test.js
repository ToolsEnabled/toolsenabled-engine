'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const test = require('node:test');
const { CustomerModelError, complete } = require('../src/lib/providers/customer-model');

const MAX_PROMPT_CHARS = 32 * 1024;

for (const [description, prompt] of [
  ['a missing prompt', undefined],
  ['a whitespace-only prompt', ' \t\n'],
  ['an oversized prompt', 'x'.repeat(MAX_PROMPT_CHARS + 1)]
]) {
  test(`MODEL_INPUT_INVALID refuses ${description} before side effects`, async () => {
    const calls = [];
    const output = [];
    const originals = {
      spawn: childProcess.spawn,
      spawnSync: childProcess.spawnSync,
      writeFile: fs.writeFile,
      writeFileSync: fs.writeFileSync,
      stdoutWrite: process.stdout.write,
      stderrWrite: process.stderr.write
    };
    childProcess.spawn = (...args) => { calls.push(['spawn', ...args]); };
    childProcess.spawnSync = (...args) => { calls.push(['spawnSync', ...args]); };
    fs.writeFile = (...args) => { calls.push(['writeFile', ...args]); };
    fs.writeFileSync = (...args) => { calls.push(['writeFileSync', ...args]); };
    process.stdout.write = chunk => { output.push(['stdout', String(chunk)]); return true; };
    process.stderr.write = chunk => { output.push(['stderr', String(chunk)]); return true; };

    try {
      await assert.rejects(
        complete({ prompt }, {
          loadSettings: () => { calls.push(['loadSettings']); throw new Error('must not load settings'); },
          getSecret: () => { calls.push(['getSecret']); throw new Error('must not read a secret'); },
          fetch: async () => { calls.push(['fetch']); throw new Error('must not issue a request'); }
        }),
        error => {
          assert.ok(error instanceof CustomerModelError);
          assert.equal(error.code, 'MODEL_INPUT_INVALID');
          assert.equal(error.message, `prompt must contain 1 through ${MAX_PROMPT_CHARS} characters.`);
          assert.deepEqual(error.details, {});
          assert.equal(error.cause, undefined);
          return true;
        }
      );
      assert.deepEqual(calls, [], 'refusal must not load configuration, write files, spawn, or send requests');
      assert.deepEqual(output, [], 'refusal must not write to stdout or stderr');
    } finally {
      childProcess.spawn = originals.spawn;
      childProcess.spawnSync = originals.spawnSync;
      fs.writeFile = originals.writeFile;
      fs.writeFileSync = originals.writeFileSync;
      process.stdout.write = originals.stdoutWrite;
      process.stderr.write = originals.stderrWrite;
    }
  });
}
