'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped Windows fallback on either host platform. The initial
// PATH lookup and executable checks remain real branches of this function;
// controlled filesystem answers make unnecessary enumeration countable.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/runtime.js'), 'utf8');
const start = source.indexOf('function resolveCommandPath(command) {');
const end = source.indexOf('\nfunction commandExists(', start);
assert.ok(start >= 0 && end > start);
const local = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local';
const roaming = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Roaming';

function fixture({ entries = [], present = [], where = { status: 1 }, version = { status: 0 } } = {}) {
  const calls = { lists: [], spawns: [], exists: [] };
  const resolve = vm.runInNewContext(`(${source.slice(start, end)})`, {
    process: { platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: roaming, ProgramFiles: 'C:\\Program Files' } },
    path: path.win32,
    fs: {
      readdirSync(file) { calls.lists.push(file); return entries; },
      existsSync(file) { calls.exists.push(file); return present.includes(file); },
    },
    spawnSync(file, args) { calls.spawns.push({ file, args: Array.from(args) }); return file === 'where.exe' ? where : version; },
    directFirebaseInvocation: (file, args) => ({ executable: file, args }),
  });
  return { resolve, calls };
}

for (const command of ['missing-program', 'node', 'npm', 'firebase', 'gcloud', 'chrome.exe', 'msedge.exe']) {
  const f = fixture();
  assert.equal(f.resolve(command), null);
  assert.equal(f.calls.lists.length, 0, `${command} must not enumerate Terraform's package directory`);
  assert.equal(f.calls.spawns.length, 1, `${command} must still perform its PATH lookup`);
}
console.log('ok - unrelated missing commands do not enumerate Windows package installations');

const terraform = path.win32.join(local, 'Microsoft', 'WinGet', 'Packages', 'Hashicorp.Terraform_1', 'terraform.exe');
const installed = fixture({
  entries: [
    { name: 'Unrelated.Package', isDirectory: () => true },
    { name: 'Hashicorp.Terraform_file', isDirectory: () => false },
    { name: 'Hashicorp.Terraform_1', isDirectory: () => true },
  ], present: [terraform],
});
assert.equal(installed.resolve('TERRAFORM'), terraform);
assert.equal(installed.calls.lists.length, 1);
assert.deepEqual(installed.calls.spawns[1], { file: terraform, args: ['version'] });
console.log('ok - Terraform still discovers and probes its executable when absent from PATH');

const refused = fixture({ entries: [{ name: 'Hashicorp.Terraform_1', isDirectory: () => true }], present: [terraform], version: { status: 1 } });
assert.equal(refused.resolve('terraform'), null);
const onPath = fixture({ where: { status: 0, stdout: terraform + '\r\n' } });
assert.equal(onPath.resolve('terraform'), terraform);
assert.equal(onPath.calls.lists.length, 0);
const unknown = fixture({ where: { status: null, error: { code: 'EIO' } } });
assert.throws(() => unknown.resolve('terraform'), error => error.code === 'COMMAND_LOOKUP_UNKNOWN');
assert.equal(unknown.calls.lists.length, 0);
console.log('ok - command refusals, PATH hits, and unknown lookup outcomes retain their behavior');
