'use strict';

// Each link stays alive until its child exits, so the server reads real /proc
// ancestors. Copying this file under a descriptor's command also tests Node
// script names; argv0 tests native command names without changing process.title.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const chain = JSON.parse(process.env.MATRIX_CHAIN);
const index = Number(process.env.MATRIX_CHAIN_INDEX || 0);
if (index + 1 < chain.length) {
  const next = chain[index + 1];
  const child = spawn(process.execPath, [next.script, ...next.args], {
    argv0: next.argv0,
    env: { ...process.env, MATRIX_CHAIN_INDEX: String(index + 1) },
    stdio: 'inherit',
  });
  child.on('error', error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
} else {
  const levels = require(process.env.MATRIX_LEVEL_MODULE);
  const registry = require(process.env.MATRIX_REGISTRY_MODULE).loadRegistry({ userDir: null });
  const detected = levels.leadLevel({ registry });
  const caps = Object.fromEntries(['1', '2', '3', '4', '0', '5', 'invalid', ''].map(cap => [cap,
    levels.leadLevel({ registry, env: { ...process.env, TOOLSENABLED_LEVEL_CAP: cap } })]));
  const ancestors = [];
  let pid = process.ppid;
  for (let depth = 0; depth < chain.length - 1; depth += 1) {
    ancestors.push(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  process.stdout.write(JSON.stringify({ detected, caps, ancestors }) + '\n');
}
