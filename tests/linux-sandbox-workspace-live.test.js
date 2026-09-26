'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseMap, mappedId, aclEntries, verifyAcl, createLinuxSandboxWorkspace } = require('../src/lib/linux-sandbox-workspace');
test('kernel mapping resolves rootless non-root UID without assuming host UID10001', () => {
  const rows = parseMap('0 1000 1\n1 100000 65536\n');
  assert.equal(mappedId(rows, 0), 1000);
  assert.equal(mappedId(rows, 10001), 110000);
  assert.throws(() => mappedId(rows, 999999));
});
test('ambiguous, overlapping, malformed and overflow mappings refuse', () => {
  for (const input of ['', '0 1 0', '0 1000 2\n1 3000 5', '0 1000 2\n5 1001 8', '0 1 4294967295', '0 -1 1', '0 1 1 extra']) {
    assert.throws(() => parseMap(input), { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
  }
});
test('ACL verifies exact numeric grants and refuses added public rights or weakened mask', () => {
  const entries = aclEntries(1000, 110000);
  verifyAcl(entries.join('\n'), entries);
  assert.ok(entries.includes('other::---') && entries.includes('default:other::---'));
  assert.throws(() => verifyAcl([...entries, 'user:9999:rwx'].join('\n'), entries));
  assert.throws(() => verifyAcl(entries.join('\n').replace('mask::rwx', 'mask::r--'), entries));
});
// Explicit real-Docker entry, deliberately absent from hermetic native gates.
test('real rootless isolated workspace roundtrip and outside-scope refusals', () => {
  const disposableRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-rootless-workspace-')));
  const parent = path.join(disposableRoot, 'sbx-0123456789abcdef0123');
  const workspace = path.join(parent, 'workspace');
  fs.mkdirSync(path.join(workspace, 'artifacts'), { recursive: true, mode: 0o700 });
  const sibling = path.join(disposableRoot, 'untouched'); fs.mkdirSync(sibling, { mode: 0o700 });
  const events = [];
  try {
    // Exercise the actual fresh-customer/LIVE profile, not the owner's CLI
    // configuration. Keep this profile inside this test's disposable root.
    const sterileHome = path.join(disposableRoot, 'sterile-home');
    fs.mkdirSync(sterileHome, { mode: 0o700 });
    const environment = { ...process.env, HOME: sterileHome, DOCKER_CONFIG: path.join(sterileHome, '.docker') };
    delete environment.DOCKER_HOST;
    delete environment.DOCKER_CONTEXT;
    const helper = createLinuxSandboxWorkspace({ disposableRoot, auditIntent: (...args) => events.push(args), environment });
    assert.equal(helper.pinnedEndpoint, `unix:///run/user/${process.getuid()}/docker.sock`);
    assert.throws(() => createLinuxSandboxWorkspace({ disposableRoot, auditIntent() {},
      environment: { ...environment, DOCKER_CONTEXT: 'default' } }),
    { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
    assert.throws(() => createLinuxSandboxWorkspace({ disposableRoot, auditIntent() {},
      environment: { ...process.env, DOCKER_CONTEXT: '', DOCKER_HOST: 'tcp://127.0.0.1:2375' } }),
    { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
    assert.match(helper.pinnedEndpoint, /^unix:\/\//);
    const inspected = helper.runDocker(['image', 'inspect', 'toolsenabled/agent-playwright-sandbox:1.61.0-v1', '--format', '{{.Id}}']);
    assert.equal(inspected.status, 0);
    const imageId = inspected.stdout.trim();
    helper.prepare({ workspace, imageId });
    fs.writeFileSync(path.join(workspace, 'input.txt'), 'host-input');
    const result = helper.runDocker(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '10001:10001',
      '--pids-limit', '32', '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.25',
      '--mount', `type=bind,src=${workspace},dst=/workspace`, imageId, 'node', '-e',
      "const f=require('fs');if(f.readFileSync('/workspace/input.txt','utf8')!=='host-input')throw Error('input');f.mkdirSync('/workspace/artifacts/nested');f.writeFileSync('/workspace/artifacts/nested/output.txt','container-output');try{f.writeFileSync('/outside.txt','escape');process.exit(7)}catch{}"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'artifacts/nested/output.txt'), 'utf8'), 'container-output');
    assert.equal(fs.statSync(sibling).mode & 0o777, 0o700);
    assert.throws(() => helper.prepare({ workspace: sibling, imageId }));
    const aliasParent = path.join(disposableRoot, 'sbx-1123456789abcdef0123');
    fs.mkdirSync(aliasParent);
    fs.symlinkSync(sibling, path.join(aliasParent, 'workspace'));
    assert.throws(() => helper.prepare({ workspace: path.join(aliasParent, 'workspace'), imageId }));
    helper.prepare({ workspace, imageId }); // Same retained daemon may reuse its generation.
    fs.writeFileSync(path.join(parent, '.linux-workspace-binding.json'), '{}');
    assert.throws(() => helper.prepare({ workspace, imageId }), { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
    const acl = spawnSync('/usr/bin/getfacl', ['-n', '-c', sibling], { encoding: 'utf8' });
    assert.doesNotMatch(acl.stdout, /user:\d+:/);
    assert.ok(events.some(([event]) => event === 'sandbox.workspace.acl.intent'));
  } finally { fs.rmSync(disposableRoot, { recursive: true, force: true }); }
});
