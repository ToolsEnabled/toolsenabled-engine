'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'drive-upload.js');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-upload-test-'));
const preload = path.join(fixtureDir, 'preload.cjs');

fs.writeFileSync(preload, String.raw`
const Module = require('node:module');
const originalLoad = Module._load;
const mode = process.env.DRIVE_UPLOAD_TEST_MODE;

Module._load = function (request, parent, isMain) {
  if (request === '../src/lib/policy') {
    return {
      assertActive(action) {
        if (mode === 'policy-refusal') throw new Error('policy refused ' + action);
        process.stdout.write('POLICY ' + action + '\n');
      }
    };
  }
  if (request === '../src/lib/providers/drive') {
    return {
      async driveFindFolder(input) {
        process.stdout.write('FIND ' + JSON.stringify(input) + '\n');
        if (mode === 'provider-refusal') throw new Error('find refused');
        if (mode === 'find-empty') return { files: [] };
        return { files: [{ id: 'folder-7', name: input.name, owners: [{ emailAddress: 'owner@example.test' }] }] };
      },
      async driveUpload(input) {
        process.stdout.write('UPLOAD ' + JSON.stringify(input) + '\n');
        if (mode === 'provider-refusal') throw new Error('upload refused');
        return { id: 'file-9', name: input.name };
      }
    };
  }
  return originalLoad.apply(this, arguments);
};
`);

function run(args, mode = 'success') {
  return spawnSync(process.execPath, ['--require', preload, CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DRIVE_UPLOAD_TEST_MODE: mode }
  });
}

function refusal(args, mode, status, message) {
  const result = run(args, mode);
  assert.equal(result.status, status, `${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, message);
}

try {
  // Pin both explicitly named exit codes and each user-facing refusal path.
  refusal([], 'success', 2, /^Usage:/);
  refusal(['--find', 'Missing Folder', '--account', 'person@example.test'], 'find-empty', 1,
    /No folder named "Missing Folder" is visible to this account\./);
  refusal(['--find', 'Blocked Folder'], 'policy-refusal', 1,
    /Upload error: policy refused drive\.find/);
  refusal(['--file', '/tmp/blocked.txt'], 'policy-refusal', 1,
    /Upload error: policy refused drive\.upload/);
  refusal(['--find', 'Provider Blocked'], 'provider-refusal', 1,
    /Upload error: find refused/);
  refusal(['--file', '/tmp/provider-blocked.txt'], 'provider-refusal', 1,
    /Upload error: upload refused/);

  const find = run(['--find', 'Named Folder', '--account', 'person@example.test']);
  assert.equal(find.status, 0, find.stderr);
  assert.match(find.stdout, /POLICY drive\.find/);
  assert.match(find.stdout, /FIND \{"name":"Named Folder","account":"person@example\.test"\}/);
  assert.match(find.stdout, /folder-7\tNamed Folder\t\(owner@example\.test\)/);

  const upload = run([
    '--file', '/tmp/input value.txt', '--folder', 'folder-7', '--name', 'Remote Name.txt',
    '--account', 'person@example.test'
  ]);
  assert.equal(upload.status, 0, upload.stderr);
  assert.match(upload.stdout, /POLICY drive\.upload/);
  assert.match(upload.stdout,
    /UPLOAD \{"filePath":"\/tmp\/input value\.txt","folderId":"folder-7","name":"Remote Name\.txt","account":"person@example\.test"\}/);
  assert.match(upload.stdout, /"id": "file-9"/);

  console.log('drive-upload CLI refusal and exit-code tests passed');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
