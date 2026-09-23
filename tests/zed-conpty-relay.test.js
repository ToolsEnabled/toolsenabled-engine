'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..', 'tools', 'zed-conpty-relay', 'Program.cs');
const relaySource = fs.readFileSync(source, 'utf8');
assert.match(
  relaySource,
  /while\s*\(\s*\(count\s*=\s*hostInput\.Read\s*\(\s*buffer\s*,\s*0\s*,\s*buffer\.Length\s*\)\s*\)\s*>\s*0\s*\)\s*\{\s*input\.Write\s*\(\s*buffer\s*,\s*0\s*,\s*count\s*\)\s*;[\s\S]*?input\.Flush\s*\(\s*\)\s*;\s*\}/,
  'the host-input pump must write and flush each keyboard-input chunk to the pseudo console'
);
console.log('Zed ConPTY keyboard forwarding source contract passed.');

if (process.platform !== 'win32') {
  console.log('Zed ConPTY relay test skipped outside Windows.');
  process.exit(0);
}

const compilers = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];
const compiler = compilers.find(candidate => fs.existsSync(candidate));
assert.ok(compiler, 'Windows C# compiler is required for the ConPTY relay test');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-conpty-input-'));
const executable = path.join(fixtureRoot, 'ZedConPtyRelay.exe');
const rawLog = path.join(fixtureRoot, 'raw.log');

async function main() {
  const build = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${executable}`, source], {
    windowsHide: true,
    encoding: 'utf8'
  });
  assert.equal(build.status, 0, `${build.stdout || ''}${build.stderr || ''}`);

  const relay = spawn(executable, [
    '--log', rawLog,
    '--cwd', fixtureRoot,
    '--cols', '100',
    '--rows', '30',
    '--', process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', '/d', '/q', '/k'
  ], {
    cwd: fixtureRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let preview = '';
  let stderr = '';
  relay.stdout.on('data', chunk => { preview += chunk.toString(); });
  relay.stderr.on('data', chunk => { stderr += chunk.toString(); });
  relay.stdin.write('echo ZED_INPUT_OK\r');
  relay.stdin.write('exit\r');
  relay.stdin.end();

  const result = await new Promise(resolve => {
    const timer = setTimeout(() => {
      relay.kill();
      resolve({ timedOut: true });
    }, 5000);
    relay.once('error', error => {
      clearTimeout(timer);
      resolve({ error });
    });
    relay.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(result.timedOut, undefined, 'ConPTY child did not receive the piped keyboard input');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `relay ended from signal ${result.signal}`);
  assert.equal(result.code, 0, stderr);
  assert.match(preview, /ZED_INPUT_OK/);
  assert.match(fs.readFileSync(rawLog, 'utf8'), /ZED_INPUT_OK/);
  console.log('Zed ConPTY keyboard forwarding test passed.');
}

main().finally(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
